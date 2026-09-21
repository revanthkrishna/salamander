// Salamander design language — src/theme.ts unit tests.
//
// Covers the two things sidebar.ts/addMode.ts/modal.ts will lean on in later
// phases: theme *mode* resolution/persistence/sync (auto/light/dark, driven
// by chrome.storage.local + matchMedia), and that bundled font loading never
// throws even when the browser APIs it needs aren't there.
//
// jsdom provides neither `window.matchMedia` nor `FontFace`/`document.fonts`
// by default (verified against this repo's jest-environment-jsdom version),
// which conveniently doubles as exercising theme.ts's "chrome/matchMedia
// unavailable" fallback paths for free — the matchMedia-dependent tests
// install their own minimal mock instead.

import {
  getThemeMode,
  getResolvedTheme,
  setThemeMode,
  cycleThemeMode,
  subscribeThemeChange,
  registerThemedHost,
  ensureFontsLoaded,
  getThemeCSS,
  LIGHT_THEME,
  DARK_THEME,
  RADII,
  _resetThemeStateForTests,
  isThemeModeSettled,
  whenThemeModeSettled,
} from '../theme';

/** Minimal `matchMedia('(prefers-color-scheme: dark)')` stand-in. Returns a
 *  `setMatches` helper that flips `.matches` and fires the captured 'change'
 *  listener, simulating the OS flipping light/dark while the page is open. */
function installMatchMediaMock(initialMatches: boolean) {
  let matches = initialMatches;
  let changeListener: (() => void) | null = null;
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: jest.fn((event: string, fn: () => void) => {
      if (event === 'change') changeListener = fn;
    }),
    removeEventListener: jest.fn(),
  };
  (window as any).matchMedia = jest.fn().mockReturnValue(mql);
  return {
    mql,
    setMatches(next: boolean) {
      matches = next;
      changeListener?.();
    },
  };
}

beforeEach(() => {
  // theme.ts's mode/host/listener state is module-level singleton state
  // (matching modal.ts's own module-level pattern) — reset it fresh before
  // every test rather than reaching for jest.resetModules() everywhere.
  _resetThemeStateForTests();
  delete (window as any).matchMedia;
});

// ---------------------------------------------------------------------------
// Token data / CSS block
// ---------------------------------------------------------------------------

