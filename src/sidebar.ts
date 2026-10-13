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
//
// The parts with state of their own live beside it: the page shrink
// (src/pageResize.ts), the width store (src/sidebarWidth.ts), the numbers
// (src/sidebarMetrics.ts), the stylesheet (src/styles/sidebar.css.ts), the
// banner (src/notifications.ts) and the "more options" menu
// (src/actionMenu.ts). What stays here: building and wiring the panel (one
// SidebarDom record while it is built), the add group's paint, the action
// row's availability and add mode's hold, the note list, the enlarged view's
// mount, and the API content.ts drives it through.

import { FeedbackItem } from './types';
import { addNoteShortcutLabel } from './shortcut';
import { NOTHING_TO_EXPORT_MESSAGE, SITE_LOAD_FAILED_MESSAGE } from './copy';
import { attachTooltips, isSoftDisabled, setSoftDisabled, TooltipHandle, TOOLTIP_CSS } from './tooltip';
import { renderThumbnailList } from './thumbnails';
import { attachDockMotion, DockMotionHandle } from './dockMotion';
import {
  cancelAnimationFrameSafe,
  getContentViewportSize,
  keyTargetWithin,
  reducedMotionQuery,
  requestAnimationFrameSafe,
} from './dom';
import { installKeyboardIsolation, KeyboardIsolationHandle } from './keyboardIsolation';
import { KEY_PRIORITY } from './keyRouter';
import { ICON_CLOSE, ICON_COMMENT, ICON_EXPORT, ICON_MORE } from './icons';
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
  ADD_SWITCH_GRACE_MS,
  ADD_SWITCH_REVEAL_MS,
  ITEM_REMOVE_TOTAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarLayoutFor,
} from './sidebarMetrics';
import { SIDEBAR_CSS } from './styles/sidebar.css';
import { Notifications } from './notifications';
import { ActionMenu, ConfirmTone } from './actionMenu';
import {
  getSidebarWidth,
  loadPersistedWidth,
  resetSidebarWidth,
  setSidebarWidth,
  subscribeSidebarWidth,
} from './sidebarWidth';
import {
  applyPageResize,
  isPageResized,
  restorePageResize,
  rewritePageResize,
  _stateForTests as pageResizeStateForTests,
} from './pageResize';

export type { ConfirmTone } from './actionMenu';

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
// The width store, which content.ts and the tests reach through here.
export { clampSidebarWidth, getSidebarWidth, setSidebarWidth } from './sidebarWidth';

// ---------------------------------------------------------------------------
// Sidebar width: the store is src/sidebarWidth.ts; the panel follows it
// (followWidth, subscribed in initSidebar).
// ---------------------------------------------------------------------------

/** Keyboard resize step for the handle's arrow keys. */
const RESIZE_KEY_STEP = 10;

/** How long past a row's removal transition its timer waits before
 *  finishing anyway (a dropped transitionend must never strand a delete). */
const REMOVE_TIMER_SLACK_MS = 60;

/** The panel's subscription to the width store, while it is built. */
let unsubscribeWidth: (() => void) | null = null;

/** The panel's side of every width change: its own box always, and the page
 *  shrink when the width really changed while the page is shrunk. */
function followWidth(width: number, changed: boolean): void {
  applyWidthToPanel();
  if (changed && isPageResized()) {
    // Sidebar is open, so the page is currently shrunk — re-shrink to match.
    rewritePageResize(width);
  }
}

