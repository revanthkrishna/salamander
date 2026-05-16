/**
 * annotationMode.ts — UI redesign
 *
 * Handles:
 *  - Hover highlight (#FEC800 outline) on hovered elements in annotation mode
 *  - Click interception (capture page clicks in annotation mode)
 *  - Annotation popover (Shadow DOM) — create / edit / delete
 *
 * Popover layout (Figma):
 *   ┌────────────────────────────┐
 *   │ textarea area  (bg #3E3E3E)│   radius 16 16 0 0
 *   ├────────────────────────────┤
 *   │ footer bar  (bg #000)      │   radius 0 0 16 16 (left/right buttons)
 *   └────────────────────────────┘
 *
 * Footer states:
 *   CREATE: [cancel]  ……spacer……  [save]
 *   EDIT:   [cancel] [delete]  ……spacer……  [save]
 */

import type { Annotation, Fingerprint } from './types';
import { captureFingerprint } from './fingerprint';

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface AnnotationModeCallbacks {
  onNewAnnotation: (params: {
    targetElement: Element;
    fingerprint: Fingerprint;
    offset: { x: number; y: number };
    note: string;
  }) => void;

  onEditAnnotation: (pinNumber: number, note: string) => void;

  onDeleteAnnotation: (pinNumber: number) => void;

  /**
   * Called when an existing pin is clicked — integration layer should
   * respond by calling openPopoverForAnnotation() with the full Annotation.
   */
  onExistingPinClick: (pinNumber: number) => void;

  /**
   * Called when the user cancels CREATE mode (either via the cancel button
   * or by clicking outside the popover). The newly-placed pin should be
   * removed by the caller because the annotation was never saved.
   */
  onCancelCreate?: () => void;
}

// ─── Inline icon SVGs (use currentColor so CSS hover recolors them) ───────────

const ICON_CROSS_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><polygon points="18.707 6.707 17.293 5.293 12 10.586 6.707 5.293 5.293 6.707 10.586 12 5.293 17.293 6.707 18.707 12 13.414 17.293 18.707 18.707 17.293 13.414 12 18.707 6.707"/></svg>`;
const ICON_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 507.506 507.506" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M163.865,436.934c-14.406,0.006-28.222-5.72-38.4-15.915L9.369,304.966c-12.492-12.496-12.492-32.752,0-45.248c12.496-12.492,32.752-12.492,45.248,0l109.248,109.248L452.889,79.942c12.496-12.492,32.752-12.492,45.248,0c12.492,12.496,12.492,32.752,0,45.248L202.265,421.019C192.087,431.214,178.271,436.94,163.865,436.934z"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true"><path d="M21,4H17.9A5.009,5.009,0,0,0,13,0H11A5.009,5.009,0,0,0,6.1,4H3A1,1,0,0,0,3,6H4V19a5.006,5.006,0,0,0,5,5h6a5.006,5.006,0,0,0,5-5V6h1a1,1,0,0,0,0-2ZM11,2h2a3.006,3.006,0,0,1,2.829,2H8.171A3.006,3.006,0,0,1,11,2Zm7,17a3,3,0,0,1-3,3H9a3,3,0,0,1-3-3V6H18Z"/><path d="M10,18a1,1,0,0,0,1-1V11a1,1,0,0,0-2,0v6A1,1,0,0,0,10,18Z"/><path d="M14,18a1,1,0,0,0,1-1V11a1,1,0,0,0-2,0v6A1,1,0,0,0,14,18Z"/></svg>`;

// ─── Module-level state ───────────────────────────────────────────────────────

let annotationModeActive = false;
let popoverOpen = false;
let highlightedEl: Element | null = null;
let callbacks: AnnotationModeCallbacks | null = null;

type PopoverMode = 'create' | 'edit';
let currentMode: PopoverMode = 'create';
let currentPinNumber: number | null = null;
let currentTargetElement: Element | null = null;
let currentFingerprint: Fingerprint | null = null;
let currentOffset: { x: number; y: number } | null = null;

// ─── Popover Shadow DOM refs ──────────────────────────────────────────────────

let popoverHost: HTMLDivElement;
let popoverShadow: ShadowRoot;

