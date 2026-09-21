// The enlarged view (design spec v2 §D/§E, design/MOTION_SPEC.md) — the
// sidebar expanding into a note viewer/editor. Driven through the real
// sidebar.ts (it lends the view its shadow root and list), the same way
// content.ts drives it, with jest.fn() stand-ins for the chrome.runtime
// round trips. jsdom has no WAAPI, layout, rAF clock or matchMedia, so each
// is mocked where a test needs it: Element.prototype.animate records calls,
// getBoundingClientRect is stubbed per list thumbnail, and matchMedia
// reports reduced motion on demand.

import * as sidebar from '../sidebar';
import { FeedbackItem } from '../types';
import {
  computeEnlargedGeometry,
  EMPTY_NOTE_MESSAGE,
  SAVE_ERROR_MESSAGE,
  DELETE_ERROR_MESSAGE,
  saveErrorFor,
  T,
  EnlargedViewCallbacks,
} from '../enlargedView';
import { containFit, cubicBezier, morphKeyframes, STD } from '../flip';

const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

function makeItem(id: number, note = `note ${id}`): FeedbackItem {
  return {
    id,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 200, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: `key-${id}`,
    thumbnailDataUrl: `data:image/jpeg;base64,THUMB${id}`,
    context: {
      primaryTarget: { cssSelector: 'div', xpath: '/html/body/div', outerHtmlSnippet: '<div></div>', truncated: false },
      containedElements: [],
      areaText: '',
      pageMeta: {
        url: 'https://example.com/page',
        normalisedUrl: 'https://example.com/page',
        title: 'example',
        viewport: { width: 1280, height: 800 },
        dpr: 1,
        selectionRect: { x: 0, y: 0, width: 200, height: 100 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

interface AnimCall {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: jest.Mock;
}
let animCalls: AnimCall[] = [];
let reducedMotion = false;

function installAnimateMock(): void {
  animCalls = [];
  (Element.prototype as any).animate = function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const cancel = jest.fn();
    animCalls.push({ el: this as Element, keyframes, options, cancel });
    return { cancel, finished: Promise.resolve(), currentTime: 0 } as unknown as Animation;
  };
}

function installMatchMedia(): void {
  (window as any).matchMedia = jest.fn((q: string) => ({
    matches: reducedMotion && q.includes('reduce'),
    media: q,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
  }));
}

function makeCallbacks(overrides: Partial<EnlargedViewCallbacks> = {}) {
  return {
    fetchFullImage: jest.fn().mockResolvedValue(null),
    onSaveNote: jest.fn().mockResolvedValue(true),
    onDelete: jest.fn().mockResolvedValue(true),
    onClosed: jest.fn(),
    ...overrides,
  };
}

function shadow(): ShadowRoot {
  return document.getElementById('annotator-sidebar-host')!.shadowRoot!;
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => shadow().querySelector<T>(sel);
const wrapper = () => q('.enlarged');
const exitBtn = () => q<HTMLButtonElement>('.xp-exit')!;
const upBtn = () => q<HTMLButtonElement>('.xp-prev')!;
const downBtn = () => q<HTMLButtonElement>('.xp-next')!;
const textarea = () => q<HTMLTextAreaElement>('.xp-note-input')!;
const status = () => q<HTMLElement>('.xp-status')!;
const title = () => q('.xp-title')!.textContent;
const count = () => q('.xp-count')!.textContent;
const mainCard = () => q<HTMLButtonElement>('.xp-card.is-main');
const peek = (which: 'prev' | 'next') => q<HTMLButtonElement>(`.xp-card.is-${which}`);

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function keydown(target: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let items: FeedbackItem[];

function setup(n = 3): void {
  sidebar.initSidebar({
    onAdd: () => {},
    onExport: () => {},
    onImportFile: () => {},
    onClose: () => {},
    onOpenItem: () => {},
  });
  sidebar.openSidebar();
  items = Array.from({ length: n }, (_, i) => makeItem(i + 1));
  sidebar.setThumbnails(items);
}

function open(id: number, cbs = makeCallbacks()) {
  expect(sidebar.openEnlargedView(id, cbs)).toBe(true);
  return cbs;
}

function settleOpen(): void {
  jest.advanceTimersByTime(T.expandSettle);
}

beforeEach(() => {
  jest.useFakeTimers();
  reducedMotion = false;
  installMatchMedia();
  installAnimateMock();
});

afterEach(() => {
  sidebar.destroySidebar();
  jest.useRealTimers();
  delete (Element.prototype as any).animate;
  delete (window as any).matchMedia;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('geometry + flip math', () => {
  test('the 1440×900 reference reproduces the prototype slots exactly', () => {
    const g = computeEnlargedGeometry(1440, 900, 300);
    expect(g.panelW).toBe(1080);
    expect(g.main).toMatchObject({ x: 1440 - 209 - 720, y: 198, w: 720, h: 380, pad: 28 });
    expect(g.prev).toMatchObject({ x: 1440 - 149 - 540, y: -201, w: 540, h: 285 });
    expect(g.next).toMatchObject({ x: 1440 - 149 - 540, y: 762, w: 540, h: 285 });
    expect(g.railRight).toBe(149);
    expect(g.titleTop).toBe(152);
    expect(g.editorTop).toBe(594);
  });

  test('peeks stay 75% of main and everything fits a small viewport', () => {
    const g = computeEnlargedGeometry(700, 520, 300);
    expect(g.panelW).toBeGreaterThanOrEqual(300);
    expect(g.panelW).toBeLessThanOrEqual(700);
    expect(g.prev.w).toBe(Math.round(g.main.w * 0.75));
    expect(g.next.h).toBe(Math.round(g.main.h * 0.75));
    expect(g.main.x).toBeGreaterThanOrEqual(700 - g.panelW);
    expect(g.main.h).toBeGreaterThanOrEqual(100);
  });

  test('panel never narrower than the docked sidebar, never wider than the viewport', () => {
    expect(computeEnlargedGeometry(320, 600, 300).panelW).toBe(320);
    expect(computeEnlargedGeometry(2560, 1440, 300).panelW).toBe(1920);
  });

  test('cubic-bezier solver hits its endpoints and std is ease-out-ish', () => {
    const e = cubicBezier(0.2, 0, 0, 1);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(e(0.5)).toBeGreaterThan(0.8);
  });

  test('containFit letterboxes without distortion', () => {
    expect(containFit(2, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  test('morph keyframes start on First and end at identity, image scale uniform on screen', () => {
    const from = { x: 1100, y: 150, w: 267, h: 100, pad: 0, imgR: 0 };
    const to = { x: 511, y: 198, w: 720, h: 380, pad: 28, imgR: 6 };
    const kf = morphKeyframes(from, to, 2, STD.fn, 10, 10);
    expect(kf.frame[0].transform).toBe(`translate(589px, -48px) scale(${Math.round((267 / 720) * 1e5) / 1e5}, ${Math.round((100 / 380) * 1e5) / 1e5})`);
    expect(kf.frame[10].transform).toBe('translate(0px, 0px) scale(1, 1)');
    expect(kf.img[10].transform).toBe('translate(0px, 0px) scale(1, 1)');
    // On-screen image scale = child scale × frame scale must be equal on x/y.
    const parse = (t: string) => t.match(/scale\(([^,]+), ([^)]+)\)/)!.slice(1).map(Number);
    for (let i = 0; i <= 10; i++) {
      const [fx, fy] = parse(kf.frame[i].transform as string);
      const [ix, iy] = parse(kf.img[i].transform as string);
      expect(fx * ix).toBeCloseTo(fy * iy, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// Open / collapse
// ---------------------------------------------------------------------------

describe('open and collapse', () => {
  test('opens inside the sidebar shadow root on the clicked note, then focuses x', () => {
    setup(3);
    open(2);
    expect(sidebar.isEnlargedViewOpen()).toBe(true);
    expect(wrapper()!.getAttribute('data-state')).toBe('opening');
    expect(wrapper()!.getAttribute('role')).toBe('dialog');
    expect(shadow().querySelectorAll('style')).toHaveLength(1);
    expect(title()).toBe('feedback #2');
    expect(count()).toBe('2 / 3');
    expect(textarea().value).toBe('note 2');
    expect(peek('prev')!.getAttribute('aria-label')).toBe('previous note: feedback #1');
    expect(peek('next')!.getAttribute('aria-label')).toBe('next note: feedback #3');
    expect(mainCard()!.querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB2');
    const sb = q('.sidebar')!;
    expect(sb.classList.contains('is-expanded')).toBe(true);

    settleOpen();
    expect(wrapper()!.getAttribute('data-state')).toBe('open');
    expect(sb.hasAttribute('inert')).toBe(true);
    expect(shadow().activeElement).toBe(exitBtn());
  });

  test('swaps in the full-resolution image when it arrives', async () => {
    setup(1);
    const cbs = open(1, makeCallbacks({ fetchFullImage: jest.fn().mockResolvedValue('data:image/png;base64,FULL1') }));
    await flush();
    expect(cbs.fetchFullImage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(mainCard()!.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,FULL1');
  });

  test('a stale full-image fetch never lands on a different note', async () => {
    setup(2);
    let resolveFirst!: (v: string) => void;
    const fetchFullImage = jest
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (resolveFirst = r)))
      .mockResolvedValue(null);
    open(1, makeCallbacks({ fetchFullImage }));
    settleOpen();
    downBtn().click(); // note 2 is main now
    jest.advanceTimersByTime(T.carousel);
    resolveFirst('data:image/png;base64,FULL1');
    await flush();
    expect(mainCard()!.dataset.itemId).toBe('2');
    expect(mainCard()!.querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB2');
    expect(peek('prev')!.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,FULL1');
  });

  test('x collapses after the collapse timeline, restores the list and returns focus', () => {
    setup(3);
    const cbs = open(2);
    settleOpen();
    exitBtn().click();
    expect(wrapper()!.getAttribute('data-state')).toBe('closing');
    expect(q('.sidebar')!.hasAttribute('inert')).toBe(false);
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    const sb = q('.sidebar')!;
    expect(sb.classList.contains('is-expanded')).toBe(false);
    expect(sb.classList.contains('is-brand-riding')).toBe(false);
    expect(sb.style.opacity).toBe('');
    expect(cbs.onClosed).toHaveBeenCalledWith(2);
    expect(shadow().activeElement).toBe(q('button.thumbnail[data-item-id="2"]'));
    for (const w of shadow().querySelectorAll<HTMLElement>('.thumbnail-image-wrap')) {
      expect(w.style.visibility).toBe('');
    }
  });

  test('Escape and a scrim click both collapse', () => {
    setup(2);
    const a = open(1);
    settleOpen();
    keydown(exitBtn(), 'Escape');
    jest.advanceTimersByTime(T.collapseSettle);
    expect(a.onClosed).toHaveBeenCalledTimes(1);

    const b = open(1);
    settleOpen();
    q('.xp-scrim')!.click();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(b.onClosed).toHaveBeenCalledTimes(1);
  });

  test('keyboard isolation: keys inside the view never reach the page', () => {
    setup(2);
    open(1);
    settleOpen();
    const pageListener = jest.fn();
    document.addEventListener('keydown', pageListener);
    keydown(textarea(), 'n');
    expect(pageListener).not.toHaveBeenCalled();
    document.removeEventListener('keydown', pageListener);
  });

  test('collapse during the expand reverses from the live panel width', () => {
    setup(2);
    open(1);
    const bg = q('.xp-bg')!;
    jest.advanceTimersByTime(100); // mid-expand
    animCalls = [];
    keydown(exitBtn(), 'Escape');
    const widthAnim = animCalls.find((c) => c.el === bg && 'width' in c.keyframes[0]);
    expect(widthAnim).toBeDefined();
    const fromW = parseFloat(String(widthAnim!.keyframes[0].width));
    const geo = computeEnlargedGeometry(window.innerWidth, window.innerHeight, sidebar.getSidebarWidth());
    expect(fromW).toBeGreaterThan(sidebar.getSidebarWidth());
    expect(fromW).toBeLessThan(geo.panelW);
    expect(widthAnim!.keyframes[1].width).toBe(`${sidebar.getSidebarWidth()}px`);
  });

  test('shared thumbnails morph (sampled transform FLIP) from their measured list rects', () => {
    setup(3);
    const wrap = shadow().querySelector<HTMLElement>('button.thumbnail[data-item-id="2"] .thumbnail-image-wrap')!;
    wrap.getBoundingClientRect = () =>
      ({ left: 740, top: 332, right: 1007, bottom: 432, width: 267, height: 100, x: 740, y: 332, toJSON() {} }) as DOMRect;
    open(2);
    expect(wrap.style.visibility).toBe('hidden');
    const frame = mainCard()!.querySelector('.xp-card-frame')!;
    const morph = animCalls.find((c) => c.el === frame);
    expect(morph).toBeDefined();
    expect(morph!.options.duration).toBe(T.expand);
    expect(morph!.options.easing).toBe('linear');
    expect(morph!.keyframes[0].transform).not.toBe('translate(0px, 0px) scale(1, 1)');
    expect(morph!.keyframes[morph!.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
    // Not measured (jsdom rect is 0×0) → neighbours fade in, never morph.
    const prevFrame = peek('prev')!.querySelector('.xp-card-frame')!;
    expect(animCalls.find((c) => c.el === prevFrame)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('navigation', () => {
  test('↓ / ↑ rail buttons carousel between notes, disabled at the ends', () => {
    setup(3);
    open(1);
    settleOpen();
    expect(upBtn().getAttribute('aria-disabled')).toBe('true');
    expect(peek('prev')).toBeNull();

    upBtn().click(); // no-op at the start
    expect(mainCard()!.dataset.itemId).toBe('1');

    downBtn().click();
    expect(mainCard()!.dataset.itemId).toBe('2');
    expect(title()).toBe('feedback #1'); // content crossfades: swapped at 120ms
    jest.advanceTimersByTime(T.contentOut);
    expect(title()).toBe('feedback #2');
    expect(count()).toBe('2 / 3');

    downBtn().click();
    jest.advanceTimersByTime(T.carousel);
    expect(mainCard()!.dataset.itemId).toBe('3');
    expect(downBtn().getAttribute('aria-disabled')).toBe('true');
    downBtn().click();
    jest.advanceTimersByTime(T.carousel);
    expect(mainCard()!.dataset.itemId).toBe('3');
  });

  test('rapid ↓↓ retargets instead of dropping the second press', () => {
    setup(4);
    open(1);
    settleOpen();
    downBtn().click();
    jest.advanceTimersByTime(50);
    downBtn().click();
    expect(mainCard()!.dataset.itemId).toBe('3');
    jest.advanceTimersByTime(T.carousel);
    expect(title()).toBe('feedback #3');
    // Only the three live cards remain once the retired ones have faded.
    expect(shadow().querySelectorAll('.xp-card')).toHaveLength(3);
  });

  test('clicking a peek navigates; ArrowUp/Down navigate unless typing', () => {
    setup(3);
    open(2);
    settleOpen();
    peek('next')!.click();
    expect(mainCard()!.dataset.itemId).toBe('3');
    jest.advanceTimersByTime(T.carousel);

    keydown(exitBtn(), 'ArrowUp');
    expect(mainCard()!.dataset.itemId).toBe('2');
    jest.advanceTimersByTime(T.carousel);

    textarea().focus();
    keydown(textarea(), 'ArrowDown');
    expect(mainCard()!.dataset.itemId).toBe('2');
  });

  test('Tab order: rail, peeks, editor, delete — wrapping', () => {
    setup(3);
    open(2);
    settleOpen();
    const order: Element[] = [];
    for (let i = 0; i < 8; i++) {
      order.push(shadow().activeElement!);
      keydown(shadow().activeElement!, 'Tab');
    }
    expect(order).toEqual([
      exitBtn(),
      upBtn(),
      downBtn(),
      peek('prev'),
      peek('next'),
      textarea(),
      q('.xp-delete'),
      exitBtn(),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

describe('autosave', () => {
  test('debounces 700ms, then shows the transient ✓ saved hint', async () => {
    setup(1);
    const cbs = open(1);
    settleOpen();
    typeInto(textarea(), 'edited');
    jest.advanceTimersByTime(T.autosave - 1);
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'edited');
    await flush();
    expect(status().dataset.kind).toBe('saved');
    expect(status().textContent).toContain('saved');
    expect(status().style.opacity).toBe('1');
    jest.advanceTimersByTime(T.hintIn + T.hintHold);
    expect(status().style.opacity).toBe('0');
  });

  test('flushes immediately on navigation and on collapse', () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    typeInto(textarea(), 'first edit');
    downBtn().click();
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'first edit');
    jest.advanceTimersByTime(T.carousel);
    typeInto(textarea(), 'second edit');
    exitBtn().click();
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'second edit');
    expect(cbs.onSaveNote).toHaveBeenCalledTimes(2);
  });

  test('flushes on blur', () => {
    setup(1);
    const cbs = open(1);
    settleOpen();
    typeInto(textarea(), 'blurred');
    textarea().dispatchEvent(new Event('blur'));
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'blurred');
  });

  test('a failed save shows the inline error until the next edit', async () => {
    setup(1);
    open(1, makeCallbacks({ onSaveNote: jest.fn().mockResolvedValue(false) }));
    settleOpen();
    typeInto(textarea(), 'nope');
    jest.advanceTimersByTime(T.autosave);
    await flush();
    expect(status().textContent).toBe(SAVE_ERROR_MESSAGE);
    expect(status().classList.contains('is-danger')).toBe(true);
    jest.advanceTimersByTime(5000);
    expect(status().style.opacity).toBe('1'); // no auto-hide
    typeInto(textarea(), 'nope!');
    expect(status().style.opacity).toBe('0');
  });

  test('a save failing after the note left the screen surfaces in the sidebar banner', async () => {
    setup(2);
    open(1, makeCallbacks({ onSaveNote: jest.fn().mockResolvedValue(false) }));
    settleOpen();
    typeInto(textarea(), 'edit');
    exitBtn().click();
    jest.advanceTimersByTime(T.collapseSettle);
    await flush();
    expect(q('.notif-text')!.textContent).toBe(saveErrorFor(1));
  });
});

// ---------------------------------------------------------------------------
// "A note can never be empty"
// ---------------------------------------------------------------------------

describe('empty-note lock', () => {
  function emptyNote() {
    setup(3);
    const cbs = open(2);
    settleOpen();
    typeInto(textarea(), '   ');
    jest.advanceTimersByTime(T.autosave * 2);
    return cbs;
  }

  function expectBlocked(cbs: ReturnType<typeof makeCallbacks>) {
    expect(mainCard()!.dataset.itemId).toBe('2');
    expect(sidebar.isEnlargedViewOpen()).toBe(true);
    expect(wrapper()!.getAttribute('data-state')).toBe('open');
    expect(textarea().classList.contains('is-error')).toBe(true);
    expect(status().textContent).toBe(EMPTY_NOTE_MESSAGE);
    expect(shadow().activeElement).toBe(textarea());
    expect(cbs.onClosed).not.toHaveBeenCalled();
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
  }

  test('never autosaves an empty value', () => {
    const cbs = emptyNote();
    textarea().dispatchEvent(new Event('blur'));
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
  });

  test.each([
    ['↓ button', () => downBtn().click()],
    ['↑ button', () => upBtn().click()],
    ['next peek', () => peek('next')!.click()],
    ['prev peek', () => peek('prev')!.click()],
    ['ArrowDown', () => keydown(exitBtn(), 'ArrowDown')],
    ['x', () => exitBtn().click()],
    ['Escape', () => keydown(textarea(), 'Escape')],
    ['scrim', () => q('.xp-scrim')!.click()],
    ['sidebar close (collapseEnlargedView)', () => expect(sidebar.collapseEnlargedView({ immediate: true })).toBe(false)],
  ])('blocks leaving via %s', (_name, act) => {
    const cbs = emptyNote();
    exitBtn().focus();
    act();
    jest.advanceTimersByTime(T.collapseSettle + T.carousel);
    expectBlocked(cbs);
  });

  test('shakes once (first blocked attempt only) and clears as soon as text is typed', () => {
    emptyNote();
    animCalls = [];
    downBtn().click();
    downBtn().click();
    const shakes = animCalls.filter((c) => c.el === textarea());
    expect(shakes).toHaveLength(1);
    typeInto(textarea(), 'x');
    expect(textarea().classList.contains('is-error')).toBe(false);
    expect(status().style.opacity).toBe('0');
    downBtn().click();
    expect(mainCard()!.dataset.itemId).toBe('3');
  });

  test('delete is still allowed', async () => {
    const cbs = emptyNote();
    q<HTMLButtonElement>('.xp-delete')!.click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(cbs.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(mainCard()!.dataset.itemId).toBe('3');
  });

  test('forced close (add mode / navigation) still gets out, keeping the stored text', () => {
    const cbs = emptyNote();
    sidebar.collapseEnlargedView({ immediate: true, force: true });
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
    expect(cbs.onClosed).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  async function del() {
    q<HTMLButtonElement>('.xp-delete')!.click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
  }

  test('middle note: carousels to the next one', async () => {
    setup(3);
    const cbs = open(2);
    settleOpen();
    await del();
    expect(cbs.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(mainCard()!.dataset.itemId).toBe('3');
    expect(title()).toBe('feedback #3');
    expect(count()).toBe('2 / 2');
    expect(shadow().querySelector('.xp-card[data-item-id="2"]')).toBeNull();
  });

  test('last note: moves to the previous one', async () => {
    setup(3);
    open(3);
    settleOpen();
    await del();
    expect(mainCard()!.dataset.itemId).toBe('2');
    expect(count()).toBe('2 / 2');
  });

  test('the only note: collapses back to the (now empty) list', async () => {
    setup(1);
    const cbs = open(1);
    settleOpen();
    await del();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    expect(cbs.onClosed).toHaveBeenCalledWith(null);
    expect(q<HTMLElement>('.empty-state')!.hidden).toBe(false);
  });

  test('a failed delete restores the note with an inline error', async () => {
    setup(2);
    open(1, makeCallbacks({ onDelete: jest.fn().mockResolvedValue(false) }));
    settleOpen();
    await del();
    expect(mainCard()!.dataset.itemId).toBe('1');
    expect(status().textContent).toBe(DELETE_ERROR_MESSAGE);
  });

  test('collapse requested mid-delete runs once the delete settles', async () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    q<HTMLButtonElement>('.xp-delete')!.click();
    keydown(exitBtn(), 'Escape');
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onClosed).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// Reduced motion, repaint deferral, teardown
// ---------------------------------------------------------------------------

describe('reduced motion', () => {
  test('no card ever travels; geometry jumps and only opacity animates', () => {
    reducedMotion = true;
    installMatchMedia();
    setup(3);
    const wrap = shadow().querySelector<HTMLElement>('button.thumbnail[data-item-id="2"] .thumbnail-image-wrap')!;
    wrap.getBoundingClientRect = () =>
      ({ left: 740, top: 332, right: 1007, bottom: 432, width: 267, height: 100, x: 740, y: 332, toJSON() {} }) as DOMRect;
    open(2);
    downBtn().click();
    jest.advanceTimersByTime(T.rdSwapAt);
    expect(mainCard()!.dataset.itemId).toBe('3');
    for (const c of animCalls) {
      for (const k of c.keyframes) {
        expect(k.transform).toBeUndefined();
        expect(k.width).toBeUndefined();
      }
    }
    exitBtn().click();
    jest.advanceTimersByTime(T.rdCollapseSettle);
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
  });
});

describe('lifecycle', () => {
  test('a list refresh while open is held off, then dropped on close (onClosed re-reads storage)', () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    // A refresh that started before the view's delete still lists note 2.
    sidebar.setThumbnails([makeItem(1), makeItem(2)]);
    expect(shadow().querySelectorAll('button.thumbnail')).toHaveLength(2);
    downBtn().click();
    jest.advanceTimersByTime(T.carousel);
    q<HTMLButtonElement>('.xp-delete')!.click();
    return (async () => {
      jest.advanceTimersByTime(T.deleteStep);
      await flush();
      sidebar.collapseEnlargedView({ immediate: true });
      // The deleted note doesn't flash back; focus stays where the view put it.
      const ids = [...shadow().querySelectorAll<HTMLElement>('button.thumbnail')].map((b) => b.dataset.itemId);
      expect(ids).toEqual(['1']);
      expect((shadow().activeElement as HTMLElement | null)?.dataset.itemId).toBe('1');
      expect(cbs.onClosed).toHaveBeenCalledWith(1);
    })();
  });

  test('closing the sidebar tears the view down', () => {
    setup(2);
    const cbs = open(1);
    sidebar.closeSidebar();
    expect(wrapper()).toBeNull();
    expect(cbs.onClosed).toHaveBeenCalled();
  });

  test('destroy leaves no DOM, timers or keyboard isolation behind', () => {
    setup(3);
    open(2);
    jest.advanceTimersByTime(50);
    sidebar.destroySidebar();
    expect(document.getElementById('annotator-sidebar-host')).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    const pageListener = jest.fn();
    document.addEventListener('keydown', pageListener);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pageListener).toHaveBeenCalled();
    document.removeEventListener('keydown', pageListener);
  });

  test('a viewport resize recomputes the geometry', () => {
    setup(2);
    open(1);
    settleOpen();
    const before = q('.xp-bg')!.style.width;
    const orig = window.innerWidth;
    (window as any).innerWidth = 900;
    window.dispatchEvent(new Event('resize'));
    jest.advanceTimersByTime(20); // coalesced into one frame
    expect(q('.xp-bg')!.style.width).not.toBe(before);
    (window as any).innerWidth = orig;
  });
});

// ---------------------------------------------------------------------------
// Review fixes: save failures, dedupe, unload flush, key leaks, focus, timers
// ---------------------------------------------------------------------------

/** onSaveNote whose replies the test settles by hand, in call order. */
function deferredSaves() {
  const pending: Array<(ok: boolean) => void> = [];
  const onSaveNote = jest.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
  return { onSaveNote, pending };
}

describe('save failures stay visible', () => {
  test('a failure for a note no longer shown lands in the view status slot, named, and is retried on the next flush', async () => {
    setup(2);
    const saves = deferredSaves();
    open(1, makeCallbacks({ onSaveNote: saves.onSaveNote }));
    settleOpen();
    typeInto(textarea(), 'edit one');
    downBtn().click(); // flush → note 1's save in flight
    jest.advanceTimersByTime(T.carousel);
    saves.pending[0](false);
    await flush();
    expect(status().dataset.kind).toBe('save-error');
    expect(status().textContent).toBe(saveErrorFor(1));
    expect(q('.notif')!.hidden).toBe(true); // not the invisible sidebar banner

    upBtn().click(); // next flush retries the failed note
    expect(saves.onSaveNote).toHaveBeenCalledTimes(2);
    expect(saves.onSaveNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), 'edit one');
  });

  test('a failure while collapsing never lands on the fading editor: the banner reports it once the list is back, and the list keeps the stored text', async () => {
    setup(1);
    const saves = deferredSaves();
    open(1, makeCallbacks({ onSaveNote: saves.onSaveNote }));
    settleOpen();
    typeInto(textarea(), 'unsaved');
    keydown(textarea(), 'Escape'); // flush + closing
    expect(wrapper()!.dataset.state).toBe('closing');
    saves.pending[0](false);
    await flush();
    expect(status().dataset.kind).not.toBe('save-error');
    jest.advanceTimersByTime(T.collapseSettle);
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    expect(q('.notif-text')!.textContent).toBe(saveErrorFor(1));
    expect(q('.thumbnail-note')!.textContent).toBe('note 1');
  });
});

describe('save dedupe', () => {
  test('blur then navigate sends the in-flight value once', () => {
    setup(2);
    const saves = deferredSaves();
    open(1, makeCallbacks({ onSaveNote: saves.onSaveNote }));
    settleOpen();
    typeInto(textarea(), 'once');
    textarea().dispatchEvent(new Event('blur'));
    downBtn().click();
    expect(saves.onSaveNote).toHaveBeenCalledTimes(1);
  });
});

describe('unload flush', () => {
  test('flushEnlargedView sends a pending edit immediately, and never an empty note', () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    typeInto(textarea(), 'typed just now');
    sidebar.flushEnlargedView();
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'typed just now');
    typeInto(textarea(), '  ');
    sidebar.flushEnlargedView();
    expect(cbs.onSaveNote).toHaveBeenCalledTimes(1);
  });
});

describe('Enter/Space isolation while the view is up', () => {
  test('activation keys aimed outside the view, or auto-repeating on its controls, are cancelled; the textarea keeps them', () => {
    setup(2);
    const onOpenItem = jest.fn();
    sidebar.initSidebar({ onAdd: () => {}, onExport: () => {}, onImportFile: () => {}, onClose: () => {}, onOpenItem });
    open(1);
    const listItem = shadow().querySelector<HTMLButtonElement>('button.thumbnail[data-item-id="1"]')!;
    expect(keydown(listItem, 'Enter').defaultPrevented).toBe(true);
    expect(keydown(listItem, ' ').defaultPrevented).toBe(true);
    // A native click that slips through anyway is ignored while opening/open.
    listItem.click();
    expect(onOpenItem).not.toHaveBeenCalled();
    settleOpen();

    const repeat = (el: Element, key: string) => {
      const e = new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, composed: true, cancelable: true });
      el.dispatchEvent(e);
      return e;
    };
    expect(repeat(exitBtn(), 'Enter').defaultPrevented).toBe(true);
    expect(keydown(exitBtn(), 'Enter').defaultPrevented).toBe(false);
    expect(repeat(textarea(), 'Enter').defaultPrevented).toBe(false);
    expect(repeat(textarea(), ' ').defaultPrevented).toBe(false);
    expect(sidebar.isEnlargedViewOpen()).toBe(true);
  });
});

describe('IME composition', () => {
  test('Esc that ends a composition does not collapse the view', () => {
    setup(1);
    open(1);
    settleOpen();
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, composed: true, cancelable: true }),
    );
    expect(wrapper()!.dataset.state).toBe('open');
    keydown(textarea(), 'Escape');
    expect(wrapper()!.dataset.state).toBe('closing');
  });
});

describe('delete edge cases', () => {
  test('deleting the only note returns focus to the "add note" button', async () => {
    setup(1);
    const cbs = open(1);
    settleOpen();
    q<HTMLButtonElement>('.xp-delete')!.click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onClosed).toHaveBeenCalledWith(null);
    // The action row's "add note" half (design spec v3 §A2 renamed it from
    // the old labelled .btn-primary).
    expect(shadow().activeElement).toBe(q('.btn-add'));
  });

  test('a delete during the expand does not strand the view in "opening"', async () => {
    setup(3);
    open(2);
    q<HTMLButtonElement>('.xp-delete')!.click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.expandSettle);
    expect(wrapper()!.dataset.state).toBe('open');
  });

  test('Esc while an emptied note is being deleted collapses after the delete, with no empty-note error', async () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    typeInto(textarea(), '');
    q<HTMLButtonElement>('.xp-delete')!.click();
    keydown(q('.xp-delete')!, 'Escape');
    expect(status().dataset.kind).not.toBe('empty-error');
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onClosed).toHaveBeenCalledWith(2);
  });
});

describe('empty-note error a11y', () => {
  test('the textarea is aria-invalid and described by the status while the error shows', () => {
    setup(2);
    open(1);
    settleOpen();
    typeInto(textarea(), '');
    downBtn().click();
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(textarea().getAttribute('aria-describedby')).toBe(status().id);
    typeInto(textarea(), 'fixed');
    expect(textarea().hasAttribute('aria-invalid')).toBe(false);
    expect(textarea().hasAttribute('aria-describedby')).toBe(false);
  });
});
