'use strict';

// Covers REQUIREMENTS §1.1's persistence guarantees: the sidebar (and its
// thumbnail list) survives a full page reload without any user action, and
// survives SPA-style navigation while showing only the current normalised
// URL's items (§1.5). Also covers edge case §6 #10 (same URL revisited later)
// and that item numbering stays global/sequential across pages of one domain.

const { test, expect } = require('@playwright/test');
const helper = require('./helpers/extension');

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

async function openPageWithSidebar(pg) {
  await pg.goto(fileServer.baseUrl);
  await helper.activateExtension(context, pg);
}

test('a full page reload re-opens the sidebar automatically and keeps its items', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'survives reload', expectedCount: 1 });

  await page.reload();

  // No icon click, no activateExtension call — background.ts's re-injection
  // (chrome.storage.session-backed, §1.1) must bring the sidebar back on its
  // own.
  await page.locator(helper.SELECTORS.sidebar).waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(helper.SELECTORS.thumbnail).first().waitFor({ state: 'visible', timeout: 10000 });
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('survives reload');
});

test('closing the sidebar before reload means it stays closed after reload', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await page.locator(helper.SELECTORS.btnClose).click();
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeHidden();

  await page.reload();
  await page.waitForTimeout(1500); // give any (incorrect) re-injection a chance to appear

  await expect(page.locator(helper.SELECTORS.sidebarHost)).toHaveCount(0);
});

test('SPA navigation keeps the sidebar open and filters thumbnails to the current URL', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'page one item', expectedCount: 1 });

  await page.locator('#goto-page-two').click();
  await expect(page).toHaveURL(/\/page-two$/);

  // Sidebar itself persists across the SPA route change (§1.1) ...
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeVisible();
  // ... but its thumbnail list is scoped to the new (empty) URL (§1.5).
  await expect(page.locator(helper.SELECTORS.emptyState)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(0);

  // Capturing here continues the domain's global sequential numbering (§1.2).
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'page two item', expectedCount: 1 });
  await expect(page.locator(helper.SELECTORS.thumbnailBadge)).toHaveText('2');

  await page.locator('#goto-page-one').click();
  await expect(page).toHaveURL(/\/$/);

  // Back on the original URL, its own item (and only its own item) reappears.
  await page.locator(helper.SELECTORS.thumbnail).first().waitFor({ state: 'visible', timeout: 10000 });
  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(1);
  await expect(page.locator(helper.SELECTORS.thumbnailBadge)).toHaveText('1');
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('page one item');
});

test('revisiting a URL in a later "session" (fresh navigation) reloads its stored items', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'still here later', expectedCount: 1 });

  // Navigate away (SPA) and back, simulating the user returning to this page
  // later in the same browsing session (§6 #10).
  await page.locator('#goto-page-two').click();
  await expect(page.locator(helper.SELECTORS.emptyState)).toBeVisible();
  await page.locator('#goto-page-one').click();

  await page.locator(helper.SELECTORS.thumbnail).first().waitFor({ state: 'visible', timeout: 10000 });
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('still here later');
});
