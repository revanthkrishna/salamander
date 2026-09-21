// src/enlargedView.ts
// The enlarged view (design spec v2 §D/§E, design/MOTION_SPEC.md) — replaces
// the old centred modal (src/modal.ts, removed). Clicking a note makes the
// SIDEBAR ITSELF grow leftward to ~75% of the viewport and become a note
// viewer/editor: previous-note peek (cut by the panel top), a header bar
// with "feedback #n" and the delete button, the screenshot at its own size,
// the autosaving note editor, next-note peek (cut by the panel bottom), and
// an x / ↑ / ↓ rail.
//
// The screenshot is shown at the selection's original CSS size (design spec
// v4 §M) — no card, no fill, no letterboxing — so the main slot IS the
// rendered <img> box, the header bar and editor take their width from it.
// That block (title bar + image + textarea) is centred in the sheet both ways
// and is the anchor for everything else (design spec v5 §R). The peeks are
// each their OWN note fitted the same way and scaled to 0.75, so a peek is a
// preview of the note you are about to open rather than a copy of the focused
// one's proportions, and they sit on an arc: one circle centred off to the
// right whose leftmost point is the block's centre, which pushes both peeks
// right of the block by the same law. All of that makes the layout
// note-dependent in three places at once: computeGeometry() reruns on every
// index change and takes the neighbours' natural sizes with it. Only the rail
// is fixed — pinned to the VIEWPORT's right edge and vertically centred, it
// never moves when any image resizes.
//
// ── Where it renders ────────────────────────────────────────────────────────
// Inside the sidebar's own closed shadow root (sidebar.ts hands this module
// a mount), not a new host: it IS the sidebar enlarging, so it shares the
// sidebar's theme host, <style> element and stacking context, and the list's
// real DOM (whose rects the shared-element morphs start/end on) is right
// there. The page is never re-laid out — the sidebar's page-shrink margin is
// untouched and the wide panel simply overlays the page; the rest of the
// visible page gets the `scrim` token (no blur anywhere).
//
// Four position:fixed layers (all children of one `.enlarged` wrapper, which
// has no stacking context of its own, so their z-indexes interleave with the
// docked `.sidebar` in the host's context), bottom → top:
//   .xp-scrim   full-viewport scrim; click = collapse
//   .xp-bg      the panel background (bg fill + 1px line left border) — the
//               one that visibly "grows leftward"
//   .sidebar    (sidebar.ts's docked list) — fades out *over* the growing bg
//   .xp-stage   title, editor, rail and the riding logo+wordmark; same
//               animated width as .xp-bg, overflow hidden = the hard clip
//   .xp-front   the morphing screenshot cards; same width + a small bleed on
//               the left, so a dock-magnified list thumbnail (which swells
//               ~40px past the docked panel edge, src/dockMotion.ts) isn't
//               clipped on the very first frame of the expand
// Every layer is right-anchored and everything inside is positioned from
// the viewport's right edge, so nothing internal depends on the animated
// width (MOTION_SPEC §13, "Panel: width vs. clip-path").
//
// ── Motion ──────────────────────────────────────────────────────────────────
// Shared elements (panel edge, clicked thumbnail, its ≤2 neighbours,
// logo+wordmark) morph; everything else fades in place (§2/§3). The cards
// are transform-only FLIP with sampled keyframes (src/flip.ts): layout box
// set once to Last, transforms play First → identity, with the screenshot
// counter-transformed (no distortion) and radii compensated per sample.
// Fades and the panel width use single WAAPI animations. Each tween keeps
// an analytic record (flip.ts), so any gesture can start from the live
// state of the previous one: collapse mid-expand reverses from where the
// panel/cards are, a second ↓ mid-carousel retargets every card from its
// current rect (MOTION_SPEC §13 option (a), the preferred one — no input is
// dropped or queued), delete mid-morph restarts from the live rect.
// Choreography timers (settle, content swap, delete step) are owned by this
// object and all cleared on every teardown path.
//
// prefers-reduced-motion is read live (a change listener, like
// dockMotion.ts): geometry then changes instantly and only crossfades run,
// at roughly halved durations (§12).
//
// ── Behaviour ───────────────────────────────────────────────────────────────
// Autosave (debounced 700ms + flushed on blur / navigate / collapse), the
// "a note can never be empty" lock, immediate delete + carousel, keyboard
// (Esc, ↑/↓, Tab order rail → peeks → editor → delete) with keyboard
// isolation from the host page (src/keyboardIsolation.ts). Like modal.ts
// before it, this module never touches chrome.runtime: content.ts supplies
// fetchFullImage/onSaveNote/onDelete.

import { FeedbackItem } from './types';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
// The project's one trash glyph (design spec v5 §S) — the note list's.
import { ICON_TRASH } from './thumbnails';
import { FOCUS_RING_CSS, PRESS_SCALE_CSS, DISABLED_CSS, STATE_TRANSITION_CSS, RADII } from './theme';
import {
  ACC,
  STD,
  Slot,
  Tween,
  animateEl,
  animateNumber,
  cancelTracks,
  containFit,
  currentOpacity,
  fadeTo,
  insetBox,
  lerpSlot,
  morphKeyframes,
  now,
  trackedValue,
  tweenProgress,
} from './flip';

// ---------------------------------------------------------------------------
// Copy (lowercase UI, §3.4). The save/delete failures are the old modal's
// strings, byte-exact.
// ---------------------------------------------------------------------------

export const SAVE_ERROR_MESSAGE = "couldn't save note. try again.";
/** A save failure for a note other than the one on screen names it. */
export function saveErrorFor(id: number): string {
  return `couldn't save note #${id}. try again.`;
}
export const DELETE_ERROR_MESSAGE = "couldn't delete item. try again.";
export const EMPTY_NOTE_MESSAGE = "a note can't be empty. add some text to continue.";

// ---------------------------------------------------------------------------
// Timing (MOTION_SPEC §5–§12). Durations in ms.
// ---------------------------------------------------------------------------

export const T = {
  expand: 450,
  expandSettle: 500,
  collapse: 340,
  collapseSettle: 360,
  carousel: 400,
  scrimIn: 200,
  listOut: 150,
  badgeDelayIn: 150,
  fade: 200,
  titleDelay: 200,
  editorDelay: 250,
  railDelay: 300,
  stageOut: 120,
  scrimOutDelay: 150,
  scrimOut: 150,
  listInDelay: 150,
  listIn: 200,
  contentOut: 120,
  contentIn: 180,
  peekOut: 150,
  farPeekDelay: 200,
  deleteStep: 180,
  autosave: 700,
  errorIn: 200,
  errorOut: 120,
  shake: 200,
  // Reduced motion (§12): crossfades only, ~halved.
  rdScrimIn: 100,
  rdListOut: 75,
  rdStageIn: 125,
  rdExpandSettle: 160,
  rdStageOut: 75,
  rdListInDelay: 50,
  rdListIn: 100,
  rdCollapseSettle: 200,
  rdSwapOut: 75,
  rdSwapAt: 80,
  rdSwapIn: 125,
} as const;

/** How far .xp-front's clip extends left of the panel edge — covers the
 *  dock magnification's worst case (sidebar.ts's DOCK_BLEED_PX reasoning:
 *  ~38px past the edge at the 300px maximum width). */
const FRONT_BLEED_PX = 48;
const FRAME_RADIUS = RADII.md;
/** The editor is the textarea and nothing else (design spec v5 §R removed
 *  the bar under it). The failure/empty-note text sits under the textarea
 *  out of flow, so it reserves no height while idle. */
const EDITOR_HEIGHT = 96;
const TITLE_BLOCK = 46; // 34px title row + 12px gap
const RAIL_BTN = 40;
/** x + ↑ + ↓ stacked: three 40px buttons, an 8px gap between each and the
 *  extra 8px margin under x. */
const RAIL_HEIGHT = RAIL_BTN * 3 + 8 * 3;
/** The rail's margin from the VIEWPORT's right edge (design spec v5 §R). It
 *  is vertically centred there and never moves when an image resizes. */
const RAIL_MARGIN = 20;
/** Image → editor gap inside the block. */
const COLUMN_GAP = 16;
/** Floor for the header bar / editor width, so a tiny selection still leaves
 *  a usable title row and note editor (design spec v4 §M). */
const MIN_COLUMN_W = 240;
/** A peek card is this fraction of ITS OWN note's fitted size (design spec
 *  v5 §R), so navigating to it grows it to its true size — a zoom, not a
 *  reshape. This replaces v4 §M's "0.75 × the main image box", which made
 *  every peek a copy of the focused note's proportions. */
export const PEEK_SCALE = 0.75;
/** How much of each peek shows past the sheet's top / bottom edge (§R). */
export const PEEK_REVEAL_PX = 20;
/** The arc's intended horizontal push at a vertical distance of H/2 (§R).
 *  The circle is solved from this, so the push at the peeks' real offsets
 *  follows from the geometry rather than being dialled in per peek. */
export const ARC_PUSH_PX = 60;
/** Breathing room between the block and the rail column, reserved on BOTH
 *  sides of the sheet so the block's centring stays symmetric (§R). */
const COLUMN_GUTTER = 20;
/** Instrument Serif italic overhangs its glyph origin to the LEFT (the
 *  leading "f" of "feedback" most visibly). The title's box is inset by this
 *  much and pulled back by the same amount, so the ink has room while the
 *  text's origin still lands exactly on the column's left edge — the header,
 *  the image and the editor keep one shared left edge. */
const TITLE_INK_BLEED = 8;

// ---------------------------------------------------------------------------
// Geometry. MOTION_SPEC §4's fixed slots are long gone: v4 §M replaced the
// main slot with the image's own box, and v5 §R replaced the peeks with each
// neighbour's own box on an arc, and re-anchored the whole sheet.
// ---------------------------------------------------------------------------

export interface EnlargedGeometry {
  /** Viewport right edge (px) everything is anchored to. */
  vwRight: number;
  panelW: number;
  railRight: number;
  railTop: number;
  /** Width of the header bar and the editor: the main image's rendered width,
   *  floored at MIN_COLUMN_W so a tiny selection still leaves both usable
   *  (design spec v4 §M). */
  columnW: number;
  /** The block's inset from the viewport's right edge. The block is CENTRED
   *  in the sheet (v5 §R), so this moves with the image's width. */
  columnRight: number;
  titleTop: number;
  editorTop: number;
  main: Slot;
  prev: Slot;
  next: Slot;
}

/** The natural sizes of the notes either side of the one in focus. Each peek
 *  is sized from its own (design spec v5 §R), so they can differ. */
export interface NeighbourSizes {
  prev?: NaturalSize | null;
  next?: NaturalSize | null;
}

/** A note's screenshot at its ORIGINAL size — `item.selectionRect`'s CSS
 *  pixels, not the stored PNG's (which is at `item.dpr`). */
export interface NaturalSize {
  w: number;
  h: number;
}

