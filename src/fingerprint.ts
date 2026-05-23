import type { Fingerprint, Annotation } from './types';
import { WORD_LIST } from './wordlist';

// Locally-extended fingerprint with the bounding-box captured at annotation
// time. The `rect` field is *not* declared on the public `Fingerprint` type
// in types.ts (kept stable for storage / YAML compatibility) but is written
// alongside the other signals and read back here for a post-resolution
// sanity check. Imported / legacy fingerprints lack the field and skip the
// check entirely.
type FingerprintRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type FingerprintWithRect = Fingerprint & { rect?: FingerprintRect };

// ─── Debug ──────────────────────────────────────────────────────────────────
//
// Console-gated tracing of resolution scoring. Enable in DevTools console
// (page context — no need to switch to the content-script world):
//
//   localStorage.__annotatorDebug = '1'
//
// Then trigger a re-resolve (navigate, reload, or toggle annotation mode).
// Disable with: `localStorage.removeItem('__annotatorDebug')`.
//
// Why localStorage rather than `window.__annotatorDebug`: Chrome content
// scripts run in an isolated JS world — `window` globals set in the page
// console aren't visible to the extension. localStorage is shared.

function isDebug(): boolean {
  if ((globalThis as Record<string, unknown>).__annotatorDebug === true) return true;
  try {
    return localStorage.getItem('__annotatorDebug') === '1';
  } catch {
    return false;
  }
}

function dbg(...args: unknown[]): void {
  if (isDebug()) console.log('[Annotator]', ...args);
}

/** Short, human-readable description of a DOM element for debug logs. */
function describeEl(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cn = typeof el.className === 'string'
    ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 1)
    : [];
  const cls = cn.length ? `.${cn[0]}` : '';
  const text = el.textContent?.trim().slice(0, 30).replace(/\s+/g, ' ') ?? '';
  return `<${el.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ''}`;
}

/**
 * Capture a fingerprint for the given element.
 * Called synchronously when user clicks an element in annotation mode.
 *
 * The fingerprint combines structural signals (CSS selector, XPath, text,
 * tagName) with semantic context signals (closestLabel, pageHeading,
 * sectionContext, siblingText, domIndex) so that structurally-identical
 * elements appearing in different wizard steps / modal dialogs / data rows
 * can be distinguished at resolution time.
 */
export function captureFingerprint(element: Element): Fingerprint {
  const rect = element.getBoundingClientRect();
  const textSnippet = element.textContent?.trim().slice(0, 50) ?? '';
  const fp: FingerprintWithRect = {
    cssSelector: buildCSSSelector(element),
    xpath: buildXPath(element),
    textSnippet,
    tagName: element.tagName.toLowerCase(),
    // Semantic context signals
    closestLabel: getClosestLabel(element),
    pageHeading: getPageHeading(element),
    pageSubHeading: getPageSubHeading(element),
    headingPath: getHeadingPath(element),
    sectionContext: getSectionContext(element),
    siblingText: getSiblingText(element),
    domIndex: getDomIndex(element, textSnippet),
    rect: {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    },
  };
  return fp;
}

/**
 * Attempt to locate an element from its fingerprint.
 * Returns null if the element cannot be found.
 *
 * Resolution strategy: collect all candidates from CSS selector, XPath, and
 * text+tagName matching, then score each candidate against the stored context
 * signals. Return the highest-scoring visible candidate above the minimum
 * threshold, or null if none qualifies.
 */
