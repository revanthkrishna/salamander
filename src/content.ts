// src/content.ts
// Content script main entry.
//
// Wires the sidebar shell (src/sidebar.ts) to the runtime: ACTIVATE /
// ICON_CLICKED open and toggle it, SPA navigation refreshes its thumbnail
// list, and its own close button restores the page and tells the service
// worker so a later reload doesn't bring the sidebar back uninvited (§1.1).
//
// Wires the sidebar's "add" button all the way through: add mode
// (src/addMode.ts) produces a selection + note, the capture pipeline
// (src/capture.ts) turns that into a stored feedback item, and the add-mode
// controller (src/addModeControl.ts, wired here) decides what happens to add
// mode and the sidebar on either outcome.
//
// Wires the thumbnail list and the enlarged view (src/thumbnails.ts,
// src/enlargedView.ts — design spec v2 §D): this file is the message-sending
// orchestrator for both (the same role it plays for capture/save), fetching
// a domain's/URL's items via GET_PAGE_ITEMS and handing them to
// sidebar.setThumbnails(), and supplying the enlarged view's
// fetchFullImage/onSaveNote/onDelete callbacks so that pure-DOM module never
// has to touch chrome.runtime itself.
//
// Also here: the double-injection idempotency guard, the chrome.runtime
// message listener (PING / ACTIVATE / ICON_CLICKED), SPA navigation
// detection (history.pushState/replaceState patching + popstate/hashchange
// + debounce), and teardown on beforeunload.
//
// The "sidebar open" state is deliberately not written from here: it lives
// in chrome.storage.session, keyed by tab id (§1.1), which is only reachable
// from the extension context. So the content script *tells* the background
// script when the sidebar opens/closes (SIDEBAR_OPENED / SIDEBAR_CLOSED,
// src/messages.ts), and background.ts persists it and decides whether to
// re-inject + re-ACTIVATE on a later full-page reload.

import { normaliseUrl, normaliseDomain } from './urlNorm';
import { isTypingTarget } from './shortcut';
import * as sidebar from './sidebar';
import * as addMode from './addMode';
import * as capture from './capture';
import { ensureFontsLoaded } from './theme';
import { parseImportBundle } from './import';
import {
  // The list's hover delete (design spec v4 §L) shares the enlarged view's
  // failure copy rather than declaring a second string for the same event.
  DELETE_ERROR_MESSAGE,
  DELETE_ALL_FAILED_MESSAGE,
  EXPORT_FAILED_MESSAGE,
  FINISH_NOTE_FIRST_MESSAGE,
  IMPORT_FAILED_MESSAGE,
  NOTHING_TO_EXPORT_MESSAGE,
  importErrorMessage,
  deleteAllConfirmMessage,
  DELETE_ALL_CONFIRM_LABEL,
  IMPORT_REPLACE_CONFIRM_LABEL,
  IMPORT_REPLACE_CONFIRM_MESSAGE,
} from './copy';
import type { EnlargedSite } from './enlargedView';
import { FeedbackItem, ImportError } from './types';
import { send } from './rpc';
import {
  BackgroundToContentMessage,
  PingResponse,
  SidebarOpenedMessage,
  SidebarClosedMessage,
  GetPageItemsMessage,
  GetImageMessage,
  GetSitePagesMessage,
  SetPageTitleMessage,
  UpdateItemMessage,
  DeleteItemMessage,
  ExportMessage,
  ImportStageImageMessage,
  ImportCommitMessage,
  ImportAbortMessage,
  GetDomainItemCountMessage,
  GetDomainItemCountResponse,
  DeleteDomainDataMessage,
  GetPenColorMessage,
  SetPenColorMessage,
} from './messages';
import type { PenColor } from './drawing';
import { createAddModeControl } from './addModeControl';

