// src/sidebarWidth.ts
// The sidebar's width: user-resizable (the drag handle on the panel's left
// edge, and its arrow keys) and persisted, so every consumer reads it *live*
// via getSidebarWidth() rather than importing a constant. The panel
// (sidebar.ts) subscribes to follow it — its own box and the page shrink.
// Moved out of sidebar.ts unchanged; no DOM.
//
// The old fixed `SIDEBAR_WIDTH = 320` export is gone on purpose: the old modal
// (backdrop inset), addMode.ts (selectable bounds) and the page-resize logic
// all sized themselves off it, and a stale copy of the width in any of
// those places shows up as the sidebar overlapping page UI or a selection
// that can capture a sliver of our own chrome (§6 #2).
//
// Default is the maximum (300px) rather than the old 320px: the drag range is
// capped at 300, and starting at the widest end of the range preserves as much
// of the pre-resize experience as the new clamp allows. The range and the
// default are in src/sidebarMetrics.ts.

import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebarMetrics';

/** chrome.storage.local key (NOT .session): the width is a durable UI
 *  preference, unlike the per-tab "sidebar is open" flag which is
 *  deliberately session-scoped (§1.1). Content scripts can read and write
 *  chrome.storage.local directly, so this needs no service-worker round trip. */
const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;

/** True once the user has dragged (or arrow-keyed) the handle in this
 *  document. Guards against a slow chrome.storage read landing *after* the
 *  user has already picked a width and snapping the panel back. */
let widthChosenByUser = false;

/** Told of every setSidebarWidth: the new width, and whether it changed. */
export type SidebarWidthListener = (width: number, changed: boolean) => void;

const listeners = new Set<SidebarWidthListener>();

/** The sidebar's current width in CSS pixels. This is the single source of
 *  truth — enlargedView.ts, addMode.ts and the page-resize logic all call it. */
export function getSidebarWidth(): number {
  return sidebarWidth;
}

/** Clamp to the resizable range, tolerating NaN/Infinity from storage. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
}

/**
 * Resize the sidebar. Every subscriber follows at once (the panel: its own
 * width, the page shrink if it is open, and the `--annotator-sidebar-width`
 * custom property any shadow tree can read), all in one place.
 *
 * `persist` is false for the live frames of a drag and true once the gesture
 * commits — writing chrome.storage on every mousemove would be pointless I/O.
 */
export function setSidebarWidth(px: number, options: { persist?: boolean } = {}): void {
  const next = clampSidebarWidth(px);
  const changed = next !== sidebarWidth;
  sidebarWidth = next;
  for (const listener of listeners) listener(next, changed);

  if (options.persist) {
    widthChosenByUser = true;
    persistSidebarWidth(next);
  }
}

/** Follow the width; returns the unsubscribe. */
export function subscribeSidebarWidth(listener: SidebarWidthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persistSidebarWidth(px: number): void {
  try {
    chrome?.storage?.local?.set({ [SIDEBAR_WIDTH_STORAGE_KEY]: px }, () => {
      // Read lastError so Chrome doesn't log an unchecked-error warning; a
      // failed write only costs the user their width next session.
      void chrome.runtime?.lastError;
    });
  } catch {
    // chrome.storage unavailable (restricted page, torn-down context).
  }
}

/** Read the width persisted by an earlier session and apply it, unless the
 *  user has picked one since. */
export function loadPersistedWidth(): void {
  try {
    chrome?.storage?.local?.get(SIDEBAR_WIDTH_STORAGE_KEY, (result) => {
      if (chrome.runtime?.lastError) return;
      if (widthChosenByUser) return; // user already picked one — don't snap back
      const stored = result?.[SIDEBAR_WIDTH_STORAGE_KEY];
      if (typeof stored !== 'number') return;
      setSidebarWidth(stored, { persist: false });
    });
  } catch {
    // chrome.storage unavailable — stay on the default width.
  }
}

/** Hard reset (the sidebar's teardown): the next init re-reads the
 *  persisted width from scratch, so in-memory width state must not leak
 *  across a teardown. Nobody is told — there is no panel to follow it. */
export function resetSidebarWidth(): void {
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  widthChosenByUser = false;
}
