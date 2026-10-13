// src/sidebar.ts
// The right-docked sidebar shell (REQUIREMENTS §1.1, design spec §3.1).
//
// A full-height panel docked to the right edge that *resizes* the page instead
// of overlaying it (src/pageResize.ts, unchanged by the Salamander restyle).
// Structure per design spec §3.1:
//   - header row: logo + wordmark, close
//   - action row: the "add note" group (button + "keep on" switch) and the
//     export group: two buttons, export and "more options" (⋯), which opens
//     a menu holding "import" and "delete all for this website"
//   - notification banner (error/warning, auto-clears)
//   - "this page (n)" heading + note list, or the empty state
//
// This module owns the shell and wiring; src/thumbnails.ts owns the actual
// note-list <li> construction (setThumbnails() below just toggles the
// empty-state/heading and delegates to renderThumbnailList()). It stays
// chrome.runtime-agnostic throughout — content.ts fetches items/wires
// callbacks and calls openEnlargedView() when onOpenItem fires — with the one
// necessary exception of chrome.runtime.getURL() for the logo asset, which
// is guarded the same way theme.ts guards every chrome.* access.
//
// The enlarged view (design spec v2 §D, src/enlargedView.ts) renders inside
// this same shadow root: it is the sidebar itself growing to ~75% of the
// viewport, so this module lends it a mount (its shadow root, docked panel
// and list hooks) and owns its lifetime — see openEnlargedView() below.
//
// Design tokens come from src/theme.ts's --sal-* custom properties
// (getThemeCSS()) rather than any hardcoded palette. The extension is dark
// only (design spec §AA): the token block is emitted once on :host and never
// changes for the sidebar's lifetime.

import { FeedbackItem } from './types';
import { addNoteShortcutLabel } from './shortcut';
import {
  CONFIRM_CANCEL_LABEL,
  NOTHING_TO_DELETE_MESSAGE,
  NOTHING_TO_EXPORT_MESSAGE,
  SITE_LOAD_FAILED_MESSAGE,
} from './copy';
import { attachTooltips, isSoftDisabled, setSoftDisabled, TooltipHandle, TOOLTIP_CSS } from './tooltip';
import { renderThumbnailList } from './thumbnails';
import { attachDockMotion, DockMotionHandle } from './dockMotion';
import { getContentViewportSize, reducedMotionQuery } from './dom';
import {
  ICON_CLOSE,
  ICON_COMMENT,
  ICON_ERROR,
  ICON_EXPORT,
  ICON_IMPORT,
  ICON_MORE,
  ICON_TRASH,
  ICON_WARNING,
} from './icons';
import {
  openEnlargedView as openEnlargedViewImpl,
  ENLARGED_VIEW_CSS,
  EnlargedSite,
  EnlargedViewCallbacks,
  EnlargedViewHandle,
  EnlargedViewMount,
} from './enlargedView';
import { getThemeCSS } from './theme';
import {
  ACTION_ROW_PAD_X,
  ADD_SWITCH_GRACE_MS,
  ADD_SWITCH_REVEAL_MS,
  CONFIRM_ACTIONS_GAP_PX,
  EASE_STD,
  ITEM_REMOVE_TOTAL_MS,
  MENU_BORDER_PX,
  MENU_PAD_PX,
  PANEL_BORDER_PX,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarLayoutFor,
} from './sidebarMetrics';
import { SIDEBAR_CSS } from './styles/sidebar.css';
import {
  applyPageResize,
  isPageResized,
  restorePageResize,
  rewritePageResize,
  _stateForTests as pageResizeStateForTests,
} from './pageResize';

// The metrics content.ts, add mode and the tests read through this module.
export {
  ADD_SWITCH_ADVANCE_PX,
  ADD_SWITCH_GRACE_MS,
  ADD_SWITCH_REVEAL_MS,
  ADD_SWITCH_WIDTH_PX,
  DEFAULT_THUMBNAIL_BOX_SIZE,
  NARROW_WIDTH_BREAKPOINT,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarLayoutFor,
} from './sidebarMetrics';

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

