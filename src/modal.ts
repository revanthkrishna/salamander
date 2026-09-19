// src/modal.ts
// Phase 7 — the enlarged feedback modal (REQUIREMENTS §1.5, §3.3).
//
// A translucent backdrop over the page showing one feedback item enlarged:
// the screenshot, a note textarea that autosaves on blur or on close (no
// explicit save button — §3.3's decision), and an immediate no-confirmation
// delete (§1.5 mirrors v1's single-item delete). "The screenshot/selection
// area itself is not editable in v1" (§1.5) — this module never offers to
// re-crop or replace the image.
//
// Built on its own closed-shadow-root host attached to document.documentElement
// (same pattern as sidebar.ts / addMode.ts), so it is immune to page CSS. The
// host itself carries an explicit z-index (the max 32-bit value) rather than
// relying on DOM order: a bare `position: fixed` host with no z-index sits in
// the z-index:auto paint layer, which loses to *any* page element that has
// its own explicit positive z-index (sticky headers, cookie banners, chat
// widgets — very common) even though those elements are earlier in the DOM.
// Shadow DOM does not create an implicit stacking-context boundary; only the
// host's own CSS does, so this has to be set explicitly (bug: page elements
// "peeking out" over the modal). The host's z-index (2147483647) is one above
// the sidebar's own host (2147483645, sidebar.ts) so the two never fight if
// they ever did overlap — see the backdrop's `right` inset below for why they
// shouldn't overlap in the first place.
//
// The backdrop only ever covers the page's own viewport area, not the
// sidebar's reserved right-edge strip (§1.1 — the sidebar resizes the page
// rather than overlaying it, and is meant to stay visible/usable at all
// times). The modal can only be opened by activating a thumbnail, which only
// exists while the sidebar is open and showing that strip, so reserving that
// strip unconditionally is safe and keeps this module simple (no need to ask
// sidebar.ts for its current visibility). Only one modal is ever open at a
// time — a module-level singleton, same shape as sidebar.ts/addMode.ts.
//
// The strip's width is *live*, not a constant: the sidebar is user-resizable
// (100–300px) and its drag handle sits on its left edge, which the backdrop
// deliberately stops short of — so the width can change while the modal is
// open. The backdrop's inset is therefore `var(--annotator-sidebar-width)`,
// a custom property sidebar.ts sets on <html> whenever it applies or updates
// the page shrink. Custom properties inherit through shadow boundaries
// (closed roots included), so the value reaches this shadow tree and a drag
// reflows the backdrop with no subscription plumbing. getSidebarWidth() is
// baked in as the var's fallback so the inset is still correct at open time
// in the (impossible-by-construction, but cheap to cover) case where the
// property is missing.
//
// Gotcha #1: the full-resolution PNG lives in IndexedDB behind the service
// worker. This module never touches chrome.runtime itself — the caller
// supplies `fetchFullImage`/`onSaveNote`/`onDelete` (the same "inject the
// side-effecting bits" shape as capture.ts's OverlayControls), which keeps
// modal.ts a pure DOM module content.ts wires up, and unit-testable without
// mocking chrome.*. The item's cached thumbnailDataUrl (Phase 1's design
// call) paints immediately so the modal never opens on a blank frame; it is
// swapped for the full-resolution image once fetchFullImage resolves.

import { FeedbackItem } from './types';
import { getSidebarWidth } from './sidebar';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { getThemeCSS, registerThemedHost } from './theme';

/** Highest possible z-index — see the file banner for why the host needs an
 *  explicit value at all rather than relying on DOM order. */
const MODAL_HOST_Z_INDEX = 2147483647;

export interface ModalCallbacks {
  /** Resolve the full-resolution screenshot for this item, or null if it
   *  could not be loaded — the thumbnail-resolution image stays on screen
   *  in that case rather than the modal failing outright. */
  fetchFullImage: () => Promise<string | null>;
  /** Persist an edited note. Resolves true on success; false leaves the
   *  modal open with an inline error instead of silently discarding the edit. */
  onSaveNote: (note: string) => Promise<boolean>;
  /** Delete the item and its blob. Resolves true on success. */
  onDelete: () => Promise<boolean>;
  /** Fired once the modal has fully closed, however it closed. */
  onClose: () => void;
}

/** Built per-open rather than once at module load: the sidebar's width is
 *  user-controlled, so the fallback baked into the backdrop's `right` inset
 *  has to be read at the moment the modal is constructed. */
