// src/capture.ts
// Phase 5 — the capture pipeline's content-script half (REQUIREMENTS §1.2
// step 4, §1.3, §1.4D, §5 #8).
//
// One user gesture ("ok" in add mode) becomes: read the page's geometry →
// capture the §1.4 context → hide the in-page overlay UI → wait for exactly
// one painted frame → ask the service worker for a cropped screenshot → ask
// it to persist the item → hand the stored item back. Everything that needs
// an extension-context API (chrome.tabs.captureVisibleTab, IndexedDB,
// chrome.storage.local) is on the far side of a chrome.runtime round trip —
// gotchas #1, #2, #3.
//
// ═══ Coordinate systems, and which one goes where ════════════════════════
//
// Three rectangles are in play and conflating any two of them is the classic
// way to produce a screenshot that looks fine and is wrong:
//
//   1. **Viewport CSS px** — what add mode measured (MouseEvent.clientX/Y).
//      This is what CAPTURE carries, because chrome.tabs.captureVisibleTab
//      photographs *the visible viewport*: same origin, same frame of
//      reference, so **no scroll offset is added and none should be**. A page
//      scrolled halfway down changes neither the rect nor the image.
//   2. **Page CSS px** — viewport px + scrollX/scrollY. §1.4D specifies
//      FeedbackItem.selectionRect and the captured context in page
//      coordinates, because those are archival ("where on the page was
//      this?") rather than something the crop consumes. toPageRect() is the
//      only place the scroll offset is ever added.
//   3. **Device px** — the space the captured PNG is in. This module never
//      computes it: the service worker does, because only it can see the
//      captured image's true dimensions (see computeDeviceRect in
//      background.ts, and the CaptureMessage contract in messages.ts). DPR
//      and browser zoom (§6 #4/#5) are therefore handled in one place rather
//      than being multiplied in here and re-checked there.
//
// ═══ Why a double requestAnimationFrame ═══════════════════════════════════
//
// overlay.hide() sets `visibility: hidden`, which is a style change, not a
// paint. Capturing in the same task would photograph the frame that still has
// the selection box, handles, scrim and comment box in it (§6 #2 — that must
// never happen). A single rAF callback runs *before* the frame it belongs to
// is painted; the second one runs after that paint has been committed, which
// is the cheapest reliable "the overlay is really gone from the screen now"
// signal. A setTimeout is not equivalent — it is not tied to the frame clock
// and would either fire too early or cost more than a frame (§2: the
// hide/restore must be imperceptible).
//
// ═══ Failure policy (§1.3, §5 #8) ════════════════════════════════════════
//
// Any failure — context capture, rate limit, restricted page, storage write —
// leaves *no* partial item and restores the overlay so the user can retry or
// cancel. Add mode is deliberately still alive (and still swallowing page
// clicks) for the whole round trip; only the caller exits it, and only on
// success. A blob written by a capture whose SAVE_ITEM then failed is deleted
// service-worker-side, so nothing is orphaned either (§1.5).
//
// ═══ Manual verification matrix ═══════════════════════════════════════════
//
// The unit tests pin the arithmetic (src/__tests__/capture.test.ts for the
// coordinate discipline and ordering, background.test.ts's computeDeviceRect
// block for the DPR/zoom/edge matrix), but a jsdom test cannot prove that the
// captured *pixels* line up. The checks that need a real browser, against a
// page with a known on-screen ruler/fixture rather than by eye:
//
//   • 1x display and 2x display (§6 #4)
//   • 100% / 80% / 150% browser zoom on each (§6 #5)
//   • scrolled halfway down a long page — the crop must be identical to the
//     same selection made at scroll 0
//   • a selection flush against each viewport edge, including the right edge
//     next to the sidebar (no sidebar pixels may appear) and the bottom edge
//   • a page with and without a vertical scrollbar (this is what the two
//     viewport widths in CaptureMessage exist for)

