// Storage layer — chrome.storage.local metadata, IndexedDB blobs
// (src/imageStore.ts), chrome.storage.session sidebar state, the
// pencil's colour and the Option/Alt+N tip's counts.
//
// Layout in chrome.storage.local (schema version 2):
//   `domain:{domain}`     -> DomainIndex: { meta, pages: { normalisedUrl: id[] } }
//                            (meta.pageTitles: the pages the user renamed)
//   `item:{domain}:{id}`  -> FeedbackItem (thumbnail data-URL inline)
//   `addNoteTip`          -> the Option/Alt+N tip's install state (below)
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
// Item ids are sequential across every URL of a domain, tracked via
// DomainMeta.nextItemNumber in the index, and never reused. They are keys,
// not the numbers the user sees: a note's number is its position in its
// page's array (`pages[url]`, capture order), computed by whoever renders it
// and never written here (types.ts, FeedbackItem.id). Every read-modify-write
// here is still non-atomic, which is why background.ts serialises every call
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

import { DomainData, DomainIndex, DomainMeta, FeedbackItem, ItemPatch, SitePage } from './types';
import { AddNoteTipState, parseTipState } from './addNoteTip';
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
//
// A failed call (quota exceeded, a corrupt database) reports itself only
// through chrome.runtime.lastError inside the callback, so each helper
// rejects when it is set: a write or delete that did not happen must not
// look like one that did. Every caller is a background.ts handler whose
// catch turns the rejection into that message's existing error copy
// (export.ts's likewise). The session helpers further down are deliberately
// left as they are: the sidebar state and the pencil's colour are
// best-effort conveniences.
// ---------------------------------------------------------------------------

/** chrome.runtime.lastError as an Error, or null when the call succeeded. */
function localStorageError(): Error | null {
  const err = chrome.runtime?.lastError;
  return err ? new Error(err.message) : null;
}

function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = localStorageError();
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = localStorageError();
      if (err) reject(err);
      else resolve();
    });
  });
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = localStorageError();
      if (err) reject(err);
      else resolve();
    });
  });
}

/** storageRemove for keys nothing points at any more (an item key after its
 *  index entry is gone): failing to remove them leaves orphans, which cost
 *  space and nothing else, so it is logged rather than failing a write that
 *  has already landed. */
async function removeOrphans(keys: string | string[]): Promise<void> {
  try {
    await storageRemove(keys);
  } catch (err) {
    console.warn('[Annotator] could not remove unreferenced keys:', err);
  }
}

function emptyIndex(): DomainIndex {
  return { meta: { nextItemNumber: 1, version: STORAGE_VERSION }, pages: {} };
}

// ---------------------------------------------------------------------------
// The index's shape check and the split/assemble pair (pure; the pair is
// exported for storage.test.ts). There is no migration: see the banner and
// STORAGE_VERSION.
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
  const meta: DomainMeta = { nextItemNumber: data.meta.nextItemNumber, version: STORAGE_VERSION };
  // Only the names of pages that still have notes travel: a name outlives
  // its page's last note nowhere (design spec §AH).
  const titles = Object.entries(data.meta.pageTitles ?? {}).filter(([url]) => (pages[url]?.length ?? 0) > 0);
  if (titles.length > 0) meta.pageTitles = Object.fromEntries(titles);
  const index: DomainIndex = { meta, pages };
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
  const meta: DomainMeta = { ...index.meta };
  if (index.meta.pageTitles) meta.pageTitles = { ...index.meta.pageTitles };
  return { meta, pages };
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

/** How many items a domain holds, and across how many pages — read from the
 *  index alone, so no item (and no thumbnail) is loaded to answer it. Zeros
 *  when nothing has been captured for the domain. */
export async function getDomainCounts(domain: string): Promise<{ items: number; pages: number }> {
  const index = await readIndex(domain);
  if (!index) return { items: 0, pages: 0 };
  const lists = Object.values(index.pages).filter((ids) => ids.length > 0);
  return { items: lists.reduce((sum, ids) => sum + ids.length, 0), pages: lists.length };
}

