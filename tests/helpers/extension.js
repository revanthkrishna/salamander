'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '../../');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

// ---------------------------------------------------------------------------
// Selectors (all toolbar/popover elements are in closed Shadow DOM)
// ---------------------------------------------------------------------------

// NOTE: Extension shadow DOMs are temporarily set to mode:'open' for Playwright testing.
// Playwright can pierce open shadow DOMs automatically with standard CSS selectors.
const SELECTORS = {
  // Toolbar host (regular DOM)
  toolbarHost: '#annotator-host',

  // Toolbar inner elements (open shadow DOM — standard CSS works)
  toolbar:      '.annotator-toolbar',
  btnStart:     '#btn-start-annotating',
  btnExit:      '#btn-exit',
  btnExport:    '#btn-export',
  btnUpload:    '#btn-upload',
  btnDeleteAll: '#btn-delete-all',
  messageArea:  '.message-area',
  filenameArea: '.filename-area',
  filenameText: '.filename-text',

  // Popover host (regular DOM)
  popoverHost: '#annotator-popover-host',

  // Popover inner elements (open shadow DOM — standard CSS works)
  popover:          '.popover',
  noteInput:        '.note-input',
  counter:          '.counter',
  addBtn:           '.add-btn',
  deleteBtn:        '.delete-btn',
  closeBtn:         '.close-btn',
  deleteConfirm:    '.delete-confirm',
  confirmDeleteBtn: '.confirm-delete-btn',
  confirmCancelBtn: '.confirm-cancel-btn',

  // Pins (regular DOM — appended directly to body)
  pin:              '.annotator-pin',
  pinByNumber: (n) => `.annotator-pin[data-pin-id="${n}"]`,
};

// ---------------------------------------------------------------------------
// File server (serves fixtures directory over HTTP)
// ---------------------------------------------------------------------------

let _fileServer = null;
let _fileServerPort = null;

/**
 * Start a local HTTP server to serve fixture files.
 * Returns { port, baseUrl, stop }.
 * Idempotent — safe to call multiple times.
 */
async function startFileServer() {
  if (_fileServer) {
    return { port: _fileServerPort, baseUrl: `http://localhost:${_fileServerPort}`, stop: stopFileServer };
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string
      const urlPath = req.url.split('?')[0];
      const filePath = path.join(FIXTURES_DIR, urlPath === '/' ? 'test-page.html' : urlPath);

      try {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.yaml' || ext === '.yml' ? 'application/x-yaml'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found: ' + urlPath);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      _fileServer = server;
      _fileServerPort = server.address().port;
      resolve({
        port: _fileServerPort,
        baseUrl: `http://localhost:${_fileServerPort}`,
        stop: stopFileServer,
      });
    });

    server.on('error', reject);
  });
}

async function stopFileServer() {
  if (_fileServer) {
    await new Promise(resolve => _fileServer.close(resolve));
    _fileServer = null;
    _fileServerPort = null;
  }
}

// ---------------------------------------------------------------------------
// Launch helpers
// ---------------------------------------------------------------------------

/**
 * Launch a persistent browser context with the Annotator extension loaded.
 * Waits for the service worker to be ready before returning.
 */
async function launchWithExtension() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  // Ensure the extension service worker is registered before we return.
  // If it fired before we got here, serviceWorkers() will already have it.
  // If not, waitForEvent catches it. This prevents the timing race in tests.
  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 10000 });
  }

  return context;
}

/**
 * Get the service worker for the extension.
 * By the time this is called, launchWithExtension() should have ensured SW is ready.
 */
async function getServiceWorker(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    // Fallback: should rarely happen after launchWithExtension fix
    sw = await context.waitForEvent('serviceworker', { timeout: 8000 });
  }
  return sw;
}

/**
 * Inject and activate the extension on the given page.
 * Returns after the toolbar (#annotator-host) is visible.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Page} page
 */
async function activateExtension(context, page) {
  const sw = await getServiceWorker(context);

  await page.waitForLoadState('domcontentloaded');
  // Short wait for Chrome to fully register the tab
  await page.waitForTimeout(400);

  // Find the tab ID by matching the current page URL
  const pageUrl = page.url();
  const tabId = await sw.evaluate(async (url) => {
    return new Promise(resolve => {
      chrome.tabs.query({}, tabs => {
        const tab = tabs.find(t => t.url === url || t.pendingUrl === url);
        resolve(tab ? tab.id : null);
      });
    });
  }, pageUrl);

  if (!tabId) {
    throw new Error(`Could not find tab for URL: ${pageUrl}`);
  }

  // Inject content script
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['dist/content.js'],
    });
  }, tabId);

  // Brief pause for script to initialise
  await page.waitForTimeout(300);

  // Send ACTIVATE message
  await sw.evaluate((tabId) => {
    chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId });
  }, tabId);

  // Wait for toolbar host to be attached (#annotator-host is 0x0 by design — don't check visibility)
  await page.waitForSelector('#annotator-host', { state: 'attached', timeout: 8000 });

  return page.locator('#annotator-host');
}

/**
 * Clear all extension storage (call between tests for isolation).
 */
async function clearExtensionStorage(context) {
  const sw = await getServiceWorker(context);
  await sw.evaluate(() => {
    return new Promise(resolve => chrome.storage.local.clear(resolve));
  });
}

/**
 * Enter annotation mode by clicking the Start Annotating button.
 */
async function enterAnnotationMode(page) {
  await page.locator(SELECTORS.btnStart).click();
  await page.waitForTimeout(100);
}

/**
 * Create one annotation by clicking a target element and filling in a note.
 * Returns after the popover closes and the pin is added.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} targetSelector - CSS selector of the element to click
 * @param {string} noteText - annotation note
 */
async function createAnnotation(page, targetSelector, noteText) {
  // Click the element to open popover
  await page.locator(targetSelector).click();
  // Wait for popover host to be attached (0x0 host like toolbar, check attached not visible)
  await page.waitForSelector('.note-input', { state: 'visible', timeout: 5000 });

  // Type the note
  await page.locator(SELECTORS.noteInput).fill(noteText);
  // Click Add
  await page.locator(SELECTORS.addBtn).click();
  // Brief pause for pin to render
  await page.waitForTimeout(200);
}

module.exports = {
  SELECTORS,
  EXTENSION_PATH,
  startFileServer,
  stopFileServer,
  launchWithExtension,
  getServiceWorker,
  activateExtension,
  clearExtensionStorage,
  enterAnnotationMode,
  createAnnotation,
};
