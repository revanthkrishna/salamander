// src/enlargedView.ts
// The enlarged view, 2.0 (design spec §AH, design/MOTION_SPEC.md). Clicking
// a note in the sidebar makes the SIDEBAR ITSELF grow leftward to ~75% of
// the viewport, over a scrim, and become one vertical scrolling page of
// every note on the website: a heading per page (its name, editable, and its
// address), and under it that page's notes in rows of up to three, each a
// "#n" + delete header, the screenshot at its own size and a text area —
// every note editable at once, each autosaving on its own. The sidebar list
// itself still shows only the page on screen; only this view shows the rest.
//
// ── Where the pieces live ────────────────────────────────────────────────────
//   src/enlargedLayout.ts  the pure geometry: note sizes, row packing, the
//                          page's height, the scroll position a note opens at
//   src/pageHeading.ts     one page's heading and its rename
//   src/scrollLock.ts      the host page's scroll lock (design spec v5 §T)
//   src/flip.ts            curves, tweens and the sampled FLIP keyframes
//   src/autosave.ts        the per-note draft/stored/in-flight bookkeeping
// This file is the DOM, the behaviour and the motion that tie them together.
// It never touches chrome.runtime: content.ts supplies fetchFullImage /
// onSaveNote / onDelete / onSavePageTitle.
//
// ── Where it renders ────────────────────────────────────────────────────────
// Inside the sidebar's own closed shadow root (sidebar.ts lends it a mount):
// it IS the sidebar enlarging, so the list's real DOM — whose rects the
// shared-element morphs start and end on — is right there, and the page is
// never re-laid out. Four position:fixed layers (children of one `.enlarged`
// wrapper with no stacking context of its own, so they interleave with the
// docked `.sidebar`), bottom → top:
//   .xp-scrim   full-viewport scrim; click = collapse
//   .xp-bg      the panel background — the one that visibly grows leftward
//   .sidebar    (sidebar.ts's docked list) — fades out over the growing bg
//   .xp-stage   the riding logo + wordmark, the exit button and the scroller
//               holding the whole site; animated width, overflow hidden =
//               the hard clip of the panel's left edge
//   .xp-front   the morphing screenshot clones; same width plus a bleed on
//               the left (a dock-magnified list thumbnail swells past the
//               docked panel's edge), clipped at the top to the scroller's
//               own top edge, so a clone lands exactly as clipped as the
//               note it becomes
// Everything is right-anchored, and the scroller has the panel's FINAL
// width from the first frame, so nothing inside moves with the animated
// width (MOTION_SPEC §13, "Panel: width vs. clip-path").
//
// Inside the scroller every heading and every part of every note (header,
// screenshot, editor) is absolutely positioned in content coordinates from
// the layout. Parts, not whole notes, are what move: when a delete re-packs
// the rows a note can change row and its row's band can change height, so
// its screenshot and its text area travel by different amounts.
//
// ── Motion ──────────────────────────────────────────────────────────────────
// Shared elements morph, everything else fades (MOTION_SPEC §2):
//   - open: the panel grows leftward; every note whose thumbnail is visible
//     in the list morphs from it into its place in the grid (a clone in
//     .xp-front, swapped for the real screenshot once it lands); notes with
//     no visible thumbnail — other pages, or scrolled out of the list — and
//     the headings, headers and text areas fade in, a row at a time;
//   - close: the notes on screen that have a thumbnail in the list morph
//     back into it, everything else fades out, the panel shrinks back;
//   - delete: the note shrinks and fades, then every remaining part travels
//     to its re-packed place (FLIP).
// Every tween keeps an analytic record (flip.ts), so a gesture starts from
// the live state of the one before: collapse mid-open reverses from where
// the panel and the clones are; a delete mid-move retargets every part from
// where it is. Choreography timers are owned here and all cleared on the one
// teardown path, finish(). prefers-reduced-motion is read live: geometry
// then changes instantly and only crossfades run, at roughly halved
// durations (MOTION_SPEC §12).
//
// ── Behaviour ───────────────────────────────────────────────────────────────
// Opening focuses the clicked note's text area, caret at the end, with ~80px
// of whatever precedes its row peeking at the top (enlargedLayout.ts,
// scrollTopFor). Each note autosaves (debounced 700ms; flushed on blur,
// collapse and unload). A note can never be saved empty: an emptied text
// area says "note required", and closing is refused — exit, Esc, the scrim
// and the toolbar icon — with focus moved to it, until it has text again; a
// forced close (navigation, add mode) leaves the last saved text in place.
// Keyboard: Tab cycles the controls in reading order, Esc collapses (or
// cancels a page rename), ↑/↓ and the page keys scroll when focus is not in
// a text field, and the host page sees none of it (keyboardIsolation.ts).

import { FeedbackItem, SitePage } from './types';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { AutosaveController } from './autosave';
// ICON_TRASH is the project's one trash glyph (design spec v5 §S) — the same
// one the note list's hover delete draws.
import { ICON_ARROW_RIGHT, ICON_TRASH } from './icons';
import { buildDrawingSvg, hasStrokes } from './drawing';
import {
  DELETE_ERROR_MESSAGE,
  DELETE_NOTE_TIP,
  ENLARGED_VIEW_LABEL,
  EXIT_ENLARGED_VIEW_LABEL,
  EXIT_ENLARGED_VIEW_TIP,
  NOTE_PLACEHOLDER,
  NOTE_REQUIRED_MESSAGE,
  SAVE_ERROR_MESSAGE,
  UNTITLED_PAGE_NAME,
  deleteNoteLabel,
  noteFieldLabel,
  saveErrorFor,
} from './copy';
import {
  cancelAnimationFrameSafe,
  getContentViewportSize,
  keyTargetWithin,
  reducedMotionQuery,
  requestAnimationFrameSafe,
} from './dom';
import { FOCUS_RING_CSS, STATE_TRANSITION_CSS, RADII } from './theme';
import { lockPageScroll, ScrollLockHandle } from './scrollLock';
import { measureCharWidth, PageHeading } from './pageHeading';
import {
  Box,
  GridLayout,
  NOTE_TEXT_H,
  PANEL_PAD_X,
  PEEK_PX,
  TOP_BAR_H,
  computeGridLayout,
  contentWidthFor,
  maxShotHeightFor,
  panelWidthFor,
  scrollTopFor,
} from './enlargedLayout';
import {
  ACC,
  STD,
  Slot,
  Tween,
  animateEl,
  animateNumber,
  cancelTracks,
  clamp,
  containFit,
  fadeTo,
  lerpSlot,
  morphKeyframes,
  now,
  tweenProgress,
} from './flip';

// ---------------------------------------------------------------------------
// Timing (MOTION_SPEC §5–§12). Durations in ms.
// ---------------------------------------------------------------------------

export const T = {
  expand: 450,
  expandSettle: 500,
  collapse: 340,
  collapseSettle: 360,
  /** A delete's re-pack: every remaining part travels to its new place, at
   *  §7's shared-element morph duration (the carousel this replaces). */
  move: 400,
  scrimIn: 200,
  listOut: 150,
  fade: 200,
  /** Grid content fades in a band (a heading, or a row) at a time, in
   *  reading order (multi-element: Grid Cards; Corporate 50ms stagger),
   *  from 150ms, capped at two steps so the last fade ends by 450ms —
   *  before the morph settles. */
  gridDelay: 150,
  gridStagger: 50,
  gridStaggerSteps: 2,
  exitDelay: 300,
  stageOut: 120,
  scrimOutDelay: 150,
  scrimOut: 150,
  listInDelay: 150,
  listIn: 200,
  /** The badge a clone carries back to the list fades in as it lands. */
  badgeIn: 150,
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
  rdDeleteOut: 75,
} as const;

/** How far .xp-front's clip extends left of the panel edge — covers the
 *  dock magnification's worst case (sidebar.ts's DOCK_BLEED_PX reasoning:
 *  ~38px past the edge at the 300px maximum width). */
const FRONT_BLEED_PX = 48;
const FRAME_RADIUS = RADII.md;
/** The docked sidebar's logo inset; in the panel it moves to the content
 *  column's inset (PANEL_PAD_X), so the logo, the headings and the notes
 *  share one left edge. */
const BRAND_LEFT_DOCKED = 16;
const EXIT_BTN = 36;
/** ↑ / ↓ scroll step (the browser's own arrow-key step is ~40px; a row of
 *  notes is ~250px, so this moves a useful amount without skipping one). */
const ARROW_SCROLL_PX = 64;
/** Room kept above/below a note brought into view by focus. */
const FOCUS_SCROLL_MARGIN = 24;
/** Full images are fetched (GET_IMAGE) as a note comes within this much of
 *  the scroller's viewport. Thumbnails, inline in every item, stand in until
 *  then, and every box is sized from the stored selection before any image
 *  arrives, so nothing moves when one does. */
const LAZY_ROOT_MARGIN = '800px 0px';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the view shows: every page of the site with notes, in display order
 *  (storage.ts, getSitePages), and which of them is on screen. */
export interface EnlargedSite {
  currentUrl: string;
  pages: SitePage[];
}

