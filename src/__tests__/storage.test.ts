// Phase 1: storage layer tests — domain CRUD, orphan-blob prevention, id
// monotonicity across URLs, and sidebar session-state round trip.

import {
  addItem,
  deleteItem,
  migrateInlineRecord,
  splitDomainData,
  assembleDomainData,
  STORAGE_VERSION,
  updateItem,
  updateNote,
  getPageItems,
  getNextItemId,
  getDomainData,
  replaceDomainData,
  deleteDomainData,
  setSidebarOpen,
  isSidebarOpen,
  clearSidebarState,
} from '../storage';
import * as imageStore from '../imageStore';
import { CapturedContext, FeedbackItem } from '../types';

function makeContext(): CapturedContext {
  return {
    primaryTarget: {
      cssSelector: '#main > div',
      xpath: '//*[@id="main"]/div',
      outerHtmlSnippet: '<div id="main"></div>',
      truncated: false,
    },
    containedElements: [],
    areaText: 'hello world',
    pageMeta: {
      url: 'https://example.com/page',
      normalisedUrl: 'https://example.com/page',
      title: 'example',
      viewport: { width: 1280, height: 800 },
      dpr: 1,
      selectionRect: { x: 0, y: 0, width: 200, height: 150 },
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  const id = overrides.id ?? 1;
  return {
    id,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: 'note text',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 200, height: 150 },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: `shot-${id}`,
    thumbnailDataUrl: 'data:image/png;base64,thumb',
    context: makeContext(),
    ...overrides,
  };
}

const DOMAIN = 'example.com';

async function seedImage(key: string, value = 'data:image/png;base64,full'): Promise<void> {
  await imageStore.putImage(key, value);
}

describe('storage.ts — domain/item CRUD', () => {
  test('getDomainData returns null for an unknown domain', async () => {
    expect(await getDomainData('nope.example')).toBeNull();
  });

  test('addItem creates the domain record on first write', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);

    const data = await getDomainData(DOMAIN);
    expect(data).not.toBeNull();
    expect(data!.meta.nextItemNumber).toBe(2);
    expect(data!.pages[item.normalisedUrl]).toEqual([item]);
  });

  test('getPageItems returns items for a URL and [] for URLs with none', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);

    expect(await getPageItems(DOMAIN, item.normalisedUrl)).toEqual([item]);
    expect(await getPageItems(DOMAIN, 'https://example.com/other')).toEqual([]);
    expect(await getPageItems('unknown.example', item.normalisedUrl)).toEqual([]);
  });

  test('updateNote edits only the targeted item', async () => {
    const a = makeItem({ id: 1 });
    const b = makeItem({ id: 2 });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);

    await updateNote(DOMAIN, a.normalisedUrl, 2, 'edited note');

    const items = await getPageItems(DOMAIN, a.normalisedUrl);
    expect(items.find((i) => i.id === 1)!.note).toBe('note text');
    expect(items.find((i) => i.id === 2)!.note).toBe('edited note');
  });

  test('updateItem applies a patch to the targeted item only and reports it was found', async () => {
    const a = makeItem({ id: 1 });
    const b = makeItem({ id: 2 });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);

    await expect(updateItem(DOMAIN, a.normalisedUrl, 2, { note: 'patched' })).resolves.toBe(true);

    const items = await getPageItems(DOMAIN, a.normalisedUrl);
    expect(items.find((i) => i.id === 1)).toEqual(a);
    expect(items.find((i) => i.id === 2)).toEqual({ ...b, note: 'patched' });
  });

  test('updateItem reports false and writes nothing for a missing domain, URL or item', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);
    (chrome.storage.local.set as jest.Mock).mockClear();

    await expect(updateItem('nope.example', item.normalisedUrl, 1, { note: 'x' })).resolves.toBe(false);
    await expect(updateItem(DOMAIN, 'https://example.com/other', 1, { note: 'x' })).resolves.toBe(false);
    await expect(updateItem(DOMAIN, item.normalisedUrl, 999, { note: 'x' })).resolves.toBe(false);

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((await getPageItems(DOMAIN, item.normalisedUrl))[0].note).toBe('note text');
  });

  test('updateNote is a no-op for an item that does not exist', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);

    await expect(updateNote(DOMAIN, item.normalisedUrl, 999, 'x')).resolves.toBeUndefined();
    expect((await getPageItems(DOMAIN, item.normalisedUrl))[0].note).toBe('note text');
  });

  test('deleteItem removes the record and its blob (no orphaned images)', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);

    expect(await imageStore.getImage(item.screenshotKey)).not.toBeNull();

    await deleteItem(DOMAIN, item.normalisedUrl, item.id);

    expect(await getPageItems(DOMAIN, item.normalisedUrl)).toEqual([]);
    expect(await imageStore.getImage(item.screenshotKey)).toBeNull();
  });

  test('deleteItem cleans up an emptied page entry but leaves other pages/domain intact', async () => {
    const a = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    const b = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);

    await deleteItem(DOMAIN, a.normalisedUrl, a.id);

    const data = await getDomainData(DOMAIN);
    expect(data!.pages[a.normalisedUrl]).toBeUndefined();
    expect(data!.pages[b.normalisedUrl]).toEqual([b]);
  });

  test('deleteItem is a no-op for a missing domain/URL/item', async () => {
    await expect(deleteItem('nope.example', '/x', 1)).resolves.toBeUndefined();

    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);
    await expect(deleteItem(DOMAIN, item.normalisedUrl, 999)).resolves.toBeUndefined();
    expect(await getPageItems(DOMAIN, item.normalisedUrl)).toHaveLength(1);
  });

  test('getNextItemId is monotonic across different URLs of the same domain', async () => {
    expect(await getNextItemId(DOMAIN)).toBe(1);

    const a = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    await seedImage(a.screenshotKey);
    await addItem(DOMAIN, a);
    expect(await getNextItemId(DOMAIN)).toBe(2);

    // A second, entirely different URL on the same domain continues the
    // sequence rather than restarting at 1 (§1.2 — ids are global per domain).
    const b = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, b);
    expect(await getNextItemId(DOMAIN)).toBe(3);
  });

  test('deleteDomainData removes all items and blobs across every URL', async () => {
    const a = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    const b = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);

    await deleteDomainData(DOMAIN);

    expect(await getDomainData(DOMAIN)).toBeNull();
    expect(await imageStore.getImage(a.screenshotKey)).toBeNull();
    expect(await imageStore.getImage(b.screenshotKey)).toBeNull();
  });

  test('replaceDomainData discards the old blobs and installs the new record wholesale', async () => {
    const old = makeItem({ id: 1, screenshotKey: 'old-shot' });
    await seedImage(old.screenshotKey);
    await addItem(DOMAIN, old);

    const incoming = makeItem({ id: 7, screenshotKey: 'new-shot' });
    await seedImage(incoming.screenshotKey, 'data:image/png;base64,new');
    await replaceDomainData(DOMAIN, {
      meta: { nextItemNumber: 8, version: 1 },
      pages: { [incoming.normalisedUrl]: [incoming] },
    });

    expect(await imageStore.getImage(old.screenshotKey)).toBeNull();
    expect(await imageStore.getImage(incoming.screenshotKey)).not.toBeNull();

    const data = await getDomainData(DOMAIN);
    expect(data!.pages[incoming.normalisedUrl]).toEqual([incoming]);
    expect(data!.meta.nextItemNumber).toBe(8);
  });

  test('replaceDomainData works even when nothing existed for the domain before', async () => {
    const incoming = makeItem({ id: 1 });
    await seedImage(incoming.screenshotKey);

    await expect(
      replaceDomainData('fresh.example', {
        meta: { nextItemNumber: 2, version: 1 },
        pages: { [incoming.normalisedUrl]: [incoming] },
      }),
    ).resolves.toBeUndefined();

    expect((await getDomainData('fresh.example'))!.pages[incoming.normalisedUrl]).toEqual([
      incoming,
    ]);
  });
});

