// src/enlargedLayout.ts
// Pure layout for the enlarged view (design spec §AH, "enlarged view 2.0"):
// the whole site as one vertical page — a heading per page, then that
// page's notes packed into rows of up to three — plus the panel's own size
// and the scroll position a note is opened at. No DOM, no clock: every
// function here is arithmetic on sizes, so src/enlargedView.ts can lay out,
// re-pack after a delete and FLIP between the two from numbers alone, and
// the tests can pin the geometry without a browser.
//
// ── A note ──────────────────────────────────────────────────────────────────
// Each note is a column: a header line ("#n" and delete), its screenshot,
// and its text area. The screenshot is shown at the selection's own CSS
// size (`selectionRect` — the stored PNG is at the capture's dpr, so its
// pixels are not its display size; design spec v4 §M), never scaled up, and
// scaled down (aspect kept) only to fit the content width or the visible
// height. The column ("slot") is that width clamped between the text area's
// width and the content width, so:
//   - a screenshot narrower than the text area sits at its own size, centred
//     over it — it is never stretched to fill;
//   - a wider one sets the column, and the text area is centred under it.
// Every text area is the same NOTE_TEXT_W × NOTE_TEXT_H, whatever its note.
//
// ── A row ───────────────────────────────────────────────────────────────────
// Notes fill rows greedily in capture order: a row takes the next note while
// the row still fits the content width with COL_GAP between columns, up to
// MAX_PER_ROW, so a wide note ends up alone. Columns keep their own widths
// (never equalised) and the row is centred as a whole — which centres the
// one- and two-note rows the design calls for, and splits a full row's
// leftover evenly. Each note is one group, centred on its image: its bar
// ("#n" and delete, side by side) directly above the image, its text area
// directly below. The groups are centred vertically in the row, so the
// images are centred against each other; bars and text areas follow their
// own image and need not line up across the row (design spec §AH, revised
// 2026-10-12).
//
// ── The page ────────────────────────────────────────────────────────────────
//   PAD_TOP · heading · HEADING_GAP · row · ROW_GAP · row … GROUP_GAP ·
//   heading · … · PAD_BOTTOM
// Rows never mix pages. Coordinates are content-box px: x from the content
// column's left edge, y from the top of the scrolled content.

/** A size in CSS px. */
export interface Size {
  w: number;
  h: number;
}

/** A box in content coordinates (px). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Metrics (design spec §AH). All px.
// ---------------------------------------------------------------------------

/** The one text-area width every note shares. Exactly the default
 *  selection's width (DEFAULT_THUMBNAIL_BOX_SIZE in sidebar.ts: the list
 *  thumbnail box at the default sidebar width, design spec §F) — so the
 *  most common note, a click-placed 267×100, reads as one column with its
 *  text area edge to edge, and three of them fit a row from a ~1250px
 *  window. Also the narrowest a column gets (MIN_NOTE_W). */
export const NOTE_TEXT_W = 267;
/** Fixed: a text area never grows with its text; it scrolls inside. Four
 *  lines of the 14px/1.45 note face plus the 12px vertical padding. */
export const NOTE_TEXT_H = 96;
/** A column is never narrower than its text area. */
export const MIN_NOTE_W = NOTE_TEXT_W;
/** The bar directly above each note's image: "#n" and the 28px delete,
 *  side by side and centred over the image. */
export const NOTE_HEAD_H = 28;
export const NOTE_HEAD_GAP = 8;
/** Image → its text area. */
export const NOTE_TEXT_GAP = 12;
export const MAX_PER_ROW = 3;
/** Between columns in a row. */
export const COL_GAP = 32;
/** Text areas of one row → header line of the next. Room for a note's
 *  one-line error under its text area (16px + 8px) with air to spare. */
export const ROW_GAP = 40;
/** A page heading, two lines (design spec §AH): the serif name (28px on a
 *  34px line) — and, while it is being renamed, the field in the same face —
 *  on a 40px line, one height for both so renaming never moves the page;
 *  then, 2px under it, the 20px line of its address and "this page". */
