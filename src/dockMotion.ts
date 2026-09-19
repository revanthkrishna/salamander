// src/dockMotion.ts
// macOS-Dock-style magnification for the sidebar's note list (design spec §4).
//
// The list is magnified *continuously* from the pointer's Y position — never
// from a discrete "hovered index" — so moving up and down the list slides the
// swell smoothly between items the way the Dock does, instead of snapping
// from one item to the next.
//
// Model, per item (one <li class="thumbnail-item">):
//   1. target influence  t = falloff(|pointerY − item centre|), a raised
//      cosine over DOCK_RADIUS_ITEMS item heights (1 on the centre, 0 past
//      the radius, C¹-smooth everywhere so the swell has no visible edge).
//   2. influence x chases t through a damped spring, integrated *analytically*
//      (closed-form solution over the real frame dt), so it is exactly
//      frame-rate independent — 60Hz, 120Hz and a janky 24Hz frame all trace
//      the same curve — and cannot blow up on a long frame.
//   3. x drives everything visible: scale 1 + 0.12x and translateX −22x
//      (transform-origin: right center, so items grow out over the page),
//      a subtle translateY that nudges neighbours apart by a fraction of the
//      growth around them, and z-index so the most magnified item is on top.
//   4. The note background (surface + shadowNote, a dedicated
//      `.thumbnail-note-bg` layer from thumbnails.ts) has its own spring on
//      opacity: target 1 only for the single most-influenced item, and only
//      once its influence reaches NOTE_BG_THRESHOLD — so exactly one note
//      lights up, fading rather than flicking.
//
// Distances are measured against the items' UNTRANSFORMED layout, so the
// magnification never feeds back on itself. Layout is only ever read on
// pointerenter / the first move after invalidation, scroll, resize and via
// ResizeObserver — never inside the rAF loop, which only writes transforms
// and opacity. getBoundingClientRect() returns the *transformed* box, so
// measure() inverts the transform this module last applied (scale about the
// vertical centre preserves the centre; only dy moves it) instead of
// clearing styles, which would itself cost a style/layout round trip.
//
// One shared requestAnimationFrame loop drives every item and goes to sleep
// as soon as all springs are at rest; will-change is only set while it runs
// (so resting items are re-rasterised crisply rather than left as a scaled
// bitmap). prefers-reduced-motion: reduce switches the whole layer off —
// no transforms at all — and hands the note background back to the plain
// CSS :hover/:focus-visible rule in sidebar.ts (keyed off the list's
// data-dock attribute, which this module owns). The media query is watched
// live, so flipping the OS setting takes effect without a reload.
//
// The pure maths (falloff, targets, spring step, rest test, nudges) is
// exported for unit tests; attachDockMotion() is the only DOM-facing entry
// point and returns a handle whose destroy() removes every listener,
// observer, rAF and inline style it added.

/** Peak scale gain on the item under the pointer (1 → 1.12). */
export const DOCK_SCALE_GAIN = 0.12;
/** Peak leftward shift (px) on the item under the pointer. */
export const DOCK_SHIFT_PX = 22;
/** Falloff radius in mean item heights: at ~1.75, the direct neighbours of
 *  the hovered item sit at ~0.3 influence (scale ~1.035) and the next ones
 *  out are untouched — the Dock's "three-icon swell". */
export const DOCK_RADIUS_ITEMS = 1.75;
/** Influence at which the most-influenced item's note background appears. */
export const NOTE_BG_THRESHOLD = 0.6;
/** Fraction of the neighbours' vertical growth used to nudge an item apart
 *  from them. The list's 16px gap already absorbs most of the ~10px growth,
 *  so this stays subtle: enough to read as the list "making room", never
 *  enough to shuffle the list. */
export const DOCK_NUDGE = 0.5;

export interface SpringParams {
  /** Natural angular frequency (rad/s): higher = snappier. */
  omega: number;
  /** Damping ratio: 1 = critically damped (no overshoot); < 1 overshoots. */
  zeta: number;
}

