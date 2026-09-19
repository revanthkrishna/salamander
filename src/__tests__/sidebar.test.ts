// Phase 3: sidebar shell tests — DOM structure, open/close visibility, the
// page-resize strategy applied to <html> (its exact application, its
// re-assertion when a page wipes it, and its per-property restoration), the
// four header buttons' wiring, and the notification primitives carried over
// from the deleted toolbar.ts.
//
// jsdom has no layout engine, so these verify the *mechanism* — which inline
// declarations land on document.documentElement, how they are restored, what
// the observer does — not actual pixel reflow. Whether the shrink looks right
// on a real site is REQUIREMENTS §1.1/§3.1's manual check (DEVELOPMENT_PLAN.md
// Phase 3 asks for 5+ real sites), and Phase 10's Playwright suite.

import * as sidebar from '../sidebar';
import { FeedbackItem } from '../types';
import { _resetThemeStateForTests, setThemeMode } from '../theme';

function getHost(): HTMLElement | null {
  return document.getElementById('annotator-sidebar-host');
}

// sidebar.ts uses `attachShadow({ mode: 'closed' })`, so we can't query into it
// from outside at all — same as a real browser. Redefine attachShadow for this
// test file only to force 'open' mode so we can assert on the actual rendered
// buttons/empty-state, while the module code itself is untouched.
const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

function shadowRoot(): ShadowRoot {
  const host = getHost();
  if (!host || !host.shadowRoot) throw new Error('sidebar host/shadow root not found');
  return host.shadowRoot;
}

function makeCallbacks(): sidebar.SidebarCallbacks & {
  calls: { add: number; export: number; importFile: File[]; close: number; openItem: FeedbackItem[] };
} {
  const calls = { add: 0, export: 0, importFile: [] as File[], close: 0, openItem: [] as FeedbackItem[] };
  return {
    calls,
    onAdd: () => { calls.add++; },
    onExport: () => { calls.export++; },
    onImportFile: (file: File) => { calls.importFile.push(file); },
    onClose: () => { calls.close++; },
    onOpenItem: (item: FeedbackItem) => { calls.openItem.push(item); },
  };
}

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 1,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: 'looks off-centre on mobile',
    createdAt: '2026-01-01T00:00:00.000Z',
    selectionRect: { x: 0, y: 0, width: 100, height: 100 },
    viewport: { width: 1280, height: 800 },
    dpr: 1,
    screenshotKey: 'key-1',
    thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
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
        selectionRect: { x: 0, y: 0, width: 100, height: 100 },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    ...overrides,
  };
}

/** Let queued MutationObserver callbacks run. */
function flushObservers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const html = () => document.documentElement;

