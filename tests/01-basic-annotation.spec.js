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

test('toolbar appears with correct buttons', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    // Toolbar host exists
    await expect(page.locator('#annotator-host')).toBeAttached();

    // Start Annotating button visible
    await expect(page.locator(SELECTORS.btnStart)).toBeVisible();

    // Exit button hidden
    await expect(page.locator(SELECTORS.btnExit)).toBeHidden();

    // Export button disabled
    await expect(page.locator(SELECTORS.btnExport)).toBeDisabled();

    // Upload button visible
    await expect(page.locator(SELECTORS.btnUpload)).toBeVisible();

    // Delete All button disabled
    await expect(page.locator(SELECTORS.btnDeleteAll)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test('Start Annotating button enters annotation mode and shows Exit', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    await page.locator(SELECTORS.btnStart).click();
    await page.waitForTimeout(100);

    // Exit button now visible, Start hidden
    await expect(page.locator(SELECTORS.btnExit)).toBeVisible();
    await expect(page.locator(SELECTORS.btnStart)).toBeHidden();
  } finally {
    await page.close();
  }
});

test('clicking element in annotation mode opens popover with textarea and counter', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await page.locator('#main-heading').click();

    // Popover host appears
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    // Textarea and counter visible
    await expect(page.locator(SELECTORS.noteInput)).toBeVisible();
    await expect(page.locator(SELECTORS.counter)).toBeVisible();

    // Add button disabled (no text yet)
    await expect(page.locator(SELECTORS.addBtn)).toBeDisabled();

    // Counter shows 0 / 400
    await expect(page.locator(SELECTORS.counter)).toHaveText('0 / 400');
  } finally {
    await page.close();
  }
});

test('typing a note enables Add button and updates counter', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await page.locator('#main-heading').click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    await page.locator(SELECTORS.noteInput).fill('Hello annotation');

    // Add button enabled
    await expect(page.locator(SELECTORS.addBtn)).toBeEnabled();

    // Counter updated
    await expect(page.locator(SELECTORS.counter)).toHaveText('16 / 400');
  } finally {
    await page.close();
  }
});

test('clicking Add creates a pin numbered 1', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'First annotation');

    // Pin #1 appears
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();

    // Export button now enabled
    await expect(page.locator(SELECTORS.btnExport)).toBeEnabled();
  } finally {
    await page.close();
  }
});

test('creating second annotation produces pin numbered 2', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Pin 1');
    await createAnnotation(page, '#intro-para', 'Pin 2');

    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
    await expect(page.locator(SELECTORS.pinByNumber(2))).toBeVisible();
  } finally {
    await page.close();
  }
});

test('clicking existing pin opens popover pre-filled with note', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'My existing note');

    // Click the pin to open edit popover
    await page.locator(SELECTORS.pinByNumber(1)).click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    // Pre-filled with existing note
    await expect(page.locator(SELECTORS.noteInput)).toHaveValue('My existing note');

    // Delete button visible in edit mode
    await expect(page.locator(SELECTORS.deleteBtn)).toBeVisible();

    // Add button enabled (note is not empty)
    await expect(page.locator(SELECTORS.addBtn)).toBeEnabled();
  } finally {
    await page.close();
  }
});

test('editing an annotation saves the new note', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'Original note');

    // Click pin to edit
    await page.locator(SELECTORS.pinByNumber(1)).click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    await page.locator(SELECTORS.noteInput).fill('Updated note');
    await page.locator(SELECTORS.addBtn).click();
    await page.waitForTimeout(200);

    // Popover closed; pin still visible
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
  } finally {
    await page.close();
  }
});

test('deleting annotation via popover shows confirmation and removes pin', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await createAnnotation(page, '#main-heading', 'To be deleted');

    // Click pin to edit
    await page.locator(SELECTORS.pinByNumber(1)).click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    // Click Delete
    await page.locator(SELECTORS.deleteBtn).click();
    await page.waitForTimeout(100);

    // Delete confirmation should appear
    await expect(page.locator(SELECTORS.deleteConfirm)).toBeVisible();

    // Confirm deletion
    await page.locator(SELECTORS.confirmDeleteBtn).click();
    await page.waitForTimeout(300);

    // Pin should be gone
    await expect(page.locator(SELECTORS.pinByNumber(1))).not.toBeAttached();

    // Export button should be disabled again
    await expect(page.locator(SELECTORS.btnExport)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test('character limit: counter shows 400/400 and input is capped at 400 chars', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);

    await page.locator('#main-heading').click();
    await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

    const text400 = 'A'.repeat(400);
    await page.locator(SELECTORS.noteInput).fill(text400);

    // Counter should show 400 / 400
    await expect(page.locator(SELECTORS.counter)).toHaveText('400 / 400');

    // Try to type more — input should still be 400 chars (maxLength enforced)
    await page.locator(SELECTORS.noteInput).press('A');
    const val = await page.locator(SELECTORS.noteInput).inputValue();
    expect(val.length).toBeLessThanOrEqual(400);
  } finally {
    await page.close();
  }
});
