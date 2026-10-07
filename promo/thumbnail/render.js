const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await p.goto('file://' + __dirname + '/thumb.html');
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: __dirname + '/salamander-thumbnail.jpg', type: 'jpeg', quality: 92 });
  await b.close();
})();
