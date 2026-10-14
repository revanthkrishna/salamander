// src/addModeControl.ts on fakes: the "add note" state machine (design spec
// v3 §A2) with an injected clock and jest's timers, no DOM. content.test.ts
// drives the same machine through the real modules.

import { ADD_DBLCLICK_WINDOW_MS, AddModeControl, AddModeControlDeps, createAddModeControl } from '../addModeControl';
import type { AddModeCallbacks, AddModeResult } from '../addMode';
import type { CaptureOutcome } from '../capture';

type Paint = 'off' | 'on' | 'kept-on';

interface Harness {
  control: AddModeControl;
  active: () => boolean;
  /** Every paint, in order. */
  paints: Paint[];
  holds: boolean[];
  errors: string[];
  callbacks: () => AddModeCallbacks;
  starts: () => number;
  saved: jest.Mock;
  restorePen: jest.Mock;
  captureAndSave: jest.Mock<Promise<CaptureOutcome>, [AddModeResult, unknown]>;
  setNow: (ms: number) => void;
  sidebarOnPage: (on: boolean) => void;
  enlargedOpen: (on: boolean) => void;
  typing: (on: boolean) => void;
  drawMenuOpen: (on: boolean) => void;
  /** add mode tearing itself down (what it does before reporting a cancel). */
  selfExit: () => void;
  /** The Option/Alt+N tip: what the service worker answers, and what the
   *  controller asked, counted and showed. */
  tip: {
    answer: (show: boolean) => void;
    query: jest.Mock;
    record: jest.Mock;
    release: jest.Mock;
    shortcutUsed: jest.Mock;
    shown: string[];
    restored: () => number;
    /** The armed tip comes on screen (add mode's onSettled(true)). */
    see: () => void;
  };
}

function harness(): Harness {
  let isActive = false;
  let lastCallbacks: AddModeCallbacks | null = null;
  let startCount = 0;
  let now = 1000;
  let onPage = true;
  let enlarged = false;
  let typingNow = false;
  let menuOpen = false;
  const paints: Paint[] = [];
  const holds: boolean[] = [];
  const errors: string[] = [];
  const saved = jest.fn();
  const restorePen = jest.fn();
  const captureAndSave = jest.fn<Promise<CaptureOutcome>, [AddModeResult, unknown]>();
  let tipAnswer = false;
  const tipShown: string[] = [];
  let restored = 0;
  const tipQuery = jest.fn(async () => tipAnswer);
  const tipRecord = jest.fn();
  const tipRelease = jest.fn();
  const tipShortcutUsed = jest.fn();
  /** The armed tip's onSettled, as add mode holds it until it settles. */
  let tipSettle: ((seen: boolean) => void) | null = null;
  const settleTip = (seen: boolean) => {
    const f = tipSettle;
    tipSettle = null;
    f?.(seen);
  };
  const deps: AddModeControlDeps = {
    addMode: {
      startAddMode: (cb) => {
        if (isActive) return;
        isActive = true;
        startCount++;
        lastCallbacks = cb;
      },
      exitAddMode: () => {
        isActive = false;
        settleTip(false);
      },
      isAddModeActive: () => isActive,
      dismissDrawingMenu: () => {
        const was = menuOpen;
        menuOpen = false;
        return was;
      },
      hideOverlayUI: () => {},
      showOverlayUI: () => {},
      showPlacingTip: (text, onSettled) => {
        if (!isActive) return false;
        tipShown.push(text);
        tipSettle = onSettled ?? null;
        return true;
      },
      restorePlacingHint: () => {
        restored++;
        settleTip(false);
      },
    },
    sidebar: {
      collapseEnlargedView: () => true,
      setAddModeHold: (hold) => {
        holds.push(hold);
      },
      setAddButtonState: (state) => {
        paints.push(state);
      },
      isSidebarOnPage: () => onPage,
      isEnlargedViewOpen: () => enlarged,
      showError: (m) => {
        errors.push(m);
      },
      hideTooltipNow: () => {},
    },
    captureAndSave,
    isTypingTarget: () => typingNow,
    penColor: { restore: restorePen, remember: jest.fn() },
    onSaved: saved,
    now: () => now,
    tip: { query: tipQuery, record: tipRecord, release: tipRelease, shortcutUsed: tipShortcutUsed, text: () => 'tip: press alt+n to add a note' },
  };
  return {
    control: createAddModeControl(deps),
    active: () => isActive,
    paints,
    holds,
    errors,
    callbacks: () => lastCallbacks!,
    starts: () => startCount,
    saved,
    restorePen,
    captureAndSave,
    setNow: (ms) => {
      now = ms;
    },
    sidebarOnPage: (on) => {
      onPage = on;
    },
    enlargedOpen: (on) => {
      enlarged = on;
    },
    typing: (on) => {
      typingNow = on;
    },
    drawMenuOpen: (on) => {
      menuOpen = on;
    },
    selfExit: () => {
      isActive = false;
      settleTip(false);
    },
    tip: {
      answer: (show) => {
        tipAnswer = show;
      },
      query: tipQuery,
      record: tipRecord,
      release: tipRelease,
      shortcutUsed: tipShortcutUsed,
      shown: tipShown,
      restored: () => restored,
      see: () => settleTip(true),
    },
  };
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
const RESULT: AddModeResult = { rect: { x: 0, y: 0, width: 10, height: 10 }, note: 'n' };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  jest.useRealTimers();
});