describe('storage.ts — the split layout (schema version 2)', () => {
  const URL_A = 'https://example.com/a';
  const URL_B = 'https://example.com/b';

  /** Every chrome.storage.local.set call's keys since the last mockClear. */
  function setCalls(): string[][] {
    return (chrome.storage.local.set as jest.Mock).mock.calls.map((c) => Object.keys(c[0]).sort());
  }
  function getCalls(): Array<string | string[] | null> {
    return (chrome.storage.local.get as jest.Mock).mock.calls.map((c) => c[0]);
  }
  async function rawStorage(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => chrome.storage.local.get(null, resolve));
  }

  test('addItem writes the item under its own key and the index under the domain key, in one set', async () => {
    const item = makeItem({ id: 1, normalisedUrl: URL_A });
    await seedImage(item.screenshotKey);
    (chrome.storage.local.set as jest.Mock).mockClear();

    await addItem(DOMAIN, item);

    expect(setCalls()).toEqual([[`domain:${DOMAIN}`, `item:${DOMAIN}:1`]]);
    const raw = await rawStorage();
    expect(raw[`item:${DOMAIN}:1`]).toEqual(item);
    expect(raw[`domain:${DOMAIN}`]).toEqual({
      meta: { nextItemNumber: 2, version: STORAGE_VERSION },
      pages: { [URL_A]: [1] },
    });
  });

  test('updateItem rewrites only the item key — the index and other items are untouched', async () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    const b = makeItem({ id: 2, normalisedUrl: URL_A });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);
    (chrome.storage.local.set as jest.Mock).mockClear();

    await updateItem(DOMAIN, URL_A, 2, { note: 'patched' });

    expect(setCalls()).toEqual([[`item:${DOMAIN}:2`]]);
    const raw = await rawStorage();
    expect((raw[`item:${DOMAIN}:2`] as FeedbackItem).note).toBe('patched');
    expect(raw[`item:${DOMAIN}:1`]).toEqual(a);
  });

  test('getPageItems reads the index and only that URL\'s item keys', async () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    const b = makeItem({ id: 2, normalisedUrl: URL_B });
    const c = makeItem({ id: 3, normalisedUrl: URL_A });
    for (const it of [a, b, c]) {
      await seedImage(it.screenshotKey);
      await addItem(DOMAIN, it);
    }
    (chrome.storage.local.get as jest.Mock).mockClear();

    expect(await getPageItems(DOMAIN, URL_A)).toEqual([a, c]);

    expect(getCalls()).toEqual([`domain:${DOMAIN}`, [`item:${DOMAIN}:1`, `item:${DOMAIN}:3`]]);
  });

  test('getPageItems skips an id whose item key is missing (a torn write) rather than returning a hole', async () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    await seedImage(a.screenshotKey);
    await addItem(DOMAIN, a);
    await new Promise<void>((resolve) => chrome.storage.local.set({
      [`domain:${DOMAIN}`]: { meta: { nextItemNumber: 3, version: STORAGE_VERSION }, pages: { [URL_A]: [1, 2] } },
    }, resolve));

    expect(await getPageItems(DOMAIN, URL_A)).toEqual([a]);
    expect((await getDomainData(DOMAIN))!.pages[URL_A]).toEqual([a]);
  });

  test('deleteItem drops the item key and its blob, and the URL from the index once it is empty', async () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    await seedImage(a.screenshotKey);
    await addItem(DOMAIN, a);

    await deleteItem(DOMAIN, URL_A, 1);

    const raw = await rawStorage();
    expect(raw[`item:${DOMAIN}:1`]).toBeUndefined();
    expect((raw[`domain:${DOMAIN}`] as { pages: unknown }).pages).toEqual({});
    expect(await imageStore.getImage(a.screenshotKey)).toBeNull();
  });

  test('replaceDomainData removes the item keys the new record no longer references', async () => {
    const old1 = makeItem({ id: 1, screenshotKey: 'old-1' });
    const old2 = makeItem({ id: 2, screenshotKey: 'old-2' });
    await seedImage('old-1');
    await seedImage('old-2');
    await addItem(DOMAIN, old1);
    await addItem(DOMAIN, old2);

    const incoming = makeItem({ id: 2, screenshotKey: 'new-2' });
    await seedImage('new-2');
    await replaceDomainData(DOMAIN, {
      meta: { nextItemNumber: 3, version: 1 }, // a stale version in the input is not written through
      pages: { [incoming.normalisedUrl]: [incoming] },
    });

    const raw = await rawStorage();
    expect(Object.keys(raw).sort()).toEqual([`domain:${DOMAIN}`, `item:${DOMAIN}:2`]);
    expect(raw[`item:${DOMAIN}:2`]).toEqual(incoming);
    expect((raw[`domain:${DOMAIN}`] as { meta: unknown }).meta).toEqual({ nextItemNumber: 3, version: STORAGE_VERSION });
    expect(await imageStore.getImage('old-1')).toBeNull();
    expect(await imageStore.getImage('old-2')).toBeNull();
  });

  test('deleteDomainData removes the index and every item key', async () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    const b = makeItem({ id: 2, normalisedUrl: URL_B });
    await seedImage(a.screenshotKey);
    await seedImage(b.screenshotKey);
    await addItem(DOMAIN, a);
    await addItem(DOMAIN, b);

    await deleteDomainData(DOMAIN);

    expect(await rawStorage()).toEqual({});
  });

  test('splitDomainData / assembleDomainData are inverses', () => {
    const a = makeItem({ id: 1, normalisedUrl: URL_A });
    const b = makeItem({ id: 2, normalisedUrl: URL_B });
    const c = makeItem({ id: 3, normalisedUrl: URL_A });
    const data = { meta: { nextItemNumber: 4, version: STORAGE_VERSION }, pages: { [URL_A]: [a, c], [URL_B]: [b] } };

    const split = splitDomainData(DOMAIN, data);
    const index = split[`domain:${DOMAIN}`] as Parameters<typeof assembleDomainData>[1];
    expect(index).toEqual({ meta: data.meta, pages: { [URL_A]: [1, 3], [URL_B]: [2] } });
    expect(assembleDomainData(DOMAIN, index, split)).toEqual(data);
  });
});