export function resolveElement(fingerprintInput: Fingerprint): Element | null {
  const fingerprint = fingerprintInput as FingerprintWithRect;

  // ── Collect candidates ────────────────────────────────────────────────────
  // Use a Set to avoid scoring the same element twice when multiple strategies
  // find the same node.
  const candidateSet = new Set<Element>();

  // Strategy 1: CSS selector
  try {
    if (fingerprint.cssSelector) {
      const els = document.querySelectorAll(fingerprint.cssSelector);
      for (const el of Array.from(els)) candidateSet.add(el);
    }
  } catch {
    // Invalid selector — skip
  }

  // Strategy 2: XPath
  try {
    if (fingerprint.xpath) {
      const result = document.evaluate(
        fingerprint.xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_ITERATOR_TYPE,
        null
      );
      let node = result.iterateNext() as Element | null;
      while (node) {
        candidateSet.add(node);
        node = result.iterateNext() as Element | null;
      }
    }
  } catch {
    // Invalid XPath — skip
  }

  // Strategy 3: tagName + text content match
  if (fingerprint.textSnippet && fingerprint.textSnippet.length > 0) {
    try {
      const els = document.querySelectorAll(fingerprint.tagName);
      for (const el of Array.from(els)) {
        const snippet = el.textContent?.trim().slice(0, 50) ?? '';
        if (snippet === fingerprint.textSnippet) candidateSet.add(el);
      }
    } catch {
      // fall through
    }
  }

  if (isDebug()) {
    dbg('────────── resolveElement ──────────');
    dbg('fingerprint:', {
      textSnippet: fingerprint.textSnippet,
      tagName: fingerprint.tagName,
      closestLabel: fingerprint.closestLabel,
      pageHeading: fingerprint.pageHeading,
      pageSubHeading: fingerprint.pageSubHeading,
      headingPath: fingerprint.headingPath,
      sectionContext: fingerprint.sectionContext,
      siblingText: fingerprint.siblingText,
      domIndex: fingerprint.domIndex,
      cssSelector: fingerprint.cssSelector,
      xpath: fingerprint.xpath,
    });
    dbg(`${candidateSet.size} candidate(s) collected`);
  }

  if (candidateSet.size === 0) {
    dbg('→ no candidates, returning null');
    return null;
  }

  // ── Score each candidate ──────────────────────────────────────────────────
  const cssSelectorUnique = (() => {
    try {
      return fingerprint.cssSelector
        ? document.querySelectorAll(fingerprint.cssSelector).length === 1
        : false;
    } catch {
      return false;
    }
  })();

  let bestEl: Element | null = null;
  let bestScore = -Infinity;

  for (const el of candidateSet) {
    const score = scoreCandidate(el, fingerprint, cssSelectorUnique);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  const MINIMUM_SCORE = 40;
  if (bestEl !== null && bestScore >= MINIMUM_SCORE) {
    dbg(`→ WINNER: ${describeEl(bestEl)} score=${bestScore} (threshold ${MINIMUM_SCORE})`);
    return bestEl;
  }
  dbg(`→ best score ${bestScore} below threshold ${MINIMUM_SCORE} — returning null`);
  return null;
}

/**
 * Score a single candidate element against the stored fingerprint.
 *
 * Base points from structural match type:
 *   CSS selector exact match (unique):  60 pts
 *   XPath match:                        50 pts
 *   text+tag match (unique):            40 pts  (when only 1 tag+text match)
 *   text+tag match (non-unique):        20 pts
 *
 * Context bonus (added regardless of structural match type):
 *   closestLabel match:    +20
 *   pageHeading match:     +15
 *   sectionContext match:  +15
 *   siblingText match:     +10
 *   domIndex match:        +10
 *
 * Visibility penalty: -1000 (effectively disqualifies non-visible elements)
 */
function scoreCandidate(
  el: Element,
  fingerprint: FingerprintWithRect,
  cssSelectorUnique: boolean
): number {
  const debug = isDebug();
  const trace: string[] = [];

  // Visibility gate
  if (!isVisible(el)) {
    if (debug) dbg(`  ✗ ${describeEl(el)} INVISIBLE → -1000`);
    return -1000;
  }

  let score = 0;

  // ── Structural base score ─────────────────────────────────────────────────
  let matchedViaCSS = false;
  let matchedViaXPath = false;
  let matchedViaText = false;

  // CSS selector match?
  if (fingerprint.cssSelector) {
    try {
      const matches = document.querySelectorAll(fingerprint.cssSelector);
      if (Array.from(matches).includes(el)) {
        matchedViaCSS = true;
      }
    } catch {
      // ignore
    }
  }

  // XPath match?
  if (fingerprint.xpath) {
    try {
      const result = document.evaluate(
        fingerprint.xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_ITERATOR_TYPE,
        null
      );
      let node = result.iterateNext() as Element | null;
      while (node) {
        if (node === el) { matchedViaXPath = true; break; }
        node = result.iterateNext() as Element | null;
      }
    } catch {
      // ignore
    }
  }

  // Text+tag match?
  if (fingerprint.textSnippet && fingerprint.textSnippet.length > 0) {
    const snippet = el.textContent?.trim().slice(0, 50) ?? '';
    if (
      snippet === fingerprint.textSnippet &&
      el.tagName.toLowerCase() === fingerprint.tagName
    ) {
      matchedViaText = true;
    }
  }

  // Assign base score from best structural match
  if (matchedViaCSS && cssSelectorUnique) {
    score += 60;
    trace.push('CSS-unique +60');
  } else if (matchedViaXPath) {
    score += 50;
    trace.push('XPath +50');
  } else if (matchedViaText) {
    const allTextMatches = Array.from(document.querySelectorAll(fingerprint.tagName)).filter(
      (e) => (e.textContent?.trim().slice(0, 50) ?? '') === fingerprint.textSnippet
    );
    const base = allTextMatches.length === 1 ? 40 : 20;
    score += base;
    trace.push(`text+tag ${allTextMatches.length === 1 ? 'unique' : 'non-unique'} +${base}`);
  } else if (matchedViaCSS) {
    score += 30;
    trace.push('CSS-non-unique +30');
  } else {
    if (debug) dbg(`  ✗ ${describeEl(el)} no structural match → -1000`);
    return -1000;
  }

  // ── Context signal bonuses and mismatch penalties ────────────────────────
  // Rules:
  //   stored non-empty + current matches  → +bonus  (confidence boost)
  //   stored non-empty + current differs  → -penalty (wrong context)
  //   stored empty                        → 0       (not captured; no opinion)
  //   stored non-empty + current empty    → 0       (element not yet rendered; don't penalise)
  // Compute heading-path agreement first — used to SCALE match bonuses on
  // the narrower heading-text signals below. A text-match on closestLabel /
  // pageHeading / pageSubHeading earns less credit when the broader heading
  // context disagrees, which catches the wizard-summary case where a step
  // heading text re-appears in a different section.
  const currentHeadingPath = getHeadingPath(el);
  const agreement = headingPathAgreement(fingerprint.headingPath, currentHeadingPath);

  // Signals with `scale` use agreement-scaled match bonuses (mismatches stay
  // at full penalty — text disagreement is its own independent signal).
  // Signals without `scale` use unscaled bonuses (don't depend on heading context).
  const addContext = (
    label: string,
    stored: string | undefined,
    current: string,
    bonus: number,
    penalty: number,
    scale: number = 1.0,
  ) => {
    let delta = 0;
    if (!stored) {
      // no opinion — signal not stored
    } else if (current === stored) {
      delta = Math.round(bonus * scale);
    } else if (current !== '') {
      delta = -penalty;
    }
    // else: stored non-empty, current empty → defer

    score += delta;
    if (debug && delta !== 0) {
      if (delta > 0) {
        const scaleNote = scale < 0.999 ? ` (scaled ×${scale.toFixed(2)} from headingPath agreement)` : '';
        trace.push(`${label} match: stored="${stored}" current="${current}" +${delta}${scaleNote}`);
      } else {
        trace.push(`${label} MISMATCH: stored="${stored}" current="${current}" ${delta}`);
      }
    }
  };

  addContext('closestLabel',   fingerprint.closestLabel,   getClosestLabel(el),    20, 15, agreement);
  addContext('pageHeading',    fingerprint.pageHeading,    getPageHeading(el),     15, 80, agreement);
  addContext('pageSubHeading', fingerprint.pageSubHeading, getPageSubHeading(el),  15, 60, agreement);

  const hpDelta = scoreHeadingPath(fingerprint.headingPath, currentHeadingPath);
  score += hpDelta;
  if (debug && hpDelta !== 0) {
    trace.push(`headingPath ${hpDelta > 0 ? '+' : ''}${hpDelta} (agreement=${agreement.toFixed(2)}, stored=[${fingerprint.headingPath?.join('|') ?? ''}] current=[${currentHeadingPath.join('|')}])`);
  }

  addContext('sectionContext', fingerprint.sectionContext, getSectionContext(el), 15, 25);
  addContext('siblingText',    fingerprint.siblingText,    getSiblingText(el),    10, 10);

  if (fingerprint.domIndex !== undefined) {
    const textSnippet = el.textContent?.trim().slice(0, 50) ?? '';
    const currentDomIdx = getDomIndex(el, textSnippet);
    if (currentDomIdx === fingerprint.domIndex) {
      score += 10;
      if (debug) trace.push(`domIndex match (${currentDomIdx}) +10`);
    } else if (debug) {
      trace.push(`domIndex mismatch: stored=${fingerprint.domIndex} current=${currentDomIdx} +0`);
    }
  }

  if (debug) {
    dbg(`  • ${describeEl(el)} → ${score}`);
    for (const line of trace) dbg(`      ${line}`);
  }
  return score;
}

/**
 * Score a single context signal: +bonus on match, -penalty on clear mismatch.
 * No opinion when either side is empty.
 */
function scoreContext(
  stored: string | undefined,
  current: string,
  bonus: number,
  penalty: number
): number {
  if (!stored) return 0;          // signal not stored → no opinion
  if (current === stored) return bonus;   // match → confidence boost
  if (current !== '') return -penalty;    // both non-empty and different → wrong context
  return 0;                       // stored non-empty, current empty → defer
}

/**
 * Score the headingPath signal: a set-based comparison between the captured
 * list of preceding headings and the candidate's current list.
 *
 *   common (stored ∩ current)       → +5 each, capped at +25 (5 headings)
 *   stored-but-missing-from-current → -10 each, capped at -60
 *   current-but-not-in-stored       → -7 each, capped at -40
 *
 * Asymmetry rationale: a stored heading we can't find on the candidate is the
 * stronger mismatch signal (likely wrong section); an unexpected extra heading
 * is weaker evidence (could legitimately reflect page evolution since capture).
 *
 * Penalty caps are large because the text-level signals (closestLabel and
 * pageHeading) can collide when a heading-text re-appears in a different
 * context (e.g. summary section listing prior wizard steps). headingPath is
 * the broader-context arbiter and needs enough weight to override coincidental
 * text matches on the narrow signals.
 *
 * Returns 0 when no headingPath was stored (backward compat with legacy /
 * imported fingerprints that predate this signal).
 */
function scoreHeadingPath(
  stored: string[] | undefined,
  current: string[]
): number {
  if (!stored || stored.length === 0) return 0;

  const storedSet = new Set(stored);
  const currentSet = new Set(current);

  let common = 0;
  let missing = 0;
  let extra = 0;
  for (const s of storedSet) {
    if (currentSet.has(s)) common++;
    else missing++;
  }
  for (const c of currentSet) {
    if (!storedSet.has(c)) extra++;
  }

  const commonBonus = Math.min(common * 5, 25);
  const missingPenalty = Math.min(missing * 10, 60);
  const extraPenalty = Math.min(extra * 7, 40);

  return commonBonus - missingPenalty - extraPenalty;
}

/**
 * Jaccard similarity between stored and current heading paths — used to
 * SCALE the text-match bonuses on `closestLabel`, `pageHeading`, and
 * `pageSubHeading`. When the broader heading context disagrees, a
 * coincidental text match on those narrower signals earns proportionally
 * less credit.
 *
 * Returns 1.0 when no headingPath was stored (legacy fingerprint) or when
 * the current page has no headings yet (deferred rendering) — i.e. fall
 * back to full credit when we have no broader-context signal to scale by.
 */
function headingPathAgreement(
  stored: string[] | undefined,
  current: string[]
): number {
  if (!stored || stored.length === 0) return 1.0;
  if (current.length === 0) return 1.0;

  const storedSet = new Set(stored);
  const currentSet = new Set(current);
  let common = 0;
  for (const s of storedSet) {
    if (currentSet.has(s)) common++;
  }
  const union = storedSet.size + currentSet.size - common;
  if (union === 0) return 1.0;
  return common / union;
}

/**
 * Attempt to resolve all annotations for the current page.
 * Returns resolved annotations with their elements and the count of unresolved ones.
 */
export function resolvePageAnnotations(
  annotations: Annotation[]
): { resolved: Array<{ annotation: Annotation; element: Element }>; unresolvedCount: number } {
  const resolved: Array<{ annotation: Annotation; element: Element }> = [];
  let unresolvedCount = 0;

  for (const annotation of annotations) {
    const element = resolveElement(annotation.fingerprint);
    if (element !== null) {
      resolved.push({ annotation, element });
    } else {
      unresolvedCount++;
    }
  }

  return { resolved, unresolvedCount };
}

// ─── Context signal helpers ──────────────────────────────────────────────────

/**
 * Generic action words that are too ambiguous to use as a closestLabel.
 * When aria-label matches one of these (case-insensitive), we skip it in
 * favour of a more contextual signal.
 */
const GENERIC_ACTION_WORDS = new Set([
  'next', 'previous', 'prev', 'back', 'forward', 'cancel', 'close', 'save',
  'submit', 'ok', 'yes', 'no', 'delete', 'remove', 'edit', 'add', 'create',
  'update', 'confirm', 'done', 'apply', 'reset', 'clear', 'search', 'filter',
  'continue',
]);

/**
 * Return the semantic label text closest to the element:
 *   1. Nearest preceding heading (h1–h4 or role="heading") text — most
 *      contextual signal, distinguishes elements in different wizard steps.
 *   2. element's own aria-label — skipped if the value is a generic action word.
 *   3. aria-labelledby → referenced element's textContent
 *   4. aria-describedby → referenced element's textContent
 *   5. Walk up ancestors to find nearest <label> or role="label"
 *   6. Input's associated <label> via matching `for` attribute
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getClosestLabel(el: Element): string {
  // 1. Nearest preceding sub-heading — most specific local context
  const subHeadingText = getPageSubHeading(el);
  if (subHeadingText) return subHeadingText;

  // 2. Nearest preceding heading — broader section context
  const headingText = getPageHeading(el);
  if (headingText) return headingText;

  // 2. Own aria-label — but skip generic action words
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    if (!GENERIC_ACTION_WORDS.has(ariaLabel.trim().toLowerCase())) {
      return ariaLabel.trim().slice(0, 80);
    }
  }

  // 3. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text.slice(0, 80);
  }

  // 4. aria-describedby
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    const text = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text.slice(0, 80);
  }

  // 5. Walk up to find nearest <label> ancestor or role="label"
  let node: Element | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.tagName === 'LABEL' || node.getAttribute('role') === 'label') {
      const text = node.textContent?.trim() ?? '';
      if (text) return text.slice(0, 80);
    }
    node = node.parentElement;
  }

  // 6. Input associated via <label for="id">
  const elId = el.id;
  if (elId) {
    const label = document.querySelector(`label[for="${CSS.escape(elId)}"]`);
    if (label) {
      const text = label.textContent?.trim() ?? '';
      if (text) return text.slice(0, 80);
    }
  }

  return '';
}

/**
 * Return the text of the nearest heading (h1–h4 or role="heading") that
 * precedes the element in document order.
 *
 * Walks ALL headings on the page and returns the last one that comes before
 * the element. This handles wizard/tab patterns where the step heading and
 * the annotated element are in sibling containers rather than ancestor/
 * descendant containers (the old ancestor-walk approach missed those).
 *
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getPageHeading(el: Element): string {
  const headings = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')
  );

  // Iterate in reverse document order — first heading we find that precedes el
  // is the nearest one.
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h === el || h.contains(el)) continue;
    // DOCUMENT_POSITION_FOLLOWING means el comes after h → h precedes el
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = h.textContent?.trim() ?? '';
      if (text) return text.slice(0, 80);
    }
  }

  return '';
}

/**
 * Return the numeric heading level for an element: 1–4 for h1–h4,
 * or 3 as a default for elements with role="heading".
 */
function getHeadingLevel(el: Element): number {
  const tag = el.tagName.toLowerCase();
  if (tag === 'h1') return 1;
  if (tag === 'h2') return 2;
  if (tag === 'h3') return 3;
  if (tag === 'h4') return 4;
  // role="heading" default
  return 3;
}

/**
 * Return the text of the nearest sub-heading that sits between the nearest
 * preceding heading (pageHeading) and the element in document order, at a
 * lower heading level (higher number) than the page heading.
 *
 * For example, if the pageHeading is an h2, this returns the nearest h3 or h4
 * appearing after that h2 and before `el`.
 *
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getPageSubHeading(el: Element): string {
  const headings = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')
  );

  // Find the nearest preceding heading element and its level (same scan as getPageHeading)
  let pageHeadingEl: Element | null = null;
  let pageHeadingLevel = 0;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h === el || h.contains(el)) continue;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = h.textContent?.trim() ?? '';
      if (text) {
        pageHeadingEl = h;
        pageHeadingLevel = getHeadingLevel(h);
        break;
      }
    }
  }

  // If no page heading found, or the page heading is already the deepest level (h4), bail out
  if (!pageHeadingEl || pageHeadingLevel >= 4) return '';

  // Find the nearest heading that:
  //   (a) has a higher level number (lower rank) than the page heading
  //   (b) appears after the page heading element in document order
  //   (c) precedes `el` in document order
  // Iterate in reverse document order to find the nearest one.
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h === el || h.contains(el)) continue;
    // (c) must precede el
    if (!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    // (b) must come after the page heading
    if (!(pageHeadingEl.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    // (a) must be at a deeper level than the page heading
    if (getHeadingLevel(h) <= pageHeadingLevel) continue;
    const text = h.textContent?.trim() ?? '';
    if (text) return text.slice(0, 80);
  }

  return '';
}

/**
 * Return the full list of h1–h4 / role="heading" elements that precede the
 * element in document order, mapped to their trimmed text content.
 *
 * Where `getPageHeading` returns only the single nearest preceding heading,
 * this returns all of them — which gives the scorer the signal it needs to
 * distinguish elements that share the same nearest heading but live in
 * different sections / wizard steps. E.g. a "Previous" button in step 4 and
 * one in the "Review and submit" step often share their nearest heading
 * (because of a stepper sidebar above both), but the step's own pane heading
 * appears in only one button's preceding-headings list.
 *
 * Cap at the 10 most-recent (deepest-in-document-order) entries; those are
 * the most local context. Each text entry trimmed to 80 chars. Skips the
 * element itself and any heading that contains it.
 */
function getHeadingPath(el: Element): string[] {
  const headings = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')
  );

  const result: string[] = [];
  for (const h of headings) {
    if (h === el || h.contains(el)) continue;
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = h.textContent?.trim() ?? '';
      if (text) result.push(text.slice(0, 80));
    }
  }

  // Keep the most-recent (deepest in document order) — those are most local.
  return result.length > 10 ? result.slice(-10) : result;
}

