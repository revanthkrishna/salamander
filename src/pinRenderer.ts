import type { Annotation } from './types';
import { resolveElement } from './fingerprint';

// Map of pinNumber → pin data
const activePins = new Map<number, {
  pinEl: HTMLDivElement;
  targetElement: Element;
  annotation: Annotation;
  offset: { x: number; y: number };
  isFixed: boolean;
  onPinClick: (a: Annotation) => void;
}>();

// Annotations whose target elements weren't in the DOM at render time.
type Pending = { annotation: Annotation; onPinClick: (a: Annotation) => void };
const pendingResolutions = new Map<number, Pending>();

let stylesInjected = false;

// RAF retry loop — active only while annotation mode is on (showPins).
let rafId: number | null = null;
let lastRetryTime = 0;
const RETRY_INTERVAL_MS = 100;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function isElementVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  return true;
}

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
  // Pins are hidden outside annotation mode. showPins/hidePins toggle
  // body.annotator-active which controls both visibility and interactivity.
  style.textContent = `
.annotator-pin {
  position: absolute;
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border-radius: 12px;
  background-color: #FEC800;
  border: 1px solid #000000;
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 2147483640;
  box-shadow: 0 2px 6px rgba(0,0,0,0.40), 0 1px 2px rgba(0,0,0,0.20);
  box-sizing: border-box;
  user-select: none;
  pointer-events: none;
  cursor: default;
  animation: annotator-pin-pop 150ms ease-out;
}

.annotator-pin span {
  color: #000000;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  text-align: center;
  pointer-events: none;
  white-space: nowrap;
}

@keyframes annotator-pin-pop {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}

/* Visible and clickable only in annotation mode */
body.annotator-active .annotator-pin {
  display: flex;
  pointer-events: auto;
  cursor: pointer;
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
  if (!isElementVisible(targetElement)) return;
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
  _targetElement: Element,
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

/**
 * Try to render a single annotation. Returns true on success.
 */
function tryRenderOne(
  annotation: Annotation,
  onPinClick: (annotation: Annotation) => void
): boolean {
  if (activePins.has(annotation.pinNumber)) return true;

  const targetElement = resolveElement(annotation.fingerprint);
  if (!targetElement) return false;

  const fixed = isFixedPosition(targetElement);
  const pinEl = createPinElement(annotation, targetElement, onPinClick);
  const pinData = {
    pinEl,
    targetElement,
    annotation,
    offset: annotation.offset,
    isFixed: fixed,
    onPinClick,
  };
  activePins.set(annotation.pinNumber, pinData);
  document.body.appendChild(pinEl);
  updatePinPosition(annotation.pinNumber, pinData);
  return true;
}

// -------------------------------------------------------------------
// RAF retry loop — re-resolves pending pins and re-queues disconnected
// ones on every browser paint (throttled to RETRY_INTERVAL_MS).
// Runs only while annotation mode is active.
// -------------------------------------------------------------------

function retryPendingAndRequeue(): void {
  // Re-queue pins whose target element was detached (e.g. React wizard step transition).
  for (const [pinNumber, pinData] of Array.from(activePins)) {
    if (!pinData.targetElement.isConnected) {
      pinData.pinEl.remove();
      activePins.delete(pinNumber);
      if (!pendingResolutions.has(pinNumber)) {
        pendingResolutions.set(pinNumber, { annotation: pinData.annotation, onPinClick: pinData.onPinClick });
      }
    } else if (isElementVisible(pinData.targetElement)) {
      // Un-hide pins whose parent became visible again
      if (pinData.pinEl.style.display === 'none') pinData.pinEl.style.display = '';
    } else {
      // CSS-hidden parent: suppress pin without removing it from activePins
      pinData.pinEl.style.display = 'none';
    }
  }

  if (pendingResolutions.size === 0) return;

  for (const [pinNumber, { annotation, onPinClick }] of Array.from(pendingResolutions)) {
    if (activePins.has(pinNumber)) {
      pendingResolutions.delete(pinNumber);
      continue;
    }
    if (tryRenderOne(annotation, onPinClick)) {
      pendingResolutions.delete(pinNumber);
    }
  }
}

function rafRetryLoop(timestamp: number): void {
  if (timestamp - lastRetryTime >= RETRY_INTERVAL_MS) {
    lastRetryTime = timestamp;
    retryPendingAndRequeue();
  }
  rafId = requestAnimationFrame(rafRetryLoop);
}

function startRAFLoop(): void {
  if (rafId !== null) return;
  lastRetryTime = 0;
  rafId = requestAnimationFrame(rafRetryLoop);
}

function stopRAFLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// -------------------------------------------------------------------
// Scroll / Resize handlers (module-level, registered once in init)
// -------------------------------------------------------------------

const repositionOnScroll = throttle(() => {
  for (const [pinNumber, pinData] of activePins) {
    if (pinData.isFixed) continue;
    updatePinPosition(pinNumber, pinData);
  }
}, 16);

const repositionAll = throttle(() => {
  for (const [pinNumber, pinData] of activePins) {
    updatePinPosition(pinNumber, pinData);
  }
}, 16);

// -------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------

export function initPinRenderer(): void {
  injectStyles();
  window.addEventListener('scroll', repositionOnScroll, { passive: true });
  window.addEventListener('resize', repositionAll, { passive: true });
}

/**
 * Render all pins from scratch.
 *
 * Annotations that can't be resolved right now are queued and retried via the
 * RAF loop whenever annotation mode is active.
 */
export function renderPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void {
  stopRAFLoop();
  pendingResolutions.clear();
  clearPinElementsOnly();

  // De-duplicate: when multiple annotations resolve to the same DOM element,
  // keep only the one with the highest pin number (most recently annotated).
  const elementToAnnotation = new Map<Element, Annotation>();
  const unresolvable: Annotation[] = [];
  for (const annotation of annotations) {
    const el = resolveElement(annotation.fingerprint);
    if (!el) {
      unresolvable.push(annotation);
      continue;
    }
    const existing = elementToAnnotation.get(el);
    if (!existing || annotation.pinNumber > existing.pinNumber) {
      elementToAnnotation.set(el, annotation);
    }
  }

  const deduped: Annotation[] = [
    ...Array.from(elementToAnnotation.values()),
    ...unresolvable,
  ];

  for (const annotation of deduped) {
    if (!tryRenderOne(annotation, onPinClick)) {
      pendingResolutions.set(annotation.pinNumber, { annotation, onPinClick });
    }
  }

  // Restart loop if annotation mode is active (e.g. SPA navigation while annotating).
  if (document.body.classList.contains('annotator-active')) {
    startRAFLoop();
  }
}

/**
 * Remove pin DOM elements only — leaves the pending-retry queue intact.
 * Use {@link clearPins} for a full reset.
 */
function clearPinElementsOnly(): void {
  for (const [, { pinEl }] of activePins) {
    pinEl.remove();
  }
  activePins.clear();
}

export function clearPins(): void {
  stopRAFLoop();
  pendingResolutions.clear();
  clearPinElementsOnly();
}

/**
 * Show pins and enable interactivity (annotation mode active).
 * Starts the RAF retry loop so pending pins are resolved as the DOM changes.
 */
export function showPins(): void {
  document.body.classList.add('annotator-active');
  startRAFLoop();
}

/**
 * Hide pins and disable interactivity (annotation mode off).
 * Stops the RAF retry loop.
 */
export function hidePins(): void {
  document.body.classList.remove('annotator-active');
  stopRAFLoop();
}

export function addPin(
  annotation: Annotation,
  targetElement: Element,
  onPinClick: (annotation: Annotation) => void
): void {
  // Dedup guard
  removePin(annotation.pinNumber);

  const fixed = isFixedPosition(targetElement);
  const pinEl = createPinElement(annotation, targetElement, onPinClick);

  const pinData = {
    pinEl,
    targetElement,
    annotation,
    offset: annotation.offset,
    isFixed: fixed,
    onPinClick,
  };

  activePins.set(annotation.pinNumber, pinData);
  document.body.appendChild(pinEl);
  updatePinPosition(annotation.pinNumber, pinData);
}

export function removePin(pinNumber: number): void {
  const pinData = activePins.get(pinNumber);
  if (pinData) {
    pinData.pinEl.remove();
    activePins.delete(pinNumber);
  }
  // Also drop from the pending queue if it was waiting to render
  pendingResolutions.delete(pinNumber);
}

export function updatePin(pinNumber: number, annotation: Annotation): void {
  const pinData = activePins.get(pinNumber);
  if (!pinData) return;

  const span = pinData.pinEl.querySelector('span');
  if (span) {
    span.textContent = String(annotation.pinNumber);
  }
  pinData.pinEl.setAttribute('data-pin-id', String(annotation.pinNumber));

  pinData.annotation = annotation;
  pinData.offset = annotation.offset;

  updatePinPosition(pinNumber, pinData);
}

export function getPinAnnotation(pinEl: Element): Annotation | null {
  const pinIdStr = pinEl.getAttribute('data-pin-id');
  if (!pinIdStr) return null;
  const pinNumber = parseInt(pinIdStr, 10);
  if (isNaN(pinNumber)) return null;
  return activePins.get(pinNumber)?.annotation ?? null;
}

export function refreshPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): void {
  renderPins(annotations, onPinClick);
}
