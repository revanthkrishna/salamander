// src/addMode.ts
// The add-mode selection interaction (REQUIREMENTS §1.2, §3.2),
// restyled to the Salamander design language (design spec §3.2).
//
// Scope: crosshair-cursor click-to-place (centered default box sized to match
// the sidebar's thumbnail box, clamped to the viewport by shifting) and
// Figma-style click-and-drag-to-draw
// (custom-sized box between mousedown and mouseup, 5px movement threshold to
// distinguish the two), resize from any edge or corner via invisible hit
// zones (20x20 minimum), a macOS-screenshot-style dimming scrim outside the
// rounded box, full suppression of page interaction while active, the
// attached comment box (textarea / counter / cancel / save), and — while
// 'placing' and nothing has been drawn yet — a preview of the exact
// click-to-place box plus a "click or drag to select" tooltip, both
// following the cursor (design spec §G; the tooltip is a first-run hint
// that retires itself after ~5s, once per page session — v4 §N). Once the
// box is placed, its interior is also a pencil (design spec §AB): strokes
// drawn there, a pencil menu (erase all) and three colour swatches in the
// comment box's bottom bar, and Cmd/Ctrl+Z to take the last stroke back.
//
// What this module does NOT do: capture a screenshot, talk to the service
// worker, or build DOM/context data. That is src/capture.ts and
// src/contextCapture.ts — this module only produces a selection rect +
// note text via AddModeCallbacks.onOk, and exposes
// hideOverlayUI()/showOverlayUI() for the capture pipeline to wrap around the actual
// capture call so none of this UI ever appears in the screenshot (§1.2 step
// 44.1).
//
// Positioning note (conceptual reuse only — all code is new): the comment box's below -> above -> side flip logic is
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
// scroll offset and DPR: src/capture.ts adds the scroll offset for
// the archival page-coordinate rect (§1.4D), and the service worker converts
// to device pixels for the crop (§1.3, §6 #4/#5). The rect handed to onOk is
// passed to the capture message unchanged — viewport CSS px is already the
// right space for cropping a viewport screenshot.

