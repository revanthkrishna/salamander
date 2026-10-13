// src/keyRouter.ts: one window capture listener per key type, handlers in
// priority order.

import { KEY_PRIORITY, registerKeyHandler, _routerStateForTests } from '../keyRouter';

const releases: Array<() => void> = [];
function reg(...args: Parameters<typeof registerKeyHandler>): () => void {
  const release = registerKeyHandler(...args);
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

function press(target: EventTarget = document.body, init: KeyboardEventInit = { key: 'a' }, type = 'keydown'): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

test('handlers run lowest priority first, equal priorities in registration order', () => {
  const seen: string[] = [];
  reg({ priority: 30, handle: () => void seen.push('c') });
  reg({ priority: 10, handle: () => void seen.push('a') });
  reg({ priority: 30, handle: () => void seen.push('d') });
  reg({ priority: 20, handle: () => void seen.push('b') });
  press();
  expect(seen).toEqual(['a', 'b', 'c', 'd']);
});

test("'stop' stops the event: no later handler, and no page listener, sees it", () => {
  const seen: string[] = [];
  const page = jest.fn();
  document.addEventListener('keydown', page);
  reg({ priority: 10, handle: () => 'stop' });
  reg({ priority: 20, handle: () => void seen.push('later') });
  const e = press();
  document.removeEventListener('keydown', page);
  expect(seen).toEqual([]);
  expect(page).not.toHaveBeenCalled();
  // Stopping is not cancelling: the default action (typing) still runs.
  expect(e.defaultPrevented).toBe(false);
});

test('types: a handler hears only its own; keydown by default', () => {
  const seen: string[] = [];
  reg({ priority: 10, handle: (e) => void seen.push(`down:${e.type}`) });
  reg({ priority: 10, types: ['keyup', 'keypress'], handle: (e) => void seen.push(`other:${e.type}`) });
  press(document.body, { key: 'a' }, 'keydown');
  press(document.body, { key: 'a' }, 'keyup');
  press(document.body, { key: 'a' }, 'keypress');
  expect(seen).toEqual(['down:keydown', 'other:keyup', 'other:keypress']);
});

test('as with DOM listeners: one registered mid-key runs from the next key, one released mid-key does not run', () => {
  const seen: string[] = [];
  let late: (() => void) | null = null;
  const releaseB = reg({ priority: 20, handle: () => void seen.push('b') });
  reg({
    priority: 10,
    handle: () => {
      seen.push('a');
      releaseB();
      if (!late) late = reg({ priority: 15, handle: () => void seen.push('late') });
    },
  });
  press();
  expect(seen).toEqual(['a']);
  press();
  expect(seen).toEqual(['a', 'a', 'late']);
});

test('the window listener goes on with the first handler and off with the last', () => {
  expect(_routerStateForTests()).toEqual({ handlers: 0, listening: [] });
  const r1 = reg({ priority: 10, handle: () => {} });
  const r2 = reg({ priority: 10, types: ['keydown', 'keyup', 'keypress'], handle: () => {} });
  expect(_routerStateForTests()).toEqual({ handlers: 2, listening: ['keydown', 'keypress', 'keyup'] });
  r2();
  expect(_routerStateForTests()).toEqual({ handlers: 1, listening: ['keydown'] });
  r1();
  r1();
  expect(_routerStateForTests()).toEqual({ handlers: 0, listening: [] });
});

test('the priority table is in the order the surfaces need', () => {
  const order = [
    KEY_PRIORITY.TOOLTIP_ESC,
    KEY_PRIORITY.GLOBAL_ESC_AND_SHORTCUT,
    KEY_PRIORITY.SCROLL_LOCK,
    KEY_PRIORITY.ENLARGED_ISOLATION,
    KEY_PRIORITY.ADDMODE_ISOLATION,
    KEY_PRIORITY.SIDEBAR_ISOLATION,
    KEY_PRIORITY.PLACING_ISOLATION,
  ];
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(new Set(order).size).toBe(order.length);
});
