'use strict';

// Covers REQUIREMENTS §1.2 / §3.2 — add mode: default box placement, resize
// from any edge/corner via invisible hit zones (with the 20x20 minimum), the
// dimming scrim, the comment box's counter thresholds, cancel-discards
// semantics, and the capture pipeline producing a numbered thumbnail.
// Journey 1 steps 2-6. Styled per the Salamander design spec §3.2 ("ok" is
// now "save"; the v1 square handles are gone).

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

test('clicking add places a default box matching the sidebar thumbnail size (267x100 at the default sidebar width) with a comment box attached', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 150, 200);

  const box = await page.locator(helper.SELECTORS.box).boundingBox();
  expect(box.width).toBeCloseTo(267, 0);
  expect(box.height).toBeCloseTo(100, 0);

  await expect(page.locator(helper.SELECTORS.commentBox)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.noteInput)).toHaveAttribute('placeholder', 'what should change here?');
  await expect(page.locator(helper.SELECTORS.btnSave)).toHaveText('save');
  await expect(page.locator(helper.SELECTORS.btnSave)).toBeDisabled();
  // No visible v1 square handles remain (design spec §3.2 — replaced by
  // invisible .resize-zone hit zones).
  await expect(page.locator('#annotator-addmode-host .handle')).toHaveCount(0);
});

test('invisible edge/corner hit zones resize the box, and the box cannot shrink below 20x20', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 300, 300);
  const before = await page.locator(helper.SELECTORS.box).boundingBox();

  // Grow via the se corner.
  await helper.dragResizeZone(page, 'se', before.x + 350, before.y + 300);
  const grown = await page.locator(helper.SELECTORS.box).boundingBox();
  expect(grown.width).toBeGreaterThan(before.width);
  expect(grown.height).toBeGreaterThan(before.height);

  // An edge moves only its own side: dragging the n edge up grows height
  // while the width stays put.
  await helper.dragResizeZone(page, 'n', grown.x + grown.width / 2, grown.y - 40);
  const taller = await page.locator(helper.SELECTORS.box).boundingBox();
  expect(taller.height).toBeGreaterThan(grown.height);
  expect(taller.width).toBeCloseTo(grown.width, 0);

  // Try to collapse it via the se corner dragged past the nw corner —
  // clamped to the 20x20 minimum (§1.2), never to zero or negative.
  await helper.dragResizeZone(page, 'se', taller.x - 500, taller.y - 500);
  const collapsed = await page.locator(helper.SELECTORS.box).boundingBox();
  expect(collapsed.width).toBeGreaterThanOrEqual(20);
  expect(collapsed.height).toBeGreaterThanOrEqual(20);
});

test('cancel discards the in-progress box; clicking outside the box does nothing', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 150, 200);
  await helper.typeAddModeNote(page, 'this should be discarded');

  // Clicking outside the box/comment area must have zero effect (§1.2) — the
  // blocker only reacts to the placement click while in 'placing' mode.
  await page.mouse.click(900, 100);
  await expect(page.locator(helper.SELECTORS.box)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.noteInput)).toHaveValue('this should be discarded');

  await helper.clickAddModeCancel(page);
  await expect(page.locator(helper.SELECTORS.addModeHost)).toHaveCount(0);
  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(0);
});

test('the note counter appears above 900 chars and turns danger at 980', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 150, 200);

  await helper.typeAddModeNote(page, 'x'.repeat(900));
  await expect(page.locator(helper.SELECTORS.counter)).toHaveAttribute('data-warn', 'false');
  await expect(page.locator(helper.SELECTORS.counter)).toBeHidden();

  await helper.typeAddModeNote(page, 'x'.repeat(901));
  await expect(page.locator(helper.SELECTORS.counter)).toHaveAttribute('data-warn', 'true');
  await expect(page.locator(helper.SELECTORS.counter)).toHaveAttribute('data-danger', 'false');
  await expect(page.locator(helper.SELECTORS.counter)).toHaveText('901/1000');

  await helper.typeAddModeNote(page, 'x'.repeat(980));
  await expect(page.locator(helper.SELECTORS.counter)).toHaveAttribute('data-danger', 'true');
  await expect(page.locator(helper.SELECTORS.counter)).toHaveText('980/1000');
});

test('save is disabled while the note is empty, and capturing produces a numbered thumbnail', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.enterAddMode(page);
  await helper.placeSelectionBox(page, 150, 200);
  await expect(page.locator(helper.SELECTORS.btnSave)).toBeDisabled();

  await helper.typeAddModeNote(page, 'the fixed header overlaps this button');
  await expect(page.locator(helper.SELECTORS.btnSave)).toBeEnabled();
  await helper.clickAddModeSave(page);

  // Add mode exits, sidebar restores, thumbnail #1 appears (§1.2 step 4).
  await expect(page.locator(helper.SELECTORS.addModeHost)).toHaveCount(0);
  await page.locator(helper.SELECTORS.thumbnail).first().waitFor({ state: 'visible', timeout: 15000 });
  await expect(page.locator(helper.SELECTORS.thumbnailBadge)).toHaveText('1');
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('the fixed header overlaps this button');
});

test('feedback item ids are sequential across successive captures on the same page', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  await helper.captureFeedbackItem(page, { x: 100, y: 150, note: 'first item', expectedCount: 1 });
  await helper.captureFeedbackItem(page, { x: 400, y: 150, note: 'second item', expectedCount: 2 });

  const badges = page.locator(helper.SELECTORS.thumbnailBadge);
  await expect(badges).toHaveCount(2);
  await expect(badges.nth(0)).toHaveText('1');
  await expect(badges.nth(1)).toHaveText('2');
});
