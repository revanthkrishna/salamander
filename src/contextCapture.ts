// Context capture — REQUIREMENTS.md §1.4, "fingerprint for
// explanation". Pure DOM → object module: given a selection rectangle (page
// coordinates — see Rect/PageMeta comments in types.ts), produces the full
// CapturedContext for one feedback item. No content.ts/background.ts surface;
// src/capture.ts calls `captureContext` from the content script
// at the moment "ok" is clicked, before the overlay UI is hidden for capture.
//
// Design decisions worth flagging (this module owns the schema/budget design,
// not its callers):
//
// 1. Primary target (§1.4A) is found by walking down from <body>/<html>: at
//    each level, pick the single child whose page-rect fully contains the
//    selection rect, and recurse into it; stop at the deepest element that
//    still fully contains the rect. This is the "deepest common ancestor of
//    everything visually inside the box" without needing elementsFromPoint()
//    (not reliably available across the runtimes this module might load
//    into) or a real layout engine (needed for jsdom testability). It is a
//    document-order-biased approximation for absolutely-positioned overlap
//    cases — acceptable for an "explain where this is" feature, not a hard
//    requirement here.
//
// 2. Cross-origin AND same-origin iframes are both treated uniformly as leaf
//    nodes: their tag/attrs (including `src`) are captured but their content
//    document is never inspected. §6 edge case 6 only mandates this for
//    cross-origin iframes (same-origin ones are technically inspectable) —
//    treating both the same avoids a same-origin/cross-origin branch (which
//    would also throw in real cross-origin cases and needs a try/catch
//    either way) for a case v1 doesn't require to be more thorough.
//
// 3. Area text (§1.4C) approximates "all visible text within the rect" by
//    aggregating each intersecting element's own *direct* text (the same
//    per-element text used for contained elements, before the 15-cap/
//    priority sort) in document order. True sub-element text-position
//    matching would need Range.getClientRects() per text node — meaningfully
//    heavier, and not needed for what §1.4C calls "a fast semantic summary".
//
// 4. Size governance (§1.4E) measures budget as `JSON.stringify(...).length`
//    — a character-count proxy for byte size. It undercounts multi-byte
//    UTF-8 text, but the budget is a soft "keep this skimmable" governor, not
//    a wire-format hard limit, so exactness is not worth pulling in
//    TextEncoder (not guaranteed identical across every runtime this module
//    might run in) for.

import type {
  CapturedContext,
  ContainedElement,
  PageMeta,
  PrimaryTarget,
  Rect,
  ViewportSize,
} from './types';
import { normaliseUrl } from './urlNorm';
import { buildCSSSelector, buildXPath } from './selectorBuilder';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CaptureContextOptions {
  /** Overrides for page metadata — primarily for tests. Default to the live
   *  `document`/`location`/`window` when omitted. */
  pageUrl?: string;
  normalisedUrl?: string;
  title?: string;
  viewport?: ViewportSize;
  dpr?: number;
  /** ISO 8601. Defaults to `new Date().toISOString()`. */
  capturedAt?: string;
}

/**
 * Capture the full §1.4 context for a feedback item whose selection rectangle
 * (in page coordinates — i.e. including scroll offset, matching
 * `FeedbackItem.selectionRect`) is `selectionRect`.
 */
export function captureContext(
  selectionRect: Rect,
  options: CaptureContextOptions = {},
): CapturedContext {
  const rootEl = (document.body ?? document.documentElement) as Element;

  const primaryEl = findPrimaryTarget(rootEl, selectionRect);
  const descendants = collectIntersectingDescendants(primaryEl, selectionRect);

  const { items: containedElements, truncated: cappedByCount } =
    buildContainedElements(descendants);
  const areaText = buildAreaText(primaryEl, descendants);

  const sanitizedFullHtml = sanitizeOuterHtml(getOuterHtml(primaryEl));
  const { text: outerHtmlSnippet, truncated: htmlTruncated } = truncateWithMarker(
    sanitizedFullHtml,
    OUTER_HTML_GUIDANCE_CAP,
  );

  const primaryTarget: PrimaryTarget = {
    cssSelector: buildCSSSelector(primaryEl),
    xpath: buildXPath(primaryEl),
    outerHtmlSnippet,
    truncated: htmlTruncated,
  };

  const pageMeta: PageMeta = {
    url: options.pageUrl ?? location.href,
    normalisedUrl: options.normalisedUrl ?? safeNormaliseUrl(options.pageUrl ?? location.href),
    title: options.title ?? document.title,
    viewport: options.viewport ?? { width: window.innerWidth, height: window.innerHeight },
    dpr: options.dpr ?? window.devicePixelRatio ?? 1,
    selectionRect,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  };

  let context: CapturedContext = {
    primaryTarget,
    containedElements,
    areaText,
    pageMeta,
  };
  if (cappedByCount) context.containedElementsTruncated = true;

  if (estimateSize(context) > TOTAL_BUDGET_BYTES) {
    context = shrinkToBudget(context, sanitizedFullHtml);
  }

  return context;
}

