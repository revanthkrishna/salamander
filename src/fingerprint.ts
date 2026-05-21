import type { Fingerprint, Annotation } from './types';

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

  if (candidateSet.size === 0) return null;

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
    return bestEl;
  }
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
  // Visibility gate
  if (!isVisible(el)) return -1000;

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
  } else if (matchedViaXPath) {
    score += 50;
  } else if (matchedViaText) {
    // Is this the only text+tag match in the document?
    const allTextMatches = Array.from(document.querySelectorAll(fingerprint.tagName)).filter(
      (e) => (e.textContent?.trim().slice(0, 50) ?? '') === fingerprint.textSnippet
    );
    score += allTextMatches.length === 1 ? 40 : 20;
  } else if (matchedViaCSS) {
    // Non-unique CSS selector match
    score += 30;
  } else {
    // Not matched by any strategy — shouldn't happen since we only score
    // candidates collected above, but handle gracefully.
    return -1000;
  }

  // ── Context signal bonuses ────────────────────────────────────────────────
  if (fingerprint.closestLabel !== undefined && fingerprint.closestLabel !== '') {
    if (getClosestLabel(el) === fingerprint.closestLabel) score += 20;
  }

  if (fingerprint.pageHeading !== undefined && fingerprint.pageHeading !== '') {
    if (getPageHeading(el) === fingerprint.pageHeading) score += 15;
  }

  if (fingerprint.sectionContext !== undefined && fingerprint.sectionContext !== '') {
    if (getSectionContext(el) === fingerprint.sectionContext) score += 15;
  }

  if (fingerprint.siblingText !== undefined && fingerprint.siblingText !== '') {
    if (getSiblingText(el) === fingerprint.siblingText) score += 10;
  }

  if (fingerprint.domIndex !== undefined) {
    const textSnippet = el.textContent?.trim().slice(0, 50) ?? '';
    if (getDomIndex(el, textSnippet) === fingerprint.domIndex) score += 10;
  }

  return score;
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
 * Return the semantic label text closest to the element:
 *   1. element's own aria-label
 *   2. aria-labelledby → referenced element's textContent
 *   3. aria-describedby → referenced element's textContent
 *   4. Walk up ancestors to find nearest <label> or role="label"
 *   5. Input's associated <label> via matching `for` attribute
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getClosestLabel(el: Element): string {
  // 1. Own aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 80);

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text.slice(0, 80);
  }

  // 3. aria-describedby
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    const text = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text.slice(0, 80);
  }

  // 4. Walk up to find nearest <label> ancestor or role="label"
  let node: Element | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.tagName === 'LABEL' || node.getAttribute('role') === 'label') {
      const text = node.textContent?.trim() ?? '';
      if (text) return text.slice(0, 80);
    }
    node = node.parentElement;
  }

  // 5. Input associated via <label for="id">
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
 * Return the text of the nearest visible heading (h1/h2/h3/role="heading")
 * that is an ancestor of, or precedes in DOM order, the element.
 *
 * Walk-up strategy:
 *   1. Check ancestors for a heading element (stop at <body>).
 *   2. For each ancestor level, also scan preceding siblings for a heading.
 * Returns trimmed text (max 80 chars) or '' if none found.
 */
function getPageHeading(el: Element): string {
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3']);

  function isHeading(node: Element): boolean {
    return HEADING_TAGS.has(node.tagName) || node.getAttribute('role') === 'heading';
  }

  // Walk up the ancestor chain
  let node: Element | null = el.parentElement;
  while (node && node !== document.body) {
    // The ancestor itself might be a heading
    if (isHeading(node)) {
      const text = node.textContent?.trim() ?? '';
      if (text) return text.slice(0, 80);
    }

    // Scan preceding siblings of this ancestor for a heading
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (isHeading(sibling)) {
        const text = sibling.textContent?.trim() ?? '';
        if (text) return text.slice(0, 80);
      }
      sibling = sibling.previousElementSibling;
    }

    node = node.parentElement;
  }

  return '';
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
 * Strategy:
 *   - If the element has a usable (non-framework-generated) #id, prefer it.
 *   - Otherwise walk up to <body>, building the *shortest* path that uniquely
 *     identifies the element. At each ancestor, try in order:
 *       a. tag[stable-attr="val"]   (data-testid, aria-label, name, role, href)
 *       b. tag.classname            (CSS-module hashes stripped; unique among siblings)
 *       c. tag:nth-of-type(n)       (always-emitted index, even for n=1)
 *   - Prepend "body > " so the resulting selector is rooted to <body>.
 *   - After every push, check whether `body > <path>` is already globally
 *     unique; if so, stop walking. This produces short, legible selectors and
 *     avoids the relative-selector false-positive class.
 */
function buildCSSSelector(element: Element): string {
  // Short-circuit on a usable ID — globally unique and self-anchoring.
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
 * Stable attribute extraction. Returns the inner attribute part of a CSS
 * selector (e.g. `data-testid="x"`) or null when no stable attribute is found.
 * Order reflects reliability: explicit test ids > semantic ARIA > form name >
 * role > anchor href.
 */
function getStableAttrSegment(el: Element): string | null {
  // Preferred test-id attributes
  for (const attr of ['data-testid', 'data-test', 'data-id', 'data-cy', 'data-qa']) {
    const value = el.getAttribute(attr);
    if (value !== null && isStableAttrValue(value)) {
      return `${attr}="${CSS.escape(value)}"`;
    }
  }

  // aria-label — stable on icon buttons / landmark regions
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length <= 80) {
    return `aria-label="${CSS.escape(ariaLabel)}"`;
  }

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
 * Build an absolute XPath for the element. Walks from the target up to <html>.
 * Always emits a positional index `[n]`, even for single siblings, so the path
 * is deterministic even when same-tag siblings are added later.
 */
function buildXPath(element: Element): string {
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