function applyWidthToPanel(): void {
  const sidebarWidth = getSidebarWidth();
  if (dom) {
    dom.panel.style.width = `${sidebarWidth}px`;
    // Responsive layout (design spec §3.1) — driven from here rather than a
    // CSS container query so the same jsdom tests that already exercise
    // every other width-driven behaviour in this module (drag/keyboard
    // resize, persistence) can assert on it directly, with no layout engine
    // required.
    const layout = sidebarLayoutFor(sidebarWidth);
    dom.panel.classList.toggle('is-narrow', layout.narrow);
    dom.resizer.setAttribute('aria-valuenow', String(sidebarWidth));
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

/** Every element and part of the built panel, while it is built
 *  (initSidebar → destroySidebar). One record rather than a nullable
 *  variable each, so code that has the panel has all of it. */
interface SidebarDom {
  /** The zero-size host on <html> and its closed shadow root. */
  host: HTMLDivElement;
  shadow: ShadowRoot;
  /** The panel itself (.sidebar). */
  panel: HTMLDivElement;
  resizer: HTMLDivElement;
  logoImg: HTMLImageElement;
  btnClose: HTMLButtonElement;
  /** The rounded box holding the "add note" button and its switch — it is the
   *  element that carries the on/off fill, the border and the states (§A2). */
  addGroup: HTMLDivElement;
  btnAdd: HTMLButtonElement;
  /** The "keep add mode on" switch (role="switch") attached to btnAdd. */
  addSwitch: HTMLButtonElement;
  /** Visually-hidden aria-describedby text for btnAdd (lock state/hint). */
  addDesc: HTMLSpanElement;
  /** Export and "more options" (§AE): pure layout, and the anchor the menu
   *  hangs from. */
  exportGroup: HTMLDivElement;
  btnExport: HTMLButtonElement;
  /** "more options" (⋯), the button that opens the menu. */
  btnMenu: HTMLButtonElement;
  /** The "more options" menu and its confirmation (src/actionMenu.ts). */
  actionMenu: ActionMenu;
  /** The notification banner (src/notifications.ts). */
  notifications: Notifications;
  /** The panel's tooltips (design spec §AG), the enlarged view's included. */
  tooltips: TooltipHandle;
  /** The note list's scrollport, its heading, the empty state and the list. */
  body: HTMLDivElement;
  heading: HTMLHeadingElement;
  emptyState: HTMLParagraphElement;
  thumbnailList: HTMLUListElement;
  fileInput: HTMLInputElement;
}

let dom: SidebarDom | null = null;

/** The switch's pointer reveal (updateSwitchReveal): when the current one
 *  started, and the grace timer holding a finished one open. */
let switchRevealStartedAt = -Infinity;
let switchGraceTimer: ReturnType<typeof setTimeout> | null = null;
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

let callbacksRef: SidebarCallbacks | null = null;
let visible = false;

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function buildDOM(host: HTMLDivElement, shadow: ShadowRoot): SidebarDom {
  const style = document.createElement('style');
  // Salamander design tokens (--sal-*) as :host custom properties, prepended
  // ahead of the sidebar's own CSS so every rule below can reference them.
  // One <style> per shadow root: the enlarged view's rules ride along here
  // since it renders inside this same root.
  style.textContent = getThemeCSS() + '\n' + SIDEBAR_CSS + '\n' + ENLARGED_VIEW_CSS + '\n' + TOOLTIP_CSS;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'sidebar';
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'annotator sidebar');
  panel.hidden = true;

  const resizer = document.createElement('div');
  resizer.className = 'resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'resize sidebar');
  resizer.dataset.tip = 'resize sidebar';
  resizer.dataset.tipSide = 'left';
  resizer.tabIndex = 0;
  resizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  resizer.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
  resizer.setAttribute('aria-valuenow', String(getSidebarWidth()));

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
  const logoImg = document.createElement('img');
  logoImg.alt = ''; // decorative — the wordmark carries the name
  logoImg.draggable = false;
  logo.appendChild(logoImg);

  const wordmark = document.createElement('span');
  wordmark.className = 'wordmark';
  wordmark.textContent = 'salamander';

  const btnClose = makeGhostButton(ICON_CLOSE, 'close sidebar', 'btn-close');

  header.appendChild(logo);
  header.appendChild(wordmark);
  header.appendChild(btnClose);

  // ── Action row: "add note" + "keep on" switch, export + "more options" ──
  //    (design spec v3 §A2, §AE)
  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';

  // "add note" group: an icon-only button with the switch attached to it.
  // Both halves are plain <button>s inside one <div> that owns the visuals,
  // so the group can carry one focus ring, one fill and one press scale.
  const addGroup = document.createElement('div');
  addGroup.className = 'add-group';

  const btnAdd = makeIconButton(ICON_COMMENT, 'add note', 'btn-add');
  btnAdd.setAttribute('aria-pressed', 'false');
  btnAdd.setAttribute('aria-describedby', ADD_BUTTON_DESC_ID);

  const addSwitch = document.createElement('button');
  addSwitch.type = 'button';
  addSwitch.className = 'add-switch';
  addSwitch.setAttribute('role', 'switch');
  addSwitch.setAttribute('aria-checked', 'false');
  addSwitch.setAttribute('aria-label', ADD_SWITCH_NAME);
  addSwitch.dataset.tip = ADD_SWITCH_TITLES.off;
  const switchTrack = document.createElement('span');
  switchTrack.className = 'add-switch-track';
  switchTrack.setAttribute('aria-hidden', 'true');
  const switchKnob = document.createElement('span');
  switchKnob.className = 'add-switch-knob';
  switchTrack.appendChild(switchKnob);
  addSwitch.appendChild(switchTrack);

  addGroup.appendChild(btnAdd);
  addGroup.appendChild(addSwitch);
  addGroup.addEventListener('pointerenter', () => updateSwitchReveal(true));
  addGroup.addEventListener('pointerleave', () => updateSwitchReveal(false));

  const addDesc = document.createElement('span');
  addDesc.id = ADD_BUTTON_DESC_ID;
  addDesc.className = 'sr-only';

  // export group (design spec §AE): export and "more options", two separate
  // buttons, and the menu "more options" opens. The menu lives inside this
  // same (closed) shadow root — there is nowhere else it could go —
  // positioned against the group.
  const exportGroup = document.createElement('div');
  exportGroup.className = 'export-group';

  const btnExport = makeIconButton(ICON_EXPORT, 'export feedback', 'btn-export');
  btnExport.dataset.tipReason = NOTHING_TO_EXPORT_MESSAGE;

  const btnMenu = makeIconButton(ICON_MORE, 'more options', 'btn-menu');
  btnMenu.setAttribute('aria-haspopup', 'menu');
  btnMenu.setAttribute('aria-expanded', 'false');

  const actionMenu = new ActionMenu({
    button: btnMenu,
    group: exportGroup,
    shadow,
    host,
    hideTooltip: () => dom?.tooltips.hide(),
  });

  exportGroup.appendChild(btnExport);
  exportGroup.appendChild(btnMenu);
  exportGroup.appendChild(actionMenu.el);

  actionRow.appendChild(addGroup);
  actionRow.appendChild(exportGroup);
  actionRow.appendChild(addDesc);

  // Notification bar (src/notifications.ts).
  const notifications = new Notifications();

  const body = document.createElement('div');
  body.className = 'body';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.hidden = true;

  const emptyState = document.createElement('p');
  emptyState.className = 'empty-state';
  emptyState.textContent = 'no feedback on this page yet';

  const thumbnailList = document.createElement('ul');
  thumbnailList.className = 'thumbnail-list';
  thumbnailList.hidden = true;
  // Tracked here rather than inside dockMotion because it has to survive
  // that layer being torn down and rebuilt on every repaint.
  thumbnailList.addEventListener('pointermove', (e) => {
    lastListPointerY = e.clientY;
  });
  thumbnailList.addEventListener('pointerleave', () => {
    lastListPointerY = null;
  });

  body.appendChild(heading);
  body.appendChild(emptyState);
  body.appendChild(thumbnailList);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.zip';
  fileInput.style.display = 'none';

  panel.appendChild(resizer);
  panel.appendChild(resizerLine);
  panel.appendChild(header);
  panel.appendChild(actionRow);
  panel.appendChild(notifications.el);
  panel.appendChild(body);
  panel.appendChild(fileInput);

  shadow.appendChild(panel);
  // One tooltip for the whole root — the panel and the enlarged view (§AG).
  const tooltips = attachTooltips(shadow);
  return {
    host,
    shadow,
    panel,
    resizer,
    logoImg,
    btnClose,
    addGroup,
    btnAdd,
    addSwitch,
    addDesc,
    exportGroup,
    btnExport,
    btnMenu,
    actionMenu,
    notifications,
    tooltips,
    body,
    heading,
    emptyState,
    thumbnailList,
    fileInput,
  };
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
  if (!dom) return;
  if (switchGraceTimer !== null) clearTimeout(switchGraceTimer);
  switchGraceTimer = null;
  const group = dom.addGroup;
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

/** The switch's accessible name (§A2) — fixed, since role="switch" carries
 *  its state in aria-checked. */
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
  if (!dom) return;
  const { addGroup, btnAdd, addSwitch, addDesc } = dom;
  const isOn = state !== 'off';
  const keepOn = state === 'kept-on';
  addGroup.classList.toggle('is-on', isOn);
  addGroup.classList.toggle('is-switch-on', keepOn);
  btnAdd.setAttribute('aria-pressed', String(isOn));
  btnAdd.setAttribute('aria-label', ADD_BUTTON_NAME);
  btnAdd.dataset.tip = ADD_BUTTON_TITLES[state];
  // The shortcut adds a note, so it is named only while there is none to add.
  if (state === 'off') btnAdd.dataset.tipKey = addNoteShortcutLabel();
  else delete btnAdd.dataset.tipKey;
  addSwitch.dataset.tip = keepOn ? ADD_SWITCH_TITLES.on : ADD_SWITCH_TITLES.off;
  addSwitch.setAttribute('aria-checked', String(keepOn));
  // Merged: while the switch is on the group is one button, so it is one tab
  // stop too — the button half carries it, and both halves do the same thing
  // (§A2 micro states). The switch stays in the accessibility tree, checked,
  // so its state is still announced.
  if (keepOn) addSwitch.setAttribute('tabindex', '-1');
  else addSwitch.removeAttribute('tabindex');
  addDesc.textContent = ADD_BUTTON_DESCRIPTIONS[state];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Idempotent: a second call only refreshes the callbacks (mirrors content.ts's
 *  own double-injection guard — cross-cutting gotcha #6). Building the DOM does
 *  not make the sidebar visible; call openSidebar() for that. */
export function initSidebar(callbacks: SidebarCallbacks): void {
  if (dom) {
    callbacksRef = callbacks;
    return;
  }
  callbacksRef = callbacks;

  const sidebarHost = document.createElement('div');
  sidebarHost.id = 'annotator-sidebar-host';
  // Zero-size positioning host (the add-mode host is built the same way):
  // the actual panel inside the shadow root does its own `position: fixed`.
  // Attached to <html> rather than <body> so an SPA replacing document.body
  // (or a framework re-rendering into it) cannot take the sidebar with it.
  sidebarHost.style.cssText =
    'position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483645; pointer-events: none;';

  const sidebarShadow = sidebarHost.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(sidebarHost);

  const built = buildDOM(sidebarHost, sidebarShadow);
  dom = built;
  // Nothing is known about the site's notes yet: start export and delete-all
  // greyed out, as setSiteHasNotes(false) would.
  syncActionAvailability();
  // The panel's fixed chrome (header, action row, banner, resize handle) is
  // not a scroller, so a wheel over it used to chain straight to the PAGE —
  // scrolling the page while the pointer was on the sidebar. Non-passive so
  // it can cancel that. The enlarged view mounts on the shadow root, outside
  // this element, so its own scrolling is never touched here.
  built.panel.addEventListener('wheel', onSidebarChromeWheel, { passive: false });

  built.panel.style.pointerEvents = 'auto';

  wireAddGroup(built);
  wireExportGroup(built);
  wireChrome(built);

  built.logoImg.src = extensionUrl(LOGO_PATH);

  // "add note" starts off (design spec v3 §A2) — content.ts moves it to
  // on/kept-on as the real add-mode state changes. The switch does not
  // persist: it resets to off per page session, like the old lock.
  setAddButtonState('off');

  unsubscribeWidth = subscribeSidebarWidth(followWidth);
  applyWidthToPanel();
  loadPersistedWidth();
}

/** The "add note" group's listeners (design spec v3 §A2): the button's
 *  click / shift-click / shift-Enter / dblclick, and the switch's click. */
function wireAddGroup(d: SidebarDom): void {
  d.btnAdd.addEventListener('click', (e) => {
    e.stopPropagation();
    // Shift+click: the single-gesture (and keyboard, below) twin of the
    // double-click lock.
    if (e.shiftKey) callbacksRef?.onAddDoubleClick?.();
    else callbacksRef?.onAdd();
  });
  d.btnAdd.addEventListener('keydown', (e) => {
    if (!e.shiftKey || (e.key !== 'Enter' && e.key !== ' ')) return;
    // Shift+Enter / Shift+Space lock too. preventDefault cancels the native
    // activation, so no plain click follows to toggle it straight back off.
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) callbacksRef?.onAddDoubleClick?.();
  });
  d.btnAdd.addEventListener('dblclick', (e) => {
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
  d.addSwitch.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = d.addSwitch.getAttribute('aria-checked') !== 'true';
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
function wireExportGroup(d: SidebarDom): void {
  d.btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    // Greyed out with nothing to export (§AF): stays focusable and
    // hoverable so it can say why, but does nothing.
    if (isSoftDisabled(d.btnExport)) return;
    callbacksRef?.onExport();
  });

  // "more options", the menu's keys and its question's buttons.
  d.actionMenu.wire();

  d.actionMenu.importItem.addEventListener('click', (e) => {
    e.stopPropagation();
    // The menu stays open: content.ts asks first if it must, then calls
    // openImportPicker() (§AF).
    callbacksRef?.onImport();
  });

  d.actionMenu.deleteAllItem.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSoftDisabled(d.actionMenu.deleteAllItem)) return;
    callbacksRef?.onDeleteAll();
  });

  d.fileInput.addEventListener('change', () => {
    const file = d.fileInput.files?.[0];
    if (file) callbacksRef?.onImportFile(file);
    d.fileInput.value = '';
  });
}