// The width range (SIDEBAR_MIN_WIDTH … SIDEBAR_MAX_WIDTH, and the default)
// and every other layout metric live in src/sidebarMetrics.ts.

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

  if (changed && isPageResized()) {
    // Sidebar is open, so the page is currently shrunk — re-shrink to match.
    rewritePageResize(next);
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
  /** "export" header button — content.ts runs the EXPORT round trip. */
  onExport: () => void;
  /** "import" — an item of the "more options" menu (design spec v3 §C2,
   *  §AE) — fired once a file is chosen from the native picker. content.ts
   *  runs the full §5 validation ladder and the confirm-then-replace round
   *  trip. */
  onImportFile: (file: File) => void;
  /** "import" was chosen in the menu (design spec §AF). The menu stays open:
   *  content.ts decides whether to ask first (confirmInMenu, when the site
   *  already has notes) and then calls openImportPicker(). */
  onImport: () => void;
  /** "delete all for this website" — the menu's destructive item (design
   *  spec §AE, §AF). The menu stays open: content.ts reads the counts, asks
   *  through confirmInMenu and runs the delete. */
  onDeleteAll: () => void;
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

/** The logo asset (design spec §1): the yellow mark, which is the one that
 *  reads on the dark panel. The black copy (icons/logo-button-black.svg) is
 *  still shipped for a future light theme — see theme.ts's banner. */
const LOGO_PATH = 'icons/logo-button.svg';

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
// Module-level state
// ---------------------------------------------------------------------------

let sidebarHost: HTMLDivElement | null = null;
let sidebarShadow: ShadowRoot | null = null;

let elSidebar: HTMLDivElement | null = null;
let elResizer: HTMLDivElement | null = null;
let elLogoImg: HTMLImageElement | null = null;
let elBtnAdd: HTMLButtonElement | null = null;
/** The rounded box holding the "add note" button and its switch — it is the
 *  element that carries the on/off fill, the border and the states (§A2). */
let elAddGroup: HTMLDivElement | null = null;
/** The switch's pointer reveal (updateSwitchReveal): when the current one
 *  started, and the grace timer holding a finished one open. */
let switchRevealStartedAt = -Infinity;
let switchGraceTimer: ReturnType<typeof setTimeout> | null = null;
/** The "keep add mode on" switch (role="switch") attached to elBtnAdd. */
let elAddSwitch: HTMLButtonElement | null = null;
/** Visually-hidden aria-describedby text for elBtnAdd (lock state/hint). */
let elAddDesc: HTMLSpanElement | null = null;
/** Export and "more options" (§AE): pure layout, and the anchor the menu
 *  hangs from. */
let elExportGroup: HTMLDivElement | null = null;
let elBtnExport: HTMLButtonElement | null = null;
/** "more options" (⋯), the button that opens elActionMenu. */
let elBtnMenu: HTMLButtonElement | null = null;
let elActionMenu: HTMLDivElement | null = null;
/** "import" — the menu's first item. */
let elBtnImport: HTMLButtonElement | null = null;
/** "delete all for this website" (design spec §AE). */
let elBtnDeleteAll: HTMLButtonElement | null = null;
/** The menu's two faces (design spec §AF): the item list, and the
 *  confirmation the menu turns into in place. */
let elMenuList: HTMLDivElement | null = null;
let elMenuConfirm: HTMLDivElement | null = null;
let elMenuConfirmText: HTMLParagraphElement | null = null;
let elMenuConfirmCancel: HTMLButtonElement | null = null;
let elMenuConfirmOk: HTMLButtonElement | null = null;
let elMenuConfirmActions: HTMLDivElement | null = null;
/** The panel's tooltips (design spec §AG), the enlarged view's included. */
let sidebarTooltips: TooltipHandle | null = null;
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
/** Where the pointer last was over the note list (clientY), or null once it
 *  left. renderItems() destroys and re-attaches the dock layer, and a fresh
 *  one would otherwise have to wait for a pointer event that is not coming
 *  — see DockMotionOptions.initialPointerY. */
let lastListPointerY: number | null = null;
/** Set by content.ts for the whole of add mode (see
 *  setDockMagnificationSuspended). Lives here rather than on the handle
 *  because the handle is rebuilt on every repaint. */
let dockSuspended = false;
/** The enlarged view's own suspension, kept separate from add mode's flag so
 *  neither can lift the other's. */
let enlargedDockSuspended = false;
/** The open enlarged view, if any (one at a time). */
let enlargedView: EnlargedViewHandle | null = null;
/** Items the list is currently rendering — the enlarged view opens from one
 *  of these (and shows them alone if the rest of the site can't be read). */
let currentItems: FeedbackItem[] = [];
/** The listed page's name as edited in the enlarged view, or null — kept
 *  for the view's fallback (openEnlargedView with no site). */
let currentEditedTitle: string | null = null;
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
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of the sidebar's own CSS so every rule below can reference them.
  // One <style> per shadow root: the enlarged view's rules ride along here
  // since it renders inside this same root.
  style.textContent = getThemeCSS() + '\n' + SIDEBAR_CSS + '\n' + ENLARGED_VIEW_CSS + '\n' + TOOLTIP_CSS;
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
  elResizer.dataset.tip = 'resize sidebar';
  elResizer.dataset.tipSide = 'left';
  elResizer.tabIndex = 0;
  elResizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  elResizer.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
  elResizer.setAttribute('aria-valuenow', String(sidebarWidth));

  // Purely visual hairline — a sibling (not ::after) so it can sit below
  // magnified items while the hit target sits above them (see .resizer).
  const resizerLine = document.createElement('div');
  resizerLine.className = 'resizer-line';
  resizerLine.setAttribute('aria-hidden', 'true');

  // ── Header: logo + wordmark, close (design spec §3.1) ───────────────────
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

  elBtnClose = makeGhostButton(ICON_CLOSE, 'close sidebar', 'btn-close');

  header.appendChild(logo);
  header.appendChild(wordmark);
  header.appendChild(elBtnClose);

  // ── Action row: "add note" + "keep on" switch, export + "more options" ──
  //    (design spec v3 §A2, §AE)
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
  elAddSwitch.setAttribute('aria-label', ADD_SWITCH_NAME);
  elAddSwitch.dataset.tip = ADD_SWITCH_TITLES.off;
  const switchTrack = document.createElement('span');
  switchTrack.className = 'add-switch-track';
  switchTrack.setAttribute('aria-hidden', 'true');
  const switchKnob = document.createElement('span');
  switchKnob.className = 'add-switch-knob';
  switchTrack.appendChild(switchKnob);
  elAddSwitch.appendChild(switchTrack);

  elAddGroup.appendChild(elBtnAdd);
  elAddGroup.appendChild(elAddSwitch);
  elAddGroup.addEventListener('pointerenter', () => updateSwitchReveal(true));
  elAddGroup.addEventListener('pointerleave', () => updateSwitchReveal(false));

  elAddDesc = document.createElement('span');
  elAddDesc.id = ADD_BUTTON_DESC_ID;
  elAddDesc.className = 'sr-only';

  // export group (design spec §AE): export and "more options", two separate
  // buttons, and the menu "more options" opens. The menu lives inside this
  // same (closed) shadow root — there is nowhere else it could go —
  // positioned against the group.
  elExportGroup = document.createElement('div');
  elExportGroup.className = 'export-group';

  elBtnExport = makeIconButton(ICON_EXPORT, 'export feedback', 'btn-export');
  elBtnExport.dataset.tipReason = NOTHING_TO_EXPORT_MESSAGE;

  elBtnMenu = makeIconButton(ICON_MORE, 'more options', 'btn-menu');
  elBtnMenu.setAttribute('aria-haspopup', 'menu');
  elBtnMenu.setAttribute('aria-expanded', 'false');

  elActionMenu = document.createElement('div');
  elActionMenu.className = 'action-menu';
  elActionMenu.setAttribute('role', 'menu');
  elActionMenu.setAttribute('aria-label', 'more options');
  elActionMenu.dataset.open = 'false';
  // What a delete-all reason sits beside.
  elActionMenu.dataset.tipEdge = '';

  elBtnImport = makeMenuItem(ICON_IMPORT, 'import', 'is-import');
  const divider = document.createElement('div');
  divider.className = 'action-menu-divider';
  divider.setAttribute('role', 'separator');
  elBtnDeleteAll = makeMenuItem(ICON_TRASH, 'delete all for this website', 'is-danger is-delete-all');
  // Its reason sits beside the menu, to the left: the menu is against the
  // window's right edge (§AF).
  elBtnDeleteAll.dataset.tipReason = NOTHING_TO_DELETE_MESSAGE;
  elBtnDeleteAll.dataset.tipSide = 'left';
  elMenuList = document.createElement('div');
  elMenuList.className = 'action-menu-list';
  elMenuList.append(elBtnImport, divider, elBtnDeleteAll);

  // The confirmation the menu morphs into (design spec §AF). Hidden until a
  // question is asked; its text and confirming label are set per question.
  elMenuConfirm = document.createElement('div');
  elMenuConfirm.className = 'action-menu-confirm';
  elMenuConfirm.hidden = true;
  elMenuConfirmText = document.createElement('p');
  elMenuConfirmText.className = 'action-menu-confirm-text';
  elMenuConfirmText.id = MENU_CONFIRM_TEXT_ID;
  const confirmActions = document.createElement('div');
  confirmActions.className = 'action-menu-confirm-actions';
  elMenuConfirmActions = confirmActions;
  elMenuConfirmCancel = document.createElement('button');
  elMenuConfirmCancel.type = 'button';
  elMenuConfirmCancel.className = 'confirm-btn is-cancel';
  elMenuConfirmCancel.textContent = CONFIRM_CANCEL_LABEL;
  elMenuConfirmOk = document.createElement('button');
  elMenuConfirmOk.type = 'button';
  elMenuConfirmOk.className = 'confirm-btn is-danger is-confirm';
  confirmActions.append(elMenuConfirmCancel, elMenuConfirmOk);
  elMenuConfirm.append(elMenuConfirmText, confirmActions);

  elActionMenu.append(elMenuList, elMenuConfirm);

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
  // Tracked here rather than inside dockMotion because it has to survive
  // that layer being torn down and rebuilt on every repaint.
  elThumbnailList.addEventListener('pointermove', (e) => {
    lastListPointerY = e.clientY;
  });
  elThumbnailList.addEventListener('pointerleave', () => {
    lastListPointerY = null;
  });

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
  // One tooltip for the whole root — the panel and the enlarged view (§AG).
  sidebarTooltips = attachTooltips(shadow);
  // Nothing is known about the site's notes yet: start export and delete-all
  // greyed out, as setSiteHasNotes(false) would.
  syncActionAvailability();
  // The panel's fixed chrome (header, action row, banner, resize handle) is
  // not a scroller, so a wheel over it used to chain straight to the PAGE —
  // scrolling the page while the pointer was on the sidebar. Non-passive so
  // it can cancel that. The enlarged view mounts on the shadow root, outside
  // this element, so its own scrolling is never touched here.
  elSidebar.addEventListener('wheel', onSidebarChromeWheel, { passive: false });
}