import { Drawing, DrawingStroke, Rect, ViewportSize } from './types';
import { DEFAULT_THUMBNAIL_BOX_SIZE } from './sidebarMetrics';
import { getSidebarWidth } from './sidebarWidth';
import { getContentViewportSize } from './dom';
import { clamp } from './flip';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { KEY_PRIORITY, registerKeyHandler } from './keyRouter';
import { getThemeCSS, RADII } from './theme';
import {
  cropDrawing,
  createStrokePath,
  DEFAULT_PEN_COLOR,
  isPenColor,
  PEN_COLORS,
  PenColor,
} from './drawing';
import { ENTER_A_NOTE_MESSAGE, NOTE_PLACEHOLDER, NOTHING_TO_ERASE_MESSAGE } from './copy';
import {
  COMMENT_PAD_PX,
  COMMENT_ROW_PX,
  COMMENT_WIDTH,
  DRAW_MENU_GAP,
  NOTE_INPUT_HEIGHT_PX,
  OUTLINE_PAD,
  OUTLINE_W,
} from './addModeMetrics';
import { ADD_MODE_CSS } from './styles/addMode.css';
import { ICON_ERASER, ICON_PENCIL, PENCIL_CURSOR } from './icons';
import { attachTooltips, isSoftDisabled, setSoftDisabled, TooltipHandle, TOOLTIP_CSS } from './tooltip';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AddModeResult {
  /** Selection rect in viewport-relative CSS px (see module doc comment). */
  rect: Rect;
  note: string;
  /** What was drawn on the selection (design spec §AB), already cropped to
   *  `rect` and in its own coordinates. Absent when nothing was drawn, or
   *  when everything drawn lies outside the final rect. */
  drawing?: Drawing;
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
  /** Fired when the user picks a pencil colour (design spec §AB), so the
   *  caller can remember it for the browser session. Not fired by
   *  setPenColor() — only a choice made in the swatches is news. */
  onPenColorChange?: (color: PenColor) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SIZE = 20;
/** Movement threshold (mousedown -> current position), in px, that
 *  distinguishes a "click" (place the centered default-size box) from a
 *  "drag" (draw a custom-sized box between mousedown and the current/mouseup
 *  point) — REQUIREMENTS §1.2. */
const DRAG_THRESHOLD = 5;
/** Comment box height before its first layout pass (offsetHeight is 0 until
 *  then): padding + text area + gap + button row + padding. Only used to pick
 *  a flip candidate on the very first render; every later render measures
 *  the real element. */
const COMMENT_FALLBACK_HEIGHT = COMMENT_PAD_PX * 3 + NOTE_INPUT_HEIGHT_PX + COMMENT_ROW_PX;
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
const SVG_NS = 'http://www.w3.org/2000/svg';
const CORNER_ZONE = 16;

/** Preview tooltip (design spec \u00a7G): fixed lowercase copy (\u00a73.4), offset
 *  down-right of the cursor, flipped/clamped like computeCommentPosition()
 *  so it can never render off the selectable area. */
const PREVIEW_TOOLTIP_TEXT = 'click or drag to select';
const TOOLTIP_OFFSET_X = 16;
const TOOLTIP_OFFSET_Y = 20;
/** How long the tooltip lives (design spec v4 §N): it is a first-run hint,
 *  not a permanent label — it shows with the preview and is then gone for the
 *  rest of the page session, later add-mode sessions included. Nothing is
 *  persisted, so a fresh page load shows it again. */
const TOOLTIP_LIFETIME = 5000;
/** Fallback size before the tooltip's first real layout pass (offsetWidth/
 *  Height are 0 in plain jsdom, same rationale as COMMENT_FALLBACK_HEIGHT) \u2014
 *  sized to roughly fit "click or drag to select" at 12px with the padding
 *  above. */
const TOOLTIP_FALLBACK_WIDTH = 150;
const TOOLTIP_FALLBACK_HEIGHT = 28;

/** The pencil menu (design spec §AB, the §C2 menu's treatment): its height
 *  before its first layout pass — 4px padding + one 32px item + 4px padding
 *  + 1px border each side — used only to decide whether it opens below the
 *  comment box or above the pencil. */
const DRAW_MENU_FALLBACK_HEIGHT = 42;
/** Pointer samples closer than this (CSS px) to the previous point add
 *  nothing visible and are dropped, so a slow stroke with coalesced events
 *  on a 120Hz+ pointer does not store thousands of near-duplicates. */
const MIN_POINT_GAP = 0.5;

/** The selectable area's size (see getBounds): the scrollbar-excluded
 *  viewport less the sidebar's docked strip. */
type Bounds = ViewportSize;

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
// Module state
// ---------------------------------------------------------------------------

type Mode = 'idle' | 'placing' | 'editing';

let mode: Mode = 'idle';
let callbacksRef: AddModeCallbacks | null = null;

let box: Rect = { x: 0, y: 0, ...DEFAULT_THUMBNAIL_BOX_SIZE };
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
let elBoxDash: SVGSVGElement | null = null;
let elDashInk: SVGRectElement | null = null;
let elDashAccent: SVGRectElement | null = null;
let elTextarea: HTMLTextAreaElement | null = null;
let elCounter: HTMLSpanElement | null = null;
let elCancelBtn: HTMLButtonElement | null = null;
let elSaveBtn: HTMLButtonElement | null = null;
let elPreviewTooltip: HTMLDivElement | null = null;
let elDrawSurface: HTMLDivElement | null = null;
let elStrokes: SVGSVGElement | null = null;
let elPencilBtn: HTMLButtonElement | null = null;
let elSwatches: HTMLButtonElement[] = [];
let elDrawMenu: HTMLDivElement | null = null;
let elEraseItem: HTMLButtonElement | null = null;

// ── The pencil (design spec §AB) ────────────────────────────────────────────

/** Finished strokes, oldest first, in viewport CSS px (see drawing.ts's
 *  banner) — pinned to the page, clipped by the box. Their <path>s are kept
 *  alongside at the same index so undo can remove exactly the last one. */
let strokes: DrawingStroke[] = [];
let strokePaths: SVGPathElement[] = [];
/** The stroke under the pointer right now, if any. Joins `strokes` on
 *  pointerup. `activeD` is its path data, grown by appending so a long
 *  stroke is not re-serialised on every move. */
let activeStroke: DrawingStroke | null = null;
let activePath: SVGPathElement | null = null;
let activeD = '';
let activePointerId: number | undefined;
/** Colour for the next stroke. Page-session state like tooltipDeadline —
 *  deliberately not reset by exitAddMode(); content.ts also restores it
 *  from the browser session on every entry (setPenColor). */
let penColor: PenColor = DEFAULT_PEN_COLOR;
let drawMenuOpen = false;
/** Between a save click and either exitAddMode() (success) or
 *  showOverlayUI() (failure): the overlay is hidden or about to be, and
 *  nothing may be drawn, undone or erased under the capture. */
let capturing = false;

/** Whether the placing-phase preview (box/scrim + tooltip) is currently
 *  shown. Tracked separately from `elVisuals.dataset.preview` so
 *  showPreview()/hidePreview() only run their one-time fade-in/instant-hide
 *  transition on an actual state change, not on every mousemove. */
let previewVisible = false;

/** When the hint's TOOLTIP_LIFETIME is up, as a wall-clock deadline set the
 *  first time it is ever shown; null until then. A deadline rather than a
 *  plain "already shown" flag because the hint is allowed to come and go with
 *  the preview (the pointer wandering onto the sidebar and back) inside that
 *  one window — it is the window that is once-per-session. Deliberately NOT
 *  reset by exitAddMode(): module lifetime IS the page session (§N). */
let tooltipDeadline: number | null = null;
/** The pending hide, live only while the tooltip is actually on screen. */
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

let activeZone: ZoneKey | null = null;
let keyboardIsolation: KeyboardIsolationHandle | null = null;
/** While a box is being placed, the page hears no key (placingKeys). */
let releasePlacingKeys: (() => void) | null = null;
/** The shared tooltip for this root (tooltip.ts, design spec §AG). */
let addModeTooltips: TooltipHandle | null = null;

/** Set on mousedown while mode === 'placing', cleared once placement
 *  finalizes (mouseup). Null whenever no placement gesture is in progress. */
let placeStart: { x: number; y: number } | null = null;
/** Whether the in-progress placement gesture has crossed DRAG_THRESHOLD and
 *  is therefore being treated as a drag-to-draw rather than a click. */
let placeDragging = false;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** The selectable area: full viewport height, full viewport width minus the
 *  sidebar's docked strip (§1.2 step 44.1 — the sidebar can never fall inside
 *  a selection because the page never renders under it). Add mode is only
 *  ever entered via the sidebar's own "add" button, so the sidebar is always
 *  open while this module is active.
 *
 *  Measured against the *scrollbar-excluded* viewport, not
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
function getBounds(): Bounds {
  const { width, height } = getContentViewportSize();
  return {
    width: Math.max(0, width - getSidebarWidth()),
    height,
  };
}

/** Click-to-place (no drag): the default-size box is *centered* on the click
 *  point, then clamped (shifted, not shrunk) independently per axis so it
 *  always lands fully on-screen — e.g. a click at (20, 20) naively centers a
 *  267x100 default to (-113.5, -30), which clamps to (0, 0).
 *
 *  The default size itself is DEFAULT_THUMBNAIL_BOX_SIZE (src/sidebar.ts)
 *  rather than an unrelated fixed constant here: it matches the sidebar's
 *  note thumbnail box at the sidebar's default width, so an un-dragged
 *  capture fills a thumbnail with no letterboxing in the common case. It is
 *  a fixed size — not read from the sidebar's *current* (user-resizable)
 *  width — so the click-to-place default never shifts underfoot while the
 *  panel is being dragged. */
