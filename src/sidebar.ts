// src/sidebar.ts
// Phase 3 — the right-docked sidebar shell (REQUIREMENTS §1.1, §3.1).
//
// Replaces v1's bottom-right floating toolbar (src/toolbar.ts, deleted) with a
// full-height panel docked to the right edge that *resizes* the page instead of
// overlaying it. The header's four buttons (add / export / import / close) are
// wired to caller-supplied callbacks; per the Phase 3 brief add/export/import
// are no-ops for now (Phases 4/8/9 fill them in) — only close does real work,
// since closing is this phase's own job.
//
// Carried over from toolbar.ts per DEVELOPMENT_PLAN.md's reuse list: the
// closed-shadow-root host construction, inline currentColor SVG icons, the
// showError / showWarning / showConfirmDialog primitives (Phases 5, 8 and 9 all
// need them and toolbar.ts was their only home), and the design tokens from
// docs/v1-archive/UX_DESIGN.md §11 (#FEC800 accent, #FB645A error, #D6AE7C
// warning, #000000 toolbar bg, #FFFFFF / #B7B7B7 text).
//
// Phase 7 fills in the body that Phase 3 left empty: setThumbnails() renders
// the current URL's feedback items (src/thumbnails.ts does the actual <li>
// construction; this module just owns the <ul> and the empty-state toggle)
// and wires each thumbnail's "open" activation to the new onOpenItem
// callback. This module stays chrome.runtime-agnostic throughout — it is
// content.ts's job (the message-sending orchestrator, per the existing
// onAdd/onExport/onImportFile pattern) to fetch items and hand them to
// setThumbnails, and to open src/modal.ts with real save/delete callbacks
// when onOpenItem fires.

import { FeedbackItem } from './types';
import { renderThumbnailList } from './thumbnails';

export const SIDEBAR_WIDTH = 320;

export interface SidebarCallbacks {
  /** "add" header button. No-op for Phase 3 — Phase 4 wires real add-mode entry. */
  onAdd: () => void;
  /** "export" header button. No-op for Phase 3 — Phase 8 wires the real zip export. */
  onExport: () => void;
  /** "import" header button, fired once a file is chosen from the native
   *  picker. content.ts (Phase 9) runs the full §5 validation ladder and the
   *  confirm-then-replace round trip. */
  onImportFile: (file: File) => void;
  /** "close" header button. Fired *after* the sidebar has already hidden
   *  itself and the page layout has been restored — the caller's only job is
   *  to tell the background service worker so it can clear the persisted
   *  per-tab "sidebar open" state (§1.1). */
  onClose: () => void;
  /** A thumbnail was activated (click or Enter/Space) — the caller opens the
   *  enlarged modal (src/modal.ts) for this item (§1.5, §3.3). */
  onOpenItem: (item: FeedbackItem) => void;
}

// ---------------------------------------------------------------------------
// Inline currentColor SVG icons (pattern and paths lifted from toolbar.ts)
// ---------------------------------------------------------------------------

const ICON_ADD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M12,2a1,1,0,0,1,1,1V11h8a1,1,0,0,1,0,2H13v8a1,1,0,0,1-2,0V13H3a1,1,0,0,1,0-2h8V3A1,1,0,0,1,12,2Z"/></svg>`;

const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M9.878,18.122a3,3,0,0,0,4.244,0l3.211-3.211A1,1,0,0,0,15.919,13.5l-2.926,2.927L13,1a1,1,0,0,0-1-1h0a1,1,0,0,0-1,1l-.009,15.408L8.081,13.5a1,1,0,0,0-1.414,1.415Z"/><path d="M23,16h0a1,1,0,0,0-1,1v4a1,1,0,0,1-1,1H3a1,1,0,0,1-1-1V17a1,1,0,0,0-1-1H1a1,1,0,0,0-1,1v4a3,3,0,0,0,3,3H21a3,3,0,0,0,3-3V17A1,1,0,0,0,23,16Z"/></svg>`;

