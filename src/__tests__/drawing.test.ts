// src/drawing.ts — the pencil's pure half (design spec §AB): the palette,
// cropping viewport strokes into the stored Drawing, the SVG a saved drawing
// is shown with, and the canvas painter export burns it in with.

import {
  buildDrawingSvg,
  cropDrawing,
  DEFAULT_PEN_COLOR,
  hasStrokes,
  isPenColor,
  paintDrawing,
  PEN_COLORS,
  STROKE_WIDTH,
  strokePathData,
  StrokeContext,
} from '../drawing';
import type { Drawing } from '../types';

describe('the palette', () => {
  test('three colours stored as HEX, yellow first and the default', () => {
    expect(PEN_COLORS.map((c) => [c.name, c.hex])).toEqual([
      ['yellow', '#E8B600'],
      ['black', '#1A1712'],
      ['red', '#E5484D'],
    ]);
    expect(DEFAULT_PEN_COLOR).toBe('#E8B600');
    expect(STROKE_WIDTH).toBe(2);
  });

  test('isPenColor accepts exactly the three', () => {
    expect(PEN_COLORS.every((c) => isPenColor(c.hex))).toBe(true);
    for (const bad of ['#e8b600', '#FF7A6B', 'red', '', null, undefined, 3]) expect(isPenColor(bad)).toBe(false);
  });

  test('hasStrokes', () => {
    expect(hasStrokes(undefined)).toBe(false);
    expect(hasStrokes({ width: 10, height: 10, strokes: [] })).toBe(false);
    expect(hasStrokes({ width: 10, height: 10, strokes: [{ color: '#E8B600', points: [[1, 1]] }] })).toBe(true);
  });
});

describe('cropDrawing', () => {
  const rect = { x: 100, y: 50, width: 200, height: 100 };
  const Y = '#E8B600';

  test('translates to the rect\'s top-left and records its size', () => {
    expect(cropDrawing([{ color: Y, points: [[110, 60], [150, 90]] }], rect)).toEqual({
      width: 200,
      height: 100,
      strokes: [{ color: Y, points: [[10, 10], [50, 40]] }],
    });
  });

  test('a stroke crossing an edge is cut exactly at it', () => {
    const d = cropDrawing([{ color: Y, points: [[250, 100], [350, 100]] }], rect)!;
    expect(d.strokes).toEqual([{ color: Y, points: [[150, 50], [200, 50]] }]);
  });

  test('a stroke entering from outside starts at the edge', () => {
    const d = cropDrawing([{ color: Y, points: [[50, 100], [150, 100], [160, 110]] }], rect)!;
    expect(d.strokes).toEqual([{ color: Y, points: [[0, 50], [50, 50], [60, 60]] }]);
  });

  test('leaving and coming back makes two strokes — the outside part is never bridged', () => {
    const d = cropDrawing([{ color: Y, points: [[150, 100], [150, 200], [250, 200], [250, 100]] }], rect)!;
    expect(d.strokes).toEqual([
      { color: Y, points: [[50, 50], [50, 100]] },
      { color: Y, points: [[150, 100], [150, 50]] },
    ]);
  });

  test('a segment that only passes through the rect keeps just its inside part', () => {
    const d = cropDrawing([{ color: Y, points: [[0, 100], [400, 100]] }], rect)!;
    expect(d.strokes).toEqual([{ color: Y, points: [[0, 50], [200, 50]] }]);
  });

  test('a dot inside is kept, one outside is dropped', () => {
    expect(cropDrawing([{ color: Y, points: [[120, 70]] }], rect)!.strokes).toEqual([{ color: Y, points: [[20, 20]] }]);
    expect(cropDrawing([{ color: Y, points: [[20, 20]] }], rect)).toBeNull();
  });

  test('null when nothing drawn falls inside, or nothing was drawn', () => {
    expect(cropDrawing([{ color: Y, points: [[0, 0], [50, 40]] }], rect)).toBeNull();
    expect(cropDrawing([], rect)).toBeNull();
    expect(cropDrawing([{ color: Y, points: [[110, 60]] }], { ...rect, width: 0 })).toBeNull();
  });

  test('keeps each stroke\'s colour and the drawing order', () => {
    const d = cropDrawing(
      [
        { color: '#E5484D', points: [[110, 60], [120, 70]] },
        { color: '#1A1712', points: [[130, 60], [140, 70]] },
      ],
      rect,
    )!;
    expect(d.strokes.map((s) => s.color)).toEqual(['#E5484D', '#1A1712']);
  });

  test('rounds to 1/100 px', () => {
    const d = cropDrawing([{ color: Y, points: [[100.123456, 50.987654], [101, 51]] }], rect)!;
    expect(d.strokes[0].points[0]).toEqual([0.12, 0.99]);
  });

  test('does not mutate its input', () => {
    const input = [{ color: Y, points: [[110, 60], [150, 90]] as [number, number][] }];
    const copy = JSON.parse(JSON.stringify(input));
    cropDrawing(input, rect);
    expect(input).toEqual(copy);
  });
});