const modalCss = (): string => `
  :host {
    --accent:  #FEC800;
    --error:   #FB645A;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }

  .backdrop {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    /* Stop short of the sidebar's own reserved strip rather than covering the
       full viewport — the sidebar must stay visible/usable (and resizable)
       while the modal is open (§1.1). The custom property is set on <html> by
       sidebar.ts and inherits in here, so this tracks a live drag. */
    right: var(--annotator-sidebar-width, ${getSidebarWidth()}px);
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .panel {
    display: flex;
    flex-direction: column;
    max-width: min(900px, 100%);
    max-height: 100%;
    background: #141414;
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 10px 14px;
    background: #000000;
    border-bottom: 1px solid rgba(255,255,255,0.10);
  }

  .item-badge {
    color: #FFFFFF;
    font-size: 13px;
    font-weight: 600;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    padding: 6px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #FFFFFF;
    cursor: pointer;
  }
  .close-btn:hover { color: var(--accent); background: rgba(255,255,255,0.08); }
  .close-btn svg { width: 100%; height: 100%; display: block; }

  .image-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    padding: 12px;
  }

  .screenshot {
    max-width: 100%;
    max-height: 60vh;
    display: block;
  }

  .footer {
    flex-shrink: 0;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #141414;
  }

  .note-input {
    width: 100%;
    height: 88px;
    resize: vertical;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    color: #FFFFFF;
    font-family: inherit;
  }
  .note-input::placeholder { color: rgba(255,255,255,0.35); }
  .note-input:focus { outline: 2px solid var(--accent); outline-offset: 0; }

  .footer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .inline-error {
    font-size: 12px;
    color: var(--error);
    flex: 1 1 auto;
  }
  .inline-error[hidden] { display: none !important; }

  .delete-btn {
    height: 30px;
    padding: 0 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    background: var(--error);
    color: #FFFFFF;
    flex-shrink: 0;
  }
  .delete-btn:hover { background: #e04f46; }
  .delete-btn:disabled { opacity: 0.5; cursor: default; }
`;

const ICON_CROSS_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><polygon points="18.707 6.707 17.293 5.293 12 10.586 6.707 5.293 5.293 6.707 10.586 12 5.293 17.293 6.707 18.707 12 13.414 17.293 18.707 18.707 17.293 13.414 12 18.707 6.707"/></svg>`;

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let modalHost: HTMLDivElement | null = null;
let elBackdrop: HTMLDivElement | null = null;
let elBadge: HTMLSpanElement | null = null;
let elCloseBtn: HTMLButtonElement | null = null;
let elImage: HTMLImageElement | null = null;
let elTextarea: HTMLTextAreaElement | null = null;
let elError: HTMLSpanElement | null = null;
let elDeleteBtn: HTMLButtonElement | null = null;

let currentItem: FeedbackItem | null = null;
let currentCallbacks: ModalCallbacks | null = null;
let lastSavedNote = '';
let keyboardIsolation: KeyboardIsolationHandle | null = null;
let unregisterThemedHost: (() => void) | null = null;

export function isModalOpen(): boolean {
  return modalHost !== null;
}

/**
 * Open the modal for `item`. If one is already open (shouldn't happen in
 * practice — the backdrop covers the whole viewport and captures every
 * click, so there is no way to activate a second thumbnail while a modal is
 * up) it is torn down first without attempting to autosave its edit, since
 * that would be a bug surfacing, not a user-initiated close.
 */
export function openModal(item: FeedbackItem, callbacks: ModalCallbacks): void {
  if (modalHost) teardown();

  currentItem = item;
  currentCallbacks = callbacks;
  lastSavedNote = item.note;

  buildDOM();

  elBadge!.textContent = `feedback #${item.id}`;
  elImage!.src = item.thumbnailDataUrl;
  elTextarea!.value = item.note;

  void callbacks.fetchFullImage().then((full) => {
    // The modal may have moved on to a different item (or closed) by the
    // time this resolves — never let a stale fetch overwrite what's on screen.
    if (currentItem !== item || !elImage) return;
    if (full) elImage.src = full;
  });

  // Capture-phase window-level keyboard isolation (see keyboardIsolation.ts)
  // so keystrokes typed into the note textarea can't leak to — or be
  // suppressed by — the host page's own keyboard-shortcut handlers. Escape
  // used to be handled by a plain document-level bubble listener; that would
  // now never see the event once isolation stops its propagation, so Escape
  // handling moves into the isolation callback instead.
  keyboardIsolation = installKeyboardIsolation(modalHost!, handleKeyDown);
}

/** Autosave any pending edit, then tear the modal down and notify the
 *  caller. Safe to call multiple times / when nothing is open. */
