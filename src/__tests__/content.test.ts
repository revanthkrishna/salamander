// content.ts orchestrates the "add note" off/on/locked state machine (design
// spec v2 §A) on top of the real sidebar.ts + addMode.ts modules, and is
// responsible for keeping the sidebar's button in sync with the real
// add-mode state on every exit path. content.ts itself is a private IIFE
// with no exported handlers — everything here drives it exactly the way the
// real page does: dispatch the chrome.runtime message that opens the
// sidebar, then click/keydown the real (open-mode) shadow DOM sidebar.ts and
// addMode.ts build.
//
// capture.ts's actual screenshot round trip (chrome.tabs.captureVisibleTab
// etc.) is mocked out — background.test.ts already covers that pipeline in
// isolation — everything else (sidebar.ts, addMode.ts, dockMotion.ts) is the
// real module, so this also exercises their real wiring together.
//
// content.ts is a side-effecting IIFE guarded by `window.__annotatorActive`,
// and sidebar.ts/addMode.ts keep their own module-level singleton state, so
// each test gets a *fresh* instance of all three via jest.resetModules() —
// see loadContent() below. Any module reference a test needs (addMode,
// sidebarApi, the captureAndSave mock) must be re-`require`d immediately
// after, in the same tick, so it resolves to the same cached instance
// content.ts itself just loaded — a reference captured before resetModules()
// would silently point at a stale, disconnected module object.

import { FeedbackItem } from '../types';

jest.mock('../capture', () => ({
  ...jest.requireActual('../capture'),
  captureAndSave: jest.fn(),
}));

// sidebar.ts/addMode.ts use closed shadow roots; force 'open'
// for the whole file so tests can query into them — same trick
// sidebar.test.ts uses.
const originalAttachShadow = HTMLElement.prototype.attachShadow;
beforeAll(() => {
  HTMLElement.prototype.attachShadow = function (init: ShadowRootInit) {
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  };
});
afterAll(() => {
  HTMLElement.prototype.attachShadow = originalAttachShadow;
});

function makeItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: 1,
    pageUrl: 'https://example.com/page',
    normalisedUrl: 'https://example.com/page',
    note: 'a note',
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

/** Items GET_PAGE_ITEMS resolves with — set per-test before loadContent(). */
let pageItems: FeedbackItem[] = [];

type MessageListener = (message: any, sender: unknown, sendResponse: (r?: unknown) => void) => void;
let onMessageListener: MessageListener = () => {};

function installChromeMocks(): void {
  const c = global.chrome as unknown as Record<string, any>;
  c.runtime = {
    ...(c.runtime ?? {}),
    lastError: null,
    onMessage: {
      addListener: jest.fn((fn: MessageListener) => {
        onMessageListener = fn;
      }),
    },
    sendMessage: jest.fn((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_PAGE_ITEMS') {
        callback?.({ ok: true, items: pageItems });
        return;
      }
      // Every other message type (SIDEBAR_OPENED/CLOSED, GET_IMAGE, ...) is
      // irrelevant to the add-mode state machine under test — a generic
      // "unreachable" response is exactly what every caller already treats
      // as a harmless no-op.
      callback?.(undefined);
    }),
  };
}

let addMode: typeof import('../addMode');
let sidebarApi: typeof import('../sidebar');
let captureAndSave: jest.Mock;

/** Fresh content.ts (+ its real sidebar.ts/addMode.ts) for one test. */
function loadContent(): void {
  jest.resetModules();
  delete (window as any).__annotatorActive;
  document.documentElement
    .querySelectorAll('#annotator-sidebar-host, #annotator-addmode-host')
    .forEach((el) => el.remove());
  document.documentElement.style.cssText = '';
  installChromeMocks();

  require('../content');
  addMode = require('../addMode');
  sidebarApi = require('../sidebar');
  captureAndSave = require('../capture').captureAndSave as jest.Mock;
}

/** Simulates background.ts's ACTIVATE — builds and opens the sidebar. */
function activate(): void {
  onMessageListener({ type: 'ACTIVATE', tabId: 1 }, {}, () => {});
}

function sidebarShadow(): ShadowRoot {
  const host = document.getElementById('annotator-sidebar-host') as HTMLElement;
  return host.shadowRoot!;
}

