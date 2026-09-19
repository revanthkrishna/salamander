// src/keyboardIsolation.ts
//
// Bug fix: keyboard events leak from our shadow-DOM-injected UI to the host
// page. Real user reports (Gmail, Instagram): typing into the extension's
// textareas only gets some characters through, and on Instagram pressing "n"
// opens Instagram's own notifications panel instead of typing an "n".
//
// Root cause: our textareas live inside a *closed* shadow root
// (addMode.ts/modal.ts both use `attachShadow({ mode: 'closed' })`). Sites
// like Gmail/Instagram/YouTube register global keyboard-shortcut handlers on
// `document` (bubble-phase `document.addEventListener('keydown', ...)` is the
// overwhelmingly common pattern). A closed shadow root hides the real focused
// element from the page's view of `document.activeElement`, so the page's
// shortcut logic can't tell the user is typing into an input and fires its
// shortcut anyway. If that handler calls `event.preventDefault()` (as
// shortcut libraries commonly do), it suppresses the browser's native
// "insert character" default action for the *entire* event dispatch —
// regardless of which element that default action would apply to — so our
// textarea silently loses the keystroke too.
//
// Fix: a capture-phase listener on `window` runs before any `document`-level
// listener, structurally — capture phase proceeds top-down through the DOM
// tree (window -> document -> ... -> target), which is a guarantee, not a
// registration-order race. When the event's target is inside our own shadow
// host, we stopPropagation()/stopImmediatePropagation() it right there so it
// never reaches the page's document/window listeners, but we deliberately do
// NOT call preventDefault() — the browser still needs to run its native
// text-editing default action (character insertion, cursor movement,
// selection, etc.) against our actual textarea target. When the target is
// NOT inside our host, the event passes through completely untouched.
//
// Shared by addMode.ts (the add-mode comment box) and modal.ts (the
// note-editing textarea) — both have the identical closed-shadow-root
// architecture and are identically vulnerable. Install only while the
// respective surface is actually open/focused; never leave this listening
// globally when neither UI is active.

export type KeyboardIsolationCallback = (e: KeyboardEvent) => void;

export interface KeyboardIsolationHandle {
  /** Removes all listeners installed by installKeyboardIsolation(). */
  release: () => void;
}

const ISOLATED_TYPES: Array<'keydown' | 'keyup' | 'keypress'> = ['keydown', 'keyup', 'keypress'];

/**
 * Installs capture-phase `window` listeners for keydown/keyup/keypress that
 * stop propagation of any keyboard event targeting inside `hostEl` (a Shadow
 * DOM host element) before it can reach the host page's own document/window
 * listeners.
 *
 * @param hostEl The extension's shadow-DOM host element. `event.composedPath()`
 *   is checked for this element to determine whether the event originated
 *   from within our UI, since a closed shadow root's `event.target` is
 *   retargeted to the host and doesn't reveal the real inner target anyway.
 * @param onKeydown Optional hook invoked with the event on 'keydown' *before*
 *   we stop its propagation, only when the event is inside `hostEl`. Use this
 *   for isolated-surface-local keyboard behavior (e.g. Escape-to-close) that
 *   would otherwise have relied on a document-level listener that this same
 *   isolation now prevents from ever seeing the event.
 */
export function installKeyboardIsolation(
  hostEl: Element,
  onKeydown?: KeyboardIsolationCallback,
): KeyboardIsolationHandle {
  function isInsideHost(e: Event): boolean {
    return e.composedPath().includes(hostEl);
  }

  function handle(e: KeyboardEvent): void {
    if (!isInsideHost(e)) return; // not our UI — let the page handle it untouched

    if (e.type === 'keydown') onKeydown?.(e);

    // Stop the page from ever seeing this event — but let the browser's
    // native default action (character insertion, cursor movement, etc.)
    // still run against the real target inside our shadow root.
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  for (const type of ISOLATED_TYPES) {
    window.addEventListener(type, handle, true);
  }

  return {
    release: () => {
      for (const type of ISOLATED_TYPES) {
        window.removeEventListener(type, handle, true);
      }
    },
  };
}
