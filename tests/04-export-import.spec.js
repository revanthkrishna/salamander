'use strict';

// Covers REQUIREMENTS §1.6 / §1.7, §5 #7/#10, and Journey 2 — export the
// domain's feedback as a .zip, then import that same bundle in a fresh
// session and confirm it lands back in an equivalent state (round trip).

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

test('exporting with zero feedback items shows "nothing to export" and downloads nothing', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  const message = await helper.exportAndGetEmptyAlert(page);
  expect(message).toBe('nothing to export'); // §5 #7, verbatim
});

test('export downloads a correctly-named zip bundle', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'export me', expectedCount: 1 });

  const download = await helper.exportAndGetDownload(context, page);
  // §1.6: feedback-{domain_with_underscores}-{YYYY-MM-DD}.zip. The test
  // server's host is "localhost:<port>", so the dot-free host still exercises
  // the colon->underscore substitution.
  expect(download.suggestedFilename()).toMatch(/^feedback-localhost_\d+-\d{4}-\d{2}-\d{2}\.zip$/);
});

test('a bundle exported from one session imports cleanly into a fresh one (round trip)', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'round trip note', expectedCount: 1 });

  const download = await helper.exportAndGetDownload(context, page);
  const zipPath = await download.path();
  expect(zipPath).toBeTruthy();

  // A second, independent session — "recipient opens the same site" (Journey 2).
  const recipientContext = await helper.launchWithExtension();
  try {
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(fileServer.baseUrl);
    await helper.activateExtension(recipientContext, recipientPage);
    await expect(recipientPage.locator(helper.SELECTORS.emptyState)).toBeVisible();

    await helper.importFile(recipientPage, zipPath);

    await recipientPage.locator(helper.SELECTORS.thumbnail).first().waitFor({ state: 'visible', timeout: 15000 });
    await expect(recipientPage.locator(helper.SELECTORS.thumbnailBadge)).toHaveText('1');
    await expect(recipientPage.locator(helper.SELECTORS.thumbnailNote)).toHaveText('round trip note');
  } finally {
    await recipientContext.close();
  }
});

test('importing when existing feedback is present asks for confirmation before replacing', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);
  await helper.captureFeedbackItem(page, { x: 150, y: 200, note: 'will be exported', expectedCount: 1 });
  const download = await helper.exportAndGetDownload(context, page);
  const zipPath = await download.path();

  // Capture a second, different item so this session now has existing data
  // that importing the (1-item) bundle above would replace.
  await helper.captureFeedbackItem(page, { x: 400, y: 200, note: 'local unsaved item', expectedCount: 2 });

  const confirmMessage = helper.handleNextDialog(page, (dialog) => dialog.accept());
  await helper.importFile(page, zipPath);
  const message = await confirmMessage;
  // §5 #10, verbatim modulo the item count.
  expect(message).toContain('importing will replace your current 2 feedback item(s) for this site');
  expect(message).toContain('this cannot be undone. continue?');

  await expect(page.locator(helper.SELECTORS.thumbnail)).toHaveCount(1);
  await expect(page.locator(helper.SELECTORS.thumbnailNote)).toHaveText('will be exported');
});

test('importing a non-zip file is rejected with the invalid-file-type error', async () => {
  const page = await context.newPage();
  await openPageWithSidebar(page);

  const notAZip = require('path').join(helper.FIXTURES_DIR, 'test-page.html');
  await helper.importFile(page, notAZip);

  await expect(page.locator(helper.SELECTORS.notif)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.notifText)).toHaveText(
    'invalid file type. please upload a .zip feedback bundle.',
  );
});
