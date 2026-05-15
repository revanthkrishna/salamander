'use strict';

const { test, expect } = require('@playwright/test');
const {
  SELECTORS,
  startFileServer,
  launchWithExtension,
  activateExtension,
  clearExtensionStorage,
  enterAnnotationMode,
  createAnnotation,
} = require('./helpers/extension');

let fileServer;
let context;
let fixtureUrl;

test.beforeAll(async () => {
  fileServer = await startFileServer();
  fixtureUrl = `${fileServer.baseUrl}/test-page.html`;
  context = await launchWithExtension();
});

test.afterAll(async () => {
  await context.close();
  await fileServer.stop();
});

test.beforeEach(async () => {
  await clearExtensionStorage(context);
});

test('toolbar reappears automatically after page reload with no icon click needed', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    // Create annotation (also sets activeTab key in storage)
    await createAnnotation(page, '#main-heading', 'Persistence test annotation');

    // Exit annotation mode
    await page.locator(SELECTORS.btnExit).click();
    await page.waitForTimeout(100);

    // Reload the page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Wait for toolbar to reappear (background.js tabs.onUpdated fires)
    await page.waitForSelector('#annotator-host', { state: 'attached', timeout: 10000 });

    // Toolbar should be visible — no additional click needed
    await expect(page.locator('#annotator-host')).toBeAttached();
  } finally {
    await page.close();
  }
});

test('annotations are visible after reload when entering annotation mode', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Should survive reload');
    await createAnnotation(page, '#intro-para', 'Also survives reload');

    await page.locator(SELECTORS.btnExit).click();
    await page.waitForTimeout(100);

    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Wait for toolbar to reappear
    await page.waitForSelector('#annotator-host', { state: 'attached', timeout: 10000 });

    // Enter annotation mode
    await page.locator(SELECTORS.btnStart).click();
    await page.waitForTimeout(300);

    // Both pins should be visible
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
    await expect(page.locator(SELECTORS.pinByNumber(2))).toBeVisible();
  } finally {
    await page.close();
  }
});