describe('storage.ts — migrating a version-1 record on read', () => {
  /** A domain record exactly as version 1 wrote it: every item inline under
   *  the domain key. FROZEN — this is the shape real users' storage holds
   *  until their first read after upgrading. */
  const V1_RECORD = {
    meta: { nextItemNumber: 4, version: 1 },
    pages: {
      'https://example.com/a': [
        makeItem({ id: 1, normalisedUrl: 'https://example.com/a' }),
        makeItem({ id: 3, normalisedUrl: 'https://example.com/a', note: 'third' }),
      ],
      'https://example.com/b': [makeItem({ id: 2, normalisedUrl: 'https://example.com/b' })],
    },
  };
  const V2_OF_V1 = { ...V1_RECORD, meta: { ...V1_RECORD.meta, version: 2 } };

  async function storeRaw(value: unknown): Promise<void> {
    await new Promise<void>((resolve) => chrome.storage.local.set({ [`domain:${DOMAIN}`]: value }, resolve));
  }
  async function rawStorage(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => chrome.storage.local.get(null, resolve));
  }

  test('STORAGE_VERSION is what a fresh record is stamped with', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);
    expect((await getDomainData(DOMAIN))!.meta.version).toBe(STORAGE_VERSION);
    expect(STORAGE_VERSION).toBe(2);
  });

  test('migrateInlineRecord: a version-1 record keeps its items and is stamped 2', () => {
    expect(migrateInlineRecord(V1_RECORD)).toEqual(V2_OF_V1);
  });

  test('migrateInlineRecord: a record with no version stamp walks both steps', () => {
    expect(migrateInlineRecord({ meta: { nextItemNumber: 4 }, pages: V1_RECORD.pages })).toEqual(V2_OF_V1);
  });

  test('migrateInlineRecord: anything that is not an inline record is null', () => {
    expect(migrateInlineRecord(undefined)).toBeNull();
    expect(migrateInlineRecord(null)).toBeNull();
    expect(migrateInlineRecord('domain:example.com')).toBeNull();
    expect(migrateInlineRecord({ meta: { nextItemNumber: 1, version: 1 } })).toBeNull();
    expect(migrateInlineRecord({ pages: {} })).toBeNull();
    // An index is not an inline record.
    expect(migrateInlineRecord({ meta: { nextItemNumber: 1, version: 2 }, pages: { u: [1] } })).toBeNull();
  });

  test('the first read migrates the record to the split layout and writes it back once', async () => {
    await storeRaw(V1_RECORD);
    (chrome.storage.local.set as jest.Mock).mockClear();

    expect(await getDomainData(DOMAIN)).toEqual(V2_OF_V1);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);

    const raw = await rawStorage();
    expect(Object.keys(raw).sort()).toEqual([
      `domain:${DOMAIN}`,
      `item:${DOMAIN}:1`,
      `item:${DOMAIN}:2`,
      `item:${DOMAIN}:3`,
    ]);
    expect(raw[`domain:${DOMAIN}`]).toEqual({
      meta: { nextItemNumber: 4, version: 2 },
      pages: { 'https://example.com/a': [1, 3], 'https://example.com/b': [2] },
    });
    expect(raw[`item:${DOMAIN}:3`]).toEqual(V1_RECORD.pages['https://example.com/a'][1]);

    // The second read finds the index and writes nothing.
    (chrome.storage.local.set as jest.Mock).mockClear();
    expect(await getDomainData(DOMAIN)).toEqual(V2_OF_V1);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test('every entry point migrates: getPageItems, getNextItemId, updateItem, deleteItem', async () => {
    await storeRaw(V1_RECORD);
    expect(await getPageItems(DOMAIN, 'https://example.com/a')).toEqual(V1_RECORD.pages['https://example.com/a']);

    await storeRaw(V1_RECORD);
    expect(await getNextItemId(DOMAIN)).toBe(4);

    await storeRaw(V1_RECORD);
    expect(await updateItem(DOMAIN, 'https://example.com/b', 2, { note: 'patched' })).toBe(true);
    expect((await getPageItems(DOMAIN, 'https://example.com/b'))[0].note).toBe('patched');

    await storeRaw(V1_RECORD);
    await seedImage('shot-1');
    await deleteItem(DOMAIN, 'https://example.com/a', 1);
    expect((await getPageItems(DOMAIN, 'https://example.com/a')).map((i) => i.id)).toEqual([3]);
    expect(await imageStore.getImage('shot-1')).toBeNull();
  });

  test('a v1 record is also migrated before an import replaces it, so its blobs are found and deleted', async () => {
    await storeRaw(V1_RECORD);
    await seedImage('shot-1');
    await seedImage('shot-2');
    await seedImage('shot-3');
    const incoming = makeItem({ id: 9, screenshotKey: 'new-9' });
    await seedImage('new-9');

    await replaceDomainData(DOMAIN, {
      meta: { nextItemNumber: 10, version: STORAGE_VERSION },
      pages: { [incoming.normalisedUrl]: [incoming] },
    });

    expect(await imageStore.getImage('shot-1')).toBeNull();
    expect(await imageStore.getImage('shot-3')).toBeNull();
    expect(Object.keys(await rawStorage()).sort()).toEqual([`domain:${DOMAIN}`, `item:${DOMAIN}:9`]);
  });

  test('an index stamped by a newer build is read as an index rather than refused', async () => {
    const item = makeItem({ id: 1 });
    await new Promise<void>((resolve) => chrome.storage.local.set({
      [`domain:${DOMAIN}`]: { meta: { nextItemNumber: 2, version: STORAGE_VERSION + 5 }, pages: { [item.normalisedUrl]: [1] } },
      [`item:${DOMAIN}:1`]: item,
    }, resolve));
    (chrome.storage.local.set as jest.Mock).mockClear();

    expect(await getPageItems(DOMAIN, item.normalisedUrl)).toEqual([item]);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('storage.ts — sidebar session state', () => {
  test('a tab with no recorded state is not open', async () => {
    expect(await isSidebarOpen(42)).toBe(false);
  });

  test('setSidebarOpen / isSidebarOpen round trip', async () => {
    await setSidebarOpen(1);
    expect(await isSidebarOpen(1)).toBe(true);
    // A different tab id is unaffected.
    expect(await isSidebarOpen(2)).toBe(false);
  });

  test('clearSidebarState resets a tab back to closed', async () => {
    await setSidebarOpen(5);
    expect(await isSidebarOpen(5)).toBe(true);

    await clearSidebarState(5);
    expect(await isSidebarOpen(5)).toBe(false);
  });
});
