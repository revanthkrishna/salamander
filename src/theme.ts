// src/theme.ts
// Salamander design language — shared foundation (Phase 1 of the redesign).
//
// This module owns three things that sidebar.ts, addMode.ts and enlargedView.ts all
// need identically, so they live here once instead of being copy-pasted:
//
//   1. The light/dark token tables (design spec §1) and a function that turns
//      them into a `:host { --sal-*: ...; }` custom-property block any of the
//      three closed shadow roots can paste at the top of their own <style>.
//   2. Theme *mode* management (auto/light/dark), persisted in
//      chrome.storage.local under `themeMode` (default 'auto') and resolved
//      to an actual light/dark theme via `matchMedia`. `registerThemedHost`
//      keeps a shadow host's `data-theme` attribute in sync with that
//      resolved theme for as long as the host stays registered.
//   3. Bundled webfont loading (design spec §5): shadow-DOM @font-face rules
//      are silently ignored by Chrome, and a host page's CSP can block
//      `chrome-extension://` font URLs from ever being fetched by CSS, so we
//      fetch the woff2 bytes ourselves from the content script and register
//      them with the FontFace API instead.
//
// Every chrome.* / matchMedia access below is wrapped the same way
// sidebar.ts already wraps chrome.storage: optional-chained and inside a
// try/catch, so this module behaves under jsdom (no chrome, no matchMedia)
// exactly like it does in a restricted page context — it just quietly stays
// on defaults instead of throwing.

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
  /** 1px outer keyline around the yellow selection outline. */
  keyline: string;
  /** Add-mode dimming outside the selection. */
  scrim: string;
  /** Modal backdrop. */
  backdrop: string;
  /** Comment box, modal panel. */
  shadowPop: string;
  /** Hovered note text background. */
  shadowNote: string;
}

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
  hover: '#F6F1E4',
  press: '#ECE4D1',
  focus: '#1A1712',
  danger: '#B42318',
  dangerSoft: '#FDE7E4',
  dangerHover: '#FBD2CC',
  dangerPress: '#F6BAB1',
  warn: '#8A5A00',
  warnSoft: '#FFF1CC',
  keyline: 'rgba(26,23,18,0.55)',
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
  hover: '#2A261C',
  press: '#353024',
  focus: '#FBF6EA',
  danger: '#FF7A6B',
  dangerSoft: 'rgba(255,122,107,0.14)',
  dangerHover: 'rgba(255,122,107,0.24)',
  dangerPress: 'rgba(255,122,107,0.34)',
  warn: '#F5C35B',
  warnSoft: 'rgba(245,195,91,0.12)',
  keyline: 'rgba(0,0,0,0.6)',
  scrim: 'rgba(0,0,0,0.5)',
  backdrop: 'rgba(0,0,0,0.65)',
  shadowPop: '0 18px 40px rgba(0,0,0,0.28)',
  shadowNote: '0 10px 28px rgba(0,0,0,0.18), 0 0 0 1px #3A3427',
};

/** Corner radii (design spec §1): sm = badges/tags, md = buttons/thumbnails/
 *  banners/note-hover bg/selection box, lg = comment box/modal panel.
 *  Rounded rectangles everywhere — never pill shapes. */
export const RADII = { sm: 6, md: 10, lg: 14 } as const;

/** `chrome.runtime.getURL`-relative paths of the bundled webfont files,
 *  exported so other tooling (e.g. a build check) can verify they exist
 *  without duplicating the list. Matches manifest.json's
 *  web_accessible_resources entry (`fonts/*.woff2`). */
