// src/content.ts
// Content script main entry — wires all modules together.

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: Idempotency guard (MUST be first — prevents double-injection)
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Imports (must be at module top level — before the IIFE guard below)
// ─────────────────────────────────────────────────────────────────────────────

import { normaliseDomain, normaliseUrl } from './urlNorm';
import {
  getDomainData,
  clearDomainData,
  setTabActive,
  getNextPinNumber,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  getPageAnnotations,
  getAnnotationCount,
} from './storage';
import {
  initPinRenderer,
  renderPins,
  clearPins,
  showPins,
  hidePins,
  addPin,
  removePin,
  refreshPins,
  setStatsListener,
  type PinRenderStats,
} from './pinRenderer';
import {
  initToolbar,
  setFilename,
  showError,
  showWarning,
  updateButtonStates,
  showResolutionAlert,
  showConfirmDialog,
  destroyToolbar,
  setAnnotationCount,
  showToolbar,
  hideToolbar,
} from './toolbar';
import {
  initAnnotationMode,
  enableAnnotationMode,
  disableAnnotationMode,
  isAnnotationModeActive,
  openPopoverForAnnotation,
  closePopoverIfOpen,
  destroyAnnotationMode,
  clearHoverHighlight,
} from './annotationMode';
import { importFile, exportAnnotations } from './importExport';
import type { Annotation, DomainData, Fingerprint } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency guard + runtime init (wrapped in IIFE so we can `return` instead
// of throwing — a throw here shows as a console error even though it’s intentional).
// ─────────────────────────────────────────────────────────────────────────────
void (function annotatorMain() {

if ((window as any).__annotatorActive) {
  return; // Already running on this page — silent exit, no console error.
}
(window as any).__annotatorActive = true;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let myTabId: number = -1;
let lastKnownUrl = location.href;

// ─────────────────────────────────────────────────────────────────────────────
// Message listener
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ alive: true, tabId: myTabId });
    return;
  }
  if (message.type === 'ACTIVATE') {
    init(message.tabId as number);
    return;
  }
  if (message.type === 'ICON_CLICKED') {
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// init
// ─────────────────────────────────────────────────────────────────────────────

async function init(tabId: number): Promise<void> {
  myTabId = tabId;

  await setTabActive(tabId);

  const domain = normaliseDomain(location.host);
  const pageUrl = normaliseUrl(location.href);

  initPinRenderer();

  // Keep the toolbar resolution alert in sync as the MutationObserver retry
  // queue inside pinRenderer resolves async-mounted elements.
  setStatsListener(handlePinStats);

  initToolbar({
    onSButtonClick: handleSButtonClick,
    onExit: handleExit,
    onExport: handleExport,
    onUploadFile: handleUploadFile,
    onDeleteAll: handleDeleteAll,
    onDismissFile: handleDismissFile,
  });

  initAnnotationMode({
    onNewAnnotation: handleNewAnnotation,
    onEditAnnotation: handleEditAnnotation,
    onDeleteAnnotation: handleDeleteAnnotationByPin,
    onExistingPinClick: handleExistingPinClick,
    onCancelCreate: handleCancelCreate,
  });

  // Register BEFORE the first awaited storage read so we don't miss any
  // changes that arrive while `refreshPageAnnotations` is in-flight.
  chrome.storage.onChanged.addListener(handleStorageChanged);

  await refreshPageAnnotations(domain, pageUrl);

  setupNavigationDetection();

  window.addEventListener('beforeunload', handleBeforeUnload);
}

function handlePinStats(stats: PinRenderStats): void {
  showResolutionAlert(stats.unresolved, stats.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshPageAnnotations
// ─────────────────────────────────────────────────────────────────────────────

async function refreshPageAnnotations(domain: string, pageUrl: string): Promise<void> {
  const domainData = await getDomainData(domain);
  const annotations = domainData?.pages[pageUrl] ?? [];
  const totalForDomain = await getAnnotationCount(domain);

  // renderPins fires the statsListener (handlePinStats) synchronously via
  // emitStats(), which calls showResolutionAlert. No need to call it again here.
  renderPins(annotations, handlePinClick);

  updateButtonStates(totalForDomain > 0, isAnnotationModeActive());

  if (domainData?.meta.importedFilename) {
    setFilename(domainData.meta.importedFilename);
  } else {
    setFilename(null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tab sync
// ─────────────────────────────────────────────────────────────────────────────

function handleStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
): void {
  if (area !== 'local') return;

  const domain = normaliseDomain(location.host);
  const domainKey = `annotations:${domain}`;
  const writerKey = `lastWriter:${domain}`;

  // Skip our own writes — we already updated the DOM directly via addPin /
  // removePin / updatePin / clearPins. Re-rendering from storage here would
  // clear and re-resolve all pins, which can clobber the live element ref
  // (e.g. a React subtree that has since remounted between addPin and now).
  if (changes[writerKey] !== undefined &&
      changes[writerKey].newValue === myTabId) {
    return;
  }

  // Short-circuit: if no annotation key changed, nothing needs re-rendering.
  // This handles the race where markTabAsWriter and addAnnotation land in
  // separate storage batches — the first batch (lastWriter:* only) is safely
  // ignored here so the guard above can fire on the second batch.
  const hasAnnotationChange = Object.keys(changes).some((k) => k.startsWith('annotations:'));
  if (!hasAnnotationChange) return;

  if (!changes[domainKey]) return;

  const newData = changes[domainKey].newValue as DomainData | undefined;

  if (!newData) {
    // Domain data was cleared from another tab. Mirror that locally.
    clearPins();
    setFilename(null);
    updateButtonStates(false, isAnnotationModeActive());
    setAnnotationCount(0);
    showResolutionAlert(0, 0);
    return;
  }

  const pageUrl = normaliseUrl(location.href);
  const annotations = newData.pages[pageUrl] ?? [];
  const totalCount = Object.values(newData.pages).flat().length;

  const stats = refreshPins(annotations, handlePinClick);
  updateButtonStates(totalCount > 0, isAnnotationModeActive());

  setFilename(newData.meta.importedFilename);

  setAnnotationCount(totalCount);
  showResolutionAlert(stats.unresolved, stats.total);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA navigation detection
// ─────────────────────────────────────────────────────────────────────────────

function setupNavigationDetection(): void {
  const debouncedHandleUrlChange = debounce(handleUrlChange, 50);

  const origPush = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    debouncedHandleUrlChange();
  };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    debouncedHandleUrlChange();
  };

  window.addEventListener('popstate', debouncedHandleUrlChange);
  window.addEventListener('hashchange', debouncedHandleUrlChange);
}

async function handleUrlChange(): Promise<void> {
  const newUrl = normaliseUrl(location.href);
  if (newUrl === normaliseUrl(lastKnownUrl)) return;
  lastKnownUrl = location.href;

  // On SPA navigation we keep annotation mode active and the toolbar visible.
  // Just close any open popover, clear stale hover state, and re-render pins
  // for the new page.
  closePopoverIfOpen();
  clearHoverHighlight();
  clearPins();

  const domain = normaliseDomain(location.host);
  await refreshPageAnnotations(domain, newUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

/** S button click → start annotation mode + expand toolbar. */
function handleSButtonClick(): void {
  enableAnnotationMode();
  showPins(); // pins are always visible; this just enables pointer-events
  showToolbar();
}

/** Exit (cross) click → stop annotation mode. Pins remain visible. */
function handleExit(): void {
  disableAnnotationMode();
  hidePins(); // pointer-events off, but pins stay rendered
  hideToolbar();
}

async function handleExport(): Promise<void> {
  const domain = normaliseDomain(location.host);
  const count = await getAnnotationCount(domain);
  if (count === 0) {
    // Spec: show alert when nothing to export — do not silently no-op.
    window.alert('nothing to export');
    return;
  }
  await exportAnnotations(domain);
}

async function handleUploadFile(file: File): Promise<void> {
  const domain = normaliseDomain(location.host);

  await importFile(file, {
    showConfirm: (message) => showConfirmDialog(message.toLowerCase()),
    getAnnotationCount: () => getAnnotationCount(domain),
    getCurrentDomain: () => domain,
    onImportSuccess: async (filename) => {
      setFilename(filename);
      const pageUrl = normaliseUrl(location.href);
      await refreshPageAnnotations(domain, pageUrl);
      // Auto-enter annotation mode (per requirements §1.4)
      handleSButtonClick();
    },
    showError: (msg) => showError(msg.toLowerCase()),
    showWarning: (msg) => showWarning(msg.toLowerCase()),
  });
}

async function handleDeleteAll(): Promise<void> {
  const domain = normaliseDomain(location.host);
  const count = await getAnnotationCount(domain);

  // Spec: if no annotations, do nothing (no confirm).
  if (count === 0) return;

  const confirmed = await showConfirmDialog(
    `delete all ${count} annotation${count === 1 ? '' : 's'}? this cannot be undone.`
  );
  if (!confirmed) return;

  await markTabAsWriter(domain);
  await clearDomainData(domain);
  clearPins();
  setFilename(null);
  updateButtonStates(false, isAnnotationModeActive());
  showResolutionAlert(0, 0);
}

/**
 * Filename-bar dismiss button → removes the file AND all annotations.
 * This is treated as a "delete all" without confirmation (since the user
 * just explicitly clicked the dismiss icon on the filename bar).
 */
async function handleDismissFile(): Promise<void> {
  const domain = normaliseDomain(location.host);
  const count = await getAnnotationCount(domain);
  if (count === 0) {
    setFilename(null);
    return;
  }
  await markTabAsWriter(domain);
  await clearDomainData(domain);
  clearPins();
  setFilename(null);
  updateButtonStates(false, isAnnotationModeActive());
  showResolutionAlert(0, 0);
}

async function handleNewAnnotation(params: {
  targetElement: Element;
  fingerprint: Fingerprint;
  offset: { x: number; y: number };
  note: string;
}): Promise<void> {
  const domain = normaliseDomain(location.host);
  const pageUrl = normaliseUrl(location.href);

  const pinNumber = await getNextPinNumber(domain);
  const annotation: Annotation = {
    pinNumber,
    note: params.note,
    fingerprint: params.fingerprint,
    offset: params.offset,
    createdAt: new Date().toISOString(),
  };

  await markTabAsWriter(domain);
  await addAnnotation(domain, pageUrl, annotation);

  addPin(annotation, params.targetElement, handlePinClick);

  const count = await getAnnotationCount(domain);
  updateButtonStates(count > 0, true);
  setAnnotationCount(count);

  const domainData = await getDomainData(domain);
  if (domainData?.meta.wasImported && !domainData.meta.importedFilename) {
    setFilename(null);
  }
}

async function handleEditAnnotation(pinNumber: number, note: string): Promise<void> {
  const domain = normaliseDomain(location.host);
  const pageUrl = normaliseUrl(location.href);
  await markTabAsWriter(domain);
  await updateAnnotation(domain, pageUrl, pinNumber, note);
  const domainData = await getDomainData(domain);
  if (domainData?.meta.wasImported && !domainData.meta.importedFilename) {
    setFilename(null);
  }
}

async function handleDeleteAnnotationByPin(pinNumber: number): Promise<void> {
  const domain = normaliseDomain(location.host);
  await markTabAsWriter(domain);
  await deleteAnnotation(domain, pinNumber);
  removePin(pinNumber);

  const count = await getAnnotationCount(domain);
  updateButtonStates(count > 0, isAnnotationModeActive());
  setAnnotationCount(count);
}

/**
 * CREATE cancel → no pin was ever rendered (we only call addPin after save),
 * so nothing to clean up. Hook is kept so future flows that pre-place a pin
 * can use it cleanly.
 */
function handleCancelCreate(): void {
  // intentionally empty
}

function handlePinClick(annotation: Annotation): void {
  const pinEl = document.querySelector(`.annotator-pin[data-pin-id="${annotation.pinNumber}"]`);
  if (!pinEl) return;
  const rect = pinEl.getBoundingClientRect();
  openPopoverForAnnotation(annotation, rect.left, rect.top);
}

function handleExistingPinClick(pinNumber: number): void {
  const domain = normaliseDomain(location.host);
  const pageUrl = normaliseUrl(location.href);
  getPageAnnotations(domain, pageUrl).then((annotations) => {
    const annotation = annotations.find((a) => a.pinNumber === pinNumber);
    if (!annotation) return;
    const pinEl = document.querySelector(`.annotator-pin[data-pin-id="${pinNumber}"]`);
    if (!pinEl) return;
    const rect = pinEl.getBoundingClientRect();
    openPopoverForAnnotation(annotation, rect.left, rect.top);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Beforeunload cleanup
// ─────────────────────────────────────────────────────────────────────────────

function handleBeforeUnload(): void {
  destroyToolbar();
  destroyAnnotationMode();
  clearPins();

  chrome.storage.onChanged.removeListener(handleStorageChanged);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab-writer marker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp this tab as the most recent writer for `domain`. Called immediately
 * before each storage mutation that originates in this tab. The companion
 * check in `handleStorageChanged` reads back `lastWriter:{domain}` and skips
 * the same-tab re-render — we already updated the DOM directly via
 * `addPin` / `removePin` / `updatePin` / `clearPins`.
 */
async function markTabAsWriter(domain: string): Promise<void> {
  if (myTabId < 0) return;
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [`lastWriter:${domain}`]: myTabId }, () => resolve());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: debounce
// ─────────────────────────────────────────────────────────────────────────────

function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  } as T;
}

})(); // end annotatorMain IIFE
export {};
