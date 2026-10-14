// content.ts orchestrates the "add note" off/on/kept-on state machine (design
// spec v3 §A2) on top of the real sidebar.ts + addMode.ts modules, and is
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
// The list delete reuses the enlarged view's failure copy (design spec v4 §L).
import {
  DELETE_ALL_FAILED_MESSAGE,
  DELETE_ERROR_MESSAGE,
  DOMAIN_COUNT_FAILED_MESSAGE,
  IMPORT_FAILED_MESSAGE,
  deleteAllConfirmMessage,
  IMPORT_REPLACE_CONFIRM_MESSAGE,
  DELETE_ALL_CONFIRM_LABEL,
  IMPORT_REPLACE_CONFIRM_LABEL,
  SITE_LOAD_FAILED_MESSAGE,
  PAGE_HAS_NO_NOTES_MESSAGE,
  SAVE_ERROR_MESSAGE,
  EXPORT_FAILED_MESSAGE,
  NOTHING_TO_EXPORT_MESSAGE,
  importErrorMessage,
} from '../copy';
import { makeItem } from './helpers/items';

jest.mock('../capture', () => ({
  ...jest.requireActual('../capture'),
  captureAndSave: jest.fn(),
}));

// The §5 validation ladder has its own suite (import.test.ts); here the
// picked file is taken as already valid so the tests can drive what
// content.ts does AROUND it — the count read, §5 #10 and the replace.
jest.mock('../import', () => ({
  parseImportBundle: jest.fn(),
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

/** Items GET_PAGE_ITEMS resolves with — set per-test before loadContent(). */
let pageItems: FeedbackItem[] = [];
/** This page's edited name, as GET_PAGE_ITEMS reports it. */
let pageEditedTitle: string | null = null;
/** Other pages of the site GET_SITE_PAGES lists before this one. */
let sitePagesBefore: Array<{ normalisedUrl: string; editedTitle: string | null; items: FeedbackItem[] }> = [];

type MessageListener = (message: any, sender: unknown, sendResponse: (r?: unknown) => void) => void;
let onMessageListener: MessageListener = () => {};

function installChromeMocks(): void {
  const c = global.chrome as unknown as Record<string, any>;
  c.runtime = {
    ...(c.runtime ?? {}),
    // Alive: a test that kills the context (deletes it) must not leak that.
    id: 'salamander-test-extension',
    lastError: null,
    onMessage: {
      addListener: jest.fn((fn: MessageListener) => {
        onMessageListener = fn;
      }),
    },
    sendMessage: jest.fn((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_PAGE_ITEMS') {
        callback?.({ ok: true, items: pageItems, editedTitle: pageEditedTitle });
        return;
      }
      if (message?.type === 'GET_SITE_PAGES') {
        // The site is this page's notes plus whatever a test adds.
        const here = pageItems.length > 0 ? [{ normalisedUrl: pageItems[0].normalisedUrl, editedTitle: null, items: pageItems }] : [];
        callback?.({ ok: true, pages: [...sitePagesBefore, ...here] });
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

// Each test loads a fresh content.ts, but the instance a test before it
// loaded would otherwise stay alive on the shared jsdom window: its history
// patch and its window/document listeners would still answer navigations
// and keys. So every window/document listener registered since the last
// load is removed, and history's methods put back, before the next one.
const pristinePushState = history.pushState;
const pristineReplaceState = history.replaceState;
type Registration = [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];
let registrations: Registration[] = [];
const captureOf = (options: boolean | AddEventListenerOptions | undefined): boolean =>
  typeof options === 'boolean' ? options : !!options?.capture;
/** The window/document listeners registered since the last load and not
 *  removed since. */
function liveRegistrations(): Registration[] {
  return registrations;
}
for (const target of [window, document] as EventTarget[]) {
  const remove = target.removeEventListener;
  target.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    registrations = registrations.filter(
      ([t, ty, l, o]) => !(t === target && ty === type && l === listener && captureOf(o) === captureOf(options as boolean | AddEventListenerOptions | undefined)),
    );
    return remove.call(this, type, listener, options);
  } as typeof target.removeEventListener;
  const add = target.addEventListener;
  target.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (listener) registrations.push([target, type, listener, options]);
    return add.call(this, type, listener, options);
  } as typeof target.addEventListener;
}
function forgetPreviousInstance(): void {
  // Its own teardown first (its sidebar's observers and timers included).
  const previous = (window as { __annotatorActive?: unknown }).__annotatorActive as { teardown?: () => void } | undefined;
  previous?.teardown?.();
  for (const [target, type, listener, options] of [...registrations]) target.removeEventListener(type, listener, options);
  registrations = [];
  history.pushState = pristinePushState;
  history.replaceState = pristineReplaceState;
}

/** Fresh content.ts (+ its real sidebar.ts/addMode.ts) for one test. */
function loadContent(): void {
  forgetPreviousInstance();
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

/** A question the "more options" menu asked (design spec §AF), as shown. */
interface Asked {
  text: string | null;
  label: string | null;
  tone: 'accent' | 'danger';
}

/** If the menu has turned into a question, read it off the real UI, record
 *  it, and answer it with its own buttons. */
async function answerIfAsked(asked: Asked[], yes: boolean): Promise<void> {
  const root = sidebarShadow();
  const menu = root.querySelector('.action-menu') as HTMLElement;
  if (!menu.classList.contains('is-confirm') || menu.dataset.open !== 'true') return;
  const ok = root.querySelector('.confirm-btn.is-confirm') as HTMLButtonElement;
  asked.push({
    text: root.querySelector('.action-menu-confirm-text')!.textContent,
    label: ok.textContent,
    tone: ok.classList.contains('is-accent') ? 'accent' : 'danger',
  });
  (yes ? ok : (root.querySelector('.confirm-btn.is-cancel') as HTMLButtonElement)).click();
  await flushMicrotasks();
  await flushMicrotasks();
}

afterEach(() => {
  sitePagesBefore = [];
  pageEditedTitle = null;
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
    // The NAME stays put (aria-pressed announces the state); the tooltip is
    // what says what a click will do now.
    expect(btn.getAttribute('aria-label')).toBe('add note');
    expect(btn.dataset.tip).toBe('cancel note');
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
    expect(btn.getAttribute('aria-label')).toBe('add note');
    expect(btn.dataset.tip).toBe('stop adding notes');
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

  test('a capture takes the sidebar\'s tooltip down at once, so it stays out of the screenshot', async () => {
    loadContent();
    activate();
    const btn = addButton();
    btn.click();
    placeSelection();
    const textarea = addModeShadow()!.querySelector('.note-input') as HTMLTextAreaElement;
    textarea.value = 'tooltip check';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // A sidebar tooltip is up (the pointer resting on a sidebar control).
    const shadow = sidebarShadow();
    const tipped = shadow.querySelector('[data-tip]') as HTMLElement;
    jest.useFakeTimers();
    tipped.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, composed: true }));
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    const tip = shadow.querySelector('.sal-tip') as HTMLElement;
    expect(tip.dataset.open).toBe('true');

    let hideTip: string | undefined;
    captureAndSave.mockImplementationOnce(async (_r: unknown, ui: { hide: () => void }) => {
      ui.hide();
      hideTip = `${tip.dataset.open}|${tip.style.transition}`;
      return { ok: true, item: makeItem({ id: 7 }) };
    });
    (addModeShadow()!.querySelector('.btn-save') as HTMLButtonElement).click();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(hideTip).toBe('false|none');
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
    expect(addButton().getAttribute('aria-label')).toBe('add note');
    expect(addButton().dataset.tip).toBe('stop adding notes');
  });

  test('clicking the merged control (either half) stops everything', () => {
    loadContent();
    activate();

    addSwitch().click(); // on + kept on — the two halves are now one button
    addSwitch().click(); // a click on the switch half of a merged control

    // Merged means the switch is no longer its own control: clicking it is
    // clicking the button, which exits add mode and clears the switch
    // together (§A2 micro states).
    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(addSwitch().getAttribute('aria-checked')).toBe('false');
  });

  test('add mode with the switch off ends at the next successful capture', async () => {
    loadContent();
    activate();

    addButton().click(); // on, switch off
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);

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

describe('content.ts: Option/Alt+N adds one note (src/shortcut.ts)', () => {
  function pressShortcut(init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { code: 'KeyN', key: 'Dead', altKey: true, bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(e);
    return e;
  }

  test('enters add mode for one note (switch off), and the page never sees the key', () => {
    loadContent();
    activate();
    const e = pressShortcut();
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-on')).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  test('does nothing while a note is already being placed', () => {
    loadContent();
    activate();
    addButton().click();
    const e = pressShortcut();
    expect(addMode.isAddModeActive()).toBe(true);
    expect(addGroup().classList.contains('is-switch-on')).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  test('does nothing while the sidebar is closed', () => {
    loadContent();
    activate();
    (sidebarShadow().querySelector('.btn-close') as HTMLButtonElement).click();
    const e = pressShortcut();
    expect(addMode.isAddModeActive()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  test('does nothing while the user is typing in the page', () => {
    loadContent();
    activate();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const e = pressShortcut();
    expect(addMode.isAddModeActive()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    input.remove();
  });

  test('does nothing while the enlarged view is open', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    pressShortcut();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    expect(addMode.isAddModeActive()).toBe(false);
  });

  test('other modifiers leave it alone', () => {
    loadContent();
    activate();
    pressShortcut({ ctrlKey: true });
    pressShortcut({ shiftKey: true });
    pressShortcut({ metaKey: true });
    expect(addMode.isAddModeActive()).toBe(false);
  });

  test("add note's tooltip names the shortcut only while it would add one", () => {
    loadContent();
    activate();
    expect(addButton().dataset.tipKey).toMatch(/^(⌥N|Alt\+N)$/);
    addButton().click();
    expect(addButton().dataset.tipKey).toBeUndefined();
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

  test('an open "more options" menu is closed by entering add mode', () => {
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

describe('content.ts: enlarged view wiring (design spec §AH)', () => {
  const OTHER = 'https://example.com/other';

  async function openFirstNote(): Promise<void> {
    pageItems = [makeItem({ id: 7 }), makeItem({ id: 8, screenshotKey: 'key-8' })];
    loadContent();
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    await flushMicrotasks();
  }

  const sent = () => (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);

  test('clicking a note reads the whole site (GET_SITE_PAGES), then expands into the enlarged view', async () => {
    sitePagesBefore = [
      { normalisedUrl: OTHER, editedTitle: 'the other page', items: [makeItem({ id: 3, normalisedUrl: OTHER, screenshotKey: 'key-3' })] },
    ];
    await openFirstNote();
    expect(sent()).toContainEqual({ type: 'GET_SITE_PAGES', domain: 'localhost' });
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    // Both pages, in the order the site gave them; numbers per page.
    const names = [...sidebarShadow().querySelectorAll('.xp-page-name')].map((n) => n.textContent);
    expect(names).toEqual(['the other page', 'example']);
    expect([...sidebarShadow().querySelectorAll('.xp-note-num')].map((n) => n.textContent)).toEqual(['#1', '#1', '#2']);
    // The clicked note's text area has focus.
    const focused = sidebarShadow().activeElement as HTMLTextAreaElement;
    expect(focused.closest('.xp-note')!.getAttribute('data-item-id')).toBe('7');
    // Full-resolution images are fetched.
    expect(sent()).toContainEqual({ type: 'GET_IMAGE', screenshotKey: 'key-1' });
  });

  test('if the site cannot be read, the view opens on this page alone, says so in its top bar, and keeps the page\'s stored name', async () => {
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    pageItems = [makeItem({ id: 7 })];
    pageEditedTitle = 'the stored name';
    loadContent();
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_SITE_PAGES') return callback?.({ ok: false, message: SITE_LOAD_FAILED_MESSAGE });
      return base(message, callback);
    });
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    expect(sidebarShadow().querySelectorAll('.xp-note')).toHaveLength(1);
    // Said where it is looked at — not in the banner hidden behind the view.
    const notice = sidebarShadow().querySelector('.xp-notice')!;
    expect(notice.textContent).toBe(SITE_LOAD_FAILED_MESSAGE);
    expect(notice.getAttribute('role')).toBe('status');
    expect(sidebarShadow().querySelector('.notif')!.hasAttribute('hidden')).toBe(true);
    // The heading has the stored name, and committing it unchanged writes nothing.
    expect(sidebarShadow().querySelector('.xp-page-name')!.textContent).toBe('the stored name');
    (sidebarShadow().querySelector('.xp-page-edit') as HTMLButtonElement).click();
    (sidebarShadow().querySelector('.xp-page-save') as HTMLButtonElement).click();
    const sent = (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
    expect(sent.some((m) => m?.type === 'SET_PAGE_TITLE')).toBe(false);
  });

  test('entering add mode while the site is being read opens nothing', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    activate();
    await flushMicrotasks();
    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    addButton().click();
    await flushMicrotasks();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('entering add mode collapses the enlarged view first (instantly)', async () => {
    await openFirstNote();
    addButton().click();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(sidebarShadow().querySelector('.enlarged')).toBeNull();
    expect(addMode.isAddModeActive()).toBe(true);
  });

  test('autosave, delete and a rename go through UPDATE_ITEM / DELETE_ITEM / SET_PAGE_TITLE', async () => {
    await openFirstNote();
    jest.useFakeTimers();
    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = 'changed';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(700);
    (sidebarShadow().querySelector('.xp-note-delete') as HTMLButtonElement).click();
    (sidebarShadow().querySelector('.xp-page-edit') as HTMLButtonElement).click();
    const input = sidebarShadow().querySelector('.xp-page-input') as HTMLInputElement;
    input.value = 'renamed';
    (sidebarShadow().querySelector('.xp-page-save') as HTMLButtonElement).click();
    expect(sent()).toContainEqual(expect.objectContaining({ type: 'UPDATE_ITEM', itemId: 7, patch: { note: 'changed' } }));
    expect(sent()).toContainEqual(expect.objectContaining({ type: 'DELETE_ITEM', itemId: 7 }));
    expect(sent()).toContainEqual({
      type: 'SET_PAGE_TITLE',
      domain: 'localhost',
      normalisedUrl: pageItems[0].normalisedUrl,
      title: 'renamed',
    });
  });

  test('the top bar\'s delete all, once confirmed there, deletes the whole site with no second question, and the list empties', async () => {
    await openFirstNote();
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'DELETE_DOMAIN_DATA') {
        pageItems = [];
        return callback?.({ ok: true });
      }
      if (message?.type === 'GET_DOMAIN_ITEM_COUNT') return callback?.({ ok: true, count: pageItems.length, pageCount: pageItems.length ? 1 : 0 });
      return base(message, callback);
    });
    (chrome.runtime.sendMessage as jest.Mock).mockClear();
    jest.useFakeTimers();
    (sidebarShadow().querySelector('.xp-delete-all') as HTMLButtonElement).click();
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'DELETE_DOMAIN_DATA' }));
    (sidebarShadow().querySelector('.xp-confirm-btn.is-danger') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sent()).toContainEqual({ type: 'DELETE_DOMAIN_DATA', domain: 'localhost' });
    // No count is read and the menu asks nothing: the top bar already did.
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'GET_DOMAIN_ITEM_COUNT' }));
    expect(sidebarShadow().querySelector('.action-menu.is-confirm')).toBeNull();
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(sidebarShadow().querySelectorAll('button.thumbnail')).toHaveLength(0);
    expect((sidebarShadow().querySelector('.empty-state') as HTMLElement).hidden).toBe(false);
  });

  test('an edit to a note deleted elsewhere (NOT_FOUND) is not reported saved: the note keeps its draft and says it could not save', async () => {
    await openFirstNote();
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'UPDATE_ITEM') return callback?.({ ok: false, code: 'NOT_FOUND', message: SAVE_ERROR_MESSAGE });
      return base(message, callback);
    });
    jest.useFakeTimers();
    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = 'typed after the delete';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    jest.advanceTimersByTime(700);
    jest.useRealTimers();
    await flushMicrotasks();
    expect(sent()).toContainEqual(expect.objectContaining({ type: 'UPDATE_ITEM', patch: { note: 'typed after the delete' } }));
    expect(sidebarShadow().querySelector('.xp-note-status')!.textContent).toBe(SAVE_ERROR_MESSAGE);
    expect(ta.value).toBe('typed after the delete');
  });

  test('renaming a page whose notes were deleted elsewhere: the NO_NOTES reply says so under the heading', async () => {
    await openFirstNote();
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'SET_PAGE_TITLE') return callback?.({ ok: false, code: 'NO_NOTES', message: 'x' });
      return base(message, callback);
    });
    (sidebarShadow().querySelector('.xp-page-edit') as HTMLButtonElement).click();
    (sidebarShadow().querySelector('.xp-page-input') as HTMLInputElement).value = 'renamed';
    (sidebarShadow().querySelector('.xp-page-save') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(sidebarShadow().querySelector('.xp-page-status')!.textContent).toBe(PAGE_HAS_NO_NOTES_MESSAGE);
    expect(sidebarShadow().querySelector('.xp-page-name')!.textContent).toBe('example');
  });

  test('the extension icon cannot close the sidebar while a note is empty', async () => {
    await openFirstNote();
    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    expect(sidebarApi.isSidebarVisible()).toBe(true);
    expect(sidebarApi.isEnlargedViewOpen()).toBe(true);
    expect(sidebarShadow().activeElement).toBe(ta);

    ta.value = 'ok';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(sidebarApi.isSidebarVisible()).toBe(false);
  });
});

describe("content.ts: the note list's hover delete (design spec v4 §L)", () => {
  /** Two notes in the list, sidebar open, nothing else in flight. */
  async function openList(): Promise<void> {
    pageItems = [makeItem({ id: 7 }), makeItem({ id: 8, screenshotKey: 'key-8' })];
    loadContent();
    activate();
    await flushMicrotasks();
  }

  function deletes(): HTMLButtonElement[] {
    return Array.from(sidebarShadow().querySelectorAll('button.thumbnail-delete'));
  }

  test('it deletes through the same DELETE_ITEM path as the enlarged view, then refreshes', async () => {
    await openList();
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    deletes()[1].click();
    await flushMicrotasks();

    const sent = (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'DELETE_ITEM',
        itemId: 8,
        normalisedUrl: 'https://example.com/page',
      }),
    );
    // No confirmation step of any kind stands between the click and the send.
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
  });

  test('a failed delete shows the enlarged view\'s own error copy, and nothing else', async () => {
    await openList();
    // The shared mock answers every non-GET_PAGE_ITEMS message with
    // `undefined`, which is exactly the "round trip failed" case.
    deletes()[0].click();
    await flushMicrotasks();

    const notif = sidebarShadow().querySelector('.notif-text') as HTMLElement;
    expect(notif.textContent).toBe(DELETE_ERROR_MESSAGE);
    expect(notif.textContent).toBe(notif.textContent!.toLowerCase());
  });

  test('it never opens the note it is deleting', async () => {
    await openList();
    deletes()[0].click();
    await flushMicrotasks();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
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
    await flushMicrotasks();

    const ta = sidebarShadow().querySelector('.xp-note-input') as HTMLTextAreaElement;
    ta.value = 'typed before unload';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));

    const updates = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map((c) => c[0])
      // (Earlier tests' content.ts instances still listen on this window.)
      .filter((m) => m?.type === 'UPDATE_ITEM' && m.patch?.note === 'typed before unload');
    expect(updates).toHaveLength(1); // beforeunload + pagehide: sent once
  });
});