describe('the button', () => {
  test('off -> on at once, on hold, with the session colour asked for', () => {
    const h = harness();
    h.control.onButtonClick();
    expect(h.active()).toBe(true);
    expect(last(h.paints)).toBe('on');
    expect(last(h.holds)).toBe(true);
    expect(h.restorePen).toHaveBeenCalledTimes(1);
  });

  test('a lone click while on turns it off at once', () => {
    const h = harness();
    h.control.onButtonClick();
    h.setNow(1000 + ADD_DBLCLICK_WINDOW_MS);
    h.control.onButtonClick();
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
    expect(last(h.holds)).toBe(false);
  });

  test('a click right after another waits out the double-click window, then turns it off', () => {
    jest.useFakeTimers();
    const h = harness();
    h.control.onButtonClick();
    h.setNow(1100);
    h.control.onButtonClick();
    expect(h.active()).toBe(true);
    jest.advanceTimersByTime(ADD_DBLCLICK_WINDOW_MS - 1);
    expect(h.active()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
  });

  test('...unless the dblclick arrives: then the switch goes on and the pending off never fires', () => {
    jest.useFakeTimers();
    const h = harness();
    h.control.onButtonClick();
    h.setNow(1100);
    h.control.onButtonClick();
    h.control.onButtonDoubleClick();
    jest.advanceTimersByTime(ADD_DBLCLICK_WINDOW_MS * 2);
    expect(h.active()).toBe(true);
    expect(last(h.paints)).toBe('kept-on');
  });

  test('a click while kept on stops everything', () => {
    const h = harness();
    h.control.setSwitch(true);
    h.setNow(5000);
    h.control.onButtonClick();
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
  });
});

describe('the switch', () => {
  test('on from off starts add mode kept on; off while active leaves the current note', () => {
    const h = harness();
    h.control.setSwitch(true);
    expect(h.active()).toBe(true);
    expect(last(h.paints)).toBe('kept-on');
    h.control.setSwitch(false);
    expect(h.active()).toBe(true);
    expect(last(h.paints)).toBe('on');
  });

  test('off with add mode already gone paints off and lifts the hold', () => {
    const h = harness();
    h.control.setSwitch(false);
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
    expect(last(h.holds)).toBe(false);
  });
});

describe('cancel and capture', () => {
  test('cancel with the switch off ends add mode; with it on, re-enters for the next note', () => {
    const h = harness();
    h.control.onButtonClick();
    h.selfExit();
    h.callbacks().onCancel();
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');

    h.control.setSwitch(true);
    const before = h.starts();
    h.selfExit();
    h.callbacks().onCancel();
    expect(h.active()).toBe(true);
    expect(h.starts()).toBe(before + 1);
    expect(last(h.paints)).toBe('kept-on');
  });

  test('a saved note with the switch off ends add mode and refreshes the list', async () => {
    const h = harness();
    h.captureAndSave.mockResolvedValue({ ok: true, item: {} as never });
    h.control.onButtonClick();
    h.callbacks().onOk(RESULT);
    await flush();
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
    expect(h.saved).toHaveBeenCalledTimes(1);
  });

  test('a saved note with the switch on goes straight back into placing', async () => {
    const h = harness();
    h.captureAndSave.mockResolvedValue({ ok: true, item: {} as never });
    h.control.setSwitch(true);
    h.callbacks().onOk(RESULT);
    await flush();
    expect(h.active()).toBe(true);
    expect(h.starts()).toBe(2);
    expect(last(h.paints)).toBe('kept-on');
  });

  test('a failed capture shows its copy and leaves add mode exactly as it was', async () => {
    const h = harness();
    h.captureAndSave.mockResolvedValue({ ok: false, message: "couldn't capture a screenshot here. try again." });
    h.control.onButtonClick();
    const paints = h.paints.length;
    h.callbacks().onOk(RESULT);
    await flush();
    expect(h.active()).toBe(true);
    expect(h.errors).toEqual(["couldn't capture a screenshot here. try again."]);
    expect(h.paints.length).toBe(paints);
    expect(h.saved).not.toHaveBeenCalled();
  });
});

describe('Esc', () => {
  test('exits add mode and turns the switch off', () => {
    const h = harness();
    h.control.setSwitch(true);
    h.control.onGlobalKeyDown(key({ key: 'Escape' }));
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
  });

  test('ending an IME composition, or closing the pencil menu, is all it does', () => {
    const h = harness();
    h.control.onButtonClick();
    h.control.onGlobalKeyDown(key({ key: 'Escape', isComposing: true }));
    expect(h.active()).toBe(true);
    h.drawMenuOpen(true);
    h.control.onGlobalKeyDown(key({ key: 'Escape' }));
    expect(h.active()).toBe(true);
    h.control.onGlobalKeyDown(key({ key: 'Escape' }));
    expect(h.active()).toBe(false);
  });
});

describe('Option/Alt+N', () => {
  const altN = () => key({ key: 'n', code: 'KeyN', altKey: true });

  test('adds one note, switch off, and the page never sees the key', () => {
    const h = harness();
    const e = altN();
    expect(h.control.onGlobalKeyDown(e)).toBe('stop');
    expect(h.active()).toBe(true);
    expect(last(h.paints)).toBe('on');
    expect(e.defaultPrevented).toBe(true);
  });

  test('does nothing with the sidebar off the page, while placing, with the enlarged view open, or while typing', () => {
    for (const set of [
      (h: Harness) => h.sidebarOnPage(false),
      (h: Harness) => h.control.onButtonClick(),
      (h: Harness) => h.enlargedOpen(true),
      (h: Harness) => h.typing(true),
    ]) {
      const h = harness();
      set(h);
      const starts = h.starts();
      const e = altN();
      expect(h.control.onGlobalKeyDown(e)).toBe('pass');
      expect(h.starts()).toBe(starts);
      expect(e.defaultPrevented).toBe(false);
    }
  });
});

describe('a capture still in flight when a new session starts (the capture session token)', () => {
  test('its late success leaves the new session alone, and still refreshes the list', async () => {
    const h = harness();
    let resolveCapture!: (o: CaptureOutcome) => void;
    h.captureAndSave.mockImplementation(() => new Promise((resolve) => (resolveCapture = resolve)));
    h.control.onButtonClick();
    h.callbacks().onOk(RESULT);
    // While it is in flight: add note clicked off, then on again.
    h.setNow(5000);
    h.control.onButtonClick();
    h.setNow(9000);
    h.control.onButtonClick();
    expect(h.active()).toBe(true);
    const paints = h.paints.length;

    resolveCapture({ ok: true, item: {} as never });
    await flush();
    expect(h.active()).toBe(true);
    expect(h.paints.length).toBe(paints);
    expect(h.saved).toHaveBeenCalledTimes(1);
  });

  test('Esc during the capture (no new session) ends add mode as before', async () => {
    const h = harness();
    let resolveCapture!: (o: CaptureOutcome) => void;
    h.captureAndSave.mockImplementation(() => new Promise((resolve) => (resolveCapture = resolve)));
    h.control.onButtonClick();
    h.callbacks().onOk(RESULT);
    h.control.onGlobalKeyDown(key({ key: 'Escape' }));
    resolveCapture({ ok: true, item: {} as never });
    await flush();
    expect(h.active()).toBe(false);
    expect(last(h.paints)).toBe('off');
    expect(h.saved).toHaveBeenCalledTimes(1);
  });
});

describe('the Option/Alt+N tip (src/addNoteTip.ts)', () => {
  /** Let the tip's answer (a resolved promise) land. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const altN = () => key({ key: 'n', code: 'KeyN', altKey: true });
  /** Past the double-click window, with every promise behind it landed. */
  const pastWindow = async () => {
    jest.advanceTimersByTime(ADD_DBLCLICK_WINDOW_MS);
    await settle();
  };

  test('a single click asks; a yes puts the tip in the hint\'s place; once it has been on screen the start counts and the showing is kept', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.tip.answer(true);
    h.control.onButtonClick();
    expect(h.tip.query).toHaveBeenCalledTimes(1);
    await settle();
    expect(h.tip.shown).toEqual(['tip: press alt+n to add a note']);
    await pastWindow();
    // Not seen yet: nothing decided.
    expect(h.tip.record).not.toHaveBeenCalled();
    expect(h.tip.release).not.toHaveBeenCalled();
    h.tip.see();
    await settle();
    expect(h.tip.record).toHaveBeenCalledTimes(1);
    expect(h.tip.release).not.toHaveBeenCalled();
  });

  test('seen before the double-click window ends, it counts as the window ends', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.tip.answer(true);
    h.control.onButtonClick();
    await settle();
    h.tip.see();
    await settle();
    expect(h.tip.record).not.toHaveBeenCalled();
    await pastWindow();
    expect(h.tip.record).toHaveBeenCalledTimes(1);
  });

  test('a yes never seen — the box placed or add mode left first — gives its showing back and does not count the start', async () => {
    jest.useFakeTimers();
    for (const end of [(h: Harness) => h.selfExit(), (h: Harness) => h.control.onGlobalKeyDown(key({ key: 'Escape' }))]) {
      const h = harness();
      h.tip.answer(true);
      h.control.onButtonClick();
      await settle();
      end(h);
      await pastWindow();
      expect(h.tip.release).toHaveBeenCalledTimes(1);
      expect(h.tip.record).not.toHaveBeenCalled();
    }
  });

  test('a no shows nothing, and the start counts', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.control.onButtonClick();
    await pastWindow();
    expect(h.tip.shown).toEqual([]);
    expect(h.tip.record).toHaveBeenCalledTimes(1);
    expect(h.tip.release).not.toHaveBeenCalled();
  });

  test('a double-click does not count, takes back a tip its first click showed and gives the showing back', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.tip.answer(true);
    h.control.onButtonClick();
    await settle();
    expect(h.tip.shown).toHaveLength(1);
    h.setNow(1100);
    h.control.onButtonClick();
    h.control.onButtonDoubleClick();
    expect(h.tip.restored()).toBe(1);
    jest.advanceTimersByTime(ADD_DBLCLICK_WINDOW_MS * 2);
    await settle();
    expect(h.tip.record).not.toHaveBeenCalled();
    expect(h.tip.release).toHaveBeenCalledTimes(1);
    expect(last(h.paints)).toBe('kept-on');
  });

  test('the switch, shift+click and the shortcut neither ask nor count', async () => {
    jest.useFakeTimers();
    for (const start of [
      (h: Harness) => h.control.setSwitch(true),
      (h: Harness) => h.control.onButtonDoubleClick(), // shift+click / shift+Enter
      (h: Harness) => h.control.onGlobalKeyDown(altN()),
    ]) {
      const h = harness();
      h.tip.answer(true);
      start(h);
      expect(h.active()).toBe(true);
      await settle();
      jest.advanceTimersByTime(ADD_DBLCLICK_WINDOW_MS * 2);
      await settle();
      expect(h.tip.query).not.toHaveBeenCalled();
      expect(h.tip.record).not.toHaveBeenCalled();
      expect(h.tip.release).not.toHaveBeenCalled();
      expect(h.tip.shown).toEqual([]);
    }
  });

  test('add mode starting again on its own (the switch kept on, after a save) does not ask', async () => {
    const h = harness();
    h.control.setSwitch(true);
    h.captureAndSave.mockResolvedValue({ ok: true, item: {} as never });
    h.callbacks().onOk(RESULT);
    await flush();
    expect(h.starts()).toBe(2);
    expect(h.tip.query).not.toHaveBeenCalled();
  });

  test('a yes that lands after add mode has ended shows nothing, gives the showing back, and leaves the next click the third', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.tip.answer(true);
    h.control.onButtonClick();
    h.control.onGlobalKeyDown(key({ key: 'Escape' }));
    expect(h.active()).toBe(false);
    await pastWindow();
    expect(h.tip.shown).toEqual([]);
    expect(h.tip.release).toHaveBeenCalledTimes(1);
    expect(h.tip.record).not.toHaveBeenCalled();
  });

  test('the shortcut, once it fires, is reported: the tip never shows again', () => {
    const h = harness();
    expect(h.control.onGlobalKeyDown(altN())).toBe('stop');
    expect(h.tip.shortcutUsed).toHaveBeenCalledTimes(1);
    // Not when it does nothing.
    const g = harness();
    g.typing(true);
    expect(g.control.onGlobalKeyDown(altN())).toBe('pass');
    expect(g.tip.shortcutUsed).not.toHaveBeenCalled();
  });
});
