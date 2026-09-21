// src/sidebar.ts
// The right-docked sidebar shell (REQUIREMENTS §1.1, design spec §3.1).
//
// A full-height panel docked to the right edge that *resizes* the page instead
// of overlaying it (see the PAGE RESIZE section below, unchanged by the
// Salamander restyle). Structure per design spec §3.1:
//   - header row: logo + wordmark, theme toggle, close
//   - action row: primary "add note", secondary export/import icon buttons
//   - notification banner (error/warning, auto-clears)
//   - "this page (n)" heading + note list, or the empty state
//
// This module owns the shell and wiring; src/thumbnails.ts owns the actual
// note-list <li> construction (setThumbnails() below just toggles the
// empty-state/heading and delegates to renderThumbnailList()). It stays
// chrome.runtime-agnostic throughout — content.ts fetches items/wires
// callbacks and calls openEnlargedView() when onOpenItem fires — with the one
// necessary exception of chrome.runtime.getURL() for the theme-dependent logo
// asset, which is guarded the same way theme.ts guards every chrome.* access.
//
// The enlarged view (design spec v2 §D, src/enlargedView.ts) renders inside
// this same shadow root: it is the sidebar itself growing to ~75% of the
// viewport, so this module lends it a mount (its shadow root, docked panel
// and list hooks) and owns its lifetime — see openEnlargedView() below.
//
// Design tokens come from src/theme.ts's --sal-* custom properties
// (getThemeCSS()) rather than any hardcoded palette; registerThemedHost keeps
// this host's data-theme attribute (and therefore every var(--sal-*) below)
// in sync with the user's theme mode for the sidebar's whole lifetime.

import { FeedbackItem } from './types';
import { renderThumbnailList, THUMBNAIL_IMAGE_HEIGHT_PX } from './thumbnails';
import { attachDockMotion, DockMotionHandle } from './dockMotion';
import {
  openEnlargedView as openEnlargedViewImpl,
  ENLARGED_VIEW_CSS,
  EnlargedViewCallbacks,
  EnlargedViewHandle,
  EnlargedViewMount,
} from './enlargedView';
import {
  getThemeCSS,
  registerThemedHost,
  isThemeModeSettled,
  whenThemeModeSettled,
  getThemeMode,
  getResolvedTheme,
  cycleThemeMode,
  subscribeThemeChange,
  ThemeMode,
  ResolvedTheme,
  FOCUS_RING_CSS,
  PRESS_SCALE_CSS,
  STATE_TRANSITION_CSS,
  DISABLED_CSS,
  RADII,
} from './theme';

// ---------------------------------------------------------------------------
// Sidebar width — user-resizable (drag handle on the panel's left edge) and
// persisted, so every consumer must read it *live* via getSidebarWidth()
// rather than importing a constant.
//
// The old fixed `SIDEBAR_WIDTH = 320` export is gone on purpose: the old modal
// (backdrop inset), addMode.ts (selectable bounds) and the page-resize logic
// below all sized themselves off it, and a stale copy of the width in any of
// those places shows up as the sidebar overlapping page UI or a selection
// that can capture a sliver of our own chrome (§6 #2).
//
// Default is the maximum (300px) rather than the old 320px: the drag range is
// capped at 300, and starting at the widest end of the range preserves as much
// of the pre-resize experience as the new clamp allows.
// ---------------------------------------------------------------------------

// SIDEBAR_MIN_WIDTH is now derived from the action row's own metrics, so it
// is declared with them further down (design spec v5 §V).

/** Widest the user can drag the panel — also the default. */
export const SIDEBAR_MAX_WIDTH = 300;
/** Width used before any persisted preference has loaded. */
export const SIDEBAR_DEFAULT_WIDTH = 300;

/** chrome.storage.local key (NOT .session): the width is a durable UI
 *  preference, unlike the per-tab "sidebar is open" flag which is
 *  deliberately session-scoped (§1.1). Content scripts can read and write
 *  chrome.storage.local directly, so this needs no service-worker round trip. */
const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

/** Keyboard resize step for the handle's arrow keys. */
const RESIZE_KEY_STEP = 10;

let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;

/** True once the user has dragged (or arrow-keyed) the handle in this
 *  document. Guards against a slow chrome.storage read landing *after* the
 *  user has already picked a width and snapping the panel back. */
let widthChosenByUser = false;

/** The sidebar's current width in CSS pixels. This is the single source of
 *  truth — enlargedView.ts, addMode.ts and the page-resize logic all call it. */
export function getSidebarWidth(): number {
  return sidebarWidth;
}

/** Clamp to the resizable range, tolerating NaN/Infinity from storage. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
}

/**
 * Resize the panel. Updates the panel's own width, the page shrink (if the
 * sidebar is open) and the `--annotator-sidebar-width` custom property that
 * any shadow tree can read, all in one place.
 *
 * `persist` is false for the live frames of a drag and true once the gesture
 * commits — writing chrome.storage on every mousemove would be pointless I/O.
 */
export function setSidebarWidth(px: number, options: { persist?: boolean } = {}): void {
  const next = clampSidebarWidth(px);
  const changed = next !== sidebarWidth;
  sidebarWidth = next;
  applyWidthToPanel();

  if (changed && savedHtmlDecls !== null) {
    // Sidebar is open, so the page is currently shrunk — re-shrink to match.
    writeManagedProps();
    writeResizeStyleSheet();
    notifyPageOfResize();
  }

  if (options.persist) {
    widthChosenByUser = true;
    persistSidebarWidth(next);
  }
}

function applyWidthToPanel(): void {
  if (elSidebar) {
    elSidebar.style.width = `${sidebarWidth}px`;
    // Responsive layout (design spec §3.1) — driven from here rather than a
    // CSS container query so the same jsdom tests that already exercise
    // every other width-driven behaviour in this module (drag/keyboard
    // resize, persistence) can assert on it directly, with no layout engine
    // required.
    const layout = sidebarLayoutFor(sidebarWidth);
    elSidebar.classList.toggle('is-narrow', layout.narrow);
  }
  if (elResizer) elResizer.setAttribute('aria-valuenow', String(sidebarWidth));
}

function persistSidebarWidth(px: number): void {
  try {
    chrome?.storage?.local?.set({ [SIDEBAR_WIDTH_STORAGE_KEY]: px }, () => {
      // Read lastError so Chrome doesn't log an unchecked-error warning; a
      // failed write only costs the user their width next session.
      void chrome.runtime?.lastError;
    });
  } catch {
    // chrome.storage unavailable (restricted page, torn-down context).
  }
}

function loadPersistedWidth(): void {
  try {
    chrome?.storage?.local?.get(SIDEBAR_WIDTH_STORAGE_KEY, (result) => {
      if (chrome.runtime?.lastError) return;
      if (widthChosenByUser) return; // user already picked one — don't snap back
      const stored = result?.[SIDEBAR_WIDTH_STORAGE_KEY];
      if (typeof stored !== 'number') return;
      setSidebarWidth(stored, { persist: false });
    });
  } catch {
    // chrome.storage unavailable — stay on the default width.
  }
}

export interface SidebarCallbacks {
  /** "add note" button was clicked (design spec v3 §A2: an icon-only toggle
   *  with an attached "keep on" switch). content.ts owns the whole state
   *  machine — single click toggles, a second click within the double-click
   *  window is instead turned into "switch on" by onAddDoubleClick below, and
   *  this sidebar module only ever paints whatever state it's told via
   *  setAddButtonState(). */
  onAdd: () => void;
  /** The "keep add mode on" switch was flipped by the user (design spec v3
   *  §A2). `on` is the switch's *requested* new value; content.ts decides what
   *  that means for add mode and paints the result back through
   *  setAddButtonState(), so the switch never moves on its own.
   *  Optional for the same reason as onAddDoubleClick. */
  onAddSwitchChange?: (on: boolean) => void;
  /** The v2 "lock" gestures, which now simply turn the switch on (design spec
   *  v3 §A2's "Behaviour"): native browser 'dblclick' on the button,
   *  shift+click or shift+Enter/Space — see onAdd.
   *  Optional so callers that never toggle add mode (e.g. other modules'
   *  test doubles) don't have to stub a callback they'll never receive. */
  onAddDoubleClick?: () => void;
  /** "export" header button. No-op for Phase 3 — Phase 8 wires the real zip export. */
  onExport: () => void;
  /** "import" — now the one item of the export group's chevron menu (design
   *  spec v3 §C2) — fired once a file is chosen from the native picker.
   *  content.ts (Phase 9) runs the full §5 validation ladder and the
   *  confirm-then-replace round trip. */
  onImportFile: (file: File) => void;
  /** "close" header button. Fired *after* the sidebar has already hidden
   *  itself and the page layout has been restored — the caller's only job is
   *  to tell the background service worker so it can clear the persisted
   *  per-tab "sidebar open" state (§1.1). */
  onClose: () => void;
  /** A thumbnail was activated (click or Enter/Space) — the caller opens the
   *  enlarged view for this item (openEnlargedView(), design spec v2 §D). */
  onOpenItem: (item: FeedbackItem) => void;
  /** The hover delete on a list item was activated (design spec v4 §L). No
   *  confirmation, exactly like the enlarged view's delete: the caller runs
   *  the same DELETE_ITEM round trip and repaints the list.
   *  Optional for the same reason as onAddDoubleClick — other modules' test
   *  doubles shouldn't have to stub a callback they'll never receive. */
  onDeleteItem?: (item: FeedbackItem) => void;
}

// ---------------------------------------------------------------------------
// Inline currentColor SVG icons — 1.8px stroke, round caps/joins (design
// spec §1's icon language). Fill-based icons are gone with the v1 palette.
// ---------------------------------------------------------------------------

/** Shared attributes for every stroke icon — kept as one string so a change
 *  to the stroke language (weight, cap style) only has to happen once. */
const STROKE_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** "add note" (design spec v3 §A2): a comment bubble rather than the v2 plus,
 *  because the button is now icon-only — a bare plus reads as "add anything",
 *  a bubble reads as "add a note". Rendered at 17px inside the 36px half. */
const ICON_COMMENT = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M20 14a2 2 0 0 1-2 2H8.5L4 19.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></svg>`;

/** Chevron for the export group's menu half (design spec v3 §C2) — 12px at a
 *  heavier 2px stroke so it still reads at that size, and drawn as two
 *  variants rather than a rotation so the open/closed arrow is the exact path
 *  the spec names. */
const CHEVRON_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const ICON_CHEVRON_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" ${CHEVRON_ICON_ATTRS}><path d="M6 9l6 6 6-6"/></svg>`;

const ICON_CHEVRON_UP = `<svg xmlns="http://www.w3.org/2000/svg" ${CHEVRON_ICON_ATTRS}><path d="M6 15l6-6 6 6"/></svg>`;

const ICON_EXPORT = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/></svg>`;

const ICON_IMPORT = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14"/></svg>`;

const ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** Default error-bar icon. Exported so later phases can pass their own to
 *  showError()/showWarning() while still having the default to fall back on. */
export const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;

/** Default warning-bar icon. */
export const ICON_WARNING = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>`;

// ─── Theme toggle icons (design spec §3.4: sun / moon / half-circle) ────────

const ICON_THEME_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4 4.2 19.8M19.8 4.2l-1.4 1.4"/></svg>`;

const ICON_THEME_DARK = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>`;

/** "auto" — a half-filled circle rather than a third distinct glyph, so it
 *  reads as "in between" light and dark at a glance. */
const ICON_THEME_AUTO = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></svg>`;

const THEME_MODE_ICONS: Record<ThemeMode, string> = {
  auto: ICON_THEME_AUTO,
  light: ICON_THEME_LIGHT,
  dark: ICON_THEME_DARK,
};

/** Logo asset paths (design spec §1) — the yellow mark reads on the dark
 *  panel, the black copy on the light one. Both are already
 *  web_accessible_resources in manifest.json. */
const LOGO_PATH_DARK = 'icons/logo-button.svg';
const LOGO_PATH_LIGHT = 'icons/logo-button-black.svg';

/** Guarded chrome.runtime.getURL — mirrors theme.ts's own chrome.* guards
 *  (optional-chained + try/catch) so this behaves the same under jsdom (no
 *  chrome.runtime.getURL mock) as it does in a torn-down content-script
 *  context: quietly falls back to an empty src rather than throwing. */
