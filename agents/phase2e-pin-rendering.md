# Phase 2E — Pin Rendering Engineer

## Role & Persona

You are a frontend engineer who has built DOM overlay systems for annotation tools and browser extensions. You know the difference between `getBoundingClientRect` and `offsetTop`, you know when to use `position: absolute` vs `position: fixed`, and you know how to efficiently reposition hundreds of DOM elements on scroll without killing performance.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY), especially:
  - §3.3 (Annotation Display)
  - §2 Non-Functional Requirements
  - §6 Edge Cases #20 (fixed-position elements)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — **read §5 (Pin Rendering) IN FULL**

Also check the stub at:
- `/root/.openclaw/workspace/annotator/src/pinRenderer.ts`
- `/root/.openclaw/workspace/annotator/src/types.ts` (Annotation interface)

## What You Produce

Fully implement one file: `src/pinRenderer.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### Overview

The pin renderer manages the lifecycle of pin DOM elements on the current page:
1. **Inject styles** into the page (not Shadow DOM — pins must use page coordinates)
2. **Create/destroy pins** from annotation data
3. **Position pins** correctly for both normal and fixed-position target elements
4. **Reposition on scroll/resize** at ~60fps
5. **Show/hide** pins based on annotation mode state

### `src/pinRenderer.ts` — Full Implementation

```typescript
import type { Annotation } from './types';

// Map of pinNumber → { element: HTMLElement, targetElement: Element, offset: {x,y}, isFixed: bool }
const activePins = new Map<number, {
  pinEl: HTMLDivElement;
  targetElement: Element;
  offset: { x: number; y: number };
  isFixed: boolean;
}>();

let stylesInjected = false;
let annotationModeActive = false;
```

### Pin DOM Structure (per TECH_DESIGN.md §5.1)

Each pin is a `<div>` appended to `<body>`:

```html
<div class="annotator-pin" data-pin-id="1" style="position: absolute; left: 532px; top: 1204px; z-index: 2147483640;">
  <span>1</span>
</div>
```

Z-index: `2147483640` (per TECH_DESIGN.md §5.3)

### Style Injection (per TECH_DESIGN.md §5.2)

Inject styles into the page's `<head>` (NOT shadow DOM), using a `<style>` element with id `annotator-pin-styles`. Check if already injected before injecting.

```css
.annotator-pin {
  position: absolute;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: #E040FB;
  border: 2px solid white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483640;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  pointer-events: auto;
  box-sizing: border-box;
  user-select: none;
}

.annotator-pin span {
  color: white;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  font-weight: bold;
  line-height: 1;
  pointer-events: none;
}

/* Hidden when annotation mode is off */
body:not(.annotator-active) .annotator-pin {
  display: none !important;
  pointer-events: none !important;
}
```

### Position Calculation (per TECH_DESIGN.md §5.4)

**For normal (non-fixed) elements:**
```
pinLeft = element.getBoundingClientRect().left + window.scrollX + annotation.offset.x
pinTop  = element.getBoundingClientRect().top  + window.scrollY + annotation.offset.y
pin uses position: absolute
```

**For fixed-position elements (sticky headers, fixed navbars):**
```
pinLeft = element.getBoundingClientRect().left + annotation.offset.x
pinTop  = element.getBoundingClientRect().top  + annotation.offset.y
pin uses position: fixed
```

Fixed element detection (per TECH_DESIGN.md §5.4):
```typescript
function isFixedPosition(el: Element): boolean {
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (window.getComputedStyle(node).position === 'fixed') return true;
    node = node.parentElement;
  }
  return false;
}
```

### Throttle Helper

```typescript
function throttle<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let lastCall = 0;
  return function(...args: Parameters<T>) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  } as T;
}
```

### Scroll/Resize Handlers (per TECH_DESIGN.md §5.6)

```typescript
const repositionOnScroll = throttle(() => {
  for (const [pinId, pinData] of activePins) {
    if (pinData.isFixed) continue; // fixed pins don't move with scroll
    updatePinPosition(pinId, pinData);
  }
}, 16); // ~60fps

const repositionAll = throttle(() => {
  for (const [pinId, pinData] of activePins) {
    updatePinPosition(pinId, pinData); // resize can move fixed elements too
  }
}, 16);

window.addEventListener('scroll', repositionOnScroll, { passive: true });
window.addEventListener('resize', repositionAll, { passive: true });
```

### Public API

```typescript
/**
 * Initialize the pin renderer (inject styles, set up scroll/resize listeners).
 * Call once on content script init.
 */
export function initPinRenderer(): void

/**
 * Render pins for the given annotations.
 * Resolves each annotation to a DOM element and places a pin.
 * @param annotations - annotations for the CURRENT PAGE only
 * @param onPinClick - called when a pin is clicked, with the annotation
 */
export function renderPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void

/**
 * Remove all rendered pins from the DOM.
 */
export function clearPins(): void

/**
 * Show all pins (annotation mode activated).
 * Adds 'annotator-active' class to document.body.
 */
export function showPins(): void

/**
 * Hide all pins (annotation mode deactivated).
 * Removes 'annotator-active' class from document.body.
 */
export function hidePins(): void

/**
 * Add a single new pin (after user creates an annotation).
 * @param annotation - the newly created annotation
 * @param targetElement - the element that was clicked
 * @param onPinClick - click handler
 */
export function addPin(
  annotation: Annotation,
  targetElement: Element,
  onPinClick: (annotation: Annotation) => void
): void

/**
 * Remove a single pin by pin number.
 */
export function removePin(pinNumber: number): void

/**
 * Update a pin's display (e.g., if pin number changes — not needed for v1).
 * Exposed for completeness.
 */
export function updatePin(pinNumber: number, annotation: Annotation): void

/**
 * Get the annotation for a given pin element (used by click handler to open popover).
 */
export function getPinAnnotation(pinEl: Element): Annotation | null

/**
 * Refresh all pin positions (call after SPA navigation or storage update).
 * Clears old pins and re-renders from new annotation set.
 */
export function refreshPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void
```

### Pin Click Handling

When a pin is clicked, the click event should call `onPinClick(annotation)`. The pin element stores the pin number via `data-pin-id`. The click handler looks up the annotation in the `activePins` map.

**Important:** The annotation mode click interception (in `annotationMode.ts`) uses a capturing-phase listener that checks `isAnnotatorElement(e.target)`. Make sure pins have the class `annotator-pin` so they are recognized as annotator elements and not treated as page elements to annotate.

### Element Storage in `activePins`

After `renderPins` resolves each annotation to an element via `resolveElement` (from `fingerprint.ts`), store the reference in `activePins`:

```typescript
activePins.set(annotation.pinNumber, {
  pinEl,
  targetElement: element,
  offset: annotation.offset,
  isFixed: isFixedPosition(element),
});
```

This avoids calling `resolveElement` again on scroll (expensive).

### Pin for New Annotations

When `addPin` is called (after user creates an annotation in the popover), the `targetElement` is passed directly (no resolution needed — we already have the live reference from the click event).

---

## How to Verify Your Work

1. `cd /root/.openclaw/workspace/annotator && npm run build` — zero TypeScript errors
2. All exported functions match their signatures
3. `isFixedPosition` correctly walks ancestors
4. `throttle` function works correctly (doesn't call fn more than once per 16ms)
5. Scroll listener uses `{ passive: true }`

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2E: Implement pinRenderer.ts — pin creation, positioning, fixed elements, scroll/resize" && git push
```
