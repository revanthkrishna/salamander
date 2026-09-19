// Phase 2: the typed chrome.runtime message contract between the service
// worker (src/background.ts) and the content script (src/content.ts). Both
// sides import this file — it is the single source of truth for what can
// cross the extension-context boundary, and it grows as later phases add
// their own message types.
//
// Cross-cutting gotcha #2: chrome.runtime messaging is JSON-serialised —
// Blob/File/ArrayBuffer do not survive. Every payload below is plain JSON;
// images cross as data-URL strings.

import { FeedbackItem, Rect, ViewportSize } from './types';

// ---------------------------------------------------------------------------
// Background -> content script
// ---------------------------------------------------------------------------

/** Health check the background sends to see if a content script is already
 *  running on a tab before deciding whether to inject. */
export interface PingMessage {
  type: 'PING';
}

/** The content script's synchronous reply to PingMessage. */
export interface PingResponse {
  alive: true;
  tabId: number;
}

/** Sent right after (re-)injection so the content script learns its own tab
 *  id — it has no other way to know it (content scripts don't have direct
 *  access to chrome.tabs). */
export interface ActivateMessage {
  type: 'ACTIVATE';
  tabId: number;
}

/** The icon was clicked while the content script was already alive on this
 *  tab — the content script toggles its own sidebar open/closed and reports
 *  the new state back via SidebarOpenedMessage/SidebarClosedMessage below. */
export interface IconClickedMessage {
  type: 'ICON_CLICKED';
}

export type BackgroundToContentMessage =
  | PingMessage
  | ActivateMessage
  | IconClickedMessage;

// ---------------------------------------------------------------------------
// Content script -> background
// ---------------------------------------------------------------------------

/** The sidebar opened (icon click on a fresh inject, ICON_CLICKED toggle, or
 *  a successful import — §1.7). Background persists this in
 *  chrome.storage.session (§1.1) so a later full-page reload knows to
 *  re-inject and re-show it. */
export interface SidebarOpenedMessage {
  type: 'SIDEBAR_OPENED';
}

/** The sidebar closed (the header's close button). Background clears the
 *  persisted session state so a later reload doesn't re-show it. */
export interface SidebarClosedMessage {
  type: 'SIDEBAR_CLOSED';
}

/**
 * Ask the service worker to capture the visible tab and crop it to `rect`.
 *
 * ── Coordinate contract (Phase 5 changed this; Phase 2 originally specified
 *    a pre-multiplied device-pixel rect) ─────────────────────────────────────
 *
 * `rect` is in **viewport-relative CSS pixels** — exactly the space
 * `MouseEvent.clientX/clientY` live in, so no scroll offset is ever added:
 * `captureVisibleTab` photographs the *visible viewport*, which is the same
 * frame of reference. The two viewport measurements and `dpr` are read at the
 * same moment as the rect, by src/capture.ts.
 *
 * The CSS-px → device-px conversion happens in the service worker instead of
 * the content script because only the service worker can see the *actual*
 * dimensions of the returned image. It derives the scale empirically
 * (`imageWidth / cssWidth`) rather than multiplying by `devicePixelRatio`,
 * which is strictly more robust: it self-corrects against integer rounding of
 * `innerWidth`/`innerHeight` (the real viewport can be fractional) and against
 * any platform where Chrome's captured image is not exactly
 * `innerWidth * devicePixelRatio`. It still satisfies §1.3 (native DPR
 * retained, no downscaling) and §6 #5 (browser zoom, which `devicePixelRatio`
 * already folds in), because the scale is read off the real rendered pixels
 * rather than assumed.
 *
 * Two CSS widths are sent because there are two plausible ones and only the
 * service worker can tell which the capture actually used: `viewport`
 * (`innerWidth`/`innerHeight`) includes the classic scrollbars, `contentViewport`
 * (`documentElement.clientWidth`/`clientHeight`, which the CSSOM defines as the
 * viewport minus rendered scrollbars) excludes them. Chrome's captured image
 * normally contains the scrollbar strip, but that is an implementation detail,
 * not a contract — and getting it wrong shifts the whole crop by ~1% of the
 * width, which is a plausible-looking but wrong screenshot rather than an
 * obvious failure. The handler picks whichever divisor yields a scale closest
 * to `dpr`, which is right under either behaviour and identical when the page
 * has no scrollbar at all. (Only the *scale* is ambiguous, never the origin:
 * classic scrollbars sit on the right/bottom edges in LTR, so the image's
 * top-left is the CSS viewport's top-left either way.)
 *
 * The handler (Phase 2, extended in Phase 5) owns the mechanical half:
 * throttle so the ~2/sec capture rate limit (§2, §6 #8) is never hit,
 * capture, convert + crop, downscale a thumbnail, and persist the
 * full-resolution PNG via imageStore. It does *not* assemble the
 * FeedbackItem — that needs context data (Phase 6) and the note (Phase 4),
 * and arrives separately as SaveItemMessage below.
 */
