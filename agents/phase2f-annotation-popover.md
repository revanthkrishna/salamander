# Phase 2F — Annotation Popover Engineer

## Role & Persona

You are a frontend engineer who has built rich in-page comment components before. You know Shadow DOM, you know how to handle click-outside detection through shadow boundaries, and you've dealt with the quirks of positioning floating elements within viewports. You implement the annotation mode overlay and the popover component.

## Before You Start

Read these files fully:
- `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY), especially:
  - §3.1 (Annotation Mode)
  - §3.2 (Annotation Popover)
- `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — **read these sections IN FULL:**
  - §6.5 (Toolbar State Machine — for context)
  - §6.6 (Annotation Mode — Hover & Click Implementation)
  - §6.7 (Popover Implementation)
- `/root/.openclaw/workspace/annotator/UX_DESIGN.md` — your visual specification for the popover (if this file exists; if not, use REQUIREMENTS.md §3.2 and TECH_DESIGN.md §6.7)

Also check:
- `/root/.openclaw/workspace/annotator/src/annotationMode.ts` (stub)
- `/root/.openclaw/workspace/annotator/src/types.ts` (Annotation, Fingerprint interfaces)

## What You Produce

Fully implement one file: `src/annotationMode.ts`

Do NOT modify any other files.

---

## Implementation Requirements

### What This Module Does

The annotation mode module handles:
1. **Hover highlight** — when annotation mode is on, hovering over page elements shows a magenta outline
2. **Click interception** — when annotation mode is on, all page clicks are captured and either open a popover for new annotations or re-open it for existing pins
3. **Popover** — the comment entry/edit component, implemented as a Shadow DOM component

This module does NOT handle storage, pin rendering, or toolbar state. It focuses purely on user interaction.

### Module Structure

```typescript
// src/annotationMode.ts
import type { Annotation, Fingerprint } from './types';
import { captureFingerprint } from './fingerprint';

// State
let annotationModeActive = false;
let popoverOpen = false;
let highlightedEl: Element | null = null;

// Popover shadow DOM
let popoverHost: HTMLDivElement;
let popoverShadow: ShadowRoot;
// (store shadow root reference — host.shadowRoot is null after closed attachShadow)
```

### Hover Highlight

Per TECH_DESIGN.md §6.6, inject the highlight CSS into the page's `<head>` (not Shadow DOM — it needs to apply to page elements):

```css
.annotator-highlighted {
  outline: 2px solid #E040FB !important;
  outline-offset: 2px !important;
  cursor: crosshair !important;
  box-sizing: border-box !important;
}
```

Use `mouseover`/`mouseout` events (not `mouseenter`/`mouseleave`):

```typescript
document.addEventListener('mouseover', (e) => {
  if (!annotationModeActive || popoverOpen) return;
  if (isAnnotatorElement(e.target as Element)) return;
  if (highlightedEl) highlightedEl.classList.remove('annotator-highlighted');
  highlightedEl = e.target as Element;
  highlightedEl.classList.add('annotator-highlighted');
}, true); // capturing phase

document.addEventListener('mouseout', (e) => {
  if (!annotationModeActive) return;
  if (e.target === highlightedEl) {
    highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = null;
  }
}, true);
```

### Click Interception

Per TECH_DESIGN.md §6.6, use a capturing-phase listener:

```typescript
document.addEventListener('click', (e) => {
  if (!annotationModeActive) return;
  if (isAnnotatorElement(e.target as Element)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  handleAnnotationClick(e as MouseEvent);
}, true);
```

`isAnnotatorElement`:
```typescript
function isAnnotatorElement(el: Element): boolean {
  return (
    el.closest('#annotator-host') !== null ||
    el.closest('#annotator-popover-host') !== null ||
    el.closest('.annotator-pin') !== null
  );
}
```

### Click Handler

```typescript
function handleAnnotationClick(e: MouseEvent): void {
  const target = e.target as Element;
  
  // Check if clicking an existing pin
  const pinEl = target.closest('.annotator-pin');
  if (pinEl) {
    const pinId = parseInt(pinEl.getAttribute('data-pin-id') ?? '0');
    // Signal to open popover for existing annotation
    // Use the onExistingPinClick callback
    onExistingPinClickCallback?.(pinId);
    return;
  }
  
  // New annotation click
  const rect = target.getBoundingClientRect();
  const offset = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
  const fingerprint = captureFingerprint(target);
  
  // Remove highlight from clicked element
  target.classList.remove('annotator-highlighted');
  highlightedEl = null;
  
  // Open popover for new annotation
  openPopover({
    mode: 'create',
    targetElement: target,
    offset,
    fingerprint,
    pinScreenX: e.clientX,
    pinScreenY: e.clientY,
  });
}
```

### Popover Component (per TECH_DESIGN.md §6.7)

Create a separate Shadow DOM host appended to `<body>`:

```typescript
popoverHost = document.createElement('div');
popoverHost.id = 'annotator-popover-host';
popoverShadow = popoverHost.attachShadow({ mode: 'closed' }); // STORE THIS
document.body.appendChild(popoverHost);
```

Popover HTML (inside shadow root):

```html
<div class="popover" hidden>
  <div class="header">
    <button class="close-btn" aria-label="Close">&#x2715;</button>
  </div>
  <textarea 
    class="note-input" 
    maxlength="400" 
    placeholder="Add a note..."></textarea>
  <div class="footer">
    <button class="delete-btn" hidden>Delete</button>
    <span class="counter">0 / 400</span>
    <button class="add-btn" disabled>Add</button>
  </div>
  <!-- Delete confirmation (shown on delete click) -->
  <div class="delete-confirm" hidden>
    <p>Delete this annotation? This cannot be undone.</p>
    <div class="confirm-btns">
      <button class="confirm-cancel-btn">Cancel</button>
      <button class="confirm-delete-btn">Confirm Delete</button>
    </div>
  </div>
</div>
```

