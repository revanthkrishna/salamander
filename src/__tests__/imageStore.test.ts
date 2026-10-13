// imageStore.ts over fake-indexeddb (setup.ts): the shared connection is
// reopened rather than cached broken.

type ImageStore = typeof import('../imageStore');

/** A fresh module (its cached connection is module state), with every
 *  indexedDB.open request recorded. */
function loadWithOpenSpy(): { store: ImageStore; opened: IDBOpenDBRequest[]; spy: jest.SpyInstance } {
  jest.resetModules();
  const opened: IDBOpenDBRequest[] = [];
  const realOpen = indexedDB.open.bind(indexedDB);
  const spy = jest.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
    const req = realOpen(name, version);
    opened.push(req);
    return req;
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const store = require('../imageStore') as ImageStore;
  return { store, opened, spy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('imageStore: the shared connection', () => {
  test('one connection serves every call while it is healthy', async () => {
    const { store, opened } = loadWithOpenSpy();
    await store.putImage('a', 'data:image/png;base64,AAAA');
    expect(await store.getImage('a')).toBe('data:image/png;base64,AAAA');
    await store.deleteImage('a');
    expect(opened).toHaveLength(1);
  });

  test('a failed open is not cached: the next call opens again', async () => {
    const { store, opened, spy } = loadWithOpenSpy();
    spy.mockImplementationOnce(() => {
      const req = {} as { onerror: ((e: Event) => void) | null; error: DOMException | null };
      req.onerror = null;
      req.error = new DOMException('open failed', 'UnknownError');
      setTimeout(() => req.onerror?.(new Event('error')));
      return req as unknown as IDBOpenDBRequest;
    });
    await expect(store.putImage('a', 'x')).rejects.toBeDefined();
    await store.putImage('a', 'data:image/png;base64,AAAA');
    expect(await store.getImage('a')).toBe('data:image/png;base64,AAAA');
    expect(opened).toHaveLength(1);
  });

  test('a connection the browser closed is replaced on the next call', async () => {
    const { store, opened } = loadWithOpenSpy();
    await store.putImage('a', 'data:image/png;base64,AAAA');
    const db = opened[0].result;
    db.close();
    db.onclose?.call(db, new Event('close'));
    expect(await store.getImage('a')).toBe('data:image/png;base64,AAAA');
    expect(opened).toHaveLength(2);
  });

  test('a versionchange from elsewhere lets the connection go, and the next call reopens', async () => {
    const { store, opened } = loadWithOpenSpy();
    await store.putImage('a', 'data:image/png;base64,AAAA');
    const db = opened[0].result;
    db.onversionchange?.call(db, new Event('versionchange') as IDBVersionChangeEvent);
    expect(await store.getImage('a')).toBe('data:image/png;base64,AAAA');
    expect(opened).toHaveLength(2);
  });
});
