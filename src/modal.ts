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
import {
  getThemeCSS,
  registerThemedHost,
  FOCUS_RING_CSS,
  PRESS_SCALE_CSS,
  STATE_TRANSITION_CSS,
  DISABLED_CSS,
} from './theme';

/** Highest possible z-index — see the file banner for why the host needs an
 *  explicit value at all rather than relying on DOM order. */
const MODAL_HOST_Z_INDEX = 2147483647;

/** id of the header title, for the dialog's aria-labelledby. */
const MODAL_TITLE_ID = 'annotator-modal-title';

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
    font-family: var(--sal-font-body);
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
    background: var(--sal-backdrop);
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
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-lg);
    box-shadow: var(--sal-shadow-pop);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 8px 10px 8px 16px;
    border-bottom: 1px solid var(--sal-line);
  }

  .item-badge {
    font-family: var(--sal-font-display);
    font-style: italic;
    font-weight: 400;
    font-size: 20px;
    color: var(--sal-text);
  }

  .close-btn {
    width: 32px;
    height: 32px;
    padding: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--sal-radius-md);
    color: var(--sal-muted);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .close-btn:hover { background: var(--sal-hover); color: var(--sal-text); }
  .close-btn:active { background: var(--sal-press); color: var(--sal-text); ${PRESS_SCALE_CSS} }
  .close-btn:focus-visible {
    outline: none;
    color: var(--sal-text);
    ${FOCUS_RING_CSS}
  }
  .close-btn svg { width: 18px; height: 18px; display: block; }

  .image-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sal-bg);
    padding: 12px;
  }

  .screenshot {
    max-width: 100%;
    max-height: 60vh;
    display: block;
    border-radius: var(--sal-radius-md);
    object-fit: contain;
  }

  /* Note editor: same merged textarea + footer-bar feel as the add-mode
     comment box (§3.2) — no gap/border between the two, only the footer
     bar's own top divider, so it still reads as one surface even though
     (unlike the floating comment box) this editor lives inside the modal
     panel rather than owning its own radius/shadow. */
  .note-editor {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .note-input {
    width: 100%;
    height: 88px;
    resize: vertical;
    background: var(--sal-surface);
    border: none;
    padding: 10px 12px;
    font-size: 13px;
    font-family: inherit;
    color: var(--sal-text);
    display: block;
  }
  .note-input::placeholder { color: var(--sal-muted); }
  /* Hover/focus only darken the text area's own edge — the outer panel never
     changes (§3.2: "no soft/secondary yellow ring anywhere"). */
  .note-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  .note-input:focus {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--sal-accent);
  }

  /* 36px bar + its 1px divider (content-box, exactly like the add-mode
     comment box's footer), so the 36px delete button fills it edge to edge. */
  .footer-bar {
    box-sizing: content-box;
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 8px;
    padding: 0 0 0 12px;
    border-top: 1px solid var(--sal-line);
  }

  .inline-error {
    align-self: center;
    font-size: 12px;
    color: var(--sal-danger);
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inline-error[hidden] { display: none !important; }

  /* Danger button (design spec §3.3: 36px) sitting flush in the bar — the
     "flush in the bar" variant the spec allows, matching the add-mode
     comment box's flush save/cancel: full bar height, flush against the
     right and bottom edges, square corners except the bottom-right, which
     follows the panel radius. No press-scale (shrinking a flush button
     opens gaps against the bar edges) and an *inset* focus ring (an outer
     ring would be clipped by the panel's overflow: hidden). */
  .delete-btn {
    height: 36px;
    margin: 0;
    padding: 0 16px;
    border-radius: 0 0 calc(var(--sal-radius-lg) - 1px) 0;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: var(--sal-danger-soft);
    color: var(--sal-danger);
    flex-shrink: 0;
    ${STATE_TRANSITION_CSS}
  }
  .delete-btn:hover:not(:disabled) { background: var(--sal-danger-hover); }
  .delete-btn:active:not(:disabled) { background: var(--sal-danger-press); }
  .delete-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--sal-focus);
  }
  .delete-btn:disabled { ${DISABLED_CSS} }
`;

// 1.8px stroke, round caps/joins, currentColor, 18px in the 32px close button
// (design spec §1's icon table: `close: M6 6l12 12M18 6L6 18`).
const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

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

  // Move focus into the dialog (aria-modal promises it's there): the note
  // is what this modal is for, so start in it. Returning focus on close is
  // the caller's job (content.ts refocuses the thumbnail after its repaint)
  // — the opener lives in the sidebar's own closed shadow root, out of
  // reach from here.
  elTextarea!.focus({ preventScroll: true });
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
  // Named by the "feedback #n" title in the header.
  elBackdrop.setAttribute('aria-labelledby', MODAL_TITLE_ID);
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
  // Scoped to this closed shadow root, so it can't collide with page ids.
  elBadge.id = MODAL_TITLE_ID;

  elCloseBtn = document.createElement('button');
  elCloseBtn.type = 'button';
  elCloseBtn.className = 'close-btn';
  elCloseBtn.setAttribute('aria-label', 'close');
  elCloseBtn.title = 'close';
  elCloseBtn.innerHTML = ICON_CLOSE;
  elCloseBtn.addEventListener('click', () => void closeModal());

  header.appendChild(elBadge);
  header.appendChild(elCloseBtn);

  const imageArea = document.createElement('div');
  imageArea.className = 'image-area';
  elImage = document.createElement('img');
  elImage.className = 'screenshot';
  elImage.alt = 'captured feedback screenshot';
  imageArea.appendChild(elImage);

  // Note editor: textarea + footer bar merged into one visual surface, same
  // shape as the add-mode comment box (§3.2) — see the .note-editor CSS
  // comment for why this doesn't also need its own radius/shadow/border here.
  const noteEditor = document.createElement('div');
  noteEditor.className = 'note-editor';

  elTextarea = document.createElement('textarea');
  elTextarea.className = 'note-input';
  elTextarea.placeholder = 'add a note...';
  elTextarea.setAttribute('aria-label', 'note');
  elTextarea.addEventListener('blur', () => void maybeSaveNote());

  const footerBar = document.createElement('div');
  footerBar.className = 'footer-bar';

  elError = document.createElement('span');
  elError.className = 'inline-error';
  elError.hidden = true;

  elDeleteBtn = document.createElement('button');
  elDeleteBtn.type = 'button';
  elDeleteBtn.className = 'delete-btn';
  elDeleteBtn.textContent = 'delete';
  elDeleteBtn.addEventListener('click', () => void handleDelete());

  footerBar.appendChild(elError);
  footerBar.appendChild(elDeleteBtn);

  noteEditor.appendChild(elTextarea);
  noteEditor.appendChild(footerBar);

  panel.appendChild(header);
  panel.appendChild(imageArea);
  panel.appendChild(noteEditor);
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
  // Detach state before removing the host: the textarea holds focus, and an
  // engine that fires blur on removal must not trigger a save from here.
  const host = modalHost;
  modalHost = null;
  currentCallbacks = null;
  if (host && host.parentNode) host.parentNode.removeChild(host);
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