/**
 * The radius of the arc the focused block and both peeks sit on (design spec
 * v5 §R). The circle's centre is off to the RIGHT of the block with the
 * block's centre as its leftmost point, so it is fixed by asking for a
 * horizontal push of `ARC_PUSH_PX` at a vertical distance of `H / 2`:
 *
 *     R = (D² + P²) / 2P,   D = H / 2,  P = ARC_PUSH_PX
 */
export function arcRadius(sheetH: number): number {
  const d = Math.max(1, sheetH) / 2;
  return (d * d + ARC_PUSH_PX * ARC_PUSH_PX) / (2 * ARC_PUSH_PX);
}

/** How far right of the block's centre a point `dy` above/below it sits on
 *  that circle: `R − sqrt(R² − dy²)`, clamped to R once |dy| reaches R (the
 *  sqrt's radicand is guarded rather than allowed to go NaN — §R). */
export function arcPush(dy: number, radius: number): number {
  const a = Math.abs(dy);
  if (!(radius > 0)) return 0;
  if (a >= radius) return radius;
  return radius - Math.sqrt(Math.max(0, radius * radius - a * a));
}

/**
 * Pure layout for a `vw`×`vh` viewport showing a screenshot of `natural`
 * CSS size, with `neighbours` the natural sizes of the notes either side.
 *
 * The main slot is the image itself (design spec v4 §M): no card, no fill,
 * no letterboxing, so the slot IS the rendered `<img>` box — `natural`
 * scaled DOWN to fit the sheet less the rail column on either side, and the
 * height the title row and editor leave over, and never scaled up past it.
 * The header bar and the editor take the image's width (columnW, floored at
 * MIN_COLUMN_W; a narrower image is then centred within it), and that whole
 * block is centred in the sheet horizontally AND vertically (v5 §R). The
 * rail is pinned to the viewport's right edge and vertically centred,
 * independent of the block, so it never moves when the image resizes.
 *
 * Each peek is its OWN note fitted the same way and scaled by PEEK_SCALE
 * (§R) — a preview of the note you are about to open, which then grows to
 * its true size when you navigate to it, so peek ↔ main is a pure uniform
 * scale. `PEEK_REVEAL_PX` of it shows past the sheet's top / bottom edge,
 * which fixes each peek's centre y from its own height; the arc above turns
 * that vertical offset into the horizontal push, so two peeks of different
 * sizes get different pushes and still sit on one circle.
 *
 * The panel is 75% of the viewport but at least 560px (or the whole
 * viewport, if narrower) and never narrower than the docked sidebar.
 *
 * A natural size omitted/degenerate (an item with no usable selectionRect)
 * falls back to the largest 16:9 box that fits — the same aspect aspectOf()
 * falls back to, so the image still fills its slot exactly.
 */