let popoverEl: HTMLDivElement;
let noteInput: HTMLTextAreaElement;
let footerEl: HTMLDivElement;
let cancelBtn: HTMLButtonElement;
let deleteBtn: HTMLButtonElement;
let saveBtn: HTMLButtonElement;

let listenerAbortController: AbortController | null = null;

// ─── Hover highlight CSS (injected to <head>) ─────────────────────────────────

function injectHighlightCSS(): void {
  if (document.getElementById('annotator-highlight-css')) return;
  const style = document.createElement('style');
  style.id = 'annotator-highlight-css';
  style.textContent = `
    body.annotator-active .annotator-highlighted {
      outline: 2px solid #FEC800 !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
      box-sizing: border-box !important;
    }
    body.annotator-active *:not(.annotator-pin) {
      cursor: crosshair;
    }
  `;
  document.head.appendChild(style);
}

// ─── Popover CSS (inside shadow root) ─────────────────────────────────────────

const POPOVER_CSS = `
  :host {
    --accent: #FEC800;
    --bg-textarea: #3E3E3E;
    --bg-footer: #000000;
    --text: #FFFFFF;
    --placeholder: #D1D1D1;
    --shadow: drop-shadow(0px 0px 8px rgba(0,0,0,0.25));
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  *, *::before, *::after { box-sizing: border-box; }

  .popover {
    position: fixed;
    width: 300px;
    z-index: 2147483646;
    color: var(--text);
    filter: var(--shadow);
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    overflow: hidden;
  }
  .popover[hidden] { display: none !important; }

  /* Textarea area */
  .ta-wrap {
    background: var(--bg-textarea);
    padding: 8px 16px;
    border-radius: 16px 16px 0 0;
    display: flex;
  }
  .note-input {
    width: 100%;
    min-height: 63px;     /* (79 area - 16 vertical padding = 63 textarea) */
    max-height: 144px;    /* approx 160 area max - 16 vert pad */
    resize: none;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: inherit;
    font-size: 18px;
    line-height: 21px;
    padding: 0;
    margin: 0;
    overflow-y: auto;
  }
  .note-input::placeholder { color: var(--placeholder); }

  /* Footer bar */
  .footer {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    width: 300px;
    height: 40px;
    background: var(--bg-footer);
  }

  .footer-btn {
    background: var(--bg-footer);
    border: none;
    color: var(--text);
    padding: 0;
    margin: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease;
  }
  .footer-btn:hover:not(:disabled) { color: var(--accent); }
  .footer-btn:active:not(:disabled) .icon { transform: scale(0.88); }
  .footer-btn:active:not(:disabled) .label { transform: scale(0.88); }
  .footer-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .footer-btn:disabled { opacity: 0.38; cursor: default; }

  .footer-btn .icon {
    width: 20px;
    height: 20px;
    display: inline-flex;
    transition: transform 80ms ease;
  }
  .footer-btn .icon svg { width: 100%; height: 100%; display: block; }
  .footer-btn .label {
    font-size: 20px;
    line-height: 1;
    color: inherit;
    transition: transform 80ms ease;
  }

  /* Cancel — bottom-left corner */
  .btn-cancel {
    width: 52px;
    height: 40px;
    border-radius: 0 0 0 16px;
  }
  /* Delete — middle (edit mode only), no radius */
  .btn-delete {
    width: 52px;
    height: 40px;
    border-radius: 0;
  }
  .btn-delete[hidden] { display: none !important; }

  /* Spacer fills remaining horizontal space */
  .spacer { flex: 1 1 auto; background: var(--bg-footer); }

  /* Save — bottom-right corner with icon+label */
  .btn-save {
    width: 103px;
    height: 40px;
    border-radius: 0 0 16px 0;
    gap: 8px;
    flex-direction: row;
  }
`;

// ─── Build popover DOM ─────────────────────────────────────────────────────────