export const FONT_ASSET_PATHS = [
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
 * Returns the `:host { --sal-*: ...; }` / `:host([data-theme="dark"]) { ... }`
 * custom-property block described in Phase 1's brief. Callers prepend this
 * (as its own `<style>` node, or concatenated into their existing one) inside
 * a closed shadow root, then use `var(--sal-bg)` etc. everywhere instead of
 * hard-coded colours. Light values live on the bare `:host` selector so a
 * host with no `data-theme` attribute yet (e.g. before the first storage
 * read resolves) still renders a coherent, correct theme rather than
 * unstyled/blank.
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
    tokensToCSSDeclarations(LIGHT_THEME),
    '}',
    ':host([data-theme="dark"]) {',
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
// 2 & 3. Theme mode management + font loading
// ---------------------------------------------------------------------------

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'themeMode';
const CYCLE_ORDER: readonly ThemeMode[] = ['auto', 'light', 'dark'];

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** True when the OS/browser currently prefers a dark colour scheme. Always
 *  guarded: `window.matchMedia` doesn't exist under jsdom by default, and a
 *  restricted/extension-less context might not have it either. */
function prefersDark(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  } catch {
    return false;
  }
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDark() ? 'dark' : 'light';
}

type ThemeChangeListener = (mode: ThemeMode, resolved: ResolvedTheme) => void;

let currentMode: ThemeMode = 'auto';
let currentResolved: ResolvedTheme = resolveTheme(currentMode);
let initialized = false;
let darkModeQuery: MediaQueryList | null = null;
const themedHosts = new Set<HTMLElement>();
const listeners = new Set<ThemeChangeListener>();

// ─── Own-write echo suppression ─────────────────────────────────────────────
// chrome.storage.onChanged fires in *every* context, including the one that
// made the write — asynchronously, after this tab has already committed the
// mode locally. Rapid toggling (auto → light → dark) queues two writes; the
// echo of the first ('light') then lands after the local state has moved on
// to 'dark' and, treated as another tab's change, reverts it — a visible
// flicker before the second echo puts it back. So every write this context
// makes is remembered until its echo arrives, and an echo of our own write
// is never re-applied (the local state already reflects it, or something
// newer). Genuine changes from other tabs carry values we have no pending
// write for, and still sync.

interface PendingWrite {
  id: number;
  mode: ThemeMode;
}
/** Our writes whose onChanged echo hasn't arrived yet, oldest first. */
let pendingWrites: PendingWrite[] = [];
let pendingWriteSeq = 0;
/** Best knowledge of what chrome.storage.local currently holds for the key
 *  (from the initial read, our own writes, and onChanged). Chrome doesn't
 *  fire onChanged for a write that leaves the value unchanged, so such a
 *  write must not be queued as pending — its echo would never come. */
let lastKnownStored: ThemeMode | undefined;
/** Safety net for a write whose echo never arrives anyway (e.g. a racing
 *  write from another tab made it a no-op): after this long it no longer
 *  masks a genuine change carrying the same value. */
const PENDING_ECHO_TTL_MS = 3000;

/** True once a local setThemeMode()/cycleThemeMode() has happened, so a slow
 *  initial storage read can't snap the user's fresh choice back (mirrors
 *  sidebar.ts's widthChosenByUser). */
let modeChosenLocally = false;

// ─── First-read settle tracking (wrong-theme flash on first open) ───────────
let modeSettled = false;
let settleResolvers: Array<() => void> = [];

function markModeSettled(): void {
  if (modeSettled) return;
  modeSettled = true;
  const resolvers = settleResolvers;
  settleResolvers = [];
  for (const resolve of resolvers) resolve();
}

function applyThemeToHosts(): void {
  for (const hostEl of themedHosts) hostEl.setAttribute('data-theme', currentResolved);
}

function notifyListeners(): void {
  for (const fn of listeners) fn(currentMode, currentResolved);
}

/** Applies a freshly-resolved mode (from storage, matchMedia or a direct
 *  setThemeMode call) to every registered host and subscriber. */
function commitMode(mode: ThemeMode): void {
  currentMode = mode;
  currentResolved = resolveTheme(mode);
  applyThemeToHosts();
  notifyListeners();
}

function dropPendingWrite(id: number): void {
  pendingWrites = pendingWrites.filter((w) => w.id !== id);
}