function extensionUrl(path: string): string {
  try {
    return chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Responsive layout metrics. The CSS below is generated from these, so the
// narrow breakpoint and the minimum width can't drift from what the browser
// actually lays out.
// ---------------------------------------------------------------------------

/** .sidebar's border-left (box-sizing: border-box, so it eats into width). */
const PANEL_BORDER_PX = 1;
/** `.thumbnail-list`'s left+right padding (each side) — see that CSS rule
 *  below. Named so DEFAULT_THUMBNAIL_BOX_SIZE (below) can derive the
 *  thumbnail's width from the exact same number the list is actually padded
 *  with, instead of a second hardcoded copy drifting from the CSS. */
const THUMBNAIL_LIST_PAD_X = 16;

/** The note text's inset inside its hover "extension" background (design
 *  spec v4 §L): the same on all four sides, so the text sits the same
 *  distance below the thumbnail as the background's bottom edge sits below
 *  the last line. Matches radius md, which is the background's own corner
 *  radius — a text inset equal to the corner it sits in. */
const NOTE_INSET_PX = 10;

/** The note-list thumbnail's box size *at the default sidebar width*
 *  (SIDEBAR_DEFAULT_WIDTH): that width minus the panel's left border minus
 *  `.thumbnail-list`'s own left+right padding, by the thumbnail's fixed
 *  height (THUMBNAIL_IMAGE_HEIGHT_PX, src/thumbnails.ts).
 *
 *  Deliberately a fixed constant rather than a live readout of the user's
 *  current (resizable) sidebar width: addMode.ts uses this as the
 *  click-to-place default selection size, and a default that shifted size
 *  every time the sidebar was dragged would be a moving target rather than a
 *  predictable default. It still derives from the same numbers the live
 *  thumbnail box is built from (this module's padding/border constants and
 *  thumbnails.ts's fixed height) rather than a second hardcoded 200x150-style
 *  magic number, so it can't drift from what a thumbnail actually looks like
 *  at the default width. */
export const DEFAULT_THUMBNAIL_BOX_SIZE: { width: number; height: number } = {
  width: SIDEBAR_DEFAULT_WIDTH - PANEL_BORDER_PX - THUMBNAIL_LIST_PAD_X * 2,
  height: THUMBNAIL_IMAGE_HEIGHT_PX,
};

/** Action row side padding (design spec §3.1). One value at every width now
 *  that §V's minimum guarantees the row fits — there is no compact layout to
 *  tighten it for. */
const ACTION_ROW_PAD_X = 16;
const ACTION_ROW_GAP = 8;
/** Every action-row control is 36px tall; the icon halves are 36px square. */
const ACTION_BUTTON_PX = 36;
/** The 1px border each action-row *group* carries (design spec v3 §A2/§C2:
 *  the group owns the fill and the border, its halves are transparent). */
const GROUP_BORDER_PX = 1;
/** The export group's chevron half (§C2). */
const CHEVRON_HALF_PX = 22;
/** The switch's padding either side of its 28px track (§A2). */
const ADD_SWITCH_PAD_X = 10;
/** How far the switch reaches back UNDER the add button — exactly the
 *  button's corner radius (design spec v5 §Q, as refined).
 *
 *  Each half now draws its own border: the button a complete rounded one on
 *  all four sides, the switch one on its top, right and bottom only. Butting
 *  a square-cornered segment against the button's ROUNDED right edge would
 *  leave a crescent-shaped gap at each of those corners, breaking the outer
 *  border into pieces and clipping the switch's hover fill where the curve
 *  falls away. Reaching one radius back under the button fills both
 *  crescents: the button paints above (z-index), so the overlap is hidden and
 *  the only part of the segment on show past the button's silhouette is the
 *  crescent itself. The outer edge then runs unbroken end to end, and the one
 *  curve between the halves is the button's own right border. */
const ADD_SWITCH_TUCK_PX = RADII.md;
const ADD_SWITCH_PAD_LEFT = ADD_SWITCH_TUCK_PX + ADD_SWITCH_PAD_X;
/** The switch's box at full reveal: the tuck, the 28px track and its padding,
 *  and the segment's own right border (the group no longer carries one).
 *  `width: auto` is not animatable and every part is fixed, so the total is
 *  known up front. */
export const ADD_SWITCH_WIDTH_PX =
  ADD_SWITCH_PAD_LEFT + 28 + ADD_SWITCH_PAD_X + GROUP_BORDER_PX;
/** What the reveal actually adds to the group, once the negative margin that
 *  cancels the tuck is taken off — so the group's revealed width is unchanged
 *  by the tuck, and SIDEBAR_MIN_WIDTH below stays honest. */
export const ADD_SWITCH_ADVANCE_PX = ADD_SWITCH_WIDTH_PX - ADD_SWITCH_TUCK_PX;

/** "add note" group at rest, i.e. with the switch collapsed (§A2). */
const ADD_GROUP_PX = ACTION_BUTTON_PX + GROUP_BORDER_PX * 2;
/** export + chevron group (§C2) — one box, two halves. */
const EXPORT_GROUP_PX = ACTION_BUTTON_PX + CHEVRON_HALF_PX + GROUP_BORDER_PX * 2;

/**
 * Narrowest the user can drag the panel (design spec v5 §V): exactly the
 * width the action row needs with the switch REVEALED, so the export group
 * can never be pushed onto a second line at any width that is reachable.
 *
 * Derived, never written out: §Q changed the switch's width, and a literal
 * total would have gone stale silently. It works out at 188px today — above
 * the old 100px floor and below NARROW_WIDTH_BREAKPOINT (220), which is why
 * that one still has work to do.
 */
export const SIDEBAR_MIN_WIDTH =
  PANEL_BORDER_PX +
  ACTION_ROW_PAD_X * 2 +
  ADD_GROUP_PX +
  ADD_SWITCH_ADVANCE_PX +
  ACTION_ROW_GAP +
  EXPORT_GROUP_PX;

/** Below this width the header sheds the wordmark (design spec §3.1's
 *  "narrow widths" rule). It is the width the wordmark needs, not a
 *  re-derivation of the action row: §V's SIDEBAR_MIN_WIDTH already
 *  guarantees the row fits at every reachable width, but at ~190px the
 *  wordmark is down to a couple of ellipsized characters. */
export const NARROW_WIDTH_BREAKPOINT = 220;

/** Width-driven layout classes for a given panel width (pure; applied by
 *  applyWidthToPanel). Only the wordmark responds to width now — §V's
 *  minimum retired the compact layout, whose breakpoint sat below it and
 *  could never match again. */
export function sidebarLayoutFor(width: number): { narrow: boolean } {
  return { narrow: width < NARROW_WIDTH_BREAKPOINT };
}

/** Above every dock-magnified item (dockMotion.ts writes z-index 0–100). */
const RESIZER_Z_INDEX = 101;

// ---------------------------------------------------------------------------
// CSS — Salamander design tokens (src/theme.ts's --sal-* custom properties,
// design spec §1–§3.1). FOCUS_RING_CSS/PRESS_SCALE_CSS/STATE_TRANSITION_CSS/
// DISABLED_CSS are the same shared interaction-state snippets enlargedView.ts and
// addMode.ts already paste in, so all three surfaces feel identical.
// ---------------------------------------------------------------------------

// ─── Motion (design spec v2 §E's curves, reused for these small controls) ───

/** Standard on-screen curve — entrances and state changes. */
const EASE_STD = 'cubic-bezier(.2, 0, 0, 1)';
/** Accelerating curve — exits/fade-outs, which run shorter than entrances. */
const EASE_ACC = 'cubic-bezier(.3, 0, 1, 1)';

/** The "keep on" switch's two reveal states (design spec v3 §A2). Kept as
 *  snippets rather than repeated blocks because several selectors reveal it
 *  (hover, keyboard focus, on, and hover-less pointers).
 *
 *  `transition-delay: 0s` in the shown state is the grace period (§A2 micro
 *  states): the base rule below delays every collapse-ward transition by
 *  ADD_SWITCH_GRACE_MS, so the switch holds open that long after the pointer
 *  leaves and a diagonal path back onto it never loses the target. Revealing
 *  zeroes the delay, so opening is still immediate.
 *
 *  The collapsed box zeroes its BORDER as well as its width: under the global
 *  `box-sizing: border-box` a `width: 0` box still cannot shrink below its own
 *  borders, so leaving the segment's 1px right border in would park a stray
 *  hairline at the button's edge and make the resting group 39px instead of
 *  the 38px the button (36px plus its own two borders) actually occupies. The
 *  negative margin that cancels the tuck only applies while revealed, for the
 *  same reason: collapsed, there is nothing to pull back. */
const ADD_SWITCH_HIDDEN_CSS =
  'width: 0; padding: 0; margin-left: 0; border-width: 0; opacity: 0; visibility: hidden; overflow: hidden;';
const ADD_SWITCH_SHOWN_CSS =
  `width: ${ADD_SWITCH_WIDTH_PX}px; padding: 0 ${ADD_SWITCH_PAD_X}px 0 ${ADD_SWITCH_PAD_LEFT}px; margin-left: -${ADD_SWITCH_TUCK_PX}px; border-width: ${GROUP_BORDER_PX}px; border-left-width: 0; opacity: 1; visibility: visible; overflow: visible; transition-delay: 0s;`;
/** How long the revealed switch holds open after the pointer leaves (§A2). */
const ADD_SWITCH_GRACE_MS = 250;
/** The reveal/collapse itself. */
const ADD_SWITCH_REVEAL_MS = 160;
/** The chevron menu (§C2) floats over the note list, whose dock-magnified
 *  items carry z-index 0–100 (dockMotion.ts); one above the resize handle so
 *  an open menu is never struck through by it either. */
const MENU_Z_INDEX = 102;
/** How far (px) the note list's scrollport extends out over the page so
 *  dock-magnified items aren't clipped at the panel edge (see .body). Worst
 *  case at the 300px maximum width: 0.12 × 268px of scale + 22px of shift −
 *  the list's 16px inset ≈ 38px past the edge, plus the note shadow's blur. */
const DOCK_BLEED_PX = 72;

const SIDEBAR_CSS = `
  :host {
    font-family: var(--sal-font-body);
    font-size: 13px;
    color: var(--sal-text);
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
    /* Starting value only — applyWidthToPanel() writes the live width as an
       inline style once the persisted preference (if any) has loaded. */
    width: ${SIDEBAR_DEFAULT_WIDTH}px;
    background: var(--sal-bg);
    color: var(--sal-text);
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--sal-line);
    /* No heavy shadow (§3.1) — the border-left is the only separation from
       the page. */
    z-index: 2147483645;
    /* Note-list items grow ~1.12x and translate up to -22px past the panel's
       left edge under dock magnification (design spec §4, src/dockMotion.ts);
       nothing along that path may clip them — see .body below for how the
       one scroll container on the path makes room. */
    overflow: visible;
  }
  .sidebar[hidden] { display: none !important; }

  /* ─── Drag handle on the page-facing (left) edge ──────────────────────────
     A 6px hit target so it is actually grabbable, with a 1px hairline that
     is always visible (design spec §3.1) and turns accent on hover/drag/
     focus. role="separator" + tabindex makes it keyboard-operable (arrow
     keys), which a pure mousedown handle would not be.

     The hit target and the hairline are two sibling elements on purpose,
     at different heights in .sidebar's stacking context:
       - .resizer (the hit target) sits above even the most magnified note
         item (dockMotion.ts writes z-index 0–100 on items), so the handle
         is grabbable at every moment — a swollen item crossing the panel
         edge can never cover it. dockMotion.ts treats it as a "hold
         target", so sweeping across its 6px strip doesn't make the swell
         dip and re-grow.
       - .resizer-line (the hairline) sits *below* magnified items at rest,
         so a swollen thumbnail isn't struck through by a 1px rule, and
         rises above them only while the handle is actually in use
         (hover/drag/focus), when the accent line should read. */
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
    z-index: ${RESIZER_Z_INDEX};
  }
  .resizer:focus-visible { outline: none; ${FOCUS_RING_CSS} }
  .resizer-line {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: var(--sal-line);
    pointer-events: none;
    z-index: 1;
    transition: background-color 140ms ease-out;
  }
  .resizer:hover + .resizer-line,
  .resizer.dragging + .resizer-line,
  .resizer:focus-visible + .resizer-line {
    background: var(--sal-accent);
    z-index: ${RESIZER_Z_INDEX};
  }

  /* ─── Header: logo + wordmark, theme toggle, close (§3.1) ────────────── */

  /* No border of its own (design spec v4 §J): the header and the action row
     are one fixed block above the scrolling list, and the single rule under
     that block lives at the bottom of .action-row. */
  .header {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    height: 56px;
    padding: 0 10px 0 16px;
    gap: 10px;
  }

  .logo {
    width: 35px;
    height: 20px;
    flex-shrink: 0;
    display: block;
  }
  .logo img { width: 100%; height: 100%; display: block; }

  /* Pushes the theme toggle + close to the right edge at every width — a
     no-op while the flexible wordmark is showing, and what keeps them from
     drifting left once it hides below the narrow breakpoint. */
  .btn-theme { margin-left: auto; }

  .wordmark {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--sal-font-display);
    font-style: italic;
    font-size: 22px;
    line-height: 1;
    color: var(--sal-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sidebar.is-narrow .wordmark { display: none; }

  /* Ghost buttons: theme toggle + close (design spec §2's "ghost" row). */
  .btn-ghost {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    padding: 0;
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
  .btn-ghost:hover { background: var(--sal-hover); color: var(--sal-text); }
  .btn-ghost:active { background: var(--sal-press); color: var(--sal-text); ${PRESS_SCALE_CSS} }
  .btn-ghost:focus-visible { ${FOCUS_RING_CSS} outline: none; color: var(--sal-text); }
  .btn-ghost[disabled] { ${DISABLED_CSS} }
  .btn-ghost .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-ghost.btn-close .icon { width: 18px; height: 18px; }
  .btn-ghost .icon svg { width: 100%; height: 100%; display: block; }

  /* ─── Action row: "add note" + "keep on" switch, export + chevron menu ──
     design spec v3 §A2 / §C2. Two groups, each one rounded box that carries
     the fill, the border and the interaction states; the halves inside are
     transparent, borderless and never change size. */

  .action-row {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    /* No wrapping: §V made SIDEBAR_MIN_WIDTH the width this row needs with
       the switch revealed, so both groups fit on one line at every width the
       user can drag to and there is no second line to fall to. */
    flex-wrap: nowrap;
    padding: 4px ${ACTION_ROW_PAD_X}px 16px;
    gap: ${ACTION_ROW_GAP}px;
    /* §J: the one divider of the fixed top block, under the whole of it
       (header + action row) rather than between the two. */
    border-bottom: 1px solid var(--sal-line);
  }

  /* ── "add note" + its attached "keep on" switch (§A2) ─────────────────── */

  .add-group {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
    /* Pushes the export group to the row's right edge at every width, and
       keeps it there when the switch's reveal widens this group. */
    margin-right: auto;
    height: ${ACTION_BUTTON_PX}px;
    /* The group is pure layout now (design spec v5 §Q, as refined): no fill
       and no border of its own — each half draws its own, so the button can
       be a complete rounded button and the switch an open-sided extension
       behind it. The radius is kept only so the merged state's focus ring
       (below) takes the shape of the whole control. */
    border-radius: var(--sal-radius-md);
    /* Not clipped: a focus ring sits 4px outside its half. */
    overflow: visible;
    color: var(--sal-text);
    ${STATE_TRANSITION_CSS}
  }
  .add-group.is-on { color: var(--sal-on-accent); }
  .add-group.is-disabled { ${DISABLED_CSS} }

  .btn-add {
    /* Above the switch, so the tucked part of the segment is hidden behind
       this button's own opaque fill and only the crescents either side of its
       rounded right corners show (see ADD_SWITCH_TUCK_PX). The fill has to be
       opaque in every state for that to hold — there is no group fill behind
       it any more. */
    position: relative;
    z-index: 1;
    /* Its own two borders are inside this box (border-box), so the button
       occupies exactly what the bordered group used to: 36px of content. */
    width: ${ADD_GROUP_PX}px;
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    background: var(--sal-surface);
    border: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: inherit;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  /* Per-half hover/press (§A2 micro states), in both the off and the on
     (yellow) group — the .is-on rules outrank the bare ones by specificity. */
  /* The OUTLINE reacts as one, the fill does not: a hover anywhere in the
     group lights both halves' borders, while only the half under the pointer
     takes the fill. Lighting just the hovered half's border leaves the
     control half-outlined — most obviously on the switch, whose border is
     only three sides, so the junction and the whole button stayed at the
     resting colour and the highlight appeared to stop part-way round the
     shape. */
  .add-group:hover .btn-add,
  .add-group:hover .add-switch,
  .add-group:active .btn-add,
  .add-group:active .add-switch { border-color: var(--sal-line-strong); }
  .btn-add:hover { background: var(--sal-hover); }
  .btn-add:active { background: var(--sal-press); }
  .add-group.is-on .btn-add { background: var(--sal-accent); border-color: transparent; }
  .add-group.is-on .btn-add:hover { background: var(--sal-accent-hover); }
  .add-group.is-on .btn-add:active { background: var(--sal-accent-press); }
  /* The ring hugs the focused half rather than the group, so it says which
     of the two Enter will hit (§A2 micro states). Keyboard-only, like every
     other control here. */
  .btn-add:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .btn-add[disabled] { cursor: default; }
  .add-group.is-disabled .btn-add:hover,
  .add-group.is-disabled .btn-add:active {
    background: var(--sal-surface);
    border-color: var(--sal-line);
  }
  .btn-add .icon { width: 17px; height: 17px; flex-shrink: 0; display: inline-flex; }
  .btn-add .icon svg { width: 100%; height: 100%; display: block; }

  /* The switch half. Hidden at rest and revealed on hover / keyboard focus
     anywhere in the group; once ON it is visible in every state (§A2).
     visibility (not just opacity) so Tab can never land on an invisible
     control, and an explicit collapsed/expanded width because width: auto is not
     animatable. */
  .add-switch {
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    display: flex;
    align-items: center;
    /* Bordered on its top, right and bottom only — never on the left, where
       the button's own right border is the single line at the junction. The
       widths live in the hidden/shown snippets so the collapsed box can zero
       them (see ADD_SWITCH_HIDDEN_CSS). */
    border: 0 solid var(--sal-line);
    border-left-width: 0;
    /* Square on the left: that edge is tucked a radius back under the button,
       so the fill reaches around its rounded corners and fills the crescents
       rather than stopping short in a straight line. */
    border-radius: 0 var(--sal-radius-md) var(--sal-radius-md) 0;
    /* Off: neutral segment — it stays neutral even when the button half is
       yellow, and only goes yellow when the switch itself is on (§A2). */
    background: var(--sal-surface);
    color: var(--sal-text);
    cursor: pointer;
    ${ADD_SWITCH_HIDDEN_CSS}
    /* Every collapse-ward transition carries the grace delay; the reveal
       selectors below zero it (see ADD_SWITCH_SHOWN_CSS). visibility is in
       the list so it flips only once the collapse has finished — without it
       the switch would blink out of existence the moment the pointer left,
       taking both the grace period and the animation with it. */
    transition:
      width ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD} ${ADD_SWITCH_GRACE_MS}ms,
      padding ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD} ${ADD_SWITCH_GRACE_MS}ms,
      margin ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD} ${ADD_SWITCH_GRACE_MS}ms,
      border-width ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD} ${ADD_SWITCH_GRACE_MS}ms,
      opacity ${ADD_SWITCH_REVEAL_MS}ms ${EASE_STD} ${ADD_SWITCH_GRACE_MS}ms,
      visibility 0s linear ${ADD_SWITCH_GRACE_MS + ADD_SWITCH_REVEAL_MS}ms,
      background-color 150ms ${EASE_STD} 0s,
      border-color 150ms ${EASE_STD} 0s;
  }
  .add-switch:hover { background: var(--sal-hover); }
  .add-switch:active { background: var(--sal-press); }
  .add-switch:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .add-group.is-disabled .add-switch:hover,
  .add-group.is-disabled .add-switch:active {
    background: var(--sal-surface);
    border-color: var(--sal-line);
  }

  /* Merged (§A2 micro states): with the switch on the two halves are one
     button, so they paint as one. The group has no fill of its own now, so
     both halves take the same yellow and BOTH respond to a hover or press
     anywhere in the group — painting only the half under the pointer would
     put two different yellows side by side in what is meant to be a single
     control. The junction line goes transparent rather than away, so merged
     and split are exactly the same width. Clicking either half means "stop":
     the click handler routes both to the add button's own callback, which
     exits add mode and turns the switch off together. */
  .add-group.is-switch-on .btn-add,
  .add-group.is-switch-on .add-switch {
    background: var(--sal-accent);
    border-color: transparent;
  }
  .add-group.is-switch-on:hover .btn-add,
  .add-group.is-switch-on:hover .add-switch { background: var(--sal-accent-hover); }
  .add-group.is-switch-on:active .btn-add,
  .add-group.is-switch-on:active .add-switch { background: var(--sal-accent-press); }
  /* One control, one ring — on the group, which spans both halves. */
  .add-group.is-switch-on .btn-add:focus-visible { box-shadow: none; }
  .add-group.is-switch-on:has(.btn-add:focus-visible) { ${FOCUS_RING_CSS} }

  /* Reveal (§A2, tightened by v5 §Q): hidden at rest, shown on hover or
     KEYBOARD focus anywhere in the group, and always shown once the switch is
     on — nothing else. :has(:focus-visible) rather than :focus-within,
     because Chrome focuses a button on mouse-down: with :focus-within the
     switch stayed out from the click that started add mode and lingered right
     through it, until the user clicked the page to draw a rect and focus
     finally left. The add button keeps all four of its corners rounded
     throughout — the switch reads as an extension sliding out from behind it,
     not as the right half of a split pill (§A2 micro states). No breakpoint
     suppresses the reveal — §V made the panel's minimum width the width this
     row needs with the switch out, so there is no width at which it does not
     fit. */
  .add-group:hover .add-switch,
  .add-group:has(:focus-visible) .add-switch,
  .add-group.is-switch-on .add-switch { ${ADD_SWITCH_SHOWN_CSS} }

  /* Nothing to hover with, so nothing would ever reveal it: on touch and
     other hover-less pointers the switch is simply always out (§A2 micro
     states). */
  @media (hover: none) {
    .add-switch { ${ADD_SWITCH_SHOWN_CSS} }
  }

  /* The switch's own colours (design spec v4 §P). Each pair either inverts
     with the theme together or is theme-independent, so the knob always
     contrasts with its track in BOTH themes:
       off — track muted, knob surface: muted (#6E6656 / #B3AA96) and
             surface (#FFFFFF / #1D1A13) invert together, so it is a light
             knob in a dark slot on light and a dark knob in a light slot on
             dark. The old lineStrong track was a hairline colour, too close
             to the segment to read as a live control at all.
       on  — track onAccent, knob accent: both are the same value in either
             theme (#1A1712 and #FEC800), so it is a yellow knob in a lit
             slot on the yellow segment everywhere. The old pairing put a
             surface knob on an onAccent track, which in dark theme is
             near-black on black — one unreadable blob. */
  .add-switch-track {
    position: relative;
    width: 28px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 8px;
    background: var(--sal-muted);
    transition: background-color 150ms ${EASE_STD};
  }
  .add-group.is-switch-on .add-switch-track { background: var(--sal-on-accent); }

  .add-switch-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--sal-surface);
    transition: left 150ms ${EASE_STD}, background-color 150ms ${EASE_STD};
  }
  .add-group.is-switch-on .add-switch-knob {
    left: 14px;
    background: var(--sal-accent);
  }

  /* ── export + chevron menu (§C2) ──────────────────────────────────────── */

  .export-group {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
    height: ${ACTION_BUTTON_PX}px;
    border: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    /* The menu hangs out of the bottom of this box. */
    overflow: visible;
    background: var(--sal-surface);
    color: var(--sal-text);
    ${STATE_TRANSITION_CSS}
  }
  /* Hover and press are per half (design spec v4 §K — the same rule §I gives
     the add group): the fill lands on the half actually under the pointer
     (see .btn-export / .btn-menu below) and the group acknowledges with its
     border alone, so hovering the chevron never lights up export.

     Every one of these is scoped to the group's own two halves rather than
     the whole box, because the menu is a child of it: an unscoped :hover
     would light the group up whenever the pointer was merely inside the open
     menu, and an unscoped :active would apply the press scale to the group
     *and* the menu, sliding the item out from under the pointer between
     mousedown and mouseup so the click never landed on it. */
  .export-group:has(> button:hover) { border-color: var(--sal-line-strong); }
  .export-group:has(> button:active) { border-color: var(--sal-line-strong); }
  /* The divider is part of that outline, so it lights with it — otherwise
     the box's edge goes strong while the line down its middle stays at the
     resting colour, which reads as a half-finished highlight (the same fault
     the add group had). */
  .export-group:has(> button:hover) .btn-menu,
  .export-group:has(> button:active) .btn-menu { border-left-color: var(--sal-line-strong); }
  /* The press scale stays on the group (scaling one half alone would tear
     the group's border), and is suppressed while the menu is open — for the
     same reason as above, an open menu must not move under the pointer. */
  .export-group:not(.is-menu-open):has(> button:active) { ${PRESS_SCALE_CSS} }
  .export-group:has(> button:focus-visible) { ${FOCUS_RING_CSS} }
  .export-group.is-disabled { ${DISABLED_CSS} }
  .export-group.is-disabled:has(> button:hover),
  .export-group.is-disabled:has(> button:active) {
    border-color: var(--sal-line);
    transform: none;
  }
  .export-group.is-disabled .btn-export:hover,
  .export-group.is-disabled .btn-export:active,
  .export-group.is-disabled .btn-menu:hover,
  .export-group.is-disabled .btn-menu:active { background: transparent; }
  .export-group.is-disabled:has(> button:hover) .btn-menu,
  .export-group.is-disabled:has(> button:active) .btn-menu { border-left-color: var(--sal-line); }

  .btn-export {
    width: ${ACTION_BUTTON_PX}px;
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    /* One px inside the group's own radius-md, so the halves' corners sit
       flush inside the border rather than crossing it. */
    border-radius: 9px 0 0 9px;
    color: inherit;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  /* §K: the fill lands here, not on the group. */
  .btn-export:hover { background: var(--sal-hover); }
  .btn-export:active { background: var(--sal-press); }
  .btn-export:focus-visible { outline: none; }
  .btn-export[disabled] { cursor: default; }
  .btn-export .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-export .icon svg { width: 100%; height: 100%; display: block; }

  .btn-menu {
    width: ${CHEVRON_HALF_PX}px;
    height: 100%;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-left: ${GROUP_BORDER_PX}px solid var(--sal-line);
    border-radius: 0 9px 9px 0;
    color: var(--sal-muted);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .btn-menu:focus-visible { outline: none; }
  .btn-menu[disabled] { cursor: default; }
  /* Open takes the hover fill so the chevron reads as the active control
     while its menu is down (§C2/§K: the open-menu state keeps its own
     treatment on this half). Written before the :hover/:active rules so the
     equal-specificity press fill still reads while the menu is open. */
  .btn-menu[aria-expanded="true"] { background: var(--sal-hover); }
  /* §K: the fill lands here, not on the group. */
  .btn-menu:hover { background: var(--sal-hover); }
  .btn-menu:active { background: var(--sal-press); }
  .btn-menu .icon { width: 12px; height: 12px; display: inline-flex; }
  .btn-menu .icon svg { width: 100%; height: 100%; display: block; }

  /* The menu itself. Closed is the base state, so this rule carries the
     *exit* timing (90ms, accelerating) and the [data-open] rule below the
     entrance (120ms, standard) — §C2, and the motion language's "entrances
     run 30–50% longer than exits". visibility rather than [hidden] so both
     directions can animate, and so nothing inside is focusable or in the
     accessibility tree while it is invisible. */
  .action-menu {
    position: absolute;
    top: 42px;
    right: 0;
    min-width: 132px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    background: var(--sal-surface);
    box-shadow: var(--sal-shadow-pop);
    z-index: ${MENU_Z_INDEX};
    transform-origin: top right;
    opacity: 0;
    visibility: hidden;
    transform: scale(0.96);
    transition:
      opacity 90ms ${EASE_ACC},
      transform 90ms ${EASE_ACC},
      visibility 0s linear 90ms;
  }
  .action-menu[data-open="true"] {
    opacity: 1;
    visibility: visible;
    transform: scale(1);
    transition:
      opacity 120ms ${EASE_STD},
      transform 120ms ${EASE_STD},
      visibility 0s;
  }

  .action-menu-item {
    height: 32px;
    margin: 0;
    padding: 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--sal-radius-sm);
    color: var(--sal-text);
    font-family: var(--sal-font-body);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .action-menu-item:hover { background: var(--sal-hover); }
  .action-menu-item:focus-visible { background: var(--sal-hover); outline: none; }
  .action-menu-item:active { background: var(--sal-press); }
  .action-menu-item[disabled] { ${DISABLED_CSS} }
  .action-menu-item .icon { width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; }
  .action-menu-item .icon svg { width: 100%; height: 100%; display: block; }

  /* ─── Notification banner (error / warning) — design spec §3.1 ────────
     An inline rounded banner (not the old full-bleed black bar), with a
     subtle bottom progress line standing in for the countdown bar. Only one
     message is ever shown at a time, so a single .warning modifier covers
     both colour variants. */
  .notif {
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
    margin: 0 16px 12px;
    border-radius: var(--sal-radius-md);
    background: var(--sal-danger-soft);
    color: var(--sal-danger);
  }
  .notif.warning { background: var(--sal-warn-soft); color: var(--sal-warn); }
  .notif[hidden] { display: none !important; }

  .notif-progress {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 2px;
    background: currentColor;
    opacity: 0.3;
    transform-origin: left center;
    transform: scaleX(1);
  }
  .notif-progress[hidden] { display: none !important; }

  .notif-row {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    padding: 10px 12px;
    gap: 6px;
  }

  .notif-row .icon {
    width: 16px;
    height: 16px;
    margin-top: 1px;
    flex-shrink: 0;
    display: inline-flex;
  }
  .notif-row .icon svg { width: 100%; height: 100%; display: block; }

  .notif-text {
    font-size: 12.5px;
    line-height: 1.4;
    flex: 1 1 auto;
    word-break: break-word;
  }

  /* The note list's scroll container.

     A scroll container clips on both axes (overflow-x: visible computes to
     auto next to overflow-y: auto), so dock magnification (§4) — which
     swells items up to ~40px past the panel's left edge, plus the note's
     shadow — gets room the other way: the scrollport itself extends
     DOCK_BLEED_PX out over the page (negative margin, matching padding, so
     the content box and list width are unchanged).

     That strip lies over the page, so it must never swallow the page's
     clicks — and the part inside the panel must behave like a normal
     scroller (draggable scrollbar, wheel anywhere scrolls the list). The
     two needs only conflict while something is actually magnified, so the
     body switches between two states, driven by dockMotion.ts's
     onBleedChange (see syncDockMotion):

       - at rest (the normal case): clip-path trims the strip back off.
         clip-path clips hit-testing as well as painting, so the strip is
         simply not part of the scroller — clicks and wheel there go
         straight to the page — while everything inside the panel has
         ordinary pointer events: the scrollbar drags, and wheel over blank
         areas (padding, below a short list) scrolls the list.
       - .is-bleeding (an item is magnified or relaxing back): no clip, so
         swollen items paint un-clipped over the page; the body itself goes
         pointer-events: none (children take events back) so the strip's
         empty parts still pass clicks to the page. Wheel over the items
         still scrolls the body (scroll chaining follows the box tree, not
         hit-testability). This state only lasts while the pointer is on
         the list (plus the ~300ms release), and the pointer can't be on
         the scrollbar *and* the list, so the scrollbar is back to normal
         by the time anyone reaches for it.

     The at-rest clip-path also makes .body a stacking context, which is
     harmless: at rest no item carries a z-index. While bleeding there is no
     clip, so per-item z-indexes compete in .sidebar's context as intended
     (see .resizer). */
  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    margin-left: -${DOCK_BLEED_PX}px;
    padding: 12px 0 16px ${DOCK_BLEED_PX}px;
    clip-path: inset(0 0 0 ${DOCK_BLEED_PX}px);
    transition: opacity 140ms ease-out;
  }
  .body.is-bleeding {
    clip-path: none;
    pointer-events: none;
  }
  .body.is-bleeding > * { pointer-events: auto; }

  /* ─── §H: the sidebar is "on hold" during add mode ─────────────────────
     The note list takes no pointer or keyboard interaction while a selection
     is being placed or a note typed, and is dimmed so the state is legible.
     Dock magnification is switched off through the handle itself (see
     setAddModeHold) rather than fought with CSS, and the list's items are
     also taken out of the tab order in JS — pointer-events: none alone
     would still leave them keyboard-reachable. The header controls and the
     "add note" group are deliberately untouched: the user must always be
     able to stop, change theme or close. */
  .body.is-on-hold { opacity: 0.5; }
  .body.is-on-hold .thumbnail-list,
  .body.is-on-hold .thumbnail,
  .body.is-on-hold .thumbnail-delete { pointer-events: none; }

  .section-heading {
    margin: 0 16px 12px;
    font: 600 12px/1.2 var(--sal-font-body);
    color: var(--sal-muted);
  }
  .section-heading[hidden] { display: none !important; }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
  .empty-state {
    color: var(--sal-muted);
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
    margin-top: 48px;
    padding: 0 24px;
  }
  .empty-state[hidden] { display: none !important; }

  .thumbnail-list {
    list-style: none;
    margin: 0;
    padding: 0 ${THUMBNAIL_LIST_PAD_X}px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: visible;
    /* No isolation here on purpose: the per-item z-index dockMotion.ts
       writes (most magnified on top) has to compete in .sidebar's stacking
       context so a magnified item paints over the resizer *hairline*
       (z-index 1) — but never over the resizer's hit target, which sits
       above every item (RESIZER_Z_INDEX) so the handle stays grabbable. */
  }
  .thumbnail-list[hidden] { display: none !important; }

  /* Dock magnification target (design spec §4): src/dockMotion.ts writes
     transform (translateX/Y + scale), z-index and — only while animating —
     will-change on each <li> from a single rAF spring loop. Right-centre
     origin so items swell out to the left over the page. Deliberately no
     CSS transition on transform here: the spring *is* the easing, and a
     transition would lag every frame behind it. */
  .thumbnail-item {
    position: relative;
    transform-origin: right center;
  }

  /* ─── Note list items (design spec §3.1/§4) ───────────────────────────
     Each item is a real <button> (src/thumbnails.ts) so Enter/Space/click
     all come from native button semantics rather than a hand-rolled
     role="button". No card/box around the item — just the thumbnail image
     and the note text below it.

     Dock magnification (§4) transforms the <li> around this button (see
     .thumbnail-item above), not the button itself, so the button's own
     press/state transitions never fight the spring. */
  .thumbnail {
    display: block;
    width: 100%;
    padding: 0;
    margin: 0;
    border: none;
    background: transparent;
    text-align: left;
    border-radius: var(--sal-radius-md);
    cursor: pointer;
    position: relative;
    ${STATE_TRANSITION_CSS}
  }
  .thumbnail:focus-visible { outline: none; }
  .thumbnail:focus-visible .thumbnail-image-wrap { ${FOCUS_RING_CSS} }

  .thumbnail-image-wrap {
    position: relative;
    width: 100%;
    height: 100px;
    border-radius: var(--sal-radius-md);
    overflow: hidden;
    background: var(--sal-raised);
    line-height: 0;
    /* Radius on all four corners in every state (design spec v2 §B) — this
       rule never changes on hover/focus. Needs an explicit stacking order
       above .thumbnail-note-bg (below): that layer's top edge is tucked up
       *underneath* this box's bottom edge (see .thumbnail-note-bg), and
       without this the two are plain same-context siblings painted in DOM
       order, which would put the note-wrap (later in the DOM) on top and
       show a sliver of it inside the thumbnail. */
    z-index: 1;
  }

  .thumbnail-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .thumbnail-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--sal-radius-sm);
    background: var(--sal-accent);
    color: var(--sal-on-accent);
    font: 600 11px/20px var(--sal-font-mono);
    text-align: center;
  }

  /* No margin of its own (design spec v4 §L). It used to open an 8px gap
     between the thumbnail and the note — but the hover extension's top edge
     is the thumbnail's bottom edge, so that gap fell *inside* the background
     and stacked on top of the note's own 8px padding-top: 16px of visible
     inset above the first line against 8px below the last. The whole inset
     is the note's padding now, and it is the same number on all four
     sides. */
  .thumbnail-note-wrap {
    display: block;
    position: relative;
  }
  /* The note's hover/focus "extension" (design spec v2 §B): a separate layer
     so it can fade on opacity alone, exactly as before — dockMotion.ts still
     only ever touches this element's inline opacity (spring-driven while
     .thumbnail-list carries data-dock="on"; the plain :hover/:focus-visible
     rule below takes over under prefers-reduced-motion), so none of that
     wiring changed. What changed is the box itself: rather than a rectangle
     matching the note text's own area, it starts tucked one radius-md *up*
     under the thumbnail's bottom edge (the wrap has no margin of its own any
     more, §L, so that edge is also the wrap's top — and .thumbnail-image-wrap's
     higher z-index and opaque fill hide the overlap completely) and runs down
     to the note's bottom padding edge — same width as the thumbnail
     throughout, so its edges land exactly flush with the thumbnail's own. Only the bottom
     corners are rounded (the top is hidden under the thumbnail regardless).
     The note text itself never moves between rest and hover — only this
     layer's opacity changes. */
  .thumbnail-note-bg {
    position: absolute;
    left: 0;
    right: 0;
    /* One radius-md up, i.e. entirely under the thumbnail's bottom edge
       (which is now also the wrap's top edge, §L) — far enough that the
       rounded top corners are hidden behind .thumbnail-image-wrap's higher
       z-index and opaque fill. Its visible top edge is therefore the
       thumbnail's, and "bottom: 0" is the note's own bottom padding edge, so
       the background sits NOTE_INSET_PX from the text at both ends. */
    top: calc(-1 * var(--sal-radius-md));
    bottom: 0;
    border-radius: 0 0 var(--sal-radius-md) var(--sal-radius-md);
    background: var(--sal-surface);
    /* Soft outer drop shadow (shadowNote's own, which is identical in both
       themes) plus a 1px line border drawn INSIDE via an inset shadow rather
       than shadowNote's outset ring — an outset ring would bleed half a
       pixel past the thumbnail's own (border-less) edges on each side, and
       v2 §B calls for the two to align exactly. */
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18), inset 0 0 0 1px var(--sal-line);
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms ease-out;
  }
  .thumbnail-list[data-dock="on"] .thumbnail-note-bg { transition: none; }

  .thumbnail-note {
    position: relative;
    margin: 0;
    /* Uniform on all four sides (§L) — the whole of the note's inset, in
       both rest and hover. */
    padding: ${NOTE_INSET_PX}px;
    max-width: 100%;
    border-radius: var(--sal-radius-md);
    background: transparent;
    font-size: 13px;
    line-height: 1.4;
    color: var(--sal-text);
    word-break: break-word;
    /* Clamp to 3 lines (§3.1) rather than letting long notes push the list
       around. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    ${STATE_TRANSITION_CSS}
  }
  .thumbnail-note-empty { color: var(--sal-muted); font-style: italic; }
  /* Reduced-motion (or not-yet-wired) fallback for the note background:
     dockMotion.ts removes data-dock when prefers-reduced-motion is on, and
     then only this static hover/focus state remains (§4). */
  .thumbnail-list:not([data-dock="on"]) .thumbnail:hover .thumbnail-note-bg,
  .thumbnail-list:not([data-dock="on"]) .thumbnail:focus-visible .thumbnail-note-bg {
    opacity: 1;
  }

  /* ─── Delete on hover (design spec v4 §L) ──────────────────────────────
     A sibling of the item's <button class="thumbnail">, not a child of it:
     nested buttons are invalid HTML and break activation, so this sits in
     the <li> and is absolutely positioned over the thumbnail's top-right
     corner (mirroring the number badge's 8px inset on the left).

     It is inside the <li> dockMotion.ts transforms, so it rides the
     magnification with its item for free, and dockMotion fades it on the
     same spring as the note extension (see .thumbnail-note-bg) — hence
     opacity in the transition here, for the reduced-motion/no-dock case
     where the CSS below is the only thing that shows it.

     pointer-events: none while it is faded out is what keeps it out of
     the thumbnail's hit area: an opacity-0 button is still clickable, and
     an invisible delete over every screenshot's corner would be a trap. It
     stays tabbable throughout, though — §L wants it reachable by Tab after
     its own item, and :focus-visible below brings it into view. */
  .thumbnail-delete {
    position: absolute;
    top: 8px;
    right: 8px;
    /* Above .thumbnail-image-wrap's z-index: 1, which is what it overlays. */
    z-index: 2;
    width: 24px;
    height: 24px;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-sm);
    background: var(--sal-surface);
    color: var(--sal-muted);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    /* STATE_TRANSITION_CSS's timings plus the extension's own opacity fade:
       one shorthand, because a second transition declaration would replace
       the first rather than add to it. */
    ${STATE_TRANSITION_CSS.replace(/;$/, ', opacity 140ms ease-out;')}
  }
  .thumbnail-delete .icon { width: 14px; height: 14px; display: inline-flex; }
  .thumbnail-delete .icon svg { width: 100%; height: 100%; display: block; }
  .thumbnail-item:hover .thumbnail-delete,
  .thumbnail-item:focus-within .thumbnail-delete {
    opacity: 1;
    pointer-events: auto;
  }
  .thumbnail-delete:hover { background: var(--sal-danger-soft); color: var(--sal-danger); }
  .thumbnail-delete:active {
    background: var(--sal-danger-press);
    color: var(--sal-danger);
    ${PRESS_SCALE_CSS}
  }
  /* Visible whenever it has focus (§L) — :focus-within above already covers
     this, but the ring must never paint on an invisible control. */
  .thumbnail-delete:focus-visible {
    opacity: 1;
    pointer-events: auto;
    ${FOCUS_RING_CSS}
    outline: none;
  }
  /* While the dock spring owns this element's opacity (inline), the CSS
     transition would fight it frame by frame — same reason .thumbnail-note-bg
     drops its transition. Only the opacity part goes; the fill/border/colour
     states are still the shared ones. */
  .thumbnail-list[data-dock="on"] .thumbnail-delete { ${STATE_TRANSITION_CSS} }

  /* Reduced motion (design spec §4, and v3 §A2/§C2's "reduced motion →
     instant"): every state change added by the action row still *happens*,
     it just happens at once. dockMotion.ts switches itself off separately. */
  @media (prefers-reduced-motion: reduce) {
    .add-switch-track,
    .add-switch-knob,
    .action-menu,
    .action-menu[data-open="true"],
    .body {
      transition: none;
    }
    /* The switch appears and collapses instantly, but the grace period is a
       usability affordance rather than motion — without it the switch would
       vanish the instant the pointer clipped the group's edge on the way to
       it, which is exactly the problem the grace exists to solve. So the
       delay stays and only the animation goes. */
    .add-switch {
      transition: visibility 0s linear ${ADD_SWITCH_GRACE_MS}ms, width 0s linear ${ADD_SWITCH_GRACE_MS}ms, padding 0s linear ${ADD_SWITCH_GRACE_MS}ms, opacity 0s linear ${ADD_SWITCH_GRACE_MS}ms;
    }
    .action-menu { transform: none; }
    .action-menu[data-open="true"] { transform: none; }
  }
`;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let sidebarHost: HTMLDivElement | null = null;
let sidebarShadow: ShadowRoot | null = null;

let elSidebar: HTMLDivElement | null = null;
let elResizer: HTMLDivElement | null = null;
let elLogoImg: HTMLImageElement | null = null;
let elBtnTheme: HTMLButtonElement | null = null;
let elBtnAdd: HTMLButtonElement | null = null;
/** The rounded box holding the "add note" button and its switch — it is the
 *  element that carries the on/off fill, the border and the states (§A2). */
let elAddGroup: HTMLDivElement | null = null;
/** The "keep add mode on" switch (role="switch") attached to elBtnAdd. */
let elAddSwitch: HTMLButtonElement | null = null;
/** Visually-hidden aria-describedby text for elBtnAdd (lock state/hint). */
let elAddDesc: HTMLSpanElement | null = null;
/** The export + chevron box (§C2) — one group, same role as elAddGroup. */
let elExportGroup: HTMLDivElement | null = null;
let elBtnExport: HTMLButtonElement | null = null;
/** The chevron half that opens elActionMenu. */
let elBtnMenu: HTMLButtonElement | null = null;
let elActionMenu: HTMLDivElement | null = null;
/** "import" — the menu's one item today. */
let elBtnImport: HTMLButtonElement | null = null;
let elBtnClose: HTMLButtonElement | null = null;
let elFileInput: HTMLInputElement | null = null;
let elHeading: HTMLHeadingElement | null = null;
let elEmptyState: HTMLParagraphElement | null = null;
let elThumbnailList: HTMLUListElement | null = null;
let elBody: HTMLDivElement | null = null;
/** Dock magnification (design spec §4) for the currently rendered list —
 *  rebuilt on every repaint, torn down on close/destroy (see
 *  syncDockMotion). */
let dockMotion: DockMotionHandle | null = null;
/** Set by content.ts for the whole of add mode (see
 *  setDockMagnificationSuspended). Lives here rather than on the handle
 *  because the handle is rebuilt on every repaint. */
let dockSuspended = false;
/** The enlarged view's own suspension, kept separate from add mode's flag so
 *  neither can lift the other's. */
let enlargedDockSuspended = false;
/** The open enlarged view, if any (one at a time). */
let enlargedView: EnlargedViewHandle | null = null;
/** Items the list is currently rendering — the enlarged view opens on these. */
let currentItems: FeedbackItem[] = [];
/** A list refresh that arrived while the enlarged view was up; applied once
 *  it has closed (repainting under a live morph would swap the very list
 *  thumbnails the clones are about to land on). */
let deferredItems: FeedbackItem[] | null = null;
/** Bumped on every openSidebar/close so a stale theme-settle reveal from an
 *  earlier open can't unhide a panel that has since been re-hidden. */
let revealToken = 0;
let elNotif: HTMLDivElement | null = null;
let elNotifIcon: HTMLSpanElement | null = null;
let elNotifText: HTMLSpanElement | null = null;
let elCountdownBar: HTMLDivElement | null = null;

let callbacksRef: SidebarCallbacks | null = null;
let visible = false;
let notifTimer: ReturnType<typeof setTimeout> | null = null;
/** Unsubscribes this host from theme.ts's mode/resolved-theme change feed
 *  (the theme toggle's icon/label and the logo swap both depend on it). Set
 *  in initSidebar, called from destroySidebar. */
let unsubscribeThemeChange: (() => void) | null = null;

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDOM(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of the sidebar's own CSS so every rule below can reference them.
  // One <style> per shadow root: the enlarged view's rules ride along here
  // since it renders inside this same root.
  style.textContent = getThemeCSS() + '\n' + SIDEBAR_CSS + '\n' + ENLARGED_VIEW_CSS;
  shadow.appendChild(style);

  elSidebar = document.createElement('div');
  elSidebar.className = 'sidebar';
  elSidebar.setAttribute('role', 'complementary');
  elSidebar.setAttribute('aria-label', 'annotator sidebar');
  elSidebar.hidden = true;

  elResizer = document.createElement('div');
  elResizer.className = 'resizer';
  elResizer.setAttribute('role', 'separator');
  elResizer.setAttribute('aria-orientation', 'vertical');
  elResizer.setAttribute('aria-label', 'resize sidebar');
  elResizer.title = 'resize sidebar';
  elResizer.tabIndex = 0;
  elResizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  elResizer.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
  elResizer.setAttribute('aria-valuenow', String(sidebarWidth));

  // Purely visual hairline — a sibling (not ::after) so it can sit below
  // magnified items while the hit target sits above them (see .resizer).
  const resizerLine = document.createElement('div');
  resizerLine.className = 'resizer-line';
  resizerLine.setAttribute('aria-hidden', 'true');

  // ── Header: logo + wordmark, theme toggle, close (design spec §3.1) ──────
  const header = document.createElement('div');
  header.className = 'header';

  const logo = document.createElement('span');
  logo.className = 'logo';
  elLogoImg = document.createElement('img');
  elLogoImg.alt = ''; // decorative — the wordmark carries the name
  elLogoImg.draggable = false;
  logo.appendChild(elLogoImg);

  const wordmark = document.createElement('span');
  wordmark.className = 'wordmark';
  wordmark.textContent = 'salamander';

  elBtnTheme = makeGhostButton(THEME_MODE_ICONS.auto, 'theme: auto', 'btn-theme');
  elBtnClose = makeGhostButton(ICON_CLOSE, 'close sidebar', 'btn-close');

  header.appendChild(logo);
  header.appendChild(wordmark);
  header.appendChild(elBtnTheme);
  header.appendChild(elBtnClose);

  // ── Action row: "add note" + "keep on" switch, export + chevron menu ────
  //    (design spec v3 §A2 / §C2)
  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';

  // "add note" group: an icon-only button with the switch attached to it.
  // Both halves are plain <button>s inside one <div> that owns the visuals,
  // so the group can carry one focus ring, one fill and one press scale.
  elAddGroup = document.createElement('div');
  elAddGroup.className = 'add-group';

  elBtnAdd = makeIconButton(ICON_COMMENT, 'add note', 'btn-add');
  elBtnAdd.setAttribute('aria-pressed', 'false');
  elBtnAdd.setAttribute('aria-describedby', ADD_BUTTON_DESC_ID);

  elAddSwitch = document.createElement('button');
  elAddSwitch.type = 'button';
  elAddSwitch.className = 'add-switch';
  elAddSwitch.setAttribute('role', 'switch');
  elAddSwitch.setAttribute('aria-checked', 'false');
  elAddSwitch.setAttribute('aria-label', ADD_SWITCH_LABEL);
  elAddSwitch.title = ADD_SWITCH_LABEL;
  const switchTrack = document.createElement('span');
  switchTrack.className = 'add-switch-track';
  switchTrack.setAttribute('aria-hidden', 'true');
  const switchKnob = document.createElement('span');
  switchKnob.className = 'add-switch-knob';
  switchTrack.appendChild(switchKnob);
  elAddSwitch.appendChild(switchTrack);

  elAddGroup.appendChild(elBtnAdd);
  elAddGroup.appendChild(elAddSwitch);

  elAddDesc = document.createElement('span');
  elAddDesc.id = ADD_BUTTON_DESC_ID;
  elAddDesc.className = 'sr-only';

  // export group: export, a chevron, and the chevron's menu. The menu lives
  // inside this same (closed) shadow root — there is nowhere else it could
  // go — positioned against the group.
  elExportGroup = document.createElement('div');
  elExportGroup.className = 'export-group';

  elBtnExport = makeIconButton(ICON_EXPORT, 'export feedback', 'btn-export');

  elBtnMenu = makeIconButton(ICON_CHEVRON_DOWN, 'more actions', 'btn-menu');
  elBtnMenu.setAttribute('aria-haspopup', 'menu');
  elBtnMenu.setAttribute('aria-expanded', 'false');

  elActionMenu = document.createElement('div');
  elActionMenu.className = 'action-menu';
  elActionMenu.setAttribute('role', 'menu');
  elActionMenu.setAttribute('aria-label', 'more actions');
  elActionMenu.dataset.open = 'false';

  elBtnImport = makeMenuItem(ICON_IMPORT, 'import');
  elActionMenu.appendChild(elBtnImport);

  elExportGroup.appendChild(elBtnExport);
  elExportGroup.appendChild(elBtnMenu);
  elExportGroup.appendChild(elActionMenu);

  actionRow.appendChild(elAddGroup);
  actionRow.appendChild(elExportGroup);
  actionRow.appendChild(elAddDesc);

  // Notification bar — live region so a screen reader announces errors and
  // warnings that appear without the user having focused anything.
  elNotif = document.createElement('div');
  elNotif.className = 'notif';
  elNotif.setAttribute('role', 'alert');
  elNotif.hidden = true;

  elCountdownBar = document.createElement('div');
  elCountdownBar.className = 'notif-progress';
  elCountdownBar.hidden = true;

  const notifRow = document.createElement('div');
  notifRow.className = 'notif-row';
  elNotifIcon = document.createElement('span');
  elNotifIcon.className = 'icon';
  elNotifIcon.innerHTML = ICON_ERROR;
  elNotifText = document.createElement('span');
  elNotifText.className = 'notif-text';
  notifRow.appendChild(elNotifIcon);
  notifRow.appendChild(elNotifText);

  elNotif.appendChild(notifRow);
  elNotif.appendChild(elCountdownBar);

  const body = document.createElement('div');
  body.className = 'body';
  elBody = body;

  elHeading = document.createElement('h2');
  elHeading.className = 'section-heading';
  elHeading.hidden = true;

  elEmptyState = document.createElement('p');
  elEmptyState.className = 'empty-state';
  elEmptyState.textContent = 'no feedback on this page yet';

  elThumbnailList = document.createElement('ul');
  elThumbnailList.className = 'thumbnail-list';
  elThumbnailList.hidden = true;

  body.appendChild(elHeading);
  body.appendChild(elEmptyState);
  body.appendChild(elThumbnailList);

  elFileInput = document.createElement('input');
  elFileInput.type = 'file';
  elFileInput.accept = '.zip';
  elFileInput.style.display = 'none';

  elSidebar.appendChild(elResizer);
  elSidebar.appendChild(resizerLine);
  elSidebar.appendChild(header);
  elSidebar.appendChild(actionRow);
  elSidebar.appendChild(elNotif);
  elSidebar.appendChild(body);
  elSidebar.appendChild(elFileInput);

  shadow.appendChild(elSidebar);
}

/** Ghost button (theme toggle / close) — transparent at rest, per design
 *  spec §2's "ghost" row. `extraClass` lets the close button size its icon
 *  up to 18px without a whole second button variant. */
function makeGhostButton(svgMarkup: string, ariaLabel: string, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `btn-ghost ${extraClass}` : 'btn-ghost';
  btn.setAttribute('aria-label', ariaLabel);
  btn.title = ariaLabel;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

/** A transparent, borderless icon half of an action-row group (design spec
 *  v3 §A2/§C2): "add note", export and the chevron are all this shape — the
 *  surrounding `.add-group`/`.export-group` owns the fill, the border and the
 *  focus ring, and `className` picks the half's own size/radius rules. */
function makeIconButton(svgMarkup: string, ariaLabel: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', ariaLabel);
  btn.title = ariaLabel;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

/** One row of the chevron menu (§C2): a 16px leading icon plus a visible,
 *  lowercase label. `role="menuitem"` and the roving Tab/arrow behaviour are
 *  wired in initSidebar. */
function makeMenuItem(svgMarkup: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'action-menu-item';
  btn.setAttribute('role', 'menuitem');
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = svgMarkup;
  const text = document.createElement('span');
  text.className = 'menu-item-label';
  text.textContent = label;
  btn.appendChild(icon);
  btn.appendChild(text);
  return btn;
}

/** Reflects the current theme mode onto the toggle's icon + aria-label/title
 *  (design spec §3.4 — "aria-label/title describe the *current* mode"). */
function updateThemeToggleUI(mode: ThemeMode): void {
  if (!elBtnTheme) return;
  const icon = elBtnTheme.querySelector('.icon');
  if (icon) icon.innerHTML = THEME_MODE_ICONS[mode];
  const label = `theme: ${mode}`;
  elBtnTheme.setAttribute('aria-label', label);
  elBtnTheme.title = label;
}

/** The "add note" control's three states. The three values are unchanged
 *  from design spec v2 §A (every content.ts exit path already calls this with
 *  one of them), but 'locked' no longer means "a padlock glyph": per v3 §A2
 *  it paints button-on **and** switch-on. */
export type AddButtonState = 'off' | 'on' | 'locked';

/** aria-label + title per state (§A2). The label is state-dependent here
 *  rather than fixed because the button is icon-only — with no visible text,
 *  the accessible name is the only place "on"/"kept on" can be read out. */
const ADD_BUTTON_LABELS: Record<AddButtonState, string> = {
  off: 'add note',
  on: 'add note (on)',
  locked: 'add note (kept on)',
};

/** Screen-reader description (aria-describedby) per state: what the switch
 *  beside the button is doing, and how to reach it from the keyboard. */
const ADD_BUTTON_DESCRIPTIONS: Record<AddButtonState, string> = {
  off: 'shift+enter keeps add mode on',
  on: 'shift+enter keeps add mode on',
  locked: 'kept on: stays on after each note',
};

const ADD_BUTTON_DESC_ID = 'add-note-desc';

/** The switch's own accessible name/tooltip (§A2) — fixed, since its state
 *  is carried by aria-checked. */
const ADD_SWITCH_LABEL = 'keep add mode on';

/**
 * Paint the "add note" group for `state` (design spec v3 §A2):
 *   - 'off'    group neutral, `aria-pressed="false"`, switch off
 *   - 'on'     group accent, `aria-pressed="true"`, switch off
 *   - 'locked' group accent, `aria-pressed="true"`, switch ON (and therefore
 *              visible in every state, not just on hover/focus)
 *
 * content.ts is the only caller: it owns the real add-mode/switch state and
 * calls this on every transition, so neither half can drift from what add
 * mode is actually doing.
 */
export function setAddButtonState(state: AddButtonState): void {
  if (!elBtnAdd || !elAddGroup) return;
  const isOn = state !== 'off';
  const keepOn = state === 'locked';
  elAddGroup.classList.toggle('is-on', isOn);
  elAddGroup.classList.toggle('is-switch-on', keepOn);
  elBtnAdd.setAttribute('aria-pressed', String(isOn));
  elBtnAdd.setAttribute('aria-label', ADD_BUTTON_LABELS[state]);
  elBtnAdd.title = ADD_BUTTON_LABELS[state];
  elAddSwitch?.setAttribute('aria-checked', String(keepOn));
  // Merged: while the switch is on the group is one button, so it is one tab
  // stop too — the button half carries it, and both halves do the same thing
  // (§A2 micro states). The switch stays in the accessibility tree, checked,
  // so its state is still announced.
  if (elAddSwitch) {
    if (keepOn) elAddSwitch.setAttribute('tabindex', '-1');
    else elAddSwitch.removeAttribute('tabindex');
  }
  if (elAddDesc) elAddDesc.textContent = ADD_BUTTON_DESCRIPTIONS[state];
}

/** Swaps the logo asset for the resolved theme (design spec §1: yellow mark
 *  on dark, black copy on light). */
function updateLogoForTheme(resolved: ResolvedTheme): void {
  if (!elLogoImg) return;
  elLogoImg.src = extensionUrl(resolved === 'dark' ? LOGO_PATH_DARK : LOGO_PATH_LIGHT);
  enlargedView?.setLogoSrc(elLogoImg.src);
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
  // Keeps `data-theme` on the shadow host in sync with the resolved
  // light/dark theme for the sidebar's whole lifetime (it's never torn down
  // and rebuilt like addMode.ts, so there's no matching unregister
  // call here).
  registerThemedHost(sidebarHost);

  buildDOM(sidebarShadow);

  elSidebar!.style.pointerEvents = 'auto';

  elBtnAdd!.addEventListener('click', (e) => {
    e.stopPropagation();
    // Shift+click: the single-gesture (and keyboard, below) twin of the
    // double-click lock.
    if (e.shiftKey) callbacksRef?.onAddDoubleClick?.();
    else callbacksRef?.onAdd();
  });
  elBtnAdd!.addEventListener('keydown', (e) => {
    if (!e.shiftKey || (e.key !== 'Enter' && e.key !== ' ')) return;
    // Shift+Enter / Shift+Space lock too. preventDefault cancels the native
    // activation, so no plain click follows to toggle it straight back off.
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) callbacksRef?.onAddDoubleClick?.();
  });
  elBtnAdd!.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    // Not every browser treats a button as a natural double-click target
    // for text selection, but pointer-down text selection can still occur
    // on the icon — suppress it so a rapid double-click reads as a clean
    // "keep on" gesture rather than also selecting something.
    e.preventDefault();
    callbacksRef?.onAddDoubleClick?.();
  });

  // The switch reports the value the user asked for; content.ts decides what
  // that does to add mode and paints the result back (§A2).
  //
  // Except once it is on: the divider goes, the two halves merge into a
  // single yellow control, and a click anywhere on it means "stop" (§A2
  // micro states). Routing that through the button's own callback rather
  // than reporting `false` here is what makes the merged control honest —
  // onAdd while the switch is on exits add mode AND turns the switch off,
  // whereas onAddSwitchChange(false) would leave add mode running.
  elAddSwitch!.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = elAddSwitch!.getAttribute('aria-checked') !== 'true';
    if (!on) {
      callbacksRef?.onAdd();
      return;
    }
    callbacksRef?.onAddSwitchChange?.(true);
  });

  elBtnExport!.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacksRef?.onExport();
  });

  // ── chevron menu (§C2) ────────────────────────────────────────────────
  elBtnMenu!.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOpen) {
      closeActionMenu();
      return;
    }
    // A keyboard activation (Enter/Space) reports detail 0, a real pointer
    // click reports ≥1 — the spec only wants focus pulled into the menu for
    // the former ("open via keyboard focuses the first item").
    openActionMenu({ focusFirstItem: e.detail === 0 });
  });
  elBtnMenu!.addEventListener('keydown', (e) => {
    // Esc closes a menu opened by pointer, where focus is still on the
    // chevron rather than inside the menu (§C2's "Esc" applies either way).
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeActionMenu();
      return;
    }
    // ArrowDown/Up open the menu straight into its first item, the usual
    // menu-button convention.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    openActionMenu({ focusFirstItem: true });
  });

  elActionMenu!.addEventListener('keydown', onActionMenuKeyDown);

  elBtnImport!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeActionMenu();
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

  elBtnTheme!.addEventListener('click', (e) => {
    e.stopPropagation();
    updateThemeToggleUI(cycleThemeMode());
  });

  elResizer!.addEventListener('mousedown', onResizerMouseDown);
  elResizer!.addEventListener('keydown', onResizerKeyDown);

  // "Outside pointerdown closes the menu" (§C2) needs two listeners, because
  // this shadow root is *closed*: an event raised inside it retargets to the
  // host by the time it reaches the document, and composedPath() is
  // truncated for listeners outside the tree. So the shadow root itself sees
  // everything inside the sidebar, and the document listener handles the
  // host page (where every one of our events looks like `sidebarHost`).
  sidebarShadow.addEventListener('pointerdown', onShadowPointerDown, true);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);

  // Theme (design spec §3.4): paint the toggle/logo for whatever mode is
  // already resolved (a fresh 'auto' default, or a mode already restored
  // from chrome.storage.local by the time this host is built), then stay
  // live for every future change — this surface's own cycleThemeMode()
  // click above, another tab's chrome.storage.onChanged write, or (in
  // 'auto' mode) the OS flipping light/dark.
  updateThemeToggleUI(getThemeMode());
  updateLogoForTheme(getResolvedTheme());
  unsubscribeThemeChange = subscribeThemeChange((mode, resolved) => {
    updateThemeToggleUI(mode);
    updateLogoForTheme(resolved);
  });

  // "add note" starts off (design spec v3 §A2) — content.ts moves it to
  // on/locked as the real add-mode state changes. The switch does not
  // persist: it resets to off per page session, like the old lock.
  setAddButtonState('off');

  applyWidthToPanel();
  loadPersistedWidth();
}

