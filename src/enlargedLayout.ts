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
// leftover evenly. Inside a row the header lines and the text areas share a
// y each; the screenshots sit in the band between, centred vertically
// against each other, so a row reads as three bands: headers, images, notes.
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
/** The header line above each column: "#n" and the 28px delete. */
export const NOTE_HEAD_H = 28;
export const NOTE_HEAD_GAP = 8;
/** Screenshot band → text area. */
export const NOTE_TEXT_GAP = 12;
export const MAX_PER_ROW = 3;
/** Between columns in a row. */
export const COL_GAP = 32;
/** Text areas of one row → header line of the next. Room for a note's
 *  one-line error under its text area (16px + 8px) with air to spare. */
export const ROW_GAP = 40;
/** A page heading: the serif name (28px on a 34px line) and, while it is
 *  being renamed, the 32px field and buttons — one height for both, so
 *  renaming never moves the page. */
export const HEADING_H = 36;
export const HEADING_GAP = 16;
/** Last row of one page → the next page's heading. Wider than ROW_GAP so a
 *  page break reads as one. */
export const GROUP_GAP = 64;
export const PAD_TOP = 24;
export const PAD_BOTTOM = 64;
/** The least of what precedes the opened note that shows above it (design
 *  spec §AH): the bottom of the previous row — another page's, if need be —
 *  cut off by the top of the scroller, so it is plain there is more above. */
export const PEEK_PX = 80;
/** Where the opened note's row lands: this fraction of the way down the
 *  panel (design spec §AH, "about 25% down"). */
export const LANDING_FRACTION = 0.25;

/** The panel's margin, the same on every side of its top bar (design spec
 *  §AH, revised 2026-10-12): the exit button's top and right, the logo's
 *  left — and the content column's inset, so the logo, the page headings
 *  and the notes share one left edge, and the docked sidebar's own 16px
 *  inset carries straight over. */
export const PANEL_MARGIN = 16;
/** The exit button, a 36px secondary icon button (design spec §X). */
export const EXIT_BTN_PX = 36;
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
  /** The whole column, header line to text-area bottom. */
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
      const bandH = Math.max(...indices.map((i) => shots[i].h));
      const bandTop = y + NOTE_HEAD_H + NOTE_HEAD_GAP;
      const textTop = Math.round(bandTop + bandH + NOTE_TEXT_GAP);
      const bottom = textTop + NOTE_TEXT_H;
      const rowIndex = rows.length;
      let x = Math.round((contentW - rowW) / 2);
      for (const i of indices) {
        const note = page.notes[i];
        const slotW = widths[i];
        const shot = shots[i];
        notes.set(note.id, {
          id: note.id,
          page: page.key,
          row: rowIndex,
          slot: { x, y, w: slotW, h: bottom - y },
          head: { x, y, w: slotW, h: NOTE_HEAD_H },
          shot: {
            x: x + Math.round((slotW - shot.w) / 2),
            y: Math.round(bandTop + (bandH - shot.h) / 2),
            w: shot.w,
            h: shot.h,
          },
          text: { x: x + Math.round((slotW - textW) / 2), y: textTop, w: textW, h: NOTE_TEXT_H },
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
 * Where to scroll to open the view on note `id` (design spec §AH).
 *
 * The note's row lands about a quarter of the way down the panel
 * (LANDING_FRACTION of the panel's height — the scroller plus the
 * `topInset` of the top bar above it), and whatever precedes it — the
 * previous row's bottom, on this page or the one before — peeks above it,
 * cut off by the scroller's edge, so it is plain there is more above. Never
 * less than PEEK_PX of it: on a short window, where a quarter of the way
 * down would leave less, the row sits lower instead. A page's first row
 * brings its heading on screen with it (a note is never opened under a
 * heading it cannot see). The note's own text area — which the view
 * focuses — always ends up on screen, even if a very tall row has to give
 * up its peek for it. With nothing before it (the site's first row), or
 * too little to fill the space above, it starts at the top. Clamped to what
 * the content can scroll; null for an unknown id.
 */
export function scrollTopFor(layout: GridLayout, id: number, viewportH: number, topInset = TOP_BAR_H): number | null {
  const note = layout.notes.get(id);
  if (!note) return null;
  const row = layout.rows[note.row];
  const landing = LANDING_FRACTION * (viewportH + topInset) - topInset;
  let top = row.top - landing;
  if (note.row > 0) top = Math.min(top, layout.rows[note.row - 1].bottom - PEEK_PX);
  // A page's first row sits under its heading: keep the heading in view.
  const heading = row.first ? layout.headings.find((h) => h.page === row.page) : undefined;
  if (heading) top = Math.min(top, heading.box.y);
  const textOnScreen = note.text.y + note.text.h + ROW_GAP / 2 - viewportH;
  const max = Math.max(0, layout.height - Math.max(0, viewportH));
  return Math.round(Math.min(max, Math.max(0, top, textOnScreen)));
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
