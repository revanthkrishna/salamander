// Dock magnification (design spec §4) — src/dockMotion.ts.
//
// The pure maths (falloff, targets, spring integration, rest detection,
// nudges) is tested directly. The DOM controller is tested under jsdom with
// a hand-driven requestAnimationFrame queue and mocked getBoundingClientRect
// — jsdom has no layout — so these check the mechanism (what gets written
// where, when the loop sleeps, what teardown releases), not how it looks.
// How it *feels* is a manual check in a real browser.

import {
  attachDockMotion,
  computeNudges,
  computeTargets,
  DOCK_SCALE_GAIN,
  falloff,
  isAtRest,
  NOTE_BG_THRESHOLD,
  noteTargetIndex,
  SPRING_RELEASE,
  SPRING_TRACK,
  SpringParams,
  SpringState,
  stepSpring,
} from '../dockMotion';

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

describe('falloff', () => {
  it('is 1 at the centre, 0 at and beyond the radius, symmetric', () => {
    expect(falloff(0, 300)).toBeCloseTo(1);
    expect(falloff(300, 300)).toBe(0);
    expect(falloff(450, 300)).toBe(0);
    expect(falloff(-120, 300)).toBeCloseTo(falloff(120, 300));
  });

  it('decreases monotonically and smoothly (no step anywhere in the swell)', () => {
    let prev = falloff(0, 300);
    for (let d = 1; d <= 300; d++) {
      const v = falloff(d, 300);
      expect(v).toBeLessThanOrEqual(prev);
      // A 1px pointer move never changes influence by more than π/(2·300).
      expect(prev - v).toBeLessThan(Math.PI / 600 + 1e-9);
      prev = v;
    }
  });

  it('returns 0 for a degenerate radius', () => {
    expect(falloff(0, 0)).toBe(0);
    expect(falloff(0, NaN)).toBe(0);
  });
});

describe('computeTargets / noteTargetIndex', () => {
  const centres = [85, 271, 457, 643]; // 170px items, 16px gap

  it('peaks on the item under the pointer with ~1.03–1.05 scale on direct neighbours', () => {
    const t = computeTargets(271, centres, 1.75 * 170);
    expect(t[1]).toBeCloseTo(1);
    const neighbourScale = 1 + DOCK_SCALE_GAIN * t[0];
    expect(neighbourScale).toBeGreaterThan(1.02);
    expect(neighbourScale).toBeLessThan(1.05);
    expect(t[0]).toBeCloseTo(t[2]);
    expect(t[3]).toBe(0);
  });

  it('is all zero with no focal point', () => {
    expect(computeTargets(null, centres, 300)).toEqual([0, 0, 0, 0]);
  });

  it('lights exactly one note: the most-influenced item, once past the threshold', () => {
    expect(noteTargetIndex([0.3, 0.95, 0.3])).toBe(1);
    expect(noteTargetIndex([0.7, 0.72, 0.1])).toBe(1);
    expect(noteTargetIndex([0.2, NOTE_BG_THRESHOLD - 0.01, 0.2])).toBe(-1);
    expect(noteTargetIndex([])).toBe(-1);
  });
});

function simulate(p: SpringParams, target: number, fps: number, seconds: number, from: SpringState = { x: 0, v: 0 }): SpringState {
  let s = from;
  const dt = 1 / fps;
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) s = stepSpring(s, target, dt, p);
  return s;
}