function addModeShadow(): ShadowRoot | null {
  const host = document.getElementById('annotator-addmode-host') as HTMLElement | null;
  return host?.shadowRoot ?? null;
}

function addButton(): HTMLButtonElement {
  return sidebarShadow().querySelector('.btn-add') as HTMLButtonElement;
}

/** The "keep add mode on" switch attached to it (design spec v3 §A2). */
function addSwitch(): HTMLButtonElement {
  return sidebarShadow().querySelector('.add-switch') as HTMLButtonElement;
}

/** The group that actually carries the on/switch-on paint. */
function addGroup(): HTMLElement {
  return sidebarShadow().querySelector('.add-group') as HTMLElement;
}

function dblclick(el: Element): void {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

/** Places the default-size selection (a plain click, no drag) and opens the
 *  comment box — the shared setup for the capture/cancel-while-locked tests. */
function placeSelection(): void {
  const blocker = addModeShadow()!.querySelector('.blocker') as HTMLElement;
  blocker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50, button: 0 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 50, clientY: 50, button: 0 }));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  jest.useRealTimers();
  pageItems = [];
});

describe('content.ts: "add note" toggle + "keep on" switch (design spec v3 §A2)', () => {
  test('starts off; a single click enters add mode immediately (on, switch off)', () => {
    loadContent();
    activate();
    const btn = addButton();

    expect(addMode.isAddModeActive()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();

    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-on')).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('add note (on)');
  });

  test('a second click with no following dblclick cancels add mode after the double-click window', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    const btn = addButton();

    btn.click(); // off -> on
    expect(addMode.isAddModeActive()).toBe(true);

    btn.click(); // on, unlocked -> deferred toggle-off
    expect(addMode.isAddModeActive()).toBe(true); // not yet — still deferred

    jest.advanceTimersByTime(500);
    expect(addMode.isAddModeActive()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('add note');
  });

  test('double-click turns the switch on instead of toggling off, and the deferred cancel never fires', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    const btn = addButton();

    btn.click(); // off -> on
    btn.click(); // schedules the deferred toggle-off
    dblclick(btn); // pre-empts it: turns the switch on instead

    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-on')).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('add note (kept on)');
    expect(addSwitch().getAttribute('aria-checked')).toBe('true');

    // The pre-empted timer must not still be pending.
    jest.advanceTimersByTime(1000);
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
  });

  test('a single click while the switch is on exits add mode and turns the switch off', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    btn.click();
    dblclick(btn); // switch on
    expect(addMode.isAddModeActive()).toBe(true);

    btn.click(); // switch on -> exits immediately, no dblclick-window delay
    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  test('Escape exits add mode and turns the switch off', () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    btn.click();
    dblclick(btn); // switch on
    expect(addMode.isAddModeActive()).toBe(true);

    // Registered on window in the capture phase at ensureStarted() time —
    // dispatching straight on window exercises exactly that listener.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
  });

  test('closing the sidebar exits an active add mode', () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    expect(addMode.isAddModeActive()).toBe(true);

    (sidebarShadow().querySelector('.btn-close') as HTMLButtonElement).click();

    expect(sidebarApi.isSidebarVisible()).toBe(false);
    expect(addMode.isAddModeActive()).toBe(false);
  });

  test('a successful capture while the switch is on re-enters add mode automatically, switch still on', async () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    btn.click();
    dblclick(btn); // switch on
    placeSelection();
    expect(addModeShadow()!.querySelector('.comment-box')).not.toBeNull();

    const textarea = addModeShadow()!.querySelector('.note-input') as HTMLTextAreaElement;
    textarea.value = 'looks off-centre';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const saveBtn = addModeShadow()!.querySelector('.btn-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    captureAndSave.mockResolvedValueOnce({ ok: true, item: makeItem({ id: 42 }) });
    saveBtn.click();
    await flushMicrotasks();
    await flushMicrotasks();

    // Straight back into placing — still locked, still active, fresh
    // placement (no comment box yet).
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
    expect(addModeShadow()!.querySelector('.comment-box')).toBeNull();
  });

  test('cancel inside the comment box while the switch is on cancels only that note and stays in add mode', async () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    btn.click();
    dblclick(btn); // switch on
    placeSelection();
    expect(addModeShadow()!.querySelector('.comment-box')).not.toBeNull();

    const cancelBtn = addModeShadow()!.querySelector('.btn-cancel') as HTMLButtonElement;
    cancelBtn.click();

    expect(captureAndSave).not.toHaveBeenCalled();
    expect(addMode.isAddModeActive()).toBe(true); // stayed in add mode
    expect(addGroup().classList.contains('is-switch-on')).toBe(true); // switch persists
    expect(addModeShadow()!.querySelector('.comment-box')).toBeNull(); // fresh placement
  });

  test('cancel while the switch is off exits add mode entirely', () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click(); // on, switch off
    placeSelection();
    const cancelBtn = addModeShadow()!.querySelector('.btn-cancel') as HTMLButtonElement;
    cancelBtn.click();

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
  });

  test('opening a note (the enlarged view) exits an active add mode first', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();
    await flushMicrotasks();

    const btn = addButton();
    btn.click();
    expect(addMode.isAddModeActive()).toBe(true);

    const thumb = sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement;
    expect(thumb).not.toBeNull();
    thumb.click();

    expect(addMode.isAddModeActive()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
  test('flicking the switch on from off starts add mode straight away', () => {
    loadContent();
    activate();

    addSwitch().click();

    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-on')).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
    expect(addSwitch().getAttribute('aria-checked')).toBe('true');
    expect(addButton().getAttribute('aria-label')).toBe('add note (kept on)');
  });

  test('flicking the switch off while add mode is on leaves it running for the current note', async () => {
    loadContent();
    activate();

    addSwitch().click(); // on + kept on
    addSwitch().click(); // kept on -> off

    expect(addMode.isAddModeActive()).toBe(true); // still placing
    expect(addGroup().classList.contains('is-on')).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);

    // …and the next successful capture now ends add mode, rather than
    // putting the user straight back into placing.
    placeSelection();
    const textarea = addModeShadow()!.querySelector('.note-input') as HTMLTextAreaElement;
    textarea.value = 'one and done';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    captureAndSave.mockResolvedValueOnce({ ok: true, item: makeItem({ id: 5 }) });
    (addModeShadow()!.querySelector('.btn-save') as HTMLButtonElement).click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
  });

  test('a button click while the switch is on turns both off (one click stops everything)', () => {
    loadContent();
    activate();

    addSwitch().click();
    expect(addMode.isAddModeActive()).toBe(true);

    addButton().click();

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');
  });

  test('Escape turns the switch off too', () => {
    loadContent();
    activate();
    addSwitch().click();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
  });

  test('the switch does not persist across a sidebar close/reopen', () => {
    loadContent();
    activate();
    addSwitch().click();
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);

    (sidebarShadow().querySelector('.btn-close') as HTMLButtonElement).click();
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});

    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');
  });
});

