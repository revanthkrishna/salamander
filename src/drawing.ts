// src/drawing.ts
// The pencil's data model and its three renderers (design spec §AB): the
// live SVG paths add mode draws while editing, the static SVG overlay the
// note list and the enlarged view lay over a screenshot, and the canvas
// painter export uses to burn a drawing into the PNG.
//
// One module, so all three agree on what a stroke looks like — the 2px
// width, round caps and joins, and a lone point drawn as a dot. The
// service worker imports it too (export), so nothing here may touch the DOM
// at module load; buildDrawingSvg() is the only function that needs a
// `document`, and only the content script calls it.
//
// Coordinate spaces: add mode records strokes in viewport CSS px (the space
// the selection box lives in, so strokes stay pinned to the page while the
// box is resized — the box is only ever their clip). cropDrawing() turns
// that into the stored Drawing: CSS px relative to the final selection's
// top-left, cropped to it. Everything downstream scales from there.

import type { Drawing, DrawingStroke, Rect } from './types';

/** The pencil's colours, in the order the swatches show them. HEX, because
 *  that is what each stroke stores (§AB). `red` is a vivid annotation red,
 *  deliberately not the theme's `danger`, which reads as pink on a
 *  screenshot. */
export const PEN_COLORS = [
  { name: 'yellow', hex: '#E8B600' },
  { name: 'black', hex: '#1A1712' },
  { name: 'red', hex: '#E5484D' },
] as const;

export type PenColor = (typeof PEN_COLORS)[number]['hex'];

/** Yellow — what a fresh browser session starts on. */
export const DEFAULT_PEN_COLOR: PenColor = PEN_COLORS[0].hex;

/** Stroke width in CSS px of the selection. Export multiplies it by the
 *  image's own pixel scale, so a 2x capture gets a 4px line. */
export const STROKE_WIDTH = 2;

/** Stored points are rounded to this many decimals — pointer coordinates are
 *  already fractional on a HiDPI screen and clipping adds more; nothing
 *  finer than 1/100 of a CSS px is visible at any zoom. */
const POINT_DECIMALS = 2;

export function isPenColor(value: unknown): value is PenColor {
  return typeof value === 'string' && PEN_COLORS.some((c) => c.hex === value);
}

/** True for a drawing with at least one stroke to paint. */
export function hasStrokes(drawing: Drawing | undefined | null): drawing is Drawing {
  return !!drawing && Array.isArray(drawing.strokes) && drawing.strokes.some((s) => s.points.length > 0);
}

function round(v: number): number {
  const f = 10 ** POINT_DECIMALS;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Cropping (viewport strokes -> the stored Drawing)
// ---------------------------------------------------------------------------

/** Liang–Barsky: the part of segment a→b inside [0,w]×[0,h], as parameters
 *  t0 ≤ t1 along it, or null if none of it is inside. */
function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  w: number,
  h: number,
): { t0: number; t1: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, ax],
    [dx, w - ax],
    [-dy, ay],
    [dy, h - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return { t0, t1 };
}

function inside(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x <= w && y <= h;
}

/** One stroke, already translated into the rect's own space, cut to it. A
 *  stroke that leaves and comes back becomes one run per visit, so the part
 *  outside is never bridged by a straight line. */
function clipStroke(stroke: DrawingStroke, w: number, h: number): DrawingStroke[] {
  const pts = stroke.points;
  if (pts.length === 1) {
    const [x, y] = pts[0];
    return inside(x, y, w, h) ? [{ color: stroke.color, points: [[round(x), round(y)]] }] : [];
  }
  const runs: [number, number][][] = [];
  let run: [number, number][] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const seg = clipSegment(ax, ay, bx, by, w, h);
    if (!seg) {
      if (run) runs.push(run);
      run = null;
      continue;
    }
    const a: [number, number] = [round(ax + (bx - ax) * seg.t0), round(ay + (by - ay) * seg.t0)];
    const b: [number, number] = [round(ax + (bx - ax) * seg.t1), round(ay + (by - ay) * seg.t1)];
    // Entered from outside: whatever run was open ended at the edge.
    if (!run || seg.t0 > 0) {
      if (run) runs.push(run);
      run = [a];
    }
    run.push(b);
    // Left through an edge: close the run there.
    if (seg.t1 < 1) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs.map((points) => ({ color: stroke.color, points }));
}

/**
 * The stored Drawing for `strokes` (viewport CSS px) on the selection
 * `rect` (same space): translated to the rect's top-left and cropped to it.
 * Null when nothing drawn falls inside the rect — the item then carries no
 * `drawing` at all rather than an empty one.
 */
export function cropDrawing(strokes: readonly DrawingStroke[], rect: Rect): Drawing | null {
  const w = rect.width;
  const h = rect.height;
  if (!(w > 0) || !(h > 0)) return null;
  const out: DrawingStroke[] = [];
  for (const stroke of strokes) {
    const local: DrawingStroke = {
      color: stroke.color,
      points: stroke.points.map(([x, y]) => [x - rect.x, y - rect.y] as [number, number]),
    };
    out.push(...clipStroke(local, w, h));
  }
  return out.length > 0 ? { width: w, height: h, strokes: out } : null;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** The path data for one stroke. A lone point is a zero-length segment,
 *  which SVG draws as a round-capped dot — a tap leaves a mark. */
export function strokePathData(points: readonly [number, number][]): string {
  if (points.length === 0) return '';
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${x0} ${y0}L${x0} ${y0}`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i][0]} ${points[i][1]}`;
  return d;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A path element styled as a stroke. Presentation attributes rather than
 *  CSS so the same element renders identically in every shadow root. */
export function createStrokePath(doc: Document, stroke: DrawingStroke): SVGPathElement {
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', strokePathData(stroke.points));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke.color);
  path.setAttribute('stroke-width', String(STROKE_WIDTH));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  return path;
}

/**
 * A view-only overlay for a saved drawing: `viewBox="0 0 width height"`
 * with `xMidYMid meet`, which is exactly how an `object-fit: contain` image
 * of the same aspect is placed — so an SVG filling the same box as the
 * screenshot lines up with it at any size, and scales its 2px strokes with
 * the image. Hidden from assistive tech and from the pointer: the element
 * underneath (the thumbnail button, the card) keeps every click.
 */
export function buildDrawingSvg(doc: Document, drawing: Drawing, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', `0 0 ${drawing.width} ${drawing.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const stroke of drawing.strokes) {
    if (stroke.points.length > 0) svg.appendChild(createStrokePath(doc, stroke));
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Canvas (export)
// ---------------------------------------------------------------------------

/** The subset of a 2D context the painter uses — satisfied by both
 *  CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D. */
export interface StrokeContext {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
}

/**
 * Paint `drawing` onto a context whose pixels are `scaleX`/`scaleY` times
 * the drawing's CSS px (the screenshot's real size over the selection's).
 * The line width scales with them, so the exported image looks like what
 * was drawn on screen. A lone point is filled as a disc: canvas does not
 * promise a round cap on a zero-length line the way SVG does.
 */
export function paintDrawing(ctx: StrokeContext, drawing: Drawing, scaleX: number, scaleY: number): void {
  const width = STROKE_WIDTH * ((scaleX + scaleY) / 2);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of drawing.strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.arc(pts[0][0] * scaleX, pts[0][1] * scaleY, width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.strokeStyle = stroke.color;
    ctx.moveTo(pts[0][0] * scaleX, pts[0][1] * scaleY);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scaleX, pts[i][1] * scaleY);
    ctx.stroke();
  }
}
