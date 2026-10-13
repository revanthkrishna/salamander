'use strict';

// Covers REQUIREMENTS §1.6 / FR-EV-* — thumbnails and the enlarged view 2.0
// (design spec §AH): the sidebar expanding into one scrolling page of every
// note on the site. Opening focuses the clicked note with the notes before
// it peeking at the top; every note is editable and autosaves on its own;
// pages are renamed in place; delete is immediate; an emptied note holds the
// view open; Esc collapses.

const { test, expect } = require('@playwright/test');
const { unzipSync, strFromU8 } = require('fflate');
const fs = require('fs');
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

async function openPageWithSidebar(page) {
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
}

/** Two pages with notes: two on page one ("Annotator Test Page"), then —
 *  via the fixture's SPA navigation — two on page two ("Test Page Two"),
 *  which is left on screen. */
async function twoPagesWithNotes(page) {
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'page one first', expectedCount: 1 });
  await helper.captureFeedbackItem(page, { x: 450, y: 200, note: 'page one second', expectedCount: 2 });
  await page.locator('#goto-page-two').click();
  await expect(page).toHaveURL(/\/page-two$/);
  await expect(page.locator(S.emptyState)).toBeVisible();
  await helper.captureFeedbackItem(page, { x: 150, y: 260, note: 'page two first', expectedCount: 1 });
  await helper.captureFeedbackItem(page, { x: 450, y: 260, note: 'page two second', expectedCount: 2 });
}

/** The open view's notes' texts, in reading order. */
async function noteTexts(page) {
  return page.locator(S.enlargedNoteInput).evaluateAll((els) => els.map((el) => el.value));
}

test('clicking a thumbnail expands the sidebar into the enlarged view, its note focused', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'original note', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await expect(page.locator(S.enlargedNoteInput)).toHaveValue('original note');
  await expect(page.locator(S.enlargedNoteInput)).toBeFocused();
  await expect(page.locator(S.enlargedNoteNumber)).toHaveText('#1');
  await expect(page.locator(S.enlargedImage)).toBeVisible();
  // The page's heading: its HTML title, its address, and "this page".
  await expect(page.locator(S.pageName)).toHaveText('Annotator Test Page');
  await expect(page.locator(S.pageUrl)).toHaveText(new URL(fileServer.baseUrl).host);
  await expect(page.locator(S.pageHere)).toHaveText('this page');
  // The old rail and carousel are gone.
  await expect(page.locator('#annotator-sidebar-host .xp-rail, #annotator-sidebar-host .xp-card')).toHaveCount(0);
});

test('the whole site in one view: open from the second page, previous notes peek at the top', async () => {
  const page = await context.newPage();
  await twoPagesWithNotes(page);

  // The list shows this page only...
  await expect(page.locator(S.thumbnail)).toHaveCount(2);
  // A short window, so the four notes do not all fit and there is
  // something to peek at.
  await page.setViewportSize({ width: 1280, height: 520 });
  await helper.openThumbnail(page, 0);
  // ...the view shows both, the page noted on first first.
  await expect(page.locator(S.pageName)).toHaveText(['Annotator Test Page', 'Test Page Two']);
  expect(await noteTexts(page)).toEqual(['page one first', 'page one second', 'page two first', 'page two second']);
  await expect(page.locator(S.enlargedNoteNumber)).toHaveText(['#1', '#2', '#1', '#2']);
  await expect(page.locator(S.pageHere)).toHaveCount(1);
  await expect(page.locator(S.pageHeading).nth(1).locator('.xp-page-here')).toHaveCount(1);

  // The clicked note (page two's first) is focused...
  await expect(page.locator(S.enlargedNoteInput).nth(2)).toBeFocused();
  // ...and page one's notes peek above it: scrolled, with their bottom
  // edge just inside the top of the scroller.
  const scroller = page.locator(S.enlargedScroll);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const top = (await scroller.boundingBox()).y;
  const peek = await page.locator(S.enlargedNoteInput).nth(0).boundingBox();
  expect(peek.y).toBeLessThan(top);
  expect(peek.y + peek.height).toBeGreaterThan(top + 40);
  expect(peek.y + peek.height).toBeLessThan(top + 120);
});

test('editing two notes at once: each autosaves, and both are there after a collapse', async () => {
  const page = await context.newPage();
  await twoPagesWithNotes(page);

  await helper.openThumbnail(page, 1);
  await helper.editNoteAndBlur(page, 'edited on page one', 0);
  await helper.editNoteAndBlur(page, 'edited on page two', 3);
  await expect(page.locator(S.enlargedOpen)).toHaveCount(1); // still open
  await page.locator(S.enlargedExit).click();
  await page.locator(S.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  await expect(page.locator(S.thumbnailNote).nth(1)).toHaveText('edited on page two');

  await helper.openThumbnail(page, 0);
  expect(await noteTexts(page)).toEqual(['edited on page one', 'page one second', 'page two first', 'edited on page two']);
});

test('editing a note and collapsing autosaves, and the list reflects the new note', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'before edit', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await helper.editNoteAndClose(page, 'edited via close');
  await expect(page.locator(S.thumbnailNote)).toHaveText('edited via close');

  // Persisted, not just an in-memory repaint — reopening shows the same text.
  await helper.openThumbnail(page, 0);
  await expect(page.locator(S.enlargedNoteInput)).toHaveValue('edited via close');
});