/** Ghost button (the header's close) — transparent at rest, per design spec
 *  §2's "ghost" row. `extraClass` lets the close button size its icon up to
 *  18px without a whole second button variant. */
function makeGhostButton(svgMarkup: string, ariaLabel: string, extraClass = ''): HTMLButtonElement {
  return makeIconButton(svgMarkup, ariaLabel, extraClass ? `btn-ghost ${extraClass}` : 'btn-ghost');
}

/** An icon-only <button>: an `.icon` span holding the raw SVG markup, with
 *  the label as both aria-label and tooltip. "add note" (design spec v3
 *  §A2: transparent and borderless, the surrounding `.add-group` owns the
 *  fill, the border and the focus ring), export and "more options" (§AE:
 *  each its own box), and the ghost button above are all this shape;
 *  `className` picks the button's own size/radius rules. */
function makeIconButton(svgMarkup: string, ariaLabel: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', ariaLabel);
  btn.dataset.tip = ariaLabel;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svgMarkup;
  btn.appendChild(span);
  return btn;
}

/** One row of the "more options" menu (§C2, §AE): a 16px leading icon plus a
 *  visible, lowercase label. `role="menuitem"` and the roving Tab/arrow
 *  behaviour are wired in initSidebar. `extraClass` names the item (and
 *  marks the destructive one). */
