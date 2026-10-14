// The enlarged view, 2.0 (design spec §AH, design/MOTION_SPEC.md) — the
// sidebar expanding into one scrolling page of every note on the site.
// Driven through the real sidebar.ts (it lends the view its shadow root and
// list), the same way content.ts drives it, with jest.fn() stand-ins for
// the chrome.runtime round trips. jsdom has no WAAPI, layout, rAF clock,
// IntersectionObserver or matchMedia, so each is mocked where a test needs
// it: Element.prototype.animate records calls, getBoundingClientRect is
// stubbed per list thumbnail, and matchMedia reports reduced motion on
// demand. The pure geometry has its own suite (enlargedLayout.test.ts);
// this one checks that the view lays itself out by it.

import * as sidebar from '../sidebar';
import { FeedbackItem, SitePage } from '../types';
import { T, EnlargedSite, EnlargedViewCallbacks, defaultPageName } from '../enlargedView';
import { ACC, STD } from '../flip';
import {
  computeGridLayout,
  contentWidthFor,
  maxShotHeightFor,
  panelWidthFor,
  DOCKED_HEADER_H,
  OPEN_PEEK_PX,
  TOP_BAR_H,
  scrollTopFor,
} from '../enlargedLayout';
import {
  DELETE_ALL_FAILED_MESSAGE,
  DELETE_ALL_LABEL,
  DELETE_ERROR_MESSAGE,
  NOTE_REQUIRED_MESSAGE,
  PAGE_HAS_NO_NOTES_MESSAGE,
  PAGE_NAME_SAVE_ERROR_MESSAGE,
  SAVE_ERROR_MESSAGE,
  SITE_LOAD_FAILED_MESSAGE,
  UNTITLED_PAGE_NAME,
  saveErrorFor,
} from '../copy';

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

const BLOG = 'https://example.com/blog';
const PRICING = 'https://example.com/pricing';
const ABOUT = 'https://example.com/about';

const TITLES: Record<string, string> = { [BLOG]: 'Blog', [PRICING]: 'Pricing', [ABOUT]: 'About' };

function makeItem(id: number, url = PRICING, size: [number, number] = [267, 100], note = `note ${id}`): FeedbackItem {
  const [width, height] = size;
  return {
    id,
    pageUrl: url,
    normalisedUrl: url,
    note,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width, height },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: `key-${id}`,
    thumbnailDataUrl: `data:image/jpeg;base64,THUMB${id}`,
    context: {
      primaryTarget: { cssSelector: 'div', xpath: '/html/body/div', outerHtmlSnippet: '<div></div>', truncated: false },
      containedElements: [],
      areaText: '',
      pageMeta: {
        url,
        normalisedUrl: url,
        title: TITLES[url] ?? '',
        viewport: { width: 1280, height: 800 },
        dpr: 1,
        selectionRect: { x: 0, y: 0, width, height },
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
    onDeleteAll: jest.fn().mockResolvedValue(true),
    onSavePageTitle: jest.fn().mockResolvedValue('saved'),
    onClosed: jest.fn(),
    ...overrides,
  };
}

function shadow(): ShadowRoot {
  return document.getElementById('annotator-sidebar-host')!.shadowRoot!;
}
const q = <E extends Element = HTMLElement>(sel: string): E | null => shadow().querySelector<E>(sel);
const qa = <E extends Element = HTMLElement>(sel: string): E[] => [...shadow().querySelectorAll<E>(sel)];
const wrapper = () => q('.enlarged');
const exitBtn = () => q<HTMLButtonElement>('.xp-exit')!;
const scroller = () => q<HTMLElement>('.xp-scroll')!;
const note = (id: number) => q<HTMLElement>(`.xp-note[data-item-id="${id}"]`)!;
const textareaOf = (id: number) => note(id).querySelector<HTMLTextAreaElement>('.xp-note-input')!;
const statusOf = (id: number) => note(id).querySelector<HTMLElement>('.xp-note-status')!;
const deleteOf = (id: number) => note(id).querySelector<HTMLButtonElement>('.xp-note-delete')!;
const shotOf = (id: number) => note(id).querySelector<HTMLElement>('.xp-shot')!;
const heading = (url: string) => q<HTMLElement>(`.xp-page[data-page-url="${url}"]`)!;
const nums = () => qa('.xp-note-num').map((n) => n.textContent);

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The default site: blog (3 notes) first-noted, then pricing (the page on
 *  screen, 3 notes), then about (2). Ids in capture order across pages. */
function defaultPages(): SitePage[] {
  return [
    { normalisedUrl: BLOG, editedTitle: null, items: [makeItem(1, BLOG), makeItem(2, BLOG, [120, 80]), makeItem(4, BLOG, [400, 250])] },
    { normalisedUrl: PRICING, editedTitle: null, items: [makeItem(3), makeItem(5, PRICING, [1100, 220]), makeItem(6)] },
    { normalisedUrl: ABOUT, editedTitle: 'team page', items: [makeItem(7, ABOUT, [600, 420]), makeItem(8, ABOUT)] },
  ];
}

let site: EnlargedSite;

/** Sidebar open on `current`, its list showing that page's notes. */
function setup(pages: SitePage[] = defaultPages(), current = PRICING): void {
  sidebar.initSidebar({
    onAdd: () => {},
    onExport: () => {},
    onImport: () => {},
    onImportFile: () => {},
    onDeleteAll: () => {},
    onClose: () => {},
    onOpenItem: () => {},
  });
  sidebar.openSidebar();
  site = { currentUrl: current, pages };
  sidebar.setThumbnails(pages.find((p) => p.normalisedUrl === current)?.items ?? []);
}

/** A one-page site of `n` default notes. */
function setupPage(n: number): void {
  setup([{ normalisedUrl: PRICING, editedTitle: null, items: Array.from({ length: n }, (_, i) => makeItem(i + 1)) }]);
}

function open(id: number, cbs = makeCallbacks()) {
  expect(sidebar.openEnlargedView(id, site, cbs)).toBe(true);
  return cbs;
}

function settleOpen(): void {
  jest.advanceTimersByTime(T.expandSettle);
}

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} }) as DOMRect;
}

/** The layout the view should have computed for the current site (jsdom:
 *  1024×768, no scrollbar, so the content width is the panel's less its
 *  insets). */
function expectedLayout(pages: SitePage[] = site.pages) {
  const panelW = panelWidthFor(window.innerWidth, sidebar.getSidebarWidth());
  return computeGridLayout(
    pages.map((p) => ({
      key: p.normalisedUrl,
      notes: p.items.map((it) => ({ id: it.id, natural: { w: it.selectionRect.width, h: it.selectionRect.height } })),
    })),
    { contentW: contentWidthFor(panelW - 1), maxShotH: maxShotHeightFor(window.innerHeight - TOP_BAR_H) },
  );
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
  delete (window as any).IntersectionObserver;
});

// ---------------------------------------------------------------------------
// Content and order
// ---------------------------------------------------------------------------