const ICON_UPLOAD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M11.007,2.578,11,18.016a1,1,0,0,0,1,1h0a1,1,0,0,0,1-1l.007-15.421,2.912,2.913a1,1,0,0,0,1.414,0h0a1,1,0,0,0,0-1.414L14.122.879a3,3,0,0,0-4.244,0L6.667,4.091a1,1,0,0,0,0,1.414h0a1,1,0,0,0,1.414,0Z"/><path d="M22,17v4a1,1,0,0,1-1,1H3a1,1,0,0,1-1-1V17a1,1,0,0,0-1-1H1a1,1,0,0,0-1,1v4a3,3,0,0,0,3,3H21a3,3,0,0,0,3-3V17a1,1,0,0,0-1-1h0A1,1,0,0,0,22,17Z"/></svg>`;

const ICON_CROSS_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><polygon points="18.707 6.707 17.293 5.293 12 10.586 6.707 5.293 5.293 6.707 10.586 12 5.293 17.293 6.707 18.707 12 13.414 17.293 18.707 18.707 17.293 13.414 12 18.707 6.707"/></svg>`;

/** Default warning-bar icon. Exported so later phases can pass their own to
 *  showWarning() while still having the default to fall back on. */
export const ICON_EXCLAMATION = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><g><path d="M12,1C6.916,1,1.081,2.25,1.081,12s5.835,11,10.919,11,10.919-1.25,10.919-11S17.084,1,12,1Zm0,20c-5.354,0-8.919-1.53-8.919-9S6.646,3,12,3s8.919,1.53,8.919,9-3.565,9-8.919,9Z"/><path d="M12,6.461c-.553,0-1,.447-1,1v5.667c0,.553,.447,1,1,1s1-.447,1-1V7.461c0-.553-.447-1-1-1Z"/></g><path d="M12,15.544c-.552,0-.999,.447-.999,.999s.447,.999,.999,.999,.999-.447,.999-.999-.447-.999-.999-.999Z"/></svg>`;

/** Error-bar icon (v1's woozy face — kept for visual continuity). */
const ICON_FACE_WOOZY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M12,0C5.383,0,0,5.383,0,12s5.383,12,12,12,12-5.383,12-12S18.617,0,12,0Zm0,22c-5.514,0-10-4.486-10-10S6.486,2,12,2s10,4.486,10,10-4.486,10-10,10ZM5.37,9.334l-.742-1.857c1.188-.474,2.268-1.373,3.04-2.531l1.664,1.109c-1.01,1.514-2.38,2.647-3.962,3.279Zm8.63,.666c0-1.657,.672-3,1.5-3s1.5,1.343,1.5,3-.672,3-1.5,3-1.5-1.343-1.5-3Zm-7.447,1.105l4-2,.895,1.789-4,2-.895-1.789Zm10.582,3.394l1.731,1c-.337,.584-2.129,3.5-4.289,3.5-.903,0-1.609-.68-2.232-1.28-.263-.252-.702-.676-.884-.724-.149,.003-.338,.124-.656,.335-.423,.282-1.002,.668-1.805,.668-1.276,0-3.018-1.604-3.707-2.293l1.414-1.415c.85,.849,1.951,1.663,2.311,1.708,.171,0,.359-.121,.678-.333,.423-.282,1.002-.668,1.805-.668,.903,0,1.609,.68,2.232,1.28,.263,.252,.702,.676,.884,.724,.684-.003,1.91-1.456,2.519-2.504Z"/></svg>`;

// ---------------------------------------------------------------------------
// CSS — tokens carried over from docs/v1-archive/UX_DESIGN.md §11
// ---------------------------------------------------------------------------