function makeMenuItem(svgMarkup: string, label: string, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `action-menu-item ${extraClass}` : 'action-menu-item';
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

/** The "add note" control's three states (design spec v3 §A2). 'kept-on'
 *  paints button-on **and** switch-on — it was 'locked' while v2 §A's
 *  padlock existed; the glyph went in v3 and the name followed. */
export type AddButtonState = 'off' | 'on' | 'kept-on';

/** The button's accessible name (§A2, refined by §Y). Deliberately does
 *  NOT change with the state: this is a toggle, and aria-pressed is what
 *  announces on/off. A name that changed as well would have the state said
 *  twice, and in two different vocabularies. */
const ADD_BUTTON_NAME = 'add note';

/** The visible tooltip, which DOES change — it says what the click will do
 *  right now. Merged (kept-on) the two halves are one button, so this and
 *  ADD_SWITCH_TITLES.on are deliberately the same sentence. */
const ADD_BUTTON_TITLES: Record<AddButtonState, string> = {
  off: 'add note',
  on: 'cancel note',
  'kept-on': 'stop adding notes',
};

/** Screen-reader description (aria-describedby) per state: what the switch
 *  beside the button is doing, and how to reach it from the keyboard. */
const ADD_BUTTON_DESCRIPTIONS: Record<AddButtonState, string> = {
  off: 'shift+enter keeps add mode on',
  on: 'shift+enter keeps add mode on',
  'kept-on': 'kept on: stays on after each note',
};

const ADD_BUTTON_DESC_ID = 'add-note-desc';

/** The switch's accessible name (§A2) — fixed, since role="switch" carries
 *  its state in aria-checked. */
/**
 * The pointer's side of the switch's reveal (design spec v3 §A2). Entering
 * the group reveals it at once (cancelling any pending collapse — a reveal
 * mid-collapse turns round from where the slide is). Leaving collapses it:
 * after ADD_SWITCH_GRACE_MS if the reveal had finished, so a pointer that
 * strays off and straight back never loses it; at once if it had not, so a
 * quick brush past reverses from the live state rather than freezing a
 * half-out switch for the grace period. Keyboard focus and "on" reveal it
 * through CSS on their own.
 */
function updateSwitchReveal(inside: boolean): void {
  if (!elAddGroup) return;
  if (switchGraceTimer !== null) clearTimeout(switchGraceTimer);
  switchGraceTimer = null;
  const group = elAddGroup;
  if (inside) {
    if (!group.classList.contains('is-revealed')) {
      group.classList.add('is-revealed');
      switchRevealStartedAt = performance.now();
    }
    return;
  }
  if (!group.classList.contains('is-revealed')) return;
  const finished = performance.now() - switchRevealStartedAt >= ADD_SWITCH_REVEAL_MS;
  if (!finished) {
    group.classList.remove('is-revealed');
    return;
  }
  switchGraceTimer = setTimeout(() => {
    switchGraceTimer = null;
    group.classList.remove('is-revealed');
  }, ADD_SWITCH_GRACE_MS);
}

const ADD_SWITCH_NAME = 'keep add mode on';

/** Its visible tooltip, which says what flicking it does. On, the halves
 *  are one button and this matches ADD_BUTTON_TITLES['kept-on']. */
const ADD_SWITCH_TITLES = {
  off: 'keep adding notes',
  on: 'stop adding notes',
} as const;

/**
 * Paint the "add note" group for `state` (design spec v3 §A2):
 *   - 'off'    group neutral, `aria-pressed="false"`, switch off
 *   - 'on'     group accent, `aria-pressed="true"`, switch off
 *   - 'kept-on' group accent, `aria-pressed="true"`, switch ON (and therefore
 *              visible in every state, not just on hover/focus)
 *
 * content.ts is the only caller: it owns the real add-mode/switch state and
 * calls this on every transition, so neither half can drift from what add
 * mode is actually doing.
 */
export function setAddButtonState(state: AddButtonState): void {
  if (!elBtnAdd || !elAddGroup) return;
  const isOn = state !== 'off';
  const keepOn = state === 'kept-on';
  elAddGroup.classList.toggle('is-on', isOn);
  elAddGroup.classList.toggle('is-switch-on', keepOn);
  elBtnAdd.setAttribute('aria-pressed', String(isOn));
  elBtnAdd.setAttribute('aria-label', ADD_BUTTON_NAME);
  elBtnAdd.dataset.tip = ADD_BUTTON_TITLES[state];
  // The shortcut adds a note, so it is named only while there is none to add.
  if (state === 'off') elBtnAdd.dataset.tipKey = addNoteShortcutLabel();
  else delete elBtnAdd.dataset.tipKey;
  if (elAddSwitch) elAddSwitch.dataset.tip = keepOn ? ADD_SWITCH_TITLES.on : ADD_SWITCH_TITLES.off;
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
  // Zero-size positioning host (the add-mode host is built the same way):
  // the actual panel inside the shadow root does its own `position: fixed`.
  // Attached to <html> rather than <body> so an SPA replacing document.body
  // (or a framework re-rendering into it) cannot take the sidebar with it.
  sidebarHost.style.cssText =
    'position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483645; pointer-events: none;';

  sidebarShadow = sidebarHost.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(sidebarHost);

  buildDOM(sidebarShadow);

  elSidebar!.style.pointerEvents = 'auto';

  wireAddGroup();
  wireExportGroup();
  wireChrome(sidebarShadow);

  if (elLogoImg) elLogoImg.src = extensionUrl(LOGO_PATH);

  // "add note" starts off (design spec v3 §A2) — content.ts moves it to
  // on/kept-on as the real add-mode state changes. The switch does not
  // persist: it resets to off per page session, like the old lock.
  setAddButtonState('off');

  applyWidthToPanel();
  loadPersistedWidth();
}

/** The "add note" group's listeners (design spec v3 §A2): the button's
 *  click / shift-click / shift-Enter / dblclick, and the switch's click. */
function wireAddGroup(): void {
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
}

/** The export group's listeners (design spec §AE, §AF): export, "more
 *  options" and its menu — "import", "delete all for this website" and the
 *  confirmation the menu turns into — and the hidden file input. */
function wireExportGroup(): void {
  elBtnExport!.addEventListener('click', (e) => {
    e.stopPropagation();
    // Greyed out with nothing to export (§AF): stays focusable and
    // hoverable so it can say why, but does nothing.
    if (isSoftDisabled(elBtnExport)) return;
    callbacksRef?.onExport();
  });

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
    // Esc closes a menu opened by pointer, where focus is still on "more
    // options" rather than inside the menu (§C2's "Esc" applies either way).
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
    // The menu stays open: content.ts asks first if it must, then calls
    // openImportPicker() (§AF).
    callbacksRef?.onImport();
  });

  elBtnDeleteAll!.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSoftDisabled(elBtnDeleteAll)) return;
    callbacksRef?.onDeleteAll();
  });

  elMenuConfirmCancel!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeActionMenu({ returnFocus: true });
  });
  elMenuConfirmOk!.addEventListener('click', (e) => {
    e.stopPropagation();
    settleMenuConfirm(true);
    closeActionMenu({ returnFocus: true });
  });

  elFileInput!.addEventListener('change', () => {
    const file = elFileInput!.files?.[0];
    if (file) callbacksRef?.onImportFile(file);
    elFileInput!.value = '';
  });
}