/**
 * Return the "container identity" of the nearest ancestor that has:
 *   - data-step, data-page, data-section, or data-id attribute
 *   - role="region", "dialog", "form", "tabpanel", or "tab"
 *   - aria-label on a section/div/form ancestor
 *
 * Preference order: data-step > data-page > data-section > aria-label on
 * sectioning element > role attribute text.
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getSectionContext(el: Element): string {
  const DATA_ATTRS = ['data-step', 'data-page', 'data-section', 'data-id'];
  const SECTION_ROLES = new Set(['region', 'dialog', 'form', 'tabpanel', 'tab']);
  const SECTION_TAGS = new Set(['SECTION', 'ARTICLE', 'ASIDE', 'FORM', 'DIALOG', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'DIV']);

  let node: Element | null = el.parentElement;
  while (node && node !== document.body) {
    // Prefer explicit data-* step/page/section attributes
    for (const attr of DATA_ATTRS) {
      const val = node.getAttribute(attr);
      if (val && val.trim()) return val.trim().slice(0, 80);
    }

    // aria-label on a sectioning element
    const ariaLabel = node.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim() && SECTION_TAGS.has(node.tagName)) {
      return ariaLabel.trim().slice(0, 80);
    }

    // role attribute on a sectioning role
    const role = node.getAttribute('role');
    if (role && SECTION_ROLES.has(role)) {
      // Prefer the element's aria-label or its text if short enough
      const label = node.getAttribute('aria-label');
      if (label && label.trim()) return label.trim().slice(0, 80);
      return role.slice(0, 80);
    }

    node = node.parentElement;
  }

  return '';
}

/**
 * Return the concatenated trimmed text of the element's direct prev/next
 * siblings, separated by ' | ', capped at 60 chars total.
 * Returns '' if neither sibling has non-empty text.
 */
