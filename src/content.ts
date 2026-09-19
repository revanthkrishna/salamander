// src/content.ts
// Content script main entry.
//
// Phase 3 rebuilds the sidebar shell (src/sidebar.ts) on top of the Phase 0
// stub and wires it up to real UI: ACTIVATE / ICON_CLICKED open and toggle
// it, SPA navigation refreshes its (currently empty) thumbnail list, and its
// own close button restores the page and tells the service worker so a
// later reload doesn't bring the sidebar back uninvited (§1.1).
//
// Phase 5 wires the sidebar's "add" button all the way through: add mode
// (src/addMode.ts) produces a selection + note, the capture pipeline
// (src/capture.ts) turns that into a stored feedback item, and this file
// decides what happens to add mode and the sidebar on either outcome — see
// handleCaptureOk below.
//
// Phase 7 wires the thumbnail list and the enlarged view (src/thumbnails.ts,
// src/enlargedView.ts — design spec v2 §D, which replaced the old centred
// modal): this file is the message-sending orchestrator for both (same role
// it already plays for capture/save), fetching a domain's/URL's items via
// GET_PAGE_ITEMS and handing them to sidebar.setThumbnails(), and supplying
// the enlarged view's fetchFullImage/onSaveNote/onDelete callbacks so that
// pure-DOM module never has to touch chrome.runtime itself.
//
// What survives from Phase 0/2 untouched, per the inventory table:
//   1. The double-injection idempotency guard.
//   2. The chrome.runtime message listener shape (PING / ACTIVATE / ICON_CLICKED).
//   3. SPA navigation detection (history.pushState/replaceState patching +
//      popstate/hashchange + debounce).
//   4. Teardown on beforeunload.
//
// What Phase 3 removes: the legacy `setTabActive` call. That was a Phase 0
// placeholder standing in for real sidebar-open persistence; the real
// mechanism is chrome.storage.session, keyed by tab id (§1.1), which is only
// reachable from the extension context (service worker) — a content script
// has no direct access to chrome.storage.session by default. So instead of
// writing that state itself, the content script *tells* the background
// script when the sidebar opens/closes (SIDEBAR_OPENED / SIDEBAR_CLOSED,
// src/messages.ts), and background.ts (Phase 2) is the one that actually
// persists it and decides whether to re-inject + re-ACTIVATE on a later
// full-page reload.

import { normaliseUrl, normaliseDomain } from './urlNorm';
import * as sidebar from './sidebar';
import * as addMode from './addMode';
import * as capture from './capture';
import { ensureFontsLoaded, primeThemeMode } from './theme';
import { parseImportBundle } from './import';
import { FeedbackItem, ImportError, ImportErrorCode, ImportErrorDetails } from './types';
import {
  SidebarOpenedMessage,
  SidebarClosedMessage,
  GetPageItemsMessage,
  GetPageItemsResponse,
  GetImageMessage,
  GetImageResponse,
  UpdateNoteMessage,
  UpdateNoteResponse,
  DeleteItemMessage,
  DeleteItemResponse,
  ExportMessage,
  ExportResponse,
  ImportReplaceMessage,
  ImportReplaceResponse,
  GetDomainItemCountMessage,
  GetDomainItemCountResponse,
} from './messages';

// §5 #7's alert text is fixed and verbatim; this is the fallback shown when
// the export round trip itself fails (a dead service worker, etc.) — not one
// of the 11 numbered §5 cases, but kept lowercase and in the same tone.
const EXPORT_ROUND_TRIP_FAILED_MESSAGE = "couldn't export feedback. try again.";

// Fallback shown when the import round trip itself fails (dead service
// worker, etc.) rather than a validation failure §5 already has copy for.
const IMPORT_ROUND_TRIP_FAILED_MESSAGE = "couldn't import this bundle. try again.";