/** The panel chrome's listeners: close, the resize handle, and the two
 *  outside-pointerdown listeners that close the "more options" menu. */
function wireChrome(shadow: ShadowRoot): void {
  elBtnClose!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSidebar();
    callbacksRef?.onClose();
  });

  elResizer!.addEventListener('mousedown', onResizerMouseDown);
  elResizer!.addEventListener('keydown', onResizerKeyDown);

  // "Outside pointerdown closes the menu" (§C2) needs two listeners, because
  // this shadow root is *closed*: an event raised inside it retargets to the
  // host by the time it reaches the document, and composedPath() is
  // truncated for listeners outside the tree. So the shadow root itself sees
  // everything inside the sidebar, and the document listener handles the
  // host page (where every one of our events looks like `sidebarHost`).
  shadow.addEventListener('pointerdown', onShadowPointerDown, true);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
}

// ---------------------------------------------------------------------------
// The "more options" menu (design spec v3 §C2, §AE)
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
  // Always opens as the item list, whatever it closed as.
  showMenuList();
  elActionMenu.dataset.open = 'true';
  elExportGroup?.classList.add('is-menu-open');
  elBtnMenu.setAttribute('aria-expanded', 'true');
  if (options.focusFirstItem) menuItems()[0]?.focus();
}

/**
 * Close the menu. `returnFocus` hands focus back to "more options", which is
 * right for Esc (§C2) and wrong for an outside click — the user has already
 * aimed somewhere else, and stealing focus back would fight them.
 */
function closeActionMenu(options: { returnFocus?: boolean } = {}): void {
  if (!elActionMenu || !elBtnMenu || !menuOpen) return;
  menuOpen = false;
  // A question still open is answered no: closing is cancelling (§AF).
  settleMenuConfirm(false);
  sidebarTooltips?.hide();
  elActionMenu.dataset.open = 'false';
  elExportGroup?.classList.remove('is-menu-open');
  elBtnMenu.setAttribute('aria-expanded', 'false');
  if (options.returnFocus) elBtnMenu.focus();
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(elActionMenu?.querySelectorAll<HTMLButtonElement>('.action-menu-item:not([disabled])') ?? []);
}

/** Up/Down move between items (wrapping), Esc closes and returns focus to
 *  the button, Tab closes and lets focus move on normally (§C2). As a
 *  confirmation (§AF), Esc cancels and Tab moves between its two buttons
 *  rather than dismissing the question. */
function onActionMenuKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeActionMenu({ returnFocus: true });
    return;
  }
  if (menuView === 'confirm') {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const onCancel = sidebarShadow?.activeElement === elMenuConfirmCancel;
    (onCancel ? elMenuConfirmOk : elMenuConfirmCancel)?.focus();
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

// ---------------------------------------------------------------------------
// The menu as a confirmation (design spec §AF)
//
// Delete-all, and import when the site already has notes, ask in place: the
// menu itself turns into the question. Its box morphs from the menu's size
// to the full width of the panel (16px from each side, like the action row)
// and the question's height; only the size animates, the contents swap at
// once. The contents are laid out at their final width and pinned to the
// box's top-right corner, so the growing box uncovers them rather than
// reflowing them frame by frame. Anything that closes the menu — cancel,
// Esc, a press outside, the sidebar closing, add mode — answers no.
// ---------------------------------------------------------------------------

const MENU_CONFIRM_TEXT_ID = 'menu-confirm-text';
/** The morph's duration: a size change in an element already on screen, a
 *  touch longer than the menu's 120ms entrance (motion spec: standard
 *  easing for anything that stays on screen). */
export const MENU_MORPH_MS = 200;

type MenuView = 'list' | 'confirm';
let menuView: MenuView = 'list';
let menuConfirmResolve: ((answer: boolean) => void) | null = null;
let menuMorph: Animation | null = null;

function settleMenuConfirm(answer: boolean): void {
  const resolve = menuConfirmResolve;
  menuConfirmResolve = null;
  resolve?.(answer);
}

/** Back to the item list (on every open), with the box's own sizing. */
function showMenuList(): void {
  menuMorph?.cancel();
  menuMorph = null;
  menuView = 'list';
  if (!elActionMenu) return;
  elActionMenu.classList.remove('is-confirm');
  elActionMenu.style.width = '';
  elActionMenu.setAttribute('role', 'menu');
  elActionMenu.setAttribute('aria-label', 'more options');
  elActionMenu.removeAttribute('aria-labelledby');
  elActionMenu.removeAttribute('aria-describedby');
  if (elMenuList) elMenuList.hidden = false;
  if (elMenuConfirm) elMenuConfirm.hidden = true;
}

/** The panel's content width: the box a confirmation fills. */
function confirmWidthPx(): number {
  return Math.max(0, sidebarWidth - PANEL_BORDER_PX - ACTION_ROW_PAD_X * 2);
}

/** Side by side when both buttons fit on one line at their natural
 *  (unwrapped) widths; otherwise stacked full width, cancel at the bottom.
 *  Measured per question, since the confirming label differs. */
function layoutConfirmActions(): void {
  const actions = elMenuConfirmActions;
  if (!actions || !elMenuConfirmCancel || !elMenuConfirmOk) return;
  actions.classList.remove('is-stacked');
  const needed = elMenuConfirmCancel.offsetWidth + CONFIRM_ACTIONS_GAP_PX + elMenuConfirmOk.offsetWidth;
  actions.classList.toggle('is-stacked', needed > actions.clientWidth);
}

/** How confirmInMenu styles its confirming button. */
export type ConfirmTone = 'danger' | 'accent';

/**
 * Turn the open menu into a yes/no question (design spec §AF) and resolve
 * with the answer: true only for the confirming button. Resolves false at
 * once if the menu is not open (the user dismissed it while the question
 * was being prepared), and false when anything closes the menu. Focus goes
 * to "cancel", so a stray Enter is the safe answer.
 *
 * `tone` styles the confirming button: 'danger' (soft red) for a delete,
 * 'accent' (yellow text, like "add note"'s glyph) for everything else.
 */
export function confirmInMenu(message: string, confirmLabel: string, tone: ConfirmTone = 'danger'): Promise<boolean> {
  if (!menuOpen || !elActionMenu || !elMenuList || !elMenuConfirm || !elMenuConfirmText || !elMenuConfirmOk) {
    return Promise.resolve(false);
  }
  settleMenuConfirm(false);
  sidebarTooltips?.hide();

  return new Promise<boolean>((resolve) => {
    menuConfirmResolve = resolve;
    const menu = elActionMenu!;
    const from = menu.getBoundingClientRect();

    elMenuConfirmText!.textContent = message;
    elMenuConfirmOk!.textContent = confirmLabel;
    elMenuConfirmOk!.classList.toggle('is-danger', tone === 'danger');
    elMenuConfirmOk!.classList.toggle('is-accent', tone === 'accent');
    const width = confirmWidthPx();
    menuView = 'confirm';
    menu.classList.add('is-confirm');
    menu.setAttribute('role', 'alertdialog');
    // Named by the question itself (an alertdialog needs a name), and
    // described by it too, as before.
    menu.removeAttribute('aria-label');
    menu.setAttribute('aria-labelledby', MENU_CONFIRM_TEXT_ID);
    menu.setAttribute('aria-describedby', MENU_CONFIRM_TEXT_ID);
    elMenuList!.hidden = true;
    elMenuConfirm!.hidden = false;
    menu.style.width = `${width}px`;
    elMenuConfirm!.style.width = `${Math.max(0, width - (MENU_BORDER_PX + MENU_PAD_PX) * 2)}px`;
    layoutConfirmActions();
    const to = menu.getBoundingClientRect();

    const reduced = reducedMotionQuery()?.matches ?? false;
    if (!reduced && typeof menu.animate === 'function' && from.width > 0 && to.width > 0) {
      menuMorph?.cancel();
      menuMorph = menu.animate(
        [
          { width: `${from.width}px`, height: `${from.height}px` },
          { width: `${to.width}px`, height: `${to.height}px` },
        ],
        { duration: MENU_MORPH_MS, easing: EASE_STD },
      );
      const morph = menuMorph;
      morph.onfinish = () => {
        if (menuMorph === morph) menuMorph = null;
      };
    }
    elMenuConfirmCancel?.focus();
  });
}

/** Close the menu and open the native file picker (§1.7). Called from the
 *  import item's own click — or from the confirmation's "yes", still inside
 *  that click's user activation, which a file picker requires. */
export function openImportPicker(): void {
  closeActionMenu();
  elFileInput?.click();
}

/** Close the "more options" menu from outside (content.ts, when a question
 *  cannot be asked because its count could not be read). */
export function closeMoreOptionsMenu(): void {
  closeActionMenu();
}

/** Whether the "more options" menu is open — content.ts checks it after a
 *  round trip, since the user may have dismissed the menu meanwhile. */
export function isMoreOptionsMenuOpen(): boolean {
  return menuOpen;
}

/** Take down the sidebar's tooltip at once, without its fade — content.ts
 *  calls it as a capture starts, since a tooltip resting on a sidebar control
 *  can reach over the page and would otherwise end up in the screenshot. */
export function hideTooltipNow(): void {
  sidebarTooltips?.hide({ immediate: true });
}

// ---------------------------------------------------------------------------
// Disabled reasons (design spec §AF)
//
// Export with nothing to export, and delete-all with nothing to delete, are
// "soft" disabled: they look and act disabled but stay focusable and
// hoverable (aria-disabled, not the disabled attribute — a truly disabled
// button gets no pointer events and no focus), so the shared tooltip
// (tooltip.ts, §AG) can show their `data-tip-reason` on hover or focus. The
// attribute is written by tooltip.ts's setSoftDisabled(); see
// syncActionAvailability().
// ---------------------------------------------------------------------------

/** Pointerdown anywhere inside the sidebar's shadow tree: close unless it
 *  landed on the menu itself or on "more options" (whose own click handler
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

/** The viewport's right edge in client coordinates: the scrollbar-excluded
 *  width (dom.ts's getContentViewportSize), which is exactly where the
 *  `position: fixed; right: 0` panel starts — `innerWidth` would include the
 *  document's vertical scrollbar and make every dragged width ~15px too
 *  small. */
function viewportRightEdge(): number {
  return getContentViewportSize().width;
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

/** True once initSidebar() has built the host. Production code never asks
 *  (initSidebar is idempotent and every entry point calls it first); this is
 *  the tests' probe for construction/teardown. */
export function isSidebarInitialised(): boolean {
  return sidebarHost !== null;
}

/** Show the sidebar and shrink the page to make room for it. Safe to call when
 *  already open (re-asserts visibility and the page resize). */
export function openSidebar(): void {
  if (!elSidebar) return;
  elSidebar.hidden = false;
  visible = true;
  applyPageResize(sidebarWidth);
  syncDockMotion();
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
  if (elSidebar) {
    elSidebar.hidden = true;
  }
  // The tooltip is the panel's sibling in the root, not its child: hiding
  // the panel does not hide it.
  sidebarTooltips?.hide();
  visible = false;
  syncDockMotion();
  clearMessage();
  restorePageResize();
}

export function isSidebarVisible(): boolean {
  return visible;
}

/** Visible AND still in the document: a page that removed salamander's host
 *  has no sidebar to act from (the add-note shortcut asks). */
export function isSidebarOnPage(): boolean {
  return visible && !!sidebarHost?.isConnected;
}

/** Disable/enable the export header button (§1.6). Assembling a
 *  multi-URL zip is an async round trip with no other on-screen affordance,
 *  so content.ts disables this for the duration to prevent a second export
 *  starting (and downloading) before the first finishes. */
export function setExportButtonEnabled(enabled: boolean): void {
  exportEnabled = enabled;
  syncActionAvailability();
}

/** Disable/enable the import header button (§1.7). Mirrors
 *  setExportButtonEnabled: parsing + validating a zip and the confirm-then-
 *  replace round trip is asynchronous with no other on-screen affordance, so
 *  content.ts disables this for the duration to prevent a second file pick
 *  from overlapping the first. */
export function setImportButtonEnabled(enabled: boolean): void {
  importEnabled = enabled;
  syncActionAvailability();
}

/** Whether this site has any notes, on any page (design spec §AF):
 *  content.ts re-reads it after every repaint, and again whenever import or
 *  delete-all reads the counts fresh. With none, export and
 *  delete-all are soft-disabled and say why on hover or focus. */
export function setSiteHasNotes(has: boolean): void {
  siteHasNotes = has;
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
/** Whether the site has any notes (design spec §AF) — until content.ts says
 *  so, export and delete-all are soft-disabled. */
let siteHasNotes = false;
/** True for the whole of add mode (design spec v3 §H). */
let addModeHold = false;

function syncActionAvailability(): void {
  // §H disables the whole export group; an in-flight export only disables
  // the export button, which would start a second one.
  const exportBlocked = addModeHold || !exportEnabled;
  if (elBtnExport) elBtnExport.disabled = exportBlocked;
  // Soft-disabled only for "nothing to export" (§AF): the add-mode hold and
  // an export in flight are brief and plain from context, so they keep the
  // plain disabled state and no tooltip.
  // A tooltip up for the old state would now say the wrong thing: hide it
  // now, not on the tooltip's MutationObserver (a microtask later).
  if (setSoftDisabled(elBtnExport, !exportBlocked && !siteHasNotes)) sidebarTooltips?.hide();
  if (elBtnMenu) elBtnMenu.disabled = addModeHold;
  if (elBtnImport) elBtnImport.disabled = !importEnabled;
  if (setSoftDisabled(elBtnDeleteAll, !siteHasNotes)) sidebarTooltips?.hide();
  elExportGroup?.classList.toggle('is-disabled', addModeHold);
}

/**
 * Put the sidebar "on hold" for the duration of add mode (design spec v3
 * §H): the note list stops taking pointer and keyboard input and dims to
 * ~0.5, dock magnification is switched off at the handle (rather than fought
 * with CSS — magnified items also bleed out over the page add mode is about
 * to screenshot), and export and "more options" are disabled with the menu
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

/**
 * Play a note row's removal, returning a promise that resolves when it has
 * finished — the caller then tells content.ts to actually delete, so the
 * repaint that follows lands on a list that has already closed the gap.
 *
 * Returns null when there is nothing to animate (reduced motion, or a row
 * with no box: a detached list, and every jsdom test). The caller deletes
 * synchronously in that case rather than deferring by a microtask for an
 * animation that was never going to run.
 *
 * Resolves on a timer as well as `transitionend`, so a dropped event can
 * never strand the delete.
 */
function playItemRemoval(itemId: number): Promise<void> | null {
  const li = elThumbnailList
    ?.querySelector<HTMLElement>(`button.thumbnail[data-item-id="${itemId}"]`)
    ?.closest<HTMLElement>('.thumbnail-item');
  if (!li) return null;
  if (reducedMotionQuery()?.matches) return null;
  const height = li.getBoundingClientRect().height;
  if (height <= 0) return null;

  // A transition out of max-height: none does not run, so pin the row's
  // current height first and let the browser see it before the class lands.
  li.style.maxHeight = `${height}px`;
  void li.offsetHeight;
  li.classList.add('is-removing');

  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      li.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === li && e.propertyName === 'max-height') finish();
    };
    li.addEventListener('transitionend', onEnd);
    setTimeout(finish, ITEM_REMOVE_TOTAL_MS + 60);
  });
}

