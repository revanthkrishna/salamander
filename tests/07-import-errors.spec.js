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
 * Write content to a temp file and return its path.
 */
function writeTempFile(content, filename) {
  const filePath = path.join(os.tmpdir(), filename);
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content);
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
}

/**
 * Upload a file via the Upload button and wait for the error message.
 * Returns the message area text.
 */
async function uploadAndGetError(page, filePath) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.locator(SELECTORS.btnUpload).click(),
  ]);
  await fileChooser.setFiles(filePath);
  // Wait for message area to become visible with content
  await page.waitForFunction(() => {
    const host = document.querySelector('#annotator-host');
    if (!host) return false;
    // We can't access closed shadow root in evaluate, check via DOM traversal
    return true; // rely on Playwright pierce selector below
  }, { timeout: 5000 });
  // Give error time to appear
  await page.waitForTimeout(500);
  return page.locator(SELECTORS.messageArea).textContent();
}

test('wrong file type (.json) shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const jsonFile = writeTempFile('{"test": 1}', 'test.json');
    const errorMsg = await uploadAndGetError(page, jsonFile);
    expect(errorMsg).toContain('Invalid file type');
    expect(errorMsg).toContain('.yaml');
  } finally {
    await page.close();
  }
});

test('empty file shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const emptyFile = writeTempFile('', 'empty.yaml');
    const errorMsg = await uploadAndGetError(page, emptyFile);
    expect(errorMsg).toContain('empty');
  } finally {
    await page.close();
  }
});

test('malformed YAML shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const malformedFile = writeTempFile('{{{invalid yaml: :::', 'malformed.yaml');
    const errorMsg = await uploadAndGetError(page, malformedFile);
    expect(errorMsg).toContain('corrupted');
  } finally {
    await page.close();
  }
});

test('domain mismatch shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    // File is for figma.com, we're on localhost
    const doc = {
      version: 1,
      exported_at: new Date().toISOString(),
      domain: 'figma.com',
      annotations: [
        {
          pin_number: 1,
          page_url: 'https://figma.com/',
          note: 'Test',
          fingerprint: { css_selector: 'body', xpath: '/html/body', text_snippet: '', tag_name: 'body' },
          offset: { x: 0, y: 0 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    const yamlFile = writeTempFile(yaml.dump(doc), 'annotations-figma_com.yaml');
    const errorMsg = await uploadAndGetError(page, yamlFile);
    expect(errorMsg).toContain('figma.com');
    expect(errorMsg).toContain('localhost');
  } finally {
    await page.close();
  }
});

test('empty annotations list shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    // Valid YAML structure but empty annotations array
    // Note: the schema validator throws EMPTY_ANNOTATIONS for empty arrays
    const doc = {
      version: 1,
      exported_at: new Date().toISOString(),
      domain: 'localhost',
      annotations: [],
    };
    const yamlFile = writeTempFile(yaml.dump(doc), 'empty-annotations.yaml');
    const errorMsg = await uploadAndGetError(page, yamlFile);
    expect(errorMsg).toContain('no annotations');
  } finally {
    await page.close();
  }
});

test('wrong schema (missing required fields) shows correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const wrongSchema = writeTempFile('name: test\nvalue: 123\n', 'wrong-schema.yaml');
    const errorMsg = await uploadAndGetError(page, wrongSchema);
    expect(errorMsg).toContain("doesn't look like an Annotator file");
  } finally {
    await page.close();
  }
});

test('duplicate pin numbers show correct error message', async () => {
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl);
    await activateExtension(context, page);

    const doc = {
      version: 1,
      exported_at: new Date().toISOString(),
      domain: 'localhost',
      annotations: [
        {
          pin_number: 1,
          page_url: 'https://localhost/test-page.html',
          note: 'First',
          fingerprint: { css_selector: '#main-heading', xpath: '/html/body/div/h1', text_snippet: 'Test Page', tag_name: 'h1' },
          offset: { x: 10, y: 10 },
          created_at: new Date().toISOString(),
        },
        {
          pin_number: 1, // duplicate!
          page_url: 'https://localhost/test-page.html',
          note: 'Duplicate',
          fingerprint: { css_selector: '#intro-para', xpath: '/html/body/div/p', text_snippet: 'This is a test', tag_name: 'p' },
          offset: { x: 5, y: 5 },
          created_at: new Date().toISOString(),
        },
      ],
    };
    const yamlFile = writeTempFile(yaml.dump(doc), 'duplicate-pins.yaml');
    const errorMsg = await uploadAndGetError(page, yamlFile);
    expect(errorMsg).toContain('duplicate');
  } finally {
    await page.close();
  }
});
