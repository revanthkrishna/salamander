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
  PEEK_PX,
  LANDING_FRACTION,
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

  test('screenshots centre vertically in the row\'s band; the text areas all start at one y', () => {
    const g = computeGridLayout([page('a', [267, 100], [300, 240], [267, 60])], { contentW: W });
    const [a, b, c] = [1, 2, 3].map((id) => g.notes.get(id)!);
    const bandTop = a.slot.y + NOTE_HEAD_H + NOTE_HEAD_GAP;
    // The tallest fills the band; the others centre on it.
    expect(b.shot.y).toBe(bandTop);
    expect(a.shot.y + a.shot.h / 2).toBeCloseTo(b.shot.y + b.shot.h / 2, 0);
    expect(c.shot.y + c.shot.h / 2).toBeCloseTo(b.shot.y + b.shot.h / 2, 0);
    expect(new Set([a.text.y, b.text.y, c.text.y]).size).toBe(1);
    expect(a.text.y).toBe(bandTop + 240 + NOTE_TEXT_GAP);
    // ...and the header lines share the row's top.
    expect(new Set([a.head.y, b.head.y, c.head.y]).size).toBe(1);
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

describe('opening on a note: a quarter of the way down, the notes before it peeking', () => {
  // Page a: one wide note per row, two rows; page b: two rows as well.
  // Each row is 28 + 8 + 200 + 12 + 96 = 344px tall.
  function site() {
    return computeGridLayout(
      [page('a', [900, 200], [900, 200]), page('b', [900, 200], [900, 200])],
      { contentW: 1000 },
    );
  }
  /** Where a box `y` sits on screen, as a fraction of a panel `panelH`
   *  tall whose scroller (under the top bar) is scrolled to `top`. */
  const onPanel = (y: number, top: number, panelH: number) => (TOP_BAR_H + y - top) / panelH;

  test('the site\'s first row starts at the top, with no peek', () => {
    expect(scrollTopFor(site(), 1, 900 - TOP_BAR_H)).toBe(0);
  });

  test('a later row lands 25% down the panel, with more than PEEK_PX of the previous row above it', () => {
    const g = site();
    const top = scrollTopFor(g, 2, 900 - TOP_BAR_H)!;
    expect(onPanel(g.rows[1].top, top, 900)).toBeCloseTo(LANDING_FRACTION, 2);
    expect(g.rows[0].bottom - top).toBeGreaterThan(PEEK_PX);
  });

  test('a page\'s first row lands there too, its heading on screen and the previous page\'s last row peeking', () => {
    const g = site();
    const top = scrollTopFor(g, 3, 1000 - TOP_BAR_H)!;
    expect(onPanel(g.rows[2].top, top, 1000)).toBeCloseTo(LANDING_FRACTION, 2);
    expect(g.headings[1].box.y).toBeGreaterThanOrEqual(top);
    expect(g.rows[1].bottom - top).toBeGreaterThanOrEqual(PEEK_PX);
  });

  test('on a short window the peek never drops below PEEK_PX: the row sits lower instead', () => {
    const g = computeGridLayout(
      [page('a', [900, 100], [900, 100]), page('b', [900, 100], [900, 100])],
      { contentW: 1000 },
    );
    const top = scrollTopFor(g, 3, 520 - TOP_BAR_H)!;
    expect(g.rows[1].bottom - top).toBe(PEEK_PX);
    expect(onPanel(g.rows[2].top, top, 520)).toBeGreaterThan(LANDING_FRACTION);
  });

  test('clamped to what the content can scroll', () => {
    const g = site();
    expect(scrollTopFor(g, 4, 10000)).toBe(0);
    const max = g.height - 700;
    expect(max).toBeLessThan(g.rows[2].bottom - PEEK_PX);
    expect(scrollTopFor(g, 4, 700)).toBe(max);
  });

  test('an unknown note has no position', () => {
    expect(scrollTopFor(site(), 99, 600)).toBeNull();
  });

  test('a row too tall for its landing gives up as much as its text area needs to be on screen', () => {
    const g = computeGridLayout([page('a', [900, 200]), page('b', [600, 560])], { contentW: 1000 });
    const n = g.notes.get(2)!;
    const top = scrollTopFor(g, 2, 700)!;
    expect(n.text.y + n.text.h - top).toBeLessThanOrEqual(700);
    expect(g.rows[0].bottom - top).toBeLessThan(PEEK_PX);
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
