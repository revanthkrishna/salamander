// src/dom.ts
// Small browser-environment helpers shared by the content-script modules
// (dockMotion.ts, enlargedView.ts). Each one exists because jsdom — and a
// torn-down content-script context — lacks the API a real page has, and the
// callers must degrade rather than throw. Content-script only: none of this
// is meaningful in the service worker.

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
