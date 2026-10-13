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
