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

test('gaps from deletions are not backfilled — pin after deletion of #2 is #4', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    // Create pins 1, 2, 3
    await createAnnotation(page, '#main-heading', 'Pin 1');
    await createAnnotation(page, '#intro-para', 'Pin 2');
    await createAnnotation(page, '#section-1', 'Pin 3');

    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
    await expect(page.locator(SELECTORS.pinByNumber(2))).toBeVisible();
    await expect(page.locator(SELECTORS.pinByNumber(3))).toBeVisible();

    // Delete pin 2 via popover
    await page.locator(SELECTORS.pinByNumber(2)).click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });
    await page.locator(SELECTORS.deleteBtn).click();
    await page.waitForTimeout(100);
    await page.locator(SELECTORS.confirmDeleteBtn).click();
    await page.waitForTimeout(300);

    // Pin 2 should be gone
    await expect(page.locator(SELECTORS.pinByNumber(2))).not.toBeAttached();

    // Create new annotation — should be pin 4 (not 2)
    await createAnnotation(page, '#section-2', 'New annotation after gap');

    // Pin 4 should exist
    await expect(page.locator(SELECTORS.pinByNumber(4))).toBeVisible();
    // Pin 2 should still not exist
    await expect(page.locator(SELECTORS.pinByNumber(2))).not.toBeAttached();
  } finally {
    await page.close();
  }
});
