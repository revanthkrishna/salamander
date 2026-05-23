// Mock chrome.storage.local and related APIs for Jest tests

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

(global as any).chrome = {
  storage: {
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
  },
};

// Reset storage between tests
beforeEach(() => {
  Object.keys(storageData).forEach(k => delete storageData[k]);
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
