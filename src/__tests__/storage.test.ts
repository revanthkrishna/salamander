// Phase 1: storage layer tests — domain CRUD, orphan-blob prevention, id
// monotonicity across URLs, and sidebar session-state round trip.

import {
  addItem,
  deleteItem,
  migrateDomainData,
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

describe('storage.ts — schema migration on read', () => {
  /** A domain record exactly as this build writes it (frozen: if this shape
   *  changes, STORAGE_VERSION must be bumped and a migration step added). */
  const V1_RECORD = {
    meta: { nextItemNumber: 3, version: 1 },
    pages: {
      'https://example.com/page': [makeItem({ id: 1 }), makeItem({ id: 2 })],
    },
  };

  test('STORAGE_VERSION is the version emptyDomainData/addItem stamp on a new record', async () => {
    const item = makeItem({ id: 1 });
    await seedImage(item.screenshotKey);
    await addItem(DOMAIN, item);
    expect((await getDomainData(DOMAIN))!.meta.version).toBe(STORAGE_VERSION);
  });

  test('a current-version record passes through migrateDomainData unchanged', () => {
    expect(migrateDomainData(V1_RECORD)).toEqual(V1_RECORD);
  });

  test('anything that is not a domain record migrates to null', () => {
    expect(migrateDomainData(undefined)).toBeNull();
    expect(migrateDomainData(null)).toBeNull();
    expect(migrateDomainData('domain:example.com')).toBeNull();
    expect(migrateDomainData({ meta: { nextItemNumber: 1, version: 1 } })).toBeNull();
    expect(migrateDomainData({ pages: {} })).toBeNull();
  });

  test('a record with no version stamp is treated as version 1 and stamped', () => {
    const unstamped = { meta: { nextItemNumber: 3 }, pages: V1_RECORD.pages };
    expect(migrateDomainData(unstamped)).toEqual(V1_RECORD);
  });

  test('a record from a newer build passes through as-is rather than being refused', () => {
    const newer = { ...V1_RECORD, meta: { ...V1_RECORD.meta, version: STORAGE_VERSION + 5 } };
    expect(migrateDomainData(newer)).toEqual(newer);
  });

  test('getDomainData migrates a stored record once and writes the upgrade back', async () => {
    const unstamped = { meta: { nextItemNumber: 3 }, pages: V1_RECORD.pages };
    await new Promise<void>((resolve) => chrome.storage.local.set({ [`domain:${DOMAIN}`]: unstamped }, resolve));
    (chrome.storage.local.set as jest.Mock).mockClear();

    expect(await getDomainData(DOMAIN)).toEqual(V1_RECORD);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);

    // The second read finds the upgraded record and writes nothing.
    (chrome.storage.local.set as jest.Mock).mockClear();
    expect(await getDomainData(DOMAIN)).toEqual(V1_RECORD);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test('getPageItems sees migrated items', async () => {
    const unstamped = { meta: { nextItemNumber: 3 }, pages: V1_RECORD.pages };
    await new Promise<void>((resolve) => chrome.storage.local.set({ [`domain:${DOMAIN}`]: unstamped }, resolve));
    expect(await getPageItems(DOMAIN, 'https://example.com/page')).toEqual(V1_RECORD.pages['https://example.com/page']);
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