/** The panel chrome's listeners: close, the resize handle, and the two
 *  outside-pointerdown listeners that close the "more options" menu. */
function wireChrome(d: SidebarDom): void {
  d.btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSidebar();
    callbacksRef?.onClose();
  });

  d.resizer.addEventListener('mousedown', onResizerMouseDown);
  d.resizer.addEventListener('keydown', onResizerKeyDown);

  // A press outside closes the menu (src/actionMenu.ts says why it takes
  // two listeners).
  d.actionMenu.listenForOutsidePresses();
}

// ---------------------------------------------------------------------------
// The "more options" menu (design spec v3 §C2, §AE, §AF): src/actionMenu.ts
// ---------------------------------------------------------------------------

/**
 * Turn the open menu into a yes/no question (design spec §AF) and resolve
 * with the answer: true only for the confirming button. Resolves false at
 * once if the menu is not open, and false when anything closes the menu
 * (ActionMenu.confirm).
 */
export function confirmInMenu(message: string, confirmLabel: string, tone: ConfirmTone = 'danger'): Promise<boolean> {
  return dom ? dom.actionMenu.confirm(message, confirmLabel, tone) : Promise.resolve(false);
}

/** Close the menu and open the native file picker (§1.7). Called from the
 *  import item's own click — or from the confirmation's "yes", still inside
 *  that click's user activation, which a file picker requires. */