describe('content.ts: the pencil colour and the pencil menu (design spec §AB)', () => {
  let penReply: { color: string | null } | undefined;
  let pendingPenReply: ((r: unknown) => void) | null;
  let deferPenReply: boolean;

  function installPenMocks(): void {
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_PEN_COLOR') {
        if (deferPenReply) pendingPenReply = (r) => callback?.(r);
        else callback?.(penReply);
        return;
      }
      base(message, callback);
    });
  }

  async function enterAndPlace(): Promise<ShadowRoot> {
    pageItems = [];
    loadContent();
    installPenMocks();
    activate();
    await flushMicrotasks();
    addButton().click();
    await flushMicrotasks();
    const root = addModeShadow()!;
    const blocker = root.querySelector('.blocker') as HTMLElement;
    blocker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 200, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 200 }));
    return root;
  }

  function sent(): any[] {
    return (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
  }

  beforeEach(() => {
    penReply = { color: null };
    pendingPenReply = null;
    deferPenReply = false;
  });

  test('entering add mode asks the service worker for the session\'s colour and applies it', async () => {
    penReply = { color: '#E5484D' };
    const root = await enterAndPlace();
    expect(sent()).toContainEqual({ type: 'GET_PEN_COLOR' });
    const checked = root.querySelector('.swatch[aria-checked="true"]') as HTMLElement;
    expect(checked.dataset.color).toBe('#E5484D');
  });

  test('a fresh browser session (nothing stored) starts on yellow', async () => {
    const root = await enterAndPlace();
    expect((root.querySelector('.swatch[aria-checked="true"]') as HTMLElement).dataset.color).toBe('#E8B600');
  });

  test('picking a swatch remembers it for the session via SET_PEN_COLOR', async () => {
    const root = await enterAndPlace();
    (root.querySelector('.swatch[data-color="#1A1712"]') as HTMLButtonElement).click();
    expect(sent()).toContainEqual({ type: 'SET_PEN_COLOR', color: '#1A1712' });
  });

  test('a late GET_PEN_COLOR reply never overrides a colour picked after asking', async () => {
    deferPenReply = true;
    const root = await enterAndPlace();
    (root.querySelector('.swatch[data-color="#1A1712"]') as HTMLButtonElement).click();
    pendingPenReply!({ color: '#E5484D' });
    await flushMicrotasks();
    expect(addMode.getPenColor()).toBe('#1A1712');
  });

  test('esc with the pencil menu open closes the menu, not add mode; the next esc exits', async () => {
    const root = await enterAndPlace();
    const pencil = root.querySelector('.btn-pencil') as HTMLButtonElement;
    pencil.click();
    expect((root.querySelector('.draw-menu') as HTMLElement).dataset.open).toBe('true');

    pencil.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect((root.querySelector('.draw-menu') as HTMLElement).dataset.open).toBe('false');
    expect(addMode.isAddModeActive()).toBe(true);
    expect(root.activeElement).toBe(pencil);

    pencil.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(addMode.isAddModeActive()).toBe(false);
  });

  test('a stroke with no note yet counts as unfinished work: opening a note is refused', async () => {
    pageItems = [makeItem({ id: 7 })];
    loadContent();
    installPenMocks();
    activate();
    await flushMicrotasks();
    addButton().click();
    const root = addModeShadow()!;
    (root.querySelector('.blocker') as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 200, button: 0 }),
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 200 }));
    const surface = root.querySelector('.draw-surface') as HTMLElement;
    surface.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 200, button: 0 }));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 310, clientY: 210 }));

    (sidebarShadow().querySelector('button.thumbnail') as HTMLButtonElement).click();
    expect(sidebarApi.isEnlargedViewOpen()).toBe(false);
    expect(addMode.isAddModeActive()).toBe(true);
    expect(sidebarShadow().querySelector('.notif-text')!.textContent).toBe('finish or cancel your note first.');
  });
});

