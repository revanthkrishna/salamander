'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '../../');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
//
// Everything the extension draws lives in a *closed* shadow root (sidebar.ts,
// addMode.ts, enlargedView.ts (inside the sidebar) use `attachShadow({ mode: 'closed' })` — this is
// deliberate production behaviour, not something Phase 10 is allowed to
// change). Playwright's CSS engine only pierces *open* shadow roots, so
// `installClosedShadowOpener` below patches `Element.prototype.attachShadow`
// inside the extension's isolated world (the same JS realm content.js runs
// in) to force every shadow root open, for every test run. Once that patch is
// in place, plain CSS locators pierce all three of the extension's shadow
// hosts exactly as if the DOM were flat — no special shadow-piercing syntax
// needed.
//
// Each host is scoped by id below because a couple of class names (e.g.
// `.note-input`, `.footer`) are reused across the sidebar/add-mode/enlarged view
// surfaces with different meanings.
const SELECTORS = {
  // Sidebar (src/sidebar.ts)
  sidebarHost: '#annotator-sidebar-host',
  sidebar: '#annotator-sidebar-host .sidebar',
  // aria-label is state-dependent ("add note" / "add note (on)" / "add note
  // (locked)" — see setAddButtonState() in src/sidebar.ts), so this selects
  // on the button's stable class instead of the label text.
  btnAdd: '#annotator-sidebar-host button.btn-primary',
  btnExport: '#annotator-sidebar-host button[aria-label="export feedback"]',
  btnImport: '#annotator-sidebar-host button[aria-label="import feedback"]',
  btnClose: '#annotator-sidebar-host button[aria-label="close sidebar"]',
  fileInput: '#annotator-sidebar-host input[type="file"]',
  emptyState: '#annotator-sidebar-host .empty-state',
  thumbnailList: '#annotator-sidebar-host .thumbnail-list',
  thumbnail: '#annotator-sidebar-host .thumbnail',
  thumbnailBadge: '#annotator-sidebar-host .thumbnail-badge',
  thumbnailNote: '#annotator-sidebar-host .thumbnail-note',
  notif: '#annotator-sidebar-host .notif',
  notifText: '#annotator-sidebar-host .notif-text',

  // Add mode (src/addMode.ts)
  addModeHost: '#annotator-addmode-host',
  blocker: '#annotator-addmode-host .blocker',
  box: '#annotator-addmode-host .box',
  // Invisible edge/corner resize hit zones (design spec §3.2) — the v1 square
  // handles are gone. `key` is a ZoneKey ('n' | 's' | 'e' | 'w' | 'ne' | 'nw'
  // | 'se' | 'sw'), matching src/addMode.ts's `data-zone` attribute.
  resizeZone: (key) => `#annotator-addmode-host .resize-zone[data-zone="${key}"]`,
  commentBox: '#annotator-addmode-host .comment-box',
  noteInput: '#annotator-addmode-host .note-input',
  counter: '#annotator-addmode-host .counter',
  btnCancel: '#annotator-addmode-host .btn-cancel',
  btnSave: '#annotator-addmode-host .btn-save',

  // Enlarged view (src/enlargedView.ts) — the sidebar itself expands; it
  // renders inside the sidebar's shadow root, so every selector is scoped to
  // the sidebar host. `.enlarged` is detached when the view is closed.
  enlarged: '#annotator-sidebar-host .enlarged',
  enlargedOpen: '#annotator-sidebar-host .enlarged[data-state="open"]',
  enlargedTitle: '#annotator-sidebar-host .xp-title',
  enlargedCount: '#annotator-sidebar-host .xp-count',
  enlargedExit: '#annotator-sidebar-host .xp-exit',
  enlargedPrev: '#annotator-sidebar-host .xp-prev',
  enlargedNext: '#annotator-sidebar-host .xp-next',
  enlargedImage: '#annotator-sidebar-host .xp-card.is-main .xp-card-img',
  enlargedNoteInput: '#annotator-sidebar-host .xp-note-input',
  enlargedDelete: '#annotator-sidebar-host .xp-delete',
  enlargedStatus: '#annotator-sidebar-host .xp-status',
};

// ---------------------------------------------------------------------------
// File server (serves fixtures directory over HTTP)
// ---------------------------------------------------------------------------

let _fileServer = null;
let _fileServerPort = null;

