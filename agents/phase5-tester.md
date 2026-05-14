# Phase 5 — Tester Agent

## Role & Persona

You are a QA engineer and test developer who writes clear, meaningful unit tests. You test behavior, not implementation. You use REQUIREMENTS.md as your test specification. You fix test failures before committing. You write a test plan that a human can use for manual browser testing.

## Before You Start

Read these files fully:
1. `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — source of truth (DO NOT MODIFY) — this is your test spec
2. `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — implementation details for test setup
3. All source files in `/root/.openclaw/workspace/annotator/src/`
4. `/root/.openclaw/workspace/annotator/REVIEW_1.md` — review findings (may affect test priorities)

## What You Produce

1. `/root/.openclaw/workspace/annotator/src/__tests__/urlNorm.test.ts` — URL normalization tests
2. `/root/.openclaw/workspace/annotator/src/__tests__/fingerprint.test.ts` — fingerprint tests (DOM mocked)
3. `/root/.openclaw/workspace/annotator/src/__tests__/importExport.test.ts` — import validation tests
4. `/root/.openclaw/workspace/annotator/src/__tests__/storage.test.ts` — storage helper tests (chrome mocked)
5. `/root/.openclaw/workspace/annotator/jest.config.js` — updated if needed
6. `/root/.openclaw/workspace/annotator/TEST_PLAN.md` — manual test plan for browser testing
7. `/root/.openclaw/workspace/annotator/TEST_RESULTS.md` — results of `npm test`

---

## Test Setup

### jest.config.js

Update to use `ts-jest` with jsdom environment (needed for DOM API tests):

```javascript
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterFramework: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    // Chrome APIs don't exist in jsdom — mock them
  },
  globals: {
    'ts-jest': {
      tsconfig: {
        strict: true,
      },
    },
  },
};
```

### `src/__tests__/setup.ts`

Mock Chrome APIs for tests:

```typescript
// Mock chrome.storage.local
const storageData: Record<string, unknown> = {};

(global as any).chrome = {
  storage: {
    local: {
      get: jest.fn((keys, callback?) => {
        if (callback) {
          if (keys === null) { callback({ ...storageData }); return; }
          const result: Record<string, unknown> = {};
          const keyArr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          for (const k of keyArr) {
            if (k in storageData) result[k] = storageData[k];
          }
          callback(result);
        }
        return Promise.resolve(storageData);
      }),
      set: jest.fn((data, callback?) => {
        Object.assign(storageData, data);
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, callback?) => {
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
});
```

---

## Test Files

### `src/__tests__/urlNorm.test.ts`

Test ALL normalization rules from REQUIREMENTS.md §6 and TECH_DESIGN.md §2.4:

```typescript
import { normaliseUrl, normaliseDomain, exportFilename } from '../urlNorm';

describe('normaliseUrl', () => {
  // Example from TECH_DESIGN.md §2.4
  test('full normalization example', () => {
    expect(normaliseUrl('http://www.figma.com/blog/How-We-Built-Figma?ref=twitter#intro'))
      .toBe('https://figma.com/blog/How-We-Built-Figma');
  });
  
  // §6 Edge Case #16: www prefix
  test('strips www. prefix', () => {
    expect(normaliseUrl('https://www.example.com/page'))
      .toBe('https://example.com/page');
  });
  
  // Does NOT strip non-www subdomains
  test('keeps non-www subdomains', () => {
    expect(normaliseUrl('https://app.example.com/page'))
      .toBe('https://app.example.com/page');
  });
  
  // §6 Edge Case #14: trailing slash
  test('strips trailing slash from path', () => {
    expect(normaliseUrl('https://example.com/page/'))
      .toBe('https://example.com/page');
  });
  
  test('handles root URL trailing slash', () => {
    expect(normaliseUrl('https://example.com/'))
      .toBe('https://example.com');
  });
  
  // §6 Edge Case #15: URL case sensitivity
  test('preserves path case', () => {
    expect(normaliseUrl('https://example.com/Blog/Post'))
      .toBe('https://example.com/Blog/Post');
  });
  
  test('lowercases hostname', () => {
    expect(normaliseUrl('https://EXAMPLE.COM/page'))
      .toBe('https://example.com/page');
  });
  
  // §6 Edge Case #8: http → https
  test('normalises http to https', () => {
    expect(normaliseUrl('http://example.com/page'))
      .toBe('https://example.com/page');
  });
  
  // §6 Edge Case #7: strips query params
  test('strips query parameters', () => {
    expect(normaliseUrl('https://example.com/page?foo=bar&baz=1'))
      .toBe('https://example.com/page');
  });
  
  // Strips fragment
  test('strips fragments', () => {
    expect(normaliseUrl('https://example.com/page#section'))
      .toBe('https://example.com/page');
  });
  
  // §6 Edge Case #17: port numbers
  test('ignores port numbers', () => {
    expect(normaliseUrl('https://example.com:8080/page'))
      .toBe('https://example.com/page');
  });
});

describe('normaliseDomain', () => {
  test('strips www.', () => {
    expect(normaliseDomain('www.figma.com')).toBe('figma.com');
  });
  
  test('keeps app subdomain', () => {
    expect(normaliseDomain('app.example.com')).toBe('app.example.com');
  });
  
  test('lowercases', () => {
    expect(normaliseDomain('EXAMPLE.COM')).toBe('example.com');
  });
  
  test('strips port', () => {
    expect(normaliseDomain('example.com:3000')).toBe('example.com');
  });
});

describe('exportFilename', () => {
  test('replaces dots with underscores', () => {
    expect(exportFilename('figma.com')).toBe('annotations-figma_com.yaml');
  });
  
  test('multi-part domain', () => {
    expect(exportFilename('app.example.com')).toBe('annotations-app_example_com.yaml');
  });
});
```