// ---------------------------------------------------------------------------
// The export group's chevron menu (design spec v3 §C2)
//
// Lives inside the sidebar's own closed shadow root — there is nowhere else
// it could go — and is shown/hidden via a `data-open` attribute so the CSS
// owns both the entrance and the (shorter) exit. Nothing inside it is
// focusable while it is closed: the closed rule is `visibility: hidden`.
// ---------------------------------------------------------------------------

let menuOpen = false;

function openActionMenu(options: { focusFirstItem?: boolean } = {}): void {
  if (!elActionMenu || !elBtnMenu || menuOpen || elBtnMenu.disabled) return;
  menuOpen = true;
  elActionMenu.dataset.open = 'true';
  elExportGroup?.classList.add('is-menu-open');
  elBtnMenu.setAttribute('aria-expanded', 'true');
  setChevronIcon(true);
  if (options.focusFirstItem) menuItems()[0]?.focus();
}

/**
 * Close the menu. `returnFocus` hands focus back to the chevron, which is
 * right for Esc (§C2) and wrong for an outside click — the user has already
 * aimed somewhere else, and stealing focus back would fight them.
 */
function closeActionMenu(options: { returnFocus?: boolean } = {}): void {
  if (!elActionMenu || !elBtnMenu || !menuOpen) return;
  menuOpen = false;
  elActionMenu.dataset.open = 'false';
  elExportGroup?.classList.remove('is-menu-open');
  elBtnMenu.setAttribute('aria-expanded', 'false');
  setChevronIcon(false);
  if (options.returnFocus) elBtnMenu.focus();
}