function getSiblingText(el: Element): string {
  const parts: string[] = [];

  const prev = el.previousElementSibling;
  if (prev) {
    const t = prev.textContent?.trim() ?? '';
    if (t) parts.push(t);
  }

  const next = el.nextElementSibling;
  if (next) {
    const t = next.textContent?.trim() ?? '';
    if (t) parts.push(t);
  }

  const result = parts.join(' | ');
  return result.slice(0, 60);
}

/**
 * Return the 0-based index of the element among all elements in the document
 * that share the same tagName and whose textContent snippet starts with (or
 * equals) `textSnippet`. Returns 0 when the element is the only match or
 * textSnippet is empty.
 */
function getDomIndex(el: Element, textSnippet: string): number {
  if (!textSnippet) return 0;
  const matches = Array.from(document.querySelectorAll(el.tagName)).filter(
    (e) => (e.textContent?.trim().slice(0, 50) ?? '') === textSnippet
  );
  const idx = matches.indexOf(el);
  return idx < 0 ? 0 : idx;
}

/**
 * Returns true when the element is currently visible in the page.
 * Checks offsetWidth/Height, computed display/visibility/opacity.
 * Non-HTMLElement nodes (SVG etc.) are assumed visible.
 */
function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

// ─── Structural fingerprint helpers ─────────────────────────────────────────