/**
 * Start a local HTTP server to serve fixture files. SPA-style fallback: any
 * path with no file extension (e.g. `/page-two`, pushState'd in by the SPA
 * nav buttons on the fixture page — see test-page.html) that doesn't exist on
 * disk serves test-page.html instead of 404ing, so a real page reload while
 * "on" a pushState'd route still loads something sensible (mirrors how a
 * real single-page app's server is configured).
 *
 * Returns { port, baseUrl, stop }. Idempotent — safe to call multiple times.
 */
async function startFileServer() {
  if (_fileServer) {
    return { port: _fileServerPort, baseUrl: `http://localhost:${_fileServerPort}`, stop: stopFileServer };
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const requested = urlPath === '/' ? 'test-page.html' : urlPath;
      let filePath = path.join(FIXTURES_DIR, requested);

      const serve = (resolvedPath) => {
        const content = fs.readFileSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.zip' ? 'application/zip'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      };

      try {
        serve(filePath);
      } catch {
        // No real file at this path. If it looks like a route (no extension)
        // rather than a missing asset, fall back to the SPA shell.
        if (!path.extname(requested)) {
          try {
            serve(path.join(FIXTURES_DIR, 'test-page.html'));
            return;
          } catch {
            // fixture itself missing — fall through to 404 below
          }
        }
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
 * Waits for the service worker to be ready, then installs the closed-shadow
 * opener patch (see SELECTORS comment above) before returning.
 */
async function launchWithExtension() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  if (context.serviceWorkers().length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 10000 });
  }

  const sw = await getServiceWorker(context);
  await installClosedShadowOpener(sw);

  return context;
}

/**
 * Get the service worker for the extension. By the time this is called,
 * launchWithExtension() should have ensured it's ready.
 */
async function getServiceWorker(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 8000 });
  }
  return sw;
}

// ---------------------------------------------------------------------------
// Closed shadow DOM opener
// ---------------------------------------------------------------------------
//
// See the SELECTORS comment for the full rationale. Mechanically: we wrap
// `chrome.scripting.executeScript` inside the service worker's own global
// scope so that every call injecting `dist/content.js` (background.ts's
// real icon-click / reload-reinject paths, and this helper's own
// `activateExtension` below) is preceded by a tiny `func`-based injection
// into the *same* isolated world that forces `Element.prototype.attachShadow`
// to ignore whatever `mode` it was asked for and open anyway. Scripts
// injected by the same extension into the same tab/frame via
// `chrome.scripting.executeScript` share one isolated-world JS realm — the
// same mechanism content.ts's own `window.__annotatorActive` double-injection
// guard relies on — so a prototype patch made by one injected script is still
// in effect for the next one.
//
// The wrapper is idempotent (guarded by a flag on the function itself) and
// installed fresh on every `launchWithExtension()` / explicit re-call, since
// an idle-timed-out and respawned service worker would otherwise lose it.
async function installClosedShadowOpener(sw) {
  await sw.evaluate(() => {
    // eslint-disable-next-line no-undef
    const scripting = chrome.scripting;
    if (scripting.executeScript.__annotatorPatched) return;

    const original = scripting.executeScript.bind(scripting);

    const openerFunc = () => {
      if (window.__annotatorShadowOpened) return;
      window.__annotatorShadowOpened = true;
      const nativeAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        return nativeAttachShadow.call(this, Object.assign({}, init || {}, { mode: 'open' }));
      };
    };

    const patched = async function (details) {
      if (details && Array.isArray(details.files) && details.files.includes('dist/content.js')) {
        try {
          await original({ target: details.target, world: 'ISOLATED', func: openerFunc });
        } catch {
          // Best-effort — if this fails the real injection below still runs;
          // tests interacting with shadow content will simply fail loudly.
        }
      }
      return original(details);
    };
    patched.__annotatorPatched = true;

    try {
      Object.defineProperty(scripting, 'executeScript', {
        value: patched,
        writable: true,
        configurable: true,
      });
    } catch {
      scripting.executeScript = patched;
    }
  });
}

/**
 * Inject and activate the extension on the given page (bypasses a real
 * toolbar-icon click — see clickExtensionIcon() for that). Returns after the
 * sidebar panel is visible.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Page} page
 */
async function activateExtension(context, page) {
  const sw = await getServiceWorker(context);
  await installClosedShadowOpener(sw);

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(200);

  const tabId = await findTabId(sw, page.url());
  await injectAndActivate(sw, tabId);

  await page.locator(SELECTORS.sidebar).waitFor({ state: 'visible', timeout: 8000 });
  return page.locator(SELECTORS.sidebar);
}

