// Where a saved drawing is shown (design spec §AB): over the note list's
// thumbnail and over the enlarged view's main image and peeks, view-only.
// Both are an SVG with viewBox = the selection's CSS size and
// preserveAspectRatio "xMidYMid meet", filling the same box as the
// object-fit: contain screenshot — which is what makes the two line up at
// any size. In the enlarged view it lives inside .xp-card-media, the element
// the FLIP morph's media track transforms, so it rides the morph and the
// carousel with the image rather than needing a track of its own.

import * as sidebar from '../sidebar';
import { renderThumbnailList } from '../thumbnails';
import { T, EnlargedViewCallbacks } from '../enlargedView';
import { containFit, insetBox } from '../flip';
import type { Drawing, FeedbackItem } from '../types';

const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

const DRAWING: Drawing = {
  width: 200,
  height: 100,
  strokes: [
    { color: '#E5484D', points: [[10, 10], [50, 40]] },
    { color: '#E8B600', points: [[150, 80]] },
  ],
};

function makeItem(id: number, drawing?: Drawing): FeedbackItem {
  return {
    id,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: `note ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 200, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 2,
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
        dpr: 2,
        selectionRect: { x: 0, y: 0, width: 200, height: 100 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    ...(drawing ? { drawing } : {}),
  };
}

// ---------------------------------------------------------------------------
// The note list
// ---------------------------------------------------------------------------

describe('the note list thumbnail', () => {
  let listEl: HTMLUListElement;
  beforeEach(() => {
    listEl = document.createElement('ul');
  });

  test('an item with a drawing gets an SVG over its image, fitted the way the image is', () => {
    renderThumbnailList(listEl, [makeItem(1, DRAWING)], { onOpen: jest.fn(), onDelete: jest.fn() });
    const wrap = listEl.querySelector('.thumbnail-image-wrap')!;
    const img = wrap.querySelector('img.thumbnail-image') as HTMLImageElement;
    const svg = wrap.querySelector('svg.thumbnail-drawing')!;
    expect(img.style.objectFit).toBe('contain');
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    // "meet" + centred is object-fit: contain's placement exactly.
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('stroke'))).toEqual(['#E5484D', '#E8B600']);
    // Over the image, under the number badge.
    expect(Array.from(wrap.children).map((c) => c.getAttribute('class'))).toEqual([
      'thumbnail-image',
      'thumbnail-drawing',
      'thumbnail-badge',
    ]);
  });

  test('an item without one gets nothing extra', () => {
    renderThumbnailList(listEl, [makeItem(1)], { onOpen: jest.fn(), onDelete: jest.fn() });
    expect(listEl.querySelector('svg.thumbnail-drawing')).toBeNull();
    expect(listEl.querySelector('.thumbnail-image-wrap')!.children).toHaveLength(2);
  });

  test('it never intercepts the thumbnail\'s click: a press on it still opens the note', () => {
    const onOpen = jest.fn();
    const item = makeItem(1, DRAWING);
    renderThumbnailList(listEl, [item], { onOpen, onDelete: jest.fn() });
    listEl.querySelector('svg.thumbnail-drawing')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  test('it lives inside the <li>, so dock magnification scales it with the image', () => {
    renderThumbnailList(listEl, [makeItem(1, DRAWING)], { onOpen: jest.fn(), onDelete: jest.fn() });
    const li = listEl.querySelector('li.thumbnail-item')!;
    const btn = li.querySelector('button.thumbnail')!;
    expect(btn.contains(listEl.querySelector('svg.thumbnail-drawing'))).toBe(true);
  });

  test('the sidebar stylesheet fills the image box with it and takes it off the pointer', () => {
    sidebar.initSidebar({ onAdd() {}, onExport() {}, onImportFile() {}, onClose() {}, onOpenItem() {} });
    const root = document.getElementById('annotator-sidebar-host')!.shadowRoot!;
    const css = root.querySelector('style')!.textContent ?? '';
    const rule = css.match(/\n\s*\.thumbnail-drawing \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/position: absolute/);
    expect(rule).toMatch(/left: 0;[\s\S]*top: 0;[\s\S]*width: 100%;[\s\S]*height: 100%/);
    expect(rule).toMatch(/pointer-events: none/);
    // the wrap is its containing block
    expect(css).toMatch(/\.thumbnail-image-wrap \{[^}]*position: relative/);
    expect(root.querySelectorAll('style')).toHaveLength(1);

    sidebar.openSidebar();
    sidebar.setThumbnails([makeItem(1, DRAWING), makeItem(2)]);
    expect(root.querySelectorAll('svg.thumbnail-drawing')).toHaveLength(1);
    sidebar.destroySidebar();
  });
});

// ---------------------------------------------------------------------------
// The enlarged view
// ---------------------------------------------------------------------------

describe('the enlarged view', () => {
  interface AnimCall {
    el: Element;
    keyframes: Keyframe[];
  }
  let animCalls: AnimCall[] = [];

  function shadow(): ShadowRoot {
    return document.getElementById('annotator-sidebar-host')!.shadowRoot!;
  }
  const mainCard = () => shadow().querySelector<HTMLElement>('.xp-card.is-main');
  const peek = (which: 'prev' | 'next') => shadow().querySelector<HTMLElement>(`.xp-card.is-${which}`);
  const downBtn = () => shadow().querySelector<HTMLButtonElement>('.xp-next')!;

  function callbacks(): EnlargedViewCallbacks {
    return {
      fetchFullImage: jest.fn().mockResolvedValue(null),
      onSaveNote: jest.fn().mockResolvedValue(true),
      onDelete: jest.fn().mockResolvedValue(true),
      onClosed: jest.fn(),
    } as unknown as EnlargedViewCallbacks;
  }

  function setup(items: FeedbackItem[]): void {
    sidebar.initSidebar({ onAdd() {}, onExport() {}, onImportFile() {}, onClose() {}, onOpenItem() {} });
    sidebar.openSidebar();
    sidebar.setThumbnails(items);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    animCalls = [];
    (Element.prototype as any).animate = function (keyframes: Keyframe[]) {
      animCalls.push({ el: this as Element, keyframes });
      return { cancel: jest.fn(), finished: Promise.resolve(), currentTime: 0 } as unknown as Animation;
    };
    (window as any).matchMedia = jest.fn((q: string) => ({
      matches: false,
      media: q,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
    }));
  });

  afterEach(() => {
    sidebar.destroySidebar();
    jest.useRealTimers();
    delete (Element.prototype as any).animate;
    delete (window as any).matchMedia;
  });

  test('over the main image and the peeks, inside .xp-card-media beside the <img>', () => {
    setup([makeItem(1, DRAWING), makeItem(2, DRAWING), makeItem(3)]);
    expect(sidebar.openEnlargedView(2, callbacks())).toBe(true);

    for (const card of [mainCard()!, peek('prev')!]) {
      const media = card.querySelector('.xp-card-media')!;
      const kids = Array.from(media.children).map((c) => c.getAttribute('class'));
      expect(kids).toEqual(['xp-card-img', 'xp-card-drawing']);
      const svg = media.querySelector('svg.xp-card-drawing')!;
      expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    }
    // the note without a drawing shows none
    expect(peek('next')!.querySelector('.xp-card-drawing')).toBeNull();
  });

  test('view-only: no pointer on it, nothing focusable, no pencil anywhere in the view', () => {
    setup([makeItem(1, DRAWING)]);
    sidebar.openEnlargedView(1, callbacks());
    const css = shadow().querySelector('style')!.textContent ?? '';
    const rule = css.match(/\n\s*\.xp-card-drawing \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/pointer-events: none/);
    expect(rule).toMatch(/width: 100%; height: 100%/);
    const svg = mainCard()!.querySelector('.xp-card-drawing')!;
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(shadow().querySelector('.draw-surface, .btn-pencil, .swatch')).toBeNull();
  });

  test('it rides the FLIP morph: the media box it sits in is what the morph transforms', () => {
    setup([makeItem(1, DRAWING)]);
    const wrap = shadow().querySelector<HTMLElement>('button.thumbnail[data-item-id="1"] .thumbnail-image-wrap')!;
    wrap.getBoundingClientRect = () =>
      ({ left: 740, top: 332, right: 1007, bottom: 432, width: 267, height: 100, x: 740, y: 332, toJSON() {} }) as DOMRect;
    sidebar.openEnlargedView(1, callbacks());

    const media = mainCard()!.querySelector<HTMLElement>('.xp-card-media')!;
    const svg = media.querySelector('.xp-card-drawing')!;
    const mediaTrack = animCalls.find((c) => c.el === media);
    expect(mediaTrack).toBeDefined();
    // Starts off-identity (on the list thumbnail), ends at identity.
    expect(mediaTrack!.keyframes[0].transform).not.toBe('translate(0px, 0px) scale(1, 1)');
    expect(mediaTrack!.keyframes[mediaTrack!.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
    // The drawing has no track of its own — it cannot drift from the image.
    expect(animCalls.find((c) => c.el === svg)).toBeUndefined();
    expect(svg.parentElement).toBe(media);
  });

  test('geometry: the media box has the drawing\'s aspect, so "meet" fills it exactly, like the image', () => {
    setup([makeItem(1, DRAWING)]);
    sidebar.openEnlargedView(1, callbacks());
    jest.advanceTimersByTime(T.expandSettle);
    const media = mainCard()!.querySelector<HTMLElement>('.xp-card-media')!;
    const w = parseFloat(media.style.width);
    const h = parseFloat(media.style.height);
    expect(w / h).toBeCloseTo(DRAWING.width / DRAWING.height, 5);
    // A contain-fit of the drawing's viewBox into that box is the whole box —
    // the same rect the object-fit: contain image occupies.
    const fitted = containFit(DRAWING.width / DRAWING.height, insetBox({ x: 0, y: 0, w, h }, 0));
    expect(fitted.w).toBeCloseTo(w, 5);
    expect(fitted.h).toBeCloseTo(h, 5);
  });

  test('it moves with its card through the carousel', () => {
    setup([makeItem(1, DRAWING), makeItem(2)]);
    sidebar.openEnlargedView(1, callbacks());
    jest.advanceTimersByTime(T.expandSettle);
    const card1 = mainCard()!;
    const svg = card1.querySelector('.xp-card-drawing')!;

    animCalls = [];
    downBtn().click();
    expect(mainCard()!.dataset.itemId).toBe('2');
    expect(mainCard()!.querySelector('.xp-card-drawing')).toBeNull();
    // Note 1 is now the previous peek, drawing and all, and its media box
    // is carried by the carousel's own media track.
    const prev = peek('prev')!;
    expect(prev).toBe(card1);
    expect(prev.querySelector('.xp-card-drawing')).toBe(svg);
    expect(animCalls.some((c) => c.el === prev.querySelector('.xp-card-media'))).toBe(true);
    jest.advanceTimersByTime(T.carousel);
    expect(peek('prev')!.querySelector('.xp-card-drawing')).toBe(svg);
  });
});