### `src/__tests__/fingerprint.test.ts`

Test CSS selector and XPath generation using jsdom:

```typescript
import { captureFingerprint, resolveElement } from '../fingerprint';

describe('buildCSSSelector', () => {
  beforeEach(() => {
    // Reset document
    document.body.innerHTML = '';
  });
  
  test('uses ID when available', () => {
    document.body.innerHTML = '<div id="main"><p id="target">text</p></div>';
    const el = document.getElementById('target')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toBe('#target');
  });
  
  test('uses data-testid when available', () => {
    document.body.innerHTML = '<div><button data-testid="submit-btn">Submit</button></div>';
    const el = document.querySelector('[data-testid="submit-btn"]')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).toContain('data-testid');
  });
  
  test('falls back to nth-of-type', () => {
    document.body.innerHTML = '<div><p>one</p><p>two</p><p id="tp3">three</p></div>';
    const el = document.querySelector('div > p:nth-of-type(3)')!;
    const fp = captureFingerprint(el);
    // Should NOT use ID (p doesn't have one), should use nth-of-type
    expect(fp.cssSelector).toContain('nth-of-type(3)');
  });
  
  test('rejects UUID data attribute as unstable', () => {
    document.body.innerHTML = '<button data-testid="3f8c5a1b-1234-1234-1234-1234567890ab">btn</button>';
    const el = document.querySelector('button')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).not.toContain('data-testid');
  });
  
  test('rejects purely numeric data attribute as unstable', () => {
    document.body.innerHTML = '<button data-id="12345">btn</button>';
    const el = document.querySelector('button')!;
    const fp = captureFingerprint(el);
    expect(fp.cssSelector).not.toContain('data-id');
  });
});

describe('resolveElement (round-trip)', () => {
  test('CSS selector round-trip', () => {
    document.body.innerHTML = '<div id="content"><p>Hello world</p></div>';
    const el = document.querySelector('#content > p')!;
    const fp = captureFingerprint(el);
    const resolved = resolveElement(fp);
    expect(resolved).toBe(el);
  });
  
  test('XPath fallback when selector not unique', () => {
    // Create a scenario where CSS selector matches multiple — should fall to XPath
    document.body.innerHTML = '<div><p>text</p></div><div><p>text</p></div>';
    const el = document.querySelectorAll('div > p')[1]!;
    const fp = captureFingerprint(el);
    fp.cssSelector = 'div > p'; // force a non-unique selector
    const resolved = resolveElement(fp);
    // XPath should still find the right element
    expect(resolved).not.toBeNull();
  });
  
  test('returns null for non-existent element', () => {
    const fp = {
      cssSelector: '#nonexistent-xyz-123',
      xpath: '/html/body/div[999]/p',
      textSnippet: '',
      tagName: 'p',
    };
    expect(resolveElement(fp)).toBeNull();
  });
  
  test('text content fallback', () => {
    document.body.innerHTML = '<section><p>The quick brown fox</p></section>';
    const el = document.querySelector('p')!;
    const fp = captureFingerprint(el);
    fp.cssSelector = '#nonexistent'; // force fallback
    fp.xpath = '/html/body/invalid[999]'; // force XPath to fail too
    const resolved = resolveElement(fp);
    expect(resolved).toBe(el);
  });
});
```