export interface EnlargedViewCallbacks {
  /** Full-resolution screenshot for `item`, or null (thumbnail stays). */
  fetchFullImage: (item: FeedbackItem) => Promise<string | null>;
  /** Persist `note` for `item`; resolves false on failure. */
  onSaveNote: (item: FeedbackItem, note: string) => Promise<boolean>;
  /** Delete `item` (and its blob); resolves false on failure. */
  onDelete: (item: FeedbackItem) => Promise<boolean>;
  /** Persist a page's edited name (null = its default); false on failure. */
  onSavePageTitle: (normalisedUrl: string, title: string | null) => Promise<boolean>;
  /** Fired once the view is fully gone (however it closed, except
   *  destroy()) with the note of this page focus returns to, or null. */
  onClosed: (focusItemId: number | null) => void;
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
  /** Where focus goes when there's no list item to return to — the "add
   *  note" button. */
  focusFallback: () => void;
  /** The sidebar's own error banner — for a save that fails once the view
   *  has collapsed (while it's up, failures show under their own note). */
  showBanner: (message: string) => void;
}

export type EnlargedState = 'opening' | 'open' | 'closing' | 'closed';

export interface EnlargedViewHandle {
  getState(): EnlargedState;
  /** User-initiated collapse (exit / Esc / scrim / toolbar icon / sidebar
   *  close). Returns false — and moves focus to it — while a note is empty. */
  requestCollapse(opts?: { immediate?: boolean }): boolean;
  /** Collapse instantly, bypassing the empty-note lock (add mode, SPA
   *  navigation, sidebar teardown). Flushes non-empty unsaved edits; an
   *  emptied note keeps its last saved text. Fires onClosed. */
  forceClose(): void;
  /** Best-effort, fire-and-forget save of every pending non-empty edit
   *  (page unload). Never saves an empty note; never changes the view. */
  flush(): void;
  /** Silent teardown (no onClosed) — sidebar destroy. */
  destroy(): void;
}

/** A page's default name: the HTML title captured with its first note that
 *  has one (design spec §AH), else "untitled page". */
export function defaultPageName(items: FeedbackItem[]): string {
  for (const item of items) {
    const title = item.context?.pageMeta?.title?.trim();
    if (title) return title;
  }
  return UNTITLED_PAGE_NAME;
}

// ---------------------------------------------------------------------------
// CSS — appended to the sidebar's single <style> (sidebar.ts)
// ---------------------------------------------------------------------------

const Z_SCRIM = 2147483643;
const Z_BG = 2147483644; // below .sidebar (2147483645)
const Z_STAGE = 2147483646;
const Z_FRONT = 2147483647;

/** The 28px icon button (design spec §X's small size) of a note's header and
 *  a page heading — §L's list delete treatment, surface at rest. */
const SMALL_BUTTON_CSS = `
    flex-shrink: 0;
    width: 28px; height: 28px; margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--sal-line); border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-muted);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}`;

export const ENLARGED_VIEW_CSS = `
  /* ─── Enlarged view (design spec §AH, src/enlargedView.ts) ───────────── */
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
  /* The clones are clipped where the scroller is: below the top bar. */
  .xp-front { z-index: ${Z_FRONT}; clip-path: inset(${TOP_BAR_H}px 0 0 0); }

  .xp-brand {
    position: absolute; top: 0; left: ${BRAND_LEFT_DOCKED}px;
    height: ${TOP_BAR_H}px;
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

  /* Exit: one secondary icon button, top right — an arrow pointing the way
     the panel goes. */
  .xp-exit {
    position: absolute; top: ${(TOP_BAR_H - EXIT_BTN) / 2}px; right: ${PANEL_PAD_X}px;
    width: ${EXIT_BTN}px; height: ${EXIT_BTN}px; margin: 0; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: var(--sal-text);
    cursor: pointer;
    pointer-events: auto;
    ${STATE_TRANSITION_CSS}
  }
  .xp-exit:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .xp-exit:active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .xp-exit:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-exit svg { width: 18px; height: 18px; display: block; }

  /* The whole site, one scrolling page. The gutter is stable, so the content
     width never changes with the content's height; overscroll stops here
     rather than chaining to the (locked) host page. */
  .xp-scroll {
    position: absolute; top: ${TOP_BAR_H}px; bottom: 0; right: 0;
    overflow-x: hidden; overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--sal-line-strong) transparent;
    pointer-events: auto;
    outline: none;
  }
  .xp-content { position: relative; margin: 0 0 0 ${PANEL_PAD_X}px; }

  /* A page heading (src/pageHeading.ts). */
  .xp-page { position: absolute; }
  .xp-page-line {
    height: 100%;
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
  }
  /* The serif's italic ink overhangs its box on the left: the padding gives
     it room, the negative margin keeps the text's origin on the column's
     edge. Ellipsized only past 60% of the line, so the address gives way
     first. */
  .xp-page-name {
    flex: 0 1 auto; min-width: 0; max-width: 60%;
    margin: 0 0 0 -8px; padding: 0 4px 0 8px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--sal-font-display);
    font-style: italic; font-weight: 400;
    font-size: 28px; line-height: 34px; letter-spacing: -0.01em;
    color: var(--sal-text);
  }
  .xp-page-name[hidden], .xp-page-edit[hidden], .xp-page-editor[hidden] { display: none; }
  /* The pencil stays quiet until wanted: a ghost (§2) at rest. */
  .xp-page-edit {
    ${SMALL_BUTTON_CSS}
    border-color: transparent; background: transparent;
  }
  .xp-page-edit:hover { background: var(--sal-hover); color: var(--sal-text); }
  .xp-page-edit:active { background: var(--sal-press); color: var(--sal-text); }
  .xp-page-edit:focus-visible { outline: none; color: var(--sal-text); ${FOCUS_RING_CSS} }
  .xp-page-edit svg { width: 16px; height: 16px; display: block; }
  .xp-page-editor { display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
  /* The note text area's look (.xp-note-input), one line tall. */
  .xp-page-input {
    width: 360px; min-width: 120px; flex: 0 1 auto;
    height: 32px; margin: 0; padding: 0 12px;
    border: none; outline: none;
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    color: var(--sal-text);
    font-family: var(--sal-font-body); font-size: 14px;
    box-shadow: inset 0 0 0 1px var(--sal-line);
    transition: box-shadow 150ms ${STD.css};
  }
  .xp-page-input:hover { box-shadow: inset 0 0 0 1px var(--sal-line-strong); }
  .xp-page-input:focus { box-shadow: inset 0 0 0 1px var(--sal-accent); }
  .xp-page-save, .xp-page-cancel {
    ${SMALL_BUTTON_CSS}
    width: 32px; height: 32px;
    color: var(--sal-text);
  }
  /* Saving is the yellow action, like add mode's save (2026-09-30). */
  .xp-page-save { color: var(--sal-accent-icon); }
  .xp-page-save:hover, .xp-page-cancel:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .xp-page-save:active, .xp-page-cancel:active { background: var(--sal-press); border-color: var(--sal-line-strong); }
  .xp-page-save:focus-visible, .xp-page-cancel:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-page-save svg, .xp-page-cancel svg { width: 16px; height: 16px; display: block; }
  /* The address: regular ink, not muted — it is what tells two pages with
     the same title apart. */
  .xp-page-url {
    flex: 0 1 auto; min-width: 0;
    margin-left: 4px;
    overflow: hidden; white-space: nowrap;
    font: 400 12px/20px var(--sal-font-mono);
    color: var(--sal-text);
  }
  .xp-page-here {
    flex-shrink: 0;
    height: 20px; padding: 0 7px;
    border-radius: var(--sal-radius-sm);
    box-shadow: inset 0 0 0 1px var(--sal-line-strong);
    font: 600 11px/20px var(--sal-font-body);
    color: var(--sal-accent-icon);
    white-space: nowrap;
  }
  .xp-page-status {
    position: absolute; top: calc(100% + 2px); left: 0;
    margin: 0;
    font-size: 12px; line-height: 16px;
    color: var(--sal-danger);
    opacity: 0;
  }
  .xp-page-status.is-shown { opacity: 1; }

  /* A note: header line, screenshot, editor — each placed on its own. */
  .xp-note-head {
    position: absolute;
    display: flex; align-items: center; justify-content: space-between;
  }
  .xp-note-num {
    font: 600 12px/1 var(--sal-font-mono);
    color: var(--sal-muted);
  }
  .xp-note-delete { ${SMALL_BUTTON_CSS} }
  /* Layered over the button's own surface, not used alone: both tints are
     translucent in the dark theme (see .thumbnail-delete). */
  .xp-note-delete:hover {
    background: linear-gradient(var(--sal-danger-soft), var(--sal-danger-soft)), var(--sal-surface);
    color: var(--sal-danger);
  }
  .xp-note-delete:active {
    background: linear-gradient(var(--sal-danger-press), var(--sal-danger-press)), var(--sal-surface);
    color: var(--sal-danger);
  }
  .xp-note-delete:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .xp-note-delete svg { width: 16px; height: 16px; display: block; }

  /* The screenshot at its own size: no card, no border. The raised fill is
     only ever seen before the first image has decoded. */
  .xp-shot {
    position: absolute;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    background: var(--sal-raised);
    cursor: text;
  }
  /* Every box has its image's proportions (enlargedLayout.ts, fitShot), so
     cover crops nothing visible; it only keeps a sub-pixel rounding from
     showing as a band of the fill. */
  .xp-shot-img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .xp-shot-drawing, .xp-card-drawing {
    position: absolute; left: 0; top: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    overflow: hidden;
  }

  .xp-editor { position: absolute; height: ${NOTE_TEXT_H}px; }
  /* Design spec v2 §C's text area, at a fixed height: it scrolls inside
     rather than growing. No overscroll containment of its own — a wheel at
     its end moves on to the scroller rather than sticking on one of a page
     of text areas. */
  .xp-note-input {
    display: block; width: 100%; height: 100%;
    margin: 0; padding: 12px 14px;
    resize: none; border: none; outline: none;
    overflow-y: auto;
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
  /* The one line under a text area: "note required" or a failure. Out of
     flow, in the row gap, so it reserves no space while idle. */
  .xp-note-status {
    position: absolute; top: calc(100% + 6px); left: 0; right: 0;
    margin: 0;
    font-size: 12px; line-height: 16px;
    color: var(--sal-danger);
    opacity: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Morph clones — see flip.ts for the transform-only morph they serve. */
  .xp-card {
    position: absolute;
    margin: 0; padding: 0;
    pointer-events: none;
  }
  .xp-card-frame {
    position: absolute; left: 0; top: 0; width: 100%; height: 100%;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    transform-origin: 0 0;
  }
  /* The media box: the contain-fit of the screenshot into the frame, and the
     element the morph's second track transforms (flip.ts). The drawing is
     the image's sibling in it and rides the same transform. */
  .xp-card-media {
    position: absolute;
    display: block;
    overflow: hidden;
    transform-origin: 0 0;
  }
  .xp-card-img {
    display: block;
    width: 100%; height: 100%;
    max-width: none;
    object-fit: contain;
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
    .xp-note-input, .xp-page-input { transition: none; }
  }
`;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;
type NoteStatus = 'none' | 'empty-error' | 'save-error' | 'delete-error';