describe('sidebar shell', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    html().style.cssText = '';
    jest.useRealTimers();
    jest.restoreAllMocks();
    // theme.ts's mode/listener state is a module-level singleton independent
    // of the sidebar host's own lifecycle (see theme.test.ts) — reset it so
    // a theme change made in one test can't leak into the next.
    _resetThemeStateForTests();
  });

  // ── structure ────────────────────────────────────────────────────────────

  test('initSidebar builds a hidden panel host attached to <html>', () => {
    sidebar.initSidebar(makeCallbacks());

    const host = getHost();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(html());

    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(sidebar.isSidebarVisible()).toBe(false);
  });

  test('header holds the logo, wordmark, theme toggle and close (in that order)', () => {
    sidebar.initSidebar(makeCallbacks());
    const header = shadowRoot().querySelector('.header') as HTMLElement;
    expect(header.querySelector('.logo img')).not.toBeNull();
    expect(header.querySelector('.wordmark')?.textContent).toBe('salamander');

    const buttons = Array.from(header.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['theme: auto', 'close sidebar']);
  });

  test('action row holds add, export and import (in that order)', () => {
    sidebar.initSidebar(makeCallbacks());
    const buttons = Array.from(shadowRoot().querySelectorAll('.action-row button'));
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'add feedback',
      'export feedback',
      'import feedback',
    ]);
  });

  test('empty state text is exactly the lowercase copy from REQUIREMENTS §3.1', () => {
    sidebar.initSidebar(makeCallbacks());
    const empty = shadowRoot().querySelector('.empty-state') as HTMLElement;
    expect(empty.textContent).toBe('no feedback on this page yet');
    expect(empty.hidden).toBe(false);
  });

  test('initSidebar is idempotent: a second call does not create a second host', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.initSidebar(makeCallbacks());
    expect(html().querySelectorAll('#annotator-sidebar-host')).toHaveLength(1);
    expect(sidebar.isSidebarInitialised()).toBe(true);
  });

  // ── page resize ──────────────────────────────────────────────────────────

  test('openSidebar shrinks <html> with an important right margin and clipped overflow', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    const s = html().style;
    expect(s.getPropertyValue('margin-right')).toBe(`${sidebar.getSidebarWidth()}px`);
    expect(s.getPropertyValue('width')).toBe('auto');
    expect(s.getPropertyValue('overflow-x')).toBe('hidden');
    for (const prop of ['margin-right', 'width', 'min-width', 'overflow-x']) {
      expect(s.getPropertyPriority(prop)).toBe('important');
    }
    expect(sidebar._pageResizeStateForTests().applied).toBe(true);
  });

  test('the resize never touches box-sizing on <html>', () => {
    // Regression guard: the `html { box-sizing: border-box } * { box-sizing:
    // inherit }` reset is everywhere, so overriding the root's box-sizing
    // silently re-sizes every element on the page. The margin-based shrink
    // must not need it.
    html().style.setProperty('box-sizing', 'content-box');
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    expect(html().style.getPropertyValue('box-sizing')).toBe('content-box');
  });

  test('closeSidebar removes the resize and leaves unrelated inline style intact', () => {
    html().style.cssText = 'background-color: red;';
    sidebar.initSidebar(makeCallbacks());

    sidebar.openSidebar();
    expect(html().style.backgroundColor).toBe('red');

    sidebar.closeSidebar();
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    expect(html().style.getPropertyValue('width')).toBe('');
    expect(html().style.getPropertyValue('min-width')).toBe('');
    expect(html().style.getPropertyValue('overflow-x')).toBe('');
    expect(html().style.backgroundColor).toBe('red');
    expect(sidebar._pageResizeStateForTests().applied).toBe(false);
  });

  test('closeSidebar puts back a managed property the page had set itself, priority included', () => {
    html().style.setProperty('overflow-x', 'scroll', 'important');
    html().style.setProperty('margin-right', '12px');
    sidebar.initSidebar(makeCallbacks());

    sidebar.openSidebar();
    expect(html().style.getPropertyValue('overflow-x')).toBe('hidden');

    sidebar.closeSidebar();
    expect(html().style.getPropertyValue('overflow-x')).toBe('scroll');
    expect(html().style.getPropertyPriority('overflow-x')).toBe('important');
    expect(html().style.getPropertyValue('margin-right')).toBe('12px');
    expect(html().style.getPropertyPriority('margin-right')).toBe('');
  });

  test('closeSidebar keeps inline style the page added while the sidebar was open', () => {
    // The previous implementation restored a whole-cssText snapshot, which
    // silently reverted anything the page set on <html> in the meantime — a
    // scroll lock, a theme variable, a scroll-behaviour switch.
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    html().style.setProperty('overflow-y', 'hidden'); // page's own modal scroll lock
    html().style.setProperty('--page-theme', 'dark');

    sidebar.closeSidebar();
    expect(html().style.getPropertyValue('overflow-y')).toBe('hidden');
    expect(html().style.getPropertyValue('--page-theme')).toBe('dark');
  });

  test('opening twice in a row does not clobber the pre-open snapshot', () => {
    html().style.cssText = 'color: blue;';
    sidebar.initSidebar(makeCallbacks());

    sidebar.openSidebar();
    sidebar.openSidebar(); // second call must not re-snapshot our own values
    sidebar.closeSidebar();

    expect(html().style.getPropertyValue('width')).toBe('');
    expect(html().style.color).toBe('blue');
  });

  test('closing when never opened is a no-op on <html>', () => {
    html().style.cssText = 'color: teal;';
    sidebar.initSidebar(makeCallbacks());
    sidebar.closeSidebar();
    expect(html().style.cssText).toBe('color: teal;');
  });

  test('re-asserts the shrink when the page wipes <html>\'s inline style', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    expect(sidebar._pageResizeStateForTests().observing).toBe(true);

    // Exactly what a page doing `documentElement.style.cssText = '...'` does.
    html().style.cssText = 'scroll-behavior: smooth;';
    expect(html().style.getPropertyValue('margin-right')).toBe('');

    await flushObservers();

    expect(html().style.getPropertyValue('margin-right')).toBe(`${sidebar.getSidebarWidth()}px`);
    expect(html().style.getPropertyValue('overflow-x')).toBe('hidden');
    expect(html().style.getPropertyValue('scroll-behavior')).toBe('smooth');
    expect(sidebar._pageResizeStateForTests().reasserts).toBe(1);
  });

  test('the sidebar\'s own writes do not feed the re-assert counter', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    await flushObservers();
    expect(sidebar._pageResizeStateForTests().reasserts).toBe(0);
  });

  test('an unrelated inline-style change by the page does not trigger a re-assert', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    html().style.setProperty('background-color', 'rebeccapurple');
    await flushObservers();

    expect(sidebar._pageResizeStateForTests().reasserts).toBe(0);
    expect(html().style.getPropertyValue('margin-right')).toBe(`${sidebar.getSidebarWidth()}px`);
  });

  test('gives up re-asserting against a page that keeps fighting back', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    for (let i = 0; i < 60; i++) {
      html().style.cssText = '';
      await flushObservers();
    }

    const state = sidebar._pageResizeStateForTests();
    expect(state.reasserts).toBe(50);
    expect(state.observing).toBe(false);
    // Still recorded as applied, so closeSidebar() restores cleanly either way.
    expect(state.applied).toBe(true);
  });

  test('stops observing once the sidebar is closed', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    sidebar.closeSidebar();

    expect(sidebar._pageResizeStateForTests().observing).toBe(false);

    html().style.cssText = '';
    await flushObservers();
    expect(html().style.getPropertyValue('margin-right')).toBe('');
  });

  // ── page resize: the youtube-style "page fights back" defences ───────────

  test('injects a backstop stylesheet carrying the same !important shrink', () => {
    // Defence 1: a page wiping <html>'s style *attribute* cannot reach a
    // stylesheet, so the shrink survives with no un-shrunk frame at all.
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    const styleEl = document.getElementById('annotator-page-resize') as HTMLStyleElement;
    expect(styleEl).not.toBeNull();
    expect(styleEl.parentElement).toBe(document.head);
    const css = styleEl.textContent ?? '';
    expect(css).toContain(`margin-right: ${sidebar.getSidebarWidth()}px !important`);
    expect(css).toContain('width: auto !important');
    expect(css).toContain('overflow-x: hidden !important');
    expect(sidebar._pageResizeStateForTests().styleSheetAttached).toBe(true);
  });

  test('closeSidebar removes the backstop stylesheet', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    sidebar.closeSidebar();
    expect(document.getElementById('annotator-page-resize')).toBeNull();
  });

  test('re-attaches the backstop stylesheet if the page rips it out', async () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    document.getElementById('annotator-page-resize')!.remove();
    // The observer watches <html>'s style/class; a class flip is the signal a
    // page's own layout code just ran, which is when we re-check.
    html().classList.add('theater-mode');
    await flushObservers();

    expect(document.getElementById('annotator-page-resize')).not.toBeNull();
    html().classList.remove('theater-mode');
  });

  test('publishes the live width as a custom property on <html> for modal.ts', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    expect(html().style.getPropertyValue('--annotator-sidebar-width')).toBe(
      `${sidebar.getSidebarWidth()}px`,
    );

    sidebar.setSidebarWidth(180);
    expect(html().style.getPropertyValue('--annotator-sidebar-width')).toBe('180px');

    sidebar.closeSidebar();
    expect(html().style.getPropertyValue('--annotator-sidebar-width')).toBe('');
  });

  test('re-asserts a *wrong* value the page wrote over our margin, not just a missing one', async () => {
    // The youtube-style failure mode: page JS re-applies its own inline
    // margin/width on <html> for its own layout, silently un-shrinking us.
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    html().style.setProperty('margin-right', '0px', 'important');
    await flushObservers();

    expect(html().style.getPropertyValue('margin-right')).toBe(
      `${sidebar.getSidebarWidth()}px`,
    );
    expect(html().style.getPropertyPriority('margin-right')).toBe('important');
    expect(sidebar._pageResizeStateForTests().reasserts).toBe(1);
  });

  // ── resizable sidebar ────────────────────────────────────────────────────

  function resizer(): HTMLElement {
    return shadowRoot().querySelector('.resizer') as HTMLElement;
  }

  function dragResizerTo(clientX: number): void {
    // jsdom has no layout, so viewportRightEdge() falls back to innerWidth.
    const startX = window.innerWidth - sidebar.getSidebarWidth();
    resizer().dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX, bubbles: true }));
  }

  test('the drag handle is on the panel edge that borders the page, and is keyboard-reachable', () => {
    sidebar.initSidebar(makeCallbacks());
    const r = resizer();
    expect(r).not.toBeNull();
    expect(r.getAttribute('role')).toBe('separator');
    expect(r.getAttribute('aria-label')).toBe('resize sidebar');
    expect(r.tabIndex).toBe(0);
    expect(r.getAttribute('aria-valuemin')).toBe(String(sidebar.SIDEBAR_MIN_WIDTH));
    expect(r.getAttribute('aria-valuemax')).toBe(String(sidebar.SIDEBAR_MAX_WIDTH));
    // First child of the panel so it paints over the header's left edge.
    expect((r.parentElement as HTMLElement).className).toBe('sidebar');
  });

  test('default width is the top of the resizable range', () => {
    sidebar.initSidebar(makeCallbacks());
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_DEFAULT_WIDTH);
    expect(sidebar.SIDEBAR_DEFAULT_WIDTH).toBe(sidebar.SIDEBAR_MAX_WIDTH);
    expect(sidebar.SIDEBAR_MIN_WIDTH).toBe(100);
    expect(sidebar.SIDEBAR_MAX_WIDTH).toBe(300);
  });

  test('dragging the handle resizes the panel and the page shrink together, live', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    dragResizerTo(window.innerWidth - 200);

    expect(sidebar.getSidebarWidth()).toBe(200);
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.style.width).toBe('200px');
    expect(html().style.getPropertyValue('margin-right')).toBe('200px');
    expect(document.getElementById('annotator-page-resize')!.textContent).toContain(
      'margin-right: 200px !important',
    );
  });

  test('the drag is clamped to 100–300px in both directions', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    dragResizerTo(window.innerWidth - 20); // far too narrow
    expect(sidebar.getSidebarWidth()).toBe(100);

    window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: window.innerWidth - 900, bubbles: true }),
    );
    expect(sidebar.getSidebarWidth()).toBe(300);
  });

  test('the drag stops tracking the mouse once the button is released', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    dragResizerTo(window.innerWidth - 200);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: window.innerWidth - 120, bubbles: true }),
    );
    expect(sidebar.getSidebarWidth()).toBe(200);
  });

  test('the chosen width is persisted to chrome.storage.local once, on release', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    (chrome.storage.local.set as jest.Mock).mockClear();

    dragResizerTo(window.innerWidth - 220);
    expect(chrome.storage.local.set).not.toHaveBeenCalled(); // not once per frame

    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { sidebarWidth: 220 },
      expect.any(Function),
    );
  });

  test('a persisted width is restored on the next init', () => {
    sidebar.initSidebar(makeCallbacks());
    dragResizerTo(window.innerWidth - 150);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    sidebar.destroySidebar();
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_DEFAULT_WIDTH);

    sidebar.initSidebar(makeCallbacks());
    expect(sidebar.getSidebarWidth()).toBe(150);
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.style.width).toBe('150px');
  });

  test('a persisted width outside the range is clamped rather than trusted', () => {
    (chrome.storage.local.get as jest.Mock).mockImplementation(
      (_keys: unknown, cb: (r: Record<string, unknown>) => void) => cb({ sidebarWidth: 9999 }),
    );
    sidebar.initSidebar(makeCallbacks());
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MAX_WIDTH);
  });

  test('arrow keys on the handle resize it and persist, left growing the panel', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    sidebar.setSidebarWidth(200);

    resizer().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(sidebar.getSidebarWidth()).toBe(190);

    resizer().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(sidebar.getSidebarWidth()).toBe(200);

    resizer().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MIN_WIDTH);

    resizer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MAX_WIDTH);
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  test('resizing while closed leaves the page alone', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setSidebarWidth(150);
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    // ...and the new width is what the next open reserves.
    sidebar.openSidebar();
    expect(html().style.getPropertyValue('margin-right')).toBe('150px');
  });

  test('dispatches a synthetic resize so js-measured layouts re-read their box', () => {
    const onResize = jest.fn();
    window.addEventListener('resize', onResize);
    try {
      sidebar.initSidebar(makeCallbacks());
      sidebar.openSidebar();
      expect(onResize).toHaveBeenCalledTimes(1);
      sidebar.closeSidebar();
      expect(onResize).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('resize', onResize);
    }
  });

  // ── visibility + buttons ─────────────────────────────────────────────────

  test('openSidebar shows the panel and sets isSidebarVisible', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(sidebar.isSidebarVisible()).toBe(true);
  });

  test('close button click hides the panel, restores <html>, and fires onClose', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    sidebar.openSidebar();

    const closeBtn = shadowRoot().querySelector('button[aria-label="close sidebar"]') as HTMLButtonElement;
    closeBtn.click();

    expect(sidebar.isSidebarVisible()).toBe(false);
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    expect(cb.calls.close).toBe(1);
  });

  test('add and export buttons invoke their callbacks (still no-ops of their own — Phases 4/8 fill them in)', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const [addBtn, exportBtn] = Array.from(shadowRoot().querySelectorAll('.action-row button'));
    (addBtn as HTMLButtonElement).click();
    (exportBtn as HTMLButtonElement).click();
    expect(cb.calls.add).toBe(1);
    expect(cb.calls.export).toBe(1);
  });

  test('import button opens a .zip-only native file picker and forwards the chosen file', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);

    const fileInput = shadowRoot().querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toBe('.zip');

    const file = new File(['x'], 'bundle.zip', { type: 'application/zip' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change'));

    expect(cb.calls.importFile).toEqual([file]);
    expect(fileInput.value).toBe('');
  });

  test('setThumbnails([]) shows the empty state and hides the list', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([]);

    const empty = shadowRoot().querySelector('.empty-state') as HTMLElement;
    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(list.hidden).toBe(true);
    expect(empty.textContent).toBe('no feedback on this page yet');
  });

  test('setThumbnails(items) hides the empty state, shows "this page (n)", one button.thumbnail per item, badge + note preview', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1, note: 'a' }), makeItem({ id: 2, note: '' })]);

    const empty = shadowRoot().querySelector('.empty-state') as HTMLElement;
    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    const heading = shadowRoot().querySelector('.section-heading') as HTMLElement;
    expect(empty.hidden).toBe(true);
    expect(list.hidden).toBe(false);
    expect(heading.hidden).toBe(false);
    expect(heading.textContent).toBe('this page (2)');

    const items = list.querySelectorAll('button.thumbnail');
    expect(items.length).toBe(2);

    const [first, second] = Array.from(items);
    expect(first.querySelector('.thumbnail-badge')?.textContent).toBe('1');
    expect(first.querySelector('.thumbnail-note')?.textContent).toBe('a');
    expect(first.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');

    // Empty note renders the lowercase placeholder (§3.4), not a blank line.
    expect(second.querySelector('.thumbnail-note')?.textContent).toBe('no note');
  });

  test('the "this page (n)" heading is hidden along with the list when there are no items', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1 })]);
    sidebar.setThumbnails([]);

    const heading = shadowRoot().querySelector('.section-heading') as HTMLElement;
    expect(heading.hidden).toBe(true);
  });

  test('a second setThumbnails call replaces rather than appends', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1 })]);
    sidebar.setThumbnails([makeItem({ id: 2 }), makeItem({ id: 3 })]);

    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    expect(list.querySelectorAll('button.thumbnail').length).toBe(2);
    expect((shadowRoot().querySelector('.section-heading') as HTMLElement).textContent).toBe('this page (2)');
  });

  test('clicking a thumbnail fires onOpenItem with that item', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const item = makeItem({ id: 7 });
    sidebar.setThumbnails([item]);

    const li = shadowRoot().querySelector('button.thumbnail') as HTMLButtonElement;
    li.click();

    expect(cb.calls.openItem).toEqual([item]);
  });

  test('activating a thumbnail with Enter/Space also fires onOpenItem', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const item = makeItem({ id: 9 });
    sidebar.setThumbnails([item]);

    const li = shadowRoot().querySelector('button.thumbnail') as HTMLButtonElement;
    li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(cb.calls.openItem).toEqual([item]);
  });

  test('destroySidebar removes the host and restores <html> if it was open', () => {
    html().style.cssText = 'color: green;';
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    sidebar.destroySidebar();

    expect(getHost()).toBeNull();
    expect(sidebar.isSidebarInitialised()).toBe(false);
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    expect(html().style.color).toBe('green');
  });

  // ── notifications (carried over from toolbar.ts) ─────────────────────────

  test('showError renders the message verbatim and auto-clears after 8s', () => {
    jest.useFakeTimers();
    sidebar.initSidebar(makeCallbacks());

    sidebar.showError("couldn't capture a screenshot here. try again.");

    const notif = shadowRoot().querySelector('.notif') as HTMLElement;
    const text = shadowRoot().querySelector('.notif-text') as HTMLElement;
    expect(notif.hidden).toBe(false);
    expect(notif.classList.contains('warning')).toBe(false);
    expect(text.textContent).toBe("couldn't capture a screenshot here. try again.");

    jest.advanceTimersByTime(8000);
    expect(notif.hidden).toBe(true);
    expect(text.textContent).toBe('');
  });

  test('showWarning uses the warning styling and a swappable icon', () => {
    sidebar.initSidebar(makeCallbacks());

    sidebar.showWarning('this bundle was created with a newer version of the extension.');
    const notif = shadowRoot().querySelector('.notif') as HTMLElement;
    const icon = shadowRoot().querySelector('.notif-row .icon') as HTMLElement;
    expect(notif.classList.contains('warning')).toBe(true);
    // Compared by a distinctive path fragment rather than the whole string:
    // innerHTML round-trips `<path/>` back out as `<path></path>`.
    expect(sidebar.ICON_WARNING).toContain('M12 7.5v5.5');
    expect(icon.innerHTML).toContain('M12 7.5v5.5');

    sidebar.showWarning('custom', '<svg id="custom-icon"></svg>');
    expect(icon.innerHTML).toContain('custom-icon');
  });

  test('a second message replaces the first instead of stacking', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.showWarning('first');
    sidebar.showError('second');

    expect(shadowRoot().querySelectorAll('.notif')).toHaveLength(1);
    const notif = shadowRoot().querySelector('.notif') as HTMLElement;
    expect(notif.classList.contains('warning')).toBe(false);
    expect((shadowRoot().querySelector('.notif-text') as HTMLElement).textContent).toBe('second');
  });

  test('clearMessage and closeSidebar both dismiss a showing message', () => {
    sidebar.initSidebar(makeCallbacks());
    const notif = () => shadowRoot().querySelector('.notif') as HTMLElement;

    sidebar.showError('boom');
    sidebar.clearMessage();
    expect(notif().hidden).toBe(true);

    sidebar.openSidebar();
    sidebar.showError('boom again');
    sidebar.closeSidebar();
    expect(notif().hidden).toBe(true);
  });

  test('showConfirmDialog resolves the native confirm result', async () => {
    sidebar.initSidebar(makeCallbacks());
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(sidebar.showConfirmDialog('replace your current feedback?')).resolves.toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith('replace your current feedback?');

    confirmSpy.mockReturnValue(false);
    await expect(sidebar.showConfirmDialog('replace your current feedback?')).resolves.toBe(false);
  });

  // ── theme toggle (design spec §3.4) ──────────────────────────────────────

  function themeToggleBtn(): HTMLButtonElement {
    return shadowRoot().querySelector('button[aria-label^="theme:"]') as HTMLButtonElement;
  }

  test('the theme toggle starts on "theme: auto" and cycles auto -> light -> dark -> auto on click', () => {
    sidebar.initSidebar(makeCallbacks());
    const btn = themeToggleBtn();
    expect(btn.getAttribute('aria-label')).toBe('theme: auto');
    expect(btn.title).toBe('theme: auto');

    btn.click();
    expect(btn.getAttribute('aria-label')).toBe('theme: light');
    btn.click();
    expect(btn.getAttribute('aria-label')).toBe('theme: dark');
    btn.click();
    expect(btn.getAttribute('aria-label')).toBe('theme: auto');
  });

  test('the theme toggle label follows a mode change made elsewhere (e.g. another tab)', () => {
    sidebar.initSidebar(makeCallbacks());
    setThemeMode('dark'); // same call chrome.storage.onChanged sync ends in (see theme.test.ts)
    expect(themeToggleBtn().getAttribute('aria-label')).toBe('theme: dark');
  });

  test('the sidebar host carries data-theme and the logo swaps between the yellow and black asset per theme', () => {
    // chrome.runtime.getURL isn't part of the shared jest mock (setup.ts) —
    // stand in an identity implementation just for this test, same pattern
    // theme.test.ts's font-loading tests use.
    const originalGetURL = (chrome.runtime as any).getURL;
    (chrome.runtime as any).getURL = jest.fn((path: string) => path);
    try {
      sidebar.initSidebar(makeCallbacks());
      const host = getHost() as HTMLElement;
      const logoImg = shadowRoot().querySelector('.logo img') as HTMLImageElement;

      expect(host.getAttribute('data-theme')).toBe('light');
      expect(logoImg.getAttribute('src') ?? '').toContain('logo-button-black.svg');

      themeToggleBtn().click(); // -> light (no-op transition, still light)
      themeToggleBtn().click(); // -> dark
      expect(host.getAttribute('data-theme')).toBe('dark');
      expect(logoImg.getAttribute('src') ?? '').toContain('logo-button.svg');
      expect(logoImg.getAttribute('src') ?? '').not.toContain('logo-button-black.svg');
    } finally {
      (chrome.runtime as any).getURL = originalGetURL;
    }
  });

  // ── responsive layout (design spec §3.1) ─────────────────────────────────

  test('narrows below ~220px: the wordmark hides and "add note" goes icon-only', () => {
    sidebar.initSidebar(makeCallbacks());
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;

    sidebar.setSidebarWidth(300);
    expect(panel.classList.contains('is-narrow')).toBe(false);

    sidebar.setSidebarWidth(200);
    expect(panel.classList.contains('is-narrow')).toBe(true);
  });

  test('goes compact at the low end of the range so the 100px floor never overflows', () => {
    sidebar.initSidebar(makeCallbacks());
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;

    sidebar.setSidebarWidth(200);
    expect(panel.classList.contains('is-compact')).toBe(false);

    sidebar.setSidebarWidth(sidebar.SIDEBAR_MIN_WIDTH);
    expect(panel.classList.contains('is-compact')).toBe(true);
    expect(panel.classList.contains('is-narrow')).toBe(true);
  });
});
