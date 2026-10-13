'use strict';

// Option+N (macOS) / Alt+N adds one note while the sidebar is open
// (REQUIREMENTS FR-AM-2a, src/shortcut.ts): like a single click on add note,
// never the kept-on switch; nothing while typing, while a note is being
// placed or while the enlarged view is open; add note's tooltip names it as a
// keycap.

const { test, expect } = require('@playwright/test');
const helper = require('./helpers/extension');

const { SELECTORS } = helper;
let fileServer;
let context;

test.beforeAll(async () => {
  fileServer = await helper.startFileServer();
});

test.afterAll(async () => {
  await helper.stopFileServer();
});

test.beforeEach(async () => {
  context = await helper.launchWithExtension();
});

test.afterEach(async () => {
  await context.close();
});

async function openPageWithSidebar() {
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
  return page;
}

test('Alt+N adds one note: add mode for a single capture, then back to off', async () => {
  const page = await openPageWithSidebar();
  await page.mouse.click(200, 300); // focus the page, not a field
  await page.keyboard.press('Alt+KeyN');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await expect(page.locator(SELECTORS.addGroup)).toHaveClass(/is-on/);
  await expect(page.locator(SELECTORS.addGroup)).not.toHaveClass(/is-switch-on/);

  await helper.placeSelectionBox(page, 150, 200);
  await helper.typeAddModeNote(page, 'added from the keyboard');
  await helper.clickAddModeSave(page);
  await expect(page.locator(SELECTORS.thumbnail)).toHaveCount(1, { timeout: 15000 });
  // One note only: add mode is over, not re-entered.
  await expect(page.locator(SELECTORS.addGroup)).not.toHaveClass(/is-on/);
});

test('Alt+N does nothing while typing in the page or while a note is being placed', async () => {
  const page = await openPageWithSidebar();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'typing-here';
    document.body.prepend(input);
  });
  await page.locator('#typing-here').focus();
  await page.keyboard.press('Alt+KeyN');
  await page.waitForTimeout(300);
  await expect(page.locator(SELECTORS.addModeHost)).toHaveCount(0);

  await page.locator('#typing-here').blur();
  await helper.enterAddMode(page);
  await page.keyboard.press('Alt+KeyN');
  await page.waitForTimeout(300);
  await expect(page.locator(SELECTORS.addGroup)).toHaveClass(/is-on/);
  await expect(page.locator(SELECTORS.addGroup)).not.toHaveClass(/is-switch-on/);
});

test('Alt+N does nothing while the enlarged view is open', async () => {
  const page = await openPageWithSidebar();
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'first', expectedCount: 1 });
  await helper.openThumbnail(page, 0);
  await page.locator(SELECTORS.enlargedExit).focus();
  await page.keyboard.press('Alt+KeyN');
  await page.waitForTimeout(300);
  await expect(page.locator(SELECTORS.enlargedOpen)).toHaveCount(1);
  await expect(page.locator(SELECTORS.addModeHost)).toHaveCount(0);
});

test("add note's tooltip shows the shortcut as a keycap", async () => {
  const page = await openPageWithSidebar();
  await page.locator(SELECTORS.btnAdd).hover();
  const cap = page.locator('#annotator-sidebar-host .sal-tip[data-open="true"] kbd.sal-tip-key');
  await expect(cap).toHaveText(/^(⌥N|Alt\+N)$/, { timeout: 3000 });
});
