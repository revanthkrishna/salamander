// Background service worker for the screenshot-based Annotator (Phase 2).
//
// Owns everything that can only run in the extension context: content-script
// injection/lifecycle, per-tab sidebar state (chrome.storage.session, §1.1),
// the screenshot capture relay (chrome.tabs.captureVisibleTab is
// service-worker-only — gotcha #3), and sole ownership of IndexedDB via
// imageStore (gotcha #1 — content scripts never touch it directly).

import { isSidebarOpen, setSidebarOpen, clearSidebarState, cleanupStaleTabKeys } from './storage';
import * as imageStore from './imageStore';
import { Rect } from './types';
import {
  ActivateMessage,
  CaptureMessage,
  CaptureErrorResponse,
  CaptureResponse,
  IconClickedMessage,
} from './messages';

const CONTENT_SCRIPT = 'dist/content.js';
const PING_TIMEOUT_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Icon click handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  const tabId = tab.id;

  const isAlive = await pingContentScript(tabId);

  if (!isAlive) {
    // Content script not present — inject it. The freshly-injected script
    // opens its own sidebar and reports back via SIDEBAR_OPENED once it's
    // up (Phase 3) — background's job here stops at getting it running.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT],
      });
      const activate: ActivateMessage = { type: 'ACTIVATE', tabId };
      chrome.tabs.sendMessage(tabId, activate, () => {
        if (chrome.runtime.lastError) {
          // Tab navigated away between inject and send — ok, will re-init on next navigation
        }
      });
    } catch (err) {
      // Injection failed (e.g. chrome://, Chrome Web Store, PDF viewer — §5 #9)
      console.warn('[Annotator] cannot inject on this page:', err);
    }
  } else {
    // Content script already running — icon clicked again toggles the
    // sidebar (§6 #18 in v1; the content script owns the toggle itself).
    const iconClicked: IconClickedMessage = { type: 'ICON_CLICKED' };
    chrome.tabs.sendMessage(tabId, iconClicked, () => {
      if (chrome.runtime.lastError) {} // tab gone, ignore
    });
  }
}

chrome.action.onClicked.addListener(handleActionClicked);

// ─────────────────────────────────────────────────────────────────────────────
// Reload persistence: re-inject on full navigation if the sidebar was open
// (§1.1 — a hard requirement now, tracked in chrome.storage.session)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
): Promise<void> {
  if (changeInfo.status !== 'complete') return;

  const wasOpen = await isSidebarOpen(tabId);
  if (!wasOpen) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT],
    });
    const activate: ActivateMessage = { type: 'ACTIVATE', tabId };
    chrome.tabs.sendMessage(tabId, activate, () => {
      if (chrome.runtime.lastError) {} // ignore
    });
  } catch {
    // Page is no longer injectable (navigated to chrome:// etc.) — the
    // sidebar can't come back here, so drop the stale "was open" state.
    await clearSidebarState(tabId);
  }
}

chrome.tabs.onUpdated.addListener(handleTabUpdated);

// ─────────────────────────────────────────────────────────────────────────────
// Tab close cleanup
// ─────────────────────────────────────────────────────────────────────────────

export function handleTabRemoved(tabId: number): void {
  void clearSidebarState(tabId);
}

chrome.tabs.onRemoved.addListener(handleTabRemoved);

// ─────────────────────────────────────────────────────────────────────────────
// Startup cleanup: remove stale legacy activeTab keys. Kept until Phase 3
// migrates content.ts's init() off storage.ts's legacy setTabActive() call
// (see storage.ts's TODO comment) — harmless no-op once that lands.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleStartup(): Promise<void> {
  await cleanupStaleTabKeys();
}

chrome.runtime.onStartup.addListener(handleStartup);

// ─────────────────────────────────────────────────────────────────────────────
// Runtime messages from content scripts: sidebar state + screenshot capture
// ─────────────────────────────────────────────────────────────────────────────

export function handleRuntimeMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const type = (message as { type?: string } | null | undefined)?.type;
  switch (type) {
    case 'SIDEBAR_OPENED': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void setSidebarOpen(tabId);
      return false;
    }
    case 'SIDEBAR_CLOSED': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void clearSidebarState(tabId);
      return false;
    }
    case 'CAPTURE': {
      handleCapture(message as CaptureMessage, sender).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    default:
      return false; // PING/ACTIVATE/ICON_CLICKED are background->content; not ours to handle
  }
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

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

