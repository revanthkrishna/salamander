// src/dom.ts
// Small browser-environment helpers shared by the content-script modules.
// Each one exists because jsdom — and a torn-down content-script context —
// lacks the API a real page has (or reports zero for it), and the callers
// must degrade rather than throw. Content-script only: none of this is
// meaningful in the service worker.

import type { ViewportSize } from './types';

/**
 * The viewport *excluding* rendered scrollbars, in CSS px — the CSSOM's
 * `documentElement.clientWidth/clientHeight`, which is the viewport minus
 * scrollbars rather than the root element's own box (so the sidebar's
 * `margin-right` on <html> does not affect it).
 *
 * This is the box the sidebar's `position: fixed; right: 0` panel is laid
 * out in, so it is the one measurement every module that reasons about
 * the panel's edge has to share: add mode clamps selections to it
 * (clamping to `innerWidth` instead would let a right-edge selection
 * overlap the sidebar by exactly the scrollbar's width and put extension
 * UI in a capture), the resize drag measures the panel's width from it,
 * the enlarged view lays its sheet out in it, and the capture message
 * carries it as the scrollbar-excluded candidate for the crop scale.
 *
 * jsdom (and any layout-less environment) reports 0 here; fall back to the
 * inner dimensions rather than returning a zero-size viewport.
 */
export function getContentViewportSize(): ViewportSize {
  const docEl = document.documentElement;
  return {
    width: docEl?.clientWidth || window.innerWidth,
    height: docEl?.clientHeight || window.innerHeight,
  };
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** `matchMedia('(prefers-reduced-motion: reduce)')`, or null where matchMedia
 *  is missing (jsdom) or throws. Callers read `.matches` live and subscribe
 *  to 'change' so a preference flipped mid-session takes effect. */
export function reducedMotionQuery(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    return null;
  }
}

/** requestAnimationFrame, or a 16ms timeout where the frame clock is missing
 *  (jsdom). Checked per call, not once, so a test that installs the clock
 *  after the caller started is still honoured. */
export function requestAnimationFrameSafe(cb: (ts: number) => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(cb);
  }
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}

/** The matching cancel for requestAnimationFrameSafe. */
export function cancelAnimationFrameSafe(id: number): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}
