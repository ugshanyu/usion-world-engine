// Cost of booting one room sandbox with Rapier (every room = a fresh isolate).
const ivm = require('isolated-vm'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../node_modules/@dimforge/rapier3d-deterministic-compat/dist/rapier.cjs'), 'utf8');
const t = fs.readFileSync(path.join(__dirname, 'ivm-test.cjs'), 'utf8');
const TD = t.match(/const TEXT_DECODER = `([\s\S]*?)`;/)[1];
const WASM = t.match(/ctx\.evalSync\(`(WebAssembly\.instantiate = [\s\S]*?)`\);/)[1];
const times = [];
for (let i = 0; i < 5; i++) {
  const t0 = process.hrtime.bigint();
  const iso = new ivm.Isolate({ memoryLimit: 128 }); const ctx = iso.createContextSync();
  ctx.evalSync(TD); ctx.evalSync('globalThis.performance={now:()=>Date.now()};'); ctx.evalSync(WASM);
  ctx.evalSync(`globalThis.module={exports:{}};(function(module,exports){${src}\n})(module,module.exports);globalThis.R=module.exports;globalThis.__ok=false;R.init().then(()=>{__ok=true});`);
  if (!ctx.evalSync('__ok')) throw new Error('init not done');
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  iso.dispose();
}
console.log('room boot ms:', times.map((x) => x.toFixed(0)).join(', '));