/** While the pointer/focus is on the list: tight enough to track a fast
 *  flick (~40ms time constant, settles in ~250ms) with a whisper of
 *  under-damping (<0.2% overshoot — felt as liveliness, never seen as a
 *  wobble). */
export const SPRING_TRACK: SpringParams = { omega: 26, zeta: 0.92 };
/** On leave: critically damped and a touch softer (~320ms) so the list
 *  exhales back to rest rather than snapping shut. */
export const SPRING_RELEASE: SpringParams = { omega: 20, zeta: 1 };

/** Longest frame step the loop will integrate. The analytic step is stable
 *  for any dt, but after a background-tab stall or GC pause we'd rather
 *  resume the motion than teleport to its end. */
export const MAX_DT_S = 1 / 15;
/** Step assumed for the first frame after the loop wakes (no previous
 *  timestamp to diff against). */
const FIRST_FRAME_DT_S = 1 / 60;

/** Position/velocity thresholds below which a spring counts as settled. In
 *  influence units: 1e-3 ≈ 0.02px of shift and 0.0001 of scale. */
const REST_POS_EPS = 1e-3;
const REST_VEL_EPS = 1e-2;

/** Fallback item height when layout is unavailable (jsdom, hidden list). */
const FALLBACK_ITEM_HEIGHT_PX = 170;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

/** Raised-cosine falloff: 1 at d = 0, 0 at |d| ≥ radius, zero slope at both
 *  ends (so neither the peak nor the edge of the swell shows a crease). */
export function falloff(distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const d = Math.abs(distance);
  if (d >= radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / radius));
}

/** Target influence per item for a focal Y (same coordinate space as
 *  `centres`), or all zeros when there is no focal point (pointer left and
 *  nothing focused). */
export function computeTargets(focalY: number | null, centres: readonly number[], radius: number): number[] {
  if (focalY === null) return centres.map(() => 0);
  return centres.map((c) => falloff(focalY - c, radius));
}

/** Index of the item whose note background should show: the single
 *  most-influenced item, provided it has reached NOTE_BG_THRESHOLD. */
export function noteTargetIndex(targets: readonly number[]): number {
  let best = -1;
  let bestVal = NOTE_BG_THRESHOLD;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i] >= bestVal) {
      best = i;
      bestVal = targets[i];
    }
  }
  return best;
}

export interface SpringState {
  x: number;
  v: number;
}

/** Advance a damped spring toward `target` by `dt` seconds using the
 *  closed-form solution of x'' = −ω²(x − target) − 2ζω x'. Exact for a
 *  target held constant over the step, which is what makes the motion
 *  identical regardless of frame rate. ζ ≥ 1 is treated as critical. */
export function stepSpring(state: SpringState, target: number, dt: number, p: SpringParams): SpringState {
  if (dt <= 0) return { x: state.x, v: state.v };
  const { omega } = p;
  const y0 = state.x - target;
  const v0 = state.v;
  if (p.zeta >= 1) {
    const e = Math.exp(-omega * dt);
    const b = v0 + omega * y0;
    return { x: target + (y0 + b * dt) * e, v: (v0 - b * omega * dt) * e };
  }
  const zeta = Math.max(0, p.zeta);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-zeta * omega * dt);
  const c = Math.cos(wd * dt);
  const s = Math.sin(wd * dt);
  const b = (v0 + zeta * omega * y0) / wd;
  return {
    x: target + e * (y0 * c + b * s),
    v: e * (v0 * c - (y0 * wd + zeta * omega * b) * s),
  };
}

export function isAtRest(state: SpringState, target: number): boolean {
  return Math.abs(state.x - target) < REST_POS_EPS && Math.abs(state.v) < REST_VEL_EPS;
}

/** Influence below which an item's nudge is faded out, so only items inside
 *  the swell make room — the rest of the list stays still rather than the
 *  whole tail breathing up and down on every enter/leave. */
const NUDGE_FULL_AT = 0.25;

