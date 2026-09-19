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

/** Narrowest the user can drag the panel. */
export const SIDEBAR_MIN_WIDTH = 100;
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
    elSidebar.classList.toggle('is-compact', layout.compact);
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
  /** "add note" button was clicked (design spec v2 §A: a three-state
   *  off/on/locked toggle). content.ts owns the whole state machine — single
   *  click toggles, a second click within the double-click window is instead
   *  turned into "lock" by onAddDoubleClick below, and this sidebar module
   *  only ever paints whatever state it's told via setAddButtonState(). */
  onAdd: () => void;
  /** Native browser 'dblclick' on the "add note" button — see onAdd.
   *  Optional so callers that never toggle add mode (e.g. other modules'
   *  test doubles) don't have to stub a callback they'll never receive. */
  onAddDoubleClick?: () => void;
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
   *  enlarged view for this item (openEnlargedView(), design spec v2 §D). */
  onOpenItem: (item: FeedbackItem) => void;
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

const ICON_PLUS = `<svg xmlns="http://www.w3.org/2000/svg" ${STROKE_ICON_ATTRS}><path d="M12 5v14M5 12h14"/></svg>`;

/** Small plain-stroke padlock (no circle/badge) shown at the plus icon's
 *  bottom-right once the "add note" button is locked (design spec v2 §A).
 *  Sized/positioned by the `.icon-lock` CSS rule below — this markup is only
 *  ever hidden/shown via that rule's `display`, never removed from the DOM,
 *  so it survives the icon-only narrow/compact variants unchanged. */
