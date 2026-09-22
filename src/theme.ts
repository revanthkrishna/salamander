// src/theme.ts
// Salamander design language — shared foundation.
//
// This module owns what sidebar.ts, addMode.ts and enlargedView.ts all need
// identically, so it lives here once instead of being copy-pasted:
//
//   1. The token tables (design spec §1) and a function that turns them into
//      a `:host { --sal-*: ...; }` custom-property block any of the three
//      closed shadow roots can paste at the top of their own <style>.
//   2. Bundled webfont loading (design spec §5): shadow-DOM @font-face rules
//      are silently ignored by Chrome, and a host page's CSP can block
//      `chrome-extension://` font URLs from ever being fetched by CSS, so we
//      fetch the woff2 bytes ourselves from the content script and register
//      them with the FontFace API instead.
//
// The extension is DARK ONLY (design spec §AA). Both token tables are kept,
// but only DARK_THEME is emitted. LIGHT_THEME is parked on purpose so a light
// theme can come back without re-deriving a palette: emit it under a
// selector in getThemeCSS() again and give the user a way to choose. The
// mode machinery that used to do that (auto/light/dark, persisted and synced
// across tabs, following the OS setting) was removed with the switcher, and
// is in git history.

// ---------------------------------------------------------------------------
// 1. Tokens (design spec §1)
// ---------------------------------------------------------------------------

/** One row per token in design spec §1's table. Values are final CSS
 *  color/shadow strings — callers never need to know which theme they came
 *  from, only which token they want. */
export interface ThemeTokens {
  /** Sidebar background, panel grounds. */
  bg: string;
  /** Cards, comment box, inputs, secondary buttons. */
  surface: string;
  /** Subtle fills. */
  raised: string;
  /** 1px borders, dividers. */
  line: string;
  /** Hover borders. */
  lineStrong: string;
  /** Primary text. */
  text: string;
  /** Secondary text, placeholders, counter. */
  muted: string;
  /** Brand yellow fills (matches icons/logo-button.svg). */
  accent: string;
  /** Primary hover. */
  accentHover: string;
  /** Primary press. */
  accentPress: string;
  /** Text/icons on yellow. */
  onAccent: string;
  /** "save" text-button colour at rest (black in light, yellow in dark). */
  accentInk: string;
  /** A yellow icon on a neutral surface (the add-note button at rest). The
   *  deeper pressed shade in light theme, where plain accent on white is too
   *  faint to read; plain accent in dark, where it is the strongest. */
  accentIcon: string;
  /** Ghost/secondary hover fill. */
  hover: string;
  /** Ghost/secondary press fill. */
  press: string;
  /** Focus ring colour. */
  focus: string;
  /** Delete text, error text, counter >= 980. */
  danger: string;
  /** Delete button fill, error banner. */
  dangerSoft: string;
  dangerHover: string;
  dangerPress: string;
  /** Warning banner text/icon. */
  warn: string;
  /** Warning banner fill. */
  warnSoft: string;
  /** Add-mode dimming outside the selection. */
  scrim: string;
  /** Modal backdrop. */
  backdrop: string;
  /** Comment box, modal panel. */
  shadowPop: string;
  /** Hovered note text background. */
  shadowNote: string;
}

/** Not emitted — the extension is dark only (see the file banner). Kept so a
 *  light theme can be restored without re-deriving the palette. */
export const LIGHT_THEME: ThemeTokens = {
  bg: '#FFFCF5',
  surface: '#FFFFFF',
  raised: '#F6F1E4',
  line: '#EAE3D2',
  lineStrong: '#CFC5AE',
  text: '#1A1712',
  muted: '#6E6656',
  accent: '#FEC800',
  accentHover: '#FFD740',
  accentPress: '#E8B600',
  onAccent: '#1A1712',
  accentInk: '#1A1712',
  accentIcon: '#E8B600',
  hover: '#F6F1E4',
  press: '#ECE4D1',
  focus: '#1A1712',
  danger: '#B42318',
  dangerSoft: '#FDE7E4',
  dangerHover: '#FBD2CC',
  dangerPress: '#F6BAB1',
  warn: '#8A5A00',
  warnSoft: '#FFF1CC',
  scrim: 'rgba(26,23,18,0.42)',
  backdrop: 'rgba(20,18,13,0.55)',
  shadowPop: '0 18px 40px rgba(0,0,0,0.28)',
  // {line} substituted with LIGHT's own `line` value (design spec §1 footnote).
  shadowNote: '0 10px 28px rgba(0,0,0,0.18), 0 0 0 1px #EAE3D2',
};