// Shown when a note is clicked while add mode's comment box holds typed text
// — opening it would throw that text away.
const FINISH_NOTE_FIRST_MESSAGE = 'finish or cancel your note first.';

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency guard + runtime init (wrapped in IIFE so we can `return` instead
// of throwing — a throw here shows as a console error even though it's intentional).
// ─────────────────────────────────────────────────────────────────────────────
void (function annotatorMain() {

if ((window as any).__annotatorActive) {
  return; // Already running on this page — silent exit, no console error.
}
(window as any).__annotatorActive = true;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let myTabId: number = -1;
let lastKnownUrl = location.href;
let started = false;

// ─────────────────────────────────────────────────────────────────────────────
// Add-mode toggle + lock (design spec v2 §A)
//
// The sidebar's "add note" button is a three-state toggle — off / on / locked
// — and this module is the only thing that ever moves it between those
// states, so the button's visuals (sidebar.setAddButtonState) can never drift
// from addMode.isAddModeActive()'s real state. Every one of add mode's exit
// paths (capture success/failure, cancel, Esc, sidebar close, SPA navigation,
// opening the enlarged view) funnels through exitAddModeFully() or
// handleAddModeCancel() below rather than calling addMode.exitAddMode()
// directly, so "sync in every path" only has to be true in one place.
// ─────────────────────────────────────────────────────────────────────────────

/** True for the whole of a "locked" add-mode session (double-click), until a
 *  single click on the button or Esc ends it (§A). Survives any number of
 *  successful captures / per-note cancels in between — see enterAddMode(). */
let addLocked = false;

/**
 * A click while add mode is already on (unlocked) that follows another click
 * on the button within this window might be the *second* click of a
 * double-click that the native 'dblclick' event (fired right after) will
 * turn into "lock" instead. Only then is the toggle-off deferred by this
 * much, so the dblclick has a chance to pre-empt it — comfortably longer
 * than any OS's double-click timing. A deliberate, lone "off" click acts
 * immediately, and the first click of any pair (off -> on) is never delayed
 * — see handleAddButtonClick.
 */
const ADD_DBLCLICK_WINDOW_MS = 400;

/** When the button was last clicked (Date.now()), for the pairing above. */
let lastAddClickAt = -Infinity;

/** Pending "toggle off" from a single click while on (unlocked); cleared if a
 *  dblclick or another exit path pre-empts it. */
let pendingAddOffTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingAddOff(): void {
  if (pendingAddOffTimer !== null) {
    clearTimeout(pendingAddOffTimer);
    pendingAddOffTimer = null;
  }
}

/** Enter add mode (fresh placement) and paint the button for whatever
 *  addLocked currently is — the single entry point for every "start/restart
 *  add mode" path: the first click off -> on, and locked re-entry after a
 *  successful capture or a per-note cancel. */
function enterAddMode(): void {
  // The enlarged view and add mode can never coexist (design spec v2 §D) —
  // nothing of it may be on screen for add mode's capture. Cancel-then-run
  // (MOTION_SPEC §13): kill it instantly to its resting closed state, no
  // half-collapse frame. A no-op when it isn't open.
  sidebar.collapseEnlargedView({ immediate: true, force: true });
  // No dock magnification for the whole of add mode: swollen note items grow
  // out over the page, which is exactly what add mode selects and
  // screenshots. Suspending snaps them back to rest instantly (no release
  // animation that could still be in flight at capture time). Lifted by
  // finishAddMode() on every exit path.
  sidebar.setDockMagnificationSuspended(true);
  addMode.startAddMode({
    onOk: (result) => {
      // Phase 5's capture pipeline (src/capture.ts) owns everything between
      // "ok" and a stored item; this side only decides what happens to add
      // mode/the sidebar afterwards (handleCaptureOk below).
      void handleCaptureOk(result);
    },
    onCancel: handleAddModeCancel,
  });
  sidebar.setAddButtonState(addLocked ? 'locked' : 'on');
}

/** Common tail of every full exit: drop the lock, hand the list its dock
 *  magnification back, and paint the button off. Does NOT touch add mode
 *  itself — callers that still need to call addMode.exitAddMode() do so
 *  first (see exitAddModeFully). */
function finishAddMode(): void {
  addLocked = false;
  sidebar.setDockMagnificationSuspended(false);
  sidebar.setAddButtonState('off');
}

/** Full stop: exits add mode (a no-op if it's already idle) and resets the
 *  lock/button/dock state. Every exit path that isn't "cancel a note while
 *  locked, stay in add mode" goes through this — capture failure never does
 *  (add mode stays exactly as the user left it), but Esc, a click while
 *  locked, sidebar close, SPA navigation and opening a note's enlarged view
 *  all do (§A, and "sidebar state must stay in sync … in every path"). */
function exitAddModeFully(): void {
  clearPendingAddOff();
  addMode.exitAddMode();
  finishAddMode();
}

/** addMode.ts's onCancel — fired once add mode has already torn itself down
 *  for this note (exitAddMode() already ran). While locked this only cancels
 *  the one note; the lock (and add mode) persists, so re-enter immediately
 *  rather than falling all the way to "off" (§A). */
function handleAddModeCancel(): void {
  clearPendingAddOff();
  if (addLocked) {
    enterAddMode();
    return;
  }
  finishAddMode();
}

/** The "add note" button's click handler (sidebar.SidebarCallbacks.onAdd). */
function handleAddButtonClick(): void {
  const now = Date.now();
  const pairedClick = now - lastAddClickAt < ADD_DBLCLICK_WINDOW_MS;
  lastAddClickAt = now;
  if (!addMode.isAddModeActive()) {
    // Off -> on: act immediately, never delayed (the double-click ambiguity
    // below only ever applies to the *second* click of a pair).
    enterAddMode();
    return;
  }
  if (addLocked) {
    // A single click while locked exits lock AND add mode outright (§A) —
    // no dblclick disambiguation needed, since locked has no "on-but-not-
    // locked" state to fall back to.
    exitAddModeFully();
    return;
  }
  // On, unlocked, and not right after another click: a lone "turn it off".
  if (!pairedClick) {
    exitAddModeFully();
    return;
  }
  // Right after another click: possibly the second click of a double-click
  // the browser is about to report — defer the toggle-off just long enough
  // for that native 'dblclick' (handled below) to pre-empt it and lock.
  if (pendingAddOffTimer !== null) return;
  pendingAddOffTimer = setTimeout(() => {
    pendingAddOffTimer = null;
    exitAddModeFully();
  }, ADD_DBLCLICK_WINDOW_MS);
}

/** sidebar.SidebarCallbacks.onAddDoubleClick — the lock gesture: the native
 *  browser 'dblclick' that follows the click pair handleAddButtonClick
 *  already saw, or a shift+click / shift+Enter / shift+Space. Converts the
 *  pending toggle-off (if any) into "locked on" instead (§A); from off (the
 *  shift gestures) it enters add mode already locked. */
function handleAddButtonDoubleClick(): void {
  clearPendingAddOff();
  if (addLocked) return;
  addLocked = true;
  if (!addMode.isAddModeActive()) {
    enterAddMode();
    return;
  }
  sidebar.setAddButtonState('locked');
}

/** Esc always exits both lock and add mode (§A), regardless of what state
 *  add mode is in ('placing' or 'editing') or whether it's locked. Installed
 *  on `window` in the capture phase, once, in ensureStarted() — i.e. *before*
 *  addMode.ts ever installs its own capture-phase keyboardIsolation listener
 *  for a given add-mode session, so this always sees the keydown first
 *  (capture-phase listeners on the same node run in registration order) and
 *  can act on it even though addMode.ts's isolation would otherwise stop the
 *  event from ever reaching a page/document-level listener. */
function handleGlobalKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Esc during IME composition cancels the composition, not add mode.
  if (e.isComposing || e.keyCode === 229) return;
  if (!addMode.isAddModeActive()) return;
  exitAddModeFully();
}

// Start reading the persisted theme mode now, at script load: ACTIVATE
// (which builds and shows the sidebar) arrives a message round trip later,
// by which point the read has normally settled, so the panel's first paint
// is already in the right theme. sidebar.openSidebar() also holds the panel
// invisible (briefly, capped) if it hasn't — see revealWhenThemeSettled.
primeThemeMode();

// ─────────────────────────────────────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ alive: true, tabId: myTabId });
    return;
  }
  if (message.type === 'ACTIVATE') {
    init(message.tabId as number);
    return;
  }
  if (message.type === 'ICON_CLICKED') {
    toggleSidebar();
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// init — always means "the sidebar should be open" (§1.1): background only
// sends ACTIVATE either right after a fresh injection (icon clicked on a
// page with no content script yet — the user just asked to open it) or
// after re-injecting on a full reload *because* chrome.storage.session said
// the sidebar was previously open. Either way, the right response is the
// same: show the sidebar and let background know so the persisted state
// stays correct.
// ─────────────────────────────────────────────────────────────────────────────

function init(tabId: number): void {
  myTabId = tabId;
  ensureStarted();
  openAndReport();
}

/**
 * Build the sidebar and attach the page-lifetime listeners, exactly once per
 * document. Split out of init() because ICON_CLICKED can legitimately arrive
 * without a preceding ACTIVATE — background only sends it once PING has
 * answered, and PING answers as soon as this script is *loaded*, which is
 * strictly earlier than ACTIVATE being delivered (or at all, if that message
 * was lost to a navigation). Toggling before the sidebar exists used to be a
 * silent no-op that still told background the sidebar was open.
 */
function ensureStarted(): void {
  if (started) return;
  started = true;

  // Salamander design fonts (src/theme.ts): fetched once, lazily, and
  // registered via the FontFace API — shadow-DOM @font-face is ignored by
  // Chrome and a host page's CSP can block a chrome-extension:// font URL,
  // so this can't just be a CSS @font-face rule (design spec §5). Fails
  // silently to the system font stack if anything goes wrong.
  void ensureFontsLoaded();

  sidebar.initSidebar({
    onAdd: handleAddButtonClick,
    onAddDoubleClick: handleAddButtonDoubleClick,
    onExport: () => {
      void handleExport();
    },
    onImportFile: (file: File) => {
      void handleImportFile(file);
    },
    onClose: () => {
      // sidebar.ts has already hidden itself by the time this fires (see
      // SidebarCallbacks.onClose's doc comment) — but add mode hasn't, so
      // the same "sidebar requires add mode" sync as toggleSidebar() below
      // applies here too (§A sync).
      if (addMode.isAddModeActive()) exitAddModeFully();
      notifyBackground({ type: 'SIDEBAR_CLOSED' });
    },
    onOpenItem: (item) => {
      // Add mode can't coexist with the enlarged view (design spec v2 §D) —
      // and the sidebar's own thumbnails sit above add mode's page blocker
      // (higher z-index), so they're still clickable while add mode is
      // active. A comment already being typed wins: the click is ignored
      // (with a nudge) rather than silently discarding it. Otherwise exit
      // fully first so the button/lock state stays in sync.
      if (addMode.hasPendingComment()) {
        sidebar.showWarning(FINISH_NOTE_FIRST_MESSAGE);
        return;
      }
      if (addMode.isAddModeActive()) exitAddModeFully();
      openItemEnlarged(item);
    },
  });
  setupNavigationDetection();
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('pagehide', handleBeforeUnload);
  // Esc-exits-add-mode (§A) — see handleGlobalKeyDown's doc comment for why
  // this has to be registered once, here, rather than per add-mode session.
  window.addEventListener('keydown', handleGlobalKeyDown, true);
}

/**
 * §1.2 step 4: "add mode exits; sidebar restores; a new thumbnail appears at
 * the bottom of the sidebar list" — except while locked (§A v2), where the
 * user is put straight back into add mode (a fresh placement) instead of
 * exiting, so several notes can be added without re-clicking the button.
 *
 * On failure the opposite: add mode stays exactly as the user left it (the
 * capture pipeline has already restored the hidden overlay and re-enabled
 * cancel/ok), no item exists anywhere (§1.3, §5 #8), and the reason is shown
 * in the sidebar's error bar — lowercase, verbatim from §5. The lock/button
 * state is untouched either way, since add mode itself hasn't exited.
 */
async function handleCaptureOk(result: addMode.AddModeResult): Promise<void> {
  const outcome = await capture.captureAndSave(result, {
    hide: addMode.hideOverlayUI,
    show: addMode.showOverlayUI,
  });

  if (!outcome.ok) {
    sidebar.showError(outcome.message);
    return;
  }

  addMode.exitAddMode();
  if (addLocked) {
    enterAddMode();
  } else {
    finishAddMode();
  }
  // Re-read the list for the current URL so the new item shows up.
  void refreshThumbnails();
}

function openAndReport(): void {
  sidebar.openSidebar();
  void refreshThumbnails();
  lastKnownUrl = location.href;
  notifyBackground({ type: 'SIDEBAR_OPENED' });
}

function toggleSidebar(): void {
  ensureStarted();
  if (sidebar.isSidebarVisible()) {
    // Closing the sidebar is a way of leaving the enlarged view, so it obeys
    // the "a note can never be empty" lock (§D): refused (the view shows its
    // inline error) until the note has text.
    if (!sidebar.collapseEnlargedView({ immediate: true })) return;
    // Add mode requires the sidebar (its bounds exclude the docked strip,
    // and its own button reflects add mode's state) — closing the sidebar
    // while it's active would leave a page-covering overlay with no visible
    // "on"/"locked" affordance anywhere. Exit fully first (§A sync).
    if (addMode.isAddModeActive()) exitAddModeFully();
    sidebar.closeSidebar();
    notifyBackground({ type: 'SIDEBAR_CLOSED' });
  } else {
    openAndReport();
  }
}

function notifyBackground(message: SidebarOpenedMessage | SidebarClosedMessage): void {
  chrome.runtime.sendMessage(message, () => {
    if (chrome.runtime.lastError) {
      // Background/service worker not reachable — nothing actionable here;
      // the persisted "sidebar open" state simply won't update this time.
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA navigation detection
// ─────────────────────────────────────────────────────────────────────────────

function setupNavigationDetection(): void {
  const debouncedHandleUrlChange = debounce(handleUrlChange, 50);

  const origPush = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    debouncedHandleUrlChange();
  };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    debouncedHandleUrlChange();
  };

  window.addEventListener('popstate', debouncedHandleUrlChange);
  window.addEventListener('hashchange', debouncedHandleUrlChange);
}

function handleUrlChange(): void {
  const newUrl = normaliseUrl(location.href);
  if (newUrl === normaliseUrl(lastKnownUrl)) return;
  lastKnownUrl = location.href;

  // A route change swaps out the page add mode is selecting/screenshotting
  // from under it — exit fully rather than leave a stale overlay (and a
  // button state) pointed at content that's already gone (§A sync).
  if (addMode.isAddModeActive()) exitAddModeFully();
  // The enlarged view is showing notes of the page we just left.
  sidebar.collapseEnlargedView({ immediate: true, force: true });

  // The sidebar itself (open/closed, and its page-resize) is untouched by
  // navigation — §1.1 requires it to persist across SPA route changes.
  // Only its thumbnail list content depends on the URL.
  if (sidebar.isSidebarVisible()) {
    void refreshThumbnails();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — thumbnail list + enlarged view message plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** chrome.runtime.sendMessage as a promise that never rejects: a dead service
 *  worker or a torn-down port surfaces as `undefined`, which every caller
 *  here already has to treat as a failure. Mirrors capture.ts's private
 *  helper of the same shape. */
function sendMessage<TResponse>(message: unknown): Promise<TResponse | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response);
      });
    } catch {
      // Extension context invalidated (e.g. reloaded while the page stayed open).
      resolve(undefined);
    }
  });
}

