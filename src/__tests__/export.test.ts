// Export (src/export.ts) — the drawn image only (design spec §AB). An item
// with a drawing exports its screenshot with the strokes painted in, at the
// image's real pixel size; an item without one exports the stored PNG byte
// for byte, never touching a canvas; feedback.md carries no drawing data,
// only the alt text saying the image is marked up (design spec §AC —
// bundleV2.test.ts pins the text itself). Also: the header's clock and
// version come from the injected environment, and a whole export imports
// back to the same items (the round trip §AC requires).
//
// jsdom has no OffscreenCanvas / createImageBitmap, and the service worker
// has no DOM — so both are faked here, recording every call the painter
// makes, and the zip is read back with fflate.

import { unzipSync, strFromU8 } from 'fflate';
import { exportDomain, compositeDrawing, ExportEnvironment } from '../export';
import { bytesToDataUrl } from '../dataUrl';
import { buildFeedbackMarkdown } from '../bundle';
import { parseImportBundle } from '../import';
import type { DomainData, Drawing, FeedbackItem } from '../types';

jest.mock('../imageStore', () => ({
  getImage: jest.fn(),
}));
import * as imageStore from '../imageStore';

const getImage = imageStore.getImage as jest.Mock;

/** The PNG bytes the fake canvas "encodes" — distinct from any stored image,
 *  so a composited file is recognisable in the zip. */
const COMPOSITED = [9, 9, 9, 9];

class FakeBlob {
  constructor(private readonly bytes: number[], public readonly type: string) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Uint8Array(this.bytes).buffer;
  }
}

interface Canvas {
  width: number;
  height: number;
  calls: unknown[][];
}
let canvases: Canvas[] = [];
let failDecode = false;
let bitmapSize = { width: 400, height: 200 };
const bitmapClose = jest.fn();

class FakeOffscreenCanvas {
  calls: unknown[][] = [];
  constructor(public width: number, public height: number) {
    canvases.push(this);
  }
  getContext() {
    const calls = this.calls;
    const ctx: Record<string, unknown> = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args.slice(1)]),
      beginPath: () => calls.push(['beginPath']),
      moveTo: (x: number, y: number) => calls.push(['moveTo', x, y]),
      lineTo: (x: number, y: number) => calls.push(['lineTo', x, y]),
      arc: (x: number, y: number, r: number) => calls.push(['arc', x, y, r]),
      stroke: () => calls.push(['stroke', ctx.strokeStyle, ctx.lineWidth, ctx.lineCap, ctx.lineJoin]),
      fill: () => calls.push(['fill', ctx.fillStyle]),
    };
    return ctx;
  }
  async convertToBlob(options?: { type?: string }): Promise<Blob> {
    this.calls.push(['convertToBlob', options]);
    return new FakeBlob(COMPOSITED, 'image/png') as unknown as Blob;
  }
}

let downloads: Array<{ url: string; filename: string }> = [];

beforeEach(() => {
  canvases = [];
  failDecode = false;
  bitmapSize = { width: 400, height: 200 };
  downloads = [];
  getImage.mockReset();
  (global as any).OffscreenCanvas = FakeOffscreenCanvas;
  (global as any).createImageBitmap = jest.fn(async () => {
    if (failDecode) throw new Error('decode failed');
    return { ...bitmapSize, close: bitmapClose };
  });
  (global.chrome as any).downloads = {
    download: jest.fn((opts: { url: string; filename: string }, cb: (id?: number) => void) => {
      downloads.push(opts);
      cb(1);
    }),
  };
  (global.chrome as any).runtime = { ...((global.chrome as any).runtime ?? {}), lastError: null };
});

afterEach(() => {
  delete (global as any).OffscreenCanvas;
  delete (global as any).createImageBitmap;
});