### `src/__tests__/importExport.test.ts`

Test import validation (not the full pipeline — just YAML parsing and schema validation):

```typescript
import { importFile } from '../importExport';

// We test importFile with mocked callbacks

const makeCallbacks = (overrides = {}) => ({
  showConfirm: jest.fn().mockResolvedValue(true),
  getAnnotationCount: jest.fn().mockResolvedValue(0),
  getCurrentDomain: jest.fn().mockReturnValue('example.com'),
  onImportSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  ...overrides,
});

function makeFile(content: string, name = 'test.yaml', type = 'text/yaml'): File {
  return new File([content], name, { type });
}

const validYaml = `
version: 1
exported_at: "2026-05-14T00:00:00.000Z"
domain: "example.com"
annotations:
  - pin_number: 1
    page_url: "https://example.com/page"
    note: "test note"
    fingerprint:
      css_selector: "#main > p"
      xpath: "/html/body/p"
      text_snippet: "test"
      tag_name: "p"
    offset:
      x: 10
      y: 20
    created_at: "2026-05-14T00:00:00.000Z"
`;

describe('importFile - error handling', () => {
  test('rejects wrong file type', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('content', 'test.json'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid file type')
    );
  });
  
  test('rejects empty file', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('empty')
    );
  });
  
  test('rejects malformed YAML', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile(': : invalid yaml {{{{', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('corrupted or incorrectly formatted')
    );
  });
  
  test('rejects wrong schema', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile('name: "not an annotator file"', 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining("doesn't look like an Annotator file")
    );
  });
  
  test('rejects empty annotations array', async () => {
    const cb = makeCallbacks();
    const yaml = 'version: 1\ndomain: "example.com"\nannotations: []\nexported_at: "2026-05-14T00:00:00Z"';
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('no annotations')
    );
  });
  
  test('rejects domain mismatch', async () => {
    const cb = makeCallbacks({ getCurrentDomain: () => 'other.com' });
    await importFile(makeFile(validYaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('example.com')
    );
  });
  
  test('rejects duplicate pin numbers', async () => {
    const cb = makeCallbacks();
    const yaml = `
version: 1
exported_at: "2026-05-14T00:00:00Z"
domain: "example.com"
annotations:
  - pin_number: 1
    page_url: "https://example.com/"
    note: "first"
    fingerprint:
      css_selector: "p"
      xpath: "/html/body/p"
      text_snippet: ""
      tag_name: "p"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
  - pin_number: 1
    page_url: "https://example.com/"
    note: "duplicate!"
    fingerprint:
      css_selector: "p"
      xpath: "/html/body/p"
      text_snippet: ""
      tag_name: "p"
    offset: {x: 0, y: 0}
    created_at: "2026-05-14T00:00:00Z"
`;
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining('duplicate pin numbers')
    );
  });
  
  test('shows warning for version mismatch but continues', async () => {
    const cb = makeCallbacks();
    const yaml = validYaml.replace('version: 1', 'version: 99');
    await importFile(makeFile(yaml, 'test.yaml'), cb);
    expect(cb.showWarning).toHaveBeenCalledWith(
      expect.stringContaining('newer version')
    );
    expect(cb.onImportSuccess).toHaveBeenCalled();
  });
  
  test('shows confirmation when annotations exist', async () => {
    const cb = makeCallbacks({ getAnnotationCount: jest.fn().mockResolvedValue(5) });
    await importFile(makeFile(validYaml, 'test.yaml'), cb);
    expect(cb.showConfirm).toHaveBeenCalledWith(
      expect.stringContaining('replace')
    );
  });
  
  test('aborts if user cancels confirmation', async () => {
    const cb = makeCallbacks({
      getAnnotationCount: jest.fn().mockResolvedValue(3),
      showConfirm: jest.fn().mockResolvedValue(false),
    });
    await importFile(makeFile(validYaml, 'test.yaml'), cb);
    expect(cb.onImportSuccess).not.toHaveBeenCalled();
  });
  
  test('succeeds with valid file', async () => {
    const cb = makeCallbacks();
    await importFile(makeFile(validYaml, 'annotations-example_com.yaml'), cb);
    expect(cb.onImportSuccess).toHaveBeenCalledWith('annotations-example_com.yaml');
    expect(cb.showError).not.toHaveBeenCalled();
  });
});
```

