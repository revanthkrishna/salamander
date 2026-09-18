// Mock chrome.storage.local/session and related APIs for Jest tests

// Phase 1: real IndexedDB implementation for storage.ts/imageStore.ts tests.
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
// whatever version manifest.json currently declares. Keeps the YAML
// salamander_version field tested against the real running version.
import * as fs from 'fs';
import * as path from 'path';
const manifestJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../manifest.json'), 'utf-8'),
);

// jsdom doesn't implement layout, so HTMLElement.offsetWidth/offsetHeight
// always return 0 — which makes fingerprint.ts's isVisible() treat every
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

function makeStorageAreaMock(data: Record<string, unknown>) {
  return {
    get: jest.fn((keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void) => {
      if (callback) {
        if (keys === null) {
          callback({ ...data });
          return;
        }
        const result: Record<string, unknown> = {};
        const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
        for (const k of keyArr) {
          if (k in data) result[k] = data[k];
        }
        callback(result);
      }
      return Promise.resolve(data);
    }),
    set: jest.fn((items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(data, items);
      if (callback) callback();
      return Promise.resolve();
    }),
    remove: jest.fn((keys: string | string[], callback?: () => void) => {
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      for (const k of keyArr) delete data[k];
      if (callback) callback();
      return Promise.resolve();
    }),
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  };
}

(global as any).chrome = {
  storage: {
    session: makeStorageAreaMock(sessionStorageData),
    local: {
      get: jest.fn((keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void) => {
        if (callback) {
          if (keys === null) {
            callback({ ...storageData });
            return;
          }
          const result: Record<string, unknown> = {};
          const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
          for (const k of keyArr) {
            if (k in storageData) result[k] = storageData[k];
          }
          callback(result);
        }
        return Promise.resolve(storageData);
      }),
      set: jest.fn((data: Record<string, unknown>, callback?: () => void) => {
        Object.assign(storageData, data);
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys: string | string[], callback?: () => void) => {
        const keyArr = typeof keys === 'string' ? [keys] : keys;
        for (const k of keyArr) delete storageData[k];
        if (callback) callback();
        return Promise.resolve();
      }),
      onChanged: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
    },
    onChanged: {
      addListener: jest.fn(),
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
  Object.keys(storageData).forEach(k => delete storageData[k]);
  Object.keys(sessionStorageData).forEach(k => delete sessionStorageData[k]);
  jest.clearAllMocks();

  // Re-wire mock implementations after clearAllMocks (which resets them)
  (chrome.storage.local.get as jest.Mock).mockImplementation(
    (keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void) => {
      if (callback) {
        if (keys === null) {
          callback({ ...storageData });
          return;
        }
        const result: Record<string, unknown> = {};
        const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
        for (const k of keyArr) {
          if (k in storageData) result[k] = storageData[k];
        }
        callback(result);
      }
      return Promise.resolve(storageData);
    }
  );

  (chrome.storage.local.set as jest.Mock).mockImplementation(
    (data: Record<string, unknown>, callback?: () => void) => {
      Object.assign(storageData, data);
      if (callback) callback();
      return Promise.resolve();
    }
  );

  (chrome.storage.local.remove as jest.Mock).mockImplementation(
    (keys: string | string[], callback?: () => void) => {
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      for (const k of keyArr) delete storageData[k];
      if (callback) callback();
      return Promise.resolve();
    }
  );
});