function computeDefaultBox(clickX: number, clickY: number, bounds: Bounds): Rect {
  const width = Math.min(DEFAULT_THUMBNAIL_BOX_SIZE.width, bounds.width);
  const height = Math.min(DEFAULT_THUMBNAIL_BOX_SIZE.height, bounds.height);
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
  bounds: Bounds,
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
function resizeBox(zone: ZoneKey, clientX: number, clientY: number, bounds: Bounds): Rect {
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
  bounds: Bounds,
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

/** Preview tooltip position (design spec §G): offset (+16, +20) from the
 *  cursor, flipped to the opposite side of whichever axis would overflow,
 *  then unconditionally clamped into `bounds` — same "flip, then clamp
 *  regardless" shape as computeCommentPosition() above, just for a single
 *  fixed-offset candidate instead of four. */
function positionTooltip(cursorX: number, cursorY: number, bounds: Bounds): void {
  if (!elPreviewTooltip) return;
  // offsetWidth/Height are 0 before the tooltip's first layout pass (and
  // always 0 in plain jsdom) — fall back to a fixed estimate, same rationale
  // as positionComment()'s commentHeight fallback.
  const w = elPreviewTooltip.offsetWidth || TOOLTIP_FALLBACK_WIDTH;
  const h = elPreviewTooltip.offsetHeight || TOOLTIP_FALLBACK_HEIGHT;

  let left = cursorX + TOOLTIP_OFFSET_X;
  if (left + w > bounds.width) left = cursorX - TOOLTIP_OFFSET_X - w;
  let top = cursorY + TOOLTIP_OFFSET_Y;
  if (top + h > bounds.height) top = cursorY - TOOLTIP_OFFSET_Y - h;

  elPreviewTooltip.style.left = `${clamp(left, 0, Math.max(0, bounds.width - w))}px`;
  elPreviewTooltip.style.top = `${clamp(top, 0, Math.max(0, bounds.height - h))}px`;
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
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of add mode's own CSS so every rule in it can reference them. One
  // <style> element per shadow root.
  style.textContent = getThemeCSS() + '\n' + ADD_MODE_CSS + '\n' + TOOLTIP_CSS;
  shadow.appendChild(style);
  addModeTooltips = attachTooltips(shadow);

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
  elBoxDash = document.createElementNS(SVG_NS, 'svg');
  elBoxDash.setAttribute('class', 'box-dash');
  elBoxDash.setAttribute('aria-hidden', 'true');
  elDashInk = document.createElementNS(SVG_NS, 'rect');
  elDashInk.setAttribute('class', 'dash-ink');
  elDashAccent = document.createElementNS(SVG_NS, 'rect');
  elDashAccent.setAttribute('class', 'dash-accent');
  elBoxDash.appendChild(elDashInk);
  elBoxDash.appendChild(elDashAccent);
  elBox.appendChild(elBoxDash);

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

  // Placing-phase preview tooltip (design spec §G) — appended last so it
  // paints above the box/zones. Built eagerly (unlike the comment box) since
  // it has no interactive state of its own to defer: it only ever shows
  // static copy and follows the pointer.
  elPreviewTooltip = document.createElement('div');
  elPreviewTooltip.className = 'preview-tooltip';
  elPreviewTooltip.textContent = PREVIEW_TOOLTIP_TEXT;
  elPreviewTooltip.setAttribute('aria-hidden', 'true');
  elVisuals.appendChild(elPreviewTooltip);

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
  elTextarea.placeholder = NOTE_PLACEHOLDER;
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
  // An empty note greys it out with aria-disabled, so it stays hoverable
  // and can say why; only "saving…" disables it outright.
  elSaveBtn.dataset.tipReason = ENTER_A_NOTE_MESSAGE;
  setSaveEmpty(true);
  elSaveBtn.addEventListener('click', handleSaveClick);

  // Left: the pencil and its swatches; right: counter, cancel, save
  // (design spec §AB). The menu hangs off the comment box itself, placed
  // against the box — see the .draw-menu rule.
  footer.appendChild(buildDrawTools());
  footer.appendChild(elCounter);
  footer.appendChild(elCancelBtn);
  footer.appendChild(elSaveBtn);

  elComment.appendChild(elTextarea);
  elComment.appendChild(footer);
  elComment.appendChild(buildDrawMenu());

  elVisuals.appendChild(elComment);
  buildDrawSurface();
  updateDrawControls();

  // Capture-phase window-level keyboard isolation (see keyboardIsolation.ts)
  // so keystrokes typed into the comment textarea can't leak to — or be
  // suppressed by — the host page's own keyboard-shortcut handlers (real
  // user reports on Gmail/Instagram). Installed only now, once the textarea
  // actually exists, and released in exitAddMode() — never left running
  // while add mode is idle or still in the pre-placement 'placing' phase.
  // The isolation stops every key before it reaches anything inside our
  // shadow root too, so add mode's own keys (stroke undo, the swatches'
  // arrows, the pencil menu) are handled in its keydown hook.
  if (host) keyboardIsolation = installKeyboardIsolation(host, handleIsolatedKeydown, KEY_PRIORITY.ADDMODE_ISOLATION);
  // Outside pointerdown closes the pencil menu (§C2's rule). Two listeners
  // for the same reason as the sidebar's: inside this closed root the root
  // sees the real target; outside it, everything of ours retargets to host.
  shadow?.addEventListener('pointerdown', onShadowPointerDown, true);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
}

/** The pencil button and the colour radio group (design spec §AB). */
function buildDrawTools(): HTMLDivElement {
  const tools = document.createElement('div');
  tools.className = 'draw-tools';

  elPencilBtn = document.createElement('button');
  elPencilBtn.type = 'button';
  elPencilBtn.className = 'btn-pencil';
  elPencilBtn.setAttribute('aria-label', 'drawing options');
  elPencilBtn.dataset.tip = 'drawing options';
  elPencilBtn.setAttribute('aria-haspopup', 'menu');
  elPencilBtn.setAttribute('aria-expanded', 'false');
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = ICON_PENCIL;
  elPencilBtn.appendChild(icon);
  elPencilBtn.addEventListener('click', (e) => {
    if (drawMenuOpen) {
      closeDrawMenu();
      return;
    }
    // Keyboard activation reports detail 0; only then does focus move into
    // the menu (§C2's "open via keyboard focuses the first item").
    openDrawMenu({ focusFirstItem: e.detail === 0 });
  });

  const group = document.createElement('div');
  group.className = 'swatches';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'pencil colour');
  elSwatches = PEN_COLORS.map((c) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.setAttribute('role', 'radio');
    sw.setAttribute('aria-label', c.name);
    sw.dataset.tip = c.name;
    sw.dataset.color = c.hex;
    const dot = document.createElement('span');
    dot.className = 'swatch-dot';
    dot.style.background = c.hex;
    dot.setAttribute('aria-hidden', 'true');
    sw.appendChild(dot);
    sw.addEventListener('click', () => choosePenColor(c.hex));
    group.appendChild(sw);
    return sw;
  });
  paintSwatches();

  tools.appendChild(elPencilBtn);
  tools.appendChild(group);
  return tools;
}