### `src/__tests__/storage.test.ts`

Test key storage operations:

```typescript
import {
  getDomainData, saveDomainData, clearDomainData,
  setTabActive, isTabActive, removeTabActive,
  getAnnotationCount, createFreshDomainData,
} from '../storage';
import type { DomainData } from '../types';

const makeAnnotation = (pinNumber: number) => ({
  pinNumber,
  note: `Note ${pinNumber}`,
  fingerprint: { cssSelector: 'p', xpath: '/html/body/p', textSnippet: 'text', tagName: 'p' },
  offset: { x: 0, y: 0 },
  createdAt: new Date().toISOString(),
});

describe('getDomainData / saveDomainData', () => {
  test('returns null for missing domain', async () => {
    const result = await getDomainData('nonexistent.com');
    expect(result).toBeNull();
  });
  
  test('saves and retrieves domain data', async () => {
    const data: DomainData = {
      meta: { nextPinNumber: 1, importedFilename: null, wasImported: false, version: 1 },
      pages: {
        'https://example.com': [makeAnnotation(1)],
      },
    };
    await saveDomainData('example.com', data);
    const retrieved = await getDomainData('example.com');
    expect(retrieved).toEqual(data);
  });
});

describe('clearDomainData', () => {
  test('removes domain data', async () => {
    const data = createFreshDomainData();
    await saveDomainData('example.com', data);
    await clearDomainData('example.com');
    expect(await getDomainData('example.com')).toBeNull();
  });
});

describe('tab active state', () => {
  test('setTabActive / isTabActive / removeTabActive', async () => {
    expect(await isTabActive(42)).toBe(false);
    await setTabActive(42);
    expect(await isTabActive(42)).toBe(true);
    await removeTabActive(42);
    expect(await isTabActive(42)).toBe(false);
  });
});

describe('getAnnotationCount', () => {
  test('returns 0 for empty domain', async () => {
    expect(await getAnnotationCount('empty.com')).toBe(0);
  });
  
  test('counts across all pages', async () => {
    const data: DomainData = {
      meta: { nextPinNumber: 4, importedFilename: null, wasImported: false, version: 1 },
      pages: {
        'https://example.com/page1': [makeAnnotation(1), makeAnnotation(2)],
        'https://example.com/page2': [makeAnnotation(3)],
      },
    };
    await saveDomainData('example.com', data);
    expect(await getAnnotationCount('example.com')).toBe(3);
  });
});
```

---

## TEST_PLAN.md

Write a manual browser test plan covering:

1. **Basic annotation flow** — create, edit, delete annotations
2. **Export flow** — export, verify YAML file contents
3. **Import flow** — import the exported file, verify pins appear
4. **Delete All** — verify confirmation, verify all pins gone
5. **Reload persistence** — annotate, reload page, verify toolbar reappears
6. **SPA navigation** — test on a React app (e.g. react.dev), navigate between pages
7. **Cross-tab sync** — open same domain in two tabs, annotate in one, verify pins appear in other
8. **Import error cases** — test each error case manually
9. **Fixed-position elements** — annotate a sticky header, scroll, verify pin stays anchored
10. **Pin numbering** — create pins 1-3, delete 2, create new → should be pin 4

---

## Run Tests

```bash
cd /root/.openclaw/workspace/annotator && npm test
```

If tests fail:
1. Read the error output
2. Fix the test OR fix the source code if the source has a bug
3. Re-run until all pass
4. Document any failures you couldn't fix in TEST_RESULTS.md

---

## TEST_RESULTS.md Format

```markdown
# Test Results

**Date:** [today]
**Command:** npm test

## Summary

- Total tests: X
- Passed: X
- Failed: X
- Skipped: X

## Failures (if any)

### [Test name]
- **Error:** [error message]
- **Status:** [Fixed / Known issue / Deferred]

## Notes

[Any observations about test coverage or gaps]
```

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 5: Unit tests, TEST_PLAN.md, TEST_RESULTS.md — npm test passes" && git push
```
