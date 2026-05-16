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
  // Pins are ALWAYS visible (regardless of annotation mode). They are only
  // interactive (clickable) when body.annotator-active is set — controlled by
  // showPins/hidePins which toggle pointer-events, not display.
  style.textContent = `
.annotator-pin {
  position: absolute;
  min-width: 14px;
  height: 14px;
  padding: 0 2px;
  border-radius: 30px;
  background-color: #FEC800;
  border: 1px solid #000000;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483640;
  box-shadow: 0 1px 3px rgba(0,0,0,0.40);
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
  font-weight: 400;
  line-height: 1;
  text-align: center;
  pointer-events: none;
}

@keyframes annotator-pin-pop {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}

/* Clickable only when annotation mode is on */
body.annotator-active .annotator-pin {
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

export function clearPins(): void {
  for (const [, { pinEl }] of activePins) {
    pinEl.remove();
  }
  activePins.clear();
}

/**
 * Enable pin interactivity (annotation mode active).
 * Pins are always rendered; this just toggles pointer-events via body class.
 */
export function showPins(): void {
  document.body.classList.add('annotator-active');
}

/**
 * Disable pin interactivity (annotation mode off).
 * Pins remain visible — only pointer-events are removed.
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
