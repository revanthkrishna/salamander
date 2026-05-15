import {
  getDomainData,
  saveDomainData,
  clearDomainData,
  setTabActive,
  isTabActive,
  removeTabActive,
  getAnnotationCount,
  createFreshDomainData,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  getPageAnnotations,
  getNextPinNumber,
} from '../storage';
import type { DomainData, Annotation } from '../types';

// Build a minimal test annotation
const makeAnnotation = (pinNumber: number, overrides: Partial<Annotation> = {}): Annotation => ({
  pinNumber,
  note: `Note ${pinNumber}`,
  fingerprint: {
    cssSelector: `p:nth-of-type(${pinNumber})`,
    xpath: `/html/body/p[${pinNumber}]`,
    textSnippet: `text ${pinNumber}`,
    tagName: 'p',
  },
  offset: { x: 0, y: 0 },
  createdAt: new Date().toISOString(),
  ...overrides,
});

// Build a minimal DomainData object
const makeDomainData = (overrides: Partial<DomainData> = {}): DomainData => ({
  meta: {
    nextPinNumber: 1,
    importedFilename: null,
    wasImported: false,
    version: 1,
  },
  pages: {},
  ...overrides,
});

// ─── getDomainData / saveDomainData ──────────────────────────────────────────

describe('getDomainData / saveDomainData', () => {
  test('returns null for missing domain', async () => {
    const result = await getDomainData('nonexistent.com');
    expect(result).toBeNull();
  });

  test('saves and retrieves domain data', async () => {
    const data: DomainData = {
      meta: { nextPinNumber: 2, importedFilename: null, wasImported: false, version: 1 },
      pages: {
        'https://example.com': [makeAnnotation(1)],
      },
    };
    await saveDomainData('example.com', data);
    const retrieved = await getDomainData('example.com');
    expect(retrieved).toEqual(data);
  });

  test('overwriting domain data replaces previous', async () => {
    const data1 = makeDomainData({ pages: { 'https://example.com': [makeAnnotation(1)] } });
    const data2 = makeDomainData({ pages: { 'https://example.com/other': [makeAnnotation(2)] } });
    await saveDomainData('example.com', data1);
    await saveDomainData('example.com', data2);
    const retrieved = await getDomainData('example.com');
    expect(retrieved).toEqual(data2);
  });

  test('different domains are stored independently', async () => {
    const dataA = makeDomainData({ meta: { nextPinNumber: 1, importedFilename: null, wasImported: false, version: 1 }, pages: { 'https://alpha.com': [makeAnnotation(1)] } });
    const dataB = makeDomainData({ meta: { nextPinNumber: 1, importedFilename: null, wasImported: false, version: 1 }, pages: { 'https://beta.com': [makeAnnotation(2)] } });
    await saveDomainData('alpha.com', dataA);
    await saveDomainData('beta.com', dataB);
    expect(await getDomainData('alpha.com')).toEqual(dataA);
    expect(await getDomainData('beta.com')).toEqual(dataB);
  });
});

// ─── clearDomainData ─────────────────────────────────────────────────────────

describe('clearDomainData', () => {
  test('removes domain data', async () => {
    const data = createFreshDomainData();
    await saveDomainData('example.com', data);
    await clearDomainData('example.com');
    expect(await getDomainData('example.com')).toBeNull();
  });

  test('clearing non-existent domain is a no-op', async () => {
    await expect(clearDomainData('never-existed.com')).resolves.not.toThrow();
  });

  test('clearing one domain does not affect another', async () => {
    const dataA = createFreshDomainData();
    const dataB = createFreshDomainData();
    await saveDomainData('alpha.com', dataA);
    await saveDomainData('beta.com', dataB);
    await clearDomainData('alpha.com');
    expect(await getDomainData('alpha.com')).toBeNull();
    expect(await getDomainData('beta.com')).not.toBeNull();
  });
});

// ─── createFreshDomainData ───────────────────────────────────────────────────

