// Background service worker for the screenshot-based Annotator (Phase 2).
//
// Owns everything that can only run in the extension context: content-script
// injection/lifecycle, per-tab sidebar state (chrome.storage.session, §1.1),
// the screenshot capture relay (chrome.tabs.captureVisibleTab is
// service-worker-only — gotcha #3), and sole ownership of IndexedDB via
// imageStore (gotcha #1 — content scripts never touch it directly).

import {
  isSidebarOpen,
  setSidebarOpen,
  clearSidebarState,
  getNextItemId,
  addItem,
  getPageItems,
  updateNote,
  deleteItem,
  getDomainData,
  replaceDomainData,
  STORAGE_VERSION,
} from './storage';
import * as imageStore from './imageStore';
import { exportDomain } from './export';
import { FeedbackItem, Rect, ViewportSize, DomainData } from './types';
import {
  ActivateMessage,
  CaptureMessage,
  CaptureErrorResponse,
  CaptureResponse,
  IconClickedMessage,
  SaveItemMessage,
  SaveItemResponse,
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
    case 'SAVE_ITEM': {
      handleSaveItem(message as SaveItemMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'GET_PAGE_ITEMS': {
      handleGetPageItems(message as GetPageItemsMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'GET_IMAGE': {
      handleGetImage(message as GetImageMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'UPDATE_NOTE': {
      handleUpdateNote(message as UpdateNoteMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'DELETE_ITEM': {
      handleDeleteItem(message as DeleteItemMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'EXPORT': {
      handleExport(message as ExportMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'GET_DOMAIN_ITEM_COUNT': {
      handleGetDomainItemCount(message as GetDomainItemCountMessage).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    case 'IMPORT_REPLACE': {
      handleImportReplace(message as ImportReplaceMessage).then(sendResponse);
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
    const { dataUrl, thumbnailDataUrl } = await cropCapture(fullDataUrl, message);
    const screenshotKey = generateScreenshotKey();
    await imageStore.putImage(screenshotKey, dataUrl);
    // The full-resolution crop deliberately does not travel back to the
    // content script — only the key and the small thumbnail do (see
    // CaptureSuccessResponse in messages.ts).
    return { ok: true, screenshotKey, thumbnailDataUrl };
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

// ─────────────────────────────────────────────────────────────────────────────
// Item persistence (§1.2 step 4) — the second half of the capture round trip
// ─────────────────────────────────────────────────────────────────────────────
//
// The content script assembles everything about a feedback item except its id
// (note, selection rect, viewport/dpr, screenshotKey, §1.4 context) and sends
// it here. The id is allocated on this side because §1.2 requires it to be
// sequential across every URL of the domain and the counter lives in
// chrome.storage.local, which only the service worker touches (gotcha #1).
//
// Writes are serialised through a single promise chain: read-modify-write on
// the domain record is not atomic, so two captures resolving at once could
// otherwise read the same nextItemNumber and collide (or drop one item's
// append entirely). Every other domain-record write (UPDATE_NOTE,
// DELETE_ITEM, IMPORT_REPLACE) goes through the same chain — storage.ts
// rewrites the whole record per write, so any two overlapping writes would
// otherwise clobber each other (last write wins).

let saveQueueTail: Promise<unknown> = Promise.resolve();

function enqueueSave<T>(fn: () => Promise<T>): Promise<T> {
  const run = saveQueueTail.then(fn);
  saveQueueTail = run.catch(() => undefined);
  return run;
}

export async function handleSaveItem(message: SaveItemMessage): Promise<SaveItemResponse> {
  try {
    const item = await enqueueSave(async () => {
      const id = await getNextItemId(message.domain);
      const stored: FeedbackItem = { ...message.item, id };
      await addItem(message.domain, stored);
      return stored;
    });
    return { ok: true, item };
  } catch (err) {
    // The blob was already written by the CAPTURE that preceded this. A failed
    // metadata write would strand it with nothing referencing it, so drop it
    // here — §1.5's no-orphan rule applied to the failure path, and §1.3's
    // "a failed capture creates no partial item".
    try {
      await imageStore.deleteImage(message.item.screenshotKey);
    } catch {
      // Best effort — the metadata failure is what we report.
    }
    console.warn('[Annotator] could not save feedback item:', err);
    return { ok: false, message: CAPTURE_ERROR_MESSAGE };
  }
}

/** Test-only escape hatch: reset the serialised save queue between tests. */
export function _resetSaveQueueForTests(): void {
  saveQueueTail = Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — thumbnail list + enlarged modal (§1.5, §3.3)
// ─────────────────────────────────────────────────────────────────────────────
//
// Four small read/write handlers on top of storage.ts/imageStore.ts.
// GET_IMAGE is a pure read; GET_PAGE_ITEMS reads through saveQueueTail so it
// sees every write sent before it. UPDATE_NOTE/DELETE_ITEM only touch
// one item, but storage.ts read-modify-writes the *whole* domain record, so
// they share saveQueueTail with SAVE_ITEM: unserialised, a note edit
// overlapping a capture in another tab (or a second edit) would write back a
// stale copy of the record and drop the other change.

const ITEM_LOAD_FAILED_MESSAGE = "couldn't load feedback for this page. try again.";
const IMAGE_LOAD_FAILED_MESSAGE = "couldn't load screenshot. try again.";
const NOTE_SAVE_FAILED_MESSAGE = "couldn't save note. try again.";
const ITEM_DELETE_FAILED_MESSAGE = "couldn't delete item. try again.";

export async function handleGetPageItems(
  message: GetPageItemsMessage,
): Promise<GetPageItemsResponse> {
  try {
    // Queued behind pending writes too: the enlarged view flushes its edit
    // and then (on close) re-reads the list — read-after-write must hold.
    const items = await enqueueSave(() => getPageItems(message.domain, message.normalisedUrl));
    return { ok: true, items };
  } catch (err) {
    console.warn('[Annotator] could not load page items:', err);
    return { ok: false, message: ITEM_LOAD_FAILED_MESSAGE };
  }
}

export async function handleGetImage(message: GetImageMessage): Promise<GetImageResponse> {
  try {
    const dataUrl = await imageStore.getImage(message.screenshotKey);
    if (!dataUrl) {
      return { ok: false, message: IMAGE_LOAD_FAILED_MESSAGE };
    }
    return { ok: true, dataUrl };
  } catch (err) {
    console.warn('[Annotator] could not load screenshot:', err);
    return { ok: false, message: IMAGE_LOAD_FAILED_MESSAGE };
  }
}

export async function handleUpdateNote(message: UpdateNoteMessage): Promise<UpdateNoteResponse> {
  try {
    await enqueueSave(() => updateNote(message.domain, message.normalisedUrl, message.itemId, message.note));
    return { ok: true };
  } catch (err) {
    console.warn('[Annotator] could not save note:', err);
    return { ok: false, message: NOTE_SAVE_FAILED_MESSAGE };
  }
}

export async function handleDeleteItem(message: DeleteItemMessage): Promise<DeleteItemResponse> {
  try {
    await enqueueSave(() => deleteItem(message.domain, message.normalisedUrl, message.itemId));
    return { ok: true };
  } catch (err) {
    console.warn('[Annotator] could not delete feedback item:', err);
    return { ok: false, message: ITEM_DELETE_FAILED_MESSAGE };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — export (§1.6): src/export.ts owns the zip assembly and the
// chrome.downloads call (both service-worker-only — gotchas #1 and #4); this
// handler is just the message-boundary adapter.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleExport(message: ExportMessage): Promise<ExportResponse> {
  return exportDomain(message.domain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9 — import (§1.7): the content script (src/import.ts) unzips and
// validates the whole §5 ladder before anything reaches here — this side's
// job is the two things only the service worker can do: read how many items
// a domain currently has (so content.ts can show §5 #10's confirmation
// *before* asking to replace anything) and the replace-and-persist write
// itself, including minting a fresh screenshotKey/thumbnailDataUrl per item
// (gotcha #4 — only this context has OffscreenCanvas).
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_COUNT_FAILED_MESSAGE = "couldn't check existing feedback. try again.";
const IMPORT_FAILED_MESSAGE = "couldn't import this bundle. try again.";

export async function handleGetDomainItemCount(
  message: GetDomainItemCountMessage,
): Promise<GetDomainItemCountResponse> {
  try {
    const data = await getDomainData(message.domain);
    const count = data
      ? Object.values(data.pages).reduce((sum, items) => sum + items.length, 0)
      : 0;
    return { ok: true, count };
  } catch (err) {
    console.warn('[Annotator] could not read domain item count:', err);
    return { ok: false, message: DOMAIN_COUNT_FAILED_MESSAGE };
  }
}

/**
 * §1.7's replace-only semantics: discard whatever `message.domain` currently
 * has and install `message.items` in its place. Ids are preserved verbatim
 * from the bundle (not re-allocated) — §1.2's "item #7" numbering is meant
 * to stay meaningful across an export/import round trip, which is exactly
 * this phase's "done when" bar. Screenshot keys are *not* preserved (the
 * bundle never carries them — they're an internal storage handle, not
 * information a human/agent reading feedback.md needs, §1.6): each item gets
 * a freshly minted key and a freshly rendered thumbnail here, the same two
 * things a live capture produces.
 *
 * If any item fails partway through (a corrupt image the zip's own
 * screenshot-presence check couldn't catch), the blobs already written for
 * *this* import are cleaned up before returning — existing domain data is
 * only touched by the final replaceDomainData call, so a failure here always
 * leaves the previous data intact rather than half-replaced.
 */
export async function handleImportReplace(
  message: ImportReplaceMessage,
): Promise<ImportReplaceResponse> {
  const writtenKeys: string[] = [];
  try {
    const pages: Record<string, FeedbackItem[]> = {};
    let maxId = 0;

    for (const payload of message.items) {
      const screenshotKey = generateScreenshotKey();
      const thumbnailDataUrl = await buildThumbnailFromDataUrl(payload.screenshotDataUrl);
      await imageStore.putImage(screenshotKey, payload.screenshotDataUrl);
      writtenKeys.push(screenshotKey);

      const item: FeedbackItem = {
        id: payload.id,
        pageUrl: payload.pageUrl,
        normalisedUrl: payload.normalisedUrl,
        note: payload.note,
        createdAt: payload.createdAt,
        selectionRect: payload.selectionRect,
        viewport: payload.viewport,
        dpr: payload.dpr,
        screenshotKey,
        thumbnailDataUrl,
        context: payload.context,
      };
      pages[item.normalisedUrl] = [...(pages[item.normalisedUrl] ?? []), item];
      maxId = Math.max(maxId, item.id);
    }

    const domainData: DomainData = {
      meta: { nextItemNumber: maxId + 1, version: STORAGE_VERSION },
      pages,
    };
    await enqueueSave(() => replaceDomainData(message.domain, domainData));
    return { ok: true };
  } catch (err) {
    console.warn('[Annotator] could not import bundle:', err);
    await Promise.all(writtenKeys.map((key) => imageStore.deleteImage(key).catch(() => undefined)));
    return { ok: false, message: IMPORT_FAILED_MESSAGE };
  }
}

/** Decode an imported screenshot and render the same inline-thumbnail shape
 *  a live capture produces (src/imageStore doesn't store thumbnails — Phase
 *  1's design call keeps them inline in chrome.storage.local metadata).
 *  Reuses cropCapture's drawing primitives against the *whole* decoded
 *  image, since an imported screenshot has no separate "full frame" to crop
 *  out of — the PNG from the zip already is the crop. */
async function buildThumbnailFromDataUrl(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const size = computeThumbnailSize(bitmap.width, bitmap.height);
    return await drawCrop(
      bitmap,
      { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
      size.width,
      size.height,
      THUMBNAIL_MIME,
      THUMBNAIL_QUALITY,
    );
  } finally {
    bitmap.close();
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// Crop (⚠ the pixel-critical half of Phase 5)
// ═══════════════════════════════════════════════════════════════════════════
//
// Service workers have no DOM and no URL.createObjectURL (gotcha #4) —
// createImageBitmap + OffscreenCanvas is the only route.
//
// ── The coordinate problem ────────────────────────────────────────────────
//
// The content script measures its selection in viewport-relative CSS pixels
// (MouseEvent.clientX/clientY). chrome.tabs.captureVisibleTab returns a PNG
// of that same visible viewport, but in *device* pixels. Three things can
// make those two spaces differ by a constant factor:
//
//   • a high-DPI display   (§6 #4 — devicePixelRatio 2 or 3)
//   • browser zoom ≠ 100%  (§6 #5 — folded into devicePixelRatio by Chrome:
//                           zooming to 150% shrinks innerWidth and raises
//                           devicePixelRatio by the same 1.5)
//   • the two combined     (2× display at 150% zoom ⇒ effective scale 3)
//
// Scroll position is deliberately *not* one of them: both the selection rect
// and the capture are viewport-relative, so a scrolled page needs no offset
// at all. (The scroll offset does matter for FeedbackItem.selectionRect,
// which §1.4D stores in *page* coordinates — the content script adds it there
// and only there.)
//
// ── Why the scale is measured, not assumed ────────────────────────────────
//
// In theory imageWidth === innerWidth * devicePixelRatio, so multiplying by
// devicePixelRatio in the content script would do. In practice innerWidth and
// innerHeight are integers (the real viewport can be fractional), and Chrome's
// captured image is not guaranteed to be exactly that product on every
// platform. Dividing the image's real dimensions by the reported CSS viewport
// gives the true mapping whatever produced it, and is self-correcting for the
// rounding.
//
// ── ...and why two CSS widths are measured against ────────────────────────
//
// "The reported CSS viewport" is ambiguous by exactly the width of a classic
// scrollbar: window.innerWidth includes it, documentElement.clientWidth does
// not. Chrome's capture normally *does* contain the scrollbar strip, but that
// is observed behaviour rather than a documented contract, and picking the
// wrong divisor skews every coordinate by ~1% of the viewport width — a
// screenshot that looks plausible and is wrong, which is precisely the failure
// mode this phase exists to avoid. So both candidate divisors come across the
// wire and the scale that lands closest to devicePixelRatio wins: correct
// under either capture behaviour, and a no-op when the page has no scrollbar
// (the two candidates are then identical). devicePixelRatio itself is the
// fallback when neither candidate is usable, and 1 the last resort.
//
// Only the scale is ever in question, never the origin: classic scrollbars
// occupy the right and bottom edges in a left-to-right document, so the
// image's top-left pixel is the CSS viewport's (0, 0) either way. (A
// right-to-left document puts the vertical scrollbar on the left, which would
// shift the origin — an accepted limitation, consistent with the rest of the
// extension's LTR assumptions.)
//
// This keeps §1.3 satisfied — the stored PNG is the native-resolution crop,
// never downscaled — while the separate thumbnail below is what gets shrunk.
// ---------------------------------------------------------------------------

/** Longest edge of the inline thumbnail (device px). 480 ≈ 2× the usable
 *  width of the 320px sidebar, so it stays crisp on a retina display while
 *  keeping storage.local's per-domain record small enough to read on every
 *  sidebar refresh. */
const THUMBNAIL_MAX_EDGE = 480;

/** Thumbnails are JPEG, not PNG: they live inline in chrome.storage.local
 *  (Phase 1's design call) and that record is read in full every time the
 *  sidebar refreshes, so size matters more than fidelity here. §1.3's
 *  "PNG, lossless, native DPR" requirement governs the *stored capture*,
 *  which is the PNG in IndexedDB and the one that gets exported — not this
 *  render-only copy. */
const THUMBNAIL_MIME = 'image/jpeg';
const THUMBNAIL_QUALITY = 0.75;

export interface CropResult {
  /** Full-resolution PNG crop — what gets persisted and exported. */
  dataUrl: string;
  /** Downscaled JPEG copy for the sidebar list. */
  thumbnailDataUrl: string;
}

/**
 * Convert a CSS-pixel, viewport-relative rect into the device-pixel rect to
 * cut out of a captured image of `imageWidth` × `imageHeight`.
 *
 * Pure and exported so the whole DPR/zoom/edge matrix is unit-testable
 * without a browser. Edges are rounded independently (rather than rounding
 * origin and size separately) so a selection that ends exactly at a boundary
 * still lands on that boundary, and the result is clamped inside the image so
 * a selection flush against the viewport edge can never ask drawImage for
 * out-of-bounds source pixels (which would silently render as transparent).
 */
export function computeDeviceRect(
  rect: Rect,
  viewport: ViewportSize | undefined,
  contentViewport: ViewportSize | undefined,
  dpr: number | undefined,
  imageWidth: number,
  imageHeight: number,
): Rect {
  const scaleX = pickScale(imageWidth, [viewport?.width, contentViewport?.width], dpr);
  const scaleY = pickScale(imageHeight, [viewport?.height, contentViewport?.height], dpr);

  let left = Math.round(rect.x * scaleX);
  let top = Math.round(rect.y * scaleY);
  let right = Math.round((rect.x + rect.width) * scaleX);
  let bottom = Math.round((rect.y + rect.height) * scaleY);

  // Unknown image dimensions (shouldn't happen with a real decoded bitmap):
  // skip clamping rather than clamp against a bogus bound.
  if (imageWidth > 0 && imageHeight > 0) {
    left = clamp(left, 0, imageWidth - 1);
    top = clamp(top, 0, imageHeight - 1);
    right = clamp(right, left + 1, imageWidth);
    bottom = clamp(bottom, top + 1, imageHeight);
  } else {
    right = Math.max(right, left + 1);
    bottom = Math.max(bottom, top + 1);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * One axis's CSS-px → device-px scale.
 *
 * `cssSizes` are the candidate CSS-space extents of the captured image, in
 * order of preference (scrollbar-inclusive first, scrollbar-exclusive second —
 * see the header comment). Each usable one implies a measured scale; the one
 * nearest `dpr` wins, because `dpr` is a reliable *approximation* of the truth
 * (exact but for sub-pixel viewport rounding) while a measured scale is exact
 * but only if it was divided by the right number.
 */
function pickScale(
  imageSize: number,
  cssSizes: ReadonlyArray<number | undefined>,
  dpr: number | undefined,
): number {
  const fallback = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (!(imageSize > 0)) return fallback;

  const measured: number[] = [];
  for (const cssSize of cssSizes) {
    if (typeof cssSize !== 'number' || !(cssSize > 0)) continue;
    const scale = imageSize / cssSize;
    if (Number.isFinite(scale) && scale > 0) measured.push(scale);
  }
  if (measured.length === 0) return fallback;
  if (!(typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0)) return measured[0];

  return measured.reduce((best, scale) =>
    Math.abs(scale - dpr) < Math.abs(best - dpr) ? scale : best,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Thumbnail dimensions for a crop of `width`×`height` device px: aspect
 *  preserved, never upscaled, longest edge capped at THUMBNAIL_MAX_EDGE. */
export function computeThumbnailSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > THUMBNAIL_MAX_EDGE ? THUMBNAIL_MAX_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decode the full-viewport capture once, then draw the same source rectangle
 * twice: at native size for the stored PNG (§1.3) and downscaled for the
 * inline thumbnail. Drawing both from the one decoded bitmap avoids
 * re-decoding the cropped PNG just to shrink it.
 */
export async function cropCapture(dataUrl: string, message: CaptureMessage): Promise<CropResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  } catch (err) {
    throw new CropError(err);
  }

  try {
    const src = computeDeviceRect(
      message.rect,
      message.viewport,
      message.contentViewport,
      message.dpr,
      bitmap.width,
      bitmap.height,
    );

    const full = await drawCrop(bitmap, src, src.width, src.height, 'image/png');

    const thumbSize = computeThumbnailSize(src.width, src.height);
    const thumb = await drawCrop(
      bitmap,
      src,
      thumbSize.width,
      thumbSize.height,
      THUMBNAIL_MIME,
      THUMBNAIL_QUALITY,
    );

    return { dataUrl: full, thumbnailDataUrl: thumb };
  } catch (err) {
    throw err instanceof CropError ? err : new CropError(err);
  } finally {
    bitmap.close();
  }
}

async function drawCrop(
  bitmap: ImageBitmap,
  src: Rect,
  destWidth: number,
  destHeight: number,
  mime: string,
  quality?: number,
): Promise<string> {
  const canvas = new OffscreenCanvas(destWidth, destHeight);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new CropError(new Error('no 2d context available for cropping'));
  // Only matters for the thumbnail (the full-resolution crop is 1:1, where
  // smoothing is a no-op): the default 'low' setting produces visibly aliased
  // text when a 1000px-wide capture is shrunk to 480.
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, src.x, src.y, src.width, src.height, 0, 0, destWidth, destHeight);
  const blob = await canvas.convertToBlob(
    quality === undefined ? { type: mime } : { type: mime, quality },
  );
  return blobToDataUrl(blob);
}

class CropError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CropError';
  }
}

/**
 * Manual data URL -> Blob conversion, so `createImageBitmap` can decode what
 * `chrome.tabs.captureVisibleTab` handed us.
 *
 * ⚠ This must never go back to being `await (await fetch(dataUrl)).blob()`,
 * which is the idiomatic one-liner and is what it was originally. The
 * extension's CSP (manifest.json, carried forward from v1's "no network calls
 * at all" posture — §2 Security) sets `connect-src 'none'`, and an MV3
 * service worker is an extension page for CSP purposes: `fetch()` there is
 * governed by `connect-src`, and a `data:` URL is not exempt. So every real
 * capture died on a CSP violation inside cropCapture and surfaced to the user
 * as §5 #8's "couldn't capture a screenshot here. try again." — while the unit
 * tests stayed green, because they stub `global.fetch`. Decoding the base64 by
 * hand has no CSP surface, no network stack, and no async hop; it is the exact
 * mirror of blobToDataUrl below. (Relaxing the CSP instead was the other
 * option and was rejected: nothing in this extension should be able to talk to
 * the network, and manifest.json's permissions/CSP are Phase 0's contract.)
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  if (comma === -1 || !dataUrl.startsWith('data:')) {
    throw new Error('captured image is not a data url');
  }

  const header = dataUrl.slice('data:'.length, comma);
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, '').split(';')[0] || 'image/png';

  if (!isBase64) {
    // captureVisibleTab always returns base64, but a percent-encoded data URL
    // is still a legal one — decode it rather than feed atob() garbage.
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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
