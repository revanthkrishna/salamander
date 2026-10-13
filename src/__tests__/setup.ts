// Mock chrome.storage.local/session and related APIs for Jest tests

// Real IndexedDB implementation for storage.ts/imageStore.ts tests.
// Chrome extension service workers get a real IndexedDB; jsdom does not, so
// fake-indexeddb/auto installs one on the global object (indexedDB,
// IDBKeyRange, etc.) that behaves like the real thing.
import 'fake-indexeddb/auto';

// jsdom's test environment doesn't provide the global structuredClone that
// fake-indexeddb's put()/get() rely on internally (Node has it, but not
// every jsdom/Jest combination exposes it on the jsdom global). A JSON
// round-trip is a sufficient stand-in here: every value this extension ever
// stores in IndexedDB is a plain data-URL string.
if (typeof (global as any).structuredClone === 'undefined') {
  (global as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

// Read manifest version live so the chrome.runtime.getManifest() mock matches
// whatever version manifest.json currently declares. Keeps the version line
// in feedback.md's header tested against the real running version.
import * as fs from 'fs';
import * as path from 'path';
const manifestJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf-8'),
);

// jsdom doesn't implement layout, so HTMLElement.offsetWidth/offsetHeight
// always return 0 — which makes visibility checks (contextCapture.ts) treat every
// element in the document as invisible and disqualify it from resolution.
// Override the prototype getters to report non-zero dimensions for any
// element connected to the document.
if (typeof HTMLElement !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get(this: HTMLElement) {
      return this.ownerDocument?.contains(this) ? 100 : 0;
    },
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      return this.ownerDocument?.contains(this) ? 100 : 0;
    },
    configurable: true,
  });
}

// CSS.escape polyfill — jsdom does not implement this browser API
if (typeof (global as any).CSS === 'undefined') {
  (global as any).CSS = {
    escape: (value: string): string => {
      // Based on the W3C CSS.escape specification
      return value.replace(/([\0-\x1f\x7f]|^[\x80-\uFFFF\d]|[^\x80-\uFFFF\w-])/g, (char) => {
        const code = char.charCodeAt(0);
        if (code === 0) return '\uFFFD';
        if (code < 0x20 || code === 0x7f) return '\\' + code.toString(16) + ' ';
        return '\\' + char;
      });
    },
  };
}

const storageData: Record<string, unknown> = {};
const sessionStorageData: Record<string, unknown> = {};

/** Like the real chrome.storage: every value is copied on the way in and on
 *  the way out, so a caller mutating what it read (or what it wrote) never
 *  changes what is stored without a set() — a storage function that forgets
 *  its write fails its tests instead of passing on an aliased object. */
function copyOf<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** The keys a get() asks for: one, several, an object of defaults, or all. */
function pick(data: Record<string, unknown>, keys: string | string[] | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (keys === null || keys === undefined) return copyOf({ ...data });
  const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const result: Record<string, unknown> = {};
  for (const k of keyArr) {
    if (k in data) result[k] = copyOf(data[k]);
  }
  return result;
}

/** The three calls of a chrome.storage area over `data`, each answering
 *  asynchronously (a microtask later), as the real API does — so the service
 *  worker's save queue really does interleave under test. */
function storageAreaImpl(data: Record<string, unknown>) {
  return {
    get: (keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void) => {
      const result = pick(data, keys);
      if (callback) queueMicrotask(() => callback(result));
      return Promise.resolve(result);
    },
    set: (items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(data, copyOf(items));
      if (callback) queueMicrotask(() => callback());
      return Promise.resolve();
    },
    remove: (keys: string | string[], callback?: () => void) => {
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      for (const k of keyArr) delete data[k];
      if (callback) queueMicrotask(() => callback());
      return Promise.resolve();
    },
  };
}

function makeStorageAreaMock(data: Record<string, unknown>) {
  const impl = storageAreaImpl(data);
  return {
    get: jest.fn(impl.get),
    set: jest.fn(impl.set),
    remove: jest.fn(impl.remove),
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  };
}

/** Put the default implementations back on an area's mocks — after a test
 *  replaced one with mockImplementation(), say. */
function rewireStorageArea(area: { get: unknown; set: unknown; remove: unknown }, data: Record<string, unknown>): void {
  const impl = storageAreaImpl(data);
  (area.get as jest.Mock).mockImplementation(impl.get);
  (area.set as jest.Mock).mockImplementation(impl.set);
  (area.remove as jest.Mock).mockImplementation(impl.remove);
}

(global as any).chrome = {
  storage: {
    session: makeStorageAreaMock(sessionStorageData),
    local: makeStorageAreaMock(storageData),
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  tabs: {
    query: jest.fn(),
  },
  runtime: {
    lastError: null,
    getManifest: jest.fn(() => manifestJson),
  },
};

// Reset storage between tests
beforeEach(() => {
  // storage.ts rejects when chrome.runtime.lastError is set in a callback, so
  // a test that simulated a failure must never leak it into the next one
  // (several test files replace chrome.runtime wholesale, hence the guard).
  if ((global as any).chrome?.runtime) (global as any).chrome.runtime.lastError = null;
  Object.keys(storageData).forEach(k => delete storageData[k]);
  Object.keys(sessionStorageData).forEach(k => delete sessionStorageData[k]);
  jest.clearAllMocks();

  // A test may have swapped an implementation (mockImplementation persists
  // across clearAllMocks): put the defaults back on both areas.
  rewireStorageArea(chrome.storage.local, storageData);
  rewireStorageArea(chrome.storage.session, sessionStorageData);
});
