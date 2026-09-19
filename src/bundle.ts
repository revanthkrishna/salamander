// src/bundle.ts
// Phase 8 — feedback.md serialisation *and* the shared section/fence grammar
// (REQUIREMENTS §1.6). Phase 9's importer parses against exactly this
// grammar, so the format is defined once, here, rather than splitting the
// contract across two phases' worth of assumptions. Phase 9 extends
// `parseFeedbackMarkdown` with the full §5 validation ladder (domain
// mismatch, duplicate ids, version warnings, etc.) — what's here is the
// shape-level grammar both sides already have to agree on for a round trip
// to work at all.
//
// Format (§1.6):
//   - one "## {normalised url}" section per URL, ordered by that URL's
//     first-captured item (lowest item id, since ids are assigned
//     sequentially at capture time — §1.2)
//   - within a section, items in chronological (capture) order
//   - each item: a "### item {id}" heading, an inline image reference to
//     `screenshots/{id}.png` (renders alongside the note in any standard
//     markdown viewer), the note as plain prose, and the §1.4 captured
//     context embedded directly below as a fenced ```yaml block
//
// Known limitation (accepted, not fixed here): a note whose text contains a
// line that is *exactly* "```yaml" would be misread as the start of the
// context fence. Notes are free-text user input and this extension doesn't
// escape/fence them specially — considered acceptable given how narrow and
// deliberate a note would have to be to hit it.

import * as yaml from 'js-yaml';
import { FeedbackItem, YamlFeedbackItem } from './types';

const FENCE_OPEN = '```yaml';
const FENCE_CLOSE = '```';

const SECTION_HEADING_RE = /^## (.+)$/;
const ITEM_HEADING_RE = /^### item (\d+)$/;
const IMAGE_LINE_RE = /^!\[\]\(screenshots\/(\d+)\.png\)$/;

// ---------------------------------------------------------------------------
// Serialise: DomainData.pages -> feedback.md
// ---------------------------------------------------------------------------

/**
 * Build the full `feedback.md` contents for a domain's worth of feedback
 * (§1.6 — export covers *all* URLs of the domain, not just the current
 * page). `pages` is exactly `DomainData.pages` (src/types.ts): keyed by
 * normalised URL, values in capture order.
 */
export function buildFeedbackMarkdown(pages: Record<string, FeedbackItem[]>): string {
  const sections = Object.entries(pages)
    .map(([url, items]) => ({ url, items: [...items].sort(byId) }))
    .filter((section) => section.items.length > 0)
    .sort((a, b) => a.items[0].id - b.items[0].id);

  return sections.map(renderSection).join('\n');
}

function byId(a: FeedbackItem, b: FeedbackItem): number {
  return a.id - b.id;
}

function renderSection(section: { url: string; items: FeedbackItem[] }): string {
  const itemBlocks = section.items.map(renderItem).join('\n');
  return `## ${section.url}\n\n${itemBlocks}`;
}

function renderItem(item: FeedbackItem): string {
  const yamlBlock = yaml
    .dump(toYamlFeedbackItem(item), { lineWidth: -1, noRefs: true })
    .trimEnd();
  const note = item.note.trim();
  return [
    `### item ${item.id}`,
    '',
    `![](screenshots/${item.id}.png)`,
    '',
    note,
    '',
    FENCE_OPEN,
    yamlBlock,
    FENCE_CLOSE,
    '',
  ].join('\n');
}

/** FeedbackItem -> its snake_case yaml-block mirror (§1.6). Exported so
 *  Phase 9's importer (and this file's own round-trip test) can build the
 *  same shape independently of the markdown text around it. */
