import type { Fingerprint, Annotation } from './types';

/**
 * Capture a fingerprint for the given element.
 * Called synchronously when user clicks an element in annotation mode.
 */
export function captureFingerprint(element: Element): Fingerprint {
  return {
    cssSelector: buildCSSSelector(element),
    xpath: buildXPath(element),
    textSnippet: element.textContent?.trim().slice(0, 50) ?? '',
    tagName: element.tagName.toLowerCase(),
  };
}

/**
 * Attempt to locate an element from its fingerprint.
 * Returns null if the element cannot be found.
 * Resolution order: CSS selector → XPath → text content match → null
 */
export function resolveElement(fingerprint: Fingerprint): Element | null {
  // 1. CSS Selector
  try {
    const el = document.querySelector(fingerprint.cssSelector);
    if (el !== null && isUnique(fingerprint.cssSelector)) {
      return el;
    }
  } catch {
    // Invalid selector — fall through
  }

  // 2. XPath
  try {
    const result = document.evaluate(
      fingerprint.xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const el = result.singleNodeValue as Element | null;
    if (el !== null) {
      return el;
    }
  } catch {
    // Invalid XPath — fall through
  }

  // 3. Text content match
  if (fingerprint.textSnippet && fingerprint.textSnippet.length > 0) {
    const candidates = document.querySelectorAll(fingerprint.tagName);
    for (const el of Array.from(candidates)) {
      const snippet = el.textContent?.trim().slice(0, 50) ?? '';
      if (snippet === fingerprint.textSnippet) {
        return el;
      }
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
 * Walks up from target to <body>, building a full path.
 * Priority at each level: #id > data-* stable attr > tagName:nth-of-type(n)
 */
function buildCSSSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE) {
    // 1. ID — globally unique, stop walking immediately
    if (node.id && node.id.trim() !== '') {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(' > ');
    }

    // 2. Stable data-* attribute
    const stableDataAttr = getStableDataAttr(node);
    if (stableDataAttr) {
      parts.unshift(`${node.tagName.toLowerCase()}[${stableDataAttr}]`);
      node = node.parentElement;
      continue;
    }

    // 3. nth-of-type fallback
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentElement?.children ?? [])
      .filter(el => el.tagName === node!.tagName);
    const index = siblings.indexOf(node) + 1; // 1-based

    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }

    node = node.parentElement;
  }

  return parts.join(' > ');
}

/**
 * Check preferred data-* attributes for a stable (non-UUID, non-numeric) value.
 * Returns the attribute string (e.g. `data-testid="submit-btn"`) or null.
 */
function getStableDataAttr(el: Element): string | null {
  const preferred = ['data-testid', 'data-id', 'data-cy', 'data-qa'];
  for (const attr of preferred) {
    const value = el.getAttribute(attr);
    if (value !== null && isStableDataValue(value)) {
      return `${attr}="${CSS.escape(value)}"`;
    }
  }
  return null;
}

/**
 * Returns true if the data-* value looks like a hand-authored identifier
 * (not a UUID and not a purely numeric string).
 */
function isStableDataValue(value: string): boolean {
  if (!value) return false;
  // Reject UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  // Reject purely numeric
  if (/^\d+$/.test(value)) return false;
  return true;
}

/**
 * Build an absolute XPath for the element.
 * Walks up from target to <html>.
 */
function buildXPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;

    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children)
      .filter(el => el.tagName === node!.tagName);

    if (siblings.length > 1) {
      const index = siblings.indexOf(node) + 1; // 1-based
      parts.unshift(`${tag}[${index}]`);
    } else {
      parts.unshift(tag);
    }

    node = parent;
  }

  return '/' + parts.join('/');
}

/**
 * Returns true if the selector matches exactly one element in the document.
 */
function isUnique(selector: string): boolean {
  return document.querySelectorAll(selector).length === 1;
}