#### Popover CSS

Inject inside shadow root. Key properties:
- `position: fixed` (so it doesn't scroll)
- `z-index: 2147483646` (per TECH_DESIGN.md §5.3)
- Width: 280px (constant — per TECH_DESIGN.md §6.7 and Principal Engineer critique)
- Dark background, rounded corners, shadow
- Textarea: resizable or fixed, full width
- Footer: flexbox with space-between
- Delete button: appears only in edit mode
- Character counter: center of footer

#### Character Counter

```typescript
noteInput.addEventListener('input', () => {
  const len = noteInput.value.length;
  counter.textContent = `${len} / 400`;
  addBtn.disabled = noteInput.value.trim().length === 0;
});
```

#### Popover Positioning (per TECH_DESIGN.md §6.7)

```typescript
function positionPopover(pinScreenX: number, pinScreenY: number): void {
  const PIN_SIZE = 24;
  const MARGIN = 8;
  const pw = 280; // fixed width — matches CSS
  const ph = popoverEl.offsetHeight || 160; // dynamic height, fallback for pre-layout
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY },                     // bottom-right
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY - ph + PIN_SIZE },      // top-right
    { left: pinScreenX - pw - MARGIN, top: pinScreenY - ph + PIN_SIZE },            // top-left
    { left: pinScreenX - pw - MARGIN, top: pinScreenY },                            // bottom-left
  ];

  const pos = candidates.find(c =>
    c.left >= 0 && c.top >= 0 &&
    c.left + pw <= vw && c.top + ph <= vh
  ) ?? candidates[0];

  Object.assign(popoverHost.style, {
    position: 'fixed',
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    zIndex: '2147483646',
  });
}
```

#### Click-Outside Detection (per TECH_DESIGN.md §6.7)

```typescript
document.addEventListener('click', (e) => {
  if (!popoverOpen) return;
  if ((e.composedPath() as EventTarget[]).includes(popoverHost)) return;
  closePopover(false); // discard changes
}, true); // must also use capturing phase
```

**Register this listener BEFORE the annotation mode click listener** to ensure it fires first.

#### Delete Confirmation (Inline)

First Delete click:
1. Hide normal popover content (footer)
2. Show delete confirmation div
3. Confirm button: call `onDeleteAnnotation(currentPinNumber)`, close popover
4. Cancel button: hide delete confirmation, restore normal view

#### Focus Management

```typescript
function openPopover(...): void {
  // ... set up content ...
  popoverEl.hidden = false;
  popoverOpen = true;
  requestAnimationFrame(() => noteInput.focus());
}
```

### Public API

```typescript
export interface AnnotationModeCallbacks {
  // Called when user creates a new annotation
  onNewAnnotation: (params: {
    targetElement: Element;
    fingerprint: Fingerprint;
    offset: { x: number; y: number };
    note: string;
  }) => void;
  
  // Called when user saves an edit to an existing annotation
  onEditAnnotation: (pinNumber: number, note: string) => void;
  
  // Called when user confirms delete
  onDeleteAnnotation: (pinNumber: number) => void;
  
  // Called when an existing pin is clicked — popover requests annotation data
  // The integration layer should call openPopoverForAnnotation with the annotation
  onExistingPinClick: (pinNumber: number) => void;
}

/**
 * Initialize the annotation mode module. Call once on content script init.
 */
export function initAnnotationMode(callbacks: AnnotationModeCallbacks): void

/**
 * Enable annotation mode: activate hover highlight, click capture.
 */
export function enableAnnotationMode(): void

/**
 * Disable annotation mode: remove hover highlight, close popover if open.
 */
export function disableAnnotationMode(): void

/**
 * Check if annotation mode is currently active.
 */
export function isAnnotationModeActive(): boolean

/**
 * Open the popover pre-filled with an existing annotation (called after pin click).
 */
export function openPopoverForAnnotation(annotation: Annotation, pinScreenX: number, pinScreenY: number): void

/**
 * Close the popover (if open). Called on SPA navigation (FIRST step in handleUrlChange).
 */
export function closePopoverIfOpen(): void

/**
 * Clean up all event listeners and DOM elements. Call on beforeunload.
 */
export function destroyAnnotationMode(): void
```

---

## Critical Notes

1. **All event listeners are registered once** (at init), not on each enable/disable — they short-circuit via the `annotationModeActive` boolean
2. **The idempotency guard** in `content.ts` (`window.__annotatorActive`) prevents double-initialization — but be defensive anyway
3. **Popover host MUST NOT be inside the toolbar host** — separate shadow roots to avoid stacking context issues
4. **`e.composedPath()`** is the only correct way to check if a click is inside a Shadow DOM from outside
5. **Delete confirmation** uses inline state change, NOT a browser `confirm()` dialog

---

## How to Verify Your Work

1. `cd /root/.openclaw/workspace/annotator && npm run build` — zero TypeScript errors
2. All exported functions match their signatures
3. Popover uses `position: fixed` with z-index 2147483646
4. Click-outside detection uses `e.composedPath()`
5. Click interception uses capturing phase (third argument `true`)

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 2F: Implement annotationMode.ts — hover highlight, click capture, popover component" && git push
```
