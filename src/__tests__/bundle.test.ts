// src/bundle — the feedback.md writer and reader (design spec §AC) against
// generated input: ordering, the round trip the importer builds on, notes
// that try to look like structure, the format dispatch, and the reader's
// error shape. The frozen text fixture has its own file (bundleV2.test.ts).

import {
  buildFeedbackMarkdown,
  decodeFeedbackMarkdown,
  ExportHeader,
  UnsupportedFormatError,
} from '../bundle';
import { formatExportDate, primaryTargetText, toJsonFeedbackItem } from '../bundle/v2';
import { FeedbackItem } from '../types';

const HEADER: ExportHeader = {
  extensionVersion: '1.1.0',
  website: 'example.com',
  exportedAt: new Date('2026-01-01T12:00:00.000Z'),
  utcOffsetMinutes: 0,
};

/** A stored item whose `context.pageMeta` mirrors its own fields, exactly
 *  as capture.ts writes one (the bundle relies on it — see bundle/v2.ts). */
function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  const pageUrl = overrides.pageUrl ?? 'https://example.com/page-one?ref=x';
  const normalisedUrl = overrides.normalisedUrl ?? 'https://example.com/page-one';
  const createdAt = overrides.createdAt ?? '2026-01-01T00:00:00.000Z';
  const selectionRect = overrides.selectionRect ?? { x: 10, y: 20, width: 100, height: 50 };
  const viewport = overrides.viewport ?? { width: 1280, height: 800 };
  const dpr = overrides.dpr ?? 2;
  return {
    id: 1,
    pageUrl,
    normalisedUrl,
    note: 'this button is misaligned',
    createdAt,
    selectionRect,
    viewport,
    dpr,
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
        url: pageUrl,
        normalisedUrl,
        title: 'page one',
        viewport: { ...viewport },
        dpr,
        selectionRect: { ...selectionRect },
        capturedAt: createdAt,
      },
    },
    ...overrides,
  };
}

/** A stored item as import should rebuild it: no storage handles, no drawing. */
function asDecoded(item: FeedbackItem) {
  const { screenshotKey: _k, thumbnailDataUrl: _t, drawing: _d, ...rest } = item;
  return rest;
}

function build(pages: Record<string, FeedbackItem[]>): string {
  return buildFeedbackMarkdown(pages, HEADER);
}

describe('buildFeedbackMarkdown', () => {
  test('the header: format stamp, then three lines joined by trailing backslashes, nothing else', () => {
    const item = makeItem();
    const md = build({ [item.normalisedUrl]: [item] });
    expect(md.split('\n').slice(0, 6)).toEqual([
      '<!-- salamander-feedback-format: 2 -->',
      'salamander 1.1.0\\',
      '**date exported:** 2026-01-01 12:00 utc+00:00\\',
      '**website:** example.com',
      '',
      '## page "https://example.com/page-one"',
    ]);
    expect(md.endsWith('</details>\n')).toBe(true);
  });

  test('orders pages by first-captured note across urls', () => {
    const first = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    const second = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    // Built out of capture order to prove sorting, not insertion order,
    // drives page placement.
    const md = build({ 'https://example.com/b': [second], 'https://example.com/a': [first] });

    const aIndex = md.indexOf('## page "https://example.com/a"');
    const bIndex = md.indexOf('## page "https://example.com/b"');
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThan(aIndex);
  });

  test('orders notes within a page by capture order (id)', () => {
    const url = 'https://example.com/page';
    const later = makeItem({ id: 5, normalisedUrl: url, note: 'later' });
    const earlier = makeItem({ id: 3, normalisedUrl: url, note: 'earlier' });
    const md = build({ [url]: [later, earlier] });

    expect(md.indexOf('### feedback 3')).toBeGreaterThanOrEqual(0);
    expect(md.indexOf('### feedback 5')).toBeGreaterThan(md.indexOf('### feedback 3'));
  });

  test('omits pages with no notes', () => {
    const item = makeItem();
    const md = build({ [item.normalisedUrl]: [item], 'https://example.com/empty': [] });
    expect(md).not.toContain('empty');
  });

  test('a note is shown trimmed; the json keeps it exactly as stored', () => {
    const item = makeItem({ note: '  padded note \n' });
    const md = build({ [item.normalisedUrl]: [item] });
    expect(md).toContain('\n**note:** padded note\n\n<details>\n');
    expect(md).toContain('"note": "  padded note \\n"');
  });

  test('a whitespace-only note is shown as (none)', () => {
    const item = makeItem({ note: ' \n ' });
    expect(build({ [item.normalisedUrl]: [item] })).toContain('\n**note:** (none)\n');
  });

  test('an empty drawing does not mark the screenshot as marked up', () => {
    const item = makeItem({ drawing: { width: 100, height: 50, strokes: [] } });
    expect(build({ [item.normalisedUrl]: [item] })).toContain('![feedback 1](screenshots/1.png)');
  });

  test('the json lists its fields in the spec\'s order, with no page_meta block', () => {
    const item = makeItem({
      context: { ...makeItem().context, containedElementsTruncated: true },
    });
    const md = build({ [item.normalisedUrl]: [item] });
    const json = md.slice(md.indexOf('```json\n') + 8, md.lastIndexOf('\n```'));
    expect(Object.keys(JSON.parse(json))).toEqual([
      'text',
      'selector',
      'xpath',
      'html',
      'page_url',
      'note',
      'id',
      'normalised_url',
      'page_title',
      'created_at',
      'selection_rect',
      'viewport',
      'dpr',
      'contained_elements',
      'contained_elements_truncated',
      'area_text',
    ]);
    expect(md).not.toMatch(/page_meta|captured_at/);
  });

  test('html_truncated appears only when the snippet was cut', () => {
    expect(toJsonFeedbackItem(makeItem())).not.toHaveProperty('html_truncated');
    const cut = makeItem({
      context: {
        ...makeItem().context,
        primaryTarget: { ...makeItem().context.primaryTarget, outerHtmlSnippet: '<b>x...[truncated]', truncated: true },
      },
    });
    expect(Object.keys(toJsonFeedbackItem(cut)).slice(3, 5)).toEqual(['html', 'html_truncated']);
  });
});

