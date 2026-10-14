// The Option/Alt+N tip's counting (src/addNoteTip.ts): the pure decision,
// and the service worker's handlers on the real storage.ts over the
// chrome.storage fake — the session count in chrome.storage.session, the
// install's state in chrome.storage.local. The controller's side (which
// starts count, the tip in the hint's place) is addModeControl.test.ts's.

import { FRESH_TIP_STATE, TIP_LIFETIME_MAX, TIP_ON_CLICK, parseTipState, shouldShowTip } from '../addNoteTip';
import { addNoteTip } from '../copy';
import type * as BackgroundModule from '../background';

// background.ts registers its listeners at import time: give it the event
// surfaces setup.ts's base mock leaves out, then load it.
const listener = () => ({ addListener: jest.fn() });
const c = chrome as unknown as Record<string, Record<string, unknown>>;
c.action = { onClicked: listener() };
c.tabs = { ...c.tabs, onUpdated: listener(), onRemoved: listener() };
c.runtime = { ...c.runtime, onMessage: listener() };
const background: typeof BackgroundModule = require('../background');

describe('the decision', () => {
  test('on the third single-click start of a session, and only then', () => {
    expect(TIP_ON_CLICK).toBe(3);
    expect([0, 1, 2, 3, 4].map((before) => shouldShowTip(before, FRESH_TIP_STATE))).toEqual([false, false, true, false, false]);
  });

  test('at most three times per install', () => {
    expect(TIP_LIFETIME_MAX).toBe(3);
    expect(shouldShowTip(2, { shown: 2, shortcutUsed: false })).toBe(true);
    expect(shouldShowTip(2, { shown: 3, shortcutUsed: false })).toBe(false);
  });

  test('never once the shortcut has been used', () => {
    expect(shouldShowTip(2, { shown: 0, shortcutUsed: true })).toBe(false);
  });

  test('never while the session\'s showing is already reserved', () => {
    expect(shouldShowTip(2, FRESH_TIP_STATE, true)).toBe(false);
  });

  test('a stored state that is not one reads as fresh', () => {
    expect(parseTipState(undefined)).toEqual(FRESH_TIP_STATE);
    expect(parseTipState({ shown: -1, shortcutUsed: 'yes' })).toEqual(FRESH_TIP_STATE);
    expect(parseTipState({ shown: 2.7, shortcutUsed: true })).toEqual({ shown: 2, shortcutUsed: true });
  });
});

describe('the wording', () => {
  test('⌥N on macOS, alt+n elsewhere', () => {
    expect(addNoteTip(true)).toBe('tip: ⌥N to add a note');
    expect(addNoteTip(false)).toBe('tip: alt+n to add a note');
  });
});