/**
 * A wheel over the panel's fixed chrome scrolls the note list instead of the
 * page. Over the list itself this does nothing: native scrolling handles it,
 * and `.body`'s overscroll-behavior stops it chaining on at the ends.
 */
function onSidebarChromeWheel(e: WheelEvent): void {
  if (!elBody || e.ctrlKey) return; // ctrl+wheel is the browser's zoom
  if (e.composedPath().includes(elBody)) return;
  e.preventDefault();
  // Chrome reports pixels; lines and pages are what other engines send, and
  // cost nothing to honour.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? elBody.clientHeight : 1;
  elBody.scrollBy({ top: e.deltaY * unit, left: 0 });
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
export function setThumbnails(items: FeedbackItem[], editedTitle: string | null = null): void {
  // Dropped, not deferred, while the enlarged view is up: repainting under
  // a live morph would swap the very list thumbnails the clones are about
  // to land on, and a refresh that started before the view's own edits/
  // deletes would repaint over the (correct) list the view hands back on
  // close. onClosed re-reads storage anyway (content.ts).
  if (enlargedView) return;
  currentEditedTitle = editedTitle;
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
      const removal = playItemRemoval(item.id);
      if (!removal) {
        callbacksRef?.onDeleteItem?.(item);
        return;
      }
      void removal.then(() => callbacksRef?.onDeleteItem?.(item));
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

/** The pointer's clientY if it is genuinely over the list right now, else
 *  null. The coordinate is only trusted when it still falls inside the
 *  list's box: after a delete the list is shorter, and the pointer that was
 *  over the last row may now be past the end of it. */
function pointerYOverList(): number | null {
  if (lastListPointerY === null || !elThumbnailList) return null;
  const r = elThumbnailList.getBoundingClientRect();
  return lastListPointerY >= r.top && lastListPointerY <= r.bottom ? lastListPointerY : null;
}

/** Keep exactly one dock-motion layer alive while the sidebar is visible and
 *  showing items, and none otherwise (so a closed sidebar holds no rAF,
 *  listeners or matchMedia subscription). */
function syncDockMotion(): void {
  const wanted = visible && !!elThumbnailList && !elThumbnailList.hidden && elThumbnailList.children.length > 0;
  if (wanted && !dockMotion && elThumbnailList) {
    dockMotion = attachDockMotion(elThumbnailList, {
      scrollContainer: elBody,
      // Only when the pointer really is over the list right now: a stale
      // coordinate would magnify a row nobody is pointing at.
      initialPointerY: pointerYOverList(),
      // See .body's CSS: the scroller only paints (and stops taking pointer
      // events) over the page while something is actually magnified.
      onBleedChange: (bleeding) => elBody?.classList.toggle('is-bleeding', bleeding),
      holdTargets: elResizer ? [elResizer] : [],
    });
    syncDockSuspension();
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
 * Exported for the tests, which suspend magnification *without* the rest of
 * the hold; production callers go through setAddModeHold().
 */
export function setDockMagnificationSuspended(suspended: boolean): void {
  dockSuspended = suspended;
  syncDockSuspension();
}

/** Push the two suspension flags to the live dock layer, if there is one:
 *  either reason alone is enough to hold the list at rest. */
function syncDockSuspension(): void {
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
      syncDockSuspension();
    },
    focusListItem: (id) => focusThumbnail(id),
    focusFallback: () => {
      if (visible) elBtnAdd?.focus({ preventScroll: true });
    },
    showBanner: (message) => showError(message),
  };
}

/**
 * Expand the sidebar into the enlarged view (design spec §AH) on item
 * `itemId` — one of the items the list is showing — with every page of the
 * site in `site`. With no site (it could not be read) the view shows this
 * page's notes alone. Returns false if the sidebar isn't showing that item,
 * the site does not hold it, or a view is already open — that one is closed
 * only through its own paths, which the empty-note lock guards, never
 * forced shut by opening another.
 */
export function openEnlargedView(itemId: number, site: EnlargedSite | null, callbacks: EnlargedViewCallbacks): boolean {
  if (!visible || enlargedView) return false;
  const mount = enlargedMount();
  const listed = currentItems.find((i) => i.id === itemId);
  if (!mount || !listed) return false;
  // Without the site: this page alone, under its stored name, and the view
  // says why the other pages are missing.
  const shown: EnlargedSite = site ?? {
    currentUrl: listed.normalisedUrl,
    pages: [{ normalisedUrl: listed.normalisedUrl, editedTitle: currentEditedTitle, items: currentItems }],
    notice: SITE_LOAD_FAILED_MESSAGE,
  };
  let handle: EnlargedViewHandle | null = null;
  handle = openEnlargedViewImpl(mount, shown, itemId, {
    ...callbacks,
    onClosed: (id) => {
      if (enlargedView === handle) enlargedView = null;
      callbacks.onClosed(id);
    },
  });
  if (handle.getState() === 'closed') return false;
  enlargedView = handle;
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
  settleMenuConfirm(false);
  enlargedView?.destroy();
  enlargedView = null;
  currentItems = [];
  currentEditedTitle = null;
  enlargedDockSuspended = false;
  dockMotion?.destroy();
  dockMotion = null;
  closeActionMenu();
  clearMessage();
  endResizeDrag();
  restorePageResize();
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  elSidebar?.removeEventListener('wheel', onSidebarChromeWheel);
  sidebarShadow?.removeEventListener('pointerdown', onShadowPointerDown, true);
  if (sidebarHost && sidebarHost.parentNode) {
    sidebarHost.parentNode.removeChild(sidebarHost);
  }
  sidebarHost = null;
  sidebarShadow = null;
  elSidebar = null;
  elResizer = null;
  elLogoImg = null;
  elBtnAdd = null;
  elAddGroup = null;
  if (switchGraceTimer !== null) clearTimeout(switchGraceTimer);
  switchGraceTimer = null;
  switchRevealStartedAt = -Infinity;
  elAddSwitch = null;
  elAddDesc = null;
  elExportGroup = null;
  elBtnExport = null;
  elBtnMenu = null;
  elActionMenu = null;
  elBtnImport = null;
  elBtnDeleteAll = null;
  elMenuList = null;
  elMenuConfirm = null;
  elMenuConfirmText = null;
  elMenuConfirmCancel = null;
  elMenuConfirmOk = null;
  elMenuConfirmActions = null;
  sidebarTooltips?.destroy();
  sidebarTooltips = null;
  siteHasNotes = false;
  menuView = 'list';
  menuMorph = null;
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
  // Hard reset, not a soft close: the next initSidebar() re-reads the
  // persisted width from scratch, so in-memory width state must not leak
  // across a teardown.
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  widthChosenByUser = false;
}

// ---------------------------------------------------------------------------
// Notifications (showError / showWarning). All copy
// passed in must already be lowercase (§3.4);
// these render it verbatim so the §5 error-table strings stay byte-exact.
// ---------------------------------------------------------------------------

const NOTIF_DURATION_MS = 8000;

/** Show the error bar inside the sidebar. Auto-clears after 8s. */
export function showError(message: string): void {
  showNotif('error', message, ICON_ERROR);
}

/** Show the warning bar inside the sidebar. Auto-clears after 8s. */
export function showWarning(message: string): void {
  showNotif('warning', message, ICON_WARNING);
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

/** Test-only: the page-resize machinery's state, with the panel's width. */
export function _pageResizeStateForTests(): {
  applied: boolean;
  observing: boolean;
  reasserts: number;
  styleSheetAttached: boolean;
  width: number;
} {
  return { ...pageResizeStateForTests(), width: sidebarWidth };
}
