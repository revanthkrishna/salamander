// src/addMode.ts
// Phase 4 — the add-mode selection interaction (REQUIREMENTS §1.2, §3.2),
// restyled to the Salamander design language (design spec §3.2).
//
// Scope: crosshair-cursor click-to-place (centered default 200x150 box,
// clamped to the viewport by shifting) and Figma-style click-and-drag-to-draw
// (custom-sized box between mousedown and mouseup, 5px movement threshold to
// distinguish the two), resize from any edge or corner via invisible hit
// zones (20x20 minimum), a macOS-screenshot-style dimming scrim outside the
// rounded box, full suppression of page interaction while active, and the
// attached comment box (textarea / counter / cancel / save).
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
import { getSidebarWidth } from './sidebar';
import { getContentViewportSize } from './capture';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { DISABLED_CSS, getThemeCSS, registerThemedHost, STATE_TRANSITION_CSS } from './theme';

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
   * Fired when the user clicks "save" with a non-empty note (the callback
   * keeps its historical `onOk` name — content.ts wires it). Add mode does
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
/** Movement threshold (mousedown -> current position), in px, that
 *  distinguishes a "click" (place the centered default-size box) from a
 *  "drag" (draw a custom-sized box between mousedown and the current/mouseup
 *  point) — REQUIREMENTS §1.2. */
const DRAG_THRESHOLD = 5;
const COMMENT_WIDTH = 280;
/** Comment box height before its first layout pass (offsetHeight is 0 until
 *  then): 88px textarea + 36px footer + 1px footer divider + 2px outer
 *  border (design spec §3.2). Only used to pick a flip candidate on the very
 *  first render; every later render measures the real element. */
const COMMENT_FALLBACK_HEIGHT = 127;
const COMMENT_MARGIN = 8;
const MAX_NOTE_LENGTH = 1000;
/** Counter visibility (design spec §3.2): hidden at 0–900 chars, muted at
 *  901–979 (strictly *above* COUNTER_WARN_ABOVE), danger at 980–1000. */
const COUNTER_WARN_ABOVE = 900;
const COUNTER_DANGER_AT = 980;

/** Resize hit zones (design spec §3.2): the box has no visible handles —
 *  instead every edge gets an invisible strip EDGE_ZONE px thick straddling
 *  the outline, and every corner a CORNER_ZONE px square centred on it. */
const EDGE_ZONE = 10;
const SAVE_LABEL = 'save';
const SAVING_LABEL = 'saving\u2026';
const CORNER_ZONE = 16;

type ZoneKey = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** Edges first, corners last: at small box sizes the corner squares overlap
 *  the ends of the edge strips, and later siblings win the hit test, so a
 *  grab near a corner always resizes diagonally. */