describe('the service worker\'s counts', () => {
  /** One single-click start, as the controller runs it: ask; a no, or a
   *  yes whose tip was then seen, counts the start. */
  async function clickStart(): Promise<boolean> {
    const { show } = await background.handleGetAddNoteTip();
    await background.handleRecordAddNoteClick();
    return show;
  }
  /** The browser restarts: chrome.storage.session is empty again. */
  async function newSession(): Promise<void> {
    await chrome.storage.session.remove(['addNoteClicks', 'addNoteTipReserved']);
  }
  const stored = async () => (await chrome.storage.local.get('addNoteTip')).addNoteTip;

  test('the third start of a session shows it; the fourth and fifth do not', async () => {
    expect([await clickStart(), await clickStart(), await clickStart(), await clickStart(), await clickStart()]).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect((await chrome.storage.session.get('addNoteClicks')).addNoteClicks).toBe(5);
    expect(await stored()).toEqual({ shown: 1, shortcutUsed: false });
  });

  test('the session count resets with the browser; the lifetime count does not, and stops at three', async () => {
    const perSession: boolean[][] = [];
    for (let s = 0; s < 5; s++) {
      await newSession();
      perSession.push([await clickStart(), await clickStart(), await clickStart()]);
    }
    expect(perSession).toEqual([
      [false, false, true],
      [false, false, true],
      [false, false, true],
      [false, false, false],
      [false, false, false],
    ]);
    expect(await stored()).toEqual({ shown: 3, shortcutUsed: false });
  });

  test('a yes reserves the showing at once: two tabs asking before either outcome cannot both be told yes', async () => {
    await clickStart();
    await clickStart();
    const [a, b] = await Promise.all([background.handleGetAddNoteTip(), background.handleGetAddNoteTip()]);
    expect([a.show, b.show].sort()).toEqual([false, true]);
    expect(await stored()).toEqual({ shown: 1, shortcutUsed: false });
  });

  test('...and at the install\'s last showing, two sessions\' tabs cannot take it twice', async () => {
    await chrome.storage.local.set({ addNoteTip: { shown: 2, shortcutUsed: false } });
    await clickStart();
    await clickStart();
    const answers = await Promise.all([background.handleGetAddNoteTip(), background.handleGetAddNoteTip()]);
    expect(answers.filter((r) => r.show)).toHaveLength(1);
    expect(await stored()).toEqual({ shown: 3, shortcutUsed: false });
  });

  test('a showing nobody saw (a double-click, a tip that never reached the screen) is given back; the next third start has it', async () => {
    await clickStart();
    await clickStart();
    expect((await background.handleGetAddNoteTip()).show).toBe(true);
    // Not seen: the start is not counted, the showing goes back.
    await background.handleReleaseAddNoteTip();
    expect(await stored()).toEqual({ shown: 0, shortcutUsed: false });
    expect((await chrome.storage.session.get('addNoteTipReserved')).addNoteTipReserved).toBeUndefined();
    expect(await clickStart()).toBe(true);
    expect(await stored()).toEqual({ shown: 1, shortcutUsed: false });
  });

  test('once seen, the session\'s showing stays spent even before its start is counted', async () => {
    await clickStart();
    await clickStart();
    expect((await background.handleGetAddNoteTip()).show).toBe(true);
    // Another tab's third start, while this one's tip is still pending.
    expect((await background.handleGetAddNoteTip()).show).toBe(false);
  });

  test('once the shortcut has been used, never again — in this session or the next', async () => {
    await clickStart();
    await background.handleAddNoteShortcutUsed();
    expect(await stored()).toEqual({ shown: 0, shortcutUsed: true });
    expect(await clickStart()).toBe(false);
    expect(await clickStart()).toBe(false);
    await newSession();
    expect([await clickStart(), await clickStart(), await clickStart()]).toEqual([false, false, false]);
  });

  test('install state lives under its own key in chrome.storage.local, the session\'s in chrome.storage.session', async () => {
    await clickStart();
    expect(Object.keys(await chrome.storage.local.get(null))).toEqual([]);
    expect(Object.keys(await chrome.storage.session.get(null))).toEqual(['addNoteClicks']);
    await clickStart();
    await clickStart();
    expect(Object.keys(await chrome.storage.local.get(null))).toEqual(['addNoteTip']);
    expect(Object.keys(await chrome.storage.session.get(null)).sort()).toEqual(['addNoteClicks', 'addNoteTipReserved']);
  });

  test('the notifications close their channel at once; the question keeps it open for its answer', () => {
    const sender = {} as chrome.runtime.MessageSender;
    expect(background.handleRuntimeMessage({ type: 'RECORD_ADD_NOTE_CLICK' }, sender, jest.fn())).toBe(false);
    expect(background.handleRuntimeMessage({ type: 'RELEASE_ADD_NOTE_TIP' }, sender, jest.fn())).toBe(false);
    expect(background.handleRuntimeMessage({ type: 'ADD_NOTE_SHORTCUT_USED' }, sender, jest.fn())).toBe(false);
    expect(background.handleRuntimeMessage({ type: 'GET_ADD_NOTE_TIP' }, sender, jest.fn())).toBe(true);
  });

  test('a storage failure answers no and counts nothing, quietly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const get = chrome.storage.session.get;
    (chrome.storage.session as unknown as { get: unknown }).get = () => {
      throw new Error('session gone');
    };
    try {
      expect(await background.handleGetAddNoteTip()).toEqual({ show: false });
      await expect(background.handleRecordAddNoteClick()).resolves.toBeUndefined();
      await expect(background.handleReleaseAddNoteTip()).resolves.toBeUndefined();
    } finally {
      (chrome.storage.session as unknown as { get: unknown }).get = get;
      warn.mockRestore();
    }
    expect(await stored()).toBeUndefined();
  });
});