describe('content.ts: import (§1.7) — asked in the menu before the file is picked (design spec §AF)', () => {
  const BUNDLE = {
    domain: 'localhost',
    items: [
      { id: 4, normalisedUrl: 'localhost/a', screenshotDataUrl: 'data:image/png;base64,NA==' },
      { id: 6, normalisedUrl: 'localhost/a', screenshotDataUrl: 'data:image/png;base64,Ng==' },
    ],
  };
  let countReply: unknown;
  let replaceReply: unknown;
  /** IMPORT_STAGE_IMAGE's answer for each staged screenshot, by data URL. */
  let stageReply: (dataUrl: string) => unknown;
  let confirmAnswer: boolean;
  /** The questions asked, read off the real menu. */
  let asked: Asked[];
  /** Clicks on the hidden file input: the native picker opening. */
  let fileInputClick: jest.SpyInstance;
  const pickerOpens = () => fileInputClick.mock.instances.filter((el) => (el as HTMLInputElement).type === 'file').length;

  function installImportMocks(): void {
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_DOMAIN_ITEM_COUNT') {
        callback?.(countReply);
        return;
      }
      if (message?.type === 'IMPORT_STAGE_IMAGE') {
        callback?.(stageReply(message.dataUrl));
        return;
      }
      if (message?.type === 'IMPORT_COMMIT') {
        callback?.(replaceReply);
        return;
      }
      base(message, callback);
    });
    // Re-required after loadContent()'s resetModules, so it is the instance
    // content.ts itself imported.
    (require('../import').parseImportBundle as jest.Mock).mockResolvedValue(BUNDLE);
  }

  function sent(): any[] {
    return (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
  }
  function notifText(): string | null {
    return sidebarShadow().querySelector('.notif-text')?.textContent ?? null;
  }
  function importItem(): HTMLButtonElement {
    return sidebarShadow().querySelector('.action-menu-item.is-import') as HTMLButtonElement;
  }
  function menuOpen(): boolean {
    return (sidebarShadow().querySelector('.action-menu') as HTMLElement).dataset.open === 'true';
  }

  async function open(): Promise<void> {
    pageItems = [];
    loadContent();
    asked = [];
    fileInputClick = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    installImportMocks();
    activate();
    await flushMicrotasks();
    (chrome.runtime.sendMessage as jest.Mock).mockClear();
  }
  async function chooseImport(): Promise<void> {
    (sidebarShadow().querySelector('.btn-menu') as HTMLButtonElement).click();
    importItem().click();
    await flushMicrotasks();
    await flushMicrotasks();
    await answerIfAsked(asked, confirmAnswer);
  }
  async function pickFile(): Promise<void> {
    const input = sidebarShadow().querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['zip'], 'feedback.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    await flushMicrotasks();
  }

  beforeEach(() => {
    countReply = { ok: true, count: 0, pageCount: 0 };
    replaceReply = { ok: true };
    stageReply = (dataUrl) => ({ ok: true, screenshotKey: `key-of-${dataUrl}`, thumbnailDataUrl: `thumb-of-${dataUrl}` });
    confirmAnswer = true;
  });

  afterEach(() => {
    fileInputClick?.mockRestore();
  });

  test('a site with no notes: the picker opens straight away, nothing is asked', async () => {
    await open();
    await chooseImport();
    expect(asked).toEqual([]);
    expect(pickerOpens()).toBe(1);
  });

  test('the menu dismissed during the count round trip (count 0): no picker opens', async () => {
    await open();
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    let reply: ((r?: unknown) => void) | undefined;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_DOMAIN_ITEM_COUNT') {
        reply = callback; // held: the round trip is still in flight
        return;
      }
      base(message, callback);
    });
    (sidebarShadow().querySelector('.btn-menu') as HTMLButtonElement).click();
    importItem().click();
    await flushMicrotasks();
    expect(reply).toBeDefined();
    // The user presses somewhere on the page before the count arrives.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    expect(menuOpen()).toBe(false);

    reply!({ ok: true, count: 0, pageCount: 0 });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(pickerOpens()).toBe(0);
  });

  test('the fresh count also catches the sidebar up: a site emptied elsewhere greys out export and delete-all', async () => {
    countReply = { ok: true, count: 2, pageCount: 1 };
    await open();
    const exportBtn = sidebarShadow().querySelector('.btn-export') as HTMLButtonElement;
    const deleteAll = sidebarShadow().querySelector('.action-menu-item.is-delete-all') as HTMLButtonElement;
    expect(exportBtn.hasAttribute('aria-disabled')).toBe(false);
    expect(deleteAll.hasAttribute('aria-disabled')).toBe(false);

    // Emptied from another tab since the last repaint.
    countReply = { ok: true, count: 0, pageCount: 0 };
    await chooseImport();
    expect(exportBtn.getAttribute('aria-disabled')).toBe('true');
    expect(deleteAll.getAttribute('aria-disabled')).toBe('true');
    expect(asked).toEqual([]);
    expect(pickerOpens()).toBe(1);
  });

  test('a site with notes: the menu asks first, and "yes" opens the picker', async () => {
    countReply = { ok: true, count: 3, pageCount: 2 };
    await open();
    await chooseImport();
    // Yellow, not red: importing is not a delete (§AF).
    expect(asked).toEqual([{ text: IMPORT_REPLACE_CONFIRM_MESSAGE, label: IMPORT_REPLACE_CONFIRM_LABEL, tone: 'accent' }]);
    expect(pickerOpens()).toBe(1);
  });

  test('"cancel" opens no picker', async () => {
    countReply = { ok: true, count: 3, pageCount: 2 };
    confirmAnswer = false;
    await open();
    await chooseImport();
    expect(asked).toHaveLength(1);
    expect(pickerOpens()).toBe(0);
  });

  test('a count that cannot be read stops before anything is asked or picked', async () => {
    countReply = { ok: false, message: DOMAIN_COUNT_FAILED_MESSAGE };
    await open();
    await chooseImport();
    expect(asked).toEqual([]);
    expect(pickerOpens()).toBe(0);
    expect(notifText()).toBe(DOMAIN_COUNT_FAILED_MESSAGE);
    expect(menuOpen()).toBe(false);
  });

  test('a dead service worker at the count step fails the same way, with the generic import copy', async () => {
    countReply = undefined;
    await open();
    await chooseImport();
    expect(pickerOpens()).toBe(0);
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
  });

  test('once picked, a valid file replaces without asking again', async () => {
    countReply = { ok: true, count: 3, pageCount: 2 };
    await open();
    await chooseImport();
    expect(asked).toHaveLength(1);
    await pickFile();
    // Nothing is asked again: the menu stays closed.
    expect(menuOpen()).toBe(false);
    // jsdom's page is http://localhost/ — the domain is the page's, not the
    // bundle's (the ladder has already checked they match).
    // One screenshot per message, in bundle order, then one commit of the
    // notes carrying what staging minted (Chrome refuses a message over
    // 64 MiB, so the screenshots never travel together).
    const writes = sent().filter((m) => m?.type?.startsWith('IMPORT_'));
    expect(writes.map((m) => m.type)).toEqual(['IMPORT_STAGE_IMAGE', 'IMPORT_STAGE_IMAGE', 'IMPORT_COMMIT']);
    expect(writes[0]).toEqual({ type: 'IMPORT_STAGE_IMAGE', dataUrl: BUNDLE.items[0].screenshotDataUrl });
    expect(writes[1]).toEqual({ type: 'IMPORT_STAGE_IMAGE', dataUrl: BUNDLE.items[1].screenshotDataUrl });
    expect(writes[2]).toEqual({
      type: 'IMPORT_COMMIT',
      domain: 'localhost',
      items: BUNDLE.items.map(({ screenshotDataUrl, ...fields }) => ({
        ...fields,
        screenshotKey: `key-of-${screenshotDataUrl}`,
        thumbnailDataUrl: `thumb-of-${screenshotDataUrl}`,
      })),
    });
    expect(importItem().disabled).toBe(false);
  });

  test('a failed commit shows the import error, and leaves the clean-up to the service worker', async () => {
    replaceReply = { ok: false, message: IMPORT_FAILED_MESSAGE };
    await open();
    await pickFile();
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
    expect(sent().some((m) => m?.type === 'IMPORT_ABORT')).toBe(false);
  });

  test('a commit whose answer never came deletes nothing (it may have landed)', async () => {
    replaceReply = undefined;
    await open();
    await pickFile();
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
    expect(sent().some((m) => m?.type === 'IMPORT_ABORT')).toBe(false);
  });

  test('a screenshot that fails to stage stops the import: nothing is committed, and what was staged is let go', async () => {
    stageReply = (dataUrl) =>
      dataUrl === BUNDLE.items[1].screenshotDataUrl
        ? { ok: false, message: IMPORT_FAILED_MESSAGE }
        : { ok: true, screenshotKey: 'staged-1', thumbnailDataUrl: 'thumb-1' };
    await open();
    await pickFile();
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
    expect(sent().some((m) => m?.type === 'IMPORT_COMMIT')).toBe(false);
    expect(sent()).toContainEqual({ type: 'IMPORT_ABORT', screenshotKeys: ['staged-1'] });
    expect(importItem().disabled).toBe(false);
  });

  test('a dead service worker at the first screenshot fails with the import copy, and has nothing to let go', async () => {
    stageReply = () => undefined;
    await open();
    await pickFile();
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
    expect(sent().some((m) => m?.type === 'IMPORT_ABORT' || m?.type === 'IMPORT_COMMIT')).toBe(false);
  });
});