function setChevronIcon(open: boolean): void {
  const icon = elBtnMenu?.querySelector('.icon');
  if (icon) icon.innerHTML = open ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN;
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(elActionMenu?.querySelectorAll<HTMLButtonElement>('.action-menu-item:not([disabled])') ?? []);
}

/** Up/Down move between items (wrapping), Esc closes and returns focus to
 *  the chevron, Tab closes and lets focus move on normally (§C2). */
function onActionMenuKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeActionMenu({ returnFocus: true });
    return;
  }
  if (e.key === 'Tab') {
    closeActionMenu();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = menuItems();
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  // ShadowRoot.activeElement, not document.activeElement — the latter only
  // ever reports the host for anything focused inside a closed root.
  const current = items.indexOf(sidebarShadow?.activeElement as HTMLButtonElement);
  const from = current >= 0 ? current : 0;
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  items[(from + delta + items.length) % items.length].focus();
}

/** Pointerdown anywhere inside the sidebar's shadow tree: close unless it
 *  landed on the menu itself or on the chevron (whose own click handler
 *  toggles). */
function onShadowPointerDown(e: Event): void {
  if (!menuOpen || !elActionMenu || !elBtnMenu) return;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.includes(elActionMenu) || path.includes(elBtnMenu)) return;
  closeActionMenu();
}