function makeItem(id: number, overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: `note ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 200, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 2,
    screenshotKey: `key-${id}`,
    thumbnailDataUrl: 'data:image/jpeg;base64,AA',
    context: {
      primaryTarget: { cssSelector: 'div', xpath: '/html/body/div', outerHtmlSnippet: '<div></div>', truncated: false },
      containedElements: [],
      areaText: '',
      pageMeta: {
        url: 'https://example.com/page',
        normalisedUrl: 'https://example.com/page',
        title: 'example',
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        selectionRect: { x: 0, y: 0, width: 200, height: 100 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    ...overrides,
  };
}

const DRAWING: Drawing = {
  width: 200,
  height: 100,
  strokes: [
    { color: '#E5484D', points: [[10, 10], [50, 40]] },
    { color: '#1A1712', points: [[100, 50]] },
  ],
};

/** Stored screenshot bytes per key: real, distinct byte strings. */
const STORED: Record<string, number[]> = {
  'key-1': [137, 80, 78, 71, 1, 1, 1],
  'key-2': [137, 80, 78, 71, 2, 2, 2],
};

function domainOf(items: FeedbackItem[]): DomainData {
  return { meta: { nextItemNumber: items.length + 1, version: 2 }, pages: { 'https://example.com/page': items } };
}

const EXPORTED_AT = new Date('2026-09-22T02:40:00.000Z');
const ENV: ExportEnvironment = { now: () => EXPORTED_AT, extensionVersion: () => '9.8.7' };

async function exportZipBytes(items: FeedbackItem[]): Promise<Uint8Array> {
  getImage.mockImplementation(async (key: string) => (STORED[key] ? bytesToDataUrl(new Uint8Array(STORED[key]), 'image/png') : null));
  const res = await exportDomain('example.com', async () => domainOf(items), ENV);
  expect(res).toEqual({ ok: true });
  const url = downloads[0].url;
  return new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

async function exportAndUnzip(items: FeedbackItem[]): Promise<Record<string, Uint8Array>> {
  return unzipSync(await exportZipBytes(items));
}

/** The header as the export should write it for EXPORTED_AT, in whatever
 *  zone this machine's clock is in. */
function headerFor(now: Date) {
  return { extensionVersion: '9.8.7', website: 'example.com', exportedAt: now, utcOffsetMinutes: -now.getTimezoneOffset() };
}

describe('export: the drawn image only (design spec §AB)', () => {
  test('an item without a drawing exports its stored PNG byte for byte, and no canvas is made', async () => {
    const files = await exportAndUnzip([makeItem(1)]);
    expect(Array.from(files['screenshots/1.png'])).toEqual(STORED['key-1']);
    expect(canvases).toHaveLength(0);
    expect((global as any).createImageBitmap).not.toHaveBeenCalled();
  });

  test('an empty drawing counts as none', async () => {
    const files = await exportAndUnzip([makeItem(1, { drawing: { width: 200, height: 100, strokes: [] } })]);
    expect(Array.from(files['screenshots/1.png'])).toEqual(STORED['key-1']);
    expect(canvases).toHaveLength(0);
  });

  test('an item with a drawing exports the composited PNG; its neighbour stays untouched', async () => {
    const files = await exportAndUnzip([makeItem(1, { drawing: DRAWING }), makeItem(2)]);
    expect(Array.from(files['screenshots/1.png'])).toEqual(COMPOSITED);
    expect(Array.from(files['screenshots/2.png'])).toEqual(STORED['key-2']);
    expect(canvases).toHaveLength(1);
  });

  test('feedback.md carries no drawing data — only the alt text says the image is marked up', async () => {
    const plain = makeItem(1);
    const files = await exportAndUnzip([{ ...plain, drawing: DRAWING }]);
    const md = strFromU8(files['feedback.md']);
    expect(md).toBe(
      buildFeedbackMarkdown({ 'https://example.com/page': [plain] }, headerFor(EXPORTED_AT)).replace(
        '![feedback 1](screenshots/1.png)',
        '![feedback 1 — marked up by the reviewer](screenshots/1.png)',
      ),
    );
    expect(md).not.toMatch(/strokes|"drawing"|#E5484D/);
    expect(Object.keys(files).sort()).toEqual(['feedback.md', 'screenshots/1.png']);
  });

  test('painted at the image\'s real size: a 2x capture scales every point and the 2px line to 4px', async () => {
    bitmapSize = { width: 400, height: 200 }; // a 200x100 selection at dpr 2
    await exportAndUnzip([makeItem(1, { drawing: DRAWING })]);
    const [c] = canvases;
    expect([c.width, c.height]).toEqual([400, 200]);
    expect(c.calls).toEqual([
      ['drawImage', 0, 0],
      ['beginPath'],
      ['moveTo', 20, 20],
      ['lineTo', 100, 80],
      ['stroke', '#E5484D', 4, 'round', 'round'],
      ['beginPath'],
      ['arc', 200, 100, 2],
      ['fill', '#1A1712'],
      ['convertToBlob', { type: 'image/png' }],
    ]);
    expect(bitmapClose).toHaveBeenCalled();
  });

  test('the scale is measured from the pixels, not assumed from dpr (a 1.5x zoomed 2x capture)', async () => {
    bitmapSize = { width: 600, height: 300 };
    await exportAndUnzip([makeItem(1, { dpr: 2, drawing: DRAWING })]);
    const calls = canvases[0].calls;
    expect(calls).toContainEqual(['moveTo', 30, 30]);
    expect(calls).toContainEqual(['stroke', '#E5484D', 6, 'round', 'round']);
  });

  test('if painting fails the clean screenshot goes out rather than the export failing', async () => {
    failDecode = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const files = await exportAndUnzip([makeItem(1, { drawing: DRAWING })]);
    warn.mockRestore();
    expect(Array.from(files['screenshots/1.png'])).toEqual(STORED['key-1']);
  });

  test('compositeDrawing returns a PNG data URL', async () => {
    const url = await compositeDrawing(bytesToDataUrl(new Uint8Array(STORED['key-1']), 'image/png'), DRAWING);
    expect(url).toBe(bytesToDataUrl(new Uint8Array(COMPOSITED), 'image/png'));
  });
});

describe('export: the header and the round trip (design spec §AC)', () => {
  test('the header takes the manifest version and the local time from the environment', async () => {
    const files = await exportAndUnzip([makeItem(1)]);
    const lines = strFromU8(files['feedback.md']).split('\n');
    expect(lines[0]).toBe('<!-- salamander-feedback-format: 2 -->');
    expect(lines[1]).toBe('salamander 9.8.7\\');
    expect(lines[2]).toMatch(/^\*\*date exported:\*\* \d{4}-\d\d-\d\d \d\d:\d\d utc[+-]\d\d:\d\d\\$/);
    expect(lines[3]).toBe('**website:** example.com');
    expect(downloads[0].filename).toBe('feedback-example_com-2026-09-22.zip');
  });

  test('by default the version is the manifest\'s', async () => {
    getImage.mockResolvedValue(bytesToDataUrl(new Uint8Array(STORED['key-1']), 'image/png'));
    await exportDomain('example.com', async () => domainOf([makeItem(1)]));
    const url = downloads[0].url;
    const files = unzipSync(new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')));
    expect(strFromU8(files['feedback.md']).split('\n')[1]).toBe(`salamander ${chrome.runtime.getManifest().version}\\`);
  });

  test('export then import reproduces every stored field; the drawing comes back only in the pixels', async () => {
    const items = [
      makeItem(1, { note: 'first "note"\n\nwith two paragraphs', drawing: DRAWING }),
      makeItem(2, { note: '' }),
    ];
    const zip = await exportZipBytes(items);
    const file = { name: 'bundle.zip', arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) } as unknown as File;

    const bundle = await parseImportBundle(file, 'example.com');

    expect(bundle.items.map(({ screenshotDataUrl: _s, ...rest }) => rest)).toEqual(
      items.map(({ screenshotKey: _k, thumbnailDataUrl: _t, drawing: _d, ...rest }) => rest),
    );
    // Item 1's screenshot is the composited one; item 2's is untouched.
    expect(bundle.items[0].screenshotDataUrl).toBe(bytesToDataUrl(new Uint8Array(COMPOSITED), 'image/png'));
    expect(bundle.items[1].screenshotDataUrl).toBe(bytesToDataUrl(new Uint8Array(STORED['key-2']), 'image/png'));
  });
});
