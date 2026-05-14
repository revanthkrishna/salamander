// Background service worker for Annotator Chrome extension (Phase 2C)

import { isTabActive, removeTabActive, cleanupStaleTabKeys } from './storage';

const CONTENT_SCRIPT = 'dist/content.js';
const PING_TIMEOUT_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Icon click handler
// ─────────────────────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;

  const isAlive = await pingContentScript(tabId);

  if (!isAlive) {
    // Content script not present — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT],
      });
      // After inject, send ACTIVATE with tabId so content script knows its own ID
      chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId }, () => {
        if (chrome.runtime.lastError) {
          // Tab navigated away between inject and send — ok, will re-init on next navigation
        }
      });
    } catch (err) {
      // Injection failed (e.g. chrome:// pages, protected pages)
      console.warn('[Annotator] Cannot inject on this page:', err);
    }
  } else {
    // Content script already running — icon clicked again (edge case §6 #18)
    chrome.tabs.sendMessage(tabId, { type: 'ICON_CLICKED' }, () => {
      if (chrome.runtime.lastError) {} // tab gone, ignore
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reload persistence: re-inject on full navigation if toolbar was active
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const active = await isTabActive(tabId);
  if (!active) return;

  // Toolbar was active on this tab before reload — re-inject
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT],
    });
    chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId }, () => {
      if (chrome.runtime.lastError) {} // ignore
    });
  } catch {
    // Page is not injectable (chrome:// etc.) — remove the stale key
    await removeTabActive(tabId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab close cleanup
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabActive(tabId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup cleanup: remove stale activeTab keys
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  await cleanupStaleTabKeys();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: ping the content script to check if it's alive
// ─────────────────────────────────────────────────────────────────────────────

function pingContentScript(tabId: number): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), PING_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(response?.alive === true);
    });
  });
}

export {};
