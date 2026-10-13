// src/sidebarWidth.ts: the width store the panel, the page shrink and add
// mode all read. Its panel-facing behaviour (drag, keys, persistence) is
// covered through the sidebar in sidebar.test.ts; this pins the store.

import {
  clampSidebarWidth,
  getSidebarWidth,
  loadPersistedWidth,
  resetSidebarWidth,
  setSidebarWidth,
  subscribeSidebarWidth,
} from '../sidebarWidth';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../sidebarMetrics';

afterEach(() => {
  resetSidebarWidth();
});

function storageAnswers(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test('starts at the default, and clamps to the range (non-finite falls back to the default)', () => {
  expect(getSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(clampSidebarWidth(250.4)).toBe(250);
});

test('subscribers hear every set, with whether it changed; unsubscribing stops that', () => {
  const heard: Array<[number, boolean]> = [];
  const unsubscribe = subscribeSidebarWidth((w, changed) => heard.push([w, changed]));
  setSidebarWidth(250);
  setSidebarWidth(250);
  unsubscribe();
  setSidebarWidth(260);
  expect(heard).toEqual([
    [250, true],
    [250, false],
  ]);
  expect(getSidebarWidth()).toBe(260);
});

test('persists only when asked, once per gesture', () => {
  (chrome.storage.local.set as jest.Mock).mockClear();
  setSidebarWidth(240);
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  setSidebarWidth(240, { persist: true });
  expect(chrome.storage.local.set).toHaveBeenCalledWith({ sidebarWidth: 240 }, expect.any(Function));
});

test('a persisted width is applied, unless the user has picked one since', async () => {
  await new Promise<void>((resolve) => chrome.storage.local.set({ sidebarWidth: 230 }, resolve));
  loadPersistedWidth();
  await storageAnswers();
  expect(getSidebarWidth()).toBe(230);

  resetSidebarWidth();
  loadPersistedWidth();
  setSidebarWidth(270, { persist: true });
  await storageAnswers();
  expect(getSidebarWidth()).toBe(270);
});

test('reset puts the default back without telling anyone', () => {
  setSidebarWidth(220);
  const heard = jest.fn();
  const unsubscribe = subscribeSidebarWidth(heard);
  resetSidebarWidth();
  unsubscribe();
  expect(getSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(heard).not.toHaveBeenCalled();
});