describe('formatExportDate', () => {
  test.each([
    ['2026-09-22T02:40:00.000Z', -300, '2026-09-21 21:40 utc-05:00'],
    ['2026-09-21T21:40:00.000Z', 0, '2026-09-21 21:40 utc+00:00'],
    ['2026-12-31T20:05:00.000Z', 330, '2027-01-01 01:35 utc+05:30'],
    ['2026-03-01T01:00:00.000Z', -570, '2026-02-28 15:30 utc-09:30'],
  ])('%s at %d minutes -> %s', (iso, offset, expected) => {
    expect(formatExportDate(new Date(iso), offset)).toBe(expected);
  });
});

describe('primaryTargetText (the json `text` field)', () => {
  test.each([
    ['<a href="/x">start trial</a>', 'start trial'],
    ['<div>\n  <span>$12</span> <span>/ seat</span>\n</div>', '$12 / seat'],
    ['<p>fish &amp; chips &lt;3 &#233;&#x e9;</p>', 'fish & chips <3 é&#x e9;'],
    ['<a title="a > b">go</a>', 'go'],
    ['<th>feature</th><th class="hi...[truncated]', 'feature'],
    ['<img src="data:[stripped]" alt="logo">', ''],
    ['...[truncated]', ''],
  ])('%s -> %s', (snippet, expected) => {
    expect(primaryTargetText(snippet)).toBe(expected);
  });
});

describe('round trip: buildFeedbackMarkdown -> decodeFeedbackMarkdown', () => {
  test('a multi-page bundle rebuilds every stored field except the drawing and storage handles', () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const a1 = makeItem({ id: 1, normalisedUrl: urlA, pageUrl: `${urlA}?q=1`, note: 'a1' });
    const a2 = makeItem({
      id: 3,
      normalisedUrl: urlA,
      pageUrl: `${urlA}#frag`,
      note: 'a2\nwith a second line',
      dpr: 1.25,
      selectionRect: { x: 0.5, y: 10.75, width: 33.3, height: 1 },
      drawing: { width: 33.3, height: 1, strokes: [{ color: '#E8B600', points: [[1, 1]] }] },
    });
    const b1 = makeItem({ id: 2, normalisedUrl: urlB, pageUrl: urlB, note: '' });

    const decoded = decodeFeedbackMarkdown(build({ [urlA]: [a1, a2], [urlB]: [b1] }));

    expect(decoded.version).toBe(2);
    expect(decoded.items).toEqual([asDecoded(a1), asDecoded(a2), asDecoded(b1)]);
  });

  test('truncation flags, optional contained-element fields and unicode survive', () => {
    const item = makeItem({
      note: 'emoji 🦎, “curly quotes”, a tab\there, and a backslash \\',
      context: {
        primaryTarget: {
          cssSelector: 'div.big',
          xpath: '//div[1]',
          outerHtmlSnippet: '<div class="big">...[truncated]',
          truncated: true,
        },
        containedElements: [
          { tag: 'div' },
          { tag: 'a', id: 'x', attrs: { href: '/y', 'aria-label': 'why' }, classes: { semantic: [], generated: ['h4sh1'] } },
        ],
        areaText: '',
        pageMeta: {
          ...makeItem().context.pageMeta,
          title: 'ページ — テスト',
        },
        containedElementsTruncated: true,
      },
    });
    const [decoded] = decodeFeedbackMarkdown(build({ [item.normalisedUrl]: [item] })).items;
    expect(decoded).toEqual(asDecoded(item));
  });

  test('notes that look like structure are skipped whole, never read as it', () => {
    const hostile = [
      '## page "https://evil.example/"',
      '### feedback 99',
      '**note:** fake',
      '<details>',
      '<summary>element data</summary>',
      '',
      '```json',
      '{ "id": 99 }',
      '```',
      '',
      '</details>',
      '```',
    ].join('\n');
    const first = makeItem({ id: 1, note: hostile });
    const second = makeItem({ id: 2, note: 'after the hostile one' });
    const decoded = decodeFeedbackMarkdown(build({ [first.normalisedUrl]: [first, second] }));
    expect(decoded.items).toEqual([asDecoded(first), asDecoded(second)]);
  });

  test('a note quoting a whole exported item with the same id is still read from the real block', () => {
    const quoted = build({ 'https://example.com/page-one': [makeItem({ note: 'quoted' })] });
    const item = makeItem({ note: quoted.split('\n').slice(5).join('\n') });
    const second = makeItem({ id: 2, note: 'the next one' });
    const decoded = decodeFeedbackMarkdown(build({ [item.normalisedUrl]: [item, second] }));
    // The quoted block carries id 1 too, but its note doesn't render to the
    // lines above it; the real block's does.
    expect(decoded.items).toEqual([asDecoded(item), asDecoded(second)]);
  });

  test('with the visible note edited by hand, the first block with the id is read', () => {
    const item = makeItem({ note: 'original' });
    const md = build({ [item.normalisedUrl]: [item] }).replace('**note:** original', '**note:** edited\n\nand longer');
    expect(decodeFeedbackMarkdown(md).items).toEqual([asDecoded(item)]);
  });
});

