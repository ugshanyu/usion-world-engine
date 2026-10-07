// node browser-bench.cjs — Chromium (1x/4x/6x CPU) and WebKit, same scene as Node.
const { chromium, webkit } = require('/Users/ugshanyu/usion-sketchbook/node_modules/playwright');
const URL = 'http://127.0.0.1:4199/page.html';
(async () => {
  const out = [];
  for (const [name, type, rates] of [['chromium', chromium, [1, 4, 6]], ['webkit', webkit, [1]]]) {
    const browser = await type.launch();
    for (const rate of rates) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => { throw new Error(name + ' pageerror: ' + e.message); });
      if (rate > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate }); }
      await page.goto(URL);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
      const initMs = await page.evaluate(() => window.__initMs);
      const det = await page.evaluate(() => window.__runSpike('det', 300));
      const client = await page.evaluate(() => window.__runSpike('client', 600));
      out.push({ engine: name, cpuSlowdown: rate, initMs: Math.round(initMs), detHash: det.hash,
        clientAvgMs: client.avgMs, clientP95Ms: client.p95Ms, clientMaxMs: client.maxMs, clientBuildMs: client.buildMs, clientHash: client.hash });
      await page.close();
    }
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