/** Fetch the current URL's feedback items and repaint the sidebar's thumbnail
 *  list (§1.5 — "current URL only"). Called on open, on every SPA navigation,
 *  after a successful capture, and after the enlarged view closes (an edit or
 *  a delete may have changed what should be showing). */
async function refreshThumbnails(): Promise<void> {
  const message: GetPageItemsMessage = {
    type: 'GET_PAGE_ITEMS',
    domain: normaliseDomain(location.host),
    normalisedUrl: normaliseUrl(location.href),
  };
  const response = await sendMessage<GetPageItemsResponse>(message);
  if (!response || !response.ok) {
    sidebar.setThumbnails([]);
    if (response && !response.ok) sidebar.showError(response.message);
    return;
  }
  sidebar.setThumbnails(response.items);
}

/**
 * §1.6 — export every feedback item across every URL of the current domain
 * as a `.zip` download. The service worker (src/export.ts) does the actual
 * assembly and download (gotchas #1, #4); this side's only job is the
 * message round trip and surfacing the two possible non-success outcomes:
 * §5 #7's empty-domain alert, or a generic failure in the sidebar's error
 * bar. The export button is disabled for the duration so a second click
 * can't start a second download mid-assembly.
 */
async function handleExport(): Promise<void> {
  sidebar.setExportButtonEnabled(false);
  try {
    const message: ExportMessage = {
      type: 'EXPORT',
      domain: normaliseDomain(location.host),
    };
    const response = await sendMessage<ExportResponse>(message);
    if (!response) {
      sidebar.showError(EXPORT_ROUND_TRIP_FAILED_MESSAGE);
      return;
    }
    if (!response.ok) {
      if (response.code === 'EMPTY') {
        alert('nothing to export'); // §5 #7, verbatim
      } else {
        sidebar.showError(response.message);
      }
    }
  } finally {
    sidebar.setExportButtonEnabled(true);
  }
}

