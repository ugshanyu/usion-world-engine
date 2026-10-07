// Can Rapier run inside the rooms-runtime sandbox (isolated-vm, 128 MB, JS intrinsics only)?
const ivm = require('isolated-vm');
const fs = require('fs');
const path = require('path');
const rapierSrc = fs.readFileSync(path.join(__dirname, '../node_modules/@dimforge/rapier3d-deterministic-compat/dist/rapier.cjs'), 'utf8');
const sceneSrc = fs.readFileSync(path.join(__dirname, '../scene.mjs'), 'utf8').replace(/^export /gm, '');

// Minimal UTF-8 TextDecoder (the sandbox exposes no Web APIs); Rapier only decodes error strings.
const TEXT_DECODER = `globalThis.TextDecoder = class { decode(u) { if (!u) return ''; let s = '', i = 0;
  while (i < u.length) { let c = u[i++]; if (c > 127) { const n = c > 239 ? 3 : c > 223 ? 2 : 1; c &= 63 >> n;
  for (let k = 0; k < n; k++) c = (c << 6) | (u[i++] & 63); } s += String.fromCodePoint(c); } return s; } };`;

(async () => {
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const ctx = isolate.createContextSync();
  const report = {};
  console.error("step: globals"); report.globals = ctx.evalSync(`JSON.stringify({ TextDecoder: typeof TextDecoder, WebAssembly: typeof WebAssembly,
    FinalizationRegistry: typeof FinalizationRegistry, performance: typeof performance })`);

  // 1. Without a TextDecoder polyfill.
  try { ctx.evalSync(`(function(module, exports){${rapierSrc}\n})({exports:{}}, {})`); report.loadWithoutPolyfill = 'ok'; }
  catch (e) { report.loadWithoutPolyfill = 'FAIL: ' + e.message; }

  console.error("step: polyfill+load", JSON.stringify(report));
  ctx.evalSync(TEXT_DECODER);
  // Rapier's internal step timers call performance.now(); the sandbox has no performance object.
  ctx.evalSync(`globalThis.performance = { now: () => Date.now() };`);
  // Async WebAssembly compilation never completes inside isolated-vm, so compile synchronously
  // and hand Rapier an already-resolved promise; its init then finishes in the microtask drain.
  ctx.evalSync(`WebAssembly.instantiate = (src, imports) => { const m = src instanceof WebAssembly.Module ? src : new WebAssembly.Module(src);
    const i = new WebAssembly.Instance(m, imports); return Promise.resolve(src instanceof WebAssembly.Module ? i : { instance: i, module: m }); };`);
  ctx.evalSync(`globalThis.module = { exports: {} }; (function(module, exports){${rapierSrc}\n})(module, module.exports); globalThis.R = module.exports;`);
  report.bundleChars = rapierSrc.length;

  console.error("step: init");
  // 3a. Sync-only world (how production calls hooks): start init, then poll with evalSync.
  ctx.evalSync(`globalThis.__ready = false; globalThis.__err = null; R.init().then(() => { __ready = true; }, (e) => { __err = String(e); });`);
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 5000) { ready = ctx.evalSync('__ready'); if (ready) break; await new Promise((r) => setTimeout(r, 10)); }
  report.initViaSyncPolling = ready ? `ok after ${Date.now() - t0} ms` : 'never resolved in 5 s; err=' + ctx.evalSync('__err');

  console.error("step: after init", JSON.stringify(report));
  if (ctx.evalSync("__ready")) {
    ctx.evalSync(sceneSrc.replace(/^import .*$/gm, '') + `\n;globalThis.__run = run;`);
    // Same runs as Node; Date.now has ms resolution only, so time the whole run.
    for (const [prof, ticks] of [['det', 300], ['server', 600]]) {
      const t = process.hrtime.bigint();
      const r = JSON.parse(ctx.evalSync(`JSON.stringify(__run(R, '${prof}', ${ticks}, () => Date.now()))`, { timeout: 120000 }));
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      report[prof] = { hash: r.hash, msPerTick: +(ms / ticks).toFixed(3) };
    }
    const hs = isolate.getHeapStatisticsSync();
    report.isolateHeapMB = +(hs.used_heap_size / 1048576).toFixed(1);
    report.isolateExternalMB = +(hs.externally_allocated_size / 1048576).toFixed(1);
    // One 200-player world kept alive (as a room would), then measured.
    ctx.evalSync(`globalThis.__s = buildWorld(R, PROFILES.server); for (let t = 0; t < 30; t++) step(__s, t);`, { timeout: 60000 });
    const hs2 = isolate.getHeapStatisticsSync();
    report.liveServerWorld = { heapMB: +(hs2.used_heap_size / 1048576).toFixed(1), externalMB: +(hs2.externally_allocated_size / 1048576).toFixed(1),
      rssMB: Math.round(process.memoryUsage().rss / 1048576) };
  }
  console.log(JSON.stringify(report, null, 1));
  isolate.dispose();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