describe('content.ts: the sidebar is on hold during add mode (design spec v3 §H)', () => {
  function body(): HTMLElement {
    return sidebarShadow().querySelector('.body') as HTMLElement;
  }

  test('entering add mode holds the list and disables the export group; leaving restores both', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();

    const thumb = () => sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement;
    const exportBtn = () => sidebarShadow().querySelector('.btn-export') as HTMLButtonElement;
    const menuBtn = () => sidebarShadow().querySelector('.btn-menu') as HTMLButtonElement;
    expect(thumb().hasAttribute('tabindex')).toBe(false);

    addButton().click();

    expect(body().classList.contains('is-on-hold')).toBe(true);
    expect(thumb().getAttribute('tabindex')).toBe('-1');
    expect(exportBtn().disabled).toBe(true);
    expect(menuBtn().disabled).toBe(true);
    // The controls that stop add mode stay live.
    expect(addButton().disabled).toBe(false);
    expect(addSwitch().disabled).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(body().classList.contains('is-on-hold')).toBe(false);
    expect(thumb().hasAttribute('tabindex')).toBe(false);
    expect(exportBtn().disabled).toBe(false);
    expect(menuBtn().disabled).toBe(false);
  });

  test('an open chevron menu is closed by entering add mode', () => {
    loadContent();
    activate();
    const menu = () => sidebarShadow().querySelector('.action-menu') as HTMLElement;

    (sidebarShadow().querySelector('.btn-menu') as HTMLButtonElement).click();
    expect(menu().dataset.open).toBe('true');

    addButton().click();
    expect(menu().dataset.open).toBe('false');
  });

  test('the hold survives the list repaint after a capture while the switch is on', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();

    addSwitch().click(); // add mode on and kept on
    placeSelection();
    const textarea = addModeShadow()!.querySelector('.note-input') as HTMLTextAreaElement;
    textarea.value = 'still going';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    captureAndSave.mockResolvedValueOnce({ ok: true, item: makeItem({ id: 8 }) });
    (addModeShadow()!.querySelector('.btn-save') as HTMLButtonElement).click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(addMode.isAddModeActive()).toBe(true);
    expect(body().classList.contains('is-on-hold')).toBe(true);
    for (const btn of Array.from(sidebarShadow().querySelectorAll('button.thumbnail'))) {
      expect(btn.getAttribute('tabindex')).toBe('-1');
    }
  });
});