/**
 * §1.7 — import a `.zip` bundle. src/import.ts owns the whole §5 validation
 * ladder (unzip, parse, screenshot/duplicate/domain checks); this side's job
 * is the UI orchestration around it: report a validation failure verbatim,
 * show the §5 #6 warning if the bundle is newer, ask how many existing items
 * a replace would discard (§5 #10) and confirm before doing it, then send
 * the validated bundle to the service worker to actually write. The import
 * button is disabled for the duration so a second pick can't overlap the
 * first (mirrors handleExport's setExportButtonEnabled).
 */
async function handleImportFile(file: File): Promise<void> {
  sidebar.setImportButtonEnabled(false);
  try {
    const currentDomain = normaliseDomain(location.host);

    let bundle;
    try {
      bundle = await parseImportBundle(file, currentDomain);
    } catch (err) {
      sidebar.showError(
        err instanceof ImportError ? importErrorMessage(err.code, err.details) : IMPORT_ROUND_TRIP_FAILED_MESSAGE,
      );
      return;
    }

    if (bundle.versionWarning) {
      sidebar.showWarning(importErrorMessage('VERSION_MISMATCH'));
    }

    const countMessage: GetDomainItemCountMessage = {
      type: 'GET_DOMAIN_ITEM_COUNT',
      domain: currentDomain,
    };
    const countResponse = await sendMessage<GetDomainItemCountResponse>(countMessage);
    const existingCount = countResponse?.ok ? countResponse.count : 0;

    if (existingCount > 0) {
      // §5 #10, verbatim.
      const confirmed = await sidebar.showConfirmDialog(
        `importing will replace your current ${existingCount} feedback item(s) for this site. this cannot be undone. continue?`,
      );
      if (!confirmed) return;
    }

    const replaceMessage: ImportReplaceMessage = {
      type: 'IMPORT_REPLACE',
      domain: currentDomain,
      items: bundle.items,
    };
    const replaceResponse = await sendMessage<ImportReplaceResponse>(replaceMessage);
    if (!replaceResponse || !replaceResponse.ok) {
      sidebar.showError(replaceResponse?.message ?? IMPORT_ROUND_TRIP_FAILED_MESSAGE);
      return;
    }

    // §1.7: sidebar opens (if not already) showing the current url's items.
    if (!sidebar.isSidebarVisible()) {
      openAndReport();
    } else {
      void refreshThumbnails();
    }
  } finally {
    sidebar.setImportButtonEnabled(true);
  }
}