function buildDrawMenu(): HTMLDivElement {
  elDrawMenu = document.createElement('div');
  elDrawMenu.className = 'draw-menu';
  elDrawMenu.setAttribute('role', 'menu');
  elDrawMenu.setAttribute('aria-label', 'drawing options');
  elDrawMenu.dataset.open = 'false';
  // "erase all"'s reason sits beside the menu, not over it (§AG).
  elDrawMenu.dataset.tipEdge = '';

  elEraseItem = document.createElement('button');
  elEraseItem.type = 'button';
  elEraseItem.className = 'draw-menu-item';
  elEraseItem.setAttribute('role', 'menuitem');
  // Greyed out while nothing is drawn, but still hoverable and focusable
  // (aria-disabled, not disabled), so it can say why — like the sidebar's
  // "delete all for this website" (§AF).
  elEraseItem.dataset.tipReason = NOTHING_TO_ERASE_MESSAGE;
  elEraseItem.dataset.tipSide = 'left';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = ICON_ERASER;
  const label = document.createElement('span');
  label.textContent = 'erase all';
  elEraseItem.appendChild(icon);
  elEraseItem.appendChild(label);
  elEraseItem.addEventListener('click', () => {
    if (isSoftDisabled(elEraseItem)) return;
    eraseAll();
    closeDrawMenu({ returnFocus: true });
  });

  elDrawMenu.appendChild(elEraseItem);
  return elDrawMenu;
}

/** The surface strokes are drawn on, and the layer they live in. Inserted
 *  before the resize zones so the zones stay on top of it along the edges. */
function buildDrawSurface(): void {
  if (!elVisuals) return;
  elDrawSurface = document.createElement('div');
  elDrawSurface.className = 'draw-surface';
  // Focusable but not a Tab stop: a stroke moves focus here, off the
  // textarea, so Cmd/Ctrl+Z means "undo stroke" (design spec §AB).
  elDrawSurface.tabIndex = -1;
  elDrawSurface.setAttribute('role', 'img');
  elDrawSurface.setAttribute('aria-label', 'drawing on the selection');
  elDrawSurface.addEventListener('pointerdown', handleSurfacePointerDown);

  elStrokes = document.createElementNS(SVG_NS, 'svg');
  elStrokes.setAttribute('class', 'draw-strokes');
  elStrokes.setAttribute('aria-hidden', 'true');
  elDrawSurface.appendChild(elStrokes);

  elVisuals.insertBefore(elDrawSurface, elZones[ZONE_KEYS[0]] ?? null);
}

function layoutHost(bounds: Bounds): void {
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
  paintBoxOutline(box.width, box.height);
  // The scrim's hole is exactly the box rect (same radius in CSS); the
  // outline's box-shadow is drawn outside it, on top of the dimming.
  if (elScrim) setRectStyle(elScrim, box.x, box.y, box.width, box.height);
  if (elVisuals) elVisuals.dataset.hasBox = 'true';

  renderZones();
  renderDrawLayer(bounds);
  positionComment(bounds);
}

/** The surface takes the box's rect; the stroke layer inside it is shifted
 *  back by the same amount and sized to the whole selectable area, so the
 *  strokes stay where they were drawn on the page and the box is only ever
 *  their clip (design spec §AB). 1:1 CSS px, no viewBox. */
function renderDrawLayer(bounds: Bounds): void {
  if (!elDrawSurface || !elStrokes) return;
  setRectStyle(elDrawSurface, box.x, box.y, box.width, box.height);
  elStrokes.style.left = `${-box.x}px`;
  elStrokes.style.top = `${-box.y}px`;
  elStrokes.setAttribute('width', `${bounds.width}`);
  elStrokes.setAttribute('height', `${bounds.height}`);
}

/** Fit a placed box back inside `bounds`: shifted first (size kept), and
 *  shrunk only on an axis where it no longer fits at all. */