describe('content.ts: enlarged view wiring (design spec v2 §D)', () => {
  async function openFirstNote(): Promise<void> {
    pageItems = [makeItem({ id: 7 }), makeItem({ id: 8, screenshotKey: 'key-8' })];
    loadContent();
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
  }

  test('clicking a note expands the sidebar into the enlarged view', async () => {
    await openFirstNote();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    expect(sidebarShadow().querySelector('.xp-title')!.textContent).toBe('feedback #7');
    // The full-resolution image is fetched for the main note.
    const sent = (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
    expect(sent).toContainEqual({ type: 'GET_IMAGE', screenshotKey: 'key-1' });
  });

  test('entering add mode collapses the enlarged view first (instantly)', async () => {
    await openFirstNote();
    addButton().click();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(sidebarShadow().querySelector('.enlarged')).toBeNull();
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('autosave and delete go through UPDATE_NOTE / DELETE_ITEM', async () => {
    await openFirstNote();
    jest.useFakeTimers();
    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = 'changed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(700);
    (sidebarShadow().querySelector('.xp-delete') as HTMLButtonElement).click();
    const sent = (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'UPDATE_NOTE', itemId: 7, note: 'changed' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'DELETE_ITEM', itemId: 7 }));
  });

  test('the extension icon cannot close the sidebar while the note is empty', async () => {
    await openFirstNote();
    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    expect(sidebarApi.isSidebarVisible()).toBe(true);
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);

    ta.value = 'ok';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(sidebarApi.isSidebarVisible()).toBe(false);
  });
});

describe('content.ts: review fixes', () => {
  test('a lone click while on (no click just before it) turns add mode off immediately', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    const btn = addButton();

    btn.click(); // off -> on
    jest.advanceTimersByTime(1000); // well past the double-click window
    btn.click();
    expect(addMode.isAddModeActive()).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  test('shift+click from off enters add mode with the switch already on', () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
  });

  test('shift+Enter while on turns the switch on', () => {
    loadContent();
    activate();
    const btn = addButton();

    btn.click();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(true);
  });

  test('Esc that ends an IME composition does not exit add mode', () => {
    loadContent();
    activate();
    addButton().click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('opening a note is ignored while the add-mode comment box holds typed text', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();

    addButton().click();
    placeSelection();
    const textarea = addModeShadow()!.querySelector('.note-input') as HTMLTextAreaElement;
    textarea.value = 'half-written';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(addMode.isAddModeActive()).toBe(true);
    expect(textarea.value).toBe('half-written');
    expect(sidebarShadow().querySelector('.notif-text')!.textContent).toBe('finish or cancel your note first.');
  });

  test('pagehide flushes the enlarged view\'s pending edit (fire-and-forget)', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();

    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = 'typed before unload';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));

    const updates = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map((c) => c[0])
      // (Earlier tests' content.ts instances still listen on this window.)
      .filter((m) => m?.type === 'UPDATE_NOTE' && m.note === 'typed before unload');
    expect(updates).toHaveLength(1); // beforeunload + pagehide: sent once
  });
});
