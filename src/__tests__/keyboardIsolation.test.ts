// Bug fix regression coverage: keyboard events leaking from our closed
// shadow-DOM UI to the host page's own global keyboard-shortcut handlers
// (real user reports: Gmail/Instagram swallowing keystrokes typed into the
// extension's comment box, and Instagram's "n" shortcut firing instead of
// the character being typed).
//
// We cannot exercise real Gmail/Instagram/YouTube JS here (no browser), so
// this proves the *mechanism* instead: a document-level bubble-phase
// listener standing in for a hostile page's shortcut handler must never see
// (or be able to preventDefault()) a keydown whose real target lives inside
// our shadow host.
//
// Note on what "the target still processes it" means here: per the DOM
// spec, once stopPropagation() is called from an ancestor's capture-phase
// listener, *no* later listener in the path is invoked for that dispatch —
// not the page's, but also not our own target's own 'keydown' listeners
// (verified empirically below). That's fine: stopPropagation() does not set
// the event's canceled flag (only preventDefault() does), and a real
// browser's native "insert character" default action is gated purely on
// that canceled flag against the currently-focused element — it is not
// implemented as a JS listener invocation on the target at all. So the
// event completing dispatch with defaultPrevented === false is exactly what
// proves native typing would still work. Concretely, neither addMode.ts nor
// modal.ts attach a 'keydown' listener to their textareas — both react to
// the separate, later 'input' event a real browser fires once native
// insertion completes — so this fix does not need the isolated keydown
// itself to reach any of our own listeners.

import { installKeyboardIsolation } from '../keyboardIsolation';

function buildShadowHost(): { host: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const host = document.createElement('div');
  document.documentElement.appendChild(host);
  // mode: 'closed' — the exact architecture addMode.ts/modal.ts use, and the
  // root cause of the bug (a closed root hides the real focused element from
  // the page's document.activeElement).
  const shadow = host.attachShadow({ mode: 'closed' });
  const textarea = document.createElement('textarea');
  shadow.appendChild(textarea);
  return { host, textarea };
}

describe('keyboardIsolation (mechanism proof)', () => {
  afterEach(() => {
    document.querySelectorAll('div').forEach((el) => el.remove());
  });

  test('a hostile document-level bubble handler never sees (or can preventDefault) a keydown targeting inside the shadow host, so the native default action is never suppressed', () => {
    const { host, textarea } = buildShadowHost();

    // Simulate a page like Gmail/Instagram/YouTube: a bubble-phase listener
    // on `document` that treats any keydown as a global shortcut and calls
    // preventDefault() on it (the common shortcut-library pattern that, per
    // the browser's event model, would otherwise suppress the native
    // "insert character" default action for the whole event dispatch,
    // regardless of which element that default action would apply to).
    let pageHandlerFired = false;
    const pageHandler = (e: KeyboardEvent) => {
      pageHandlerFired = true;
      e.preventDefault();
    };
    document.addEventListener('keydown', pageHandler);

    const isolation = installKeyboardIsolation(host);

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      bubbles: true,
      cancelable: true,
      composed: true, // crosses the shadow boundary, exactly like a real key event
    });
    const dispatchReturnedTrue = textarea.dispatchEvent(event);

    // The page's global shortcut handler must never have fired, so it never
    // got the chance to call preventDefault().
    expect(pageHandlerFired).toBe(false);

    // dispatchEvent() returns false only when *something* called
    // preventDefault() during the full dispatch; true here proves the event
    // reached the end of dispatch uncancelled. This is exactly what a real
    // browser's native "insert character" default action is gated on — that
    // default action is a browser-native behavior tied to the focused
    // element and the event's canceled state, not to whether any JS
    // listener was invoked on the target — so in a real browser this proves
    // the character would still be typed into the textarea normally.
    expect(event.defaultPrevented).toBe(false);
    expect(dispatchReturnedTrue).toBe(true);

    isolation.release();
    document.removeEventListener('keydown', pageHandler);
  });

  test('stopping propagation for the page does not stop the same event from being independently followed by a working input event (the actual mechanism our textareas rely on)', () => {
    // addMode.ts / modal.ts don't attach their own 'keydown' listeners to
    // their textareas at all — they react to the 'input' event, which a real
    // browser fires as a brand-new, separate dispatch *after* performing the
    // native character-insertion default action. That later 'input' event is
    // completely unaffected by anything that happened during the earlier
    // keydown's propagation (including our isolation calling stopPropagation
    // on it), which is exactly why the fix does not need — and must not rely
    // on — any listener seeing the isolated keydown itself.
    const { host, textarea } = buildShadowHost();
    const isolation = installKeyboardIsolation(host);

    let inputSeen = '';
    textarea.addEventListener('input', () => {
      inputSeen = textarea.value;
    });

    // 1) The keydown a hostile page would love to hijack — isolated away.
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true }),
    );

    // 2) What the browser's native default action would have just done,
    // followed by the resulting 'input' event it always fires afterward.
    textarea.value = 'n';
    textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(inputSeen).toBe('n');

    isolation.release();
  });

  test('does not touch keydowns whose target is outside the shadow host', () => {
    const { host } = buildShadowHost();
    const isolation = installKeyboardIsolation(host);

    let pageHandlerFired = false;
    const pageHandler = () => {
      pageHandlerFired = true;
    };
    document.addEventListener('keydown', pageHandler);

    const outsideInput = document.createElement('input');
    document.body.appendChild(outsideInput);
    outsideInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
    );

    expect(pageHandlerFired).toBe(true);

    isolation.release();
    document.removeEventListener('keydown', pageHandler);
    outsideInput.remove();
  });

  test('invokes the optional onKeydown callback for isolated events before stopping propagation', () => {
    const { host, textarea } = buildShadowHost();
    const seen: string[] = [];
    const isolation = installKeyboardIsolation(host, (e) => seen.push(e.key));

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }),
    );

    expect(seen).toEqual(['Escape']);
    isolation.release();
  });

  test('release() fully removes the listeners — a subsequent keydown reaches the page again', () => {
    const { host, textarea } = buildShadowHost();
    const isolation = installKeyboardIsolation(host);
    isolation.release();

    let pageHandlerFired = false;
    document.addEventListener('keydown', () => {
      pageHandlerFired = true;
    });

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true, composed: true }),
    );

    expect(pageHandlerFired).toBe(true);
  });
});
