'use strict';

// Covers §1.7's round trip for a site whose screenshots are larger than
// Chrome's 64 MiB message ceiling: the import stages each screenshot in its
// own message and commits the notes after (src/messages.ts's import banner).
// A bundle with ~60 MB of incompressible PNGs (~80 MB once base64-encoded)
// used to fail as one message with the generic "import failed".

const { test, expect } = require('@playwright/test');
const { unzipSync, zipSync, strFromU8 } = require('fflate');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const helper = require('./helpers/extension');

const S = helper.SELECTORS;
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

// A minimal PNG encoder: random RGB pixels (incompressible), filter 0 per row.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function randomPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = width * 3 + 1;
  const raw = crypto.randomBytes(row * height);
  for (let y = 0; y < height; y++) raw[y * row] = 0;
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a bundle whose screenshots exceed 64 MiB imports, every note with its thumbnail', async () => {
  test.setTimeout(120000);
  const NOTES = 5;
  const page = await context.newPage();
  await page.goto(fileServer.baseUrl);
  await helper.activateExtension(context, page);
  for (let i = 1; i <= NOTES; i++) {
    await helper.captureFeedbackItem(page, { x: 60 + i * 20, y: 120 + i * 40, note: `large note ${i}`, expectedCount: i });
  }
  const download = await helper.exportAndGetDownload(context, page);
  const entries = unzipSync(fs.readFileSync(await download.path()));

  // Every screenshot swapped for a 2000x2000 random-pixel PNG (~12 MB each).
  const shots = Object.keys(entries).filter((name) => /^screenshots\/\d+\.png$/.test(name));
  expect(shots).toHaveLength(NOTES);
  let total = 0;
  for (const name of shots) {
    entries[name] = randomPng(2000, 2000);
    total += entries[name].length;
  }
  expect(Math.ceil(total / 3) * 4).toBeGreaterThan(64 * 1024 * 1024);
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'salamander-large-')), 'large.zip');
  fs.writeFileSync(zipPath, zipSync(entries, { level: 0 }));
  expect(strFromU8(entries['feedback.md'])).toContain('large note 1');

  const recipientContext = await helper.launchWithExtension();
  try {
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(fileServer.baseUrl);
    await helper.activateExtension(recipientContext, recipientPage);
    await expect(recipientPage.locator(S.emptyState)).toBeVisible();

    await helper.importFile(recipientPage, zipPath);

    await expect(recipientPage.locator(S.thumbnail)).toHaveCount(NOTES, { timeout: 60000 });
    await expect(recipientPage.locator(S.thumbnailNote).first()).toHaveText('large note 1');
    await expect(recipientPage.locator(S.notif)).toBeHidden();
    // Each thumbnail was rendered from its imported screenshot.
    const sizes = await recipientPage
      .locator(`${S.thumbnail} img`)
      .evaluateAll((imgs) => imgs.map((img) => [img.naturalWidth, img.naturalHeight]));
    expect(sizes).toHaveLength(NOTES);
    for (const [w, h] of sizes) expect([w, h]).toEqual([480, 480]);
  } finally {
    await recipientContext.close();
  }
});
