// src/bundle/v2.ts
// Format version 2 of feedback.md (design spec §AC): one Markdown file that
// is both what a person or coding agent reads and what import reads back.
// src/__tests__/fixtures/feedback-v2.md is the golden copy of what this
// writer produces; bundleV2.test.ts holds the writer and the reader to it.
//
//   <!-- salamander-feedback-format: 2 -->     line 1: the format stamp
//   salamander 1.1.0\                           header: three lines joined by
//   **date exported:** 2026-09-21 21:40 utc-05:00\    trailing `\` so they
//   **website:** example.com                    render as separate lines
//
//   ## page "{normalised url}"                  pages in first-capture order
//
//   ### feedback {n}                            notes in capture order, n =
//                                               position on the page from 1
//   ![feedback {n}](screenshots/{id}.png)       alt gains " — marked up by the
//                                               reviewer" when drawn on (§AB)
//   **note:** {note, or "(none)"}
//
//   <details>
//   <summary>element data</summary>
//
//   ```json
//   { ...the complete record, 2-space indent... }
//   ```
//
//   </details>
//
// The JSON block is the whole item and the only thing import reads; the
// visible note line is for people and is ignored on the way back in. Every
// fixed label is lowercase; user content (notes, urls, page text) is written
// exactly as captured.
//
// Two numbers per note, on purpose (types.ts, FeedbackItem.id). The heading
// and alt text carry the DISPLAY number — the note's 1-based position on its
// page, the same number its badge and title show in the sidebar, restarting
// at 1 on every page. The screenshot filename and the json `id` carry the
// INTERNAL id, unique across the whole domain, so image files never collide
// across pages and an import can keep the id as the note's identity. The
// display number is not written into the json: it is the heading, and a
// record that also carried its own position could disagree with where it
// sits after a hand edit. The reader hands both back — the number so the
// importer can refuse a page that lists the same number twice (§5 #11), the
// id as the record's own.
//
// No field is written twice. The in-memory item repeats six of its own
// fields inside `context.pageMeta` (url, normalised url, viewport, dpr,
// selection rect, capture time — capture.ts fills both from the same values);
// only the page title is unique there, so only `page_title` is written, and
// the reader rebuilds `pageMeta` from the item-level fields.
//
// Why notes cannot break the grammar: an item is read in order — heading,
// image line, note line, then its `<details>` block, the one whose fenced
// json parses to an object with the image line's id (and, when a note quotes
// such a block itself, whose note renders to exactly the lines above it) —
// and the parser resumes after that block's `</details>`. Whatever the note
// contains (headings, fences, a quoted item) is skipped with it. The json
// body itself can never contain a line that is exactly ``` (every line of
// pretty-printed json is a brace or an indented member), so its closing
// fence is found unambiguously.

import type { ContainedElement, FeedbackItem, Rect, ViewportSize } from '../types';
import { hasStrokes } from '../drawing';
import { formatMarker } from './version';

/** The format version this file writes and reads. */
export const FORMAT_VERSION_V2 = 2;

/** What the header says about the export itself. Passed in rather than read
 *  here, so the writer is pure and a test can pin its output exactly. */
export interface ExportHeader {
  /** The extension's manifest version. */
  extensionVersion: string;
  /** The domain the bundle covers. */
  website: string;
  exportedAt: Date;
  /** The exporter's local offset from utc, in minutes east of it (utc-05:00
   *  is -300) — `-date.getTimezoneOffset()` for the machine's own zone. */
  utcOffsetMinutes: number;
}

// ---------------------------------------------------------------------------
// The json record (§AC's field list, in its order)
// ---------------------------------------------------------------------------

export interface JsonContainedElement {
  tag: string;
  id?: string;
  classes?: { semantic: string[]; generated: string[] };
  attrs?: Record<string, string>;
  text?: string;
}

/** One item's json block. Key order is significant — it is the order the
 *  writer emits: what an agent needs to find the element comes first. */
export interface JsonFeedbackItem {
  /** Derived at export from `html` (primaryTargetText) — not stored on the
   *  item, so the reader ignores it. */
  text: string;
  selector: string;
  xpath: string;
  html: string;
  page_url: string;
  note: string;
  id: number;
  normalised_url: string;
  page_title: string;
  created_at: string;
  selection_rect: Rect;
  viewport: ViewportSize;
  dpr: number;
  contained_elements: JsonContainedElement[];
  area_text: string;
}

/** An item as read back from a bundle: everything a FeedbackItem needs
 *  except the two storage handles the service worker mints at import (the
 *  bundle never carries them — §1.6). */
