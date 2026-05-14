# Phase 2B — Fingerprinting Engineer

## Role & Persona

You are a senior frontend engineer with deep expertise in DOM APIs, CSS selectors, and XPath. You know that fingerprinting is the hardest part of this extension — if elements can't be re-located on import, annotations are useless. You implement defensively, handle exceptions everywhere, and make the resolution algorithm work on real-world pages including React SPAs.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — especially §1.2 (Element Targeting) and §6 (edge cases 5, 9, 13) — DO NOT MODIFY
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — **read §4 (Element Fingerprinting) IN FULL** — this is your spec

Also read:
- `/root/.openclaw/workspace/annotator/src/types.ts` — Fingerprint interface (created by Storage & Types engineer, may still be a stub — implement based on the interface defined there)

## What You Produce

Fully implement one file: `src/fingerprint.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### Overview

The fingerprinting module has two responsibilities:
1. **Capture:** When a user clicks an element, record a multi-signal fingerprint
2. **Resolve:** When importing, locate each element from its fingerprint

### `src/fingerprint.ts` — Full Implementation

```typescript
import type { Fingerprint } from './types';

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
  // ... see algorithm below
}
```

### CSS Selector Generation (`buildCSSSelector`)

Implement per TECH_DESIGN.md §4.2. Walk up the DOM from target to `<body>`.

**Priority at each DOM level (first match wins):**

1. **Element has a non-empty `id`:** use `#id`. Stop immediately — IDs are globally unique, no need to walk further.
2. **Element has a stable `data-*` attribute:** check for `data-testid`, `data-id`, `data-cy`, `data-qa` (in that order). Only use if the value appears to be a stable hand-authored identifier, NOT a UUID or a purely numeric value. Stability heuristic:
   - Reject if value matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` (UUID)
   - Reject if value matches `/^\d+$/` (purely numeric)
   - Accept everything else
3. **Fallback:** use `tagName:nth-of-type(n)` — compute the 1-based position of this element among its siblings with the same tag name.

**Why no class names:** Classes are not used in selector generation. Detecting stable vs generated classes is not reliably possible (Tailwind looks like CSS Module hashes). Structural `nth-of-type` selectors are more reliable.

**No length cap.** Do not truncate the selector. Every segment is needed for uniqueness. The resolution algorithm's `isUnique()` check handles non-unique selectors by falling through to XPath.

Build the selector as a full path from `<body>` to the element: `segment1 > segment2 > ... > targetSegment`.

```typescript
function buildCSSSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  
  while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE) {
    // 1. ID
    if (node.id && node.id.trim() !== '') {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(' > ');  // ID is unique, stop walking
    }
    
    // 2. data-* stable attributes
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
    const index = siblings.indexOf(node) + 1;  // 1-based
    
    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }
    
    node = node.parentElement;
  }
  
  return parts.join(' > ');
}

function getStableDataAttr(el: Element): string | null {
  const preferred = ['data-testid', 'data-id', 'data-cy', 'data-qa'];
  for (const attr of preferred) {
    const value = el.getAttribute(attr);
    if (value && isStableDataValue(value)) {
      return `${attr}="${CSS.escape(value)}"`;
    }
  }
  return null;
}

function isStableDataValue(value: string): boolean {
  // Reject UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  // Reject purely numeric
  if (/^\d+$/.test(value)) return false;
  return true;
}
```

### XPath Generation (`buildXPath`)

Implement per TECH_DESIGN.md §4.3. Walk up from target element to `<html>`.

```typescript
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
      const index = siblings.indexOf(node) + 1;  // 1-based
      parts.unshift(`${tag}[${index}]`);
    } else {
      parts.unshift(tag);
    }
    
    node = parent;
  }
  
  return '/' + parts.join('/');
}
```

### Resolution Algorithm (`resolveElement`)

Implement per TECH_DESIGN.md §4.4. Try each strategy in order:

```typescript
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

function isUnique(selector: string): boolean {
  return document.querySelectorAll(selector).length === 1;
}
```

**Edge cases to handle:**
- `CSS.escape()` is used for attribute values to handle special characters
- The CSS selector may contain characters invalid in a selector (rare but possible if a `data-*` value had unusual chars) — the try/catch handles this
- XPath on an SVG element or namespaced element may fail — the try/catch handles this
- Text snippet may be empty string — skip text match in that case (already handled in algorithm)
- Document may not have the element (removed by SPA navigation) — querySelectorAll returns empty, returns null

### Counting Unresolved Annotations

Also export a helper for counting resolutions (used by toolbar for the alert):

```typescript
/**
 * Attempt to resolve all annotations for the current page.
 * Returns { resolved: Element[], unresolved: number[] } where unresolved contains pin numbers.
 */
export function resolvePageAnnotations(
  annotations: import('./types').Annotation[]
): { resolved: Array<{ annotation: import('./types').Annotation; element: Element }>; unresolvedCount: number } {
  const resolved: Array<{ annotation: import('./types').Annotation; element: Element }> = [];
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
```

---

## Testing Your Implementation

To verify the CSS selector builder:
1. `buildCSSSelector(document.getElementById('main'))` should return `#main`
2. For a `<p>` that's the 3rd paragraph in an `<article>`, should return something like `article > p:nth-of-type(3)`
3. Full path from body should be built

To verify the XPath builder:
1. Should produce `/html/body/...` paths
2. Indexed siblings should have `[n]` suffixes

To verify `resolveElement`:
1. `resolveElement(captureFingerprint(someElement))` should return `someElement` (round-trip)

---

## How to Verify Your Work

1. Run `cd /root/.openclaw/workspace/annotator && npm run build`
2. Build must pass with zero TypeScript errors
3. No `any` types (use proper types from `./types`)

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2B: Implement fingerprint.ts — CSS selector, XPath generation, and resolution algorithm" && git push
```