export const HEADING_NAME_H = 40;
export const HEADING_SUB_GAP = 2;
export const HEADING_SUB_H = 20;
export const HEADING_H = HEADING_NAME_H + HEADING_SUB_GAP + HEADING_SUB_H;
export const HEADING_GAP = 16;
/** Last row of one page → the next page's heading. Wider than ROW_GAP so a
 *  page break reads as one. */
export const GROUP_GAP = 64;
export const PAD_TOP = 24;
export const PAD_BOTTOM = 64;
/** How much of what comes right before the opened note shows above it
 *  (design spec §AH, revised 2026-10-13): the last 40px of the previous row
 *  — or, for a page's first row, of its heading — cut off by the top of the
 *  scroller, so it is plain there is more above. Fixed: the note lands just
 *  under it, near the top, on every window tall enough for it. */
export const OPEN_PEEK_PX = 40;
/** The overlap the page keys keep (PageUp/PageDown scroll a screen less
 *  this), so the reader never loses their place. */
export const PEEK_PX = 80;

/** The panel's margin, the same on every side of its top bar (design spec
 *  §AH, revised 2026-10-12): the exit button's top and right, the logo's
 *  left — and the content column's inset, so the logo, the page headings
 *  and the notes share one left edge, and the docked sidebar's own 16px
 *  inset carries straight over. */
export const PANEL_MARGIN = 16;
/** The exit button, a 36px secondary icon button (design spec §X). */
export const EXIT_BTN_PX = 36;
/** The docked sidebar's header: the logo sits 16px in (PANEL_MARGIN, the
 *  same in the panel) and centred in a 56px row. In the panel's taller top
 *  bar it is centred with the exit button instead. */
export const DOCKED_HEADER_H = 56;
/** The panel's top bar: the logo + wordmark and the exit button, the button
 *  PANEL_MARGIN from the top as from the right, so the bar is that margin
 *  either side of it. The scroller starts below it. */
export const TOP_BAR_H = PANEL_MARGIN + EXIT_BTN_PX + PANEL_MARGIN;
/** The content column's inset from the panel's left and right edges. */
export const PANEL_PAD_X = PANEL_MARGIN;
/** The tallest a screenshot may be is what leaves its header line and text
 *  area on screen with it, less this much air (see maxShotHeightFor). */
const SHOT_HEIGHT_MARGIN = 48;
/** ...but never less than this, on a very short window. */
const MIN_SHOT_H = 160;
/** A note with no usable selection size (shouldn't happen — every capture
 *  stores one) is laid out as a text-area-wide 16:9 box. */
const FALLBACK_SIZE: Size = { w: NOTE_TEXT_W, h: Math.round((NOTE_TEXT_W * 9) / 16) };

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The expanded panel's width: 75% of the viewport, but at least 560px (or
 *  the whole viewport, if narrower), and never narrower than the docked
 *  sidebar it grew from. Unchanged from the first enlarged view. */
export function panelWidthFor(vw: number, sidebarW: number): number {
  const v = Math.max(1, vw);
  return Math.round(Math.min(v, Math.max(0.75 * v, Math.min(560, v), sidebarW)));
}

/** The content column's width for a scroller `scrollerClientW` wide (its
 *  client width, i.e. less any classic scrollbar): the panel less its side
 *  insets. Also the widest a note may be. */
export function contentWidthFor(scrollerClientW: number): number {
  return Math.max(1, Math.floor(scrollerClientW - 2 * PANEL_PAD_X));
}

/** The tallest a screenshot may be shown in a scroller `scrollerH` tall: a
 *  note's header, screenshot and text area always fit on screen together,
 *  so a very tall selection is scaled down (aspect kept) rather than making
 *  the reviewer scroll between an image and its note. */
export function maxShotHeightFor(scrollerH: number): number {
  const chrome = NOTE_HEAD_H + NOTE_HEAD_GAP + NOTE_TEXT_GAP + NOTE_TEXT_H + SHOT_HEIGHT_MARGIN;
  return Math.max(MIN_SHOT_H, Math.floor(scrollerH - chrome));
}

// ---------------------------------------------------------------------------
// One note
// ---------------------------------------------------------------------------

/**
 * The size a screenshot is shown at: `natural` (its selection's CSS size),
 * never scaled up, scaled down uniformly only as far as `maxW`/`maxH`
 * demand. The width is a whole pixel; the height follows from the aspect
 * rather than rounding on its own, so the box has exactly the image's
 * proportions and nothing letterboxes inside it.
 */
