'use strict';

const { test, expect } = require('@playwright/test');
const {
  SELECTORS,
  startFileServer,
  launchWithExtension,
  activateExtension,
  clearExtensionStorage,
} = require('./helpers/extension');

// Test A: context-per-file approach (shared context)
test.describe('shared context approach', () => {
  let fileServer, context, fixtureUrl;
  test.beforeAll(async () => {
    fileServer = await startFileServer();
    fixtureUrl = `${fileServer.baseUrl}/test-page.html`;
    context = await launchWithExtension();
  });
  test.afterAll(async () => {
    await context.close();
    await fileServer.stop();
  });

  test('shared context: toolbar appears', async () => {
    const page = await context.newPage();
    try {
      await page.goto(fixtureUrl);
      console.log('Page URL:', page.url());

      // Check SW
      const sws = context.serviceWorkers();
      console.log('Service workers count:', sws.length);
      if (sws.length > 0) console.log('SW URL:', sws[0].url());

      await activateExtension(context, page);
      await expect(page.locator('#annotator-host')).toBeAttached();
    } finally {
      await page.close();
    }
  });
});

// Test B: context-per-test approach
test.describe('per-test context approach', () => {
  let fileServer, fixtureUrl;
  test.beforeAll(async () => {
    fileServer = await startFileServer();
    fixtureUrl = `${fileServer.baseUrl}/test-page.html`;
  });
  test.afterAll(async () => {
    await fileServer.stop();
  });

  test('per-test context: toolbar appears', async () => {
    const context = await launchWithExtension();
    try {
      const page = await context.newPage();
      await page.goto(fixtureUrl);
      console.log('Page URL B:', page.url());
      const sws = context.serviceWorkers();
      console.log('SWs B:', sws.length);
      await activateExtension(context, page);
      await expect(page.locator('#annotator-host')).toBeAttached();
    } finally {
      await context.close();
    }
  });
});