describe('createFreshDomainData', () => {
  test('nextPinNumber starts at 1', () => {
    const data = createFreshDomainData();
    expect(data.meta.nextPinNumber).toBe(1);
  });

  test('importedFilename is null', () => {
    const data = createFreshDomainData();
    expect(data.meta.importedFilename).toBeNull();
  });

  test('wasImported is false', () => {
    const data = createFreshDomainData();
    expect(data.meta.wasImported).toBe(false);
  });

  test('pages is empty object', () => {
    const data = createFreshDomainData();
    expect(data.pages).toEqual({});
  });

  test('version is 1', () => {
    const data = createFreshDomainData();
    expect(data.meta.version).toBe(1);
  });
});

// ─── Tab activation state ────────────────────────────────────────────────────

describe('tab active state', () => {
  test('isTabActive returns false when not set', async () => {
    expect(await isTabActive(42)).toBe(false);
  });

  test('setTabActive marks tab as active', async () => {
    await setTabActive(42);
    expect(await isTabActive(42)).toBe(true);
  });

  test('removeTabActive removes the marker', async () => {
    await setTabActive(42);
    await removeTabActive(42);
    expect(await isTabActive(42)).toBe(false);
  });

  test('different tab IDs are independent', async () => {
    await setTabActive(1);
    await setTabActive(2);
    await removeTabActive(1);
    expect(await isTabActive(1)).toBe(false);
    expect(await isTabActive(2)).toBe(true);
  });
});

// ─── getAnnotationCount ──────────────────────────────────────────────────────

describe('getAnnotationCount', () => {
  test('returns 0 for unknown domain', async () => {
    expect(await getAnnotationCount('empty.com')).toBe(0);
  });

  test('counts annotations on a single page', async () => {
    const data = makeDomainData({
      pages: {
        'https://example.com/page': [makeAnnotation(1), makeAnnotation(2)],
      },
    });
    await saveDomainData('example.com', data);
    expect(await getAnnotationCount('example.com')).toBe(2);
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

  test('returns 0 for domain with empty pages', async () => {
    const data = makeDomainData({ pages: {} });
    await saveDomainData('example.com', data);
    expect(await getAnnotationCount('example.com')).toBe(0);
  });
});

// ─── getNextPinNumber ────────────────────────────────────────────────────────

describe('getNextPinNumber', () => {
  test('returns 1 for unknown domain', async () => {
    expect(await getNextPinNumber('unknown.com')).toBe(1);
  });

  test('returns stored nextPinNumber', async () => {
    const data = makeDomainData({ meta: { nextPinNumber: 5, importedFilename: null, wasImported: false, version: 1 } });
    await saveDomainData('example.com', data);
    expect(await getNextPinNumber('example.com')).toBe(5);
  });
});

// ─── addAnnotation ───────────────────────────────────────────────────────────

describe('addAnnotation', () => {
  test('adds annotation to storage', async () => {
    const ann = makeAnnotation(1);
    await addAnnotation('example.com', 'https://example.com/page', ann);
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toEqual(ann);
  });

  test('updates nextPinNumber to pinNumber + 1', async () => {
    const ann = makeAnnotation(3);
    await addAnnotation('example.com', 'https://example.com/page', ann);
    const data = await getDomainData('example.com');
    expect(data!.meta.nextPinNumber).toBe(4);
  });

  test('clears importedFilename (modified state)', async () => {
    const data = makeDomainData({
      meta: { nextPinNumber: 1, importedFilename: 'annotations-example_com.yaml', wasImported: true, version: 1 },
    });
    await saveDomainData('example.com', data);
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    const updated = await getDomainData('example.com');
    expect(updated!.meta.importedFilename).toBeNull();
  });

  test('multiple annotations on same page', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(2));
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations).toHaveLength(2);
  });

  test('annotations on different pages are stored separately', async () => {
    await addAnnotation('example.com', 'https://example.com/page1', makeAnnotation(1));
    await addAnnotation('example.com', 'https://example.com/page2', makeAnnotation(2));
    expect(await getPageAnnotations('example.com', 'https://example.com/page1')).toHaveLength(1);
    expect(await getPageAnnotations('example.com', 'https://example.com/page2')).toHaveLength(1);
  });
});

