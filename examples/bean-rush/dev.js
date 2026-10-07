/**
 * Local dev harness.
 *
 * Boots the real world server on :3050 with a self-signed keypair (so no
 * backend is needed), serves the real client, and shims the two calls that
 * normally go through the platform: `joinWorld` (placement) and
 * `_fetchDirectAccess` (token minting). The SDK still loads from
 * usions.com, exactly as it does in production.
 *
 *   npm run dev
 *   open http://localhost:3050            (random player id)
 *   open http://localhost:3050/?player=bob&lang=mn
 *
 * Two browser tabs = two players in the same race.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { startBeanRush, WORLD_SPEC } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ID = 'bean-rush';
const ROOM_ID = 'dev-bean-rush';
const PORT = Number(process.env.PORT || 3050);

const clientHtml = await readFile(join(here, 'client', 'index.html'), 'utf8');
// Dev serves the engine straight from the repo build (run `npm run build` in
// the repo root after engine changes) and Rapier from node_modules.
const engineBundle = await readFile(join(here, '..', '..', 'dist', 'usion-world.js'), 'utf8');
const rapierModule = await readFile(join(here, 'node_modules', '@dimforge', 'rapier3d-deterministic-compat', 'dist', 'rapier.mjs'), 'utf8');

const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const publicKeyPem = await exportSPKI(publicKey);

async function mintToken(playerId, name, sessionId) {
  return new SignJWT({
    room_id: ROOM_ID, service_id: SERVICE_ID, session_id: sessionId,
    permissions: ['play'], jti: randomUUID(), name,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'game-access-v1' })
    .setIssuer('usion-backend')
    .setAudience(`usion-game-service:${SERVICE_ID}`)
    .setSubject(playerId)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(privateKey);
}

function shimFor(dev) {
  return `<script>(function () {
  var DEV = ${JSON.stringify(dev)};
  Usion.game.joinWorld = function () {
    Usion.game.roomId = DEV.roomId;
    return Promise.resolve({ roomId: DEV.roomId, playerIds: [] });
  };
  Usion.game._fetchDirectAccess = function () {
    Usion.game.roomId = DEV.roomId;
    Usion.game.playerId = DEV.playerId;
    return Promise.resolve({ ws_url: DEV.wsUrl, access_token: DEV.token,
      session_id: DEV.sessionId, protocol_version: '2' });
  };
  var config = { userId: DEV.playerId, userName: DEV.name, theme: DEV.theme,
    language: DEV.lang, serviceId: DEV.serviceId, mode: 'single', balance: 0 };
  var kick = function () { if (!Usion._initialized) window.postMessage({ type: 'INIT', config: config }, '*'); };
  setTimeout(kick, 0); setTimeout(kick, 250); setTimeout(kick, 1000);
})();</script>`;
}

const server = await startBeanRush({
  port: PORT,
  publicKeyPem,
  logLevel: 'info',
  staticDir: null,          // dev.js serves the client itself so it can inject
  onRequest: null,
});

// The world server owns the port; wrap its HTTP handling with the dev pages.
const http = server.httpServer;
http.removeAllListeners('request');
http.on('request', async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname === '/usion-world.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(engineBundle);
    return;
  }
  if (url.pathname === '/preview') {
    // Dev-only course preview: renders the course (no server, no physics)
    // from a camera spot — ?x=&y=&z=&tx=&ty=&tz= — for screenshots and
    // level design. Obstacles are posed at ?t= seconds.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(previewPage(WORLD_SPEC.manifest));
    return;
  }
  if (url.pathname === '/rapier.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
    res.end(rapierModule);
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', dev: true, rooms: server.rooms.size }));
    return;
  }
  if (url.pathname === '/') {
    const playerId = (url.searchParams.get('player') || `dev-${Math.random().toString(36).slice(2, 8)}`).slice(0, 40);
    const sessionId = `sess-${randomUUID()}`;
    const dev = {
      playerId,
      name: url.searchParams.get('name') || playerId,
      theme: url.searchParams.get('theme') === 'light' ? 'light' : 'dark',
      lang: url.searchParams.get('lang') || 'en',
      roomId: ROOM_ID,
      serviceId: SERVICE_ID,
      sessionId,
      wsUrl: `ws://localhost:${PORT}/ws`,
      token: await mintToken(playerId, playerId, sessionId),
    };
    // The shim must run AFTER the SDK script tag, so append it at </head>.
    const page = clientHtml.replace('</head>', `${shimFor(dev)}\n</head>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

console.log(`[bean-rush] dev server  http://localhost:${PORT}  — open two tabs for two players`);

function previewPage(manifest) {
  return `<!doctype html><meta charset="utf-8"><title>Bean Rush preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden}canvas{width:100%;height:100%;display:block}</style>
<script src="https://usions.com/vendor/babylon/9.16.1/babylon.js"></script>
<script src="/usion-world.js"></script>
<canvas id="c"></canvas>
<script>
  const q = new URLSearchParams(location.search);
  const n = (k, d) => Number(q.get(k) ?? d);
  const manifest = ${JSON.stringify(manifest)};
  const world = UsionWorld.buildWorld(manifest);
  const t = n('t', 1.3);
  UsionWorld.updateMovers(world.movers, t);
  const r = UsionWorld.createRenderer(document.getElementById('c'), world.manifest, {
    avatar: 'bean', playerColors: ['#ff4f8b', '#7a5cff', '#2fcf9b', '#ff8a3d'], rollerColor: '#ff4f8b', fogDensity: 0.0012,
  });
  r.camera.position.set(n('x', 0), n('y', 8), n('z', -20));
  r.camera.setTarget(new BABYLON.Vector3(n('tx', 0), n('ty', 0), n('tz', 10)));
  const beans = [[0, 0, -9], [3, 0, 20], [-2, 0, 85], [1, 0, 120], [0, 0, 145], [2, 2.5, 192], [-1, 7, 236]]
    .map(([x, y, z], i) => ({ id: 'b' + i, k: 'p', wx: x, wy: y, wz: z, a: 0, hp: 100, s: 'run' }));
  const balls = [[-3.2, 4.6, 200], [3.2, 2.2, 188]].map(([x, y, z], i) => ({ id: 'o' + i, k: 'o', wx: x, wy: y, wz: z, r: 1 }));
  // Babylon compiles shaders asynchronously: keep rendering until the scene is
  // ready and has drawn a few frames, then signal screenshot tools.
  let frames = 0;
  r.engine.runRenderLoop(() => {
    r.render({ entities: beans.concat(balls), movers: world.movers, time: t, dt: 0.016 });
    if (r.scene.isReady() && ++frames > 20) window.__ready = true;
  });
</script>`;
}
