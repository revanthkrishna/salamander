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
 * The fingerprint combines four signals so that the element can be re-located
 * later (same page reload, SPA navigation, or cross-machine import):
 *   1. A body-anchored, per-segment-unique CSS selector
 *   2. An absolute, always-indexed XPath
 *   3. A trimmed text snippet (with uniqueness gate at resolve time)
 *   4. The element's bounding rect (document coords) for a sanity check
 */
export function captureFingerprint(element: Element): Fingerprint {
  const rect = element.getBoundingClientRect();
  const fp: FingerprintWithRect = {
    cssSelector: buildCSSSelector(element),
    xpath: buildXPath(element),
    textSnippet: element.textContent?.trim().slice(0, 50) ?? '',
    tagName: element.tagName.toLowerCase(),
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
 * Resolution order: CSS selector → XPath → unique-text match → null.
 * Every candidate must pass a rect sanity check (if rect was captured).
 */
export function resolveElement(fingerprintInput: Fingerprint): Element | null {
  const fingerprint = fingerprintInput as FingerprintWithRect;
  // 1. CSS Selector — must be unique AND pass rect sanity check
  try {
    if (fingerprint.cssSelector) {
      const els = document.querySelectorAll(fingerprint.cssSelector);
      if (els.length === 1) {
        const el = els[0];
        if (passesRectSanityCheck(el, fingerprint)) return el;
      }
    }
  } catch {
    // Invalid selector — fall through
  }

  // 2. XPath — must pass rect sanity check
  try {
    if (fingerprint.xpath) {
      const result = document.evaluate(
        fingerprint.xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const el = result.singleNodeValue as Element | null;
      if (el !== null && passesRectSanityCheck(el, fingerprint)) {
        return el;
      }
    }
  } catch {
    // Invalid XPath — fall through
  }

  // 3. Text content match — must be UNIQUELY matched AND pass rect check
  if (fingerprint.textSnippet && fingerprint.textSnippet.length > 0) {
    try {
      const candidates = document.querySelectorAll(fingerprint.tagName);
      const matches: Element[] = [];
      for (const el of Array.from(candidates)) {
        const snippet = el.textContent?.trim().slice(0, 50) ?? '';
        if (snippet === fingerprint.textSnippet) {
          matches.push(el);
          if (matches.length > 1) break; // short-circuit: not unique
        }
      }
      if (matches.length === 1 && passesRectSanityCheck(matches[0], fingerprint)) {
        return matches[0];
      }
    } catch {
      // fall through
    }
  }

  // 4. All strategies failed
  return null;
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

// ─── Internal helpers ────────────────────────────────────────────────────────

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
