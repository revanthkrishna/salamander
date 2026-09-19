// Phase 9 — import.ts: the §5 validation ladder (§1.7), tested against
// purpose-built fixture bundles built the same way src/export.ts assembles a
// real one (fflate zipSync + bundle.ts's buildFeedbackMarkdown/
// toYamlFeedbackItem), so these tests exercise the real grammar rather than
// a hand-rolled stand-in for it.

import { zipSync, strToU8 } from 'fflate';
import { parseImportBundle } from '../import';
import { buildFeedbackMarkdown, toYamlFeedbackItem, SCHEMA_VERSION } from '../bundle';
import { ImportError, FeedbackItem } from '../types';

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
  const markdown = buildFeedbackMarkdown(pages);
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
    expect(bundle.versionWarning).toBe(false);
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
      'feedback.md': strToU8(buildFeedbackMarkdown({ [item.normalisedUrl]: [item] })),
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

  test('#4b malformed yaml fence', async () => {
    const markdown =
      '## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: [1, 2\n```\n';
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MALFORMED_CONTEXT',
    });
  });

  test('#4b well-formed fence missing required fields', async () => {
    const markdown =
      '## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: 1\n```\n';
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
    const markdown = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] });
    const file = rawZipFile({ 'feedback.md': strToU8(markdown) }); // no screenshots/1.png

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'MISSING_SCREENSHOT',
    });
  });

  test('#11 duplicate item ids', async () => {
    const markdown = [
      '## https://example.com/page',
      '',
      '### item 1',
      '',
      '![](screenshots/1.png)',
      '',
      'first',
      '',
      '```yaml',
      toYamlishFixture(1, 'https://example.com/page'),
      '```',
      '',
      '### item 1',
      '',
      '![](screenshots/1.png)',
      '',
      'second',
      '',
      '```yaml',
      toYamlishFixture(1, 'https://example.com/page'),
      '```',
      '',
    ].join('\n');
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
    });

    await expect(parseImportBundle(file, 'example.com')).rejects.toMatchObject({
      code: 'DUPLICATE_IDS',
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

  test('#6 newer schema version warns but does not throw', async () => {
    const item = makeItem();
    const markdown = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] }).replace(
      `<!-- annotator-schema-version: ${SCHEMA_VERSION} -->`,
      `<!-- annotator-schema-version: ${SCHEMA_VERSION + 1} -->`,
    );
    const file = rawZipFile({
      'feedback.md': strToU8(markdown),
      'screenshots/1.png': PNG_BYTES,
    });

    const bundle = await parseImportBundle(file, 'example.com');
    expect(bundle.versionWarning).toBe(true);
    expect(bundle.items).toHaveLength(1);
  });

  test('a bundle at the current schema version does not warn', async () => {
    const item = makeItem();
    const file = makeBundleFile({ [item.normalisedUrl]: [item] });

    const bundle = await parseImportBundle(file, 'example.com');
    expect(bundle.versionWarning).toBe(false);
  });
});

describe('ImportError instances thrown', () => {
  test('rejects with an ImportError instance, not a plain Error', async () => {
    const file = fakeFile(new Uint8Array([1]), 'not-a-zip.txt');
    await expect(parseImportBundle(file, 'example.com')).rejects.toBeInstanceOf(ImportError);
  });
});

/** A minimal-but-complete yaml fence body for the duplicate-id fixture,
 *  where we need full control over the raw markdown text rather than going
 *  through buildFeedbackMarkdown. */
function toYamlishFixture(id: number, url: string): string {
  const item = makeItem({ id, pageUrl: url, normalisedUrl: url });
  const yamlItem = toYamlFeedbackItem(item);
  // Cheap deterministic YAML dump without pulling in js-yaml here — the
  // real fence body only needs to parse, not be pretty.
  return JSON.stringify(yamlItem);
}