export function fitShot(natural: Size | null | undefined, maxW: number, maxH = Infinity): Size {
  const n = natural && natural.w > 0 && natural.h > 0 ? natural : FALLBACK_SIZE;
  const scale = Math.min(1, Math.max(1, maxW) / n.w, Math.max(1, maxH) / n.h);
  const w = Math.max(1, Math.round(n.w * scale));
  return { w, h: Math.max(1, (w * n.h) / n.w) };
}

/** A column's width: the shown screenshot's, clamped between the text
 *  area's and the content width. */
export function slotWidthFor(shotW: number, textW: number, contentW: number): number {
  return Math.min(Math.max(shotW, textW), Math.max(textW, contentW));
}

/**
 * Greedy row packing: each row takes the next width while the row still
 * fits `contentW` with `gap` between columns, up to `maxPerRow`. A width
 * that does not fit even alone still gets a row of its own. Returns the
 * index ranges, in order.
 */
export function packRows(widths: number[], contentW: number, gap = COL_GAP, maxPerRow = MAX_PER_ROW): number[][] {
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  widths.forEach((w, i) => {
    const needed = row.length === 0 ? w : used + gap + w;
    if (row.length > 0 && (row.length >= maxPerRow || needed > contentW)) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used = row.length === 0 ? w : used + gap + w;
    row.push(i);
  });
  if (row.length > 0) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// The whole site
// ---------------------------------------------------------------------------

export interface LayoutNote {
  id: number;
  /** The selection's CSS size, or null when it has none. */
  natural: Size | null;
}

export interface LayoutPage {
  /** The page's key (its normalised URL). */
  key: string;
  notes: LayoutNote[];
}

export interface NoteLayout {
  id: number;
  page: string;
  /** Index into GridLayout.rows. */
  row: number;
  /** The note's group: its column's width, bar top to text-area bottom. */
  slot: Box;
  head: Box;
  shot: Box;
  text: Box;
}

export interface RowLayout {
  page: string;
  ids: number[];
  /** The header line's top. */
  top: number;
  /** The text areas' bottom. */
  bottom: number;
  /** True for a page's first row, which sits under the page's heading. */
  first: boolean;
}

export interface HeadingLayout {
  page: string;
  box: Box;
}

export interface GridLayout {
  contentW: number;
  /** The scrolled content's full height, PAD_BOTTOM included. */
  height: number;
  /** The text areas' width here (NOTE_TEXT_W, or less in a column narrower
   *  than that). */
  textW: number;
  headings: HeadingLayout[];
  rows: RowLayout[];
  notes: Map<number, NoteLayout>;
}

export interface GridOptions {
  contentW: number;
  /** maxShotHeightFor(the scroller's height). */
  maxShotH?: number;
}

/**
 * Lay the site out: `pages` in display order, each page's notes in capture
 * order. Empty pages are skipped (a page exists only through its notes).
 * Every coordinate is a whole pixel except a screenshot's height, which
 * keeps its exact aspect (fitShot).
 */
export function computeGridLayout(pages: LayoutPage[], opts: GridOptions): GridLayout {
  const contentW = Math.max(1, Math.floor(opts.contentW));
  const maxShotH = opts.maxShotH ?? Infinity;
  const textW = Math.min(NOTE_TEXT_W, contentW);
  const headings: HeadingLayout[] = [];
  const rows: RowLayout[] = [];
  const notes = new Map<number, NoteLayout>();

  let y = PAD_TOP;
  let firstPage = true;
  for (const page of pages) {
    if (page.notes.length === 0) continue;
    if (!firstPage) y += GROUP_GAP;
    firstPage = false;
    headings.push({ page: page.key, box: { x: 0, y, w: contentW, h: HEADING_H } });
    y += HEADING_H + HEADING_GAP;

    const shots = page.notes.map((n) => fitShot(n.natural, contentW, maxShotH));
    const widths = shots.map((s) => slotWidthFor(s.w, textW, contentW));
    packRows(widths, contentW).forEach((indices, r) => {
      if (r > 0) y += ROW_GAP;
      const rowW = indices.reduce((sum, i) => sum + widths[i], 0) + COL_GAP * (indices.length - 1);
      // Each note is one group — its bar, its image, its text area, stacked
      // tight — and the groups are centred vertically in the row, so the
      // images stay centred against each other; bars and text areas follow
      // their own image rather than lining up across the row.
      const groupH = (i: number) => NOTE_HEAD_H + NOTE_HEAD_GAP + shots[i].h + NOTE_TEXT_GAP + NOTE_TEXT_H;
      const rowH = Math.max(...indices.map(groupH));
      const bottom = Math.ceil(y + rowH);
      const rowIndex = rows.length;
      let x = Math.round((contentW - rowW) / 2);
      for (const i of indices) {
        const note = page.notes[i];
        const slotW = widths[i];
        const shot = shots[i];
        const top = Math.round(y + (rowH - groupH(i)) / 2);
        const shotY = top + NOTE_HEAD_H + NOTE_HEAD_GAP;
        const textY = Math.round(shotY + shot.h + NOTE_TEXT_GAP);
        notes.set(note.id, {
          id: note.id,
          page: page.key,
          row: rowIndex,
          slot: { x, y: top, w: slotW, h: textY + NOTE_TEXT_H - top },
          head: { x, y: top, w: slotW, h: NOTE_HEAD_H },
          shot: { x: x + Math.round((slotW - shot.w) / 2), y: shotY, w: shot.w, h: shot.h },
          text: { x: x + Math.round((slotW - textW) / 2), y: textY, w: textW, h: NOTE_TEXT_H },
        });
        x += slotW + COL_GAP;
      }
      rows.push({ page: page.key, ids: indices.map((i) => page.notes[i].id), top: y, bottom, first: r === 0 });
      y = bottom;
    });
  }
  return { contentW, height: firstPage ? 0 : y + PAD_BOTTOM, textW, headings, rows, notes };
}

/**
 * Where to scroll to open the view on note `id` (design spec §AH, revised
 * 2026-10-13).
 *
 * Whatever comes right before the note's row — the previous row on its
 * page, or, for a page's first row, the page's heading — shows its last
 * OPEN_PEEK_PX under the top bar, cut off by the scroller's edge; the row
 * follows it at its usual gap. A note in the site's first row starts at the
 * top, with no peek. On a window too short for both the peek and the note's
 * text area (which the view focuses), the text area wins: the scroll goes
 * as far as it takes to show it whole, with half a row gap under it for its
 * message. Clamped to what the content can scroll, so content shorter than
 * the window is simply all there; null for an unknown id.
 */
export function scrollTopFor(layout: GridLayout, id: number, viewportH: number): number | null {
  const note = layout.notes.get(id);
  if (!note) return null;
  if (note.row === 0) return 0;
  const row = layout.rows[note.row];
  const heading = row.first ? layout.headings.find((h) => h.page === row.page) : undefined;
  const before = heading ? heading.box.y + heading.box.h : layout.rows[note.row - 1].bottom;
  const peekTop = before - OPEN_PEEK_PX;
  const textOnScreen = note.text.y + note.text.h + ROW_GAP / 2 - viewportH;
  const max = Math.max(0, layout.height - Math.max(0, viewportH));
  return Math.round(Math.min(max, Math.max(0, peekTop, textOnScreen)));
}

// ---------------------------------------------------------------------------
// A page's address
// ---------------------------------------------------------------------------

/** A page's normalised URL as its heading shows it: without the scheme,
 *  which is https:// for every page of a site (urlNorm.ts) and says
 *  nothing. */
export function displayUrl(normalisedUrl: string): string {
  return normalisedUrl.replace(/^https?:\/\//, '');
}

/**
 * `text` cut to at most `maxChars` characters with a single ellipsis in the
 * middle — a URL keeps its host at the start and its last path segment at
 * the end, which are the two parts that tell pages apart. The head gets the
 * odd character. Shown in the monospace face, so a character count is a
 * width (src/pageHeading.ts measures one).
 */
export function ellipsizeMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return '\u2026';
  const keep = maxChars - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}\u2026${text.slice(text.length - (keep - head))}`;
}
