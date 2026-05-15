// Phase 2A: chrome.storage.local wrapper
// All annotation state lives under:
//   annotations:{domain}  → DomainData
//   activeTab:{tabId}     → true (boolean)

import type { DomainData, Annotation } from './types';

export const STORAGE_VERSION = 1;

// ---------------------------------------------------------------------------
// Internal Promise-based helpers
// ---------------------------------------------------------------------------

function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Domain data
// ---------------------------------------------------------------------------

/** Get all domain data for a normalised domain. Returns null if not found. */
export async function getDomainData(domain: string): Promise<DomainData | null> {
  const key = `annotations:${domain}`;
  const result = await storageGet(key);
  const value = result[key];
  return value != null ? (value as DomainData) : null;
}

/** Save domain data for a normalised domain. */
export async function saveDomainData(domain: string, data: DomainData): Promise<void> {
  const key = `annotations:${domain}`;
  await storageSet({ [key]: data });
}

/**
 * Clear all data for a domain (used by delete-all).
 * Removes the storage key entirely; subsequent reads return null.
 */
export async function clearDomainData(domain: string): Promise<void> {
  const key = `annotations:${domain}`;
  await storageRemove(key);
}

// ---------------------------------------------------------------------------
// Tab activation state
// ---------------------------------------------------------------------------

/** Mark a tab as having an active toolbar. */
export async function setTabActive(tabId: number): Promise<void> {
  await storageSet({ [`activeTab:${tabId}`]: true });
}

/** Remove tab active marker (called on tab close). */
export async function removeTabActive(tabId: number): Promise<void> {
  await storageRemove(`activeTab:${tabId}`);
}

/** Check if a tab has an active toolbar. */
export async function isTabActive(tabId: number): Promise<boolean> {
  const key = `activeTab:${tabId}`;
  const result = await storageGet(key);
  return result[key] === true;
}

/**
 * Startup cleanup: remove stale activeTab keys for tabs that no longer exist.
 * Called from the background service worker on chrome.runtime.onStartup.
 */
export async function cleanupStaleTabKeys(): Promise<void> {
  // Get all current tab IDs
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) =>
    chrome.tabs.query({}, resolve)
  );
  const liveIds = new Set(tabs.map((t) => t.id));

  // Get all storage keys
  const all = await storageGet(null);

  // Remove stale activeTab keys
  const staleKeys = Object.keys(all)
    .filter((k) => k.startsWith('activeTab:'))
    .filter((k) => !liveIds.has(parseInt(k.split(':')[1])));

  if (staleKeys.length > 0) {
    await storageRemove(staleKeys);
  }
}

// ---------------------------------------------------------------------------
// Annotation helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh DomainData object with defaults.
 * Used on first write for a domain or after delete-all.
 */
export function createFreshDomainData(): DomainData {
  return {
    meta: {
      nextPinNumber: 1,
      importedFilename: null,
      wasImported: false,
      version: STORAGE_VERSION,
    },
    pages: {},
  };
}

/**
 * Get the next pin number for a domain (reads from meta.nextPinNumber).
 * Creates fresh DomainData if none exists.
 */
export async function getNextPinNumber(domain: string): Promise<number> {
  const data = await getDomainData(domain);
  if (!data) return 1;
  return data.meta.nextPinNumber;
}

/**
 * Add an annotation to storage.
 * Updates meta.nextPinNumber = annotation.pinNumber + 1.
 */
export async function addAnnotation(
  domain: string,
  pageUrl: string,
  annotation: Annotation
): Promise<void> {
  const data = (await getDomainData(domain)) ?? createFreshDomainData();
  if (!data.pages[pageUrl]) {
    data.pages[pageUrl] = [];
  }
  data.pages[pageUrl].push(annotation);
  data.meta.nextPinNumber = annotation.pinNumber + 1;
  // Clear filename indicator: any add after import puts us in "modified" state
  // (consistent with updateAnnotation and deleteAnnotation)
  data.meta.importedFilename = null;
  await saveDomainData(domain, data);
}

/**
 * Update an existing annotation's note (by pinNumber on the specified page).
 * Clears importedFilename to indicate modified-after-import state.
 */
export async function updateAnnotation(
  domain: string,
  pageUrl: string,
  pinNumber: number,
  note: string
): Promise<void> {
  const data = await getDomainData(domain);
  if (!data) return;

  const annotations = data.pages[pageUrl];
  if (!annotations) return;

  const ann = annotations.find((a) => a.pinNumber === pinNumber);
  if (!ann) return;

  ann.note = note;
  // Clear filename indicator: any edit after import puts us in "modified" state
  data.meta.importedFilename = null;
  await saveDomainData(domain, data);
}

/**
 * Delete an annotation by pinNumber, searching across all pages of the domain.
 * Cleans up empty page entries. Clears importedFilename (modified-after-import).
 */
export async function deleteAnnotation(domain: string, pinNumber: number): Promise<void> {
  const data = await getDomainData(domain);
  if (!data) return;

  let found = false;
  for (const pageUrl of Object.keys(data.pages)) {
    const before = data.pages[pageUrl].length;
    data.pages[pageUrl] = data.pages[pageUrl].filter((a) => a.pinNumber !== pinNumber);
    if (data.pages[pageUrl].length !== before) {
      found = true;
      // Clean up empty page entry to keep storage tidy
      if (data.pages[pageUrl].length === 0) {
        delete data.pages[pageUrl];
      }
      break;
    }
  }

  if (!found) return;

  // Clear filename indicator: any deletion after import puts us in "modified" state
  data.meta.importedFilename = null;
  await saveDomainData(domain, data);
}

/** Get all annotations for a specific normalised page URL. */
export async function getPageAnnotations(
  domain: string,
  pageUrl: string
): Promise<Annotation[]> {
  const data = await getDomainData(domain);
  if (!data) return [];
  return data.pages[pageUrl] ?? [];
}

/** Get total annotation count for a domain (across all pages). */
export async function getAnnotationCount(domain: string): Promise<number> {
  const data = await getDomainData(domain);
  if (!data) return 0;
  return Object.values(data.pages).reduce((sum, anns) => sum + anns.length, 0);
}
