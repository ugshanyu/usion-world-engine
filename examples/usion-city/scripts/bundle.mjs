/**
 * Build the deployable artifacts.
 *
 *   dist/server.mjs      the server with @usions/world-engine inlined
 *   client/usion-world.js  the browser engine bundle, served from our origin
 *
 * Why bundle: the engine lives in this monorepo as a `file:` dependency, and
 * a host like Railway only ever receives THIS directory. Inlining the engine
 * makes the deploy a plain `npm ci && npm start` with two real dependencies
 * (`ws`, `jose`). Both outputs are committed so a deploy never has to build
 * the engine first.
 *
 * Run `npm run build` after ANY change to the engine, mode.js or
 * server.js — `npm test` fails if the artifacts are stale.
 */
import { rollup } from 'rollup';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const enginePkg = join(root, '..', '..');
const check = process.argv.includes('--check');

const banner = `/* Usion City — built artifact. Source: examples/usion-city + the engine root.
 * Regenerate with: npm run build */`;

// Map the package's own subpath exports to files — rollup resolves relative
// imports on its own, but not the bare `@usions/world-engine/...` specifiers.
const ENGINE_ENTRIES = {
  '@usions/world-engine': join(enginePkg, 'src', 'core', 'index.js'),
  '@usions/world-engine/core': join(enginePkg, 'src', 'core', 'index.js'),
  '@usions/world-engine/server': join(enginePkg, 'src', 'server', 'index.js'),
  '@usions/world-engine/modes': join(enginePkg, 'src', 'modes', 'index.js'),
  '@usions/world-engine/worlds': join(enginePkg, 'src', 'worlds', 'index.js'),
};

const bundle = await rollup({
  input: join(root, 'server.js'),
  external: ['ws', 'jose', /^node:/],
  plugins: [{
    name: 'usion-world-engine',
    resolveId(source) {
      return ENGINE_ENTRIES[source] || null;
    },
  }],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
});
const { output } = await bundle.generate({ format: 'esm', banner });
await bundle.close();
const serverCode = output[0].code;

const engineBundle = await readFile(join(enginePkg, 'dist', 'usion-world.min.js'), 'utf8')
  .catch(() => {
    throw new Error('dist/usion-world.min.js is missing — run `npm run build` there first');
  });

const serverPath = join(root, 'dist', 'server.mjs');
const clientEnginePath = join(root, 'client', 'usion-world.js');

if (check) {
  const currentServer = await readFile(serverPath, 'utf8').catch(() => null);
  const currentEngine = await readFile(clientEnginePath, 'utf8').catch(() => null);
  const stale = [];
  if (currentServer !== serverCode) stale.push('dist/server.mjs');
  if (currentEngine !== engineBundle) stale.push('client/usion-world.js');
  if (stale.length) {
    console.error(`✗ stale build artifacts: ${stale.join(', ')} — run: npm run build`);
    process.exit(1);
  }
  console.log('✓ build artifacts are in sync');
} else {
  await mkdir(dirname(serverPath), { recursive: true });
  await writeFile(serverPath, serverCode);
  await writeFile(clientEnginePath, engineBundle);
  console.log('✓ built usion-city');
  console.log(`  dist/server.mjs        ${(serverCode.length / 1024).toFixed(1)} KB`);
  console.log(`  client/usion-world.js  ${(engineBundle.length / 1024).toFixed(1)} KB`);
}