/** Vertical nudge per item (px): each item is pushed away from its
 *  neighbours by DOCK_NUDGE × half of their vertical growth (items above
 *  push it down, items below push it up), faded in with its own influence.
 *  Driven by the springs' current influence, not the targets, so it is as
 *  smooth as the scale itself; an item flanked symmetrically stays put. */
export function computeNudges(influences: readonly number[], heights: readonly number[]): number[] {
  const n = influences.length;
  const halfGrowth = influences.map((x, i) => (DOCK_SCALE_GAIN * x * heights[i]) / 2);
  const out = new Array<number>(n).fill(0);
  let above = 0;
  for (let i = 0; i < n; i++) {
    out[i] += above;
    above += halfGrowth[i];
  }
  let below = 0;
  for (let i = n - 1; i >= 0; i--) {
    out[i] -= below;
    below += halfGrowth[i];
  }
  return out.map((dy, i) => dy * DOCK_NUDGE * Math.min(1, Math.max(0, influences[i]) / NUDGE_FULL_AT));
}

// ---------------------------------------------------------------------------
// DOM controller
// ---------------------------------------------------------------------------

export interface DockMotionHandle {
  /** Re-read the cached layout (call after anything moves the items that
   *  the built-in listeners can't see). */
  refresh(): void;
  /** Remove every listener/observer/rAF and restore the items' styles. */
  destroy(): void;
}

export interface DockMotionOptions {
  /** The element that scrolls the list (sidebar.ts's `.body`); scroll
   *  events don't bubble, so it has to be named. */
  scrollContainer?: HTMLElement | null;
}

interface DockItem {
  li: HTMLElement;
  noteBg: HTMLElement | null;
  /** Untransformed vertical centre, relative to the list's top edge. */
  centre: number;
  /** Untransformed height. */
  height: number;
  influence: SpringState;
  note: SpringState;
  /** Last values written to the DOM — used to invert the transform when
   *  measuring and to skip redundant style writes. */
  scale: number;
  dy: number;
  z: number;
}

type RafFn = (cb: (ts: number) => void) => number;
type CancelRafFn = (id: number) => void;

function getRaf(): { raf: RafFn; cancel: CancelRafFn } {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return {
      raf: (cb) => window.requestAnimationFrame(cb),
      cancel: (id) => window.cancelAnimationFrame(id),
    };
  }
  return {
    raf: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancel: (id) => clearTimeout(id),
  };
}

function getReducedMotionQuery(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    return null;
  }
}

/** True when `el` currently shows keyboard focus. Falls back to true where
 *  the selector isn't supported (older engines, jsdom): showing the swell on
 *  a mouse-focused button is a far smaller sin than never showing it for a
 *  keyboard user. */
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Wire dock magnification onto a rendered note list. Call again (after
 *  destroy()) whenever the list is repainted — items are captured once. */