// ─── updateAnnotation ────────────────────────────────────────────────────────

describe('updateAnnotation', () => {
  test('updates note of existing annotation', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1, { note: 'original' }));
    await updateAnnotation('example.com', 'https://example.com/page', 1, 'updated note');
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations[0].note).toBe('updated note');
  });

  test('clears importedFilename on update', async () => {
    const data = makeDomainData({
      meta: { nextPinNumber: 2, importedFilename: 'file.yaml', wasImported: true, version: 1 },
      pages: { 'https://example.com/page': [makeAnnotation(1)] },
    });
    await saveDomainData('example.com', data);
    await updateAnnotation('example.com', 'https://example.com/page', 1, 'changed');
    const updated = await getDomainData('example.com');
    expect(updated!.meta.importedFilename).toBeNull();
  });

  test('is a no-op when pin number not found', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    await expect(
      updateAnnotation('example.com', 'https://example.com/page', 999, 'nope')
    ).resolves.not.toThrow();
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations[0].note).toBe('Note 1');
  });
});

// ─── deleteAnnotation ────────────────────────────────────────────────────────

describe('deleteAnnotation', () => {
  test('removes annotation by pin number', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(2));
    await deleteAnnotation('example.com', 1);
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations).toHaveLength(1);
    expect(annotations[0].pinNumber).toBe(2);
  });

  test('clears empty page entry after deletion', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    await deleteAnnotation('example.com', 1);
    const data = await getDomainData('example.com');
    expect(data!.pages['https://example.com/page']).toBeUndefined();
  });

  test('clears importedFilename on delete', async () => {
    const data = makeDomainData({
      meta: { nextPinNumber: 2, importedFilename: 'file.yaml', wasImported: true, version: 1 },
      pages: { 'https://example.com/page': [makeAnnotation(1)] },
    });
    await saveDomainData('example.com', data);
    await deleteAnnotation('example.com', 1);
    const updated = await getDomainData('example.com');
    expect(updated!.meta.importedFilename).toBeNull();
  });

  test('deleting non-existent pin is a no-op', async () => {
    await addAnnotation('example.com', 'https://example.com/page', makeAnnotation(1));
    await expect(deleteAnnotation('example.com', 999)).resolves.not.toThrow();
    const annotations = await getPageAnnotations('example.com', 'https://example.com/page');
    expect(annotations).toHaveLength(1);
  });

  test('deleting across pages (pin on page2)', async () => {
    await addAnnotation('example.com', 'https://example.com/page1', makeAnnotation(1));
    await addAnnotation('example.com', 'https://example.com/page2', makeAnnotation(2));
    await deleteAnnotation('example.com', 2);
    expect(await getPageAnnotations('example.com', 'https://example.com/page1')).toHaveLength(1);
    const data = await getDomainData('example.com');
    expect(data!.pages['https://example.com/page2']).toBeUndefined();
  });
});

// ─── getPageAnnotations ──────────────────────────────────────────────────────

describe('getPageAnnotations', () => {
  test('returns empty array for unknown domain', async () => {
    const result = await getPageAnnotations('unknown.com', 'https://unknown.com/page');
    expect(result).toEqual([]);
  });

  test('returns empty array for unknown page URL', async () => {
    const data = createFreshDomainData();
    await saveDomainData('example.com', data);
    const result = await getPageAnnotations('example.com', 'https://example.com/nonexistent');
    expect(result).toEqual([]);
  });

  test('returns annotations for the correct page', async () => {
    const data: DomainData = {
      meta: { nextPinNumber: 3, importedFilename: null, wasImported: false, version: 1 },
      pages: {
        'https://example.com/page1': [makeAnnotation(1)],
        'https://example.com/page2': [makeAnnotation(2)],
      },
    };
    await saveDomainData('example.com', data);
    const result = await getPageAnnotations('example.com', 'https://example.com/page1');
    expect(result).toHaveLength(1);
    expect(result[0].pinNumber).toBe(1);
  });
});
