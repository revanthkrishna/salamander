// src/bundle — the current-version feedback.md writer, the v1 grammar's
// parser and the round-trip contract the importer builds on. The frozen v1
// text fixture has its own file (bundleV1.test.ts); this one exercises the
// codec pair against generated input.

import { buildFeedbackMarkdown, decodeFeedbackMarkdown } from '../bundle';
import { parseFeedbackMarkdown, toYamlFeedbackItem } from '../bundle/v1';
import { FeedbackItem } from '../types';

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

describe('buildFeedbackMarkdown', () => {
  test('renders one section per url with a heading, image ref, note, and yaml fence', () => {
    const item = makeItem();
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] });

    expect(md).toContain('## https://example.com/page-one');
    expect(md).toContain('### item 1');
    expect(md).toContain('![](screenshots/1.png)');
    expect(md).toContain('this button is misaligned');
    expect(md).toContain('```yaml');
    expect(md).toContain('css_selector: button.submit');
  });

  test('orders sections by first-captured item across urls', () => {
    const first = makeItem({ id: 1, normalisedUrl: 'https://example.com/a' });
    const second = makeItem({ id: 2, normalisedUrl: 'https://example.com/b' });
    // Deliberately built out of capture order to prove sorting, not insertion
    // order, drives section placement.
    const md = buildFeedbackMarkdown({
      'https://example.com/b': [second],
      'https://example.com/a': [first],
    });

    const aIndex = md.indexOf('## https://example.com/a');
    const bIndex = md.indexOf('## https://example.com/b');
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThan(aIndex);
  });

  test('orders items within a url section chronologically by id', () => {
    const url = 'https://example.com/page';
    const later = makeItem({ id: 5, normalisedUrl: url, note: 'later' });
    const earlier = makeItem({ id: 3, normalisedUrl: url, note: 'earlier' });
    const md = buildFeedbackMarkdown({ [url]: [later, earlier] });

    const earlierIndex = md.indexOf('### item 3');
    const laterIndex = md.indexOf('### item 5');
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThan(earlierIndex);
  });

  test('omits urls with no items', () => {
    const item = makeItem();
    const md = buildFeedbackMarkdown({
      [item.normalisedUrl]: [item],
      'https://example.com/empty': [],
    });
    expect(md).not.toContain('empty');
  });
});

describe('round trip: buildFeedbackMarkdown -> parseFeedbackMarkdown', () => {
  test('a single-url, single-item bundle round-trips exactly', () => {
    const item = makeItem();
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] });
    const sections = parseFeedbackMarkdown(md);

    expect(sections).toHaveLength(1);
    expect(sections[0].url).toBe(item.normalisedUrl);
    expect(sections[0].items).toHaveLength(1);
    expect(sections[0].items[0].id).toBe(item.id);
    expect(sections[0].items[0].note).toBe(item.note);
    expect(sections[0].items[0].yaml).toEqual(toYamlFeedbackItem(item));
  });

  test('a multi-url, multi-item bundle round-trips exactly', () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const itemA1 = makeItem({ id: 1, normalisedUrl: urlA, note: 'a1' });
    const itemA2 = makeItem({ id: 3, normalisedUrl: urlA, note: 'a2\nwith a second line' });
    const itemB1 = makeItem({ id: 2, normalisedUrl: urlB, note: 'b1' });

    const pages = { [urlA]: [itemA1, itemA2], [urlB]: [itemB1] };
    const md = buildFeedbackMarkdown(pages);
    const sections = parseFeedbackMarkdown(md);

    expect(sections).toHaveLength(2);

    const sectionA = sections.find((s) => s.url === urlA)!;
    const sectionB = sections.find((s) => s.url === urlB)!;

    expect(sectionA.items.map((i) => i.id)).toEqual([1, 3]);
    expect(sectionA.items[1].note).toBe('a2\nwith a second line');
    expect(sectionA.items[0].yaml).toEqual(toYamlFeedbackItem(itemA1));
    expect(sectionA.items[1].yaml).toEqual(toYamlFeedbackItem(itemA2));

    expect(sectionB.items.map((i) => i.id)).toEqual([2]);
    expect(sectionB.items[0].yaml).toEqual(toYamlFeedbackItem(itemB1));
  });

  test('preserves an item whose context hits the truncation markers', () => {
    const item = makeItem({
      context: {
        primaryTarget: {
          cssSelector: 'div.big',
          xpath: '//div[1]',
          outerHtmlSnippet: '<div class="big">...[truncated]',
          truncated: true,
        },
        containedElements: [],
        areaText: 'lots of text',
        pageMeta: {
          url: 'https://example.com/page-one',
          normalisedUrl: 'https://example.com/page-one',
          title: 'page one',
          viewport: { width: 1280, height: 800 },
          dpr: 1,
          selectionRect: { x: 0, y: 0, width: 500, height: 500 },
          capturedAt: '2026-01-01T00:00:00.000Z',
        },
        containedElementsTruncated: true,
      },
    });
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] });
    const sections = parseFeedbackMarkdown(md);

    expect(sections[0].items[0].yaml.context.primary_target.truncated).toBe(true);
    expect(sections[0].items[0].yaml.context.contained_elements_truncated).toBe(true);
  });

  test('an empty note round-trips as an empty string', () => {
    const item = makeItem({ note: '' });
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] });
    const sections = parseFeedbackMarkdown(md);
    expect(sections[0].items[0].note).toBe('');
  });
});

