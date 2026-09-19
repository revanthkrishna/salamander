// src/addMode.ts
// Phase 4 — the add-mode selection interaction (REQUIREMENTS §1.2, §3.2).
//
// Scope: crosshair-cursor click-to-place, a default 200x150 box clamped to
// the viewport, 8 resize handles (20x20 minimum), a macOS-screenshot-style
// dimming scrim outside the box, full suppression of page interaction while
// active, and the attached comment box (textarea / counter / cancel / ok).
//
// What this module does NOT do: capture a screenshot, talk to the service
// worker, or build DOM/context data. That is Phase 5 (src/capture.ts) and
// Phase 6 (src/contextCapture.ts, already built) — this module only produces
// a selection rect + note text via AddModeCallbacks.onOk, and exposes
// hideOverlayUI()/showOverlayUI() for Phase 5 to wrap around the actual
// capture call so none of this UI ever appears in the screenshot (§1.2 step
// 44.1).
//
// Positioning note (conceptual reuse only, per DEVELOPMENT_PLAN.md Phase 4 —
// "all code is new"): the comment box's below -> above -> side flip logic is
// the same overflow-candidate-list idea as v1's deleted annotationMode.ts
// positionPopover() (git history, commit 869d09d), adapted from "flip around
// a point" to "flip around a rect", with a final unconditional clamp added so
// the box can never render off-screen even if none of the candidates fit.
//
// Coordinate system: the selection rect this module works with and hands
// back is in *viewport-relative CSS pixels* (MouseEvent.clientX/clientY),
// measured against the visible **page content area** — i.e. excluding the
// sidebar's docked strip on the right (§1.2 step 44.1's guarantee that the
// sidebar can never fall inside a selection, because it resizes the page
// rather than overlaying it). This module deliberately stays ignorant of
// scroll offset and DPR: src/capture.ts (Phase 5) adds the scroll offset for
// the archival page-coordinate rect (§1.4D), and the service worker converts
// to device pixels for the crop (§1.3, §6 #4/#5). The rect handed to onOk is
// passed to the capture message unchanged — viewport CSS px is already the
// right space for cropping a viewport screenshot.

import { Rect } from './types';
import { SIDEBAR_WIDTH } from './sidebar';
import { getContentViewportSize } from './capture';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AddModeResult {
  /** Selection rect in viewport-relative CSS px (see module doc comment). */
  rect: Rect;
  note: string;
}