describe('decodeFeedbackMarkdown — format dispatch', () => {
  function rejects(markdown: string, version: number | null): void {
    let thrown: unknown;
    try {
      decodeFeedbackMarkdown(markdown);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedFormatError);
    expect((thrown as UnsupportedFormatError).version).toBe(version);
  }

  test('a retired v1 bundle is refused, not read', () => {
    rejects(
      '<!-- annotator-schema-version: 1 -->\n\n## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: 1\n```\n',
      null,
    );
  });

  test('a newer format is refused', () => {
    const item = makeItem();
    rejects(build({ [item.normalisedUrl]: [item] }).replace('salamander-feedback-format: 2', 'salamander-feedback-format: 3'), 3);
  });

  test('a file with no stamp, or the stamp anywhere but line 1, is refused', () => {
    const item = makeItem();
    const md = build({ [item.normalisedUrl]: [item] });
    rejects(md.split('\n').slice(1).join('\n'), null);
    rejects(`\n${md}`, null);
    rejects('', null);
  });
});

describe('decodeFeedbackMarkdown — malformed current-format files throw a plain Error', () => {
  const item = makeItem();
  const good = build({ [item.normalisedUrl]: [item] });

  test.each([
    ['the screenshot line is missing', good.replace('![feedback 1](screenshots/1.png)\n', '')],
    ['the screenshot line names another id', good.replace('screenshots/1.png', 'screenshots/2.png')],
    ['the note line is missing', good.replace('**note:** this button is misaligned', 'this button is misaligned')],
    ['the json is unparsable', good.replace('"id": 1,', '"id": 1,,')],
    ['the json is for another id', good.replace('"id": 1,', '"id": 2,')],
    ['the json fence is unterminated', good.replace(/\n```\n\n<\/details>\n$/, '\n')],
    ['the details block is unclosed', good.replace(/<\/details>\n$/, '')],
    ['a required field is missing', good.replace(/\n  "area_text": .*\n/, '\n')],
    ['a field has the wrong type', good.replace('"dpr": 2,', '"dpr": "2",')],
    ['a rect member is not a number', good.replace('"x": 10,', '"x": null,')],
    ['a contained element has no tag', good.replace('"tag": "span",', '')],
    ['a truncation flag is not a boolean', good.replace('"area_text"', '"contained_elements_truncated": "yes",\n  "area_text"')],
    ['a note comes before any page heading', good.replace('## page "https://example.com/page-one"\n', '')],
  ])('%s', (_, markdown) => {
    expect(markdown).not.toBe(good);
    let thrown: unknown;
    try {
      decodeFeedbackMarkdown(markdown);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnsupportedFormatError);
  });

  test('the derived text field is optional and ignored on import', () => {
    const [decoded] = decodeFeedbackMarkdown(good.replace(/\n  "text": .*\n/, '\n')).items;
    expect(decoded).toEqual(asDecoded(item));
  });

  test('lines outside notes that a person added are ignored', () => {
    const edited = good.replace('## page', 'a line someone added\n\n## page');
    expect(decodeFeedbackMarkdown(edited).items).toEqual([asDecoded(item)]);
  });

  test('a stamped file with no notes reads as empty', () => {
    expect(decodeFeedbackMarkdown(build({})).items).toEqual([]);
  });
});