/** A FLIP translate in flight: the part's layout box is already at its
 *  destination, and `dx`/`dy` is where it started from relative to it. */
interface Move {
  dx: number;
  dy: number;
  start: number;
  duration: number;
  anim: Animation | null;
}

/** One absolutely positioned piece of the grid. `size` is which of its
 *  dimensions the layout sets (a header's and an editor's height is CSS's). */
interface Part {
  el: HTMLElement;
  size: 'width' | 'both';
  box: Box;
  move: Move | null;
}

interface PageView {
  url: string;
  items: FeedbackItem[];
  heading: PageHeading;
  /** role=group, named by the heading; holds the heading and the notes. */
  group: HTMLDivElement;
  part: Part;
}

interface NoteView {
  item: FeedbackItem;
  page: PageView;
  /** Static and zero-size: groups the note's parts for opacity (and the
   *  delete's shrink) without being their containing block. */
  wrap: HTMLDivElement;
  num: HTMLSpanElement;
  del: HTMLButtonElement;
  img: HTMLImageElement;
  textarea: HTMLTextAreaElement;
  status: HTMLParagraphElement;
  head: Part;
  shot: Part;
  editor: Part;
  statusKind: NoteStatus;
  /** The one shake per emptying (MOTION_SPEC §11) has run. */
  shaken: boolean;
  deleting: boolean;
  shrink: Animation | null;
}

/** A screenshot travelling between the list and the grid, in .xp-front. */
interface Clone {
  id: number;
  el: HTMLDivElement;
  frame: HTMLElement;
  media: HTMLElement;
  img: HTMLImageElement;
  badge: HTMLElement;
  slot: Slot;
  morph: { tween: Tween<Slot>; anims: Animation[] } | null;
  aspect: number;
}

function aspectOf(item: FeedbackItem): number {
  const r = item.selectionRect;
  return r && r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 9;
}

/** §M's "original size": the selection's own CSS pixels (the stored PNG is
 *  at `item.dpr`, so its pixel size is NOT its display size). */
function naturalOf(item: FeedbackItem): { w: number; h: number } | null {
  const r = item.selectionRect;
  return r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
}

/**
 * Open the enlarged view on note `itemId` of `site`. The site is copied —
 * the view keeps its own edits and deletes and hands this page's notes back
 * to the list on collapse. A handle already 'closed' means the note is not
 * in the site.
 */
export function openEnlargedView(
  mount: EnlargedViewMount,
  site: EnlargedSite,
  itemId: number,
  callbacks: EnlargedViewCallbacks,
): EnlargedViewHandle {
  const view = new EnlargedView(mount, site, itemId, callbacks);
  view.open();
  return {
    getState: () => view.state,
    requestCollapse: (opts) => view.requestCollapse(opts),
    forceClose: () => view.forceClose(),
    flush: () => view.flushSave(),
    destroy: () => view.finish(false),
  };
}

class EnlargedView {
  state: EnlargedState = 'opening';

  private readonly currentUrl: string;
  private pages: PageView[] = [];
  private notes = new Map<number, NoteView>();
  private layout: GridLayout = computeGridLayout([], { contentW: 1 });
  private panelW = 0;
  private reduced: boolean;
  private mql: MediaQueryList | null;

  // DOM
  private wrapper!: HTMLDivElement;
  private scrim!: HTMLDivElement;
  private bg!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private front!: HTMLDivElement;
  private brand!: HTMLDivElement;
  private brandWord!: HTMLSpanElement;
  private btnExit!: HTMLButtonElement;
  private scroller!: HTMLDivElement;
  private content!: HTMLDivElement;

  private clones = new Map<number, Clone>();
  private hiddenThumbs: HTMLElement[] = [];
  private autosave: AutosaveController<string>;
  private listDirty = false;
  private fullImages = new Map<number, string>();
  private fetching = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private charW = 0;

  /** The note the view was opened on, and the last one focus was in —
   *  where the list is centred, and focus returns, on collapse. */
  private readonly openedId: number;
  private anchorId: number;
  private pendingDeletes = 0;
  private collapseAfterDeletes = false;

  private settleTimer: Timer | null = null;
  private settleAt = 0;
  private suspendTimer: Timer | null = null;
  private panelSnapTimer: Timer | null = null;
  private deleteTimers = new Set<Timer>();
  private shakeAnim: Animation | null = null;
  private isolation: KeyboardIsolationHandle | null = null;
  /** §T's page scroll lock. Taken in open(), dropped in finish() — the one
   *  teardown path every exit already routes through. */
  private scrollLock: ScrollLockHandle | null = null;
  private resizeRaf: number | null = null;

  constructor(
    private mount: EnlargedViewMount,
    site: EnlargedSite,
    itemId: number,
    private callbacks: EnlargedViewCallbacks,
  ) {
    this.currentUrl = site.currentUrl;
    this.openedId = itemId;
    this.anchorId = itemId;
    this.autosave = new AutosaveController<string>({
      debounceMs: T.autosave,
      equals: (a, b) => a === b,
      // Never autosave an empty note — the last non-empty text stays stored.
      savable: (value) => value.trim() !== '',
      save: this.saveNote,
      onSaveStarted: this.onSaveStarted,
      onSettled: this.onSaveSettled,
    });
    this.mql = reducedMotionQuery();
    this.reduced = this.mql?.matches ?? false;
    this.buildModel(site);
  }

  // ─── Model ─────────────────────────────────────────────────────────────────

  private buildModel(site: EnlargedSite): void {
    site.pages.forEach((p, i) => {
      if (p.items.length === 0) return;
      const items = p.items.map((it) => ({ ...it }));
      const group = document.createElement('div');
      group.className = 'xp-page-group';
      group.setAttribute('role', 'group');
      const heading: PageHeading = new PageHeading({
        url: p.normalisedUrl,
        isCurrent: p.normalisedUrl === site.currentUrl,
        defaultName: defaultPageName(items),
        editedName: p.editedTitle,
        idPrefix: `xp-page-${i}`,
        onRename: (name) => this.callbacks.onSavePageTitle(p.normalisedUrl, name),
        onNameChanged: () => this.renumber(page),
      });
      group.setAttribute('aria-labelledby', heading.nameId);
      group.appendChild(heading.el);
      const page: PageView = {
        url: p.normalisedUrl,
        items,
        heading,
        group,
        part: { el: heading.el, size: 'both', box: zeroBox(), move: null },
      };
      this.pages.push(page);
      for (const item of items) {
        this.autosave.seed(item.id, item.note);
        const note = this.buildNote(item, page);
        this.notes.set(item.id, note);
        group.appendChild(note.wrap);
      }
      this.renumber(page);
    });
  }