function buildPopoverDOM(): void {
  popoverHost = document.createElement('div');
  popoverHost.id = 'annotator-popover-host';
  popoverShadow = popoverHost.attachShadow({ mode: 'closed' });

  const styleEl = document.createElement('style');
  styleEl.textContent = POPOVER_CSS;
  popoverShadow.appendChild(styleEl);

  popoverEl = document.createElement('div');
  popoverEl.className = 'popover';
  popoverEl.setAttribute('role', 'dialog');
  popoverEl.setAttribute('aria-label', 'Annotation note');
  popoverEl.hidden = true;

  // Textarea area
  const taWrap = document.createElement('div');
  taWrap.className = 'ta-wrap';
  noteInput = document.createElement('textarea');
  noteInput.className = 'note-input';
  noteInput.maxLength = 400;
  noteInput.placeholder = 'type something...';
  noteInput.spellcheck = true;
  noteInput.rows = 3;
  taWrap.appendChild(noteInput);

  // Footer
  footerEl = document.createElement('div');
  footerEl.className = 'footer';

  cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'footer-btn btn-cancel';
  cancelBtn.setAttribute('aria-label', 'Cancel');
  {
    const ic = document.createElement('span');
    ic.className = 'icon';
    ic.innerHTML = ICON_CROSS_SMALL;
    cancelBtn.appendChild(ic);
  }

  deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'footer-btn btn-delete';
  deleteBtn.setAttribute('aria-label', 'Delete annotation');
  deleteBtn.hidden = true;
  {
    const ic = document.createElement('span');
    ic.className = 'icon';
    ic.innerHTML = ICON_TRASH;
    deleteBtn.appendChild(ic);
  }

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'footer-btn btn-save';
  saveBtn.setAttribute('aria-label', 'Save annotation');
  {
    const ic = document.createElement('span');
    ic.className = 'icon';
    ic.innerHTML = ICON_CHECK;
    const lbl = document.createElement('span');
    lbl.className = 'label';
    lbl.textContent = 'save';
    saveBtn.appendChild(ic);
    saveBtn.appendChild(lbl);
  }
  saveBtn.disabled = true;

  footerEl.appendChild(cancelBtn);
  footerEl.appendChild(deleteBtn);
  footerEl.appendChild(spacer);
  footerEl.appendChild(saveBtn);

  popoverEl.appendChild(taWrap);
  popoverEl.appendChild(footerEl);
  popoverShadow.appendChild(popoverEl);

  document.body.appendChild(popoverHost);

  // ── Wire internal events ──
  cancelBtn.addEventListener('click', () => handleCancel());

  noteInput.addEventListener('input', () => {
    if (currentMode === 'create') {
      saveBtn.disabled = noteInput.value.trim().length === 0;
    } else {
      saveBtn.disabled = false;
    }
  });

  noteInput.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter saves
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!saveBtn.disabled) saveBtn.click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  });

  saveBtn.addEventListener('click', () => {
    const note = noteInput.value.trim();
    if (currentMode === 'create') {
      if (!note) return;
      if (currentTargetElement && currentFingerprint && currentOffset) {
        callbacks?.onNewAnnotation({
          targetElement: currentTargetElement,
          fingerprint: currentFingerprint,
          offset: currentOffset,
          note,
        });
      }
    } else {
      if (currentPinNumber !== null) {
        callbacks?.onEditAnnotation(currentPinNumber, note);
      }
    }
    // Mark closure as "saved" so closePopover skips the cancel callback
    closePopover({ wasSaved: true });
  });

  deleteBtn.addEventListener('click', () => {
    // Immediate delete — no inline confirmation per spec
    if (currentPinNumber !== null) {
      callbacks?.onDeleteAnnotation(currentPinNumber);
    }
    closePopover({ wasSaved: true });
  });
}

// ─── Popover positioning ──────────────────────────────────────────────────────

function positionPopover(pinScreenX: number, pinScreenY: number): void {
  const PIN_SIZE = 24;
  const MARGIN = 8;
  const pw = 300;
  const ph = popoverEl.offsetHeight || 119; // ~79 textarea + 40 footer
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY },
    { left: pinScreenX + PIN_SIZE + MARGIN, top: pinScreenY - ph + PIN_SIZE },
    { left: pinScreenX - pw - MARGIN,       top: pinScreenY - ph + PIN_SIZE },
    { left: pinScreenX - pw - MARGIN,       top: pinScreenY },
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

  noteInput.value = '';
  deleteBtn.hidden = true;
  saveBtn.disabled = true;

  popoverEl.hidden = false;
  popoverOpen = true;

  positionPopover(pinScreenX, pinScreenY);
  requestAnimationFrame(() => noteInput.focus());
}

