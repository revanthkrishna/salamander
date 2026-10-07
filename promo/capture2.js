// Records the real extension as footage: every frame Chrome composites, with
// its timestamp, while a scripted (human-paced) cursor drives it. Every action
// is scheduled against the film's beat grid, so the footage plays back 1:1
// and still lands on the music.
//
// Output: public/take/<take>/<n>.jpg, public/take/takes.json (frame times,
// cursor log, rects), public/take/feedback.md, public/take/shot-<n>.png
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = path.resolve(__dirname, '..');
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright'));
const h = require(path.join(REPO, 'tests', 'helpers', 'extension.js'));
const { unzipSync, strFromU8 } = require(path.join(REPO, 'node_modules', 'fflate'));
const S = h.SELECTORS;

const OUT = path.join(__dirname, 'public', 'take');
const VW = 1600, VH = 880;
const BEAT = 0.51291; // music5.mp3: 116.98 bpm
const B = (n) => 0.065 + n * BEAT; // film seconds of beat n (the track's first beat is at 0.065s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Minimum-jerk profile: how a hand moves a mouse (peak speed 1.9x the mean, vs 3x for cubic in-out).
const ease = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

function serve() {
  const html = fs.readFileSync(path.join(__dirname, 'site', 'index.html'));
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/favicon')) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }).listen(0, () => resolve(srv));
  });
}
const rect = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no rect: ' + sel);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};
const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const port = srv.address().port;
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: VW, height: VH },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`,
      `--host-resolver-rules=MAP orbit.example 127.0.0.1:${port}`,
      '--no-sandbox', '--hide-scrollbars',
    ],
  });
  if (ctx.serviceWorkers().length === 0) await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const sw = await h.getServiceWorker(ctx);
  await h.installClosedShadowOpener(sw);
  const URL = 'http://orbit.example/pricing';
  const meta = { viewport: { w: VW, h: VH }, rects: {}, takes: {} };

  // ── Dry run: measure the layout with the sidebar open ───────────────────
  {
    const p = await ctx.newPage();
    await p.goto(URL);
    await p.waitForLoadState('networkidle');
    for (const id of ['cta-business', 'typo', 'stat-events']) meta.rects[`${id}@closed`] = await rect(p, '#' + id);
    await h.activateExtension(ctx, p);
    await sleep(500);
    for (const id of ['cta-business', 'typo', 'stat-events']) meta.rects[id] = await rect(p, '#' + id);
    meta.rects.sidebar = await rect(p, S.sidebar);
    meta.rects.btnAdd = await rect(p, S.btnAdd);
    meta.rects.btnExport = await rect(p, S.btnExport);
    // The misspelt word itself, for the underline.
    meta.rects.word = await p.evaluate(() => {
      const t = document.getElementById('typo').firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 7);
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    await p.close();
  }

  // ── The take page: content script injected, not yet activated ───────────
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForLoadState('networkidle');
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, URL);
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
    // Capture-only: DevTools-protocol pointer moves report zero coordinates
    // for their coalesced samples; with none, add mode uses each event's own
    // position (its normal fallback). Real mice never hit this.
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { PointerEvent.prototype.getCoalescedEvents = function () { return []; }; } });
    if (!globalThis.__salDl) {
      globalThis.__salDl = [];
      const orig = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = (o, cb) => { globalThis.__salDl.push({ url: o.url, filename: o.filename }); return orig(o, cb); };
    }
  }, tabId);
  await page.mouse.move(900, 760);

  const cdp = await ctx.newCDPSession(page);
  let take = null; // { name, t0, frames: [], log: [], dir, n }
  const writes = [];
  cdp.on('Page.screencastFrame', (e) => {
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    if (!take) return;
    const n = take.n++;
    take.frames.push(+(e.metadata.timestamp - take.t0).toFixed(4));
    writes.push(fs.promises.writeFile(path.join(take.dir, `${n}.jpg`), Buffer.from(e.data, 'base64')));
  });

  let cur = { x: 900, y: 760 };
  const now = () => Date.now() / 1000 - take.t0;
  const until = async (t) => { const ms = (take.t0 + t) * 1000 - Date.now(); if (ms > 0) await sleep(ms); };
  const log = (kind, extra = {}) => take.log.push({ t: +now().toFixed(4), x: +cur.x.toFixed(1), y: +cur.y.toFixed(1), kind, ...extra });
  const real = (p) => ({ x: Math.min(VW - 1, Math.max(0, p.x)), y: Math.min(VH - 1, Math.max(0, p.y)) });
  async function moveTo(to, t1, t2, extra = {}) {
    await until(t1);
    const from = { ...cur };
    for (;;) {
      const k = Math.min(1, (now() - t1) / (t2 - t1));
      const e = ease(Math.max(0, k));
      cur = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      if (cur.y >= 0) { const r = real(cur); await page.mouse.move(r.x, r.y); }
      log('move', extra);
      if (k >= 1) break;
      await sleep(14);
    }
  }
  async function pathAlong(fn, t1, t2, extra = {}) {
    await until(t1);
    for (;;) {
      const k = Math.min(1, (now() - t1) / (t2 - t1));
      cur = fn(k);
      await page.mouse.move(cur.x, cur.y);
      log('move', extra);
      if (k >= 1) break;
      await sleep(14);
    }
  }
  async function click(t, extra = {}) {
    await until(t);
    if (cur.y >= 0) await page.mouse.down();
    log('down', extra);
    await sleep(70);
    if (cur.y >= 0) await page.mouse.up();
    log('up', extra);
  }
  async function typeText(text, t1, t2) {
    for (let i = 0; i < text.length; i++) {
      await until(t1 + ((t2 - t1) * i) / text.length);
      await page.keyboard.type(text[i]);
    }
    log('typed', { text });
  }
  async function key(k, t) { await until(t); await page.keyboard.press(k); log('key', { key: k }); }
  async function startTake(name, filmStart, speed = 1) {
    const dir = path.join(OUT, name);
    fs.mkdirSync(dir, { recursive: true });
    take = { name, t0: Date.now() / 1000, frames: [], log: [], dir, n: 0, filmStart, speed };
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VW * 2, maxHeight: VH * 2, everyNthFrame: 1 });
    log('start');
  }
  async function endTake(t) {
    await until(t);
    log('end');
    await cdp.send('Page.stopScreencast');
    await sleep(150);
    meta.takes[take.name] = { filmStart: take.filmStart, speed: take.speed, duration: +now().toFixed(3), frames: take.frames, log: take.log };
    take = null;
  }
  const ring = (box) => (k) => {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, rx = box.w / 2 - 44, ry = box.h / 2 - 20;
    const a = -Math.PI * 0.62 + k * Math.PI * 2.12;
    const wob = 1 + 0.03 * Math.sin(k * 40 * 0.7);
    return { x: cx + Math.cos(a) * rx * wob, y: cy + Math.sin(a) * ry * wob };
  };
  const boxAround = (r, px, pt, pb = pt) => ({ x: r.x - px, y: r.y - pt, w: r.w + px * 2, h: r.h + pt + pb });
  const R = meta.rects;
  const ctaBox = boxAround(R['cta-business'], 22, 16);
  const typoBox = boxAround(R.typo, 40, 10, 32);
  const statBox = boxAround(R['stat-events'], 14, 12);
  Object.assign(R, { ctaBox, typoBox, statBox });

  // ── One continuous take, 1:1 with the film from FILM_START ────────────
  // One calm cadence for every extension action: a discrete action (click,
  // placement, save) every 2 beats, cursor travel ~0.5s on a smooth ease with
  // a short rest before each click, clicks on beats or half beats. Only the
  // typing inside the comment box is fast (60 chars/s, real keystrokes). The
  // window lands at beat 21; the box placement on the typo lands on the drop
  // (beat 32). The footage plays back 1:1.
  const FILM_START = B(20.8);
  const CPS = 60;
  const typeFast = (text, t1) => typeText(text, t1, t1 + text.length / CPS);
  // Comment-box geometry for the default box at these click points (fixed:
  // same viewport, same click), so nothing is measured mid-take.
  const TYPO_INPUT = { x: 341.5, y: 319, w: 284, h: 88 };
  const TYPO_SAVE = { x: 573.59, y: 413, w: 51.91, h: 30 };
  const CTA_SAVE = { x: 1117.59, y: 804, w: 51.91, h: 30 };
  {
    const b = (n) => B(n) - FILM_START;
    const s = (t) => t - FILM_START; // film seconds → take seconds
    await page.mouse.move(1180, 300);
    cur = { x: 1180, y: 300 };
    await startTake('t1', FILM_START, 1);
    // Launch: at rest while the window lands and the camera pushes in on the
    // toolbar, then a reach to the extension icon.
    const icon = { x: VW - 26, y: -22 };
    await moveTo(icon, s(12.70), s(13.25), { virtual: true });
    await until(b(26));
    log('down', { virtual: true }); await sleep(60); log('up', { virtual: true });
    sw.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE', tabId }, () => void chrome.runtime.lastError), tabId);

    // Add note (turns yellow); it rests there a beat, then the preview box
    // follows the cursor to the typo, placed with a click on the drop.
    await moveTo(mid(R.btnAdd), s(13.80), s(14.32));
    await click(b(28));
    await moveTo({ x: R.typo.x + R.typo.w / 2, y: R.typo.y + R.typo.h / 2 + 26 }, s(15.70), s(16.32));
    await click(b(32));
    const w = R.word;
    const under = (k) => {
      // left to right with a wobble, then a quick pass back a little lower
      const y0 = w.y + w.h + 3;
      if (k < 0.62) { const u = k / 0.62; return { x: w.x - 4 + (w.w + 8) * u, y: y0 + Math.sin(u * Math.PI * 5) * 1.6 }; }
      const u = (k - 0.62) / 0.38; return { x: w.x + w.w + 4 - (w.w + 6) * u, y: y0 + 4 + Math.sin(u * Math.PI * 3) * 1.4 };
    };
    await moveTo(under(0), s(16.62), s(16.80), { pencil: true });
    await until(s(16.82)); await page.mouse.down(); log('down', { pencil: true });
    await pathAlong(under, s(16.82), s(17.40), { pencil: true });
    await page.mouse.up(); log('up', { pencil: true });
    // A stroke moves focus to the drawing; click back into the note.
    await moveTo({ x: TYPO_INPUT.x + TYPO_INPUT.w * 0.62, y: TYPO_INPUT.y + 36 }, s(17.46), s(17.70));
    await click(b(34.5));
    await typeFast('typo: should be “receive”', s(17.90));
    await moveTo(mid(TYPO_SAVE), s(18.42), s(18.68));
    await click(b(36.5));

    // Note 2, the button.
    await moveTo(mid(R.btnAdd), s(19.00), s(19.55));
    await click(b(38.5));
    await moveTo(mid(R['cta-business']), s(20.08), s(20.62));
    await click(b(40.5));
    await typeFast('make this button match the others', s(20.95));
    await moveTo(mid(CTA_SAVE), s(21.56), s(21.78));
    await click(b(42.5));
    R.item1 = await rect(page, `${S.thumbnailList} > li:nth-child(1)`);

    // Browse: one pass over the list (it magnifies under the cursor); then export.
    const pitch = 154; // list row pitch
    const at = (n) => ({ x: R.item1.x + R.item1.w * 0.42, y: R.item1.y + R.item1.h * 0.45 + (n - 1) * pitch });
    await moveTo(at(2), s(22.02), s(22.50));
    await moveTo(at(1), s(22.80), s(23.25));
    await moveTo(mid(R.btnExport), s(23.48), s(23.82));
    await click(b(46.5));
    await endTake(b(47.8));
    R.item2 = await rect(page, `${S.thumbnailList} > li:nth-child(2)`);
    console.log('item1', JSON.stringify(R.item1), 'item2', JSON.stringify(R.item2));
  }

  await Promise.all(writes);
  // Stills for the share scene.
  await page.mouse.move(20, 860);
  await sleep(900);
  for (const n of [1, 2]) {
    const r = R[`item${n}`];
    await page.screenshot({ path: path.join(OUT, `item-${n}.png`), clip: { x: r.x - 2, y: r.y - 2, width: r.w + 4, height: r.h + 4 } });
  }
  const dl = await sw.evaluate(() => globalThis.__salDl[globalThis.__salDl.length - 1]);
  const zip = Buffer.from(dl.url.slice(dl.url.indexOf(',') + 1), 'base64');
  const files = unzipSync(zip);
  meta.exportName = dl.filename;
  for (const [k, v] of Object.entries(files)) {
    if (k.endsWith('feedback.md')) fs.writeFileSync(path.join(OUT, 'feedback.md'), strFromU8(v));
    const m = k.match(/screenshots\/(\d+)\.png$/);
    if (m) fs.writeFileSync(path.join(OUT, `shot-${m[1]}.png`), Buffer.from(v));
  }
  fs.writeFileSync(path.join(OUT, 'takes.json'), JSON.stringify(meta));
  for (const [k, t] of Object.entries(meta.takes)) {
    const f = t.frames;
    console.log(k, 'frames', f.length, 'dur', t.duration, 'fps', (f.length / (f[f.length - 1] - f[0])).toFixed(1));
  }
  console.log('export', meta.exportName, Object.keys(files).join(', '));
  await ctx.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