/** Pointerdown on the host page (or in another extension surface). Anything
 *  raised inside our closed root arrives here retargeted to the host, and is
 *  already handled by onShadowPointerDown. */
function onDocumentPointerDown(e: Event): void {
  if (!menuOpen) return;
  if (e.target === sidebarHost) return;
  closeActionMenu();
}

// ---------------------------------------------------------------------------
// Resize gesture (§ enhancement: user-resizable sidebar)
//
// Mouse events rather than Pointer Events on purpose: the whole gesture has to
// keep tracking once the cursor leaves our shadow root and moves over the
// page, and window-level mousemove/mouseup listeners installed for the
// duration of the drag do that in every browser this runs in (and in jsdom, so
// the behaviour is testable). Pointer capture would work too but is not
// implemented in jsdom, which would leave the whole feature untested.
//
// Limitation shared with every drag implementation on the web: if the cursor
// crosses into a cross-origin iframe mid-drag, the page stops delivering
// mousemove to us and the width freezes until the cursor comes back out. The
// mouseup listener is on window with capture so the gesture still ends
// cleanly.
// ---------------------------------------------------------------------------

let resizeDragging = false;
/** Distance between the cursor and the panel's left edge when the drag began,
 *  so the panel does not jump by up to the handle's own width on grab. */