const ZONE_KEYS: ZoneKey[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
const ZONE_CURSORS: Record<ZoneKey, string> = {
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

// Every colour/radius/font below is a --sal-* token from getThemeCSS(), which
// buildDOM() prepends into this same <style> element, so light/dark theme
// switches (data-theme on the host) restyle add mode live.
const ADD_MODE_CSS = `
  :host {
    font-family: var(--sal-font-body);
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
  /* Nothing selection-related renders until the first placement/drag gives
     the box a real rect (renderBox() sets data-has-box). Without this the
     scrim's spread shadow would dim the whole page during 'placing'. */
  .visuals:not([data-has-box="true"]) .scrim-layer,
  .visuals:not([data-has-box="true"]) .box,
  .visuals:not([data-has-box="true"]) .resize-zone { display: none; }

  /* Scrim: a single transparent element exactly over the box, with the same
     corner radius, casting a huge spread shadow in the scrim colour. That
     leaves a hole whose corners match the rounded outline (the v1 four-strip
     scrim only worked for a square box). The layer is sized to the page
     content area and clips, so the spread never dims the sidebar. */
  .scrim-layer {
    position: absolute;
    top: 0;
    left: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .scrim {
    position: absolute;
    border-radius: var(--sal-radius-md);
    box-shadow: 0 0 0 200vmax var(--sal-scrim);
    pointer-events: none;
  }

  /* Selection outline: 2px accent plus a 1px keyline outside it, so it reads
     on both light and dark pages. No hover/press styling — only the cursor
     over the hit zones below changes. */
  .box {
    position: absolute;
    border-radius: var(--sal-radius-md);
    box-shadow: 0 0 0 2px var(--sal-accent), 0 0 0 3px var(--sal-keyline);
    background: transparent;
    pointer-events: none;
  }

  .resize-zone {
    position: absolute;
    background: transparent;
    /* .visuals inherits pointer-events: none from the host; the hit zones
       must opt back in or no mousedown ever reaches them. */
    pointer-events: auto;
  }

  .comment-box {
    position: absolute;
    width: ${COMMENT_WIDTH}px;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-lg);
    box-shadow: var(--sal-shadow-pop);
    overflow: hidden;
    padding: 0;
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    /* .visuals inherits pointer-events: none from the host (the host is
       pointer-events: none so the blocker underneath can own page-click
       suppression while non-interactive visuals like the box outline and
       scrim stay click-through). .resize-zone opts itself back into auto
       above; the comment box and everything in it (textarea, cancel/save
       buttons) need the same opt-in, or their clicks fall through to nothing
       and only keyboard/Tab focus keeps working. */
    pointer-events: auto;
  }

  /* Text area and footer merge into the one outer box: the textarea has no
     border of its own, only an inset edge on hover (lineStrong) and focus
     (accent). The outer box never changes. Inner top radius = lg minus the
     outer 1px border so the inset edge hugs the box's corner. */
  .note-input {
    display: block;
    width: 100%;
    height: 88px;
    margin: 0;
    resize: none;
    border: none;
    border-radius: calc(var(--sal-radius-lg) - 1px) calc(var(--sal-radius-lg) - 1px) 0 0;
    outline: none;
    background: transparent;
    padding: 10px 12px;
    font-family: var(--sal-font-body);
    font-size: 13px;
    line-height: 1.4;
    color: var(--sal-text);
    transition: box-shadow 140ms ease-out;
  }
  .note-input::placeholder { color: var(--sal-muted); }
  .note-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  /* After :hover so focus wins while both apply. Accent edge only — no
     secondary/soft ring. */
  .note-input:focus { box-shadow: inset 0 0 0 1px var(--sal-accent); }

  .footer {
    display: flex;
    align-items: stretch;
    box-sizing: content-box;
    height: 36px;
    border-top: 1px solid var(--sal-line);
  }

  .counter {
    align-self: center;
    margin-right: auto;
    padding: 0 12px;
    font-family: var(--sal-font-mono);
    font-size: 11px;
    color: var(--sal-muted);
    visibility: hidden;
  }
  .counter[data-warn="true"] { visibility: visible; }
  .counter[data-danger="true"] { color: var(--sal-danger); font-weight: 600; }

  /* Flush text buttons in the footer bar (design spec §2 "save"/"cancel"
     rows). No vertical dividers, no scale-on-press: they sit flush against
     the bar/box edges, so shrinking them would open visible gaps. */
  .btn {
    height: 100%;
    margin: 0;
    padding: 0 14px;
    border: none;
    border-radius: 0;
    background: transparent;
    font-family: var(--sal-font-body);
    font-size: 13px;
    cursor: pointer;
    outline: none;
    ${STATE_TRANSITION_CSS}
  }
  .btn:disabled { ${DISABLED_CSS} }

  .btn-cancel {
    color: var(--sal-muted);
    font-weight: 500;
  }
  .btn-cancel:not(:disabled):hover { background: var(--sal-hover); color: var(--sal-text); }
  .btn-cancel:not(:disabled):active { background: var(--sal-press); color: var(--sal-text); }
  .btn-cancel:focus-visible { box-shadow: inset 0 0 0 2px var(--sal-focus); color: var(--sal-text); }

  /* The save button is the last thing in the box, so its bottom-right corner
     follows the box radius (overflow: hidden already clips the fill; the
     explicit radius keeps the inset focus ring following the curve too). */
  .btn-save {
    color: var(--sal-accent-ink);
    font-weight: 700;
    border-bottom-right-radius: calc(var(--sal-radius-lg) - 1px);
  }
  .btn-save:not(:disabled):hover { background: var(--sal-accent); color: var(--sal-on-accent); }
  .btn-save:not(:disabled):active { background: var(--sal-accent-press); color: var(--sal-on-accent); }
  .btn-save:not(:disabled):focus-visible {
    background: var(--sal-accent);
    color: var(--sal-on-accent);
    box-shadow: inset 0 0 0 2px var(--sal-focus);
  }
  /* Empty note: muted text at half opacity (design spec §2 "save disabled"). */
  .btn-save:disabled { color: var(--sal-muted); opacity: 0.5; }
  /* While capturing (after save), keep the ink colour so "saving…" reads as
     in-progress rather than as the empty-note disabled state. */
  .comment-box[aria-busy="true"] .btn-save:disabled { color: var(--sal-accent-ink); opacity: 1; }
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
let elScrimLayer: HTMLDivElement | null = null;
let elScrim: HTMLDivElement | null = null;
let elBox: HTMLDivElement | null = null;
let elZones: Partial<Record<ZoneKey, HTMLDivElement>> = {};
let elComment: HTMLDivElement | null = null;
let elTextarea: HTMLTextAreaElement | null = null;
let elCounter: HTMLSpanElement | null = null;
let elCancelBtn: HTMLButtonElement | null = null;
let elSaveBtn: HTMLButtonElement | null = null;

let activeZone: ZoneKey | null = null;
let keyboardIsolation: KeyboardIsolationHandle | null = null;
let unregisterThemedHost: (() => void) | null = null;

/** Set on mousedown while mode === 'placing', cleared once placement
 *  finalizes (mouseup). Null whenever no placement gesture is in progress. */
let placeStart: { x: number; y: number } | null = null;
/** Whether the in-progress placement gesture has crossed DRAG_THRESHOLD and
 *  is therefore being treated as a drag-to-draw rather than a click. */
let placeDragging = false;

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
 *  "no extension UI in a capture" rule (§6 #2) it exists to uphold.
 *
 *  getSidebarWidth() is read on every call, never cached: the sidebar is
 *  user-resizable, so a width captured at add-mode entry would be stale the
 *  moment the user dragged the handle. This is called fresh on every
 *  placement/resize gesture, so the bounds always match the panel on screen. */
function getBounds(): { width: number; height: number } {
  const { width, height } = getContentViewportSize();
  return {
    width: Math.max(0, width - getSidebarWidth()),
    height,
  };
}

/** Click-to-place (no drag): the default-size box is *centered* on the click
 *  point, then clamped (shifted, not shrunk) independently per axis so it
 *  always lands fully on-screen — e.g. a click at (20, 20) naively centers
 *  the 200x150 default to (-80, -55), which clamps to (0, 0). */
function computeDefaultBox(clickX: number, clickY: number, bounds: { width: number; height: number }): Rect {
  const width = Math.min(DEFAULT_WIDTH, bounds.width);
  const height = Math.min(DEFAULT_HEIGHT, bounds.height);
  const x = clamp(clickX - width / 2, 0, Math.max(0, bounds.width - width));
  const y = clamp(clickY - height / 2, 0, Math.max(0, bounds.height - height));
  return { x, y, width, height };
}

/** Drag-to-draw: the box is the actual rectangle between the mousedown point
 *  (`startX`/`startY`, treated as the fixed anchor corner) and the
 *  current/mouseup point, normalized to work when dragging in any direction.
 *  Per-edge clamped to the viewport and the 20x20 minimum exactly like
 *  resizeBox()'s hit-zone-drag logic — the edge nearest the anchor point stays
 *  fixed while the edge nearest the moving point is clamped against it, so a
 *  drag that shrinks below MIN_SIZE grows back out from the anchor instead
 *  of collapsing or crossing over. */
function computeDragBox(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  bounds: { width: number; height: number },
): Rect {
  const anchorX = clamp(startX, 0, bounds.width);
  const anchorY = clamp(startY, 0, bounds.height);

  let left: number;
  let right: number;
  if (currentX >= anchorX) {
    left = anchorX;
    right = clamp(currentX, left + MIN_SIZE, bounds.width);
  } else {
    right = anchorX;
    left = clamp(currentX, 0, right - MIN_SIZE);
  }

  let top: number;
  let bottom: number;
  if (currentY >= anchorY) {
    top = anchorY;
    bottom = clamp(currentY, top + MIN_SIZE, bounds.height);
  } else {
    bottom = anchorY;
    top = clamp(currentY, 0, bottom - MIN_SIZE);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Moves only the edges named by `zone` (e.g. 'ne' = top + right) to the
 *  pointer, keeping the opposite edges fixed; clamped per edge to the content
 *  viewport and the 20x20 minimum. */
function resizeBox(zone: ZoneKey, clientX: number, clientY: number, bounds: { width: number; height: number }): Rect {
  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;

  let newLeft = left;
  let newTop = top;
  let newRight = right;
  let newBottom = bottom;

  if (zone.includes('w')) newLeft = clamp(clientX, 0, right - MIN_SIZE);
  if (zone.includes('e')) newRight = clamp(clientX, left + MIN_SIZE, bounds.width);
  if (zone.includes('n')) newTop = clamp(clientY, 0, bottom - MIN_SIZE);
  if (zone.includes('s')) newBottom = clamp(clientY, top + MIN_SIZE, bounds.height);

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
  unregisterThemedHost = registerThemedHost(host);

  const style = document.createElement('style');
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of add mode's own CSS so every rule in it can reference them. One
  // <style> element per shadow root.
  style.textContent = getThemeCSS() + '\n' + ADD_MODE_CSS;
  shadow.appendChild(style);

  elBlocker = document.createElement('div');
  elBlocker.className = 'blocker';
  elBlocker.style.pointerEvents = 'auto';

  elVisuals = document.createElement('div');
  elVisuals.className = 'visuals';

  elScrimLayer = document.createElement('div');
  elScrimLayer.className = 'scrim-layer';
  elScrim = document.createElement('div');
  elScrim.className = 'scrim';
  elScrimLayer.appendChild(elScrim);

  elBox = document.createElement('div');
  elBox.className = 'box';

  // Invisible resize hit zones (design spec §3.2) — purely a pointer
  // affordance, so hidden from assistive tech. There was no keyboard resize
  // path before the redesign either; keyboard users still reach everything
  // actionable (textarea, cancel, save) via Tab.
  for (const key of ZONE_KEYS) {
    const zone = document.createElement('div');
    zone.className = 'resize-zone';
    zone.dataset.zone = key;
    zone.style.cursor = ZONE_CURSORS[key];
    zone.setAttribute('aria-hidden', 'true');
    zone.addEventListener('mousedown', (e) => startResize(key, e));
    elZones[key] = zone;
  }

  elVisuals.appendChild(elScrimLayer);
  elVisuals.appendChild(elBox);
  for (const key of ZONE_KEYS) elVisuals.appendChild(elZones[key]!);
  // The comment box (textarea + counter + cancel/save) is deliberately NOT
  // built here. Per REQUIREMENTS §1.2 it must not exist until the user has
  // placed the box (click-to-place or drag-to-draw, 'placing' -> 'editing');
  // buildCommentDOM() is called from finalizePlacement() for that reason.
  // Building it eagerly here left it in the DOM at its unset absolute-
  // position default (top-left of the page) for the entire 'placing' phase.

  shadow.appendChild(elBlocker);
  shadow.appendChild(elVisuals);

  document.documentElement.appendChild(host);
}

/** Builds and appends the comment box (textarea / counter / cancel / save).
 *  Called once, from finalizePlacement(), the moment the user places the
 *  selection box (click or drag) — never during startAddMode()/buildDOM()
 *  (§1.2: the comment box must not exist before the first placement). */
function buildCommentDOM(): void {
  if (!elVisuals || elComment) return;

  elComment = document.createElement('div');
  elComment.className = 'comment-box';
  elComment.setAttribute('role', 'dialog');
  elComment.setAttribute('aria-label', 'add feedback note');

  elTextarea = document.createElement('textarea');
  elTextarea.className = 'note-input';
  elTextarea.placeholder = 'what should change here?';
  elTextarea.maxLength = MAX_NOTE_LENGTH;
  elTextarea.setAttribute('aria-label', 'feedback note');
  elTextarea.addEventListener('input', updateCounterAndSaveState);

  const footer = document.createElement('div');
  footer.className = 'footer';

  elCounter = document.createElement('span');
  elCounter.className = 'counter';
  elCounter.setAttribute('aria-live', 'polite');

  elCancelBtn = document.createElement('button');
  elCancelBtn.type = 'button';
  elCancelBtn.className = 'btn btn-cancel';
  elCancelBtn.textContent = 'cancel';
  elCancelBtn.addEventListener('click', handleCancelClick);

  elSaveBtn = document.createElement('button');
  elSaveBtn.type = 'button';
  elSaveBtn.className = 'btn btn-save';
  elSaveBtn.textContent = SAVE_LABEL;
  elSaveBtn.disabled = true;
  elSaveBtn.addEventListener('click', handleSaveClick);

  footer.appendChild(elCounter);
  footer.appendChild(elCancelBtn);
  footer.appendChild(elSaveBtn);

  elComment.appendChild(elTextarea);
  elComment.appendChild(footer);

  elVisuals.appendChild(elComment);

  // Capture-phase window-level keyboard isolation (see keyboardIsolation.ts)
  // so keystrokes typed into the comment textarea can't leak to — or be
  // suppressed by — the host page's own keyboard-shortcut handlers (real
  // user reports on Gmail/Instagram). Installed only now, once the textarea
  // actually exists, and released in exitAddMode() — never left running
  // while add mode is idle or still in the pre-placement 'placing' phase.
  if (host) keyboardIsolation = installKeyboardIsolation(host);
}

function layoutHost(bounds: { width: number; height: number }): void {
  if (!host || !elBlocker) return;
  host.style.width = `${bounds.width}px`;
  host.style.height = `${bounds.height}px`;
  elBlocker.style.width = `${bounds.width}px`;
  elBlocker.style.height = `${bounds.height}px`;
  if (elScrimLayer) {
    elScrimLayer.style.width = `${bounds.width}px`;
    elScrimLayer.style.height = `${bounds.height}px`;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderBox(): void {
  const bounds = getBounds();
  layoutHost(bounds);

  if (!elBox) return;
  setRectStyle(elBox, box.x, box.y, box.width, box.height);
  // The scrim's hole is exactly the box rect (same radius in CSS); the
  // outline's box-shadow is drawn outside it, on top of the dimming.
  if (elScrim) setRectStyle(elScrim, box.x, box.y, box.width, box.height);
  if (elVisuals) elVisuals.dataset.hasBox = 'true';

  renderZones();
  positionComment(bounds);
}

/** Fit a placed box back inside `bounds`: shifted first (size kept), and
 *  shrunk only on an axis where it no longer fits at all. */
function clampBoxToBounds(b: Rect, bounds: { width: number; height: number }): Rect {
  const width = Math.min(b.width, bounds.width);
  const height = Math.min(b.height, bounds.height);
  return {
    x: clamp(b.x, 0, Math.max(0, bounds.width - width)),
    y: clamp(b.y, 0, Math.max(0, bounds.height - height)),
    width,
    height,
  };
}

/** Hit-zone rects for the current box: edge strips EDGE_ZONE thick centred on
 *  the outline (half inside, half outside) and running between the corner
 *  squares; CORNER_ZONE squares centred on each corner. Exported for tests
 *  via _zoneRectsForTests(). */
function computeZoneRects(b: Rect): Record<ZoneKey, Rect> {
  const e = EDGE_ZONE / 2;
  const c = CORNER_ZONE / 2;
  const left = b.x;
  const top = b.y;
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  const innerW = Math.max(0, b.width - CORNER_ZONE);
  const innerH = Math.max(0, b.height - CORNER_ZONE);
  return {
    n: { x: left + c, y: top - e, width: innerW, height: EDGE_ZONE },
    s: { x: left + c, y: bottom - e, width: innerW, height: EDGE_ZONE },
    w: { x: left - e, y: top + c, width: EDGE_ZONE, height: innerH },
    e: { x: right - e, y: top + c, width: EDGE_ZONE, height: innerH },
    nw: { x: left - c, y: top - c, width: CORNER_ZONE, height: CORNER_ZONE },
    ne: { x: right - c, y: top - c, width: CORNER_ZONE, height: CORNER_ZONE },
    sw: { x: left - c, y: bottom - c, width: CORNER_ZONE, height: CORNER_ZONE },
    se: { x: right - c, y: bottom - c, width: CORNER_ZONE, height: CORNER_ZONE },
  };
}

function renderZones(): void {
  const rects = computeZoneRects(box);
  for (const key of ZONE_KEYS) {
    const el = elZones[key];
    if (!el) continue;
    const r = rects[key];
    setRectStyle(el, r.x, r.y, r.width, r.height);
  }
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
// Placement (first click) and resize (hit-zone drag)
// ---------------------------------------------------------------------------

function handleBlockerMouseDown(e: MouseEvent): void {
  if (mode !== 'placing') return; // 'editing': clicking outside the box/comment does nothing (§1.2)
  if (e.button !== 0) return;
  e.preventDefault();

  placeStart = { x: e.clientX, y: e.clientY };
  placeDragging = false;
  document.addEventListener('mousemove', onPlacementMove);
  document.addEventListener('mouseup', onPlacementUp);
}

function onPlacementMove(e: MouseEvent): void {
  if (!placeStart) return;

  const dx = e.clientX - placeStart.x;
  const dy = e.clientY - placeStart.y;
  if (!placeDragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // still might resolve as a click
  placeDragging = true;

  const bounds = getBounds();
  box = computeDragBox(placeStart.x, placeStart.y, e.clientX, e.clientY, bounds);
  renderBox();
}

function onPlacementUp(e: MouseEvent): void {
  document.removeEventListener('mousemove', onPlacementMove);
  document.removeEventListener('mouseup', onPlacementUp);
  if (!placeStart) return;

  const bounds = getBounds();
  box = placeDragging
    ? computeDragBox(placeStart.x, placeStart.y, e.clientX, e.clientY, bounds)
    : computeDefaultBox(placeStart.x, placeStart.y, bounds);

  placeStart = null;
  placeDragging = false;
  finalizePlacement();
}

/** Shared tail of both the click-to-place and drag-to-draw paths: switches
 *  to 'editing', builds/opens the comment box, and focuses its textarea. */
function finalizePlacement(): void {
  mode = 'editing';
  elBlocker?.classList.remove('placing');

  buildCommentDOM();
  renderBox();
  elTextarea!.value = '';
  updateCounterAndSaveState();
  requestAnimationFrame(() => elTextarea?.focus());
}

function startResize(zone: ZoneKey, e: MouseEvent): void {
  if (mode !== 'editing') return;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  activeZone = zone;
  // Keep the resize cursor for the whole gesture: once the pointer leaves
  // the thin hit zone it's over the blocker, which otherwise shows the
  // default arrow mid-drag.
  if (elBlocker) elBlocker.style.cursor = ZONE_CURSORS[zone];
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeUp);
}

function onResizeMove(e: MouseEvent): void {
  if (!activeZone) return;
  const bounds = getBounds();
  box = resizeBox(activeZone, e.clientX, e.clientY, bounds);
  renderBox();
}

function onResizeUp(): void {
  activeZone = null;
  if (elBlocker) elBlocker.style.cursor = '';
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
}

// ---------------------------------------------------------------------------
// Comment box behaviour
// ---------------------------------------------------------------------------

function updateCounterAndSaveState(): void {
  if (!elTextarea || !elCounter || !elSaveBtn) return;
  const len = elTextarea.value.length;
  elCounter.textContent = `${len}/${MAX_NOTE_LENGTH}`;
  elCounter.dataset.warn = String(len > COUNTER_WARN_ABOVE);
  elCounter.dataset.danger = String(len >= COUNTER_DANGER_AT);
  elSaveBtn.disabled = elTextarea.value.trim().length === 0;
}

function handleCancelClick(): void {
  const cbs = callbacksRef;
  exitAddMode();
  cbs?.onCancel();
}

function handleSaveClick(): void {
  if (!elTextarea || !elSaveBtn || !elCancelBtn) return;
  const note = elTextarea.value.trim();
  if (note.length === 0) return; // save is disabled in this state, but guard anyway

  // Capturing (design spec §3.2): lock the note and both buttons until the
  // capture pipeline either exits add mode (success) or calls
  // showOverlayUI() (failure). readOnly rather than disabled keeps the
  // textarea's focus, so a failed capture hands the user straight back to it.
  elSaveBtn.disabled = true;
  elCancelBtn.disabled = true;
  elSaveBtn.textContent = SAVING_LABEL;
  elTextarea.readOnly = true;
  elComment?.setAttribute('aria-busy', 'true');

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
  elBlocker!.addEventListener('mousedown', handleBlockerMouseDown);
  layoutHost(getBounds());
  window.addEventListener('resize', handleBoundsChange);
}

/** Keep the selectable area — and a placed selection — inside the bounds
 *  when they change under add mode: a real viewport resize, or the sidebar
 *  being widened (sidebar.ts dispatches a synthetic `resize` on every width
 *  change while open). Without this, a box placed flush right stays where
 *  it was and ends up under the wider panel, capturing a slice of it. */
function handleBoundsChange(): void {
  if (mode === 'idle') return;
  const bounds = getBounds();
  if (mode === 'editing') {
    box = clampBoxToBounds(box, bounds);
    renderBox();
  } else {
    layoutHost(bounds);
  }
}

export function isAddModeActive(): boolean {
  return mode !== 'idle';
}

/** Hide all add-mode visuals (box outline, resize hit zones, scrim, comment box) for
 *  the single frame of a screenshot capture (§1.2 step 44.1). The page-click
 *  blocker stays up — add mode is still logically active, just invisible.
 *  Safe to call when nothing has been placed yet, though Phase 5 only ever
 *  calls this once a "save" click has fired. */
export function hideOverlayUI(): void {
  if (elVisuals) elVisuals.dataset.hidden = 'true';
}

/** Reverse of hideOverlayUI() — also re-enables the comment box's buttons, so
 *  a caller that hid the UI, attempted a capture, and got a failure back can
 *  restore the exact pre-capture state and let the user retry or cancel. */
export function showOverlayUI(): void {
  if (elVisuals) elVisuals.dataset.hidden = 'false';
  if (elTextarea) elTextarea.readOnly = false;
  elComment?.removeAttribute('aria-busy');
  if (elSaveBtn) {
    elSaveBtn.textContent = SAVE_LABEL;
    elSaveBtn.disabled = elTextarea ? elTextarea.value.trim().length === 0 : true;
  }
  if (elCancelBtn) elCancelBtn.disabled = false;
}

/** Full teardown: removes all add-mode DOM/listeners and returns to idle.
 *  Called internally by cancel; callers (content.ts today, Phase 5's capture
 *  pipeline later) call it themselves once a successful capture completes. */
export function exitAddMode(): void {
  if (mode === 'idle') return;

  window.removeEventListener('resize', handleBoundsChange);

  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  activeZone = null;

  document.removeEventListener('mousemove', onPlacementMove);
  document.removeEventListener('mouseup', onPlacementUp);
  placeStart = null;
  placeDragging = false;

  keyboardIsolation?.release();
  keyboardIsolation = null;

  unregisterThemedHost?.();
  unregisterThemedHost = null;

  if (host && host.parentNode) host.parentNode.removeChild(host);

  host = null;
  shadow = null;
  elBlocker = null;
  elVisuals = null;
  elScrimLayer = null;
  elScrim = null;
  elBox = null;
  elZones = {};
  elComment = null;
  elTextarea = null;
  elCounter = null;
  elCancelBtn = null;
  elSaveBtn = null;

  mode = 'idle';
  callbacksRef = null;
  box = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/** Test-only: current selection rect, so tests can drive placement/resize via
 *  the exported handlers and assert on the resulting geometry. */
export function _boxForTests(): Rect {
  return { ...box };
}

/** Test-only: the hit-zone rects computeZoneRects() produces for the current
 *  box, keyed by zone ('n', 'se', ...). */
export function _zoneRectsForTests(): Record<ZoneKey, Rect> {
  return computeZoneRects(box);
}
