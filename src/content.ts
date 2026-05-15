// src/content.ts
// Content script main entry — wires all modules together

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: Idempotency guard (MUST be first — prevents double-injection)
// Two content scripts on the same page = two toolbars, doubled storage events
// ─────────────────────────────────────────────────────────────────────────────
if ((window as any).__annotatorActive) {
  // Already running on this page — exit immediately
  throw new Error('Annotator: already active, skipping re-injection');
}
(window as any).__annotatorActive = true;

// ─────────────────────────────────────────────────────────────────────────────
// Imports
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
import { resolvePageAnnotations } from './fingerprint';
import {
  initPinRenderer,
  renderPins,
  clearPins,
  showPins,
  hidePins,
  addPin,
  removePin,
  refreshPins,
} from './pinRenderer';
import {
  initToolbar,
  setAnnotationMode,
  setFilename,
  showError,
  showWarning,
  updateButtonStates,
  showResolutionAlert,
  showConfirmDialog,
  destroyToolbar,
  setAnnotationCount,
} from './toolbar';
import {
  initAnnotationMode,
  enableAnnotationMode,
  disableAnnotationMode,
  isAnnotationModeActive,
  openPopoverForAnnotation,
  closePopoverIfOpen,
  destroyAnnotationMode,
} from './annotationMode';
import { importFile, exportAnnotations } from './importExport';
import type { Annotation, DomainData, Fingerprint } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let myTabId: number = -1;
let lastKnownUrl = location.href;

// ─────────────────────────────────────────────────────────────────────────────
// Message listener (must be registered immediately — before init)
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
    // Toolbar already active — no-op (per requirements §6 edge case 18)
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// init — called once when ACTIVATE message received
// ─────────────────────────────────────────────────────────────────────────────

async function init(tabId: number): Promise<void> {
  myTabId = tabId;

  // 1. Mark this tab as active in storage
  await setTabActive(tabId);

  // 2. Get current domain and URL
  const domain = normaliseDomain(location.hostname);
  const pageUrl = normaliseUrl(location.href);

  // 3. Initialize pin renderer (injects styles, sets up scroll/resize listeners)
  initPinRenderer();

  // 4. Initialize toolbar with callbacks
  initToolbar({
    onStartAnnotating: handleStartAnnotating,
    onExitAnnotating: handleExitAnnotating,
    onExport: handleExport,
    onUploadFile: handleUploadFile,
    onDeleteAll: handleDeleteAll,
  });

  // 5. Initialize annotation mode with callbacks
  initAnnotationMode({
    onNewAnnotation: handleNewAnnotation,
    onEditAnnotation: handleEditAnnotation,
    onDeleteAnnotation: handleDeleteAnnotationByPin,
    onExistingPinClick: handleExistingPinClick,
  });

  // 6. Load and render annotations for current page
  await refreshPageAnnotations(domain, pageUrl);

  // 7. Set up storage change listener (cross-tab sync)
  chrome.storage.onChanged.addListener(handleStorageChanged);

  // 8. Set up SPA navigation detection
  setupNavigationDetection();

  // 9. Set up cleanup on unload
  window.addEventListener('beforeunload', handleBeforeUnload);
}

// ─────────────────────────────────────────────────────────────────────────────
// refreshPageAnnotations — load + render for a given page
// ─────────────────────────────────────────────────────────────────────────────