const SIDEBAR_CSS = `
  :host {
    --accent:     #FEC800;
    --error:      #FB645A;
    --warning:    #D6AE7C;
    --bg:         #000000;
    --bg-panel:   #141414;
    --text:       #FFFFFF;
    --text-muted: #B7B7B7;
    --border:     rgba(255,255,255,0.10);

    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: var(--text);
  }

  *, *::before, *::after { box-sizing: border-box; }

  /* Docked panel. top/bottom rather than height:100vh — 100vh is unreliable
     under browser zoom and on mobile-emulating viewports, and fixed insets
     always resolve against the same box the sidebar is positioned in. */
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    width: ${SIDEBAR_WIDTH}px;
    background: var(--bg-panel);
    color: var(--text);
    display: flex;
    flex-direction: column;
    box-shadow: -2px 0 16px rgba(0,0,0,0.35);
    z-index: 2147483645;
  }
  .sidebar[hidden] { display: none !important; }

  .header {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    height: 56px;
    padding: 0 8px;
    gap: 4px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }

  .icon-btn {
    width: 40px;
    height: 40px;
    padding: 8px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease, background-color 120ms ease;
  }
  .icon-btn:hover { color: var(--accent); background: rgba(255,255,255,0.06); }
  .icon-btn:active .icon { transform: scale(0.88); }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .icon-btn[disabled] { cursor: default; opacity: 0.38; }
  .icon-btn[disabled]:hover { color: var(--text); background: transparent; }

  .icon-btn .icon {
    width: 20px;
    height: 20px;
    display: inline-flex;
    transition: transform 80ms ease;
  }
  .icon-btn .icon svg { width: 100%; height: 100%; display: block; }

  /* ─── Notification bar (error / warning) ──────────────────────────────
     Carried over from toolbar.ts, collapsed into one bar with a colour
     modifier since only one message is ever shown at a time. */
  .notif { flex-shrink: 0; background: var(--bg); }
  .notif[hidden] { display: none !important; }

  .countdown-bar {
    width: 100%;
    height: 3px;
    background: var(--error);
    transform-origin: left center;
    transform: scaleX(1);
  }
  .countdown-bar[hidden] { display: none !important; }
  .notif.warning .countdown-bar { background: var(--warning); }

  .notif-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    min-height: 32px;
    padding: 8px 12px;
    gap: 6px;
    color: var(--error);
  }
  .notif.warning .notif-row { color: var(--warning); }

  .notif-row .icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: inline-flex;
  }
  .notif-row .icon svg { width: 100%; height: 100%; display: block; }

  .notif-text {
    font-size: 12px;
    line-height: 14px;
    flex: 1 1 auto;
    word-break: break-word;
  }

  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
  }

  .empty-state {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
    margin-top: 48px;
    padding: 0 12px;
  }
  .empty-state[hidden] { display: none !important; }

  .thumbnail-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .thumbnail-list[hidden] { display: none !important; }

  /* ─── Thumbnails (Phase 7, §1.5/§3.3) ─────────────────────────────────── */

  .thumbnail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: pointer;
    border-radius: 8px;
    padding: 6px;
    transition: background-color 120ms ease;
  }
  .thumbnail:hover { background: rgba(255,255,255,0.06); }
  .thumbnail:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .thumbnail-image-wrap {
    position: relative;
    width: 100%;
    border-radius: 6px;
    overflow: hidden;
    background: #000000;
    line-height: 0;
  }

  .thumbnail-image {
    width: 100%;
    height: auto;
    display: block;
  }

  .thumbnail-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #000000;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
  }

  .thumbnail-note {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
    word-break: break-word;
  }
  .thumbnail-note-empty {
    color: var(--text-muted);
    font-style: italic;
  }
`;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let sidebarHost: HTMLDivElement | null = null;
let sidebarShadow: ShadowRoot | null = null;

let elSidebar: HTMLDivElement | null = null;
let elBtnAdd: HTMLButtonElement | null = null;
let elBtnExport: HTMLButtonElement | null = null;
let elBtnImport: HTMLButtonElement | null = null;
let elBtnClose: HTMLButtonElement | null = null;
let elFileInput: HTMLInputElement | null = null;
let elEmptyState: HTMLParagraphElement | null = null;
let elThumbnailList: HTMLUListElement | null = null;
let elNotif: HTMLDivElement | null = null;
let elNotifIcon: HTMLSpanElement | null = null;
let elNotifText: HTMLSpanElement | null = null;
let elCountdownBar: HTMLDivElement | null = null;