export function computeEnlargedGeometry(
  vw: number,
  vh: number,
  sidebarWidth: number,
  natural?: NaturalSize | null,
  neighbours?: NeighbourSizes,
): EnlargedGeometry {
  const vwRight = Math.max(1, vw);
  const vhBottom = Math.max(1, vh);
  const panelW = Math.round(Math.min(vwRight, Math.max(0.75 * vwRight, Math.min(560, vwRight), sidebarWidth)));
  const sy = Math.min(vhBottom / 900, 1.25);

  // The rail rides the viewport's right edge (§R). The same column width is
  // reserved on BOTH sides of the sheet, so the block can be centred in the
  // sheet and still never reach the rail.
  const railRight = RAIL_MARGIN;
  const sideReserve = RAIL_MARGIN + RAIL_BTN + COLUMN_GUTTER;

  // The box every image is fitted into: the sheet less those two reserves,
  // and the viewport height less the title row, the editor and their margins.
  const marginV = Math.min(140, Math.max(40, Math.round(96 * sy)));
  const maxW = Math.max(160, panelW - 2 * sideReserve);
  const maxH = Math.max(100, vhBottom - 2 * marginV - TITLE_BLOCK - COLUMN_GAP - EDITOR_HEIGHT);

  // Width rounds to a whole pixel; the height then follows from the aspect
  // rather than rounding independently, so the slot's aspect is EXACTLY the
  // image's and the contain-fit leaves no sub-pixel letterbox band showing
  // along an edge (§M: no container fill, no border).
  const fitted = (n: NaturalSize | null | undefined): NaturalSize => {
    const nat = n && n.w > 0 && n.h > 0 ? n : { w: (16 / 9) * maxH, h: maxH };
    const fit = Math.min(1, maxW / nat.w, maxH / nat.h);
    const w = Math.max(1, Math.round(nat.w * fit));
    return { w, h: Math.max(1, (w * nat.h) / nat.w) };
  };

  const { w: mainW, h: mainH } = fitted(natural);
  const columnW = Math.max(Math.min(MIN_COLUMN_W, maxW), mainW);
  const blockH = TITLE_BLOCK + mainH + COLUMN_GAP + EDITOR_HEIGHT;

  // The block, centred in the sheet both ways. Its centre (bx, by) anchors
  // the arc below; `by` is read back off the clamped top rather than assumed
  // to be H/2, so a block too tall to centre still puts the peeks on a
  // circle through where the block actually is.
  const bx = vwRight - panelW / 2;
  const titleTop = Math.max(16, Math.round(vhBottom / 2 - blockH / 2));
  const by = titleTop + blockH / 2;
  const mainTop = titleTop + TITLE_BLOCK;
  const editorTop = mainTop + mainH + COLUMN_GAP;
  const columnX = Math.round(bx - columnW / 2);
  const columnRight = vwRight - (columnX + columnW);

  // PEEK_SCALE of each neighbour's OWN fitted box, so peek ↔ main for that
  // note is a pure uniform scale with no letterboxing at either end (§R).
  const peekBox = (n: NaturalSize | null | undefined): NaturalSize => {
    const f = fitted(n);
    const w = Math.max(1, Math.round(f.w * PEEK_SCALE));
    return { w, h: Math.max(1, (w * f.h) / f.w) };
  };
  const radius = arcRadius(vhBottom);
  /** `centreY` comes from the PEEK_REVEAL_PX rule and that peek's own
   *  height; the arc then supplies the push from the resulting offset. */
  const peekSlot = (box: NaturalSize, centreY: number): Slot => ({
    x: Math.round(bx + arcPush(centreY - by, radius) - box.w / 2),
    y: Math.round(centreY - box.h / 2),
    w: box.w,
    h: box.h,
    pad: 0,
    imgR: FRAME_RADIUS,
  });
  const prevBox = peekBox(neighbours?.prev);
  const nextBox = peekBox(neighbours?.next);

  return {
    vwRight,
    panelW,
    railRight,
    railTop: Math.max(16, Math.round((vhBottom - RAIL_HEIGHT) / 2)),
    columnW,
    columnRight,
    titleTop,
    editorTop,
    // Centred within the column (§R), which only shows when the MIN_COLUMN_W
    // floor has made the column wider than a small screenshot — otherwise the
    // two are the same box. pad 0 + the image's own aspect = the frame is
    // exactly covered: no letterboxing, nothing of a card left to see.
    main: {
      x: columnX + Math.round((columnW - mainW) / 2),
      y: mainTop,
      w: mainW,
      h: mainH,
      pad: 0,
      imgR: FRAME_RADIUS,
    },
    // PEEK_REVEAL_PX of each peek shows past the sheet's top / bottom edge.
    prev: peekSlot(prevBox, PEEK_REVEAL_PX - prevBox.h / 2),
    next: peekSlot(nextBox, vhBottom - PEEK_REVEAL_PX + nextBox.h / 2),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnlargedViewCallbacks {
  /** Full-resolution screenshot for `item`, or null (thumbnail stays). */
  fetchFullImage: (item: FeedbackItem) => Promise<string | null>;
  /** Persist `note` for `item`; resolves false on failure. */
  onSaveNote: (item: FeedbackItem, note: string) => Promise<boolean>;
  /** Delete `item` (and its blob); resolves false on failure. */
  onDelete: (item: FeedbackItem) => Promise<boolean>;
  /** Fired once the view is fully gone (however it closed, except destroy())
   *  with the note that was current, or null if every note was deleted. */
  onClosed: (currentItemId: number | null) => void;
}

/** What the sidebar lends the view — its shadow root, its docked panel and
 *  a few list hooks. Everything is read at the moment it's needed. */
export interface EnlargedViewMount {
  host: HTMLElement;
  shadow: ShadowRoot;
  sidebarEl: HTMLElement;
  getSidebarWidth: () => number;
  getListLayout: () => { narrow: boolean };
  getLogoSrc: () => string;
  /** The list thumbnail box (.thumbnail-image-wrap) for an item, if rendered. */
  getListThumb: (id: number) => HTMLElement | null;
  /** The list's scrollport rect (for "is this slot visible?"). */
  getListViewport: () => DOMRect | null;
  /** Scroll the (hidden) list so the item is centred. */
  centreListOn: (id: number) => void;
  /** Repaint the list from `items` (edits/deletes made in this view). */
  renderList: (items: FeedbackItem[]) => void;
  setDockSuspended: (suspended: boolean) => void;
  /** Focus the list item for `id`; false if it isn't rendered. */
  focusListItem: (id: number) => boolean;
  /** Where focus goes when there's no list item to return to (the last
   *  note was deleted) — the "add note" button. */
  focusFallback: () => void;
  /** The sidebar's own error banner — for a save that fails once the view
   *  has collapsed (while it's up the list, banner included, is invisible
   *  and inert, so failures go to the view's own status slot instead). */
  showBanner: (message: string) => void;
}

export type EnlargedState = 'opening' | 'open' | 'closing' | 'closed';

export interface EnlargedViewHandle {
  getState(): EnlargedState;
  /** User-initiated collapse (x / Esc / scrim / sidebar close). Returns false
   *  — and shows the empty-note error — if the current note is empty. */
  requestCollapse(opts?: { immediate?: boolean }): boolean;
  /** Collapse instantly, bypassing the empty-note lock (add mode, SPA
   *  navigation, sidebar teardown). Still flushes a non-empty unsaved edit
   *  and fires onClosed. */
  forceClose(): void;
  /** Best-effort, fire-and-forget save of every pending non-empty edit
   *  (page unload). Never saves an empty note; never changes the view. */
  flush(): void;
  /** Silent teardown (no onClosed) — sidebar destroy. */
  destroy(): void;
  setLogoSrc(src: string): void;
  /** Recompute geometry (viewport / sidebar width changed). */
  relayout(): void;
}

// ---------------------------------------------------------------------------
// CSS — appended to the sidebar's single <style> (sidebar.ts)
// ---------------------------------------------------------------------------

const Z_SCRIM = 2147483643;
const Z_BG = 2147483644; // below .sidebar (2147483645)
const Z_STAGE = 2147483646;
const Z_FRONT = 2147483647;

export const ENLARGED_VIEW_CSS = `
  /* ─── Enlarged view (design spec v2 §D, src/enlargedView.ts) ──────────── */
  .sidebar.is-expanded { pointer-events: none !important; }
  /* The header mark is replaced by .xp-brand, which rides the panel edge. */
  .sidebar.is-brand-riding .header .logo,
  .sidebar.is-brand-riding .header .wordmark { visibility: hidden; }

  .xp-scrim {
    position: fixed; inset: 0;
    background: var(--sal-scrim);
    z-index: ${Z_SCRIM};
    pointer-events: auto;
  }
  .xp-bg {
    position: fixed; top: 0; bottom: 0; right: 0;
    background: var(--sal-bg);
    border-left: 1px solid var(--sal-line);
    z-index: ${Z_BG};
    pointer-events: auto;
  }
  .xp-stage, .xp-front {
    position: fixed; top: 0; bottom: 0; right: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .xp-stage { z-index: ${Z_STAGE}; }
  .xp-front { z-index: ${Z_FRONT}; }

  .xp-brand {
    position: absolute; top: 0; left: 16px;
    height: 56px;
    display: flex; align-items: center; gap: 10px;
    pointer-events: none;
    white-space: nowrap;
  }
  .xp-brand img { width: 35px; height: 20px; display: block; flex-shrink: 0; }
  .xp-brand-word {
    font-family: var(--sal-font-display);
    font-style: italic; font-size: 22px; line-height: 1;
    color: var(--sal-text);
  }

  /* Header bar: the title at the left, the delete icon button at the right
     (design spec v4 §M). applyStageGeometry() gives it a MIN-width, not a
     width — see there for why the title can no longer be clipped. */
  .xp-head {
    position: absolute;
    height: 34px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    /* Load-bearing: the title's italic ink deliberately overhangs its box
       (TITLE_INK_BLEED below) and must not be cut off. */
    overflow: visible;
  }
  /* No overflow/min-width of its own: as a nowrap flex item the title's
     automatic minimum size is its own min-content width, so it never shrinks
     below its text and never needs to clip or ellipsize it. The padding /
     negative margin pair gives the italic's left overhang room to paint
     while leaving the text's origin on the column's left edge, so the
     header, the image and the editor still share one edge. */
  .xp-title {
    margin: 0 0 0 -${TITLE_INK_BLEED}px;
    padding: 0 0 0 ${TITLE_INK_BLEED}px;
    font-family: var(--sal-font-display);
    font-style: italic; font-weight: 400;
    font-size: 28px; line-height: 34px; letter-spacing: -0.01em;
    color: var(--sal-text);
    white-space: nowrap;
  }

  /* Editor — design spec v2 §C's text area, and nothing under it: v5 §R
     removed the extension bar, its fill and its inset border. */
  .xp-editor {
    position: absolute;
    pointer-events: auto;
  }
  .xp-note-input {
    position: relative; z-index: 1;
    display: block; width: 100%; height: 96px;
    margin: 0; padding: 12px 14px;
    resize: none; border: none; outline: none;
    /* Stated rather than left to the UA default: this is the one element the
       §T scroll lock lets a wheel through to, and overscroll-behavior
       belt-and-braces the "textarea at its last line must not scroll the
       page" case the lock already cancels. */
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: var(--sal-radius-lg);
    background: var(--sal-surface);
    color: var(--sal-text);
    font-family: var(--sal-font-body); font-size: 14px; line-height: 1.45;
    /* 1px border drawn inside; colour-only state changes (150ms std —
       MOTION_SPEC §11 reuses this exact transition for the danger state). */
    box-shadow: inset 0 0 0 1px var(--sal-line);
    transition: box-shadow 150ms ${STD.css};
  }
  .xp-note-input::placeholder { color: var(--sal-muted); }
  .xp-note-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  .xp-note-input:focus { box-shadow: inset 0 0 0 1px var(--sal-accent); }
  .xp-note-input.is-error,
  .xp-note-input.is-error:hover,
  .xp-note-input.is-error:focus { box-shadow: inset 0 0 0 1px var(--sal-danger); }

  /* Delete: an icon button at the header bar's right end, with §L's list
     delete treatment (surface at rest, danger on hover/press). The stage is
     pointer-events: none, so this opts back in like the editor and rail. */
  .xp-delete {
    flex-shrink: 0;
    width: 32px; height: 32px; margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--sal-line); border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-muted);
    cursor: pointer;
    pointer-events: auto;
    ${STATE_TRANSITION_CSS}
  }
  .xp-delete:hover { background: var(--sal-danger-soft); color: var(--sal-danger); }
  .xp-delete:active { background: var(--sal-danger-press); color: var(--sal-danger); ${PRESS_SCALE_CSS} }
  .xp-delete:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-delete svg { width: 16px; height: 16px; display: block; }
  /* The one thing under the textarea (design spec v5 §R): plain left-aligned
     text, no bar, no background, no border. Out of flow (top: 100%) so it
     reserves no space at all while idle and the block's height is the
     textarea's — nothing moves when a failure appears. Every message it can
     carry is now an error, so it is danger-coloured outright; the success
     hint is gone. */
  .xp-status {
    position: absolute; top: calc(100% + 8px); left: 0; right: 0;
    margin: 0;
    font-size: 12px; line-height: 16px;
    color: var(--sal-danger);
    text-align: left;
    opacity: 0;
    word-break: break-word;
  }

  /* Rail — 40×40 secondary icon buttons (§2's secondary row). */
  .xp-rail {
    position: absolute;
    display: flex; flex-direction: column; gap: 8px;
    pointer-events: auto;
  }
  .xp-rail-btn {
    width: ${RAIL_BTN}px; height: ${RAIL_BTN}px;
    margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: var(--sal-text);
    cursor: pointer;
    transition: background-color 140ms ease-out, border-color 140ms ease-out, transform 80ms ease-out;
  }
  .xp-rail-btn.xp-exit { margin-bottom: 8px; }
  .xp-rail-btn:not([aria-disabled="true"]):hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .xp-rail-btn:not([aria-disabled="true"]):active {
    background: var(--sal-press); border-color: var(--sal-line-strong); ${PRESS_SCALE_CSS}
  }
  .xp-rail-btn:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-rail-btn[aria-disabled="true"] { ${DISABLED_CSS} }
  .xp-rail-btn svg { width: 16px; height: 16px; display: block; }
  .xp-rail-btn.xp-exit svg { width: 18px; height: 18px; }

  /* Cards — see flip.ts for the transform-only morph these elements serve. */
  .xp-card {
    position: absolute;
    margin: 0; padding: 0;
    border: none; background: transparent;
    color: var(--sal-text);
    font: inherit; text-align: left;
    cursor: pointer; outline: none;
    pointer-events: none;
  }
  .xp-card.is-peek { pointer-events: auto; }
  .xp-card-lift {
    position: absolute; inset: 0;
    transform-origin: 50% 50%;
    /* Peek hover (MOTION_SPEC §9): leave 180ms std... */
    transition: transform 180ms ${STD.css};
  }
  /* ...enter 90ms std; pointer only — focus shows the ring, never the lift. */
  .xp-card.is-prev:hover .xp-card-lift { transform: translateY(7px); transition-duration: 90ms; }
  .xp-card.is-next:hover .xp-card-lift { transform: translateY(-7px); transition-duration: 90ms; }
  /* No fill of its own (design spec v5 §R): every slot has the aspect of the
     image it holds, so a fill could only ever show as a sub-pixel band along
     an edge — and a peek is "the image edge alone", with no frame behind it. */
  .xp-card-frame {
    position: absolute; left: 0; top: 0; width: 100%; height: 100%;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    transform-origin: 0 0;
  }
  .xp-card:focus-visible .xp-card-frame { ${FOCUS_RING_CSS} }
  .xp-card-img {
    position: absolute;
    display: block;
    max-width: none;
    object-fit: contain;
    transform-origin: 0 0;
  }
  .xp-card-badge {
    position: absolute; top: 8px; left: 8px;
    min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: var(--sal-radius-sm);
    background: var(--sal-accent); color: var(--sal-on-accent);
    font: 600 11px/20px var(--sal-font-mono);
    text-align: center;
    transform-origin: 0 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .xp-card-lift { transform: none !important; transition: none !important; }
    .xp-note-input { transition: none; }
  }
`;

// ---------------------------------------------------------------------------
// Icons (1.8px stroke, round caps/joins — design spec §1)
// ---------------------------------------------------------------------------

const STROKE =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
/** "collapse the panel to the right" (design spec v5 §U): a rounded panel
 *  outline, a divider three-quarters across, and a chevron pointing right in
 *  the larger left area. It replaces the × — the aria-label and title still
 *  say "exit enlarged view", which is what carries the meaning to AT. */
const ICON_COLLAPSE =
  `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}>` +
  '<rect x="3" y="4" width="18" height="16" rx="2.5"/>' +
  '<path d="M15.5 4v16M8 9.5l3 2.5-3 2.5"/></svg>';
const ICON_UP = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M6 15l6-6 6 6"/></svg>`;
const ICON_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M6 9l6 6 6-6"/></svg>`;

const TITLE_ID = 'xp-title';
const STATUS_ID = 'xp-status';

// ---------------------------------------------------------------------------
// Page scroll lock (design spec v5 §T)
// ---------------------------------------------------------------------------

/** The direction each scrolling key travels, as a (dx, dy) sign pair. Space
 *  is in the list twice over — it pages down, and shift+space pages up. */
const SCROLL_KEYS: Record<string, { dx: number; dy: number }> = {
  ' ': { dx: 0, dy: 1 },
  Spacebar: { dx: 0, dy: 1 }, // legacy key name, still emitted by some IMEs/remotes
  PageUp: { dx: 0, dy: -1 },
  PageDown: { dx: 0, dy: 1 },
  Home: { dx: 0, dy: -1 },
  End: { dx: 0, dy: 1 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

export interface ScrollLockHandle {
  release: () => void;
}

function computedStyleOf(el: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle(el);
  } catch {
    return null;
  }
}

function scrollableOverflow(value: string | undefined): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay';
}

/**
 * Can `el` itself take this scroll — is it an overflow container AND does it
 * still have room to move in the direction of travel?
 *
 * The "room left" half is what makes overscroll chaining stop at our own
 * edge: a textarea scrolled to its last line has no room, so the wheel is
 * cancelled rather than handed on to the page underneath.
 *
 * `dx`/`dy` are signs (or a wheel's raw deltas); 0/0 means "either axis,
 * either direction", which is all a touchmove can tell us.
 */
export function elementCanScroll(el: Element, dx: number, dy: number): boolean {
  const anyDir = dx === 0 && dy === 0;
  // The cheap rejection first — most elements in the path have no overflow
  // at all, and this runs on every wheel event.
  const roomY = el.scrollHeight - el.clientHeight;
  const roomX = el.scrollWidth - el.clientWidth;
  if (roomY <= 1 && roomX <= 1) return false;
  const style = computedStyleOf(el);
  // A <textarea> scrolls by UA default (and jsdom reports no computed
  // overflow at all), so it counts whatever the cascade says.
  const isTextarea = el instanceof HTMLTextAreaElement;

  if (roomY > 1 && (dy !== 0 || anyDir) && (isTextarea || scrollableOverflow(style?.overflowY))) {
    if (anyDir) return true;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop < roomY - 1) return true;
  }
  if (roomX > 1 && (dx !== 0 || anyDir) && (isTextarea || scrollableOverflow(style?.overflowX))) {
    if (anyDir) return true;
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft < roomX - 1) return true;
  }
  return false;
}

