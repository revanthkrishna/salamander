// src/notifications.ts: the sidebar's banner on its own (sidebar.test.ts
// covers it in place).

import { Notifications } from '../notifications';

afterEach(() => {
  jest.useRealTimers();
});

function parts(n: Notifications) {
  return {
    text: n.el.querySelector('.notif-text') as HTMLElement,
    bar: n.el.querySelector('.notif-progress') as HTMLElement,
  };
}

test('starts hidden, a live region', () => {
  const n = new Notifications();
  expect(n.el.hidden).toBe(true);
  expect(n.el.getAttribute('role')).toBe('alert');
  expect(parts(n).bar.hidden).toBe(true);
});

test('an error shows verbatim with its countdown, and clears itself after 8s', () => {
  jest.useFakeTimers();
  const n = new Notifications();
  n.showError("couldn't save note. try again.");
  expect(n.el.hidden).toBe(false);
  expect(n.el.classList.contains('warning')).toBe(false);
  expect(parts(n).text.textContent).toBe("couldn't save note. try again.");
  expect(parts(n).bar.hidden).toBe(false);
  expect(parts(n).bar.style.transition).toBe('transform 8000ms linear');
  jest.advanceTimersByTime(7999);
  expect(n.el.hidden).toBe(false);
  jest.advanceTimersByTime(1);
  expect(n.el.hidden).toBe(true);
  expect(parts(n).text.textContent).toBe('');
  expect(parts(n).bar.hidden).toBe(true);
});

test('a warning is marked as one; a new message restarts the 8s', () => {
  jest.useFakeTimers();
  const n = new Notifications();
  n.showWarning('finish or cancel your note first.');
  expect(n.el.classList.contains('warning')).toBe(true);
  jest.advanceTimersByTime(5000);
  n.showError('x');
  expect(n.el.classList.contains('warning')).toBe(false);
  jest.advanceTimersByTime(5000);
  expect(n.el.hidden).toBe(false);
  jest.advanceTimersByTime(3000);
  expect(n.el.hidden).toBe(true);
});

test('clear hides at once and cancels the auto-clear', () => {
  jest.useFakeTimers();
  const n = new Notifications();
  n.showError('x');
  n.clear();
  expect(n.el.hidden).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
