// src/content.ts
// Content script main entry.
//
// Phase 3 rebuilds the sidebar shell (src/sidebar.ts) on top of the Phase 0
// stub and wires it up to real UI: ACTIVATE / ICON_CLICKED open and toggle
// it, SPA navigation refreshes its (currently empty) thumbnail list, and its
// own close button restores the page and tells the service worker so a
// later reload doesn't bring the sidebar back uninvited (§1.1).
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

import { normaliseUrl } from './urlNorm';
import * as sidebar from './sidebar';
import * as addMode from './addMode';
import { SidebarOpenedMessage, SidebarClosedMessage } from './messages';

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
        onOk: (_result) => {
          // Phase 5 wires the real capture pipeline here: hideOverlayUI(),
          // message the service worker with the selection rect (converted to
          // page-absolute device pixels), crop, persist, then either
          // exitAddMode() on success or showOverlayUI() on failure so the
          // user can retry or cancel. No capture pipeline exists yet, so for
          // now we just leave add mode — no feedback item is created.
          addMode.exitAddMode();
        },
        onCancel: () => {
          // Add mode has already torn itself down — nothing left to do.
        },
      });
    },
    onExport: () => {
      // Phase 8 wires the real zip export here.
    },
    onImportFile: (_file: File) => {
      // Phase 9 wires real bundle import here.
    },
    onClose: () => {
      notifyBackground({ type: 'SIDEBAR_CLOSED' });
    },
  });
  setupNavigationDetection();
  window.addEventListener('beforeunload', handleBeforeUnload);
}

function openAndReport(): void {
  sidebar.openSidebar();
  sidebar.refreshForUrl(location.href);
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
    sidebar.refreshForUrl(location.href);
  }
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
