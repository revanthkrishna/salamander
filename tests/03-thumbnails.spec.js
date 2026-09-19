'use strict';

// Covers REQUIREMENTS §1.5 / §3.3 — thumbnails, the enlarged modal, note
// autosave on blur and on close, and immediate no-confirmation delete.

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

async function openPageWithSidebar(page) {
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
}

test('clicking a thumbnail opens the enlarged modal with the screenshot and note', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'original note', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await expect(page.locator(helper.SELECTORS.modalBackdrop)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.modalBadge)).toHaveText('feedback #1');
  await expect(page.locator(helper.SELECTORS.modalNoteInput)).toHaveValue('original note');
  await expect(page.locator(helper.SELECTORS.modalImage)).toBeVisible();
});

test('editing the note and blurring autosaves without closing the modal', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'before edit', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await helper.editModalNoteAndBlur(page, 'edited via blur');
  await expect(page.locator(helper.SELECTORS.modalHost)).toHaveCount(1); // still open
  await expect(page.locator(helper.SELECTORS.modalInlineError)).toBeHidden();
});

test('editing the note and closing autosaves, and the sidebar reflects the new note', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'before edit', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await helper.editModalNoteAndClose(page, 'edited via close');

  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('edited via close');

  // Persisted, not just an in-memory repaint — reopening shows the same text.
  await helper.openThumbnail(page, 0);
  await expect(page.locator(helper.SELECTORS.modalNoteInput)).toHaveValue('edited via close');
});

test('delete removes the item immediately, with no confirmation dialog', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'to be deleted', expectedCount: 1 });

  let dialogFired = false;
  page.on('dialog', () => { dialogFired = true; });

  await helper.openThumbnail(page, 0);
  await helper.deleteCurrentModalItem(page);

  expect(dialogFired).toBe(false);
  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(0);
  await expect(page.locator(helper.SELECTORS.emptyState)).toBeVisible();
});