let callbacksRef: SidebarCallbacks | null = null;
let visible = false;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDOM(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = SIDEBAR_CSS;
  shadow.appendChild(style);

  elSidebar = document.createElement('div');
  elSidebar.className = 'sidebar';
  elSidebar.setAttribute('role', 'complementary');
  elSidebar.setAttribute('aria-label', 'annotator sidebar');
  elSidebar.hidden = true;

  const header = document.createElement('div');
  header.className = 'header';

  elBtnAdd = makeIconButton(ICON_ADD, 'add feedback');
  elBtnExport = makeIconButton(ICON_DOWNLOAD, 'export feedback');
  elBtnImport = makeIconButton(ICON_UPLOAD, 'import feedback');
  elBtnClose = makeIconButton(ICON_CROSS_SMALL, 'close sidebar');

  header.appendChild(elBtnAdd);
  header.appendChild(elBtnExport);
  header.appendChild(elBtnImport);
  header.appendChild(elBtnClose);

  // Notification bar — live region so a screen reader announces errors and
  // warnings that appear without the user having focused anything.
  elNotif = document.createElement('div');
  elNotif.className = 'notif';
  elNotif.setAttribute('role', 'alert');
  elNotif.hidden = true;

  elCountdownBar = document.createElement('div');
  elCountdownBar.className = 'countdown-bar';
  elCountdownBar.hidden = true;

  const notifRow = document.createElement('div');
  notifRow.className = 'notif-row';
  elNotifIcon = document.createElement('span');
  elNotifIcon.className = 'icon';
  elNotifIcon.innerHTML = ICON_FACE_WOOZY;
  elNotifText = document.createElement('span');
  elNotifText.className = 'notif-text';
  notifRow.appendChild(elNotifIcon);
  notifRow.appendChild(elNotifText);

  elNotif.appendChild(elCountdownBar);
  elNotif.appendChild(notifRow);

  const body = document.createElement('div');
  body.className = 'body';

  elEmptyState = document.createElement('p');
  elEmptyState.className = 'empty-state';
  elEmptyState.textContent = 'no feedback on this page yet';

  elThumbnailList = document.createElement('ul');
  elThumbnailList.className = 'thumbnail-list';
  elThumbnailList.hidden = true;

  body.appendChild(elEmptyState);
  body.appendChild(elThumbnailList);

  elFileInput = document.createElement('input');
  elFileInput.type = 'file';
  elFileInput.accept = '.zip';
  elFileInput.style.display = 'none';

  elSidebar.appendChild(header);
  elSidebar.appendChild(elNotif);
  elSidebar.appendChild(body);
  elSidebar.appendChild(elFileInput);

  shadow.appendChild(elSidebar);
}

function makeIconButton(svgMarkup: string, ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.setAttribute('aria-label', ariaLabel);
  btn.title = ariaLabel;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Idempotent: a second call only refreshes the callbacks (mirrors content.ts's
 *  own double-injection guard — cross-cutting gotcha #6). Building the DOM does
 *  not make the sidebar visible; call openSidebar() for that. */
export function initSidebar(callbacks: SidebarCallbacks): void {
  if (sidebarHost) {
    callbacksRef = callbacks;
    return;
  }
  callbacksRef = callbacks;

  sidebarHost = document.createElement('div');
  sidebarHost.id = 'annotator-sidebar-host';
  // Zero-size positioning host, same trick as toolbar.ts: the actual panel
  // inside the shadow root does its own `position: fixed`. Attached to
  // <html> rather than <body> so an SPA replacing document.body (or a
  // framework re-rendering into it) cannot take the sidebar with it.
  sidebarHost.style.cssText =
    'position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483645; pointer-events: none;';

  sidebarShadow = sidebarHost.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(sidebarHost);

  buildDOM(sidebarShadow);

  elSidebar!.style.pointerEvents = 'auto';

  elBtnAdd!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onAdd();
  });

  elBtnExport!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onExport();
  });

  elBtnImport!.addEventListener('click', (e) => {
    e.stopPropagation();
    elFileInput!.click();
  });

  elFileInput!.addEventListener('change', () => {
    const file = elFileInput!.files?.[0];
    if (file) callbacksRef?.onImportFile(file);
    elFileInput!.value = '';
  });

  elBtnClose!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSidebar();
    callbacksRef?.onClose();
  });
}