/**
 * Build a stable CSS selector for the element.
 *
 * Priority order:
 *   1. Any data-* attribute with a non-empty stable value → tag[data-*="val"]
 *   2. Element's own ID if it contains dictionary-like words → #id
 *   3. Walk up to <body> building the shortest uniquely-identifying path, at
 *      each node trying:
 *       a. tag[stable-attr="val"]   (data-* first, then name, role, href)
 *       b. tag.classname            (CSS-module hashes stripped; unique among siblings)
 *       c. tag:nth-of-type(n)       (always-emitted index, even for n=1)
 *   - Prepend "body > " so the resulting selector is rooted to <body>.
 *   - After every push, check whether `body > <path>` is already globally
 *     unique; if so, stop walking. This produces short, legible selectors and
 *     avoids the relative-selector false-positive class.
 */
function buildCSSSelector(element: Element): string {
  // Priority 1: any data-* attribute on the element itself
  const dataAttrSeg = getDataAttrSegment(element);
  if (dataAttrSeg) {
    const tag = element.tagName.toLowerCase();
    const sel = `${tag}[${dataAttrSeg}]`;
    if (isUnique(sel)) return sel;
    // Even if not globally unique, use it as a rooted selector
    const rooted = 'body > ' + sel;
    if (isUnique(rooted)) return rooted;
  }

  // Priority 2: own ID with dictionary-like word
  if (hasUsableId(element) && idHasDictionaryWord(element.id)) {
    const sel = `#${CSS.escape(element.id)}`;
    if (isUnique(sel)) return sel;
  }

  // Priority 3: fall back to the original walk — but also try the plain
  // usable ID (without the dictionary check) since the original code did.
  if (hasUsableId(element)) {
    const sel = `#${CSS.escape(element.id)}`;
    if (isUnique(sel)) return sel;
  }

  const parts: string[] = [];
  let node: Element | null = element;

  while (node && node !== document.body && node !== document.documentElement) {
    // If this ancestor has a usable ID, anchor on it and stop walking.
    if (node !== element && hasUsableId(node)) {
      const headSel = `#${CSS.escape(node.id)}`;
      if (isUnique(headSel)) {
        return [headSel, ...parts].join(' > ');
      }
    }

    parts.unshift(segmentFor(node));

    const candidate = 'body > ' + parts.join(' > ');
    if (isUnique(candidate)) {
      // Already globally unique — no need to walk further up.
      return candidate;
    }

    node = node.parentElement;
  }

  return 'body > ' + parts.join(' > ');
}