export function openImportPicker(): void {
  dom?.actionMenu.close();
  dom?.fileInput.click();
}

/** Close the "more options" menu from outside (content.ts, when a question
 *  cannot be asked because its count could not be read). */
export function closeMoreOptionsMenu(): void {
  dom?.actionMenu.close();
}

/** Whether the "more options" menu is open — content.ts checks it after a
 *  round trip, since the user may have dismissed the menu meanwhile. */
export function isMoreOptionsMenuOpen(): boolean {
  return dom?.actionMenu.isOpen() ?? false;
}

/** Take down the sidebar's tooltip at once, without its fade — content.ts
 *  calls it as a capture starts, since a tooltip resting on a sidebar control
 *  can reach over the page and would otherwise end up in the screenshot. */
export function hideTooltipNow(): void {
  dom?.tooltips.hide({ immediate: true });
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
/** The latest pointer x of the drag, not yet applied, and the frame that
 *  will apply it: the width (five inline declarations on <html>, the
 *  backstop sheet and a synthetic `resize` for the page) is written once
 *  per frame, however many mousemoves arrive in it. */
let resizePendingX: number | null = null;
let resizeFrame: number | null = null;

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
  resizeGrabOffset = viewportRightEdge() - e.clientX - getSidebarWidth();
  dom?.resizer.classList.add('dragging');
  window.addEventListener('mousemove', onResizeDragMove, true);
  window.addEventListener('mouseup', onResizeDragEnd, true);
}

