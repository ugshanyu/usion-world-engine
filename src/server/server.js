/**
 * createWorldServer — a complete developer-hosted (direct-mode) world server.
 *
 * You give it a world spec and a mode; it gives you an authoritative,
 * massively-multiplayer game server that speaks the Usion SDK's direct-mode
 * protocol: RS256 token verification against the platform JWKS, world rooms
 * keyed by the token's room_id, a fixed-tick simulation, per-observer AOI
 * snapshots, rate limits, keepalives and graceful shutdown.
 *
 *   import { createWorldServer } from '@usions/world-engine/server';
 *
 *   const server = await createWorldServer({
 *     serviceId: 'usion-city',
 *     worldSpec: { generator: 'city', options: { seed: 7, blocks: 6 } },
 *     mode: { id: 'race', laps: 2 },
 *     staticDir: './client',            // serves the game client too
 *     physics: 'rapier',                // optional: real meshes, character controller, rolling balls
 *   });
 *
 * Deploying to Railway/Fly/EC2 is then just `node server.js` with
 * `SERVICE_ID` and `USION_API_URL` set.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { createVerifier } from './auth.js';
import { createGate, sendError } from './net.js';
import { WorldRoom } from './room.js';
import { buildManifest } from '../worlds/index.js';
import { createMode } from '../modes/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const EMPTY_ROOM_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function createLogger(level) {
  const min = LEVELS[level] ?? LEVELS.info;
  return (lvl, msg, fields) => {
    if ((LEVELS[lvl] ?? LEVELS.info) < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(fields || {}) });
    (lvl === 'error' ? console.error : console.log)(line);
  };
}

export async function createWorldServer(options = {}) {
  const env = process.env;
  const apiUrl = String(options.apiUrl ?? env.USION_API_URL ?? 'https://mobile.mongolai.mn').replace(/\/$/, '');
  const cfg = {
    port: options.port ?? Number(env.PORT || 3030),
    serviceId: options.serviceId ?? env.SERVICE_ID ?? 'usion-world',
    apiUrl,
    jwksUrl: options.jwksUrl ?? env.JWKS_URL ?? `${apiUrl}/.well-known/jwks.json`,
    publicKeyPem: options.publicKeyPem ?? env.PUBLIC_KEY_PEM ?? null,
    logLevel: options.logLevel ?? env.LOG_LEVEL ?? 'info',
    idleFrameMs: options.idleFrameMs ?? Number(env.IDLE_FRAME_MS || 15_000),
    tickHz: options.tickHz ?? Number(env.TICK_HZ || 30),
    snapshotHz: options.snapshotHz ?? Number(env.SNAPSHOT_HZ || 15),
    aoiRadius: options.aoiRadius ?? Number(env.AOI_RADIUS || 150),
    maxPlayers: options.maxPlayers ?? Number(env.MAX_PLAYERS || 200),
    seed: options.seed ?? (env.WORLD_SEED ? Number(env.WORLD_SEED) : 12345),
    staticDir: options.staticDir ?? env.STATIC_DIR ?? null,
    graceMs: options.graceMs ?? Number(env.GRACE_MS || 15_000),
    maxEntities: options.maxEntities ?? Number(env.MAX_ENTITIES || 96),
  };
  const log = createLogger(cfg.logLevel);
  const startedAt = Date.now();

  const worldSpec = options.worldSpec || { generator: 'city', options: { seed: cfg.seed } };
  const manifest = buildManifest(worldSpec);
  const modeSpec = options.mode || 'freeroam';
  const rapier = options.rapier || (options.physics === 'rapier' ? await loadRapier() : null);

  const verifier = options.verifier || createVerifier({
    serviceId: cfg.serviceId,
    jwksUrl: cfg.publicKeyPem ? null : cfg.jwksUrl,
    publicKeyPem: cfg.publicKeyPem,
  });

  /** @type {Map<string, WorldRoom>} */
  const rooms = new Map();
  const getRoom = (roomId) => rooms.get(roomId);
  const totalPlayers = () => [...rooms.values()].reduce((n, r) => n + r.playerCount, 0);

  function requestJoin(ws, conn) {
    const session = conn.session;
    let room = rooms.get(session.roomId);
    if (!room) {
      room = new WorldRoom({
        roomId: session.roomId,
        manifest,
        worldSpec,
        mode: createMode(modeSpec),
        simConfig: options.simConfig,
        tickHz: cfg.tickHz,
        snapshotHz: cfg.snapshotHz,
        aoiRadius: cfg.aoiRadius,
        maxPlayers: cfg.maxPlayers,
        seed: cfg.seed,
        rapier,
        graceMs: cfg.graceMs,
        maxEntities: cfg.maxEntities,
        log,
      });
      if (options.onRoomCreated) options.onRoomCreated(room);
      rooms.set(session.roomId, room);
      log('info', 'world created', { room: session.roomId, rooms: rooms.size });
    }
    const res = room.admit(session, ws);
    if (!res.ok) {
      sendError(ws, res.code, 'World room is full');
      return;
    }
    conn.joined = true;
  }

  const gate = createGate({ verifier, getRoom, requestJoin, log, idleFrameMs: cfg.idleFrameMs });

  const httpServer = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: cfg.serviceId,
        engine: 'usion-world',
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        rooms: rooms.size,
        players: totalPlayers(),
        connections: gate.connectionCount(),
        sim_hz: cfg.tickHz,
        snapshot_hz: cfg.snapshotHz,
        aoi_radius: cfg.aoiRadius,
        max_players: cfg.maxPlayers,
        world: worldSpec,
      }));
      return;
    }
    if (req.method === 'GET' && path === '/world.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(worldSpec));
      return;
    }
    if (cfg.staticDir && req.method === 'GET') {
      serveStatic(cfg.staticDir, path, res).catch(() => notFound(res));
      return;
    }
    notFound(res);
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '/').split('?')[0];
    if (pathname !== '/ws' && pathname !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => gate.handleConnection(ws, request));
  });

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (room.playerCount === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        room.destroy();
        rooms.delete(roomId);
        log('info', 'empty world swept', { room: roomId, rooms: rooms.size });
      }
    }
    log('info', 'stats', { rooms: rooms.size, players: totalPlayers(), connections: gate.connectionCount() });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    // Worlds persist conceptually across deploys (the platform re-places
    // players), so shutdown just stops the loops and closes sockets cleanly.
    for (const room of rooms.values()) room.destroy(1001, 'server restarting');
    rooms.clear();
    gate.close(1001, 'server restarting');
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
    log('info', 'server closed');
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, () => resolve());
  });
  const boundPort = httpServer.address().port;
  log('info', 'usion world server listening', {
    port: boundPort,
    service: cfg.serviceId,
    auth: cfg.publicKeyPem ? 'PUBLIC_KEY_PEM (local)' : cfg.jwksUrl,
    world: worldSpec.generator || 'manifest',
    mode: typeof modeSpec === 'string' ? modeSpec : (modeSpec.id || modeSpec.name || 'custom'),
    sim_hz: cfg.tickHz,
    snapshot_hz: cfg.snapshotHz,
    solids: manifest.solids.length,
    movers: manifest.movers.length,
    physics: rapier ? 'rapier' : 'arcade',
  });

  return {
    port: boundPort,
    close,
    rooms,
    httpServer,          // exposed so local dev harnesses can wrap the routes
    manifest,
    worldSpec,
    config: cfg,
    playerCount: totalPlayers,
  };
}

/** Load and initialise the deterministic Rapier build (optional dependency). */
async function loadRapier() {
  const mod = await import('@dimforge/rapier3d-deterministic-compat');
  const R = mod.default || mod;
  await R.init();
  return R;
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

async function serveStatic(dir, urlPath, res) {
  // Normalise first, then reject anything that escapes the static root.
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const rel = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^[/\\]+/, '');
  const file = join(dir, rel);
  if (!file.startsWith(normalize(dir))) return notFound(res);
  const info = await stat(file).catch(() => null);
  const target = info && info.isDirectory() ? join(file, 'index.html') : file;
  const body = await readFile(target);
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': extname(target) === '.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(body);
}