  private buildNote(item: FeedbackItem, page: PageView): NoteView {
    const wrap = document.createElement('div');
    wrap.className = 'xp-note';
    wrap.dataset.itemId = String(item.id);

    const head = document.createElement('div');
    head.className = 'xp-note-head';
    const num = document.createElement('span');
    num.className = 'xp-note-num';
    num.setAttribute('aria-hidden', 'true');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'xp-note-delete';
    del.innerHTML = ICON_TRASH; // the list's glyph, the only one (§S)
    del.dataset.tip = DELETE_NOTE_TIP;
    head.append(num, del);

    const shot = document.createElement('div');
    shot.className = 'xp-shot';
    const img = document.createElement('img');
    img.className = 'xp-shot-img';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.src = item.thumbnailDataUrl;
    shot.appendChild(img);
    // Design spec §AB: view-only, over the image, fitted the same way.
    if (hasStrokes(item.drawing)) shot.appendChild(buildDrawingSvg(document, item.drawing, 'xp-shot-drawing'));

    const editor = document.createElement('div');
    editor.className = 'xp-editor';
    const textarea = document.createElement('textarea');
    textarea.className = 'xp-note-input';
    textarea.placeholder = NOTE_PLACEHOLDER;
    textarea.value = item.note;
    const status = document.createElement('p');
    status.className = 'xp-note-status';
    status.id = `xp-note-status-${item.id}`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    editor.append(textarea, status);

    // DOM order is reading order: the header (its delete), then the text area.
    wrap.append(head, shot, editor);

    const note: NoteView = {
      item,
      page,
      wrap,
      num,
      del,
      img,
      textarea,
      status,
      head: { el: head, size: 'width', box: zeroBox(), move: null },
      shot: { el: shot, size: 'both', box: zeroBox(), move: null },
      editor: { el: editor, size: 'width', box: zeroBox(), move: null },
      statusKind: 'none',
      shaken: false,
      deleting: false,
      shrink: null,
    };
    del.addEventListener('click', () => this.deleteNote(note));
    textarea.addEventListener('input', () => this.onInput(note));
    textarea.addEventListener('blur', () => this.onBlur(note));
    // The image is part of the note: clicking it is clicking into the note.
    shot.addEventListener('click', () => textarea.focus({ preventScroll: true }));
    return note;
  }

  /** "#n" is the note's position on its page (design spec §AD), and every
   *  label names it with its page — recomputed after deletes and renames. */
  private renumber(page: PageView): void {
    page.items.forEach((item, i) => {
      const note = this.notes.get(item.id);
      if (!note) return;
      const n = i + 1;
      note.num.textContent = `#${n}`;
      note.del.setAttribute('aria-label', deleteNoteLabel(n, page.heading.name));
      note.textarea.setAttribute('aria-label', noteFieldLabel(n, page.heading.name));
    });
  }

  /** Every live note, in reading order. */
  private noteOrder(): NoteView[] {
    const out: NoteView[] = [];
    for (const page of this.pages) {
      for (const item of page.items) {
        const note = this.notes.get(item.id);
        if (note) out.push(note);
      }
    }
    return out;
  }

  private currentPage(): PageView | undefined {
    return this.pages.find((p) => p.url === this.currentUrl);
  }

  // ─── Open (MOTION_SPEC §5) ─────────────────────────────────────────────────

