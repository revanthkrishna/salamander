// Phase 0: minimal stub, kept compiling against the new v2 type surface.
//
// Not in Phase 0's file list, but src/background.ts imports the tab-activation
// helpers below and those don't depend on the (now-deleted) Annotation/pin
// shape — only on tabId. The domain/feedback-item CRUD that DID depend on the
// old Annotation/DomainData shape is removed here; Phase 1 ("extend
// src/storage.ts") adds the IndexedDB blob store, feedback-item CRUD, and the
// chrome.storage.session sidebar state back in against the new FeedbackItem
// type (see DEVELOPMENT_PLAN.md Phase 1 and the inventory table's "extend"
// note for this file).

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
// Tab activation state
// ---------------------------------------------------------------------------
// TODO(Phase 1): replace with chrome.storage.session keyed by tab id, per
// REQUIREMENTS.md §1.1's decision — chrome.storage.local's activeTab:{tabId}
// key survives browser restarts, which is the wrong lifetime for "is the
// sidebar open" state.

/** Mark a tab as having an active sidebar. */
export async function setTabActive(tabId: number): Promise<void> {
  await storageSet({ [`activeTab:${tabId}`]: true });
}

/** Remove tab active marker (called on tab close). */
export async function removeTabActive(tabId: number): Promise<void> {
  await storageRemove(`activeTab:${tabId}`);
}

/** Check if a tab has an active sidebar. */
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
  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) =>
    chrome.tabs.query({}, resolve)
  );
  const liveIds = new Set(tabs.map((t) => t.id));

  const all = await storageGet(null);

  const staleKeys = Object.keys(all)
    .filter((k) => k.startsWith('activeTab:'))
    .filter((k) => !liveIds.has(parseInt(k.split(':')[1])));

  if (staleKeys.length > 0) {
    await storageRemove(staleKeys);
  }
}