/** §5's error/warning copy, lowercase and verbatim. The one parameterised
 *  row (#5, domain mismatch) fills in from `ImportError.details`. */
function importErrorMessage(code: ImportErrorCode, details?: ImportErrorDetails): string {
  switch (code) {
    case 'INVALID_FILE_TYPE':
      return 'invalid file type. please upload a .zip feedback bundle.';
    case 'CORRUPT_ARCHIVE':
      return 'could not read this file — it appears to be corrupted.';
    case 'MISSING_MANIFEST':
      return "this doesn't look like a feedback bundle.";
    case 'MALFORMED_CONTEXT':
      return "this bundle appears to be corrupted (couldn't read feedback data).";
    case 'MISSING_SCREENSHOT':
      return "this file is missing screenshot data and can't be imported.";
    case 'DOMAIN_MISMATCH':
      return `this bundle contains feedback for '${details?.fileDomain}', but you're currently on '${details?.currentDomain}'.`;
    case 'DUPLICATE_IDS':
      return 'this bundle appears to be corrupted (duplicate item ids).';
    case 'VERSION_MISMATCH':
      return 'this bundle was created with a newer version of the extension. some feedback may not display correctly.';
    default:
      return IMPORT_ROUND_TRIP_FAILED_MESSAGE;
  }
}

