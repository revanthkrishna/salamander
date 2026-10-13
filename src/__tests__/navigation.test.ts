// src/navigation.ts: SPA navigation detection and its restore().

import { debounce, watchNavigation } from '../navigation';

const startUrl = location.href;

afterEach(() => {
  jest.useRealTimers();
  history.replaceState(null, '', startUrl);
});

test('pushState, replaceState, popstate and hashchange each report, debounced into one call per burst', () => {
  jest.useFakeTimers();
  const onChange = jest.fn();
  const watch = watchNavigation(onChange);
  history.pushState({}, '', '/a');
  history.replaceState({}, '', '/b');
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  jest.advanceTimersByTime(49);
  expect(onChange).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(location.pathname).toBe('/b');
  watch.restore();
});

test('restore puts the page\'s own history methods back, removes the listeners and drops a pending call', () => {
  jest.useFakeTimers();
  const push = history.pushState;
  const replace = history.replaceState;
  const onChange = jest.fn();
  const watch = watchNavigation(onChange);
  expect(history.pushState).not.toBe(push);
  history.pushState({}, '', '/pending');
  watch.restore();
  expect(history.pushState).toBe(push);
  expect(history.replaceState).toBe(replace);
  history.pushState({}, '', '/after');
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  jest.advanceTimersByTime(100);
  expect(onChange).not.toHaveBeenCalled();
});

test('a wrapper the page added after ours is kept; ours inside it stops reporting', () => {
  jest.useFakeTimers();
  const push = history.pushState;
  const onChange = jest.fn();
  const watch = watchNavigation(onChange);
  const ours = history.pushState;
  const pageWrapper = function (this: History, ...args: Parameters<History['pushState']>) {
    return ours.apply(this, args);
  };
  history.pushState = pageWrapper;
  watch.restore();
  expect(history.pushState).toBe(pageWrapper);
  history.pushState({}, '', '/still-works');
  jest.advanceTimersByTime(100);
  expect(location.pathname).toBe('/still-works');
  expect(onChange).not.toHaveBeenCalled();
  history.pushState = push;
});

test('debounce: one call after the last of a burst, with its arguments; cancel drops it', () => {
  jest.useFakeTimers();
  const fn = jest.fn();
  const d = debounce(fn, 50);
  d(1);
  d(2);
  jest.advanceTimersByTime(50);
  expect(fn.mock.calls).toEqual([[2]]);
  d(3);
  d.cancel();
  jest.advanceTimersByTime(50);
  expect(fn).toHaveBeenCalledTimes(1);
});
