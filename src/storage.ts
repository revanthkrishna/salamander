// Phase 1: storage layer — chrome.storage.local metadata, IndexedDB blobs
// (src/imageStore.ts), chrome.storage.session sidebar state.
//
// Layout in chrome.storage.local: one key per domain, `domain:{domain}` ->
// DomainData (meta + pages, keyed by normalised URL). Item ids are
// sequential across every URL of a domain (§1.2), tracked via
// DomainMeta.nextItemNumber.
//
// Cross-cutting gotcha #1 — the storage boundary (TECH_DESIGN.md "Storage
// boundary"): this module (and imageStore.ts) is only ever imported by the
// service worker. Feedback data (domain records, items, screenshot blobs)
// and the per-tab session state are reached from a content script only
// through chrome.runtime messages (src/messages.ts). The one sanctioned
// exception is UI *preferences* — `themeMode` (theme.ts) and `sidebarWidth`
// (sidebar.ts) — which the content script reads and writes in
// chrome.storage.local directly: they are not domain data, a round trip
// for them would be silly, and nothing here ever touches those keys.

import { DomainData, DomainMeta, FeedbackItem, ItemPatch } from './types';
import * as imageStore from './imageStore';

/** The schema version stamped on every domain record this build writes.
 *  Bump it the first time DomainData's stored shape changes, and add the
 *  matching step to migrateDomainData below. */
export const STORAGE_VERSION = 1;

function domainKey(domain: string): string {
  return `domain:${domain}`;
}

// ---------------------------------------------------------------------------
// Internal Promise-based helpers (chrome.storage.local)
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

function emptyDomainData(): DomainData {
  return { meta: { nextItemNumber: 1, version: STORAGE_VERSION }, pages: {} };
}

// ---------------------------------------------------------------------------
// Domain CRUD
// ---------------------------------------------------------------------------

/**
 * Bring a raw stored record up to the current DomainData shape. Pure, so the
 * version steps can be tested against frozen fixtures of what older builds
 * actually wrote. Returns null for anything that is not a domain record at
 * all (nothing stored, or a value with no `meta`/`pages`).
 *
 * Each `case` is one version step and runs in sequence, so a record from
 * several versions back walks every step. A record stamped with a version
 * NEWER than this build (an extension downgrade) is passed through as-is:
 * there is no way to reshape it correctly, and refusing it would make the
 * user's feedback vanish rather than degrade.
 */
export function migrateDomainData(raw: unknown): DomainData | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<DomainData>;
  if (!record.meta || typeof record.meta !== 'object' || !record.pages || typeof record.pages !== 'object') {
    return null;
  }
  let data = record as DomainData;
  // A record with no version at all predates the stamp (or was hand-edited)
  // and is treated as the first versioned shape.
  const version = typeof data.meta.version === 'number' ? data.meta.version : 0;
  switch (version) {
    case 0:
      data = { ...data, meta: { ...data.meta, version: 1 } };
    // falls through — version 1 is the current shape.
    case 1:
      break;
    default:
      break;
  }
  return data;
}

/** Read a domain's full record, or null if nothing has been captured for it
 *  yet. A record written by an older build is migrated on the way in and,
 *  if the migration changed it, written straight back so the upgrade
 *  happens once rather than on every read. */
export async function getDomainData(domain: string): Promise<DomainData | null> {
  const key = domainKey(domain);
  const result = await storageGet(key);
  const raw = result[key];
  const data = migrateDomainData(raw);
  if (!data) return null;
  const storedVersion = (raw as Partial<DomainData>).meta?.version;
  if (storedVersion !== data.meta.version) {
    await saveDomainData(domain, data);
  }
  return data;
}

/** Overwrite a domain's full record verbatim. Low-level primitive — prefer
 *  addItem/updateItem/deleteItem/replaceDomainData for normal mutation. */
export async function saveDomainData(domain: string, data: DomainData): Promise<void> {
  await storageSet({ [domainKey(domain)]: data });
}

/** Delete a domain's record entirely, including every item's blob. */
export async function deleteDomainData(domain: string): Promise<void> {
  const data = await getDomainData(domain);
  if (data) {
    await deleteAllBlobsIn(data);
  }
  await storageRemove(domainKey(domain));
}

async function deleteAllBlobsIn(data: DomainData): Promise<void> {
  const keys = Object.values(data.pages)
    .flat()
    .map((item) => item.screenshotKey);
  await Promise.all(keys.map((k) => imageStore.deleteImage(k)));
}

// ---------------------------------------------------------------------------
// Item-level CRUD
// ---------------------------------------------------------------------------

/** All feedback items captured for one normalised URL of a domain, in
 *  capture order. Empty array if the domain or URL has nothing yet. */
export async function getPageItems(
  domain: string,
  normalisedUrl: string,
): Promise<FeedbackItem[]> {
  const data = await getDomainData(domain);
  return data?.pages[normalisedUrl] ?? [];
}