async function refreshPageAnnotations(domain: string, pageUrl: string): Promise<void> {
  const domainData = await getDomainData(domain);
  const annotations = domainData?.pages[pageUrl] ?? [];
  const totalForDomain = await getAnnotationCount(domain);

  // Render pins for current page
  renderPins(annotations, handlePinClick);

  // Update toolbar button states
  updateButtonStates(totalForDomain > 0, isAnnotationModeActive());

  // Update resolution alert
  const { unresolvedCount } = resolvePageAnnotations(annotations);
  showResolutionAlert(unresolvedCount, annotations.length);

  // Update filename
  if (domainData?.meta.importedFilename) {
    setFilename(domainData.meta.importedFilename);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tab sync (per TECH_DESIGN.md §7)
// ─────────────────────────────────────────────────────────────────────────────

function handleStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
): void {
  if (area !== 'local') return;

  const domain = normaliseDomain(location.hostname);
  const domainKey = `annotations:${domain}`;
  if (!changes[domainKey]) return;

  const newData = changes[domainKey].newValue as DomainData | undefined;
  if (!newData) return;

  // Refresh pins from updated storage (idempotent — no visible effect if unchanged)
  const pageUrl = normaliseUrl(location.href);
  const annotations = newData.pages[pageUrl] ?? [];
  const totalCount = Object.values(newData.pages).flat().length;

  refreshPins(annotations, handlePinClick);
  updateButtonStates(totalCount > 0, isAnnotationModeActive());

  // Update filename state
  setFilename(newData.meta.importedFilename);

  // Update annotation count for confirm dialogs
  setAnnotationCount(totalCount);

  // Update resolution alert
  const { unresolvedCount } = resolvePageAnnotations(annotations);
  showResolutionAlert(unresolvedCount, annotations.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA Navigation Detection (per TECH_DESIGN.md §6.4)
// ─────────────────────────────────────────────────────────────────────────────

function setupNavigationDetection(): void {
  const debouncedHandleUrlChange = debounce(handleUrlChange, 50);

  // Patch pushState
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    debouncedHandleUrlChange();
  };

  // Patch replaceState (REQUIRED — used by React Router, Vue Router redirects)
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    debouncedHandleUrlChange();
  };

  // popstate (back/forward)
  window.addEventListener('popstate', debouncedHandleUrlChange);

  // hashchange
  window.addEventListener('hashchange', debouncedHandleUrlChange);
}

async function handleUrlChange(): Promise<void> {
  const newUrl = normaliseUrl(location.href);
  if (newUrl === normaliseUrl(lastKnownUrl)) return;
  lastKnownUrl = location.href;

  // 1. Close popover if open (FIRST — per Senior Engineer critique)
  closePopoverIfOpen();

  // 2. Turn off annotation mode
  if (isAnnotationModeActive()) {
    disableAnnotationMode();
    setAnnotationMode(false); // update toolbar
  }

  // 3. Clear rendered pins
  clearPins();

  // 4. Load and render pins for new page
  const domain = normaliseDomain(location.hostname);
  await refreshPageAnnotations(domain, newUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleStartAnnotating(): void {
  enableAnnotationMode();
  setAnnotationMode(true);
  showPins();
}

function handleExitAnnotating(): void {
  disableAnnotationMode();
  setAnnotationMode(false);
  hidePins();
}

async function handleExport(): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  await exportAnnotations(domain);
}

async function handleUploadFile(file: File): Promise<void> {
  const domain = normaliseDomain(location.hostname);

  await importFile(file, {
    showConfirm: (message) => showConfirmDialog(message),
    getAnnotationCount: () => getAnnotationCount(domain),
    getCurrentDomain: () => domain,
    onImportSuccess: async (filename) => {
      setFilename(filename);
      // Refresh pins with imported data
      const pageUrl = normaliseUrl(location.href);
      await refreshPageAnnotations(domain, pageUrl);
      // Auto-enter annotation mode (per requirements §1.4)
      handleStartAnnotating();
    },
    showError: (msg) => showError(msg),
    showWarning: (msg) => showWarning(msg),
  });
}

async function handleDeleteAll(): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  const count = await getAnnotationCount(domain);

  const confirmed = await showConfirmDialog(
    `Delete all ${count} annotation${count === 1 ? '' : 's'}? This cannot be undone.`
  );
  if (!confirmed) return;

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
  const domain = normaliseDomain(location.hostname);
  const pageUrl = normaliseUrl(location.href);

  const pinNumber = await getNextPinNumber(domain);
  const annotation: Annotation = {
    pinNumber,
    note: params.note,
    fingerprint: params.fingerprint,
    offset: params.offset,
    createdAt: new Date().toISOString(),
  };

  await addAnnotation(domain, pageUrl, annotation);

  // Add pin to page
  addPin(annotation, params.targetElement, handlePinClick);

  // Update toolbar
  const count = await getAnnotationCount(domain);
  updateButtonStates(count > 0, true);
  setAnnotationCount(count);

  // Clear filename if modified after import
  const domainData = await getDomainData(domain);
  if (domainData?.meta.wasImported && !domainData.meta.importedFilename) {
    setFilename(null);
  }
}

async function handleEditAnnotation(pinNumber: number, note: string): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  const pageUrl = normaliseUrl(location.href);
  await updateAnnotation(domain, pageUrl, pinNumber, note);
  // Update filename indicator (modified after import)
  const domainData = await getDomainData(domain);
  if (domainData?.meta.wasImported && !domainData.meta.importedFilename) {
    setFilename(null);
  }
}

async function handleDeleteAnnotationByPin(pinNumber: number): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  await deleteAnnotation(domain, pinNumber);
  removePin(pinNumber);

  const count = await getAnnotationCount(domain);
  updateButtonStates(count > 0, isAnnotationModeActive());
  setAnnotationCount(count);
}

function handlePinClick(annotation: Annotation): void {
  // Find pin position on screen
  const pinEl = document.querySelector(`.annotator-pin[data-pin-id="${annotation.pinNumber}"]`);
  if (!pinEl) return;
  const rect = pinEl.getBoundingClientRect();
  openPopoverForAnnotation(annotation, rect.left, rect.top);
}

function handleExistingPinClick(pinNumber: number): void {
  // Look up annotation from storage and open popover
  const domain = normaliseDomain(location.hostname);
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
// Beforeunload cleanup (per TECH_DESIGN.md §6.3)
// ─────────────────────────────────────────────────────────────────────────────

function handleBeforeUnload(): void {
  // IMPORTANT: Do NOT remove activeTab key from storage!
  // Removing it here breaks reload persistence.
  // The key persists until: tab close (onRemoved) or browser restart (startup sweep)

  // DOM-only cleanup
  destroyToolbar();
  destroyAnnotationMode();
  clearPins();

  // Remove storage listener
  chrome.storage.onChanged.removeListener(handleStorageChanged);
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

export {};
