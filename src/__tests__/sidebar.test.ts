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
import { ICON_WARNING } from '../icons';
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
  calls: {
    add: number;
    addDoubleClick: number;
    addSwitch: boolean[];
    export: number;
    importFile: File[];
    close: number;
    openItem: FeedbackItem[];
    deleteItem: FeedbackItem[];
  };
} {
  const calls = {
    add: 0,
    addDoubleClick: 0,
    addSwitch: [] as boolean[],
    export: 0,
    importFile: [] as File[],
    close: 0,
    openItem: [] as FeedbackItem[],
    deleteItem: [] as FeedbackItem[],
  };
  return {
    calls,
    onAdd: () => { calls.add++; },
    onAddSwitchChange: (on: boolean) => { calls.addSwitch.push(on); },
    onAddDoubleClick: () => { calls.addDoubleClick++; },
    onExport: () => { calls.export++; },
    onImportFile: (file: File) => { calls.importFile.push(file); },
    onClose: () => { calls.close++; },
    onOpenItem: (item: FeedbackItem) => { calls.openItem.push(item); },
    onDeleteItem: (item: FeedbackItem) => { calls.deleteItem.push(item); },
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

  test('action row holds two groups: "add note" + its switch, then export + chevron (design spec v3 §A2/§C2)', () => {
    sidebar.initSidebar(makeCallbacks());
    const groups = Array.from(shadowRoot().querySelectorAll('.action-row > div'));
    expect(groups.map((g) => g.className)).toEqual(['add-group', 'export-group']);

    const addHalves = Array.from(groups[0].querySelectorAll('button'));
    expect(addHalves.map((b) => b.className)).toEqual(['btn-add', 'add-switch']);
    expect(addHalves.map((b) => b.getAttribute('aria-label'))).toEqual(['add note', 'keep add mode on']);

    const exportHalves = Array.from(groups[1].querySelectorAll(':scope > button'));
    expect(exportHalves.map((b) => b.className)).toEqual(['btn-export', 'btn-menu']);
    expect(exportHalves.map((b) => b.getAttribute('aria-label'))).toEqual(['export feedback', 'more actions']);

    // "import" is the chevron menu's one item, not a button of its own.
    const menu = groups[1].querySelector('.action-menu') as HTMLElement;
    expect(menu.getAttribute('role')).toBe('menu');
    const items = Array.from(menu.querySelectorAll('button'));
    expect(items.map((b) => b.getAttribute('role'))).toEqual(['menuitem']);
    expect(items.map((b) => b.textContent)).toEqual(['import']);
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

    sidebar.setSidebarWidth(200);
    expect(html().style.getPropertyValue('--annotator-sidebar-width')).toBe('200px');

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
    expect(sidebar.SIDEBAR_MAX_WIDTH).toBe(300);
  });

  test('v5 §V: the minimum width is the width the action row needs, switch revealed', () => {
    sidebar.initSidebar(makeCallbacks());
    // 1 (panel border) + 16·2 (row padding) + 38 (add group)
    // + 49 (what the revealed switch ADDS: its box less the tuck that a
    // negative margin cancels) + 8 (gap) + 60 (export + chevron).
    expect(sidebar.ADD_SWITCH_ADVANCE_PX).toBe(49);
    expect(sidebar.SIDEBAR_MIN_WIDTH).toBe(1 + 16 * 2 + 38 + sidebar.ADD_SWITCH_ADVANCE_PX + 8 + 60);
    expect(sidebar.SIDEBAR_MIN_WIDTH).toBe(188);
    // It has to leave the narrow breakpoint something to do, and has to be
    // reachable at all.
    expect(sidebar.SIDEBAR_MIN_WIDTH).toBeLessThan(sidebar.NARROW_WIDTH_BREAKPOINT);
    expect(sidebar.SIDEBAR_MIN_WIDTH).toBeLessThan(sidebar.SIDEBAR_MAX_WIDTH);
  });

  test('v5 §V: a width persisted below the new minimum is clamped on load, not just on drag', () => {
    const get = chrome.storage.local.get as unknown as jest.Mock;
    get.mockImplementation((_key: string, cb: (r: Record<string, unknown>) => void) => cb({ sidebarWidth: 100 }));
    sidebar.initSidebar(makeCallbacks());
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MIN_WIDTH);
    // ...and the same clamp guards the drag/keyboard paths.
    sidebar.setSidebarWidth(40);
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MIN_WIDTH);
    expect(sidebar.clampSidebarWidth(100)).toBe(sidebar.SIDEBAR_MIN_WIDTH);
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

  test('the drag is clamped to the resizable range in both directions', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();

    dragResizerTo(window.innerWidth - 20); // far too narrow
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_MIN_WIDTH);

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
    dragResizerTo(window.innerWidth - 250);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    sidebar.destroySidebar();
    expect(sidebar.getSidebarWidth()).toBe(sidebar.SIDEBAR_DEFAULT_WIDTH);

    sidebar.initSidebar(makeCallbacks());
    expect(sidebar.getSidebarWidth()).toBe(250);
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.style.width).toBe('250px');
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
    sidebar.setSidebarWidth(250);
    expect(html().style.getPropertyValue('margin-right')).toBe('');
    // ...and the new width is what the next open reserves.
    sidebar.openSidebar();
    expect(html().style.getPropertyValue('margin-right')).toBe('250px');
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
    (shadowRoot().querySelector('.btn-add') as HTMLButtonElement).click();
    (shadowRoot().querySelector('.btn-export') as HTMLButtonElement).click();
    expect(cb.calls.add).toBe(1);
    expect(cb.calls.export).toBe(1);
  });

  test('the menu\'s "import" item opens a .zip-only native file picker and forwards the chosen file', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);

    const fileInput = shadowRoot().querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toBe('.zip');

    // The item is what clicks the hidden input, and it closes the menu first.
    const picker = jest.spyOn(fileInput, 'click').mockImplementation(() => {});
    (shadowRoot().querySelector('.btn-menu') as HTMLButtonElement).click();
    (shadowRoot().querySelector('.action-menu-item') as HTMLButtonElement).click();
    expect(picker).toHaveBeenCalledTimes(1);
    expect((shadowRoot().querySelector('.action-menu') as HTMLElement).dataset.open).toBe('false');
    picker.mockRestore();

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

  test('dock magnification (design spec §4) is wired only while the sidebar is open with items, and torn down on repaint/close/destroy', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setThumbnails([makeItem({ id: 1 }), makeItem({ id: 2 })]);
    const list = shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
    // Closed: no motion layer (no listeners/rAF held for a hidden sidebar).
    expect(list.dataset.dock).toBeUndefined();

    sidebar.openSidebar();
    expect(list.dataset.dock).toBe('on');

    // Repaint keeps exactly one live layer on the fresh items.
    sidebar.setThumbnails([makeItem({ id: 3 })]);
    expect(list.dataset.dock).toBe('on');

    sidebar.setThumbnails([]);
    expect(list.dataset.dock).toBeUndefined();

    sidebar.setThumbnails([makeItem({ id: 4 })]);
    expect(list.dataset.dock).toBe('on');
    sidebar.closeSidebar();
    expect(list.dataset.dock).toBeUndefined();

    sidebar.openSidebar();
    expect(list.dataset.dock).toBe('on');
    sidebar.destroySidebar();
    expect(list.dataset.dock).toBeUndefined();
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

  test('destroySidebar unregisters the host from the theme feed', () => {
    sidebar.initSidebar(makeCallbacks());
    const host = getHost()!;
    const before = host.getAttribute('data-theme');

    sidebar.destroySidebar();
    setThemeMode(before === 'dark' ? 'light' : 'dark');

    // A registered host would have been repainted by the mode change; the
    // torn-down one is no longer in theme.ts's set.
    expect(host.getAttribute('data-theme')).toBe(before);
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

  test('showWarning uses the warning styling and the warning icon', () => {
    sidebar.initSidebar(makeCallbacks());

    sidebar.showWarning('this bundle was created with a newer version of the extension.');
    const notif = shadowRoot().querySelector('.notif') as HTMLElement;
    const icon = shadowRoot().querySelector('.notif-row .icon') as HTMLElement;
    expect(notif.classList.contains('warning')).toBe(true);
    // Compared by a distinctive path fragment rather than the whole string:
    // innerHTML round-trips `<path/>` back out as `<path></path>`.
    expect(ICON_WARNING).toContain('M12 7.5v5.5');
    expect(icon.innerHTML).toContain('M12 7.5v5.5');

    // An error after a warning swaps back to the error icon.
    sidebar.showError('an error');
    expect(notif.classList.contains('warning')).toBe(false);
    expect(icon.innerHTML).toContain('M9 9l6 6');
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

  test('narrows below ~220px: the wordmark hides and the switch\'s hover reveal is suppressed', () => {
    sidebar.initSidebar(makeCallbacks());
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;

    sidebar.setSidebarWidth(300);
    expect(panel.classList.contains('is-narrow')).toBe(false);

    sidebar.setSidebarWidth(200);
    expect(panel.classList.contains('is-narrow')).toBe(true);
  });

  test('v5 §V: there is no compact layout left, at any reachable width', () => {
    sidebar.initSidebar(makeCallbacks());
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    const style = shadowRoot().querySelector('style')!.textContent ?? '';

    for (const w of [sidebar.SIDEBAR_MIN_WIDTH, 200, 219, 220, 300]) {
      sidebar.setSidebarWidth(w);
      expect(panel.classList.contains('is-compact')).toBe(false);
    }
    // The class, its rules and the breakpoint are gone rather than unused.
    expect(style).not.toContain('is-compact');
    expect((sidebar as Record<string, unknown>).COMPACT_WIDTH_BREAKPOINT).toBeUndefined();
    expect((sidebar as Record<string, unknown>).actionRowFits).toBeUndefined();
    // The logo the compact layout used to shed is now always in the header.
    sidebar.setSidebarWidth(sidebar.SIDEBAR_MIN_WIDTH);
    expect(shadowRoot().querySelector('.header .logo')).not.toBeNull();
  });
});

describe('sidebar review fixes', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    html().style.cssText = '';
    jest.useRealTimers();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  /** The first `selector { ... }` rule body in the sidebar's stylesheet. */
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }
  function body(): HTMLElement {
    return shadowRoot().querySelector('.body') as HTMLElement;
  }
  function list(): HTMLElement {
    return shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
  }
  function openWithItems(n = 3): void {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    sidebar.setThumbnails(Array.from({ length: n }, (_, i) => makeItem({ id: i + 1 })));
  }
  function hoverList(): void {
    list().dispatchEvent(new MouseEvent('pointerenter', { clientY: 10 }));
  }

  // ── #2: the scroller keeps normal pointer events at rest ──────────────────

  test('at rest the note scroller has ordinary pointer events and clip-path trims the over-page strip', () => {
    openWithItems();
    const rest = cssRule('.body');
    expect(rest).toMatch(/clip-path:\s*inset\(0 0 0 72px\)/);
    expect(rest).toMatch(/margin-left:\s*-72px/);
    expect(rest).not.toMatch(/pointer-events/);
    expect(body().classList.contains('is-bleeding')).toBe(false);
  });

  test('only while an item is magnified does the scroller paint over the page (and go click-through there)', () => {
    openWithItems();
    const bleeding = cssRule('.body.is-bleeding');
    expect(bleeding).toMatch(/clip-path:\s*none/);
    expect(bleeding).toMatch(/pointer-events:\s*none/);
    expect(cssRule('.body.is-bleeding > *')).toMatch(/pointer-events:\s*auto/);

    hoverList();
    expect(body().classList.contains('is-bleeding')).toBe(true);

    // Closing tears the motion layer down and drops the bleed with it.
    sidebar.closeSidebar();
    expect(body().classList.contains('is-bleeding')).toBe(false);
  });

  // ── #1: dock suspension for add mode / capture ─────────────────────────────

  test('setDockMagnificationSuspended stops the list magnifying, and survives repaints until lifted', () => {
    openWithItems();
    hoverList();
    expect(body().classList.contains('is-bleeding')).toBe(true);

    sidebar.setDockMagnificationSuspended(true);
    // Instantly back to rest: nothing painting over the page any more.
    expect(body().classList.contains('is-bleeding')).toBe(false);
    for (const li of Array.from(list().children) as HTMLElement[]) expect(li.style.transform).toBe('');

    hoverList();
    expect(body().classList.contains('is-bleeding')).toBe(false);

    // A repaint (e.g. after a capture) builds a fresh motion layer — still suspended.
    sidebar.setThumbnails([makeItem({ id: 7 }), makeItem({ id: 8 })]);
    hoverList();
    expect(body().classList.contains('is-bleeding')).toBe(false);

    sidebar.setDockMagnificationSuspended(false);
    hoverList();
    expect(body().classList.contains('is-bleeding')).toBe(true);
  });

  // ── #3: the action row never overflows ─────────────────────────────────────

  test('v5 §V: the action row fits with the switch OUT at every reachable width', () => {
    // The whole point of the new minimum: the widest the row can ever be is
    // the width the panel can never go below.
    const widest = 1 + 16 * 2 + 38 + sidebar.ADD_SWITCH_ADVANCE_PX + 8 + 60;
    for (let w = sidebar.SIDEBAR_MIN_WIDTH; w <= sidebar.SIDEBAR_MAX_WIDTH; w++) {
      expect({ w, fits: w >= widest }).toEqual({ w, fits: true });
    }
  });

  test('layout classes flip exactly at the narrow boundary', () => {
    sidebar.initSidebar(makeCallbacks());
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    const at = (w: number) => {
      sidebar.setSidebarWidth(w);
      return { narrow: panel.classList.contains('is-narrow') };
    };
    expect(at(sidebar.SIDEBAR_MIN_WIDTH)).toEqual({ narrow: true });
    expect(at(219)).toEqual({ narrow: true });
    expect(at(220)).toEqual({ narrow: false });
    expect(at(300)).toEqual({ narrow: false });
    for (const w of [188, 200, 219, 220, 300]) {
      expect(sidebar.sidebarLayoutFor(w)).toEqual(at(w));
    }
  });

  test('both action-row groups are fixed-size and the row never wraps (v5 §V)', () => {
    sidebar.initSidebar(makeCallbacks());
    // §A2: "the button never changes size in any state — nothing wraps,
    // shrinks or reflows on hover".
    // 38 = 36px of content plus the button's own two borders (border-box).
    expect(cssRule('.btn-add')).toMatch(/width:\s*38px/);
    expect(cssRule('.btn-add')).toMatch(/flex-shrink:\s*0/);
    expect(cssRule('.btn-add')).toMatch(/white-space:\s*nowrap/);
    expect(cssRule('.export-group')).toMatch(/flex-shrink:\s*0/);
    // There is no second line to fall to any more — §V guarantees one fits.
    expect(cssRule('.action-row')).toMatch(/flex-wrap:\s*nowrap/);
  });

  // ── #9: header controls stay right-aligned when the wordmark hides ────────

  test('the theme toggle carries margin-left: auto so theme + close stay pinned right', () => {
    sidebar.initSidebar(makeCallbacks());
    const theme = shadowRoot().querySelector('.header .btn-theme') as HTMLElement;
    expect(theme).not.toBeNull();
    expect(theme.getAttribute('aria-label')).toMatch(/^theme: /);
    expect(cssRule('.btn-theme')).toMatch(/margin-left:\s*auto/);
  });

  // ── #6 / #8: resize handle focus ring and stacking ─────────────────────────

  test('the resize handle shows the standard focus ring and sits above magnified items; its hairline sits below them', () => {
    sidebar.initSidebar(makeCallbacks());
    const handle = shadowRoot().querySelector('.resizer') as HTMLElement;
    const line = handle.nextElementSibling as HTMLElement;
    expect(line.className).toBe('resizer-line');
    expect(line.getAttribute('aria-hidden')).toBe('true');

    expect(cssRule('.resizer:focus-visible')).toContain('0 0 0 4px var(--sal-focus)');

    // dockMotion.ts writes item z-indexes 0–100.
    const handleZ = Number(/z-index:\s*(\d+)/.exec(cssRule('.resizer'))![1]);
    const lineZ = Number(/z-index:\s*(\d+)/.exec(cssRule('.resizer-line'))![1]);
    expect(handleZ).toBeGreaterThan(100);
    expect(lineZ).toBeLessThan(100);
    // …but the accent line rises above items while the handle is in use.
    expect(css()).toMatch(/\.resizer:focus-visible \+ \.resizer-line \{[^}]*z-index:\s*101/);
  });

  // ── #5: no wrong-theme flash on first open ─────────────────────────────────

  test('the panel stays invisible until the stored theme mode has loaded, then reveals in the right theme', () => {
    let deliver: ((r: Record<string, unknown>) => void) | null = null;
    (chrome.storage.local.get as jest.Mock).mockImplementation((key: unknown, cb: (r: Record<string, unknown>) => void) => {
      if (key === 'themeMode') deliver = cb;
      else cb({});
    });
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.style.visibility).toBe('hidden');

    deliver!({ themeMode: 'dark' });
    return Promise.resolve().then(() => {
      expect(getHost()!.getAttribute('data-theme')).toBe('dark');
      expect(panel.style.visibility).toBe('');
    });
  });

  test('a storage read that never settles only delays the reveal briefly', () => {
    jest.useFakeTimers();
    (chrome.storage.local.get as jest.Mock).mockImplementation((key: unknown, cb: (r: Record<string, unknown>) => void) => {
      if (key !== 'themeMode') cb({});
    });
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.style.visibility).toBe('hidden');
    jest.advanceTimersByTime(150);
    expect(panel.style.visibility).toBe('');
  });

  test('once the theme read has settled, opening is instant', () => {
    sidebar.initSidebar(makeCallbacks()); // mock storage answers synchronously
    sidebar.openSidebar();
    const panel = shadowRoot().querySelector('.sidebar') as HTMLElement;
    expect(panel.style.visibility).toBe('');
  });

  // ── #10: focus returns to the thumbnail after the modal ────────────────────

  test('focusThumbnail focuses the rendered item by id, and reports a missing one', () => {
    openWithItems(3);
    expect(sidebar.focusThumbnail(2)).toBe(true);
    const focused = shadowRoot().activeElement as HTMLElement;
    expect(focused.classList.contains('thumbnail')).toBe(true);
    expect(focused.getAttribute('aria-label')).toBe('feedback item 2');
    expect(sidebar.focusThumbnail(99)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// design spec v3 §A2 — icon-only "add note" + attached "keep on" switch
// ═══════════════════════════════════════════════════════════════════════════

describe('"add note" + "keep on" switch (design spec v3 §A2)', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }
  function group(): HTMLElement {
    return shadowRoot().querySelector('.add-group') as HTMLElement;
  }
  function addButton(): HTMLButtonElement {
    return shadowRoot().querySelector('.btn-add') as HTMLButtonElement;
  }
  function addSwitch(): HTMLButtonElement {
    return shadowRoot().querySelector('.add-switch') as HTMLButtonElement;
  }

  test('starts off: neutral group, aria-pressed false, switch present and unchecked', () => {
    sidebar.initSidebar(makeCallbacks());
    expect(group().classList.contains('is-on')).toBe(false);
    expect(group().classList.contains('is-switch-on')).toBe(false);
    expect(addButton().getAttribute('aria-pressed')).toBe('false');
    expect(addButton().getAttribute('aria-label')).toBe('add note');
    expect(addButton().title).toBe('add note');
    // Icon-only: no visible label anywhere in the button.
    expect(addButton().textContent).toBe('');
    expect(addSwitch().getAttribute('role')).toBe('switch');
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');
    expect(addSwitch().getAttribute('aria-label')).toBe('keep add mode on');
    expect(addSwitch().title).toBe('keep add mode on');
  });

  test('setAddButtonState keeps its three values; "locked" now paints button-on + switch-on', () => {
    sidebar.initSidebar(makeCallbacks());
    const desc = () => shadowRoot().getElementById(addButton().getAttribute('aria-describedby')!)!;
    expect(desc().classList.contains('sr-only')).toBe(true);

    sidebar.setAddButtonState('on');
    expect(group().classList.contains('is-on')).toBe(true);
    expect(group().classList.contains('is-switch-on')).toBe(false);
    expect(addButton().getAttribute('aria-pressed')).toBe('true');
    // Icon-only, so the state has to ride on the accessible name.
    expect(addButton().getAttribute('aria-label')).toBe('add note (on)');
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');

    sidebar.setAddButtonState('locked');
    expect(group().classList.contains('is-on')).toBe(true);
    expect(group().classList.contains('is-switch-on')).toBe(true);
    expect(addButton().getAttribute('aria-pressed')).toBe('true');
    expect(addButton().getAttribute('aria-label')).toBe('add note (kept on)');
    expect(addSwitch().getAttribute('aria-checked')).toBe('true');
    expect(desc().textContent).toMatch(/kept on/);

    sidebar.setAddButtonState('off');
    expect(group().classList.contains('is-on')).toBe(false);
    expect(group().classList.contains('is-switch-on')).toBe(false);
    expect(addButton().getAttribute('aria-pressed')).toBe('false');
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');
  });

  test('no padlock glyph survives anywhere', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.setAddButtonState('locked');
    expect(shadowRoot().querySelector('.icon-lock')).toBeNull();
    expect(css()).not.toMatch(/icon-lock/);
    expect(group().classList.contains('is-locked')).toBe(false);
  });

  test('the switch reports the value the user asked for, and never moves on its own', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);

    addSwitch().click();
    expect(cb.calls.addSwitch).toEqual([true]);
    // Nothing moved: content.ts owns the state and paints it back.
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');

    // While on, the halves are merged and the switch stops reporting its own
    // value — see "clicking either half of the merged control stops
    // everything" below.
    sidebar.setAddButtonState('locked');
    addSwitch().click();
    expect(cb.calls.addSwitch).toEqual([true]);
    expect(cb.calls.add).toBe(1);
  });

  test('click fires onAdd; the v2 gestures (dblclick, shift+click, shift+Enter/Space) still drive the switch', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const btn = addButton();

    btn.click();
    expect(cb.calls.add).toBe(1);
    expect(cb.calls.addDoubleClick).toBe(0);

    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(cb.calls.addDoubleClick).toBe(1);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    expect(cb.calls.addDoubleClick).toBe(2);
    expect(cb.calls.add).toBe(1); // not a plain toggle

    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true });
      btn.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true); // no native click follows
    }
    expect(cb.calls.addDoubleClick).toBe(4);
  });

  test('off hover/press use the secondary fills; only "on" goes yellow', () => {
    sidebar.initSidebar(makeCallbacks());
    // The fill and the border belong to the HALVES now (v5 §Q as refined):
    // the group is pure layout, so the button can be a complete rounded
    // button with the switch an open-sided extension behind it.
    const group = cssRule('.add-group');
    expect(group).not.toMatch(/background:/);
    expect(group).not.toMatch(/border:\s*1px/);

    const btn = cssRule('.btn-add');
    expect(btn).toMatch(/background:\s*var\(--sal-surface\)/);
    expect(btn).toMatch(/border:\s*1px solid var\(--sal-line\)/);

    expect(cssRule('.add-group.is-on')).toMatch(/color:\s*var\(--sal-on-accent\)/);
    const on = cssRule('.add-group.is-on .btn-add');
    expect(on).toMatch(/background:\s*var\(--sal-accent\)/);
    // The border stays in the box (transparent) so on and off are the same size.
    expect(on).toMatch(/border-color:\s*transparent/);
  });

  test('hover and press land on the half under the pointer, and nothing scales', () => {
    sidebar.initSidebar(makeCallbacks());
    // Nothing is painted at the group level while the halves are separate
    // controls, and nothing scales.
    expect(css()).not.toMatch(/\.add-group:hover\s*\{/);
    expect(css()).not.toMatch(/\.add-group:active\s*\{/);
    expect(cssRule('.add-group')).not.toMatch(/scale\(0\.97\)/);
    // The OUTLINE reacts as one: a hover anywhere lights BOTH halves'
    // borders, so the control is never half-outlined. Lighting only the
    // hovered half left the switch (bordered on three sides) highlighted
    // while the junction and the whole button stayed at the resting colour.
    const outline = cssRule(
      '.add-group:hover .btn-add,\n  .add-group:hover .add-switch,\n  .add-group:active .btn-add,\n  .add-group:active .add-switch',
    );
    expect(outline).toMatch(/border-color:\s*var\(--sal-line-strong\)/);
    // ...while the FILL stays on the hovered half alone.
    expect(cssRule('.btn-add:hover')).not.toMatch(/border-color:/);
    expect(cssRule('.add-switch:hover')).not.toMatch(/border-color:/);

    // Each half takes its own fill, in both the off and the yellow group.
    expect(cssRule('.btn-add:hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.btn-add:active')).toMatch(/background:\s*var\(--sal-press\)/);
    expect(cssRule('.add-switch:hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.add-switch:active')).toMatch(/background:\s*var\(--sal-press\)/);
    expect(cssRule('.add-group.is-on .btn-add:hover')).toMatch(/background:\s*var\(--sal-accent-hover\)/);
    expect(cssRule('.add-group.is-on .btn-add:active')).toMatch(/background:\s*var\(--sal-accent-press\)/);
    // ...except once the switch is on: the two halves are then one button and
    // both take the same yellow together (see the merged test below).

    // Hovering the switch must not light up the button: no group-level rule
    // paints a fill while the two are separate controls.
    expect(css()).not.toMatch(/\.add-group:hover\s*\{[^}]*background:/);
  });

  test('the focus ring hugs the focused half, and the group lets it out', () => {
    sidebar.initSidebar(makeCallbacks());
    // A ring 4px outside a half would be clipped by a scrolling/hidden group.
    expect(cssRule('.add-group')).toMatch(/overflow:\s*visible/);
    // No group-level ring while the halves are separate controls. (§Q's
    // reveal uses `:has(:focus-visible)` as a *descendant* selector — that
    // shows the switch, it does not draw a ring round the group.)
    expect(css()).not.toMatch(/\.add-group:has\(:focus-visible\)\s*\{/);

    expect(cssRule('.btn-add:focus-visible')).toContain('0 0 0 4px var(--sal-focus)');
    // The segment carries no box-shadow of its own, so the ring is the plain
    // shared snippet on both halves — nothing to spell out alongside it.
    const switchFocus = cssRule('.add-switch:focus-visible');
    expect(switchFocus).toContain('0 0 0 4px var(--sal-focus)');
    expect(switchFocus).not.toContain('inset');
    // Merged, the group is one tab stop and one control, so the ring belongs
    // to the group — there is no per-half override for the switch any more.
    expect(css()).not.toMatch(/\.add-group\.is-switch-on \.add-switch:focus-visible/);
    expect(cssRule('.add-group.is-switch-on:has(.btn-add:focus-visible)')).toContain('0 0 0 4px var(--sal-focus)');

    // Each half owns its shape: the button fully rounded, the segment
    // rounded only on the right, square on the tucked left edge.
    expect(cssRule('.btn-add')).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    expect(cssRule('.add-switch')).toMatch(
      /border-radius:\s*0 var\(--sal-radius-md\) var\(--sal-radius-md\) 0/,
    );
  });

  test('the add button never squares off; the switch is an extension behind it', () => {
    sidebar.initSidebar(makeCallbacks());
    // No rule anywhere gives the button a half-rounded (right-square) radius.
    expect(css()).not.toMatch(/\.btn-add[^{]*\{[^}]*border-radius:[^;]*0 0 calc/);
    // It paints above the switch, so the switch tucks out from behind its
    // rounded silhouette (v5 §Q: that silhouette IS the separation now).
    const btn = cssRule('.btn-add');
    expect(btn).toMatch(/position:\s*relative/);
    expect(btn).toMatch(/z-index:\s*1/);
  });

  test('switch on merges the two halves into one button of the same width', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);

    // The junction line is the BUTTON's right border, and merged it goes
    // transparent rather than away, so merged and split are the same width.
    const merged = cssRule('.add-group.is-switch-on .btn-add,\n  .add-group.is-switch-on .add-switch');
    expect(merged).toMatch(/border-color:\s*transparent/);
    expect(merged).toMatch(/background:\s*var\(--sal-accent\)/);

    // Hover and press paint BOTH halves together — one control, one yellow.
    const mergedHover = cssRule('.add-group.is-switch-on:hover .btn-add,\n  .add-group.is-switch-on:hover .add-switch');
    expect(mergedHover).toMatch(/background:\s*var\(--sal-accent-hover\)/);
    const mergedPress = cssRule('.add-group.is-switch-on:active .btn-add,\n  .add-group.is-switch-on:active .add-switch');
    expect(mergedPress).toMatch(/background:\s*var\(--sal-accent-press\)/);
    expect(cssRule('.add-group.is-switch-on:has(.btn-add:focus-visible)')).toContain('0 0 0 4px var(--sal-focus)');

    // One tab stop while merged: the button half carries it.
    const sw = shadowRoot().querySelector('.add-switch') as HTMLButtonElement;
    sidebar.setAddButtonState('locked');
    expect(sw.getAttribute('tabindex')).toBe('-1');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sidebar.setAddButtonState('on');
    expect(sw.hasAttribute('tabindex')).toBe(false);
  });

  test('clicking either half of the merged control stops everything', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    const sw = shadowRoot().querySelector('.add-switch') as HTMLButtonElement;

    // Switch off: a click on it asks to turn it ON.
    sidebar.setAddButtonState('on');
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb.calls.addSwitch).toEqual([true]);
    expect(cb.calls.add).toBe(0);

    // Switch on (merged): a click on the switch half is a click on the
    // button — content.ts's add handler exits add mode and clears the switch
    // together, which reporting `false` here would not do.
    sidebar.setAddButtonState('locked');
    sw.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb.calls.addSwitch).toEqual([true]);
    expect(cb.calls.add).toBe(1);
  });

  test('the switch segment stays neutral while off even when the button half is yellow', () => {
    sidebar.initSidebar(makeCallbacks());
    const off = cssRule('.add-switch');
    expect(off).toMatch(/background:\s*var\(--sal-surface\)/);
    // No ".add-group.is-on .add-switch" rule: only the switch's own state
    // turns the segment yellow.
    expect(css()).not.toMatch(/\.add-group\.is-on \.add-switch\s*\{/);
  });

  test('v5 §Q: each half draws its own border, and they interlock', () => {
    sidebar.initSidebar(makeCallbacks());
    // The button is a complete rounded button: border on all four sides,
    // every corner rounded, in every state.
    const btn = cssRule('.btn-add');
    expect(btn).toMatch(/border:\s*1px solid var\(--sal-line\)/);
    expect(btn).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    expect(css()).not.toMatch(/\.btn-add[^{]*\{[^}]*border-(left|right)-width:\s*0/);

    // The segment borders its top, right and bottom only — never its left,
    // where the button's own right border is the single line at the junction.
    const seg = cssRule('.add-switch');
    expect(seg).toMatch(/border:\s*0 solid var\(--sal-line\)/);
    expect(seg).toMatch(/border-left-width:\s*0/);
    expect(seg).not.toMatch(/box-shadow:/);
    // The group itself paints nothing at all now.
    const group = cssRule('.add-group');
    expect(group).not.toMatch(/border:\s*1px/);
    expect(group).not.toMatch(/background:/);
  });

  test('v5 §Q: the segment tucks a radius back so the border never breaks', () => {
    sidebar.initSidebar(makeCallbacks());
    // Butting a square-cornered segment against the button's ROUNDED right
    // edge leaves a crescent gap at each corner: the outer border breaks into
    // pieces and the segment's hover fill looks clipped where the curve falls
    // away. Reaching exactly one radius back under the button fills both
    // crescents, and the button (z-index: 1, opaque) hides the rest.
    const reveal = css().match(
      /\.add-group:hover \.add-switch,\s*\.add-group:has\(:focus-visible\) \.add-switch,\s*\.add-group\.is-switch-on \.add-switch \{[^}]*\}/,
    )?.[0];
    expect(reveal).toMatch(/margin-left:\s*-10px/);
    expect(reveal).toMatch(/padding:\s*0 10px 0 20px/);
    expect(reveal).toMatch(/border-left-width:\s*0/);
    expect(cssRule('.btn-add')).toMatch(/z-index:\s*1/);
    expect(cssRule('.btn-add')).toMatch(/background:\s*var\(--sal-surface\)/);

    // The tuck must not widen the group: the negative margin cancels it, so
    // the reveal still advances the row by the same 49px.
    expect(sidebar.ADD_SWITCH_WIDTH_PX).toBe(10 + 20 + 28 + 1 - 10 + 10);
    expect(sidebar.ADD_SWITCH_ADVANCE_PX).toBe(sidebar.ADD_SWITCH_WIDTH_PX - 10);
    expect(sidebar.ADD_SWITCH_ADVANCE_PX).toBe(49);
  });

  test('v5 §Q: the reveal takes keyboard focus only, never a mouse click\'s focus', () => {
    sidebar.initSidebar(makeCallbacks());
    // :focus-within also matched the focus Chrome gives a button on
    // mouse-down, so the switch stayed out from the click that started add
    // mode and lingered right through it. :has(:focus-visible) does not.
    expect(css()).not.toMatch(/:focus-within \.add-switch/);
    expect(css()).toMatch(/\.add-group:has\(:focus-visible\) \.add-switch/);
  });

  test('merged, both halves take the same yellow together', () => {
    sidebar.initSidebar(makeCallbacks());
    // The group has no fill of its own, so each half paints the accent — and
    // a hover anywhere in the group has to repaint BOTH, or the half under
    // the pointer goes accentHover while the other stays flat accent: two
    // yellows in what is meant to be one control.
    const on = cssRule('.add-group.is-switch-on .btn-add,\n  .add-group.is-switch-on .add-switch');
    expect(on).toMatch(/background:\s*var\(--sal-accent\)/);
    expect(on).toMatch(/border-color:\s*transparent/);

    for (const [sel, fill] of [
      ['.add-group.is-switch-on:hover .btn-add,\n  .add-group.is-switch-on:hover .add-switch', 'accent-hover'],
      ['.add-group.is-switch-on:active .btn-add,\n  .add-group.is-switch-on:active .add-switch', 'accent-press'],
    ] as const) {
      expect(cssRule(sel)).toMatch(new RegExp(`background:\\s*var\\(--sal-${fill}\\)`));
    }

    // The per-half overrides that used to cancel an opaque fill are gone
    // rather than left behind as dead rules.
    expect(css()).not.toMatch(/\.add-group\.is-switch-on \.add-switch:hover\s*\{/);
    expect(css()).not.toMatch(/\.add-group\.is-switch-on \.add-switch:active\s*\{/);
  });

  test('the track and knob follow §A2\'s geometry, and the knob slides on the standard curve', () => {
    sidebar.initSidebar(makeCallbacks());
    const track = cssRule('.add-switch-track');
    expect(track).toMatch(/width:\s*28px/);
    expect(track).toMatch(/height:\s*16px/);
    expect(track).toMatch(/border-radius:\s*8px/);

    const knob = cssRule('.add-switch-knob');
    expect(knob).toMatch(/width:\s*12px/);
    expect(knob).toMatch(/height:\s*12px/);
    expect(knob).toMatch(/top:\s*2px/);
    expect(knob).toMatch(/left:\s*2px/);
    expect(knob).toMatch(/transition:\s*left 150ms cubic-bezier\(\.2, 0, 0, 1\)/);
    expect(cssRule('.add-group.is-switch-on .add-switch-knob')).toMatch(/left:\s*14px/);

    // The DOM is track > knob, so the knob's absolute offsets resolve
    // against the track.
    const knobEl = shadowRoot().querySelector('.add-switch-knob') as HTMLElement;
    expect(knobEl.parentElement!.className).toBe('add-switch-track');
  });

  test("the track and knob contrast with each other in BOTH themes (design spec v4 §P)", () => {
    sidebar.initSidebar(makeCallbacks());
    // Off: muted (#6E6656 light / #B3AA96 dark) and surface (#FFFFFF /
    // #1D1A13) invert together, so the knob always contrasts with its track.
    // The old lineStrong track was a hairline colour — too close to the
    // segment to read as a live control at all.
    expect(cssRule('.add-switch-track')).toMatch(/background:\s*var\(--sal-muted\)/);
    expect(cssRule('.add-switch-track')).not.toMatch(/var\(--sal-line-strong\)/);
    expect(cssRule('.add-switch-knob')).toMatch(/background:\s*var\(--sal-surface\)/);

    // On: onAccent (#1A1712) and accent (#FEC800) are theme-independent, so
    // this pairing is identical in light and dark. The old on-state put a
    // `surface` knob on an `onAccent` track, which in dark theme is
    // near-black on black.
    expect(cssRule('.add-group.is-switch-on .add-switch-track')).toMatch(/background:\s*var\(--sal-on-accent\)/);
    const onKnob = cssRule('.add-group.is-switch-on .add-switch-knob');
    expect(onKnob).toMatch(/background:\s*var\(--sal-accent\)/);
    expect(onKnob).not.toMatch(/var\(--sal-surface\)/);
    // The crossfade between the two tracks needs the knob's fill animated too.
    expect(cssRule('.add-switch-knob')).toMatch(/background-color 150ms/);
  });

  test('the collapsed switch takes up no width at all, so the resting group is 38px', () => {
    sidebar.initSidebar(makeCallbacks());
    const hidden = cssRule('.add-switch');
    // `box-sizing: border-box` is global here, so a `width: 0` box still
    // cannot be narrower than its own border — a collapsed switch that kept
    // its 1px would measure 1px, pushing the group to 39px, knocking the
    // button half off-centre and drawing a stray `line` hairline at the
    // button's right edge at rest. The border has to leave the box entirely,
    // and so does the negative margin that cancels the tuck.
    expect(cssRule('*, *::before, *::after')).toMatch(/box-sizing:\s*border-box/);
    expect(hidden).toMatch(/width:\s*0/);
    expect(hidden).toMatch(/padding:\s*0/);
    expect(hidden).toMatch(/border-width:\s*0/);
    expect(hidden).toMatch(/margin-left:\s*0/);

    // Resting group width, from the stylesheet: the button half alone, its
    // own two borders inside its box, and nothing from the switch.
    const px = (rule: string, prop: string): number =>
      Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(cssRule(rule))?.[1] ?? NaN);
    expect(px('.btn-add', 'width')).toBe(38);

    // Revealing restores the border and the tuck together.
    const reveal = css().match(
      /\.add-group:hover \.add-switch,\s*\.add-group:has\(:focus-visible\) \.add-switch,\s*\.add-group\.is-switch-on \.add-switch \{[^}]*\}/,
    )?.[0];
    expect(reveal).toMatch(/border-width:\s*1px/);
    expect(reveal).toMatch(/margin-left:\s*-10px/);
    expect(sidebar.ADD_SWITCH_WIDTH_PX).toBe(59);
  });

  test('the switch is hidden (and untabbable) at rest, revealed on hover/focus, and always visible once on', () => {
    sidebar.initSidebar(makeCallbacks());
    // visibility, not just opacity — Tab must not land on an invisible control.
    expect(cssRule('.add-switch')).toMatch(/visibility:\s*hidden/);
    expect(cssRule('.add-switch')).toMatch(/width:\s*0/);

    const reveal = css().match(
      /\.add-group:hover \.add-switch,\s*\.add-group:has\(:focus-visible\) \.add-switch,\s*\.add-group\.is-switch-on \.add-switch \{[^}]*\}/,
    )?.[0];
    expect(reveal).toBeDefined();
    expect(reveal).toMatch(/visibility:\s*visible/);
    expect(reveal).toMatch(new RegExp(`width:\\s*${sidebar.ADD_SWITCH_WIDTH_PX}px`));

    // No breakpoint suppresses the reveal any more (§A2 micro states): the
    // action row wraps at a width where the revealed switch will not fit.
    expect(css()).not.toMatch(/\.sidebar\.is-narrow \.add-group/);

    // Hover-less pointers have nothing to reveal it with, so it is always out.
    const hoverNone = css().match(/@media \(hover: none\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(hoverNone).toMatch(/\.add-switch/);
    expect(hoverNone).toMatch(/visibility:\s*visible/);
  });

  test('the revealed switch holds open briefly after the pointer leaves', () => {
    sidebar.initSidebar(makeCallbacks());
    const base = cssRule('.add-switch');
    // The grace period is a delay on every collapse-ward transition...
    expect(base).toMatch(/width 160ms cubic-bezier\(\.2, 0, 0, 1\) 250ms/);
    // ...including visibility, which otherwise flips instantly and takes both
    // the grace period and the collapse animation with it.
    expect(base).toMatch(/visibility 0s linear 410ms/);

    // Revealing zeroes the delay, so opening stays immediate.
    const reveal = css().match(
      /\.add-group:hover \.add-switch,\s*\.add-group:has\(:focus-visible\) \.add-switch,\s*\.add-group\.is-switch-on \.add-switch \{[^}]*\}/,
    )?.[0];
    expect(reveal).toMatch(/transition-delay:\s*0s/);
  });

  test('reduced motion makes the reveal and the knob instant', () => {
    sidebar.initSidebar(makeCallbacks());
    const block = css().match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(block).toContain('.add-switch');
    expect(block).toContain('.add-switch-knob');
    expect(block).toContain('.action-menu');
    expect(block).toMatch(/transition:\s*none/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// design spec v3 §C2 — export + chevron menu (replaces the import button)
// ═══════════════════════════════════════════════════════════════════════════

describe('export + chevron menu (design spec v3 §C2)', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }
  function chevron(): HTMLButtonElement {
    return shadowRoot().querySelector('.btn-menu') as HTMLButtonElement;
  }
  function menu(): HTMLElement {
    return shadowRoot().querySelector('.action-menu') as HTMLElement;
  }
  function importItem(): HTMLButtonElement {
    return shadowRoot().querySelector('.action-menu-item') as HTMLButtonElement;
  }
  function isOpen(): boolean {
    return menu().dataset.open === 'true';
  }
  /** A pointerdown as the real listeners see it (jsdom has no PointerEvent). */
  function pointerDown(target: EventTarget): void {
    const e = new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true });
    target.dispatchEvent(e);
  }

  test('the chevron is a menu button: haspopup, expanded, and a chevron that flips', () => {
    sidebar.initSidebar(makeCallbacks());
    expect(chevron().getAttribute('aria-haspopup')).toBe('menu');
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
    expect(chevron().innerHTML).toContain('M6 9l6 6 6-6');

    chevron().click();
    expect(isOpen()).toBe(true);
    expect(chevron().getAttribute('aria-expanded')).toBe('true');
    expect(chevron().innerHTML).toContain('M6 15l6-6 6 6');
    // Suppresses the group's press scale while the menu is down.
    expect((shadowRoot().querySelector('.export-group') as HTMLElement).classList.contains('is-menu-open')).toBe(true);

    chevron().click();
    expect(isOpen()).toBe(false);
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
    expect(chevron().innerHTML).toContain('M6 9l6 6 6-6');
  });

  test('a pointer click opens without moving focus; a keyboard activation focuses the first item', () => {
    sidebar.initSidebar(makeCallbacks());

    // detail >= 1 is a real pointer click.
    chevron().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(isOpen()).toBe(true);
    expect(shadowRoot().activeElement).not.toBe(importItem());
    chevron().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

    // detail 0 is Enter/Space on the button.
    chevron().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(isOpen()).toBe(true);
    expect(shadowRoot().activeElement).toBe(importItem());
  });

  test('ArrowDown/ArrowUp on the chevron open the menu straight into it', () => {
    sidebar.initSidebar(makeCallbacks());
    chevron().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(isOpen()).toBe(true);
    expect(shadowRoot().activeElement).toBe(importItem());
  });

  test('Esc closes and returns focus to the chevron; Tab just closes', () => {
    sidebar.initSidebar(makeCallbacks());

    chevron().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    importItem().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(isOpen()).toBe(false);
    expect(shadowRoot().activeElement).toBe(chevron());

    chevron().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    importItem().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(isOpen()).toBe(false);
  });

  test('outside pointerdown closes it — inside this closed shadow root and on the host page', () => {
    sidebar.initSidebar(makeCallbacks());

    // Inside the shadow root: the shadow-level listener sees the real path.
    chevron().click();
    pointerDown(shadowRoot().querySelector('.header') as HTMLElement);
    expect(isOpen()).toBe(false);

    // On the menu itself: stays open.
    chevron().click();
    pointerDown(importItem());
    expect(isOpen()).toBe(true);

    // On the host page: the document-level listener sees something that
    // isn't the sidebar host.
    pointerDown(document.body);
    expect(isOpen()).toBe(false);
  });

  test('closing the sidebar closes the menu', () => {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    chevron().click();
    expect(isOpen()).toBe(true);
    sidebar.closeSidebar();
    expect(isOpen()).toBe(false);
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
  });

  test('the group carries the border/fill and its halves the §C2 geometry', () => {
    sidebar.initSidebar(makeCallbacks());
    const group = cssRule('.export-group');
    expect(group).toMatch(/border:\s*1px solid var\(--sal-line\)/);
    expect(group).toMatch(/background:\s*var\(--sal-surface\)/);
    // The menu hangs out of the bottom of the box.
    expect(group).toMatch(/overflow:\s*visible/);
    // Scoped to the group's own halves: the menu is a child of this box, so
    // an unscoped :hover would light the group up whenever the pointer was
    // merely inside the open menu.
    expect(cssRule('.export-group:has(> button:hover)')).toMatch(/border-color:\s*var\(--sal-line-strong\)/);
    expect(cssRule('.export-group:has(> button:active)')).toMatch(/border-color:\s*var\(--sal-line-strong\)/);
    expect(css()).not.toMatch(/\n\s*\.export-group:active\s*\{/);
    expect(cssRule('.export-group:has(> button:focus-visible)')).toContain('0 0 0 4px var(--sal-focus)');

    expect(cssRule('.btn-export')).toMatch(/width:\s*36px/);
    expect(cssRule('.btn-export')).toMatch(/border-radius:\s*9px 0 0 9px/);
    const chev = cssRule('.btn-menu');
    expect(chev).toMatch(/width:\s*22px/);
    expect(chev).toMatch(/border-left:\s*1px solid var\(--sal-line\)/);
    expect(chev).toMatch(/border-radius:\s*0 9px 9px 0/);
    expect(chev).toMatch(/color:\s*var\(--sal-muted\)/);
    expect(cssRule('.btn-menu[aria-expanded="true"]')).toMatch(/background:\s*var\(--sal-hover\)/);

    const m = cssRule('.action-menu');
    expect(m).toMatch(/top:\s*42px/);
    expect(m).toMatch(/right:\s*0/);
    expect(m).toMatch(/min-width:\s*132px/);
    expect(m).toMatch(/padding:\s*4px/);
    expect(m).toMatch(/box-shadow:\s*var\(--sal-shadow-pop\)/);
    // Closed is the base state, so it carries the (shorter) exit timing.
    expect(m).toMatch(/visibility:\s*hidden/);
    expect(m).toMatch(/opacity 90ms cubic-bezier\(\.3, 0, 1, 1\)/);
    expect(cssRule('.action-menu[data-open="true"]')).toMatch(/opacity 120ms cubic-bezier\(\.2, 0, 0, 1\)/);

    const item = cssRule('.action-menu-item');
    expect(item).toMatch(/height:\s*32px/);
    expect(item).toMatch(/padding:\s*0 12px/);
    expect(item).toMatch(/border-radius:\s*var\(--sal-radius-sm\)/);
    expect(item).toMatch(/gap:\s*8px/);
    expect(item).toMatch(/white-space:\s*nowrap/);
  });

  test('hover and press land on the half under the pointer (design spec v4 §K)', () => {
    sidebar.initSidebar(makeCallbacks());
    // Same rule as the add group's §I: the fill is per half, so hovering the
    // chevron never lights export up (and vice versa).
    expect(cssRule('.btn-export:hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.btn-export:active')).toMatch(/background:\s*var\(--sal-press\)/);
    expect(cssRule('.btn-menu:hover')).toMatch(/background:\s*var\(--sal-hover\)/);
    expect(cssRule('.btn-menu:active')).toMatch(/background:\s*var\(--sal-press\)/);

    // The group acknowledges with its border alone — no fill of its own.
    expect(cssRule('.export-group:has(> button:hover)')).not.toMatch(/background:/);
    expect(cssRule('.export-group:has(> button:active)')).not.toMatch(/background:/);

    // The open-menu state keeps its own treatment on the chevron half, and is
    // written before the :hover/:active rules so the equal-specificity press
    // fill still reads while the menu is open.
    expect(css().indexOf('.btn-menu[aria-expanded="true"]')).toBeLessThan(css().indexOf('\n  .btn-menu:active'));

    // Nothing scales on press, here or anywhere else: a press changes the
    // fill of the half under the pointer and nothing more. Scaling the box
    // moved the half that was not pressed, and with the menu open it slid the
    // item out from under the pointer between mousedown and mouseup.
    expect(css()).not.toMatch(/scale\(0\.97\)/);

    // Disabled cancels the per-half fills as well as the group's own states.
    expect(css()).toMatch(
      /\.export-group\.is-disabled \.btn-export:hover,[\s\S]*?\.export-group\.is-disabled \.btn-menu:active \{[^}]*background:\s*transparent/,
    );
  });

  test('the fixed top section is one bordered block (design spec v4 §J)', () => {
    sidebar.initSidebar(makeCallbacks());
    // The divider that used to sit between the header and the action row is
    // now under the whole block, so the two read as one.
    expect(cssRule('.header')).not.toMatch(/border-bottom/);
    expect(cssRule('.action-row')).toMatch(/border-bottom:\s*1px solid var\(--sal-line\)/);
    // ...and nowhere inside it.
    expect(cssRule('.add-group')).not.toMatch(/border-bottom/);
    expect(cssRule('.export-group')).not.toMatch(/border-bottom/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// design spec v3 §H — the sidebar is "on hold" during add mode
// ═══════════════════════════════════════════════════════════════════════════

describe('sidebar on hold during add mode (design spec v3 §H)', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }
  function body(): HTMLElement {
    return shadowRoot().querySelector('.body') as HTMLElement;
  }
  function list(): HTMLElement {
    return shadowRoot().querySelector('.thumbnail-list') as HTMLElement;
  }
  function thumbs(): HTMLButtonElement[] {
    return Array.from(list().querySelectorAll('button.thumbnail'));
  }
  /** Each item's hover delete (design spec v4 §L). */
  function deletes(): HTMLButtonElement[] {
    return Array.from(list().querySelectorAll('button.thumbnail-delete'));
  }
  function openWithItems(n = 3): void {
    sidebar.initSidebar(makeCallbacks());
    sidebar.openSidebar();
    sidebar.setThumbnails(Array.from({ length: n }, (_, i) => makeItem({ id: i + 1 })));
  }

  test('the list dims, stops taking pointer input and leaves the tab order', () => {
    openWithItems();
    expect(thumbs().every((b) => !b.hasAttribute('tabindex'))).toBe(true);

    sidebar.setAddModeHold(true);
    expect(body().classList.contains('is-on-hold')).toBe(true);
    expect(cssRule('.body.is-on-hold')).toMatch(/opacity:\s*0\.5/);
    expect(css()).toMatch(
      /\.body\.is-on-hold \.thumbnail-list,\s*\.body\.is-on-hold \.thumbnail,\s*\.body\.is-on-hold \.thumbnail-delete \{[^}]*pointer-events:\s*none/,
    );
    expect(thumbs().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    // The hover delete (§L) is a second real button in the same <li>, so the
    // hold has to take it out of the tab order too.
    expect(deletes().length).toBeGreaterThan(0);
    expect(deletes().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);

    sidebar.setAddModeHold(false);
    expect(body().classList.contains('is-on-hold')).toBe(false);
    expect(thumbs().every((b) => !b.hasAttribute('tabindex'))).toBe(true);
    expect(deletes().every((b) => !b.hasAttribute('tabindex'))).toBe(true);
  });

  test('a repaint while on hold comes back on hold too', () => {
    openWithItems();
    sidebar.setAddModeHold(true);
    // e.g. the list refreshing after a capture while the switch keeps add mode on.
    sidebar.setThumbnails([makeItem({ id: 9 }), makeItem({ id: 10 })]);
    expect(thumbs().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
    expect(deletes().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);
  });

  test('the hover delete is refused while the list is held (design spec v4 §L)', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    sidebar.openSidebar();
    sidebar.setThumbnails([makeItem({ id: 1 })]);

    sidebar.setAddModeHold(true);
    deletes()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb.calls.deleteItem).toEqual([]);

    sidebar.setAddModeHold(false);
    deletes()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb.calls.deleteItem.map((i) => i.id)).toEqual([1]);
  });

  test('dock magnification is switched off at the handle for the whole hold', () => {
    openWithItems();
    list().dispatchEvent(new MouseEvent('pointerenter', { clientY: 10 }));
    expect(body().classList.contains('is-bleeding')).toBe(true);

    sidebar.setAddModeHold(true);
    expect(body().classList.contains('is-bleeding')).toBe(false);
    list().dispatchEvent(new MouseEvent('pointerenter', { clientY: 10 }));
    expect(body().classList.contains('is-bleeding')).toBe(false);

    sidebar.setAddModeHold(false);
    list().dispatchEvent(new MouseEvent('pointerenter', { clientY: 10 }));
    expect(body().classList.contains('is-bleeding')).toBe(true);
  });

  test('the export group is disabled with its menu closed; add/theme/close stay live', () => {
    openWithItems();
    const q = <T extends HTMLElement>(sel: string) => shadowRoot().querySelector(sel) as T;
    q<HTMLButtonElement>('.btn-menu').click();
    expect(q<HTMLElement>('.action-menu').dataset.open).toBe('true');

    sidebar.setAddModeHold(true);
    expect(q<HTMLElement>('.action-menu').dataset.open).toBe('false');
    expect(q<HTMLButtonElement>('.btn-export').disabled).toBe(true);
    expect(q<HTMLButtonElement>('.btn-menu').disabled).toBe(true);
    expect(q<HTMLElement>('.export-group').classList.contains('is-disabled')).toBe(true);
    // The user must always be able to stop, change theme or close.
    expect(q<HTMLButtonElement>('.btn-add').disabled).toBe(false);
    expect(q<HTMLButtonElement>('.add-switch').disabled).toBe(false);
    expect(q<HTMLButtonElement>('.btn-theme').disabled).toBe(false);
    expect(q<HTMLButtonElement>('.btn-close').disabled).toBe(false);

    sidebar.setAddModeHold(false);
    expect(q<HTMLButtonElement>('.btn-export').disabled).toBe(false);
    expect(q<HTMLButtonElement>('.btn-menu').disabled).toBe(false);
    expect(q<HTMLElement>('.export-group').classList.contains('is-disabled')).toBe(false);
  });

  test('an in-flight export stays disabled after the hold lifts, and vice versa', () => {
    openWithItems();
    const exportBtn = () => shadowRoot().querySelector('.btn-export') as HTMLButtonElement;
    sidebar.setExportButtonEnabled(false); // export round trip started
    sidebar.setAddModeHold(true);
    sidebar.setAddModeHold(false);
    expect(exportBtn().disabled).toBe(true); // still mid-export
    sidebar.setExportButtonEnabled(true);
    expect(exportBtn().disabled).toBe(false);
  });

  test('an in-flight import only disables the menu item', () => {
    openWithItems();
    const item = () => shadowRoot().querySelector('.action-menu-item') as HTMLButtonElement;
    sidebar.setImportButtonEnabled(false);
    expect(item().disabled).toBe(true);
    expect((shadowRoot().querySelector('.btn-export') as HTMLButtonElement).disabled).toBe(false);
    sidebar.setImportButtonEnabled(true);
    expect(item().disabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// design spec v2 §B — note-in-list hover "extension"
// ═══════════════════════════════════════════════════════════════════════════

describe('note-in-list hover extension (design spec v2 §B)', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }

  test('the thumbnail keeps radius on all four corners and paints above the note extension', () => {
    sidebar.initSidebar(makeCallbacks());
    const wrap = cssRule('.thumbnail-image-wrap');
    expect(wrap).toMatch(/border-radius:\s*var\(--sal-radius-md\)/);
    expect(wrap).not.toMatch(/border-top-left-radius:\s*0/);
    // Must out-stack the note extension so its tucked-under overlap is hidden.
    expect(wrap).toMatch(/z-index:\s*1/);
  });

  test('the note extension is tucked up under the thumbnail, bottom-only radius, inset border', () => {
    sidebar.initSidebar(makeCallbacks());
    const bg = cssRule('.thumbnail-note-bg');
    // One radius-md into the thumbnail itself. There is no longer a gap to
    // reach back through first: the note wrap has no margin of its own (v4
    // §L), so its top edge IS the thumbnail's bottom edge.
    expect(bg).toMatch(/top:\s*calc\(-1 \* var\(--sal-radius-md\)\)/);
    expect(cssRule('.thumbnail-note-wrap')).not.toMatch(/margin/);
    expect(bg).toMatch(/bottom:\s*0/);
    // Only the bottom corners are rounded — the top is hidden under the
    // thumbnail regardless.
    expect(bg).toMatch(/border-radius:\s*0 0 var\(--sal-radius-md\) var\(--sal-radius-md\)/);
    expect(bg).toMatch(/background:\s*var\(--sal-surface\)/);
    // Soft outer drop shadow + a 1px line border drawn INSIDE (inset), not
    // shadowNote's own outset ring.
    expect(bg).toMatch(/box-shadow:\s*0 10px 28px rgba\(0, 0, 0, 0\.18\), inset 0 0 0 1px var\(--sal-line\)/);
  });

  test('the note text itself never changes position/padding between rest and hover', () => {
    sidebar.initSidebar(makeCallbacks());
    const note = cssRule('.thumbnail-note');
    // Same padding/position at rest as in hover — no separate hover variant
    // of this rule exists; only .thumbnail-note-bg's opacity changes.
    expect(note).toMatch(/padding:\s*10px;/);
    expect(css()).not.toMatch(/\.thumbnail:hover \.thumbnail-note\s*\{[^}]*padding/);
  });

  test("the note's inset is the same on all four sides, top and bottom included (design spec v4 §L)", () => {
    sidebar.initSidebar(makeCallbacks());
    // One shorthand value, so the four sides cannot drift apart. It used to
    // be `8px 10px` — and the wrap's own 8px margin-top fell INSIDE the
    // extension background (whose visible top edge is the thumbnail's bottom
    // edge), so the text sat 16px below the thumbnail and 8px above the
    // background's bottom: visibly more above than below.
    const inset = /padding:\s*(\d+)px;/.exec(cssRule('.thumbnail-note'))?.[1];
    expect(inset).toBe('10');

    // With the gap gone, the background's own box is exactly the note's
    // padding box at the bottom (`bottom: 0`) and is hidden under the
    // thumbnail at the top — so both visible edges sit `inset` from the text.
    expect(cssRule('.thumbnail-note-wrap')).not.toMatch(/margin-top/);
    expect(cssRule('.thumbnail-note-bg')).toMatch(/bottom:\s*0/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// design spec v4 §L — the note's hover delete
// ═══════════════════════════════════════════════════════════════════════════

describe('note-in-list hover delete (design spec v4 §L)', () => {
  afterEach(() => {
    sidebar.destroySidebar();
    jest.restoreAllMocks();
    _resetThemeStateForTests();
  });

  function css(): string {
    return shadowRoot().querySelector('style')!.textContent ?? '';
  }
  function cssRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css().match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
  }
  function openWith(ids: number[]): void {
    sidebar.openSidebar();
    sidebar.setThumbnails(ids.map((id) => makeItem({ id })));
  }

  test('it is a sibling of the thumbnail button, never a child of it', () => {
    sidebar.initSidebar(makeCallbacks());
    openWith([1, 2]);
    const items = Array.from(shadowRoot().querySelectorAll('li.thumbnail-item'));
    expect(items.length).toBe(2);
    for (const li of items) {
      const del = li.querySelector('button.thumbnail-delete') as HTMLButtonElement;
      expect(del).not.toBeNull();
      // Nested buttons are invalid HTML and break activation — it must be a
      // direct child of the <li>, outside the thumbnail's own hit area.
      expect(del.parentElement).toBe(li);
      expect(li.querySelector('button.thumbnail')!.contains(del)).toBe(false);
    }
  });

  test('activating it deletes that item and never opens it', () => {
    const cb = makeCallbacks();
    sidebar.initSidebar(cb);
    openWith([4, 5]);

    const del = shadowRoot().querySelectorAll('button.thumbnail-delete')[1] as HTMLButtonElement;
    del.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(cb.calls.deleteItem.map((i) => i.id)).toEqual([5]);
    expect(cb.calls.openItem).toEqual([]);
  });

  test('it survives a repaint — every item gets one, every time', () => {
    sidebar.initSidebar(makeCallbacks());
    openWith([1]);
    expect(shadowRoot().querySelectorAll('button.thumbnail-delete').length).toBe(1);
    sidebar.setThumbnails([makeItem({ id: 2 }), makeItem({ id: 3 }), makeItem({ id: 4 })]);
    expect(shadowRoot().querySelectorAll('button.thumbnail-delete').length).toBe(3);
  });

  test('it sits over the thumbnail top-right, above the image, and rides the item', () => {
    sidebar.initSidebar(makeCallbacks());
    const rule = cssRule('.thumbnail-delete');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*8px/);
    expect(rule).toMatch(/right:\s*8px/);
    // .thumbnail-image-wrap carries z-index 1; this overlays it.
    expect(rule).toMatch(/z-index:\s*2/);
    expect(rule).toMatch(/width:\s*24px/);
    expect(rule).toMatch(/height:\s*24px/);
    // Inside the <li> dockMotion.ts transforms, so it magnifies with its item.
    expect(cssRule('.thumbnail-item')).toMatch(/transform-origin:\s*right center/);
  });

  test('its states follow §1/§L: neutral at rest, danger on hover and press', () => {
    sidebar.initSidebar(makeCallbacks());
    const rest = cssRule('.thumbnail-delete');
    expect(rest).toMatch(/background:\s*var\(--sal-surface\)/);
    expect(rest).toMatch(/border:\s*1px solid var\(--sal-line\)/);
    expect(rest).toMatch(/color:\s*var\(--sal-muted\)/);

    const hover = cssRule('.thumbnail-delete:hover');
    expect(hover).toMatch(/background:\s*var\(--sal-danger-soft\)/);
    expect(hover).toMatch(/color:\s*var\(--sal-danger\)/);

    const press = cssRule('.thumbnail-delete:active');
    expect(press).toMatch(/background:\s*var\(--sal-danger-press\)/);
    expect(press).not.toMatch(/scale\(/);

    expect(cssRule('.thumbnail-delete:focus-visible')).toContain('0 0 0 4px var(--sal-focus)');
  });

  test('it is invisible and click-through at rest, and appears with the note extension', () => {
    sidebar.initSidebar(makeCallbacks());
    const rest = cssRule('.thumbnail-delete');
    expect(rest).toMatch(/opacity:\s*0/);
    // An opacity-0 button is still clickable — without this it would be an
    // invisible trap over every screenshot's corner.
    expect(rest).toMatch(/pointer-events:\s*none/);
    // Same fade timing as .thumbnail-note-bg's own CSS fallback.
    expect(rest).toMatch(/opacity 140ms ease-out/);

    expect(css()).toMatch(
      /\.thumbnail-item:hover \.thumbnail-delete,\s*\.thumbnail-item:focus-within \.thumbnail-delete \{[^}]*opacity:\s*1/,
    );
    // Visible whenever it has focus (§L), so the ring never paints on an
    // invisible control.
    expect(cssRule('.thumbnail-delete:focus-visible')).toMatch(/opacity:\s*1/);
    // While the dock spring owns the inline opacity, the CSS transition
    // would fight it frame by frame — the fill/colour states stay.
    expect(cssRule('.thumbnail-list[data-dock="on"] .thumbnail-delete')).toMatch(/transition:/);
    expect(cssRule('.thumbnail-list[data-dock="on"] .thumbnail-delete')).not.toMatch(/opacity/);
  });
});