  open(): void {
    const opened = this.notes.get(this.openedId);
    if (!opened) {
      this.state = 'closed';
      return;
    }
    // t0: measure the list thumbnails (dock transform included) once,
    // before anything is hidden or moves.
    const sources = this.reduced ? new Map<number, Slot>() : this.measureListSlots(this.openedId);

    this.build();
    this.applyGeometry();
    const top = scrollTopFor(this.layout, this.openedId, this.scrollerHeight()) ?? 0;
    this.scroller.scrollTop = top;

    const sb = this.mount.sidebarEl;
    sb.classList.add('is-expanded', 'is-brand-riding');

    // The page is frozen for as long as the view is up (§T). Taken before
    // the keyboard isolation, which stops in-host key events reaching any
    // later capture listener, and handed the (closed) shadow root so it can
    // tell a key typed into a text area from one pressed on the page.
    this.scrollLock = lockPageScroll(this.mount.host, this.mount.shadow);
    this.isolation = installKeyboardIsolation(this.mount.host, this.onKeydown);
    window.addEventListener('resize', this.onResize);
    this.mql?.addEventListener?.('change', this.onReducedChange);
    this.startLazyImages();

    // The clicked note's text area takes focus at once, caret at the end —
    // so Esc during the expand reaches this host, and the list can go inert
    // now without dropping focus to <body>.
    opened.textarea.focus({ preventScroll: true });
    const end = opened.textarea.value.length;
    opened.textarea.setSelectionRange(end, end);
    sb.setAttribute('inert', '');

    const from = this.mount.getSidebarWidth();
    this.btnExit.style.opacity = '0';
    this.scrim.style.opacity = '0';
    this.syncBrandWord(true);

    if (this.reduced) {
      // §12: geometry jumps, only opacity moves.
      this.setPanelWidth(this.panelW, 0);
      this.setBrandLeft(PANEL_PAD_X, 0);
      fadeTo(this.scrim, 1, { duration: T.rdScrimIn, curve: STD });
      fadeTo(sb, 0, { duration: T.rdListOut, curve: ACC });
      this.scroller.style.opacity = '0';
      fadeTo(this.scroller, 1, { duration: T.rdStageIn, curve: STD });
      fadeTo(this.btnExit, 1, { duration: T.rdStageIn, curve: STD });
      this.mount.setDockSuspended(true);
      this.scheduleSettle(T.rdExpandSettle);
      return;
    }

    this.setPanelWidth(this.panelW, T.expand, from);
    this.setBrandLeft(PANEL_PAD_X, T.expand, BRAND_LEFT_DOCKED);
    // Backdrop first (Modal-with-Content), list-only chrome dissolves out
    // (entrance-exit: Dissolve Exit, ease-in), then the grid a band at a
    // time, and the exit button last.
    fadeTo(this.scrim, 1, { duration: T.scrimIn, curve: STD });
    fadeTo(sb, 0, { duration: T.listOut, curve: ACC });
    fadeTo(this.btnExit, 1, { duration: T.fade, delay: T.exitDelay, curve: STD });
    this.fadeInGrid(top);

    // Shared elements: every note whose thumbnail is visible in the list
    // morphs from it into its place (MOTION_SPEC §2, §5).
    const origin = this.contentOrigin();
    for (const [id, slot] of sources) {
      const note = this.notes.get(id);
      if (!note) continue;
      const clone = this.createClone(note, slot);
      this.morphClone(clone, slot, this.shotViewportSlot(note, origin), T.expand);
      note.shot.el.style.visibility = 'hidden';
      this.hideThumb(id);
    }

    // Suspend the dock once the list is invisible — suspending snaps swollen
    // items to rest, which must not be seen mid-fade.
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      this.mount.setDockSuspended(true);
    }, T.listOut);
    this.scheduleSettle(T.expandSettle);
  }

  /** (Re)arm the end of the expand `after` ms from now — never earlier than
   *  already armed (a delete mid-expand retargets the clones, and pushes the
   *  end back). */
  private scheduleSettle(after: number): void {
    const at = now() + after;
    if (this.settleTimer !== null && at <= this.settleAt) return;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleAt = at;
    this.settleTimer = setTimeout(() => this.settleOpen(), after);
  }

  private settleOpen(): void {
    this.settleTimer = null;
    if (this.state !== 'opening') return;
    this.state = 'open';
    this.wrapper.dataset.state = 'open';
    this.mount.setDockSuspended(true);
    // The clones have landed exactly on their notes: swap them back.
    for (const clone of [...this.clones.values()]) this.removeClone(clone);
    for (const note of this.notes.values()) note.shot.el.style.visibility = '';
    this.restoreThumbs();
  }

  /** Grid content fades in a band at a time — a heading, or a row — top
   *  down from where the view opens; what is off screen is simply there. */
  private fadeInGrid(scrollTop: number): void {
    const viewBottom = scrollTop + this.scrollerHeight();
    const visible = (y: number, h: number) => y + h > scrollTop && y < viewBottom;
    let band = 0;
    const next = () => T.gridDelay + Math.min(band++, T.gridStaggerSteps) * T.gridStagger;
    for (const page of this.pages) {
      const hb = page.part.box;
      if (visible(hb.y, hb.h)) fadeInEl(page.heading.el, next());
      for (const row of this.layout.rows) {
        if (row.page !== page.url || !visible(row.top, row.bottom - row.top)) continue;
        const delay = next();
        for (const id of row.ids) {
          const note = this.notes.get(id);
          if (note) fadeInEl(note.wrap, delay);
        }
      }
    }
  }

  // ─── DOM ──────────────────────────────────────────────────────────────────

  private build(): void {
    const w = document.createElement('div');
    w.className = 'enlarged';
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-modal', 'true');
    w.setAttribute('aria-label', ENLARGED_VIEW_LABEL);
    w.dataset.state = 'opening';
    this.wrapper = w;

    this.scrim = div('xp-scrim');
    this.scrim.setAttribute('aria-hidden', 'true');
    this.scrim.addEventListener('click', () => void this.requestCollapse());
    this.bg = div('xp-bg');
    this.bg.setAttribute('aria-hidden', 'true');
    this.stage = div('xp-stage');
    this.front = div('xp-front');
    this.front.setAttribute('aria-hidden', 'true');

    // Logo + wordmark, riding the panel's left edge.
    this.brand = div('xp-brand');
    this.brand.setAttribute('aria-hidden', 'true');
    const logo = document.createElement('img');
    logo.alt = '';
    logo.draggable = false;
    logo.src = this.mount.getLogoSrc();
    this.brandWord = document.createElement('span');
    this.brandWord.className = 'xp-brand-word';
    this.brandWord.textContent = 'salamander';
    this.brand.append(logo, this.brandWord);

    this.btnExit = document.createElement('button');
    this.btnExit.type = 'button';
    this.btnExit.className = 'xp-exit';
    this.btnExit.innerHTML = ICON_ARROW_RIGHT;
    this.btnExit.setAttribute('aria-label', EXIT_ENLARGED_VIEW_LABEL);
    this.btnExit.dataset.tip = EXIT_ENLARGED_VIEW_TIP;
    this.btnExit.addEventListener('click', () => void this.requestCollapse());

    this.scroller = div('xp-scroll');
    this.content = div('xp-content');
    for (const page of this.pages) this.content.appendChild(page.group);
    this.scroller.appendChild(this.content);
    // The scroller holds still while a morph is in flight: the clones are
    // aimed at where the notes are at this scroll position.
    const holdStill = (e: Event) => {
      if (this.state !== 'open' && e.cancelable) e.preventDefault();
    };
    this.scroller.addEventListener('wheel', holdStill, { passive: false });
    this.scroller.addEventListener('touchmove', holdStill, { passive: false });

    this.stage.append(this.brand, this.btnExit, this.scroller);
    w.append(this.scrim, this.bg, this.stage, this.front);
    w.addEventListener('focusin', this.onFocusIn);
    this.mount.shadow.appendChild(w);
  }

  private scrollerHeight(): number {
    return Math.max(1, viewportSize().h - TOP_BAR_H);
  }

  /** Size the panel and scroller for the viewport, measure the content
   *  width the scroller really leaves (less any classic scrollbar), and lay
   *  the site out in it. Every part lands on its box, with no move. */
  private applyGeometry(): void {
    const vp = viewportSize();
    this.panelW = panelWidthFor(vp.w, this.mount.getSidebarWidth());
    const scrollerW = Math.max(1, this.panelW - 1); // inside .xp-bg's border
    this.scroller.style.width = `${scrollerW}px`;
    const contentW = contentWidthFor(this.scroller.clientWidth || scrollerW);
    this.layout = computeGridLayout(
      this.pages.map((p) => ({ key: p.url, notes: p.items.map((it) => ({ id: it.id, natural: naturalOf(it) })) })),
      { contentW, maxShotH: maxShotHeightFor(this.scrollerHeight()) },
    );
    this.content.style.width = `${contentW}px`;
    this.content.style.height = `${this.layout.height}px`;
    for (const page of this.pages) {
      const h = this.layout.headings.find((x) => x.page === page.url);
      if (h) this.placePart(page.part, h.box);
      for (const item of page.items) {
        const note = this.notes.get(item.id);
        const nl = this.layout.notes.get(item.id);
        if (!note || !nl) continue;
        this.placePart(note.head, nl.head);
        this.placePart(note.shot, nl.shot);
        this.placePart(note.editor, nl.text);
      }
    }
    if (!this.charW) this.charW = measureCharWidth(this.content);
    for (const page of this.pages) page.heading.fitAddress(this.charW);
  }

  /** The content box's top-left in viewport coordinates (scroll included).
   *  One layout read per gesture. */
  private contentOrigin(): { x: number; y: number } {
    const r = this.content.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  /** Where a note's screenshot is on screen now, live move included. */
  private shotViewportSlot(note: NoteView, origin: { x: number; y: number }): Slot {
    const live = liveBox(note.shot);
    return { x: origin.x + live.x, y: origin.y + live.y, w: live.w, h: live.h, pad: 0, imgR: FRAME_RADIUS };
  }

  // ─── Parts (layout boxes + FLIP moves) ────────────────────────────────────

  /**
   * Put `part` at `box`. With `from` (an offset from the new box to where it
   * is on screen now) it then travels there: a transform-only FLIP on the
   * std curve, with an analytic record so the next gesture can start from
   * wherever it is.
   */
  private placePart(part: Part, box: Box, from?: { dx: number; dy: number }, duration = 0): void {
    part.move?.anim?.cancel();
    part.move = null;
    part.box = box;
    const s = part.el.style;
    s.left = `${box.x}px`;
    s.top = `${box.y}px`;
    s.width = `${box.w}px`;
    if (part.size === 'both') s.height = `${box.h}px`;
    if (!from || duration <= 0 || (Math.abs(from.dx) < 0.5 && Math.abs(from.dy) < 0.5)) return;
    const anim = animateEl(
      part.el,
      [{ transform: `translate(${from.dx}px, ${from.dy}px)` }, { transform: 'translate(0px, 0px)' }],
      { duration, easing: STD.css },
    );
    part.move = { dx: from.dx, dy: from.dy, start: now(), duration, anim };
  }

  // ─── Panel width + brand ──────────────────────────────────────────────────

  private setPanelWidth(to: number, duration: number, from?: number): void {
    const pairs: Array<[HTMLElement, number]> = [
      [this.bg, 0],
      [this.stage, 0],
      [this.front, FRONT_BLEED_PX],
    ];
    for (const [el, extra] of pairs) {
      animateNumber(el, 'width', to + extra, {
        duration,
        from: from === undefined ? undefined : from + extra,
        curve: STD,
      });
    }
  }

  /** The logo moves from the docked header's inset to the content column's
   *  as the panel grows (and back), on the panel's own curve. */
  private setBrandLeft(to: number, duration: number, from?: number): void {
    animateNumber(this.brand, 'left', to, { duration, from, curve: STD });
  }

  /** The wordmark, which the list header hides at a narrow sidebar width
   *  (§3.1), fades in/out as the view opens/closes. */
  private syncBrandWord(opening: boolean): void {
    if (!this.mount.getListLayout().narrow) return;
    if (opening) {
      this.brandWord.style.opacity = '0';
      fadeTo(this.brandWord, 1, {
        duration: this.reduced ? T.rdStageIn : T.fade,
        delay: this.reduced ? 0 : T.gridDelay,
        curve: STD,
      });
    } else {
      fadeTo(this.brandWord, 0, { duration: this.reduced ? T.rdStageOut : T.stageOut, curve: ACC });
    }
  }

  // ─── The list's side of the morphs ───────────────────────────────────────

  /** List-slot rects for this page's notes that are actually visible in the
   *  list's scrollport (MOTION_SPEC §3's edge case: one scrolled out has no
   *  rect to morph from, so it fades instead) — and always `always`'s (the
   *  note that was clicked, even if the list cuts it off). */
  private measureListSlots(always: number | null = null): Map<number, Slot> {
    const out = new Map<number, Slot>();
    const page = this.currentPage();
    if (!page) return out;
    const vp = this.mount.getListViewport();
    const hasViewport = !!vp && vp.height >= 1;
    for (const item of page.items) {
      const el = this.mount.getListThumb(item.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const inView = !hasViewport || (r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5);
      if (!inView && item.id !== always) continue;
      out.set(item.id, { x: r.left, y: r.top, w: r.width, h: r.height, pad: 0, imgR: 0 });
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

  // ─── Clones ───────────────────────────────────────────────────────────────

  private createClone(note: NoteView, slot: Slot): Clone {
    const item = note.item;
    const el = document.createElement('div');
    el.className = 'xp-card';
    el.dataset.itemId = String(item.id);
    const frame = document.createElement('span');
    frame.className = 'xp-card-frame';
    const media = document.createElement('span');
    media.className = 'xp-card-media';
    const img = document.createElement('img');
    img.className = 'xp-card-img';
    img.alt = '';
    img.draggable = false;
    img.src = this.fullImages.get(item.id) ?? item.thumbnailDataUrl;
    // The list's badge, carried on the clone: it fades out as the clone
    // leaves the list and back in as one lands on it (MOTION_SPEC §4).
    const badge = document.createElement('span');
    badge.className = 'xp-card-badge';
    badge.textContent = String(note.page.items.findIndex((it) => it.id === item.id) + 1);
    media.appendChild(img);
    if (hasStrokes(item.drawing)) media.appendChild(buildDrawingSvg(document, item.drawing, 'xp-card-drawing'));
    frame.appendChild(media);
    el.append(frame, badge);
    const clone: Clone = { id: item.id, el, frame, media, img, badge, slot, morph: null, aspect: aspectOf(item) };
    this.placeClone(clone, slot);
    if (this.state === 'opening') fadeTo(badge, 0, { duration: T.fade, delay: T.gridDelay, curve: STD });
    else badge.style.opacity = '0';
    this.clones.set(item.id, clone);
    this.front.appendChild(el);
    return clone;
  }

  /** Write the clone's layout boxes for `slot` (the FLIP "Last"). */
  private placeClone(clone: Clone, slot: Slot): void {
    this.cancelCloneMorph(clone);
    clone.slot = slot;
    const s = clone.el.style;
    s.right = `${viewportSize().w - (slot.x + slot.w)}px`;
    s.top = `${slot.y}px`;
    s.width = `${slot.w}px`;
    s.height = `${slot.h}px`;
    const ib = containFit(clone.aspect, { x: 0, y: 0, w: slot.w, h: slot.h });
    const ms = clone.media.style;
    ms.left = `${ib.x}px`;
    ms.top = `${ib.y}px`;
    ms.width = `${ib.w}px`;
    ms.height = `${ib.h}px`;
    ms.borderRadius = `${slot.imgR}px`;
  }

  private morphClone(clone: Clone, from: Slot, to: Slot, duration: number): void {
    this.placeClone(clone, to);
    if (duration <= 0 || from.w < 1 || from.h < 1) return;
    const kf = morphKeyframes(from, to, clone.aspect, STD.fn, Math.max(8, Math.round(duration / 16)), FRAME_RADIUS);
    const opts: KeyframeAnimationOptions = { duration, easing: 'linear' };
    const anims = [
      animateEl(clone.frame, kf.frame, opts),
      animateEl(clone.media, kf.media, opts),
      animateEl(clone.badge, kf.badge, opts),
    ].filter((a): a is Animation => a !== null);
    clone.morph = { tween: { from, to, start: now(), delay: 0, duration, ease: STD.fn }, anims };
  }

  private cancelCloneMorph(clone: Clone): void {
    if (!clone.morph) return;
    for (const a of clone.morph.anims) a.cancel();
    clone.morph = null;
  }

  /** Where the clone is on screen right now (analytic — no DOM read). */
  private cloneSlot(clone: Clone): Slot {
    const m = clone.morph;
    if (!m) return clone.slot;
    return lerpSlot(m.tween.from, m.tween.to, tweenProgress(m.tween, now()));
  }

  private removeClone(clone: Clone): void {
    this.cancelCloneMorph(clone);
    cancelTracks(clone.el);
    cancelTracks(clone.badge);
    clone.el.remove();
    if (this.clones.get(clone.id) === clone) this.clones.delete(clone.id);
  }

  // ─── Images ───────────────────────────────────────────────────────────────

  /** Full images arrive as notes near the viewport (IntersectionObserver on
   *  the scroller, with a margin). Without one (jsdom), all are fetched. */
  private startLazyImages(): void {
    if (typeof IntersectionObserver !== 'function') {
      for (const note of this.notes.values()) this.ensureFullImage(note);
      return;
    }
    const byEl = new Map<Element, NoteView>();
    for (const note of this.notes.values()) byEl.set(note.shot.el, note);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.observer?.unobserve(entry.target);
          const note = byEl.get(entry.target);
          if (note) this.ensureFullImage(note);
        }
      },
      { root: this.scroller, rootMargin: LAZY_ROOT_MARGIN },
    );
    for (const el of byEl.keys()) this.observer.observe(el);
  }

  private ensureFullImage(note: NoteView): void {
    const id = note.item.id;
    if (this.fullImages.has(id) || this.fetching.has(id)) return;
    this.fetching.add(id);
    const item = note.item;
    void this.callbacks
      .fetchFullImage(item)
      .catch(() => null)
      .then((url) => {
        this.fetching.delete(id);
        if (!url || this.state === 'closed') return;
        this.fullImages.set(id, url);
        // Keyed by note id, so a reply can only land on its own note.
        const n = this.notes.get(id);
        if (n && n.item === item) n.img.src = url;
        const clone = this.clones.get(id);
        if (clone) clone.img.src = url;
      });
  }

  // ─── Collapse (MOTION_SPEC §6) ────────────────────────────────────────────

  requestCollapse(opts: { immediate?: boolean } = {}): boolean {
    if (this.state === 'closed' || this.state === 'closing') return true;
    this.commitRenames();
    if (this.blockIfEmpty()) return false;
    // A delete still in flight decides what the list should look like, so
    // the collapse waits for it. (The note going away is exempt from the
    // empty lock: deleting is always allowed.)
    if (this.pendingDeletes > 0 && !opts.immediate) {
      this.collapseAfterDeletes = true;
      return true;
    }
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
    this.commitRenames();
    this.flushSave();
    this.finish(true);
  }

  /** A rename still being typed is saved, not dropped, by a collapse. */
  private commitRenames(): void {
    for (const page of this.pages) if (page.heading.isEditing()) page.heading.commit({ refocus: false });
  }

  private beginCollapse(): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    const wasOpen = this.state === 'open';
    this.clearChoreoTimers();
    this.state = 'closing';
    this.wrapper.dataset.state = 'closing';
    const sb = this.mount.sidebarEl;
    sb.removeAttribute('inert');

    // t0: bring the (still invisible) list up to date, centre the note
    // focus returns to, then measure the landing rects once.
    this.restoreThumbs();
    if (this.listDirty) {
      this.mount.renderList(this.listItems());
      this.listDirty = false;
    }
    const anchor = this.focusReturnId();
    if (anchor !== null) this.mount.centreListOn(anchor);
    const targets = this.reduced ? new Map<number, Slot>() : this.measureListSlots(anchor);

    const rd = this.reduced;
    fadeTo(this.btnExit, 0, { duration: rd ? T.rdStageOut : T.stageOut, curve: ACC });
    fadeTo(this.scroller, 0, { duration: rd ? T.rdStageOut : T.stageOut, curve: ACC });
    this.syncBrandWord(false);

    if (rd) {
      fadeTo(this.front, 0, { duration: T.rdStageOut, curve: ACC });
      fadeTo(this.scrim, 0, { duration: T.rdStageOut, curve: ACC });
      fadeTo(sb, 1, { duration: T.rdListIn, delay: T.rdListInDelay, curve: STD });
      sb.classList.remove('is-brand-riding');
      this.panelSnapTimer = setTimeout(() => {
        this.panelSnapTimer = null;
        this.setPanelWidth(this.mount.getSidebarWidth(), 0);
        this.setBrandLeft(BRAND_LEFT_DOCKED, 0);
      }, T.rdStageOut);
      this.settleTimer = setTimeout(() => this.finish(true), T.rdCollapseSettle);
      return;
    }

    this.setPanelWidth(this.mount.getSidebarWidth(), T.collapse);
    this.setBrandLeft(BRAND_LEFT_DOCKED, T.collapse);
    fadeTo(this.scrim, 0, { duration: T.scrimOut, delay: T.scrimOutDelay, curve: ACC });
    fadeTo(sb, 1, { duration: T.listIn, delay: T.listInDelay, curve: STD });

    // Clones still in flight (a collapse mid-open) reverse from where they
    // are. On an open view, every note on screen with a thumbnail in the
    // list gets a clone, from where it is now.
    if (wasOpen) {
      const origin = this.contentOrigin();
      const view = this.scroller.getBoundingClientRect();
      const viewBottom = view.top + this.scrollerHeight();
      for (const id of targets.keys()) {
        const note = this.notes.get(id);
        if (!note || note.deleting || this.clones.has(id)) continue;
        const at = this.shotViewportSlot(note, origin);
        if (at.y + at.h <= view.top || at.y >= viewBottom) continue;
        this.createClone(note, at);
        note.shot.el.style.visibility = 'hidden';
      }
    }
    for (const clone of [...this.clones.values()]) {
      const to = targets.get(clone.id);
      if (to) {
        this.hideThumb(clone.id);
        this.morphClone(clone, this.cloneSlot(clone), to, T.collapse);
        fadeTo(clone.badge, 1, { duration: T.badgeIn, curve: STD });
      } else {
        fadeTo(clone.el, 0, { duration: T.stageOut, curve: ACC });
      }
    }
    this.settleTimer = setTimeout(() => this.finish(true), T.collapseSettle);
  }

  /** This page's notes as the list should show them: saved text, or a
   *  non-empty draft flushSave() is already persisting — never a draft
   *  whose save failed (the list would show text that isn't stored). */
  private listItems(): FeedbackItem[] {
    const page = this.currentPage();
    if (!page) return [];
    return page.items.map((it) => {
      const d = this.autosave.draft(it.id);
      if (this.autosave.unresolvedFailure(it.id)) return it;
      return d !== undefined && d.trim() !== '' ? { ...it, note: d } : it;
    });
  }

  /** The list note focus returns to: the last one focused in the view if it
   *  is on this page, else the one the view was opened on, if it is still
   *  there. */
  private focusReturnId(): number | null {
    for (const id of [this.anchorId, this.openedId]) {
      const note = this.notes.get(id);
      if (note && note.page.url === this.currentUrl) return id;
    }
    return null;
  }

  /** The single teardown path — every timer, animation, listener and node
   *  this view created goes here, whether the collapse completed, was
   *  skipped (immediate) or the sidebar is being destroyed. */
  finish(notify: boolean): void {
    if (this.state === 'closed') return;
    const focusId = this.focusReturnId();
    this.state = 'closed';
    this.clearChoreoTimers();
    this.autosave.dispose();
    this.shakeAnim?.cancel();
    this.shakeAnim = null;
    this.observer?.disconnect();
    this.observer = null;
    if (this.resizeRaf !== null) cancelAnimationFrameSafe(this.resizeRaf);
    this.resizeRaf = null;

    for (const clone of [...this.clones.values()]) this.removeClone(clone);
    for (const note of this.notes.values()) {
      note.shrink?.cancel();
      for (const part of [note.head, note.shot, note.editor]) part.move?.anim?.cancel();
      cancelTracks(note.wrap);
      cancelTracks(note.status);
    }
    for (const page of this.pages) {
      page.part.move?.anim?.cancel();
      cancelTracks(page.heading.el);
    }
    for (const el of [this.scrim, this.bg, this.stage, this.front, this.btnExit, this.scroller, this.brand, this.brandWord]) {
      if (el) cancelTracks(el);
    }

    this.restoreThumbs();
    if (notify && this.listDirty) this.mount.renderList(this.listItems());
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
    if (focusId === null || !this.mount.focusListItem(focusId)) this.mount.focusFallback();
    // A save that failed and isn't being retried: the list (and its banner)
    // is visible again, so report it there. Retries still in flight report
    // themselves when they settle.
    const lost = this.autosave.firstUnresolvedFailure();
    if (lost !== undefined) this.mount.showBanner(this.saveErrorMessageFor(lost));
    this.callbacks.onClosed(focusId);
  }

  private clearChoreoTimers(): void {
    for (const t of [this.settleTimer, this.suspendTimer, this.panelSnapTimer]) if (t) clearTimeout(t);
    for (const t of this.deleteTimers) clearTimeout(t);
    this.deleteTimers.clear();
    this.settleTimer = null;
    this.suspendTimer = null;
    this.panelSnapTimer = null;
  }

  // ─── Delete (MOTION_SPEC §8) ──────────────────────────────────────────────

  /** Immediate, no confirmation: the note shrinks and fades (180ms acc)
   *  while DELETE_ITEM runs; then it is gone and every note after it
   *  travels to its re-packed place. A page's last note takes its heading
   *  with it; the site's last note collapses the view. */
  private deleteNote(note: NoteView): void {
    if (this.state !== 'open' && this.state !== 'opening') return;
    if (note.deleting) return;
    note.deleting = true;
    this.pendingDeletes++;
    this.autosave.cancelPending(note.item.id);
    note.textarea.classList.remove('is-error');
    this.setStatus(note, 'none', true);
    const lastOfPage = note.page.items.every((it) => this.notes.get(it.id)?.deleting !== false);

    const out = this.reduced ? T.rdDeleteOut : T.deleteStep;
    fadeTo(note.wrap, 0, { duration: out, curve: ACC });
    if (lastOfPage) fadeTo(note.page.heading.el, 0, { duration: out, curve: ACC });
    if (!this.reduced) {
      // The wrap is static and zero-size at the content's origin, so its
      // box starts where the content's does: the shrink's origin is the
      // note's own centre in content coordinates.
      const slot = this.layout.notes.get(note.item.id)?.slot;
      if (slot) note.wrap.style.transformOrigin = `${slot.x + slot.w / 2}px ${slot.y + slot.h / 2}px`;
      note.shrink?.cancel();
      note.shrink = animateEl(note.wrap, [{ transform: 'scale(1)' }, { transform: 'scale(0.95)' }], {
        duration: T.deleteStep,
        easing: ACC.css,
        fill: 'forwards',
      });
    }

    const request = this.callbacks.onDelete(note.item).catch(() => false);
    const step = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.deleteTimers.delete(timer);
        resolve();
      }, out);
      this.deleteTimers.add(timer);
    });
    void Promise.all([request, step]).then(([ok]) => {
      if (this.state === 'closed') return;
      this.pendingDeletes--;
      if (!ok) {
        note.deleting = false;
        note.shrink?.cancel();
        note.shrink = null;
        fadeTo(note.wrap, 1, { duration: T.fade, curve: STD });
        fadeTo(note.page.heading.el, 1, { duration: T.fade, curve: STD });
        this.setStatus(note, 'delete-error');
      } else {
        this.applyDeletion(note);
      }
      if (this.pendingDeletes === 0 && this.collapseAfterDeletes) {
        this.collapseAfterDeletes = false;
        if (this.state === 'open' || this.state === 'opening') this.requestCollapse();
      }
    });
  }

  private applyDeletion(note: NoteView): void {
    if (this.state === 'closing') return;
    const order = this.noteOrder();
    const at = order.indexOf(note);
    const active = this.mount.shadow.activeElement;
    const focusWasHere = !active || note.wrap.contains(active);
    const id = note.item.id;
    const page = note.page;

    page.items = page.items.filter((it) => it.id !== id);
    this.notes.delete(id);
    this.autosave.forget(id);
    if (page.url === this.currentUrl) this.listDirty = true;
    if (this.anchorId === id) this.anchorId = this.openedId;
    const clone = this.clones.get(id);
    if (clone) this.removeClone(clone);
    note.shrink?.cancel();
    cancelTracks(note.wrap);
    note.wrap.remove();
    if (page.items.length === 0) {
      cancelTracks(page.heading.el);
      page.group.remove();
      this.pages = this.pages.filter((p) => p !== page);
    } else {
      this.renumber(page);
    }

    if (this.notes.size === 0) {
      // The site's last note: straight back to the (now empty) list.
      this.beginCollapse();
      return;
    }
    this.relayout(this.reduced ? 'instant' : 'move');

    if (focusWasHere) {
      const rest = order.filter((n) => n !== note && this.notes.has(n.item.id));
      rest[Math.min(at, rest.length - 1)]?.del.focus({ preventScroll: true });
    }
  }

  // ─── Relayout (a delete's re-pack, a resize) ─────────────────────────────

  /**
   * Lay the site out again for the notes and the viewport as they are now.
   * 'move' (after a delete) sends every part from where it is on screen
   * right now to its new place — the content's height change can make the
   * browser clamp the scroll position, which is folded into the start
   * offsets so nothing jumps; 'instant' (a resize, reduced motion) places
   * them, keeping the note at the top of the scroller where it was.
   */
  private relayout(kind: 'move' | 'instant'): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    const s0 = this.scroller.scrollTop;
    const parts = this.allParts();
    const live = new Map(parts.map((p) => [p, liveBox(p)] as const));
    const anchor = kind === 'instant' ? this.scrollAnchor() : null;

    this.applyGeometry();
    if (anchor) this.restoreScrollAnchor(anchor);

    if (kind === 'move') {
      const shift = this.scroller.scrollTop - s0;
      for (const part of parts) {
        const was = live.get(part)!;
        this.placePart(part, part.box, { dx: was.x - part.box.x, dy: was.y - part.box.y + shift }, T.move);
      }
    }
    // Clones in flight (a delete or a resize during the expand) are aimed
    // at their notes' new places.
    if (this.clones.size > 0) {
      const origin = this.contentOrigin();
      for (const clone of this.clones.values()) {
        const n = this.notes.get(clone.id);
        if (!n) continue;
        const to = this.shotViewportSlot(n, origin);
        if (kind === 'move') this.morphClone(clone, this.cloneSlot(clone), to, T.move);
        else this.placeClone(clone, to);
      }
      if (kind === 'move' && this.state === 'opening') this.scheduleSettle(T.move);
    }
  }

  private allParts(): Part[] {
    const out: Part[] = [];
    for (const page of this.pages) {
      out.push(page.part);
      for (const item of page.items) {
        const n = this.notes.get(item.id);
        if (n) out.push(n.head, n.shot, n.editor);
      }
    }
    return out;
  }

  /** The first note whose bottom is below the scroll position, and how far
   *  below the scroller's top its own top is. */
  private scrollAnchor(): { id: number; offset: number } | null {
    const top = this.scroller.scrollTop;
    for (const note of this.noteOrder()) {
      const nl = this.layout.notes.get(note.item.id);
      if (nl && nl.slot.y + nl.slot.h > top) return { id: note.item.id, offset: nl.slot.y - top };
    }
    return null;
  }

  private restoreScrollAnchor(anchor: { id: number; offset: number }): void {
    const nl = this.layout.notes.get(anchor.id);
    if (nl) this.scroller.scrollTop = Math.max(0, nl.slot.y - anchor.offset);
  }

  // ─── Autosave (MOTION_SPEC §10) ───────────────────────────────────────────
  //
  // The draft / stored / in-flight / failed bookkeeping is src/autosave.ts's
  // AutosaveController, with a debounce per note — every note is editable
  // at once. What is here is the note's own policy: never save an empty
  // note, and what a settled save does to that note's status line, the
  // sidebar banner and the list.

  private onInput(note: NoteView): void {
    const id = note.item.id;
    const value = note.textarea.value;
    this.autosave.setDraft(id, value);
    if (value.trim() === '') {
      // Never autosave an empty note — the last saved text stays stored —
      // and say so under it at once, not only when leaving is refused.
      this.autosave.cancelPending(id);
      this.setEmptyError(note, true);
      return;
    }
    this.setEmptyError(note, false);
    if (note.statusKind !== 'none') this.setStatus(note, 'none');
    this.autosave.schedule(id);
  }

  private onBlur(note: NoteView): void {
    if (this.state === 'closed') return;
    const id = note.item.id;
    this.autosave.cancelPending(id);
    if (this.autosave.isDirty(id)) this.autosave.saveNow(id);
  }

  /** Immediate save of every pending change, plus a retry of every note
   *  whose last save failed (collapse / unload). */
  flushSave(): void {
    this.autosave.flush();
  }

  /** AutosaveOptions.save — the UPDATE round trip, via content.ts. */
  private saveNote = (id: number, value: string): Promise<boolean> => {
    const note = this.notes.get(id);
    if (!note) return Promise.resolve(false);
    return this.callbacks.onSaveNote(note.item, value);
  };

  private onSaveStarted = (id: number): void => {
    if (this.notes.get(id)?.page.url === this.currentUrl) this.listDirty = true;
  };

  private onSaveSettled = (id: number, value: string, ok: boolean): void => {
    const note = this.notes.get(id);
    if (ok) {
      if (note) note.item.note = value;
      if (note && note.statusKind === 'save-error') this.setStatus(note, 'none');
      return;
    }
    if (this.state === 'closed') {
      this.mount.showBanner(this.saveErrorMessageFor(id));
      return;
    }
    // Mid-collapse, finish() reports it on the (by then visible) list.
    if (note && this.state !== 'closing' && note.statusKind !== 'empty-error') this.setStatus(note, 'save-error');
  };

  /** The banner's copy for a note's failed save, named by its number and
   *  page — the view that showed it is gone by the time it is read. */
  private saveErrorMessageFor(id: number): string {
    const note = this.notes.get(id);
    if (!note) return SAVE_ERROR_MESSAGE;
    return saveErrorFor(note.page.items.findIndex((it) => it.id === id) + 1, note.page.heading.name);
  }

  private setStatus(note: NoteView, kind: NoteStatus, instant = false): void {
    note.statusKind = kind;
    note.status.dataset.kind = kind;
    const ta = note.textarea;
    // A message under a text area is that text area's description, and the
    // empty-note one says the value is invalid.
    if (kind === 'none') {
      ta.removeAttribute('aria-invalid');
      ta.removeAttribute('aria-describedby');
      fadeTo(note.status, 0, { duration: instant ? 0 : T.errorOut, curve: ACC });
      return;
    }
    if (kind === 'empty-error') ta.setAttribute('aria-invalid', 'true');
    else ta.removeAttribute('aria-invalid');
    ta.setAttribute('aria-describedby', note.status.id);
    note.status.textContent =
      kind === 'save-error' ? SAVE_ERROR_MESSAGE : kind === 'delete-error' ? DELETE_ERROR_MESSAGE : NOTE_REQUIRED_MESSAGE;
    fadeTo(note.status, 1, { duration: instant ? 0 : T.errorIn, curve: STD });
  }

  // ─── "A note can never be empty" (§D, §AH, MOTION_SPEC §11) ──────────────

  private setEmptyError(note: NoteView, on: boolean): void {
    note.textarea.classList.toggle('is-error', on);
    if (on) {
      if (note.statusKind !== 'empty-error') this.setStatus(note, 'empty-error');
      return;
    }
    note.shaken = false;
    if (note.statusKind === 'empty-error') this.setStatus(note, 'none');
  }

  /** Refuse to close while any note (not being deleted) is empty: bring the
   *  first one into view and focus it, shaking it once per emptying. */
  private blockIfEmpty(): boolean {
    if (this.state === 'closing' || this.state === 'closed') return false;
    const empty = this.noteOrder().find((n) => !n.deleting && (this.autosave.draft(n.item.id) ?? '').trim() === '');
    if (!empty) return false;
    this.setEmptyError(empty, true);
    if (!empty.shaken && !this.reduced) {
      // One toned-down shake (±4px, 2 cycles, 200ms ease-in-out — the
      // state-feedback Error Shake at Corporate intensity), never under
      // reduced motion.
      this.shakeAnim?.cancel();
      this.shakeAnim = animateEl(
        empty.textarea,
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
    empty.shaken = true;
    this.revealNote(empty);
    empty.textarea.focus({ preventScroll: true });
    return true;
  }

  // ─── Focus + scrolling ────────────────────────────────────────────────────

  private onFocusIn = (e: FocusEvent): void => {
    const t = e.target;
    if (!(t instanceof Node) || this.state !== 'open') return;
    for (const note of this.notes.values()) {
      if (note.wrap.contains(t)) {
        this.anchorId = note.item.id;
        this.revealNote(note);
        return;
      }
    }
    const page = this.pages.find((p) => p.heading.el.contains(t));
    if (page) this.revealBox(page.part.box);
  };

  /** Scroll just enough to show a note whole (header to text area), with a
   *  margin — the browser's own focus scroll would jump, and land the note
   *  flush against the edge. */
  private revealNote(note: NoteView): void {
    const nl = this.layout.notes.get(note.item.id);
    if (nl) this.revealBox(nl.slot);
  }

  private revealBox(box: Box): void {
    const h = this.scrollerHeight();
    const top = this.scroller.scrollTop;
    let to: number | null = null;
    if (box.y - FOCUS_SCROLL_MARGIN < top) to = box.y - FOCUS_SCROLL_MARGIN;
    else if (box.y + box.h + FOCUS_SCROLL_MARGIN > top + h) {
      to = Math.min(box.y - FOCUS_SCROLL_MARGIN, box.y + box.h + FOCUS_SCROLL_MARGIN - h);
    }
    if (to !== null) this.scrollTo(Math.max(0, to));
  }

  private scrollTo(top: number): void {
    const s = this.scroller;
    if (typeof s.scrollTo === 'function') s.scrollTo({ top, behavior: this.reduced ? 'auto' : 'smooth' });
    else s.scrollTop = top;
  }

  /** ↑/↓ step, the page keys page (keeping PEEK_PX of overlap, like the
   *  opening peek), Home/End go to the ends. False for any other key. */
  private scrollByKey(key: string): boolean {
    const h = this.scrollerHeight();
    const top = this.scroller.scrollTop;
    const max = Math.max(0, this.layout.height - h);
    const page = Math.max(ARROW_SCROLL_PX, h - PEEK_PX);
    const targets: Record<string, number> = {
      ArrowUp: top - ARROW_SCROLL_PX,
      ArrowDown: top + ARROW_SCROLL_PX,
      PageUp: top - page,
      PageDown: top + page,
      Home: 0,
      End: max,
    };
    if (!(key in targets)) return false;
    this.scrollTo(clamp(targets[key], 0, max));
    return true;
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────

  private onKeydown = (e: KeyboardEvent): void => {
    if (this.state === 'closed' || this.state === 'closing') return;
    // Keys that belong to an IME composition (Esc cancels it) aren't ours.
    if (e.isComposing || e.keyCode === 229) return;
    // This runs at window capture, outside the closed root, where
    // composedPath() stops at the host — keyTargetWithin (dom.ts) recovers
    // the key's real target.
    const target = keyTargetWithin(e, this.mount.host, this.mount.shadow);
    const inView = target instanceof Node && this.wrapper.contains(target);
    const renaming = this.pages.find((p) => p.heading.isEditing());
    const textEntry = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;

    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc while renaming a page cancels the rename, and only that.
      if (renaming) renaming.heading.cancel();
      else this.requestCollapse();
      return;
    }
    if (e.key === 'Enter' && renaming && target instanceof HTMLInputElement && renaming.heading.el.contains(target)) {
      e.preventDefault();
      renaming.heading.commit();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // Keyboard isolation stops this event at window capture, so no inner
      // keydown handler (e.g. the list item's, thumbnails.ts) can cancel the
      // native button activation: a repeat Enter on the still-focused list
      // item would reopen the view, auto-repeat on a delete would delete
      // note after note. Cancel activation outside the view, and auto-repeat
      // on anything but a text field — or on anything at all while the view
      // is still opening (the Enter that opened it, held down).
      if (!inView || (e.repeat && (!textEntry || this.state === 'opening'))) e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }
    if (textEntry) return;
    if (this.state === 'open' && this.scrollByKey(e.key)) e.preventDefault();
  };

  /** Tab order is reading order — exit, then per page its heading control
   *  and each note's delete and text area — wrapping, since the view is
   *  modal over the page. */
  private cycleFocus(dir: -1 | 1): void {
    const order: HTMLElement[] = [this.btnExit];
    for (const page of this.pages) {
      order.push(...page.heading.focusables());
      for (const item of page.items) {
        const n = this.notes.get(item.id);
        if (n && !n.deleting) order.push(n.del, n.textarea);
      }
    }
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
      if (this.state === 'closed' || this.state === 'closing') return;
      this.relayout('instant');
      this.setPanelWidth(this.panelW, 0);
    });
  };

  private onReducedChange = (e: MediaQueryListEvent): void => {
    this.reduced = e.matches;
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The scrollbar-excluded viewport (dom.ts's getContentViewportSize) — the
 *  box the docked panel, and so this sheet, is laid out in. */
function viewportSize(): { w: number; h: number } {
  const { width, height } = getContentViewportSize();
  return { w: width, h: height };
}

function zeroBox(): Box {
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** Where a part is right now, in content coordinates: its layout box plus
 *  whatever is left of its FLIP move (analytic, no DOM read). */
function liveBox(part: Part): Box {
  const m = part.move;
  if (!m) return part.box;
  const p = m.duration > 0 ? STD.fn(clamp((now() - m.start) / m.duration, 0, 1)) : 1;
  return { ...part.box, x: part.box.x + (1 - p) * m.dx, y: part.box.y + (1 - p) * m.dy };
}

function fadeInEl(el: HTMLElement, delay: number): void {
  el.style.opacity = '0';
  fadeTo(el, 1, { duration: T.fade, delay, curve: STD });
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