describe('stepSpring', () => {
  it.each([
    ['tracking', SPRING_TRACK],
    ['release', SPRING_RELEASE],
  ])('%s spring converges to its target within ~400ms', (_name, p) => {
    const s = simulate(p, 1, 120, 0.4);
    expect(s.x).toBeCloseTo(1, 2);
    expect(isAtRest(simulate(p, 1, 120, 0.6), 1)).toBe(true);
  });

  it('starts from rest with zero velocity (ramps in rather than jumping)', () => {
    const first = stepSpring({ x: 0, v: 0 }, 1, 1 / 60, SPRING_TRACK);
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(0.15);
  });

  it('is frame-rate independent: 30, 60, 120 and 240Hz trace the same curve', () => {
    for (const p of [SPRING_TRACK, SPRING_RELEASE]) {
      for (const at of [0.1, 0.2, 0.3]) {
        const ref = simulate(p, 1, 240, at);
        for (const fps of [30, 60, 120]) {
          const s = simulate(p, 1, fps, at);
          expect(s.x).toBeCloseTo(ref.x, 6);
          expect(s.v).toBeCloseTo(ref.v, 5);
        }
      }
    }
  });

  it('never meaningfully overshoots (subtle, not bouncy)', () => {
    let s: SpringState = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 200; i++) {
      s = stepSpring(s, 1, 1 / 120, SPRING_TRACK);
      max = Math.max(max, s.x);
    }
    expect(max).toBeLessThan(1.005);
  });

  it('stays stable for a huge dt and is a no-op for dt <= 0', () => {
    const s = stepSpring({ x: 0, v: 5 }, 1, 10, SPRING_TRACK);
    expect(s.x).toBeCloseTo(1, 6);
    expect(stepSpring({ x: 0.3, v: 2 }, 1, 0, SPRING_TRACK)).toEqual({ x: 0.3, v: 2 });
  });

  it('retargets continuously from a moving state (velocity carries over)', () => {
    const moving = simulate(SPRING_TRACK, 1, 60, 0.05);
    expect(moving.v).toBeGreaterThan(0);
    const next = stepSpring(moving, 0, 1 / 60, SPRING_TRACK);
    // Still moving up for a moment on its own momentum, no jump.
    expect(Math.abs(next.x - moving.x)).toBeLessThan(0.1);
  });
});

describe('isAtRest', () => {
  it('needs both position and velocity near zero', () => {
    expect(isAtRest({ x: 1.0001, v: 0.001 }, 1)).toBe(true);
    expect(isAtRest({ x: 1, v: 0.5 }, 1)).toBe(false);
    expect(isAtRest({ x: 0.9, v: 0 }, 1)).toBe(false);
  });
});

