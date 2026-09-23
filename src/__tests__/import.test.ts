// import.ts: the §5 validation ladder (§1.7), tested against
// purpose-built fixture bundles built the same way src/export.ts assembles a
// real one (fflate zipSync + src/bundle's buildFeedbackMarkdown), so these
// tests exercise the real grammar rather than a hand-rolled stand-in for it.
// The frozen text of the format itself is pinned in bundleV2.test.ts.

import { zipSync, strToU8 } from 'fflate';
import { parseImportBundle } from '../import';
import { buildFeedbackMarkdown, ExportHeader } from '../bundle';
import { ImportError, FeedbackItem } from '../types';

const HEADER: ExportHeader = {
  extensionVersion: '1.1.0',
  website: 'example.com',
  exportedAt: new Date('2026-01-01T12:00:00.000Z'),
  utcOffsetMinutes: 60,
};

function markdownFor(pages: Record<string, FeedbackItem[]>): string {
  return buildFeedbackMarkdown(pages, HEADER);
}

// jsdom's File (like its Blob) has no arrayBuffer() implementation — a
// minimal stand-in with just the shape import.ts needs, mirroring
// background.test.ts's FakeBlob for the same jsdom gap.
class FakeFile {
  constructor(
    private readonly bytes: Uint8Array,
    public readonly name: string,
  ) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    ) as ArrayBuffer;
  }
}

function fakeFile(bytes: Uint8Array, name: string): File {
  return new FakeFile(bytes, name) as unknown as File;
}

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 1,
    pageUrl: 'https://example.com/page-one?ref=x',
    normalisedUrl: 'https://example.com/page-one',
    note: 'this button is misaligned',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 10, y: 20, width: 100, height: 50 },
    viewport: { width: 1280, height: 800 },
    dpr: 2,
    screenshotKey: 'key-1',
    thumbnailDataUrl: 'data:image/jpeg;base64,thumb',
    context: {
      primaryTarget: {
        cssSelector: 'button.submit',
        xpath: '//button[1]',
        outerHtmlSnippet: '<button class="submit">go</button>',
        truncated: false,
      },
      containedElements: [
        { tag: 'span', text: 'go', classes: { semantic: ['label'], generated: [] } },
      ],
      areaText: 'go',
      pageMeta: {
        url: 'https://example.com/page-one?ref=x',
        normalisedUrl: 'https://example.com/page-one',
        title: 'page one',
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        selectionRect: { x: 10, y: 20, width: 100, height: 50 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    ...overrides,
  };
}

const PNG_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** Build a real .zip file (as a fake File) out of a domain's worth of pages,
 *  exactly like src/export.ts would, minus the chrome.downloads part. */
function makeBundleFile(
  pages: Record<string, FeedbackItem[]>,
  opts: { filename?: string; extraFiles?: Record<string, Uint8Array> } = {},
): File {
  const markdown = markdownFor(pages);
  const allItems = Object.values(pages).flat();
  const files: Record<string, Uint8Array> = {
    'feedback.md': strToU8(markdown),
    ...Object.fromEntries(allItems.map((item) => [`screenshots/${item.id}.png`, PNG_BYTES])),
    ...(opts.extraFiles ?? {}),
  };
  const zipped = zipSync(files);
  return fakeFile(zipped, opts.filename ?? 'bundle.zip');
}

function rawZipFile(files: Record<string, Uint8Array>, filename = 'bundle.zip'): File {
  return fakeFile(zipSync(files), filename);
}

describe('parseImportBundle — happy path', () => {
  test('parses a valid single-item bundle', async () => {
    const item = makeItem();
    const file = makeBundleFile({ [item.normalisedUrl]: [item] });

    const bundle = await parseImportBundle(file, 'example.com');

    expect(bundle.domain).toBe('example.com');
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0].id).toBe(1);
    expect(bundle.items[0].note).toBe(item.note);
    expect(bundle.items[0].pageUrl).toBe(item.pageUrl);
    expect(bundle.items[0].context).toEqual(item.context);
    expect(bundle.items[0].screenshotDataUrl).toBe(
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
    );
    // screenshotKey/thumbnailDataUrl are not part of the payload — the
    // service worker mints those at write time.
    expect(bundle.items[0]).not.toHaveProperty('screenshotKey');
    expect(bundle.items[0]).not.toHaveProperty('thumbnailDataUrl');
  });

  test('parses a multi-url, multi-item bundle, preserving ids and per-url grouping', async () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const a1 = makeItem({ id: 1, normalisedUrl: urlA, pageUrl: urlA, note: 'a1' });
    const a2 = makeItem({ id: 3, normalisedUrl: urlA, pageUrl: urlA, note: 'a2' });
    const b1 = makeItem({ id: 2, normalisedUrl: urlB, pageUrl: urlB, note: 'b1' });
    const file = makeBundleFile({ [urlA]: [a1, a2], [urlB]: [b1] });

    const bundle = await parseImportBundle(file, 'example.com');

    expect(bundle.items.map((i) => i.id).sort((x, y) => x - y)).toEqual([1, 2, 3]);
    expect(bundle.items.find((i) => i.id === 2)?.normalisedUrl).toBe(urlB);
  });
});

