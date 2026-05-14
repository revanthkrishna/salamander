# Phase 2C — Background Worker Engineer

## Role & Persona

You are a Chrome extension specialist who writes lean, correct background service workers. You know the MV3 lifecycle, you know why content scripts must be injected on demand, and you understand the tab lifecycle deeply. You write minimal code that handles every edge case in the spec.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY), especially:
  - §2 Non-Functional Requirements: Multi-Tab Behavior
  - §2 Non-Functional Requirements: Toolbar Activation & Persistence
  - §6 Edge Cases #18 (icon clicked while toolbar visible)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — read these sections fully:
  - §1.3 (Message Passing Design)
  - §6.1 (Injection Flow)
  - §6.2 (Content Script init)
  - §6.3 (Full Page Reload Persistence)
  - §7 (Cross-Tab Sync)
  - §10.3 (Permissions)

Also check the stub at:
- `/root/.openclaw/workspace/annotator/src/background.ts`
- `/root/.openclaw/workspace/annotator/src/storage.ts` (you will use storage helpers)

## What You Produce

Fully implement one file: `src/background.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### Overview

The background service worker has these jobs:
1. **Icon click handler:** When user clicks the extension icon, check if content script is alive on that tab. If not, inject it. If already alive, send a no-op message.
2. **Tab reload persistence:** When a tab completes navigation (`onUpdated status=complete`), check if that tab had an active toolbar. If yes, re-inject the content script.
3. **Tab close cleanup:** When a tab closes, remove its `activeTab:{tabId}` key from storage.
4. **Startup cleanup:** On browser startup, remove stale `activeTab:*` keys for tabs that no longer exist.

### Full Implementation

```typescript
// src/background.ts
// Background service worker for Annotator Chrome extension

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
      // Check lastError in case tab navigated between inject and message
      chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId }, () => {
        if (chrome.runtime.lastError) {
          // Tab navigated away between inject and send — ok, content script will re-init on next navigation
        }
      });
    } catch (err) {
      // Injection failed (e.g. chrome:// pages, protected pages)
      console.warn('[Annotator] Cannot inject on this page:', err);
    }
  } else {
    // Content script already running — icon clicked again, no-op per requirements §6 edge case 18
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
  
  const result = await chrome.storage.local.get(`activeTab:${tabId}`);
  if (!result[`activeTab:${tabId}`]) return;
  
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
    chrome.storage.local.remove(`activeTab:${tabId}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab close cleanup
// ─────────────────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`activeTab:${tabId}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup cleanup: remove stale activeTab keys
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(t => t.id).filter((id): id is number => id !== undefined));
  
  const all = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(all)
    .filter(k => k.startsWith('activeTab:'))
    .filter(k => !liveIds.has(parseInt(k.split(':')[1])));
  
  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }
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
```

### Message Types

The background worker sends these messages to the content script:
- `{ type: 'ACTIVATE', tabId: number }` — initialize the content script
- `{ type: 'ICON_CLICKED' }` — toolbar already active, no-op

The content script sends this to the background:
- `{ type: 'PING' }` → response: `{ alive: true, tabId: number }`

The content script listens for `ACTIVATE` and `PING` messages (implemented by Integration Engineer in Phase 3 via `content.ts`).

### Key Design Decisions (reference TECH_DESIGN.md §11.3)

- Content scripts are NOT declared in manifest.json — injected on demand only
- This avoids running the extension on every page load everywhere
- Trade-off: background must track which tabs are active via `activeTab:{tabId}` storage keys

### Error Handling

- `chrome.scripting.executeScript` fails on: `chrome://` pages, `chrome-extension://` pages, the Chrome Web Store, PDF pages, and pages where the user has revoked permissions. Catch these and log a warning.
- `chrome.tabs.sendMessage` can fail if the tab no longer exists — always check `chrome.runtime.lastError` in callbacks.
- All service worker code is event-driven — no persistent state in module scope (service workers are terminated and re-started by Chrome).

---

## TypeScript Notes

- `chrome.tabs.query({})` returns `Promise<chrome.tabs.Tab[]>` in MV3
- `chrome.scripting.executeScript` is async — use `await`
- `chrome.storage.local.get` and `.remove` are async — use `await` with the promise-based API or promisify
- `export {}` at the bottom is required for TypeScript to treat this as a module

---

## How to Verify Your Work

1. Run `cd /root/.openclaw/workspace/annotator && npm run build`
2. `dist/background.js` must exist and have no TypeScript errors
3. Check that ALL handlers are registered:
   - `chrome.action.onClicked`
   - `chrome.tabs.onUpdated`
   - `chrome.tabs.onRemoved`
   - `chrome.runtime.onStartup`
4. The `pingContentScript` function must have a timeout so it doesn't hang indefinitely

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2C: Implement background.ts — icon click, reload persistence, tab cleanup" && git push
```