/**
 * Produce the most-specific stable selector segment we can for a single node.
 * Tries: stable attribute → meaningful class → tag+nth-of-type.
 */
function segmentFor(node: Element): string {
  const tag = node.tagName.toLowerCase();

  // a. Stable attribute (data-testid, aria-label, name, role, href, …)
  const attrSegment = getStableAttrSegment(node);
  if (attrSegment) return `${tag}[${attrSegment}]`;

  // b. Tag + meaningful class — only if unique among same-tag siblings.
  //    Global uniqueness is verified by the caller after the path is assembled.
  const cls = getMeaningfulClass(node);
  if (cls) {
    const parent = node.parentElement;
    if (parent) {
      const siblingMatches = Array.from(parent.children)
        .filter(el => el.tagName === node.tagName && el.classList.contains(cls));
      if (siblingMatches.length === 1) {
        return `${tag}.${CSS.escape(cls)}`;
      }
    }
  }

  // c. Tag + nth-of-type — always emit an index, even for n=1.
  const siblings = Array.from(node.parentElement?.children ?? [])
    .filter(el => el.tagName === node.tagName);
  const index = Math.max(1, siblings.indexOf(node) + 1);
  return `${tag}:nth-of-type(${index})`;
}

/**
 * Returns true if the given ID string contains at least one segment that is a
 * dictionary word. Segments are produced by splitting on "-" and "_", and only
 * segments of 3+ characters are considered.
 */
function idHasDictionaryWord(id: string): boolean {
  const segments = id.split(/[-_]/);
  for (const seg of segments) {
    if (seg.length >= 3 && WORD_LIST.has(seg.toLowerCase())) return true;
  }
  return false;
}

/**
 * Returns true if the element has an ID worth using as an anchor.
 * Rejects framework-generated IDs that look auto-generated (Radix, Headless UI,
 * MUI, Chakra, Aria, purely numeric, UUID, react-aria `:r17:` style).
 */
