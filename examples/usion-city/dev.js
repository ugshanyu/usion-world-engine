/**
 * Local dev harness.
 *
 * Boots the real world server on :3040 with a self-signed keypair (so no
 * backend is needed), serves the real client, and shims the two calls that
 * normally go through the platform: `joinWorld` (placement) and
 * `_fetchDirectAccess` (token minting). The SDK still loads from
 * usions.com, exactly as it does in production.
 *
 *   npm run dev
 *   open http://localhost:3040            (random player id)
 *   open http://localhost:3040/?player=bob&lang=mn
 *
 * Two browser tabs = two players in the same city.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { startCity } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ID = 'usion-city';
const ROOM_ID = 'dev-usion-city';
const PORT = Number(process.env.PORT || 3040);

const clientHtml = await readFile(join(here, 'client', 'index.html'), 'utf8');
const engineBundle = await readFile(join(here, 'client', 'usion-world.js'), 'utf8');

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

const server = await startCity({
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

console.log(`[usion-city] dev server  http://localhost:${PORT}  — open two tabs for two players`);