/** Text entry of any kind — typing a space, or moving the caret with the
 *  arrow/home/end keys, must never be cancelled. These consume the key
 *  themselves, so letting them through can't scroll anything either. */
function isTextEntry(target: EventTarget | undefined): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Stops the host page scrolling under the enlarged view, at the EVENT level
 * (design spec v5 §T): capture-phase `wheel` / `touchmove` with
 * `{ passive: false }` plus the scrolling keys, cancelled unless something
 * in OUR OWN UI can actually consume the scroll.
 *
 * Deliberately NOT `overflow: hidden` on the host's documentElement/body.
 * On a page with a classic scrollbar that hands the scrollbar's width back
 * to the content, which changes the layout viewport — and this extension
 * reads that viewport twice over: content.ts shrinks the page by the docked
 * sidebar's width, and the FLIP morphs measure list-thumbnail rects in
 * viewport coordinates at the exact moment the view opens and closes. A
 * width change there is a visible jump in the middle of the morph. Nothing
 * here touches layout at all.
 *
 * The exemption is "this event can really be consumed", NOT "this event is
 * somewhere inside our host". The two are not the same thing and the
 * difference is the whole feature: while the view is open the host covers
 * the ENTIRE viewport, because the scrim belongs to it — `elementFromPoint`
 * anywhere on screen returns the host. A path-contains-host test therefore
 * exempts every wheel and every key on the page and the lock blocks nothing
 * at all, while still cancelling a synthetic event dispatched on
 * `document.body` (whose path genuinely excludes the host) and so still
 * looking like it works.
 *
 * So: walk the composed path as far as the host and let the event through
 * only if an element BEFORE the host can take it — an overflow container
 * with room left in the direction of travel. In practice that is the note
 * textarea and nothing else. Stopping at the host also keeps a page that
 * sets `html { overflow: auto }` from qualifying as the scroller.
 */