async function findTabId(sw, pageUrl) {
  const tabId = await sw.evaluate(async (url) => {
    return new Promise(resolve => {
      chrome.tabs.query({}, tabs => {
        const tab = tabs.find(t => t.url === url || t.pendingUrl === url);
        resolve(tab ? tab.id : null);
      });
    });
  }, pageUrl);
  if (!tabId) throw new Error(`Could not find tab for URL: ${pageUrl}`);
  return tabId;
}

async function injectAndActivate(sw, tabId) {
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
  }, tabId);
  await sw.evaluate((tabId) => {
    chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId }, () => void chrome.runtime.lastError);
  }, tabId);
}

/**
 * Simulate a real click on the extension's toolbar icon — mirrors
 * background.ts's handleActionClicked: ping the content script first; if it's
 * alive, toggle via ICON_CLICKED (exactly what a second real icon click
 * does); otherwise inject + activate as if this were the first click on a
 * fresh page.
 */
async function clickExtensionIcon(context, page) {
  const sw = await getServiceWorker(context);
  await installClosedShadowOpener(sw);
  const tabId = await findTabId(sw, page.url());

  const isAlive = await sw.evaluate((tabId) => {
    return new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 500);
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(response?.alive === true);
      });
    });
  }, tabId);

  if (isAlive) {
    await sw.evaluate((tabId) => {
      chrome.tabs.sendMessage(tabId, { type: 'ICON_CLICKED' }, () => void chrome.runtime.lastError);
    }, tabId);
  } else {
    await injectAndActivate(sw, tabId);
  }
}

/**
 * Clear all extension storage — chrome.storage.local/session and the
 * screenshots IndexedDB — for isolation between tests.
 */
