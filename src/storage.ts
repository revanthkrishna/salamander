// Storage layer — chrome.storage.local metadata, IndexedDB blobs
// (src/imageStore.ts), chrome.storage.session sidebar state.
//
// Layout in chrome.storage.local (schema version 2):
//   `domain:{domain}`     -> DomainIndex: { meta, pages: { normalisedUrl: id[] } }
//   `item:{domain}:{id}`  -> FeedbackItem (thumbnail data-URL inline)
//
// Version 1 kept every item of a domain inline in the one `domain:` record,
// thumbnails included, so a 700ms note autosave in a 150-item domain
// serialised several MB of JPEG through chrome.storage.local.set, and
// reading one URL's list read every other URL's thumbnails too. Splitting
// the record keeps the property that decision was made for — the sidebar's
// list paints from one round trip (an index read + one multi-key get) with
// the thumbnail already inline per item — while an item write touches only
// that item's key and the (small) index. A v1 record is migrated the first
// time it is read (see readIndex). In memory, consumers still see the
// assembled DomainData shape: getDomainData() joins index and items, and
// saveDomainData()/replaceDomainData() take one and split it.
//
// Item ids are sequential across every URL of a domain (§1.2), tracked via
// DomainMeta.nextItemNumber in the index. Every read-modify-write here is
// still non-atomic, which is why background.ts serialises every call
// through one queue.
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

import { DomainData, DomainIndex, DomainMeta, FeedbackItem, ItemPatch } from './types';
import * as imageStore from './imageStore';

/** The schema version stamped on every domain index this build writes.
 *  Bump it the first time the stored shape changes, and add the matching
 *  step to migrateInlineRecord / readIndex below. */
export const STORAGE_VERSION = 2;

function domainKey(domain: string): string {
  return `domain:${domain}`;
}

