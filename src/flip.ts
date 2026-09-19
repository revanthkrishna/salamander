// src/flip.ts
// Small motion toolkit for the enlarged sidebar view (src/enlargedView.ts,
// design/MOTION_SPEC.md §1, §13). Pure math plus two thin Web Animations API
// wrappers — no module-level DOM, no knowledge of the view itself.
//
// Why a JS cubic-bezier at all when WAAPI takes the CSS string directly:
// interruptibility (MOTION_SPEC §13). A gesture that pre-empts another in
// flight (collapse during expand, a second ↓ mid-carousel, delete mid-morph)
// must start from where things *are*, not where they were headed. Rather than
// reading that back from the DOM (getComputedStyle mid-animation = forced
// style recalc, and a transform readback is a matrix, not a rect), every
// tween below keeps its own analytic record — from, to, start time, curve —
// so "current value" is pure arithmetic: the spec's "measure once" rule
// (§13) holds even across interruptions.
//
// The shared-element card morph (morphKeyframes) is a real transform-only
// FLIP: the card's layout box is set once to its destination ("Last"), then
// transforms map it back onto "First" and play to identity. Two problems the
// naive single scale() has are solved here by *sampling* the gesture into
// stepped keyframes (played with linear timing — the easing is baked into
// the samples):
//   - the screenshot inside a non-uniformly scaling frame would squash; it
//     gets its own counter-transform per sample so on screen it is always
//     exactly the contain-fit of the image into the frame's current box
//     (uniform scale — no distortion, letterboxing never swims);
//   - border-radius would scale with the frame; it is compensated per
//     sample (elliptical radii = r / scale on each axis), so the corners
//     read as a constant radius the whole way.

// ---------------------------------------------------------------------------
// Curves (MOTION_SPEC §1)
// ---------------------------------------------------------------------------

export type Ease = (t: number) => number;

/** A curve as both the CSS string WAAPI wants and the JS function the
 *  analytic tweens / sampled keyframes need — kept together so the two can
 *  never drift apart. */
export interface Curve {
  css: string;
  fn: Ease;
}

/** Standard cubic-bezier solver (Newton–Raphson with a bisection fallback),
 *  accurate to ~1e-6 — far below a pixel for any duration used here. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}

/** MD3 Standard — every shared-element morph, the panel edge, entrances. */
export const STD: Curve = { css: 'cubic-bezier(0.2, 0, 0, 1)', fn: cubicBezier(0.2, 0, 0, 1) };
/** MD3 Accelerate — exits, fade-outs, the delete shrink. */
export const ACC: Curve = { css: 'cubic-bezier(0.3, 0, 1, 1)', fn: cubicBezier(0.3, 0, 1, 1) };

// ---------------------------------------------------------------------------
// Clock + analytic tweens
// ---------------------------------------------------------------------------

/** Monotonic ms clock. performance.now() in every real browser (and under
 *  Jest's modern fake timers, which fake it along with setTimeout). */
export function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface Tween<T> {
  from: T;
  to: T;
  start: number;
  delay: number;
  duration: number;
  ease: Ease;
}

/** Eased progress 0..1 of `tw` at time `at` (0 during the delay). */
export function tweenProgress<T>(tw: Tween<T>, at: number): number {
  if (tw.duration <= 0) return at >= tw.start + tw.delay ? 1 : 0;
  const t = (at - tw.start - tw.delay) / tw.duration;
  return tw.ease(Math.min(1, Math.max(0, t)));
}

export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A card's resting geometry in one of its slots (list / main / peek), in
 *  viewport px: the frame box, the inner padding the screenshot is inset by,
 *  and the screenshot's own corner radius. */
export interface Slot extends Box {
  pad: number;
  imgR: number;
}

export function lerpSlot(a: Slot, b: Slot, p: number): Slot {
  return {
    x: lerp(a.x, b.x, p),
    y: lerp(a.y, b.y, p),
    w: lerp(a.w, b.w, p),
    h: lerp(a.h, b.h, p),
    pad: lerp(a.pad, b.pad, p),
    imgR: lerp(a.imgR, b.imgR, p),
  };
}

export function insetBox(b: Box, pad: number): Box {
  const p = Math.max(0, Math.min(pad, b.w / 2 - 0.5, b.h / 2 - 0.5));
  return { x: b.x + p, y: b.y + p, w: Math.max(1, b.w - 2 * p), h: Math.max(1, b.h - 2 * p) };
}

/** `object-fit: contain` as arithmetic: the largest box of `aspect` (w/h)
 *  that fits in `b`, centred. */
