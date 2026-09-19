// src/enlargedView.ts
// The enlarged view (design spec v2 §D/§E, design/MOTION_SPEC.md) — replaces
// the old centred modal (src/modal.ts, removed). Clicking a note makes the
// SIDEBAR ITSELF grow leftward to ~75% of the viewport and become a note
// viewer/editor: previous-note peek (cut by the panel top), "feedback #n" +
// "n / total", the large screenshot, the autosaving note editor, next-note
// peek (cut by the panel bottom), and an x / ↑ / ↓ rail.
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
import { FOCUS_RING_CSS, PRESS_SCALE_CSS, DISABLED_CSS, RADII } from './theme';
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
  captionDelay: 250,
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
  hintIn: 150,
  hintHold: 1400,
  hintOut: 300,
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
/** Screenshot corner radius once a card sits in the main/peek slot (the
 *  list thumbnail's image has none — its frame's radius clips it). */
const IMG_RADIUS = RADII.sm;
/** Textarea (96) + visible part of the tucked extension bar (62 − 14). */
const EDITOR_HEIGHT = 144;
const TITLE_BLOCK = 46; // 34px title row + 12px gap
const RAIL_BTN = 40;

// ---------------------------------------------------------------------------
// Geometry (MOTION_SPEC §4 at the 1440×900 reference, scaled responsively)
// ---------------------------------------------------------------------------

export interface EnlargedGeometry {
  /** Viewport right edge (px) everything is anchored to. */
  vwRight: number;
  panelW: number;
  railRight: number;
  railTop: number;
  mainRight: number;
  titleTop: number;
  editorTop: number;
  main: Slot;
  prev: Slot;
  next: Slot;
}

/**
 * Pure layout for a `vw`×`vh` viewport. At 1440×900 this reproduces the
 * prototype's slot() numbers exactly (panel 1080, main 720×380 at right 209 /
 * top 198, peeks 540×285 at right 149, tops −201 / 762). Horizontal insets
 * scale with the panel (never below a usable floor, never more than 1.25×),
 * vertical zones with the viewport height; the main slot takes what's left
 * (aspect capped at the reference 720:380) and the peeks stay exactly 75% of
 * it. The panel is 75% of the viewport but at least 560px (or the whole
 * viewport, if narrower) and never narrower than the docked sidebar.
 */