test('renaming a page: saved per page, kept across opens, Esc cancels, empty restores the title', async () => {
  const page = await context.newPage();
  await twoPagesWithNotes(page);
  await helper.openThumbnail(page, 0);

  const first = page.locator(S.pageHeading).nth(0);
  await first.locator('.xp-page-edit').click();
  const input = first.locator('.xp-page-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Annotator Test Page');
  await input.fill('the home page');
  await input.press('Enter');
  await expect(first.locator('.xp-page-name')).toHaveText('the home page');

  // Esc cancels a rename and leaves the view open.
  await first.locator('.xp-page-edit').click();
  await first.locator('.xp-page-input').fill('never mind');
  await page.keyboard.press('Escape');
  await expect(first.locator('.xp-page-name')).toHaveText('the home page');
  await expect(page.locator(S.enlargedOpen)).toHaveCount(1);

  // Stored: closing and reopening keeps it.
  await page.keyboard.press('Escape');
  await page.locator(S.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  await helper.openThumbnail(page, 0);
  await expect(page.locator(S.pageName)).toHaveText(['the home page', 'Test Page Two']);

  // The export writes it as the page's title.
  await page.keyboard.press('Escape');
  await page.locator(S.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  const download = await helper.exportAndGetDownload(context, page);
  const md = strFromU8(unzipSync(fs.readFileSync(await download.path()))['feedback.md']);
  expect(md.match(/"page_title": "[^"]*"/g)).toEqual([
    '"page_title": "the home page"',
    '"page_title": "the home page"',
    '"page_title": "Test Page Two"',
    '"page_title": "Test Page Two"',
  ]);

  // An empty name gives the page its title back.
  await helper.openThumbnail(page, 0);
  await page.locator(S.pageHeading).nth(0).locator('.xp-page-edit').click();
  await page.locator(S.pageHeading).nth(0).locator('.xp-page-input').fill('   ');
  await page.keyboard.press('Enter');
  await expect(page.locator(S.pageName).nth(0)).toHaveText('Annotator Test Page');
});

test('an emptied note cannot be left and is never saved empty', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'keep me', expectedCount: 1 });
  await helper.captureFeedbackItem(page, { x: 450, y: 200, note: 'other', expectedCount: 2 });

  await helper.openThumbnail(page, 1);
  await page.locator(S.enlargedNoteInput).nth(0).fill('   ');
  // Said at once, under the note.
  await expect(page.locator(S.enlargedStatus).nth(0)).toHaveText('note required');
  await page.locator(S.enlargedNoteInput).nth(1).focus();
  await page.keyboard.press('Escape');

  // Still open, focus moved to the empty note.
  await expect(page.locator(S.enlargedOpen)).toHaveCount(1);
  await expect(page.locator(S.enlargedNoteInput).nth(0)).toBeFocused();
  await expect(page.locator(S.enlargedStatus).nth(0)).toHaveAttribute('data-kind', 'empty-error');

  // Typing text clears the block; collapsing then works and the new text is kept.
  await page.locator(S.enlargedNoteInput).nth(0).fill('replacement');
  await page.locator(S.enlargedExit).click();
  await page.locator(S.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  await expect(page.locator(S.thumbnailNote).nth(0)).toHaveText('replacement');
});

test('Esc collapses the enlarged view', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'esc test', expectedCount: 1 });

  await helper.openThumbnail(page, 0);
  await page.keyboard.press('Escape');
  await page.locator(S.enlarged).waitFor({ state: 'detached', timeout: 5000 });
});

test('delete is immediate: the rest renumber; the site\'s last note collapses to the empty list', async () => {
  const page = await context.newPage();
  await twoPagesWithNotes(page);

  let dialogFired = false;
  page.on('dialog', () => {
    dialogFired = true;
  });

  await helper.openThumbnail(page, 0);
  await helper.deleteCurrentNote(page, { expectCollapse: false, index: 2 });
  await expect(page.locator(S.enlargedNote)).toHaveCount(3);
  await expect(page.locator(S.enlargedNoteNumber)).toHaveText(['#1', '#2', '#1']);
  expect(await noteTexts(page)).toEqual(['page one first', 'page one second', 'page two second']);

  // Page one's last note takes its heading with it.
  await helper.deleteCurrentNote(page, { expectCollapse: false, index: 0 });
  await helper.deleteCurrentNote(page, { expectCollapse: false, index: 0 });
  await expect(page.locator(S.pageHeading)).toHaveCount(1);
  await expect(page.locator(S.pageName)).toHaveText('Test Page Two');

  await helper.deleteCurrentNote(page, { expectCollapse: true, index: 0 });
  expect(dialogFired).toBe(false);
  await expect(page.locator(S.thumbnail)).toHaveCount(0);
  await expect(page.locator(S.emptyState)).toBeVisible();
});
