// src/dom.ts — the browser-environment helpers the content-script modules
// share. Each degrades where the API is missing (jsdom, a torn-down
// context); the fallbacks are what these pin.

import { getContentViewportSize, reducedMotionQuery, requestAnimationFrameSafe, cancelAnimationFrameSafe } from '../dom';

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
