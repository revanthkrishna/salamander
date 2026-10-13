// Extension-origin IndexedDB wrapper for screenshot storage.
//
// Cross-cutting gotcha #1: IndexedDB opened from a content script belongs to
// the *page's* origin, not the extension's, and would be readable by the
// page and scattered per-site. This module is only ever imported by the
// service worker (extension origin) — content scripts reach it exclusively
// over chrome.runtime messages (gotcha #3).
//
// Design decision — representation: images are stored as data-URL strings,
// not native Blob objects, even though REQUIREMENTS.md's "Storage" section
// frames the ask as "IndexedDB for screenshot PNG blobs". Every hop that
// touches an image in this extension already deals in data-URL strings:
// chrome.tabs.captureVisibleTab returns one; chrome.runtime messages are
// JSON-serialised so Blob/ArrayBuffer can't cross the boundary anyway
// (gotcha #2); and chrome.downloads accepts a data: URL directly for export
// (gotcha #4). Converting to/from a native Blob would need FileReader
// (unavailable in a service worker's global scope) or manual
// arrayBuffer()->base64 plumbing, for no real benefit at this extension's
// storage volumes (unlimitedStorage is already granted). The intent behind
// "use IndexedDB, not chrome.storage.local" — keep large payloads out of the
// small, frequently-read metadata store — is satisfied regardless of which
// representation IndexedDB holds them in.

const DB_NAME = 'annotator-images';
const DB_VERSION = 1;
const STORE_NAME = 'screenshots';

/** The open connection, shared by every call. Forgotten — so the next call
 *  opens afresh — when the open fails, when the browser closes the
 *  connection on its own (site data cleared, a disk error), and when
 *  another context asks to upgrade the database (versionchange). Cached
 *  forever instead, one bad moment would fail every screenshot read and
 *  write until the service worker happened to restart. */
let dbPromise: Promise<IDBDatabase> | null = null;

function forget(connection: Promise<IDBDatabase>): void {
  if (dbPromise === connection) dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const connection: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => forget(connection);
      db.onversionchange = () => {
        db.close();
        forget(connection);
      };
      resolve(db);
    };
    req.onerror = () => {
      forget(connection);
      reject(req.error);
    };
  });
  dbPromise = connection;
  return connection;
}

/** Store (or overwrite) the full-resolution PNG data-URL for `key`. */
export async function putImage(key: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Fetch the full-resolution PNG data-URL for `key`, or null if absent. */
export async function getImage(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Delete the stored image for `key`. A no-op if the key doesn't exist. */
export async function deleteImage(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