function clampBoxToBounds(b: Rect, bounds: Bounds): Rect {
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

/** Resize the outline SVG to match the box. The stroke is centred on the
 *  rect's own path, so the path sits half a stroke outside the box: the line
 *  lands entirely outside the selection and never covers what gets captured.
 *  1:1 with CSS pixels (no viewBox scaling) so the 4px dashes stay 4px at
 *  every box size. */
function paintBoxOutline(width: number, height: number): void {
  if (!elBoxDash || !elDashInk || !elDashAccent) return;
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const svgW = w + OUTLINE_PAD * 2;
  const svgH = h + OUTLINE_PAD * 2;
  elBoxDash.setAttribute('width', `${svgW}`);
  elBoxDash.setAttribute('height', `${svgH}`);
  // The stroke is centred on this path, so insetting it half a stroke from
  // the SVG's edge puts the line exactly in the 2px immediately outside the
  // box.
  const inset = OUTLINE_PAD - OUTLINE_W / 2;
  const rw = Math.max(0, w + (OUTLINE_PAD - inset) * 2);
  const rh = Math.max(0, h + (OUTLINE_PAD - inset) * 2);
  // The box's own radius, grown by however far the path sits outside it, so
  // the line stays concentric with the rounded selection.
  const radius = RADII.md + (OUTLINE_PAD - inset);
  for (const rect of [elDashInk, elDashAccent]) {
    rect.setAttribute('x', `${inset}`);
    rect.setAttribute('y', `${inset}`);
    rect.setAttribute('width', `${rw}`);
    rect.setAttribute('height', `${rh}`);
    rect.setAttribute('rx', `${radius}`);
  }
}

function setRectStyle(el: HTMLDivElement, x: number, y: number, width: number, height: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, width)}px`;
  el.style.height = `${Math.max(0, height)}px`;
}

function positionComment(bounds: Bounds): void {
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
// Add-mode preview: the selection rect follows the cursor (design spec §G)
// ---------------------------------------------------------------------------

/** Shows the box+scrim visuals (marked `data-preview="true"`, per the spec's
 *  own wording) at `rect`, plus the tooltip. Safe to call on every
 *  'placing'-phase mousemove: the rect/tooltip position is updated
 *  unconditionally (1:1 with the pointer, no easing), while the one-time
 *  fade-in only runs the first time (`previewVisible` false -> true). */
function showPreview(rect: Rect, bounds: Bounds): void {
  if (!elBox || !elScrim || !elVisuals) return;
  layoutHost(bounds);
  setRectStyle(elBox, rect.x, rect.y, rect.width, rect.height);
  paintBoxOutline(rect.width, rect.height);
  setRectStyle(elScrim, rect.x, rect.y, rect.width, rect.height);

  if (!previewVisible) {
    previewVisible = true;
    elVisuals.dataset.preview = 'true';
    elBox.dataset.preview = 'true';
    // Force a style flush between adding data-preview (opacity: 0, having
    // just come from display: none — see the CSS) and flipping
    // data-preview-visible (opacity: 1) below, or the browser coalesces both
    // attribute writes into one recalc and the fade-in never runs.
    void elVisuals.offsetWidth;
    elVisuals.dataset.previewVisible = 'true';
  }
}

/** Reverse of showPreview(): hides the box/scrim (instantly — the spec only
 *  describes a fade for the appearance) and the tooltip. No-op if the
 *  preview isn't currently shown. */
function hidePreview(): void {
  if (!previewVisible) return;
  previewVisible = false;
  if (elVisuals) {
    delete elVisuals.dataset.preview;
    delete elVisuals.dataset.previewVisible;
  }
  if (elBox) delete elBox.dataset.preview;
  hideTooltip();
}

/** Shows (and keeps positioned) the first-run hint, unless its once-per-page
 *  window has already closed (design spec v4 §N). The preview rect itself is
 *  unaffected by any of this and keeps following the cursor. */
function showTooltip(cursorX: number, cursorY: number, bounds: Bounds): void {
  if (!elPreviewTooltip || tooltipSpent()) return;
  positionTooltip(cursorX, cursorY, bounds);
  elPreviewTooltip.dataset.visible = 'true';
  armTooltipTimer();
}

function hideTooltip(): void {
  if (elPreviewTooltip) delete elPreviewTooltip.dataset.visible;
  clearTooltipTimer();
}

function tooltipSpent(): boolean {
  return tooltipDeadline !== null && Date.now() >= tooltipDeadline;
}

/** Starts the countdown on the hint's first ever appearance, and re-arms it
 *  for whatever is left of that window on any later one. */
function armTooltipTimer(): void {
  if (tooltipTimer) return;
  if (tooltipDeadline === null) tooltipDeadline = Date.now() + TOOLTIP_LIFETIME;
  tooltipTimer = setTimeout(hideTooltip, Math.max(0, tooltipDeadline - Date.now()));
}

function clearTooltipTimer(): void {
  if (tooltipTimer === null) return;
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
}

/** Drives the preview while 'placing' and no placement gesture has begun yet
 *  (`placeStart` is only set between a blocker mousedown and its matching
 *  mouseup — see handleBlockerMouseDown/onPlacementUp): on every pointer
 *  move, shows the exact default box a click would produce right now
 *  (computeDefaultBox + clampBoxToBounds — the same functions the real
 *  click-to-place path uses, so the preview can never lie about the
 *  outcome), plus the "click or drag to select" tooltip. Reuses this
 *  module's one document-level mousemove path rather than a second
 *  animation loop — there's no rAF loop here at all; position is just
 *  written straight from the event, same as onPlacementMove/onResizeMove. */
function onPlacementHoverMove(e: MouseEvent): void {
  if (mode !== 'placing' || placeStart) return;

  const bounds = getBounds();
  if (e.clientX < 0 || e.clientY < 0 || e.clientX > bounds.width || e.clientY > bounds.height) {
    hidePreview(); // pointer moved onto the sidebar, or otherwise off the selectable area
    return;
  }

  const rect = clampBoxToBounds(computeDefaultBox(e.clientX, e.clientY, bounds), bounds);
  showPreview(rect, bounds);
  showTooltip(e.clientX, e.clientY, bounds);
}

/** Belt-and-braces for onPlacementHoverMove()'s own bounds check above:
 *  `mousemove` never fires once the pointer is actually outside the browser
 *  window, so that check alone would leave the preview stuck at its last
 *  position. `mouseout` with a null `relatedTarget` fires exactly when the
 *  pointer leaves the document entirely (design spec §G: "leaves the
 *  viewport"). */
function onPlacementMouseOut(e: MouseEvent): void {
  if (mode !== 'placing') return;
  if (e.relatedTarget === null) hidePreview();
}

// ---------------------------------------------------------------------------
// Placement (first click) and resize (hit-zone drag)
// ---------------------------------------------------------------------------

function handleBlockerMouseDown(e: MouseEvent): void {
  if (mode !== 'placing') {
    // 'editing': clicking outside the box/comment does nothing (§1.2) — not
    // even move focus. Left to its default, the press would blur the
    // textarea or the drawing surface onto the page's <body>, outside the
    // keyboard isolation, and the page would get the next Cmd/Ctrl+Z.
    if (mode === 'editing') e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();

  // The preview deliberately stays up through the press. Dropping it here
  // left nothing drawn at all between mousedown and mouseup — the whole
  // duration of a click — so the outline and the scrim's hole blinked out
  // and back as the box was placed. onPlacementHoverMove stops tracking the
  // moment placeStart is set, so it simply holds still under the cursor
  // until either a drag takes over (below) or finalizePlacement() swaps in
  // the real box.
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
  if (!placeDragging) {
    // A drag, not a click: the real box takes over from here, so the preview
    // goes now (design spec §G, "hides when a drag starts").
    placeDragging = true;
    hidePreview();
  }

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
  stopPlacingKeys();
  elBlocker?.classList.remove('placing');
  // The preview only ever exists during 'placing' (design spec §G: "gone
  // for good once a rect is placed") — drop its listeners and any lingering
  // visual state (already hidden by handleBlockerMouseDown for the
  // mousedown path, but onPlacementUp's drag path never called it).
  document.removeEventListener('mousemove', onPlacementHoverMove);
  document.removeEventListener('mouseout', onPlacementMouseOut);
  hidePreview();

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
  // ...and over the rect's interior, which is otherwise the pencil.
  if (elDrawSurface) elDrawSurface.style.cursor = ZONE_CURSORS[zone];
  closeDrawMenu();
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
  if (elDrawSurface) elDrawSurface.style.cursor = '';
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
}

// ---------------------------------------------------------------------------
// The pencil (design spec §AB)
// ---------------------------------------------------------------------------

/** Whether the pencil may act right now: editing, not mid-capture, and not
 *  mid-resize. */
function canDraw(): boolean {
  return mode === 'editing' && !capturing && activeZone === null;
}

/** Pointer Events rather than the mouse events the placement and resize
 *  gestures use: only they carry coalesced samples, which is what keeps a
 *  fast stroke smooth instead of a polygon of frame-rate corners. The
 *  listeners are document-level like the other gestures', so a stroke that
 *  wanders off the surface keeps drawing (the clip hides that part) — and
 *  pointer capture, where there is one, keeps delivering it even outside
 *  the window. */
function handleSurfacePointerDown(e: PointerEvent): void {
  if (!canDraw() || !elDrawSurface || !elStrokes) return;
  if (e.button !== 0 || activeStroke) return;
  e.preventDefault();
  e.stopPropagation();
  closeDrawMenu();
  // Off the textarea, so Cmd/Ctrl+Z now undoes strokes, not typing (§AB).
  elDrawSurface.focus({ preventScroll: true });

  activeStroke = { color: penColor, points: [[e.clientX, e.clientY]] };
  activePath = createStrokePath(document, activeStroke);
  activeD = activePath.getAttribute('d') ?? '';
  elStrokes.appendChild(activePath);
  activePointerId = e.pointerId;
  if (typeof e.pointerId === 'number' && typeof elDrawSurface.setPointerCapture === 'function') {
    try {
      elDrawSurface.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (the pointer is already gone) — the document
      // listeners still see the rest of the stroke inside the window.
    }
  }
  if (elVisuals) elVisuals.dataset.drawing = 'true';
  if (elBlocker) elBlocker.style.cursor = PENCIL_CURSOR;
  document.addEventListener('pointermove', onStrokeMove);
  document.addEventListener('pointerup', onStrokeEnd);
  document.addEventListener('pointercancel', onStrokeEnd);
}

function isActivePointer(e: PointerEvent): boolean {
  return activePointerId === undefined || e.pointerId === undefined || e.pointerId === activePointerId;
}

/** Append one sample, unless it is too close to the last one to matter. */
function addStrokePoint(x: number, y: number): void {
  if (!activeStroke || !activePath) return;
  const pts = activeStroke.points;
  const [lx, ly] = pts[pts.length - 1];
  if (Math.hypot(x - lx, y - ly) < MIN_POINT_GAP) return;
  if (pts.length === 1) activeD = `M${lx} ${ly}`; // drop the lone-point dot segment
  pts.push([x, y]);
  activeD += `L${x} ${y}`;
  activePath.setAttribute('d', activeD);
}

function onStrokeMove(e: PointerEvent): void {
  if (!activeStroke || !isActivePointer(e)) return;
  const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  if (samples.length === 0) addStrokePoint(e.clientX, e.clientY);
  else for (const s of samples) addStrokePoint(s.clientX, s.clientY);
}

function onStrokeEnd(e: PointerEvent): void {
  if (!activeStroke || !isActivePointer(e)) return;
  if (e.type === 'pointerup') addStrokePoint(e.clientX, e.clientY);
  strokes.push(activeStroke);
  if (activePath) strokePaths.push(activePath);
  endStrokeGesture();
  updateDrawControls();
}

/** Drop the in-flight stroke's listeners and pointer state (not the stroke
 *  itself — onStrokeEnd has already kept it, exitAddMode throws it away). */
function endStrokeGesture(): void {
  document.removeEventListener('pointermove', onStrokeMove);
  document.removeEventListener('pointerup', onStrokeEnd);
  document.removeEventListener('pointercancel', onStrokeEnd);
  if (
    elDrawSurface &&
    typeof activePointerId === 'number' &&
    typeof elDrawSurface.releasePointerCapture === 'function'
  ) {
    try {
      elDrawSurface.releasePointerCapture(activePointerId);
    } catch {
      // Already released by the browser on pointerup.
    }
  }
  activeStroke = null;
  activePath = null;
  activeD = '';
  activePointerId = undefined;
  if (elVisuals) delete elVisuals.dataset.drawing;
  if (elBlocker && activeZone === null) elBlocker.style.cursor = '';
}

/** Cmd/Ctrl+Z outside the textarea: take back the last finished stroke. */
function undoStroke(): void {
  if (!canDraw() || activeStroke) return;
  const path = strokePaths.pop();
  strokes.pop();
  path?.remove();
  updateDrawControls();
}

/** "erase all": every stroke on this selection. */
function eraseAll(): void {
  if (!canDraw() || activeStroke) return;
  for (const path of strokePaths) path.remove();
  strokes = [];
  strokePaths = [];
  updateDrawControls();
}

/** "erase all" is greyed out while there is nothing drawn (§AB). */
function updateDrawControls(): void {
  // A tooltip up for the old state would now say the wrong thing: hide it
  // now, not on the tooltip's MutationObserver (a microtask later).
  if (setSoftDisabled(elEraseItem, strokes.length === 0)) addModeTooltips?.hide();
}

/** Checked state and the radio group's roving tabindex: only the checked
 *  swatch is a Tab stop; the arrows move between them. */
function paintSwatches(): void {
  for (const sw of elSwatches) {
    const on = sw.dataset.color === penColor;
    sw.setAttribute('aria-checked', String(on));
    sw.tabIndex = on ? 0 : -1;
  }
}

/** A colour picked in the swatches — the one path that reports it. */
function choosePenColor(color: PenColor): void {
  if (capturing) return;
  const changed = color !== penColor;
  penColor = color;
  paintSwatches();
  if (changed) callbacksRef?.onPenColorChange?.(color);
}

function openDrawMenu(options: { focusFirstItem?: boolean } = {}): void {
  if (!elDrawMenu || !elPencilBtn || drawMenuOpen || capturing) return;
  drawMenuOpen = true;
  elDrawMenu.dataset.placement = drawMenuFitsBelow() ? 'below' : 'above';
  elDrawMenu.dataset.open = 'true';
  elPencilBtn.setAttribute('aria-expanded', 'true');
  if (options.focusFirstItem) drawMenuItems()[0]?.focus();
}

/** `returnFocus` hands focus back to the pencil — right for Esc and for an
 *  item's activation, wrong for an outside click (the user aimed elsewhere). */
function closeDrawMenu(options: { returnFocus?: boolean } = {}): void {
  if (!elDrawMenu || !elPencilBtn || !drawMenuOpen) return;
  drawMenuOpen = false;
  elDrawMenu.dataset.open = 'false';
  elPencilBtn.setAttribute('aria-expanded', 'false');
  if (options.returnFocus) elPencilBtn.focus();
}

/** Below the comment box unless that would run off the bottom of the
 *  selectable area, as the comment box itself flips (computeCommentPosition). */
function drawMenuFitsBelow(): boolean {
  if (!elComment || !elDrawMenu) return true;
  const top = parseFloat(elComment.style.top) || 0;
  const menuH = elDrawMenu.offsetHeight || DRAW_MENU_FALLBACK_HEIGHT;
  return top + commentHeight + DRAW_MENU_GAP + menuH <= getBounds().height;
}

/** The menu's items, greyed-out ones included: the keyboard reaches them
 *  too, and focus shows why they are off. */
function drawMenuItems(): HTMLButtonElement[] {
  return elEraseItem ? [elEraseItem] : [];
}

function onShadowPointerDown(e: Event): void {
  if (!drawMenuOpen || !elDrawMenu || !elPencilBtn) return;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.includes(elDrawMenu) || path.includes(elPencilBtn)) return;
  closeDrawMenu();
}

function onDocumentPointerDown(e: Event): void {
  if (!drawMenuOpen) return;
  if (e.target === host) return; // already seen by onShadowPointerDown
  closeDrawMenu();
}

function isUndoChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
}

/**
 * Every key pressed inside add mode's host, before keyboardIsolation stops
 * it (see buildCommentDOM). Esc arrives here after content.ts's global
 * handler has already had it — which asks dismissDrawingMenu() first, so an
 * open menu eats one Esc before add mode does.
 */
function handleIsolatedKeydown(e: KeyboardEvent): void {
  if (mode !== 'editing' || !shadow || e.isComposing) return;
  const active = shadow.activeElement;

  if (isUndoChord(e)) {
    // In the textarea the keys keep their own meaning: undoing typing.
    if (active === elTextarea) return;
    e.preventDefault();
    undoStroke();
    return;
  }

  if (e.key === 'Escape' && drawMenuOpen) {
    e.preventDefault();
    closeDrawMenu({ returnFocus: true });
    return;
  }

  if (drawMenuOpen && elDrawMenu && active instanceof Node && elDrawMenu.contains(active)) {
    if (e.key === 'Tab') {
      closeDrawMenu();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = drawMenuItems();
      if (items.length === 0) return;
      e.preventDefault();
      const from = Math.max(0, items.indexOf(active as HTMLButtonElement));
      items[(from + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
    return;
  }

  if (active === elPencilBtn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    openDrawMenu({ focusFirstItem: true });
    return;
  }

  const at = elSwatches.indexOf(active as HTMLButtonElement);
  if (at >= 0) {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    // A radio group's arrows move the checked state with the focus, and wrap.
    const next = elSwatches[(at + delta + elSwatches.length) % elSwatches.length];
    const color = next.dataset.color;
    if (isPenColor(color)) choosePenColor(color);
    next.focus();
  }
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
  setSaveEmpty(elTextarea.value.trim().length === 0);
}

/** Save greyed out (soft: aria-disabled) while the note is empty. Its click
 *  does nothing then — handleSaveClick checks the note itself. */
function setSaveEmpty(empty: boolean): void {
  // A tooltip up for the old state would now say the wrong thing.
  if (setSoftDisabled(elSaveBtn, empty)) addModeTooltips?.hide();
}

function handleCancelClick(): void {
  const cbs = callbacksRef;
  exitAddMode();
  cbs?.onCancel();
}

function handleSaveClick(): void {
  if (!elTextarea || !elSaveBtn || !elCancelBtn) return;
  const note = elTextarea.value.trim();
  if (note.length === 0) return; // greyed out (aria-disabled) in this state: no-op

  // Capturing (design spec §3.2): lock the note and both buttons until the
  // capture pipeline either exits add mode (success) or calls
  // showOverlayUI() (failure). readOnly rather than disabled keeps the
  // textarea's focus, so a failed capture hands the user straight back to it.
  elSaveBtn.disabled = true;
  elCancelBtn.disabled = true;
  elSaveBtn.textContent = SAVING_LABEL;
  elTextarea.readOnly = true;
  elComment?.setAttribute('aria-busy', 'true');
  // The pencil goes quiet too: no stroke, undo, erase or colour change may
  // land between this frame and the screenshot. The menu closes so nothing
  // of it is left to hide.
  capturing = true;
  closeDrawMenu();
  setDrawToolsDisabled(true);
  // Nothing of ours may be in the screenshot, a tooltip included — and
  // without its fade: the capture follows within a frame or two, well inside
  // the 90ms fade-out, and a press has usually started one already.
  addModeTooltips?.hide({ immediate: true });

  // The drawing travels as its own layer, cropped to the final rect; the
  // screenshot underneath is taken with every stroke hidden (§AB).
  const drawing = cropDrawing(strokes, box);
  callbacksRef?.onOk({ rect: { ...box }, note, ...(drawing ? { drawing } : {}) });
}

function setDrawToolsDisabled(disabled: boolean): void {
  if (elPencilBtn) elPencilBtn.disabled = disabled;
  for (const sw of elSwatches) sw.disabled = disabled;
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
  // Preview (design spec §G): document-level, like onPlacementMove/
  // onResizeMove, so it still tracks the pointer over the blocker (and sees
  // it leave the selectable area onto the sidebar) without needing its own
  // per-element listener.
  document.addEventListener('mousemove', onPlacementHoverMove);
  document.addEventListener('mouseout', onPlacementMouseOut);
  layoutHost(getBounds());
  window.addEventListener('resize', handleBoundsChange);
  // FR-AM-8: keyboard shortcuts are suppressed for the whole of add mode.
  // Until a box is placed focus is still on the page (or on the sidebar's
  // add button), so the page's shortcuts would fire under the scrim —
  // YouTube's "f" and "k", Gmail's "j" and "k". Every key is stopped before
  // the page hears it, at the key router's PLACING_ISOLATION: after
  // salamander's own handlers (Esc and Option/Alt+N, the sidebar's keys),
  // which run first. Stopped, never cancelled: Space and the arrows still
  // scroll the page natively, as they always did. Placing a box hands over
  // to the comment box's isolation (buildCommentDOM).
  releasePlacingKeys = registerKeyHandler({
    priority: KEY_PRIORITY.PLACING_ISOLATION,
    types: ['keydown', 'keyup', 'keypress'],
    handle: () => 'stop',
  });
}

/** The placing phase's key handler off (a box was placed, or add mode
 *  ended). */
function stopPlacingKeys(): void {
  releasePlacingKeys?.();
  releasePlacingKeys = null;
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

/** True while a selection is placed and its comment box holds typed text —
 *  work content.ts must not silently throw away (e.g. by opening a note). */
export function hasPendingComment(): boolean {
  return mode === 'editing' && ((!!elTextarea && elTextarea.value.trim() !== '') || strokes.length > 0);
}

/** Set the pencil colour without reporting it back — content.ts restoring
 *  the browser session's choice (design spec §AB). Anything not one of the
 *  three palette HEXes is ignored. Safe in any mode; the swatches pick it up
 *  whenever they exist. */
export function setPenColor(color: unknown): void {
  if (!isPenColor(color)) return;
  penColor = color;
  paintSwatches();
}

export function getPenColor(): PenColor {
  return penColor;
}

/** Close the pencil menu if it is open, handing focus back to the pencil.
 *  True if it was — content.ts's global Esc handler asks this first, so Esc
 *  with the menu down closes the menu rather than add mode (§AB). */
export function dismissDrawingMenu(): boolean {
  if (!drawMenuOpen) return false;
  closeDrawMenu({ returnFocus: true });
  return true;
}

/** Hide all add-mode visuals (box outline, resize hit zones, scrim, comment box) for
 *  the single frame of a screenshot capture (§1.2 step 44.1). The page-click
 *  blocker stays up — add mode is still logically active, just invisible.
 *  Safe to call when nothing has been placed yet, though the capture
 *  pipeline only ever calls this once a "save" click has fired. */
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
    elSaveBtn.disabled = false;
    setSaveEmpty(elTextarea ? elTextarea.value.trim().length === 0 : true);
  }
  if (elCancelBtn) elCancelBtn.disabled = false;
  capturing = false;
  setDrawToolsDisabled(false);
}

/** Full teardown: removes all add-mode DOM/listeners and returns to idle.
 *  Called internally by cancel; content.ts calls it itself once a
 *  successful capture completes. */
export function exitAddMode(): void {
  if (mode === 'idle') return;

  window.removeEventListener('resize', handleBoundsChange);

  document.removeEventListener('mousemove', onPlacementHoverMove);
  document.removeEventListener('mouseout', onPlacementMouseOut);
  previewVisible = false;
  // The hint's element is about to go; its deadline is page-session state
  // and deliberately survives (design spec v4 §N).
  clearTooltipTimer();

  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  activeZone = null;

  document.removeEventListener('mousemove', onPlacementMove);
  document.removeEventListener('mouseup', onPlacementUp);
  placeStart = null;
  placeDragging = false;

  keyboardIsolation?.release();
  keyboardIsolation = null;
  stopPlacingKeys();
  addModeTooltips?.destroy();
  addModeTooltips = null;

  endStrokeGesture();
  strokes = [];
  strokePaths = [];
  drawMenuOpen = false;
  capturing = false;
  shadow?.removeEventListener('pointerdown', onShadowPointerDown, true);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);

  if (host && host.parentNode) host.parentNode.removeChild(host);

  host = null;
  shadow = null;
  elBlocker = null;
  elVisuals = null;
  elScrimLayer = null;
  elScrim = null;
  elBox = null;
  elBoxDash = null;
  elDashInk = null;
  elDashAccent = null;
  elZones = {};
  elComment = null;
  elTextarea = null;
  elCounter = null;
  elCancelBtn = null;
  elSaveBtn = null;
  elPreviewTooltip = null;
  elDrawSurface = null;
  elStrokes = null;
  elPencilBtn = null;
  elSwatches = [];
  elDrawMenu = null;
  elEraseItem = null;

  mode = 'idle';
  callbacksRef = null;
  box = { x: 0, y: 0, ...DEFAULT_THUMBNAIL_BOX_SIZE };
}

/** Test-only: current selection rect, so tests can drive placement/resize via
 *  the exported handlers and assert on the resulting geometry. */
export function _boxForTests(): Rect {
  return { ...box };
}

/** Test-only: forget that the first-run hint (design spec v4 §N) has been
 *  shown, so each test starts from a fresh "page session". Production has no
 *  reason to call this — a real page load reloads the module. */
export function _resetHintForTests(): void {
  clearTooltipTimer();
  tooltipDeadline = null;
}

/** Test-only: the finished strokes, in viewport CSS px. */
export function _strokesForTests(): DrawingStroke[] {
  return strokes.map((s) => ({ color: s.color, points: s.points.map(([x, y]) => [x, y] as [number, number]) }));
}

/** Test-only: back to a fresh page session's yellow. */
export function _resetPenColorForTests(): void {
  penColor = DEFAULT_PEN_COLOR;
}

/** Test-only: the hit-zone rects computeZoneRects() produces for the current
 *  box, keyed by zone ('n', 'se', ...). */
export function _zoneRectsForTests(): Record<ZoneKey, Rect> {
  return computeZoneRects(box);
}