function hasUsableId(el: Element): boolean {
  if (!el.id || el.id.trim() === '') return false;
  const id = el.id;
  // React aria / Radix-style `:r17:` IDs start with a colon
  if (id.startsWith(':')) return false;
  // Common framework prefixes
  if (/^(radix-|headlessui-|mui-|chakra-|aria-|react-aria-)/i.test(id)) return false;
  // Pure numeric ids are usually dynamic
  if (/^\d+$/.test(id)) return false;
  // UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  // Long hex strings
  if (/^[0-9a-f]{16,}$/i.test(id)) return false;
  return true;
}

/**
 * Returns the inner CSS selector attribute part for any data-* attribute on the
 * element (e.g. `data-testid="wizard-next"`), or null if none found.
 * Checks any data-* attribute (not just a hard-coded list).
 */
function getDataAttrSegment(el: Element): string | null {
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (attr.name.startsWith('data-') && isStableAttrValue(attr.value)) {
      return `${attr.name}="${CSS.escape(attr.value)}"`;
    }
  }
  return null;
}

/**
 * Stable attribute extraction. Returns the inner attribute part of a CSS
 * selector (e.g. `data-testid="x"`) or null when no stable attribute is found.
 * Order reflects reliability: data-* attributes > form name > role > anchor href.
 * aria-label is intentionally excluded here — it stays in getClosestLabel only.
 */
function getStableAttrSegment(el: Element): string | null {
  // data-* attributes — any data-* with a stable value
  const dataAttr = getDataAttrSegment(el);
  if (dataAttr) return dataAttr;

  // name — form controls
  const name = el.getAttribute('name');
  if (name && isStableAttrValue(name)) {
    return `name="${CSS.escape(name)}"`;
  }

  // role — landmarks
  const role = el.getAttribute('role');
  if (role && isStableAttrValue(role) && role.length <= 30) {
    return `role="${CSS.escape(role)}"`;
  }

  // href — only for anchors; prefer relative/hash links
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    if (href && href.length > 0 && href.length <= 120 &&
        (href.startsWith('/') || href.startsWith('#'))) {
      return `href="${CSS.escape(href)}"`;
    }
  }

  return null;
}

/**
 * Returns true if the attribute value looks like a hand-authored identifier.
 */
function isStableAttrValue(value: string): boolean {
  if (!value) return false;
  if (value.length > 100) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (/^[0-9a-f]{16,}$/i.test(value)) return false;
  // React 18+ useId pattern (`:rXX:` where XX is base-36) — regenerates on
  // every render, so a data-* value carrying it is unstable. Matches both the
  // raw form (`:r9r:`) and prefixed forms used by component libraries
  // (e.g. Cloudscape's `button:r9r:` for data-analytics-funnel-value).
  if (/:r[0-9a-z]{1,6}:/i.test(value)) return false;
  return true;
}

/**
 * Pick a meaningful class name from the element. Strips CSS-module hash
 * suffixes like `Button_primary_a8d3f` → `Button_primary`. Rejects auto-
 * generated/hash classes and Tailwind-style utilities (kept as last resort).
 */
function getMeaningfulClass(el: Element): string | null {
  const cn = el.className;
  if (typeof cn !== 'string' || cn.trim() === '') return null;

  for (const raw of cn.split(/\s+/)) {
    if (!raw) continue;

    // Strip CSS-module hash suffixes (5+ alphanumeric chars after _ or -)
    const cleaned = raw.replace(/[-_][A-Za-z0-9]{5,}$/, '');

    if (cleaned.length < 3) continue;
    // ALL CAPS / digit hashes
    if (/^[A-Z0-9]{6,}$/.test(cleaned)) continue;
    // 1–2 letter utility classes
    if (/^[a-z]{1,2}$/.test(cleaned)) continue;
    // foo_1234-style
    if (/^[a-z0-9_-]+\d{4,}$/.test(cleaned)) continue;
    // Common Tailwind/utility prefixes — too weak as a primary signal
    if (/^(flex|grid|block|hidden|absolute|relative|fixed|p-|m-|w-|h-|text-|bg-|border|rounded)/.test(cleaned)) continue;

    return cleaned;
  }
  return null;
}

/**
 * Returns true if the selector matches exactly one element in the document.
 */
function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * Build an absolute XPath for the element.
 *
 * Priority order:
 *   1. data-* attribute → //tag[@data-attr="value"]
 *   2. Heading-anchored XPath using the nearest preceding heading (h1–h4 or
 *      role="heading"), but only when the element itself has non-empty
 *      textContent so the following:: predicate is meaningful.
 *   3. Element's own dictionary-word ID → //*[@id="the-id"]
 *   4. Positional path fallback (walk up to <html>, emit tag[n] at each level)
 */
