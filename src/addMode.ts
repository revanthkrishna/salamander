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
// that retires itself after ~5s, once per page session — v4 §N).
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

import { Rect } from './types';
import { getSidebarWidth, DEFAULT_THUMBNAIL_BOX_SIZE } from './sidebar';
import { getContentViewportSize } from './capture';
import { clamp } from './flip';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { DISABLED_CSS, FOCUS_RING_CSS, getThemeCSS, RADII, registerThemedHost, STATE_TRANSITION_CSS } from './theme';

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

const MIN_SIZE = 20;
/** Movement threshold (mousedown -> current position), in px, that
 *  distinguishes a "click" (place the centered default-size box) from a
 *  "drag" (draw a custom-sized box between mousedown and the current/mouseup
 *  point) — REQUIREMENTS §1.2. */
const DRAG_THRESHOLD = 5;
const COMMENT_WIDTH = 280;
/** Comment box height before its first layout pass (offsetHeight is 0 until
 *  then): 88px textarea + 42px of visible footer bar (design spec §3.2 v2
 *  §C — the footer's own 56px height, made of a 20px top padding that
 *  absorbs the hidden radius-lg overlap, a 30px button row and 6px bottom
 *  padding, minus the 14px negative margin that tucks it under the
 *  textarea's bottom edge). Only used to pick a flip candidate on the very
 *  first render; every later render measures the real element. */
const COMMENT_FALLBACK_HEIGHT = 130;
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
/** Selection outline: a 2px line whose length alternates 4px accent, 4px
 *  ink. CSS cannot express that — `dashed`/`dotted` derive their dash length
 *  from the line's thickness and give no control over it, and border-image
 *  with a repeating gradient ignores border-radius, which this box has. So
 *  the line is an SVG stroke: a solid ink rect with the accent dashed over
 *  it at the same width, which fills the gaps rather than leaving holes. */
const OUTLINE_W = 2;
const OUTLINE_DASH = 4;
/** How far the SVG extends past the box on each side: the 2px line sits
 *  just outside the box (so the selection itself is never covered), and the
 *  1px keyline shadow sits outside that. */