function onResizeDragMove(e: MouseEvent): void {
  if (!resizeDragging) return;
  resizePendingX = e.clientX;
  if (resizeFrame === null) resizeFrame = requestAnimationFrameSafe(applyPendingResize);
}

/** The frame's one width write: the latest pointer position of the drag. */
function applyPendingResize(): void {
  resizeFrame = null;
  if (resizePendingX === null) return;
  const x = resizePendingX;
  resizePendingX = null;
  setSidebarWidth(viewportRightEdge() - x - resizeGrabOffset);
}

function onResizeDragEnd(): void {
  if (!resizeDragging) return;
  // The last move before the release lands now, not a frame later.
  if (resizeFrame !== null) cancelAnimationFrameSafe(resizeFrame);
  applyPendingResize();
  endResizeDrag();
  // Commit: one storage write per gesture, not one per frame.
  setSidebarWidth(getSidebarWidth(), { persist: true });
}

function endResizeDrag(): void {
  resizeDragging = false;
  if (resizeFrame !== null) cancelAnimationFrameSafe(resizeFrame);
  resizeFrame = null;
  resizePendingX = null;
  dom?.resizer.classList.remove('dragging');
  window.removeEventListener('mousemove', onResizeDragMove, true);
  window.removeEventListener('mouseup', onResizeDragEnd, true);
}