export function containFit(aspect: number, b: Box): Box {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let w = b.w;
  let h = w / a;
  if (h > b.h) {
    h = b.h;
    w = h * a;
  }
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

// ---------------------------------------------------------------------------
// Card morph keyframes (see the file banner)
// ---------------------------------------------------------------------------

export interface MorphKeyframes {
  frame: Keyframe[];
  img: Keyframe[];
  /** Translate-only: follows the frame's top-left corner (number badge). */
  badge: Keyframe[];
  /** Translate-only: follows the frame's bottom-left corner (peek caption). */
  caption: Keyframe[];
}

/**
 * Sampled FLIP keyframes for one card travelling `from` → `to` (viewport
 * px). The card's layout box is assumed to already sit at `to` (Last);
 * every keyframe maps it back to the eased intermediate rect. Elements are
 * expected to use `transform-origin: 0 0`, and the image's layout box to be
 * the contain-fit of `aspect` into `to` inset by `to.pad`, relative to the
 * frame's top-left.
 */
export function morphKeyframes(
  from: Slot,
  to: Slot,
  aspect: number,
  ease: Ease,
  steps: number,
  frameRadius: number,
): MorphKeyframes {
  const out: MorphKeyframes = { frame: [], img: [], badge: [], caption: [] };
  const lastImg = containFit(aspect, insetBox({ x: 0, y: 0, w: to.w, h: to.h }, to.pad));
  const n = Math.max(1, Math.round(steps));
  for (let i = 0; i <= n; i++) {
    const offset = i / n;
    const s = lerpSlot(from, to, ease(offset));
    const sfx = s.w / to.w;
    const sfy = s.h / to.h;
    const tfx = s.x - to.x;
    const tfy = s.y - to.y;
    out.frame.push({
      offset,
      transform: `translate(${r3(tfx)}px, ${r3(tfy)}px) scale(${r5(sfx)}, ${r5(sfy)})`,
      borderRadius: `${r3(frameRadius / sfx)}px / ${r3(frameRadius / sfy)}px`,
    });

    // The screenshot's on-screen box at this sample, and the child transform
    // that puts it there *through* the frame's own (non-uniform) transform.
    const d = containFit(aspect, insetBox(s, s.pad));
    const ds = d.w / lastImg.w;
    const scx = ds / sfx;
    const scy = d.h / lastImg.h / sfy;
    const tcx = (d.x - to.x - tfx) / sfx - lastImg.x;
    const tcy = (d.y - to.y - tfy) / sfy - lastImg.y;
    out.img.push({
      offset,
      transform: `translate(${r3(tcx)}px, ${r3(tcy)}px) scale(${r5(scx)}, ${r5(scy)})`,
      borderRadius: `${r3(s.imgR / ds)}px`,
    });

    out.badge.push({ offset, transform: `translate(${r3(tfx)}px, ${r3(tfy)}px)` });
    out.caption.push({
      offset,
      transform: `translate(${r3(tfx)}px, ${r3(tfy + s.h - to.h)}px)`,
    });
  }
  return out;
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function r5(v: number): number {
  return Math.round(v * 100000) / 100000;
}

// ---------------------------------------------------------------------------
// WAAPI wrappers
// ---------------------------------------------------------------------------

/** element.animate(), or null where WAAPI is missing (jsdom) or throws —
 *  every caller has already written the final inline style first, so "no
 *  animation" degrades to "jump to the end state", never to a broken one. */
export function animateEl(
  el: Element,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  const fn = (el as Element & { animate?: Element['animate'] }).animate;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(el, keyframes, options);
  } catch {
    return null;
  }
}

interface NumberTrack {
  tween: Tween<number>;
  anim: Animation | null;
}

/** Live numeric tweens per element + property key (opacity, width). */
const tracks = new WeakMap<Element, Map<string, NumberTrack>>();

/** Current (possibly mid-flight) value of `el`'s tracked `key`, or
 *  `fallback` if nothing was ever tweened on it. */
export function trackedValue(el: Element, key: string, fallback: number): number {
  const t = tracks.get(el)?.get(key);
  if (!t) return fallback;
  return lerp(t.tween.from, t.tween.to, tweenProgress(t.tween, now()));
}

export interface NumberAnimOptions {
  duration: number;
  delay?: number;
  curve: Curve;
  /** Start value; defaults to the tracked current value (interruption-safe). */
  from?: number;
}

/**
 * Tween one numeric CSS property of `el` to `to`: writes the final value
 * inline first (so a cancelled/missing animation lands on the end state),
 * then plays from the current value — which, for an interrupted tween, is
 * wherever the previous one had got to. `fill: backwards` holds the start
 * value through `delay`.
 */
export function animateNumber(
  el: HTMLElement,
  prop: 'opacity' | 'width',
  to: number,
  opts: NumberAnimOptions,
): void {
  const unit = prop === 'width' ? 'px' : '';
  const fallback = prop === 'opacity' ? parseOpacity(el) : to;
  const from = opts.from ?? trackedValue(el, prop, fallback);
  cancelTrack(el, prop);
  el.style.setProperty(prop, `${to}${unit}`);
  const delay = opts.delay ?? 0;
  if (opts.duration <= 0 || (from === to && delay === 0)) {
    setTrack(el, prop, { tween: { from: to, to, start: now(), delay: 0, duration: 0, ease: opts.curve.fn }, anim: null });
    return;
  }
  const anim = animateEl(
    el,
    [{ [prop]: `${from}${unit}` }, { [prop]: `${to}${unit}` }],
    { duration: opts.duration, delay, easing: opts.curve.css, fill: 'backwards' },
  );
  setTrack(el, prop, {
    tween: { from, to, start: now(), delay, duration: opts.duration, ease: opts.curve.fn },
    anim,
  });
}

/** Shorthand for the (very common) opacity case. */
export function fadeTo(el: HTMLElement, to: number, opts: NumberAnimOptions): void {
  animateNumber(el, 'opacity', to, opts);
}

/** Current opacity of `el` (tracked tween, else its inline style, else 1). */
export function currentOpacity(el: HTMLElement): number {
  return trackedValue(el, 'opacity', parseOpacity(el));
}

/** Stop every tracked tween on `el` (its inline end values stay). */
export function cancelTracks(el: Element): void {
  const m = tracks.get(el);
  if (!m) return;
  for (const t of m.values()) t.anim?.cancel();
  tracks.delete(el);
}

function cancelTrack(el: Element, key: string): void {
  const m = tracks.get(el);
  const t = m?.get(key);
  if (!m || !t) return;
  t.anim?.cancel();
  m.delete(key);
}

function setTrack(el: Element, key: string, t: NumberTrack): void {
  let m = tracks.get(el);
  if (!m) {
    m = new Map();
    tracks.set(el, m);
  }
  m.set(key, t);
}

function parseOpacity(el: HTMLElement): number {
  const v = parseFloat(el.style.opacity);
  return Number.isFinite(v) ? v : 1;
}