export type DecodedBundleItem = Omit<FeedbackItem, 'screenshotKey' | 'thumbnailDataUrl'>;

/** One note as the reader gives it back: the item, and the display number
 *  its `### feedback {n}` heading showed. The number is not part of the
 *  item (it is never stored — the list position is recomputed at every
 *  render); it is here for the importer's duplicate check. */
export interface DecodedBundleEntry {
  number: number;
  item: DecodedBundleItem;
}

const NOTE_LABEL = '**note:** ';
const EMPTY_NOTE = '(none)';
const DRAWN_ALT_SUFFIX = ' — marked up by the reviewer';
const DETAILS_OPEN = '<details>';
const DETAILS_SUMMARY = '<summary>element data</summary>';
const DETAILS_CLOSE = '</details>';
const JSON_FENCE_OPEN = '```json';
const FENCE_CLOSE = '```';

const PAGE_HEADING_RE = /^## page "(.*)"$/;
const ITEM_HEADING_RE = /^### feedback (\d+)$/;
const IMAGE_LINE_RE = /^!\[[^\]]*\]\(screenshots\/(\d+)\.png\)$/;

// ---------------------------------------------------------------------------
// Write: DomainData.pages -> feedback.md
// ---------------------------------------------------------------------------

/**
 * The full `feedback.md` for a domain's worth of feedback (§1.6 — export
 * covers every url of the domain). `pages` is exactly `DomainData.pages`:
 * keyed by normalised url, values in capture order. Notes are written in
 * that array order and numbered by their position in it — the same order
 * and numbers the sidebar shows for the page, by construction. Pages are
 * ordered by their first note's id: ids are allocated in capture order, so
 * that is the order the pages were first captured in (§AC).
 */
export function buildFeedbackMarkdown(
  pages: Record<string, FeedbackItem[]>,
  header: ExportHeader,
): string {
  const sections = Object.entries(pages)
    .map(([url, items]) => ({ url, items }))
    .filter((section) => section.items.length > 0)
    .sort((a, b) => a.items[0].id - b.items[0].id);

  const top = [
    formatMarker(FORMAT_VERSION_V2),
    `salamander ${header.extensionVersion}\\`,
    `**date exported:** ${formatExportDate(header.exportedAt, header.utcOffsetMinutes)}\\`,
    `**website:** ${header.website}`,
  ].join('\n');

  return `${[top, ...sections.map(renderPage)].join('\n\n')}\n`;
}

function renderPage(section: { url: string; items: FeedbackItem[] }): string {
  return [
    `## page "${section.url}"`,
    ...section.items.map((item, index) => renderItem(item, index + 1)),
  ].join('\n\n');
}

/** One note. `number` is its display number (position on the page); the
 *  screenshot path is its id — see the file banner for why they differ. */
function renderItem(item: FeedbackItem, number: number): string {
  const alt = `feedback ${number}${hasStrokes(item.drawing) ? DRAWN_ALT_SUFFIX : ''}`;
  return [
    `### feedback ${number}`,
    '',
    `![${alt}](screenshots/${item.id}.png)`,
    '',
    renderNoteLine(item.note),
    '',
    DETAILS_OPEN,
    DETAILS_SUMMARY,
    '',
    JSON_FENCE_OPEN,
    JSON.stringify(toJsonFeedbackItem(item), null, 2),
    FENCE_CLOSE,
    '',
    DETAILS_CLOSE,
  ].join('\n');
}

/** The visible note: as written, with no surrounding quotes, and "(none)"
 *  when empty. Trimmed for display only — a trailing newline would break the
 *  blank line the details block needs; the json keeps the note exactly as
 *  stored. */
function renderNoteLine(note: string): string {
  const shown = note.trim();
  return `${NOTE_LABEL}${shown === '' ? EMPTY_NOTE : shown}`;
}