function safeNormaliseUrl(url: string): string {
  try {
    return normaliseUrl(url);
  } catch {
    return url;
  }
}

// ─── Primary target (§1.4A) ────────────────────────────────────────────────────

/** Tags whose subtree is never inspected — no useful structural/text signal,
 *  and script/style contents specifically must never leak into the export. */
const NEVER_DESCEND_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/**
 * Deepest single descendant of `root` whose page-rect fully contains
 * `selectionRect`. Stops (and returns the current node) as soon as no single
 * child fully contains the rect, or the containing child is an <iframe> (see
 * file-level design note #2 — iframes are always treated as leaves).
 */
function findPrimaryTarget(root: Element, selectionRect: Rect): Element {
  let current = root;
  for (;;) {
    const containingChild = Array.from(current.children).find((child) => {
      if (NEVER_DESCEND_TAGS.has(child.tagName)) return false;
      if (!isRenderedVisible(child)) return false;
      return rectContains(getPageRect(child), selectionRect);
    });
    if (!containingChild) return current;
    if (containingChild.tagName === 'IFRAME') return containingChild;
    current = containingChild;
  }
}

// ─── Contained elements (§1.4B) ─────────────────────────────────────────────────

/**
 * All descendants of `root` (at any depth) whose page-rect intersects
 * `selectionRect`, in document order. Never descends into <iframe> (leaf,
 * per design note #2) or script/style/template subtrees.
 */
function collectIntersectingDescendants(root: Element, selectionRect: Rect): Element[] {
  const found: Element[] = [];

  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (NEVER_DESCEND_TAGS.has(child.tagName)) continue;
      if (!isRenderedVisible(child)) continue;

      if (rectsIntersect(getPageRect(child), selectionRect)) {
        found.push(child);
      }

      if (child.tagName === 'IFRAME') continue; // leaf — never descend
      walk(child);
    }
  };

  walk(root);
  return found;
}

const CONTAINED_ELEMENTS_CAP = 15;

/** Key attributes captured verbatim per §1.4B, beyond the `data-` and `aria-`
 *  prefix families. */
const SIMPLE_KEY_ATTRS = new Set(['role', 'href', 'alt', 'name', 'type', 'placeholder']);

function getKeyAttrs(el: Element): Record<string, string> | undefined {
  let attrs: Record<string, string> | undefined;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') || attr.name.startsWith('aria-') || SIMPLE_KEY_ATTRS.has(attr.name)) {
      if (!attrs) attrs = {};
      attrs[attr.name] = attr.value;
    }
  }
  return attrs;
}

/** Direct visible text only — text of the element's own text-node children,
 *  not the full subtree (avoids duplicating a child's own `text` entry).
 *  Trimmed, capped at 100 chars per §1.4B. */
function getDirectText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
  }
  return text.trim().slice(0, 100);
}

// CSS-module hash suffix, e.g. `Button_primary_a8d3f` — the suffix alone
// doesn't condemn a class (see getMeaningfulClass in selectorBuilder.ts for
// the sibling heuristic used there), but for the purpose of this field ("is
// this class human-authored or framework noise") a class carrying one *is*
// noise, even though a human wrote the readable part of it.
const CSS_MODULE_SUFFIX = /[-_][A-Za-z0-9]{5,}$/;
const ALL_CAPS_HASH = /^[A-Z0-9]{6,}$/;
const TRAILING_DIGIT_HASH = /^[a-z][a-z0-9_-]*-?\d{4,}$/i;

function isGeneratedClass(raw: string): boolean {
  if (ALL_CAPS_HASH.test(raw)) return true;
  if (TRAILING_DIGIT_HASH.test(raw)) return true;
  if (CSS_MODULE_SUFFIX.test(raw)) {
    const base = raw.replace(CSS_MODULE_SUFFIX, '');
    if (base.length >= 3) return true;
  }
  return false;
}

function classifyClasses(el: Element): ContainedElement['classes'] {
  const raw = typeof el.className === 'string' ? el.className.trim() : '';
  if (!raw) return undefined;

  const semantic: string[] = [];
  const generated: string[] = [];
  for (const cls of raw.split(/\s+/)) {
    if (!cls) continue;
    (isGeneratedClass(cls) ? generated : semantic).push(cls);
  }
  if (semantic.length === 0 && generated.length === 0) return undefined;
  return { semantic, generated };
}

function buildContainedElementItem(el: Element): ContainedElement {
  const item: ContainedElement = { tag: el.tagName.toLowerCase() };
  if (el.id) item.id = el.id;
  const classes = classifyClasses(el);
  if (classes) item.classes = classes;
  const attrs = getKeyAttrs(el);
  if (attrs) item.attrs = attrs;
  const text = getDirectText(el);
  if (text) item.text = text;
  return item;
}

/** Attribute-rich or text-bearing elements outrank bare layout wrappers, per
 *  §1.4B's prioritisation. Ties keep document order (stable sort below). */