describe('the whole site, one page', () => {
  test('every page of the site, in the order given, each under a heading; the list stays this page only', () => {
    setup();
    open(3);
    expect(wrapper()!.getAttribute('role')).toBe('dialog');
    expect(wrapper()!.getAttribute('aria-label')).toBe('all notes on this website');
    expect(shadow().querySelectorAll('style')).toHaveLength(1);
    expect(qa('.xp-page').map((h) => h.dataset.pageUrl)).toEqual([BLOG, PRICING, ABOUT]);
    expect(qa('.xp-note').map((n) => n.dataset.itemId)).toEqual(['1', '2', '4', '3', '5', '6', '7', '8']);
    // The notice's live region is there, empty — and not laid out.
    expect(q('.xp-notice')!.textContent).toBe('');
    expect(q('style')!.textContent).toMatch(/\.xp-notice:empty \{ display: none; \}/);
    // Numbers are per page, in capture order (design spec §AD).
    expect(nums()).toEqual(['#1', '#2', '#3', '#1', '#2', '#3', '#1', '#2']);
    // The sidebar's own list still shows only this page.
    expect(qa('button.thumbnail').map((b) => b.dataset.itemId)).toEqual(['3', '5', '6']);
  });

  test('every note is in edit mode: a text area holding its note', () => {
    setup();
    open(3);
    expect(qa<HTMLTextAreaElement>('.xp-note-input').map((t) => t.value)).toEqual(
      ['note 1', 'note 2', 'note 4', 'note 3', 'note 5', 'note 6', 'note 7', 'note 8'],
    );
    expect(textareaOf(5).getAttribute('aria-label')).toBe('note #2 on Pricing');
    expect(deleteOf(5).getAttribute('aria-label')).toBe('delete note #2 on Pricing');
    expect(textareaOf(7).getAttribute('aria-label')).toBe('note #1 on team page');
  });

  test('headings: the serif name, the address in regular ink, "this page" on the page on screen only', () => {
    setup();
    open(3);
    expect(heading(BLOG).querySelector('.xp-page-name')!.textContent).toBe('Blog');
    expect(heading(ABOUT).querySelector('.xp-page-name')!.textContent).toBe('team page');
    expect(heading(PRICING).querySelector('.xp-page-url')!.textContent).toBe('example.com/pricing');
    expect(heading(PRICING).querySelector('.xp-page-url')!.getAttribute('data-tip')).toBe(PRICING);
    expect(qa('.xp-page-here').map((l) => l.closest<HTMLElement>('.xp-page')!.dataset.pageUrl)).toEqual([PRICING]);
    // Each page's notes are a group named by its heading.
    const group = heading(ABOUT).closest('.xp-page-group')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-labelledby')).toBe(heading(ABOUT).querySelector('.xp-page-name')!.id);
    const css = q('style')!.textContent!;
    const urlRule = css.slice(css.indexOf('.xp-page-url {'), css.indexOf('}', css.indexOf('.xp-page-url {')));
    expect(urlRule).toContain('var(--sal-font-mono)');
    expect(urlRule).toContain('color: var(--sal-text)');
    const nameRule = css.slice(css.indexOf('.xp-page-name {'), css.indexOf('}', css.indexOf('.xp-page-name {')));
    expect(nameRule).toContain('var(--sal-font-display)');
    expect(nameRule).toContain('font-style: italic');
  });

  test('a heading is two lines: the name and its pencil, then the address with "this page" to its right, in regular ink', () => {
    setup();
    open(3);
    const h = heading(PRICING);
    const [line, sub] = [h.querySelector('.xp-page-line')!, h.querySelector('.xp-page-sub')!];
    expect([...line.children].map((c) => c.className)).toEqual(['xp-page-name', 'xp-page-edit', 'xp-page-editor']);
    expect([...sub.children].map((c) => c.className)).toEqual(['xp-page-url', 'xp-page-here']);
    const css = q('style')!.textContent!;
    const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    expect(rule('.xp-page-here')).toMatch(/color: var\(--sal-text\)/);
    expect(rule('.xp-page-here')).toMatch(/inset 0 0 0 1px var\(--sal-line\)/);
    expect(rule('.xp-page-here')).not.toMatch(/accent/);
  });

  test('the pencil is the delete\'s button without the red; the rename field is the name\'s own face', () => {
    setup();
    open(3);
    const css = q('style')!.textContent!;
    const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    const edit = rule('.xp-page-edit');
    const del = rule('.xp-note-delete');
    for (const decl of ['width: 28px; height: 28px;', 'border: 1px solid var(--sal-line); border-radius: var(--sal-radius-md);', 'background: var(--sal-surface);']) {
      expect(edit).toContain(decl);
      expect(del).toContain(decl);
    }
    const editStates = css.slice(css.indexOf('.xp-page-edit:hover'), css.indexOf('.xp-page-edit:focus-visible'));
    expect(editStates).not.toMatch(/danger/);
    expect(editStates).toMatch(/var\(--sal-hover\)/);
    // The field: the serif, italic, at the name's size and line.
    const input = rule('.xp-page-input');
    const name = rule('.xp-page-name');
    for (const decl of ['font-family: var(--sal-font-display)', 'font-style: italic', 'font-size: 28px', 'line-height: 34px']) {
      expect(input).toContain(decl);
      expect(name).toContain(decl);
    }
  });

  test('a page\'s default name is its first captured HTML title, else "untitled page"', () => {
    const a = makeItem(1, BLOG);
    const b = makeItem(2, BLOG);
    a.context.pageMeta.title = '  ';
    b.context.pageMeta.title = 'Second title';
    expect(defaultPageName([a, b])).toBe('Second title');
    b.context.pageMeta.title = '';
    expect(defaultPageName([a, b])).toBe(UNTITLED_PAGE_NAME);
  });

  test('the parts are placed by the layout: headings, headers, screenshots, text areas', () => {
    setup();
    open(3);
    const layout = expectedLayout();
    for (const id of [1, 2, 4, 3, 5, 6, 7, 8]) {
      const nl = layout.notes.get(id)!;
      const shot = shotOf(id).style;
      expect([shot.left, shot.top, shot.width]).toEqual([`${nl.shot.x}px`, `${nl.shot.y}px`, `${nl.shot.w}px`]);
      const ed = note(id).querySelector<HTMLElement>('.xp-editor')!.style;
      expect([ed.left, ed.top, ed.width]).toEqual([`${nl.text.x}px`, `${nl.text.y}px`, `${nl.text.w}px`]);
      const head = note(id).querySelector<HTMLElement>('.xp-note-head')!.style;
      expect([head.left, head.top, head.width]).toEqual([`${nl.head.x}px`, `${nl.head.y}px`, `${nl.head.w}px`]);
    }
    const h = layout.headings.find((x) => x.page === ABOUT)!;
    expect(heading(ABOUT).style.top).toBe(`${h.box.y}px`);
    expect(q<HTMLElement>('.xp-content')!.style.height).toBe(`${layout.height}px`);
  });

  test('every box is sized from the stored selection before any image arrives', () => {
    setup();
    open(5);
    // The wide one is scaled to the content width; nothing waits on a load.
    const layout = expectedLayout();
    expect(shotOf(5).style.width).toBe(`${layout.contentW}px`);
    expect(parseFloat(shotOf(5).style.height)).toBeCloseTo((layout.contentW * 220) / 1100, 3);
    expect(shotOf(5).querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB5');
  });
});

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

describe('opening on a note', () => {
  test('the clicked note\'s text area has focus at once, caret at its end', () => {
    setup();
    open(5);
    const ta = textareaOf(5);
    expect(shadow().activeElement).toBe(ta);
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(ta.selectionEnd).toBe(ta.value.length);
    expect(wrapper()!.dataset.state).toBe('opening');
    expect(q('.sidebar')!.hasAttribute('inert')).toBe(true);
    settleOpen();
    expect(wrapper()!.dataset.state).toBe('open');
    expect(shadow().activeElement).toBe(ta);
  });

  test('scrolled so the row before it peeks 40px under the top bar, the note right under it', () => {
    setup();
    open(5);
    const layout = expectedLayout();
    const top = scroller().scrollTop;
    const at = layout.notes.get(5)!.row;
    expect(layout.rows[at - 1].page).toBe(layout.rows[at].page);
    expect(layout.rows[at - 1].bottom - top).toBe(OPEN_PEEK_PX);
    expect(top).toBe(scrollTopFor(layout, 5, window.innerHeight - TOP_BAR_H));
  });

  test('from a page\'s first note, its heading shows whole, the previous page\'s last row peeking 40px above it', () => {
    setup();
    open(3);
    const layout = expectedLayout();
    const top = scroller().scrollTop;
    const at = layout.notes.get(3)!.row;
    expect(layout.rows[at - 1].page).toBe(BLOG);
    expect(layout.rows[at - 1].bottom - top).toBe(OPEN_PEEK_PX);
    expect(layout.headings.find((x) => x.page === PRICING)!.box.y).toBeGreaterThan(top);
  });

  test('the site\'s first note opens at the top, with no peek', () => {
    setupPage(3);
    open(1);
    expect(scroller().scrollTop).toBe(0);
  });

  test('every note with a visible list thumbnail morphs from it — one cut by the list\'s edge too; the rest fade in', () => {
    setup();
    const wraps = qa<HTMLElement>('.thumbnail-image-wrap');
    stubRect(q('.body')!, { left: 724, top: 130, width: 300, height: 400 });
    stubRect(wraps[0], { left: 740, top: 150, width: 267, height: 100 });
    // Half under the list's bottom edge: still visible, so it morphs, clipped.
    stubRect(wraps[1], { left: 740, top: 480, width: 267, height: 100 });
    // Scrolled out of the list's viewport: no rect to morph from.
    stubRect(wraps[2], { left: 740, top: 600, width: 267, height: 100 });
    open(5);

    expect(qa('.xp-card').map((c) => c.dataset.itemId)).toEqual(['3', '5']);
    for (const id of [3, 5]) {
      const frame = q(`.xp-card[data-item-id="${id}"] .xp-card-frame`)!;
      const morph = animCalls.find((c) => c.el === frame)!;
      expect(morph.options.duration).toBe(T.expand);
      expect(morph.keyframes[0].transform).not.toBe('translate(0px, 0px) scale(1, 1)');
      expect(morph.keyframes[morph.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
      // The real screenshot waits under its clone; the list's is hidden.
      expect(shotOf(id).style.visibility).toBe('hidden');
    }
    // The cut one starts clipped by exactly what the list hides (50px on
    // screen, in the frame's own scaled px) and ends unclipped.
    const cutFrame = animCalls.find((c) => c.el === q('.xp-card[data-item-id="5"] .xp-card-frame'))!;
    const first = cutFrame.keyframes[0];
    const sy = Number(String(first.transform).match(/scale\([^,]+, ([^)]+)\)/)![1]);
    expect(first.clipPath).toBe(`inset(0px 0px ${Math.round((50 / sy) * 1000) / 1000}px 0px)`);
    expect(cutFrame.keyframes[cutFrame.keyframes.length - 1].clipPath).toBe('inset(0px 0px 0px 0px)');
    // The whole one carries no clip at all.
    const wholeFrame = animCalls.find((c) => c.el === q('.xp-card[data-item-id="3"] .xp-card-frame'))!;
    expect('clipPath' in wholeFrame.keyframes[0]).toBe(false);
    expect(wraps[0].style.visibility).toBe('hidden');
    expect(wraps[2].style.visibility).toBe('');
    // Other pages' notes and the scrolled-out one fade in, never morph.
    for (const id of [1, 6, 7]) {
      expect(q(`.xp-card[data-item-id="${id}"]`)).toBeNull();
    }

    settleOpen();
    expect(qa('.xp-card')).toHaveLength(0);
    expect(shotOf(3).style.visibility).toBe('');
    expect(wraps[0].style.visibility).toBe('');
  });

  test('grid content fades in a band at a time, the exit button last', () => {
    setup();
    open(3);
    const fadeOf = (el: Element) => animCalls.find((c) => c.el === el && 'opacity' in c.keyframes[0]);
    const pricingHead = fadeOf(heading(PRICING))!;
    const firstRow = fadeOf(note(3))!;
    expect(pricingHead.options.delay).toBeGreaterThanOrEqual(T.gridDelay);
    expect(firstRow.options.delay).toBeGreaterThan(pricingHead.options.delay as number);
    expect(fadeOf(note(5))!.options.delay).toBeGreaterThanOrEqual(firstRow.options.delay as number);
    // Capped: nothing starts later than two steps in.
    for (const c of animCalls.filter((a) => 'opacity' in a.keyframes[0] && a.el.classList?.contains('xp-note'))) {
      expect(c.options.delay).toBeLessThanOrEqual(T.gridDelay + T.gridStaggerSteps * T.gridStagger);
    }
    expect(fadeOf(exitBtn())!.options.delay).toBe(T.exitDelay);
  });

  test('the panel grows leftward from the docked width; the logo, its size unchanged, settles centred in the top bar, as far in', () => {
    setup();
    open(3);
    const width = animCalls.find((c) => c.el === q('.xp-bg') && 'width' in c.keyframes[0])!;
    expect(width.keyframes[0].width).toBe(`${sidebar.getSidebarWidth()}px`);
    expect(width.keyframes[1].width).toBe(`${panelWidthFor(window.innerWidth, sidebar.getSidebarWidth())}px`);
    expect(width.options.duration).toBe(T.expand);
    const brand = q('.xp-brand')!;
    const top = animCalls.find((c) => c.el === brand && 'top' in c.keyframes[0])!;
    const left = animCalls.find((c) => c.el === brand && 'left' in c.keyframes[0])!;
    // Docked, the 20px logo is 16px in and centred in a 56px header (18px
    // from its top). In the panel it is centred in the 68px bar — 24px
    // above its ink, 24 to the bar's bottom edge — and 24px in.
    expect([top.keyframes[0].top, top.keyframes[1].top]).toEqual(['0px', '6px']);
    expect([left.keyframes[0].left, left.keyframes[1].left]).toEqual(['16px', '24px']);
    // 6px down from the docked pose: (56 - 20) / 2 + 6 = 24, the logo's
    // margin, with as much under it in the 68px bar.
    expect((DOCKED_HEADER_H - 20) / 2 + 6).toBe((TOP_BAR_H - 20) / 2);
    for (const c of [top, left]) {
      expect(c.options.duration).toBe(T.expand);
      expect(c.options.easing).toBe(width.options.easing);
    }
    // Never scaled.
    expect(animCalls.some((c) => c.el === brand && ('transform' in c.keyframes[0] || 'scale' in c.keyframes[0]))).toBe(false);
    // Collapsing takes it back to the docked pose.
    settleOpen();
    animCalls = [];
    exitBtn().click();
    const backLeft = animCalls.find((c) => c.el === brand && 'left' in c.keyframes[0])!;
    const backTop = animCalls.find((c) => c.el === brand && 'top' in c.keyframes[0])!;
    expect([backLeft.keyframes[0].left, backLeft.keyframes[1].left]).toEqual(['24px', '16px']);
    expect([backTop.keyframes[0].top, backTop.keyframes[1].top]).toEqual(['6px', '0px']);
    expect(backLeft.options.duration).toBe(T.collapse);
  });

  test('a collapse mid-open takes the logo back from where it had got to', () => {
    setup();
    open(3);
    jest.advanceTimersByTime(T.expand / 2);
    animCalls = [];
    exitBtn().click();
    const back = animCalls.find((c) => c.el === q('.xp-brand') && 'left' in c.keyframes[0])!;
    const from = parseFloat(back.keyframes[0].left as string);
    expect(from).toBeGreaterThan(16);
    expect(from).toBeLessThan(24);
  });

  test('the top bar has one margin on every side: the exit button\'s top and right, the docked logo\'s left, the content\'s inset', () => {
    setupPage(1);
    open(1);
    const css = q('style')!.textContent!;
    const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    expect(rule('.xp-exit')).toMatch(/top: 16px; right: 16px;/);
    expect(rule('.xp-brand')).toMatch(/left: 16px;/);
    expect(rule('.xp-content')).toMatch(/margin: 0 0 0 16px;/);
    // The bar is that margin either side of the 36px button; the logo's
    // 20px box is centred in it once settled, on the button's centre line.
    expect(TOP_BAR_H).toBe(16 + 36 + 16);
    expect(rule('.xp-brand img')).toMatch(/height: 20px;/);
  });

  test('the top bar has a bottom rule: the docked header block\'s divider, edge to edge, on the bar\'s last row', () => {
    setupPage(1);
    animCalls = [];
    open(1);
    const css = q('style')!.textContent!;
    const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    const bar = q('.xp-bar-rule')!;
    expect(bar.parentElement).toBe(q('.xp-stage'));
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    // The same token and thickness as .action-row's border-bottom.
    expect(rule('.action-row')).toMatch(/border-bottom: 1px solid var\(--sal-line\);/);
    expect(rule('.xp-bar-rule')).toMatch(/border-bottom: 1px solid var\(--sal-line\);/);
    // Full width, like the docked one, and inside the bar: the scroller
    // still starts at TOP_BAR_H.
    expect(rule('.xp-bar-rule')).toMatch(new RegExp(`left: 0; right: 0; top: ${TOP_BAR_H - 1}px;`));
    expect(rule('.xp-scroll')).toMatch(new RegExp(`top: ${TOP_BAR_H}px;`));
    // It arrives with the exit button and leaves with it.
    const fadeIn = animCalls.find((c) => c.el === bar && 'opacity' in c.keyframes[0])!;
    expect(fadeIn.options.delay).toBe(T.exitDelay);
    settleOpen();
    animCalls = [];
    exitBtn().click();
    const fadeOut = animCalls.find((c) => c.el === bar && 'opacity' in c.keyframes[0])!;
    expect(fadeOut.options.duration).toBe(T.stageOut);
  });

  test('full images: fetched as notes near the viewport (IntersectionObserver), and only land on their own note', async () => {
    const observed: Element[] = [];
    let fire!: (els: Element[]) => void;
    (window as any).IntersectionObserver = class {
      constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void, public opts: IntersectionObserverInit) {
        fire = (els) => cb(els.map((target) => ({ target, isIntersecting: true })));
        expect(opts.root).toBe(scroller());
        expect(opts.rootMargin).toMatch(/px/);
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    };
    setup();
    const fetchFullImage = jest.fn(async (item: FeedbackItem) => `data:image/png;base64,FULL${item.id}`);
    open(3, makeCallbacks({ fetchFullImage }));
    expect(observed).toHaveLength(8);
    expect(fetchFullImage).not.toHaveBeenCalled();
    fire([shotOf(3), shotOf(5)]);
    await flush();
    expect(fetchFullImage.mock.calls.map((c) => c[0].id)).toEqual([3, 5]);
    expect(shotOf(3).querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,FULL3');
    expect(shotOf(6).querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB6');
  });

  test('without IntersectionObserver every full image is fetched', async () => {
    setup();
    const cbs = open(3);
    await flush();
    expect(cbs.fetchFullImage).toHaveBeenCalledTimes(8);
  });

  test('a second open while one is up is refused — the open view keeps its empty-note lock', () => {
    setup();
    open(3);
    settleOpen();
    typeInto(textareaOf(3), '');
    expect(sidebar.openEnlargedView(5, site, makeCallbacks())).toBe(false);
    expect(wrapper()!.dataset.state).toBe('open');
    expect(textareaOf(3).value).toBe('');
  });

  test('a note not in the site opens nothing', () => {
    setup();
    expect(sidebar.openEnlargedView(99, site, makeCallbacks())).toBe(false);
    expect(wrapper()).toBeNull();
  });

  test('with no site, it opens on the list\'s own notes', () => {
    setup();
    expect(sidebar.openEnlargedView(5, null, makeCallbacks())).toBe(true);
    expect(qa('.xp-note').map((n) => n.dataset.itemId)).toEqual(['3', '5', '6']);
    expect(q('.xp-notice')!.textContent).toBe(SITE_LOAD_FAILED_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

describe('closing', () => {
  test('exit collapses after the collapse timeline, restores the list and returns focus', () => {
    setup();
    const cbs = open(5);
    settleOpen();
    exitBtn().click();
    expect(wrapper()!.dataset.state).toBe('closing');
    expect(q('.sidebar')!.hasAttribute('inert')).toBe(false);
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    const sb = q('.sidebar')!;
    expect(sb.classList.contains('is-expanded')).toBe(false);
    expect(sb.style.opacity).toBe('');
    expect(cbs.onClosed).toHaveBeenCalledWith(5);
    expect(shadow().activeElement).toBe(q('button.thumbnail[data-item-id="5"]'));
    for (const w of qa('.thumbnail-image-wrap')) expect(w.style.visibility).toBe('');
  });

  test('focus returns to the last note focused on this page; a note on another page leaves it on the opened one', () => {
    setup();
    let cbs = open(3);
    settleOpen();
    textareaOf(6).focus();
    keydown(textareaOf(6), 'Escape');
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onClosed).toHaveBeenCalledWith(6);

    cbs = open(3);
    settleOpen();
    textareaOf(7).focus(); // about — not in the list
    keydown(textareaOf(7), 'Escape');
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onClosed).toHaveBeenCalledWith(3);
  });

  test('Escape and a scrim click both collapse', () => {
    setupPage(2);
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

  test('notes on screen with a list thumbnail morph back into it; the rest fade', () => {
    setup();
    open(3);
    settleOpen();
    const listWrap = (id: number) => q<HTMLElement>(`button.thumbnail[data-item-id="${id}"] .thumbnail-image-wrap`)!;
    stubRect(listWrap(3), { left: 740, top: 150, width: 267, height: 100 });
    stubRect(listWrap(5), { left: 740, top: 344, width: 267, height: 100 });
    // jsdom has no layout: place the scroller under the top bar and the
    // content where the scroll position puts it, as Chrome would.
    stubRect(scroller(), { left: 1024 - 768, top: TOP_BAR_H, width: 767, height: 768 - TOP_BAR_H });
    stubRect(q('.xp-content')!, { left: 1024 - 768 + 32, top: TOP_BAR_H - scroller().scrollTop, width: 703, height: 2000 });
    animCalls = [];
    exitBtn().click();
    // Pricing's notes are on screen; the blog's and about's have no
    // thumbnail in the list.
    expect(qa('.xp-card').map((c) => c.dataset.itemId)).toEqual(['3', '5']);
    const frame = q('.xp-card[data-item-id="3"] .xp-card-frame')!;
    const morph = animCalls.find((c) => c.el === frame)!;
    expect(morph.options.duration).toBe(T.collapse);
    expect(morph.keyframes[morph.keyframes.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
    expect(listWrap(3).style.visibility).toBe('hidden');
    // The grid itself fades out at once.
    const scrollFade = animCalls.find((c) => c.el === scroller() && 'opacity' in c.keyframes[0])!;
    expect(scrollFade.options.duration).toBe(T.stageOut);
    jest.advanceTimersByTime(T.collapseSettle);
    expect(listWrap(3).style.visibility).toBe('');
  });

  test('a thumbnail the list cuts on the way back is landed on exactly as cut, and stays so', () => {
    setup();
    open(3);
    settleOpen();
    stubRect(scroller(), { left: 1024 - 768, top: TOP_BAR_H, width: 767, height: 768 - TOP_BAR_H });
    stubRect(q('.xp-content')!, { left: 1024 - 768 + 32, top: TOP_BAR_H - scroller().scrollTop, width: 703, height: 2000 });
    stubRect(q('.body')!, { left: 724, top: 130, width: 300, height: 400 });
    // 30px of it under the list's top edge.
    stubRect(q('button.thumbnail[data-item-id="3"] .thumbnail-image-wrap')!, { left: 740, top: 100, width: 267, height: 100 });
    animCalls = [];
    exitBtn().click();
    const frame = q<HTMLElement>('.xp-card[data-item-id="3"] .xp-card-frame')!;
    const kf = animCalls.find((c) => c.el === frame)!.keyframes;
    expect(kf[0].clipPath).toBe('inset(0px 0px 0px 0px)');
    expect(kf[kf.length - 1].clipPath).toBe('inset(30px 0px 0px 0px)');
    // After the morph ends, before the swap: still cut.
    expect(frame.style.clipPath).toBe('inset(30px 0px 0px 0px)');
  });

  test('collapse during the expand reverses from the live panel width, clones and all', () => {
    setup();
    stubRect(qa('.thumbnail-image-wrap')[0], { left: 740, top: 150, width: 267, height: 100 });
    open(3);
    jest.advanceTimersByTime(100); // mid-expand
    animCalls = [];
    keydown(textareaOf(3), 'Escape');
    const widthAnim = animCalls.find((c) => c.el === q('.xp-bg') && 'width' in c.keyframes[0])!;
    const fromW = parseFloat(String(widthAnim.keyframes[0].width));
    expect(fromW).toBeGreaterThan(sidebar.getSidebarWidth());
    expect(fromW).toBeLessThan(panelWidthFor(window.innerWidth, sidebar.getSidebarWidth()));
    expect(widthAnim.keyframes[1].width).toBe(`${sidebar.getSidebarWidth()}px`);
    // The clone still in flight turns round from where it is.
    const frame = q('.xp-card[data-item-id="3"] .xp-card-frame')!;
    expect(animCalls.find((c) => c.el === frame)!.options.duration).toBe(T.collapse);
  });

  test('keyboard isolation: keys inside the view never reach the page', () => {
    setupPage(2);
    open(1);
    settleOpen();
    const pageListener = jest.fn();
    document.addEventListener('keydown', pageListener);
    keydown(textareaOf(1), 'n');
    expect(pageListener).not.toHaveBeenCalled();
    document.removeEventListener('keydown', pageListener);
  });
});

// ---------------------------------------------------------------------------
// Editing, all at once
// ---------------------------------------------------------------------------

describe('autosave, per note', () => {
  test('each note debounces 700ms on its own: typing in a second never restarts the first', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(3), 'first edit');
    jest.advanceTimersByTime(400);
    typeInto(textareaOf(7), 'second edit');
    jest.advanceTimersByTime(300);
    expect(cbs.onSaveNote).toHaveBeenCalledTimes(1);
    expect(cbs.onSaveNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3 }), 'first edit');
    jest.advanceTimersByTime(400);
    expect(cbs.onSaveNote).toHaveBeenCalledTimes(2);
    expect(cbs.onSaveNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7 }), 'second edit');
  });

  test('blur saves that note at once', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(4), 'blurred');
    textareaOf(4).dispatchEvent(new Event('blur'));
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), 'blurred');
  });

  test('collapse flushes every pending edit, and the list shows this page\'s new text', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(3), 'pricing edit');
    typeInto(textareaOf(1), 'blog edit');
    exitBtn().click();
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), 'pricing edit');
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'blog edit');
    jest.advanceTimersByTime(T.collapseSettle);
    expect(q('button.thumbnail[data-item-id="3"] .thumbnail-note')!.textContent).toBe('pricing edit');
  });

  test('a failed save shows under its own note until the next edit; one left unresolved is named in the banner after close', async () => {
    setup();
    const pending: Array<(ok: boolean) => void> = [];
    const onSaveNote = jest.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
    open(3, makeCallbacks({ onSaveNote }));
    settleOpen();
    typeInto(textareaOf(5), 'will fail');
    jest.advanceTimersByTime(T.autosave);
    pending[0](false);
    await flush();
    expect(statusOf(5).dataset.kind).toBe('save-error');
    expect(statusOf(5).textContent).toBe(SAVE_ERROR_MESSAGE);
    expect(textareaOf(5).getAttribute('aria-describedby')).toBe(statusOf(5).id);
    expect(statusOf(3).dataset.kind).toBeUndefined(); // never had a message

    sidebar.collapseEnlargedView({ immediate: true }); // retries...
    pending[1](false); // ...and fails again
    await flush();
    expect(q('.notif-text')!.textContent).toBe(saveErrorFor(2, 'Pricing'));
  });

  test('flushEnlargedView sends every pending edit immediately, and never an empty note', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(3), 'typed just now');
    typeInto(textareaOf(8), '   ');
    sidebar.flushEnlargedView();
    expect(cbs.onSaveNote).toHaveBeenCalledTimes(1);
    expect(cbs.onSaveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), 'typed just now');
  });

  test('blur then collapse sends the in-flight value once', () => {
    setup();
    const onSaveNote = jest.fn(() => new Promise<boolean>(() => {}));
    open(3, makeCallbacks({ onSaveNote }));
    settleOpen();
    typeInto(textareaOf(3), 'once');
    textareaOf(3).dispatchEvent(new Event('blur'));
    exitBtn().click();
    expect(onSaveNote).toHaveBeenCalledTimes(1);
  });
});

