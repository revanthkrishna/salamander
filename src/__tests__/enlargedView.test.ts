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
  /** The panel's content area: its left edge, and the rail's left edge. */
  function contentSpan(g: ReturnType<typeof computeEnlargedGeometry>, vw: number) {
    return { left: vw - g.panelW, right: vw - g.railRight - 40 };
  }

  test('the 1440×900 reference keeps the prototype panel/rail insets and a 720px column', () => {
    // A selection larger than the panel can show: scaled down to the full
    // 720px content width, and the column takes that width (v4 §M).
    const g = computeEnlargedGeometry(1440, 900, 300, { w: 1440, h: 760 });
    expect(g.panelW).toBe(1080);
    expect(g.railRight).toBe(149);
    expect(g.main).toMatchObject({ w: 720, h: 380, pad: 0 });
    expect(g.columnW).toBe(720);
    expect(g.columnRight).toBe(1440 - (g.main.x + 720));
    // Peeks are 75% of the note in FOCUS, right edge flush with the rail's.
    expect(g.prev).toMatchObject({ x: 1440 - 149 - 540, w: 540, h: 285 });
    expect(g.next).toMatchObject({ x: 1440 - 149 - 540, w: 540, h: 285 });
    // Column (title + image + editor) centred vertically; the rail centred
    // on the panel independently of it (§M).
    const columnH = 46 + g.main.h + 16 + 144;
    expect(g.titleTop).toBe(Math.round((900 - columnH) / 2));
    expect(g.main.y).toBe(g.titleTop + 46);
    expect(g.editorTop).toBe(g.main.y + g.main.h + 16);
    expect(g.railTop).toBe(Math.round((900 - 144) / 2));
  });

  test('the column is centred between the panel edge and the rail, at every image size', () => {
    for (const nat of [{ w: 1440, h: 760 }, { w: 267, h: 100 }, { w: 80, h: 60 }, { w: 400, h: 2000 }]) {
      for (const [vw, vh] of [[1280, 900], [1440, 900], [700, 520]]) {
        const g = computeEnlargedGeometry(vw, vh, 300, nat);
        const { left, right } = contentSpan(g, vw);
        const gapLeft = g.main.x - left;
        const gapRight = right - (g.main.x + g.columnW);
        // Equal to within the odd pixel a rounded half-width leaves over.
        expect(Math.abs(gapLeft - gapRight)).toBeLessThanOrEqual(1);
        expect(gapLeft).toBeGreaterThanOrEqual(0);
        expect(gapRight).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('the 1280×900 repro: a default 267×100 selection sits in the middle of the panel', () => {
    const g = computeEnlargedGeometry(1280, 900, 300, { w: 267, h: 100 });
    const { left, right } = contentSpan(g, 1280);
    expect([left, right]).toEqual([320, 1108]); // panel edge → rail edge
    expect(g.columnW).toBe(267);
    expect(g.main).toMatchObject({ x: 581, y: 343, w: 267, h: 100 });
    // ...not jammed against the rail, where it used to land.
    expect(g.main.x).toBeLessThan(700);
  });

  test('everything fits a small viewport, and the peeks stay proportional', () => {
    const g = computeEnlargedGeometry(700, 520, 300, { w: 1200, h: 900 });
    expect(g.panelW).toBeGreaterThanOrEqual(300);
    expect(g.panelW).toBeLessThanOrEqual(700);
    expect(g.prev.w).toBe(g.next.w);
    expect(g.prev.h).toBe(g.next.h);
    expect(g.main.x).toBeGreaterThanOrEqual(700 - g.panelW);
    expect(g.main.w).toBeGreaterThan(0);
    expect(g.main.h).toBeGreaterThan(0);
    // Scaled down to fit, never up, and proportional.
    expect(g.main.w).toBeLessThanOrEqual(1200);
    expect(g.main.w / g.main.h).toBeCloseTo(1200 / 900, 1);
  });

  test('a peek is always smaller than the note in focus, at every size (§M)', () => {
    const sizes = [{ w: 1440, h: 760 }, { w: 3000, h: 1000 }, { w: 267, h: 100 }, { w: 80, h: 60 }, { w: 400, h: 2000 }];
    for (const nat of sizes) {
      for (const [vw, vh] of [[1280, 900], [1440, 900], [700, 520]]) {
        const g = computeEnlargedGeometry(vw, vh, 300, nat);
        for (const peek of [g.prev, g.next]) {
          expect(peek.w).toBeLessThan(g.main.w);
          expect(peek.h).toBeLessThan(g.main.h);
          // 75% in both dimensions = a pure uniform scale, so peek ↔ main
          // never changes shape and never letterboxes.
          expect(peek.w / g.main.w).toBeCloseTo(0.75, 1);
          expect(peek.w / peek.h).toBeCloseTo(g.main.w / g.main.h, 5);
          expect(peek.pad).toBe(0);
          // Right edge still flush with the rail's right edge (v2 §D).
          expect(peek.x + peek.w).toBe(vw - g.railRight);
        }
      }
    }
  });

  test('the rail does not move when the image size changes (§M)', () => {
    const wide = computeEnlargedGeometry(1440, 900, 300, { w: 1440, h: 760 });
    const tiny = computeEnlargedGeometry(1440, 900, 300, { w: 80, h: 60 });
    expect(tiny.railTop).toBe(wide.railTop);
    expect(tiny.railRight).toBe(wide.railRight);
    // The peeks now follow the image, by design — but stay rail-flush.
    expect(tiny.prev.x + tiny.prev.w).toBe(wide.prev.x + wide.prev.w);
  });

  test('panel never narrower than the docked sidebar, never wider than the viewport', () => {
    expect(computeEnlargedGeometry(320, 600, 300).panelW).toBe(320);
    expect(computeEnlargedGeometry(2560, 1440, 300).panelW).toBe(1920);
  });

  test('the image renders at the selection\'s own CSS size, never scaled up (§M)', () => {
    // 200×100 fits the 1440×900 panel many times over: shown 1:1, whatever
    // the PNG's pixel size (dpr) happens to be.
    const g = computeEnlargedGeometry(1440, 900, 300, { w: 200, h: 100 });
    expect(g.main.w).toBe(200);
    expect(g.main.h).toBe(100);
    // ...and no letterboxing: pad 0 means the contain-fit IS the slot.
    expect(g.main.pad).toBe(0);
    expect(containFit(200 / 100, { x: 0, y: 0, w: g.main.w, h: g.main.h })).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
    // The header bar / editor keep a usable width even so (§M's ~240 floor),
    // and the image sits at that column's left edge.
    expect(g.columnW).toBe(240);
    expect(g.main.x).toBe(1440 - g.columnRight - 240);
  });

  test('an over-tall selection is scaled down by height, keeping its aspect (§M)', () => {
    const g = computeEnlargedGeometry(1440, 900, 300, { w: 400, h: 2000 });
    expect(g.main.h).toBeLessThan(2000);
    expect(g.main.w / g.main.h).toBeCloseTo(400 / 2000, 2);
    // Still leaves room for the title row and the editor inside the viewport.
    expect(g.titleTop).toBeGreaterThanOrEqual(16);
    expect(g.editorTop + 144).toBeLessThanOrEqual(900);
    expect(g.columnW).toBe(Math.max(240, g.main.w));
  });

  test('a selection wider than the panel is scaled down by width (§M)', () => {
    const g = computeEnlargedGeometry(1440, 900, 300, { w: 3000, h: 1000 });
    expect(g.main.w).toBe(720); // the full content width
    expect(g.main.w / g.main.h).toBeCloseTo(3, 2);
    expect(g.columnW).toBe(g.main.w);
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
// Header bar + the image at its own size (design spec v4 §M)
// ---------------------------------------------------------------------------

describe('v4 §M — header bar and the image at its own size', () => {
  function geoFor(natural: { w: number; h: number }) {
    return computeEnlargedGeometry(window.innerWidth, window.innerHeight, sidebar.getSidebarWidth(), natural);
  }

  test('the "n / total" counter is gone', () => {
    setup(3);
    open(2);
    expect(q('.xp-count')).toBeNull();
    expect(q('.xp-head')!.textContent).toBe('feedback #2');
  });

  test('the title is never clipped: no overflow/ellipsis, and the bar has a min-width not a width', () => {
    setup(3);
    open(2);
    const head = q<HTMLElement>('.xp-head')!;
    const g = geoFor({ w: 200, h: 100 });
    expect(head.style.minWidth).toBe(`${g.columnW}px`);
    expect(head.style.width).toBe('auto');
    // The rules that were doing the clipping are gone from the stylesheet.
    const css = shadow().querySelector('style')!.textContent!;
    const titleRule = css.slice(css.indexOf('.xp-title {'), css.indexOf('.xp-title {') + 400);
    expect(titleRule).not.toMatch(/text-overflow/);
    expect(titleRule).not.toMatch(/overflow:\s*hidden/);
    expect(titleRule).not.toMatch(/min-width:\s*0/);
    expect(titleRule).toMatch(/white-space:\s*nowrap/);
  });

  test('the italic\'s left overhang has room, without moving the column\'s left edge', () => {
    setup(1);
    open(1);
    const css = shadow().querySelector('style')!.textContent!;
    const titleRule = css.slice(css.indexOf('.xp-title {'), css.indexOf('.xp-title {') + 400);
    // A padding/negative-margin pair of the same size: the box starts left of
    // the column edge so the 'f' can paint, the text origin stays on it.
    const pad = /padding:\s*0 0 0 (\d+)px/.exec(titleRule);
    const margin = /margin:\s*0 0 0 -(\d+)px/.exec(titleRule);
    expect(pad).not.toBeNull();
    expect(margin).not.toBeNull();
    expect(pad![1]).toBe(margin![1]);
    expect(Number(pad![1])).toBeGreaterThan(0);
    // ...and nothing on the header bar clips it.
    const headRule = css.slice(css.indexOf('.xp-head {'), css.indexOf('.xp-head {') + 400);
    expect(headRule).toMatch(/overflow:\s*visible/);
  });

  test('the header and the editor are anchored to the centred column, not to a fixed panel inset', () => {
    setup(1);
    open(1);
    const g = geoFor({ w: 200, h: 100 });
    expect(q<HTMLElement>('.xp-head')!.style.right).toBe(`${g.columnRight}px`);
    expect(q<HTMLElement>('.xp-editor')!.style.right).toBe(`${g.columnRight}px`);
    expect(q<HTMLElement>('.xp-rail')!.style.right).toBe(`${g.railRight}px`);
  });

  test('the peek card stays smaller than the main image after a carousel', () => {
    setup(2);
    items[1] = { ...items[1], selectionRect: { x: 0, y: 0, width: 400, height: 200 } };
    sidebar.setThumbnails(items);
    open(1);
    settleOpen();
    const sizeOf = (el: HTMLElement) => [parseFloat(el.style.width), parseFloat(el.style.height)];
    const [mw0, mh0] = sizeOf(mainCard()!);
    const [pw0, ph0] = sizeOf(peek('next')!);
    expect(pw0).toBeLessThan(mw0);
    expect(ph0).toBeLessThan(mh0);

    downBtn().click();
    jest.advanceTimersByTime(T.carousel);
    const [mw1, mh1] = sizeOf(mainCard()!);
    const [pw1, ph1] = sizeOf(peek('prev')!);
    expect([mw1, mh1]).toEqual([400, 200]);
    expect(pw1).toBeLessThan(mw1);
    expect(ph1).toBeLessThan(mh1);
  });

  test('delete is an icon button in the header bar, with the same behaviour', async () => {
    setup(2);
    const cbs = open(1);
    settleOpen();
    const del = q<HTMLButtonElement>('.xp-delete')!;
    expect(del.parentElement).toBe(q('.xp-head'));
    expect(del.getAttribute('aria-label')).toBe('delete note');
    expect(del.title).toBe('delete note');
    expect(del.textContent).toBe(''); // icon only
    expect(del.querySelector('svg')).not.toBeNull();
    // The editor's extension bar now holds only the status slot.
    expect(q('.xp-bar')!.children).toHaveLength(1);
    expect(q('.xp-bar')!.firstElementChild).toBe(status());

    del.click(); // no confirmation, exactly as before
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(cbs.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  test('the editor\'s extension bar carries the note\'s 1px line border, drawn inside (v4 §O)', () => {
    setup(1);
    open(1);
    const css = shadow().querySelector('style')!.textContent!;
    const bar = css.slice(css.indexOf('.xp-bar {'), css.indexOf('.xp-bar {') + 400);
    expect(bar).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sal-line\)/);
    // The status slot stays on the right now that it is the bar's only child.
    expect(bar).toMatch(/justify-content:\s*flex-end/);
  });

  test('the main card is the image box, and the header/editor take its width', () => {
    setup(1);
    open(1);
    const g = geoFor({ w: 200, h: 100 }); // the fixture's selectionRect
    const card = mainCard()!;
    // Never scaled up past the selection's own CSS size (the PNG's pixels
    // are at item.dpr and are NOT the display size).
    expect(card.style.width).toBe('200px');
    expect(card.style.height).toBe('100px');
    // No letterboxing: the <img> fills the card exactly.
    const img = card.querySelector<HTMLImageElement>('.xp-card-img')!;
    expect(img.style.left).toBe('0px');
    expect(img.style.top).toBe('0px');
    expect(img.style.width).toBe('200px');
    expect(img.style.height).toBe('100px');
    expect(q<HTMLElement>('.xp-editor')!.style.width).toBe(`${g.columnW}px`);
  });

  test('navigating to a differently-sized note re-sizes the column but not the rail', () => {
    setup(2);
    items[1] = { ...items[1], selectionRect: { x: 0, y: 0, width: 400, height: 200 } };
    sidebar.setThumbnails(items);
    open(1);
    settleOpen();
    const railTop = q<HTMLElement>('.xp-rail')!.style.top;
    const editorW = q<HTMLElement>('.xp-editor')!.style.width;

    downBtn().click();
    jest.advanceTimersByTime(T.contentOut); // the swap point
    const card = mainCard()!;
    expect(card.dataset.itemId).toBe('2');
    expect(card.style.width).toBe('400px');
    expect(card.style.height).toBe('200px');
    expect(q<HTMLElement>('.xp-editor')!.style.width).toBe('400px');
    expect(q<HTMLElement>('.xp-editor')!.style.width).not.toBe(editorW);
    // §M: the rail stays put whatever the image does.
    expect(q<HTMLElement>('.xp-rail')!.style.top).toBe(railTop);
  });

  test('the FLIP morph still lands on the image box, before and after a carousel', () => {
    setup(2);
    items[1] = { ...items[1], selectionRect: { x: 0, y: 0, width: 400, height: 200 } };
    sidebar.setThumbnails(items);
    const wrap = shadow().querySelector<HTMLElement>('button.thumbnail[data-item-id="1"] .thumbnail-image-wrap')!;
    wrap.getBoundingClientRect = () =>
      ({ left: 740, top: 332, right: 1007, bottom: 432, width: 267, height: 100, x: 740, y: 332, toJSON() {} }) as DOMRect;
    open(1);

    const frame = mainCard()!.querySelector('.xp-card-frame')!;
    const morph = animCalls.find((c) => c.el === frame)!;
    // First maps the card back onto the measured 267×100 list rect — the
    // scale is now relative to the 200×100 image box, not a fixed slot.
    expect(morph.keyframes[0].transform).toContain(`scale(${Math.round((267 / 200) * 1e5) / 1e5}, 1)`);
    expect(morph.keyframes[morph.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');

    settleOpen();
    animCalls = [];
    downBtn().click();
    const card2 = mainCard()!;
    expect(card2.dataset.itemId).toBe('2');
    // Peek slot → the new note's own image box: the carousel retargets from
    // the live rect and still ends at identity on the new (different) size.
    const morph2 = animCalls.find((c) => c.el === card2.querySelector('.xp-card-frame'))!;
    expect(morph2.options.duration).toBe(T.carousel);
    expect(morph2.keyframes[0].transform).not.toBe('translate(0px, 0px) scale(1, 1)');
    expect(morph2.keyframes[morph2.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
    jest.advanceTimersByTime(T.carousel);
    expect(card2.style.width).toBe('400px');
    expect(card2.style.height).toBe('200px');
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
    expect(shadow().querySelector('.xp-card[data-item-id="2"]')).toBeNull();
  });

  test('last note: moves to the previous one', async () => {
    setup(3);
    open(3);
    settleOpen();
    await del();
    expect(mainCard()!.dataset.itemId).toBe('2');
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