/**
 * Every page of a domain that has notes, for the enlarged view (design spec
 * §AH): pages ordered by their first note's id — ids are allocated in
 * capture order, so that is the order the pages were first noted on, the
 * same order the export writes them in (src/bundle/v2.ts) — and each page's
 * notes in capture order, the order their numbers come from. Each page
 * carries its edited name, or null for its default. Empty when nothing has
 * been captured for the domain.
 */
export async function getSitePages(domain: string): Promise<SitePage[]> {
  const data = await getDomainData(domain);
  if (!data) return [];
  const titles = data.meta.pageTitles ?? {};
  return Object.entries(data.pages)
    .filter(([, items]) => items.length > 0)
    .sort(([, a], [, b]) => a[0].id - b[0].id)
    .map(([normalisedUrl, items]) => ({ normalisedUrl, editedTitle: titles[normalisedUrl] ?? null, items }));
}

/**
 * Give a page of a domain the name the user typed in the enlarged view
 * (design spec §AH), or — `title` null, empty or whitespace — clear it so
 * the page shows its default again. Stored trimmed, in the domain index's
 * `meta.pageTitles`, so it costs one small write and no item is touched.
 * Resolves false (writing nothing) when the page has no notes: a name only
 * exists alongside notes, and deleting a page's last note clears it.
 */
export async function setPageTitle(domain: string, normalisedUrl: string, title: string | null): Promise<boolean> {
  const index = await readIndex(domain);
  if (!index || !(index.pages[normalisedUrl]?.length)) return false;
  const name = title?.trim() ?? '';
  const titles = { ...(index.meta.pageTitles ?? {}) };
  if (name === '') delete titles[normalisedUrl];
  else titles[normalisedUrl] = name;
  setTitles(index.meta, titles);
  index.meta.version = STORAGE_VERSION;
  await storageSet({ [domainKey(domain)]: index });
  return true;
}

/** Write `titles` onto `meta`, dropping the key when nothing is left so an
 *  index with no renamed page looks exactly like one that never had one. */
function setTitles(meta: DomainMeta, titles: Record<string, string>): void {
  if (Object.keys(titles).length > 0) meta.pageTitles = titles;
  else delete meta.pageTitles;
}

/** Delete a domain's record entirely — index, every item, every blob. The
 *  keys go first and the screenshots after: a failed removal leaves every
 *  note with its screenshot, and a screenshot left behind once nothing
 *  points at it is an orphan (removeOrphanImages). */
export async function deleteDomainData(domain: string): Promise<void> {
  const index = await readIndex(domain);
  if (!index) return;
  const keys = itemKeysOf(domain, index);
  const screenshots = screenshotKeysIn(keys.length > 0 ? await storageGet(keys) : {}, keys);
  await storageRemove([domainKey(domain), ...keys]);
  await removeOrphanImages(screenshots);
}

/** The screenshot keys of the items stored under `keys` in `stored`. */
function screenshotKeysIn(stored: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const item = stored[k] as FeedbackItem | undefined;
    if (item) out.push(item.screenshotKey);
  }
  return out;
}

/** Delete screenshots nothing points at any more (their items are already
 *  gone from the record): like removeOrphans, a failure leaves orphans,
 *  which cost space and nothing else, so it is logged rather than failing
 *  a write that has already landed. Each is tried, whatever happens to the
 *  others. */