describe('a note can never be empty', () => {
  test('emptying a text area says "note required" at once, in danger, announced — and saves nothing', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(6), '  ');
    expect(statusOf(6).textContent).toBe(NOTE_REQUIRED_MESSAGE);
    expect(statusOf(6).getAttribute('aria-live')).toBe('polite');
    expect(textareaOf(6).classList.contains('is-error')).toBe(true);
    expect(textareaOf(6).getAttribute('aria-invalid')).toBe('true');
    expect(textareaOf(6).getAttribute('aria-describedby')).toBe(statusOf(6).id);
    jest.advanceTimersByTime(T.autosave * 2);
    textareaOf(6).dispatchEvent(new Event('blur'));
    expect(cbs.onSaveNote).not.toHaveBeenCalled();

    typeInto(textareaOf(6), 'fixed');
    expect(textareaOf(6).classList.contains('is-error')).toBe(false);
    expect(textareaOf(6).hasAttribute('aria-invalid')).toBe(false);
    expect(statusOf(6).dataset.kind).toBe('none');
  });

  test.each([
    ['exit', () => exitBtn().click()],
    ['Esc', () => keydown(textareaOf(3), 'Escape')],
    ['the scrim', () => q('.xp-scrim')!.click()],
    ['the toolbar icon / sidebar close', () => expect(sidebar.collapseEnlargedView({ immediate: true })).toBe(false)],
  ])('%s is refused while a note is empty, and focus moves to it', (_name, attempt) => {
    setup();
    open(3);
    settleOpen();
    typeInto(textareaOf(7), '');
    textareaOf(3).focus();
    attempt();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(sidebar.isEnlargedViewOpen()).toBe(true);
    expect(wrapper()!.dataset.state).toBe('open');
    expect(shadow().activeElement).toBe(textareaOf(7));
    // ...and brought into view.
    const layout = expectedLayout();
    const slot = layout.notes.get(7)!.slot;
    expect(scroller().scrollTop).toBeLessThanOrEqual(slot.y);
    expect(scroller().scrollTop + window.innerHeight - TOP_BAR_H).toBeGreaterThanOrEqual(slot.y + slot.h);
  });

  test('the first refusal shakes the note, once, never under reduced motion', () => {
    setup();
    open(3);
    settleOpen();
    typeInto(textareaOf(3), '');
    const shakes = () => animCalls.filter((c) => c.el === textareaOf(3) && String(c.keyframes[1]?.transform).includes('translateX'));
    exitBtn().click();
    exitBtn().click();
    expect(shakes()).toHaveLength(1);
    typeInto(textareaOf(3), 'x');
    typeInto(textareaOf(3), '');
    exitBtn().click();
    expect(shakes()).toHaveLength(2);
  });

  test('a forced close (add mode, navigation) gets out, and the stored text stays', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(3), '');
    sidebar.collapseEnlargedView({ immediate: true, force: true });
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
    expect(q('button.thumbnail[data-item-id="3"] .thumbnail-note')!.textContent).toBe('note 3');
  });

  test('deleting is still allowed — and Esc while the empty note is being deleted collapses after it', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(3), '');
    deleteOf(3).click();
    keydown(deleteOf(3), 'Escape');
    expect(sidebar.isEnlargedViewOpen()).toBe(true);
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(cbs.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    expect(cbs.onClosed).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  test('immediate: the note shrinks and fades, then later notes renumber and every part moves to its new place', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    deleteOf(3).click();
    const shrink = animCalls.find((c) => c.el === note(3) && 'transform' in c.keyframes[0])!;
    expect(shrink.options.duration).toBe(T.deleteStep);
    expect(cbs.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    animCalls = [];
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(q('.xp-note[data-item-id="3"]')).toBeNull();
    expect(nums()).toEqual(['#1', '#2', '#3', '#1', '#2', '#1', '#2']);
    expect(deleteOf(5).getAttribute('aria-label')).toBe('delete note #1 on Pricing');
    // The rows re-packed; moved parts travel there (FLIP: from an offset
    // back to none), on the move duration.
    const layout = expectedLayout(site.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== 3) })));
    expect(shotOf(5).style.top).toBe(`${layout.notes.get(5)!.shot.y}px`);
    const moves = animCalls.filter((c) => c.options.duration === T.move);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.keyframes[1].transform).toBe('translate(0px, 0px)');
    expect(moves.some((m) => m.el === shotOf(5))).toBe(true);
  });

  test('only the parts on or near screen travel; the rest of a long site just takes its place', async () => {
    setupPage(30);
    open(1);
    settleOpen();
    animCalls = [];
    deleteOf(1).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    const moved = (id: number) => animCalls.some((c) => c.el === shotOf(id) && c.options.duration === T.move);
    expect(moved(2)).toBe(true); // on screen
    expect(moved(30)).toBe(false); // far below
    const layout = expectedLayout(site.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== 1) })));
    expect(shotOf(30).style.top).toBe(`${layout.notes.get(30)!.shot.y}px`);
  });

  test('a click on a delete deletes, without scrolling the view first; the scroll position stays', async () => {
    setup();
    open(3);
    settleOpen();
    scroller().scrollTop = 240;
    // Chrome focuses a button on pointerdown; that focus must not scroll it
    // into view, or the button moves out from under the pointer.
    const del = deleteOf(7);
    del.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    del.focus();
    expect(scroller().scrollTop).toBe(240);
    del.click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(q('.xp-note[data-item-id="7"]')).toBeNull();
    // The focus the view moves on to the next delete is quiet too.
    expect(shadow().activeElement).toBe(deleteOf(8));
    expect(scroller().scrollTop).toBe(240);
  });

  test('keyboard focus still brings a note into view', () => {
    setup();
    open(3);
    settleOpen();
    scroller().scrollTop = 0;
    keydown(exitBtn(), 'Shift');
    deleteOf(8).focus();
    expect(scroller().scrollTop).toBeGreaterThan(0);
  });

  test('focus moves on to the next note\'s delete', async () => {
    setup();
    open(3);
    settleOpen();
    deleteOf(5).focus();
    deleteOf(5).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(shadow().activeElement).toBe(deleteOf(6));
  });

  test('a page\'s last note takes its heading with it', async () => {
    setup([
      { normalisedUrl: BLOG, editedTitle: null, items: [makeItem(1, BLOG)] },
      { normalisedUrl: PRICING, editedTitle: null, items: [makeItem(2)] },
    ]);
    open(2);
    settleOpen();
    deleteOf(1).click();
    expect(animCalls.some((c) => c.el === heading(BLOG) && c.keyframes[1]?.opacity === '0')).toBe(true);
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(q(`.xp-page[data-page-url="${BLOG}"]`)).toBeNull();
    expect(qa('.xp-page-group')).toHaveLength(1);
  });

  test('the site\'s last note collapses the view to the empty list, focus on "add note"', async () => {
    setupPage(1);
    const cbs = open(1);
    settleOpen();
    deleteOf(1).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(cbs.onClosed).toHaveBeenCalledWith(null);
    expect(shadow().activeElement).toBe(q('.btn-add'));
    expect(q('.empty-state')!.hidden).toBe(false);
  });

  test('a failed delete restores the note with an inline error', async () => {
    setup();
    open(3, makeCallbacks({ onDelete: jest.fn().mockResolvedValue(false) }));
    settleOpen();
    deleteOf(3).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    expect(note(3)).not.toBeNull();
    expect(statusOf(3).textContent).toBe(DELETE_ERROR_MESSAGE);
    expect(nums()).toEqual(['#1', '#2', '#3', '#1', '#2', '#3', '#1', '#2']);
  });

  test('a delete during the expand does not strand the view in "opening"', async () => {
    setup();
    stubRect(qa('.thumbnail-image-wrap')[1], { left: 740, top: 344, width: 267, height: 100 });
    open(5);
    deleteOf(3).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.expandSettle + T.move);
    expect(wrapper()!.dataset.state).toBe('open');
    expect(qa('.xp-card')).toHaveLength(0);
  });

  test('closing after a delete hands the list back renumbered', async () => {
    setup();
    open(5);
    settleOpen();
    deleteOf(3).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    exitBtn().click();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(qa('button.thumbnail').map((b) => b.dataset.itemId)).toEqual(['5', '6']);
    expect(qa('.thumbnail-badge').map((b) => b.textContent)).toEqual(['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// Page names
// ---------------------------------------------------------------------------

describe('delete all, in the top bar', () => {
  const da = () => q<HTMLButtonElement>('.xp-delete-all')!;
  const confirmBox = () => q<HTMLElement>('.xp-confirm')!;
  const yes = () => q<HTMLButtonElement>('.xp-confirm-btn.is-danger')!;
  const cancel = () => q<HTMLButtonElement>('.xp-confirm-btn:not(.is-danger)')!;
  const box = () => q<HTMLElement>('.xp-delete-all-group')!;
  /** The box shows the question (its face), which takes focus and clicks;
   *  the button's face is inert, and the other way round. */
  const asking = () => {
    const on = box().dataset.face === 'confirm';
    // The attribute itself: jsdom has no HTMLElement.inert, and it is what
    // the browser (and tooltip.ts's observer) acts on.
    expect(confirmBox().hasAttribute('inert')).toBe(!on);
    expect(da().hasAttribute('inert')).toBe(on);
    return on;
  };
  const css = () => q('style')!.textContent!;
  /** The rule whose selector is exactly `sel`, on a line of its own. */
  const rule = (sel: string) => {
    const at = css().indexOf(`\n  ${sel} {`);
    return css().slice(at, css().indexOf('}', at));
  };

  test('left of the exit button: "delete all" with the note delete\'s trash glyph, in the menu item\'s danger ink', () => {
    setup();
    open(3);
    const button = da();
    expect(button.textContent).toBe(DELETE_ALL_LABEL);
    expect(button.getAttribute('aria-label')).toBe('delete all notes on this website');
    expect(button.dataset.tip).toBe('delete all notes on this website');
    expect(button.querySelector('svg')!.innerHTML).toBe(deleteOf(3).querySelector('svg')!.innerHTML);
    expect(rule('.xp-delete-all')).toMatch(/color: var\(--sal-danger\);/);
    expect(rule('.action-menu-item.is-danger')).toMatch(/color: var\(--sal-danger\);/);
    // In the tools, before the exit button in the DOM and in Tab order.
    expect(q('.xp-tools')!.contains(button)).toBe(true);
    expect(button.compareDocumentPosition(exitBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(asking()).toBe(false);
  });

  test('the docked action row\'s gap from exit, and a tighter one between the question\'s two buttons', () => {
    setup();
    open(3);
    // 16 (margin) + 36 (exit) + 6: the tools end export's gap to "more
    // options" (sidebarMetrics.EXPORT_GROUP_GAP_PX) left of exit.
    expect(rule('.xp-tools')).toMatch(/right: 58px;/);
    expect(rule('.xp-confirm-actions')).toMatch(/gap: 4px;/);
  });

  test('"yes, delete all" is bordered like cancel, in a danger tint', () => {
    setup();
    open(3);
    expect(rule('.xp-confirm-btn.is-danger')).toMatch(/border-color: var\(--sal-danger-hover\);/);
    expect(rule('.xp-confirm-btn.is-danger:hover')).toMatch(/border-color: var\(--sal-danger-press\);/);
  });

  test('one box for both faces: the exit button\'s height, fill, border and radius', () => {
    setup();
    open(3);
    const r = rule('.xp-delete-all-group');
    expect(r).toMatch(/height: 36px;/);
    expect(r).toMatch(/background: var\(--sal-surface\);/);
    expect(r).toMatch(/border: 1px solid var\(--sal-line\);/);
    expect(r).toMatch(/border-radius: var\(--sal-radius-md\);/);
    expect(r).toMatch(/justify-content: flex-end;/);
    // The answers sit 3px inside it: 36 - 2 (border) - 6.
    expect(rule('.xp-confirm-btn')).toMatch(/height: 28px;/);
  });

  test('clicking it asks in place — "confirm?", then "yes, delete all" and "cancel" — with focus on cancel', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    da().click();
    expect(asking()).toBe(true);
    expect(da().hasAttribute('inert')).toBe(true);
    expect(q('.xp-confirm-text')!.textContent).toBe('confirm?');
    expect([yes().textContent, cancel().textContent]).toEqual(['yes, delete all', 'cancel']);
    // Side by side, the confirming one first, in the menu question's order.
    expect(yes().nextElementSibling).toBe(cancel());
    expect(shadow().activeElement).toBe(cancel());
    // No separate box, nothing deleted yet.
    expect(q('.action-menu-confirm:not([hidden])')).toBeNull();
    expect(cbs.onDeleteAll).not.toHaveBeenCalled();
  });

  test('the question is announced as the menu\'s is: an alertdialog named by "confirm?", described by what it does', () => {
    setup();
    open(3);
    settleOpen();
    da().click();
    const box = confirmBox();
    expect(box.getAttribute('role')).toBe('alertdialog');
    const label = shadow().getElementById(box.getAttribute('aria-labelledby')!)!;
    const desc = shadow().getElementById(box.getAttribute('aria-describedby')!)!;
    expect(label.textContent).toBe('confirm?');
    expect(desc.textContent).toBe('delete all notes on this website');
    // For AT only: visually hidden, out of the row's flow.
    expect(desc.classList.contains('sr-only')).toBe(true);
    expect(box.contains(desc) && box.contains(cancel())).toBe(true);
  });

  test('cancel puts the button back, focused', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    da().click();
    cancel().click();
    expect(asking()).toBe(false);
    expect(da().hasAttribute('inert')).toBe(false);
    expect(shadow().activeElement).toBe(da());
    expect(cbs.onDeleteAll).not.toHaveBeenCalled();
  });

  test('Esc cancels the question rather than closing the view', () => {
    setup();
    open(3);
    settleOpen();
    da().click();
    keydown(cancel(), 'Escape');
    expect(asking()).toBe(false);
    expect(shadow().activeElement).toBe(da());
    expect(wrapper()!.dataset.state).toBe('open');
    // The next Esc closes, as ever.
    keydown(da(), 'Escape');
    expect(wrapper()!.dataset.state).toBe('closing');
  });

  test('a press elsewhere, or focus moving off it, puts the button back', () => {
    setup();
    open(3);
    settleOpen();
    da().click();
    textareaOf(5).dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(asking()).toBe(false);
    expect(wrapper()!.dataset.state).toBe('open');
    da().click();
    textareaOf(6).focus();
    expect(asking()).toBe(false);
    expect(shadow().activeElement).toBe(textareaOf(6));
    // A press on the question itself keeps it — its answers, or the box's
    // own border between them.
    da().click();
    yes().dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(asking()).toBe(true);
    box().dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(asking()).toBe(true);
  });

  test('from the keyboard: Enter asks, Tab moves between the answers, Enter on yes deletes', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    da().focus();
    // Native activation of a focused button is a click.
    da().click();
    expect(shadow().activeElement).toBe(cancel());
    // Tab on to exit leaves the question, which goes back to the button...
    keydown(cancel(), 'Tab');
    expect(shadow().activeElement).toBe(exitBtn());
    expect(asking()).toBe(false);
    keydown(exitBtn(), 'Tab', { shiftKey: true });
    expect(shadow().activeElement).toBe(da());
    // ...and Shift+Tab within it moves between the answers.
    da().click();
    keydown(cancel(), 'Tab', { shiftKey: true });
    expect(shadow().activeElement).toBe(yes());
    expect(asking()).toBe(true);
    yes().click();
    expect(cbs.onDeleteAll).toHaveBeenCalledTimes(1);
  });

  test('the box morphs between the faces\' widths on the right edge, the content crossfading: out, then in', () => {
    setup();
    open(3);
    settleOpen();
    stubRect(box(), { left: 600, top: 16, width: 104, height: 36 });
    // Laid out for the question, the box is the question's width.
    const natural = () => (box().dataset.face === 'confirm' ? 245 : 104);
    box().getBoundingClientRect = () => ({ width: natural(), height: 36 }) as DOMRect;
    animCalls = [];
    da().click();
    const width = animCalls.find((c) => c.el === box() && 'width' in c.keyframes[0])!;
    expect([width.keyframes[0].width, width.keyframes[1].width]).toEqual(['104px', '245px']);
    expect(width.options.duration).toBe(T.askMorph);
    expect(width.options.easing).toBe(STD.css);
    const out = animCalls.find((c) => c.el === da() && 'opacity' in c.keyframes[0])!;
    const into = animCalls.find((c) => c.el === confirmBox() && 'opacity' in c.keyframes[0])!;
    expect([out.keyframes[1].opacity, out.options.duration, out.options.easing]).toEqual(['0', T.askOut, ACC.css]);
    expect([into.keyframes[1].opacity, into.options.duration, into.options.delay]).toEqual(['1', T.askIn, T.askInDelay]);
    // Out, then in, both done with the morph.
    expect(T.askInDelay).toBeLessThan(T.askOut + 1);
    expect(T.askInDelay + T.askIn).toBe(T.askMorph);
    // The same as the "more options" menu's morph into its question.
    expect(T.askMorph).toBe(200);
  });

  test('a reversal mid-morph turns round from the width it had reached', () => {
    setup();
    open(3);
    settleOpen();
    const natural = () => (box().dataset.face === 'confirm' ? 245 : 104);
    box().getBoundingClientRect = () => ({ width: natural(), height: 36 }) as DOMRect;
    da().click();
    jest.advanceTimersByTime(T.askMorph / 2);
    animCalls = [];
    keydown(cancel(), 'Escape');
    const back = animCalls.find((c) => c.el === box() && 'width' in c.keyframes[0])!;
    const from = parseFloat(back.keyframes[0].width as string);
    expect(from).toBeGreaterThan(104);
    expect(from).toBeLessThan(245);
    expect(back.keyframes[1].width).toBe('104px');
    // The faces turn round from where their fades are too.
    const fadeIn = animCalls.find((c) => c.el === da() && 'opacity' in c.keyframes[0])!;
    expect(fadeIn.keyframes[1].opacity).toBe('1');
    expect(shadow().activeElement).toBe(da());
  });

  test('reduced motion: a crossfade only, no size morph', () => {
    reducedMotion = true;
    setup();
    open(3);
    settleOpen();
    box().getBoundingClientRect = () => ({ width: box().dataset.face === 'confirm' ? 245 : 104, height: 36 }) as DOMRect;
    animCalls = [];
    da().click();
    expect(animCalls.some((c) => c.el === box() && 'width' in c.keyframes[0])).toBe(false);
    const into = animCalls.find((c) => c.el === confirmBox() && 'opacity' in c.keyframes[0])!;
    expect(into.options.duration).toBe(T.rdAskFade);
    expect(asking()).toBe(true);
  });

  test('Tab order starts in the top bar: delete all, exit, then the pages', () => {
    setup();
    open(3);
    settleOpen();
    exitBtn().focus();
    keydown(exitBtn(), 'Tab', { shiftKey: true });
    expect(shadow().activeElement).toBe(da());
  });

  test('confirming deletes the whole site and closes onto the empty list, every note fading, none morphing', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    da().click();
    animCalls = [];
    yes().click();
    expect(cbs.onDeleteAll).toHaveBeenCalledTimes(1);
    await flush();
    expect(wrapper()!.dataset.state).toBe('closing');
    // Nothing left in the list to land on: no clone.
    expect(qa('.xp-card')).toHaveLength(0);
    expect(q('.empty-state')!.hidden).toBe(false);
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(cbs.onClosed).toHaveBeenCalledWith(null);
    expect(shadow().activeElement).toBe(q('.btn-add'));
    expect(cbs.onDelete).not.toHaveBeenCalled();
  });

  test('an edit waiting on its debounce is dropped, not saved against the deleted notes', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(5), 'about to be deleted');
    da().click();
    yes().click();
    await flush();
    jest.advanceTimersByTime(T.autosave + T.collapseSettle);
    await flush();
    expect(cbs.onSaveNote).not.toHaveBeenCalled();
    expect(q('.notif:not([hidden])')).toBeNull();
  });

  test('allowed while a note is empty', async () => {
    setup();
    const cbs = open(3);
    settleOpen();
    typeInto(textareaOf(5), '');
    expect(exitBtn().click()).toBeUndefined();
    expect(wrapper()!.dataset.state).toBe('open'); // the lock holds exit
    da().click();
    yes().click();
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(cbs.onClosed).toHaveBeenCalledWith(null);
  });

  test('a failure puts the button back, focused, and says so in the top bar; the view stays', async () => {
    setup();
    open(3, makeCallbacks({ onDeleteAll: jest.fn().mockResolvedValue(false) }));
    settleOpen();
    // The live region is there, empty, before anything goes wrong...
    const region = q('.xp-notice');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');
    da().click();
    yes().click();
    await flush();
    expect(wrapper()!.dataset.state).toBe('open');
    expect(asking()).toBe(false);
    expect(shadow().activeElement).toBe(da());
    // ...and the failure is a change to it, which is what gets announced.
    const notice = q('.xp-notice')!;
    expect(notice).toBe(region);
    expect(notice.textContent).toBe(DELETE_ALL_FAILED_MESSAGE);
    expect(notice.getAttribute('role')).toBe('status');
    expect(qa('.xp-note')).toHaveLength(8);
  });

  /** Open with delete all held in flight; `settle(ok)` answers it. */
  function inFlight(extra: Partial<EnlargedViewCallbacks> = {}) {
    let resolve!: (ok: boolean) => void;
    setup();
    const cbs = open(3, makeCallbacks({ onDeleteAll: jest.fn(() => new Promise<boolean>((r) => (resolve = r))), ...extra }));
    settleOpen();
    return { cbs, start: () => (da().click(), yes().click()), settle: async (ok: boolean) => (resolve(ok), await flush()) };
  }

  test('with a note emptied, Esc or exit while it runs neither trips the empty-note lock nor moves focus', async () => {
    for (const ask of [() => keydown(yes(), 'Escape'), () => exitBtn().click()]) {
      const f = inFlight();
      typeInto(textareaOf(5), '');
      f.start();
      const focused = shadow().activeElement;
      expect(confirmBox().contains(focused)).toBe(true);
      animCalls = [];
      ask();
      // Parked, as for a delete: no shake, focus not pulled to the empty note.
      expect(wrapper()!.dataset.state).toBe('open');
      expect(shadow().activeElement).toBe(focused);
      expect(animCalls.some((c) => c.el === note(5) && 'transform' in c.keyframes[0])).toBe(false);
      await f.settle(true);
      expect(wrapper()!.dataset.state).toBe('closing');
      jest.advanceTimersByTime(T.collapseSettle);
      sidebar.destroySidebar();
    }
  });

  test('with a note emptied, a collapse parked behind a failed delete all still meets the lock', async () => {
    const f = inFlight();
    typeInto(textareaOf(5), '');
    f.start();
    keydown(yes(), 'Escape');
    await f.settle(false);
    expect(wrapper()!.dataset.state).toBe('open');
    expect(shadow().activeElement).toBe(textareaOf(5));
  });

  test('a note\'s delete that fails behind a confirmed delete all does not come back mid-collapse', async () => {
    // The note's DELETE_ITEM queues behind DELETE_DOMAIN_DATA in the worker,
    // so it answers (NOT_FOUND) after the site delete has gone through.
    let answerDelete!: (ok: boolean) => void;
    const f = inFlight({ onDelete: jest.fn(() => new Promise<boolean>((r) => (answerDelete = r))) });
    f.start();
    deleteOf(5).click();
    jest.advanceTimersByTime(T.deleteStep);
    await f.settle(true);
    expect(wrapper()!.dataset.state).toBe('closing');
    animCalls = [];
    answerDelete(false);
    await flush();
    expect(statusOf(5).textContent).not.toBe(DELETE_ERROR_MESSAGE);
    expect(animCalls.some((c) => c.el === note(5) && c.keyframes[1]?.opacity === '1')).toBe(false);
  });

  test('a failure leaves focus where the user moved it meanwhile; still on the question, it goes back to the button', async () => {
    let f = inFlight();
    f.start();
    textareaOf(6).focus();
    await f.settle(false);
    expect(shadow().activeElement).toBe(textareaOf(6));
    sidebar.destroySidebar();
    f = inFlight();
    f.start();
    await f.settle(false);
    expect(shadow().activeElement).toBe(da());
  });

  test('a forced close while it runs does not save drafts against notes about to be gone', async () => {
    const f = inFlight();
    typeInto(textareaOf(5), 'typed, not yet saved');
    f.start();
    sidebar.collapseEnlargedView({ force: true });
    await f.settle(true);
    jest.advanceTimersByTime(T.autosave * 2);
    await flush();
    expect(f.cbs.onSaveNote).not.toHaveBeenCalled();
    expect(q('.notif:not([hidden])')).toBeNull();
  });

  test('a collapse asked for while it runs waits for the outcome', async () => {
    let resolve!: (ok: boolean) => void;
    setup();
    const cbs = open(3, makeCallbacks({ onDeleteAll: jest.fn(() => new Promise<boolean>((r) => (resolve = r))) }));
    settleOpen();
    da().click();
    yes().click();
    // The answers stay, and say they are busy, without dropping focus.
    expect(yes().getAttribute('aria-disabled')).toBe('true');
    yes().click();
    expect(cbs.onDeleteAll).toHaveBeenCalledTimes(1);
    keydown(yes(), 'Escape');
    expect(wrapper()!.dataset.state).toBe('open');
    resolve(false);
    await flush();
    expect(wrapper()!.dataset.state).toBe('closing');
  });
});