const OUTLINE_PAD = 3;

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

  /* Selection outline (see OUTLINE_W): the alternating line itself is the
     .box-dash SVG below; this rule keeps the 1px keyline just outside it, so
     the whole thing reads on a white page as well as a dark one. The box's
     own rect IS the selection, so nothing here may cover it — the line is
     drawn OUTSIDE the box, which is why the SVG overhangs. No hover/press
     styling — only the cursor over the hit zones below changes. */
  .box {
    position: absolute;
    border-radius: var(--sal-radius-md);
    box-shadow: 0 0 0 ${OUTLINE_PAD}px var(--sal-keyline);
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

  /* Add-mode preview (design spec §G): while 'placing' and before any box
     has been placed, hovering shows the same box+scrim visuals as a live
     preview of the box a click would produce right now. These two rules are
     an equal-specificity override of the ".visuals:not([data-has-box]) ..."
     display:none rule above (three class/attribute selectors on each side),
     so they only need to win by appearing later in the stylesheet — no
     !important, no touching that rule (a regression test pins its exact
     text). Faded in via opacity rather than the display flip itself, since
     display can't transition; onPlacementHoverMove() forces a style flush
     between setting data-preview and data-preview-visible so the fade-in
     actually runs (see showPreview()). Hiding is instant (spec only
     describes an appear fade), which also covers reduced motion without a
     media-query duplicate of the whole rule. */
  .visuals[data-preview="true"] .scrim-layer,
  .visuals[data-preview="true"] .box {
    display: block;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .visuals[data-preview="true"][data-preview-visible="true"] .scrim-layer,
  .visuals[data-preview="true"][data-preview-visible="true"] .box {
    opacity: 1;
  }

  /* Tooltip that follows the cursor alongside the preview (design spec §G):
     "click or drag to select". Uses the real box/comment surface treatment
     (surface fill, line border, radius md, shadowNote) so it reads as part
     of the same UI. Position is set 1:1 with the pointer in JS (no
     transition on left/top — only opacity fades, per the motion-design
     skill's rule for pointer-following UI: the tracked position itself
     never eases or lags, only the appearance/disappearance may). It is a
     first-run hint, so it also fades back OUT after ~5s and never returns
     for the rest of the page session (v4 §N) — same 120ms opacity
     transition in both directions. */
  .preview-tooltip {
    position: absolute;
    z-index: 1;
    padding: 6px 10px;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    box-shadow: var(--sal-shadow-note);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  .preview-tooltip[data-visible="true"] { opacity: 1; }

  /* The alternating outline. Two rects on the same path at the same stroke
     width: ink underneath, accent dashed on top, so the "gaps" are ink
     rather than holes and the line never gets thicker than OUTLINE_W. Sized
     in JS (paintBoxOutline) because the dash length has to stay 4px whatever
     the box's size — a viewBox that scaled would stretch it. */
  .box-dash {
    position: absolute;
    left: -${OUTLINE_PAD}px;
    top: -${OUTLINE_PAD}px;
    overflow: visible;
    pointer-events: none;
  }
  .box-dash rect { fill: none; stroke-width: ${OUTLINE_W}; }
  .box-dash .dash-ink { stroke: var(--sal-on-accent); }
  .box-dash .dash-accent { stroke: var(--sal-accent); stroke-dasharray: ${OUTLINE_DASH} ${OUTLINE_DASH}; }

  /* The wrapper itself has no fill/border/radius of its own (design spec
     §3.2 v2 §C): it just positions and drop-shadows its two block children,
     the text area and the footer "extension", which each own their own
     rounded surface and together read as one merged shape. */
  .comment-box {
    position: absolute;
    width: ${COMMENT_WIDTH}px;
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    box-shadow: var(--sal-shadow-pop);
    /* Same radius as the two rounded children, so the drop shadow follows
       the merged shape instead of casting a square one. */
    border-radius: var(--sal-radius-lg);
    /* .visuals inherits pointer-events: none from the host (the host is
       pointer-events: none so the blocker underneath can own page-click
       suppression while non-interactive visuals like the box outline and
       scrim stay click-through). .resize-zone opts itself back into auto
       above; the comment box and everything in it (textarea, cancel/save
       buttons) need the same opt-in, or their clicks fall through to nothing
       and only keyboard/Tab focus keeps working. */
    pointer-events: auto;
  }

  /* Text area is its own fully-rounded surface (design spec §3.2 v2 §C):
     radius lg on all four corners, a real 1px border (box-sizing: border-box
     keeps it from growing the box), surface fill. Hover/focus only ever
     change the border colour — no extra ring, no shape change. Positioned
     above the footer (z-index 1 vs 0) so its rounded bottom corners paint
     over the footer's square top ones. */
  .note-input {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 88px;
    box-sizing: border-box;
    margin: 0;
    resize: none;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-lg);
    outline: none;
    background: var(--sal-surface);
    padding: 10px 12px;
    font-family: var(--sal-font-body);
    font-size: 13px;
    line-height: 1.4;
    color: var(--sal-text);
    transition: border-color 140ms ease-out;
  }
  .note-input::placeholder { color: var(--sal-muted); }
  .note-input:hover { border-color: var(--sal-line-strong); }
  /* After :hover so focus wins while both apply. */
  .note-input:focus { border-color: var(--sal-accent); }

  /* Button bar "extension" (design spec §3.2 v2 §C, same pattern as the
     sidebar's hovered note-list item): tucked under the text area's bottom
     edge by exactly one radius-lg via a negative margin, with that same
     amount added back as top padding so the counter/buttons never render
     inside the hidden zone. .footer is a plain block child of .comment-box
     just like .note-input, so both span the same 280px width and their
     edges line up exactly. Its own 1px line border is drawn INSIDE via an
     inset shadow (design spec v4 §O, the same treatment as the note's hover
     extension in v2 §B): a real border would sit outside the padding box and
     bleed half a pixel past the text area's edges, an inset shadow paints on
     the element's own edge, so the two line up exactly. */
  .footer {
    position: relative;
    z-index: 0;
    margin-top: calc(-1 * var(--sal-radius-lg));
    box-sizing: border-box;
    padding: calc(var(--sal-radius-lg) + 6px) 6px 6px 6px;
    border-radius: 0 0 var(--sal-radius-lg) var(--sal-radius-lg);
    background: var(--sal-raised);
    box-shadow: inset 0 0 0 1px var(--sal-line);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .counter {
    margin-right: auto;
    padding: 0 6px;
    font-family: var(--sal-font-mono);
    font-size: 11px;
    color: var(--sal-muted);
    visibility: hidden;
  }
  .counter[data-warn="true"] { visibility: visible; }
  .counter[data-danger="true"] { color: var(--sal-danger); font-weight: 600; }

  /* Ghost buttons (design spec §2 "save"/"cancel" rows, restyled per v2 §C):
     rounded-sm, ~30px tall, padded — free-floating inside the raised bar
     rather than flush against its edges. No vertical dividers between them. */
  .btn {
    height: 30px;
    margin: 0;
    padding: 0 12px;
    border: none;
    border-radius: var(--sal-radius-sm);
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
  .btn-cancel:focus-visible { color: var(--sal-text); ${FOCUS_RING_CSS} }

  .btn-save {
    color: var(--sal-accent-ink);
    font-weight: 700;
  }
  .btn-save:not(:disabled):hover { background: var(--sal-accent); color: var(--sal-on-accent); }
  .btn-save:not(:disabled):active { background: var(--sal-accent-press); color: var(--sal-on-accent); }
  .btn-save:not(:disabled):focus-visible {
    background: var(--sal-accent);
    color: var(--sal-on-accent);
    ${FOCUS_RING_CSS}
  }
  /* Empty note: muted text at half opacity (design spec §2 "save disabled"). */
  .btn-save:disabled { color: var(--sal-muted); opacity: 0.5; }
  /* While capturing (after save), keep the ink colour so "saving…" reads as
     in-progress rather than as the empty-note disabled state. */
  .comment-box[aria-busy="true"] .btn-save:disabled { color: var(--sal-accent-ink); opacity: 1; }

  /* Motion-design skill: reduced motion keeps the opacity change (still
     communicates state) but drops the transition itself, so the preview and
     tooltip appear instantly instead of fading in. Nothing here needs a
     "remove spatial movement" rule — the preview/tooltip never had any: both
     already track the pointer 1:1 with plain style writes, never eased. */
  @media (prefers-reduced-motion: reduce) {
    .visuals[data-preview="true"] .scrim-layer,
    .visuals[data-preview="true"] .box,
    .preview-tooltip {
      transition: none;
    }
  }
`;

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
function getBounds(): { width: number; height: number } {
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
function computeDefaultBox(clickX: number, clickY: number, bounds: { width: number; height: number }): Rect {
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

/** Preview tooltip position (design spec §G): offset (+16, +20) from the
 *  cursor, flipped to the opposite side of whichever axis would overflow,
 *  then unconditionally clamped into `bounds` — same "flip, then clamp
 *  regardless" shape as computeCommentPosition() above, just for a single
 *  fixed-offset candidate instead of four. */
function positionTooltip(cursorX: number, cursorY: number, bounds: { width: number; height: number }): void {
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
  paintBoxOutline(box.width, box.height);
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
  // Path inset OUTLINE_W/2 from the SVG's own edge minus the keyline's 1px:
  // the stroke then spans exactly the 2px immediately outside the box.
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
// Add-mode preview: the selection rect follows the cursor (design spec §G)
// ---------------------------------------------------------------------------

/** Shows the box+scrim visuals (marked `data-preview="true"`, per the spec's
 *  own wording) at `rect`, plus the tooltip. Safe to call on every
 *  'placing'-phase mousemove: the rect/tooltip position is updated
 *  unconditionally (1:1 with the pointer, no easing), while the one-time
 *  fade-in only runs the first time (`previewVisible` false -> true). */
function showPreview(rect: Rect, bounds: { width: number; height: number }): void {
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
function showTooltip(cursorX: number, cursorY: number, bounds: { width: number; height: number }): void {
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
  if (mode !== 'placing') return; // 'editing': clicking outside the box/comment does nothing (§1.2)
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
  // Preview (design spec §G): document-level, like onPlacementMove/
  // onResizeMove, so it still tracks the pointer over the blocker (and sees
  // it leave the selectable area onto the sidebar) without needing its own
  // per-element listener.
  document.addEventListener('mousemove', onPlacementHoverMove);
  document.addEventListener('mouseout', onPlacementMouseOut);
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

/** True while a selection is placed and its comment box holds typed text —
 *  work content.ts must not silently throw away (e.g. by opening a note). */
export function hasPendingComment(): boolean {
  return mode === 'editing' && !!elTextarea && elTextarea.value.trim() !== '';
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
    elSaveBtn.disabled = elTextarea ? elTextarea.value.trim().length === 0 : true;
  }
  if (elCancelBtn) elCancelBtn.disabled = false;
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

/** Test-only: the hit-zone rects computeZoneRects() produces for the current
 *  box, keyed by zone ('n', 'se', ...). */
export function _zoneRectsForTests(): Record<ZoneKey, Rect> {
  return computeZoneRects(box);
}