describe('content.ts: delete all on this website (design spec §AE)', () => {
  let countReply: unknown;
  let deleteReply: unknown;
  let confirmAnswer: boolean;
  /** The questions asked, read off the real menu and answered with its own
   *  buttons (its look is sidebar.test.ts's). */
  let asked: Asked[];

  function installDeleteMocks(): void {
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === 'GET_DOMAIN_ITEM_COUNT') {
        callback?.(countReply);
        return;
      }
      if (message?.type === 'DELETE_DOMAIN_DATA') {
        // A successful delete empties the site, as the service worker would.
        if ((deleteReply as { ok?: boolean })?.ok) {
          pageItems = [];
          countReply = { ok: true, count: 0, pageCount: 0 };
        }
        callback?.(deleteReply);
        return;
      }
      base(message, callback);
    });
  }

  function sent(): any[] {
    return (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
  }
  function deleteAllItem(): HTMLButtonElement {
    return sidebarShadow().querySelector('.action-menu-item.is-delete-all') as HTMLButtonElement;
  }
  function notifText(): string | null {
    return sidebarShadow().querySelector('.notif-text')?.textContent ?? null;
  }

  async function open(): Promise<void> {
    loadContent();
    asked = [];
    installDeleteMocks();
    activate();
    await flushMicrotasks();
    await flushMicrotasks();
  }
  async function clickDeleteAll(): Promise<void> {
    (chrome.runtime.sendMessage as jest.Mock).mockClear();
    (sidebarShadow().querySelector('.btn-menu') as HTMLButtonElement).click();
    deleteAllItem().click();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await answerIfAsked(asked, confirmAnswer);
  }

  beforeEach(() => {
    pageItems = [makeItem({ id: 7 })];
    countReply = { ok: true, count: 5, pageCount: 3 };
    deleteReply = { ok: true };
    confirmAnswer = true;
  });

  test('the item is enabled once the site is known to have feedback', async () => {
    await open();
    expect(deleteAllItem().hasAttribute('aria-disabled')).toBe(false);
  });

  test('a site with no feedback leaves it disabled', async () => {
    pageItems = [];
    countReply = { ok: true, count: 0, pageCount: 0 };
    await open();
    expect(deleteAllItem().getAttribute('aria-disabled')).toBe('true');
  });

  test('a count that cannot be read leaves it disabled, the safe direction', async () => {
    countReply = { ok: false, message: DOMAIN_COUNT_FAILED_MESSAGE };
    await open();
    expect(deleteAllItem().getAttribute('aria-disabled')).toBe('true');
  });

  test('confirms with both counts, then deletes the whole domain and empties the list', async () => {
    await open();
    await clickDeleteAll();
    // Delete keeps the default, danger tone.
    expect(asked).toEqual([{ text: deleteAllConfirmMessage(5, 3), label: DELETE_ALL_CONFIRM_LABEL, tone: 'danger' }]);
    expect(sent()).toContainEqual({ type: 'DELETE_DOMAIN_DATA', domain: 'localhost' });
    expect(sidebarShadow().querySelectorAll('button.thumbnail')).toHaveLength(0);
    // Nothing left: the item disables itself again.
    expect(deleteAllItem().getAttribute('aria-disabled')).toBe('true');
  });

  test('"cancel" deletes nothing', async () => {
    confirmAnswer = false;
    await open();
    await clickDeleteAll();
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'DELETE_DOMAIN_DATA' }));
    expect(sidebarShadow().querySelectorAll('button.thumbnail')).toHaveLength(1);
    expect(deleteAllItem().hasAttribute('aria-disabled')).toBe(false);
  });

  test('a count that fails at click time stops before the confirmation', async () => {
    await open();
    countReply = { ok: false, message: DOMAIN_COUNT_FAILED_MESSAGE };
    await clickDeleteAll();
    expect(asked).toEqual([]);
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'DELETE_DOMAIN_DATA' }));
    expect(notifText()).toBe(DOMAIN_COUNT_FAILED_MESSAGE);
  });

  test('a site emptied since the item was enabled asks nothing and just disables it', async () => {
    await open();
    countReply = { ok: true, count: 0, pageCount: 0 };
    await clickDeleteAll();
    expect(asked).toEqual([]);
    expect(sent()).not.toContainEqual(expect.objectContaining({ type: 'DELETE_DOMAIN_DATA' }));
    expect(deleteAllItem().getAttribute('aria-disabled')).toBe('true');
  });

  test('a failed delete shows the error and keeps what survived', async () => {
    deleteReply = { ok: false, message: DELETE_ALL_FAILED_MESSAGE };
    await open();
    await clickDeleteAll();
    expect(notifText()).toBe(DELETE_ALL_FAILED_MESSAGE);
    expect(sidebarShadow().querySelectorAll('button.thumbnail')).toHaveLength(1);
    expect(deleteAllItem().hasAttribute('aria-disabled')).toBe(false);
  });

  test('a dead service worker during the delete fails with the same copy', async () => {
    deleteReply = undefined;
    await open();
    await clickDeleteAll();
    expect(notifText()).toBe(DELETE_ALL_FAILED_MESSAGE);
  });
});