export const DARK_THEME: ThemeTokens = {
  bg: '#14120D',
  surface: '#1D1A13',
  raised: '#2A261C',
  line: '#3A3427',
  lineStrong: '#56503F',
  text: '#FBF6EA',
  muted: '#B3AA96',
  accent: '#FEC800',
  accentHover: '#FFD740',
  accentPress: '#E8B600',
  onAccent: '#1A1712',
  accentInk: '#FEC800',
  accentIcon: '#FEC800',
  hover: '#2A261C',
  press: '#353024',
  focus: '#FBF6EA',
  danger: '#FF7A6B',
  dangerSoft: 'rgba(255,122,107,0.14)',
  dangerHover: 'rgba(255,122,107,0.24)',
  dangerPress: 'rgba(255,122,107,0.34)',
  warn: '#F5C35B',
  warnSoft: 'rgba(245,195,91,0.12)',
  scrim: 'rgba(0,0,0,0.5)',
  backdrop: 'rgba(0,0,0,0.65)',
  shadowPop: '0 18px 40px rgba(0,0,0,0.28)',
  shadowNote: '0 10px 28px rgba(0,0,0,0.18), 0 0 0 1px #3A3427',
};

/** Corner radii (design spec §1): sm = badges/tags, md = buttons/thumbnails/
 *  banners/note-hover bg/selection box, lg = comment box/modal panel.
 *  Rounded rectangles everywhere — never pill shapes. */
export const RADII = { sm: 6, md: 10, lg: 14 } as const;

/** `chrome.runtime.getURL`-relative paths of the bundled webfont files —
 *  the type source for FontSpec.path below, so a typo in FONT_SPECS is a
 *  compile error. Matches manifest.json's web_accessible_resources entry
 *  (`fonts/*.woff2`). */
const FONT_ASSET_PATHS = [
  'fonts/instrument-serif-latin-400-normal.woff2',
  'fonts/instrument-serif-latin-400-italic.woff2',
  'fonts/instrument-sans-latin-400-normal.woff2',
  'fonts/instrument-sans-latin-500-normal.woff2',
  'fonts/instrument-sans-latin-600-normal.woff2',
  'fonts/instrument-sans-latin-700-normal.woff2',
  'fonts/jetbrains-mono-latin-400-normal.woff2',
  'fonts/jetbrains-mono-latin-500-normal.woff2',
  'fonts/jetbrains-mono-latin-600-normal.woff2',
] as const;

/** camelCase -> kebab-case, e.g. `lineStrong` -> `line-strong`. Used to turn
 *  ThemeTokens keys into `--sal-*` custom property names without a second,
 *  hand-maintained name table that could drift from the interface above. */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function tokensToCSSDeclarations(tokens: ThemeTokens): string {
  return (Object.keys(tokens) as Array<keyof ThemeTokens>)
    .map((key) => `  --sal-${kebabCase(key)}: ${tokens[key]};`)
    .join('\n');
}

/** Namespaced font stacks (design spec §5) — "Salamander *" is what
 *  ensureFontsLoaded() registers via the FontFace API, always with a system
 *  fallback stack in case loading failed or hasn't finished yet. */
const FONT_DISPLAY_CSS = `  --sal-font-display: 'Salamander Serif', 'Times New Roman', Georgia, serif;`;
const FONT_BODY_CSS = `  --sal-font-body: 'Salamander Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;`;
const FONT_MONO_CSS = `  --sal-font-mono: 'Salamander Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`;

const RADII_CSS = `  --sal-radius-sm: ${RADII.sm}px;\n  --sal-radius-md: ${RADII.md}px;\n  --sal-radius-lg: ${RADII.lg}px;`;

/**
 * Returns the `:host { --sal-*: ...; }` custom-property block (design spec
 * §1's tokens — the dark set, the only one in use). Callers prepend this (as
 * its own `<style>` node, or concatenated into their existing one) inside a
 * closed shadow root, then use `var(--sal-bg)` etc. everywhere instead of
 * hard-coded colours. On the bare `:host`, so it applies from the first
 * paint with nothing to wait for.
 *
 * This is pure string data — it doesn't touch the DOM, so it's safe to call
 * at any time, including outside a shadow root (e.g. from a test).
 */