export function computeEnlargedGeometry(vw: number, vh: number, sidebarWidth: number): EnlargedGeometry {
  const vwRight = Math.max(1, vw);
  const panelW = Math.round(Math.min(vwRight, Math.max(0.75 * vwRight, Math.min(560, vwRight), sidebarWidth)));
  const sx = Math.min(panelW / 1080, 1.25);
  const sy = Math.min(Math.max(vh, 1) / 900, 1.25);

  const railRight = Math.max(16, Math.round(149 * sx));
  const leftPad = Math.max(20, Math.round(151 * sx));
  const mainRight = railRight + RAIL_BTN + 20;
  const mainW = Math.max(160, panelW - leftPad - mainRight);

  const topZone = Math.min(190, Math.max(88, Math.round(152 * sy)));
  const bottomZone = Math.min(200, Math.max(72, Math.round(162 * sy)));
  const availH = vh - topZone - bottomZone - TITLE_BLOCK - 16 - EDITOR_HEIGHT;
  const mainH = Math.max(100, Math.min(Math.round((mainW * 380) / 720), availH));

  const titleTop = topZone;
  const mainTop = topZone + TITLE_BLOCK;
  const editorTop = mainTop + mainH + 16;
  const peekW = Math.round(mainW * 0.75);
  const peekH = Math.round(mainH * 0.75);
  const mainPad = Math.max(12, Math.min(28, Math.round((mainW * 28) / 720)));
  const peekPad = Math.round(mainPad * 0.75);

  const slotAt = (right: number, top: number, w: number, h: number, pad: number): Slot => ({
    x: vwRight - right - w,
    y: top,
    w,
    h,
    pad,
    imgR: IMG_RADIUS,
  });

  return {
    vwRight,
    panelW,
    railRight,
    railTop: topZone,
    mainRight,
    titleTop,
    editorTop,
    main: slotAt(mainRight, mainTop, mainW, mainH, mainPad),
    // 24px gap + 44px 2-line caption above the title, then the card itself.
    prev: slotAt(railRight, topZone - 68 - peekH, peekW, peekH, peekPad),
    next: slotAt(railRight, editorTop + EDITOR_HEIGHT + 24, peekW, peekH, peekPad),
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
  getListLayout: () => { narrow: boolean; compact: boolean };
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
  .xp-brand.is-compact { left: 8px; gap: 6px; }
  .xp-brand img { width: 35px; height: 20px; display: block; flex-shrink: 0; }
  .xp-brand-word {
    font-family: var(--sal-font-display);
    font-style: italic; font-size: 22px; line-height: 1;
    color: var(--sal-text);
  }

  .xp-head {
    position: absolute;
    height: 34px;
    display: flex; align-items: baseline; gap: 12px;
    min-width: 0;
  }
  .xp-title {
    margin: 0;
    font-family: var(--sal-font-display);
    font-style: italic; font-weight: 400;
    font-size: 28px; line-height: 34px; letter-spacing: -0.01em;
    color: var(--sal-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0;
  }
  .xp-count {
    flex-shrink: 0;
    font-family: var(--sal-font-mono); font-size: 12px;
    color: var(--sal-muted);
  }

  /* Editor — design spec v2 §C's text area + tucked extension bar. */
  .xp-editor {
    position: absolute;
    display: flex; flex-direction: column;
    pointer-events: auto;
  }
  .xp-note-input {
    position: relative; z-index: 1;
    display: block; width: 100%; height: 96px;
    margin: 0; padding: 12px 14px;
    resize: none; border: none; outline: none;
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

  .xp-bar {
    position: relative; z-index: 0;
    height: 62px; margin-top: -14px;
    padding: 22px 8px 8px;
    background: var(--sal-raised);
    border-radius: 0 0 var(--sal-radius-lg) var(--sal-radius-lg);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .xp-delete {
    flex-shrink: 0;
    height: 32px; margin: 0; padding: 0 12px;
    border: none; border-radius: var(--sal-radius-md);
    background: transparent;
    color: var(--sal-danger);
    font-family: var(--sal-font-body); font-size: 13px; font-weight: 600;
    cursor: pointer;
    transition: background-color 140ms ease-out, transform 80ms ease-out;
  }
  .xp-delete:hover { background: var(--sal-danger-soft); }
  .xp-delete:active { background: var(--sal-danger-press); ${PRESS_SCALE_CSS} }
  .xp-delete:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-status {
    min-width: 0;
    display: flex; align-items: center; gap: 4px;
    padding: 0 10px;
    font-size: 12px; color: var(--sal-muted);
    opacity: 0;
    white-space: nowrap; overflow: hidden;
  }
  .xp-status.is-danger { color: var(--sal-danger); }
  .xp-status-text { overflow: hidden; text-overflow: ellipsis; }
  .xp-status svg { width: 14px; height: 14px; flex-shrink: 0; display: block; }
  .xp-status:not(.is-saved) svg { display: none; }

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
  .xp-card-frame {
    position: absolute; left: 0; top: 0; width: 100%; height: 100%;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    background: var(--sal-raised);
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
  .xp-card-caption {
    position: absolute; left: 0; right: 0; top: calc(100% + 8px);
    margin: 0; padding: 0 10px;
    font-size: 13px; line-height: 18px;
    color: var(--sal-text);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
    transform-origin: 0 0;
  }
  .xp-card-caption.is-empty { color: var(--sal-muted); font-style: italic; }

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
const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_UP = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M6 15l6-6 6 6"/></svg>`;
const ICON_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M6 9l6 6 6-6"/></svg>`;
const ICON_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

const TITLE_ID = 'xp-title';
const STATUS_ID = 'xp-status';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Role = 'main' | 'prev' | 'next';
type StatusKind = 'none' | 'saved' | 'save-error' | 'delete-error' | 'empty-error';

interface Card {
  item: FeedbackItem;
  el: HTMLButtonElement;
  lift: HTMLElement;
  frame: HTMLElement;
  img: HTMLImageElement;
  badge: HTMLElement;
  caption: HTMLElement;
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
  private countEl!: HTMLSpanElement;
  private editor!: HTMLDivElement;
  private textarea!: HTMLTextAreaElement;
  private deleteBtn!: HTMLButtonElement;
  private statusEl!: HTMLSpanElement;
  private statusText!: HTMLSpanElement;
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
  private hintTimer: Timer | null = null;
  private suspendTimer: Timer | null = null;
  private panelSnapTimer: Timer | null = null;
  /** The delete step's own timer — never shares settleTimer, which a delete
   *  during the expand would otherwise overwrite (stranding 'opening'). */
  private deleteTimer: Timer | null = null;

  private deleting = false;
  private collapseAfterDelete = false;
  private shakeAnim: Animation | null = null;
  private isolation: KeyboardIsolationHandle | null = null;
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
    const vp = viewportSize();
    this.geo = computeEnlargedGeometry(vp.w, vp.h, mount.getSidebarWidth());
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
    this.applyStageGeometry();
    this.setContent(cur);
    this.updateRail();

    const sb = this.mount.sidebarEl;
    sb.classList.add('is-expanded', 'is-brand-riding');
    for (const id of sources.keys()) this.hideThumb(id);

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

    // Title row.
    this.head = div('xp-head');
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'xp-title';
    this.titleEl.id = TITLE_ID;
    this.countEl = document.createElement('span');
    this.countEl.className = 'xp-count';
    this.head.append(this.titleEl, this.countEl);

    // Editor.
    this.editor = div('xp-editor');
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'xp-note-input';
    this.textarea.setAttribute('aria-label', 'note');
    this.textarea.placeholder = 'what should change here?';
    this.textarea.addEventListener('input', this.onInput);
    this.textarea.addEventListener('blur', this.onBlur);
    const bar = div('xp-bar');
    this.deleteBtn = document.createElement('button');
    this.deleteBtn.type = 'button';
    this.deleteBtn.className = 'xp-delete';
    this.deleteBtn.textContent = 'delete';
    this.deleteBtn.setAttribute('aria-label', 'delete note');
    this.deleteBtn.addEventListener('click', () => this.deleteCurrent());
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'xp-status';
    this.statusEl.id = STATUS_ID;
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.statusEl.innerHTML = ICON_CHECK;
    this.statusText = document.createElement('span');
    this.statusText.className = 'xp-status-text';
    this.statusEl.appendChild(this.statusText);
    bar.append(this.deleteBtn, this.statusEl);
    this.editor.append(this.textarea, bar);

    // Rail.
    this.rail = div('xp-rail');
    this.btnExit = railButton(ICON_CLOSE, 'exit enlarged view', 'exit enlarged view (esc)', 'xp-exit');
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

  private applyStageGeometry(): void {
    const g = this.geo;
    const mainW = g.main.w;
    setBox(this.head, { right: g.mainRight, top: g.titleTop, width: mainW });
    setBox(this.editor, { right: g.mainRight, top: g.editorTop, width: mainW });
    setBox(this.rail, { right: g.railRight, top: g.railTop });
  }

  /** Logo/wordmark parts the *list* header doesn't show at this sidebar
   *  width (§3.1 narrow/compact) fade in/out as the view opens/closes; the
   *  rest ride the edge unchanged. */
  private syncBrandParts(opening: boolean): void {
    const layout = this.mount.getListLayout();
    this.brand.classList.toggle('is-compact', layout.compact);
    const parts: Array<[HTMLElement, boolean]> = [
      [this.brandLogo, layout.compact],
      [this.brandWord, layout.narrow],
    ];
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
          card.caption.style.opacity = '0';
          this.morphCard(card, from, slot, morphDur);
        } else {
          this.placeCard(card, slot);
          card.badge.style.opacity = '0';
          card.caption.style.opacity = role === 'main' ? '0' : '1';
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

      // Badges never rest on main/peek (§4); peek captions fade only (§3).
      if (animate) {
        fadeTo(card.badge, 0, kind === 'expand'
          ? { duration: T.fade, delay: T.badgeDelayIn, curve: STD }
          : { duration: 100, curve: ACC });
        if (role === 'main') fadeTo(card.caption, 0, { duration: 100, curve: ACC });
        else if (currentOpacity(card.caption) < 1 || kind === 'expand') {
          fadeTo(card.caption, 1, {
            duration: T.fade,
            delay: kind === 'expand' ? T.captionDelay : T.farPeekDelay,
            curve: STD,
          });
        }
      } else {
        fadeTo(card.badge, 0, { duration: 0, curve: STD });
        fadeTo(card.caption, role === 'main' ? 0 : 1, { duration: 0, curve: STD });
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
    const caption = document.createElement('p');
    caption.className = 'xp-card-caption';
    caption.setAttribute('aria-hidden', 'true');
    frame.appendChild(img);
    lift.append(frame, badge);
    el.append(lift, caption);

    const card: Card = {
      item,
      el,
      lift,
      frame,
      img,
      badge,
      caption,
      role: 'gone',
      slot,
      morph: null,
      aspect: aspectOf(item),
      removeTimer: null,
      shrink: null,
    };
    this.updateCaption(card);
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
      if (!card.morph || tweenProgress(card.morph.tween, now()) >= 1) this.placeCard(card, card.slot);
    });
    this.placeCard(card, slot);
    this.cards.set(item.id, card);
    this.front.appendChild(el);
    return card;
  }

  private updateCaption(card: Card): void {
    const text = (this.drafts.get(card.item.id) ?? card.item.note).trim() || this.saved.get(card.item.id)?.trim() || '';
    card.caption.textContent = text || 'no note';
    card.caption.classList.toggle('is-empty', !text);
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
      animateEl(card.caption, kf.caption, opts),
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
    cancelTracks(card.caption);
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

  // ─── Content (title / count / editor) ────────────────────────────────────

  private setContent(item: FeedbackItem): void {
    this.shownId = item.id;
    this.titleEl.textContent = `feedback #${item.id}`;
    this.countEl.textContent = `${this.idx + 1} / ${this.items.length}`;
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
        fadeTo(card.caption, 0, { duration: 100, curve: ACC });
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
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.saveTimer = null;
    this.hintTimer = null;
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
    const card = this.cards.get(id);
    if (card) this.updateCaption(card);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (value.trim() === '') {
      // Never autosave an empty note — the last non-empty text stays stored.
      if (this.statusKind === 'saved' || this.statusKind === 'save-error') this.setStatus('none');
      return;
    }
    if (this.statusKind === 'empty-error') this.clearEmptyError();
    else if (this.statusKind === 'save-error' || this.statusKind === 'delete-error') this.setStatus('none');
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save(id, true);
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
    if (this.isDirty(id)) this.save(id, true);
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
    if (id !== null && this.isDirty(id)) this.save(id, false);
    for (const f of [...this.failed]) {
      if (f !== id && this.isDirty(f)) this.save(f, false);
    }
  }

  private save(id: number, showHint: boolean): void {
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
        const onScreen = up && this.shownId === id && this.swapTimer === null;
        if (ok) {
          this.saved.set(id, value);
          item.note = value;
          this.failed.delete(id);
          if (!up || this.statusKind === 'empty-error') return;
          if ([...this.failed].some((f) => this.unresolvedFailure(f))) this.surfaceSaveFailure();
          else if (onScreen && showHint) this.setStatus('saved');
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
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    const prev = this.statusKind;
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
      const dur = instant ? 0 : prev === 'saved' ? T.hintOut : T.errorOut;
      fadeTo(this.statusEl, 0, { duration: dur, curve: ACC });
      return;
    }
    const text =
      message ??
      (kind === 'saved'
        ? 'saved'
        : kind === 'save-error'
          ? SAVE_ERROR_MESSAGE
          : kind === 'delete-error'
            ? DELETE_ERROR_MESSAGE
            : EMPTY_NOTE_MESSAGE);
    this.statusText.textContent = text;
    this.statusEl.title = kind === 'saved' ? '' : text;
    this.statusEl.classList.toggle('is-saved', kind === 'saved');
    this.statusEl.classList.toggle('is-danger', kind !== 'saved');
    this.statusEl.dataset.kind = kind;
    // The ✓ hint and save failures fade in over 150ms std; the empty-note
    // error over 200ms std (§10, §11 — state-feedback: Inline Validation).
    const dur = instant ? 0 : kind === 'empty-error' ? T.errorIn : T.hintIn;
    fadeTo(this.statusEl, 1, { duration: dur, curve: STD });
    if (kind === 'saved') {
      this.hintTimer = setTimeout(() => {
        this.hintTimer = null;
        if (this.statusKind === 'saved') this.setStatus('none');
      }, T.hintIn + T.hintHold);
    }
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
    const vp = viewportSize();
    this.geo = computeEnlargedGeometry(vp.w, vp.h, this.mount.getSidebarWidth());
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
