// Phase 2: the typed chrome.runtime message contract between the service
// worker (src/background.ts) and the content script (src/content.ts). Both
// sides import this file — it is the single source of truth for what can
// cross the extension-context boundary, and it grows as later phases add
// their own message types.
//
// Cross-cutting gotcha #2: chrome.runtime messaging is JSON-serialised —
// Blob/File/ArrayBuffer do not survive. Every payload below is plain JSON;
// images cross as data-URL strings.

import { Rect } from './types';

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
 * `rect` must already be in *device* pixels (native DPR, no downscaling —
 * §1.3) relative to the top-left of the visible viewport. Coordinate
 * conversion — CSS px * dpr, scroll offsets, browser zoom — is the caller's
 * job; Phase 5 owns getting that exactly right. This message's handler
 * (Phase 2) owns the mechanical half: throttle so the ~2/sec capture rate
 * limit (§2, §6 #8) is never hit, capture, crop, and persist the blob via
 * imageStore — not assembling the full FeedbackItem, which needs context
 * data (Phase 6) and UI state (Phase 4/5) this message doesn't carry.
 */
export interface CaptureMessage {
  type: 'CAPTURE';
  rect: Rect;
}

export type CaptureErrorCode = 'RATE_LIMITED' | 'CAPTURE_FAILED' | 'CROP_FAILED';

export interface CaptureSuccessResponse {
  ok: true;
  /** Key into imageStore.ts (Phase 1) — the cropped PNG is already persisted
   *  there by the time this response is sent. */
  screenshotKey: string;
  /** The cropped PNG as a data URL, handed back so the caller can render an
   *  immediate thumbnail without a follow-up round trip through storage. */
  dataUrl: string;
}

export interface CaptureErrorResponse {
  ok: false;
  code: CaptureErrorCode;
  /** Lowercase, user-facing verbatim from §5 #8. */
  message: string;
}

export type CaptureResponse = CaptureSuccessResponse | CaptureErrorResponse;

export type ContentToBackgroundMessage =
  | SidebarOpenedMessage
  | SidebarClosedMessage
  | CaptureMessage;
