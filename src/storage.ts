// Storage layer — chrome.storage.local metadata, IndexedDB blobs
// (src/imageStore.ts), chrome.storage.session sidebar state and the
// pencil's colour.
//
// Layout in chrome.storage.local (schema version 2):
//   `domain:{domain}`     -> DomainIndex: { meta, pages: { normalisedUrl: id[] } }
//   `item:{domain}:{id}`  -> FeedbackItem (thumbnail data-URL inline)
//
// The split exists so the sidebar's list still paints from one round trip
// (an index read plus one multi-key get, thumbnail already inline per item)
// while an item write touches only that item's key and the small index. The
// alternative — every item of a domain inline in the one `domain:` record —
// meant a 700ms note autosave in a 150-item domain serialised several MB of
// JPEG through chrome.storage.local.set, and reading one URL's list read
// every other URL's thumbnails too. In memory, consumers still see the
// assembled DomainData shape: getDomainData() joins index and items, and
// replaceDomainData() takes one and splits it.
//
// There is no migration path from an older stored shape, on purpose: no
// build before this layout was ever released, so no such record exists in
// the wild. `version` below is stamped on every index anyway, so a FUTURE
// change has something to branch on.
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

import { DomainData, DomainIndex, FeedbackItem, ItemPatch } from './types';
import * as imageStore from './imageStore';

/** The schema version stamped on every domain index this build writes.
 *  Bump it the first time the stored shape changes, and add the matching
 *  step to readIndex below. Nothing reads it today — it is the hook a
 *  future migration needs, not evidence that one exists. */
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

/** Shape check for what `domain:{domain}` holds: an object with `meta` and
 *  `pages` objects. Only the top level is checked — the values are trusted
 *  as this build's own writes (or a newer build's, see readIndex). */
function isDomainIndex(raw: unknown): raw is DomainIndex {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<DomainIndex>;
  return !!r.meta && typeof r.meta === 'object' && !!r.pages && typeof r.pages === 'object';
}

/** The chrome.storage.local keys+values that store `data` for `domain`:
 *  the index plus one entry per item. The index is stamped with this
 *  build's version regardless of what `data.meta.version` says, so an
 *  index is always stamped with the shape it was actually written in. */
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
 * Whatever is under the key is taken as an index, including a record
 * stamped NEWER than this build (an extension downgrade): there is no way
 * to reshape that correctly, and refusing it would make the user's feedback
 * vanish rather than degrade. If the stored shape ever changes, this is
 * where the version branch goes.
 */
async function readIndex(domain: string): Promise<DomainIndex | null> {
  const key = domainKey(domain);
  const raw = (await storageGet(key))[key];
  return isDomainIndex(raw) ? raw : null;
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

// ---------------------------------------------------------------------------
// The pencil's colour (chrome.storage.session, one value for the browser)
// ---------------------------------------------------------------------------
// Design spec §AB: remembered until the browser closes, across reloads,
// pages and sites, and back to yellow in a fresh session — exactly
// chrome.storage.session's lifetime. One key for the whole browser, not per
// tab or domain. The value is validated by the caller (background.ts), so
// anything read back here is returned as-is.

const PEN_COLOR_SESSION_KEY = 'penColor';

/** The colour chosen earlier this browser session, or null if none yet. */
export async function getPenColor(): Promise<string | null> {
  const result = await sessionGet(PEN_COLOR_SESSION_KEY);
  const value = result[PEN_COLOR_SESSION_KEY];
  return typeof value === 'string' ? value : null;
}

export async function setPenColor(color: string): Promise<void> {
  await sessionSet({ [PEN_COLOR_SESSION_KEY]: color });
}