export interface AddModeCallbacks {
  /**
   * Fired when the user clicks "ok" with a non-empty note. Add mode does
   * *not* exit itself afterward — the box/comment stay alive (buttons
   * disabled) so the capture pipeline (src/capture.ts) can call
   * hideOverlayUI() around the actual screenshot call, then either
   * exitAddMode() on success or showOverlayUI() on failure so the user can
   * retry or cancel (§1.3: a failed capture must not leave a partial item,
   * but the user should still be able to act). The blocker stays up
   * throughout, so the page is never clickable mid-capture.
   */
  onOk: (result: AddModeResult) => void;
  /** Fired after cancel has already fully torn down add mode (exitAddMode()
   *  has already run) — a notification hook only, nothing left to clean up. */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 150;
const MIN_SIZE = 20;
const HANDLE_SIZE = 10;
const COMMENT_WIDTH = 280;
const COMMENT_FALLBACK_HEIGHT = 168; // used only before first layout pass
const COMMENT_MARGIN = 8;
const MAX_NOTE_LENGTH = 1000;
const COUNTER_WARN_AT = 900;
const COUNTER_DANGER_AT = 980;

type HandleKey = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLE_KEYS: HandleKey[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const HANDLE_CURSORS: Record<HandleKey, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const ADD_MODE_CSS = `
  :host {
    --accent: #FEC800;
    --error:  #FB645A;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }

  .blocker {
    position: absolute;
    top: 0;
    left: 0;
    background: transparent;
  }
  .blocker.placing { cursor: crosshair; }

  .visuals[data-hidden="true"] { visibility: hidden; }

  .scrim-rect {
    position: absolute;
    background: rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }

  .box {
    position: absolute;
    border: 2px solid var(--accent);
    background: transparent;
    pointer-events: none;
  }

  .handle {
    position: absolute;
    width: ${HANDLE_SIZE}px;
    height: ${HANDLE_SIZE}px;
    background: var(--accent);
    border: 1px solid rgba(0, 0, 0, 0.6);
    border-radius: 2px;
    pointer-events: auto;
  }

  .comment-box {
    position: absolute;
    width: ${COMMENT_WIDTH}px;
    background: rgba(20, 20, 20, 0.98);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
    padding: 12px;
    color: #FFFFFF;
  }

  .note-input {
    width: 100%;
    height: 88px;
    resize: none;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    color: #FFFFFF;
    font-family: inherit;
    margin-bottom: 8px;
  }
  .note-input::placeholder { color: rgba(255,255,255,0.35); }
  .note-input:focus { outline: 2px solid var(--accent); outline-offset: 0; }

  .footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
  }

  .counter {
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    margin-right: auto;
    visibility: hidden;
  }
  .counter[data-warn="true"] { visibility: visible; }
  .counter[data-danger="true"] { color: var(--error); }

  .btn {
    height: 30px;
    padding: 0 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
  }
  .btn-cancel {
    background: rgba(255,255,255,0.10);
    color: #FFFFFF;
  }
  .btn-cancel:hover { background: rgba(255,255,255,0.18); }
  .btn-ok {
    background: var(--accent);
    color: #000000;
  }
  .btn-ok:disabled {
    background: rgba(254,200,0,0.30);
    color: rgba(0,0,0,0.4);
    cursor: default;
  }
`;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

type Mode = 'idle' | 'placing' | 'editing';

let mode: Mode = 'idle';
let callbacksRef: AddModeCallbacks | null = null;

let box: Rect = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
let commentHeight = COMMENT_FALLBACK_HEIGHT;

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let elBlocker: HTMLDivElement | null = null;
let elVisuals: HTMLDivElement | null = null;
let elScrimTop: HTMLDivElement | null = null;
let elScrimBottom: HTMLDivElement | null = null;
let elScrimLeft: HTMLDivElement | null = null;
let elScrimRight: HTMLDivElement | null = null;
let elBox: HTMLDivElement | null = null;
let elHandles: Partial<Record<HandleKey, HTMLDivElement>> = {};
let elComment: HTMLDivElement | null = null;
let elTextarea: HTMLTextAreaElement | null = null;
let elCounter: HTMLSpanElement | null = null;
let elCancelBtn: HTMLButtonElement | null = null;
let elOkBtn: HTMLButtonElement | null = null;

let activeHandle: HandleKey | null = null;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The selectable area: full viewport height, full viewport width minus the
 *  sidebar's docked strip (§1.2 step 44.1 — the sidebar can never fall inside
 *  a selection because the page never renders under it). Add mode is only
 *  ever entered via the sidebar's own "add" button, so the sidebar is always
 *  open while this module is active.
 *
 *  Measured against the *scrollbar-excluded* viewport (Phase 5), not
 *  `window.innerWidth`: the sidebar panel is `position: fixed; right: 0`, so
 *  it sits against the inner edge of the document's vertical scrollbar. With
 *  `innerWidth` (which includes that scrollbar) the clamp lands ~15px to the
 *  right of where the sidebar actually starts, and a selection dragged flush
 *  to the right edge captures a sliver of the sidebar itself — exactly the
 *  "no extension UI in a capture" rule (§6 #2) it exists to uphold. */
function getBounds(): { width: number; height: number } {
  const { width, height } = getContentViewportSize();
  return {
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height,
  };
}

function computeDefaultBox(clickX: number, clickY: number, bounds: { width: number; height: number }): Rect {
  const width = Math.min(DEFAULT_WIDTH, bounds.width);
  const height = Math.min(DEFAULT_HEIGHT, bounds.height);
  const x = clamp(clickX, 0, Math.max(0, bounds.width - width));
  const y = clamp(clickY, 0, Math.max(0, bounds.height - height));
  return { x, y, width, height };
}

function resizeBox(handle: HandleKey, clientX: number, clientY: number, bounds: { width: number; height: number }): Rect {
  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  let newLeft = left;
  let newTop = top;
  let newRight = right;
  let newBottom = bottom;

  if (handle.includes('w')) newLeft = clamp(clientX, 0, right - MIN_SIZE);
  if (handle.includes('e')) newRight = clamp(clientX, left + MIN_SIZE, bounds.width);
  if (handle.includes('n')) newTop = clamp(clientY, 0, bottom - MIN_SIZE);
  if (handle.includes('s')) newBottom = clamp(clientY, top + MIN_SIZE, bounds.height);

  return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
}

/** Below -> above -> right -> left, first fully-in-bounds candidate wins;
 *  falls back to "below", then unconditionally clamps into bounds so the
 *  comment box can never render off-screen even in a tiny viewport where
 *  none of the four candidates fit cleanly. */
function computeCommentPosition(
  boxRect: Rect,
  commentW: number,
  commentH: number,
  bounds: { width: number; height: number },
): { left: number; top: number } {
  const candidates = [
    { left: boxRect.x, top: boxRect.y + boxRect.height + COMMENT_MARGIN }, // below
    { left: boxRect.x, top: boxRect.y - commentH - COMMENT_MARGIN }, // above
    { left: boxRect.x + boxRect.width + COMMENT_MARGIN, top: boxRect.y }, // right
    { left: boxRect.x - commentW - COMMENT_MARGIN, top: boxRect.y }, // left
  ];

  const fit = candidates.find(
    (c) => c.left >= 0 && c.top >= 0 && c.left + commentW <= bounds.width && c.top + commentH <= bounds.height,
  );
  const chosen = fit ?? candidates[0];

  return {
    left: clamp(chosen.left, 0, Math.max(0, bounds.width - commentW)),
    top: clamp(chosen.top, 0, Math.max(0, bounds.height - commentH)),
  };
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDOM(): void {
  host = document.createElement('div');
  host.id = 'annotator-addmode-host';
  host.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483640; pointer-events: none;';

  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = ADD_MODE_CSS;
  shadow.appendChild(style);

  elBlocker = document.createElement('div');
  elBlocker.className = 'blocker';
  elBlocker.style.pointerEvents = 'auto';

  elVisuals = document.createElement('div');
  elVisuals.className = 'visuals';

  elScrimTop = document.createElement('div');
  elScrimTop.className = 'scrim-rect';
  elScrimBottom = document.createElement('div');
  elScrimBottom.className = 'scrim-rect';
  elScrimLeft = document.createElement('div');
  elScrimLeft.className = 'scrim-rect';
  elScrimRight = document.createElement('div');
  elScrimRight.className = 'scrim-rect';

  elBox = document.createElement('div');
  elBox.className = 'box';

  for (const key of HANDLE_KEYS) {
    const h = document.createElement('div');
    h.className = 'handle';
    h.style.cursor = HANDLE_CURSORS[key];
    h.dataset.handle = key;
    h.addEventListener('mousedown', (e) => startResize(key, e));
    elHandles[key] = h;
  }

  elComment = document.createElement('div');
  elComment.className = 'comment-box';
  elComment.setAttribute('role', 'dialog');
  elComment.setAttribute('aria-label', 'add feedback note');

  elTextarea = document.createElement('textarea');
  elTextarea.className = 'note-input';
  elTextarea.placeholder = 'type something...';
  elTextarea.maxLength = MAX_NOTE_LENGTH;
  elTextarea.addEventListener('input', updateCounterAndOkState);

  const footer = document.createElement('div');
  footer.className = 'footer';

  elCounter = document.createElement('span');
  elCounter.className = 'counter';

  elCancelBtn = document.createElement('button');
  elCancelBtn.type = 'button';
  elCancelBtn.className = 'btn btn-cancel';
  elCancelBtn.textContent = 'cancel';
  elCancelBtn.addEventListener('click', handleCancelClick);

  elOkBtn = document.createElement('button');
  elOkBtn.type = 'button';
  elOkBtn.className = 'btn btn-ok';
  elOkBtn.textContent = 'ok';
  elOkBtn.disabled = true;
  elOkBtn.addEventListener('click', handleOkClick);

  footer.appendChild(elCounter);
  footer.appendChild(elCancelBtn);
  footer.appendChild(elOkBtn);

  elComment.appendChild(elTextarea);
  elComment.appendChild(footer);

  elVisuals.appendChild(elScrimTop);
  elVisuals.appendChild(elScrimBottom);
  elVisuals.appendChild(elScrimLeft);
  elVisuals.appendChild(elScrimRight);
  elVisuals.appendChild(elBox);
  for (const key of HANDLE_KEYS) elVisuals.appendChild(elHandles[key]!);
  elVisuals.appendChild(elComment);

  shadow.appendChild(elBlocker);
  shadow.appendChild(elVisuals);

  document.documentElement.appendChild(host);
}

function layoutHost(bounds: { width: number; height: number }): void {
  if (!host || !elBlocker) return;
  host.style.width = `${bounds.width}px`;
  host.style.height = `${bounds.height}px`;
  elBlocker.style.width = `${bounds.width}px`;
  elBlocker.style.height = `${bounds.height}px`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBox(): void {
  const bounds = getBounds();
  layoutHost(bounds);

  if (!elBox) return;
  elBox.style.left = `${box.x}px`;
  elBox.style.top = `${box.y}px`;
  elBox.style.width = `${box.width}px`;
  elBox.style.height = `${box.height}px`;

  renderHandles();
  renderScrim(bounds);
  positionComment(bounds);
}

function renderHandles(): void {
  const half = HANDLE_SIZE / 2;
  const positions: Record<HandleKey, { x: number; y: number }> = {
    nw: { x: box.x, y: box.y },
    n: { x: box.x + box.width / 2, y: box.y },
    ne: { x: box.x + box.width, y: box.y },
    e: { x: box.x + box.width, y: box.y + box.height / 2 },
    se: { x: box.x + box.width, y: box.y + box.height },
    s: { x: box.x + box.width / 2, y: box.y + box.height },
    sw: { x: box.x, y: box.y + box.height },
    w: { x: box.x, y: box.y + box.height / 2 },
  };
  for (const key of HANDLE_KEYS) {
    const el = elHandles[key];
    const pos = positions[key];
    if (!el) continue;
    el.style.left = `${pos.x - half}px`;
    el.style.top = `${pos.y - half}px`;
  }
}

function renderScrim(bounds: { width: number; height: number }): void {
  if (!elScrimTop || !elScrimBottom || !elScrimLeft || !elScrimRight) return;

  // Top strip: full width, above the box.
  setRectStyle(elScrimTop, 0, 0, bounds.width, box.y);
  // Bottom strip: full width, below the box.
  setRectStyle(elScrimBottom, 0, box.y + box.height, bounds.width, Math.max(0, bounds.height - (box.y + box.height)));
  // Left strip: to the left of the box, vertically spanning just the box's row.
  setRectStyle(elScrimLeft, 0, box.y, box.x, box.height);
  // Right strip: to the right of the box, vertically spanning just the box's row.
  setRectStyle(elScrimRight, box.x + box.width, box.y, Math.max(0, bounds.width - (box.x + box.width)), box.height);
}

function setRectStyle(el: HTMLDivElement, x: number, y: number, width: number, height: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, width)}px`;
  el.style.height = `${Math.max(0, height)}px`;
}

function positionComment(bounds: { width: number; height: number }): void {
  if (!elComment) return;
  // offsetHeight is 0 before the element has ever been laid out (and always 0
  // in plain jsdom without the test-setup override) — fall back to a fixed
  // estimate rather than collapsing the comment box to zero height.
  const measured = elComment.offsetHeight;
  commentHeight = measured > 0 ? measured : COMMENT_FALLBACK_HEIGHT;

  const pos = computeCommentPosition(box, COMMENT_WIDTH, commentHeight, bounds);
  elComment.style.left = `${pos.left}px`;
  elComment.style.top = `${pos.top}px`;
}

// ---------------------------------------------------------------------------
// Placement (first click) and resize (handle drag)
// ---------------------------------------------------------------------------

function handleBlockerClick(e: MouseEvent): void {
  if (mode !== 'placing') return; // 'editing': clicking outside the box/comment does nothing (§1.2)
  e.preventDefault();

  const bounds = getBounds();
  box = computeDefaultBox(e.clientX, e.clientY, bounds);
  mode = 'editing';
  elBlocker?.classList.remove('placing');

  renderBox();
  elTextarea!.value = '';
  updateCounterAndOkState();
  requestAnimationFrame(() => elTextarea?.focus());
}

function startResize(handle: HandleKey, e: MouseEvent): void {
  if (mode !== 'editing') return;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  activeHandle = handle;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeUp);
}

function onResizeMove(e: MouseEvent): void {
  if (!activeHandle) return;
  const bounds = getBounds();
  box = resizeBox(activeHandle, e.clientX, e.clientY, bounds);
  renderBox();
}

function onResizeUp(): void {
  activeHandle = null;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
}

// ---------------------------------------------------------------------------
// Comment box behaviour
// ---------------------------------------------------------------------------

function updateCounterAndOkState(): void {
  if (!elTextarea || !elCounter || !elOkBtn) return;
  const len = elTextarea.value.length;
  elCounter.textContent = `${len} / ${MAX_NOTE_LENGTH}`;
  elCounter.dataset.warn = String(len >= COUNTER_WARN_AT);
  elCounter.dataset.danger = String(len >= COUNTER_DANGER_AT);
  elOkBtn.disabled = elTextarea.value.trim().length === 0;
}

function handleCancelClick(): void {
  const cbs = callbacksRef;
  exitAddMode();
  cbs?.onCancel();
}

function handleOkClick(): void {
  if (!elTextarea || !elOkBtn || !elCancelBtn) return;
  const note = elTextarea.value.trim();
  if (note.length === 0) return; // ok is disabled in this state, but guard anyway

  elOkBtn.disabled = true;
  elCancelBtn.disabled = true;

  callbacksRef?.onOk({ rect: { ...box }, note });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Begin add mode: crosshair cursor, page interaction suppressed, waiting for
 *  the placement click. No-op if already active. */
export function startAddMode(callbacks: AddModeCallbacks): void {
  if (mode !== 'idle') return;
  callbacksRef = callbacks;
  mode = 'placing';

  buildDOM();
  elBlocker!.classList.add('placing');
  elBlocker!.addEventListener('click', handleBlockerClick);
  layoutHost(getBounds());
}

export function isAddModeActive(): boolean {
  return mode !== 'idle';
}

/** Hide all add-mode visuals (box outline, handles, scrim, comment box) for
 *  the single frame of a screenshot capture (§1.2 step 44.1). The page-click
 *  blocker stays up — add mode is still logically active, just invisible.
 *  Safe to call when nothing has been placed yet, though Phase 5 only ever
 *  calls this once an "ok" click has fired. */
export function hideOverlayUI(): void {
  if (elVisuals) elVisuals.dataset.hidden = 'true';
}

/** Reverse of hideOverlayUI() — also re-enables the comment box's buttons, so
 *  a caller that hid the UI, attempted a capture, and got a failure back can
 *  restore the exact pre-capture state and let the user retry or cancel. */
export function showOverlayUI(): void {
  if (elVisuals) elVisuals.dataset.hidden = 'false';
  if (elOkBtn) elOkBtn.disabled = elTextarea ? elTextarea.value.trim().length === 0 : true;
  if (elCancelBtn) elCancelBtn.disabled = false;
}

/** Full teardown: removes all add-mode DOM/listeners and returns to idle.
 *  Called internally by cancel; callers (content.ts today, Phase 5's capture
 *  pipeline later) call it themselves once a successful capture completes. */
export function exitAddMode(): void {
  if (mode === 'idle') return;

  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  activeHandle = null;

  if (host && host.parentNode) host.parentNode.removeChild(host);

  host = null;
  shadow = null;
  elBlocker = null;
  elVisuals = null;
  elScrimTop = null;
  elScrimBottom = null;
  elScrimLeft = null;
  elScrimRight = null;
  elBox = null;
  elHandles = {};
  elComment = null;
  elTextarea = null;
  elCounter = null;
  elCancelBtn = null;
  elOkBtn = null;

  mode = 'idle';
  callbacksRef = null;
  box = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/** Test-only: current selection rect, so tests can drive placement/resize via
 *  the exported handlers and assert on the resulting geometry. */
export function _boxForTests(): Rect {
  return { ...box };
}