export function toYamlFeedbackItem(item: FeedbackItem): YamlFeedbackItem {
  const ctx = item.context;
  return {
    id: item.id,
    page_url: item.pageUrl,
    normalised_url: item.normalisedUrl,
    created_at: item.createdAt,
    selection_rect: { ...item.selectionRect },
    viewport: { ...item.viewport },
    dpr: item.dpr,
    context: {
      primary_target: {
        css_selector: ctx.primaryTarget.cssSelector,
        xpath: ctx.primaryTarget.xpath,
        outer_html_snippet: ctx.primaryTarget.outerHtmlSnippet,
        truncated: ctx.primaryTarget.truncated,
      },
      contained_elements: ctx.containedElements.map((el) => ({
        tag: el.tag,
        ...(el.id !== undefined ? { id: el.id } : {}),
        ...(el.classes !== undefined ? { classes: el.classes } : {}),
        ...(el.attrs !== undefined ? { attrs: el.attrs } : {}),
        ...(el.text !== undefined ? { text: el.text } : {}),
      })),
      area_text: ctx.areaText,
      page_meta: {
        url: ctx.pageMeta.url,
        normalised_url: ctx.pageMeta.normalisedUrl,
        title: ctx.pageMeta.title,
        viewport: { ...ctx.pageMeta.viewport },
        dpr: ctx.pageMeta.dpr,
        selection_rect: { ...ctx.pageMeta.selectionRect },
        captured_at: ctx.pageMeta.capturedAt,
      },
      ...(ctx.containedElementsTruncated !== undefined
        ? { contained_elements_truncated: ctx.containedElementsTruncated }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Parse: feedback.md -> per-URL sections of {id, note, yaml}
// ---------------------------------------------------------------------------

export interface ParsedBundleItem {
  id: number;
  note: string;
  yaml: YamlFeedbackItem;
}

export interface ParsedBundleSection {
  url: string;
  items: ParsedBundleItem[];
}

/**
 * Parse `feedback.md`'s grammar back into structured sections. Deliberately
 * permissive about *values* (deciding whether those values are valid is
 * Phase 9's §5 error ladder) but strict about *shape*: a missing image
 * reference or an unterminated/malformed yaml fence throws, since that shape
 * mismatch is exactly what §5 #4b ("this bundle appears to be corrupted —
 * couldn't read feedback data") means. Phase 9 wraps these throws in that
 * ImportError.
 */
export function parseFeedbackMarkdown(markdown: string): ParsedBundleSection[] {
  const lines = markdown.split('\n');
  const sections: ParsedBundleSection[] = [];
  let current: ParsedBundleSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const sectionMatch = SECTION_HEADING_RE.exec(line);
    if (sectionMatch) {
      current = { url: sectionMatch[1].trim(), items: [] };
      sections.push(current);
      i += 1;
      continue;
    }

    const itemMatch = ITEM_HEADING_RE.exec(line);
    if (itemMatch) {
      if (!current) {
        throw new Error('item heading found before any url section');
      }
      const id = parseInt(itemMatch[1], 10);
      const { item, nextIndex } = parseItemBlock(lines, i + 1, id);
      current.items.push(item);
      i = nextIndex;
      continue;
    }

    i += 1;
  }

  return sections;
}

function parseItemBlock(
  lines: string[],
  startIndex: number,
  id: number,
): { item: ParsedBundleItem; nextIndex: number } {
  let i = startIndex;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  const imageMatch = IMAGE_LINE_RE.exec(lines[i] ?? '');
  if (!imageMatch) {
    throw new Error(`item ${id}: missing screenshot image reference`);
  }
  i += 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  const noteLines: string[] = [];
  while (i < lines.length && lines[i].trim() !== FENCE_OPEN) {
    if (SECTION_HEADING_RE.test(lines[i]) || ITEM_HEADING_RE.test(lines[i])) {
      throw new Error(`item ${id}: missing yaml context block`);
    }
    noteLines.push(lines[i]);
    i += 1;
  }
  if (i >= lines.length) {
    throw new Error(`item ${id}: missing yaml context block`);
  }
  const note = noteLines.join('\n').trim();

  i += 1; // past the opening fence
  const yamlLines: string[] = [];
  while (i < lines.length && lines[i].trim() !== FENCE_CLOSE) {
    yamlLines.push(lines[i]);
    i += 1;
  }
  if (i >= lines.length) {
    throw new Error(`item ${id}: unterminated yaml context block`);
  }
  i += 1; // past the closing fence

  let parsedYaml: unknown;
  try {
    parsedYaml = yaml.load(yamlLines.join('\n'));
  } catch {
    throw new Error(`item ${id}: malformed yaml context block`);
  }
  if (!parsedYaml || typeof parsedYaml !== 'object') {
    throw new Error(`item ${id}: malformed yaml context block`);
  }

  return { item: { id, note, yaml: parsedYaml as YamlFeedbackItem }, nextIndex: i };
}