/** True once initSidebar() has built the host — content.ts uses this to avoid
 *  toggling a sidebar that was never constructed. */
export function isSidebarInitialised(): boolean {
  return sidebarHost !== null;
}

/** Show the sidebar and shrink the page to make room for it. Safe to call when
 *  already open (re-asserts visibility and the page resize). */
export function openSidebar(): void {
  if (!elSidebar) return;
  elSidebar.hidden = false;
  visible = true;
  applyPageResize();
}

/** Hide the sidebar and restore the page's original layout exactly as it was
 *  before openSidebar() ran. Safe to call when already closed. */
export function closeSidebar(): void {
  if (elSidebar) elSidebar.hidden = true;
  visible = false;
  clearMessage();
  restorePageResize();
}

export function isSidebarVisible(): boolean {
  return visible;
}

/** Disable/enable the export header button (Phase 8, §1.6). Assembling a
 *  multi-URL zip is an async round trip with no other on-screen affordance,
 *  so content.ts disables this for the duration to prevent a second export
 *  starting (and downloading) before the first finishes. */
export function setExportButtonEnabled(enabled: boolean): void {
  if (elBtnExport) elBtnExport.disabled = !enabled;
}

/** Disable/enable the import header button (Phase 9, §1.7). Mirrors
 *  setExportButtonEnabled: parsing + validating a zip and the confirm-then-
 *  replace round trip is asynchronous with no other on-screen affordance, so
 *  content.ts disables this for the duration to prevent a second file pick
 *  from overlapping the first. */
export function setImportButtonEnabled(enabled: boolean): void {
  if (elBtnImport) elBtnImport.disabled = !enabled;
}

/**
 * Repaint the thumbnail list for whatever items content.ts fetched for the
 * current URL (§1.5 — "current URL only"; newest-at-the-bottom is the
 * caller's responsibility, since storage.ts's getPageItems already returns
 * capture order). Shows the empty state (§3.1's "no feedback on this page
 * yet") when `items` is empty. content.ts calls this after every
 * GET_PAGE_ITEMS round trip: on open, on SPA navigation, and after a
 * successful capture or a modal close (edit/delete).
 */
export function setThumbnails(items: FeedbackItem[]): void {
  if (!elEmptyState || !elThumbnailList || !callbacksRef) return;
  if (items.length === 0) {
    elEmptyState.hidden = false;
    elThumbnailList.hidden = true;
    elThumbnailList.innerHTML = '';
    return;
  }
  elEmptyState.hidden = true;
  elThumbnailList.hidden = false;
  renderThumbnailList(elThumbnailList, items, {
    onOpen: (item) => callbacksRef?.onOpenItem(item),
  });
}

/** Full teardown: removes the host from the DOM and restores page layout. Not
 *  part of the normal open/close cycle (§1.1's "close hides the sidebar,
 *  content script stays loaded") — this exists for tests and for a hard reset
 *  if the content script is ever torn down without a page navigation. */
export function destroySidebar(): void {
  clearMessage();
  restorePageResize();
  if (sidebarHost && sidebarHost.parentNode) {
    sidebarHost.parentNode.removeChild(sidebarHost);
  }
  sidebarHost = null;
  sidebarShadow = null;
  elSidebar = null;
  elBtnAdd = null;
  elBtnExport = null;
  elBtnImport = null;
  elBtnClose = null;
  elFileInput = null;
  elEmptyState = null;
  elThumbnailList = null;
  elNotif = null;
  elNotifIcon = null;
  elNotifText = null;
  elCountdownBar = null;
  callbacksRef = null;
  visible = false;
}

// ---------------------------------------------------------------------------
// Notifications — carried over from toolbar.ts (showError / showWarning /
// showConfirmDialog). All copy passed in must already be lowercase (§3.4);
// these render it verbatim so the §5 error-table strings stay byte-exact.
// ---------------------------------------------------------------------------

const NOTIF_DURATION_MS = 8000;

/** Show the error bar inside the sidebar. Auto-clears after 8s. */
export function showError(message: string): void {
  showNotif('error', message, ICON_FACE_WOOZY);
}

/** Show the warning bar inside the sidebar. Auto-clears after 8s. Pass
 *  `customIcon` to swap the default exclamation for this one message. */
