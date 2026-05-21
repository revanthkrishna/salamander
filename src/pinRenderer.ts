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
// Held in a MutationObserver-driven retry queue.
type Pending = { annotation: Annotation; onPinClick: (a: Annotation) => void };
const pendingResolutions = new Map<number, Pending>();
let retryObserver: MutationObserver | null = null;
let retryCutoffTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityObserver: MutationObserver | null = null;
let lastRenderTotal = 0;
let statsListener: ((stats: PinRenderStats) => void) | null = null;

// Tracks pin numbers that have been successfully placed at least once in this
// page session. Used to distinguish "contextually hidden" pins (temporarily
// absent from the DOM, e.g. a previous wizard step) from truly unresolvable
// ones. Reset on full clearPins() (page navigation).
const everResolvedPins = new Set<number>();

const RETRY_CUTOFF_MS = 5000;

let stylesInjected = false;

export interface PinRenderStats {
  resolved: number;
  unresolved: number;
  total: number;
}

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

function checkPinVisibility(): void {
  for (const [pinNumber, pinData] of activePins) {
    const { pinEl, targetElement, annotation, onPinClick } = pinData;

    if (!targetElement.isConnected) {
      // Target was detached from the DOM (e.g. React re-rendered the wizard
      // step). Remove the pin and re-queue so the retry observer can
      // re-resolve it to the fresh element when it re-appears.
      pinEl.remove();
      activePins.delete(pinNumber);
      if (!pendingResolutions.has(pinNumber)) {
        pendingResolutions.set(pinNumber, { annotation, onPinClick });
      }
      startRetry();
    } else if (isElementVisible(targetElement)) {
      pinEl.style.display = '';
    } else {
      // Element is in the DOM but CSS-hidden (e.g. parent has display:none).
      // Just hide the pin; it will un-hide when the parent becomes visible.
      pinEl.style.display = 'none';
    }
  }
}

function startVisibilityObserver(): void {
  if (visibilityObserver) return;
  const throttledCheck = throttle(checkPinVisibility, 100);
  visibilityObserver = new MutationObserver(() => {
    throttledCheck();
  });
  visibilityObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
    childList: true,
    subtree: true,
  });
}

function stopVisibilityObserver(): void {
  if (visibilityObserver) {
    visibilityObserver.disconnect();
    visibilityObserver = null;
  }
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
  // Skip if already rendered (defensive — caller filters too)
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
  everResolvedPins.add(annotation.pinNumber);
  document.body.appendChild(pinEl);
  updatePinPosition(annotation.pinNumber, pinData);
  return true;
}

function startRetry(): void {
  // Already running — nothing to do
  if (retryObserver) return;
  if (pendingResolutions.size === 0) return;

  retryObserver = new MutationObserver(() => {
    if (pendingResolutions.size === 0) {
      stopRetry();
      return;
    }
    for (const [pinNumber, { annotation, onPinClick }] of Array.from(pendingResolutions)) {
      if (activePins.has(pinNumber)) {
        pendingResolutions.delete(pinNumber);
        continue;
      }
      if (tryRenderOne(annotation, onPinClick)) {
        pendingResolutions.delete(pinNumber);
      }
    }

    emitStats();

    if (pendingResolutions.size === 0) stopRetry();
  });

  retryObserver.observe(document.body, { childList: true, subtree: true });

  retryCutoffTimer = setTimeout(() => {
    // Hard cutoff: stop retrying and finalize stats.
    stopRetry();
    emitStats();
  }, RETRY_CUTOFF_MS);
}

function stopRetry(): void {
  if (retryObserver) {
    retryObserver.disconnect();
    retryObserver = null;
  }
  if (retryCutoffTimer !== null) {
    clearTimeout(retryCutoffTimer);
    retryCutoffTimer = null;
  }
}

function emitStats(): void {
  if (!statsListener) return;
  // Exclude pins that are only temporarily absent (contextually hidden):
  // they resolved at least once this session so they are not truly broken.
  let contextuallyHidden = 0;
  for (const [pinNumber] of pendingResolutions) {
    if (everResolvedPins.has(pinNumber)) contextuallyHidden++;
  }
  const unresolved = pendingResolutions.size - contextuallyHidden;
  const resolved = Math.max(0, lastRenderTotal - pendingResolutions.size);
  statsListener({ resolved, unresolved, total: lastRenderTotal });
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
  startVisibilityObserver();
}

/**
 * Register a listener that is fired whenever resolution stats change (initial
 * render and each MutationObserver retry tick). Useful to keep a toolbar
 * "X couldn't be placed" alert in sync with async re-resolves.
 */
export function setStatsListener(cb: ((stats: PinRenderStats) => void) | null): void {
  statsListener = cb;
}

/**
 * Render all pins from scratch.
 *
 * Annotations that can't be resolved right now are queued and retried via a
 * MutationObserver until either they all resolve or a 5-second cutoff fires.
 * Returns the *initial* stats (synchronous). Use {@link setStatsListener} to
 * receive subsequent updates as retries land.
 */
export function renderPins(
  annotations: Annotation[],
  onPinClick: (annotation: Annotation) => void
): PinRenderStats {
  stopRetry();
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

  // Build the deduplicated list: winners from resolved + all unresolvable.
  const deduped: Annotation[] = [
    ...Array.from(elementToAnnotation.values()),
    ...unresolvable,
  ];

  lastRenderTotal = deduped.length;

  for (const annotation of deduped) {
    if (!tryRenderOne(annotation, onPinClick)) {
      pendingResolutions.set(annotation.pinNumber, { annotation, onPinClick });
    }
  }

  const initialStats: PinRenderStats = {
    resolved: deduped.length - pendingResolutions.size,
    unresolved: pendingResolutions.size,
    total: deduped.length,
  };

  if (pendingResolutions.size > 0) {
    startRetry();
  }

  // Ensure visibility observer is running for the newly rendered pins.
  startVisibilityObserver();

  // Always emit so listeners see the initial state too.
  emitStats();

  return initialStats;
}

/**
 * Remove pin DOM elements only — leaves the pending-retry queue intact.
 * Use {@link clearPins} for a full reset (including stopping retries).
 */
function clearPinElementsOnly(): void {
  for (const [, { pinEl }] of activePins) {
    pinEl.remove();
  }
  activePins.clear();
}

export function clearPins(): void {
  stopRetry();
  stopVisibilityObserver();
  pendingResolutions.clear();
  clearPinElementsOnly();
  lastRenderTotal = 0;
  everResolvedPins.clear();
}

/**
 * Show pins and enable interactivity (annotation mode active).
 *
 * Adds `body.annotator-active` which switches `.annotator-pin` from
 * `display:none` to `display:flex` (via the cascade) and enables
 * pointer-events. Pins remain in the DOM regardless of this state.
 */
export function showPins(): void {
  document.body.classList.add('annotator-active');
}

/**
 * Hide pins and disable interactivity (annotation mode off).
 *
 * Removes `body.annotator-active`; pins become `display:none` and stop
 * receiving pointer events. Pins stay in the DOM — call {@link clearPins}
 * to remove them entirely.
 */
export function hidePins(): void {
  document.body.classList.remove('annotator-active');
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
): PinRenderStats {
  return renderPins(annotations, onPinClick);
}
