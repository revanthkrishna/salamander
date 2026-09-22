'use strict';

// Covers REQUIREMENTS §1.1 / §3.1 — sidebar activation, header buttons, empty
// state, the page-resize side effect, and the close/reopen toggle. Journey 1
// step 1.

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

test('clicking the icon opens the sidebar, docked right, with the header/action-row controls and the empty state', async () => {
  // Salamander restyle (design spec §3.1): add/export/import moved out of
  // the header into their own action row below it, and the header itself
  // gained a logo/wordmark (the theme toggle it also gained went again when
  // the extension became dark only, §AA). v3 §A2/§C2 then merged the
  // row into two groups — "add note" (icon-only) with a "keep add mode on"
  // switch, and export with a chevron whose menu holds "import".
  // export/close keep a fixed aria-label; the add button's is state-dependent
  // (the tooltip changes with the state, the aria-label does not), so its selector
  // targets the stable .btn-add class instead (see SELECTORS.btnAdd).
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);

  await expect(page.locator(helper.SELECTORS.sidebar)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.btnAdd)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.btnExport)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.btnMenu)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.btnClose)).toBeVisible();

  // The "keep add mode on" switch and the chevron menu's "import" item are
  // both hidden until asked for (§A2's reveal, §C2's menu) — and nothing
  // hidden may be focusable.
  await expect(page.locator(helper.SELECTORS.addSwitch)).toBeHidden();
  await expect(page.locator(helper.SELECTORS.btnImport)).toBeHidden();

  await page.locator(helper.SELECTORS.addGroup).hover();
  await expect(page.locator(helper.SELECTORS.addSwitch)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.addSwitch)).toHaveAttribute('aria-checked', 'false');

  await helper.openActionMenu(page);
  await expect(page.locator(helper.SELECTORS.btnImport)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.btnMenu)).toHaveAttribute('aria-expanded', 'true');
  // Esc closes it and hands focus back to the chevron (§C2).
  await page.keyboard.press('Escape');
  await expect(page.locator(helper.SELECTORS.btnImport)).toBeHidden();

  // §3.1's decided empty-state copy, lowercase.
  await expect(page.locator(helper.SELECTORS.emptyState)).toHaveText('no feedback on this page yet');
  await expect(page.locator(helper.SELECTORS.thumbnailList)).toBeHidden();
});

test('opening the sidebar shrinks the page rather than overlaying it', async () => {
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);

  const marginBefore = await page.evaluate(() => document.documentElement.style.marginRight);
  expect(marginBefore).toBe('');

  await helper.activateExtension(context, page);

  const marginAfter = await page.evaluate(() => document.documentElement.style.marginRight);
  // SIDEBAR_DEFAULT_WIDTH (src/sidebar.ts) is 300px, not the old fixed 320px
  // SIDEBAR_WIDTH — the sidebar is now user-resizable (188-300px).
  expect(marginAfter).toBe('300px');

  // Sidebar itself must be docked to the right edge.
  const box = await page.locator(helper.SELECTORS.sidebar).boundingBox();
  const viewport = page.viewportSize();
  expect(box.x + box.width).toBeCloseTo(viewport.width, 0);
});

test('close hides the sidebar and restores the page layout; the icon reopens it in the same state', async () => {
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);

  await page.locator(helper.SELECTORS.btnClose).click();
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeHidden();

  const marginAfterClose = await page.evaluate(() => document.documentElement.style.marginRight);
  expect(marginAfterClose).toBe('');

  // Re-opening via the toolbar icon (content script is still loaded — this
  // exercises the ICON_CLICKED toggle path, not a fresh injection).
  await helper.clickExtensionIcon(context, page);
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeVisible();
  await expect(page.locator(helper.SELECTORS.emptyState)).toBeVisible();
});

test('clicking the icon a second time toggles the sidebar closed', async () => {
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeVisible();

  await helper.clickExtensionIcon(context, page);
  await expect(page.locator(helper.SELECTORS.sidebar)).toBeHidden();
});
