import type { Annotation } from './types';
import { resolveElement } from './fingerprint';

// Map of pinNumber → pin data
const activePins = new Map<number, {
  pinEl: HTMLDivElement;
  targetElement: Element;
  annotation: Annotation;
  offset: { x: number; y: number };
  isFixed: boolean;
}>();

let stylesInjected = false;
let annotationModeActive = false;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function isFixedPosition(el: Element): boolean {
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (window.getComputedStyle(node).position === 'fixed') return true;
    node = node.parentElement;
  }
  return false;
}

function throttle<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let lastCall = 0;
  return function (...args: Parameters<T>) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn(...args);
    }
  } as T;
}

function injectStyles(): void {
  if (stylesInjected || document.getElementById('annotator-pin-styles')) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'annotator-pin-styles';
  style.textContent = `
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
`;
  document.head.appendChild(style);
  stylesInjected = true;
}

function updatePinPosition(
  pinNumber: number,
  pinData: { pinEl: HTMLDivElement; targetElement: Element; offset: { x: number; y: number }; isFixed: boolean }
): void {
  const { pinEl, targetElement, offset, isFixed } = pinData;
  const rect = targetElement.getBoundingClientRect();

  if (isFixed) {
    pinEl.style.position = 'fixed';
    pinEl.style.left = `${rect.left + offset.x}px`;
    pinEl.style.top = `${rect.top + offset.y}px`;
  } else {
    pinEl.style.position = 'absolute';
    pinEl.style.left = `${rect.left + window.scrollX + offset.x}px`;
    pinEl.style.top = `${rect.top + window.scrollY + offset.y}px`;
  }
}

function createPinElement(
  annotation: Annotation,
  targetElement: Element,
  onPinClick: (annotation: Annotation) => void
): HTMLDivElement {
  const pinEl = document.createElement('div');
  pinEl.className = 'annotator-pin';
  pinEl.setAttribute('data-pin-id', String(annotation.pinNumber));
  pinEl.style.zIndex = '2147483640';

  const span = document.createElement('span');
  span.textContent = String(annotation.pinNumber);
  pinEl.appendChild(span);

  pinEl.addEventListener('click', (e) => {
    e.stopPropagation();
    onPinClick(annotation);
  });

  return pinEl;
}

// -------------------------------------------------------------------
// Scroll / Resize handlers (module-level, registered once in init)
// -------------------------------------------------------------------

const repositionOnScroll = throttle(() => {
  for (const [pinNumber, pinData] of activePins) {
    if (pinData.isFixed) continue; // fixed pins don't move with scroll
    updatePinPosition(pinNumber, pinData);
  }
}, 16); // ~60fps

const repositionAll = throttle(() => {
  for (const [pinNumber, pinData] of activePins) {
    updatePinPosition(pinNumber, pinData); // resize can move fixed elements too
  }
}, 16);

// -------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------

/**
 * Initialize the pin renderer (inject styles, set up scroll/resize listeners).
 * Call once on content script init.
 */
export function initPinRenderer(): void {
  injectStyles();
  window.addEventListener('scroll', repositionOnScroll, { passive: true });
  window.addEventListener('resize', repositionAll, { passive: true });
}

/**
 * Render pins for the given annotations.
 * Resolves each annotation to a DOM element and places a pin.
 * @param annotations - annotations for the CURRENT PAGE only
 * @param onPinClick - called when a pin is clicked, with the annotation
 */
export function renderPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void {
  clearPins();

  for (const annotation of annotations) {
    const targetElement = resolveElement(annotation.fingerprint);
    if (!targetElement) continue;

    const fixed = isFixedPosition(targetElement);
    const pinEl = createPinElement(annotation, targetElement, onPinClick);

    const pinData = {
      pinEl,
      targetElement,
      annotation,
      offset: annotation.offset,
      isFixed: fixed,
    };

    activePins.set(annotation.pinNumber, pinData);
    document.body.appendChild(pinEl);
    updatePinPosition(annotation.pinNumber, pinData);
  }
}

/**
 * Remove all rendered pins from the DOM.
 */
export function clearPins(): void {
  for (const [, { pinEl }] of activePins) {
    pinEl.remove();
  }
  activePins.clear();
}

/**
 * Show all pins (annotation mode activated).
 * Adds 'annotator-active' class to document.body.
 */
export function showPins(): void {
  annotationModeActive = true;
  document.body.classList.add('annotator-active');
}

/**
 * Hide all pins (annotation mode deactivated).
 * Removes 'annotator-active' class from document.body.
 */
export function hidePins(): void {
  annotationModeActive = false;
  document.body.classList.remove('annotator-active');
}

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
): void {
  const fixed = isFixedPosition(targetElement);
  const pinEl = createPinElement(annotation, targetElement, onPinClick);

  const pinData = {
    pinEl,
    targetElement,
    annotation,
    offset: annotation.offset,
    isFixed: fixed,
  };

  activePins.set(annotation.pinNumber, pinData);
  document.body.appendChild(pinEl);
  updatePinPosition(annotation.pinNumber, pinData);
}

/**
 * Remove a single pin by pin number.
 */
export function removePin(pinNumber: number): void {
  const pinData = activePins.get(pinNumber);
  if (pinData) {
    pinData.pinEl.remove();
    activePins.delete(pinNumber);
  }
}

/**
 * Update a pin's display (e.g., if pin number changes — not needed for v1).
 * Exposed for completeness.
 */
export function updatePin(pinNumber: number, annotation: Annotation): void {
  const pinData = activePins.get(pinNumber);
  if (!pinData) return;

  // Update the span text if pin number changed
  const span = pinData.pinEl.querySelector('span');
  if (span) {
    span.textContent = String(annotation.pinNumber);
  }
  pinData.pinEl.setAttribute('data-pin-id', String(annotation.pinNumber));

  // Update stored annotation and offset
  pinData.annotation = annotation;
  pinData.offset = annotation.offset;

  updatePinPosition(pinNumber, pinData);
}

/**
 * Get the annotation for a given pin element (used by click handler to open popover).
 */
export function getPinAnnotation(pinEl: Element): Annotation | null {
  const pinIdStr = pinEl.getAttribute('data-pin-id');
  if (!pinIdStr) return null;
  const pinNumber = parseInt(pinIdStr, 10);
  if (isNaN(pinNumber)) return null;
  return activePins.get(pinNumber)?.annotation ?? null;
}

/**
 * Refresh all pin positions (call after SPA navigation or storage update).
 * Clears old pins and re-renders from new annotation set.
 */
export function refreshPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void {
  renderPins(annotations, onPinClick);
}
