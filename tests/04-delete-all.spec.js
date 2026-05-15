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

test('Delete All button is disabled when no annotations exist', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await expect(page.locator(SELECTORS.btnDeleteAll)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test('Delete All button is enabled after creating annotations', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);
    await createAnnotation(page, '#main-heading', 'Annotation for delete all test');

    await expect(page.locator(SELECTORS.btnDeleteAll)).toBeEnabled();
  } finally {
    await page.close();
  }
});

test('Delete All shows confirmation dialog with correct count', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Pin 1');
    await createAnnotation(page, '#intro-para', 'Pin 2');
    await createAnnotation(page, '#section-1', 'Pin 3');

    let dialogMessage = null;
    page.once('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss(); // cancel
    });

    await page.locator(SELECTORS.btnDeleteAll).click();
    await page.waitForTimeout(300);

    expect(dialogMessage).toBeTruthy();
    // Should mention "3 annotations"
    expect(dialogMessage).toContain('3');
    expect(dialogMessage.toLowerCase()).toContain('annotation');
  } finally {
    await page.close();
  }
});

test('confirming Delete All removes all pins and resets toolbar', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Pin 1');
    await createAnnotation(page, '#intro-para', 'Pin 2');

    // Confirm the deletion
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.locator(SELECTORS.btnDeleteAll).click();
    await page.waitForTimeout(500);

    // All pins removed
    await expect(page.locator(SELECTORS.pin)).toHaveCount(0);

    // Export and Delete All should be disabled
    await expect(page.locator(SELECTORS.btnExport)).toBeDisabled();
    await expect(page.locator(SELECTORS.btnDeleteAll)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test('cancelling Delete All leaves annotations intact', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Pin 1');
    await createAnnotation(page, '#intro-para', 'Pin 2');

    // Cancel the deletion
    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });

    await page.locator(SELECTORS.btnDeleteAll).click();
    await page.waitForTimeout(300);

    // Pins still present
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
    await expect(page.locator(SELECTORS.pinByNumber(2))).toBeVisible();

    // Buttons still enabled
    await expect(page.locator(SELECTORS.btnExport)).toBeEnabled();
    await expect(page.locator(SELECTORS.btnDeleteAll)).toBeEnabled();
  } finally {
    await page.close();
  }
});