export async function closeModal(): Promise<void> {
  if (!modalHost) return;
  await maybeSaveNote();
  const cb = currentCallbacks;
  teardown();
  cb?.onClose();
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    void closeModal();
  }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDOM(): void {
  modalHost = document.createElement('div');
  modalHost.id = 'annotator-modal-host';
  modalHost.style.cssText = `position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: ${MODAL_HOST_Z_INDEX};`;
  const shadow = modalHost.attachShadow({ mode: 'closed' });
  unregisterThemedHost = registerThemedHost(modalHost);

  const style = document.createElement('style');
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of the modal's own CSS so every rule below can reference them.
  // Phase 1 only wires this up; restyling modalCss() itself is a later
  // phase's job.
  style.textContent = getThemeCSS() + '\n' + modalCss();
  shadow.appendChild(style);

  elBackdrop = document.createElement('div');
  elBackdrop.className = 'backdrop';
  elBackdrop.setAttribute('role', 'dialog');
  elBackdrop.setAttribute('aria-modal', 'true');
  elBackdrop.addEventListener('click', (e) => {
    if (e.target === elBackdrop) void closeModal();
  });

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('div');
  header.className = 'panel-header';

  elBadge = document.createElement('span');
  elBadge.className = 'item-badge';

  elCloseBtn = document.createElement('button');
  elCloseBtn.type = 'button';
  elCloseBtn.className = 'close-btn';
  elCloseBtn.setAttribute('aria-label', 'close');
  elCloseBtn.title = 'close';
  elCloseBtn.innerHTML = ICON_CROSS_SMALL;
  elCloseBtn.addEventListener('click', () => void closeModal());

  header.appendChild(elBadge);
  header.appendChild(elCloseBtn);

  const imageArea = document.createElement('div');
  imageArea.className = 'image-area';
  elImage = document.createElement('img');
  elImage.className = 'screenshot';
  elImage.alt = 'captured feedback screenshot';
  imageArea.appendChild(elImage);

  const footer = document.createElement('div');
  footer.className = 'footer';

  elTextarea = document.createElement('textarea');
  elTextarea.className = 'note-input';
  elTextarea.placeholder = 'add a note...';
  elTextarea.addEventListener('blur', () => void maybeSaveNote());

  const footerRow = document.createElement('div');
  footerRow.className = 'footer-row';

  elError = document.createElement('span');
  elError.className = 'inline-error';
  elError.hidden = true;

  elDeleteBtn = document.createElement('button');
  elDeleteBtn.type = 'button';
  elDeleteBtn.className = 'delete-btn';
  elDeleteBtn.textContent = 'delete';
  elDeleteBtn.addEventListener('click', () => void handleDelete());

  footerRow.appendChild(elError);
  footerRow.appendChild(elDeleteBtn);

  footer.appendChild(elTextarea);
  footer.appendChild(footerRow);

  panel.appendChild(header);
  panel.appendChild(imageArea);
  panel.appendChild(footer);
  elBackdrop.appendChild(panel);
  shadow.appendChild(elBackdrop);

  document.documentElement.appendChild(modalHost);
}

// ---------------------------------------------------------------------------
// Autosave / delete
// ---------------------------------------------------------------------------

async function maybeSaveNote(): Promise<void> {
  if (!elTextarea || !currentCallbacks) return;
  const value = elTextarea.value;
  if (value === lastSavedNote) return;
  const ok = await currentCallbacks.onSaveNote(value);
  if (ok) {
    lastSavedNote = value;
    showInlineError(null);
  } else {
    showInlineError("couldn't save note. try again.");
  }
}

async function handleDelete(): Promise<void> {
  if (!currentCallbacks || !elDeleteBtn) return;
  elDeleteBtn.disabled = true;
  const ok = await currentCallbacks.onDelete();
  if (!ok) {
    elDeleteBtn.disabled = false;
    showInlineError("couldn't delete item. try again.");
    return;
  }
  // Deletion succeeded — close without re-saving the note of an item that no
  // longer exists.
  const cb = currentCallbacks;
  teardown();
  cb.onClose();
}

function showInlineError(message: string | null): void {
  if (!elError) return;
  if (!message) {
    elError.hidden = true;
    elError.textContent = '';
    return;
  }
  elError.hidden = false;
  elError.textContent = message;
}

function teardown(): void {
  keyboardIsolation?.release();
  keyboardIsolation = null;
  unregisterThemedHost?.();
  unregisterThemedHost = null;
  if (modalHost && modalHost.parentNode) modalHost.parentNode.removeChild(modalHost);
  modalHost = null;
  elBackdrop = null;
  elBadge = null;
  elCloseBtn = null;
  elImage = null;
  elTextarea = null;
  elError = null;
  elDeleteBtn = null;
  currentItem = null;
  currentCallbacks = null;
  lastSavedNote = '';
}

/** Test-only: force-close without autosave or callbacks, for afterEach hooks. */
export function _destroyForTests(): void {
  teardown();
}
