// src/pageDetectors.ts
// Scans the page for conditions that cause pins to fail silently and returns a
// stable, prioritised list of human-readable issues to surface in the toolbar.
//
// Dependency arrow stays one-way: content.ts → pageDetectors.ts.
// This module MUST NOT import from toolbar.ts or annotationMode.ts.

export type DetectedType = 'iframe' | 'canvas' | 'closedShadow' | 'spa';

export interface DetectedIssue {
  type: DetectedType;
  message: string;
  count?: number;
}

export interface DetectorConfig {
  iframe: boolean;
  canvas: boolean;
  closedShadow: boolean;
  spa: boolean;
  sizeThresholdPx: { width: number; height: number };
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  iframe: true,
  canvas: true,
  closedShadow: true,
  spa: true,
  sizeThresholdPx: { width: 200, height: 200 },
};

// ─────────────────────────────────────────────────────────────────────────────
// User-facing messages
// ─────────────────────────────────────────────────────────────────────────────
// Copy is lowercase to match the toolbar convention (see content.ts:309 — all
// error strings are .toLowerCase() before being handed to showError). iframe
// and canvas detection are deterministic, so we use definite language.
// closedShadow and SPA detection are heuristics, so we hedge.

const MSG_IFRAME =
  "some parts of this page are embedded from another source — you can't pin anything inside those embedded areas.";
const MSG_CANVAS =
  'this page contains drawn images. you can pin the whole image but not specific spots inside it.';
const MSG_CLOSED_SHADOW =
  'some parts of this page are built with components that may not be pinnable individually.';
const MSG_SPA =
  'this page may reload parts of itself as you navigate. pins might not always stay attached when that happens.';

// ─────────────────────────────────────────────────────────────────────────────
// Visibility / size predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true iff `el` is currently rendered AND its bounding box meets the
 * minimum size threshold.
 *
 * Implementation notes:
 *   - Use getBoundingClientRect for the size check (offsetWidth/Height are
 *     mocked to a constant in jsdom — see __tests__/setup.ts).
 *   - Still consult offsetWidth/Height as a coarse "is connected and rendered"
 *     boolean — jsdom returns 100 for any connected element, so this gives us
 *     a reliable presence signal in tests while remaining cheap in the browser.
 *   - Read computed style for display / visibility / opacity.
 */
function isVisibleAndLargeEnough(el: Element, minW: number, minH: number): boolean {
  if (!(el instanceof HTMLElement) && el.tagName.toLowerCase() !== 'iframe' && el.tagName.toLowerCase() !== 'canvas') {
    // We only ever pass HTMLElement-ish things in (iframe / canvas / custom
    // elements are all HTMLElement) — but be defensive.
    return false;
  }

  const htmlEl = el as HTMLElement;

  if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) return false;

  const style = window.getComputedStyle(htmlEl);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;

  const rect = htmlEl.getBoundingClientRect();
  if (rect.width < minW || rect.height < minH) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual detectors
// ─────────────────────────────────────────────────────────────────────────────

function detectIframes(cfg: DetectorConfig): DetectedIssue | null {
  const minW = cfg.sizeThresholdPx.width;
  const minH = cfg.sizeThresholdPx.height;

  const all = document.querySelectorAll('iframe');
  let count = 0;
  for (const el of Array.from(all)) {
    if (isVisibleAndLargeEnough(el, minW, minH)) count++;
  }
  if (count === 0) return null;
  return { type: 'iframe', message: MSG_IFRAME, count };
}

function detectCanvases(cfg: DetectorConfig): DetectedIssue | null {
  const minW = cfg.sizeThresholdPx.width;
  const minH = cfg.sizeThresholdPx.height;

  const all = document.querySelectorAll('canvas');
  let count = 0;
  for (const el of Array.from(all)) {
    if (isVisibleAndLargeEnough(el, minW, minH)) count++;
  }
  if (count === 0) return null;
  return { type: 'canvas', message: MSG_CANVAS, count };
}

function detectClosedShadowRoots(_cfg: DetectorConfig): DetectedIssue | null {
  // Stub — implemented in a follow-up commit.
  return null;
}

function detectSpa(_cfg: DetectorConfig): DetectedIssue | null {
  // Stub — implemented in a follow-up commit.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run every enabled detector and return a stable-ordered list of issues.
 * Order is always: iframe, canvas, closedShadow, spa.
 */
export function detectPageLimitations(
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  if (cfg.iframe) {
    const r = detectIframes(cfg);
    if (r) issues.push(r);
  }
  if (cfg.canvas) {
    const r = detectCanvases(cfg);
    if (r) issues.push(r);
  }
  if (cfg.closedShadow) {
    const r = detectClosedShadowRoots(cfg);
    if (r) issues.push(r);
  }
  if (cfg.spa) {
    const r = detectSpa(cfg);
    if (r) issues.push(r);
  }
  return issues;
}

/**
 * Compose one toolbar-ready string from the detected issues.
 *   - 0 issues  → empty string (caller should guard before calling)
 *   - 1 issue   → that issue's message verbatim
 *   - 2 issues  → "heads up — {a} also, {b}"
 *   - 3+ issues → "heads up — this page has several things that can limit
 *                  pinning: {a} {b} {c} ..."
 */
export function combineIssueMessages(issues: DetectedIssue[]): string {
  if (issues.length === 0) return '';
  if (issues.length === 1) return issues[0].message;
  if (issues.length === 2) {
    return `heads up — ${issues[0].message} also, ${issues[1].message}`;
  }
  const joined = issues.map((i) => i.message).join(' ');
  return `heads up — this page has several things that can limit pinning: ${joined}`;
}
