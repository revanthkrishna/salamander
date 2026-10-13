// src/keyRouter.ts
// The one owner of salamander's capture-phase key listeners on `window`.
//
// Several parts of the extension have to see a key before the host page
// does, and some of them have to stop it there: the tooltip's Esc, the
// add-mode controller's Esc and Option/Alt+N, the enlarged view's scroll
// lock (it cancels page-scrolling keys), and the keyboard isolation of each
// closed shadow host (it stops every key inside the host so a page's
// shortcut library can never see, or preventDefault, a key meant for our
// UI — keyboardIsolation.ts says why). They used to be separate window
// listeners whose correctness rested on the order they happened to be
// registered in, each module's comments promising to be registered before
// another's. Here the order is a table: one window listener per key event
// type, and every handler runs at its named priority, lowest first.
//
// A handler returns 'stop' to stop the event (stopPropagation and
// stopImmediatePropagation, once, so neither a later handler nor any page
// listener sees it) or nothing / 'pass' to let it go on. It may call
// preventDefault itself. As with DOM listeners, a handler registered while
// a key is being dispatched first runs for the next key, and one released
// while a key is being dispatched does not run for it.
//
// The window listener goes on with the first handler and comes off with the
// last, so a page without salamander's UI keeps no listener of ours.

export type KeyEventType = 'keydown' | 'keyup' | 'keypress';

export type KeyVerdict = 'stop' | 'pass';

export interface KeyHandler {
  /** Lower runs first; see KEY_PRIORITY. Equal priorities run in the order
   *  they were registered. */
  priority: number;
  /** Which events it hears. Default: keydown only. */
  types?: readonly KeyEventType[];
  handle: (e: KeyboardEvent) => KeyVerdict | void;
}

/** Who sees a key first. */
export const KEY_PRIORITY = {
  /** A tooltip hides on Esc pressed in its root — before anything can stop
   *  the key (tooltip.ts). Never stops it. */
  TOOLTIP_ESC: 10,
  /** Esc ends add mode; Option/Alt+N adds a note, and stops the key when it
   *  does (addModeControl.ts). */
  GLOBAL_ESC_AND_SHORTCUT: 20,
  /** The enlarged view's scroll lock cancels page-scrolling keys; it must see
   *  keys typed inside the view, so it runs before the view's isolation
   *  (scrollLock.ts). Never stops a key. */
  SCROLL_LOCK: 30,
  /** Keys inside the sidebar's host while the enlarged view is open: the
   *  view's own keyboard, then stopped (enlargedView.ts). */
  ENLARGED_ISOLATION: 40,
  /** Keys inside add mode's host once a box is placed (addMode.ts). */
  ADDMODE_ISOLATION: 50,
  /** Keys inside the sidebar's host (sidebar.ts). After the enlarged view's,
   *  which takes every key in the same host while it is open. */
  SIDEBAR_ISOLATION: 60,
  /** Every key on the page while add mode is placing a box (addMode.ts). */
  PLACING_ISOLATION: 70,
} as const;

const DEFAULT_TYPES: readonly KeyEventType[] = ['keydown'];

interface Entry {
  priority: number;
  seq: number;
  types: readonly KeyEventType[];
  handle: (e: KeyboardEvent) => KeyVerdict | void;
  live: boolean;
}

let entries: Entry[] = [];
let seq = 0;
const installed = new Set<KeyEventType>();

function dispatch(e: Event): void {
  const key = e as KeyboardEvent;
  const type = key.type as KeyEventType;
  const run = entries.filter((entry) => entry.types.includes(type));
  for (const entry of run) {
    if (!entry.live) continue;
    if (entry.handle(key) === 'stop') {
      key.stopPropagation();
      key.stopImmediatePropagation();
      return;
    }
  }
}

function syncListeners(): void {
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    const wanted = entries.some((entry) => entry.types.includes(type));
    if (wanted && !installed.has(type)) {
      window.addEventListener(type, dispatch, true);
      installed.add(type);
    } else if (!wanted && installed.has(type)) {
      window.removeEventListener(type, dispatch, true);
      installed.delete(type);
    }
  }
}

/** Run `handler` for every key of its types, at its priority. Returns the
 *  release; calling it again does nothing. */
export function registerKeyHandler(handler: KeyHandler): () => void {
  const entry: Entry = {
    priority: handler.priority,
    seq: seq++,
    types: handler.types ?? DEFAULT_TYPES,
    handle: handler.handle,
    live: true,
  };
  entries = [...entries, entry].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  syncListeners();
  return () => {
    if (!entry.live) return;
    entry.live = false;
    entries = entries.filter((x) => x !== entry);
    syncListeners();
  };
}

/** Test-only: how many handlers are registered, and for which types the
 *  window listener is on. */
export function _routerStateForTests(): { handlers: number; listening: KeyEventType[] } {
  return { handlers: entries.length, listening: [...installed].sort() };
}
