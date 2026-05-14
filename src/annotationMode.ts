/**
 * annotationMode.ts — Phase 2F
 *
 * Handles:
 *  - Hover highlight (magenta outline on hovered elements in annotation mode)
 *  - Click interception (capture all page clicks in annotation mode)
 *  - Annotation popover (Shadow DOM component for create / edit / delete)
 *
 * Does NOT handle: storage, pin rendering, or toolbar state.
 */

import type { Annotation, Fingerprint } from './types';
import { captureFingerprint } from './fingerprint';

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface AnnotationModeCallbacks {
  /** Called when user saves a new annotation via the popover. */
  onNewAnnotation: (params: {
    targetElement: Element;
    fingerprint: Fingerprint;
    offset: { x: number; y: number };
    note: string;
  }) => void;

  /** Called when user saves an edit to an existing annotation. */
  onEditAnnotation: (pinNumber: number, note: string) => void;

  /** Called when user confirms deletion of an annotation. */
  onDeleteAnnotation: (pinNumber: number) => void;

  /**
   * Called when an existing pin is clicked — integration layer should
   * respond by calling openPopoverForAnnotation() with the full Annotation.
   */
  onExistingPinClick: (pinNumber: number) => void;
}

// ─── Module-level state ───────────────────────────────────────────────────────

let annotationModeActive = false;
let popoverOpen = false;
let highlightedEl: Element | null = null;
let callbacks: AnnotationModeCallbacks | null = null;

// Current popover context (only valid while popover is open)
type PopoverMode = 'create' | 'edit';
let currentMode: PopoverMode = 'create';
let currentPinNumber: number | null = null;
let currentTargetElement: Element | null = null;
let currentFingerprint: Fingerprint | null = null;
let currentOffset: { x: number; y: number } | null = null;

// ─── Popover Shadow DOM refs ──────────────────────────────────────────────────

let popoverHost: HTMLDivElement;
let popoverShadow: ShadowRoot; // stored — host.shadowRoot is null after closed attachShadow

// Popover DOM element refs (inside shadow)
let popoverEl: HTMLDivElement;
let noteInput: HTMLTextAreaElement;
let counter: HTMLSpanElement;
let addBtn: HTMLButtonElement;
let deleteBtn: HTMLButtonElement;
let closeBtn: HTMLButtonElement;
let footerEl: HTMLDivElement;
let deleteConfirmEl: HTMLDivElement;

// AbortController for event listener cleanup
let listenerAbortController: AbortController | null = null;

// ─── Highlight CSS (injected to page <head>, not Shadow DOM) ──────────────────