describe('decodeFeedbackMarkdown (the versioned reader)', () => {
  test('reads a current-version file back to the in-memory item shape, minus the storage handles', () => {
    const item = makeItem({ note: 'line one\n\nline three' });
    const decoded = decodeFeedbackMarkdown(buildFeedbackMarkdown({ [item.normalisedUrl]: [item] }));

    expect(decoded.version).toBe(1);
    expect(decoded.versionWarning).toBe(false);
    const { screenshotKey: _k, thumbnailDataUrl: _t, ...expected } = item;
    expect(decoded.items).toEqual([expected]);
  });

  test('a file with no version stamp is read as version 1', () => {
    const item = makeItem();
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] }).replace(/^<!--.*-->\n\n/, '');
    expect(md.startsWith('## ')).toBe(true);
    const decoded = decodeFeedbackMarkdown(md);
    expect(decoded.version).toBe(1);
    expect(decoded.items.map((i) => i.id)).toEqual([1]);
  });

  test('a newer version is read best-effort with the newest codec and flagged', () => {
    const item = makeItem();
    const md = buildFeedbackMarkdown({ [item.normalisedUrl]: [item] }).replace(
      'annotator-schema-version: 1',
      'annotator-schema-version: 99',
    );
    const decoded = decodeFeedbackMarkdown(md);
    expect(decoded.version).toBe(99);
    expect(decoded.versionWarning).toBe(true);
    expect(decoded.items).toHaveLength(1);
  });

  test('throws a plain Error for a fence missing a required field', () => {
    const md = '## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: 1\n```\n';
    expect(() => decodeFeedbackMarkdown(md)).toThrow(Error);
  });
});

describe('parseFeedbackMarkdown error shape', () => {
  test('throws when an item is missing its image reference', () => {
    const broken = '## https://example.com/page\n\n### item 1\n\nno image here\n\n```yaml\nid: 1\n```\n';
    expect(() => parseFeedbackMarkdown(broken)).toThrow();
  });

  test('throws when a yaml fence is unterminated', () => {
    const broken =
      '## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: 1\n';
    expect(() => parseFeedbackMarkdown(broken)).toThrow();
  });

  test('throws on a malformed yaml fence body', () => {
    const broken =
      '## https://example.com/page\n\n### item 1\n\n![](screenshots/1.png)\n\nnote\n\n```yaml\nid: [1, 2\n```\n';
    expect(() => parseFeedbackMarkdown(broken)).toThrow();
  });
});
