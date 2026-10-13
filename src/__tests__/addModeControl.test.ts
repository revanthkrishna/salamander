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
      },
      isAddModeActive: () => isActive,
      dismissDrawingMenu: () => {
        const was = menuOpen;
        menuOpen = false;
        return was;
      },
      hideOverlayUI: () => {},
      showOverlayUI: () => {},
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