const ICON_LOCK = `<svg xmlns="http://www.w3.org/2000/svg" class="icon-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;

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
// breakpoints and actionRowFits() (and its test) can't drift from what the
// browser actually lays out.
// ---------------------------------------------------------------------------

/** .sidebar's border-left (box-sizing: border-box, so it eats into width). */
const PANEL_BORDER_PX = 1;
/** `.thumbnail-list`'s left+right padding (each side) — see that CSS rule
 *  below. Named so DEFAULT_THUMBNAIL_BOX_SIZE (below) can derive the
 *  thumbnail's width from the exact same number the list is actually padded
 *  with, instead of a second hardcoded copy drifting from the CSS. */
const THUMBNAIL_LIST_PAD_X = 16;

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

/** Action row side padding: design spec §3.1's 16px, 8px once compact. */
const ACTION_ROW_PAD_X = 16;
const ACTION_ROW_PAD_X_COMPACT = 8;
const ACTION_ROW_GAP = 8;
/** Every action-row button is 36px tall; the secondaries (and the icon-only
 *  primary) are 36px square. */
const ACTION_BUTTON_PX = 36;

/** Width-driven layout classes for a given panel width (pure; applied by
 *  applyWidthToPanel). */
export function sidebarLayoutFor(width: number): { narrow: boolean; compact: boolean } {
  return { narrow: width < NARROW_WIDTH_BREAKPOINT, compact: width < COMPACT_WIDTH_BREAKPOINT };
}

/** Whether the action row's fixed-size content fits inside a panel of this
 *  width in the layout sidebarLayoutFor() picks for it — i.e. the
 *  arithmetic behind the breakpoints. The labelled primary (wide layout) is
 *  counted at its icon-only size: it has min-width: 0 and an ellipsizing
 *  label, so it can shrink to that without overflowing. */
export function actionRowFits(width: number): boolean {
  const { compact } = sidebarLayoutFor(width);
  const pad = compact ? ACTION_ROW_PAD_X_COMPACT : ACTION_ROW_PAD_X;
  const available = width - PANEL_BORDER_PX - pad * 2;
  const secondaries = ACTION_BUTTON_PX * 2 + ACTION_ROW_GAP;
  // Compact wraps: the primary takes its own full-width row, so the widest
  // row is the two secondaries side by side.
  const needed = compact
    ? Math.max(ACTION_BUTTON_PX, secondaries)
    : ACTION_BUTTON_PX + ACTION_ROW_GAP + secondaries;
  return available >= needed;
}

/** Above every dock-magnified item (dockMotion.ts writes z-index 0–100). */
const RESIZER_Z_INDEX = 101;

// ---------------------------------------------------------------------------
// CSS — Salamander design tokens (src/theme.ts's --sal-* custom properties,
// design spec §1–§3.1). FOCUS_RING_CSS/PRESS_SCALE_CSS/STATE_TRANSITION_CSS/
// DISABLED_CSS are the same shared interaction-state snippets enlargedView.ts and
// addMode.ts already paste in, so all three surfaces feel identical.
// ---------------------------------------------------------------------------

/** Below this width the wordmark hides and "add note" goes icon-only (design
 *  spec §3.1's "narrow widths" rule). */
export const NARROW_WIDTH_BREAKPOINT = 220;
/** Below this width the action row wraps (primary on its own row) and the
 *  header sheds the (purely decorative) logo mark, so the panel never
 *  overflows down to the 100px floor.
 *
 *  Derived, not picked: it is the narrowest width at which the *narrow*
 *  single-row layout (three 36px buttons, two gaps, 16px side padding, the
 *  panel's 1px left border) still fits — 1 + 16 + 36·3 + 8·2 + 16 = 157px.
 *  A hand-picked 150 left 150–156px overflowing by up to 7px. */
export const COMPACT_WIDTH_BREAKPOINT =
  PANEL_BORDER_PX + ACTION_ROW_PAD_X * 2 + ACTION_BUTTON_PX * 3 + ACTION_ROW_GAP * 2;
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

  .header {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    height: 56px;
    padding: 0 10px 0 16px;
    gap: 10px;
    border-bottom: 1px solid var(--sal-line);
  }
  .sidebar.is-compact .header { padding: 0 8px; gap: 6px; }

  .logo {
    width: 35px;
    height: 20px;
    flex-shrink: 0;
    display: block;
  }
  .logo img { width: 100%; height: 100%; display: block; }
  /* Purely decorative chrome — shed first, before the header's actual
     controls (theme toggle, close) could ever be squeezed out. */
  .sidebar.is-compact .logo { display: none; }

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

  /* ─── Action row: primary "add note" + secondary export/import (§3.1) ── */

  .action-row {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 4px ${ACTION_ROW_PAD_X}px 16px;
    gap: ${ACTION_ROW_GAP}px;
  }
  .sidebar.is-compact .action-row {
    padding-left: ${ACTION_ROW_PAD_X_COMPACT}px;
    padding-right: ${ACTION_ROW_PAD_X_COMPACT}px;
    flex-wrap: wrap;
  }

  /* "add note" toggle (design spec v2 §A) — off/on/locked. The base rule
     below *is* the on/locked look (accent fill, onAccent text, 600 weight);
     :not(.is-on) overrides it to the off/secondary look. Both share every
     interaction-state rule after it (hover/press/focus/disabled), since §A
     says hover/press are identical fills regardless of on/off — only the
     *regular* state differs. */
  .btn-primary {
    flex: 1 1 auto;
    /* Lets the button shrink below its label's width (the label ellipsizes)
       rather than pushing the icon buttons out of the row, whatever the
       loaded font's metrics turn out to be. */
    min-width: 0;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    border: none;
    border-radius: var(--sal-radius-md);
    font-family: var(--sal-font-body);
    font-size: 13px;
    line-height: 1;
    font-weight: 600;
    background: var(--sal-accent);
    color: var(--sal-on-accent);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .btn-primary:not(.is-on) {
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    color: var(--sal-text);
    font-weight: 500;
  }
  /* Hover/press: accentHover/accentPress fill + onAccent text regardless of
     on/off (§A) — border-color: transparent rather than removing the
     declaration keeps the off variant's box the same size under
     box-sizing: border-box. */
  .btn-primary:hover { background: var(--sal-accent-hover); color: var(--sal-on-accent); border-color: transparent; }
  .btn-primary:active {
    background: var(--sal-accent-press);
    color: var(--sal-on-accent);
    border-color: transparent;
    ${PRESS_SCALE_CSS}
  }
  .btn-primary:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .btn-primary[disabled] { ${DISABLED_CSS} }
  .btn-primary .icon { position: relative; width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; }
  .btn-primary .btn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-primary .icon svg { width: 100%; height: 100%; display: block; }
  /* The lock glyph (ICON_LOCK) is always in the DOM — display:none/block
     rather than adding/removing it — so it survives the icon-only narrow/
     compact variants (.is-narrow hides only .btn-label, never .icon)
     unchanged. ~9px, bottom-right of the 16px plus icon, per design spec v2
     §A / States.dc.html's "add note · locked" row. */
  .btn-primary .icon svg.icon-lock {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 9px;
    height: 9px;
    display: none;
  }
  .btn-primary.is-locked .icon svg.icon-lock { display: block; }
  /* Icon-only once the wordmark itself would no longer fit (§3.1). */
  .sidebar.is-narrow .btn-primary .btn-label { display: none; }
  .sidebar.is-narrow .btn-primary { flex: 0 0 ${ACTION_BUTTON_PX}px; padding: 0; }
  /* At the 100px floor the action row wraps instead: the primary button
     takes its own full-width row so the two icon buttons below always have
     room to sit side by side. */
  .sidebar.is-compact .btn-primary { flex: 1 1 100%; }

  .btn-secondary {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sal-surface);
    border: 1px solid var(--sal-line);
    border-radius: var(--sal-radius-md);
    color: var(--sal-text);
    cursor: pointer;
    ${STATE_TRANSITION_CSS}
  }
  .btn-secondary:hover { background: var(--sal-hover); border-color: var(--sal-line-strong); }
  .btn-secondary:active { background: var(--sal-press); border-color: var(--sal-line-strong); ${PRESS_SCALE_CSS} }
  .btn-secondary:focus-visible { ${FOCUS_RING_CSS} outline: none; }
  .btn-secondary[disabled] { ${DISABLED_CSS} }
  .btn-secondary .icon { width: 16px; height: 16px; display: inline-flex; }
  .btn-secondary .icon svg { width: 100%; height: 100%; display: block; }

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
  }
  .body.is-bleeding {
    clip-path: none;
    pointer-events: none;
  }
  .body.is-bleeding > * { pointer-events: auto; }

  .section-heading {
    margin: 0 16px 12px;
    font: 600 12px/1.2 var(--sal-font-body);
    color: var(--sal-muted);
  }
  .section-heading[hidden] { display: none !important; }

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

  .thumbnail-note-wrap {
    display: block;
    position: relative;
    margin-top: 8px;
  }
  /* The note's hover/focus "extension" (design spec v2 §B): a separate layer
     so it can fade on opacity alone, exactly as before — dockMotion.ts still
     only ever touches this element's inline opacity (spring-driven while
     .thumbnail-list carries data-dock="on"; the plain :hover/:focus-visible
     rule below takes over under prefers-reduced-motion), so none of that
     wiring changed. What changed is the box itself: rather than a rectangle
     matching the note text's own area, it starts tucked one radius-md *up*
     under the thumbnail's bottom edge (through the 8px gap
     .thumbnail-note-wrap's margin-top opens up, and one radius-md further
     into the thumbnail itself, where .thumbnail-image-wrap's higher z-index
     and opaque fill hide the overlap completely) and runs down to the
     button's bottom edge — same width as the thumbnail throughout, so its
     edges land exactly flush with the thumbnail's own. Only the bottom
     corners are rounded (the top is hidden under the thumbnail regardless).
     The note text itself never moves between rest and hover — only this
     layer's opacity changes. */
  .thumbnail-note-bg {
    position: absolute;
    left: 0;
    right: 0;
    /* 8px = .thumbnail-note-wrap's own margin-top, i.e. the gap this reaches
       back through before it goes one radius-md further up, under the
       thumbnail's bottom edge. */
    top: calc(-8px - var(--sal-radius-md));
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
    padding: 8px 10px;
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
let elBtnExport: HTMLButtonElement | null = null;
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

  // ── Action row: primary "add note" + secondary export/import (§3.1) ─────
  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';

  elBtnAdd = makePrimaryButton(ICON_PLUS, 'add note');
  elBtnExport = makeSecondaryButton(ICON_EXPORT, 'export feedback');
  elBtnImport = makeSecondaryButton(ICON_IMPORT, 'import feedback');

  actionRow.appendChild(elBtnAdd);
  actionRow.appendChild(elBtnExport);
  actionRow.appendChild(elBtnImport);

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

/** Secondary icon button (export / import) — surface fill, 1px line border. */
function makeSecondaryButton(svgMarkup: string, ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.setAttribute('aria-label', ariaLabel);
  btn.title = ariaLabel;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

/** Primary button ("add note") — the off/on/locked toggle (design spec v2
 *  §A). Label text stays "add note" in every state (only the fill/border and
 *  the lock glyph change); state is applied afterward via
 *  setAddButtonState(), which owns the classes/aria-pressed/aria-label. */
function makePrimaryButton(svgMarkup: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = svgMarkup + ICON_LOCK;
  const text = document.createElement('span');
  text.className = 'btn-label';
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

/** The "add note" button's three states (design spec v2 §A). */
export type AddButtonState = 'off' | 'on' | 'locked';

const ADD_BUTTON_LABELS: Record<AddButtonState, string> = {
  off: 'add note',
  on: 'add note (on)',
  locked: 'add note (locked)',
};

/**
 * Paint the "add note" button for `state` — fill/border (via .is-on),
 * the padlock glyph (via .is-locked), `aria-pressed` and the
 * aria-label/title (design spec v2 §A: "add note" / "add note (on)" /
 * "add note (locked)"). content.ts is the only caller: it owns the real
 * add-mode/lock state and calls this on every transition so the button never
 * drifts from what add mode is actually doing.
 */
export function setAddButtonState(state: AddButtonState): void {
  if (!elBtnAdd) return;
  const isOn = state !== 'off';
  elBtnAdd.classList.toggle('is-on', isOn);
  elBtnAdd.classList.toggle('is-locked', state === 'locked');
  elBtnAdd.setAttribute('aria-pressed', String(isOn));
  const label = ADD_BUTTON_LABELS[state];
  elBtnAdd.setAttribute('aria-label', label);
  elBtnAdd.title = label;
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
    callbacksRef?.onAdd();
  });
  elBtnAdd!.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    // Not every browser treats a button as a natural double-click target
    // for text selection, but pointer-down text selection can still occur
    // on the label — suppress it so a rapid double-click reads as a clean
    // "lock" gesture rather than also highlighting "add note".
    e.preventDefault();
    callbacksRef?.onAddDoubleClick?.();
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

  elBtnTheme!.addEventListener('click', (e) => {
    e.stopPropagation();
    updateThemeToggleUI(cycleThemeMode());
  });

  elResizer!.addEventListener('mousedown', onResizerMouseDown);
  elResizer!.addEventListener('keydown', onResizerKeyDown);

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

  // "add note" starts off (design spec v2 §A) — content.ts moves it to
  // on/locked as the real add-mode state changes.
  setAddButtonState('off');

  applyWidthToPanel();
  loadPersistedWidth();
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
    onOpen: (item) => callbacksRef?.onOpenItem(item),
  });
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
 * content.ts suspends it for the whole of add mode: magnified items grow out
 * past the panel's left edge over the page, and add mode's screenshot is of
 * the page — so nothing of ours may bleed there while a selection is being
 * made or captured. Suspending snaps the list back to rest instantly (no
 * release animation, no pending frame), and the flag survives list repaints
 * and close/reopen until it is lifted.
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
    focusListItem: (id) => {
      focusThumbnail(id);
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
      if (deferredItems) {
        const d = deferredItems;
        deferredItems = null;
        renderItems(d);
      }
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
  clearMessage();
  endResizeDrag();
  restorePageResize();
  unsubscribeThemeChange?.();
  unsubscribeThemeChange = null;
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
  elBtnExport = null;
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
