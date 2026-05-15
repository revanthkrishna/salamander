const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

// manifest.json is at the root, referencing dist/background.js
const EXTENSION_PATH = path.resolve(__dirname, '..');

test('extension loads and sidebar appears', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const page = await context.newPage();
  await page.goto('https://example.com');
  await page.waitForTimeout(2000);

  // Check the extension injected its content script (look for annotator UI elements)
  const annotatorEl = await page.$('[data-annotator], #annotator-root, #annotator-sidebar, .annotator-pin');
  console.log('Annotator element found:', !!annotatorEl);

  // Take a screenshot only for debugging this initial setup
  await page.screenshot({ path: 'test-results/smoke-screenshot.png' });

  await context.close();
});