describe('computeNudges', () => {
  it('pushes neighbours away from a magnified item and leaves it put when flanked symmetrically', () => {
    const dy = computeNudges([0.3, 1, 0.3], [170, 170, 170]);
    expect(dy[0]).toBeLessThan(0);
    expect(dy[2]).toBeGreaterThan(0);
    expect(dy[1]).toBeCloseTo(0);
    // Subtle: well under the 16px list gap.
    expect(Math.abs(dy[0])).toBeLessThan(8);
  });

  it('is zero at rest, and items outside the swell stay still', () => {
    expect(computeNudges([0, 0, 0], [170, 170, 170])).toEqual([0, 0, 0]);
    const dy = computeNudges([1, 0.3, 0, 0], [170, 170, 170, 170]);
    expect(dy[1]).toBeGreaterThan(0);
    expect(dy[2]).toBe(0);
    expect(dy[3]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DOM controller
// ---------------------------------------------------------------------------

const ITEM_H = 170;
const GAP = 16;
const LIST_TOP = 100;

let rafQueue: Map<number, FrameRequestCallback>;
let rafNext: number;
let now: number;
let reducedMql: { matches: boolean; listeners: Set<() => void>; addEventListener: jest.Mock; removeEventListener: jest.Mock };

function flushFrame(stepMs = 16): void {
  now += stepMs;
  const cbs = Array.from(rafQueue.values());
  rafQueue.clear();
  for (const cb of cbs) cb(now);
}

function runFrames(n: number, stepMs = 16): void {
  for (let i = 0; i < n && rafQueue.size > 0; i++) flushFrame(stepMs);
}

function makeList(count: number): { list: HTMLUListElement; scroller: HTMLDivElement } {
  const scroller = document.createElement('div');
  const list = document.createElement('ul');
  list.getBoundingClientRect = () => ({ top: LIST_TOP, bottom: LIST_TOP + 1000, left: 0, right: 300, width: 300, height: 1000, x: 0, y: LIST_TOP, toJSON() {} }) as DOMRect;
  for (let i = 0; i < count; i++) {
    const li = document.createElement('li');
    li.className = 'thumbnail-item';
    const btn = document.createElement('button');
    btn.className = 'thumbnail';
    const bg = document.createElement('span');
    bg.className = 'thumbnail-note-bg';
    btn.appendChild(bg);
    li.appendChild(btn);
    // The item's hover delete (design spec v4 §L): a sibling of the
    // thumbnail button inside the <li>, faded on the same spring as the
    // note background.
    const del = document.createElement('button');
    del.className = 'thumbnail-delete';
    li.appendChild(del);
    const top = LIST_TOP + i * (ITEM_H + GAP);
    // Untransformed layout box (as a real browser would report with no
    // transform applied; the controller inverts its own transform anyway).
    li.getBoundingClientRect = () => ({ top, bottom: top + ITEM_H, left: 16, right: 284, width: 268, height: ITEM_H, x: 16, y: top, toJSON() {} }) as DOMRect;
    list.appendChild(li);
  }
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  return { list, scroller };
}

function pointer(el: Element, type: string, clientY: number): void {
  const e = new MouseEvent(type, { clientY, bubbles: type === 'pointermove' });
  el.dispatchEvent(e);
}

function scaleOf(li: HTMLElement): number {
  const m = /scale\(([\d.]+)\)/.exec(li.style.transform);
  return m ? parseFloat(m[1]) : 1;
}

beforeEach(() => {
  rafQueue = new Map();
  rafNext = 1;
  now = 0;
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = rafNext++;
    rafQueue.set(id, cb);
    return id;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    rafQueue.delete(id);
  });
  reducedMql = {
    matches: false,
    listeners: new Set(),
    addEventListener: jest.fn((_t: string, fn: () => void) => reducedMql.listeners.add(fn)),
    removeEventListener: jest.fn((_t: string, fn: () => void) => reducedMql.listeners.delete(fn)),
  };
  (window as any).matchMedia = jest.fn(() => reducedMql);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (window as any).matchMedia;
  document.body.innerHTML = '';
});

describe('attachDockMotion', () => {
  it('marks the list as motion-driven and does nothing until the pointer arrives', () => {
    const { list, scroller } = makeList(4);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    expect(list.dataset.dock).toBe('on');
    expect(rafQueue.size).toBe(0);
    for (const li of Array.from(list.children) as HTMLElement[]) expect(li.style.transform).toBe('');
    dock.destroy();
  });

  it('enter ramps items in smoothly, peaking on the hovered item', () => {
    const { list, scroller } = makeList(4);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const lis = Array.from(list.children) as HTMLElement[];
    const hoveredCentre = LIST_TOP + (ITEM_H + GAP) + ITEM_H / 2;

    pointer(list, 'pointerenter', hoveredCentre);
    expect(rafQueue.size).toBe(1);
    flushFrame();
    const firstFrame = scaleOf(lis[1]);
    expect(firstFrame).toBeGreaterThan(1);
    expect(firstFrame).toBeLessThan(1.03); // ramps, doesn't jump

    runFrames(60);
    expect(scaleOf(lis[1])).toBeCloseTo(1 + DOCK_SCALE_GAIN, 3);
    expect(lis[1].style.transform).toMatch(/translate3d\(-22\.0\d*px/);
    expect(scaleOf(lis[0])).toBeGreaterThan(1.02);
    expect(scaleOf(lis[0])).toBeLessThan(1.05);
    expect(lis[3].style.transform).toBe('');
    // z-order by influence, hovered on top.
    expect(Number(lis[1].style.zIndex)).toBeGreaterThan(Number(lis[0].style.zIndex));
    // Exactly one note background lit.
    const bgs = lis.map((li) => li.querySelector<HTMLElement>('.thumbnail-note-bg')!);
    expect(Number(bgs[1].style.opacity)).toBe(1);
    expect(bgs[0].style.opacity).toBe('');
    // The hover delete (§L) rides that same spring, so the two appear and go
    // together rather than on two different clocks.
    const dels = lis.map((li) => li.querySelector<HTMLElement>('.thumbnail-delete')!);
    expect(dels[1].style.opacity).toBe(bgs[1].style.opacity);
    expect(dels[0].style.opacity).toBe('');
    // Loop sleeps at rest and releases will-change.
    expect(rafQueue.size).toBe(0);
    expect(lis[1].style.willChange).toBe('');
    dock.destroy();
  });

  it('moving retargets continuously and leaving relaxes everything back to identity', () => {
    const { list, scroller } = makeList(4);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const lis = Array.from(list.children) as HTMLElement[];

    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    runFrames(60);
    expect(scaleOf(lis[0])).toBeCloseTo(1.12, 3);

    pointer(list, 'pointermove', LIST_TOP + 2 * (ITEM_H + GAP) + ITEM_H / 2);
    flushFrame();
    // Mid-transition: the old peak is shrinking, the new one growing.
    expect(scaleOf(lis[0])).toBeLessThan(1.12);
    expect(scaleOf(lis[0])).toBeGreaterThan(1.05);
    runFrames(60);
    expect(scaleOf(lis[2])).toBeCloseTo(1.12, 3);

    pointer(list, 'pointerleave', 0);
    flushFrame();
    expect(scaleOf(lis[2])).toBeGreaterThan(1.1); // relaxes, doesn't snap
    runFrames(120);
    for (const li of lis) {
      expect(li.style.transform).toBe('');
      expect(li.style.zIndex).toBe('');
      expect(li.querySelector<HTMLElement>('.thumbnail-note-bg')!.style.opacity).toBe('');
      // Cleared, not pinned to 0, so the plain CSS hover/focus states (and
      // the delete's own :focus-visible) take back over at rest.
      expect(li.querySelector<HTMLElement>('.thumbnail-delete')!.style.opacity).toBe('');
    }
    expect(rafQueue.size).toBe(0);
    dock.destroy();
  });

  it('is frame-rate independent end to end (30Hz and 120Hz agree)', () => {
    const results: number[] = [];
    for (const stepMs of [1000 / 30, 1000 / 120]) {
      const { list, scroller } = makeList(3);
      const dock = attachDockMotion(list, { scrollContainer: scroller });
      pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
      // First frame always uses a nominal dt; compare from there on.
      flushFrame(stepMs);
      const frames = Math.round(100 / stepMs);
      runFrames(frames, stepMs);
      results.push(scaleOf(list.children[0] as HTMLElement));
      dock.destroy();
      document.body.innerHTML = '';
    }
    expect(Math.abs(results[0] - results[1])).toBeLessThan(0.01);
  });

  it('keyboard focus magnifies the focused item; focus leaving the list relaxes it', () => {
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const lis = Array.from(list.children) as HTMLElement[];
    const btn = lis[2].querySelector('button')!;
    btn.focus();
    runFrames(60);
    expect(scaleOf(lis[2])).toBeCloseTo(1.12, 3);
    btn.blur();
    runFrames(120);
    expect(lis[2].style.transform).toBe('');
    dock.destroy();
  });

  it('does not swallow clicks', () => {
    const { list, scroller } = makeList(2);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const btn = list.querySelector('button')!;
    const onClick = jest.fn();
    btn.addEventListener('click', onClick);
    pointer(list, 'pointerenter', LIST_TOP + 10);
    runFrames(5);
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    dock.destroy();
  });

  it('prefers-reduced-motion: no transforms at all, CSS handles the note background', () => {
    reducedMql.matches = true;
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    expect(list.dataset.dock).toBeUndefined();
    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    pointer(list, 'pointermove', LIST_TOP + ITEM_H);
    list.querySelector('button')!.focus();
    expect(rafQueue.size).toBe(0);
    for (const li of Array.from(list.children) as HTMLElement[]) expect(li.style.transform).toBe('');
    dock.destroy();
  });

  it('reacts live to the reduced-motion setting changing', () => {
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const li0 = list.children[0] as HTMLElement;
    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    runFrames(10);
    expect(li0.style.transform).not.toBe('');

    reducedMql.matches = true;
    reducedMql.listeners.forEach((fn) => fn());
    expect(li0.style.transform).toBe('');
    expect(list.dataset.dock).toBeUndefined();
    expect(rafQueue.size).toBe(0);

    reducedMql.matches = false;
    reducedMql.listeners.forEach((fn) => fn());
    expect(list.dataset.dock).toBe('on');
    runFrames(60);
    // Pointer is still over the list, so the swell comes back.
    expect(scaleOf(li0)).toBeCloseTo(1.12, 3);
    dock.destroy();
  });

  it('re-reads the list position on scroll and retargets under a still pointer', () => {
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const lis = Array.from(list.children) as HTMLElement[];
    const y = LIST_TOP + ITEM_H / 2;
    pointer(list, 'pointerenter', y);
    runFrames(60);
    expect(scaleOf(lis[0])).toBeCloseTo(1.12, 3);

    // Scroll the list up by one item pitch: item 1 is now under the pointer.
    const pitch = ITEM_H + GAP;
    list.getBoundingClientRect = () => ({ top: LIST_TOP - pitch }) as DOMRect;
    scroller.dispatchEvent(new Event('scroll'));
    runFrames(60);
    expect(scaleOf(lis[1])).toBeCloseTo(1.12, 3);
    expect(scaleOf(lis[0])).toBeLessThan(1.05);
    dock.destroy();
  });

  it('measures untransformed layout even while items are transformed', () => {
    const { list, scroller } = makeList(3);
    const lis = Array.from(list.children) as HTMLElement[];
    // Simulate the browser reporting the *transformed* rect for item 0.
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    runFrames(60);
    const s = scaleOf(lis[0]);
    const origRect = lis[0].getBoundingClientRect();
    const dy = parseFloat(/translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(lis[0].style.transform)![1]);
    const cy = (origRect.top + origRect.bottom) / 2 + dy;
    lis[0].getBoundingClientRect = () => ({ top: cy - (ITEM_H * s) / 2, bottom: cy + (ITEM_H * s) / 2, height: ITEM_H * s }) as DOMRect;
    dock.refresh(); // forces a re-measure while magnified
    window.dispatchEvent(new Event('resize'));
    runFrames(60);
    // Still the same settled swell — no feedback drift from the transform.
    expect(scaleOf(lis[0])).toBeCloseTo(s, 4);
    dock.destroy();
  });

  it('teardown cancels the rAF, removes listeners and restores styles', () => {
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    const lis = Array.from(list.children) as HTMLElement[];
    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    flushFrame();
    expect(rafQueue.size).toBe(1);

    dock.destroy();
    expect(rafQueue.size).toBe(0);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(list.dataset.dock).toBeUndefined();
    for (const li of lis) {
      expect(li.style.transform).toBe('');
      expect(li.style.willChange).toBe('');
      expect(li.querySelector<HTMLElement>('.thumbnail-note-bg')!.style.opacity).toBe('');
      expect(li.querySelector<HTMLElement>('.thumbnail-delete')!.style.opacity).toBe('');
    }
    expect(reducedMql.removeEventListener).toHaveBeenCalled();

    // Listeners are gone: further pointer input schedules nothing.
    pointer(list, 'pointermove', LIST_TOP + 300);
    pointer(list, 'pointerenter', LIST_TOP + 300);
    scroller.dispatchEvent(new Event('scroll'));
    expect(rafQueue.size).toBe(0);
    dock.destroy(); // idempotent
  });
});

describe('attachDockMotion — suspension, bleed reporting and hold targets', () => {
  it('setSuspended(true) snaps a magnified list straight back to rest, with no release animation', () => {
    const { list, scroller } = makeList(4);
    const bleed = jest.fn();
    const dock = attachDockMotion(list, { scrollContainer: scroller, onBleedChange: bleed });
    const lis = Array.from(list.children) as HTMLElement[];

    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    runFrames(40);
    expect(scaleOf(lis[0])).toBeGreaterThan(1.1);
    expect(bleed).toHaveBeenLastCalledWith(true);

    dock.setSuspended(true);
    // Synchronously at identity — nothing left for a later frame to finish.
    expect(rafQueue.size).toBe(0);
    for (const li of lis) {
      expect(li.style.transform).toBe('');
      expect(li.style.zIndex).toBe('');
      expect(li.style.willChange).toBe('');
    }
    expect(bleed).toHaveBeenLastCalledWith(false);

    // Pointer input while suspended does nothing visible.
    pointer(list, 'pointermove', LIST_TOP + 300);
    list.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    expect(rafQueue.size).toBe(0);
    for (const li of lis) expect(li.style.transform).toBe('');

    // Resuming with the pointer still over the list swells back in from rest,
    // centred on where the pointer is *now*.
    dock.setSuspended(false);
    expect(rafQueue.size).toBe(1);
    runFrames(40);
    expect(scaleOf(lis[1])).toBeGreaterThan(scaleOf(lis[3]));
    expect(scaleOf(lis[1])).toBeGreaterThan(1.05);
    dock.destroy();
  });

  it('a list attached while suspended never magnifies until resumed', () => {
    const { list, scroller } = makeList(3);
    const dock = attachDockMotion(list, { scrollContainer: scroller });
    dock.setSuspended(true);
    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    pointer(list, 'pointermove', LIST_TOP + ITEM_H / 2 + 5);
    expect(rafQueue.size).toBe(0);
    pointer(list, 'pointerleave', LIST_TOP);
    dock.setSuspended(false);
    expect(rafQueue.size).toBe(0); // pointer is gone: nothing to swell for
    dock.destroy();
  });

  it('reports bleed on as the swell starts and off only once every item is back at identity', () => {
    const { list, scroller } = makeList(3);
    const bleed = jest.fn();
    const dock = attachDockMotion(list, { scrollContainer: scroller, onBleedChange: bleed });
    const lis = Array.from(list.children) as HTMLElement[];

    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    // Before the first transform is written.
    expect(bleed).toHaveBeenCalledTimes(1);
    expect(bleed).toHaveBeenLastCalledWith(true);

    runFrames(60); // settles magnified under a still pointer: still bleeding
    expect(rafQueue.size).toBe(0);
    expect(bleed).toHaveBeenCalledTimes(1);

    pointer(list, 'pointerleave', LIST_TOP);
    flushFrame();
    expect(bleed).toHaveBeenCalledTimes(1); // still relaxing
    runFrames(120);
    expect(rafQueue.size).toBe(0);
    for (const li of lis) expect(li.style.transform).toBe('');
    expect(bleed).toHaveBeenCalledTimes(2);
    expect(bleed).toHaveBeenLastCalledWith(false);

    dock.destroy();
    expect(bleed).toHaveBeenCalledTimes(2); // already off: no duplicate report
  });

  it('holds the swell while the pointer crosses a hold target, and releases once it leaves that too', () => {
    const { list, scroller } = makeList(3);
    const handle = document.createElement('div');
    document.body.appendChild(handle);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const dock = attachDockMotion(list, { scrollContainer: scroller, holdTargets: [handle] });
    const lis = Array.from(list.children) as HTMLElement[];

    const leave = (from: Element, to: Element | null) =>
      from.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: to }));

    pointer(list, 'pointerenter', LIST_TOP + ITEM_H / 2);
    runFrames(60);
    const peak = scaleOf(lis[0]);
    expect(peak).toBeGreaterThan(1.1);

    // List → handle: held exactly where it was.
    leave(list, handle);
    runFrames(30);
    expect(scaleOf(lis[0])).toBeCloseTo(peak, 4);

    // Handle → back onto the list: still magnified, no dip.
    leave(handle, lis[0]);
    runFrames(30);
    expect(scaleOf(lis[0])).toBeCloseTo(peak, 4);

    // List → handle → somewhere else: released.
    leave(list, handle);
    leave(handle, elsewhere);
    runFrames(120);
    for (const li of lis) expect(li.style.transform).toBe('');

    // Entering the handle from outside never starts magnification.
    handle.dispatchEvent(new MouseEvent('pointerenter', { clientY: LIST_TOP + ITEM_H / 2 }));
    leave(handle, elsewhere);
    expect(rafQueue.size).toBe(0);

    dock.destroy();
  });
});
