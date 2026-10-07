/**
 * Cross-engine determinism check: the same 8-player match (Rapier physics,
 * obstacles, rolling balls, scripted inputs) must produce the same hash in
 * Node, Chromium (Android) and WebKit (iPhone). If they ever disagree, phones
 * would mispredict and constantly correct.
 *
 *   node scripts/check-determinism.cjs
 *
 * Needs Playwright with chromium + webkit installed (`npx playwright install
 * chromium webkit`); set PLAYWRIGHT_PATH to where the playwright package lives
 * if it is not resolvable from here.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const { chromium, webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  const R = (await import('@dimforge/rapier3d-deterministic-compat')).default;
  await R.init();
  const { runDeterminismMatch } = await import(path.join(ROOT, 'test/fixtures/determinism-course.js'));
  const results = { node: runDeterminismMatch(R) };

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/test/browser/determinism.html`;
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch();
    const page = await browser.newPage();
    await page.goto(url);
    const out = await page.waitForFunction(() => window.__result, null, { timeout: 120000 }).then(h => h.jsonValue());
    results[name] = out.error ? 'ERROR ' + out.error : out.hash;
    await browser.close();
  }
  server.close();

  const hashes = new Set(Object.values(results));
  for (const [k, v] of Object.entries(results)) console.log(k.padEnd(9), v);
  if (hashes.size !== 1) { console.error('✗ engines disagree'); process.exit(1); }
  console.log('✓ identical on every engine');
})().catch((err) => { console.error(err); process.exit(1); });
