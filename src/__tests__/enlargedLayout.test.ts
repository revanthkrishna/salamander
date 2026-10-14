// The enlarged view's pure layout (src/enlargedLayout.ts, design spec §AH):
// note sizing and clamping, greedy row packing (one to three per row,
// centred, never stretched), the bands inside a row, page headings, narrow
// panels, and the scroll position a note is opened at (the peek).

import {
  COL_GAP,
  GROUP_GAP,
  HEADING_GAP,
  HEADING_H,
  MAX_PER_ROW,
  MIN_NOTE_W,
  NOTE_HEAD_GAP,
  NOTE_HEAD_H,
  NOTE_TEXT_GAP,
  NOTE_TEXT_H,
  NOTE_TEXT_W,
  PAD_BOTTOM,
  PAD_TOP,
  PANEL_PAD_X,
  OPEN_PEEK_PX,
  PEEK_PX,
  ROW_GAP,
  TOP_BAR_H,
  computeGridLayout,
  contentWidthFor,
  displayUrl,
  ellipsizeMiddle,
  fitShot,
  LayoutPage,
  maxShotHeightFor,
  packRows,
  panelWidthFor,
  scrollTopFor,
  slotWidthFor,
} from '../enlargedLayout';
import { DEFAULT_THUMBNAIL_BOX_SIZE } from '../sidebar';

const nat = (w: number, h: number) => ({ w, h });
let nextId = 1;
function page(key: string, ...sizes: Array<[number, number]>): LayoutPage {
  return { key, notes: sizes.map(([w, h]) => ({ id: nextId++, natural: nat(w, h) })) };
}
beforeEach(() => {
  nextId = 1;
});

describe('the panel', () => {
  test('75% of the viewport, at least 560 (or the viewport), never narrower than the docked sidebar', () => {
    expect(panelWidthFor(1440, 300)).toBe(1080);
    expect(panelWidthFor(700, 300)).toBe(560);
    expect(panelWidthFor(400, 300)).toBe(400);
    expect(panelWidthFor(320, 300)).toBe(320);
    expect(panelWidthFor(2560, 300)).toBe(1920);
  });

  test('the content column is the scroller less the two side insets', () => {
    expect(contentWidthFor(1079)).toBe(1079 - 2 * PANEL_PAD_X);
    expect(contentWidthFor(10)).toBe(1);
  });

  test('a screenshot is never taller than what leaves its header and text area on screen', () => {
    expect(maxShotHeightFor(844)).toBe(844 - (NOTE_HEAD_H + NOTE_HEAD_GAP + NOTE_TEXT_GAP + NOTE_TEXT_H) - 48);
    expect(maxShotHeightFor(200)).toBe(160);
  });

  test('the text area is exactly the default selection\'s width (design spec §F)', () => {
    expect(NOTE_TEXT_W).toBe(DEFAULT_THUMBNAIL_BOX_SIZE.width);
    expect(MIN_NOTE_W).toBe(NOTE_TEXT_W);
  });
});

describe('one note', () => {
  test('shown at its own CSS size — never scaled up', () => {
    expect(fitShot(nat(267, 100), 1000)).toEqual({ w: 267, h: 100 });
    expect(fitShot(nat(40, 30), 1000)).toEqual({ w: 40, h: 30 });
  });

  test('wider than the content: scaled down to fit, aspect kept exactly', () => {
    const s = fitShot(nat(2000, 500), 1000);
    expect(s.w).toBe(1000);
    expect(s.w / s.h).toBeCloseTo(4, 10);
  });

  test('taller than the visible height: scaled down by height, aspect kept', () => {
    const s = fitShot(nat(400, 2000), 1000, 600);
    expect(s.w).toBe(120);
    expect(s.h).toBeCloseTo(600, 6);
  });

  test('no usable size falls back to a text-area-wide 16:9 box', () => {
    expect(fitShot(null, 1000).w).toBe(NOTE_TEXT_W);
    expect(fitShot(nat(0, 10), 1000).w).toBe(NOTE_TEXT_W);
  });

  test('a column is the screenshot clamped between the text area and the content width', () => {
    expect(slotWidthFor(100, NOTE_TEXT_W, 1000)).toBe(NOTE_TEXT_W);
    expect(slotWidthFor(500, NOTE_TEXT_W, 1000)).toBe(500);
    expect(slotWidthFor(1000, NOTE_TEXT_W, 1000)).toBe(1000);
  });
});

