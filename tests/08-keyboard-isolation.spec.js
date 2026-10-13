'use strict';

// Keys and a hostile page (REQUIREMENTS NF-ISO-1, NF-A11Y-2, FR-AM-8): a
// page whose shortcut library listens on `document` and cancels Enter and
// Space. Keys pressed in the sidebar never reach it, so its buttons still
// work from the keyboard; and while add mode is placing a box, the page
// sees no key at all.

const { test, expect } = require('@playwright/test');
const helper = require('./helpers/extension');

const S = helper.SELECTORS;
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

/** The page's own shortcut handler: logs every key it hears and cancels
 *  Enter and Space, as shortcut libraries do. */
async function hostilePage() {
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
  await page.evaluate(() => {
    window.__pageSaw = [];
    for (const type of ['keydown', 'keyup', 'keypress']) {
      document.addEventListener(type, (e) => {
        window.__pageSaw.push(`${e.type}:${e.key}`);
        if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
      });
    }
  });
  return page;
}
const pageSaw = (page) => page.evaluate(() => window.__pageSaw.slice());

test('Enter and Space work on the sidebar\'s buttons, and the page hears none of it', async () => {
  const page = await hostilePage();
  await page.locator(S.btnMenu).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(S.actionMenu)).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.locator(S.actionMenu)).toHaveAttribute('data-open', 'false');

  await page.locator(S.btnAdd).focus();
  await page.keyboard.press(' ');
  await page.locator(S.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await expect(page.locator(S.addGroup)).toHaveClass(/is-on/);
  // Space again turns it off, from the same focused button.
  await page.keyboard.press(' ');
  await expect(page.locator(S.addGroup)).not.toHaveClass(/is-on/);

  expect(await pageSaw(page)).toEqual([]);
});

test('Option/Alt+N still adds a note with focus in the sidebar', async () => {
  const page = await hostilePage();
  await page.locator(S.btnExport).focus();
  await page.keyboard.press('Alt+KeyN');
  await page.locator(S.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  await expect(page.locator(S.addGroup)).toHaveClass(/is-on/);
});

test('keys pressed on the page itself still reach it while the sidebar is open', async () => {
  const page = await hostilePage();
  await page.mouse.click(200, 300);
  await page.keyboard.press('j');
  expect(await pageSaw(page)).toEqual(['keydown:j', 'keypress:j', 'keyup:j']);
});

test('while add mode is placing a box the page hears no key; Space still scrolls; Esc still exits', async () => {
  const page = await hostilePage();
  await page.mouse.click(200, 300); // focus on the page, not the sidebar
  await page.keyboard.press('Alt+KeyN');
  await page.locator(S.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
  // The Alt keydown itself came before add mode began: the page heard that.
  await page.evaluate(() => {
    window.__pageSaw = [];
  });
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(' ');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  expect(await pageSaw(page)).toEqual([]);

  await page.keyboard.press('Escape');
  await page.locator(S.addModeHost).waitFor({ state: 'detached', timeout: 5000 });
  await expect(page.locator(S.addGroup)).not.toHaveClass(/is-on/);
  // Add mode is over: the page hears keys again.
  await page.keyboard.press('j');
  expect(await pageSaw(page)).toContain('keydown:j');
});

test('typing a note still never reaches the page (the comment box, as before)', async () => {
  const page = await hostilePage();
  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 150, 200);
  await page.locator(S.noteInput).focus();
  await page.keyboard.type('a note ok');
  await expect(page.locator(S.noteInput)).toHaveValue('a note ok');
  expect((await pageSaw(page)).filter((k) => !k.endsWith(':Escape'))).toEqual([]);
});
