// src/addNoteTip.ts
// The Option/Alt+N tip (design spec §AH's companion, 2026-10-13): when the
// add-mode hint that follows the cursor says "tip: ⌥N to add a note"
// instead of "click or drag to select". Pure: the counts come from the
// service worker (background.ts, storage.ts), which owns both stores.
//
//   - It is earned by starting add mode with a single click on "add note"
//     — never the switch, a double-click, shift+click or the shortcut
//     itself — and shows on the third such start of a browser session
//     (chrome.storage.session: the count resets when the browser restarts).
//   - At most three times per install (chrome.storage.local, which an
//     uninstall clears), and never again once the shortcut has been used
//     even once — the tip has nothing left to teach.

/** The single-click start of a browser session the tip shows on. */
export const TIP_ON_CLICK = 3;
/** The most times it shows per install. */
export const TIP_LIFETIME_MAX = 3;

/** What chrome.storage.local remembers across sessions. */
export interface AddNoteTipState {
  /** How many times the tip has been shown on this install. */
  shown: number;
  /** The shortcut has fired at least once. */
  shortcutUsed: boolean;
}

export const FRESH_TIP_STATE: AddNoteTipState = { shown: 0, shortcutUsed: false };

/** Read back from storage: anything malformed is a fresh state. */
export function parseTipState(value: unknown): AddNoteTipState {
  const v = value as Partial<AddNoteTipState> | null | undefined;
  const shown = typeof v?.shown === 'number' && Number.isFinite(v.shown) && v.shown >= 0 ? Math.floor(v.shown) : 0;
  return { shown, shortcutUsed: v?.shortcutUsed === true };
}

/** Whether the single-click start about to be counted — the session's
 *  `clicksBefore + 1`th — shows the tip. */
export function shouldShowTip(clicksBefore: number, state: AddNoteTipState): boolean {
  return clicksBefore + 1 === TIP_ON_CLICK && state.shown < TIP_LIFETIME_MAX && !state.shortcutUsed;
}
