// Who sees a key first, pair by pair, with the real modules on the key
// router (keyRouter.ts): the order is the priority table's, whatever order
// the handlers were registered in. Each pair registers the later-priority
// handler FIRST, which is exactly what used to break.

import { KEY_PRIORITY, registerKeyHandler } from '../keyRouter';
import { installKeyboardIsolation } from '../keyboardIsolation';
import { lockPageScroll } from '../scrollLock';
import { attachTooltips, TOOLTIP_DELAY_MS } from '../tooltip';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  document.body.innerHTML = '';
  jest.useRealTimers();
});

function closedHost(): { host: HTMLElement; root: ShadowRoot; button: HTMLButtonElement; textarea: HTMLTextAreaElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.dataset.tip = 'a control';
  const textarea = document.createElement('textarea');
  root.append(button, textarea);
  return { host, root, button, textarea };
}

function key(target: Element, k: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

test('TOOLTIP_ESC before any isolation: Esc in the host hides its tooltip', () => {
  jest.useFakeTimers();
  const { host, root, button } = closedHost();
  const iso = installKeyboardIsolation(host);
  cleanups.push(iso.release);
  const tips = attachTooltips(root);
  cleanups.push(tips.destroy);
  button.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, composed: true }));
  jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
  const tip = root.querySelector('.sal-tip') as HTMLElement;
  expect(tip.dataset.open).toBe('true');
  button.focus();
  key(button, 'Escape');
  expect(tip.dataset.open).toBe('false');
});

test('GLOBAL_ESC_AND_SHORTCUT before any isolation: add mode\'s Esc is heard inside the host', () => {
  const { host, textarea } = closedHost();
  const iso = installKeyboardIsolation(host, undefined, KEY_PRIORITY.ADDMODE_ISOLATION);
  cleanups.push(iso.release);
  const seen: string[] = [];
  cleanups.push(registerKeyHandler({ priority: KEY_PRIORITY.GLOBAL_ESC_AND_SHORTCUT, handle: (e) => void seen.push(e.key) }));
  textarea.focus();
  key(textarea, 'Escape');
  expect(seen).toEqual(['Escape']);
});

test('SCROLL_LOCK before ENLARGED_ISOLATION: the lock cancels a page key pressed inside the view', () => {
  const { host, root, button } = closedHost();
  const iso = installKeyboardIsolation(host, undefined, KEY_PRIORITY.ENLARGED_ISOLATION);
  cleanups.push(iso.release);
  const lock = lockPageScroll(host, root);
  cleanups.push(lock.release);
  button.focus();
  expect(key(button, 'PageDown').defaultPrevented).toBe(true);
});

test('ENLARGED_ISOLATION before SIDEBAR_ISOLATION: in the same host, the view\'s keyboard takes the key and the sidebar\'s never runs', () => {
  const { host, textarea } = closedHost();
  const sidebarSaw: string[] = [];
  const viewSaw: string[] = [];
  const sidebarIso = installKeyboardIsolation(host, (e) => sidebarSaw.push(e.key), KEY_PRIORITY.SIDEBAR_ISOLATION);
  cleanups.push(sidebarIso.release);
  const viewIso = installKeyboardIsolation(host, (e) => viewSaw.push(e.key), KEY_PRIORITY.ENLARGED_ISOLATION);
  cleanups.push(viewIso.release);
  textarea.focus();
  key(textarea, 'j');
  expect(viewSaw).toEqual(['j']);
  expect(sidebarSaw).toEqual([]);
});

test('ADDMODE_ISOLATION before PLACING_ISOLATION: a key in add mode\'s host is add mode\'s', () => {
  const { host, textarea } = closedHost();
  const placingSaw: string[] = [];
  cleanups.push(registerKeyHandler({ priority: KEY_PRIORITY.PLACING_ISOLATION, handle: (e) => void placingSaw.push(e.key) }));
  const addSaw: string[] = [];
  const iso = installKeyboardIsolation(host, (e) => addSaw.push(e.key), KEY_PRIORITY.ADDMODE_ISOLATION);
  cleanups.push(iso.release);
  textarea.focus();
  key(textarea, 'k');
  expect(addSaw).toEqual(['k']);
  expect(placingSaw).toEqual([]);
});

test('outside every host, isolation passes the key on untouched', () => {
  const { host } = closedHost();
  const iso = installKeyboardIsolation(host);
  cleanups.push(iso.release);
  const page = jest.fn();
  document.addEventListener('keydown', page);
  cleanups.push(() => document.removeEventListener('keydown', page));
  const e = key(document.body, 'j');
  expect(page).toHaveBeenCalled();
  expect(e.defaultPrevented).toBe(false);
});