export interface CaptureMessage {
  type: 'CAPTURE';
  /** Viewport-relative CSS pixels (see above). */
  rect: Rect;
  /** window.innerWidth/innerHeight in CSS px at capture time — scrollbars
   *  included. */
  viewport: ViewportSize;
  /** documentElement.clientWidth/clientHeight in CSS px at capture time —
   *  the viewport *excluding* rendered scrollbars. */
  contentViewport: ViewportSize;
  /** window.devicePixelRatio at capture time. Not used as the scale directly:
   *  it is the reference the two measured candidate scales are judged
   *  against, and the fallback if neither is usable. */
  dpr: number;
}

export type CaptureErrorCode = 'RATE_LIMITED' | 'CAPTURE_FAILED' | 'CROP_FAILED';

export interface CaptureSuccessResponse {
  ok: true;
  /** Key into imageStore.ts (Phase 1) — the cropped PNG is already persisted
   *  there by the time this response is sent.
   *
   *  Phase 2 also returned the full-resolution crop inline as a data URL;
   *  Phase 5 dropped it. Nothing on the content-script side consumed it (the
   *  sidebar list paints from `thumbnailDataUrl`, and Phase 7's modal will
   *  fetch the full image by key), while every capture paid for serialising a
   *  multi-megabyte base64 string across the boundary — gotcha #2's cost, for
   *  a value that was thrown away on arrival. */
  screenshotKey: string;
  /** A downscaled copy of the crop, for FeedbackItem.thumbnailDataUrl
   *  (the Phase 1 design call: thumbnails live inline in storage.local so the
   *  sidebar list paints from one read). Produced in the service worker
   *  because that is where OffscreenCanvas and the decoded bitmap already
   *  are — gotcha #4. */
  thumbnailDataUrl: string;
}

export interface CaptureErrorResponse {
  ok: false;
  code: CaptureErrorCode;
  /** Lowercase, user-facing verbatim from §5 #8. */
  message: string;
}

export type CaptureResponse = CaptureSuccessResponse | CaptureErrorResponse;

/**
 * A fully-assembled feedback item that has not been given its id yet. The id
 * is the one field the content script must not invent: §1.2 requires ids to
 * be sequential across every URL of the domain, and the counter lives in
 * chrome.storage.local behind the service worker (gotcha #1), so the service
 * worker allocates it at write time.
 */
export type NewFeedbackItem = Omit<FeedbackItem, 'id'>;

/**
 * Persist a captured item (Phase 5). Sent immediately after a successful
 * CaptureMessage — `item.screenshotKey` is the key that capture returned, so
 * the blob is already in IndexedDB by the time this arrives. If the metadata
 * write fails, the handler deletes that blob again rather than leaving it
 * orphaned (§1.5's no-orphan rule, applied to the failure path).
 */
export interface SaveItemMessage {
  type: 'SAVE_ITEM';
  /** Normalised domain (urlNorm.normaliseDomain) — the storage.local key. */
  domain: string;
  item: NewFeedbackItem;
}

export interface SaveItemSuccessResponse {
  ok: true;
  /** The stored item, including the id the service worker assigned. */
  item: FeedbackItem;
}

export interface SaveItemErrorResponse {
  ok: false;
  /** Lowercase, user-facing. Reuses §5 #8's copy: from the user's point of
   *  view the capture did not complete, and §5 has no separate row for a
   *  storage write failing. */
  message: string;
}

export type SaveItemResponse = SaveItemSuccessResponse | SaveItemErrorResponse;

export type ContentToBackgroundMessage =
  | SidebarOpenedMessage
  | SidebarClosedMessage
  | CaptureMessage
  | SaveItemMessage;
