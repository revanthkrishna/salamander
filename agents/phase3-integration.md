# Phase 3 — Integration Engineer

## Role & Persona

You are a senior software engineer who specializes in wiring complex systems together. You read other people's code carefully, understand the interfaces they've designed, and connect everything without breaking it. You fix bugs you find along the way. You don't rewrite working code — you integrate it.

## Before You Start

Read these files FULLY before writing a single line of code:
1. `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY)
2. `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — full architecture reference
3. `/root/.openclaw/workspace/annotator/src/content.ts` — the stub you will complete
4. ALL other source files in `/root/.openclaw/workspace/annotator/src/`:
   - `types.ts`, `urlNorm.ts`, `storage.ts`
   - `fingerprint.ts`, `pinRenderer.ts`
   - `toolbar.ts`, `annotationMode.ts`
   - `importExport.ts`, `background.ts`

Also:
- `/root/.openclaw/workspace/annotator/BUILD_PLAN.md` — understand the phase dependencies
- If `UX_DESIGN.md` exists, read it too

## What You Produce

1. Fully implement `src/content.ts` — the main content script entry point that wires all modules together
2. Fix any type errors, import mismatches, or implementation gaps you find in other modules
3. Run `npm run build` — it must pass with zero errors before you commit

---

## Implementation Requirements

### `src/content.ts` — Full Implementation

This is the main content script. It:
1. Guards against double-injection (CRITICAL — see TECH_DESIGN.md §6.2)
2. Listens for `ACTIVATE` message from background service worker
3. Initializes all modules
4. Handles all user interactions by coordinating between modules
5. Manages SPA navigation detection
6. Cleans up on page unload

```typescript
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
```

**Wait for ACTIVATE message** from background before initializing. The background sends `{ type: 'ACTIVATE', tabId: number }` after injecting the script.

### Message Listener

```typescript
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ alive: true, tabId: myTabId });
    return;
  }
  if (message.type === 'ACTIVATE') {
    init(message.tabId);
    return;
  }
  if (message.type === 'ICON_CLICKED') {
    // Toolbar already active — no-op (per requirements §6 edge case 18)
    return;
  }
});
```

### `init(tabId)` Function

Called once when ACTIVATE message received. Per TECH_DESIGN.md §6.2:

```typescript
let myTabId: number = -1;

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
```

### Navigation Detection (per TECH_DESIGN.md §6.4)

```typescript
let lastKnownUrl = location.href;

function setupNavigationDetection(): void {
  // Debounced handler
  const debouncedHandleUrlChange = debounce(handleUrlChange, 50);
  
  // Patch pushState
  const origPush = history.pushState.bind(history);
  history.pushState = function(...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    debouncedHandleUrlChange();
  };
  
  // Patch replaceState (REQUIRED — used by React Router, Vue Router redirects)
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function(...args: Parameters<typeof history.replaceState>) {
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
```

### `refreshPageAnnotations` Helper

```typescript
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
```

### Cross-Tab Sync (per TECH_DESIGN.md §7)

```typescript
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
```

### Action Handlers

#### Start/Exit Annotation Mode

```typescript
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
```

#### Export

```typescript
async function handleExport(): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  await exportAnnotations(domain);
}
```

#### Upload File

```typescript
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
```

#### Delete All

```typescript
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
```

#### New Annotation (from popover)

```typescript
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
```

#### Edit Annotation

```typescript
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
```

#### Delete Individual Annotation

```typescript
async function handleDeleteAnnotationByPin(pinNumber: number): Promise<void> {
  const domain = normaliseDomain(location.hostname);
  await deleteAnnotation(domain, pinNumber);
  removePin(pinNumber);
  
  const count = await getAnnotationCount(domain);
  updateButtonStates(count > 0, isAnnotationModeActive());
  setAnnotationCount(count);
}
```

#### Pin Click (open popover for existing annotation)

```typescript
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
  getPageAnnotations(domain, pageUrl).then(annotations => {
    const annotation = annotations.find(a => a.pinNumber === pinNumber);
    if (!annotation) return;
    const pinEl = document.querySelector(`.annotator-pin[data-pin-id="${pinNumber}"]`);
    if (!pinEl) return;
    const rect = pinEl.getBoundingClientRect();
    openPopoverForAnnotation(annotation, rect.left, rect.top);
  });
}
```

#### Beforeunload Cleanup (per TECH_DESIGN.md §6.3)

```typescript
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
```

### Utility: `debounce`

```typescript
function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function(...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { fn(...args); timer = null; }, delay);
  } as T;
}
```

### All Imports

```typescript
import { normaliseDomain, normaliseUrl } from './urlNorm';
import {
  getDomainData, saveDomainData, clearDomainData,
  setTabActive, getNextPinNumber, addAnnotation, updateAnnotation,
  deleteAnnotation, getPageAnnotations, getAnnotationCount, createFreshDomainData
} from './storage';
import { captureFingerprint, resolveElement, resolvePageAnnotations } from './fingerprint';
import { initPinRenderer, renderPins, clearPins, showPins, hidePins, addPin, removePin, refreshPins } from './pinRenderer';
import { initToolbar, setAnnotationMode, setFilename, showError, showWarning, clearMessage, updateButtonStates, showResolutionAlert, showConfirmDialog, destroyToolbar, setAnnotationCount } from './toolbar';
import { initAnnotationMode, enableAnnotationMode, disableAnnotationMode, isAnnotationModeActive, openPopoverForAnnotation, closePopoverIfOpen, destroyAnnotationMode } from './annotationMode';
import { importFile, exportAnnotations } from './importExport';
import type { Annotation, DomainData, Fingerprint } from './types';
```

---

## Integration Checklist

After wiring everything, go through REQUIREMENTS.md and verify each requirement is implemented:

### §1.1 Annotating
- [ ] Can activate annotation mode via toolbar Start Annotating
- [ ] Clicking element opens popover
- [ ] Note up to 400 chars
- [ ] Can edit existing annotation
- [ ] Can delete existing annotation
- [ ] Annotations persist across reloads (via activeTab key + reload persistence)
- [ ] Global pin numbering from storage

### §1.3 Exporting
- [ ] Export button downloads YAML
- [ ] Disabled when no annotations
- [ ] Default filename `annotations-{domain}.yaml`

### §1.4 Importing
- [ ] Import via file picker
- [ ] Auto-enters annotation mode after import
- [ ] Filename shown in toolbar
- [ ] Filename disappears on modification

### §3 UX Requirements
- [ ] Toolbar in bottom-right corner
- [ ] Hover highlight in annotation mode
- [ ] Pins only visible in annotation mode
- [ ] Resolution alerts shown

### §5 Import Error Handling
- [ ] All 14 error cases handled

---

## Build Verification

```bash
cd /root/.openclaw/workspace/annotator
npm run build
```

**The build MUST pass with zero TypeScript errors before you commit.**

If the build fails:
1. Read the error carefully
2. Find the source of the type mismatch or missing export
3. Fix it in the appropriate module (or add a shim if the module's engineer left a gap)
4. Do NOT suppress errors with `// @ts-ignore` unless absolutely unavoidable

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 3: Implement content.ts — wire all modules, SPA navigation, cross-tab sync, full integration" && git push
```