/** Keyboard equivalent of the drag: left grows the panel (it grows leftwards,
 *  into the page), right shrinks it. Home/End jump to the extremes. */
function onResizerKeyDown(e: KeyboardEvent): void {
  let next: number | null = null;
  if (e.key === 'ArrowLeft') next = getSidebarWidth() + RESIZE_KEY_STEP;
  else if (e.key === 'ArrowRight') next = getSidebarWidth() - RESIZE_KEY_STEP;
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
  return dom !== null;
}

/** Show the sidebar and shrink the page to make room for it. Safe to call when
 *  already open (re-asserts visibility and the page resize). */
export function openSidebar(): void {
  if (!dom) return;
  dom.panel.hidden = false;
  visible = true;
  applyPageResize(getSidebarWidth());
  syncDockMotion();
  isolateKeys();
}

// ---------------------------------------------------------------------------
// Keyboard isolation (REQUIREMENTS NF-ISO-1, NF-A11Y-2)
//
// Keys pressed in the panel never reach the page. A page's shortcut library
// listens on `document` and cannot see that focus is inside our closed
// shadow root, so without this it took every key pressed in the sidebar for
// its own: "k" paused a video, and a handler calling preventDefault() on
// Enter or Space cancelled the native activation of every button here.
// keyboardIsolation.ts stops the key at window capture, before the page
// sees it (but never cancels it, so the native activation still runs); that
// also stops it before the panel's own keydown listeners (the add button's
// shift+Enter, the menu's arrows and Esc, the resize handle's arrows, a
// list item's Enter and Space), so the hook hands each of those a copy of
// the key first: the same key, dispatched at the element it was pressed on,
// not composed, so it bubbles inside the root and never leaves it. A copy a
// listener cancels cancels the real key, which is what stops a native
// activation those listeners replace. While the enlarged view is open, its
// own isolation takes every key in this host first (the key router's
// ENLARGED_ISOLATION runs before SIDEBAR_ISOLATION).
// ---------------------------------------------------------------------------

/** The panel's isolation, while it is shown. */
let keyIsolation: KeyboardIsolationHandle | null = null;

function isolateKeys(): void {
  if (keyIsolation || !dom) return;
  keyIsolation = installKeyboardIsolation(dom.host, handOnInside, KEY_PRIORITY.SIDEBAR_ISOLATION);
}

function releaseKeys(): void {
  keyIsolation?.release();
  keyIsolation = null;
}

/** Give the panel's own keydown listeners the key the isolation is about to
 *  stop (see the banner). */
function handOnInside(e: KeyboardEvent): void {
  if (!dom) return;
  const target = keyTargetWithin(e, dom.host, dom.shadow);
  if (!(target instanceof Element) || target === dom.host) return;
  const copy = new KeyboardEvent(e.type, {
    key: e.key,
    code: e.code,
    location: e.location,
    repeat: e.repeat,
    isComposing: e.isComposing,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
    composed: false,
  });
  target.dispatchEvent(copy);
  if (copy.defaultPrevented) e.preventDefault();
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
  dom?.actionMenu.close();
  if (dom) {
    dom.panel.hidden = true;
  }
  // The tooltip is the panel's sibling in the root, not its child: hiding
  // the panel does not hide it.
  dom?.tooltips.hide();
  visible = false;
  releaseKeys();
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
  return visible && !!dom?.host.isConnected;
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
//
// Disabled reasons (design spec §AF): export with nothing to export, and
// delete-all with nothing to delete, are "soft" disabled: they look and act
// disabled but stay focusable and hoverable (aria-disabled, not the disabled
// attribute — a truly disabled button gets no pointer events and no focus),
// so the shared tooltip (tooltip.ts, §AG) can show their `data-tip-reason`
// on hover or focus. The attribute is written by tooltip.ts's
// setSoftDisabled().
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
  if (!dom) return;
  const { btnExport, btnMenu, actionMenu, exportGroup, tooltips } = dom;
  const exportBlocked = addModeHold || !exportEnabled;
  btnExport.disabled = exportBlocked;
  // Soft-disabled only for "nothing to export" (§AF): the add-mode hold and
  // an export in flight are brief and plain from context, so they keep the
  // plain disabled state and no tooltip.
  // A tooltip up for the old state would now say the wrong thing: hide it
  // now, not on the tooltip's MutationObserver (a microtask later).
  if (setSoftDisabled(btnExport, !exportBlocked && !siteHasNotes)) tooltips.hide();
  btnMenu.disabled = addModeHold;
  actionMenu.importItem.disabled = !importEnabled;
  if (setSoftDisabled(actionMenu.deleteAllItem, !siteHasNotes)) tooltips.hide();
  exportGroup.classList.toggle('is-disabled', addModeHold);
}

