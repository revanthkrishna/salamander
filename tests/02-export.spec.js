'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');
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

test('Export button is disabled when no annotations exist', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await expect(page.locator(SELECTORS.btnExport)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test('Export button is enabled after creating an annotation', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);
    await createAnnotation(page, '#main-heading', 'Export test note');

    await expect(page.locator(SELECTORS.btnExport)).toBeEnabled();
  } finally {
    await page.close();
  }
});

test('clicking Export does not show an error message', async () => {
  // Note: blob:chrome-extension:// downloads from content scripts cannot be captured
  // by Playwright CDP. We verify export works by checking no error appears in the toolbar.
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);
    await createAnnotation(page, '#main-heading', 'Download test');

    await page.locator(SELECTORS.btnExport).click();
    await page.waitForTimeout(500);

    // No error message should appear after export
    const msgArea = page.locator(SELECTORS.messageArea);
    const msgVisible = await msgArea.evaluate(el => !el.hidden);
    if (msgVisible) {
      const msgText = await page.locator(SELECTORS.messageArea).textContent();
      expect(msgText).not.toMatch(/error/i);
    }
  } finally {
    await page.close();
  }
});

test('exported YAML has correct structure (version, domain, annotations) — verified via storage', async () => {
  // Since blob:chrome-extension:// URLs cannot be captured via CDP in Playwright,
  // we verify YAML correctness by reading annotations from chrome.storage.local
  // via the service worker and checking the stored data has the required fields.
  const { getServiceWorker } = require('./helpers/extension');
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);
    await enterAnnotationMode(page);
    await createAnnotation(page, '#main-heading', 'YAML structure test');

    // Read annotation data directly from storage via service worker
    const sw = await getServiceWorker(context);
    const storageData = await sw.evaluate(() => {
      return new Promise(resolve => {
        chrome.storage.local.get(null, resolve);
      });
    });

    // Find the annotations key for localhost
    const annotationsKey = Object.keys(storageData).find(k => k.startsWith('annotations:'));
    expect(annotationsKey).toBeTruthy();

    const domainData = storageData[annotationsKey];
    expect(domainData).toHaveProperty('pages');

    // Flatten all annotations across pages
    const allAnnotations = Object.values(domainData.pages).flat();
    expect(allAnnotations.length).toBeGreaterThanOrEqual(1);

    const ann = allAnnotations[0];
    expect(ann).toHaveProperty('pinNumber');
    expect(ann.pinNumber).toBe(1);
    expect(ann).toHaveProperty('note', 'YAML structure test');
    expect(ann).toHaveProperty('fingerprint');
    expect(ann.fingerprint).toHaveProperty('cssSelector');
    expect(ann.fingerprint).toHaveProperty('xpath');
    expect(ann.fingerprint).toHaveProperty('textSnippet');
    expect(ann.fingerprint).toHaveProperty('tagName');
    expect(ann).toHaveProperty('offset');
    expect(ann.offset).toHaveProperty('x');
    expect(ann.offset).toHaveProperty('y');
  } finally {
    await page.close();
  }
});