async function removeOrphanImages(keys: string[]): Promise<void> {
  const results = await Promise.allSettled(keys.map((k) => imageStore.deleteImage(k)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) console.warn('[Annotator] could not delete unreferenced screenshots:', failed[0].reason);
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

/** A page's edited name (design spec §AH), or null when it shows its
 *  default — from the index alone. */
export async function getPageTitle(domain: string, normalisedUrl: string): Promise<string | null> {
  const index = await readIndex(domain);
  return index?.meta.pageTitles?.[normalisedUrl] ?? null;
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
 *  Kept as the UPDATE_NOTE message's storage half. Resolves as updateItem
 *  does: false, writing nothing, if the item can't be found. */
export async function updateNote(
  domain: string,
  normalisedUrl: string,
  itemId: number,
  note: string,
): Promise<boolean> {
  return updateItem(domain, normalisedUrl, itemId, { note });
}

/** Remove an item and its screenshot blob (§1.5 — deleting a feedback item
 *  must not orphan its image). No-op if the item can't be found. Once the
 *  index write has landed the note is deleted: a key or a screenshot that
 *  cannot be removed after that is logged, never reported as a failed
 *  delete of a note that is already gone. */
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
    // The page's last note: its edited name goes with it, and the page is
    // back on its default if it is ever noted on again (design spec §AH).
    if (index.meta.pageTitles?.[normalisedUrl] !== undefined) {
      const titles = { ...index.meta.pageTitles };
      delete titles[normalisedUrl];
      setTitles(index.meta, titles);
    }
  } else {
    index.pages[normalisedUrl] = remaining;
  }
  await storageSet({ [domainKey(domain)]: index });
  // The index no longer points at the item: it is deleted as far as the
  // user can tell, whatever happens to its key and its screenshot.
  await removeOrphans(key);
  if (removed) await removeOrphanImages([removed.screenshotKey]);
}

/** Import's replace-only semantics (§1.7): discard everything currently
 *  stored for `domain` — index, items and blobs alike — and install `data`
 *  in its place. The caller has already written the incoming items'
 *  screenshots into imageStore (their keys are fresh, unique to the
 *  import). Order is what keeps a failure safe: the new record is written
 *  first, and only then are the old item keys and the old screenshots
 *  removed, so a failed write leaves the previous notes exactly as they
 *  were, screenshots included, and a failed clean-up leaves orphans (keys
 *  and images nothing points at) rather than notes without images. */
export async function replaceDomainData(domain: string, data: DomainData): Promise<void> {
  const existingIndex = await readIndex(domain);
  const oldKeys = existingIndex ? itemKeysOf(domain, existingIndex) : [];
  const oldScreenshots = screenshotKeysIn(oldKeys.length > 0 ? await storageGet(oldKeys) : {}, oldKeys);
  const split = splitDomainData(domain, data);
  await storageSet(split);
  // The new record has landed; the old keys and screenshots are orphans
  // already. A screenshot the new record still points at is kept.
  const stale = oldKeys.filter((k) => !(k in split));
  if (stale.length > 0) await removeOrphans(stale);
  const kept = new Set(Object.values(data.pages).flat().map((item) => item.screenshotKey));
  await removeOrphanImages(oldScreenshots.filter((k) => !kept.has(k)));
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

// ---------------------------------------------------------------------------
// The Option/Alt+N tip's counts (src/addNoteTip.ts)
// ---------------------------------------------------------------------------
// The session's single-click starts of add mode in chrome.storage.session
// (back to none when the browser restarts), and the install's tip state —
// how often it has shown, whether the shortcut has been used — in
// chrome.storage.local, under one key of its own that no domain operation
// (import, delete-all) ever touches; an uninstall clears it.

const ADD_NOTE_CLICKS_SESSION_KEY = 'addNoteClicks';
const ADD_NOTE_TIP_KEY = 'addNoteTip';

export async function getAddNoteClicks(): Promise<number> {
  const result = await sessionGet(ADD_NOTE_CLICKS_SESSION_KEY);
  const value = result[ADD_NOTE_CLICKS_SESSION_KEY];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function setAddNoteClicks(count: number): Promise<void> {
  await sessionSet({ [ADD_NOTE_CLICKS_SESSION_KEY]: count });
}

export async function getAddNoteTipState(): Promise<AddNoteTipState> {
  const result = await storageGet(ADD_NOTE_TIP_KEY);
  return parseTipState(result[ADD_NOTE_TIP_KEY]);
}

export async function setAddNoteTipState(state: AddNoteTipState): Promise<void> {
  await storageSet({ [ADD_NOTE_TIP_KEY]: state });
}
