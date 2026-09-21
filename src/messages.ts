// Phase 2: the typed chrome.runtime message contract between the service
// worker (src/background.ts) and the content script (src/content.ts). Both
// sides import this file — it is the single source of truth for what can
// cross the extension-context boundary, and it grows as later phases add
// their own message types.
//
// Cross-cutting gotcha #2: chrome.runtime messaging is JSON-serialised —
// Blob/File/ArrayBuffer do not survive. Every payload below is plain JSON;
// images cross as data-URL strings.

import { FeedbackItem, ItemPatch, Rect, ViewportSize } from './types';

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

// ---------------------------------------------------------------------------
// Phase 7 — thumbnail list + enlarged modal (§1.5, §3.3)
// ---------------------------------------------------------------------------
//
// The sidebar's thumbnail list paints entirely from FeedbackItem.thumbnailDataUrl
// (Phase 1's inline-thumbnail design call), which already lives in
// chrome.storage.local — so GetPageItemsMessage is the only round trip the
// list needs. The modal additionally wants the full-resolution PNG, which
// lives in IndexedDB behind the service worker (gotcha #1), hence the
// separate GetImageMessage rather than inlining it into every item.

/** Fetch every feedback item for one normalised URL of a domain (§1.5 —
 *  "current URL only"), sent on sidebar open/refresh and on every SPA
 *  navigation. */
export interface GetPageItemsMessage {
  type: 'GET_PAGE_ITEMS';
  domain: string;
  normalisedUrl: string;
}

export interface GetPageItemsSuccessResponse {
  ok: true;
  /** In capture order — storage.ts's getPageItems already returns them that
   *  way, so the sidebar can render newest-at-the-bottom (§1.5) with no
   *  re-sorting on this side. */
  items: FeedbackItem[];
}

export interface GetPageItemsErrorResponse {
  ok: false;
  message: string;
}

export type GetPageItemsResponse = GetPageItemsSuccessResponse | GetPageItemsErrorResponse;

/** Fetch the full-resolution PNG for one item, for the enlarged view. The
 *  sidebar list itself never sends this — only the enlarged view does. */
export interface GetImageMessage {
  type: 'GET_IMAGE';
  screenshotKey: string;
}

export interface GetImageSuccessResponse {
  ok: true;
  dataUrl: string;
}

export interface GetImageErrorResponse {
  ok: false;
  /** Lowercase, user-facing. Not a §5-numbered case — enlargedView.ts falls back to
   *  the already-on-screen thumbnail rather than surfacing this as a hard
   *  failure, but the copy stays consistent with the rest of the extension's
   *  error tone regardless. */
  message: string;
}

export type GetImageResponse = GetImageSuccessResponse | GetImageErrorResponse;

/** Apply a partial update to one stored item (enlarged-view autosave, §3.3).
 *  `patch` is an ItemPatch (src/types.ts), the single declaration of which
 *  fields are mutable — a new per-item field (an annotations document, say)
 *  travels through this same message rather than a new one. */
export interface UpdateItemMessage {
  type: 'UPDATE_ITEM';
  domain: string;
  normalisedUrl: string;
  itemId: number;
  patch: ItemPatch;
}

export interface UpdateItemSuccessResponse {
  ok: true;
}

export interface UpdateItemErrorResponse {
  ok: false;
  message: string;
}

export type UpdateItemResponse = UpdateItemSuccessResponse | UpdateItemErrorResponse;

/** The note-only predecessor of UpdateItemMessage: `{ note }` as a flat
 *  field instead of a patch. Nothing in the content script sends it any
 *  more; the handler stays as a thin alias of UPDATE_ITEM so an older
 *  content script still on a page keeps saving. */
export interface UpdateNoteMessage {
  type: 'UPDATE_NOTE';
  domain: string;
  normalisedUrl: string;
  itemId: number;
  note: string;
}

export type UpdateNoteResponse = UpdateItemResponse;

/** Delete a feedback item and its screenshot blob (§1.5 — immediate, no
 *  confirmation, no orphaned image). */
export interface DeleteItemMessage {
  type: 'DELETE_ITEM';
  domain: string;
  normalisedUrl: string;
  itemId: number;
}

export interface DeleteItemSuccessResponse {
  ok: true;
}

export interface DeleteItemErrorResponse {
  ok: false;
  message: string;
}

export type DeleteItemResponse = DeleteItemSuccessResponse | DeleteItemErrorResponse;