let resizeGrabOffset = 0;

/** The viewport's right edge in client coordinates. `documentElement.clientWidth`
 *  excludes the document's vertical scrollbar, which is exactly where the
 *  `position: fixed; right: 0` panel starts — `innerWidth` would include it and
 *  make every dragged width ~15px too small. Falls back to innerWidth where
 *  clientWidth is unavailable (jsdom reports 0: no layout engine). */
function viewportRightEdge(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

function onResizerMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  // Stops the page starting a text selection under the cursor for the whole
  // drag, and stops the click reaching page handlers behind the handle.
  e.preventDefault();
  e.stopPropagation();
  if (resizeDragging) return;
  resizeDragging = true;
  resizeGrabOffset = viewportRightEdge() - e.clientX - sidebarWidth;
  elResizer?.classList.add('dragging');
  window.addEventListener('mousemove', onResizeDragMove, true);
  window.addEventListener('mouseup', onResizeDragEnd, true);
}

function onResizeDragMove(e: MouseEvent): void {
  if (!resizeDragging) return;
  setSidebarWidth(viewportRightEdge() - e.clientX - resizeGrabOffset);
}

function onResizeDragEnd(): void {
  if (!resizeDragging) return;
  endResizeDrag();
  // Commit: one storage write per gesture, not one per frame.
  setSidebarWidth(sidebarWidth, { persist: true });
}

