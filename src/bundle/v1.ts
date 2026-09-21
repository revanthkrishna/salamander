// src/bundle/v1.ts
// FROZEN — schema version 1 of feedback.md: the section/fence grammar, the
// snake_case yaml mirror types, both codecs and the parser, exactly as every
// bundle exported so far was written. Nothing in this file changes shape any
// more: a change to the format is a new `bundle/v2.ts` plus a step in
// src/bundle/index.ts's dispatcher, and this file keeps reading the bundles
// already on disk. src/__tests__/fixtures/feedback-v1.md is the golden copy
// of what this writer produces; bundleV1.test.ts holds both halves to it.
//
// Format (REQUIREMENTS §1.6):
//   - one "## {normalised url}" section per URL, ordered by that URL's
//     first-captured item (lowest item id, since ids are assigned
//     sequentially at capture time — §1.2)
//   - within a section, items in chronological (capture) order
//   - each item: a "### item {id}" heading, an inline image reference to
//     `screenshots/{id}.png` (renders alongside the note in any standard
//     markdown viewer), the note as plain prose, and the §1.4 captured
//     context embedded directly below as a fenced ```yaml block
//
// Known limitations (accepted in v1, not fixed here — fixing them is a
// grammar change and therefore a v2): a note whose text contains a line that
// is *exactly* "```yaml" is misread as the start of the context fence, and a
// note line starting with "## " or "### item " is read as structure and
// truncates the item. Notes are free-text user input and this format doesn't
// escape/fence them specially.

import * as yaml from 'js-yaml';
import { FeedbackItem } from '../types';
import { versionComment } from './version';

/** The schema version this file writes and reads. */
export const SCHEMA_VERSION_V1 = 1;

// ---------------------------------------------------------------------------
// Bundle serialisation mirror types (REQUIREMENTS §1.6/§1.7)
// ---------------------------------------------------------------------------
// snake_case field names, for the fenced ```yaml blocks embedded per-item in
// feedback.md. The note text and screenshot image are NOT part of this
// object — they live as plain markdown prose / an image reference alongside
// it (§1.6) — this yaml block is exactly the §1.4 captured context plus the
// item-identifying fields an importer needs to reconstruct a FeedbackItem.

export interface YamlRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface YamlPrimaryTarget {
  css_selector: string;
  xpath: string;
  outer_html_snippet: string;
  truncated: boolean;
}

export interface YamlContainedElement {
  tag: string;
  id?: string;
  classes?: {
    semantic: string[];
    generated: string[];
  };
  attrs?: Record<string, string>;
  text?: string;
}

export interface YamlPageMeta {
  url: string;
  normalised_url: string;
  title: string;
  viewport: { width: number; height: number };
  dpr: number;
  selection_rect: YamlRect;
  captured_at: string;
}

export interface YamlCapturedContext {
  primary_target: YamlPrimaryTarget;
  contained_elements: YamlContainedElement[];
  area_text: string;
  page_meta: YamlPageMeta;
  contained_elements_truncated?: boolean;
}

/** One item's fenced yaml block. `id` maps to `screenshots/{id}.png` (§1.6). */
export interface YamlFeedbackItem {
  id: number;
  page_url: string;
  normalised_url: string;
  created_at: string;
  selection_rect: YamlRect;
  viewport: { width: number; height: number };
  dpr: number;
  context: YamlCapturedContext;
}

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

  return `${versionComment(SCHEMA_VERSION_V1)}\n\n${sections.map(renderSection).join('\n')}`;
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

/** FeedbackItem -> its snake_case yaml-block mirror (§1.6). Exported so the
 *  round-trip tests can build the same shape independently of the markdown
 *  text around it. */
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

/**
 * Inverse of `toYamlFeedbackItem`: a parsed fence's yaml object
 * plus the prose note sitting above it -> everything a `FeedbackItem` needs
 * except `screenshotKey`/`thumbnailDataUrl`. Those two are deliberately not
 * part of the yaml block (they're internal storage handles, not information
 * a human/agent reading `feedback.md` needs — §1.6) — src/import.ts asks the
 * service worker to mint fresh ones at write time, mirroring how the capture
 * pipeline never lets the content script invent an id or a storage key
 * either.
 *
 * Throws a plain `Error` (not `ImportError` — this module has no opinion on
 * user-facing copy) if the object is missing a field this shape requires;
 * src/import.ts maps that to §5 #4b's "corrupted" message.
 */
export function fromYamlFeedbackItem(
  note: string,
  y: YamlFeedbackItem,
): Omit<FeedbackItem, 'screenshotKey' | 'thumbnailDataUrl'> {
  if (
    !y ||
    typeof y.id !== 'number' ||
    typeof y.page_url !== 'string' ||
    typeof y.normalised_url !== 'string' ||
    typeof y.created_at !== 'string' ||
    !y.selection_rect ||
    !y.viewport ||
    typeof y.dpr !== 'number' ||
    !y.context ||
    !y.context.primary_target ||
    !y.context.page_meta
  ) {
    throw new Error('malformed feedback item yaml block');
  }

  const ctx = y.context;
  return {
    id: y.id,
    pageUrl: y.page_url,
    normalisedUrl: y.normalised_url,
    note,
    createdAt: y.created_at,
    selectionRect: { ...y.selection_rect },
    viewport: { ...y.viewport },
    dpr: y.dpr,
    context: {
      primaryTarget: {
        cssSelector: ctx.primary_target.css_selector,
        xpath: ctx.primary_target.xpath,
        outerHtmlSnippet: ctx.primary_target.outer_html_snippet,
        truncated: ctx.primary_target.truncated,
      },
      containedElements: (ctx.contained_elements ?? []).map((el) => ({
        tag: el.tag,
        ...(el.id !== undefined ? { id: el.id } : {}),
        ...(el.classes !== undefined ? { classes: el.classes } : {}),
        ...(el.attrs !== undefined ? { attrs: el.attrs } : {}),
        ...(el.text !== undefined ? { text: el.text } : {}),
      })),
      areaText: ctx.area_text ?? '',
      pageMeta: {
        url: ctx.page_meta.url,
        normalisedUrl: ctx.page_meta.normalised_url,
        title: ctx.page_meta.title,
        viewport: { ...ctx.page_meta.viewport },
        dpr: ctx.page_meta.dpr,
        selectionRect: { ...ctx.page_meta.selection_rect },
        capturedAt: ctx.page_meta.captured_at,
      },
      ...(ctx.contained_elements_truncated !== undefined
        ? { containedElementsTruncated: ctx.contained_elements_truncated }
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
 * src/import.ts's §5 error ladder) but strict about *shape*: a missing image
 * reference or an unterminated/malformed yaml fence throws, since that shape
 * mismatch is exactly what §5 #4b ("this bundle appears to be corrupted —
 * couldn't read feedback data") means. import.ts wraps these throws in that
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
