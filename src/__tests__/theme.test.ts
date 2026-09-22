// Salamander design language — src/theme.ts unit tests.
//
// Covers the token tables and the CSS block every surface pastes into its
// shadow root, and that bundled font loading never throws even when the
// browser APIs it needs aren't there. The extension is dark only (design
// spec §AA): only DARK_THEME is emitted, and LIGHT_THEME is kept for a
// future light theme — so these also pin that the two tables still match.

import { ensureFontsLoaded, getThemeCSS, LIGHT_THEME, DARK_THEME, RADII, _resetThemeStateForTests } from '../theme';

beforeEach(() => {
  _resetThemeStateForTests();
});

// ---------------------------------------------------------------------------
// Token data / CSS block
// ---------------------------------------------------------------------------

describe('tokens and getThemeCSS', () => {
  test('the parked light table still covers the same keys as the dark one', () => {
    // So restoring a light theme is a matter of emitting it, not of finding
    // which tokens it is missing.
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(Object.keys(DARK_THEME).sort());
  });

  test('RADII matches the design spec (sm 6, md 10, lg 14)', () => {
    expect(RADII).toEqual({ sm: 6, md: 10, lg: 14 });
  });

  test('getThemeCSS emits the dark tokens on the bare :host, and nothing else', () => {
    const css = getThemeCSS();
    expect(css).toMatch(/:host\s*\{/);
    expect(css).toContain(`--sal-bg: ${DARK_THEME.bg};`);
    expect(css).toContain(`--sal-line-strong: ${DARK_THEME.lineStrong};`);
    expect(css).toContain(`--sal-accent-icon: ${DARK_THEME.accentIcon};`);
    // No light values, and no theme selector left to switch on.
    expect(css).not.toContain(`--sal-bg: ${LIGHT_THEME.bg};`);
    expect(css).not.toMatch(/data-theme/);
    // Exactly one --sal-bg declaration.
    expect(css.match(/--sal-bg:/g)).toHaveLength(1);
    // Namespaced font stacks (design spec §5), with a system fallback.
    expect(css).toContain("--sal-font-display: 'Salamander Serif'");
    expect(css).toContain("--sal-font-body: 'Salamander Sans'");
    expect(css).toContain("--sal-font-mono: 'Salamander Mono'");
    expect(css).toContain('--sal-radius-md: 10px;');
  });
});

// ---------------------------------------------------------------------------
// Fonts
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
