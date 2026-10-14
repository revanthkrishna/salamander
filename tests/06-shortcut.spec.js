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

// ── The Option/Alt+N tip (src/addNoteTip.ts) ─────────────────────────────────

const TIP = process.platform === 'darwin' ? 'tip: press ⌥N to add a note' : 'tip: press alt+n to add a note';
const HINT = 'click or drag to select';
const tooltip = '#annotator-addmode-host .preview-tooltip';

/** One single click on add note; the words the cursor's hint shows (the
 *  tip's answer and the start's count settle within the double-click
 *  window); then out again with Esc. */
async function clickStart(page) {
  await helper.enterAddMode(page);
  await page.mouse.move(200, 300);
  await page.mouse.move(220, 320, { steps: 3 });
  await page.waitForTimeout(600);
  const words = await page.locator(tooltip).textContent();
  await page.keyboard.press('Escape');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'detached', timeout: 5000 });
  return words;
}

/** The browser restarting, as far as the tip can tell: the session's count
 *  (chrome.storage.session) is gone; the install's state is not. */
async function newBrowserSession() {
  const sw = await helper.getServiceWorker(context);
  await sw.evaluate(() => chrome.storage.session.remove(['addNoteClicks', 'addNoteTipReserved']));
}

test('the third single click on add note in a session shows the tip in the hint\'s place, once', async () => {
  const page = await openPageWithSidebar();
  const words = [];
  for (let i = 0; i < 4; i++) words.push(await clickStart(page));
  expect(words).toEqual([HINT, HINT, TIP, HINT]);
});

test('the switch and a double-click do not count towards it', async () => {
  const page = await openPageWithSidebar();
  // A double-click turns the switch on: not a single click.
  await page.locator(SELECTORS.btnAdd).dblclick();
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'detached', timeout: 5000 });
  const words = [];
  for (let i = 0; i < 3; i++) words.push(await clickStart(page));
  expect(words).toEqual([HINT, HINT, TIP]);
});

test('at most three times per install, one a session', async () => {
  const page = await openPageWithSidebar();
  const thirds = [];
  for (let s = 0; s < 4; s++) {
    if (s > 0) await newBrowserSession();
    await clickStart(page);
    await clickStart(page);
    thirds.push(await clickStart(page));
  }
  expect(thirds).toEqual([TIP, TIP, TIP, HINT]);
});

test('a tip that never reached the screen does not use up a showing: the next single click shows it', async () => {
  const page = await openPageWithSidebar();
  await clickStart(page);
  await clickStart(page);
  // The third start: placed at once, the pointer never travelling over the
  // page, so the tip is never on screen.
  await page.locator(SELECTORS.btnAdd).click();
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(600);
  expect(await clickStart(page)).toBe(TIP);
  const sw = await helper.getServiceWorker(context);
  expect(await sw.evaluate(async () => (await chrome.storage.local.get('addNoteTip')).addNoteTip)).toEqual({ shown: 1, shortcutUsed: false });
});

test('never once Option/Alt+N has been used', async () => {
  const page = await openPageWithSidebar();
  await page.mouse.click(200, 300);
  await page.keyboard.press('Alt+KeyN');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForTimeout(300);
  const words = [];
  for (let i = 0; i < 3; i++) words.push(await clickStart(page));
  await newBrowserSession();
  for (let i = 0; i < 3; i++) words.push(await clickStart(page));
  expect(words).toEqual([HINT, HINT, HINT, HINT, HINT, HINT]);
});