function injectHighlightCSS(): void {
  if (document.getElementById('annotator-highlight-css')) return;
  const style = document.createElement('style');
  style.id = 'annotator-highlight-css';
  style.textContent = `
    .annotator-highlighted {
      outline: 2px solid #E040FB !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
      box-sizing: border-box !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Popover CSS (inside shadow root) ────────────────────────────────────────

const POPOVER_CSS = `
  :host {
    --accent:               #E040FB;
    --error:                #F44336;
    --bg:                   rgba(36, 36, 38, 0.98);
    --text:                 #FFFFFF;
    --text-secondary:       rgba(255, 255, 255, 0.60);
    --btn-secondary:        rgba(255, 255, 255, 0.10);
    --btn-secondary-hover:  rgba(255, 255, 255, 0.18);
    --counter-normal:       rgba(255, 255, 255, 0.50);
    --counter-warning:      #F44336;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .popover {
    position: fixed;
    width: 280px;
    min-height: 160px;
    background: var(--bg);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.50), 0 2px 8px rgba(0,0,0,0.30);
    z-index: 2147483646;
    color: var(--text);
    padding: 12px;
    box-sizing: border-box;
  }

  .popover[hidden] {
    display: none;
  }

  .header {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    height: 28px;
    margin-bottom: 8px;
  }

  .close-btn {
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: 50%;
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .close-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: var(--text);
  }

  .note-input {
    width: 100%;
    height: 88px;
    resize: none;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text);
    font-family: inherit;
    box-sizing: border-box;
    margin-bottom: 8px;
  }
  .note-input::placeholder {
    color: rgba(255, 255, 255, 0.35);
  }
  .note-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 36px;
    gap: 8px;
  }

  .delete-btn {
    height: 30px;
    padding: 0 12px;
    background: transparent;
    color: var(--error);
    border: 1px solid rgba(244, 67, 54, 0.50);
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
  }
  .delete-btn:hover {
    background: rgba(244, 67, 54, 0.15);
  }
  .delete-btn[hidden] {
    display: none;
  }

  .counter {
    font-size: 11px;
    font-weight: 400;
    color: var(--counter-normal);
    white-space: nowrap;
    flex-shrink: 0;
    flex: 1;
    text-align: center;
  }
  .counter.warning {
    color: var(--counter-warning);
  }

  .add-btn {
    height: 30px;
    padding: 0 14px;
    background: var(--accent);
    color: var(--text);
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
  }
  .add-btn:hover:not(:disabled) {
    background: #CE35DC;
  }
  .add-btn:disabled {
    background: rgba(224, 64, 251, 0.30);
    color: rgba(255, 255, 255, 0.38);
    cursor: default;
    pointer-events: none;
  }

  .delete-confirm {
    padding: 8px 0;
  }
  .delete-confirm[hidden] {
    display: none;
  }

  .delete-confirm p {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    margin: 0 0 12px 0;
  }

  .confirm-btns {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .confirm-delete-btn {
    height: 30px;
    padding: 0 12px;
    background: var(--error);
    color: var(--text);
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .confirm-delete-btn:hover {
    background: #d32f2f;
  }

  .confirm-cancel-btn {
    height: 30px;
    padding: 0 12px;
    background: var(--btn-secondary);
    color: var(--text);
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .confirm-cancel-btn:hover {
    background: var(--btn-secondary-hover);
  }
`;

// ─── Build popover DOM ─────────────────────────────────────────────────────────

function buildPopoverDOM(): void {
  popoverHost = document.createElement('div');
  popoverHost.id = 'annotator-popover-host';
  popoverShadow = popoverHost.attachShadow({ mode: 'closed' }); // STORE THIS

  // CSS
  const styleEl = document.createElement('style');
  styleEl.textContent = POPOVER_CSS;
  popoverShadow.appendChild(styleEl);

  // Container
  popoverEl = document.createElement('div');
  popoverEl.className = 'popover';
  popoverEl.setAttribute('role', 'dialog');
  popoverEl.setAttribute('aria-label', 'Annotation note');
  popoverEl.hidden = true;

  // Header row
  const header = document.createElement('div');
  header.className = 'header';

  closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&#x2715;';
  header.appendChild(closeBtn);

  // Textarea
  noteInput = document.createElement('textarea');
  noteInput.className = 'note-input';
  noteInput.maxLength = 400;
  noteInput.placeholder = 'Add a note…';
  noteInput.spellcheck = true;

  // Footer row
  footerEl = document.createElement('div');
  footerEl.className = 'footer';

  deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.hidden = true;

  counter = document.createElement('span');
  counter.className = 'counter';
  counter.textContent = '0 / 400';

  addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = 'Add';
  addBtn.disabled = true;

  footerEl.appendChild(deleteBtn);
  footerEl.appendChild(counter);
  footerEl.appendChild(addBtn);

  // Delete confirmation panel
  deleteConfirmEl = document.createElement('div');
  deleteConfirmEl.className = 'delete-confirm';
  deleteConfirmEl.hidden = true;

  const confirmP = document.createElement('p');
  confirmP.textContent = 'Delete this annotation? This cannot be undone.';
  deleteConfirmEl.appendChild(confirmP);

  const confirmBtns = document.createElement('div');
  confirmBtns.className = 'confirm-btns';

  const confirmDeleteBtn = document.createElement('button');
  confirmDeleteBtn.className = 'confirm-delete-btn';
  confirmDeleteBtn.textContent = 'Confirm Delete';

  const confirmCancelBtn = document.createElement('button');
  confirmCancelBtn.className = 'confirm-cancel-btn';
  confirmCancelBtn.textContent = 'Cancel';

  confirmBtns.appendChild(confirmDeleteBtn);
  confirmBtns.appendChild(confirmCancelBtn);
  deleteConfirmEl.appendChild(confirmBtns);

  // Assemble
  popoverEl.appendChild(header);
  popoverEl.appendChild(noteInput);
  popoverEl.appendChild(footerEl);
  popoverEl.appendChild(deleteConfirmEl);
  popoverShadow.appendChild(popoverEl);

  document.body.appendChild(popoverHost);

  // ── Wire up internal events ──────────────────────────────────────────────

  closeBtn.addEventListener('click', () => closePopover());

  noteInput.addEventListener('input', () => {
    const len = noteInput.value.length;
    counter.textContent = `${len} / 400`;
    if (len >= 380) {
      counter.classList.add('warning');
    } else {
      counter.classList.remove('warning');
    }
    addBtn.disabled = noteInput.value.trim().length === 0;
  });

  addBtn.addEventListener('click', () => {
    const note = noteInput.value.trim();
    if (!note) return;

    if (currentMode === 'create') {
      if (currentTargetElement && currentFingerprint && currentOffset) {
        callbacks?.onNewAnnotation({
          targetElement: currentTargetElement,
          fingerprint: currentFingerprint,
          offset: currentOffset,
          note,
        });
      }
    } else {
      // edit mode
      if (currentPinNumber !== null) {
        callbacks?.onEditAnnotation(currentPinNumber, note);
      }
    }

    closePopover();
  });

  deleteBtn.addEventListener('click', () => {
    // Show inline delete confirmation
    noteInput.hidden = true;
    footerEl.hidden = true;
    deleteConfirmEl.hidden = false;
  });

  confirmDeleteBtn.addEventListener('click', () => {
    if (currentPinNumber !== null) {
      callbacks?.onDeleteAnnotation(currentPinNumber);
    }
    closePopover();
  });

  confirmCancelBtn.addEventListener('click', () => {
    // Restore EDIT state
    noteInput.hidden = false;
    footerEl.hidden = false;
    deleteConfirmEl.hidden = true;
  });
}

// ─── Popover positioning ───────────────────────────────────────────────────────

function positionPopover(pinScreenX: number, pinScreenY: number): void {
  const PIN_SIZE = 24;
  const MARGIN = 8;
  const pw = 280; // fixed width — matches CSS; do NOT use offsetWidth (0 before layout)
  const ph = popoverEl.offsetHeight || 160; // dynamic height; fallback for pre-layout
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY },                    // bottom-right
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY - ph + PIN_SIZE },    // top-right
    { left: pinScreenX - pw - MARGIN,       top: pinScreenY - ph + PIN_SIZE },    // top-left
    { left: pinScreenX - pw - MARGIN,       top: pinScreenY },                    // bottom-left
  ];

  const pos = candidates.find(c =>
    c.left >= 0 && c.top >= 0 &&
    c.left + pw <= vw && c.top + ph <= vh
  ) ?? candidates[0]; // fallback to bottom-right if all overflow

  Object.assign(popoverHost.style, {
    position: 'fixed',
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    zIndex: '2147483646',
  });
}

// ─── Internal open / close ────────────────────────────────────────────────────

function openPopoverCreate(
  targetElement: Element,
  offset: { x: number; y: number },
  fingerprint: Fingerprint,
  pinScreenX: number,
  pinScreenY: number
): void {
  currentMode = 'create';
  currentPinNumber = null;
  currentTargetElement = targetElement;
  currentOffset = offset;
  currentFingerprint = fingerprint;

  // Reset UI to CREATE state
  noteInput.value = '';
  noteInput.hidden = false;
  footerEl.hidden = false;
  deleteConfirmEl.hidden = true;
  deleteBtn.hidden = true; // hidden in CREATE mode
  counter.textContent = '0 / 400';
  counter.classList.remove('warning');
  addBtn.disabled = true;

  popoverEl.hidden = false;
  popoverOpen = true;

  positionPopover(pinScreenX, pinScreenY);
  requestAnimationFrame(() => noteInput.focus());
}

function closePopover(): void {
  popoverEl.hidden = true;
  popoverOpen = false;

  // Reset inline state
  noteInput.hidden = false;
  footerEl.hidden = false;
  deleteConfirmEl.hidden = true;

  currentPinNumber = null;
  currentTargetElement = null;
  currentFingerprint = null;
  currentOffset = null;
}

// ─── Click handler ────────────────────────────────────────────────────────────

function handleAnnotationClick(e: MouseEvent): void {
  const target = e.target as Element;

  // Check if clicking an existing pin
  const pinEl = target.closest('.annotator-pin');
  if (pinEl) {
    const pinId = parseInt(pinEl.getAttribute('data-pin-id') ?? '0');
    callbacks?.onExistingPinClick(pinId);
    return;
  }

  // New annotation — clear hover highlight from clicked element
  if (highlightedEl) {
    highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = null;
  }

  const rect = target.getBoundingClientRect();
  const offset = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
  const fingerprint = captureFingerprint(target);

  openPopoverCreate(target, offset, fingerprint, e.clientX, e.clientY);
}

// ─── isAnnotatorElement ───────────────────────────────────────────────────────

function isAnnotatorElement(el: Element): boolean {
  return (
    el.closest('#annotator-host') !== null ||
    el.closest('#annotator-popover-host') !== null ||
    el.closest('.annotator-pin') !== null
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the annotation mode module. Call once on content script init.
 * Registers all event listeners (they short-circuit via booleans when inactive).
 */
export function initAnnotationMode(cbs: AnnotationModeCallbacks): void {
  callbacks = cbs;

  injectHighlightCSS();
  buildPopoverDOM();

  listenerAbortController = new AbortController();
  const { signal } = listenerAbortController;

  // ── Click-outside detection — MUST be registered BEFORE annotation mode listener ──
  // Uses composedPath() to correctly detect clicks inside Shadow DOM.
  document.addEventListener('click', (e) => {
    if (!popoverOpen) return;
    if ((e.composedPath() as EventTarget[]).includes(popoverHost)) return;
    closePopover();
    // Do NOT stopPropagation — let the annotation mode handler also run if active
  }, { capture: true, signal });

  // ── Annotation mode click interceptor ────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!annotationModeActive) return;
    if (isAnnotatorElement(e.target as Element)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handleAnnotationClick(e as MouseEvent);
  }, { capture: true, signal });

  // ── Hover highlight — mouseover ───────────────────────────────────────────
  document.addEventListener('mouseover', (e) => {
    if (!annotationModeActive || popoverOpen) return;
    if (isAnnotatorElement(e.target as Element)) return;
    if (highlightedEl) highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = e.target as Element;
    highlightedEl.classList.add('annotator-highlighted');
  }, { capture: true, signal });

  // ── Hover highlight — mouseout ────────────────────────────────────────────
  document.addEventListener('mouseout', (e) => {
    if (!annotationModeActive) return;
    if (e.target === highlightedEl) {
      highlightedEl.classList.remove('annotator-highlighted');
      highlightedEl = null;
    }
  }, { capture: true, signal });
}

/**
 * Enable annotation mode: activate hover highlight and click capture.
 */
export function enableAnnotationMode(): void {
  annotationModeActive = true;
  document.body.classList.add('annotator-active');
}

/**
 * Disable annotation mode: remove hover highlight, close popover if open.
 */
export function disableAnnotationMode(): void {
  annotationModeActive = false;
  document.body.classList.remove('annotator-active');

  if (highlightedEl) {
    highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = null;
  }

  if (popoverOpen) {
    closePopover();
  }
}

/**
 * Check if annotation mode is currently active.
 */
export function isAnnotationModeActive(): boolean {
  return annotationModeActive;
}

/**
 * Open the popover pre-filled with an existing annotation.
 * Called by the integration layer after onExistingPinClick fires.
 */
export function openPopoverForAnnotation(
  annotation: Annotation,
  pinScreenX: number,
  pinScreenY: number
): void {
  currentMode = 'edit';
  currentPinNumber = annotation.pinNumber;
  currentTargetElement = null;
  currentFingerprint = annotation.fingerprint;
  currentOffset = annotation.offset;

  // Populate UI for EDIT state
  noteInput.value = annotation.note;
  noteInput.hidden = false;
  footerEl.hidden = false;
  deleteConfirmEl.hidden = true;
  deleteBtn.hidden = false; // shown in EDIT mode

  const len = annotation.note.length;
  counter.textContent = `${len} / 400`;
  if (len >= 380) {
    counter.classList.add('warning');
  } else {
    counter.classList.remove('warning');
  }
  addBtn.disabled = annotation.note.trim().length === 0;

  popoverEl.hidden = false;
  popoverOpen = true;

  positionPopover(pinScreenX, pinScreenY);

  // Focus and place cursor at end
  requestAnimationFrame(() => {
    noteInput.focus();
    noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);
  });
}

/**
 * Close the popover if open.
 * Called as the FIRST step in handleUrlChange (SPA navigation).
 */
export function closePopoverIfOpen(): void {
  if (popoverOpen) {
    closePopover();
  }
}

/**
 * Clean up all event listeners and DOM elements.
 * Called on beforeunload.
 */
export function destroyAnnotationMode(): void {
  disableAnnotationMode();

  // Abort all registered listeners
  listenerAbortController?.abort();
  listenerAbortController = null;

  // Remove popover host from DOM
  if (popoverHost?.parentNode) {
    popoverHost.parentNode.removeChild(popoverHost);
  }

  // Remove highlight CSS from page head
  document.getElementById('annotator-highlight-css')?.remove();

  callbacks = null;
}