describe('renaming a page', () => {
  const nameOf = (url: string) => heading(url).querySelector('.xp-page-name')!.textContent;
  const editBtn = (url: string) => heading(url).querySelector<HTMLButtonElement>('.xp-page-edit')!;
  const input = (url: string) => heading(url).querySelector<HTMLInputElement>('.xp-page-input')!;

  test('the pencil swaps the name for a field holding it, with save and cancel beside it', () => {
    setup();
    open(3);
    settleOpen();
    expect(editBtn(PRICING).getAttribute('aria-label')).toBe('edit page name: Pricing');
    editBtn(PRICING).click();
    expect(heading(PRICING).querySelector<HTMLElement>('.xp-page-editor')!.hidden).toBe(false);
    expect(heading(PRICING).querySelector<HTMLElement>('.xp-page-name')!.hidden).toBe(true);
    expect(input(PRICING).value).toBe('Pricing');
    expect(shadow().activeElement).toBe(input(PRICING));
    expect(heading(PRICING).querySelector('.xp-page-save')!.getAttribute('aria-label')).toBe('save page name');
    expect(heading(PRICING).querySelector('.xp-page-cancel')!.getAttribute('aria-label')).toBe('cancel');
  });

  test('Enter saves it per page, the notes\' labels follow, and focus returns to the pencil', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), '  plans and prices  ');
    keydown(input(PRICING), 'Enter');
    expect(cbs.onSavePageTitle).toHaveBeenCalledWith(PRICING, 'plans and prices');
    expect(nameOf(PRICING)).toBe('plans and prices');
    expect(deleteOf(5).getAttribute('aria-label')).toBe('delete note #2 on plans and prices');
    expect(shadow().activeElement).toBe(editBtn(PRICING));
  });

  test('Esc cancels the rename — and only that: the view stays open', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'never mind');
    keydown(input(PRICING), 'Escape');
    expect(wrapper()!.dataset.state).toBe('open');
    expect(nameOf(PRICING)).toBe('Pricing');
    expect(cbs.onSavePageTitle).not.toHaveBeenCalled();
    keydown(editBtn(PRICING), 'Escape');
    expect(wrapper()!.dataset.state).toBe('closing');
  });

  test('✓ saves, × cancels', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    editBtn(BLOG).click();
    typeInto(input(BLOG), 'journal');
    heading(BLOG).querySelector<HTMLButtonElement>('.xp-page-save')!.click();
    expect(nameOf(BLOG)).toBe('journal');
    editBtn(BLOG).click();
    typeInto(input(BLOG), 'not this');
    heading(BLOG).querySelector<HTMLButtonElement>('.xp-page-cancel')!.click();
    expect(nameOf(BLOG)).toBe('journal');
    expect(cbs.onSavePageTitle).toHaveBeenCalledTimes(1);
  });

  test('an empty or whitespace-only name — or the default itself — restores the default', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    editBtn(ABOUT).click(); // edited: "team page"
    typeInto(input(ABOUT), '   ');
    keydown(input(ABOUT), 'Enter');
    expect(cbs.onSavePageTitle).toHaveBeenLastCalledWith(ABOUT, null);
    expect(nameOf(ABOUT)).toBe('About');
    editBtn(ABOUT).click();
    typeInto(input(ABOUT), 'us');
    keydown(input(ABOUT), 'Enter');
    editBtn(ABOUT).click();
    typeInto(input(ABOUT), 'About');
    keydown(input(ABOUT), 'Enter');
    expect(cbs.onSavePageTitle).toHaveBeenLastCalledWith(ABOUT, null);
  });

  test('a rename that does not stick goes back, with an error under the heading', async () => {
    setup();
    open(3, makeCallbacks({ onSavePageTitle: jest.fn().mockResolvedValue('failed') }));
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'plans');
    keydown(input(PRICING), 'Enter');
    expect(nameOf(PRICING)).toBe('plans');
    await flush();
    expect(nameOf(PRICING)).toBe('Pricing');
    expect(heading(PRICING).querySelector('.xp-page-status')!.textContent).toBe(PAGE_NAME_SAVE_ERROR_MESSAGE);
  });

  test('a page whose notes were deleted elsewhere says so — not "try again" — and keeps its name', async () => {
    setup();
    open(3, makeCallbacks({ onSavePageTitle: jest.fn().mockResolvedValue('no-notes') }));
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'plans');
    keydown(input(PRICING), 'Enter');
    await flush();
    expect(nameOf(PRICING)).toBe('Pricing');
    expect(heading(PRICING).querySelector('.xp-page-status')!.textContent).toBe(PAGE_HAS_NO_NOTES_MESSAGE);
  });

  test.each([
    ['failed', PAGE_NAME_SAVE_ERROR_MESSAGE],
    ['no-notes', PAGE_HAS_NO_NOTES_MESSAGE],
  ] as const)('a rename the collapse committed that comes back %p is said in the sidebar\'s banner', async (result, message) => {
    setup();
    open(3, makeCallbacks({ onSavePageTitle: jest.fn().mockResolvedValue(result) }));
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'plans');
    exitBtn().click();
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    expect(q('.notif')!.hidden).toBe(false);
    expect(q('.notif-text')!.textContent).toBe(message);
  });

  test('...and one that saved says nothing', async () => {
    setup();
    open(3);
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'plans');
    exitBtn().click();
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(q('.notif')!.hidden).toBe(true);
  });

  test('while the view is open a failed rename shows under its heading only, not in the banner', async () => {
    setup();
    open(3, makeCallbacks({ onSavePageTitle: jest.fn().mockResolvedValue('failed') }));
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'plans');
    keydown(input(PRICING), 'Enter');
    await flush();
    expect(q('.notif')!.hidden).toBe(true);
  });

  test('clicking away saves, as does closing the view mid-rename', () => {
    setup();
    const cbs = open(3);
    settleOpen();
    editBtn(PRICING).click();
    typeInto(input(PRICING), 'clicked away');
    textareaOf(3).focus();
    expect(cbs.onSavePageTitle).toHaveBeenLastCalledWith(PRICING, 'clicked away');
    editBtn(BLOG).click();
    typeInto(input(BLOG), 'closed mid-rename');
    sidebar.collapseEnlargedView({ immediate: true, force: true });
    expect(cbs.onSavePageTitle).toHaveBeenLastCalledWith(BLOG, 'closed mid-rename');
  });
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