async function clearExtensionStorage(context) {
  const sw = await getServiceWorker(context);
  await sw.evaluate(() => {
    return Promise.all([
      new Promise(resolve => chrome.storage.local.clear(resolve)),
      new Promise(resolve => chrome.storage.session.clear(resolve)),
      new Promise(resolve => {
        const req = indexedDB.deleteDatabase('annotator-images');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      }),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Add mode (src/addMode.ts) — selection + comment box
// ---------------------------------------------------------------------------

/** Click "add" in the sidebar header and wait for the add-mode host to
 *  attach. Only the blocker/box-drawing surface exists at this point —
 *  src/addMode.ts deliberately does not build the comment box (`.comment-box`)
 *  until the user places the selection (buildCommentDOM() is called from
 *  finalizePlacement(), not from startAddMode()) — so callers must place the
 *  box (placeSelectionBox) before looking for it. */
async function enterAddMode(page) {
  await page.locator(SELECTORS.btnAdd).click();
  await page.locator(SELECTORS.addModeHost).waitFor({ state: 'attached', timeout: 5000 });
}

/** Click once on the page (in add mode) to place the default-sized box at
 *  (x, y). Coordinates are viewport-relative CSS px, matching
 *  MouseEvent.clientX/clientY (the same space addMode.ts works in). Waits for
 *  the box outline and the now-built comment box, since placement is what
 *  creates the latter (see enterAddMode's doc comment). */
async function placeSelectionBox(page, x, y) {
  await page.locator(SELECTORS.blocker).click({ position: { x, y } });
  await page.locator(SELECTORS.box).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator(SELECTORS.commentBox).waitFor({ state: 'attached', timeout: 5000 });
}

/** Drag one invisible resize hit zone (edge strip or corner square — design
 *  spec §3.2; the v1 square handles are gone) to a new viewport position.
 *  `zoneKey` is a ZoneKey ('n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'). */
async function dragResizeZone(page, zoneKey, toX, toY) {
  const zone = page.locator(SELECTORS.resizeZone(zoneKey));
  const box = await zone.boundingBox();
  if (!box) throw new Error(`resize zone "${zoneKey}" not found`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 8 });
  await page.mouse.up();
}

/** Type into the add-mode note textarea (fires the same 'input' listener
 *  addMode.ts uses to drive the counter and save-button enabled state). */
async function typeAddModeNote(page, text) {
  await page.locator(SELECTORS.noteInput).fill(text);
}

async function clickAddModeSave(page) {
  await page.locator(SELECTORS.btnSave).click();
}

async function clickAddModeCancel(page) {
  await page.locator(SELECTORS.btnCancel).click();
}

/**
 * End-to-end capture convenience: enter add mode, place the default box at
 * (x, y), optionally resize it, type `note`, click ok, and wait for a new
 * thumbnail to land in the sidebar list. Returns once the thumbnail count is
 * `expectedCount`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{x: number, y: number, note: string, resize?: {zone: string, toX: number, toY: number}, expectedCount: number}} opts
 */
async function captureFeedbackItem(page, opts) {
  await enterAddMode(page);
  await placeSelectionBox(page, opts.x, opts.y);
  if (opts.resize) {
    await dragResizeZone(page, opts.resize.zone, opts.resize.toX, opts.resize.toY);
  }
  await typeAddModeNote(page, opts.note);
  await clickAddModeSave(page);
  await page.locator(SELECTORS.thumbnail).nth(opts.expectedCount - 1).waitFor({ state: 'visible', timeout: 15000 });
}

// ---------------------------------------------------------------------------
// Sidebar thumbnails + enlarged view (src/thumbnails.ts, src/enlargedView.ts)
// ---------------------------------------------------------------------------

/** Click a thumbnail and wait until the enlarged view has finished expanding. */
async function openThumbnail(page, index) {
  await page.locator(SELECTORS.thumbnail).nth(index).click();
  await page.locator(SELECTORS.enlargedOpen).waitFor({ state: 'attached', timeout: 5000 });
}

/** Edit the open note and exit via the rail's x button — exercises the
 *  "autosave flushed on collapse" path. */
async function editNoteAndClose(page, newText) {
  await page.locator(SELECTORS.enlargedNoteInput).fill(newText);
  await page.locator(SELECTORS.enlargedExit).click();
  await page.locator(SELECTORS.enlarged).waitFor({ state: 'detached', timeout: 5000 });
}

/** Edit the open note and blur the text area — exercises autosave without
 *  closing the view. Blurs directly rather than clicking another element:
 *  the view's layers are composited/animated, so a click target can take a
 *  while to count as "stable" for Playwright. */
async function editNoteAndBlur(page, newText) {
  const input = page.locator(SELECTORS.enlargedNoteInput);
  await input.fill(newText);
  await input.blur();
}

/** Delete the open note. With a single note the view collapses back to the
 *  list; otherwise it moves on to a neighbouring note. */
async function deleteCurrentNote(page, { expectCollapse = true } = {}) {
  await page.locator(SELECTORS.enlargedDelete).click();
  if (expectCollapse) {
    await page.locator(SELECTORS.enlarged).waitFor({ state: 'detached', timeout: 5000 });
  }
}

// ---------------------------------------------------------------------------
// Export / import (src/export.ts, src/import.ts)
// ---------------------------------------------------------------------------

/** Click "export" and wait for the resulting browser download. */
async function exportAndGetDownload(context, page) {
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 10000 }),
    page.locator(SELECTORS.btnExport).click(),
  ]);
  return download;
}

/** Click "export" on an empty domain and capture the resulting
 *  `alert("nothing to export")` (§5 #7). Dismisses the dialog and returns its
 *  message. */
async function exportAndGetEmptyAlert(page) {
  const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
  await page.locator(SELECTORS.btnExport).click();
  const dialog = await dialogPromise;
  const message = dialog.message();
  await dialog.dismiss();
  return message;
}

/** Click "import", pick `filePath` from the native file chooser, and wait for
 *  the round trip to settle (sidebar re-render / confirm dialog, if any). */
async function importFile(page, filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.locator(SELECTORS.btnImport).click(),
  ]);
  await chooser.setFiles(filePath);
}

module.exports = {
  SELECTORS,
  EXTENSION_PATH,
  FIXTURES_DIR,
  startFileServer,
  stopFileServer,
  launchWithExtension,
  getServiceWorker,
  installClosedShadowOpener,
  activateExtension,
  clickExtensionIcon,
  clearExtensionStorage,
  enterAddMode,
  placeSelectionBox,
  dragResizeZone,
  typeAddModeNote,
  clickAddModeSave,
  clickAddModeCancel,
  captureFeedbackItem,
  openThumbnail,
  editNoteAndClose,
  editNoteAndBlur,
  deleteCurrentNote,
  exportAndGetDownload,
  exportAndGetEmptyAlert,
  importFile,
};
