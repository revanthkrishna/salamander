// src/content.ts
// Content script main entry.
//
// Phase 0 stub: all pin-era wiring (toolbar, annotation mode, pin renderer,
// page-limitation detectors, YAML import/export) has been stripped out along
// with the modules that implemented it (see DEVELOPMENT_PLAN.md's inventory
// table). What survives untouched, per the Phase 0 brief, is exactly the
// three things every later phase needs already in place:
//   1. The double-injection idempotency guard.
//   2. The chrome.runtime message listener shape (PING / ACTIVATE / ICON_CLICKED).
//   3. SPA navigation detection (history.pushState/replaceState patching +
//      popstate/hashchange + debounce).
// Phase 3 rebuilds the sidebar shell on top of this and wires ICON_CLICKED /
// handleUrlChange up to real UI.

import { normaliseUrl } from './urlNorm';
import { setTabActive } from './storage';

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
    // Phase 3: toggle the sidebar open/closed on repeat icon clicks.
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// init
// ─────────────────────────────────────────────────────────────────────────────

async function init(tabId: number): Promise<void> {
  myTabId = tabId;

  await setTabActive(tabId);

  // Phase 3: open the sidebar shell here.

  setupNavigationDetection();

  window.addEventListener('beforeunload', handleBeforeUnload);
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

  // Phase 3: refresh the sidebar's thumbnail list for the new URL.
}

// ─────────────────────────────────────────────────────────────────────────────
// Beforeunload cleanup
// ─────────────────────────────────────────────────────────────────────────────

function handleBeforeUnload(): void {
  // Phase 3+: tear down sidebar/add-mode UI here.
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