// Paths content.ts only covered end to end before the controller split
// (architecture review T4): SPA navigation, export's replies, and import's
// validation failures.
describe('content.ts: SPA navigation, export and import failures', () => {
  const sent = () => (chrome.runtime.sendMessage as jest.Mock).mock.calls.map((c) => c[0]);
  function notifText(): string | null {
    return sidebarShadow().querySelector('.notif-text')?.textContent ?? null;
  }
  const startUrl = location.href;

  afterEach(() => {
    history.replaceState(null, '', startUrl);
  });

  test('a navigation to another URL exits add mode, collapses the enlarged view and repaints the list for the new URL', async () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    addButton().click();
    expect(addMode.isAddModeActive()).toBe(true);
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    history.pushState({}, '', '/somewhere-else');
    jest.advanceTimersByTime(50);

    expect(addMode.isAddModeActive()).toBe(false);
    expect(addGroup().classList.contains('is-on')).toBe(false);
    expect(sent()).toContainEqual({
      type: 'GET_PAGE_ITEMS',
      domain: 'localhost',
      normalisedUrl: 'https://localhost/somewhere-else',
    });
  });

  test('changes that keep the normalised URL (a query, a hash, a burst within the debounce) repaint at most once and only on a real change', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    history.replaceState({}, '', `${location.pathname}?q=1`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    jest.advanceTimersByTime(50);
    expect(sent().filter((m) => m?.type === 'GET_PAGE_ITEMS')).toHaveLength(0);

    history.pushState({}, '', '/a');
    history.pushState({}, '', '/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    jest.advanceTimersByTime(49);
    expect(sent().filter((m) => m?.type === 'GET_PAGE_ITEMS')).toHaveLength(0);
    jest.advanceTimersByTime(1);
    const reads = sent().filter((m) => m?.type === 'GET_PAGE_ITEMS');
    expect(reads).toHaveLength(1);
    expect(reads[0].normalisedUrl).toBe('https://localhost/b');
  });

  test('a navigation while the sidebar is closed repaints nothing', () => {
    jest.useFakeTimers();
    loadContent();
    activate();
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    expect(sidebarApi.isSidebarVisible()).toBe(false);
    (chrome.runtime.sendMessage as jest.Mock).mockClear();
    history.pushState({}, '', '/elsewhere');
    jest.advanceTimersByTime(50);
    expect(sent().filter((m) => m?.type === 'GET_PAGE_ITEMS')).toHaveLength(0);
  });

  function replyTo(type: string, reply: unknown): void {
    const base = (chrome.runtime.sendMessage as jest.Mock).getMockImplementation()!;
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((message: any, callback?: (r?: unknown) => void) => {
      if (message?.type === type) return callback?.(reply);
      return base(message, callback);
    });
  }

  async function clickExport(): Promise<HTMLButtonElement> {
    const btn = sidebarShadow().querySelector('.btn-export') as HTMLButtonElement;
    sidebarApi.setSiteHasNotes(true);
    btn.click();
    await flushMicrotasks();
    return btn;
  }

  test('export: success shows nothing and leaves the button live', async () => {
    loadContent();
    activate();
    replyTo('EXPORT', { ok: true });
    const btn = await clickExport();
    expect(sent()).toContainEqual({ type: 'EXPORT', domain: 'localhost' });
    expect(notifText()).toBe('');
    expect(btn.disabled).toBe(false);
  });

  test('export: a site emptied elsewhere (EMPTY) says "nothing to export" and greys export out', async () => {
    loadContent();
    activate();
    replyTo('EXPORT', { ok: false, code: 'EMPTY', message: 'x' });
    const btn = await clickExport();
    await flushMicrotasks();
    expect(notifText()).toBe(NOTHING_TO_EXPORT_MESSAGE);
    expect(sidebarShadow().querySelector('.notif')!.classList.contains('warning')).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  test('export: a failure shows its copy; no answer at all shows the export copy', async () => {
    loadContent();
    activate();
    replyTo('EXPORT', { ok: false, code: 'FAILED', message: 'the zip failed' });
    await clickExport();
    expect(notifText()).toBe('the zip failed');

    replyTo('EXPORT', undefined);
    const btn = await clickExport();
    expect(notifText()).toBe(EXPORT_FAILED_MESSAGE);
    expect(btn.disabled).toBe(false);
  });

  test('import: a bundle the ladder rejects shows its §5 copy, and nothing is written', async () => {
    loadContent();
    activate();
    const { ImportError } = jest.requireActual('../types') as typeof import('../types');
    (require('../import').parseImportBundle as jest.Mock).mockRejectedValue(
      new ImportError('DOMAIN_MISMATCH', { fileDomain: 'other.com', currentDomain: 'localhost' }),
    );
    const input = sidebarShadow().querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['zip'], 'f.zip')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(notifText()).toBe(importErrorMessage('DOMAIN_MISMATCH', { fileDomain: 'other.com', currentDomain: 'localhost' }));
    expect(sent().some((m) => typeof m?.type === 'string' && m.type.startsWith('IMPORT_'))).toBe(false);
    expect((sidebarShadow().querySelector('.action-menu-item.is-import') as HTMLButtonElement).disabled).toBe(false);
  });

  test('import: an unexpected failure while reading shows the generic import copy', async () => {
    loadContent();
    activate();
    (require('../import').parseImportBundle as jest.Mock).mockRejectedValue(new Error('boom'));
    const input = sidebarShadow().querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['zip'], 'f.zip')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(notifText()).toBe(IMPORT_FAILED_MESSAGE);
  });
});