// ─────────────────────────────────────────────────────────────────────────────
// Capture relay (§1.2 step 2, §1.3, §2, §6 #8)
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURE_ERROR_MESSAGE = "couldn't capture a screenshot here. try again."; // §5 #8, verbatim, lowercase

export async function handleCapture(
  message: CaptureMessage,
  sender: chrome.runtime.MessageSender,
): Promise<CaptureResponse> {
  const tab = sender.tab;
  if (!tab || tab.id === undefined) {
    return { ok: false, code: 'CAPTURE_FAILED', message: CAPTURE_ERROR_MESSAGE };
  }

  try {
    const fullDataUrl = await enqueueCapture(() => captureVisibleTabDataUrl(tab.windowId));
    const croppedDataUrl = await cropToRect(fullDataUrl, message.rect);
    const screenshotKey = generateScreenshotKey();
    await imageStore.putImage(screenshotKey, croppedDataUrl);
    return { ok: true, screenshotKey, dataUrl: croppedDataUrl };
  } catch (err) {
    return mapCaptureError(err);
  }
}

export function generateScreenshotKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for test/runtime environments without Web Crypto's randomUUID.
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function mapCaptureError(err: unknown): CaptureErrorResponse {
  const raw = err instanceof Error ? err.message : String(err);
  const code: CaptureErrorResponse['code'] =
    err instanceof CropError
      ? 'CROP_FAILED'
      : /rate|quota|MAX_CAPTURE_VISIBLE_TAB/i.test(raw)
        ? 'RATE_LIMITED'
        : 'CAPTURE_FAILED';
  return { ok: false, code, message: CAPTURE_ERROR_MESSAGE };
}

// ---------------------------------------------------------------------------
// Throttle queue: chrome.tabs.captureVisibleTab is rate-limited to roughly
// 2 calls/second (§2, §6 #8). Rather than let bursts hit that limit and
// surface Chrome's own opaque error, every capture is funneled through a
// single serial queue that spaces the underlying calls at least
// CAPTURE_THROTTLE_MS apart. A rejection here still propagates to the
// caller (mapCaptureError turns it into a clean §5 #8 message) — queueing
// smooths out bursts, it doesn't hide real failures.
// ---------------------------------------------------------------------------

const CAPTURE_THROTTLE_MS = 500;
let captureQueueTail: Promise<unknown> = Promise.resolve();
let lastCaptureStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function enqueueCapture<T>(fn: () => Promise<T>): Promise<T> {
  const run = captureQueueTail.then(async () => {
    const wait = lastCaptureStartedAt + CAPTURE_THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureStartedAt = Date.now();
    return fn();
  });
  // Swallow rejections in the chained tail only — a failed capture must not
  // poison the queue for whatever is queued behind it. The real result
  // (including rejection) is still returned to this call's own caller via
  // `run`, unaffected by this catch.
  captureQueueTail = run.catch(() => undefined);
  return run;
}

/** Test-only escape hatch: reset the throttle queue's shared state between
 *  tests. Production code never needs this. */
export function _resetCaptureQueueForTests(): void {
  captureQueueTail = Promise.resolve();
  lastCaptureStartedAt = 0;
}

function captureVisibleTabDataUrl(windowId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'capture failed'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

// ---------------------------------------------------------------------------
// Crop: service workers have no DOM and no URL.createObjectURL (gotcha #4) —
// createImageBitmap + OffscreenCanvas is the only route. `rect` is already
// in device pixels (native DPR, no downscaling — §1.3); the caller (Phase 5)
// owns converting CSS pixels/scroll/zoom into that space.
// ---------------------------------------------------------------------------

export async function cropToRect(dataUrl: string, rect: Rect): Promise<string> {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new CropError(err);
  }

  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context available for cropping');
    ctx.drawImage(bitmap, rect.x, rect.y, width, height, 0, 0, width, height);
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(croppedBlob);
  } catch (err) {
    throw new CropError(err);
  } finally {
    bitmap.close();
  }
}

class CropError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CropError';
  }
}

/** Manual Blob -> data URL conversion: no URL.createObjectURL (gotcha #4)
 *  and FileReader's availability inside a service worker isn't guaranteed
 *  across Chrome versions, so this sticks to arrayBuffer()/btoa(), both of
 *  which are part of the standard worker global scope. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || 'image/png'};base64,${base64}`;
}