describe('SVG', () => {
  test('path data; a lone point is a zero-length segment (a round-capped dot)', () => {
    expect(strokePathData([[1, 2], [3, 4], [5, 6]])).toBe('M1 2L3 4L5 6');
    expect(strokePathData([[7, 8]])).toBe('M7 8L7 8');
    expect(strokePathData([])).toBe('');
  });

  test('buildDrawingSvg: viewBox of the selection, contain-fit, hidden from AT, one styled path per stroke', () => {
    const drawing: Drawing = {
      width: 200,
      height: 100,
      strokes: [
        { color: '#E8B600', points: [[10, 10], [50, 40]] },
        { color: '#E5484D', points: [[60, 60]] },
      ],
    };
    const svg = buildDrawingSvg(document, drawing, 'thumbnail-drawing');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('class')).toBe('thumbnail-drawing');
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const paths = Array.from(svg.querySelectorAll('path'));
    expect(paths.map((p) => [p.getAttribute('d'), p.getAttribute('stroke'), p.getAttribute('stroke-width')])).toEqual([
      ['M10 10L50 40', '#E8B600', '2'],
      ['M60 60L60 60', '#E5484D', '2'],
    ]);
    expect(paths.every((p) => p.getAttribute('stroke-linecap') === 'round' && p.getAttribute('fill') === 'none')).toBe(true);
  });
});

describe('paintDrawing (export)', () => {
  function recorder() {
    const calls: unknown[][] = [];
    const ctx: StrokeContext & { calls: unknown[][] } = {
      calls,
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      beginPath: () => calls.push(['beginPath']),
      moveTo: (x, y) => calls.push(['moveTo', x, y]),
      lineTo: (x, y) => calls.push(['lineTo', x, y]),
      arc: (x, y, r) => calls.push(['arc', x, y, r]),
      stroke: () => calls.push(['stroke', ctx.strokeStyle, ctx.lineWidth]),
      fill: () => calls.push(['fill', ctx.fillStyle]),
    };
    return ctx;
  }

  test('points and the 2px line scale with the image: a 2x capture gets a 4px line', () => {
    const ctx = recorder();
    paintDrawing(ctx, { width: 200, height: 100, strokes: [{ color: '#E5484D', points: [[10, 10], [50, 40]] }] }, 2, 2);
    expect(ctx.lineCap).toBe('round');
    expect(ctx.lineJoin).toBe('round');
    expect(ctx.calls).toEqual([
      ['beginPath'],
      ['moveTo', 20, 20],
      ['lineTo', 100, 80],
      ['stroke', '#E5484D', 4],
    ]);
  });

  test('a dot is filled as a disc of the line\'s width', () => {
    const ctx = recorder();
    paintDrawing(ctx, { width: 10, height: 10, strokes: [{ color: '#1A1712', points: [[5, 5]] }] }, 3, 3);
    expect(ctx.calls).toEqual([['beginPath'], ['arc', 15, 15, 3], ['fill', '#1A1712']]);
  });

  test('strokes paint in order, each in its own colour', () => {
    const ctx = recorder();
    paintDrawing(
      ctx,
      {
        width: 10,
        height: 10,
        strokes: [
          { color: '#E8B600', points: [[0, 0], [1, 1]] },
          { color: '#E5484D', points: [[2, 2], [3, 3]] },
        ],
      },
      1,
      1,
    );
    expect(ctx.calls.filter((c) => c[0] === 'stroke').map((c) => c[1])).toEqual(['#E8B600', '#E5484D']);
  });
});
