/**
 * Build the shipped artifacts.
 *
 *   dist/usion-world.js             readable browser bundle (window.UsionWorld)
 *   dist/usion-world.min.js         minified browser bundle — the file a game
 *                                   serves from its own origin
 *   dist/usion-world-engine.cjs.js  sandbox bundle for platform-hosted server
 *                                   bundles (window-free IIFE + module.exports)
 *
 * Run: npm run build
 *
 * Each game embeds the minified bundle itself (see examples/usion-city, whose
 * build step copies it into `client/`), so the engine depends on no CDN and
 * every game pins its own version.
 */
import { rollup } from 'rollup';
import terser from '@rollup/plugin-terser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const banner = `/*! @usions/world-engine v${version} — the Usion World Engine.
 * Deterministic world core shared by the server simulation and the client
 * prediction. Source: github.com/ugshanyu/usion-world-engine */`;

async function build(input, output, format, name, { minify = false, footer = '' } = {}) {
  const bundle = await rollup({
    input: join(root, input),
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      warn(warning);
    },
  });
  const { output: chunks } = await bundle.generate({
    format,
    name,
    banner,
    footer,
    exports: 'default',
    esModule: false,
    plugins: minify ? [terser({ format: { comments: /^!/ } })] : [],
  });
  await bundle.close();
  const code = chunks[0].code;
  await mkdir(dirname(join(root, output)), { recursive: true });
  await writeFile(join(root, output), code);
  return code;
}

const browserFooter = `
if (typeof window !== 'undefined') window.UsionWorld = UsionWorld;
else if (typeof globalThis !== 'undefined') globalThis.UsionWorld = UsionWorld;`;

const readable = await build('src/browser.js', 'dist/usion-world.js', 'iife', 'UsionWorld', {
  footer: browserFooter,
});
const minified = await build('src/browser.js', 'dist/usion-world.min.js', 'iife', 'UsionWorld', {
  minify: true, footer: browserFooter,
});

// The sandbox has no `window`, so the engine is published on `globalThis` and
// bundle authors append `module.exports = UsionWorldEngine.createWorldBundle(…)`.
const sandboxFooter = `
if (typeof globalThis !== 'undefined') globalThis.UsionWorldEngine = UsionWorldEngine;`;
const sandbox = await build('src/hosted/entry.js', 'dist/usion-world-engine.cjs.js', 'iife', 'UsionWorldEngine', {
  footer: sandboxFooter,
});

console.log(`✓ built v${version}`);
console.log(`  dist/usion-world.js             ${(readable.length / 1024).toFixed(1)} KB`);
console.log(`  dist/usion-world.min.js         ${(minified.length / 1024).toFixed(1)} KB`);
console.log(`  dist/usion-world-engine.cjs.js  ${(sandbox.length / 1024).toFixed(1)} KB`);