// The extension reloaded or updated under an open sidebar (architecture
// review B5, owner decision D3): the orphaned script shuts down cleanly and
// shows nothing new, and the next injection never makes a second sidebar.
describe('content.ts: shutting down when the extension context dies', () => {
  const hosts = () => document.querySelectorAll('#annotator-sidebar-host').length;

  function killContext(runtime: any = (global.chrome as any).runtime): void {
    delete runtime.id;
    runtime.sendMessage = jest.fn(() => {
      throw new Error('Extension context invalidated.');
    });
  }

  test('the first round trip that finds the context gone removes everything and restores the page', async () => {
    const pushBefore = pristinePushState;
    loadContent();
    activate();
    await flushMicrotasks();
    addButton().click();
    expect(addMode.isAddModeActive()).toBe(true);
    expect(document.documentElement.style.getPropertyValue('margin-right')).toBe('300px');
    const listenersBefore = liveRegistrations().length;
    expect(listenersBefore).toBeGreaterThan(0);

    killContext();
    // Any round trip: here the list refresh an SPA navigation asks for.
    jest.useFakeTimers();
    history.pushState({}, '', '/after-the-update');
    jest.advanceTimersByTime(50);
    jest.useRealTimers();
    await flushMicrotasks();

    expect(hosts()).toBe(0);
    expect(document.getElementById('annotator-addmode-host')).toBeNull();
    expect(addMode.isAddModeActive()).toBe(false);
    expect(document.documentElement.style.cssText).toBe('');
    expect(document.getElementById('annotator-page-resize')).toBeNull();
    expect(history.pushState).toBe(pushBefore);
    expect(window.__annotatorActive).toBeUndefined();
    // No salamander listener is left on window or document.
    expect(liveRegistrations()).toEqual([]);
    history.replaceState(null, '', '/');
  });

  test('a failure that is not a dead context (a busy worker) shuts nothing down', async () => {
    loadContent();
    activate();
    await flushMicrotasks();
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation((_m: unknown, cb?: (r?: unknown) => void) => {
      (chrome.runtime as any).lastError = { message: 'The message port closed before a response was received.' };
      cb?.(undefined);
      (chrome.runtime as any).lastError = null;
    });
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    onMessageListener({ type: 'ICON_CLICKED' }, {}, () => {});
    await flushMicrotasks();
    expect(hosts()).toBe(1);
    expect(sidebarApi.isSidebarVisible()).toBe(true);
  });

  test('the icon clicked after an update: the new injection takes over from the orphan, and there is one sidebar', async () => {
    loadContent();
    activate();
    await flushMicrotasks();
    const orphanRuntime = (global.chrome as any).runtime;
    killContext(orphanRuntime);

    // The new build's script runs in a fresh JS world: it cannot see the
    // orphan's globals, only the DOM they share.
    jest.resetModules();
    delete (window as any).__annotatorActive;
    installChromeMocks();
    (global.chrome as any).runtime.id = 'salamander-test-extension';
    require('../content');
    sidebarApi = require('../sidebar');
    expect(hosts()).toBe(0); // the orphan heard the takeover and shut down
    activate();
    await flushMicrotasks();
    expect(hosts()).toBe(1);
    expect(sidebarApi.isSidebarVisible()).toBe(true);
    expect(document.documentElement.style.getPropertyValue('margin-right')).toBe('300px');
  });

  test('a second injection while the first is alive changes nothing (the guard, as before)', async () => {
    loadContent();
    activate();
    await flushMicrotasks();
    const first = window.__annotatorActive;
    jest.resetModules();
    require('../content');
    expect(window.__annotatorActive).toBe(first);
    expect(hosts()).toBe(1);
    expect(sidebarApi.isSidebarVisible()).toBe(true);
  });

  test('an orphan in the same world is shut down by the next injection\'s guard', async () => {
    loadContent();
    activate();
    await flushMicrotasks();
    const orphan = window.__annotatorActive as { alive: () => boolean; teardown: () => void };
    const teardown = jest.spyOn(orphan, 'teardown');
    killContext();
    // Without its takeover listener (as if it had none), only the guard is left.
    document.dispatchEvent(new CustomEvent('salamander:takeover'));
    expect(hosts()).toBe(0);
    teardown.mockClear();
    jest.resetModules();
    window.__annotatorActive = orphan;
    require('../content');
    expect(teardown).toHaveBeenCalled();
    expect(window.__annotatorActive).not.toBe(orphan);
  });
});