function persistMode(mode: ThemeMode): void {
  let pending: PendingWrite | null = null;
  if (mode !== lastKnownStored) {
    pending = { id: ++pendingWriteSeq, mode };
    pendingWrites.push(pending);
  }
  lastKnownStored = mode;
  try {
    chrome?.storage?.local?.set({ [STORAGE_KEY]: mode }, () => {
      // Read lastError so Chrome doesn't log an unchecked-error warning; a
      // failed write only costs the user their theme choice next session.
      const failed = !!chrome.runtime?.lastError;
      if (!pending) return;
      const id = pending.id;
      // A failed write has no echo coming; a successful one should have
      // been (or be about to be) echoed — expire it either way eventually.
      if (failed) dropPendingWrite(id);
      else setTimeout(() => dropPendingWrite(id), PENDING_ECHO_TTL_MS);
    });
  } catch {
    // chrome.storage unavailable (restricted page, torn-down context).
    if (pending) dropPendingWrite(pending.id);
  }
}

function loadPersistedMode(): void {
  try {
    const local = chrome?.storage?.local;
    if (!local?.get) {
      markModeSettled();
      return;
    }
    local.get(STORAGE_KEY, (result) => {
      try {
        if (chrome.runtime?.lastError) return;
        const stored = result?.[STORAGE_KEY];
        if (!isThemeMode(stored)) return;
        if (lastKnownStored === undefined) lastKnownStored = stored;
        // The user already picked a mode in this document — don't snap back.
        if (modeChosenLocally) return;
        if (stored !== currentMode) commitMode(stored);
      } finally {
        markModeSettled();
      }
    });
  } catch {
    // chrome.storage unavailable — stay on the 'auto' default.
    markModeSettled();
  }
}

/** Handles one chrome.storage.onChanged notification for our key. */
function handleStorageChange(newValue: unknown): void {
  if (!isThemeMode(newValue)) return;
  const idx = pendingWrites.findIndex((w) => w.mode === newValue);
  if (idx >= 0) {
    // Echo of our own write. Writes land in order, so anything queued
    // before it has been superseded (or coalesced away) too.
    pendingWrites = pendingWrites.slice(idx + 1);
    return;
  }
  lastKnownStored = newValue;
  if (newValue !== currentMode) commitMode(newValue);
}

function setupStorageListener(): void {
  try {
    chrome?.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes?.[STORAGE_KEY];
      if (!change) return;
      handleStorageChange(change.newValue);
    });
  } catch {
    // chrome.storage unavailable.
  }
}

function setupMatchMediaListener(): void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      // Only 'auto' mode is derived from the OS setting — an explicit
      // light/dark choice must not flip when the OS preference changes.
      if (currentMode !== 'auto') return;
      currentResolved = resolveTheme(currentMode);
      applyThemeToHosts();
      notifyListeners();
    };
    if (typeof darkModeQuery.addEventListener === 'function') {
      darkModeQuery.addEventListener('change', handler);
    } else if (typeof (darkModeQuery as any).addListener === 'function') {
      // Safari < 14 fallback — deprecated but harmless to also register.
      (darkModeQuery as any).addListener(handler);
    }
  } catch {
    // matchMedia unavailable.
  }
}

/** Runs the one-time setup (storage read + live listeners) the first time
 *  any public function in this module is actually used. Deferred rather
 *  than run at module-import time so importing theme.ts has no side effects
 *  of its own — handy for tests that import the token tables/getThemeCSS
 *  without wanting the storage/matchMedia machinery to spin up. */
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  currentResolved = resolveTheme(currentMode);
  setupMatchMediaListener();
  setupStorageListener();
  loadPersistedMode();
}

/** Current theme mode ('auto' | 'light' | 'dark'), synchronously. Reflects
 *  chrome.storage.local once the (async) initial read completes; 'auto'
 *  until then, which is also the documented default. */
export function getThemeMode(): ThemeMode {
  ensureInitialized();
  return currentMode;
}