describe('parseImportBundle — §5 error ladder', () => {
  test('#1 wrong file extension', async () => {
    const item = makeItem();
    const zipped = zipSync({
      'feedback.md': strToU8(markdownFor({ [item.normalisedUrl]: [item] })),
      [`screenshots/${item.id}.png`]: PNG_BYTES,
    });
    const file = fakeFile(zipped, 'bundle.yaml');

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
  });

  test('#2 corrupt archive', async () => {
    const file = fakeFile(new Uint8Array([9, 9, 9, 9, 9]), 'bundle.zip');

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'CORRUPT_ARCHIVE',
    });
  });

  test('#3 missing feedback.md', async () => {
    const file = rawZipFile({ 'readme.txt': strToU8('hello') });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MISSING_MANIFEST',
    });
  });

  test('#4b an item whose element data does not parse', async () => {
    const item = makeItem();
    const markdown = markdownFor({ [item.normalisedUrl]: [item] }).replace('"id": 1,', '"id": 1,,');
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MALFORMED_CONTEXT',
    });
  });

  test('#4b well-formed element data missing a required field', async () => {
    const item = makeItem();
    const markdown = markdownFor({ [item.normalisedUrl]: [item] }).replace(/\n  "page_url": .*\n/, '\n');
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MALFORMED_CONTEXT',
    });
  });

  test('#4 referenced screenshot missing from the zip', async () => {
    const item = makeItem();
    const markdown = markdownFor({ [item.normalisedUrl]: [item] });
    const file = rawZipFile({ 'feedback.md': strToU8(markdown) }); // no screenshots/1.png

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MISSING_SCREENSHOT',
    });
  });

  test('#11 the same id on two pages: one screenshot file claimed by two notes', async () => {
    // Both notes are `feedback 1` on their own page, which is fine — it is
    // the shared id (`screenshots/1.png`, json "id": 1) that is refused: the
    // id is the storage key, so a repeat would collapse two notes into one.
    const first = makeItem({ id: 1, normalisedUrl: 'https://example.com/a', note: 'first' });
    const second = makeItem({ id: 1, normalisedUrl: 'https://example.com/b', note: 'second' });
    const file = makeBundleFile({ 'https://example.com/a': [first], 'https://example.com/b': [second] });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'DUPLICATE_IDS',
    });
  });

  test('#11 the same number twice under one page', async () => {
    const url = 'https://example.com/a';
    const first = makeItem({ id: 1, normalisedUrl: url, note: 'first' });
    const second = makeItem({ id: 2, normalisedUrl: url, note: 'second' });
    // A hand edit that gives the second note the first one's heading.
    const markdown = markdownFor({ [url]: [first, second] }).replace(
      '### feedback 2\n\n![feedback 2](screenshots/2.png)',
      '### feedback 1\n\n![feedback 1](screenshots/2.png)',
    );
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
      'screenshots/2.png': PNG_BYTES,
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'DUPLICATE_IDS',
    });
  });

  test('#11 is not tripped by the same number on two pages — every page counts from 1', async () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const a1 = makeItem({ id: 1, normalisedUrl: urlA, pageUrl: urlA, note: 'a' });
    const b1 = makeItem({ id: 2, normalisedUrl: urlB, pageUrl: urlB, note: 'b' });
    const markdown = markdownFor({ [urlA]: [a1], [urlB]: [b1] });
    expect(markdown.match(/^### feedback \d+$/gm)).toEqual(['### feedback 1', '### feedback 1']);

    const bundle = await parseImportBundle(makeBundleFile({ [urlA]: [a1], [urlB]: [b1] }), 'example.com');

    expect(bundle.items.map((i) => [i.id, i.normalisedUrl])).toEqual([[1, urlA], [2, urlB]]);
  });

  test('#11 tolerates a gap in a page\'s numbers (a note deleted by hand); the list renumbers on the next draw', async () => {
    const url = 'https://example.com/a';
    const first = makeItem({ id: 1, normalisedUrl: url, note: 'first' });
    const second = makeItem({ id: 2, normalisedUrl: url, note: 'second' });
    const markdown = markdownFor({ [url]: [first, second] }).replace('### feedback 2', '### feedback 3');
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
      'screenshots/2.png': PNG_BYTES,
    });

    const bundle = await parseImportBundle(file, 'example.com');

    // The heading's number goes no further than the check: the payload is
    // the item, and its place in the list is what it will be numbered by.
    expect(bundle.items.map((i) => i.id)).toEqual([1, 2]);
    expect(bundle.items[1]).not.toHaveProperty('number');
  });

  test('#4 comes before #11: a bundle with both a missing screenshot and a repeated id reports the screenshot', async () => {
    const first = makeItem({ id: 1, normalisedUrl: 'https://example.com/a', note: 'first' });
    const second = makeItem({ id: 1, normalisedUrl: 'https://example.com/b', note: 'second' });
    const markdown = markdownFor({ 'https://example.com/a': [first], 'https://example.com/b': [second] });
    const file = rawZipFile({ 'feedback.md': strToU8(markdown) });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MISSING_SCREENSHOT',
    });
  });

  test('#5 domain mismatch', async () => {
    const item = makeItem({
      pageUrl: 'https://other-site.com/page',
      normalisedUrl: 'https://other-site.com/page',
    });
    const file = makeBundleFile({ [item.normalisedUrl]: [item] });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'DOMAIN_MISMATCH',
      details: { fileDomain: 'other-site.com', currentDomain: 'example.com' },
    });
  });

  test('#6 a retired v1 bundle is refused', async () => {
    const v1 = [
      '<!-- annotator-schema-version: 1 -->',
      '',
      '## https://example.com/page',
      '',
      '### item 1',
      '',
      '![](screenshots/1.png)',
      '',
      'a note',
      '',
      '```yaml',
      'id: 1',
      '```',
      '',
    ].join('\n');
    const file = rawZipFile({ 'feedback.md': strToU8(v1), 'screenshots/1.png': PNG_BYTES });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  test('#6 a newer format is refused, not read best-effort', async () => {
    const item = makeItem();
    const markdown = markdownFor({ [item.normalisedUrl]: [item] }).replace(
      '<!-- salamander-feedback-format: 2 -->',
      '<!-- salamander-feedback-format: 3 -->',
    );
    const file = rawZipFile({ 'feedback.md': strToU8(markdown), 'screenshots/1.png': PNG_BYTES });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  test('#6 a feedback.md with no format stamp is refused', async () => {
    const file = rawZipFile({ 'feedback.md': strToU8('# my notes\n\nnothing to see\n') });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  test('#6 comes before #4b: a broken file in another format reports the format', async () => {
    const file = rawZipFile({
      'feedback.md': strToU8('<!-- salamander-feedback-format: 1 -->\n### feedback 1\n```json\n{\n'),
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });
});

describe('parseImportBundle — round trip', () => {
  test('every stored field comes back except the storage handles and the drawing', async () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const a1 = makeItem({ id: 1, normalisedUrl: urlA, pageUrl: `${urlA}?x=1`, note: 'a "quoted" note\n\nsecond paragraph' });
    const a2 = makeItem({
      id: 4,
      normalisedUrl: urlA,
      pageUrl: urlA,
      note: '',
      drawing: { width: 100, height: 50, strokes: [{ color: '#1A1712', points: [[1, 2]] }] },
    });
    const b1 = makeItem({ id: 2, normalisedUrl: urlB, pageUrl: urlB });
    for (const item of [a1, a2, b1]) {
      item.context = { ...item.context, pageMeta: { ...item.context.pageMeta, url: item.pageUrl, normalisedUrl: item.normalisedUrl } };
    }
    const file = makeBundleFile({ [urlA]: [a1, a2], [urlB]: [b1] });

    const bundle = await parseImportBundle(file, 'example.com');

    const expected = [a1, a2, b1].map(({ screenshotKey: _k, thumbnailDataUrl: _t, drawing: _d, ...rest }) => ({
      ...rest,
      screenshotDataUrl: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
    }));
    expect(bundle.items).toEqual(expected);
  });
});

describe('ImportError instances thrown', () => {
  test('rejects with an ImportError instance, not a plain Error', async () => {
    const file = fakeFile(new Uint8Array([1]), 'not-a-zip.txt');
    await expect(parseImportBundle(file, 'example.com')).rejects.toBeInstanceOf(ImportError);
  });
});