export function showWarning(message: string, customIcon?: string): void {
  showNotif('warning', message, customIcon ?? ICON_EXCLAMATION);
}

function showNotif(kind: 'error' | 'warning', message: string, icon: string): void {
  if (!elNotif || !elNotifText || !elNotifIcon) return;
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  elNotif.classList.toggle('warning', kind === 'warning');
  elNotifIcon.innerHTML = icon;
  elNotifText.textContent = message;
  elNotif.hidden = false;
  startCountdownAnim();
  notifTimer = setTimeout(() => {
    notifTimer = null;
    clearMessage();
  }, NOTIF_DURATION_MS);
}

/** Hide whatever notification is showing and cancel its auto-clear timer. */
export function clearMessage(): void {
  if (notifTimer !== null) {
    clearTimeout(notifTimer);
    notifTimer = null;
  }
  if (!elNotif || !elNotifText) return;
  elNotif.hidden = true;
  elNotif.classList.remove('warning');
  elNotifText.textContent = '';
  stopCountdownAnim();
}

/** Animate the countdown bar from full width to zero over the notification
 *  duration, as a visual timer. Colour comes from the .warning modifier on the
 *  parent, so nothing to set here. */
function startCountdownAnim(): void {
  if (!elCountdownBar) return;
  elCountdownBar.hidden = false;
  // Snap to full width with no transition...
  elCountdownBar.style.transition = 'none';
  elCountdownBar.style.transform = 'scaleX(1)';
  // ...then force a reflow so the reset actually takes effect before the next
  // transition is applied. Without this the browser collapses both style
  // changes into one frame and the animation never runs.
  void elCountdownBar.offsetWidth;
  elCountdownBar.style.transition = `transform ${NOTIF_DURATION_MS}ms linear`;
  elCountdownBar.style.transform = 'scaleX(0)';
}

function stopCountdownAnim(): void {
  if (!elCountdownBar) return;
  elCountdownBar.hidden = true;
  elCountdownBar.style.transition = 'none';
  elCountdownBar.style.transform = 'scaleX(1)';
}

/** Native browser confirm — kept lowercase per §3.4. Async-shaped because
 *  Phase 9's import flow awaits it and may later swap in a styled dialog. */
