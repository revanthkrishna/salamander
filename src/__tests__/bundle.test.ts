// src/bundle — the feedback.md writer and reader (design spec §AC) against
// generated input: ordering, the round trip the importer builds on, notes
// that try to look like structure, the format dispatch, and the reader's
// error shape. The frozen text fixture has its own file (bundleV2.test.ts).

import {
  buildFeedbackMarkdown,
  decodeFeedbackMarkdown,
  ExportHeader,
  FORMAT_VERSION,
  UnsupportedFormatError,
} from '../bundle';
import {
  capText,
  formatExportDate,
  FORMAT_VERSION_V2,
  JSON_TEXT_LIMITS,
  primaryTargetText,
  toJsonFeedbackItem,
} from '../bundle/v2';
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

  test('writes notes within a page in list order and numbers them by position, whatever their ids', () => {
    const url = 'https://example.com/page';
    const later = makeItem({ id: 5, normalisedUrl: url, note: 'later' });
    const earlier = makeItem({ id: 3, normalisedUrl: url, note: 'earlier' });
    const md = build({ [url]: [later, earlier] });

    // The page's array order is the sidebar's order, so it is the file's
    // too — never re-sorted by id — and the heading is the position in it;
    // the screenshot path is the id (types.ts, FeedbackItem.id).
    expect(md).toContain('### feedback 1\n\n![feedback 1](screenshots/5.png)');
    expect(md).toContain('### feedback 2\n\n![feedback 2](screenshots/3.png)');
    expect(md.indexOf('screenshots/5.png')).toBeLessThan(md.indexOf('screenshots/3.png'));
    expect(md).not.toContain('### feedback 3');
  });

  test('every page numbers its notes from 1; the same number on two pages is two notes, told apart by id', () => {
    const a1 = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    const a2 = makeItem({ id: 3, normalisedUrl: 'https://example.com/a' });
    const b1 = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    const md = build({ 'https://example.com/a': [a1, a2], 'https://example.com/b': [b1] });

    expect(md.match(/^### feedback \d+$/gm)).toEqual(['### feedback 1', '### feedback 2', '### feedback 1']);
    expect(md.match(/screenshots\/\d+\.png/g)).toEqual(['screenshots/1.png', 'screenshots/3.png', 'screenshots/2.png']);
    // The json carries the id only — the position is the heading, not a field.
    expect(md.match(/^  "id": \d+,$/gm)).toEqual(['  "id": 1,', '  "id": 3,', '  "id": 2,']);
    expect(md).not.toMatch(/"number"|"position"/);
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
      'area_text',
    ]);
    // no truncation flags, even for an item capture had cut
    expect(md).not.toMatch(/page_meta|captured_at|_truncated/);
  });

  test('no truncation flags: a cut value ends in a single ellipsis instead', () => {
    const cut = makeItem({
      context: {
        ...makeItem().context,
        primaryTarget: { ...makeItem().context.primaryTarget, outerHtmlSnippet: '<b>x...[truncated]', truncated: true },
        containedElementsTruncated: true,
      },
    });
    const json = toJsonFeedbackItem(cut);
    expect(json).not.toHaveProperty('html_truncated');
    expect(json).not.toHaveProperty('contained_elements_truncated');
    // capture's own cut marker becomes the one ellipsis convention
    expect(json.html).toBe('<b>x\u2026');
  });

  test('free-text fields are capped, each ending in an ellipsis past its limit', () => {
    const long = (n: number) => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n);
    const item = makeItem({
      context: {
        ...makeItem().context,
        primaryTarget: {
          ...makeItem().context.primaryTarget,
          outerHtmlSnippet: `<p>${long(900)}</p>`,
        },
        containedElements: [{ tag: 'a', attrs: { href: `/${long(300)}` }, text: long(300) }],
        areaText: long(900),
      },
    });
    const json = toJsonFeedbackItem(item);
    const E = '\u2026';
    expect(json.html).toHaveLength(JSON_TEXT_LIMITS.html + 1);
    expect(json.html.endsWith(E)).toBe(true);
    expect(json.text).toHaveLength(JSON_TEXT_LIMITS.text + 1);
    expect(json.text.endsWith(E)).toBe(true);
    expect(json.area_text).toHaveLength(JSON_TEXT_LIMITS.areaText + 1);
    expect(json.contained_elements[0].text).toHaveLength(JSON_TEXT_LIMITS.element + 1);
    expect(json.contained_elements[0].attrs!.href).toHaveLength(JSON_TEXT_LIMITS.element + 1);
  });

  test('values within their limit are untouched', () => {
    const json = toJsonFeedbackItem(makeItem());
    expect(json.html).toBe(makeItem().context.primaryTarget.outerHtmlSnippet);
    expect(json.area_text).toBe(makeItem().context.areaText);
    expect(json.html.endsWith('\u2026')).toBe(false);
  });

  test('the note and every identifier are never capped', () => {
    const huge = 'x'.repeat(2000);
    const item = makeItem({
      note: huge,
      pageUrl: `https://example.com/${huge}`,
      context: {
        ...makeItem().context,
        primaryTarget: { ...makeItem().context.primaryTarget, cssSelector: `div.${huge}`, xpath: `/html/${huge}` },
      },
    });
    const json = toJsonFeedbackItem(item);
    expect(json.note).toBe(huge);
    expect(json.page_url).toBe(`https://example.com/${huge}`);
    expect(json.selector).toBe(`div.${huge}`);
    expect(json.xpath).toBe(`/html/${huge}`);
  });

  test('capText: under the limit as-is, over it cut and ended with an ellipsis', () => {
    expect(capText('short', 10)).toBe('short');
    expect(capText('exactly ten', 11)).toBe('exactly ten');
    expect(capText('this is too long', 7)).toBe('this is\u2026');
    // an already-cut value is marked even when it now fits
    expect(capText('cut here', 20, true)).toBe('cut here\u2026');
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
    expect(decoded.entries.map((e) => e.item)).toEqual([asDecoded(a1), asDecoded(a2), asDecoded(b1)]);
    // Each note comes back with the number its heading showed: its position
    // on its page, restarting on the second page.
    expect(decoded.entries.map((e) => e.number)).toEqual([1, 2, 1]);
  });

  test('optional contained-element fields and unicode survive; a cut html comes back as written', () => {
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
    const [decoded] = decodeFeedbackMarkdown(build({ [item.normalisedUrl]: [item] })).entries.map((e) => e.item);
    // The file is the record: capture's cut marker is written as the one
    // ellipsis, so that is what comes back, still marked truncated; and the
    // list's truncation flag, which the file no longer carries, does not.
    const { containedElementsTruncated: _gone, ...context } = asDecoded(item).context;
    expect(decoded).toEqual({
      ...asDecoded(item),
      context: {
        ...context,
        primaryTarget: { ...context.primaryTarget, outerHtmlSnippet: '<div class="big">\u2026', truncated: true },
      },
    });
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
    expect(decoded.entries.map((e) => e.item)).toEqual([asDecoded(first), asDecoded(second)]);
  });

  test('a note quoting a whole exported item with the same id is still read from the real block', () => {
    const quoted = build({ 'https://example.com/page-one': [makeItem({ note: 'quoted' })] });
    const item = makeItem({ note: quoted.split('\n').slice(5).join('\n') });
    const second = makeItem({ id: 2, note: 'the next one' });
    const decoded = decodeFeedbackMarkdown(build({ [item.normalisedUrl]: [item, second] }));
    // The quoted block carries id 1 too, but its note doesn't render to the
    // lines above it; the real block's does.
    expect(decoded.entries.map((e) => e.item)).toEqual([asDecoded(item), asDecoded(second)]);
  });

  test('with the visible note edited by hand, the first block with the id is read', () => {
    const item = makeItem({ note: 'original' });
    const md = build({ [item.normalisedUrl]: [item] }).replace('**note:** original', '**note:** edited\n\nand longer');
    expect(decodeFeedbackMarkdown(md).entries.map((e) => e.item)).toEqual([asDecoded(item)]);
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
    ['the screenshot line names an id the json does not carry', good.replace('screenshots/1.png', 'screenshots/2.png')],
    ['the note line is missing', good.replace('**note:** this button is misaligned', 'this button is misaligned')],
    ['the json is unparsable', good.replace('"id": 1,', '"id": 1,,')],
    ['the json is for another id', good.replace('"id": 1,', '"id": 2,')],
    ['the json fence is unterminated', good.replace(/\n```\n\n<\/details>\n$/, '\n')],
    ['the details block is unclosed', good.replace(/<\/details>\n$/, '')],
    ['a required field is missing', good.replace(/\n  "area_text": .*\n/, '\n')],
    ['a field has the wrong type', good.replace('"dpr": 2,', '"dpr": "2",')],
    ['a rect member is not a number', good.replace('"x": 10,', '"x": null,')],
    ['a contained element has no tag', good.replace('"tag": "span",', '')],
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

  test('a heading whose number is not the note\'s position still reads, the number taken as written', () => {
    // A hand-edited file may have gaps (someone deleted a note by hand); the
    // list renumbers on the next draw, so the reader does not police it.
    const [entry] = decodeFeedbackMarkdown(good.replace('### feedback 1', '### feedback 7')).entries;
    expect(entry).toEqual({ number: 7, item: asDecoded(item) });
  });

  test('the derived text field is optional and ignored on import', () => {
    const [decoded] = decodeFeedbackMarkdown(good.replace(/\n  "text": .*\n/, '\n')).entries.map((e) => e.item);
    expect(decoded).toEqual(asDecoded(item));
  });

  test('lines outside notes that a person added are ignored', () => {
    const edited = good.replace('## page', 'a line someone added\n\n## page');
    expect(decodeFeedbackMarkdown(edited).entries.map((e) => e.item)).toEqual([asDecoded(item)]);
  });

  test('a stamped file with no notes reads as empty', () => {
    expect(decodeFeedbackMarkdown(build({})).entries.map((e) => e.item)).toEqual([]);
  });
});


describe('src/bundle — the current format is the v2 codec', () => {
  test('FORMAT_VERSION (what this build writes) is the v2 codec\'s own version', () => {
    // The reader dispatches on each codec's own version so old files keep
    // reading after a bump; the writer must be the codec FORMAT_VERSION
    // names, or export would stamp a version the reader refuses.
    expect(FORMAT_VERSION).toBe(FORMAT_VERSION_V2);
  });
});