interface CloseOpts { wasSaved?: boolean }

function closePopover(opts: CloseOpts = {}): void {
  if (!popoverOpen) return;
  const wasCreateUnsaved = currentMode === 'create' && !opts.wasSaved;

  popoverEl.hidden = true;
  popoverOpen = false;

  // Reset state
  currentPinNumber = null;
  currentTargetElement = null;
  currentFingerprint = null;
  currentOffset = null;

  // Notify caller so it can remove the orphan pin (CREATE cancel only)
  if (wasCreateUnsaved) {
    callbacks?.onCancelCreate?.();
  }
}

function handleCancel(): void {
  closePopover();
}

// ─── Click handler ────────────────────────────────────────────────────────────

function handleAnnotationClick(e: MouseEvent): void {
  const target = e.target as Element;

  const pinEl = target.closest('.annotator-pin');
  if (pinEl) {
    const pinId = parseInt(pinEl.getAttribute('data-pin-id') ?? '0');
    callbacks?.onExistingPinClick(pinId);
    return;
  }

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

function isAnnotatorElement(el: Element): boolean {
  return (
    el.closest('#annotator-host') !== null ||
    el.closest('#annotator-popover-host') !== null ||
    el.closest('.annotator-pin') !== null
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initAnnotationMode(cbs: AnnotationModeCallbacks): void {
  callbacks = cbs;

  injectHighlightCSS();
  buildPopoverDOM();

  listenerAbortController = new AbortController();
  const { signal } = listenerAbortController;

  // Click-outside detection (registered BEFORE the annotation handler).
  document.addEventListener('click', (e) => {
    if (!popoverOpen) return;
    if ((e.composedPath() as EventTarget[]).includes(popoverHost)) return;
    closePopover();
  }, { capture: true, signal });

  // Annotation-mode click interceptor.
  document.addEventListener('click', (e) => {
    if (!annotationModeActive) return;
    if (isAnnotatorElement(e.target as Element)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handleAnnotationClick(e as MouseEvent);
  }, { capture: true, signal });

  // Hover highlight — mouseover.
  document.addEventListener('mouseover', (e) => {
    if (!annotationModeActive || popoverOpen) return;
    if (isAnnotatorElement(e.target as Element)) return;
    if (highlightedEl) highlightedEl.classList.remove('annotator-highlighted');
    highlightedEl = e.target as Element;
    highlightedEl.classList.add('annotator-highlighted');
  }, { capture: true, signal });

  // Hover highlight — mouseout.
  document.addEventListener('mouseout', (e) => {
    if (!annotationModeActive) return;
    if (highlightedEl && e.target === highlightedEl) {
      highlightedEl.classList.remove('annotator-highlighted');
      highlightedEl = null;
    }
  }, { capture: true, signal });
}

export function enableAnnotationMode(): void {
  annotationModeActive = true;
  document.body.classList.add('annotator-active');
}

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

export function isAnnotationModeActive(): boolean {
  return annotationModeActive;
}

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

  noteInput.value = annotation.note;
  deleteBtn.hidden = false;
  // In edit mode, save is always enabled (allows save without changes — no-op),
  // but spec says "always enabled in edit", so we honour that here.
  saveBtn.disabled = false;

  popoverEl.hidden = false;
  popoverOpen = true;

  positionPopover(pinScreenX, pinScreenY);

  requestAnimationFrame(() => {
    noteInput.focus();
    noteInput.setSelectionRange(noteInput.value.length, noteInput.value.length);
  });
}

export function closePopoverIfOpen(): void {
  if (popoverOpen) {
    closePopover();
  }
}

export function destroyAnnotationMode(): void {
  disableAnnotationMode();

  listenerAbortController?.abort();
  listenerAbortController = null;

  if (popoverHost?.parentNode) {
    popoverHost.parentNode.removeChild(popoverHost);
  }

  document.getElementById('annotator-highlight-css')?.remove();

  callbacks = null;
}