export function attachDockMotion(listEl: HTMLElement, options: DockMotionOptions = {}): DockMotionHandle {
  const scrollContainer = options.scrollContainer ?? null;
  const { raf, cancel } = getRaf();

  const items: DockItem[] = Array.from(listEl.children)
    .filter((el): el is HTMLElement => el instanceof HTMLElement)
    .map((li) => ({
      li,
      noteBg: li.querySelector<HTMLElement>('.thumbnail-note-bg'),
      centre: 0,
      height: 0,
      influence: { x: 0, v: 0 },
      note: { x: 0, v: 0 },
      scale: 1,
      dy: 0,
      z: 0,
    }));

  let listTop = 0;
  let radius = FALLBACK_ITEM_HEIGHT_PX * DOCK_RADIUS_ITEMS;
  let layoutDirty = true;
  /** Pointer clientY while it is over the list, else null. */
  let pointerY: number | null = null;
  /** Index of the keyboard-focused item, else null. */
  let focusIndex: number | null = null;
  let targets: number[] = items.map(() => 0);
  let noteIndex = -1;
  let params = SPRING_RELEASE;
  let rafId: number | null = null;
  let lastTs: number | null = null;
  let animating = false;
  let destroyed = false;

  const mql = getReducedMotionQuery();
  let reduced = mql?.matches ?? false;

  // ─── Layout cache ─────────────────────────────────────────────────────

  function measure(): void {
    layoutDirty = false;
    listTop = listEl.getBoundingClientRect().top;
    let total = 0;
    for (const item of items) {
      const r = item.li.getBoundingClientRect();
      // Undo our own transform: scale is about the vertical centre (so the
      // centre only moves by dy) and multiplies the height.
      item.height = r.height / item.scale;
      item.centre = (r.top + r.bottom) / 2 - item.dy - listTop;
      total += item.height;
    }
    const mean = items.length > 0 ? total / items.length : 0;
    radius = (mean > 0 ? mean : FALLBACK_ITEM_HEIGHT_PX) * DOCK_RADIUS_ITEMS;
  }

  /** Scrolling moves the whole list rigidly — only its top needs re-reading. */
  function measureListTop(): void {
    listTop = listEl.getBoundingClientRect().top;
  }

  // ─── Targets ──────────────────────────────────────────────────────────

  function retarget(): void {
    if (reduced || destroyed) return;
    let focalY: number | null = null;
    if (pointerY !== null) {
      focalY = pointerY - listTop;
    } else if (focusIndex !== null && items[focusIndex]) {
      focalY = items[focusIndex].centre;
    }
    targets = computeTargets(
      focalY,
      items.map((it) => it.centre),
      radius,
    );
    noteIndex = noteTargetIndex(targets);
    params = focalY === null ? SPRING_RELEASE : SPRING_TRACK;
    wake();
  }

  // ─── Loop ─────────────────────────────────────────────────────────────

  function wake(): void {
    if (rafId !== null || destroyed || reduced) return;
    if (!animating) {
      animating = true;
      for (const item of items) item.li.style.willChange = 'transform';
    }
    rafId = raf(frame);
  }

  function frame(ts: number): void {
    rafId = null;
    if (destroyed || reduced) return;
    const dt = lastTs === null ? FIRST_FRAME_DT_S : Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_DT_S);
    lastTs = ts;

    let allRest = true;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const t = targets[i] ?? 0;
      const nt = i === noteIndex ? 1 : 0;
      item.influence = stepSpring(item.influence, t, dt, params);
      item.note = stepSpring(item.note, nt, dt, params);
      if (isAtRest(item.influence, t)) item.influence = { x: t, v: 0 };
      else allRest = false;
      if (isAtRest(item.note, nt)) item.note = { x: nt, v: 0 };
      else allRest = false;
    }
    write();

    if (allRest) {
      sleep();
    } else {
      rafId = raf(frame);
    }
  }

  function sleep(): void {
    lastTs = null;
    if (!animating) return;
    animating = false;
    for (const item of items) item.li.style.willChange = '';
  }

  function write(): void {
    const nudges = computeNudges(
      items.map((it) => it.influence.x),
      items.map((it) => it.height),
    );
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const x = item.influence.x;
      const dy = nudges[i];
      const scale = 1 + DOCK_SCALE_GAIN * x;
      if (Math.abs(x) < 1e-6 && Math.abs(dy) < 1e-3) {
        if (item.scale !== 1 || item.dy !== 0) item.li.style.transform = '';
        item.scale = 1;
        item.dy = 0;
      } else {
        item.li.style.transform =
          `translate3d(${(-DOCK_SHIFT_PX * x).toFixed(3)}px, ${dy.toFixed(3)}px, 0) scale(${scale.toFixed(5)})`;
        item.scale = scale;
        item.dy = dy;
      }
      // Quantised so z-order only changes (and restacks) when the ranking
      // meaningfully does.
      const z = Math.round(Math.max(0, x) * 100);
      if (z !== item.z) {
        item.li.style.zIndex = z === 0 ? '' : String(z);
        item.z = z;
      }
      if (item.noteBg) {
        const o = Math.min(1, Math.max(0, item.note.x));
        item.noteBg.style.opacity = o < 1e-3 ? '' : o.toFixed(4);
      }
    }
  }

  /** Drop every spring to rest and strip our inline styles (reduced motion
   *  switching on, and teardown). */
  function resetStyles(): void {
    if (rafId !== null) cancel(rafId);
    rafId = null;
    sleep();
    for (const item of items) {
      item.influence = { x: 0, v: 0 };
      item.note = { x: 0, v: 0 };
      item.scale = 1;
      item.dy = 0;
      item.z = 0;
      item.li.style.transform = '';
      item.li.style.zIndex = '';
      item.li.style.willChange = '';
      if (item.noteBg) item.noteBg.style.opacity = '';
    }
  }

  // ─── Event wiring ─────────────────────────────────────────────────────

  function onPointerEnter(e: PointerEvent): void {
    pointerY = e.clientY;
    if (reduced) return;
    measure();
    retarget();
  }

  function onPointerMove(e: PointerEvent): void {
    pointerY = e.clientY;
    if (reduced) return;
    // A repaint swaps in a fresh instance while the pointer may already be
    // inside the list (no pointerenter), so measure lazily on first move.
    if (layoutDirty) measure();
    retarget();
  }

  function onPointerLeave(): void {
    pointerY = null;
    retarget();
  }

  function indexOfTarget(target: EventTarget | null): number {
    if (!(target instanceof Node)) return -1;
    return items.findIndex((it) => it.li.contains(target));
  }

  function onFocusIn(e: FocusEvent): void {
    const idx = indexOfTarget(e.target);
    // Mouse clicks focus the button too; only keyboard focus magnifies, or a
    // clicked item would stay swollen after the pointer leaves.
    focusIndex = idx >= 0 && e.target instanceof Element && isFocusVisible(e.target) ? idx : null;
    if (reduced) return;
    if (layoutDirty) measure();
    retarget();
  }

  function onFocusOut(e: FocusEvent): void {
    if (indexOfTarget(e.relatedTarget) >= 0) return; // focusin will retarget
    focusIndex = null;
    retarget();
  }

  function onScroll(): void {
    if (reduced) return;
    if (layoutDirty) measure();
    else measureListTop();
    if (pointerY !== null || focusIndex !== null) retarget();
  }

  function onLayoutChange(): void {
    layoutDirty = true;
    if (reduced) return;
    if (pointerY !== null || focusIndex !== null) {
      measure();
      retarget();
    }
  }

  function applyReducedMotion(): void {
    if (reduced) {
      resetStyles();
      delete listEl.dataset.dock;
    } else {
      listEl.dataset.dock = 'on';
      layoutDirty = true;
      if (pointerY !== null || focusIndex !== null) {
        measure();
        retarget();
      }
    }
  }

  function onReducedMotionChange(): void {
    reduced = mql?.matches ?? false;
    applyReducedMotion();
  }

  listEl.addEventListener('pointerenter', onPointerEnter);
  listEl.addEventListener('pointermove', onPointerMove);
  listEl.addEventListener('pointerleave', onPointerLeave);
  listEl.addEventListener('focusin', onFocusIn);
  listEl.addEventListener('focusout', onFocusOut);
  scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onLayoutChange);
  // Sidebar drags change the width → notes rewrap → heights change; late
  // font loads do the same. Guarded: jsdom has no ResizeObserver.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onLayoutChange) : null;
  ro?.observe(listEl);
  mql?.addEventListener?.('change', onReducedMotionChange);

  applyReducedMotion();

  return {
    refresh(): void {
      onLayoutChange();
    },
    destroy(): void {
      if (destroyed) return;
      resetStyles();
      destroyed = true;
      listEl.removeEventListener('pointerenter', onPointerEnter);
      listEl.removeEventListener('pointermove', onPointerMove);
      listEl.removeEventListener('pointerleave', onPointerLeave);
      listEl.removeEventListener('focusin', onFocusIn);
      listEl.removeEventListener('focusout', onFocusOut);
      scrollContainer?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onLayoutChange);
      ro?.disconnect();
      mql?.removeEventListener?.('change', onReducedMotionChange);
      delete listEl.dataset.dock;
    },
  };
}