function priorityScore(item: ContainedElement): number {
  let score = 0;
  if (item.id) score += 3;
  if (item.attrs) score += 2;
  if (item.text) score += 2;
  if (item.classes && item.classes.semantic.length > 0) score += 1;
  return score;
}

function buildContainedElements(
  elements: Element[],
): { items: ContainedElement[]; truncated: boolean } {
  const withScore = elements.map((el, idx) => {
    const item = buildContainedElementItem(el);
    return { item, idx, score: priorityScore(item) };
  });

  // Stable sort by score desc; ties preserve document order via `idx`.
  withScore.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const truncated = withScore.length > CONTAINED_ELEMENTS_CAP;
  const items = withScore.slice(0, CONTAINED_ELEMENTS_CAP).map((w) => w.item);
  return { items, truncated };
}

// ─── Area text (§1.4C) ──────────────────────────────────────────────────────────

function buildAreaText(primaryEl: Element, descendants: Element[]): string {
  const parts: string[] = [];
  const primaryText = getDirectText(primaryEl);
  if (primaryText) parts.push(primaryText);
  for (const el of descendants) {
    const t = getDirectText(el);
    if (t) parts.push(t);
  }
  // Dedup immediately-adjacent duplicate fragments (a wrapper and its sole
  // text-bearing child commonly produce the same string twice).
  const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
  return deduped.join(' ').trim();
}

// ─── outerHTML sanitisation + truncation ────────────────────────────────────────

const OUTER_HTML_GUIDANCE_CAP = 1024; // §1.4A's 1KB guidance cap
const TOTAL_BUDGET_BYTES = 2048; // §1.4E's 2KB total budget
const TRUNCATION_MARKER = '...[truncated]';

function getOuterHtml(el: Element): string {
  return el.outerHTML ?? '';
}

/** Strips <script>/<style> contents and base64 data-URIs per §1.4A. Keeps the
 *  tags themselves (so the structural shape is still visible) but empties
 *  their bodies, and replaces base64 payloads with a short placeholder. */
function sanitizeOuterHtml(html: string): string {
  let out = html;
  out = out.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  out = out.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
  out = out.replace(/data:[^"'\s)]+;base64,[A-Za-z0-9+/=]+/gi, 'data:[stripped]');
  return out;
}

function truncateWithMarker(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  if (maxLen <= TRUNCATION_MARKER.length) {
    return { text: TRUNCATION_MARKER.slice(0, Math.max(maxLen, 0)), truncated: true };
  }
  return { text: text.slice(0, maxLen - TRUNCATION_MARKER.length) + TRUNCATION_MARKER, truncated: true };
}

// ─── Size governance (§1.4E) ───────────────────────────────────────────────────

function estimateSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Truncate outerHtmlSnippet first (shrinking toward empty), then — only if
 *  still over budget — trim the contained-elements list from its
 *  lowest-priority (tail) end. Always leaves a visible marker, never a
 *  silent cut, per §1.4E. */
function shrinkToBudget(context: CapturedContext, sanitizedFullHtml: string): CapturedContext {
  let working = shrinkOuterHtml(context, sanitizedFullHtml);
  if (estimateSize(working) > TOTAL_BUDGET_BYTES) {
    working = shrinkContainedElements(working);
  }
  return working;
}

function shrinkOuterHtml(context: CapturedContext, sanitizedFullHtml: string): CapturedContext {
  let working = context;
  let cap = context.primaryTarget.outerHtmlSnippet.length;

  while (estimateSize(working) > TOTAL_BUDGET_BYTES && cap > 0) {
    cap = Math.floor(cap * 0.7);
    const { text, truncated } = truncateWithMarker(sanitizedFullHtml, cap);
    working = {
      ...working,
      primaryTarget: { ...working.primaryTarget, outerHtmlSnippet: text, truncated: truncated || working.primaryTarget.truncated },
    };
  }

  if (cap <= 0 && sanitizedFullHtml.length > 0 && working.primaryTarget.outerHtmlSnippet !== TRUNCATION_MARKER) {
    working = {
      ...working,
      primaryTarget: { ...working.primaryTarget, outerHtmlSnippet: TRUNCATION_MARKER, truncated: true },
    };
  }

  return working;
}

function shrinkContainedElements(context: CapturedContext): CapturedContext {
  let items = context.containedElements;
  let working = context;

  while (estimateSize(working) > TOTAL_BUDGET_BYTES && items.length > 0) {
    items = items.slice(0, -1);
    working = { ...working, containedElements: items, containedElementsTruncated: true };
  }

  return working;
}

// ─── Geometry + visibility helpers ──────────────────────────────────────────────

function getPageRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height,
  };
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Returns false for display:none/visibility:hidden/opacity:0. Deliberately
 *  does not gate on rect size (0-width/height elements are naturally
 *  filtered out by the intersection tests instead) — this keeps SVG and
 *  other non-HTMLElement nodes (which have no `offsetWidth`) working without
 *  a type-narrowing branch. */
function isRenderedVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return true;
}
