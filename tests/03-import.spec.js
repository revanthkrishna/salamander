'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const yaml = require('js-yaml');
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

/**
 * Build a valid YAML annotation file for the localhost fixture page.
 * normaliseUrl('http://localhost:PORT/test-page.html') → 'https://localhost/test-page.html'
 */
function buildValidYaml(pinNumber = 1, domain = 'localhost', pageUrl = 'https://localhost/test-page.html') {
  const doc = {
    version: 1,
    exported_at: new Date().toISOString(),
    domain,
    annotations: [
      {
        pin_number: pinNumber,
        page_url: pageUrl,
        note: `Imported annotation ${pinNumber}`,
        fingerprint: {
          css_selector: '#main-heading',
          xpath: '/html/body/div/h1',
          text_snippet: 'Test Page',
          tag_name: 'h1',
        },
        offset: { x: 10, y: 10 },
        created_at: new Date().toISOString(),
      },
    ],
  };
  return yaml.dump(doc, { sortKeys: false, schema: yaml.JSON_SCHEMA });
}

function writeTempYaml(content, filename = 'test-import.yaml') {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('importing a valid YAML file shows filename in toolbar and enters annotation mode', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const yamlContent = buildValidYaml();
    const yamlFile = writeTempYaml(yamlContent, 'annotations-localhost.yaml');

    // Click Upload and provide file
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator(SELECTORS.btnUpload).click(),
    ]);
    await fileChooser.setFiles(yamlFile);
    await page.waitForTimeout(800);

    // Filename should appear in toolbar
    await expect(page.locator(SELECTORS.filenameText)).toContainText('annotations-localhost.yaml');

    // Annotation mode should be active (Exit button visible)
    await expect(page.locator(SELECTORS.btnExit)).toBeVisible();
    await expect(page.locator(SELECTORS.btnStart)).toBeHidden();
  } finally {
    await page.close();
  }
});

test('importing a valid YAML file renders pins for resolvable elements', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const yamlContent = buildValidYaml(1);
    const yamlFile = writeTempYaml(yamlContent, 'annotations-localhost.yaml');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator(SELECTORS.btnUpload).click(),
    ]);
    await fileChooser.setFiles(yamlFile);
    await page.waitForTimeout(800);

    // Pin #1 should be visible (element resolved via #main-heading)
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
  } finally {
    await page.close();
  }
});

test('pin numbering after import continues from max imported pin', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    // Import file with pin #5
    const doc = {
      version: 1,
      exported_at: new Date().toISOString(),
      domain: 'localhost',
      annotations: [
        {
          pin_number: 5,
          page_url: 'https://localhost/test-page.html',
          note: 'Imported pin 5',
          fingerprint: {
            css_selector: '#main-heading',
            xpath: '/html/body/div/h1',
            text_snippet: 'Test Page',
            tag_name: 'h1',
          },
          offset: { x: 10, y: 10 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    const yamlFile = writeTempYaml(yaml.dump(doc), 'annotations-localhost.yaml');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator(SELECTORS.btnUpload).click(),
    ]);
    await fileChooser.setFiles(yamlFile);
    await page.waitForTimeout(800);

    // Now create a new annotation — it should be pin #6
    await createAnnotation(page, '#intro-para', 'New annotation after import');

    // Pin #6 should exist
    await expect(page.locator(SELECTORS.pinByNumber(6))).toBeVisible();
    // Pin #5 should still exist
    await expect(page.locator(SELECTORS.pinByNumber(5))).toBeVisible();
  } finally {
    await page.close();
  }
});

test('importing when annotations already exist shows confirmation dialog', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    // Create an existing annotation first
    await enterAnnotationMode(page);
    await createAnnotation(page, '#main-heading', 'Existing annotation');

    // Try to import — should show confirm dialog
    const yamlContent = buildValidYaml();
    const yamlFile = writeTempYaml(yamlContent, 'annotations-localhost.yaml');

    // Set up dialog handler to CANCEL
    let dialogSeen = false;
    page.once('dialog', async (dialog) => {
      dialogSeen = true;
      await dialog.dismiss();
    });

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator(SELECTORS.btnUpload).click(),
    ]);
    await fileChooser.setFiles(yamlFile);
    await page.waitForTimeout(500);

    expect(dialogSeen).toBe(true);

    // Since we cancelled, existing pin should still be there
    await expect(page.locator(SELECTORS.pinByNumber(1))).toBeVisible();
  } finally {
    await page.close();
  }
});