declare global {
  interface Window {
    /** Set by the first injection of this script into a document; a second
     *  injection (the icon clicked again before PING answered, a re-inject
     *  on reload racing an already-alive script) sees it and exits. */
    __annotatorActive?: true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency guard + runtime init (wrapped in IIFE so we can `return` instead
// of throwing — a throw here shows as a console error even though it's intentional).
// ─────────────────────────────────────────────────────────────────────────────
void (function annotatorMain() {

if (window.__annotatorActive) {
  return; // Already running on this page — silent exit, no console error.
}
window.__annotatorActive = true;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let myTabId: number = -1;
let lastKnownUrl = location.href;
let started = false;

// ─────────────────────────────────────────────────────────────────────────────
// The pencil's colour (design spec §AB)
//
// Remembered for the browser session in chrome.storage.session, which only
// the service worker reaches (see messages.ts's GET_PEN_COLOR). Re-read on
// every entry rather than cached for the page, so a colour picked in
// another tab a moment ago is the one this tab draws with. The swatches
// only exist once a box is placed, long after the reply lands.
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped by every local pick, so a GET_PEN_COLOR reply that was already in
 *  flight cannot overwrite a colour the user chose after asking. */
let penColorSeq = 0;

function restorePenColor(): void {
  const seq = ++penColorSeq;
  const message: GetPenColorMessage = { type: 'GET_PEN_COLOR' };
  void send(message).then((response) => {
    if (seq !== penColorSeq || !response || response.color === null) return;
    addMode.setPenColor(response.color);
  });
}

function rememberPenColor(color: PenColor): void {
  penColorSeq++;
  const message: SetPenColorMessage = { type: 'SET_PEN_COLOR', color };
  void send(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-mode toggle + "keep on" switch (design spec v3 §A2): the state machine
// is src/addModeControl.ts; this wires it to the real modules.
// ─────────────────────────────────────────────────────────────────────────────

const addControl = createAddModeControl({
  addMode,
  sidebar,
  captureAndSave: capture.captureAndSave,
  isTypingTarget,
  penColor: { restore: restorePenColor, remember: rememberPenColor },
  onSaved: () => void refreshThumbnails(),
  now: () => Date.now(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
  if (message.type === 'PING') {
    const reply: PingResponse = { alive: true, tabId: myTabId };
    sendResponse(reply);
    return;
  }
  if (message.type === 'ACTIVATE') {
    init(message.tabId);
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
    onAdd: addControl.onButtonClick,
    onAddSwitchChange: addControl.setSwitch,
    onAddDoubleClick: addControl.onButtonDoubleClick,
    onExport: () => {
      void handleExport();
    },
    onImport: () => {
      void handleImportRequest();
    },
    onImportFile: (file: File) => {
      void handleImportFile(file);
    },
    onDeleteAll: () => {
      void handleDeleteAll();
    },
    onClose: () => {
      // sidebar.ts has already hidden itself by the time this fires (see
      // SidebarCallbacks.onClose's doc comment) — but add mode hasn't, so
      // the same "sidebar requires add mode" sync as toggleSidebar() below
      // applies here too (§A2 sync).
      if (addMode.isAddModeActive()) addControl.exitFully();
      notifyBackground({ type: 'SIDEBAR_CLOSED' });
    },
    onOpenItem: (item) => {
      // Add mode can't coexist with the enlarged view (design spec v2 §D).
      // §H now stops the list taking clicks at all for the whole of add
      // mode, so this is a backstop rather than the main defence — the
      // sidebar's thumbnails sit above add mode's page blocker (higher
      // z-index), and an activation could still arrive from a script or a
      // focus already inside the list when the hold went on. A comment
      // already being typed wins: the click is ignored (with a nudge) rather
      // than silently discarding it. Otherwise exit fully first so the
      // control's state stays in sync.
      if (addMode.hasPendingComment()) {
        sidebar.showWarning(FINISH_NOTE_FIRST_MESSAGE);
        return;
      }
      if (addMode.isAddModeActive()) addControl.exitFully();
      void openItemEnlarged(item);
    },
    onDeleteItem: (item) => {
      void handleDeleteItem(item);
    },
  });
  setupNavigationDetection();
  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('pagehide', handleBeforeUnload);
  // Esc-exits-add-mode (§A2) — see onGlobalKeyDown's doc comment
  // (src/addModeControl.ts) for why this has to be registered once, here,
  // rather than per add-mode session.
  window.addEventListener('keydown', addControl.onGlobalKeyDown, true);
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
    // "on"/"kept on" affordance anywhere. Exit fully first (§A2 sync).
    if (addMode.isAddModeActive()) addControl.exitFully();
    sidebar.closeSidebar();
    notifyBackground({ type: 'SIDEBAR_CLOSED' });
  } else {
    openAndReport();
  }
}

/** Fire-and-forget: the background/service worker not being reachable is
 *  not actionable here — the persisted "sidebar open" state simply won't
 *  update this time. */
function notifyBackground(message: SidebarOpenedMessage | SidebarClosedMessage): void {
  void send(message);
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
  // button state) pointed at content that's already gone (§A2 sync).
  if (addMode.isAddModeActive()) addControl.exitFully();
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
// Thumbnail list + enlarged view message plumbing
// ─────────────────────────────────────────────────────────────────────────────

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
  const response = await send(message);
  // Every repaint follows a change that may have emptied or first filled the
  // site (a save, a delete, an import, a navigation), so it is also when
  // export and "delete all" learn whether they have anything to act on.
  void refreshSiteHasNotes();
  if (!response || !response.ok) {
    sidebar.setThumbnails([]);
    if (response && !response.ok) sidebar.showError(response.message);
    return;
  }
  sidebar.setThumbnails(response.items, response.editedTitle);
}

// ─────────────────────────────────────────────────────────────────────────────
// The site's counts, "delete all for this website" and import's question
// (design spec §AE, §AF)
// ─────────────────────────────────────────────────────────────────────────────

let deleteAllInFlight = false;

/** Read the site's note and page counts (every page, not just this one),
 *  through the service worker's write queue, so every write sent before is
 *  counted. A successful read also catches the sidebar up on whether the
 *  site has notes — what greys out export and delete-all (§AF). A failed
 *  one changes nothing; the caller decides what that means. */
async function readSiteCounts(): Promise<GetDomainItemCountResponse | undefined> {
  const message: GetDomainItemCountMessage = {
    type: 'GET_DOMAIN_ITEM_COUNT',
    domain: normaliseDomain(location.host),
  };
  const response = await send(message);
  if (response?.ok) sidebar.setSiteHasNotes(response.count > 0);
  return response;
}

/** Re-read whether the site has any notes, and with it whether export and
 *  "delete all" have anything to act on. A count that cannot be read greys
 *  them out: the safe direction for the one irreversible action in the
 *  product. */
async function refreshSiteHasNotes(): Promise<void> {
  const response = await readSiteCounts();
  if (!response?.ok) sidebar.setSiteHasNotes(false);
}

/**
 * Delete every note on every page of this site, and every screenshot, after
 * the menu turns into a question quoting both counts (§AF) — so it is plain
 * this reaches beyond the page on screen. The counts are read fresh when
 * asked (not trusted from the last repaint), through the same write queue
 * the delete then goes through, so the question counts every write sent
 * before it. Unreachable during add mode (the whole group is disabled, §H)
 * and the enlarged view (the panel is inert behind it).
 */
async function handleDeleteAll(): Promise<void> {
  if (deleteAllInFlight) return;
  const domain = normaliseDomain(location.host);

  const counts = await readSiteCounts();
  if (!counts || !counts.ok) {
    sidebar.closeMoreOptionsMenu();
    sidebar.showError(counts ? counts.message : DELETE_ALL_FAILED_MESSAGE);
    return;
  }
  if (counts.count === 0) {
    // Emptied since the item was last enabled (e.g. from the enlarged view):
    // nothing to ask — readSiteCounts has already greyed the item out.
    sidebar.closeMoreOptionsMenu();
    return;
  }

  const confirmed = await sidebar.confirmInMenu(
    deleteAllConfirmMessage(counts.count, counts.pageCount),
    DELETE_ALL_CONFIRM_LABEL,
  );
  if (!confirmed) return;

  deleteAllInFlight = true;
  try {
    const message: DeleteDomainDataMessage = { type: 'DELETE_DOMAIN_DATA', domain };
    const response = await send(message);
    if (!response || !response.ok) {
      sidebar.showError(response?.message ?? DELETE_ALL_FAILED_MESSAGE);
    }
  } finally {
    deleteAllInFlight = false;
    // Repaint from storage either way: on success the list empties and the
    // item greys itself out; on failure whatever did survive is shown.
    await refreshThumbnails();
  }
}

/**
 * "import" was chosen in the menu (§1.7, design spec §AF). With notes on the
 * site the menu first turns into "your existing notes will be discarded.
 * continue with import?" — asked BEFORE the file is chosen, so once the file
 * checks out it replaces without asking again. With none, the picker opens
 * straight away (unless the menu was dismissed during the round trip).
 * The count is read fresh when asked rather than trusted from the last
 * repaint, so notes added from another tab before the click are counted;
 * the round trip takes milliseconds, well inside the user activation a file
 * picker needs.
 */
async function handleImportRequest(): Promise<void> {
  const counts = await readSiteCounts();
  if (!counts || !counts.ok) {
    // Without the count there is no knowing whether a replace would discard
    // anything, so the only safe answer is to stop (§5 #10).
    sidebar.closeMoreOptionsMenu();
    sidebar.showError(counts ? counts.message : IMPORT_FAILED_MESSAGE);
    return;
  }
  if (counts.count > 0) {
    const confirmed = await sidebar.confirmInMenu(
      IMPORT_REPLACE_CONFIRM_MESSAGE,
      IMPORT_REPLACE_CONFIRM_LABEL,
      'accent',
    );
    if (!confirmed) return;
  } else if (!sidebar.isMoreOptionsMenuOpen()) {
    // Dismissed during the round trip: the user has moved on, so no picker.
    // (The question above already answers no in that case.)
    return;
  }
  sidebar.openImportPicker();
}

/**
 * Delete one note straight from the list's hover delete (design spec v4 §L):
 * immediate, with no confirmation, exactly like the enlarged view's delete —
 * the same DELETE_ITEM round trip, and the same error message on failure, so
 * the two entry points can't drift apart. On success the list is re-read from
 * storage rather than patched locally, which is what every other mutation
 * here does.
 */
async function handleDeleteItem(item: FeedbackItem): Promise<void> {
  const message: DeleteItemMessage = {
    type: 'DELETE_ITEM',
    domain: normaliseDomain(location.host),
    normalisedUrl: item.normalisedUrl,
    itemId: item.id,
  };
  const response = await send(message);
  if (response?.ok !== true) {
    sidebar.showError(DELETE_ERROR_MESSAGE);
    return;
  }
  await refreshThumbnails();
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
    const response = await send(message);
    if (!response) {
      sidebar.showError(EXPORT_FAILED_MESSAGE);
      return;
    }
    if (!response.ok) {
      if (response.code === 'EMPTY') {
        // Export is greyed out with nothing to export (§AF), so this is only
        // reached if the site emptied since the last check (another tab):
        // say so, and grey it out now.
        sidebar.showWarning(NOTHING_TO_EXPORT_MESSAGE);
        void refreshSiteHasNotes();
      } else {
        sidebar.showError(response.message);
      }
    }
  } finally {
    sidebar.setExportButtonEnabled(true);
  }
}

/**
 * §1.7 — import a `.zip` bundle, once it has been picked. src/import.ts owns
 * the whole §5 validation ladder (unzip, parse, screenshot/duplicate/domain
 * checks); this side reports a validation failure verbatim and hands a valid
 * bundle to the service worker to write, one screenshot at a time and then
 * the notes. Nothing is asked here: any replace
 * of existing notes was confirmed before the picker opened
 * (handleImportRequest, §AF). The import item is disabled for the duration
 * so a second pick can't overlap the first.
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
        err instanceof ImportError ? importErrorMessage(err.code, err.details) : IMPORT_FAILED_MESSAGE,
      );
      return;
    }

    // The write crosses to the service worker in pieces (messages.ts's
    // import banner): each screenshot staged on its own, then one small
    // commit of the notes, carrying the keys and thumbnails staging minted.
    const items: FeedbackItem[] = [];
    for (const { screenshotDataUrl, ...fields } of bundle.items) {
      const stage: ImportStageImageMessage = { type: 'IMPORT_STAGE_IMAGE', dataUrl: screenshotDataUrl };
      const staged = await send(stage);
      if (!staged || !staged.ok) {
        // Nothing references what was staged so far; let it go.
        if (items.length > 0) {
          const abort: ImportAbortMessage = { type: 'IMPORT_ABORT', screenshotKeys: items.map((i) => i.screenshotKey) };
          void send(abort);
        }
        sidebar.showError(staged?.message ?? IMPORT_FAILED_MESSAGE);
        return;
      }
      items.push({ ...fields, screenshotKey: staged.screenshotKey, thumbnailDataUrl: staged.thumbnailDataUrl });
    }

    // A commit that fails cleans up its own screenshots; one whose answer
    // never came may have landed, so nothing is deleted from here.
    const commit: ImportCommitMessage = { type: 'IMPORT_COMMIT', domain: currentDomain, items };
    const committed = await send(commit);
    if (!committed || !committed.ok) {
      sidebar.showError(committed?.message ?? IMPORT_FAILED_MESSAGE);
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

/** Bumped by every request to open the enlarged view, so only the latest
 *  one opens once the site's pages arrive. */
let openRequest = 0;

/**
 * Expand the sidebar into the enlarged view on one note (design spec §AH):
 * read every page of the site first (GET_SITE_PAGES — the view shows the
 * whole site, where the list shows this page), then open, wiring the view's
 * callbacks onto the GET_IMAGE / UPDATE_ITEM / DELETE_ITEM / SET_PAGE_TITLE
 * round trips (enlargedView.ts itself never touches chrome.runtime — gotcha
 * #1/#3). Every callback takes the note or page it acts on.
 *
 * The read is one queued round trip (milliseconds); if the world moved on
 * meanwhile — another note clicked, add mode entered, the sidebar closed,
 * an SPA navigation — nothing opens. If it fails, the view opens on this
 * page's notes alone and says, in its top bar, that the rest could not be
 * read.
 */
async function openItemEnlarged(item: FeedbackItem): Promise<void> {
  const token = ++openRequest;
  const domain = normaliseDomain(location.host);
  const href = location.href;
  const request: GetSitePagesMessage = { type: 'GET_SITE_PAGES', domain };
  const response = await send(request);
  if (token !== openRequest || location.href !== href) return;
  if (!sidebar.isSidebarVisible() || addMode.isAddModeActive() || sidebar.isEnlargedViewOpen()) return;

  // The list shows this page's notes, so the clicked one names this page.
  // Without the site, sidebar.ts opens on this page alone and the view says
  // why, where it is being looked at.
  const site: EnlargedSite | null = response?.ok ? { currentUrl: item.normalisedUrl, pages: response.pages } : null;

  const opened = sidebar.openEnlargedView(item.id, site, {
    fetchFullImage: async (target) => {
      const getImage: GetImageMessage = { type: 'GET_IMAGE', screenshotKey: target.screenshotKey };
      const reply = await send(getImage);
      return reply && reply.ok ? reply.dataUrl : null;
    },
    onSaveNote: async (target, note) => {
      const updateItem: UpdateItemMessage = {
        type: 'UPDATE_ITEM',
        domain,
        normalisedUrl: target.normalisedUrl,
        itemId: target.id,
        patch: { note },
      };
      const reply = await send(updateItem);
      return reply?.ok === true;
    },
    onDelete: async (target) => {
      const deleteItemMsg: DeleteItemMessage = {
        type: 'DELETE_ITEM',
        domain,
        normalisedUrl: target.normalisedUrl,
        itemId: target.id,
      };
      const reply = await send(deleteItemMsg);
      return reply?.ok === true;
    },
    onSavePageTitle: async (normalisedUrl, title) => {
      const rename: SetPageTitleMessage = { type: 'SET_PAGE_TITLE', domain, normalisedUrl, title };
      const reply = await send(rename);
      if (reply?.ok) return 'saved';
      return reply?.code === 'NO_NOTES' ? 'no-notes' : 'failed';
    },
    onClosed: (focusId) => {
      // Edits and deletes are already reflected in the list the view handed
      // back; re-reading storage makes it authoritative. Then hand focus back
      // to the note it returned to (a no-op if there is none).
      void refreshThumbnails().then(() => {
        if (focusId !== null) sidebar.focusThumbnail(focusId);
      });
    },
  });
  // The note was deleted elsewhere since the list was painted: catch up.
  if (!opened) void refreshThumbnails();
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
