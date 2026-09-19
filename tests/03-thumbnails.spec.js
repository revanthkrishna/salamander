'use strict';

// Covers REQUIREMENTS §1.5 / §3.3 — thumbnails and the enlarged view (the
// sidebar expanding into a note viewer): autosave on blur and on collapse,
// prev/next navigation, the non-empty note rule, Esc, and immediate delete.

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

test('clicking a thumbnail expands the sidebar into the enlarged view', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'original note', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await expect(page.locator(helper.SELECTORS.enlargedTitle)).toHaveText('feedback #1');
  await expect(page.locator(helper.SELECTORS.enlargedCount)).toHaveText('1 / 1');
  await expect(page.locator(helper.SELECTORS.enlargedNoteInput)).toHaveValue('original note');
  await expect(page.locator(helper.SELECTORS.enlargedImage)).toBeVisible();
});

test('editing the note and blurring autosaves without collapsing', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'before edit', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await helper.editNoteAndBlur(page, 'edited via blur');
  await expect(page.locator(helper.SELECTORS.enlargedOpen)).toHaveCount(1); // still open
  await expect(page.locator(helper.SELECTORS.enlargedStatus)).not.toHaveAttribute('data-kind', 'save-error');
});

test('editing the note and collapsing autosaves, and the list reflects the new note', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'before edit', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await helper.editNoteAndClose(page, 'edited via close');

  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('edited via close');

  // Persisted, not just an in-memory repaint — reopening shows the same text.
  await helper.openThumbnail(page, 0);
  await expect(page.locator(helper.SELECTORS.enlargedNoteInput)).toHaveValue('edited via close');
});

test('next / previous move between notes and are disabled at the ends', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'first note', expectedCount: 1 });
  await helper.captureFeedbackItem(page, { x: 150, y: 420, note: 'second note', expectedCount: 2 });

  await helper.openThumbnail(page, 0);
  await expect(page.locator(helper.SELECTORS.enlargedPrev)).toHaveAttribute('aria-disabled', 'true');

  await page.locator(helper.SELECTORS.enlargedNext).click();
  await expect(page.locator(helper.SELECTORS.enlargedNoteInput)).toHaveValue('second note');
  await expect(page.locator(helper.SELECTORS.enlargedCount)).toHaveText('2 / 2');
  await expect(page.locator(helper.SELECTORS.enlargedNext)).toHaveAttribute('aria-disabled', 'true');

  await page.locator(helper.SELECTORS.enlargedPrev).click();
  await expect(page.locator(helper.SELECTORS.enlargedNoteInput)).toHaveValue('first note');
});

test('an emptied note cannot be left and is never saved empty', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'keep me', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await page.locator(helper.SELECTORS.enlargedNoteInput).fill('   ');
  await page.locator(helper.SELECTORS.enlargedExit).click();

  // Still open, with an inline error.
  await expect(page.locator(helper.SELECTORS.enlargedOpen)).toHaveCount(1);
  await expect(page.locator(helper.SELECTORS.enlargedStatus)).toHaveAttribute('data-kind', 'empty-error');

  // Typing text clears the block; collapsing then works and the new text is kept.
  await page.locator(helper.SELECTORS.enlargedNoteInput).fill('replacement');
  await page.locator(helper.SELECTORS.enlargedExit).click();
  await page.locator(helper.SELECTORS.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('replacement');
});

test('Esc collapses the enlarged view', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'esc test', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await page.keyboard.press('Escape');
  await page.locator(helper.SELECTORS.enlarged).waitFor({ state: 'detached', timeout: 5000 });
});

test('delete removes the item immediately, with no confirmation dialog', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'to be deleted', expectedCount: 1 });

  let dialogFired = false;
  page.on('dialog', () => { dialogFired = true; });

  await helper.openThumbnail(page, 0);
  await helper.deleteCurrentNote(page);

  expect(dialogFired).toBe(false);
  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(0);
  await expect(page.locator(helper.SELECTORS.emptyState)).toBeVisible();
});