describe('tokens and getThemeCSS', () => {
  test('light and dark token tables cover the same keys', () => {
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(Object.keys(DARK_THEME).sort());
  });

  test('RADII matches the design spec (sm 6, md 10, lg 14)', () => {
    expect(RADII).toEqual({ sm: 6, md: 10, lg: 14 });
  });

  test('getThemeCSS emits a :host block with light values and a data-theme dark override', () => {
    const css = getThemeCSS();
    expect(css).toMatch(/:host\s*\{/);
    expect(css).toContain(`--sal-bg: ${LIGHT_THEME.bg};`);
    expect(css).toContain(`--sal-line-strong: ${LIGHT_THEME.lineStrong};`);
    expect(css).toMatch(/:host\(\[data-theme="dark"\]\)\s*\{/);
    expect(css).toContain(`--sal-bg: ${DARK_THEME.bg};`);
    // Namespaced font stacks (design spec §5), with a system fallback.
    expect(css).toContain("--sal-font-display: 'Salamander Serif'");
    expect(css).toContain("--sal-font-body: 'Salamander Sans'");
    expect(css).toContain("--sal-font-mono: 'Salamander Mono'");
    expect(css).toContain('--sal-radius-md: 10px;');
  });
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe('mode resolution', () => {
  test('defaults to auto mode, resolved to light when matchMedia is unavailable', () => {
    expect(getThemeMode()).toBe('auto');
    expect(getResolvedTheme()).toBe('light');
  });

  test('auto mode resolves to dark when the OS prefers dark', () => {
    installMatchMediaMock(true);
    expect(getResolvedTheme()).toBe('dark');
  });

  test('explicit light/dark modes ignore the OS preference entirely', () => {
    installMatchMediaMock(true); // OS prefers dark...
    setThemeMode('light'); // ...but an explicit choice wins.
    expect(getResolvedTheme()).toBe('light');

    setThemeMode('dark');
    expect(getResolvedTheme()).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// Cycling
// ---------------------------------------------------------------------------

describe('cycleThemeMode', () => {
  test('cycles auto -> light -> dark -> auto and returns the new mode', () => {
    expect(getThemeMode()).toBe('auto');
    expect(cycleThemeMode()).toBe('light');
    expect(getThemeMode()).toBe('light');
    expect(cycleThemeMode()).toBe('dark');
    expect(getThemeMode()).toBe('dark');
    expect(cycleThemeMode()).toBe('auto');
    expect(getThemeMode()).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Persistence (chrome.storage.local)
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('setThemeMode persists to chrome.storage.local under "themeMode"', async () => {
    setThemeMode('dark');

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ themeMode: 'dark' }, expect.any(Function));

    const stored = await new Promise((resolve) => chrome.storage.local.get('themeMode', resolve));
    expect(stored).toEqual({ themeMode: 'dark' });
  });

  test('a persisted mode is picked up on the next (fresh) init', async () => {
    await new Promise<void>((resolve) => chrome.storage.local.set({ themeMode: 'dark' }, () => resolve()));

    // Simulates a fresh document load: nothing has called into theme.ts yet,
    // so the first call has to trigger the storage read itself (the test
    // mock happens to resolve it synchronously; real chrome.storage is
    // async, which is exactly why getThemeMode() stays a synchronous
    // reader of cached state rather than returning a Promise).
    expect(getThemeMode()).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// Cross-tab storage sync (chrome.storage.onChanged)
// ---------------------------------------------------------------------------

describe('chrome.storage.onChanged sync', () => {
  function getRegisteredListener(): (changes: any, areaName: string) => void {
    const addListenerMock = chrome.storage.onChanged.addListener as jest.Mock;
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    return addListenerMock.mock.calls[0][0];
  }

  test('another tab changing themeMode in local storage updates mode, resolved theme and subscribers', () => {
    expect(getThemeMode()).toBe('auto'); // forces init, registers the listener
    const listener = getRegisteredListener();

    const spy = jest.fn();
    subscribeThemeChange(spy);

    listener({ themeMode: { oldValue: 'auto', newValue: 'dark' } }, 'local');

    expect(getThemeMode()).toBe('dark');
    expect(getResolvedTheme()).toBe('dark');
    expect(spy).toHaveBeenCalledWith('dark', 'dark');
  });

  test('a full state reset removes the listener it registered', () => {
    expect(getThemeMode()).toBe('auto');
    const listener = getRegisteredListener();

    _resetThemeStateForTests();

    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
  });

  test('changes in a different storage area, or to an unrelated key, are ignored', () => {
    expect(getThemeMode()).toBe('auto');
    const listener = getRegisteredListener();

    listener({ themeMode: { newValue: 'dark' } }, 'sync');
    expect(getThemeMode()).toBe('auto');

    listener({ someOtherKey: { newValue: 'dark' } }, 'local');
    expect(getThemeMode()).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// matchMedia change (OS preference flips while the page is open)
// ---------------------------------------------------------------------------

describe('matchMedia change', () => {
  test('OS preference change updates the resolved theme live while in auto mode', () => {
    const mm = installMatchMediaMock(false);
    expect(getResolvedTheme()).toBe('light');

    mm.setMatches(true);
    expect(getResolvedTheme()).toBe('dark');

    mm.setMatches(false);
    expect(getResolvedTheme()).toBe('light');
  });

  test('OS preference change is ignored once the mode is set explicitly', () => {
    const mm = installMatchMediaMock(false);
    setThemeMode('light');

    mm.setMatches(true); // OS now prefers dark, but mode is explicitly 'light'
    expect(getResolvedTheme()).toBe('light');
  });

  test('notifies subscribers on an OS-driven change', () => {
    const mm = installMatchMediaMock(false);
    getResolvedTheme(); // force init before subscribing
    const spy = jest.fn();
    subscribeThemeChange(spy);

    mm.setMatches(true);

    expect(spy).toHaveBeenCalledWith('auto', 'dark');
  });
});

// ---------------------------------------------------------------------------
// registerThemedHost
// ---------------------------------------------------------------------------

describe('registerThemedHost', () => {
  test('sets data-theme immediately and keeps it live until unregistered', () => {
    const hostEl = document.createElement('div');
    const unregister = registerThemedHost(hostEl);
    expect(hostEl.getAttribute('data-theme')).toBe('light');

    setThemeMode('dark');
    expect(hostEl.getAttribute('data-theme')).toBe('dark');

    unregister();
    setThemeMode('light');
    expect(hostEl.getAttribute('data-theme')).toBe('dark'); // unaffected post-unregister
  });

  test('multiple hosts are all kept in sync independently', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    registerThemedHost(a);
    const unregisterB = registerThemedHost(b);

    setThemeMode('dark');
    expect(a.getAttribute('data-theme')).toBe('dark');
    expect(b.getAttribute('data-theme')).toBe('dark');

    unregisterB();
    setThemeMode('light');
    expect(a.getAttribute('data-theme')).toBe('light');
    expect(b.getAttribute('data-theme')).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// Font loading
// ---------------------------------------------------------------------------

describe('ensureFontsLoaded', () => {
  test('resolves silently when chrome.runtime.getURL / FontFace / document.fonts are unavailable (default jsdom env)', async () => {
    await expect(ensureFontsLoaded()).resolves.toBeUndefined();
  });

  test('resolves silently even when every font fetch rejects', async () => {
    const originalGetURL = (chrome.runtime as any).getURL;
    const originalFetch = (global as any).fetch;
    const originalFontFace = (global as any).FontFace;
    const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');

    (chrome.runtime as any).getURL = jest.fn((path: string) => `chrome-extension://test-id/${path}`);
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('blocked by page CSP'));
    (global as any).FontFace = jest.fn().mockImplementation(() => ({
      load: () => Promise.resolve(),
    }));
    Object.defineProperty(document, 'fonts', { value: { add: jest.fn() }, configurable: true });

    try {
      await expect(ensureFontsLoaded()).resolves.toBeUndefined();
      expect((global as any).fetch).toHaveBeenCalled();
    } finally {
      (chrome.runtime as any).getURL = originalGetURL;
      (global as any).fetch = originalFetch;
      (global as any).FontFace = originalFontFace;
      if (originalFontsDescriptor) {
        Object.defineProperty(document, 'fonts', originalFontsDescriptor);
      } else {
        delete (document as any).fonts;
      }
    }
  });

  test('is idempotent — a second call returns the same (already-settled) promise', async () => {
    const first = ensureFontsLoaded();
    const second = ensureFontsLoaded();
    expect(second).toBe(first);
    await first;
  });
});

// ---------------------------------------------------------------------------
// Own-write echoes (rapid toggling must not flicker) and the first-read settle
// ---------------------------------------------------------------------------

describe('own-write echo suppression', () => {
  function listener(): (changes: any, areaName: string) => void {
    return (chrome.storage.onChanged.addListener as jest.Mock).mock.calls[0][0];
  }
  const echo = (oldValue: string | undefined, newValue: string) =>
    listener()({ themeMode: { oldValue, newValue } }, 'local');

  test('rapid toggling: late echoes of this tab\'s own writes never revert the mode', () => {
    expect(getThemeMode()).toBe('auto');
    const spy = jest.fn();
    subscribeThemeChange(spy);

    cycleThemeMode(); // light
    cycleThemeMode(); // dark
    expect(getThemeMode()).toBe('dark');
    spy.mockClear();

    // Echoes arrive afterwards, in write order.
    echo(undefined, 'light');
    expect(getThemeMode()).toBe('dark');
    echo('light', 'dark');
    expect(getThemeMode()).toBe('dark');
    expect(spy).not.toHaveBeenCalled();
  });

  test('a genuine change from another tab still syncs, before or after our echoes', () => {
    expect(getThemeMode()).toBe('auto');
    setThemeMode('light');

    echo('light', 'dark'); // another tab — we never wrote 'dark'
    expect(getThemeMode()).toBe('dark');

    echo(undefined, 'light'); // our (late) echo: ignored, not a revert
    expect(getThemeMode()).toBe('dark');

    echo('dark', 'light'); // the other tab again, now with a value we once wrote
    expect(getThemeMode()).toBe('light');
  });

  test('a write that leaves storage unchanged is not queued, so it can\'t mask a later genuine change', () => {
    chrome.storage.local.set({ themeMode: 'light' });
    expect(getThemeMode()).toBe('light'); // loaded from storage

    setThemeMode('light'); // no-op for storage: Chrome fires no onChanged
    echo('light', 'dark'); // another tab
    expect(getThemeMode()).toBe('dark');
    echo('dark', 'light'); // another tab — must not be mistaken for our echo
    expect(getThemeMode()).toBe('light');
  });
});

describe('initial read settle', () => {
  test('settles once the stored mode arrives, and a slow read never overrides a fresh local choice', async () => {
    let deliver: ((r: Record<string, unknown>) => void) | null = null;
    (chrome.storage.local.get as jest.Mock).mockImplementation((_k: unknown, cb: (r: Record<string, unknown>) => void) => {
      deliver = cb;
    });
    expect(isThemeModeSettled()).toBe(false);
    const settled = whenThemeModeSettled();

    setThemeMode('light'); // user picks before the read lands
    deliver!({ themeMode: 'dark' });
    await settled;

    expect(isThemeModeSettled()).toBe(true);
    expect(getThemeMode()).toBe('light');
  });

  test('settles even when nothing is stored', async () => {
    expect(getThemeMode()).toBe('auto'); // mock answers synchronously with {}
    expect(isThemeModeSettled()).toBe(true);
    await expect(whenThemeModeSettled()).resolves.toBeUndefined();
  });
});