describe('keyboard', () => {
  test('Tab moves through the controls in reading order, wrapping; Shift+Tab goes back', () => {
    setup([
      { normalisedUrl: BLOG, editedTitle: null, items: [makeItem(1, BLOG)] },
      { normalisedUrl: PRICING, editedTitle: null, items: [makeItem(2), makeItem(3)] },
    ]);
    open(2);
    settleOpen();
    q<HTMLElement>('.xp-delete-all')!.focus();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 10; i++) {
      const a = shadow().activeElement as HTMLElement;
      seen.push(a.className + (a.closest<HTMLElement>('.xp-note')?.dataset.itemId ?? a.closest<HTMLElement>('.xp-page')?.dataset.pageUrl?.slice(-4) ?? ''));
      keydown(a, 'Tab');
    }
    expect(seen).toEqual([
      'xp-delete-all',
      'xp-exit',
      'xp-page-editblog',
      'xp-note-delete1',
      'xp-note-input1',
      'xp-page-editcing',
      'xp-note-delete2',
      'xp-note-input2',
      'xp-note-delete3',
      'xp-note-input3',
    ]);
    expect(shadow().activeElement).toBe(q('.xp-delete-all'));
    keydown(q('.xp-delete-all')!, 'Tab', { shiftKey: true });
    expect(shadow().activeElement).toBe(textareaOf(3));
  });

  test('↑/↓ and the page keys scroll when focus is not in a text field', () => {
    setup();
    open(3);
    settleOpen();
    const start = scroller().scrollTop;
    exitBtn().focus();
    expect(keydown(exitBtn(), 'ArrowDown').defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(start + 64);
    keydown(exitBtn(), 'ArrowUp');
    expect(scroller().scrollTop).toBe(start);
    keydown(exitBtn(), 'Home');
    expect(scroller().scrollTop).toBe(0);
    // In a text area they move the caret instead.
    textareaOf(3).focus();
    const at = scroller().scrollTop;
    expect(keydown(textareaOf(3), 'ArrowDown').defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(at);
  });

  test('Enter/Space aimed outside the view, or auto-repeating on its buttons, are cancelled; text areas keep them', () => {
    setupPage(2);
    const onOpenItem = jest.fn();
    sidebar.initSidebar({ onAdd: () => {}, onExport: () => {}, onImport: () => {}, onImportFile: () => {}, onDeleteAll: () => {}, onClose: () => {}, onOpenItem });
    open(1);
    const listItem = q<HTMLButtonElement>('button.thumbnail[data-item-id="1"]')!;
    expect(keydown(listItem, 'Enter').defaultPrevented).toBe(true);
    expect(keydown(listItem, ' ').defaultPrevented).toBe(true);
    listItem.click();
    expect(onOpenItem).not.toHaveBeenCalled();
    // Held down from the list, it does not type into the note while opening.
    expect(keydown(textareaOf(1), 'Enter', { repeat: true }).defaultPrevented).toBe(true);
    settleOpen();
    expect(keydown(exitBtn(), 'Enter', { repeat: true }).defaultPrevented).toBe(true);
    expect(keydown(deleteOf(1), ' ', { repeat: true }).defaultPrevented).toBe(true);
    expect(keydown(exitBtn(), 'Enter').defaultPrevented).toBe(false);
    expect(keydown(textareaOf(1), 'Enter', { repeat: true }).defaultPrevented).toBe(false);
    expect(keydown(textareaOf(1), ' ', { repeat: true }).defaultPrevented).toBe(false);
  });

  test('Esc that ends an IME composition does not collapse the view', () => {
    setupPage(1);
    open(1);
    settleOpen();
    keydown(textareaOf(1), 'Escape', { isComposing: true });
    expect(wrapper()!.dataset.state).toBe('open');
    keydown(textareaOf(1), 'Escape');
    expect(wrapper()!.dataset.state).toBe('closing');
  });

  test('the exit button: a right-pointing chevron, top right, with its name and tooltip', () => {
    setupPage(1);
    open(1);
    // A simple "›" in the icon set's stroke language — it replaced v5 §U's
    // collapse-panel glyph (no panel outline, no divider).
    expect(exitBtn().querySelector('rect')).toBeNull();
    const d = [...exitBtn().querySelectorAll('path')].map((n) => n.getAttribute('d')).join(' ');
    expect(d).toBe('M9 6l6 6-6 6');
    const svg = exitBtn().querySelector('svg')!;
    expect([svg.getAttribute('viewBox'), svg.getAttribute('stroke-linecap'), svg.getAttribute('stroke-linejoin')]).toEqual(['0 0 24 24', 'round', 'round']);
    expect(exitBtn().querySelector('svg')!.getAttribute('stroke-width')).toBe('1.8');
    expect(exitBtn().getAttribute('aria-label')).toBe('exit enlarged view');
    expect(exitBtn().dataset.tip).toBe('exit enlarged view (esc)');
    // The old rail and carousel are gone.
    expect(q('.xp-rail, .xp-prev, .xp-next, .xp-title')).toBeNull();
  });

  test('§S: a note\'s delete uses the note list\'s trash glyph, the only one', () => {
    setupPage(1);
    const listDelete = q('.thumbnail-delete svg')!;
    open(1);
    const paths = (svg: Element) => [...svg.querySelectorAll('path')].map((n) => n.getAttribute('d'));
    expect(paths(deleteOf(1).querySelector('svg')!)).toEqual(paths(listDelete));
  });
});

// ---------------------------------------------------------------------------
// The host page does not scroll (design spec v5 §T)
// ---------------------------------------------------------------------------

describe('v5 §T — the page does not scroll while the view is open', () => {
  function fire(target: EventTarget, type: string, init: EventInit = {}): Event {
    const base = { bubbles: true, composed: true, cancelable: true, ...init };
    const e = type === 'wheel' ? new WheelEvent(type, base) : new Event(type, base);
    target.dispatchEvent(e);
    return e;
  }
  const pageScrolls = () => !fire(document.body, 'wheel').defaultPrevented;
  function makeScrollable(el: HTMLElement, opts: { scrollTop?: number; room?: number } = {}): void {
    const room = opts.room ?? 200;
    for (const [prop, value] of [
      ['scrollHeight', 96 + room],
      ['clientHeight', 96],
      ['scrollWidth', 0],
      ['clientWidth', 0],
    ] as const) {
      Object.defineProperty(el, prop, { value, configurable: true });
    }
    Object.defineProperty(el, 'scrollTop', { value: opts.scrollTop ?? 0, writable: true, configurable: true });
    // jsdom does not compute styles from a shadow root's sheet; Chrome sees
    // .xp-scroll's overflow-y: auto there.
    if (!(el instanceof HTMLTextAreaElement)) el.style.overflowY = 'auto';
  }

  test('wheel, touch and the scrolling keys are cancelled on the page; nothing about its layout is touched', () => {
    setupPage(2);
    const htmlEl = document.documentElement;
    const before = [htmlEl.style.overflow, document.body.style.overflow];
    open(1);
    settleOpen();
    expect(fire(document.body, 'wheel').defaultPrevented).toBe(true);
    expect(fire(document.body, 'touchmove').defaultPrevented).toBe(true);
    for (const key of [' ', 'PageDown', 'End', 'ArrowDown']) {
      expect(keydown(document.body, key).defaultPrevented).toBe(true);
    }
    expect([htmlEl.style.overflow, document.body.style.overflow]).toEqual(before);
  });

  test('the view\'s own scroller and text areas keep working; at their ends nothing is handed to the page', () => {
    setup();
    open(3);
    settleOpen();
    makeScrollable(scroller(), { scrollTop: 50 });
    expect(fire(shotOf(3), 'wheel', { deltaY: 40 } as WheelEventInit).defaultPrevented).toBe(false);
    expect(fire(heading(PRICING), 'wheel', { deltaY: -40 } as WheelEventInit).defaultPrevented).toBe(false);
    // A text area with room scrolls itself; at its end the wheel goes on to
    // the scroller (not stopped on a page of text areas) — and only when the
    // scroller is at its end too does the lock cancel it.
    makeScrollable(textareaOf(3), { scrollTop: 200, room: 200 });
    expect(fire(textareaOf(3), 'wheel', { deltaY: 120 } as WheelEventInit).defaultPrevented).toBe(false);
    makeScrollable(scroller(), { scrollTop: 200, room: 200 });
    expect(fire(textareaOf(3), 'wheel', { deltaY: 120 } as WheelEventInit).defaultPrevented).toBe(true);
    // Outside the scroller nothing scrolls.
    expect(fire(q('.xp-scrim')!, 'wheel', { deltaY: 120 } as WheelEventInit).defaultPrevented).toBe(true);
    expect(fire(exitBtn(), 'wheel', { deltaY: 120 } as WheelEventInit).defaultPrevented).toBe(true);
  });

  test('Space on a focused button is its click, never cancelled — even when nothing can scroll', () => {
    setupPage(2); // two notes: nothing to scroll
    open(1);
    settleOpen();
    for (const el of [deleteOf(2), exitBtn(), heading(PRICING).querySelector<HTMLElement>('.xp-page-edit')!]) {
      el.focus();
      expect(keydown(el, ' ').defaultPrevented).toBe(false);
    }
    // The page keys from a button still are, and Space on the page itself.
    expect(keydown(exitBtn(), 'PageDown').defaultPrevented).toBe(true);
    expect(keydown(document.body, ' ').defaultPrevented).toBe(true);
  });

  test('the lock sees keys typed inside the view: it is installed before the keyboard isolation', () => {
    // The isolation stops in-host keys at window capture (stopImmediatePropagation),
    // so a lock registered after it would never see them. ArrowRight is a key the
    // view itself does not handle, so only the lock can cancel it.
    setupPage(2);
    open(1);
    settleOpen();
    exitBtn().focus();
    expect(keydown(exitBtn(), 'ArrowRight').defaultPrevented).toBe(true);
  });

  test('the scroller holds still while a morph is in flight', () => {
    setup();
    open(3);
    expect(fire(scroller(), 'wheel', { deltaY: 40 } as WheelEventInit).defaultPrevented).toBe(true);
    settleOpen();
    makeScrollable(scroller(), { scrollTop: 50 });
    expect(fire(scroller(), 'wheel', { deltaY: 40 } as WheelEventInit).defaultPrevented).toBe(false);
  });

  test.each([
    ['the exit button', () => { exitBtn().click(); jest.advanceTimersByTime(T.collapseSettle); }],
    ['esc', () => { keydown(textareaOf(1), 'Escape'); jest.advanceTimersByTime(T.collapseSettle); }],
    ['an immediate collapse (add mode)', () => sidebar.collapseEnlargedView({ immediate: true })],
    ['a forced close (SPA navigation)', () => sidebar.collapseEnlargedView({ immediate: true, force: true })],
    ['the sidebar closing', () => sidebar.closeSidebar()],
    ['a teardown', () => sidebar.destroySidebar()],
  ])('%s releases the lock', (_name, exit) => {
    setupPage(2);
    open(1);
    settleOpen();
    expect(pageScrolls()).toBe(false);
    exit();
    expect(pageScrolls()).toBe(true);
  });

  test('deleting the last note collapses and still releases the lock', async () => {
    setupPage(1);
    open(1);
    settleOpen();
    deleteOf(1).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    jest.advanceTimersByTime(T.collapseSettle);
    expect(wrapper()).toBeNull();
    expect(pageScrolls()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reduced motion, lifecycle
// ---------------------------------------------------------------------------

describe('reduced motion', () => {
  test('no clone, no travel: geometry jumps and only opacity animates, at roughly halved durations', async () => {
    reducedMotion = true;
    installMatchMedia();
    setup();
    stubRect(qa('.thumbnail-image-wrap')[0], { left: 740, top: 150, width: 267, height: 100 });
    open(3);
    expect(qa('.xp-card')).toHaveLength(0);
    for (const c of animCalls) {
      const props = Object.keys(c.keyframes[0]).filter((k) => k !== 'offset');
      expect(props).toEqual(['opacity']);
      expect(c.options.duration).toBeLessThanOrEqual(T.rdStageIn);
    }
    jest.advanceTimersByTime(T.rdExpandSettle);
    expect(wrapper()!.dataset.state).toBe('open');

    animCalls = [];
    deleteOf(3).click();
    jest.advanceTimersByTime(T.rdDeleteOut);
    await flush();
    expect(animCalls.every((c) => Object.keys(c.keyframes[0]).every((k) => k === 'opacity' || k === 'offset'))).toBe(true);
    expect(textareaOf(5).classList.contains('is-error')).toBe(false);
  });
});

describe('lifecycle', () => {
  test('a list refresh while open is held off; the view hands the list back on close', async () => {
    setup();
    open(5);
    settleOpen();
    sidebar.setThumbnails(site.pages[1].items);
    deleteOf(3).click();
    jest.advanceTimersByTime(T.deleteStep);
    await flush();
    sidebar.collapseEnlargedView({ immediate: true });
    expect(qa('button.thumbnail').map((b) => b.dataset.itemId)).toEqual(['5', '6']);
  });

  test('closing the sidebar tears the view down', () => {
    setupPage(2);
    const cbs = open(1);
    sidebar.closeSidebar();
    expect(wrapper()).toBeNull();
    expect(cbs.onClosed).toHaveBeenCalled();
  });

  test('destroy leaves no DOM, timers or keyboard isolation behind', () => {
    setup();
    open(3);
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

  test('a narrower window re-lays the site out: fewer notes per row, the panel resized at once', () => {
    setup();
    open(3);
    settleOpen();
    const before = q('.xp-bg')!.style.width;
    const orig = window.innerWidth;
    (window as any).innerWidth = 700;
    window.dispatchEvent(new Event('resize'));
    jest.advanceTimersByTime(20); // coalesced into one frame
    expect(q('.xp-bg')!.style.width).not.toBe(before);
    expect(q('.xp-bg')!.style.width).toBe(`${panelWidthFor(700, sidebar.getSidebarWidth())}px`);
    const layout = expectedLayout();
    expect(shotOf(6).style.top).toBe(`${layout.notes.get(6)!.shot.y}px`);
    // At 560px the panel holds one default note per row.
    expect(new Set(layout.rows.map((r) => r.ids.length))).toEqual(new Set([1]));
    (window as any).innerWidth = orig;
  });
});

// Pin for splitting the class (architecture review A4): every way the view
// ends leaves no window/document/matchMedia listener, observer or key
// handler of its own behind.
describe('the view leaves nothing behind', () => {
  type Reg = [EventTarget, string, EventListenerOrEventListenerObject, boolean];
  let live: Reg[];
  let restore: Array<() => void>;
  let observers: Array<{ disconnected: boolean; observed: number }>;
  let mqlListeners: number;

  beforeEach(() => {
    live = [];
    restore = [];
    observers = [];
    mqlListeners = 0;
    const capture = (o: unknown) => (typeof o === 'boolean' ? o : !!(o as AddEventListenerOptions | undefined)?.capture);
    for (const target of [window, document] as EventTarget[]) {
      const add = target.addEventListener;
      const remove = target.removeEventListener;
      target.addEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
        if (l) live.push([target, type, l, capture(o)]);
        return add.call(this, type, l, o);
      } as typeof target.addEventListener;
      target.removeEventListener = function (this: EventTarget, type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
        live = live.filter(([t, ty, ll, c]) => !(t === target && ty === type && ll === l && c === capture(o)));
        return remove.call(this, type, l, o);
      } as typeof target.removeEventListener;
      restore.push(() => {
        target.addEventListener = add;
        target.removeEventListener = remove;
      });
    }
    (window as any).matchMedia = jest.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: jest.fn(() => {
        mqlListeners++;
      }),
      removeEventListener: jest.fn(() => {
        mqlListeners--;
      }),
    }));
    (window as any).IntersectionObserver = class {
      record = { disconnected: false, observed: 0 };
      constructor() {
        observers.push(this.record);
      }
      observe() {
        this.record.observed++;
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
    };
  });

  afterEach(() => {
    for (const r of restore) r();
  });

  test.each([
    ['the exit button', () => { exitBtn().click(); jest.advanceTimersByTime(T.collapseSettle); }],
    ['esc', () => { keydown(textareaOf(1), 'Escape'); jest.advanceTimersByTime(T.collapseSettle); }],
    ['an immediate collapse', () => sidebar.collapseEnlargedView({ immediate: true })],
    ['a forced close', () => sidebar.collapseEnlargedView({ immediate: true, force: true })],
    ['the sidebar closing', () => sidebar.closeSidebar()],
  ])('%s', async (name, end) => {
    setupPage(3);
    const before = live.length;
    const mqlBefore = mqlListeners;
    open(1);
    settleOpen();
    expect(live.length).toBeGreaterThan(before);
    expect(observers.length).toBe(1);
    end();
    await flush();
    expect(sidebar.isEnlargedViewOpen()).toBe(false);
    // Only what the sidebar itself had before the view opened is left (the
    // sidebar closing also drops its own key isolation and the list's dock
    // motion, so at most that).
    if (name === 'the sidebar closing') {
      expect(live.length).toBeLessThanOrEqual(before);
      expect(mqlListeners).toBeLessThanOrEqual(mqlBefore);
    } else {
      expect(live.length).toBe(before);
      expect(mqlListeners).toBe(mqlBefore);
    }
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});
