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
// Phase 7 wires the thumbnail list and the enlarged modal (src/thumbnails.ts,
// src/modal.ts): this file is the message-sending orchestrator for both
// (same role it already plays for capture/save), fetching a domain's/URL's
// items via GET_PAGE_ITEMS and handing them to sidebar.setThumbnails(), and
// supplying modal.ts's fetchFullImage/onSaveNote/onDelete callbacks so that
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
import * as modal from './modal';
import { FeedbackItem } from './types';
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
} from './messages';

// §5 #7's alert text is fixed and verbatim; this is the fallback shown when
// the export round trip itself fails (a dead service worker, etc.) — not one
// of the 11 numbered §5 cases, but kept lowercase and in the same tone.
const EXPORT_ROUND_TRIP_FAILED_MESSAGE = "couldn't export feedback. try again.";

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

  sidebar.initSidebar({
    onAdd: () => {
      if (addMode.isAddModeActive()) return;
      addMode.startAddMode({
        onOk: (result) => {
          // Phase 5's capture pipeline (src/capture.ts) owns everything
          // between "ok" and a stored item: hiding the overlay for exactly
          // one painted frame, the screenshot round trip to the service
          // worker, the §1.4 context, and the write. All this side does is
          // decide what happens to add mode and the sidebar afterwards.
          void handleCaptureOk(result);
        },
        onCancel: () => {
          // Add mode has already torn itself down — nothing left to do.
        },
      });
    },
    onExport: () => {
      void handleExport();
    },
    onImportFile: (_file: File) => {
      // Phase 9 wires real bundle import here.
    },
    onClose: () => {
      notifyBackground({ type: 'SIDEBAR_CLOSED' });
    },
    onOpenItem: (item) => {
      openItemModal(item);
    },
  });
  setupNavigationDetection();
  window.addEventListener('beforeunload', handleBeforeUnload);
}

/**
 * §1.2 step 4: "add mode exits; sidebar restores; a new thumbnail appears at
 * the bottom of the sidebar list".
 *
 * On failure the opposite: add mode stays exactly as the user left it (the
 * capture pipeline has already restored the hidden overlay and re-enabled
 * cancel/ok), no item exists anywhere (§1.3, §5 #8), and the reason is shown
 * in the sidebar's error bar — lowercase, verbatim from §5.
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

  // The sidebar itself (open/closed, and its page-resize) is untouched by
  // navigation — §1.1 requires it to persist across SPA route changes.
  // Only its thumbnail list content depends on the URL.
  if (sidebar.isSidebarVisible()) {
    void refreshThumbnails();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — thumbnail list + enlarged modal message plumbing
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
 *  after a successful capture, and after a modal closes (an edit or a
 *  delete may have changed what should be showing). */
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

/** Open the enlarged modal for one thumbnail, wiring its callbacks onto the
 *  GET_IMAGE / UPDATE_NOTE / DELETE_ITEM round trips (modal.ts itself never
 *  touches chrome.runtime — gotcha #1/#3). */
function openItemModal(item: FeedbackItem): void {
  const domain = normaliseDomain(location.host);

  modal.openModal(item, {
    fetchFullImage: async () => {
      const getImage: GetImageMessage = { type: 'GET_IMAGE', screenshotKey: item.screenshotKey };
      const response = await sendMessage<GetImageResponse>(getImage);
      return response && response.ok ? response.dataUrl : null;
    },
    onSaveNote: async (note) => {
      const updateNote: UpdateNoteMessage = {
        type: 'UPDATE_NOTE',
        domain,
        normalisedUrl: item.normalisedUrl,
        itemId: item.id,
        note,
      };
      const response = await sendMessage<UpdateNoteResponse>(updateNote);
      return response?.ok === true;
    },
    onDelete: async () => {
      const deleteItemMsg: DeleteItemMessage = {
        type: 'DELETE_ITEM',
        domain,
        normalisedUrl: item.normalisedUrl,
        itemId: item.id,
      };
      const response = await sendMessage<DeleteItemResponse>(deleteItemMsg);
      return response?.ok === true;
    },
    onClose: () => {
      // Covers both outcomes: an edited note (preview text changed) and a
      // deletion (item should disappear) — re-reading beats trying to patch
      // the in-memory list two different ways.
      void refreshThumbnails();
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