function itemKey(domain: string, id: number): string {
  return `item:${domain}:${id}`;
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

function emptyIndex(): DomainIndex {
  return { meta: { nextItemNumber: 1, version: STORAGE_VERSION }, pages: {} };
}

// ---------------------------------------------------------------------------
// Schema migration + the split/assemble pair (all pure, all exported for the
// frozen-fixture tests)
// ---------------------------------------------------------------------------

function isRecordLike(raw: unknown): raw is { meta: Partial<DomainMeta>; pages: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<DomainData>;
  return !!r.meta && typeof r.meta === 'object' && !!r.pages && typeof r.pages === 'object';
}

function storedVersion(raw: { meta: Partial<DomainMeta> }): number {
  return typeof raw.meta.version === 'number' ? raw.meta.version : 0;
}

/**
 * Bring a legacy INLINE domain record (schema version 0/1: `pages` holding
 * the items themselves) up to the current in-memory DomainData shape. Pure,
 * so the version steps can be tested against frozen fixtures of what older
 * builds actually wrote. Returns null for anything that is not an inline
 * record at all.
 *
 * Each `case` is one version step and runs in sequence, so a record from
 * several versions back walks every step. The version-2 split is a change
 * of *stored* layout, not of the in-memory shape, so the step here is only
 * the stamp; splitDomainData() does the layout half when the result is
 * written back.
 */
export function migrateInlineRecord(raw: unknown): DomainData | null {
  if (!isRecordLike(raw)) return null;
  if (storedVersion(raw) >= 2) return null; // an index, not an inline record
  let data = raw as unknown as DomainData;
  switch (storedVersion(raw)) {
    case 0:
      // No version at all predates the stamp (or was hand-edited): the first
      // versioned shape.
      data = { ...data, meta: { ...data.meta, version: 1 } };
    // falls through
    case 1:
      data = { ...data, meta: { ...data.meta, version: 2 } };
      break;
  }
  return data;
}

/** The chrome.storage.local keys+values that store `data` for `domain`:
 *  the index plus one entry per item. The index is stamped with this
 *  build's version regardless of what `data.meta.version` says, so a
 *  caller can never write an index the next read would mistake for a
 *  legacy inline record. */
export function splitDomainData(domain: string, data: DomainData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pages: Record<string, number[]> = {};
  for (const [url, items] of Object.entries(data.pages)) {
    pages[url] = items.map((item) => item.id);
    for (const item of items) out[itemKey(domain, item.id)] = item;
  }
  const index: DomainIndex = {
    meta: { nextItemNumber: data.meta.nextItemNumber, version: STORAGE_VERSION },
    pages,
  };
  out[domainKey(domain)] = index;
  return out;
}

/** Join an index with the items it points at. An id whose item is missing
 *  (a torn write) is skipped rather than surfaced as `undefined`. */
export function assembleDomainData(
  domain: string,
  index: DomainIndex,
  stored: Record<string, unknown>,
): DomainData {
  const pages: Record<string, FeedbackItem[]> = {};
  for (const [url, ids] of Object.entries(index.pages)) {
    const items: FeedbackItem[] = [];
    for (const id of ids) {
      const item = stored[itemKey(domain, id)] as FeedbackItem | undefined;
      if (item) items.push(item);
    }
    pages[url] = items;
  }
  return { meta: { ...index.meta }, pages };
}

function itemKeysOf(domain: string, index: DomainIndex): string[] {
  return Object.values(index.pages)
    .flat()
    .map((id) => itemKey(domain, id));
}

/**
 * Read a domain's index, or null if nothing has been captured for it yet.
 * A legacy inline record (version 0/1) found here is migrated and written
 * back in the split layout, once — every later read finds the index. The
 * write-back happens inside whatever queue slot the caller holds
 * (background.ts serialises every storage call), so it cannot interleave
 * with another write. A record stamped NEWER than this build (an extension
 * downgrade) is read as an index as-is: there is no way to reshape it
 * correctly, and refusing it would make the user's feedback vanish rather
 * than degrade.
 */
async function readIndex(domain: string): Promise<DomainIndex | null> {
  const key = domainKey(domain);
  const raw = (await storageGet(key))[key];
  if (!isRecordLike(raw)) return null;
  if (storedVersion(raw) >= 2) return raw as unknown as DomainIndex;
  const data = migrateInlineRecord(raw);
  if (!data) return null;
  const split = splitDomainData(domain, data);
  await storageSet(split);
  return split[key] as DomainIndex;
}

// ---------------------------------------------------------------------------
// Domain CRUD
// ---------------------------------------------------------------------------

/** Read a domain's full record — index and every item joined into the
 *  DomainData shape — or null if nothing has been captured for it yet. */
export async function getDomainData(domain: string): Promise<DomainData | null> {
  const index = await readIndex(domain);
  if (!index) return null;
  const keys = itemKeysOf(domain, index);
  const stored = keys.length > 0 ? await storageGet(keys) : {};
  return assembleDomainData(domain, index, stored);
}

/** Write a domain's full record in the split layout. Low-level primitive —
 *  it does not remove item keys `data` no longer references; prefer
 *  addItem/updateItem/deleteItem/replaceDomainData for normal mutation. */
export async function saveDomainData(domain: string, data: DomainData): Promise<void> {
  await storageSet(splitDomainData(domain, data));
}

/** Delete a domain's record entirely — index, every item, every blob. */
export async function deleteDomainData(domain: string): Promise<void> {
  const index = await readIndex(domain);
  if (!index) return;
  const data = await getDomainData(domain);
  if (data) await deleteAllBlobsIn(data);
  await storageRemove([domainKey(domain), ...itemKeysOf(domain, index)]);
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
 *  capture order. Empty array if the domain or URL has nothing yet. One
 *  index read and one multi-key get — the other URLs' items (and their
 *  thumbnails) are never read. */
export async function getPageItems(
  domain: string,
  normalisedUrl: string,
): Promise<FeedbackItem[]> {
  const index = await readIndex(domain);
  const ids = index?.pages[normalisedUrl];
  if (!ids || ids.length === 0) return [];
  const keys = ids.map((id) => itemKey(domain, id));
  const stored = await storageGet(keys);
  return keys.map((k) => stored[k] as FeedbackItem | undefined).filter((it): it is FeedbackItem => !!it);
}

/** The id the *next* captured item for this domain should use. Monotonic
 *  across every URL of the domain (§1.2) — does not itself reserve the id;
 *  addItem() is what advances the counter. */
export async function getNextItemId(domain: string): Promise<number> {
  const index = await readIndex(domain);
  return index?.meta.nextItemNumber ?? 1;
}

/** Append a captured feedback item under its page's URL, creating the
 *  domain index if this is its first item. Advances nextItemNumber past
 *  the item's id so ids stay strictly increasing even if a caller supplies
 *  one out of the expected sequence. The item and the index land in one
 *  `set`, so a torn write cannot leave the index pointing at nothing. */
export async function addItem(domain: string, item: FeedbackItem): Promise<void> {
  const index = (await readIndex(domain)) ?? emptyIndex();
  const ids = index.pages[item.normalisedUrl] ?? [];
  index.pages[item.normalisedUrl] = [...ids, item.id];
  index.meta.nextItemNumber = Math.max(index.meta.nextItemNumber, item.id + 1);
  index.meta.version = STORAGE_VERSION;
  await storageSet({ [itemKey(domain, item.id)]: item, [domainKey(domain)]: index });
}

/**
 * Apply a partial update to one stored item (the enlarged view's autosave,
 * §1.5). `patch` is an ItemPatch (src/types.ts) — the one declaration of
 * which fields are mutable — so a new per-item field needs no new storage
 * function. Writes only that item's key: the index and every other item
 * are untouched. Resolves true if the item was found and written, false if
 * the domain, URL or item does not exist (nothing is written then).
 */
export async function updateItem(
  domain: string,
  normalisedUrl: string,
  itemId: number,
  patch: ItemPatch,
): Promise<boolean> {
  const index = await readIndex(domain);
  if (!index?.pages[normalisedUrl]?.includes(itemId)) return false;
  const key = itemKey(domain, itemId);
  const item = (await storageGet(key))[key] as FeedbackItem | undefined;
  if (!item) return false;
  await storageSet({ [key]: { ...item, ...patch } });
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
  const index = await readIndex(domain);
  if (!index) return;
  const ids = index.pages[normalisedUrl];
  if (!ids || !ids.includes(itemId)) return;
  const key = itemKey(domain, itemId);
  const removed = (await storageGet(key))[key] as FeedbackItem | undefined;
  const remaining = ids.filter((id) => id !== itemId);
  if (remaining.length === 0) {
    delete index.pages[normalisedUrl];
  } else {
    index.pages[normalisedUrl] = remaining;
  }
  await storageSet({ [domainKey(domain)]: index });
  await storageRemove(key);
  if (removed) await imageStore.deleteImage(removed.screenshotKey);
}

/** Import's replace-only semantics (§1.7): discard everything currently
 *  stored for `domain` — index, items and blobs alike — and install `data`
 *  in its place. The caller is responsible for having already written the
 *  incoming items' screenshots into imageStore before calling this (or
 *  immediately after — either order is safe since the two stores are keyed
 *  independently and screenshotKey values are unique to the import). The
 *  new record is written before the old item keys are removed, so a torn
 *  write leaves orphan item keys rather than an index with no items. */
export async function replaceDomainData(domain: string, data: DomainData): Promise<void> {
  const existingIndex = await readIndex(domain);
  const existing = existingIndex ? await getDomainData(domain) : null;
  if (existing) {
    await deleteAllBlobsIn(existing);
  }
  const split = splitDomainData(domain, data);
  await storageSet(split);
  if (existingIndex) {
    const stale = itemKeysOf(domain, existingIndex).filter((k) => !(k in split));
    if (stale.length > 0) await storageRemove(stale);
  }
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