function buildXPath(element: Element): string {
  const tag = element.tagName.toLowerCase();

  // Priority 1: any data-* attribute
  const dataAttr = getDataAttrSegment(element);
  if (dataAttr) {
    return `//${tag}[@${dataAttr}]`;
  }

  // Priority 2: heading-anchored XPath
  const elementText = element.textContent?.trim().slice(0, 50) ?? '';
  if (elementText) {
    const headingXPath = buildHeadingAnchoredXPath(element, tag, elementText);
    if (headingXPath) return headingXPath;
  }

  // Priority 3: dictionary-word ID on the element itself
  if (element.id && hasUsableId(element) && idHasDictionaryWord(element.id)) {
    return `//*[@id="${element.id}"]`;
  }

  // Priority 4: positional path fallback
  return buildPositionalXPath(element);
}

/**
 * Attempt to build a heading-anchored XPath. Prefers the sub-heading (more
 * specific) over the main page heading as the anchor. Verifies the XPath
 * resolves back to exactly the target element, and returns it — or null if no
 * valid heading-anchored path can be built.
 */
function buildHeadingAnchoredXPath(
  element: Element,
  tag: string,
  elementText: string
): string | null {
  // Prefer the sub-heading as the anchor — it is more specific and produces a
  // tighter match. Fall back to the main page heading if no sub-heading exists.
  const subHeadingText = getPageSubHeading(element);
  const anchorText = subHeadingText || getPageHeading(element);

  if (!anchorText) return null;

  // Build the heading-anchored XPath
  const escapedHeading = anchorText.replace(/"/g, '&quot;');
  const escapedText = elementText.replace(/"/g, '&quot;');
  const xpath =
    `//*[self::h1 or self::h2 or self::h3 or self::h4]` +
    `[normalize-space()="${escapedHeading}"]` +
    `/following::${tag}[normalize-space()="${escapedText}"][1]`;

  // Verify this XPath actually resolves to the target element
  try {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    if (result.singleNodeValue === element) return xpath;
  } catch {
    // Invalid XPath or evaluation error — fall through
  }

  // If sub-heading anchor didn't verify, try the main heading as a fallback
  if (subHeadingText) {
    const mainHeadingText = getPageHeading(element);
    if (mainHeadingText) {
      const escapedMain = mainHeadingText.replace(/"/g, '&quot;');
      const xpathFallback =
        `//*[self::h1 or self::h2 or self::h3 or self::h4]` +
        `[normalize-space()="${escapedMain}"]` +
        `/following::${tag}[normalize-space()="${escapedText}"][1]`;
      try {
        const result = document.evaluate(
          xpathFallback,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue === element) return xpathFallback;
      } catch {
        // fall through
      }
    }
  }

  return null;
}

/**
 * Build a positional XPath by walking from the element up to <html>.
 * Always emits a positional index `[n]`, even for single siblings, so the path
 * is deterministic even when same-tag siblings are added later.
 */
function buildPositionalXPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;

    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children)
      .filter(el => el.tagName === node!.tagName);
    const index = Math.max(1, siblings.indexOf(node) + 1);
    parts.unshift(`${tag}[${index}]`);

    node = parent;
  }

  return '/' + parts.join('/');
}

/**
 * After resolving a candidate element, compare its current bounding rect to
 * the rect captured at annotation time (if any). Reject candidates whose size
 * is wildly different — this catches resolved-but-wrong elements (e.g. a tiny
 * icon when the original was a banner, or a hidden 0×0 placeholder).
 *
 * Tolerance: width and height each within 50% (i.e. between 0.5× and 2× of
 * the saved values). Skipped when no rect was captured (legacy/imported data).
 *
 * NOTE: This function is retained for any future direct use but is no longer
 * called from resolveElement; visibility is now handled by isVisible() and
 * the scoring system handles context-mismatch cases.
 */
function passesRectSanityCheck(el: Element, fingerprint: FingerprintWithRect): boolean {
  if (!fingerprint.rect) return true; // legacy / imported — nothing to check

  const rect = el.getBoundingClientRect();
  const savedW = fingerprint.rect.width;
  const savedH = fingerprint.rect.height;

  // Always accept when the saved element was effectively zero-sized — too
  // small to make a meaningful comparison.
  if (savedW < 4 && savedH < 4) return true;

  // Reject candidates that are currently zero-sized when the saved rect was
  // substantial (likely a hidden / detached placeholder).
  if (rect.width === 0 && rect.height === 0 && (savedW >= 4 || savedH >= 4)) {
    return false;
  }

  // Reject when the candidate is wildly different in BOTH dimensions.
  // Responsive layouts and minor reflows can change one dimension a lot
  // (e.g. text wraps, container width tightens), so we only fail when both
  // width and height are outside the tolerance band.
  const widthOK = isWithinTolerance(rect.width, savedW);
  const heightOK = isWithinTolerance(rect.height, savedH);
  if (!widthOK && !heightOK) return false;

  return true;
}

/**
 * Returns true when `actual` is within ±50% of `expected`. Specifically
 * `actual` must be between 0.5× and 1.5× of `expected` (or the equivalent
 * relationship when `actual > expected`). This is symmetric: a 2× size jump
 * fails the check, as does a 0.5× shrink.
 */
function isWithinTolerance(actual: number, expected: number): boolean {
  if (expected <= 0 && actual <= 0) return true;
  if (expected <= 0 || actual <= 0) return false;
  const bigger = Math.max(actual, expected);
  const smaller = Math.min(actual, expected);
  return bigger / smaller <= 1.5;
}