export function getThemeCSS(): string {
  return [
    ':host {',
    RADII_CSS,
    FONT_DISPLAY_CSS,
    FONT_BODY_CSS,
    FONT_MONO_CSS,
    tokensToCSSDeclarations(DARK_THEME),
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Shared CSS snippets (design spec §2) — kept intentionally small. These
// cover the handful of interaction-state rules every control repeats
// (focus ring, press scale, transition timing, disabled look) so restyled
// components can paste one line instead of retyping the same values; they
// are NOT a full button component system — each surface still owns its own
// layout/variant CSS.
// ---------------------------------------------------------------------------

/** `:focus-visible` ring (§2): "0 0 0 2px {bg}, 0 0 0 4px {focus}", only ever
 *  applied on keyboard focus. Paste inside a `:focus-visible { }` block. */
export const FOCUS_RING_CSS = 'box-shadow: 0 0 0 2px var(--sal-bg), 0 0 0 4px var(--sal-focus);';

/* Press feedback used to add `transform: scale(0.97)` on top of the control's
 * own press fill. It is gone (design spec §2, revised): a press changes the
 * fill of the thing under the pointer and nothing else. On a two-half control
 * it moved the half you were not pressing, and on the export group with its
 * menu open it slid the menu item out from under the pointer between
 * mousedown and mouseup, so the click landed on the panel instead. */

/** Interaction-state transition timing shared by every control (§2):
 *  120-160ms ease-out on colour-ish properties, 80ms for the press scale. */
export const STATE_TRANSITION_CSS =
  'transition: background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out, transform 80ms ease-out;';

/** Disabled look (§2): no hover/press states apply on top of this — callers
 *  are expected to also stop wiring pointer handlers while disabled. */
export const DISABLED_CSS = 'opacity: 0.4; cursor: default;';

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Test-only: drops the cached font-load promise so each case starts from a
 *  fresh import's state. */
export function _resetThemeStateForTests(): void {
  fontsLoadPromise = null;
}

// ---------------------------------------------------------------------------
// Font loading (design spec §5)
// ---------------------------------------------------------------------------

interface FontSpec {
  family: string;
  path: (typeof FONT_ASSET_PATHS)[number];
  weight: string;
  style: 'normal' | 'italic';
}

const FONT_SPECS: readonly FontSpec[] = [
  { family: 'Salamander Serif', path: 'fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
  { family: 'Salamander Serif', path: 'fonts/instrument-serif-latin-400-italic.woff2', weight: '400', style: 'italic' },
  { family: 'Salamander Sans', path: 'fonts/instrument-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
  { family: 'Salamander Sans', path: 'fonts/instrument-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
  { family: 'Salamander Sans', path: 'fonts/instrument-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  { family: 'Salamander Sans', path: 'fonts/instrument-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  { family: 'Salamander Mono', path: 'fonts/jetbrains-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
  { family: 'Salamander Mono', path: 'fonts/jetbrains-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  { family: 'Salamander Mono', path: 'fonts/jetbrains-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
];

let fontsLoadPromise: Promise<void> | null = null;

/** Fetches+registers one bundled font. Failures (missing file, blocked
 *  fetch, unsupported FontFace descriptor) are swallowed here so one bad
 *  font never stops the rest from loading — every surface already falls
 *  back to the system stack in getThemeCSS() regardless. */
async function loadOneFont(spec: FontSpec): Promise<void> {
  try {
    const url = chrome.runtime.getURL(spec.path);
    const buffer = await fetch(url).then((res) => res.arrayBuffer());
    const face = new FontFace(spec.family, buffer, { weight: spec.weight, style: spec.style });
    await face.load();
    document.fonts.add(face);
  } catch {
    // Silent fallback to the system font stack (design spec §5).
  }
}

/**
 * Loads the bundled Salamander Serif/Sans/Mono webfonts, once, lazily.
 * Content scripts can't rely on `@font-face` in a shadow root (Chrome
 * ignores it there) or on the host page's CSP allowing a
 * `chrome-extension://` font URL through `font-src`, so this fetches the
 * woff2 bytes directly and registers them with `document.fonts` via the
 * FontFace API instead — see the file banner for the full rationale.
 *
 * Safe to call repeatedly (returns the same in-flight/resolved promise) and
 * safe to call where `chrome`/`document.fonts`/`FontFace` don't exist
 * (jsdom, a torn-down context): it resolves without throwing either way,
 * leaving every surface on its system font fallback.
 */
export function ensureFontsLoaded(): Promise<void> {
  if (!fontsLoadPromise) {
    fontsLoadPromise = (async () => {
      try {
        if (
          typeof document === 'undefined' ||
          !document.fonts ||
          typeof FontFace === 'undefined' ||
          typeof chrome === 'undefined' ||
          !chrome.runtime?.getURL
        ) {
          return;
        }
        await Promise.all(FONT_SPECS.map(loadOneFont));
      } catch {
        // Belt-and-braces: loadOneFont already swallows its own errors, but
        // nothing here should ever throw out to a caller.
      }
    })();
  }
  return fontsLoadPromise;
}