function endResizeDrag(): void {
  resizeDragging = false;
  elResizer?.classList.remove('dragging');
  window.removeEventListener('mousemove', onResizeDragMove, true);
  window.removeEventListener('mouseup', onResizeDragEnd, true);
}

/** Keyboard equivalent of the drag: left grows the panel (it grows leftwards,
 *  into the page), right shrinks it. Home/End jump to the extremes. */
function onResizerKeyDown(e: KeyboardEvent): void {
  let next: number | null = null;
  if (e.key === 'ArrowLeft') next = sidebarWidth + RESIZE_KEY_STEP;
  else if (e.key === 'ArrowRight') next = sidebarWidth - RESIZE_KEY_STEP;
  else if (e.key === 'Home') next = SIDEBAR_MAX_WIDTH;
  else if (e.key === 'End') next = SIDEBAR_MIN_WIDTH;
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  setSidebarWidth(next, { persist: true });
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
  revealWhenThemeSettled();
  applyPageResize();
  syncDockMotion();
}

/** Longest the panel stays invisible waiting for the persisted theme mode
 *  (chrome.storage.local is normally a few ms; this only caps a pathological
 *  read so opening the sidebar can never hang on it). */
const THEME_REVEAL_TIMEOUT_MS = 150;

/** Avoid a wrong-theme flash on first open: the stored themeMode is read
 *  asynchronously, so until that first read settles the panel would paint
 *  in the 'auto' default and then flip. Keep it laid out (the page shrink
 *  still applies, so nothing jumps) but visibility: hidden until the read
 *  settles or THEME_REVEAL_TIMEOUT_MS passes, whichever is first. Every
 *  later open is instant: the read has long since settled. */
function revealWhenThemeSettled(): void {
  const token = ++revealToken;
  if (!elSidebar || isThemeModeSettled()) {
    if (elSidebar) elSidebar.style.visibility = '';
    return;
  }
  elSidebar.style.visibility = 'hidden';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reveal = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (token !== revealToken || !elSidebar) return;
    elSidebar.style.visibility = '';
  };
  timer = setTimeout(reveal, THEME_REVEAL_TIMEOUT_MS);
  void whenThemeModeSettled().then(reveal);
}

/** Hide the sidebar and restore the page's original layout exactly as it was
 *  before openSidebar() ran. Safe to call when already closed. */
export function closeSidebar(): void {
  // The enlarged view can't outlive the panel it grew from. Callers that
  // must honour the empty-note lock (content.ts's toggle) ask
  // collapseEnlargedView() first; this is the unconditional backstop.
  enlargedView?.forceClose();
  // §C2: the menu closes when the sidebar closes — a panel that reopened
  // with a menu already down would be a surprise, and nothing in a hidden
  // panel should stay in the accessibility tree.
  closeActionMenu();
  revealToken++;
  if (elSidebar) {
    elSidebar.hidden = true;
    elSidebar.style.visibility = '';
  }
  visible = false;
  syncDockMotion();
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
  exportEnabled = enabled;
  syncActionAvailability();
}

/** Disable/enable the import header button (Phase 9, §1.7). Mirrors
 *  setExportButtonEnabled: parsing + validating a zip and the confirm-then-
 *  replace round trip is asynchronous with no other on-screen affordance, so
 *  content.ts disables this for the duration to prevent a second file pick
 *  from overlapping the first. */
export function setImportButtonEnabled(enabled: boolean): void {
  importEnabled = enabled;
  syncActionAvailability();
}

// ---------------------------------------------------------------------------
// Availability of the action row's controls
//
// Three independent reasons a control can be off, so they are tracked
// separately and resolved in one place rather than by whoever wrote last:
//   - an export round trip is in flight (setExportButtonEnabled)
//   - an import round trip is in flight (setImportButtonEnabled)
//   - add mode is active, so the sidebar is "on hold" (setAddModeHold, §H)
// ---------------------------------------------------------------------------

let exportEnabled = true;
let importEnabled = true;
/** True for the whole of add mode (design spec v3 §H). */
let addModeHold = false;

function syncActionAvailability(): void {
  // §H disables the whole export group; an in-flight export only disables
  // the half that would start a second one.
  if (elBtnExport) elBtnExport.disabled = addModeHold || !exportEnabled;
  if (elBtnMenu) elBtnMenu.disabled = addModeHold;
  if (elBtnImport) elBtnImport.disabled = !importEnabled;
  elExportGroup?.classList.toggle('is-disabled', addModeHold);
}

/**
 * Put the sidebar "on hold" for the duration of add mode (design spec v3
 * §H): the note list stops taking pointer and keyboard input and dims to
 * ~0.5, dock magnification is switched off at the handle (rather than fought
 * with CSS — magnified items also bleed out over the page add mode is about
 * to screenshot), and the export + chevron group is disabled with its menu
 * closed. The "add note" group, the theme toggle and close deliberately stay
 * live: the user must always be able to stop, change theme or close.
 *
 * Idempotent, and everything it touches is restored by the same call with
 * `false` — which every one of content.ts's add-mode exit paths makes.
 */
export function setAddModeHold(hold: boolean): void {
  addModeHold = hold;
  if (hold) closeActionMenu();
  elBody?.classList.toggle('is-on-hold', hold);
  syncActionAvailability();
  applyListHold();
  setDockMagnificationSuspended(hold);
}

/** Take the list's items out of the tab order while on hold (and put them
 *  back after). `pointer-events: none` covers the mouse but leaves a button
 *  perfectly reachable with Tab, so this is the other half of §H's "list
 *  items not tabbable". Re-applied after every repaint — renderItems() calls
 *  it — since a fresh list starts with default tabindexes.
 *
 *  Covers each item's hover delete (design spec v4 §L) as well as the
 *  thumbnail itself: it is a second real button in the same <li>, so it
 *  needs the same treatment or add mode would leave a live "delete" one Tab
 *  away from a held list. */
function applyListHold(): void {
  if (!elThumbnailList) return;
  const held = elThumbnailList.querySelectorAll<HTMLButtonElement>('button.thumbnail, button.thumbnail-delete');
  for (const btn of Array.from(held)) {
    if (addModeHold) btn.setAttribute('tabindex', '-1');
    else btn.removeAttribute('tabindex');
  }
}

/**
 * Repaint the thumbnail list for whatever items content.ts fetched for the
 * current URL (§1.5 — "current URL only"; newest-at-the-bottom is the
 * caller's responsibility, since storage.ts's getPageItems already returns
 * capture order). Shows the empty state (§3.1's "no feedback on this page
 * yet") when `items` is empty. content.ts calls this after every
 * GET_PAGE_ITEMS round trip: on open, on SPA navigation, and after a
 * successful capture or an enlarged-view close (edit/delete). While the
 * enlarged view is open the repaint is deferred until it closes.
 */
export function setThumbnails(items: FeedbackItem[]): void {
  if (enlargedView) {
    deferredItems = items;
    return;
  }
  renderItems(items);
}

function renderItems(items: FeedbackItem[]): void {
  if (!elEmptyState || !elThumbnailList || !elHeading || !callbacksRef) return;
  currentItems = items.slice();
  if (items.length === 0) {
    elHeading.hidden = true;
    elEmptyState.hidden = false;
    elThumbnailList.hidden = true;
    elThumbnailList.innerHTML = '';
    syncDockMotion();
    return;
  }
  // "this page (n)" (design spec §3.1) — only ever shown alongside the list,
  // never alongside the empty state.
  elHeading.textContent = `this page (${items.length})`;
  elHeading.hidden = false;
  elEmptyState.hidden = true;
  elThumbnailList.hidden = false;
  // Tear the old motion layer down *before* the repaint so it releases the
  // outgoing <li>s, then attach a fresh one to the new ones.
  dockMotion?.destroy();
  dockMotion = null;
  renderThumbnailList(elThumbnailList, items, {
    onOpen: (item) => {
      // A stray activation of the (hidden, inert-to-be) list while the view
      // is expanding or open — e.g. a native click from a repeated Enter on
      // the item that opened it — must not reopen/force-close it.
      const state = enlargedView?.getState();
      if (state === 'opening' || state === 'open') return;
      callbacksRef?.onOpenItem(item);
    },
    onDelete: (item) => {
      // Same two guards as onOpen, for the same reasons: §H holds the whole
      // list inert for the duration of add mode, and the enlarged view owns
      // the list's items while it is up. Deleting behind the user's back
      // would be worse than opening behind it.
      if (addModeHold) return;
      const state = enlargedView?.getState();
      if (state === 'opening' || state === 'open') return;
      callbacksRef?.onDeleteItem?.(item);
    },
  });
  // A fresh list starts with default tabindexes — re-assert the §H hold if
  // one is in force (e.g. a repaint after a capture while add mode stays on).
  applyListHold();
  syncDockMotion();
}

/** Move keyboard focus to the thumbnail for item `id`, if it is currently
 *  rendered. content.ts calls this after the enlarged view closes (and the
 *  list has been repainted) so focus returns to where it came from rather
 *  than falling back to <body>. Returns false if there's no such item (e.g.
 *  it was just deleted). */
export function focusThumbnail(id: number): boolean {
  if (!visible || !elThumbnailList) return false;
  const btn = elThumbnailList.querySelector<HTMLButtonElement>(`button.thumbnail[data-item-id="${id}"]`);
  if (!btn) return false;
  btn.focus();
  return true;
}

/** Keep exactly one dock-motion layer alive while the sidebar is visible and
 *  showing items, and none otherwise (so a closed sidebar holds no rAF,
 *  listeners or matchMedia subscription). */
function syncDockMotion(): void {
  const wanted = visible && !!elThumbnailList && !elThumbnailList.hidden && elThumbnailList.children.length > 0;
  if (wanted && !dockMotion && elThumbnailList) {
    dockMotion = attachDockMotion(elThumbnailList, {
      scrollContainer: elBody,
      // See .body's CSS: the scroller only paints (and stops taking pointer
      // events) over the page while something is actually magnified.
      onBleedChange: (bleeding) => elBody?.classList.toggle('is-bleeding', bleeding),
      holdTargets: elResizer ? [elResizer] : [],
    });
    if (dockSuspended || enlargedDockSuspended) dockMotion.setSuspended(true);
  } else if (!wanted && dockMotion) {
    dockMotion.destroy();
    dockMotion = null;
  }
}

/**
 * Suspend (true) / resume (false) the note list's dock magnification.
 * setAddModeHold() (design spec v3 §H) drives this for the whole of add
 * mode: magnified items grow out past the panel's left edge over the page,
 * and add mode's screenshot is of the page — so nothing of ours may bleed
 * there while a selection is being made or captured. Suspending snaps the
 * list back to rest instantly (no release animation, no pending frame), and
 * the flag survives list repaints and close/reopen until it is lifted.
 * Exported separately so a caller can suspend magnification *without* the
 * rest of the hold.
 */
export function setDockMagnificationSuspended(suspended: boolean): void {
  dockSuspended = suspended;
  dockMotion?.setSuspended(dockSuspended || enlargedDockSuspended);
}

// ---------------------------------------------------------------------------
// Enlarged view (design spec v2 §D, src/enlargedView.ts)
// ---------------------------------------------------------------------------

