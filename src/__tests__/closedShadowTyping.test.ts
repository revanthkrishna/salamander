// Typing inside a CLOSED shadow root while the enlarged view's page-scroll
// lock is listening on window.
//
// Every other suite forces shadow roots open (and so does the Playwright
// helper), which is exactly how a bug slipped through: from a window-level
// listener, composedPath() into a closed root stops at the host, so the lock
// could not tell a key typed into the note textarea from one pressed on the
// page, and cancelled Space, the arrows and Home/End as page scrolls. These
// tests use a real closed root and first prove the environment reproduces
// that retargeting, so they cannot pass vacuously.

import { lockPageScroll, ScrollLockHandle } from '../enlargedView';

/** Every lock a test takes, released in afterEach — so a failing assertion
 *  can never leave a listener on window for the next test to trip over. */
const locks: ScrollLockHandle[] = [];
function lock(host: Element, root: ShadowRoot | null): ScrollLockHandle {
  const handle = lockPageScroll(host, root);
  locks.push(handle);
  return handle;
}

function setup() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  const textarea = document.createElement('textarea');
  const button = document.createElement('button');
  root.append(textarea, button);
  return { host, root, textarea, button };
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  for (const handle of locks.splice(0)) handle.release();
  document.body.innerHTML = '';
});

describe('page scroll lock over a closed shadow root', () => {
  test('the environment hides the inner target from window, as Chrome does', () => {
    const { host, textarea } = setup();
    let seen: EventTarget | undefined;
    const spy = (e: Event) => {
      seen = e.composedPath()[0];
    };
    window.addEventListener('keydown', spy, true);
    textarea.focus();
    keydown(textarea, ' ');
    window.removeEventListener('keydown', spy, true);
    expect(seen).toBe(host);
  });

  test.each([' ', 'Spacebar', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])(
    '%p typed into the textarea is never cancelled',
    (key) => {
      const { host, root, textarea } = setup();
      lock(host, root);
      textarea.focus();
      expect(keydown(textarea, key).defaultPrevented).toBe(false);
    },
  );

  test('shift+space in the textarea is never cancelled either', () => {
    const { host, root, textarea } = setup();
    lock(host, root);
    textarea.focus();
    expect(keydown(textarea, ' ', { shiftKey: true }).defaultPrevented).toBe(false);
  });

  test('the lock still holds: Space on a control that cannot scroll is cancelled', () => {
    const { host, root, button } = setup();
    lock(host, root);
    button.focus();
    expect(keydown(button, ' ').defaultPrevented).toBe(true);
    expect(keydown(button, 'PageDown').defaultPrevented).toBe(true);
  });

  test('a key pressed on the page itself is cancelled', () => {
    const { host, root } = setup();
    lock(host, root);
    const outside = document.createElement('div');
    outside.tabIndex = 0;
    document.body.appendChild(outside);
    outside.focus();
    expect(keydown(outside, ' ').defaultPrevented).toBe(true);
  });

  test('ordinary characters are never touched', () => {
    const { host, root, textarea } = setup();
    lock(host, root);
    textarea.focus();
    for (const key of ['a', 'Z', '1', '.', ',', '!', '@', '#', '"', "'", '/', '\\', 'é', '中', 'Enter', 'Tab', 'Backspace']) {
      expect(keydown(textarea, key).defaultPrevented).toBe(false);
    }
  });

  test('released, it lets everything through', () => {
    const { host, root, button } = setup();
    lock(host, root).release();
    button.focus();
    expect(keydown(button, ' ').defaultPrevented).toBe(false);
  });
});