/** The mode above resolved to an actual theme, taking `matchMedia` into
 *  account for 'auto'. This is what should drive which logo/icon variant a
 *  surface shows (design spec §1's black-vs-yellow logo swap, for example). */
export function getResolvedTheme(): ResolvedTheme {
  ensureInitialized();
  return currentResolved;
}

/** Sets and persists the theme mode, applying it to every registered host
 *  and subscriber immediately (persistence to chrome.storage.local is
 *  fire-and-forget, matching setSidebarWidth's persistSidebarWidth). */
export function setThemeMode(mode: ThemeMode): void {
  ensureInitialized();
  modeChosenLocally = true;
  commitMode(mode);
  persistMode(mode);
}

/** auto -> light -> dark -> auto (design spec §3.4). Returns the new mode so
 *  a caller (e.g. the sidebar's theme toggle) can update its own label/icon
 *  immediately instead of waiting for the subscribe callback. */
export function cycleThemeMode(): ThemeMode {
  ensureInitialized();
  const next = CYCLE_ORDER[(CYCLE_ORDER.indexOf(currentMode) + 1) % CYCLE_ORDER.length];
  setThemeMode(next);
  return next;
}

/** Kick off the persisted-mode read without needing a surface yet. content.ts
 *  calls this as soon as the content script loads, so the read has usually
 *  settled long before the sidebar is first built and shown. Idempotent. */
export function primeThemeMode(): void {
  ensureInitialized();
}

/** True once the initial chrome.storage.local read of the theme mode has
 *  settled (with a value, without one, or failed) — from then on
 *  getThemeMode()/getResolvedTheme() reflect the user's stored choice. */
export function isThemeModeSettled(): boolean {
  ensureInitialized();
  return modeSettled;
}

/** Resolves once isThemeModeSettled() is true (immediately if it already
 *  is). Never rejects; callers that must not block should race it with a
 *  timeout (sidebar.ts does). */
export function whenThemeModeSettled(): Promise<void> {
  ensureInitialized();
  if (modeSettled) return Promise.resolve();
  return new Promise((resolve) => settleResolvers.push(resolve));
}

/** Subscribes to mode/resolved-theme changes from ANY source: a direct
 *  setThemeMode()/cycleThemeMode() call, another tab changing
 *  chrome.storage, or (in 'auto' mode) the OS flipping light/dark. Does NOT
 *  fire immediately with the current value — read getThemeMode()/
 *  getResolvedTheme() for that. Returns an unsubscribe function. */
export function subscribeThemeChange(fn: ThemeChangeListener): () => void {
  ensureInitialized();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Registers a shadow-DOM host element (sidebar/add-mode/modal) to have its
 * `data-theme` attribute kept in sync with the resolved theme for as long as
 * it stays registered — set once immediately, then live on every future
 * mode/OS-preference change. Callers whose host is torn down and rebuilt
 * per-open (addMode.ts) should call the returned unregister
 * function from their own teardown so the Set doesn't accumulate dead
 * elements across many open/close cycles.
 */
export function registerThemedHost(hostEl: HTMLElement): () => void {
  ensureInitialized();
  themedHosts.add(hostEl);
  hostEl.setAttribute('data-theme', currentResolved);
  return () => {
    themedHosts.delete(hostEl);
  };
}

/** Test-only: drops all module state (mode, listeners, registered hosts,
 *  the matchMedia listener, the cached font-load promise) back to a fresh
 *  import's defaults. Mirrors modal.ts's `_destroyForTests` pattern so
 *  theme.test.ts doesn't need `jest.resetModules()` between cases. */
export function _resetThemeStateForTests(): void {
  currentMode = 'auto';
  currentResolved = resolveTheme(currentMode);
  initialized = false;
  darkModeQuery = null;
  themedHosts.clear();
  listeners.clear();
  fontsLoadPromise = null;
  pendingWrites = [];
  pendingWriteSeq = 0;
  lastKnownStored = undefined;
  modeChosenLocally = false;
  modeSettled = false;
  settleResolvers = [];
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