/** `YYYY-MM-DD HH:MM utc±hh:mm`, in the zone `utcOffsetMinutes` describes. */
export function formatExportDate(date: Date, utcOffsetMinutes: number): string {
  const local = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  const offset = Math.abs(utcOffsetMinutes);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ` +
    `utc${utcOffsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Length caps on the free-text fields of an item's json block (design spec
 * §AC). A container that spans the whole selection can otherwise put a
 * page's entire copy in `text` and a kilobyte of markup in `html`, burying
 * the record an agent reads top-down. A capped value ends in a single
 * ellipsis instead of carrying a separate "truncated" flag.
 *
 * Deliberately NOT capped: the note (the user's own words), and every
 * identifier — selector, xpath, URLs, ids, class names. A shortened selector
 * is not a shorter selector, it is a wrong one.
 */
export const JSON_TEXT_LIMITS = {
  text: 120,
  html: 300,
  areaText: 200,
  /** Each nearby element's text, and each of its attribute values. */
  element: 80,
} as const;

const ELLIPSIS = '\u2026';

/** `value` cut to `limit` characters and ended with an ellipsis, or as-is
 *  when it already fits. `forceEllipsis` marks a value that was already
 *  cut before it got here (capture caps the html snippet too) even when it
 *  now fits the limit. */
export function capText(value: string, limit: number, forceEllipsis = false): string {
  if (value.length > limit) return `${value.slice(0, limit).trimEnd()}${ELLIPSIS}`;
  return forceEllipsis && !value.endsWith(ELLIPSIS) ? `${value.trimEnd()}${ELLIPSIS}` : value;
}

/** The stored html snippet with capture's own cut marker swapped for the
 *  one ellipsis convention, then capped. */
function capHtml(snippet: string): string {
  const wasCut = snippet.endsWith(TRUNCATION_MARKER);
  const html = wasCut ? snippet.slice(0, -TRUNCATION_MARKER.length) : snippet;
  return capText(html, JSON_TEXT_LIMITS.html, wasCut);
}

/** FeedbackItem -> its json record, keys in §AC's order. */
export function toJsonFeedbackItem(item: FeedbackItem): JsonFeedbackItem {
  const ctx = item.context;
  const target = ctx.primaryTarget;
  return {
    text: capText(primaryTargetText(target.outerHtmlSnippet), JSON_TEXT_LIMITS.text),
    selector: target.cssSelector,
    xpath: target.xpath,
    html: capHtml(target.outerHtmlSnippet),
    page_url: item.pageUrl,
    note: item.note,
    id: item.id,
    normalised_url: item.normalisedUrl,
    page_title: ctx.pageMeta.title,
    created_at: item.createdAt,
    selection_rect: pickRect(item.selectionRect),
    viewport: { width: item.viewport.width, height: item.viewport.height },
    dpr: item.dpr,
    contained_elements: ctx.containedElements.map(pickContainedElement),
    area_text: capText(ctx.areaText, JSON_TEXT_LIMITS.areaText),
  };
}

const TRUNCATION_MARKER = '...[truncated]';
// A tag, with quoted attribute values allowed to contain `>`.
const TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
// A tag the truncation cut off before its `>`, possibly mid-attribute-value.
const CUT_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*)?$/;
const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * The primary target's visible text, read out of its stored html snippet:
 * tags dropped, entities decoded, whitespace collapsed. The item stores no
 * separate copy of it (capture keeps the snippet, sanitised and capped at
 * ~1KB — §1.4A), so this is derived at export, and a truncated snippet gives
 * the text up to the cut. The service worker has no DOMParser, hence the
 * string work. Deterministic, so a re-export after import writes the same
 * value.
 */
export function primaryTargetText(snippet: string): string {
  const html = snippet.endsWith(TRUNCATION_MARKER)
    ? snippet.slice(0, -TRUNCATION_MARKER.length)
    : snippet;
  return html
    .replace(CUT_TAG_RE, '')
    .replace(TAG_RE, ' ')
    .replace(ENTITY_RE, (_, name: string) => decodeEntity(name))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntity(name: string): string {
  if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()];
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function pickRect(r: Rect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function pickContainedElement(el: ContainedElement): JsonContainedElement {
  return {
    tag: el.tag,
    ...(el.id !== undefined ? { id: el.id } : {}),
    ...(el.classes !== undefined
      ? { classes: { semantic: [...el.classes.semantic], generated: [...el.classes.generated] } }
      : {}),
    ...(el.attrs !== undefined
      ? {
          attrs: Object.fromEntries(
            Object.entries(el.attrs).map(([k, v]) => [k, capText(v, JSON_TEXT_LIMITS.element)]),
          ),
        }
      : {}),
    ...(el.text !== undefined ? { text: capText(el.text, JSON_TEXT_LIMITS.element) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read: feedback.md -> items
// ---------------------------------------------------------------------------

/**
 * Every note in a version-2 `feedback.md`, in document order, each with the
 * number its heading showed. The caller (src/bundle/index.ts) has already
 * matched the line-1 stamp.
 *
 * Strict about shape and types, since everything read here goes to storage
 * and on to the page's UI: a note heading without its image line, a missing
 * or unparsable json block, an image/json id disagreement, or a json field
 * of the wrong type all throw a plain `Error`, which src/import.ts maps to
 * §5 #4b's "corrupted" message. The heading's number is taken as written
 * and not checked against the note's position — a hand-edited file with a
 * gap still reads, and the list renumbers on the next draw. Lines outside
 * notes (the header, blank lines, anything a person added between notes)
 * are ignored. Whether the values are acceptable as a set — screenshots
 * present, ids and numbers unique, domain matching — is the importer's
 * ladder, not this reader's.
 */
export function decodeFeedbackMarkdown(markdown: string): DecodedBundleEntry[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: DecodedBundleEntry[] = [];
  let inPage = false;
  let i = 1; // line 0 is the format stamp

  while (i < lines.length) {
    const line = lines[i];
    if (PAGE_HEADING_RE.test(line)) {
      inPage = true;
      i += 1;
      continue;
    }
    const heading = ITEM_HEADING_RE.exec(line);
    if (heading) {
      const number = parseInt(heading[1], 10);
      if (!inPage) throw new Error(`feedback ${number}: comes before any page heading`);
      const { id, record, nextIndex } = readItemBlock(lines, i + 1, number);
      entries.push({ number, item: fromJsonFeedbackItem(record, id, `feedback ${number}`) });
      i = nextIndex;
      continue;
    }
    i += 1;
  }

  return entries;
}

/** A structural line, allowing the stray trailing whitespace an editor may
 *  leave. */
function isLine(lines: string[], i: number, expected: string): boolean {
  return (lines[i] ?? '').trim() === expected;
}

function skipBlank(lines: string[], i: number): number {
  while (i < lines.length && lines[i].trim() === '') i += 1;
  return i;
}

/** The image line that must follow `### feedback {n}` (after blank lines),
 *  with the id its screenshot path names, or null. */
function imageLineAfter(lines: string[], headingIndex: number): { index: number; id: number } | null {
  const index = skipBlank(lines, headingIndex + 1);
  const match = IMAGE_LINE_RE.exec(lines[index] ?? '');
  return match ? { index, id: parseInt(match[1], 10) } : null;
}

interface ElementDataBlock {
  record: Record<string, unknown>;
  /** The `<details>` line. */
  openIndex: number;
  /** The line after `</details>`. */
  nextIndex: number;
}

/** The element-data block opening at line `k`, if one does and its json
 *  parses to an object. */
function elementDataAt(lines: string[], k: number): ElementDataBlock | null {
  if (!isLine(lines, k, DETAILS_OPEN) || !isLine(lines, k + 1, DETAILS_SUMMARY)) return null;
  const fenceIndex = skipBlank(lines, k + 2);
  if (!isLine(lines, fenceIndex, JSON_FENCE_OPEN)) return null;
  let close = fenceIndex + 1;
  while (close < lines.length && !isLine(lines, close, FENCE_CLOSE)) close += 1;
  if (close >= lines.length) return null;
  const endIndex = skipBlank(lines, close + 1);
  if (!isLine(lines, endIndex, DETAILS_CLOSE)) return null;
  try {
    const parsed: unknown = JSON.parse(lines.slice(fenceIndex + 1, close).join('\n'));
    return isRecord(parsed) ? { record: parsed, openIndex: k, nextIndex: endIndex + 1 } : null;
  } catch {
    return null;
  }
}

/** The lines of one note after its `### feedback {number}` heading: the
 *  screenshot line (whose path names the note's id), the note line, and the
 *  element-data block for that id. */
function readItemBlock(
  lines: string[],
  startIndex: number,
  number: number,
): { id: number; record: Record<string, unknown>; nextIndex: number } {
  const image = imageLineAfter(lines, startIndex - 1);
  if (!image) throw new Error(`feedback ${number}: missing its screenshot line`);
  const { id } = image;

  const noteIndex = skipBlank(lines, image.index + 1);
  if (!(lines[noteIndex] ?? '').startsWith(NOTE_LABEL)) {
    throw new Error(`feedback ${number}: missing its note line`);
  }

  // This item's element data: a block after the note whose json carries the
  // screenshot's id. Normally the first such block is the one, but a note may
  // itself quote a block, so the one whose note renders to exactly the
  // lines above it is preferred — that is the writer's own layout, and it is
  // how the real block is told from a quoted one. Only if the visible note
  // was edited by hand (no block matches it) does the first block win.
  let first: ElementDataBlock | null = null;
  for (let k = noteIndex + 1; k < lines.length; k += 1) {
    const block = elementDataAt(lines, k);
    if (!block || block.record.id !== id) continue;
    const note = block.record.note;
    if (typeof note === 'string' && noteLines(lines, noteIndex, k) === renderNoteLine(note)) {
      return { id, ...block };
    }
    first ??= block;
  }
  if (first) return { id, ...first };
  throw new Error(`feedback ${number}: missing or unreadable element data`);
}

/** The note's text as written between the note label and line `end`. */
function noteLines(lines: string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n').trimEnd();
}

/**
 * A parsed json record -> the item it describes, checking every field's type
 * on the way (`id` is the screenshot line's, already matched against the
 * record). `text` is derived at export and ignored here; unknown fields are
 * ignored too. `context.pageMeta` is rebuilt from the item-level fields it
 * duplicates plus `page_title`. `where` names the note in an error the way
 * the file shows it (its heading number).
 */
export function fromJsonFeedbackItem(
  json: Record<string, unknown>,
  id: number,
  where = `feedback ${id}`,
): DecodedBundleItem {
  const field = new FieldReader(json, where);
  const pageUrl = field.string('page_url');
  const normalisedUrl = field.string('normalised_url');
  const createdAt = field.string('created_at');
  const selectionRect = field.rect('selection_rect');
  const viewport = field.viewport('viewport');
  const dpr = field.number('dpr');
  const html = field.string('html');

  return {
    id,
    pageUrl,
    normalisedUrl,
    note: field.string('note'),
    createdAt,
    selectionRect,
    viewport,
    dpr,
    context: {
      primaryTarget: {
        cssSelector: field.string('selector'),
        xpath: field.string('xpath'),
        outerHtmlSnippet: html,
        // No flag in the file: a cut snippet is the one that ends in the
        // ellipsis the writer adds.
        truncated: html.endsWith(ELLIPSIS),
      },
      containedElements: field.containedElements('contained_elements'),
      areaText: field.string('area_text'),
      pageMeta: {
        url: pageUrl,
        normalisedUrl,
        title: field.string('page_title'),
        viewport: { ...viewport },
        dpr,
        selectionRect: { ...selectionRect },
        capturedAt: createdAt,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Typed reads off one json record; any mismatch throws naming the field. */
class FieldReader {
  constructor(
    private readonly json: Record<string, unknown>,
    private readonly where: string,
  ) {}

  private fail(key: string, expected: string): never {
    throw new Error(`${this.where}: "${key}" is missing or not ${expected}`);
  }

  string(key: string): string {
    const v = this.json[key];
    return typeof v === 'string' ? v : this.fail(key, 'a string');
  }

  number(key: string, from: Record<string, unknown> = this.json): number {
    const v = from[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : this.fail(key, 'a number');
  }

  rect(key: string): Rect {
    const v = this.json[key];
    if (!isRecord(v)) return this.fail(key, 'an object');
    return {
      x: this.number('x', v),
      y: this.number('y', v),
      width: this.number('width', v),
      height: this.number('height', v),
    };
  }

  viewport(key: string): ViewportSize {
    const v = this.json[key];
    if (!isRecord(v)) return this.fail(key, 'an object');
    return { width: this.number('width', v), height: this.number('height', v) };
  }

  containedElements(key: string): ContainedElement[] {
    const list = this.json[key];
    if (!Array.isArray(list)) return this.fail(key, 'a list');
    return list.map((el) => {
      if (!isRecord(el) || typeof el.tag !== 'string') return this.fail(key, 'a list of elements');
      const { id, classes, attrs, text } = el;
      if (id !== undefined && typeof id !== 'string') return this.fail(`${key}.id`, 'a string');
      if (text !== undefined && typeof text !== 'string') return this.fail(`${key}.text`, 'a string');
      if (
        classes !== undefined &&
        !(isRecord(classes) && isStringArray(classes.semantic) && isStringArray(classes.generated))
      ) {
        return this.fail(`${key}.classes`, 'semantic and generated lists');
      }
      if (
        attrs !== undefined &&
        !(isRecord(attrs) && Object.values(attrs).every((a) => typeof a === 'string'))
      ) {
        return this.fail(`${key}.attrs`, 'a map of strings');
      }
      const item: ContainedElement = { tag: el.tag };
      if (id !== undefined) item.id = id;
      if (classes !== undefined) {
        const { semantic, generated } = classes as { semantic: string[]; generated: string[] };
        item.classes = { semantic: [...semantic], generated: [...generated] };
      }
      if (attrs !== undefined) item.attrs = { ...(attrs as Record<string, string>) };
      if (text !== undefined) item.text = text;
      return item;
    });
  }
}