// ---------------------------------------------------------------------------
// Phase 8 — export (§1.6)
// ---------------------------------------------------------------------------
//
// The zip is assembled and downloaded entirely inside the service worker
// (src/export.ts) — the screenshot blobs already live in its IndexedDB
// (gotcha #1), and chrome.downloads is service-worker-only in practice for
// this extension (content scripts don't get it — gotcha #4 covers the
// createObjectURL half of that same constraint). So this message carries no
// zip bytes in either direction: the content script only needs to know
// whether to show the domain's empty-state alert or a real error.

/** Ask the service worker to export every feedback item across every URL of
 *  `domain` (§1.6 — "all URLs of the current domain", not just the current
 *  page) as a `.zip` download. */
export interface ExportMessage {
  type: 'EXPORT';
  /** Normalised domain (urlNorm.normaliseDomain) — the storage.local key. */
  domain: string;
}

export interface ExportSuccessResponse {
  ok: true;
}

/** §5 #7 — zero feedback items on the domain. The content script is the one
 *  that calls `alert("nothing to export")`, verbatim, since `alert()` needs
 *  the page's window and the service worker has none. */
export interface ExportEmptyResponse {
  ok: false;
  code: 'EMPTY';
}

export interface ExportErrorResponse {
  ok: false;
  code: 'EXPORT_FAILED';
  /** Lowercase, user-facing. */
  message: string;
}

export type ExportResponse = ExportSuccessResponse | ExportEmptyResponse | ExportErrorResponse;

// ---------------------------------------------------------------------------
// Phase 9 — import (§1.7)
// ---------------------------------------------------------------------------
//
// Unzipping the picked file and validating it against §5's ladder happens in
// the content script (src/import.ts): the File object from the native
// picker lives in the page's JS world, and none of that validation needs
// chrome.storage/IndexedDB. Only the last step — actually writing the
// replacement domain data — needs the service worker (gotcha #1), so this
// boundary carries the whole validated bundle across in one message rather
// than one round trip per item. `screenshotDataUrl` is the raw
// `screenshots/{id}.png` bytes from the zip, re-encoded as a data URL so
// they survive the JSON-serialised hop (gotcha #2) — the service worker
// mints a fresh `screenshotKey` and derives `thumbnailDataUrl` from it
// (gotcha #4: only it has OffscreenCanvas), exactly like a live capture.

/** One imported item, everything a `FeedbackItem` needs except the two
 *  storage handles the service worker mints at write time. */
export type ImportItemPayload = Omit<FeedbackItem, 'screenshotKey' | 'thumbnailDataUrl'> & {
  screenshotDataUrl: string;
};

/** §1.7's replace-only import: discard whatever is currently stored for
 *  `domain` and install `items` in its place. The content script has
 *  already run the full §5 validation ladder and (if needed) shown the §5
 *  #10 confirmation dialog by the time this is sent. */
export interface ImportReplaceMessage {
  type: 'IMPORT_REPLACE';
  domain: string;
  items: ImportItemPayload[];
}

export interface ImportReplaceSuccessResponse {
  ok: true;
}

export interface ImportReplaceErrorResponse {
  ok: false;
  /** Lowercase, user-facing. */
  message: string;
}

export type ImportReplaceResponse = ImportReplaceSuccessResponse | ImportReplaceErrorResponse;

/** §5 #10's confirmation needs to know how many items importing would
 *  discard *before* the content script can show it — that count lives
 *  behind the service worker (gotcha #1), hence this small read ahead of
 *  IMPORT_REPLACE. */
export interface GetDomainItemCountMessage {
  type: 'GET_DOMAIN_ITEM_COUNT';
  domain: string;
}

export interface GetDomainItemCountSuccessResponse {
  ok: true;
  count: number;
}

export interface GetDomainItemCountErrorResponse {
  ok: false;
  message: string;
}

export type GetDomainItemCountResponse =
  | GetDomainItemCountSuccessResponse
  | GetDomainItemCountErrorResponse;

export type ContentToBackgroundMessage =
  | SidebarOpenedMessage
  | SidebarClosedMessage
  | CaptureMessage
  | SaveItemMessage
  | GetPageItemsMessage
  | GetImageMessage
  | UpdateItemMessage
  | UpdateNoteMessage
  | DeleteItemMessage
  | ExportMessage
  | ImportReplaceMessage
  | GetDomainItemCountMessage;
