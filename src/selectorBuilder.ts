// Selector/XPath builders — the surviving half of v1's deleted
// src/fingerprint.ts (git history). These functions are lifted essentially as-is: they are mature and
// already hardened against framework-generated hash IDs/classes (Radix,
// Headless UI, MUI, Chakra, React's `useId`, CSS-module hash suffixes,
// Tailwind utility classes).
//
// What did NOT come along: everything that existed only to *re-find* an
// element later (`resolveElement`, `scoreCandidate`, `scoreContext`,
// `scoreHeadingPath`, `headingPathAgreement`, `passesRectSanityCheck`,
// `resolvePageAnnotations`) and the semantic "which one of several
// lookalikes" signal family (`closestLabel`, `pageHeading`, `pageSubHeading`,
// `headingPath`, `sectionContext`, `siblingText`, `domIndex`). REQUIREMENTS.md
// §1.4 repositions the selector/xpath as a "fingerprint for explanation" (a
// human or coding agent locating the element in source, reading a static
// export) rather than a "fingerprint for resolution" (re-finding the live
// element on a changed page) — so nothing here is used for disambiguation
// anymore, only for description.
//
// DEVIATION FROM THE INVENTORY LIST: v1's `buildXPath` had a second priority
// tier — a "heading-anchored" XPath (`//h2[...]/following::button[...]`)
// built via `buildHeadingAnchoredXPath`, which in turn depended on
// `getPageHeading`/`getPageSubHeading` — i.e. exactly the heading signal
// family that was deliberately deleted with fingerprint.ts. Reintroducing
// those functions here (even as private helpers) would resurrect it. Since
// the deliberate "lift as-is" list
// (buildCSSSelector, segmentFor, hasUsableId, idHasDictionaryWord,
// getDataAttrSegment, getStableAttrSegment, getMeaningfulClass, isUnique,
// buildXPath, buildPositionalXPath) does not name the heading-anchored
// helpers, `buildXPath` below keeps its data-attr and dictionary-id
// priorities but drops straight to the positional fallback instead of trying
// a heading anchor. XPath's stated job is only "fallback identifier" (§1.4A)
// — the primary explanatory value (readable location context) is carried by
// the CSS selector, the outerHTML snippet, and contextCapture.ts's contained
// elements/area text, so the loss is cosmetic, not functional.

import { WORD_LIST } from './wordlist';

// ─── CSS selector building ───────────────────────────────────────────────────

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
export function buildCSSSelector(element: Element): string {
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
export function segmentFor(node: Element): string {
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
export function idHasDictionaryWord(id: string): boolean {
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
export function hasUsableId(el: Element): boolean {
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
export function getDataAttrSegment(el: Element): string | null {
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
 * aria-label is intentionally excluded here (it was v1's `closestLabel`
 * signal, which is not part of the surviving selector logic).
 */
export function getStableAttrSegment(el: Element): string | null {
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
export function isStableAttrValue(value: string): boolean {
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
export function getMeaningfulClass(el: Element): string | null {
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
export function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

// ─── XPath building ───────────────────────────────────────────────────────────

/**
 * Build an absolute XPath for the element — a fallback identifier (§1.4A),
 * not a resolution strategy.
 *
 * Priority order:
 *   1. data-* attribute → //tag[@data-attr="value"]
 *   2. Element's own dictionary-word ID → //*[@id="the-id"]
 *   3. Positional path fallback (walk up to <html>, emit tag[n] at each level)
 *
 * (v1 additionally tried a heading-anchored XPath here as tier 2 — see the
 * file-level DEVIATION note for why that tier was dropped.)
 */
export function buildXPath(element: Element): string {
  const tag = element.tagName.toLowerCase();

  // Priority 1: any data-* attribute
  const dataAttr = getDataAttrSegment(element);
  if (dataAttr) {
    return `//${tag}[@${dataAttr}]`;
  }

  // Priority 2: dictionary-word ID on the element itself
  if (element.id && hasUsableId(element) && idHasDictionaryWord(element.id)) {
    return `//*[@id="${element.id}"]`;
  }

  // Priority 3: positional path fallback
  return buildPositionalXPath(element);
}

/**
 * Build a positional XPath by walking from the element up to <html>.
 * Always emits a positional index `[n]`, even for single siblings, so the path
 * is deterministic even when same-tag siblings are added later.
 */
export function buildPositionalXPath(element: Element): string {
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