/**
 * Put the sidebar "on hold" for the duration of add mode (design spec v3
 * §H): the note list stops taking pointer and keyboard input and dims to
 * ~0.5, dock magnification is switched off at the handle (rather than fought
 * with CSS — magnified items also bleed out over the page add mode is about
 * to screenshot), and export and "more options" are disabled with the menu
 * closed. The "add note" group and close deliberately stay live: the user
 * must always be able to stop or close.
 *
 * Idempotent, and everything it touches is restored by the same call with
 * `false` — which every one of content.ts's add-mode exit paths makes.
 */
export function setAddModeHold(hold: boolean): void {
  addModeHold = hold;
  if (hold) dom?.actionMenu.close();
  dom?.body.classList.toggle('is-on-hold', hold);
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
  const li = dom?.thumbnailList
    .querySelector<HTMLElement>(`button.thumbnail[data-item-id="${itemId}"]`)
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
    setTimeout(finish, ITEM_REMOVE_TOTAL_MS + REMOVE_TIMER_SLACK_MS);
  });
}

/**
 * A wheel over the panel's fixed chrome scrolls the note list instead of the
 * page. Over the list itself this does nothing: native scrolling handles it,
 * and `.body`'s overscroll-behavior stops it chaining on at the ends.
 */
function onSidebarChromeWheel(e: WheelEvent): void {
  if (!dom || e.ctrlKey) return; // ctrl+wheel is the browser's zoom
  const body = dom.body;
  if (e.composedPath().includes(body)) return;
  e.preventDefault();
  // Chrome reports pixels; lines and pages are what other engines send, and
  // cost nothing to honour.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? body.clientHeight : 1;
  body.scrollBy({ top: e.deltaY * unit, left: 0 });
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
  if (!dom) return;
  const held = dom.thumbnailList.querySelectorAll<HTMLButtonElement>('button.thumbnail, button.thumbnail-delete');
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
  if (!dom || !callbacksRef) return;
  const { heading, emptyState, thumbnailList } = dom;
  currentItems = items.slice();
  if (items.length === 0) {
    heading.hidden = true;
    emptyState.hidden = false;
    thumbnailList.hidden = true;
    thumbnailList.innerHTML = '';
    syncDockMotion();
    return;
  }
  // "this page (n)" (design spec §3.1) — only ever shown alongside the list,
  // never alongside the empty state.
  heading.textContent = `this page (${items.length})`;
  heading.hidden = false;
  emptyState.hidden = true;
  thumbnailList.hidden = false;
  // Tear the old motion layer down *before* the repaint so it releases the
  // outgoing <li>s, then attach a fresh one to the new ones.
  dockMotion?.destroy();
  dockMotion = null;
  renderThumbnailList(thumbnailList, items, {
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
  if (!visible || !dom) return false;
  const btn = dom.thumbnailList.querySelector<HTMLButtonElement>(`button.thumbnail[data-item-id="${id}"]`);
  if (!btn) return false;
  btn.focus();
  return true;
}

/** The pointer's clientY if it is genuinely over the list right now, else
 *  null. The coordinate is only trusted when it still falls inside the
 *  list's box: after a delete the list is shorter, and the pointer that was
 *  over the last row may now be past the end of it. */
function pointerYOverList(): number | null {
  if (lastListPointerY === null || !dom) return null;
  const r = dom.thumbnailList.getBoundingClientRect();
  return lastListPointerY >= r.top && lastListPointerY <= r.bottom ? lastListPointerY : null;
}

/** Keep exactly one dock-motion layer alive while the sidebar is visible and
 *  showing items, and none otherwise (so a closed sidebar holds no rAF,
 *  listeners or matchMedia subscription). */
function syncDockMotion(): void {
  const list = dom?.thumbnailList ?? null;
  const wanted = visible && !!list && !list.hidden && list.children.length > 0;
  if (wanted && !dockMotion && dom && list) {
    dockMotion = attachDockMotion(list, {
      scrollContainer: dom.body,
      // Only when the pointer really is over the list right now: a stale
      // coordinate would magnify a row nobody is pointing at.
      initialPointerY: pointerYOverList(),
      // See .body's CSS: the scroller only paints (and stops taking pointer
      // events) over the page while something is actually magnified.
      onBleedChange: (bleeding) => dom?.body.classList.toggle('is-bleeding', bleeding),
      holdTargets: [dom.resizer],
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
  if (!dom) return null;
  return {
    host: dom.host,
    shadow: dom.shadow,
    sidebarEl: dom.panel,
    getSidebarWidth: () => getSidebarWidth(),
    getListLayout: () => sidebarLayoutFor(getSidebarWidth()),
    getLogoSrc: () => dom?.logoImg.src ?? '',
    getListThumb: (id) =>
      dom?.thumbnailList.querySelector<HTMLElement>(`button.thumbnail[data-item-id="${id}"] .thumbnail-image-wrap`) ?? null,
    getListViewport: () => dom?.body.getBoundingClientRect() ?? null,
    centreListOn: (id) => {
      const li = dom?.thumbnailList.querySelector(`button.thumbnail[data-item-id="${id}"]`)?.closest('li');
      if (!li || !dom) return;
      const body = dom.body;
      const b = body.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      body.scrollTop += r.top + r.height / 2 - (b.top + b.height / 2);
    },
    renderList: (items) => renderItems(items),
    setDockSuspended: (suspended) => {
      enlargedDockSuspended = suspended;
      syncDockSuspension();
    },
    focusListItem: (id) => focusThumbnail(id),
    focusFallback: () => {
      if (visible) dom?.btnAdd.focus({ preventScroll: true });
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
  dom?.actionMenu.cancelQuestion();
  enlargedView?.destroy();
  enlargedView = null;
  currentItems = [];
  currentEditedTitle = null;
  enlargedDockSuspended = false;
  dockMotion?.destroy();
  dockMotion = null;
  dom?.actionMenu.close();
  clearMessage();
  endResizeDrag();
  restorePageResize();
  releaseKeys();
  if (dom) {
    dom.actionMenu.destroy();
    dom.panel.removeEventListener('wheel', onSidebarChromeWheel);
    dom.host.parentNode?.removeChild(dom.host);
  }
  if (switchGraceTimer !== null) clearTimeout(switchGraceTimer);
  switchGraceTimer = null;
  switchRevealStartedAt = -Infinity;
  dom?.tooltips.destroy();
  dom = null;
  siteHasNotes = false;
  callbacksRef = null;
  visible = false;
  dockSuspended = false;
  addModeHold = false;
  exportEnabled = true;
  importEnabled = true;
  // Hard reset, not a soft close: the next initSidebar() re-reads the
  // persisted width from scratch, so in-memory width state must not leak
  // across a teardown.
  unsubscribeWidth?.();
  unsubscribeWidth = null;
  resetSidebarWidth();
}

// ---------------------------------------------------------------------------
// Notifications (src/notifications.ts)
// ---------------------------------------------------------------------------

/** Show the error bar inside the sidebar. Auto-clears after 8s. */
export function showError(message: string): void {
  dom?.notifications.showError(message);
}

/** Show the warning bar inside the sidebar. Auto-clears after 8s. */
export function showWarning(message: string): void {
  dom?.notifications.showWarning(message);
}

/** Hide whatever notification is showing and cancel its auto-clear timer. */
export function clearMessage(): void {
  dom?.notifications.clear();
}

/** Test-only: the page-resize machinery's state, with the panel's width. */
export function _pageResizeStateForTests(): {
  applied: boolean;
  observing: boolean;
  reasserts: number;
  styleSheetAttached: boolean;
  width: number;
} {
  return { ...pageResizeStateForTests(), width: getSidebarWidth() };
}