describe('row packing', () => {
  test('greedy, in order, while the row fits with its gaps, up to three', () => {
    expect(packRows([300, 300, 300, 300], 1000)).toEqual([[0, 1, 2], [3]]);
    expect(packRows([300, 300, 300, 300], 1000, COL_GAP, 2)).toEqual([[0, 1], [2, 3]]);
    expect(MAX_PER_ROW).toBe(3);
  });

  test('a note too wide to join gets its own row, and the ones after start a new one', () => {
    expect(packRows([300, 900, 300, 300], 1000)).toEqual([[0], [1], [2, 3]]);
  });

  test('exactly fitting counts as fitting; one pixel more does not', () => {
    expect(packRows([300, 300], 600 + COL_GAP)).toEqual([[0, 1]]);
    expect(packRows([300, 301], 600 + COL_GAP)).toEqual([[0], [1]]);
  });

  test('a width that does not fit even alone still gets a row', () => {
    expect(packRows([2000, 100], 1000)).toEqual([[0], [1]]);
    expect(packRows([], 1000)).toEqual([]);
  });
});

describe('the grid', () => {
  const W = 1000;

  test('three default notes share a row, centred, each at its own width', () => {
    const g = computeGridLayout([page('a', [267, 100], [267, 100], [267, 100])], { contentW: W });
    expect(g.rows).toHaveLength(1);
    const xs = [1, 2, 3].map((id) => g.notes.get(id)!.slot.x);
    const rowW = 3 * 267 + 2 * COL_GAP;
    expect(xs[0]).toBe(Math.round((W - rowW) / 2));
    expect(xs[1] - xs[0]).toBe(267 + COL_GAP);
    expect(xs[2] - xs[1]).toBe(267 + COL_GAP);
  });

  test('one- and two-note rows are centred too, and columns are never equalised', () => {
    const g = computeGridLayout([page('a', [300, 100], [500, 200])], { contentW: W });
    const a = g.notes.get(1)!;
    const b = g.notes.get(2)!;
    expect(a.slot.w).toBe(300);
    expect(b.slot.w).toBe(500);
    const left = a.slot.x;
    const right = W - (b.slot.x + b.slot.w);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

    const single = computeGridLayout([page('b', [400, 100])], { contentW: W }).notes.get(3)!;
    expect(single.slot.x).toBe((W - 400) / 2);
  });

  test('a wide note gets its own row; the next notes start a new one', () => {
    const g = computeGridLayout([page('a', [267, 100], [900, 300], [267, 100], [267, 100])], { contentW: W });
    expect(g.rows.map((r) => r.ids)).toEqual([[1], [2], [3, 4]]);
  });

  test('each note is one group — bar right above its image, text area right below — and the groups centre vertically in the row', () => {
    const g = computeGridLayout([page('a', [267, 100], [300, 240], [267, 60])], { contentW: W });
    const [a, b, c] = [1, 2, 3].map((id) => g.notes.get(id)!);
    for (const n of [a, b, c]) {
      // The bar sits directly above its own image, the text area directly below.
      expect(n.shot.y - (n.head.y + n.head.h)).toBe(NOTE_HEAD_GAP);
      expect(n.text.y - (n.shot.y + n.shot.h)).toBeCloseTo(NOTE_TEXT_GAP, 0);
      // ...and the bar and the text area are centred on the image.
      expect(Math.abs(n.head.x + n.head.w / 2 - (n.shot.x + n.shot.w / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(n.text.x + n.text.w / 2 - (n.shot.x + n.shot.w / 2))).toBeLessThanOrEqual(1);
    }
    // The tallest group fills the row; the others centre on it, so the
    // images are centred against each other.
    expect(b.head.y).toBe(g.rows[0].top);
    expect(b.text.y + b.text.h).toBe(g.rows[0].bottom);
    expect(Math.abs(a.shot.y + a.shot.h / 2 - (b.shot.y + b.shot.h / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(c.shot.y + c.shot.h / 2 - (b.shot.y + b.shot.h / 2))).toBeLessThanOrEqual(1);
    // Bars and text areas no longer line up across the row.
    expect(new Set([a.head.y, b.head.y, c.head.y]).size).toBe(3);
    expect(new Set([a.text.y, b.text.y, c.text.y]).size).toBe(3);
  });

  test('a narrow screenshot sits at its own size, centred over the one text-area width', () => {
    const g = computeGridLayout([page('a', [120, 80])], { contentW: W });
    const n = g.notes.get(1)!;
    expect(n.slot.w).toBe(NOTE_TEXT_W);
    expect(n.shot.w).toBe(120);
    expect(n.shot.x - n.slot.x).toBe(Math.round((NOTE_TEXT_W - 120) / 2));
    expect(n.text).toEqual({ x: n.slot.x, y: n.text.y, w: NOTE_TEXT_W, h: NOTE_TEXT_H });
    expect(n.head.w).toBe(n.slot.w);
  });

  test('a wide screenshot sets the column; the text area keeps its width, centred under it', () => {
    const n = computeGridLayout([page('a', [700, 200])], { contentW: W }).notes.get(1)!;
    expect(n.slot.w).toBe(700);
    expect(n.text.w).toBe(NOTE_TEXT_W);
    expect(n.text.x - n.slot.x).toBe(Math.round((700 - NOTE_TEXT_W) / 2));
  });

  test('wider than the content: scaled down to the content width', () => {
    const n = computeGridLayout([page('a', [3000, 600])], { contentW: W }).notes.get(1)!;
    expect(n.shot.w).toBe(W);
    expect(n.shot.h).toBeCloseTo(200, 6);
    expect(n.slot.x).toBe(0);
  });

  test('every text area has the same size', () => {
    const g = computeGridLayout([page('a', [100, 50], [600, 300]), page('b', [267, 100])], { contentW: W });
    expect(new Set([...g.notes.values()].map((n) => `${n.text.w}x${n.text.h}`))).toEqual(new Set([`${NOTE_TEXT_W}x${NOTE_TEXT_H}`]));
  });

  test('pages stack with a heading each; rows never mix pages', () => {
    const g = computeGridLayout([page('a', [267, 100]), page('b', [267, 100], [267, 100])], { contentW: W });
    expect(g.headings.map((h) => h.page)).toEqual(['a', 'b']);
    expect(g.rows.map((r) => [r.page, r.ids])).toEqual([['a', [1]], ['b', [2, 3]]]);
    expect(g.headings[0].box.y).toBe(PAD_TOP);
    expect(g.rows[0].top).toBe(PAD_TOP + HEADING_H + HEADING_GAP);
    expect(g.headings[1].box.y).toBe(g.rows[0].bottom + GROUP_GAP);
    expect(g.rows[1].top).toBe(g.headings[1].box.y + HEADING_H + HEADING_GAP);
    expect(g.height).toBe(g.rows[1].bottom + PAD_BOTTOM);
    expect(g.rows.map((r) => r.first)).toEqual([true, true]);
  });

  test('rows of one page are ROW_GAP apart', () => {
    const g = computeGridLayout([page('a', [600, 100], [600, 100])], { contentW: W });
    expect(g.rows[1].top - g.rows[0].bottom).toBe(ROW_GAP);
    expect(g.rows[1].first).toBe(false);
  });

  test('an empty page is skipped; no pages is an empty layout', () => {
    const g = computeGridLayout([page('a'), page('b', [267, 100])], { contentW: W });
    expect(g.headings.map((h) => h.page)).toEqual(['b']);
    expect(computeGridLayout([], { contentW: W }).height).toBe(0);
  });

  test('everything lands on whole pixels except a screenshot\'s exact height', () => {
    const g = computeGridLayout([page('a', [333, 111], [250, 77], [123, 99])], { contentW: 917 });
    for (const n of g.notes.values()) {
      for (const v of [n.slot.x, n.slot.y, n.shot.x, n.shot.y, n.shot.w, n.text.x, n.text.y]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe('narrow panels', () => {
  test('fewer notes per row as the content narrows, down to one', () => {
    const sizes: Array<[number, number]> = [[267, 100], [267, 100], [267, 100]];
    const at = (w: number) => computeGridLayout([page('a', ...sizes)], { contentW: w }).rows.map((r) => r.ids.length);
    expect(at(3 * 267 + 2 * COL_GAP)).toEqual([3]);
    nextId = 1;
    expect(at(3 * 267 + 2 * COL_GAP - 1)).toEqual([2, 1]);
    nextId = 1;
    expect(at(2 * 267 + COL_GAP - 1)).toEqual([1, 1, 1]);
  });

  test('when even one does not fit, its screenshot is scaled down and the text area narrows with the column', () => {
    const g = computeGridLayout([page('a', [400, 200])], { contentW: 240 });
    const n = g.notes.get(1)!;
    expect(n.shot.w).toBe(240);
    expect(n.shot.h).toBeCloseTo(120, 6);
    expect(n.text.w).toBe(240);
    expect(g.textW).toBe(240);
    expect(n.slot.x).toBe(0);
  });

  test('the visible height caps a tall screenshot', () => {
    const n = computeGridLayout([page('a', [300, 1500])], { contentW: 1000, maxShotH: 500 }).notes.get(1)!;
    expect(n.shot.h).toBeCloseTo(500, 6);
    expect(n.shot.w).toBe(100);
    expect(n.slot.w).toBe(NOTE_TEXT_W);
  });
});

describe('opening on a note: a fixed 40px peek of what comes before it', () => {
  // Page a: one wide note per row, two rows; page b: two rows as well.
  // Each row is 28 + 8 + 200 + 12 + 96 = 344px tall.
  function site() {
    return computeGridLayout(
      [page('a', [900, 200], [900, 200]), page('b', [900, 200], [900, 200])],
      { contentW: 1000 },
    );
  }
  /** Where content `y` is on screen, below the top bar, at scroll `top`. */
  const underBar = (y: number, top: number) => y - top;

  test('the peek is 40px; the page keys keep their own 80px overlap', () => {
    expect(OPEN_PEEK_PX).toBe(40);
    expect(PEEK_PX).toBe(80);
  });

  test('the site\'s first row starts at the top, with no peek — every note in it', () => {
    const g = computeGridLayout([page('a', [267, 100], [267, 100]), page('b', [900, 200])], { contentW: 1000 });
    expect(g.notes.get(1)!.row).toBe(0);
    expect(g.notes.get(2)!.row).toBe(0);
    expect(scrollTopFor(g, 1, 900 - TOP_BAR_H)).toBe(0);
    expect(scrollTopFor(g, 2, 900 - TOP_BAR_H)).toBe(0);
  });

  test('a later row on a page: the previous row\'s last 40px under the top bar, then the row at its gap', () => {
    const g = site();
    const top = scrollTopFor(g, 2, 900 - TOP_BAR_H)!;
    expect(underBar(g.rows[0].bottom, top)).toBe(OPEN_PEEK_PX);
    expect(underBar(g.rows[1].top, top)).toBe(OPEN_PEEK_PX + ROW_GAP);
  });

  test('a page\'s first row: its heading whole, the previous page\'s last row peeking 40px above it', () => {
    // Enough after it that the scroll is not clamped by the content's end.
    const g = computeGridLayout(
      [page('a', [900, 200], [900, 200]), page('b', [900, 200], [900, 200], [900, 200], [900, 200])],
      { contentW: 1000 },
    );
    const h = g.headings[1].box;
    const top = scrollTopFor(g, 3, 1200 - TOP_BAR_H)!;
    expect(g.rows[1].page).toBe('a');
    expect(underBar(g.rows[1].bottom, top)).toBe(OPEN_PEEK_PX);
    // The heading is never cut: wholly under the top bar, then the row.
    expect(underBar(h.y, top)).toBe(OPEN_PEEK_PX + GROUP_GAP);
    expect(underBar(g.rows[2].top, top)).toBe(OPEN_PEEK_PX + GROUP_GAP + HEADING_H + HEADING_GAP);
  });

  test('the site\'s first page has no row before it: its first row opens at the top', () => {
    const g = site();
    expect(scrollTopFor(g, 1, 400)).toBe(0);
  });

  test('a page\'s first row on a short window: the text area still wins over the heading and the peek', () => {
    const g = computeGridLayout(
      [page('a', [900, 200], [900, 200]), page('b', [900, 200], [900, 200], [900, 200], [900, 200])],
      { contentW: 1000 },
    );
    const n = g.notes.get(3)!;
    const vh = 400 - TOP_BAR_H;
    const top = scrollTopFor(g, 3, vh)!;
    expect(n.text.y + n.text.h + ROW_GAP / 2 - top).toBe(vh);
    expect(underBar(g.rows[1].bottom, top)).toBeLessThan(OPEN_PEEK_PX);
  });

  test('the same peek on a tall and on a short window, while both fit', () => {
    const g = site();
    expect(scrollTopFor(g, 2, 1400 - TOP_BAR_H)).toBe(scrollTopFor(g, 2, 520 - TOP_BAR_H));
  });

  test('too short for the peek and the text area: the text area wins, shown whole', () => {
    const g = site();
    const n = g.notes.get(2)!;
    const vh = 420 - TOP_BAR_H;
    const top = scrollTopFor(g, 2, vh)!;
    // With the peek the text area would end below the window...
    expect(n.text.y + n.text.h - (g.rows[0].bottom - OPEN_PEEK_PX)).toBeGreaterThan(vh);
    // ...so the scroll goes on until it is on screen, half a row gap to spare.
    expect(n.text.y + n.text.h + ROW_GAP / 2 - top).toBe(vh);
    expect(underBar(g.rows[0].bottom, top)).toBeLessThan(OPEN_PEEK_PX);
  });

  test('clamped to what the content can scroll', () => {
    const g = site();
    expect(scrollTopFor(g, 4, 10000)).toBe(0);
    const max = g.height - 700;
    expect(max).toBeLessThan(g.rows[2].bottom - OPEN_PEEK_PX);
    expect(scrollTopFor(g, 4, 700)).toBe(max);
  });

  test('an unknown note has no position', () => {
    expect(scrollTopFor(site(), 99, 600)).toBeNull();
  });
});

describe('a page\'s address', () => {
  test('shown without its scheme', () => {
    expect(displayUrl('https://example.com/pricing')).toBe('example.com/pricing');
    expect(displayUrl('https://localhost:3000')).toBe('localhost:3000');
    expect(displayUrl('/Users/me/page.html')).toBe('/Users/me/page.html');
  });

  test('ellipsized in the middle, keeping the host and the last segment', () => {
    expect(ellipsizeMiddle('example.com/a', 20)).toBe('example.com/a');
    const cut = ellipsizeMiddle('example.com/blog/2026/10/how-we-built-it', 21);
    expect(cut).toHaveLength(21);
    expect(cut).toBe('example.co\u2026e-built-it');
    expect(ellipsizeMiddle('abcdef', 1)).toBe('\u2026');
  });
});