/** The id the *next* captured item for this domain should use. Monotonic
 *  across every URL of the domain (§1.2) — does not itself reserve the id;
 *  addItem() is what advances the counter. */
export async function getNextItemId(domain: string): Promise<number> {
  const data = await getDomainData(domain);
  return data?.meta.nextItemNumber ?? 1;
}

/** Append a captured feedback item under its page's URL, creating the
 *  domain record if this is its first item. Advances nextItemNumber past
 *  the item's id so ids stay strictly increasing even if a caller supplies
 *  one out of the expected sequence. */
export async function addItem(domain: string, item: FeedbackItem): Promise<void> {
  const data = (await getDomainData(domain)) ?? emptyDomainData();
  const pageItems = data.pages[item.normalisedUrl] ?? [];
  data.pages[item.normalisedUrl] = [...pageItems, item];
  data.meta.nextItemNumber = Math.max(data.meta.nextItemNumber, item.id + 1);
  await saveDomainData(domain, data);
}

/**
 * Apply a partial update to one stored item (the enlarged view's autosave,
 * §1.5). `patch` is an ItemPatch (src/types.ts) — the one declaration of
 * which fields are mutable — so a new per-item field needs no new storage
 * function. Resolves true if the item was found and written, false if the
 * domain, URL or item does not exist (nothing is written then).
 */
export async function updateItem(
  domain: string,
  normalisedUrl: string,
  itemId: number,
  patch: ItemPatch,
): Promise<boolean> {
  const data = await getDomainData(domain);
  if (!data) return false;
  const pageItems = data.pages[normalisedUrl];
  if (!pageItems) return false;
  const idx = pageItems.findIndex((it) => it.id === itemId);
  if (idx === -1) return false;
  pageItems[idx] = { ...pageItems[idx], ...patch };
  await saveDomainData(domain, data);
  return true;
}

/** Edit an item's note text in place — `updateItem` with a `{ note }` patch.
 *  Kept as the UPDATE_NOTE message's storage half. No-op if the item can't
 *  be found. */
export async function updateNote(
  domain: string,
  normalisedUrl: string,
  itemId: number,
  note: string,
): Promise<void> {
  await updateItem(domain, normalisedUrl, itemId, { note });
}

/** Remove an item and its screenshot blob (§1.5 — deleting a feedback item
 *  must not orphan its image). No-op if the item can't be found. */
export async function deleteItem(
  domain: string,
  normalisedUrl: string,
  itemId: number,
): Promise<void> {
  const data = await getDomainData(domain);
  if (!data) return;
  const pageItems = data.pages[normalisedUrl];
  if (!pageItems) return;
  const idx = pageItems.findIndex((it) => it.id === itemId);
  if (idx === -1) return;
  const [removed] = pageItems.splice(idx, 1);
  if (pageItems.length === 0) {
    delete data.pages[normalisedUrl];
  }
  await saveDomainData(domain, data);
  await imageStore.deleteImage(removed.screenshotKey);
}

/** Import's replace-only semantics (§1.7): discard everything currently
 *  stored for `domain` — metadata and blobs alike — and install `data` in
 *  its place. The caller is responsible for having already written the
 *  incoming items' screenshots into imageStore before calling this (or
 *  immediately after — either order is safe since the two stores are keyed
 *  independently and screenshotKey values are unique to the import). */
export async function replaceDomainData(domain: string, data: DomainData): Promise<void> {
  const existing = await getDomainData(domain);
  if (existing) {
    await deleteAllBlobsIn(existing);
  }
  await saveDomainData(domain, data);
}

// ---------------------------------------------------------------------------
// Sidebar open/closed state (chrome.storage.session, keyed by tab id)
// ---------------------------------------------------------------------------
// §1.1 decision: chrome.storage.session (not .local) — survives a full page
// reload (content script re-injected, needs to know to re-show the sidebar)
// but clears on browser restart, which is the right lifetime for "is the
// sidebar open". (v1 kept this in chrome.storage.local under an
// `activeTab:{tabId}` key; nothing writes or reads those keys any more.)

function sidebarSessionKey(tabId: number): string {
  return `sidebarOpen:${tabId}`;
}

function sessionGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.session.get(keys, (result) => resolve(result));
  });
}

function sessionSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.set(items, () => resolve());
  });
}

function sessionRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.remove(keys, () => resolve());
  });
}

/** Mark a tab's sidebar as open. */
export async function setSidebarOpen(tabId: number): Promise<void> {
  await sessionSet({ [sidebarSessionKey(tabId)]: true });
}

/** Whether a tab's sidebar is currently marked open. */
export async function isSidebarOpen(tabId: number): Promise<boolean> {
  const key = sidebarSessionKey(tabId);
  const result = await sessionGet(key);
  return result[key] === true;
}

/** Clear a tab's sidebar state — called on explicit close and on tab removal. */
export async function clearSidebarState(tabId: number): Promise<void> {
  await sessionRemove(sidebarSessionKey(tabId));
}