function enlargedMount(): EnlargedViewMount | null {
  if (!sidebarHost || !sidebarShadow || !elSidebar) return null;
  return {
    host: sidebarHost,
    shadow: sidebarShadow,
    sidebarEl: elSidebar,
    getSidebarWidth: () => sidebarWidth,
    getListLayout: () => sidebarLayoutFor(sidebarWidth),
    getLogoSrc: () => elLogoImg?.src ?? '',
    getListThumb: (id) =>
      elThumbnailList?.querySelector<HTMLElement>(`button.thumbnail[data-item-id="${id}"] .thumbnail-image-wrap`) ?? null,
    getListViewport: () => elBody?.getBoundingClientRect() ?? null,
    centreListOn: (id) => {
      const li = elThumbnailList?.querySelector(`button.thumbnail[data-item-id="${id}"]`)?.closest('li');
      if (!li || !elBody) return;
      const b = elBody.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      elBody.scrollTop += r.top + r.height / 2 - (b.top + b.height / 2);
    },
    renderList: (items) => renderItems(items),
    setDockSuspended: (suspended) => {
      enlargedDockSuspended = suspended;
      dockMotion?.setSuspended(dockSuspended || enlargedDockSuspended);
    },
    focusListItem: (id) => focusThumbnail(id),
    focusFallback: () => {
      if (visible) elBtnAdd?.focus({ preventScroll: true });
    },
    showBanner: (message) => showError(message),
  };
}

/**
 * Expand the sidebar into the enlarged view on item `itemId` (one of the
 * items the list is showing). Replaces any view already open. Returns false
 * if the sidebar isn't showing that item.
 */
export function openEnlargedView(itemId: number, callbacks: EnlargedViewCallbacks): boolean {
  if (!visible) return false;
  enlargedView?.forceClose();
  const mount = enlargedMount();
  const index = currentItems.findIndex((i) => i.id === itemId);
  if (!mount || index < 0) return false;
  let handle: EnlargedViewHandle | null = null;
  handle = openEnlargedViewImpl(mount, currentItems, index, {
    ...callbacks,
    onClosed: (id) => {
      if (enlargedView === handle) enlargedView = null;
      // Dropped, not applied: a refresh that started before the view's own
      // edits/deletes would repaint over the (correct) list the view just
      // handed back — a deleted note flashing back in — and wipe the focus
      // it restored. onClosed re-reads storage anyway (content.ts).
      deferredItems = null;
      callbacks.onClosed(id);
    },
  });
  if (handle.getState() !== 'closed') enlargedView = handle;
  return true;
}

export function isEnlargedViewOpen(): boolean {
  return enlargedView !== null;
}

/**
 * Collapse the enlarged view, if open. `force` bypasses the empty-note lock
 * (add mode, navigation); otherwise returns false when the lock refused
 * (the view is then showing its inline error). `immediate` skips the
 * animation (e.g. the sidebar is about to close anyway).
 */
export function collapseEnlargedView(opts: { immediate?: boolean; force?: boolean } = {}): boolean {
  if (!enlargedView) return true;
  if (opts.force) {
    enlargedView.forceClose();
    return true;
  }
  return enlargedView.requestCollapse({ immediate: opts.immediate });
}

/** Page unload: fire off the enlarged view's pending (non-empty) saves,
 *  best effort. A no-op when it isn't open. */
export function flushEnlargedView(): void {
  enlargedView?.flush();
}

/** Full teardown: removes the host from the DOM and restores page layout. Not
 *  part of the normal open/close cycle (§1.1's "close hides the sidebar,
 *  content script stays loaded") — this exists for tests and for a hard reset
 *  if the content script is ever torn down without a page navigation. */
export function destroySidebar(): void {
  enlargedView?.destroy();
  enlargedView = null;
  deferredItems = null;
  currentItems = [];
  enlargedDockSuspended = false;
  dockMotion?.destroy();
  dockMotion = null;
  closeActionMenu();
  clearMessage();
  endResizeDrag();
  restorePageResize();
  unsubscribeThemeChange?.();
  unsubscribeThemeChange = null;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  sidebarShadow?.removeEventListener('pointerdown', onShadowPointerDown, true);
  if (sidebarHost && sidebarHost.parentNode) {
    sidebarHost.parentNode.removeChild(sidebarHost);
  }
  sidebarHost = null;
  sidebarShadow = null;
  elSidebar = null;
  elResizer = null;
  elLogoImg = null;
  elBtnTheme = null;
  elBtnAdd = null;
  elAddGroup = null;
  elAddSwitch = null;
  elAddDesc = null;
  elExportGroup = null;
  elBtnExport = null;
  elBtnMenu = null;
  elActionMenu = null;
  elBtnImport = null;
  elBtnClose = null;
  elFileInput = null;
  elHeading = null;
  elEmptyState = null;
  elThumbnailList = null;
  elBody = null;
  elNotif = null;
  elNotifIcon = null;
  elNotifText = null;
  elCountdownBar = null;
  callbacksRef = null;
  visible = false;
  dockSuspended = false;
  addModeHold = false;
  exportEnabled = true;
  importEnabled = true;
  revealToken++;
  // Hard reset, not a soft close: the next initSidebar() re-reads the
  // persisted width from scratch, so in-memory width state must not leak
  // across a teardown.
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  widthChosenByUser = false;
}

// ---------------------------------------------------------------------------
// Notifications — carried over from toolbar.ts (showError / showWarning /
// showConfirmDialog). All copy passed in must already be lowercase (§3.4);
// these render it verbatim so the §5 error-table strings stay byte-exact.
// ---------------------------------------------------------------------------

const NOTIF_DURATION_MS = 8000;

/** Show the error bar inside the sidebar. Auto-clears after 8s. */
export function showError(message: string): void {
  showNotif('error', message, ICON_ERROR);
}

/** Show the warning bar inside the sidebar. Auto-clears after 8s. Pass
 *  `customIcon` to swap the default exclamation for this one message. */
export function showWarning(message: string, customIcon?: string): void {
  showNotif('warning', message, customIcon ?? ICON_WARNING);
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
// below), as four !important inline declarations, where N is the sidebar's
// *current* width (getSidebarWidth() — the user can drag it between 100 and
// 300px, so nothing here may hardcode a number):
//
//     margin-right: Npx      the actual shrink
//     width:        auto     defeats page CSS that pins html's width
//     min-width:    0        defeats page CSS that floors html's width
//     overflow-x:   hidden   clips whatever refuses to shrink anyway
//
// Plus one non-layout declaration, `--annotator-sidebar-width: Npx`. Custom
// properties inherit through shadow boundaries (closed roots included), so
// setting it on <html> lets any other extension shadow tree track the live
// width without any subscription plumbing.
//
// `margin-right` rather than `width: calc(100% - Npx)`, which was the
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
// it. Two independent defences, because they fail in different ways:
//
//   1. An injected <style> element (`#annotator-page-resize`) carrying the
//      same declarations as `html:root { ... !important }`. A stylesheet is
//      not stored in the style *attribute*, so a page wiping `cssText` cannot
//      touch it and the shrink survives with zero latency — no observer tick,
//      no un-shrunk frame. Inline !important still outranks it while both are
//      present (inline is the top of the author cascade), so this is purely a
//      backstop and never changes the normal case.
//   2. A MutationObserver on the root's `style`/`class` attributes that
//      re-asserts the inline declarations if they go missing, with a hard cap
//      so we can never end up in a re-write war with a page that is fighting
//      back. `class` is watched as well as `style` because class flips are the
//      cheapest signal that a page's own layout code just ran (theme toggles,
//      scroll locks, theater/fullscreen switches) — it is the moment to
//      re-check that our stylesheet is still attached.
//
// ── Sites where the shrink cannot fully work (youtube.com is the known one) ─
//
// Two page-side patterns defeat *any* root-box shrink, and both are present on
// YouTube. Neither is fixable from a content script; do not "fix" this by
// rewriting the page's stylesheets, which is unsafe and unreliable.
//
//   * Viewport units. `100vw`/`100dvw` are defined by spec against the actual
//     browser viewport, not against any element's used width — shrinking
//     <html> has no effect on them whatsoever. YouTube's app shell sizes
//     several containers this way (the full-bleed/theater player container
//     most visibly), so those keep their full-viewport width and bleed under
//     the sidebar strip no matter what we set on the root.
//   * Layout measured in JS from `window.innerWidth`. Shrinking the root does
//     not change `innerWidth`, so a layout that computes its own pixel widths
//     from it recomputes to the same too-wide number. YouTube's Polymer app
//     (ytd-watch-flexy's player sizing) does exactly this. We dispatch a
//     synthetic `resize` after every apply so such layouts at least re-run,
//     but they re-run to the same answer.
//
// On top of that, YouTube's masthead is `position: fixed`, which is the
// already-accepted fixed-element limitation below.
//
// The degradation is deliberate and safe rather than silent: the sidebar host
// carries an explicit z-index near the top of the 32-bit range, so on such a
// page the panel stays fully visible and usable and the page simply reads as
// "partly covered", which closing the sidebar undoes. This is a documented
// edge case in REQUIREMENTS.md, not a bug with a pending fix.
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

/** Inherits through shadow boundaries, so other extension surfaces can
 *  track the sidebar's live width without subscription plumbing. */
const SIDEBAR_WIDTH_CSS_VAR = '--annotator-sidebar-width';

/** id of the injected backstop stylesheet — see defence 1 in the banner. */
const RESIZE_STYLE_ELEMENT_ID = 'annotator-page-resize';

let resizeStyleEl: HTMLStyleElement | null = null;

/** Property list + the value each should currently hold. A function, not a
 *  constant: the margin (and the custom property) track the
 *  user's chosen sidebar width. Custom properties are written without
 *  `important` — nothing competes for ours, and some engines drop the
 *  priority on custom properties anyway. */
function managedHtmlProps(): ReadonlyArray<[prop: string, value: string, priority: string]> {
  const px = `${sidebarWidth}px`;
  return [
    ['margin-right', px, 'important'],
    ['width', 'auto', 'important'],
    ['min-width', '0px', 'important'],
    ['overflow-x', 'hidden', 'important'],
    [SIDEBAR_WIDTH_CSS_VAR, px, ''],
  ];
}

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
    for (const [prop] of managedHtmlProps()) {
      saved.set(prop, {
        value: html.style.getPropertyValue(prop),
        priority: html.style.getPropertyPriority(prop),
      });
    }
    savedHtmlDecls = saved;
    reassertCount = 0;
  }

  writeManagedProps();
  writeResizeStyleSheet();
  startHtmlStyleObserver();
  notifyPageOfResize();
}

function restorePageResize(): void {
  stopHtmlStyleObserver();
  removeResizeStyleSheet();
  if (savedHtmlDecls === null) return;

  const html = document.documentElement;
  for (const [prop] of managedHtmlProps()) {
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
  for (const [prop, value, priority] of managedHtmlProps()) {
    html.style.setProperty(prop, value, priority);
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

/**
 * Defence 1: the same declarations as a real stylesheet rule, which a page
 * wiping <html>'s style *attribute* cannot reach. Appended to <head> (falling
 * back to <html> for the rare document without one) and rewritten in place on
 * every width change, so there is never more than one of these.
 *
 * `html:root` rather than bare `html` only to raise specificity above a page's
 * own `html { ... }` rule; both carry !important anyway, and later-injected
 * author sheets win ties, which ours is.
 */
function writeResizeStyleSheet(): void {
  if (!resizeStyleEl) {
    resizeStyleEl = document.createElement('style');
    resizeStyleEl.id = RESIZE_STYLE_ELEMENT_ID;
  }
  resizeStyleEl.textContent =
    `html:root {` +
    `margin-right: ${sidebarWidth}px !important;` +
    `width: auto !important;` +
    `min-width: 0 !important;` +
    `overflow-x: hidden !important;` +
    `${SIDEBAR_WIDTH_CSS_VAR}: ${sidebarWidth}px;` +
    `}`;
  ensureResizeStyleSheetAttached();
}

function ensureResizeStyleSheetAttached(): void {
  if (!resizeStyleEl) return;
  if (resizeStyleEl.isConnected) return;
  (document.head ?? document.documentElement).appendChild(resizeStyleEl);
}

function removeResizeStyleSheet(): void {
  resizeStyleEl?.parentNode?.removeChild(resizeStyleEl);
  resizeStyleEl = null;
}

function startHtmlStyleObserver(): void {
  if (htmlStyleObserver || typeof MutationObserver === 'undefined') return;
  htmlStyleObserver = new MutationObserver(() => {
    if (savedHtmlDecls === null) return;
    // Cheap and unconditional: a page that tore our stylesheet out of <head>
    // gets it back on the next mutation of <html>'s style/class, and this
    // costs one `isConnected` read when nothing is wrong.
    ensureResizeStyleSheetAttached();
    if (managedPropsIntact()) return;
    if (reassertCount >= MAX_REASSERTS) {
      stopHtmlStyleObserver();
      return;
    }
    reassertCount++;
    writeManagedProps();
  });
  htmlStyleObserver.observe(document.documentElement, {
    attributes: true,
    // `class` as well as `style`: a class flip on <html> is the cheapest
    // signal that the page's own layout code just ran (theme/scroll-lock/
    // theater-mode toggles), which is exactly when to re-check our state.
    attributeFilter: ['style', 'class'],
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
  styleSheetAttached: boolean;
  width: number;
} {
  return {
    applied: savedHtmlDecls !== null,
    observing: htmlStyleObserver !== null,
    reasserts: reassertCount,
    styleSheetAttached: resizeStyleEl !== null && resizeStyleEl.isConnected,
    width: sidebarWidth,
  };
}
