// src/dom.ts — the browser-environment helpers the content-script modules
// share. Each degrades where the API is missing (jsdom, a torn-down
// context); the fallbacks are what these pin.

import {
  getContentViewportSize,
  reducedMotionQuery,
  requestAnimationFrameSafe,
  cancelAnimationFrameSafe,
  keyTargetWithin,
  pointTargetWithin,
} from '../dom';

describe('dom.ts — getContentViewportSize', () => {
  test('falls back to window.innerWidth/innerHeight where the document has no layout (jsdom)', () => {
    expect(document.documentElement.clientWidth).toBe(0);
    expect(getContentViewportSize()).toEqual({ width: window.innerWidth, height: window.innerHeight });
  });

  test('prefers documentElement.clientWidth/clientHeight (the scrollbar-excluded viewport) once the page has layout', () => {
    const de = document.documentElement as HTMLElement & { clientWidth: number; clientHeight: number };
    Object.defineProperty(de, 'clientWidth', { value: 1265, configurable: true });
    Object.defineProperty(de, 'clientHeight', { value: 700, configurable: true });
    try {
      expect(getContentViewportSize()).toEqual({ width: 1265, height: 700 });
    } finally {
      delete (de as Partial<typeof de>).clientWidth;
      delete (de as Partial<typeof de>).clientHeight;
    }
  });
});

describe('dom.ts — reducedMotionQuery', () => {
  const original = window.matchMedia;

  afterEach(() => {
    if (original === undefined) delete (window as Partial<Window>).matchMedia;
    else window.matchMedia = original;
  });

  test('null where matchMedia is missing (jsdom)', () => {
    delete (window as Partial<Window>).matchMedia;
    expect(reducedMotionQuery()).toBeNull();
  });

  test('null where matchMedia throws (a torn-down context)', () => {
    window.matchMedia = (() => {
      throw new Error('gone');
    }) as typeof window.matchMedia;
    expect(reducedMotionQuery()).toBeNull();
  });

  test('the live MediaQueryList for prefers-reduced-motion where it exists', () => {
    const mql = { matches: true, media: '(prefers-reduced-motion: reduce)' } as MediaQueryList;
    const fake = jest.fn(() => mql);
    window.matchMedia = fake as unknown as typeof window.matchMedia;
    expect(reducedMotionQuery()).toBe(mql);
    expect(fake).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });
});

describe('dom.ts — requestAnimationFrameSafe', () => {
  const originalRaf = window.requestAnimationFrame;
  const originalCaf = window.cancelAnimationFrame;

  afterEach(() => {
    jest.useRealTimers();
    if (originalRaf === undefined) delete (window as Partial<Window>).requestAnimationFrame;
    else window.requestAnimationFrame = originalRaf;
    if (originalCaf === undefined) delete (window as Partial<Window>).cancelAnimationFrame;
    else window.cancelAnimationFrame = originalCaf;
  });

  test('falls back to a 16ms timeout where the frame clock is missing, and the cancel clears it', () => {
    jest.useFakeTimers();
    // The frame clock comes and goes as a pair (a real window has both or
    // neither); fake timers install both, so both are removed here.
    delete (window as Partial<Window>).requestAnimationFrame;
    delete (window as Partial<Window>).cancelAnimationFrame;
    const cb = jest.fn();
    const id = requestAnimationFrameSafe(cb);
    jest.advanceTimersByTime(15);
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    const cancelled = jest.fn();
    cancelAnimationFrameSafe(requestAnimationFrameSafe(cancelled));
    jest.advanceTimersByTime(20);
    expect(cancelled).not.toHaveBeenCalled();
    expect(typeof id).toBe('number');
  });

  test('uses the real frame clock when the window has one (checked per call, not once)', () => {
    const raf = jest.fn(() => 42);
    window.requestAnimationFrame = raf as unknown as typeof window.requestAnimationFrame;
    const cb = (): void => {};
    expect(requestAnimationFrameSafe(cb)).toBe(42);
    expect(raf).toHaveBeenCalledWith(cb);
  });
});

describe('dom.ts — the real target of an event, seen from window (keyTargetWithin / pointTargetWithin)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** Dispatch `e` at `target` and hand back what the helper saw from a
   *  window capture listener — where the real callers sit. */
  function seenFromWindow<T>(target: EventTarget, e: Event, read: (e: Event) => T): T {
    let seen: T | undefined;
    const listener = (ev: Event): void => {
      seen = read(ev);
    };
    window.addEventListener(e.type, listener, true);
    try {
      target.dispatchEvent(e);
    } finally {
      window.removeEventListener(e.type, listener, true);
    }
    return seen as T;
  }

  function mount(mode: 'open' | 'closed'): { host: HTMLElement; root: ShadowRoot; input: HTMLTextAreaElement } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode });
    const input = document.createElement('textarea');
    root.appendChild(input);
    return { host, root, input };
  }

  test('open root: the key\'s own target, straight from the composed path', () => {
    const { host, root, input } = mount('open');
    const other = document.createElement('button');
    root.appendChild(other);
    other.focus(); // focus elsewhere: the path wins, not activeElement
    const t = seenFromWindow(input, new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }), (e) =>
      keyTargetWithin(e, host, root),
    );
    expect(t).toBe(input);
  });

  test('closed root: the path stops at the host, so the key goes to the root\'s focused element', () => {
    const { host, root, input } = mount('closed');
    input.focus();
    const t = seenFromWindow(input, new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }), (e) => {
      expect(e.composedPath()[0]).toBe(host);
      return keyTargetWithin(e, host, root);
    });
    expect(t).toBe(input);
  });

  test('outside the host: the page\'s own target, untouched', () => {
    const { host, root } = mount('closed');
    const page = document.createElement('input');
    document.body.appendChild(page);
    const t = seenFromWindow(page, new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }), (e) =>
      keyTargetWithin(e, host, root),
    );
    expect(t).toBe(page);
  });

  test('pointer: open root uses the path; closed root hit-tests the root at the event\'s point', () => {
    const open = mount('open');
    const w1 = new MouseEvent('wheel', { bubbles: true, composed: true, clientX: 10, clientY: 20 });
    expect(seenFromWindow(open.input, w1, (e) => pointTargetWithin(e, open.host, open.root))).toBe(open.input);

    const closed = mount('closed');
    const hit = jest.fn(() => closed.input);
    (closed.root as unknown as { elementFromPoint: typeof hit }).elementFromPoint = hit;
    const w2 = new MouseEvent('wheel', { bubbles: true, composed: true, clientX: 10, clientY: 20 });
    expect(seenFromWindow(closed.input, w2, (e) => pointTargetWithin(e, closed.host, closed.root))).toBe(closed.input);
    expect(hit).toHaveBeenCalledWith(10, 20);
  });

  test('pointer, closed root: no position, or no hit-testing (jsdom), gives null', () => {
    const { host, root, input } = mount('closed');
    const noPoint = new Event('wheel', { bubbles: true, composed: true });
    const hasHitTest = typeof (root as unknown as { elementFromPoint?: unknown }).elementFromPoint === 'function';
    expect(seenFromWindow(input, noPoint, (e) => pointTargetWithin(e, host, root))).toBeNull();
    if (!hasHitTest) {
      const w = new MouseEvent('wheel', { bubbles: true, composed: true, clientX: 1, clientY: 1 });
      expect(seenFromWindow(input, w, (e) => pointTargetWithin(e, host, root))).toBeNull();
    }
  });
});
