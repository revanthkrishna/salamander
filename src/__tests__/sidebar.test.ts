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

  test('header shows exactly 4 buttons in order: add, export, import, close', () => {
    sidebar.initSidebar(makeCallbacks());
    const buttons = Array.from(shadowRoot().querySelectorAll('.header button'));
    expect(buttons).toHaveLength(4);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'add feedback',
      'export feedback',
      'import feedback',
      'close sidebar',
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
    expect(s.getPropertyValue('margin-right')).toBe(`${sidebar.SIDEBAR_WIDTH}px`);
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

    expect(html().style.getPropertyValue('margin-right')).toBe(`${sidebar.SIDEBAR_WIDTH}px`);
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
    expect(html().style.getPropertyValue('margin-right')).toBe(`${sidebar.SIDEBAR_WIDTH}px`);
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

    const closeBtn = shadowRoot().querySelectorAll('.header button')[3] as HTMLButtonElement;
    closeBtn.click();

    expect(sidebar.isSidebarVisible()).toBe(false);
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    expect(cb.calls.close).toBe(1);
  });

  test('add and export buttons invoke their callbacks (no-ops for Phase 3, still wired)', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const [addBtn, exportBtn] = Array.from(shadowRoot().querySelectorAll('.header button'));
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

  test('setThumbnails(items) hides the empty state, shows one <li> per item, badge + note preview', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1, note: 'a' }), makeItem({ id: 2, note: '' })]);

    const empty = shadowRoot().querySelector('.empty-state') as HTMLElement;
    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    expect(empty.hidden).toBe(true);
    expect(list.hidden).toBe(false);

    const items = list.querySelectorAll('li.thumbnail');
    expect(items.length).toBe(2);

    const [first, second] = Array.from(items);
    expect(first.querySelector('.thumbnail-badge')?.textContent).toBe('1');
    expect(first.querySelector('.thumbnail-note')?.textContent).toBe('a');
    expect(first.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');

    // Empty note renders the lowercase placeholder (§3.4), not a blank line.
    expect(second.querySelector('.thumbnail-note')?.textContent).toBe('no note');
  });

  test('a second setThumbnails call replaces rather than appends', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1 })]);
    sidebar.setThumbnails([makeItem({ id: 2 }), makeItem({ id: 3 })]);

    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    expect(list.querySelectorAll('li.thumbnail').length).toBe(2);
  });

  test('clicking a thumbnail fires onOpenItem with that item', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const item = makeItem({ id: 7 });
    sidebar.setThumbnails([item]);

    const li = shadowRoot().querySelector('li.thumbnail') as HTMLLIElement;
    li.click();

    expect(cb.calls.openItem).toEqual([item]);
  });

  test('activating a thumbnail with Enter/Space also fires onOpenItem', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const item = makeItem({ id: 9 });
    sidebar.setThumbnails([item]);

    const li = shadowRoot().querySelector('li.thumbnail') as HTMLLIElement;
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
    expect(sidebar.ICON_EXCLAMATION).toContain('M12,1C6.916');
    expect(icon.innerHTML).toContain('M12,1C6.916');

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
});