export function lockPageScroll(hostEl: Element): ScrollLockHandle {
  /** The part of the composed path that belongs to our UI, or null when the
   *  event never touched it. */
  function ownPath(e: Event): EventTarget[] | null {
    const path = e.composedPath();
    const host = path.indexOf(hostEl);
    return host > 0 ? path.slice(0, host) : null;
  }

  function consumable(e: Event, dx: number, dy: number): boolean {
    const path = ownPath(e);
    if (!path) return false;
    for (const t of path) {
      if (t instanceof Element && elementCanScroll(t, dx, dy)) return true;
    }
    return false;
  }

  function cancel(e: Event): void {
    if (e.cancelable) e.preventDefault();
  }

  const onWheel = (e: Event): void => {
    const w = e as WheelEvent;
    if (!consumable(e, w.deltaX ?? 0, w.deltaY ?? 0)) cancel(e);
  };
  // A touchmove carries no delta, so "can this scroll at all, either way" is
  // as much as can be asked of it.
  const onTouchMove = (e: Event): void => {
    if (!consumable(e, 0, 0)) cancel(e);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    const dir = SCROLL_KEYS[e.key];
    if (!dir) return;
    if (isTextEntry(e.composedPath()[0])) return;
    const dy = e.key === ' ' || e.key === 'Spacebar' ? (e.shiftKey ? -1 : 1) : dir.dy;
    if (!consumable(e, dir.dx, dy)) cancel(e);
  };

  // Capture phase, so a page that stops these events on its own document
  // never gets the chance to (the same guarantee keyboardIsolation.ts
  // relies on). `passive: false` is required: Chrome makes window-level
  // wheel/touchmove listeners passive by default, and a passive listener's
  // preventDefault() is ignored.
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  window.addEventListener('wheel', onWheel, opts);
  window.addEventListener('touchmove', onTouchMove, opts);
  window.addEventListener('keydown', onKeydown, opts);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('touchmove', onTouchMove, opts);
      window.removeEventListener('keydown', onKeydown, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Role = 'main' | 'prev' | 'next';
/** Every message the status slot can carry is a failure now — design spec
 *  v5 §R dropped the "✓ saved" confirmation entirely. */
type StatusKind = 'none' | 'save-error' | 'delete-error' | 'empty-error';

interface Card {
  item: FeedbackItem;
  el: HTMLButtonElement;
  lift: HTMLElement;
  frame: HTMLElement;
  img: HTMLImageElement;
  badge: HTMLElement;
  role: Role | 'gone';
  /** Layout ("Last") slot the element boxes currently sit at. */
  slot: Slot;
  morph: { tween: Tween<Slot>; anims: Animation[] } | null;
  aspect: number;
  removeTimer: ReturnType<typeof setTimeout> | null;
  shrink: Animation | null;
}

type Timer = ReturnType<typeof setTimeout>;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionQuery(): MediaQueryList | null {
  try {
    if (typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    return null;
  }
}

function viewportSize(): { w: number; h: number } {
  const de = document.documentElement;
  return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight };
}

function aspectOf(item: FeedbackItem): number {
  const r = item.selectionRect;
  return r && r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 9;
}

/**
 * Open the enlarged view on `items[index]`. `items` is the list the sidebar
 * is currently showing (copied — this view keeps its own edits/deletes and
 * hands the result back to the list on collapse).
 */
export function openEnlargedView(
  mount: EnlargedViewMount,
  items: FeedbackItem[],
  index: number,
  callbacks: EnlargedViewCallbacks,
): EnlargedViewHandle {
  const view = new EnlargedView(mount, items, index, callbacks);
  view.open();
  return {
    getState: () => view.state,
    requestCollapse: (opts) => view.requestCollapse(opts),
    forceClose: () => view.forceClose(),
    flush: () => view.flushSave(),
    destroy: () => view.finish(false),
    setLogoSrc: (src) => view.setLogoSrc(src),
    relayout: () => view.relayout(),
  };
}

class EnlargedView {
  state: EnlargedState = 'opening';

  private items: FeedbackItem[];
  private idx: number;
  private geo: EnlargedGeometry;
  private reduced: boolean;
  private mql: MediaQueryList | null;

  // DOM
  private wrapper!: HTMLDivElement;
  private scrim!: HTMLDivElement;
  private bg!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private front!: HTMLDivElement;
  private brand!: HTMLDivElement;
  private brandLogo!: HTMLImageElement;
  private brandWord!: HTMLSpanElement;
  private head!: HTMLDivElement;
  private titleEl!: HTMLHeadingElement;
  private editor!: HTMLDivElement;
  private textarea!: HTMLTextAreaElement;
  private deleteBtn!: HTMLButtonElement;
  private statusEl!: HTMLParagraphElement;
  private rail!: HTMLDivElement;
  private btnExit!: HTMLButtonElement;
  private btnUp!: HTMLButtonElement;
  private btnDown!: HTMLButtonElement;

  private cards = new Map<number, Card>();
  private hiddenThumbs: HTMLElement[] = [];

  // Notes
  /** id of the note whose content (title/editor) is on screen. */
  private shownId: number | null = null;
  private drafts = new Map<number, string>();
  private saved = new Map<number, string>();
  private saveSeq = new Map<number, number>();
  /** Value of each note's latest save still awaiting a reply — counts as
   *  not dirty, so blur-then-navigate doesn't send the same UPDATE twice. */
  private inflight = new Map<number, string>();
  /** Notes whose latest save failed. They stay dirty and are retried by the
   *  next flushSave() (navigate / collapse / unload). */
  private failed = new Set<number>();
  private listDirty = false;
  private fullImages = new Map<number, string>();
  private fetching = new Set<number>();

  // Status slot
  private statusKind: StatusKind = 'none';

  // Timers
  private settleTimer: Timer | null = null;
  private swapTimer: Timer | null = null;
  private saveTimer: Timer | null = null;
  private suspendTimer: Timer | null = null;
  private panelSnapTimer: Timer | null = null;
  /** The delete step's own timer — never shares settleTimer, which a delete
   *  during the expand would otherwise overwrite (stranding 'opening'). */
  private deleteTimer: Timer | null = null;

  private deleting = false;
  private collapseAfterDelete = false;
  private shakeAnim: Animation | null = null;
  private isolation: KeyboardIsolationHandle | null = null;
  /** §T's page scroll lock. Taken in open(), dropped in finish() — the one
   *  teardown path every exit already routes through, so no caller has to
   *  remember it and a leaked lock is structurally impossible. */
  private scrollLock: ScrollLockHandle | null = null;
  private resizeRaf: number | null = null;

  constructor(
    private mount: EnlargedViewMount,
    items: FeedbackItem[],
    index: number,
    private callbacks: EnlargedViewCallbacks,
  ) {
    this.items = items.map((it) => ({ ...it }));
    this.idx = Math.max(0, Math.min(index, this.items.length - 1));
    for (const it of this.items) {
      this.drafts.set(it.id, it.note);
      this.saved.set(it.id, it.note);
    }
    this.geo = this.computeGeometry();
    this.mql = reducedMotionQuery();
    this.reduced = this.mql?.matches ?? false;
  }

  // ─── Open (MOTION_SPEC §5) ─────────────────────────────────────────────────

  open(): void {
    const cur = this.items[this.idx];
    if (!cur) {
      this.state = 'closed';
      return;
    }
    // t0: measure the source rects (list thumbnails, dock transform
    // included) exactly once, before anything is hidden or moves.
    const sources = this.reduced ? new Map<number, Slot>() : this.measureListSlots(this.idx, true);

    this.build();
    this.setContent(cur); // also applies the (image-sized) stage geometry
    this.updateRail();

    const sb = this.mount.sidebarEl;
    sb.classList.add('is-expanded', 'is-brand-riding');
    for (const id of sources.keys()) this.hideThumb(id);

    // The page is frozen for as long as the view is up (§T). Taken before
    // the keyboard isolation, which stops in-host key events reaching any
    // later capture listener — the lock passes those through anyway, but
    // this way its view of the keyboard matches the page's.
    this.scrollLock = lockPageScroll(this.mount.host);
    this.isolation = installKeyboardIsolation(this.mount.host, this.onKeydown);
    window.addEventListener('resize', this.onResize);
    this.mql?.addEventListener?.('change', this.onReducedChange);

    const W = this.geo.panelW;
    const from = this.mount.getSidebarWidth();

    // Initial (invisible) state for everything enlarged-only.
    for (const el of [this.head, this.editor, this.rail]) el.style.opacity = '0';
    this.scrim.style.opacity = '0';
    this.syncBrandParts(true);

    if (this.reduced) {
      // §12: geometry jumps, only opacity moves.
      this.setPanelWidth(W, 0);
      fadeTo(this.scrim, 1, { duration: T.rdScrimIn, curve: STD });
      fadeTo(sb, 0, { duration: T.rdListOut, curve: ACC });
      for (const el of [this.head, this.editor, this.rail]) fadeTo(el, 1, { duration: T.rdStageIn, curve: STD });
      this.layoutCards('expand', sources);
      this.settleTimer = setTimeout(() => this.settleOpen(), T.rdExpandSettle);
      return;
    }

    this.setPanelWidth(W, T.expand, from);
    // Backdrop first (Modal-with-Content), list-only chrome dissolves out
    // (entrance-exit: Dissolve Exit, ease-in), then enlarged-only content in
    // reading order with a 50ms Corporate stagger (multi-element: List Items).
    fadeTo(this.scrim, 1, { duration: T.scrimIn, curve: STD });
    fadeTo(sb, 0, { duration: T.listOut, curve: ACC });
    fadeTo(this.head, 1, { duration: T.fade, delay: T.titleDelay, curve: STD });
    fadeTo(this.editor, 1, { duration: T.fade, delay: T.editorDelay, curve: STD });
    fadeTo(this.rail, 1, { duration: T.fade, delay: T.railDelay, curve: STD });
    this.layoutCards('expand', sources);

    // Suspend the dock once the list is invisible — suspending snaps swollen
    // items to rest, which must not be seen mid-fade.
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      this.mount.setDockSuspended(true);
    }, T.listOut);
    this.settleTimer = setTimeout(() => this.settleOpen(), T.expandSettle);
  }

  private settleOpen(): void {
    this.settleTimer = null;
    if (this.state !== 'opening') return;
    this.state = 'open';
    this.wrapper.dataset.state = 'open';
    this.mount.setDockSuspended(true);
    // The list is out of the tab order / AT tree for as long as the view is
    // up. Set only now, together with the focus move: inerting the subtree
    // that holds focus (the clicked list item) would drop focus to <body>,
    // and Esc during the expand has to keep reaching this host.
    this.mount.sidebarEl.setAttribute('inert', '');
    const active = this.mount.shadow.activeElement;
    if (!active || !this.wrapper.contains(active)) this.btnExit.focus({ preventScroll: true });
  }

  // ─── DOM ──────────────────────────────────────────────────────────────────

  private build(): void {
    const w = document.createElement('div');
    w.className = 'enlarged';
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-modal', 'true');
    w.setAttribute('aria-labelledby', TITLE_ID);
    w.dataset.state = 'opening';
    this.wrapper = w;

    this.scrim = div('xp-scrim');
    this.scrim.setAttribute('aria-hidden', 'true');
    this.scrim.addEventListener('click', () => void this.requestCollapse());
    this.bg = div('xp-bg');
    this.bg.setAttribute('aria-hidden', 'true');
    this.stage = div('xp-stage');
    this.front = div('xp-front');

    // Logo + wordmark, riding the panel's left edge.
    this.brand = div('xp-brand');
    this.brand.setAttribute('aria-hidden', 'true');
    this.brandLogo = document.createElement('img');
    this.brandLogo.alt = '';
    this.brandLogo.draggable = false;
    this.brandLogo.src = this.mount.getLogoSrc();
    this.brandWord = document.createElement('span');
    this.brandWord.className = 'xp-brand-word';
    this.brandWord.textContent = 'salamander';
    this.brand.append(this.brandLogo, this.brandWord);

    // Header bar: title + delete (design spec v4 §M).
    this.head = div('xp-head');
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'xp-title';
    this.titleEl.id = TITLE_ID;
    this.deleteBtn = document.createElement('button');
    this.deleteBtn.type = 'button';
    this.deleteBtn.className = 'xp-delete';
    this.deleteBtn.innerHTML = ICON_TRASH; // the list's glyph, the only one (§S)
    this.deleteBtn.setAttribute('aria-label', 'delete note');
    this.deleteBtn.title = 'delete note';
    this.deleteBtn.addEventListener('click', () => this.deleteCurrent());
    this.head.append(this.titleEl, this.deleteBtn);

    // Editor.
    this.editor = div('xp-editor');
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'xp-note-input';
    this.textarea.setAttribute('aria-label', 'note');
    this.textarea.placeholder = 'what should change here?';
    this.textarea.addEventListener('input', this.onInput);
    this.textarea.addEventListener('blur', this.onBlur);
    // The failure/empty-note line, directly under the textarea and out of
    // flow (§R). It keeps the live-region semantics it had in the old bar.
    this.statusEl = document.createElement('p');
    this.statusEl.className = 'xp-status';
    this.statusEl.id = STATUS_ID;
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.editor.append(this.textarea, this.statusEl);

    // Rail.
    this.rail = div('xp-rail');
    this.btnExit = railButton(ICON_COLLAPSE, 'exit enlarged view', 'exit enlarged view (esc)', 'xp-exit');
    this.btnUp = railButton(ICON_UP, 'previous note', 'previous note (↑)', 'xp-prev');
    this.btnDown = railButton(ICON_DOWN, 'next note', 'next note (↓)', 'xp-next');
    this.btnExit.addEventListener('click', () => void this.requestCollapse());
    this.btnUp.addEventListener('click', () => this.go(-1));
    this.btnDown.addEventListener('click', () => this.go(1));
    this.rail.append(this.btnExit, this.btnUp, this.btnDown);

    this.stage.append(this.brand, this.head, this.editor, this.rail);
    w.append(this.scrim, this.bg, this.stage, this.front);
    this.mount.shadow.appendChild(w);
  }

  /** §M's "original size": the selection's own CSS pixels (the stored PNG is
   *  at `item.dpr`, so its pixel size is NOT its display size). If the card's
   *  loaded image turned out to disagree with the stored rect, the rect's
   *  width still wins and the image's aspect supplies the height. */
  private naturalFor(item: FeedbackItem | undefined): NaturalSize | null {
    if (!item) return null;
    const r = item.selectionRect;
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    const card = this.cards.get(item.id);
    const aspect = card && card.aspect > 0 ? card.aspect : r.width / r.height;
    return { w: r.width, h: Math.max(1, r.width / aspect) };
  }

  private computeGeometry(): EnlargedGeometry {
    const vp = viewportSize();
    return computeEnlargedGeometry(vp.w, vp.h, this.mount.getSidebarWidth(), this.naturalFor(this.items[this.idx]), {
      // Each peek is sized from its OWN note (§R), so the neighbours' natural
      // sizes are part of the layout, not just the focused note's.
      prev: this.naturalFor(this.items[this.idx - 1]),
      next: this.naturalFor(this.items[this.idx + 1]),
    });
  }

  /** Every slot is sized from the note that sits in it, so an index change
   *  reshapes all three. Call before layoutCards() on any navigation. */
  private recomputeGeometry(): void {
    this.geo = this.computeGeometry();
  }

  private applyStageGeometry(): void {
    const g = this.geo;
    // The header bar gets a MIN-width, not a width (design spec v4 §M): with
    // `right` fixed and `width: auto` it shrink-to-fits, so it matches the
    // image's rendered width in the normal case and, in the pathological one
    // where the title plus the delete button are wider than that, grows
    // LEFTWARD instead of squeezing the title. That — a fixed-width flex line
    // whose `min-width: 0; overflow: hidden; text-overflow: ellipsis` title
    // was free to shrink below its own text, with the old "n / total" count
    // reserving another 40px of it — was what clipped "feedback #12".
    // Everything is positioned from the viewport's right edge, so the
    // animated panel width never moves anything inside it (see the banner).
    this.head.style.right = `${g.columnRight}px`;
    this.head.style.top = `${g.titleTop}px`;
    this.head.style.width = 'auto';
    this.head.style.minWidth = `${g.columnW}px`;
    setBox(this.editor, { right: g.columnRight, top: g.editorTop, width: g.columnW });
    setBox(this.rail, { right: g.railRight, top: g.railTop });
  }

  /** The wordmark, which the *list* header doesn't show at a narrow sidebar
   *  width (§3.1), fades in/out as the view opens/closes; the logo rides the
   *  edge unchanged — the list always shows it now that §V retired the
   *  compact layout that used to shed it. */
  private syncBrandParts(opening: boolean): void {
    const layout = this.mount.getListLayout();
    const parts: Array<[HTMLElement, boolean]> = [[this.brandWord, layout.narrow]];
    for (const [el, hiddenInList] of parts) {
      if (!hiddenInList) continue;
      if (opening) {
        el.style.opacity = '0';
        fadeTo(el, 1, { duration: this.reduced ? T.rdStageIn : T.fade, delay: this.reduced ? 0 : T.badgeDelayIn, curve: STD });
      } else {
        fadeTo(el, 0, { duration: this.reduced ? T.rdStageOut : T.stageOut, curve: ACC });
      }
    }
  }

  setLogoSrc(src: string): void {
    if (this.brandLogo) this.brandLogo.src = src;
  }

  // ─── Panel width ──────────────────────────────────────────────────────────

  private setPanelWidth(to: number, duration: number, from?: number): void {
    const start = from ?? trackedValue(this.bg, 'width', to);
    const pairs: Array<[HTMLElement, number]> = [
      [this.bg, 0],
      [this.stage, 0],
      [this.front, FRONT_BLEED_PX],
    ];
    for (const [el, extra] of pairs) {
      animateNumber(el, 'width', to + extra, { duration, from: start + extra, curve: STD });
    }
  }

  // ─── Cards ────────────────────────────────────────────────────────────────

  /** List-slot rects for items idx-1..idx+1 (only those actually visible in
   *  the list's scrollport — MOTION_SPEC §3 edge case; the current item is
   *  always taken). */
  private measureListSlots(center: number, includeCurrentAlways: boolean): Map<number, Slot> {
    const out = new Map<number, Slot>();
    const vp = this.mount.getListViewport();
    for (const j of [center - 1, center, center + 1]) {
      const it = this.items[j];
      if (!it) continue;
      const el = this.mount.getListThumb(it.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const inView = !vp || (r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5);
      if (!inView && !(includeCurrentAlways && j === center)) continue;
      out.set(it.id, { x: r.left, y: r.top, w: r.width, h: r.height, pad: 0, imgR: 0 });
    }
    return out;
  }

  private hideThumb(id: number): void {
    const el = this.mount.getListThumb(id);
    if (!el) return;
    el.style.visibility = 'hidden';
    this.hiddenThumbs.push(el);
  }

  private restoreThumbs(): void {
    for (const el of this.hiddenThumbs) el.style.visibility = '';
    this.hiddenThumbs = [];
  }

  private targets(): Map<number, Role> {
    const m = new Map<number, Role>();
    const cur = this.items[this.idx];
    if (!cur) return m;
    m.set(cur.id, 'main');
    const p = this.items[this.idx - 1];
    const n = this.items[this.idx + 1];
    if (p) m.set(p.id, 'prev');
    if (n) m.set(n.id, 'next');
    return m;
  }

  private slotFor(role: Role): Slot {
    return role === 'main' ? this.geo.main : role === 'prev' ? this.geo.prev : this.geo.next;
  }

  /**
   * Bring every card to the role the current index gives it.
   *  - 'expand': cards with a measured list rect morph from it (450ms std);
   *    the rest fade into their slot (200ms std, 150ms delay).
   *  - 'carousel': existing cards retarget from their live rect (400ms std);
   *    a new far card fades into the vacated peek (200ms std, 200ms delay);
   *    a card leaving the set fades out in place (150ms acc).
   *  - 'instant': snap (reduced motion / resize).
   */
  private layoutCards(kind: 'expand' | 'carousel' | 'instant', sources?: Map<number, Slot>): void {
    const want = this.targets();
    const animate = kind !== 'instant' && !this.reduced;
    const morphDur = kind === 'expand' ? T.expand : T.carousel;

    for (const card of this.cards.values()) {
      if (!want.has(card.item.id) && card.role !== 'gone') this.retireCard(card, animate);
    }

    for (const [id, role] of want) {
      const item = this.items.find((i) => i.id === id)!;
      const slot = this.slotFor(role);
      let card = this.cards.get(id);
      const from = sources?.get(id);

      if (!card) {
        card = this.createCard(item, from ?? slot);
        if (from && animate) {
          card.el.style.opacity = '1';
          card.badge.style.opacity = '1';
          this.morphCard(card, from, slot, morphDur);
        } else {
          this.placeCard(card, slot);
          card.badge.style.opacity = '0';
          card.el.style.opacity = '0';
          if (kind === 'instant' || !animate) {
            // Reduced motion: the whole card crossfades in with the rest.
            fadeTo(card.el, 1, { duration: kind === 'instant' ? 0 : T.rdStageIn, curve: STD });
          } else {
            fadeTo(card.el, 1, {
              duration: T.fade,
              delay: kind === 'expand' ? T.badgeDelayIn : T.farPeekDelay,
              curve: STD,
            });
          }
        }
      } else {
        this.unretire(card);
        if (animate) this.morphCard(card, this.currentSlot(card), slot, morphDur);
        else this.placeCard(card, slot);
        if (currentOpacity(card.el) < 1) {
          fadeTo(card.el, 1, { duration: animate ? T.fade : 0, curve: STD });
        }
      }
      this.setRole(card, role);

      // Badges never rest on main/peek (§4). Peeks carry nothing else — §R
      // took their captions away: the image edge alone.
      if (animate) {
        fadeTo(card.badge, 0, kind === 'expand'
          ? { duration: T.fade, delay: T.badgeDelayIn, curve: STD }
          : { duration: 100, curve: ACC });
      } else {
        fadeTo(card.badge, 0, { duration: 0, curve: STD });
      }
      if (role === 'main') this.ensureFullImage(card);
    }
  }

  private createCard(item: FeedbackItem, slot: Slot): Card {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'xp-card';
    el.tabIndex = -1;
    el.dataset.itemId = String(item.id);
    const lift = document.createElement('span');
    lift.className = 'xp-card-lift';
    const frame = document.createElement('span');
    frame.className = 'xp-card-frame';
    const img = document.createElement('img');
    img.className = 'xp-card-img';
    img.alt = '';
    img.draggable = false;
    img.src = this.fullImages.get(item.id) ?? item.thumbnailDataUrl;
    const badge = document.createElement('span');
    badge.className = 'xp-card-badge';
    badge.textContent = String(item.id);
    badge.setAttribute('aria-hidden', 'true');
    frame.appendChild(img);
    lift.append(frame, badge);
    el.append(lift);

    const card: Card = {
      item,
      el,
      lift,
      frame,
      img,
      badge,
      role: 'gone',
      slot,
      morph: null,
      aspect: aspectOf(item),
      removeTimer: null,
      shrink: null,
    };
    el.addEventListener('click', () => {
      // Activating a peek: setRole() hands focus to the matching rail
      // button once this card has become the main one.
      if (card.role === 'prev') this.go(-1);
      else if (card.role === 'next') this.go(1);
    });
    img.addEventListener('load', () => {
      // selectionRect is the capture's aspect; trust the pixels if they
      // disagree (e.g. an imported item), but only re-place a resting card.
      if (!img.naturalWidth || !img.naturalHeight) return;
      const a = img.naturalWidth / img.naturalHeight;
      if (Math.abs(a - card.aspect) / card.aspect < 0.02) return;
      card.aspect = a;
      if (card.morph && tweenProgress(card.morph.tween, now()) < 1) return;
      // Every slot IS its own image (v4 §M, v5 §R), so a corrected aspect
      // reshapes the layout rather than just this card's contain-fit — a
      // peek's height decides its own place on the arc.
      if (card.role !== 'gone') this.relayout();
      else this.placeCard(card, card.slot);
    });
    this.placeCard(card, slot);
    this.cards.set(item.id, card);
    this.front.appendChild(el);
    return card;
  }

  /** Write the card's layout boxes for `slot` (the FLIP "Last"). */
  private placeCard(card: Card, slot: Slot): void {
    this.cancelMorph(card);
    card.slot = slot;
    const g = this.geo;
    const s = card.el.style;
    s.right = `${g.vwRight - (slot.x + slot.w)}px`;
    s.top = `${slot.y}px`;
    s.width = `${slot.w}px`;
    s.height = `${slot.h}px`;
    const ib = containFit(card.aspect, insetBox({ x: 0, y: 0, w: slot.w, h: slot.h }, slot.pad));
    const is = card.img.style;
    is.left = `${ib.x}px`;
    is.top = `${ib.y}px`;
    is.width = `${ib.w}px`;
    is.height = `${ib.h}px`;
    is.borderRadius = `${slot.imgR}px`;
  }

  private morphCard(card: Card, from: Slot, to: Slot, duration: number): void {
    this.placeCard(card, to);
    if (duration <= 0 || from.w < 1 || from.h < 1) return;
    const kf = morphKeyframes(from, to, card.aspect, STD.fn, Math.max(8, Math.round(duration / 16)), FRAME_RADIUS);
    const opts: KeyframeAnimationOptions = { duration, easing: 'linear' };
    const anims = [
      animateEl(card.frame, kf.frame, opts),
      animateEl(card.img, kf.img, opts),
      animateEl(card.badge, kf.badge, opts),
    ].filter((a): a is Animation => a !== null);
    card.morph = { tween: { from, to, start: now(), delay: 0, duration, ease: STD.fn }, anims };
  }

  private cancelMorph(card: Card): void {
    if (!card.morph) return;
    for (const a of card.morph.anims) a.cancel();
    card.morph = null;
  }

  /** Where the card is on screen right now (analytic — no DOM read). */
  private currentSlot(card: Card): Slot {
    const m = card.morph;
    if (!m) return card.slot;
    return lerpSlot(m.tween.from, m.tween.to, tweenProgress(m.tween, now()));
  }

  private setRole(card: Card, role: Role | 'gone'): void {
    const wasFocused = this.mount.shadow.activeElement === card.el;
    card.role = role;
    const peek = role === 'prev' || role === 'next';
    card.el.classList.toggle('is-main', role === 'main');
    card.el.classList.toggle('is-peek', peek);
    card.el.classList.toggle('is-prev', role === 'prev');
    card.el.classList.toggle('is-next', role === 'next');
    card.el.tabIndex = peek ? 0 : -1;
    if (peek) {
      const label = `${role === 'prev' ? 'previous' : 'next'} note: feedback #${card.item.id}`;
      card.el.setAttribute('aria-label', label);
      card.el.title = role === 'prev' ? 'previous note' : 'next note';
      card.el.removeAttribute('aria-hidden');
    } else {
      card.el.removeAttribute('aria-label');
      card.el.removeAttribute('title');
      card.el.setAttribute('aria-hidden', 'true');
    }
    if (wasFocused && !peek) {
      // A clicked/activated peek just became the main card — keep keyboard
      // focus on the matching rail control rather than losing it.
      const fallback = role === 'main' ? (this.lastNavDir < 0 ? this.btnUp : this.btnDown) : this.btnExit;
      fallback.focus({ preventScroll: true });
    }
  }

  private retireCard(card: Card, animate: boolean): void {
    this.setRole(card, 'gone');
    fadeTo(card.el, 0, { duration: animate ? T.peekOut : 0, curve: ACC });
    if (card.removeTimer) clearTimeout(card.removeTimer);
    card.removeTimer = setTimeout(() => this.removeCard(card), animate ? T.peekOut + 20 : 0);
  }

  private unretire(card: Card): void {
    if (card.removeTimer) {
      clearTimeout(card.removeTimer);
      card.removeTimer = null;
    }
  }

  private removeCard(card: Card): void {
    if (card.removeTimer) clearTimeout(card.removeTimer);
    card.removeTimer = null;
    this.cancelMorph(card);
    card.shrink?.cancel();
    cancelTracks(card.el);
    cancelTracks(card.badge);
    card.el.remove();
    if (this.cards.get(card.item.id) === card) this.cards.delete(card.item.id);
  }

  private ensureFullImage(card: Card): void {
    const id = card.item.id;
    const cached = this.fullImages.get(id);
    if (cached) {
      if (card.img.src !== cached) card.img.src = cached;
      return;
    }
    if (this.fetching.has(id)) return;
    this.fetching.add(id);
    const item = card.item;
    void this.callbacks
      .fetchFullImage(item)
      .catch(() => null)
      .then((url) => {
        this.fetching.delete(id);
        if (!url) return;
        this.fullImages.set(id, url);
        // Stale-fetch guard: cards are keyed by note id, so this can only
        // ever land on the card of the note it was fetched for — never on
        // whatever note is main by the time it resolves.
        if (this.state === 'closed') return;
        const c = this.cards.get(id);
        if (c && c.item === item) c.img.src = url;
      });
  }

  // ─── Content (title / editor) ────────────────────────────────────────────

  /** Swaps the header/editor over to `item`. Also (re)applies the stage
   *  geometry, since the column is sized by that note's image (v4 §M) — the
   *  callers all run this while the header/editor are faded out, so the
   *  resize is never seen. */
  private setContent(item: FeedbackItem): void {
    this.shownId = item.id;
    this.applyStageGeometry();
    this.titleEl.textContent = `feedback #${item.id}`;
    this.textarea.value = this.drafts.get(item.id) ?? item.note;
    this.textarea.classList.remove('is-error');
    this.setStatus('none', true);
    this.surfaceSaveFailure();
  }

  private updateRail(): void {
    this.btnUp.setAttribute('aria-disabled', String(this.idx <= 0));
    this.btnDown.setAttribute('aria-disabled', String(this.idx >= this.items.length - 1));
  }

  /** Title/editor crossfade (MOTION_SPEC §7, multi-element: Tab Switch):
   *  old content out 120ms acc, swap, new content in 180ms std. Rail and
   *  panel stay still. Re-entrant: a second call restarts the swap window. */
  private crossfadeContent(): void {
    if (this.swapTimer) clearTimeout(this.swapTimer);
    fadeTo(this.head, 0, { duration: T.contentOut, curve: ACC });
    fadeTo(this.editor, 0, { duration: T.contentOut, curve: ACC });
    this.swapTimer = setTimeout(() => {
      this.swapTimer = null;
      const cur = this.items[this.idx];
      if (!cur) return;
      this.setContent(cur);
      fadeTo(this.head, 1, { duration: T.contentIn, curve: STD });
      fadeTo(this.editor, 1, { duration: T.contentIn, curve: STD });
    }, T.contentOut);
  }

  // ─── Navigation (MOTION_SPEC §7) ─────────────────────────────────────────

  private lastNavDir = 1;

  go(dir: -1 | 1): void {
    if (this.state !== 'open' && this.state !== 'opening') return;
    if (this.deleting) return;
    const to = this.idx + dir;
    if (to < 0 || to >= this.items.length) return;
    if (this.blockIfEmpty()) return;
    this.flushSave();
    this.lastNavDir = dir;
    this.idx = to;
    this.recomputeGeometry();
    this.updateRail();
    if (this.reduced) {
      this.reducedSwap();
    } else {
      this.layoutCards('carousel');
      this.crossfadeContent();
    }
  }

  /** Reduced-motion carousel/delete step (§12): fade out → instant swap →
   *  fade in, no card ever travels. */
  private reducedSwap(): void {
    if (this.swapTimer) clearTimeout(this.swapTimer);
    for (const el of [this.front, this.head, this.editor]) fadeTo(el, 0, { duration: T.rdSwapOut, curve: ACC });
    this.swapTimer = setTimeout(() => {
      this.swapTimer = null;
      const cur = this.items[this.idx];
      if (!cur) return;
      this.layoutCards('instant');
      this.setContent(cur);
      for (const el of [this.front, this.head, this.editor]) fadeTo(el, 1, { duration: T.rdSwapIn, curve: STD });
    }, T.rdSwapAt);
  }

  // ─── Delete (MOTION_SPEC §8) ──────────────────────────────────────────────

  private deleteCurrent(): void {
    if (this.state !== 'open' && this.state !== 'opening') return;
    if (this.deleting) return;
    const item = this.items[this.idx];
    if (!item) return;
    const card = this.cards.get(item.id);
    this.deleting = true;
    if (this.saveTimer && this.shownId === item.id) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.textarea.classList.remove('is-error');
    this.setStatus('none', true);

    const out = this.reduced ? T.rdSwapOut : T.deleteStep;
    if (card) {
      fadeTo(card.el, 0, { duration: out, curve: ACC });
      if (!this.reduced) {
        card.shrink?.cancel();
        card.shrink = animateEl(card.lift, [{ transform: 'scale(1)' }, { transform: 'scale(0.95)' }], {
          duration: T.deleteStep,
          easing: ACC.css,
          fill: 'forwards',
        });
      }
    }
    fadeTo(this.head, 0, { duration: this.reduced ? T.rdSwapOut : T.contentOut, curve: ACC });
    fadeTo(this.editor, 0, { duration: this.reduced ? T.rdSwapOut : T.contentOut, curve: ACC });

    const request = this.callbacks.onDelete(item).catch(() => false);
    const step = new Promise<void>((resolve) => {
      this.deleteTimer = setTimeout(() => {
        this.deleteTimer = null;
        resolve();
      }, out);
    });
    void Promise.all([request, step]).then(([ok]) => {
      if (this.state === 'closed') return;
      this.deleting = false;
      if (!ok) {
        if (card) {
          card.shrink?.cancel();
          card.shrink = null;
          fadeTo(card.el, 1, { duration: T.fade, curve: STD });
        }
        fadeTo(this.head, 1, { duration: T.contentIn, curve: STD });
        fadeTo(this.editor, 1, { duration: T.contentIn, curve: STD });
        this.setStatus('delete-error');
        if (this.collapseAfterDelete) {
          this.collapseAfterDelete = false;
          this.requestCollapse();
        }
        return;
      }
      this.applyDeletion(item, card);
    });
  }

  private applyDeletion(item: FeedbackItem, card: Card | undefined): void {
    const oldIdx = this.idx;
    this.items = this.items.filter((i) => i.id !== item.id);
    this.drafts.delete(item.id);
    this.saved.delete(item.id);
    this.inflight.delete(item.id);
    this.failed.delete(item.id);
    this.listDirty = true;
    if (card) this.removeCard(card);

    if (this.items.length === 0) {
      // The only note: skip the carousel, collapse straight to the (now
      // empty) list — §8.
      this.shownId = null;
      this.collapseAfterDelete = false;
      this.beginCollapse();
      return;
    }
    this.idx = Math.min(oldIdx, this.items.length - 1);
    this.lastNavDir = this.idx < oldIdx ? -1 : 1;
    this.recomputeGeometry();
    this.updateRail();
    const cur = this.items[this.idx];
    if (this.reduced) {
      this.layoutCards('instant');
      this.setContent(cur);
      for (const el of [this.head, this.editor]) fadeTo(el, 1, { duration: T.rdSwapIn, curve: STD });
    } else {
      this.layoutCards('carousel');
      // Title/editor were already faded out by the delete step: fade-in only.
      this.setContent(cur);
      fadeTo(this.head, 1, { duration: T.contentIn, curve: STD });
      fadeTo(this.editor, 1, { duration: T.contentIn, curve: STD });
    }
    if (this.mount.shadow.activeElement === null || !this.wrapper.contains(this.mount.shadow.activeElement)) {
      this.deleteBtn.focus({ preventScroll: true });
    }
    if (this.collapseAfterDelete) {
      this.collapseAfterDelete = false;
      this.requestCollapse();
    }
  }

  // ─── Collapse (MOTION_SPEC §6) ────────────────────────────────────────────

  requestCollapse(opts: { immediate?: boolean } = {}): boolean {
    if (this.state === 'closed' || this.state === 'closing') return true;
    // The note being deleted is on its way out — its (possibly empty) text
    // can't block leaving, so this is checked before the empty lock.
    if (this.deleting && !opts.immediate) {
      this.collapseAfterDelete = true;
      return true;
    }
    if (!this.deleting && this.blockIfEmpty()) return false;
    this.flushSave();
    if (opts.immediate) {
      this.finish(true);
      return true;
    }
    this.beginCollapse();
    return true;
  }

  forceClose(): void {
    if (this.state === 'closed') return;
    this.flushSave();
    this.finish(true);
  }

  private beginCollapse(): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.clearChoreoTimers();
    this.state = 'closing';
    this.wrapper.dataset.state = 'closing';
    const sb = this.mount.sidebarEl;
    sb.removeAttribute('inert');

    // t0: bring the (still invisible) list up to date, centre the current
    // note in it, then measure the landing rects once.
    this.restoreThumbs();
    if (this.listDirty) {
      this.mount.renderList(this.itemsForList());
      this.listDirty = false;
    }
    const cur = this.items[this.idx];
    if (cur) this.mount.centreListOn(cur.id);
    const targets = cur && !this.reduced ? this.measureListSlots(this.idx, true) : new Map<number, Slot>();

    const rd = this.reduced;
    fadeTo(this.head, 0, { duration: rd ? T.rdStageOut : T.stageOut, curve: ACC });
    fadeTo(this.editor, 0, { duration: rd ? T.rdStageOut : T.stageOut, curve: ACC });
    fadeTo(this.rail, 0, { duration: rd ? T.rdStageOut : T.stageOut, curve: ACC });
    this.syncBrandParts(false);

    if (rd) {
      fadeTo(this.front, 0, { duration: T.rdStageOut, curve: ACC });
      fadeTo(this.scrim, 0, { duration: T.rdStageOut, curve: ACC });
      fadeTo(sb, 1, { duration: T.rdListIn, delay: T.rdListInDelay, curve: STD });
      sb.classList.remove('is-brand-riding');
      this.panelSnapTimer = setTimeout(() => {
        this.panelSnapTimer = null;
        this.setPanelWidth(this.mount.getSidebarWidth(), 0);
      }, T.rdStageOut);
      this.settleTimer = setTimeout(() => this.finish(true), T.rdCollapseSettle);
      return;
    }

    this.setPanelWidth(this.mount.getSidebarWidth(), T.collapse);
    fadeTo(this.scrim, 0, { duration: T.scrimOut, delay: T.scrimOutDelay, curve: ACC });
    fadeTo(sb, 1, { duration: T.listIn, delay: T.listInDelay, curve: STD });

    for (const card of [...this.cards.values()]) {
      const to = targets.get(card.item.id);
      if (card.role !== 'gone' && to) {
        this.hideThumb(card.item.id);
        this.unretire(card);
        this.setRole(card, 'gone');
        this.morphCard(card, this.currentSlot(card), to, T.collapse);
        if (currentOpacity(card.el) < 1) fadeTo(card.el, 1, { duration: T.stageOut, curve: STD });
        fadeTo(card.badge, 1, { duration: T.scrimOut, curve: STD });
      } else {
        this.setRole(card, 'gone');
        fadeTo(card.el, 0, { duration: T.stageOut, curve: ACC });
      }
    }
    this.settleTimer = setTimeout(() => this.finish(true), T.collapseSettle);
  }

  /** Items as the list should show them: saved text, or a non-empty draft
   *  that flushSave() is already persisting — never a draft whose save
   *  failed (the list would silently show text that isn't stored). */
  private itemsForList(): FeedbackItem[] {
    return this.items.map((it) => {
      const d = this.drafts.get(it.id);
      if (this.unresolvedFailure(it.id)) return it;
      return d !== undefined && d.trim() !== '' ? { ...it, note: d } : it;
    });
  }

  /** The single teardown path — every timer, animation, listener and node
   *  this view created goes here, whether the collapse completed, was
   *  skipped (immediate) or the sidebar is being destroyed. */
  finish(notify: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearChoreoTimers();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.shakeAnim?.cancel();
    this.shakeAnim = null;
    if (this.resizeRaf !== null) cancelAnimationFrameSafe(this.resizeRaf);
    this.resizeRaf = null;

    for (const card of [...this.cards.values()]) this.removeCard(card);
    for (const el of [this.scrim, this.bg, this.stage, this.front, this.head, this.editor, this.rail, this.brandLogo, this.brandWord, this.statusEl]) {
      if (el) cancelTracks(el);
    }

    this.restoreThumbs();
    // After a collapse this is only still set if a save failed mid-collapse:
    // the list painted at its t0 then showed that draft as if stored.
    if (notify && this.listDirty) {
      this.mount.renderList(this.itemsForList());
    }
    this.listDirty = false;

    const sb = this.mount.sidebarEl;
    cancelTracks(sb);
    sb.style.opacity = '';
    sb.classList.remove('is-expanded', 'is-brand-riding');
    sb.removeAttribute('inert');

    this.wrapper?.remove();
    this.isolation?.release();
    this.isolation = null;
    // §T: the page gets its scroll back here and nowhere else, whether this
    // was a collapse, an Esc, add mode, an SPA navigation or a destroy().
    this.scrollLock?.release();
    this.scrollLock = null;
    window.removeEventListener('resize', this.onResize);
    this.mql?.removeEventListener?.('change', this.onReducedChange);
    this.mount.setDockSuspended(false);

    if (!notify) return;
    const cur = this.items[this.idx];
    const id = cur ? cur.id : null;
    if (id === null || !this.mount.focusListItem(id)) this.mount.focusFallback();
    // A save that failed and isn't being retried: the list (and its banner)
    // is visible again, so report it there. Retries still in flight report
    // themselves when they settle (save()).
    const lost = [...this.failed].find((f) => this.unresolvedFailure(f));
    if (lost !== undefined) this.mount.showBanner(saveErrorFor(lost));
    this.callbacks.onClosed(id);
  }

  private clearChoreoTimers(): void {
    for (const t of [this.settleTimer, this.swapTimer, this.suspendTimer, this.panelSnapTimer, this.deleteTimer]) {
      if (t) clearTimeout(t);
    }
    this.settleTimer = null;
    this.deleteTimer = null;
    this.swapTimer = null;
    this.suspendTimer = null;
    this.panelSnapTimer = null;
  }

  // ─── Autosave (MOTION_SPEC §10) ───────────────────────────────────────────

  private onInput = (): void => {
    const id = this.shownId;
    if (id === null) return;
    const value = this.textarea.value;
    this.drafts.set(id, value);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (value.trim() === '') {
      // Never autosave an empty note — the last non-empty text stays stored.
      if (this.statusKind === 'save-error') this.setStatus('none');
      return;
    }
    if (this.statusKind === 'empty-error') this.clearEmptyError();
    else if (this.statusKind === 'save-error' || this.statusKind === 'delete-error') this.setStatus('none');
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save(id);
    }, T.autosave);
  };

  private onBlur = (): void => {
    if (this.state === 'closed') return;
    const id = this.shownId;
    if (id === null) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.isDirty(id)) this.save(id);
  };

  private isDirty(id: number): boolean {
    const d = this.drafts.get(id);
    return d !== undefined && d.trim() !== '' && d !== this.saved.get(id) && d !== this.inflight.get(id);
  }

  /** A failed save with no retry in flight. */
  private unresolvedFailure(id: number): boolean {
    return this.failed.has(id) && !this.inflight.has(id);
  }

  /** Immediate save of the shown note's pending change, plus a retry of
   *  every note whose last save failed (navigate / collapse / unload). */
  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const id = this.shownId;
    if (id !== null && this.isDirty(id)) this.save(id);
    for (const f of [...this.failed]) {
      if (f !== id && this.isDirty(f)) this.save(f);
    }
  }

  private save(id: number): void {
    const item = this.items.find((i) => i.id === id);
    const value = this.drafts.get(id);
    if (!item || value === undefined || value.trim() === '') return;
    const seq = (this.saveSeq.get(id) ?? 0) + 1;
    this.saveSeq.set(id, seq);
    this.inflight.set(id, value);
    this.listDirty = true;
    void this.callbacks
      .onSaveNote(item, value)
      .catch(() => false)
      .then((ok) => {
        if (this.saveSeq.get(id) !== seq) return; // superseded by a newer save
        this.inflight.delete(id);
        // 'closing' counts as off screen: the editor is already fading out.
        const up = this.state === 'open' || this.state === 'opening';
        if (ok) {
          this.saved.set(id, value);
          item.note = value;
          this.failed.delete(id);
          // A success says nothing at all now (v5 §R): it only clears a
          // failure this note was still showing, or surfaces another note's.
          if (!up || this.statusKind === 'empty-error') return;
          if ([...this.failed].some((f) => this.unresolvedFailure(f))) this.surfaceSaveFailure();
          else if (this.statusKind === 'save-error') this.setStatus('none');
          return;
        }
        this.failed.add(id);
        if (this.state === 'closing') this.listDirty = true;
        if (this.state === 'closed') this.mount.showBanner(saveErrorFor(id));
        // Mid-swap, setContent() surfaces it once the new content is in;
        // mid-collapse, finish() reports it on the (by then visible) list.
        else if (up && this.swapTimer === null) this.surfaceSaveFailure();
      });
  }

  /** Show the first unresolved save failure in the status slot — the shown
   *  note's own, else another note's, by number. Never over the empty-note
   *  error. */
  private surfaceSaveFailure(): void {
    if (this.statusKind === 'empty-error') return;
    const shown = this.shownId;
    if (shown !== null && this.unresolvedFailure(shown)) {
      this.setStatus('save-error');
      return;
    }
    const other = [...this.failed].find((f) => this.unresolvedFailure(f));
    if (other !== undefined) this.setStatus('save-error', false, saveErrorFor(other));
  }

  private setStatus(kind: StatusKind, instant = false, message?: string): void {
    this.statusKind = kind;
    // The empty-note error is the textarea's validation message.
    if (kind === 'empty-error') {
      this.textarea.setAttribute('aria-invalid', 'true');
      this.textarea.setAttribute('aria-describedby', STATUS_ID);
    } else {
      this.textarea.removeAttribute('aria-invalid');
      this.textarea.removeAttribute('aria-describedby');
    }
    if (kind === 'none') {
      fadeTo(this.statusEl, 0, { duration: instant ? 0 : T.errorOut, curve: ACC });
      return;
    }
    const text =
      message ??
      (kind === 'save-error'
        ? SAVE_ERROR_MESSAGE
        : kind === 'delete-error'
          ? DELETE_ERROR_MESSAGE
          : EMPTY_NOTE_MESSAGE);
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind;
    // Every remaining message is a failure, so they all fade in over the
    // 200ms std of §11's inline validation — there is no ✓ hint to be
    // quicker than any more (v5 §R).
    fadeTo(this.statusEl, 1, { duration: instant ? 0 : T.errorIn, curve: STD });
  }

  // ─── "A note can never be empty" (§D, MOTION_SPEC §11) ───────────────────

  private blockIfEmpty(): boolean {
    const id = this.shownId;
    if (id === null || this.state === 'closing' || this.state === 'closed') return false;
    const draft = this.drafts.get(id) ?? '';
    if (draft.trim() !== '') return false;
    const first = this.statusKind !== 'empty-error';
    this.textarea.classList.add('is-error');
    if (first) {
      this.setStatus('empty-error');
      // One toned-down shake on the first blocked attempt only (±4px, 2
      // cycles, 200ms ease-in-out — state-feedback's Error Shake scaled to
      // Corporate intensity); never under reduced motion.
      if (!this.reduced) {
        this.shakeAnim?.cancel();
        this.shakeAnim = animateEl(
          this.textarea,
          [
            { transform: 'translateX(0)' },
            { transform: 'translateX(-4px)' },
            { transform: 'translateX(4px)' },
            { transform: 'translateX(-4px)' },
            { transform: 'translateX(4px)' },
            { transform: 'translateX(0)' },
          ],
          { duration: T.shake, easing: 'ease-in-out' },
        );
      }
    }
    this.textarea.focus({ preventScroll: true });
    return true;
  }

  private clearEmptyError(): void {
    this.textarea.classList.remove('is-error');
    this.setStatus('none');
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────

  private onKeydown = (e: KeyboardEvent): void => {
    if (this.state === 'closed' || this.state === 'closing') return;
    // Keys that belong to an IME composition (Esc cancels it) aren't ours.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ' ') {
      // Keyboard isolation stops this event at window capture, so no inner
      // keydown handler (e.g. the list item's, thumbnails.ts) can cancel the
      // native button activation: a repeat Enter on the still-focused list
      // item would reopen the view, auto-repeat after focus lands on x would
      // collapse it. Cancel activation outside the view and on auto-repeat
      // (the textarea keeps its repeated newlines/spaces).
      const target = e.composedPath()[0];
      const inView = target instanceof Node && this.wrapper.contains(target);
      if (!inView || (e.repeat && target !== this.textarea)) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.requestCollapse();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }
    const active = this.mount.shadow.activeElement;
    if (active === this.textarea) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.go(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.go(1);
    }
  };

  /** Tab order per §D: rail, peeks, editor, delete — wrapping, since the
   *  view is modal over the page. */
  private cycleFocus(dir: -1 | 1): void {
    const order: HTMLElement[] = [this.btnExit, this.btnUp, this.btnDown];
    for (const role of ['prev', 'next'] as const) {
      for (const c of this.cards.values()) if (c.role === role) order.push(c.el);
    }
    order.push(this.textarea, this.deleteBtn);
    const active = this.mount.shadow.activeElement as HTMLElement | null;
    const i = active ? order.indexOf(active) : -1;
    const next = i < 0 ? (dir > 0 ? order[0] : order[order.length - 1]) : order[(i + dir + order.length) % order.length];
    next.focus({ preventScroll: true });
  }

  // ─── Resize / reduced-motion ─────────────────────────────────────────────

  private onResize = (): void => {
    if (this.resizeRaf !== null) return;
    this.resizeRaf = requestAnimationFrameSafe(() => {
      this.resizeRaf = null;
      this.relayout();
    });
  };

  /** New viewport / sidebar width: jump every resting geometry to the new
   *  layout (any in-flight morph lands instantly at its new slot). */
  relayout(): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.recomputeGeometry();
    this.setPanelWidth(this.geo.panelW, 0);
    this.applyStageGeometry();
    for (const card of this.cards.values()) {
      if (card.role === 'gone') continue;
      this.placeCard(card, this.slotFor(card.role));
    }
  }

  private onReducedChange = (e: MediaQueryListEvent): void => {
    this.reduced = e.matches;
  };
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function railButton(icon: string, label: string, title: string, extra: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `xp-rail-btn ${extra}`;
  b.setAttribute('aria-label', label);
  b.title = title;
  b.innerHTML = icon;
  // aria-disabled (not `disabled`) at the ends, so a focused ↓ keeps focus
  // when the last note is reached; clicks are ignored by go()'s range check.
  b.setAttribute('aria-disabled', 'false');
  return b;
}

function setBox(el: HTMLElement, box: { right: number; top: number; width?: number }): void {
  el.style.right = `${box.right}px`;
  el.style.top = `${box.top}px`;
  if (box.width !== undefined) el.style.width = `${box.width}px`;
}

function requestAnimationFrameSafe(cb: () => void): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(() => cb());
  return setTimeout(cb, 16) as unknown as number;
}

function cancelAnimationFrameSafe(id: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id);
  else clearTimeout(id as unknown as Timer);
}