import type { AddModeResult } from './addMode';
import type { CapturedContext, FeedbackItem, Rect, ViewportSize } from './types';
import { captureContext } from './contextCapture';
import { normaliseDomain, normaliseUrl } from './urlNorm';
import { CAPTURE_FAILED_MESSAGE } from './copy';
import { send } from './rpc';
import type { CaptureMessage, NewFeedbackItem, SaveItemMessage } from './messages';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The two add-mode entry points this module drives around the capture. Passed
 *  in rather than imported so the pipeline stays testable (and so capture.ts
 *  does not depend on add mode's module-level singleton state). */
export interface OverlayControls {
  hide(): void;
  show(): void;
}

export type CaptureOutcome =
  | { ok: true; item: FeedbackItem }
  | { ok: false; message: string };

/** How long to wait for the post-hide paint before giving up on the frame
 *  clock. requestAnimationFrame is throttled to a standstill in a backgrounded
 *  tab, and a capture in that state is going to fail anyway (captureVisibleTab
 *  requires the active tab) — but it must fail *fast* and with the overlay
 *  restored, not hang forever with the page blocked and the UI invisible. */
const PAINT_TIMEOUT_MS = 250;

// ---------------------------------------------------------------------------
// Geometry (pure — exported for tests)
// ---------------------------------------------------------------------------

export interface ViewportMetrics {
  /** window.innerWidth/innerHeight — CSS px, scrollbars included. */
  viewport: ViewportSize;
  /** documentElement.clientWidth/clientHeight — CSS px, scrollbars excluded.
   *  Per CSSOM this is the *viewport* minus rendered scrollbars, not the root
   *  element's own box, so the sidebar's `margin-right` on <html> does not
   *  affect it. */
  contentViewport: ViewportSize;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

/**
 * The viewport *excluding* rendered scrollbars, in CSS px.
 *
 * This is the box the sidebar's `position: fixed; right: 0` panel is laid out
 * in, so it is also the box add mode must clamp selections to — clamping to
 * `innerWidth` instead lets a right-edge selection overlap the sidebar by
 * exactly the scrollbar's width and put extension UI in a capture. Hence add
 * mode importing it from here rather than the two modules each measuring the
 * viewport their own way.
 */
export function getContentViewportSize(): ViewportSize {
  const docEl = document.documentElement;
  // jsdom (and any layout-less environment) reports 0 here; fall back to the
  // inner dimensions rather than returning a zero-width viewport.
  return {
    width: docEl?.clientWidth || window.innerWidth,
    height: docEl?.clientHeight || window.innerHeight,
  };
}

/** Read every geometry number the pipeline needs in one go, so the rect, the
 *  scroll offset and the viewport can never come from different moments. */
export function readViewportMetrics(): ViewportMetrics {
  const viewport: ViewportSize = { width: window.innerWidth, height: window.innerHeight };
  const contentViewport = getContentViewportSize();
  const rawDpr = window.devicePixelRatio;
  return {
    viewport,
    contentViewport,
    dpr: typeof rawDpr === 'number' && Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1,
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
  };
}

/** Viewport CSS px → page CSS px (§1.4D). The *only* place scroll offset is
 *  applied; the crop rect deliberately never goes through here. */
export function toPageRect(rect: Rect, scrollX: number, scrollY: number): Rect {
  return {
    x: rect.x + scrollX,
    y: rect.y + scrollY,
    width: rect.width,
    height: rect.height,
  };
}

/** Resolve once the browser has painted a frame that reflects whatever was
 *  mutated just before the call (see the "double rAF" note in the header).
 *  Resolves on a timer instead if the frame clock is stalled. */
export function waitForNextPaint(timeoutMs: number = PAINT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);

    if (typeof requestAnimationFrame !== 'function') {
      done();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Turn an add-mode selection into a stored FeedbackItem.
 *
 * On success the overlay is left hidden — the caller exits add mode, which
 * tears the whole host down, and re-showing it first would flash it for a
 * frame. On any failure the overlay is restored and add mode is still live,
 * so cancel/retry both work.
 */
export async function captureAndSave(
  selection: AddModeResult,
  overlay: OverlayControls,
): Promise<CaptureOutcome> {
  const metrics = readViewportMetrics();
  const pageRect = toPageRect(selection.rect, metrics.scrollX, metrics.scrollY);
  const capturedAt = new Date().toISOString();
  const pageUrl = location.href;
  const normalisedUrl = normaliseUrl(pageUrl);

  // §1.4 first, while the page is still exactly as the user saw it and before
  // anything is hidden — it is a read-only DOM walk, so doing it here costs
  // nothing and keeps the "overlay invisible" window down to one frame. The
  // add-mode and sidebar hosts both hang off <html> rather than <body>, and
  // contextCapture walks from <body>, so the extension's own DOM can't leak
  // into the captured context either.
  let context: CapturedContext;
  try {
    context = captureContext(pageRect, {
      pageUrl,
      normalisedUrl,
      viewport: metrics.viewport,
      dpr: metrics.dpr,
      capturedAt,
    });
  } catch (err) {
    console.warn('[Annotator] context capture failed:', err);
    return { ok: false, message: CAPTURE_FAILED_MESSAGE };
  }

  overlay.hide();

  try {
    await waitForNextPaint();

    const captureMessage: CaptureMessage = {
      type: 'CAPTURE',
      rect: selection.rect,
      viewport: metrics.viewport,
      contentViewport: metrics.contentViewport,
      dpr: metrics.dpr,
    };
    // The service worker may hold this for up to ~500ms if the previous
    // capture was very recent (§6 #8's throttle). The overlay stays hidden and
    // the blocker stays up for that whole window, which is the right trade:
    // a brief pause beats either a captured overlay or Chrome's opaque
    // rate-limit error.
    const captured = await send(captureMessage);
    if (!captured || !captured.ok) {
      overlay.show();
      return { ok: false, message: captured?.message ?? CAPTURE_FAILED_MESSAGE };
    }

    const newItem: NewFeedbackItem = {
      pageUrl,
      normalisedUrl,
      note: selection.note,
      createdAt: capturedAt,
      selectionRect: pageRect,
      viewport: metrics.viewport,
      dpr: metrics.dpr,
      screenshotKey: captured.screenshotKey,
      thumbnailDataUrl: captured.thumbnailDataUrl,
      context,
    };

    const saveMessage: SaveItemMessage = {
      type: 'SAVE_ITEM',
      domain: normaliseDomain(location.host),
      item: newItem,
    };
    const saved = await send(saveMessage);
    if (!saved || !saved.ok) {
      overlay.show();
      return { ok: false, message: saved?.message ?? CAPTURE_FAILED_MESSAGE };
    }

    return { ok: true, item: saved.item };
  } catch (err) {
    console.warn('[Annotator] capture pipeline failed:', err);
    overlay.show();
    return { ok: false, message: CAPTURE_FAILED_MESSAGE };
  }
}