export function showConfirmDialog(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message));
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE RESIZE — the hard part of Phase 3 (DEVELOPMENT_PLAN.md §Phase 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Goal (§1.1, §3.1): the sidebar must *shrink the page's usable width* rather
// than float over it, so page content is never covered — and §1.2 step 1 leans
// on that ("the sidebar does not need to be hidden for a capture, since the
// page's visible viewport never extends under it").
//
// ── Strategy: shrink the root element's box with a right margin ────────────
//
// Applied to `document.documentElement` (never <body> — see "why the root"
// below), as four !important inline declarations:
//
//     margin-right: 320px    the actual shrink
//     width:        auto     defeats page CSS that pins html's width
//     min-width:    0        defeats page CSS that floors html's width
//     overflow-x:   hidden   clips whatever refuses to shrink anyway
//
// `margin-right` rather than `width: calc(100% - 320px)`, which was the
// previous implementation and is subtly worse:
//
//   * With `width`, the declaration only describes the *content* box under
//     content-box sizing, so any padding or border the page puts on <html>
//     is added on top and the root box overflows into the sidebar strip by
//     exactly that much. The previous implementation papered over this by
//     also forcing `box-sizing: border-box !important` on <html> — which is
//     actively dangerous, because the extremely common
//     `html { box-sizing: border-box } *, *::before, *::after { box-sizing:
//     inherit }` reset means every element on the page inherits its sizing
//     model from the root. Overriding the root's box-sizing there silently
//     re-sizes the *entire page*. With `margin-right` + `width: auto` the
//     used width is "containing block − margins − border − padding" by
//     definition, so the shrink is exact under either sizing model and we
//     never have to touch box-sizing at all.
//   * `width: auto` also beats the `html { width: 100vw }` pattern, where a
//     page-authored width would otherwise win over our margin and reintroduce
//     the overflow. `min-width: 0` does the same for fixed-width legacy
//     layouts that floor the root.
//
// ── Why the root element and not <body> ────────────────────────────────────
//
// Percentage/auto widths on the root resolve against the initial containing
// block — the real viewport — so the shrink is independent of whatever the
// page's own CSS does further down. Shrinking <body> instead would be
// defeated by any page that positions its layout off <html>, and would leave
// the document's own scrollbar geometry inconsistent.
//
// Root-element `overflow` is also special: the used value is *propagated to
// the viewport* and the root itself is then treated as `overflow: visible`.
// That matters twice over — (a) it suppresses the second, document-level
// horizontal scrollbar that a `100vw` hero or an over-wide table would
// otherwise grow next to the sidebar, and (b) because the root never actually
// becomes a scroll container, `position: sticky` elements inside the page keep
// working, which a plain `overflow: hidden` on <body> would break.
//
// ── Scrollbar geometry ─────────────────────────────────────────────────────
//
// The document's vertical scrollbar is painted by the viewport, and the
// initial containing block excludes it. Our panel is `position: fixed;
// right: 0` with no transformed ancestor, so it too is laid out in the initial
// containing block. Both the shrink and the panel therefore measure from the
// *inner* edge of the scrollbar: the panel lands exactly in the gap the margin
// opened, and the page's scrollbar stays visible and grabbable to its right.
//
// ── The accepted limitation: the page's own fixed/full-screen elements ─────
//
// A width change on an ancestor does not move a `position: fixed` descendant —
// only `transform` / `filter` / `will-change: transform` on an ancestor
// re-parents it, by making that ancestor its containing block. So a page's
// fixed header, cookie banner or chat bubble still spans the full viewport and
// slides under the sidebar strip; likewise an app-shell layout that sets
// `html, body { overflow: hidden }` and lays everything out in `position:
// fixed; inset: 0` containers ignores the shrink entirely.
//
// The transform trick was tried and rejected: our own host is unavoidably a
// descendant of <html>, so a transform there would capture the *sidebar's* own
// fixed positioning into the shrunken box and walk it off the screen edge —
// and there is no way to exempt one fixed descendant from an ancestor's
// containing block. Applying the transform to <body> instead (host stays on
// <html>, so it escapes) fails differently and worse: a transformed ancestor
// makes fixed descendants scroll with the page, so every sticky header on the
// web would start scrolling away. Neither is acceptable, so the fixed-element
// case degrades gracefully instead: the sidebar is opaque and at the top of
// the stacking order, so those elements read as "covered by the panel" rather
// than as broken layout, and they are still fully reachable by closing it.
//
// ── Keeping the shrink applied ─────────────────────────────────────────────
//
// Page JS that assigns `documentElement.style.cssText` wholesale (or removes
// the style attribute) would silently drop our declarations and un-shrink the
// page while the sidebar is still on screen — content would end up underneath
// it. A MutationObserver on the root's style attribute re-asserts the four
// declarations if they go missing, with a hard cap so we can never end up in a
// re-write war with a page that is fighting back.
//
// Restoration is per-property, not a whole-cssText snapshot: we record each
// managed property's pre-open value and priority and put exactly those back,
// leaving any *other* inline style the page set in the meantime alone. A
// cssText snapshot would revert those too (e.g. silently undoing a page's own
// `html.style.overflow = 'hidden'` scroll lock set after the sidebar opened).
//
// ── Telling the page to re-measure ─────────────────────────────────────────
//
// Shrinking the root does not change `window.innerWidth`, so no native resize
// event fires. Layouts that measure in JS rather than in CSS — canvas charts,
// virtualised lists, carousels — would keep their pre-shrink geometry. A
// synthetic `resize` event after apply and after restore nudges them to
// re-measure; ResizeObserver-based layouts already fire on their own.
// ═══════════════════════════════════════════════════════════════════════════

const MANAGED_HTML_PROPS: ReadonlyArray<[prop: string, value: string]> = [
  ['margin-right', `${SIDEBAR_WIDTH}px`],
  ['width', 'auto'],
  ['min-width', '0px'],
  ['overflow-x', 'hidden'],
];

interface SavedDecl {
  value: string;
  priority: string;
}

/** Pre-open values of the managed properties. `null` when no resize is applied. */
let savedHtmlDecls: Map<string, SavedDecl> | null = null;

/** The managed declarations as the user agent actually stored them, captured on
 *  write. Compared against on every style mutation to spot a page wiping them. */
let appliedValues: Map<string, string> | null = null;

let htmlStyleObserver: MutationObserver | null = null;
let reassertCount = 0;

/** Ceiling on how many times we re-apply the shrink after the page wipes it.
 *  Generous enough for normal SPA churn, low enough that a page actively
 *  rewriting <html>'s style attribute cannot spin us forever. */
const MAX_REASSERTS = 50;

function applyPageResize(): void {
  const html = document.documentElement;

  if (savedHtmlDecls === null) {
    const saved = new Map<string, SavedDecl>();
    for (const [prop] of MANAGED_HTML_PROPS) {
      saved.set(prop, {
        value: html.style.getPropertyValue(prop),
        priority: html.style.getPropertyPriority(prop),
      });
    }
    savedHtmlDecls = saved;
    reassertCount = 0;
  }

  writeManagedProps();
  startHtmlStyleObserver();
  notifyPageOfResize();
}

function restorePageResize(): void {
  stopHtmlStyleObserver();
  if (savedHtmlDecls === null) return;

  const html = document.documentElement;
  for (const [prop] of MANAGED_HTML_PROPS) {
    const saved = savedHtmlDecls.get(prop);
    html.style.removeProperty(prop);
    if (saved && saved.value !== '') {
      html.style.setProperty(prop, saved.value, saved.priority);
    }
  }
  savedHtmlDecls = null;
  appliedValues = null;
  reassertCount = 0;
  notifyPageOfResize();
}

function writeManagedProps(): void {
  const html = document.documentElement;
  const seen = new Map<string, string>();
  for (const [prop, value] of MANAGED_HTML_PROPS) {
    html.style.setProperty(prop, value, 'important');
    // Read back rather than trusting what we wrote: user agents normalise
    // declarations on the way in (Chrome stores `min-width: 0` as `0px`), and
    // comparing against the un-normalised string would make managedPropsIntact()
    // permanently false and put the observer in a pointless rewrite loop.
    seen.set(prop, html.style.getPropertyValue(prop));
  }
  appliedValues = seen;
  // Discard the records our own writes just queued so the observer only ever
  // reacts to the *page's* mutations. A boolean guard would not work: observer
  // callbacks are delivered asynchronously, long after the flag was cleared.
  htmlStyleObserver?.takeRecords();
}

function managedPropsIntact(): boolean {
  if (!appliedValues) return false;
  const html = document.documentElement;
  for (const [prop, value] of appliedValues) {
    if (html.style.getPropertyValue(prop) !== value) return false;
  }
  return true;
}

function startHtmlStyleObserver(): void {
  if (htmlStyleObserver || typeof MutationObserver === 'undefined') return;
  htmlStyleObserver = new MutationObserver(() => {
    if (savedHtmlDecls === null || managedPropsIntact()) return;
    if (reassertCount >= MAX_REASSERTS) {
      stopHtmlStyleObserver();
      return;
    }
    reassertCount++;
    writeManagedProps();
  });
  htmlStyleObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

function stopHtmlStyleObserver(): void {
  htmlStyleObserver?.disconnect();
  htmlStyleObserver = null;
}

/** Synthetic resize event so JS-measured layouts re-read their box. Wrapped
 *  because a page listener throwing must not take the sidebar down with it. */
function notifyPageOfResize(): void {
  try {
    window.dispatchEvent(new Event('resize'));
  } catch {
    // Page listener threw — not ours to handle.
  }
}

/** Test-only: assert the current state of the page-resize machinery without
 *  exposing the module's mutable internals. */
export function _pageResizeStateForTests(): {
  applied: boolean;
  observing: boolean;
  reasserts: number;
} {
  return {
    applied: savedHtmlDecls !== null,
    observing: htmlStyleObserver !== null,
    reasserts: reassertCount,
  };
}