/** Expand the sidebar into the enlarged view on one note (design spec v2
 *  §D), wiring its callbacks onto the GET_IMAGE / UPDATE_NOTE / DELETE_ITEM
 *  round trips (enlargedView.ts itself never touches chrome.runtime — gotcha
 *  #1/#3). The view navigates between notes itself, so every callback takes
 *  the note it's acting on. */
function openItemEnlarged(item: FeedbackItem): void {
  const domain = normaliseDomain(location.host);

  sidebar.openEnlargedView(item.id, {
    fetchFullImage: async (target) => {
      const getImage: GetImageMessage = { type: 'GET_IMAGE', screenshotKey: target.screenshotKey };
      const response = await sendMessage<GetImageResponse>(getImage);
      return response && response.ok ? response.dataUrl : null;
    },
    onSaveNote: async (target, note) => {
      const updateNote: UpdateNoteMessage = {
        type: 'UPDATE_NOTE',
        domain,
        normalisedUrl: target.normalisedUrl,
        itemId: target.id,
        note,
      };
      const response = await sendMessage<UpdateNoteResponse>(updateNote);
      return response?.ok === true;
    },
    onDelete: async (target) => {
      const deleteItemMsg: DeleteItemMessage = {
        type: 'DELETE_ITEM',
        domain,
        normalisedUrl: target.normalisedUrl,
        itemId: target.id,
      };
      const response = await sendMessage<DeleteItemResponse>(deleteItemMsg);
      return response?.ok === true;
    },
    onClosed: (currentId) => {
      // Edits and deletes are already reflected in the list the view handed
      // back; re-reading storage makes it authoritative. Then hand focus back
      // to the note that was current (a no-op if every note was deleted).
      void refreshThumbnails().then(() => {
        if (currentId !== null) sidebar.focusThumbnail(currentId);
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Beforeunload cleanup
// ─────────────────────────────────────────────────────────────────────────────

function handleBeforeUnload(): void {
  // A full navigation/reload destroys this document (and with it, the
  // sidebar's shadow host and any inline style it applied to <html>) —
  // there is nothing to explicitly restore here. If the sidebar was open,
  // it stays recorded as open in chrome.storage.session so background.ts
  // re-injects and re-opens it on the next page (§1.1).
  //
  // The one thing that would be lost: typing in the enlarged view still
  // inside its autosave debounce. Send it now — fire-and-forget (never
  // blocks unload), never an empty note. Runs on both beforeunload and
  // pagehide (the only one fired on some navigations, e.g. bfcache); the
  // second call finds nothing dirty (in-flight saves count as clean).
  sidebar.flushEnlargedView();
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: debounce
// ─────────────────────────────────────────────────────────────────────────────

function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  } as T;
}

})(); // end annotatorMain IIFE
export {};
