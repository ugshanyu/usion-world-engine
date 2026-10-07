/* Usion City — built artifact. Source: examples/usion-city + the engine root.
 * Regenerate with: npm run build */
import { normalize, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { importSPKI, jwtVerify, createRemoteJWKSet } from 'jose';

/**
 * Access-token verification — the direct-mode auth contract.
 *
 * The PLATFORM mints short-lived RS256 tokens (backend/core/security.py
 * `create_game_access_token`) with claims: iss `usion-backend`,
 * aud `usion-game-service:<service_id>`, sub `<user_id>`, `room_id`,
 * `session_id`, `permissions ['play']`. A world server only VERIFIES — it
 * never issues tokens and never trusts anything the client says about its own
 * identity or which room it is in.
 *
 * Keys come from the platform JWKS. `publicKeyPem` replaces it for tests and
 * local dev so the whole loop runs with no backend.
 */

const JWKS_TIMEOUT_MS = 15000;
const JWKS_CACHE_MAX_AGE_MS = 300000;
const JWKS_COOLDOWN_MS = 1000;

function isKeyRotationError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  return (
    name === 'JWSSignatureVerificationFailed' ||
    name === 'JWKSNoMatchingKey' ||
    msg.includes('signature verification failed') ||
    msg.includes('no applicable key')
  );
}

function createVerifier({
  serviceId,
  jwksUrl = null,
  publicKeyPem = null,
  issuer = 'usion-backend',
  audiencePrefix = 'usion-game-service:',
}) {
  if (!serviceId) throw new Error('createVerifier: serviceId is required');
  if (!jwksUrl && !publicKeyPem) throw new Error('createVerifier: need jwksUrl or publicKeyPem');

  let remoteJwks = null;
  let localKeyPromise = null;

  function getRemoteJwks(forceRefresh = false) {
    if (forceRefresh || !remoteJwks) {
      remoteJwks = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: JWKS_TIMEOUT_MS,
        cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
      });
    }
    return remoteJwks;
  }

  const verifyOptions = {
    issuer,
    audience: `${audiencePrefix}${serviceId}`,  // a token minted for another game is rejected
    algorithms: ['RS256'],                      // RS256 only — no alg-confusion downgrade
    clockTolerance: 60,
  };

  async function verifyRaw(token) {
    if (publicKeyPem) {
      if (!localKeyPromise) localKeyPromise = importSPKI(publicKeyPem, 'RS256');
      return jwtVerify(token, await localKeyPromise, verifyOptions);
    }
    try {
      return await jwtVerify(token, getRemoteJwks(), verifyOptions);
    } catch (err) {
      // A backend restart can rotate key material under the same kid: refresh
      // the JWKS once before failing the player's connection.
      if (!isKeyRotationError(err)) throw err;
      return jwtVerify(token, getRemoteJwks(true), verifyOptions);
    }
  }

  return {
    async verify(token) {
      const { payload } = await verifyRaw(token);
      if (!Array.isArray(payload.permissions) || !payload.permissions.includes('play')) {
        throw new Error("Token missing 'play' permission");
      }
      if (!payload.sub) throw new Error('Token missing sub');
      if (!payload.room_id) throw new Error('Token missing room_id');
      if (!payload.session_id) throw new Error('Token missing session_id');
      if (payload.service_id && String(payload.service_id) !== serviceId) {
        throw new Error(`Token service_id mismatch: ${payload.service_id}`);
      }
      return {
        userId: String(payload.sub),
        name: String(payload.name || payload.preferred_username || payload.username || 'Player').slice(0, 24),
        roomId: String(payload.room_id),   // the PLATFORM owns membership — never the client envelope
        sessionId: String(payload.session_id),
        serviceId,
      };
    },
  };
}

/**
 * WebSocket protocol + per-connection gate.
 *
 * Wire contract = the SDK's direct mode (packages/sdk/src/modules/game-direct.js):
 *   client → server  {type, room_id, ts, seq, session_id, protocol_version, payload}
 *     types: join / leave / heartbeat / action / input / ping (+ rematch / forfeit)
 *   server → client  {type, payload}
 *     types: joined / player_joined / player_left / state_snapshot /
 *            state_delta / pong / match_end / error
 *
 * This module owns auth-on-connect, pre-auth buffering, rate and size limits,
 * ping/heartbeat, and the downstream idle keepalive. Game rules live in the
 * simulation; the roster and snapshots live in room.js.
 */
const MAX_FRAME_BYTES = 8 * 1024;
const RATE_LIMIT_PER_SECOND = 60;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_STALE = 4000;
const STALE_CONN_MS = 90_000;          // the SDK heartbeats every 25 s
const PRE_AUTH_BUFFER_MAX = 32;
const KEEPALIVE_SWEEP_MS = 1_000;

function sendFrame(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify({ type, payload: payload || {} }));
    ws._lastSentAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function sendError(ws, code, message) {
  return sendFrame(ws, 'error', { code, message });
}

function parseClientMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  return {
    type: msg.type,
    payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
  };
}

function createGate({ verifier, getRoom, requestJoin, log, idleFrameMs = 15_000 }) {
  const connections = new Map();

  function handleInputMessage(ws, conn, msg) {
    const room = getRoom(conn.session.roomId);
    if (!room || !conn.joined) return;
    const now = Date.now();
    const rate = conn.rate;
    if (now - rate.windowStart >= 1000) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count += 1;
    if (rate.count > RATE_LIMIT_PER_SECOND) {
      // Error frames are themselves throttled so a flood cannot amplify.
      if (now - rate.lastErrorAt > 1000) {
        rate.lastErrorAt = now;
        sendError(ws, 'RATE_LIMITED', `Input rate limit exceeded (${RATE_LIMIT_PER_SECOND}/s); dropping messages`);
      }
      return;
    }
    room.handleInput(conn.session.userId, msg.payload, msg.type);
  }

  function routeMessage(ws, conn, msg) {
    const session = conn.session;
    const room = getRoom(session.roomId);
    switch (msg.type) {
      case 'join':
        requestJoin(ws, conn);
        return;
      case 'action':
      case 'input':
        handleInputMessage(ws, conn, msg);
        return;
      case 'ping':
        sendFrame(ws, 'pong', { t: msg.payload.t ?? null, server_t: Date.now(), seq: room ? room.seq : 0 });
        // A ping carrying last_sequence is the SDK's resync request.
        if (room && conn.joined && msg.payload.last_sequence !== undefined) {
          room.sendResyncKeyframe(session.userId, Number(msg.payload.last_sequence) || 0);
        }
        return;
      case 'heartbeat':
        sendFrame(ws, 'state_delta', {
          seq: room ? room.seq : 0, event: 'heartbeat', data: { server_t: Date.now() },
        });
        return;
      case 'forfeit':
        // In a world, forfeit == leave: no winner, the world keeps playing.
        room?.removePlayer(session.userId, null, 'forfeit');
        conn.joined = false;
        return;
      case 'leave':
        room?.removePlayer(session.userId, null, 'left');
        conn.joined = false;
        try { ws.close(1000, 'left'); } catch { /* already closed */ }
        return;
        // Unknown types (including `rematch`, meaningless in a world) are ignored.
    }
  }

  function handleConnection(ws, req) {
    let token = null;
    try {
      token = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
    } catch { /* malformed url → treated as a missing token */ }
    const conn = {
      session: null,
      joined: false,
      buffered: [],
      rate: { windowStart: 0, count: 0, lastErrorAt: 0 },
      lastSeenAt: Date.now(),
    };
    connections.set(ws, conn);
    ws._lastSentAt = Date.now();

    ws.on('message', (data, isBinary) => {
      conn.lastSeenAt = Date.now();
      if (isBinary || (data?.length ?? 0) > MAX_FRAME_BYTES) {
        const now = Date.now();
        if (now - conn.rate.lastErrorAt > 1000) {
          conn.rate.lastErrorAt = now;
          sendError(ws, 'PAYLOAD_TOO_LARGE', `Frame exceeds ${MAX_FRAME_BYTES} bytes; dropped`);
        }
        return;
      }
      const msg = parseClientMessage(data);
      if (!msg) return;
      if (!conn.session) {
        // The SDK sends `join` the moment the socket opens, usually before
        // token verification finishes — buffer and replay once it clears.
        if (conn.buffered.length < PRE_AUTH_BUFFER_MAX) conn.buffered.push(msg);
        return;
      }
      routeMessage(ws, conn, msg);
    });

    ws.on('close', () => {
      connections.delete(ws);
      if (conn.session && conn.joined) {
        getRoom(conn.session.roomId)?.disconnectPlayer(conn.session.userId, ws);
      }
    });
    ws.on('error', () => { /* 'close' follows and cleans up */ });

    if (!token) {
      sendError(ws, 'NO_TOKEN', 'Missing access token');
      try { ws.close(CLOSE_UNAUTHORIZED, 'missing token'); } catch { /* gone */ }
      return;
    }
    verifier.verify(token)
      .then((session) => {
        if (ws.readyState !== 1) return;
        conn.session = session;
        log('debug', 'ws authenticated', { user: session.userId, room: session.roomId });
        const pending = conn.buffered;
        conn.buffered = [];
        for (const msg of pending) routeMessage(ws, conn, msg);
      })
      .catch((err) => {
        log('warn', 'ws auth failed', { reason: err?.message || String(err) });
        sendError(ws, 'INVALID_TOKEN', err?.message || 'Token verification failed');
        try { ws.close(CLOSE_UNAUTHORIZED, 'invalid token'); } catch { /* gone */ }
      });
  }

  // Some downstream frame at least every `idleFrameMs` per client, whatever
  // the game is doing: proxy edges (Railway, nginx) kill silently-downstream
  // connections after ~60 s and the client reconnect-loops forever.
  const sweepMs = Math.max(50, Math.min(KEEPALIVE_SWEEP_MS, Math.floor(idleFrameMs / 4)));
  const keepaliveTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws, conn] of connections) {
      if (ws.readyState > 1) { connections.delete(ws); continue; }
      if (now - conn.lastSeenAt > STALE_CONN_MS) {
        try { ws.close(CLOSE_STALE, 'stale connection'); } catch { /* gone */ }
        continue;
      }
      if (now - (ws._lastSentAt || 0) >= idleFrameMs) {
        const room = conn.session ? getRoom(conn.session.roomId) : null;
        sendFrame(ws, 'state_delta', { seq: room ? room.seq : 0, event: 'idle', data: { server_t: now } });
      }
    }
  }, sweepMs);
  keepaliveTimer.unref?.();

  return {
    handleConnection,
    connectionCount: () => connections.size,
    close(code = 1001, reason = 'server shutting down') {
      clearInterval(keepaliveTimer);
      for (const ws of connections.keys()) {
        try { ws.close(code, reason); } catch { /* gone */ }
      }
      connections.clear();
    },
  };
}

/**
 * Scalar math helpers for the world core.
 *
 * Everything here is allocation-free on purpose: the simulation steps up to
 * 200 players plus vehicles and projectiles 30×/s inside a sandboxed isolate,
 * so hot paths must not create garbage. Vectors are passed as loose scalars
 * (x, y, z) rather than objects.
 *
 * World space: X = east, Y = up, Z = north. Units are metres, seconds,
 * radians. Yaw 0 faces +Z and increases toward +X (Babylon's convention),
 * so forward = (sin(yaw), 0, cos(yaw)).
 */

const TAU = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Wrap an angle into (-PI, PI]. */
function wrapAngle(a) {
  return angleDelta(0, a);
}

/** Move `from` toward `to` by at most `maxStep` radians (shortest arc). */
function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (d > maxStep) return wrapAngle(from + maxStep);
  if (d < -maxStep) return wrapAngle(from - maxStep);
  return wrapAngle(to);
}

function length2(x, z) {
  return Math.sqrt(x * x + z * z);
}

function distSq2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Round to `dp` decimals — used to quantize network payloads. */
function q(value, dp = 2) {
  const m = dp === 2 ? 100 : Math.pow(10, dp);
  return Math.round(value * m) / m;
}

/**
 * Static collision world.
 *
 * The world is built from two convex primitives — yawed **boxes** (buildings,
 * walls, kerbs, crates, platforms) and yawed **ramps** (a box whose top is a
 * slope rising along its local +Z). Everything a GTA-style city needs is one
 * of those two, and keeping the set that small is what lets the same code run
 * in a sandboxed isolate at 30 Hz for 200 players.
 *
 * Solids live in a uniform XZ grid so a query touches a handful of candidates
 * instead of the whole city. Nothing here allocates per query except the
 * candidate array, which callers reuse.
 *
 *   box:  { kind:'box',  x, y, z, hx, hy, hz, ry?, tag? }   // centre + half-extents
 *   ramp: { kind:'ramp', x, y, z, hx, hy, hz, ry?, tag? }   // top rises along local +Z
 *
 * `y` is the CENTRE height. Use `boxAt`/`rampAt` if you'd rather think in
 * "sits on the ground and is N tall".
 *
 * The same primitives back the moving hazards (see movers.js): a mover is a
 * prepared solid whose transform is recomputed from server time each step.
 */

const EPS = 1e-6;

/** Build a ground-anchored box: base at `y`, `w`×`d` footprint, `h` tall. */
function boxAt(x, y, z, w, h, d, ry = 0, tag) {
  return { kind: 'box', x, y: y + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, ry, tag };
}

/** Build a ground-anchored ramp rising along its local +Z. */
function rampAt(x, y, z, w, h, d, ry = 0, tag) {
  return { kind: 'ramp', x, y: y + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, ry, tag };
}

/** Turn a solid description into the cached form every query below expects. */
function prepareSolid(solid) {
  const s = {
    kind: solid.kind || 'box',
    x: solid.x, y: solid.y, z: solid.z,
    hx: solid.hx, hy: solid.hy, hz: solid.hz,
    ry: solid.ry || 0,
    cos: 1, sin: 0,
    tag: solid.tag,
    solid: solid.solid !== false,
    k: (solid.kind === 'ramp') ? solid.hy / solid.hz : 0,
    minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0,
  };
  refreshSolid(s);
  return s;
}

/** Recompute the cached rotation + world AABB after a mover has moved. */
function refreshSolid(s) {
  s.cos = Math.cos(s.ry);
  s.sin = Math.sin(s.ry);
  const ex = s.hx * Math.abs(s.cos) + s.hz * Math.abs(s.sin);
  const ez = s.hx * Math.abs(s.sin) + s.hz * Math.abs(s.cos);
  s.minX = s.x - ex; s.maxX = s.x + ex;
  s.minZ = s.z - ez; s.maxZ = s.z + ez;
  s.minY = s.y - s.hy; s.maxY = s.y + s.hy;
  return s;
}

/** world → solid-local (yaw only; Y is never rotated). */
function toLocalX(s, dx, dz) { return dx * s.cos - dz * s.sin; }
function toLocalZ(s, dx, dz) { return dx * s.sin + dz * s.cos; }
/** solid-local → world. */
function toWorldX(s, lx, lz) { return lx * s.cos + lz * s.sin; }
function toWorldZ(s, lx, lz) { return -lx * s.sin + lz * s.cos; }

/** Local top surface height at a local Z (ramps slope, boxes are flat). */
function localTop(s, lz) {
  if (s.kind !== 'ramp') return s.hy;
  return -s.hy + (clamp(lz, -s.hz, s.hz) + s.hz) * s.k;
}

/**
 * World-space top surface height of a solid at (x, z), or null when the point
 * is outside its footprint (`radius` widens the footprint test).
 */
function solidTopAt(s, x, z, radius = 0) {
  const lx = toLocalX(s, x - s.x, z - s.z);
  const lz = toLocalZ(s, x - s.x, z - s.z);
  if (lx < -s.hx - radius || lx > s.hx + radius) return null;
  if (lz < -s.hz - radius || lz > s.hz + radius) return null;
  return s.y + localTop(s, lz);
}

/** Slope of a solid's surface at a local Z — 1 on flats, < 1 on ramps. */
function solidNormalY(s) {
  return s.kind === 'ramp' ? 1 / Math.sqrt(1 + s.k * s.k) : 1;
}

/**
 * Depenetrate a sphere from ONE solid, accumulating the correction into
 * `out` (`{x, y, z, hit}`). Returns true when the sphere overlapped.
 */
function depenetrateSphere(s, px, py, pz, r, out) {
  if (!s.solid) return false;
  if (py - r > s.maxY || py + r < s.minY) return false;
  const dx = px - s.x;
  const dz = pz - s.z;
  const ly = py - s.y;
  const lx = toLocalX(s, dx, dz);
  const lz = toLocalZ(s, dx, dz);

  const top = localTop(s, lz);
  const cx = clamp(lx, -s.hx, s.hx);
  const cz = clamp(lz, -s.hz, s.hz);
  const cy = clamp(ly, -s.hy, top);
  let nx = lx - cx;
  let ny = ly - cy;
  let nz = lz - cz;
  const d2 = nx * nx + ny * ny + nz * nz;
  if (d2 > r * r) return false;

  if (d2 > EPS) {
    const d = Math.sqrt(d2);
    const pen = r - d;
    nx = (nx / d) * pen;
    ny = (ny / d) * pen;
    nz = (nz / d) * pen;
  } else {
    // Centre is inside the solid: escape along the cheapest face. For ramps
    // the slope face is a candidate too, and usually the right one — it is
    // the surface you walk and drive on.
    const facePX = s.hx - lx, faceNX = lx + s.hx;
    const facePZ = s.hz - lz, faceNZ = lz + s.hz;
    const faceBottom = ly + s.hy;
    let best = facePX, axis = 0;
    if (faceNX < best) { best = faceNX; axis = 1; }
    if (facePZ < best) { best = facePZ; axis = 2; }
    if (faceNZ < best) { best = faceNZ; axis = 3; }
    if (faceBottom < best) { best = faceBottom; axis = 4; }
    if (s.kind === 'ramp') {
      const inv = 1 / Math.sqrt(1 + s.k * s.k);
      const slopePen = (top - ly) * inv;
      if (slopePen < best) {
        const move = slopePen + r;
        out.x += toWorldX(s, 0, -move * s.k * inv);
        out.y += move * inv;
        out.z += toWorldZ(s, 0, -move * s.k * inv);
        out.hit = true;
        return true;
      }
    } else if (top - ly < best) {
      best = top - ly; axis = 5;
    }
    nx = 0; ny = 0; nz = 0;
    if (axis === 0) nx = best + r;
    else if (axis === 1) nx = -(best + r);
    else if (axis === 2) nz = best + r;
    else if (axis === 3) nz = -(best + r);
    else if (axis === 4) ny = -(best + r);
    else ny = best + r;
  }

  out.x += toWorldX(s, nx, nz);
  out.y += ny;
  out.z += toWorldZ(s, nx, nz);
  out.hit = true;
  return true;
}

/**
 * Raycast against ONE solid. Returns the entry distance or -1.
 * On a hit, `out` receives the surface normal (`nx`, `ny`, `nz`).
 */
function raycastSolid(s, ox, oy, oz, dx, dy, dz, maxT, out) {
  if (!s.solid) return -1;
  const rx = toLocalX(s, ox - s.x, oz - s.z);
  const rz = toLocalZ(s, ox - s.x, oz - s.z);
  const ry0 = oy - s.y;
  const vx = toLocalX(s, dx, dz);
  const vz = toLocalZ(s, dx, dz);

  let t0 = 0;
  let t1 = maxT;
  let axis = -1;
  let sign = 0;

  let r = slab(rx, vx, s.hx, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 0; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  r = slab(rz, vz, s.hz, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 2; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  r = slab(ry0, dy, s.hy, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 1; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  if (s.kind === 'ramp') {
    // Clip to the half-space below the slope: (y + hy) - k*(z + hz) <= 0
    const c0 = (ry0 + s.hy) - s.k * (rz + s.hz);
    const cv = dy - s.k * vz;
    if (Math.abs(cv) < EPS) {
      if (c0 > 0) return -1;
    } else {
      const tc = -c0 / cv;
      if (cv > 0) {
        if (tc < t1) t1 = tc;
      } else if (tc > t0) {
        t0 = tc; axis = 3; sign = 1;
      }
    }
  }

  if (t0 > t1 || t0 < 0 || t0 > maxT) return -1;

  if (axis === 0) { out.nx = toWorldX(s, sign, 0); out.ny = 0; out.nz = toWorldZ(s, sign, 0); }
  else if (axis === 2) { out.nx = toWorldX(s, 0, sign); out.ny = 0; out.nz = toWorldZ(s, 0, sign); }
  else if (axis === 1) { out.nx = 0; out.ny = sign; out.nz = 0; }
  else {
    const inv = 1 / Math.sqrt(1 + s.k * s.k);
    out.nx = toWorldX(s, 0, -s.k * inv);
    out.ny = inv;
    out.nz = toWorldZ(s, 0, -s.k * inv);
  }
  return t0;
}

const slabResult = { t0: 0, t1: 0, sign: 1 };
function slab(origin, dir, half, t0, t1) {
  if (Math.abs(dir) < EPS) {
    if (origin < -half || origin > half) return null;
    slabResult.t0 = t0; slabResult.t1 = t1; slabResult.sign = 1;
    return slabResult;
  }
  let near = (-half - origin) / dir;
  let far = (half - origin) / dir;
  let sign = dir > 0 ? -1 : 1;
  if (near > far) { const tmp = near; near = far; far = tmp; sign = -sign; }
  if (near > t1 || far < t0) return null;
  slabResult.t0 = near; slabResult.t1 = far; slabResult.sign = sign;
  return slabResult;
}

function createCollisionWorld(options = {}) {
  const cellSize = options.cellSize || 16;
  const groundY = options.groundY === null ? null : (options.groundY ?? 0);
  const cells = new Map();
  const all = [];

  function add(solid) {
    const s = prepareSolid(solid);
    all.push(s);
    const cx0 = Math.floor(s.minX / cellSize);
    const cx1 = Math.floor(s.maxX / cellSize);
    const cz0 = Math.floor(s.minZ / cellSize);
    const cz1 = Math.floor(s.maxZ / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = cx + '|' + cz;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = []));
        bucket.push(s);
      }
    }
    return s;
  }

  for (const solid of options.solids || []) add(solid);

  /** Candidate solids overlapping an XZ rectangle. Reuses `out`. */
  function query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const cx0 = Math.floor(minX / cellSize);
    const cx1 = Math.floor(maxX / cellSize);
    const cz0 = Math.floor(minZ / cellSize);
    const cz1 = Math.floor(maxZ / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = cells.get(cx + '|' + cz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          if (s.maxX < minX || s.minX > maxX || s.maxZ < minZ || s.minZ > maxZ) continue;
          if (out.indexOf(s) === -1) out.push(s);
        }
      }
    }
    return out;
  }

  const pushOut = { x: 0, y: 0, z: 0, hit: false };
  const scratch = [];

  /**
   * Depenetrate a sphere from the static world. Returns a shared
   * `{x, y, z, hit}` — the correction to ADD to the sphere centre.
   */
  function resolveSphere(px, py, pz, r) {
    pushOut.x = 0; pushOut.y = 0; pushOut.z = 0; pushOut.hit = false;
    const list = query(px - r, pz - r, px + r, pz + r, scratch);
    for (let i = 0; i < list.length; i++) {
      depenetrateSphere(list[i], px + pushOut.x, py + pushOut.y, pz + pushOut.z, r, pushOut);
    }
    return pushOut;
  }

  /**
   * Highest walkable surface at (x, z) at or below `fromY`.
   * `normalY` is 1 on flat tops and less on ramps — the character and the
   * vehicle both use it to decide "too steep to hold".
   *
   * Returns a SHARED object (no allocation in the hot path): read the fields
   * you need before the next call, never hold on to it.
   */
  const groundHit = { y: 0, normalY: 1, solid: null, slopeX: 0, slopeZ: 0 };
  function sampleGround(x, z, fromY, radius = 0) {
    groundHit.y = groundY === null ? -Infinity : groundY;
    groundHit.normalY = 1;
    groundHit.slopeX = 0;
    groundHit.slopeZ = 0;
    groundHit.solid = null;
    const list = query(x - radius, z - radius, x + radius, z + radius, scratch);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.solid || s.minY > fromY + 0.05) continue;
      const top = solidTopAt(s, x, z, radius);
      if (top === null || top > fromY + 0.05 || top <= groundHit.y) continue;
      groundHit.y = top;
      groundHit.solid = s;
      if (s.kind === 'ramp') {
        const inv = solidNormalY(s);
        groundHit.normalY = inv;
        groundHit.slopeX = toWorldX(s, 0, -s.k * inv);
        groundHit.slopeZ = toWorldZ(s, 0, -s.k * inv);
      } else {
        groundHit.normalY = 1;
        groundHit.slopeX = 0;
        groundHit.slopeZ = 0;
      }
    }
    return groundHit;
  }

  /**
   * Raycast the static world (bullets, line of sight, camera).
   * Returns a shared `{t, x, y, z, nx, ny, nz, solid}` or null.
   */
  const rayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, solid: null };
  const rayNormal = { nx: 0, ny: 1, nz: 0 };
  function raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let bestT = maxT;
    let bestNX = 0, bestNY = 1, bestNZ = 0, bestSolid = null;
    let hitAny = false;

    if (groundY !== null && dy < -EPS && oy > groundY) {
      const t = (groundY - oy) / dy;
      if (t >= 0 && t < bestT) {
        bestT = t; bestNX = 0; bestNY = 1; bestNZ = 0; bestSolid = null; hitAny = true;
      }
    }

    const minX = Math.min(ox, ox + dx * maxT);
    const maxX = Math.max(ox, ox + dx * maxT);
    const minZ = Math.min(oz, oz + dz * maxT);
    const maxZ = Math.max(oz, oz + dz * maxT);
    const list = query(minX, minZ, maxX, maxZ, scratch);
    for (let i = 0; i < list.length; i++) {
      const t = raycastSolid(list[i], ox, oy, oz, dx, dy, dz, bestT, rayNormal);
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      bestNX = rayNormal.nx; bestNY = rayNormal.ny; bestNZ = rayNormal.nz;
      bestSolid = list[i];
      hitAny = true;
    }

    if (!hitAny) return null;
    rayHit.t = bestT;
    rayHit.x = ox + dx * bestT;
    rayHit.y = oy + dy * bestT;
    rayHit.z = oz + dz * bestT;
    rayHit.nx = bestNX; rayHit.ny = bestNY; rayHit.nz = bestNZ;
    rayHit.solid = bestSolid;
    return rayHit;
  }

  return { cellSize, groundY, solids: all, add, query, resolveSphere, sampleGround, raycast };
}

/**
 * Movers — the kinematic hazards and platforms that give a world its Fall
 * Guys character: spinning bars, swinging sweepers, pistons, lifts, crushers
 * and conveyors.
 *
 * A mover's transform is a **pure function of world time**, so the server and
 * every client compute the identical pose from `state.t` without a single
 * byte on the wire. That is what keeps a hazard-dense world affordable at 200
 * players: only the things that make real decisions (players, cars, bullets)
 * are replicated.
 *
 * Spec (from the world manifest):
 *   { id, kind, x, y, z, w, h, d, ry?, period?, phase?, ... }
 *     spinner  — bar rotating about its centre       (period = one full turn)
 *     sweeper  — bar swinging back and forth         (sweep = half-angle)
 *     piston   — box sliding along `travel`          (period = out and back)
 *     platform — same motion, but riders are carried (smooth easing)
 *     crusher  — vertical piston (travel defaults to straight down)
 *     conveyor — static box with a surface velocity  (speed along local +Z)
 *   Optional: `push` (extra knockback multiplier), `damage` (per hit),
 *   `rideable` (override: e.g. a piston with `rideable: false` is a pusher
 *   that knocks you over instead of carrying you), `color` (renderer).
 */

const RIDEABLE = new Set(['platform', 'piston', 'crusher', 'conveyor']);

function createMover(spec) {
  const kind = spec.kind || 'platform';
  const solid = prepareSolid({
    kind: 'box',
    x: spec.x, y: spec.y + (spec.h || 1) / 2, z: spec.z,
    hx: (spec.w || 1) / 2, hy: (spec.h || 1) / 2, hz: (spec.d || 1) / 2,
    ry: spec.ry || 0,
    tag: spec.id,
  });
  return {
    id: spec.id,
    kind,
    spec,
    solid,
    baseX: spec.x, baseY: spec.y + (spec.h || 1) / 2, baseZ: spec.z,
    baseRy: spec.ry || 0,
    period: Math.max(0.1, spec.period || 4),
    phase: spec.phase || 0,
    sweep: spec.sweep ?? Math.PI * 0.6,
    travelX: (spec.travel && spec.travel.x) || 0,
    travelY: (spec.travel && spec.travel.y) || (kind === 'crusher' ? -(spec.height ?? 4) : 0),
    travelZ: (spec.travel && spec.travel.z) || 0,
    speed: spec.speed ?? 6,
    push: spec.push ?? 1,
    damage: spec.damage ?? 0,
    rideable: spec.rideable ?? RIDEABLE.has(kind),
    // Current kinematics, refreshed by update():
    vx: 0, vy: 0, vz: 0, omega: 0,
  };
}

/** Advance every mover to world time `t` (seconds). Deterministic. */
function updateMovers(movers, t) {
  for (let i = 0; i < movers.length; i++) updateMover(movers[i], t);
}

function updateMover(m, t) {
  const s = m.solid;
  const w = TAU / m.period;
  const phase = t * w + m.phase;
  switch (m.kind) {
    case 'spinner': {
      s.ry = m.baseRy + phase;
      m.omega = w;
      m.vx = 0; m.vy = 0; m.vz = 0;
      break;
    }
    case 'sweeper': {
      s.ry = m.baseRy + Math.sin(phase) * m.sweep;
      m.omega = Math.cos(phase) * m.sweep * w;
      m.vx = 0; m.vy = 0; m.vz = 0;
      break;
    }
    case 'conveyor': {
      m.omega = 0;
      m.vx = Math.sin(s.ry) * m.speed;
      m.vy = 0;
      m.vz = Math.cos(s.ry) * m.speed;
      break;
    }
    case 'piston':
    case 'crusher':
    case 'platform':
    default: {
      // 0 → 1 → 0 with smooth ends so riders are not launched at the turn.
      const u = 0.5 - 0.5 * Math.cos(phase);
      const du = 0.5 * Math.sin(phase) * w;
      s.x = m.baseX + m.travelX * u;
      s.y = m.baseY + m.travelY * u;
      s.z = m.baseZ + m.travelZ * u;
      m.vx = m.travelX * du;
      m.vy = m.travelY * du;
      m.vz = m.travelZ * du;
      m.omega = 0;
      break;
    }
  }
  refreshSolid(s);
  return m;
}

/** Surface velocity of a mover at a world point (rotation + translation). */
function moverVelocityAt(m, x, z, out) {
  const rx = x - m.solid.x;
  const rz = z - m.solid.z;
  out.vx = m.vx + m.omega * rz;
  out.vy = m.vy;
  out.vz = m.vz - m.omega * rx;
  return out;
}

/**
 * Depenetrate a sphere from all movers near it.
 *
 * `out` accumulates the positional correction (`x`,`y`,`z`,`hit`) and also
 * reports the strongest contact — `mover`, plus that mover's surface velocity
 * (`vx`,`vy`,`vz`) at the contact point — so callers can transfer momentum
 * (a spinner bar launching a player) instead of merely blocking movement.
 */
const contactVel = { vx: 0, vy: 0, vz: 0 };
function resolveMovers(movers, px, py, pz, r, out) {
  out.x = 0; out.y = 0; out.z = 0; out.hit = false;
  out.mover = null; out.vx = 0; out.vy = 0; out.vz = 0;
  let bestPush = 0;
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i];
    const s = m.solid;
    if (px + r < s.minX || px - r > s.maxX || pz + r < s.minZ || pz - r > s.maxZ) continue;
    const beforeX = out.x, beforeY = out.y, beforeZ = out.z;
    if (!depenetrateSphere(s, px + out.x, py + out.y, pz + out.z, r, out)) continue;
    const dx = out.x - beforeX, dy = out.y - beforeY, dz = out.z - beforeZ;
    const mag = dx * dx + dy * dy + dz * dz;
    if (mag <= bestPush) continue;
    bestPush = mag;
    moverVelocityAt(m, px, pz, contactVel);
    out.mover = m;
    out.vx = contactVel.vx;
    out.vy = contactVel.vy;
    out.vz = contactVel.vz;
  }
  return out;
}

/**
 * Highest rideable mover surface under (x, z) at or below `fromY`.
 * Only platforms/pistons/conveyors carry riders — you do not stand on a
 * spinning bar, it hits you.
 */
const moverGround = { y: -Infinity, mover: null };
function sampleMoverGround(movers, x, z, fromY, radius = 0) {
  moverGround.y = -Infinity;
  moverGround.mover = null;
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i];
    if (!m.rideable) continue;
    const top = solidTopAt(m.solid, x, z, radius);
    if (top === null || top > fromY + 0.15 || top <= moverGround.y) continue;
    moverGround.y = top;
    moverGround.mover = m;
  }
  return moverGround;
}

/**
 * Rapier physics backend.
 *
 * The core never imports Rapier itself: the host passes in an initialised
 * RAPIER namespace (`@dimforge/rapier3d-deterministic-compat`), so the same
 * code runs in Node, in the browser and — once the platform provides Rapier —
 * inside the rooms-runtime sandbox. The deterministic build gives
 * byte-identical results on every engine and CPU we ship to
 * (spikes/rapier/RESULTS.md), which is what lets a phone predict its own
 * player against the exact geometry the server simulates.
 *
 * What lives in the Rapier world:
 *   - static geometry: manifest boxes, ramps (convex wedges) and meshes
 *     (trimeshes, e.g. exported from Blender)
 *   - movers: colliders posed from world time (movers.js computes the pose;
 *     this file only mirrors it), so they cost no bandwidth
 *   - rollers: dynamic balls, simulated on the server only
 *   - one capsule per player, used purely as the character controller's
 *     shape. Player capsules collide with NOTHING — the controller moves them,
 *     and players jostle each other through the soft push in character.js.
 *
 * Collision groups (membership << 16 | filter):
 */
const GROUP = {
  STATIC: 0x1,
  RIDE: 0x2,       // platforms, pistons, conveyors: block and carry
  HAZARD: 0x4,     // spinners, sweepers: block and knock you down
  PLAYER: 0x8,
  ROLLER: 0x10,    // dynamic balls
};

const ALL = 0xffff;
const groups = (membership, filter) => ((membership & 0xffff) << 16) | (filter & 0xffff);

// The character controller sees the level and the movers, never other
// players (soft push) or rollers (they knock you over instead of blocking).
const MOVE_GROUPS = groups(GROUP.PLAYER, GROUP.STATIC | GROUP.RIDE | GROUP.HAZARD);
const GROUND_GROUPS = groups(GROUP.PLAYER, GROUP.STATIC | GROUP.RIDE);
const KNOCK_GROUPS = groups(GROUP.PLAYER, GROUP.HAZARD | GROUP.ROLLER);

/** Quaternion for a rotation of `ry` radians about +Y (the engine's yaw). */
function yawQuat(ry, out) {
  out.x = 0; out.y = Math.sin(ry / 2); out.z = 0; out.w = Math.cos(ry / 2);
  return out;
}

/**
 * @param {object} R        initialised RAPIER namespace
 * @param {object} manifest normalised world manifest
 * @param {Array}  movers   runtime movers from movers.js (already posed at t=0)
 * @param {object} [opts]   {character: CHARACTER constants, gravity}
 */
function createPhysics(R, manifest, movers, opts = {}) {
  const C = opts.character;
  const world = new R.World({ x: 0, y: -(opts.gravity ?? 20), z: 0 });
  world.timestep = opts.dt ?? 1 / 30;
  const q = { x: 0, y: 0, z: 0, w: 1 };

  // ---- static level -------------------------------------------------------
  const staticGroups = groups(GROUP.STATIC, ALL);
  for (const s of manifest.solids) {
    if (s.solid === false) continue;
    let desc;
    if (s.kind === 'ramp') {
      // Wedge rising along local +Z, matching collision.js ramps exactly.
      desc = R.ColliderDesc.convexHull(new Float32Array([
        -s.hx, -s.hy, -s.hz, s.hx, -s.hy, -s.hz,
        -s.hx, -s.hy, s.hz, s.hx, -s.hy, s.hz,
        -s.hx, s.hy, s.hz, s.hx, s.hy, s.hz,
      ]));
    } else {
      desc = R.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    }
    desc.setTranslation(s.x, s.y, s.z).setRotation(yawQuat(s.ry || 0, q)).setCollisionGroups(staticGroups);
    world.createCollider(desc);
  }
  for (const mesh of manifest.meshes || []) {
    const desc = R.ColliderDesc.trimesh(Float32Array.from(mesh.vertices), Uint32Array.from(mesh.indices));
    desc.setCollisionGroups(staticGroups);
    world.createCollider(desc);
  }
  if (manifest.groundY !== null && manifest.groundY !== undefined) {
    const b = manifest.bounds;
    const hx = (b.maxX - b.minX) / 2 + 50;
    const hz = (b.maxZ - b.minZ) / 2 + 50;
    world.createCollider(R.ColliderDesc.cuboid(hx, 1, hz)
      .setTranslation((b.minX + b.maxX) / 2, manifest.groundY - 1, (b.minZ + b.maxZ) / 2)
      .setCollisionGroups(staticGroups));
  }

  // ---- movers -------------------------------------------------------------
  // Movers are STANDALONE colliders (no rigid body) re-posed every tick.
  // Rapier treats them like fixed geometry, which matters: on kinematic
  // bodies the character controller silently adds platform motion, and only
  // when the body was moved with setNextKinematic* — the server and a phone
  // replaying history would then disagree. Our own carry (character-physics)
  // is identical on both sides.
  const moverByCollider = new Map();
  const moverColliders = [];
  for (const m of movers) {
    const s = m.solid;
    const col = world.createCollider(R.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
      .setTranslation(s.x, s.y, s.z).setRotation(yawQuat(s.ry, q))
      .setCollisionGroups(groups(m.rideable ? GROUP.RIDE : GROUP.HAZARD, ALL)));
    moverByCollider.set(col.handle, m);
    moverColliders.push({ m, col });
  }

  /** Mirror the movers' current poses (set by updateMovers) into Rapier. */
  const v3 = { x: 0, y: 0, z: 0 };
  function syncMovers() {
    for (let i = 0; i < moverColliders.length; i++) {
      const { m, col } = moverColliders[i];
      const s = m.solid;
      v3.x = s.x; v3.y = s.y; v3.z = s.z;
      col.setTranslation(v3);
      col.setRotation(yawQuat(s.ry, q));
    }
  }

  // ---- rollers (server-only dynamic balls) --------------------------------
  const rollers = new Map();      // id → {id, body, collider, r}
  const rollerByCollider = new Map();
  function addRoller(id, x, y, z, r, vx = 0, vy = 0, vz = 0, push = 0.6) {
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z).setLinvel(vx, vy, vz).setCcdEnabled(true));
    const collider = world.createCollider(R.ColliderDesc.ball(r).setDensity(2).setRestitution(0.2)
      // PLAYER in the filter only makes balls visible to the knock query:
      // player capsules accept no contacts, so balls never bounce off people.
      .setFriction(0.8).setCollisionGroups(groups(GROUP.ROLLER,
        GROUP.STATIC | GROUP.RIDE | GROUP.HAZARD | GROUP.ROLLER | GROUP.PLAYER)), body);
    const roller = { id, body, collider, r, push };     // push: share of its speed a hit transfers
    rollers.set(id, roller);
    rollerByCollider.set(collider.handle, roller);
    return roller;
  }
  function removeRoller(id) {
    const roller = rollers.get(id);
    if (!roller) return;
    rollerByCollider.delete(roller.collider.handle);
    world.removeRigidBody(roller.body);
    rollers.delete(id);
  }

  // ---- characters ---------------------------------------------------------
  const halfHeight = (C.height - 2 * C.radius) / 2;
  const centerY = C.radius + halfHeight;            // feet → capsule centre
  const capsules = new Map();                        // player id → collider
  const capsuleShape = new R.Capsule(halfHeight, C.radius);

  const kcc = world.createCharacterController(0.02);
  kcc.enableAutostep(C.stepHeight, 0.2, false);
  kcc.enableSnapToGround(0.3);
  kcc.setMaxSlopeClimbAngle(Math.acos(C.maxSlopeNormalY));
  kcc.setMinSlopeSlideAngle(Math.acos(C.maxSlopeNormalY));
  kcc.setApplyImpulsesToDynamicBodies(false);

  function capsuleOf(p) {
    let col = capsules.get(p.id);
    if (!col) {
      col = world.createCollider(R.ColliderDesc.capsule(halfHeight, C.radius)
        .setTranslation(p.x, p.y + centerY, p.z)
        .setCollisionGroups(groups(GROUP.PLAYER, 0)));     // collides with nothing
      capsules.set(p.id, col);
    }
    return col;
  }
  function removeCharacter(id) {
    const col = capsules.get(id);
    if (!col) return;
    world.removeCollider(col, false);
    capsules.delete(id);
  }

  /**
   * Move a player by (dx, dy, dz) with the character controller.
   * Mutates p.x/y/z and returns a SHARED result — read it before the next call.
   */
  const moveResult = { grounded: false, x: 0, y: 0, z: 0, contacts: 0 };
  const contacts = [];          // reused: {nx, ny, nz, mover}
  const delta = { x: 0, y: 0, z: 0 };
  function moveCharacter(p, dx, dy, dz) {
    const col = capsuleOf(p);
    v3.x = p.x; v3.y = p.y + centerY; v3.z = p.z;
    col.setTranslation(v3);
    delta.x = dx; delta.y = dy; delta.z = dz;
    kcc.computeColliderMovement(col, delta, undefined, MOVE_GROUPS);
    const m = kcc.computedMovement();
    p.x += m.x; p.y += m.y; p.z += m.z;
    v3.x = p.x; v3.y = p.y + centerY; v3.z = p.z;
    col.setTranslation(v3);
    moveResult.grounded = kcc.computedGrounded();
    moveResult.x = m.x; moveResult.y = m.y; moveResult.z = m.z;
    const n = kcc.numComputedCollisions();
    moveResult.contacts = n;
    for (let i = 0; i < n; i++) {
      const hit = kcc.computedCollision(i);
      let c = contacts[i];
      if (!c) contacts[i] = c = { nx: 0, ny: 0, nz: 0, mover: null };
      const nrm = hit.normal1;
      c.nx = nrm.x; c.ny = nrm.y; c.nz = nrm.z;
      c.mover = hit.collider ? (moverByCollider.get(hit.collider.handle) || null) : null;
    }
    return moveResult;
  }

  /** What is directly under a player's feet: {normalY, mover} or null. */
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const groundResult = { normalY: 1, mover: null, gap: 0 };
  function groundUnder(p, reach = 0.35) {
    ray.origin.x = p.x; ray.origin.y = p.y + 0.15; ray.origin.z = p.z;
    const hit = world.castRayAndGetNormal(ray, 0.15 + reach, true, undefined, GROUND_GROUPS);
    if (!hit) return null;
    groundResult.normalY = hit.normal.y;
    groundResult.mover = moverByCollider.get(hit.collider.handle) || null;
    groundResult.gap = hit.timeOfImpact - 0.15;        // feet → surface (≈ the controller's skin)
    return groundResult;
  }

  /**
   * Hazards and rollers overlapping a player — catches a spinning bar that
   * swings INTO a player standing still, which the controller (it only
   * resolves the player's own motion) never reports.
   */
  const pos = { x: 0, y: 0, z: 0 };
  const ident = { x: 0, y: 0, z: 0, w: 1 };
  function overlapKnockers(p, cb) {
    pos.x = p.x; pos.y = p.y + centerY; pos.z = p.z;
    world.intersectionsWithShape(pos, ident, capsuleShape, (collider) => {
      const h = collider.handle;
      const mover = moverByCollider.get(h);
      if (mover) cb(mover, null);
      else {
        const roller = rollerByCollider.get(h);
        if (roller) cb(null, roller);
      }
      return true;
    }, undefined, KNOCK_GROUPS);
  }

  return {
    R,
    world,
    centerY,
    syncMovers,
    step() { world.step(); },
    moveCharacter,
    contacts,
    groundUnder,
    overlapKnockers,
    removeCharacter,
    addRoller,
    removeRoller,
    rollers,
    free() { world.free(); },
  };
}

/**
 * On-foot character step on the Rapier backend.
 *
 * Same feel as the arcade backend in character.js — it shares the controls
 * (`beginCharacterStep` / `applyCharacterControls`) and the hazard knock —
 * but collision is Rapier's character controller against real geometry:
 * meshes, rotated boxes, ramps and kinematic movers, with autostep, slope
 * limits and snap-to-ground.
 *
 * Deterministic and allocation-free in the hot path: the phone runs this
 * exact function to predict (and replay) the local player.
 */

const surface = { vx: 0, vy: 0, vz: 0 };

/**
 * @param {object} p      player entity (mutated in place)
 * @param {object} input  {mx, mz, aim, jump, sprint, dive}
 * @param {number} dt     seconds (fixed step)
 * @param {object} ctx    {physics, movers, moverById, config?}
 */
function stepCharacterPhysics(p, input, dt, ctx) {
  const C = ctx.config || CHARACTER;
  const phys = ctx.physics;
  if (p.locked) input = null;          // countdowns, spectating: physics only, no control

  const ctl = beginCharacterStep(p, input, dt);

  // Grounded state comes from the controller's previous move.
  const wasGrounded = p.grounded;
  if (p.grounded) p.coyote = C.coyoteTime;
  else if (p.coyote > 0) p.coyote = Math.max(0, p.coyote - dt);
  const impactSpeed = wasGrounded ? 0 : -p.vy;

  applyCharacterControls(p, input, dt, C, ctl);
  const knockedBefore = p.stunT;

  // ---- gravity ------------------------------------------------------------
  if (p.grounded && p.vy <= 0) {
    p.vy = -C.groundStick;
  } else {
    p.vy -= C.gravity * dt;
    if (p.vy < -C.maxFallSpeed) p.vy = -C.maxFallSpeed;
  }

  // ---- ride platforms -----------------------------------------------------
  let carryX = 0, carryY = 0, carryZ = 0;
  const rider = p.rideId ? ctx.moverById.get(p.rideId) : null;
  if (rider) {
    moverVelocityAt(rider, p.x, p.z, surface);
    carryX = surface.vx * dt;
    carryZ = surface.vz * dt;
    carryY = surface.vy * dt;
  }

  // ---- move ---------------------------------------------------------------
  const res = phys.moveCharacter(p, p.vx * dt + carryX, p.vy * dt + carryY, p.vz * dt + carryZ);
  for (let i = 0; i < res.contacts; i++) {
    const c = phys.contacts[i];
    const m = c.mover;
    if (m && !m.rideable) {
      moverVelocityAt(m, p.x, p.z, surface);
      const nl = length2(c.nx, c.nz) || 1;
      knockFromHazard(p, m, surface.vx, surface.vz, c.nx / nl, c.nz / nl);
      p.diveT = 0;
    } else {
      cancelIntoNormal(p, c.nx, c.ny, c.nz);
    }
  }

  // ---- hazards that swept INTO us -----------------------------------------
  if (p.stunT === knockedBefore) {
    phys.overlapKnockers(p, (m, roller) => {
      if (p.stunT !== knockedBefore) return;     // one knock per step
      let ax = p.x, az = p.z;
      if (m) {
        moverVelocityAt(m, p.x, p.z, surface);
        ax -= m.solid.x; az -= m.solid.z;
        const al = length2(ax, az) || 1;
        knockFromHazard(p, m, surface.vx, surface.vz, ax / al, az / al);
      } else {
        const v = roller.body.linvel();
        const t = roller.body.translation();
        ax -= t.x; az -= t.z;
        const al = length2(ax, az) || 1;
        knockFromHazard(p, roller, v.x, v.z, ax / al, az / al);
      }
      p.diveT = 0;
    });
  }

  // ---- ground -------------------------------------------------------------
  // Grounded = our own short ray finds walkable ground right under the feet.
  // (The controller's own flag flickers off for single ticks while running
  // on flat ground, which breaks coyote time and the run animation.)
  const rising = p.vy > 0.001 && p.stunT === knockedBefore;
  const ground = rising ? null : phys.groundUnder(p);
  p.grounded = !rising && !!ground && ground.gap < 0.12 && ground.normalY >= C.maxSlopeNormalY;
  p.rideId = p.grounded && ground.mover && ground.mover.rideable ? ground.mover.id : null;
  if (p.grounded) {
    if (p.vy < 0) p.vy = 0;
    if (!wasGrounded && impactSpeed > C.fallDamageSpeed) {
      p.pendingFallDamage = Math.round((impactSpeed - C.fallDamageSpeed) * C.fallDamagePerSpeed);
    }
  } else if (p.vy > 0 && res.y < (p.vy * dt + carryY) * 0.5) {
    p.vy = 0;                                    // bumped a ceiling
  }

  p.yaw = wrapAngle(p.yaw);
  p.anim = p.stunT > 0 ? 'stun'
    : p.diveT > 0 ? 'dive'
      : p.getUpT > 0 ? 'getup'
        : !p.grounded ? 'air'
          : length2(p.vx, p.vz) > 0.6 ? (input && input.sprint ? 'sprint' : 'run')
            : 'idle';
  return p;
}

/**
 * On-foot character controller.
 *
 * The feel is deliberately arcade — Fall Guys, not a milsim: quick
 * acceleration, generous air control, a committed dive, and players who bump
 * and jostle each other instead of passing through. It is also deterministic
 * and allocation-free, because the client runs this exact function to predict
 * the local player while the server runs it as the authority.
 *
 * Positions are FEET positions (`y` is ground height, not the capsule centre).
 */

const CHARACTER = {
  radius: 0.4,
  height: 1.8,
  eyeHeight: 1.6,
  walkSpeed: 5.6,
  sprintSpeed: 8.6,
  groundAccel: 48,
  airAccel: 14,
  groundFriction: 11,
  airDrag: 0.25,
  gravity: 24,
  jumpSpeed: 9.2,
  coyoteTime: 0.12,
  jumpBufferTime: 0.15,
  stepHeight: 0.55,
  maxSlopeNormalY: 0.64,     // ≈ 50°: steeper than this and you slide
  slideAccel: 16,
  diveSpeed: 10.5,
  diveUp: 3.6,
  diveTime: 0.55,
  getUpTime: 0.4,
  diveCooldown: 0.9,
  pushRadius: 0.62,          // player-vs-player jostle radius
  pushStrength: 26,
  maxFallSpeed: 45,
  groundStick: 2,            // physics backend: downward push that keeps the controller snapped
  fallDamageSpeed: 22,       // impact speed where fall damage starts
  fallDamagePerSpeed: 4.5,
};

const push$1 = { x: 0, y: 0, z: 0, hit: false, mover: null, vx: 0, vy: 0, vz: 0 };

/** Reset a player to a spawn point, on foot and fully healed. */
function spawnCharacter(p, spawn) {
  p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.yaw = spawn.yaw || 0;
  p.grounded = true;
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.diveT = 0;
  p.diveCd = 0;
  p.stunT = 0;
  p.getUpT = 0;
  p.anim = 'idle';
  p.rideId = null;
  p.locked = false;
  p.veh = null;
  p.seat = -1;
  return p;
}

/** Knock a player about — car hits, explosions, spinner bars, shoves. */
function applyImpulse(p, ix, iy, iz, stun = 0) {
  p.vx += ix;
  p.vy += iy;
  p.vz += iz;
  if (stun > 0) {
    p.stunT = Math.max(p.stunT || 0, stun);
    p.diveT = 0;
    p.grounded = false;
  }
}

/**
 * Advance one on-foot player by `dt`.
 *
 * @param {object} p      player entity (mutated in place)
 * @param {object} input  {mx, mz, aim, jump, sprint, dive}
 * @param {number} dt     seconds
 * @param {object} ctx    {collision, movers, gravity?, config?}
 */
function stepCharacter(p, input, dt, ctx) {
  if (ctx.physics) return stepCharacterPhysics(p, input, dt, ctx);
  const C = ctx.config || CHARACTER;
  if (p.locked) input = null;          // countdowns, spectating: physics only, no control
  const collision = ctx.collision;
  const movers = ctx.movers || [];

  const ctl = beginCharacterStep(p, input, dt);

  // ---- ground probe -------------------------------------------------------
  const feetProbe = p.y + 0.25;
  const ground = collision.sampleGround(p.x, p.z, feetProbe, C.radius * 0.9);
  const moverGround = sampleMoverGround(movers, p.x, p.z, feetProbe, C.radius * 0.9);
  let groundY = ground.y;
  let groundNormalY = ground.normalY;
  let rider = null;
  if (moverGround.mover && moverGround.y >= groundY) {
    groundY = moverGround.y;
    groundNormalY = 1;
    rider = moverGround.mover;
  }

  const wasGrounded = p.grounded;
  const nearGround = groundY > -Infinity && p.y <= groundY + 0.08 && p.vy <= 0.001;
  const steep = groundNormalY < C.maxSlopeNormalY;
  p.grounded = nearGround && !steep;
  if (p.grounded) {
    p.coyote = C.coyoteTime;
  } else if (p.coyote > 0) {
    p.coyote = Math.max(0, p.coyote - dt);
  }

  const impactSpeed = wasGrounded ? 0 : -p.vy;

  applyCharacterControls(p, input, dt, C, ctl);
  const diving = ctl.diving;

  // ---- gravity / slopes ---------------------------------------------------
  if (p.grounded) {
    if (p.vy < 0) p.vy = 0;
  } else {
    p.vy -= C.gravity * dt;
    if (p.vy < -C.maxFallSpeed) p.vy = -C.maxFallSpeed;
  }
  if (nearGround && steep) {
    p.vx += ground.slopeX * C.slideAccel * dt;
    p.vz += ground.slopeZ * C.slideAccel * dt;
  }
  if (rider) {
    // Ride the platform: carry its motion without fighting the ground snap.
    p.x += rider.vx * dt;
    p.z += rider.vz * dt;
    if (rider.vy > 0) p.y += rider.vy * dt;
  }

  // ---- integrate ----------------------------------------------------------
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;

  // ---- static + mover collision ------------------------------------------
  // Only the UPPER body is resolved against solids: anything below the step
  // height is the ground probe's job. Sampling a sphere at ankle level fights
  // the ground snap on every ramp and kerb, which reads as walking through
  // treacle up a slope.
  const r = C.radius;
  const heights = diving
    ? [r + 0.1, r * 2]
    : [C.stepHeight + r * 0.5, C.height * 0.55, C.height - r];
  for (let i = 0; i < heights.length; i++) {
    const cy = p.y + heights[i];
    const fix = collision.resolveSphere(p.x, cy, p.z, r);
    if (fix.hit) {
      p.x += fix.x;
      p.z += fix.z;
      if (fix.y > 0 && p.vy < 0) { p.y += fix.y; p.vy = 0; }
      else if (fix.y < 0 && p.vy > 0) { p.y += fix.y; p.vy = 0; }
      cancelIntoNormal(p, fix.x, 0, fix.z);
    }
    if (movers.length) {
      resolveMovers(movers, p.x, p.y + heights[i], p.z, r, push$1);
      if (push$1.hit) {
        p.x += push$1.x;
        p.z += push$1.z;
        if (push$1.y !== 0) p.y += push$1.y;
        const m = push$1.mover;
        if (m && !m.rideable) {
          // Hazard bar: transfer its surface velocity, then knock you down.
          knockFromHazard(p, m, push$1.vx, push$1.vz);
        } else {
          cancelIntoNormal(p, push$1.x, 0, push$1.z);
        }
      }
    }
  }

  // ---- ground snap + step up ---------------------------------------------
  const after = collision.sampleGround(p.x, p.z, p.y + (p.grounded ? C.stepHeight : 0.08), C.radius * 0.9);
  const afterMover = sampleMoverGround(movers, p.x, p.z, p.y + (p.grounded ? C.stepHeight : 0.15), C.radius * 0.9);
  let snapY = after.y;
  if (afterMover.mover && afterMover.y > snapY) snapY = afterMover.y;
  if (snapY > -Infinity) {
    if (p.y < snapY) {
      p.y = snapY;
      if (p.vy < 0) p.vy = 0;
      p.grounded = after.normalY >= C.maxSlopeNormalY || afterMover.mover != null;
      // Landing is detected HERE, not before integration: at terminal velocity
      // a body covers 1.5 m per tick and would never be seen "near" the floor.
      if (impactSpeed > C.fallDamageSpeed) {
        p.pendingFallDamage = Math.round((impactSpeed - C.fallDamageSpeed) * C.fallDamagePerSpeed);
      }
    } else if (p.grounded && p.y - snapY < 0.2) {
      p.y = snapY;
    }
  }

  p.yaw = wrapAngle(p.yaw);
  p.anim = p.stunT > 0 ? 'stun'
    : p.diveT > 0 ? 'dive'
      : p.getUpT > 0 ? 'getup'
        : !p.grounded ? 'air'
          : length2(p.vx, p.vz) > 0.6 ? (input && input.sprint ? 'sprint' : 'run')
            : 'idle';
  return p;
}

/**
 * Shared opening of a character step (both physics backends): tick the
 * timers and turn the body toward the camera / stick. Returns a SHARED
 * control record — read it before the next call.
 */
const ctlState = { mx: 0, mz: 0, stunned: false, diving: false };
function beginCharacterStep(p, input, dt, C) {
  if (p.stunT > 0) p.stunT = Math.max(0, p.stunT - dt);
  if (p.diveCd > 0) p.diveCd = Math.max(0, p.diveCd - dt);
  if (p.getUpT > 0) p.getUpT = Math.max(0, p.getUpT - dt);

  const stunned = p.stunT > 0 || p.getUpT > 0;
  let mx = 0;
  let mz = 0;
  if (input && !stunned) {
    mx = input.mx || 0;
    mz = input.mz || 0;
    const len = length2(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    if (typeof input.aim === 'number') {
      // Facing follows the aim/camera yaw; it snaps faster while moving.
      p.yaw = approachAngle(p.yaw, input.aim, (len > 0.1 ? 14 : 9) * dt);
    } else if (len > 0.1) {
      p.yaw = approachAngle(p.yaw, Math.atan2(mx, mz), 12 * dt);
    }
  }
  ctlState.mx = mx;
  ctlState.mz = mz;
  ctlState.stunned = stunned;
  ctlState.diving = p.diveT > 0;
  return ctlState;
}

/**
 * Shared controls (both backends): dive, buffered jump with coyote time, and
 * arcade horizontal acceleration / friction. Needs p.grounded and p.coyote
 * to be current for this step.
 */
function applyCharacterControls(p, input, dt, C, ctl) {
  const { mx, mz, stunned, diving } = ctl;
  if (input && !stunned) {
    if (input.jump) p.jumpBuffer = C.jumpBufferTime;
    if (input.dive && !diving && p.diveCd <= 0 && (p.grounded || p.coyote > 0)) {
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      p.vx = fx * C.diveSpeed;
      p.vz = fz * C.diveSpeed;
      p.vy = C.diveUp;
      p.diveT = C.diveTime;
      p.diveCd = C.diveCooldown;
      p.grounded = false;
      p.coyote = 0;
      p.jumpBuffer = 0;
    }
  }
  if (p.jumpBuffer > 0) p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  if (p.jumpBuffer > 0 && (p.grounded || p.coyote > 0) && !diving && !stunned) {
    p.vy = C.jumpSpeed;
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
  }

  if (p.diveT > 0) {
    p.diveT = Math.max(0, p.diveT - dt);
    if (p.diveT === 0) p.getUpT = C.getUpTime;
  }

  // ---- horizontal movement ------------------------------------------------
  const canSteer = !stunned && !diving;
  const speedCap = input && input.sprint ? C.sprintSpeed : C.walkSpeed;
  if (canSteer) {
    const accel = p.grounded ? C.groundAccel : C.airAccel;
    const targetX = mx * speedCap;
    const targetZ = mz * speedCap;
    p.vx += clamp(targetX - p.vx, -accel * dt, accel * dt);
    p.vz += clamp(targetZ - p.vz, -accel * dt, accel * dt);
    if (p.grounded && mx === 0 && mz === 0) {
      const drop = C.groundFriction * dt;
      const speed = length2(p.vx, p.vz);
      const scale = speed > 0 ? Math.max(0, speed - drop) / speed : 0;
      p.vx *= scale;
      p.vz *= scale;
    }
  } else if (p.grounded) {
    const drop = (diving ? 5 : 8) * dt;
    const speed = length2(p.vx, p.vz);
    const scale = speed > 0 ? Math.max(0, speed - drop) / speed : 0;
    p.vx *= scale;
    p.vz *= scale;
  }
}

/**
 * A hazard (spinning bar, sweeper, rolling ball) hits a player: carry its
 * surface velocity — never less than a firm shove away from it — then knock
 * the player over. `awayX/awayZ` (optional, unit) is the fallback direction
 * when the surface itself is barely moving (near a spinner's hub).
 */
function knockFromHazard(p, m, svx, svz, awayX, awayZ) {
  const kick = m.push ?? 1;
  let vx = svx * kick;
  let vz = svz * kick;
  const minSpeed = 5 * kick;
  if (awayX !== undefined && vx * vx + vz * vz < minSpeed * minSpeed) {
    vx = awayX * minSpeed;
    vz = awayZ * minSpeed;
  }
  p.vx = vx;
  p.vz = vz;
  p.vy = Math.max(p.vy, 3.5 * Math.min(2, kick));
  p.stunT = Math.max(p.stunT, 0.9);
  p.grounded = false;
  if (m.damage) p.pendingHazardDamage = (p.pendingHazardDamage || 0) + m.damage;
}

/** Remove the velocity component pointing into a contact normal. */
function cancelIntoNormal(p, nx, ny, nz) {
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-6) return;
  nx /= len; ny /= len; nz /= len;
  const dot = p.vx * nx + p.vy * ny + p.vz * nz;
  if (dot >= 0) return;
  p.vx -= nx * dot;
  p.vy -= ny * dot;
  p.vz -= nz * dot;
}

/**
 * Player-vs-player jostle: equal-mass separation so a crowd funnelling
 * through a doorway shoves instead of overlapping. Runs once per step over
 * the whole roster (O(n) with the caller's spatial buckets). `move(p, dx, dz)`
 * replaces the direct position change (the physics backend passes one).
 */
function resolvePlayerPush(a, b, dt, C = CHARACTER, move = null) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  if (Math.abs(dy) > C.height * 0.9) return false;
  const minDist = C.pushRadius * 2;
  const d2 = dx * dx + dz * dz;
  if (d2 > minDist * minDist) return false;
  const d = Math.sqrt(d2) || 0.0001;
  const overlap = (minDist - d) * 0.5;
  const nx = dx / d;
  const nz = dz / d;
  if (move) {
    // Physics backend: separate through the character controller, so a
    // shove can never push someone into (or through) a wall.
    move(a, -nx * overlap, -nz * overlap);
    move(b, nx * overlap, nz * overlap);
  } else {
    a.x -= nx * overlap;
    a.z -= nz * overlap;
    b.x += nx * overlap;
    b.z += nz * overlap;
  }
  const impulse = Math.min(overlap * C.pushStrength, 9) * dt * 30;
  a.vx -= nx * impulse * dt;
  a.vz -= nz * impulse * dt;
  b.vx += nx * impulse * dt;
  b.vz += nz * impulse * dt;
  return true;
}

/**
 * World manifest → runtime world.
 *
 * A **manifest** is plain JSON describing a place: its solids (which are both
 * the collision geometry and the thing the renderer draws), moving hazards,
 * spawn points, parked vehicles, pickups, checkpoints and zones. The server
 * and every client build their world from the same manifest — usually from
 * the same seed — so nobody has to ship a mesh file and the two sides cannot
 * disagree about where a wall is.
 *
 *   const world = buildWorld(manifest);
 *   world.collision.raycast(...)   // physics queries
 *   world.movers                   // hazards, already time-driven
 *   world.manifest                 // hand this to the renderer verbatim
 */

const DEFAULT_THEME = {
  sky: '#9fc7ef',
  fog: '#c9dcf0',
  ground: '#6f7c74',
  road: '#3b3f45',
  line: '#e9e2c8',
  buildings: ['#8b8f98', '#a5a29b', '#7d8894', '#9b9086', '#6f7681'],
  accent: '#ff5a3c',
  water: '#3f7fa8',
};

/** Normalise a manifest: fill defaults, stamp ids, validate the essentials. */
function normalizeManifest(manifest) {
  const m = {
    id: manifest.id || 'world',
    name: manifest.name || 'World',
    seed: manifest.seed ?? 1,
    groundY: manifest.groundY === null ? null : (manifest.groundY ?? 0),
    killY: manifest.killY ?? -25,
    bounds: manifest.bounds || { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
    theme: { ...DEFAULT_THEME, ...(manifest.theme || {}) },
    solids: manifest.solids || [],
    props: manifest.props || [],
    movers: manifest.movers || [],
    spawns: manifest.spawns || [{ x: 0, y: 0, z: 0, yaw: 0 }],
    vehicleSpawns: manifest.vehicleSpawns || [],
    pickups: manifest.pickups || [],
    checkpoints: manifest.checkpoints || [],
    zones: manifest.zones || [],
    meshes: manifest.meshes || [],      // [{vertices:[x,y,z,…], indices:[…]}] — Rapier backend only
    rollers: manifest.rollers || [],    // ball spawners — Rapier backend only
    game: manifest.game || {},          // the game's own data (bot routes, podiums…), carried untouched
    character: manifest.character || null,  // per-world movement tuning (e.g. one run speed)
  };
  if (!m.spawns.length) throw new Error('world manifest needs at least one spawn point');
  m.movers.forEach((mv, i) => { if (!mv.id) mv.id = 'mv' + i; });
  m.pickups.forEach((pk, i) => { if (!pk.id) pk.id = 'pk' + i; });
  m.checkpoints.forEach((cp, i) => { if (!cp.id) cp.id = 'cp' + i; if (cp.order == null) cp.order = i; });
  m.zones.forEach((z, i) => { if (!z.id) z.id = 'zn' + i; });
  m.rollers.forEach((r, i) => { if (!r.id) r.id = 'rl' + i; });
  return m;
}

/**
 * @param {object} manifest
 * @param {object} [options]
 * @param {object} [options.rapier]  initialised RAPIER namespace → Rapier
 *   physics backend (real meshes, character controller, rolling balls).
 *   Without it the world uses the arcade box/ramp backend.
 * @param {number} [options.dt]      fixed simulation step (Rapier backend)
 */
function buildWorld(manifest, options = {}) {
  const m = normalizeManifest(manifest);
  const collision = createCollisionWorld({
    solids: m.solids,
    groundY: m.groundY,
    cellSize: manifest.cellSize || 16,
  });
  const movers = m.movers.map(createMover);
  updateMovers(movers, 0);
  const moverById = new Map(movers.map(mv => [mv.id, mv]));
  // Movement tuning lives in the manifest so the server and every phone's
  // prediction read the same numbers.
  const character = m.character ? { ...CHARACTER, ...m.character } : CHARACTER;
  const physics = options.rapier
    ? createPhysics(options.rapier, m, movers, { character, dt: options.dt, gravity: manifest.gravity })
    : null;
  const checkpoints = m.checkpoints.slice().sort((a, b) => a.order - b.order);

  return {
    manifest: m,
    collision,
    movers,
    moverById,
    physics,
    character,
    checkpoints,
    zones: m.zones,
    spawns: m.spawns,
    vehicleSpawns: m.vehicleSpawns,
    pickups: m.pickups,
    bounds: m.bounds,
    killY: m.killY,
    /**
     * Advance hazards to world time `t` (seconds). Pure function of `t`, so a
     * phone replaying history can jump back and forth freely. With physics,
     * the new poses are visible to queries after the next physics step.
     */
    update(t) {
      updateMovers(movers, t);
      if (physics) physics.syncMovers();
    },
    /** Release native physics memory (Rapier backend). */
    dispose() { if (physics) physics.free(); },
    /** Spawn point chosen to be as far as possible from the given entities. */
    pickSpawn(avoid, tag, rng) {
      const pool = tag ? m.spawns.filter(s => s.tag === tag) : m.spawns;
      const spawns = pool.length ? pool : m.spawns;
      const roll = rng || Math.random;
      if (!avoid || !avoid.length) return spawns[(roll() * spawns.length) | 0];
      let best = spawns[0];
      let bestScore = -Infinity;
      for (const s of spawns) {
        let nearest = Infinity;
        for (const a of avoid) {
          const d = distSq2(s.x, s.z, a.x, a.z);
          if (d < nearest) nearest = d;
        }
        if (nearest > bestScore) { bestScore = nearest; best = s; }
      }
      return best;
    },
    /** True when a point is inside a zone (`radius` circles or `rx/rz` boxes). */
    zoneContains(zone, x, z) {
      if (zone.radius) return distSq2(x, z, zone.x, zone.z) <= zone.radius * zone.radius;
      return Math.abs(x - zone.x) <= (zone.rx || 0) && Math.abs(z - zone.z) <= (zone.rz || 0);
    },
    /** True when the point is outside the playable bounds. */
    outOfBounds(x, z) {
      const b = m.bounds;
      return x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ;
    },
  };
}

/**
 * Checkpoint gate test — a player passes when they are inside the gate's
 * radius. Gates are cylinders on purpose: a plane crossing test punishes
 * players who clip a corner at 40 m/s, and this is an arcade racer.
 */
function atCheckpoint(cp, x, y, z) {
  const r = cp.radius || 9;
  if (distSq2(x, z, cp.x, cp.z) > r * r) return false;
  const height = cp.height || 12;
  return y >= cp.y - 3 && y <= cp.y + height;
}

/**
 * Deterministic RNG.
 *
 * `Math.random()` is banned everywhere the server and client must agree
 * (world generation, hazard layout, spawn shuffling): both sides build the
 * same world from the same seed, so a shared stream is the only way the two
 * stay identical. Gameplay randomness that only the server decides (weapon
 * spread) uses a server-owned stream instead.
 *
 * mulberry32 — 32-bit, fast, well-distributed, and identical in every JS
 * engine because it only uses integer ops that stay inside 2^32.
 */
function createRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const rng = function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Uniform float in [lo, hi). */
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  /** Uniform integer in [lo, hi]. */
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  /** Pick one element. */
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** True with probability p. */
  rng.chance = (p) => rng() < p;
  return rng;
}

/**
 * Rollers — balls that spawn on a schedule and tumble down the level
 * (Rapier backend only, simulated on the server and interpolated on phones).
 *
 * Spec (from the world manifest):
 *   { id, x, y, z, radius?, every?, first?, life?, max?, vx?, vy?, vz? }
 *     every  — seconds between balls (default 3)
 *     first  — world time of the first ball (default 0)
 *     life   — seconds before a ball is removed (default 12)
 *     max    — cap on live balls from this spawner (default 6)
 *     v*     — launch velocity
 *     push   — share of the ball's speed a hit transfers to a player (default 0.6)
 *     despawn — optional box {minX, maxX, minZ, maxZ}: a ball leaving it is
 *               removed (e.g. at the foot of a ramp)
 *
 * Spawning is a pure function of world time, so a restarted room produces
 * the same balls at the same moments.
 */

function createRollers(world) {
  const physics = world.physics;
  const spawners = (world.manifest.rollers || []).map((spec) => ({
    spec,
    every: Math.max(0.25, spec.every ?? 3),
    first: spec.first ?? 0,
    life: spec.life ?? 12,
    max: spec.max ?? 6,
    radius: spec.radius ?? 1.2,
    lastIndex: -1,
    live: [],          // [{id, until}]
  }));

  function preStep(sim) {
    const t = sim.state.t;
    for (const sp of spawners) {
      if (t < sp.first) continue;
      const index = Math.floor((t - sp.first) / sp.every);
      if (index <= sp.lastIndex) continue;
      sp.lastIndex = index;
      if (sp.live.length >= sp.max) continue;
      const s = sp.spec;
      const id = s.id + '_' + index;
      physics.addRoller(id, s.x, s.y ?? 0, s.z, sp.radius, s.vx || 0, s.vy || 0, s.vz || 0, s.push ?? 0.6);
      sp.live.push({ id, until: t + sp.life });
      sim.emit({ e: 'roll', id, x: q(s.x), y: q(s.z) });
    }
  }

  function postStep(sim) {
    const t = sim.state.t;
    const killY = world.killY;
    for (const sp of spawners) {
      for (let i = sp.live.length - 1; i >= 0; i--) {
        const ball = sp.live[i];
        const roller = physics.rollers.get(ball.id);
        const pos = roller ? roller.body.translation() : null;
        const d = sp.spec.despawn;
        const outside = d && pos && (pos.x < (d.minX ?? -Infinity) || pos.x > (d.maxX ?? Infinity)
          || pos.z < (d.minZ ?? -Infinity) || pos.z > (d.maxZ ?? Infinity));
        if (pos && t < ball.until && pos.y > killY && !outside) continue;
        if (outside) sim.emit({ e: 'pop', id: ball.id, x: q(pos.x), y: q(pos.z), h: q(pos.y) });
        physics.removeRoller(ball.id);
        sp.live.splice(i, 1);
      }
    }
  }

  /** Project live balls as network entities: k 'o', x/y on the ground plane, h height. */
  function project(out) {
    for (const roller of physics.rollers.values()) {
      const p = roller.body.translation();
      out[roller.id] = { k: 'o', x: q(p.x), y: q(p.z), h: q(p.y), r: roller.r };
    }
  }

  return { preStep, postStep, project, spawners };
}

/**
 * Input normalisation shared by the server and the phone.
 *
 * The server clamps every raw client input with this before simulating it,
 * and the phone runs the SAME function on what it sends, so a predicted tick
 * and the server's tick see bit-identical input.
 */

/** Clamp one raw input into `out` (allocation-free when `out` is reused). */
function normalizeInput(raw, out = {}) {
  out.mx = clamp(Number(raw.mx) || 0, -1, 1);
  out.mz = clamp(Number(raw.mz) || 0, -1, 1);
  out.aim = Number.isFinite(raw.aim) ? wrapAngle(Number(raw.aim)) : undefined;
  out.jump = !!raw.jump;
  out.sprint = !!raw.sprint;
  out.dive = !!raw.dive;
  out.throttle = clamp(Number(raw.throttle) || 0, -1, 1);
  out.steer = clamp(Number(raw.steer) || 0, -1, 1);
  out.handbrake = !!raw.handbrake;
  out.fire = !!raw.fire;
  out.aimX = Number(raw.aimX) || 0;
  out.aimY = Number(raw.aimY) || 0;
  out.aimZ = Number(raw.aimZ) || 0;
  out.use = !!raw.use;
  out.weapon = typeof raw.weapon === 'string' ? raw.weapon.slice(0, 32) : undefined;
  return out;
}

/**
 * Arcade vehicles.
 *
 * The model is deliberately a *driving* model, not a rigid-body simulation:
 * forward/lateral velocity split, speed-sensitive steering, grip that drops
 * on the handbrake so the car drifts, four ground samples for suspension and
 * body angles, and sphere collisions that bounce you off buildings. It reads
 * like GTA to a player and, unlike a real solver, it is deterministic, cheap,
 * and safe to run inside a sandboxed isolate for dozens of cars at once.
 */

/** Built-in vehicle classes. Creators can pass their own spec object. */
const VEHICLE_SPECS = {
  sedan: {
    name: 'sedan', mass: 1300, halfLength: 2.2, halfWidth: 0.95, height: 1.5,
    maxSpeed: 30, reverseSpeed: 9, accel: 12, brake: 26, drag: 0.0045,
    rollingResist: 2.2, grip: 9, driftGrip: 2.6, maxSteer: 0.62,
    steerSpeed: 6, wheelBase: 3.4, hp: 100, seats: 4,
  },
  sport: {
    name: 'sport', mass: 1150, halfLength: 2.1, halfWidth: 0.9, height: 1.25,
    maxSpeed: 41, reverseSpeed: 10, accel: 17, brake: 30, drag: 0.0038,
    rollingResist: 2.0, grip: 10.5, driftGrip: 2.4, maxSteer: 0.58,
    steerSpeed: 7, wheelBase: 3.2, hp: 90, seats: 2,
  },
  truck: {
    name: 'truck', mass: 3400, halfLength: 3.2, halfWidth: 1.25, height: 2.6,
    maxSpeed: 22, reverseSpeed: 7, accel: 7.5, brake: 18, drag: 0.0075,
    rollingResist: 3.0, grip: 6.5, driftGrip: 2.2, maxSteer: 0.5,
    steerSpeed: 4.5, wheelBase: 4.6, hp: 180, seats: 2,
  },
  kart: {
    name: 'kart', mass: 420, halfLength: 1.35, halfWidth: 0.75, height: 1.0,
    maxSpeed: 26, reverseSpeed: 8, accel: 16, brake: 24, drag: 0.005,
    rollingResist: 2.4, grip: 12, driftGrip: 3.2, maxSteer: 0.75,
    steerSpeed: 9, wheelBase: 2.2, hp: 60, seats: 1,
  },
};

const VEHICLE = {
  gravity: 24,
  suspensionSnap: 14,     // how fast the body settles onto the wheels
  crashDamagePerSpeed: 2.4,
  crashThreshold: 8,      // m/s of impact before paint gets scratched
  bounce: 0.35,
  pedKnockSpeed: 4,       // relative speed that knocks a pedestrian down
};

const push = { x: 0, y: 0, z: 0, hit: false, mover: null, vx: 0, vy: 0, vz: 0 };

function getSpec(kind) {
  return VEHICLE_SPECS[kind] || VEHICLE_SPECS.sedan;
}

/** Create a vehicle entity ready to be dropped into `state.vehicles`. */
function createVehicle(id, kind, x, y, z, yaw = 0) {
  const spec = getSpec(kind);
  return {
    id,
    kind,
    x, y, z, yaw,
    vx: 0, vy: 0, vz: 0,
    steer: 0,
    yawRate: 0,
    pitch: 0, roll: 0,
    grounded: true,
    hp: spec.hp,
    maxHp: spec.hp,
    driver: null,
    passengers: [],
    homeX: x, homeY: y, homeZ: z, homeYaw: yaw,
    idleFor: 0,
    lastDriver: null,
  };
}

/** Put a wrecked or abandoned vehicle back where it spawned. */
function respawnVehicle(v) {
  const spec = getSpec(v.kind);
  v.x = v.homeX; v.y = v.homeY; v.z = v.homeZ; v.yaw = v.homeYaw;
  v.vx = 0; v.vy = 0; v.vz = 0;
  v.steer = 0; v.yawRate = 0; v.pitch = 0; v.roll = 0;
  v.hp = spec.hp;
  v.driver = null;
  v.passengers = [];
  v.idleFor = 0;
  return v;
}

/**
 * Advance one vehicle.
 *
 * @param {object} v     vehicle entity (mutated)
 * @param {object} input {throttle:-1..1, steer:-1..1, handbrake:boolean} or null when driverless
 * @param {number} dt    seconds
 * @param {object} ctx   {collision, movers}
 */
function stepVehicle(v, input, dt, ctx) {
  const spec = getSpec(v.kind);
  const collision = ctx.collision;
  const movers = ctx.movers || [];

  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  const rx = fz;
  const rz = -fx;

  let vf = v.vx * fx + v.vz * fz;      // forward speed (signed)
  let vl = v.vx * rx + v.vz * rz;      // lateral slip

  const throttle = input ? clamp(input.throttle || 0, -1, 1) : 0;
  const steerInput = input ? clamp(input.steer || 0, -1, 1) : 0;
  const handbrake = !!(input && input.handbrake);

  // ---- steering: less lock the faster you go, more yaw while drifting -----
  const speedFrac = Math.min(1, Math.abs(vf) / spec.maxSpeed);
  const steerLimit = spec.maxSteer * (1 - 0.62 * speedFrac);
  const targetSteer = steerInput * steerLimit;
  v.steer += clamp(targetSteer - v.steer, -spec.steerSpeed * dt, spec.steerSpeed * dt);

  if (v.grounded) {
    // ---- engine / brakes --------------------------------------------------
    if (throttle > 0) {
      if (vf < -0.5) vf += spec.brake * throttle * dt;
      else vf += spec.accel * throttle * dt;
    } else if (throttle < 0) {
      if (vf > 0.5) vf += spec.brake * throttle * dt;
      else vf += spec.accel * 0.55 * throttle * dt;
    }
    if (handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), spec.brake * 0.6 * dt);

    // ---- resistance -------------------------------------------------------
    vf -= vf * Math.abs(vf) * spec.drag * dt * 10;
    const roll = spec.rollingResist * dt;
    if (Math.abs(vf) <= roll && throttle === 0) vf = 0;
    else vf -= Math.sign(vf) * roll * (throttle === 0 ? 1 : 0.25);
    vf = clamp(vf, -spec.reverseSpeed, spec.maxSpeed);

    // ---- yaw from the steered wheels --------------------------------------
    const turn = (vf / spec.wheelBase) * Math.tan(v.steer);
    v.yawRate = turn * (handbrake ? 1.55 : 1);
    v.yaw = wrapAngle(v.yaw + v.yawRate * dt);

    // ---- grip: how much sideways slide survives the step -------------------
    const grip = handbrake ? spec.driftGrip : spec.grip;
    vl *= Math.exp(-grip * dt);
  } else {
    v.yaw = wrapAngle(v.yaw + v.yawRate * dt * 0.6);
    vl *= Math.exp(-0.4 * dt);
  }

  // recompose after yaw changed
  const nfx = Math.sin(v.yaw);
  const nfz = Math.cos(v.yaw);
  v.vx = nfx * vf + nfz * vl;
  v.vz = nfz * vf - nfx * vl;

  // ---- vertical -----------------------------------------------------------
  if (!v.grounded) {
    v.vy -= VEHICLE.gravity * dt;
    if (v.vy < -45) v.vy = -45;
  }

  v.x += v.vx * dt;
  v.y += v.vy * dt;
  v.z += v.vz * dt;

  // ---- suspension: four ground samples give height, pitch and roll --------
  const wl = spec.halfLength * 0.85;
  const ww = spec.halfWidth * 0.9;
  const probeY = v.y + 0.9;
  const fl = groundAt(collision, v.x + nfx * wl - nfz * ww, v.z + nfz * wl + nfx * ww, probeY);
  const fr = groundAt(collision, v.x + nfx * wl + nfz * ww, v.z + nfz * wl - nfx * ww, probeY);
  const rl = groundAt(collision, v.x - nfx * wl - nfz * ww, v.z - nfz * wl + nfx * ww, probeY);
  const rr = groundAt(collision, v.x - nfx * wl + nfz * ww, v.z - nfz * wl - nfx * ww, probeY);
  const support = Math.max(Math.max(fl, fr), Math.max(rl, rr));

  if (support > -Infinity && v.y <= support + 0.35) {
    v.y += (support - v.y) * Math.min(1, VEHICLE.suspensionSnap * dt);
    if (v.y < support) v.y = support;
    if (v.vy < 0) v.vy = 0;
    v.grounded = true;
    const front = (fl + fr) * 0.5;
    const rear = (rl + rr) * 0.5;
    const left = (fl + rl) * 0.5;
    const right = (fr + rr) * 0.5;
    if (Number.isFinite(front) && Number.isFinite(rear)) {
      v.pitch = Math.atan2(rear - front, wl * 2);
    }
    if (Number.isFinite(left) && Number.isFinite(right)) {
      v.roll = Math.atan2(right - left, ww * 2);
    }
  } else {
    v.grounded = false;
    v.pitch *= Math.exp(-3 * dt);
    v.roll *= Math.exp(-3 * dt);
  }

  // ---- body collision: three spheres along the chassis --------------------
  // The spheres ride ABOVE the wheels: one big enough to reach the tarmac
  // would fight the suspension on every ramp and kerb, and the car would
  // simply refuse to climb.
  const bodyR = spec.halfWidth;
  const bodyY = v.y + bodyR + 0.2;
  let impact = 0;
  for (let i = -1; i <= 1; i += 1) {
    const cx = v.x + nfx * (spec.halfLength - bodyR) * i;
    const cz = v.z + nfz * (spec.halfLength - bodyR) * i;
    const fix = collision.resolveSphere(cx, bodyY, cz, bodyR);
    if (fix.hit) impact = Math.max(impact, applyCrash(v, fix.x, fix.y, fix.z));
    if (movers.length) {
      resolveMovers(movers, cx + (fix.hit ? fix.x : 0), bodyY, cz + (fix.hit ? fix.z : 0), bodyR, push);
      if (push.hit) impact = Math.max(impact, applyCrash(v, push.x, push.y, push.z));
    }
  }
  if (impact > VEHICLE.crashThreshold) {
    v.hp = Math.max(0, v.hp - Math.round((impact - VEHICLE.crashThreshold) * VEHICLE.crashDamagePerSpeed));
    v.crashImpact = impact;
  }

  v.speed = length2(v.vx, v.vz);
  if (v.driver) v.idleFor = 0;
  else v.idleFor += dt;
  return v;
}

function groundAt(collision, x, z, fromY) {
  return collision.sampleGround(x, z, fromY, 0.2).y;
}

/** Push the car out of a solid, kill the velocity into it, report impact. */
function applyCrash(v, nx, ny, nz) {
  v.x += nx;
  v.z += nz;
  if (ny > 0) { v.y += ny; if (v.vy < 0) v.vy = 0; }
  const len = Math.sqrt(nx * nx + nz * nz);
  if (len < 1e-6) return 0;
  const ux = nx / len;
  const uz = nz / len;
  const into = v.vx * ux + v.vz * uz;
  if (into >= 0) return 0;
  v.vx -= ux * into * (1 + VEHICLE.bounce);
  v.vz -= uz * into * (1 + VEHICLE.bounce);
  return -into;
}

/**
 * Elastic-ish collision between two vehicles: separate them, then exchange
 * momentum by mass so a truck shunts a kart and not the other way round.
 */
function resolveVehiclePair(a, b) {
  const sa = getSpec(a.kind);
  const sb = getSpec(b.kind);
  const ra = Math.max(sa.halfWidth, sa.halfLength * 0.6);
  const rb = Math.max(sb.halfWidth, sb.halfLength * 0.6);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.abs(b.y - a.y) > 2.5) return 0;
  const minDist = ra + rb;
  const d2 = dx * dx + dz * dz;
  if (d2 > minDist * minDist || d2 < 1e-9) return 0;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const nz = dz / d;
  const overlap = minDist - d;
  const total = sa.mass + sb.mass;
  a.x -= nx * overlap * (sb.mass / total);
  a.z -= nz * overlap * (sb.mass / total);
  b.x += nx * overlap * (sa.mass / total);
  b.z += nz * overlap * (sa.mass / total);

  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel >= 0) return 0;
  const impulse = -1.35 * rel / (1 / sa.mass + 1 / sb.mass);
  a.vx -= (impulse / sa.mass) * nx;
  a.vz -= (impulse / sa.mass) * nz;
  b.vx += (impulse / sb.mass) * nx;
  b.vz += (impulse / sb.mass) * nz;
  const speed = -rel;
  if (speed > VEHICLE.crashThreshold) {
    const dmg = Math.round((speed - VEHICLE.crashThreshold) * VEHICLE.crashDamagePerSpeed);
    a.hp = Math.max(0, a.hp - Math.round(dmg * (sb.mass / total) * 2));
    b.hp = Math.max(0, b.hp - Math.round(dmg * (sa.mass / total) * 2));
  }
  return speed;
}

/** Seat offset for a rider, in world space. */
function seatPosition(v, seat, out) {
  const spec = getSpec(v.kind);
  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  const side = seat % 2 === 0 ? -1 : 1;
  const row = seat < 2 ? 0.35 : -0.75;
  const lateral = spec.halfWidth * 0.5 * side;
  out.x = v.x + fx * (spec.halfLength * row) + fz * lateral;
  out.y = v.y + spec.height * 0.35;
  out.z = v.z + fz * (spec.halfLength * row) - fx * lateral;
  return out;
}

/**
 * Weapons, damage and projectiles.
 *
 * Shooting is server-authoritative: a client sends "I fired, aiming here" and
 * the server does every trace, so a modified client cannot invent hits. Aim
 * direction is the one thing we take from the client (it is a view property),
 * and it is normalised and range-clamped before use.
 *
 * Hitscan traces run against the static world, players and vehicles; the
 * nearest blocker wins, so you cannot shoot through a building.
 */

/**
 * Built-in weapons. `kind` is 'hitscan' | 'projectile' | 'melee'.
 * `rpm` is rounds per minute; `spread` is the cone half-angle in radians.
 */
const WEAPONS = {
  shove: {
    name: 'shove', kind: 'melee', damage: 8, range: 2.6, rpm: 90,
    knockback: 13, stun: 0.8, ammo: Infinity, reload: 0, arc: 0.9,
  },
  pistol: {
    name: 'pistol', kind: 'hitscan', damage: 20, range: 90, rpm: 300,
    spread: 0.012, pellets: 1, ammo: 12, reload: 1.4, knockback: 1.5, falloff: 0.45,
  },
  smg: {
    name: 'smg', kind: 'hitscan', damage: 12, range: 65, rpm: 780,
    spread: 0.045, pellets: 1, ammo: 30, reload: 1.8, knockback: 1, falloff: 0.55,
  },
  shotgun: {
    name: 'shotgun', kind: 'hitscan', damage: 9, range: 32, rpm: 75,
    spread: 0.13, pellets: 8, ammo: 6, reload: 2.4, knockback: 6, falloff: 0.75,
  },
  rifle: {
    name: 'rifle', kind: 'hitscan', damage: 28, range: 150, rpm: 400,
    spread: 0.01, pellets: 1, ammo: 25, reload: 2.1, knockback: 2, falloff: 0.25,
  },
  rocket: {
    name: 'rocket', kind: 'projectile', damage: 85, range: 200, rpm: 45,
    speed: 42, splash: 7, splashDamage: 60, ammo: 3, reload: 3.2,
    knockback: 22, gravity: 2,
  },
};

function getWeapon(name) {
  return WEAPONS[name] || WEAPONS.shove;
}

/** Fresh loadout for a spawning player. */
function resetLoadout(p, weapons = ['shove']) {
  p.weapons = weapons.slice();
  p.weapon = weapons[0];
  p.ammo = {};
  for (const name of weapons) {
    const w = getWeapon(name);
    p.ammo[name] = w.ammo === Infinity ? -1 : w.ammo;
  }
  p.nextFire = 0;
  p.reloadUntil = 0;
  return p;
}

function giveWeapon(p, name, ammo) {
  const w = getWeapon(name);
  if (!p.weapons) resetLoadout(p, [name]);
  if (p.weapons.indexOf(name) === -1) p.weapons.push(name);
  const cap = w.ammo === Infinity ? -1 : w.ammo;
  p.ammo[name] = cap === -1 ? -1 : Math.min(cap, (p.ammo[name] > 0 ? p.ammo[name] : 0) + (ammo ?? cap));
  p.weapon = name;
  return p;
}

/** Can this player pull the trigger right now? */
function canFire(p, now) {
  if (!p.weapons || p.hp <= 0 || p.stunT > 0) return false;
  if (now < p.nextFire || now < p.reloadUntil) return false;
  const ammo = p.ammo[p.weapon];
  return ammo === -1 || ammo > 0;
}

/**
 * Ray vs vertical capsule (a standing player). Returns entry distance or -1.
 * Solves the closest-approach of the ray to the capsule's core segment.
 */
function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cy0, cz, cy1, radius, maxT) {
  // The capsule axis is vertical, so this reduces to a 2D circle test in XZ
  // plus a height check at the hit — accurate enough for 0.4 m capsules and
  // far cheaper than the general segment-segment form.
  const mx = ox - cx;
  const mz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - radius * radius;
  if (a < 1e-9) {
    if (c > 0) return -1;
    // Straight down/up the axis: hit the cap we reach first.
    const t = dy > 0 ? (cy0 - oy) / dy : (cy1 - oy) / dy;
    return t >= 0 && t <= maxT ? t : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  const hy = oy + dy * t;
  if (hy >= cy0 - radius && hy <= cy1 + radius) return t;
  // Clip against the cap planes when the ray enters above/below the body.
  if (Math.abs(dy) < 1e-9) return -1;
  const tTop = (cy1 - oy) / dy;
  const tBot = (cy0 - oy) / dy;
  for (const tc of [tTop, tBot]) {
    if (tc < 0 || tc > maxT) continue;
    const px = ox + dx * tc - cx;
    const pz = oz + dz * tc - cz;
    if (px * px + pz * pz <= radius * radius) return tc;
  }
  return -1;
}

/** Ray vs a vehicle body, approximated by two spheres along the chassis. */
function rayVehicle(v, ox, oy, oz, dx, dy, dz, maxT) {
  const spec = getSpec(v.kind);
  const r = Math.max(spec.halfWidth, spec.halfLength * 0.55);
  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  let best = -1;
  for (let i = -1; i <= 1; i += 2) {
    const cx = v.x + fx * (spec.halfLength - r) * i;
    const cy = v.y + spec.height * 0.5;
    const cz = v.z + fz * (spec.halfLength - r) * i;
    const t = raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - 4 * c;      // direction is unit length, so a = 1
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / 2;
  if (t < 0) t = (-b + sq) / 2;
  return (t >= 0 && t <= maxT) ? t : -1;
}

/**
 * Trace one shot through the world.
 *
 * `ctx` provides `collision`, `players` (array), `vehicles` (array) and the
 * shooter id to skip. Returns the closest hit as
 * `{kind:'player'|'vehicle'|'world', id, t, x, y, z}` or null.
 */
function traceShot(ctx, shooterId, ox, oy, oz, dx, dy, dz, maxT) {
  let bestT = maxT;
  let hit = null;

  const wall = ctx.collision.raycast(ox, oy, oz, dx, dy, dz, maxT);
  if (wall) {
    bestT = wall.t;
    hit = { kind: 'world', id: null, t: wall.t, x: wall.x, y: wall.y, z: wall.z };
  }

  const players = ctx.players || [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.id === shooterId || p.hp <= 0 || p.veh) continue;
    const t = rayCapsule(
      ox, oy, oz, dx, dy, dz,
      p.x, p.y + CHARACTER.radius, p.z, p.y + CHARACTER.height - CHARACTER.radius,
      CHARACTER.radius * 1.15, bestT,
    );
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    hit = { kind: 'player', id: p.id, t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, target: p };
  }

  const vehicles = ctx.vehicles || [];
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (v.id === ctx.ignoreVehicle) continue;
    const t = rayVehicle(v, ox, oy, oz, dx, dy, dz, bestT);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    hit = { kind: 'vehicle', id: v.id, t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, target: v };
  }

  return hit;
}

/** Muzzle position for a player (eye height, slightly forward). */
function muzzleOf(p, out) {
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  out.x = p.x + fx * 0.35;
  out.y = p.y + CHARACTER.eyeHeight;
  out.z = p.z + fz * 0.35;
  return out;
}

/** Normalise a client-supplied aim vector; falls back to the player's facing. */
function normalizeAim(p, ax, ay, az, out) {
  let x = Number(ax);
  let y = Number(ay);
  let z = Number(az);
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(len) || len < 1e-4) {
    out.x = Math.sin(p.yaw);
    out.y = 0;
    out.z = Math.cos(p.yaw);
    return out;
  }
  out.x = x / len;
  out.y = clamp(y / len, -0.95, 0.95);
  out.z = z / len;
  const l2 = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  out.x /= l2; out.y /= l2; out.z /= l2;
  return out;
}

/** Damage falloff over distance — full damage up close, `falloff` at max range. */
function damageAt(weapon, distance) {
  const f = weapon.falloff ?? 0;
  const t = clamp(distance / Math.max(1, weapon.range), 0, 1);
  return weapon.damage * (1 - f * t);
}

/** Step every projectile: move, trace the segment it covered, explode. */
function stepProjectiles(state, dt, ctx, onHit) {
  const list = state.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    const w = getWeapon(b.weapon);
    b.life -= dt;
    if (b.life <= 0) { list.splice(i, 1); continue; }
    const stepLen = b.speed * dt;
    const hit = traceShot(ctx, b.owner, b.x, b.y, b.z, b.dx, b.dy, b.dz, stepLen);
    b.x += b.dx * stepLen;
    b.y += b.dy * stepLen;
    b.z += b.dz * stepLen;
    if (w.gravity) {
      b.dy -= (w.gravity * dt) / Math.max(1e-3, b.speed);
      const l = Math.sqrt(b.dx * b.dx + b.dy * b.dy + b.dz * b.dz);
      b.dx /= l; b.dy /= l; b.dz /= l;
    }
    if (!hit) continue;
    list.splice(i, 1);
    onHit(b, w, hit);
  }
}

/**
 * The simulation — one authoritative world tick.
 *
 * This is the piece the server runs as truth and the client re-runs to
 * predict the local player. It owns players, vehicles, projectiles, pickups
 * and the interaction between them; the *rules* (who scores, when a round
 * ends) live in a mode object so creators never fork this file.
 *
 * Network entity convention (matters — the platform's area-of-interest grid
 * slices on `x`/`y`):
 *   x = world X, y = world Z (the ground plane), h = world Y (height).
 */

const SIM_DEFAULTS = {
  tickHz: 30,
  respawnDelay: 4,
  vehicleRespawnDelay: 20,
  vehicleIdleReset: 90,      // abandoned far from home → returns after this
  friendlyFire: false,
  fallDamage: true,
  startWeapons: ['shove'],
  maxProjectiles: 120,
  pickupRespawn: 20,
  eventBudget: 60,           // per-tick cap on broadcast events
  maxInputQueue: 6,          // buffered inputs per player (~200 ms at 30 Hz)
};

const ZERO_INPUT = { mx: 0, mz: 0, aim: undefined, jump: false, sprint: false, dive: false };
const tmpSeat = { x: 0, y: 0, z: 0 };
const tmpMuzzle = { x: 0, y: 0, z: 0 };
const tmpAim = { x: 0, y: 0, z: 0 };

function createSimulation(options) {
  const world = options.world;
  const mode = options.mode || null;
  // Mode settings (e.g. deathmatch start weapons) sit between the engine
  // defaults and whatever the server explicitly passes.
  const config = { ...SIM_DEFAULTS, ...((mode && mode.config) || {}), ...(options.config || {}) };
  const rng = options.rng || createRng(options.seed ?? 12345);

  const state = {
    t: 0,
    tick: 0,
    players: {},
    vehicles: {},
    projectiles: [],
    pickups: {},
    mode: {},
  };

  let events = [];
  let nextProjectileId = 1;
  const playerList = [];
  const vehicleList = [];
  const traceCtx = { collision: world.collision, players: playerList, vehicles: vehicleList, ignoreVehicle: null };
  const charCtx = {
    collision: world.collision, movers: world.movers, physics: world.physics,
    moverById: world.moverById, config: world.character,
  };
  const rollers = world.physics ? createRollers(world) : null;
  const pushMove = world.physics ? (p, dx, dz) => world.physics.moveCharacter(p, dx, 0, dz) : null;

  // Parked vehicles come from the manifest and live for the world's lifetime.
  (world.vehicleSpawns || []).forEach((vs, i) => {
    const id = vs.id || ('veh' + i);
    state.vehicles[id] = createVehicle(id, vs.kind || 'sedan', vs.x, vs.y ?? 0, vs.z, vs.yaw || 0);
  });
  (world.pickups || []).forEach((pk) => {
    state.pickups[pk.id] = { id: pk.id, ready: true, readyAt: 0 };
  });
  refreshLists();

  function refreshLists() {
    playerList.length = 0;
    for (const id in state.players) playerList.push(state.players[id]);
    vehicleList.length = 0;
    for (const id in state.vehicles) vehicleList.push(state.vehicles[id]);
  }

  function emit(event) {
    if (events.length < config.eventBudget) events.push(event);
  }

  // ---------------------------------------------------------------- players

  function addPlayer(id, name, extra) {
    const spawn = world.pickSpawn(playerList.filter(p => p.hp > 0), extra && extra.spawnTag, rng);
    const p = {
      id,
      name: name || 'Player',
      team: (extra && extra.team) || null,
      hp: 100,
      maxHp: 100,
      score: 0,
      kills: 0,
      deaths: 0,
      deadUntil: 0,
      joinedAt: state.t,
      lastSeq: 0,
      input: { ...ZERO_INPUT },
      inputQueue: [],
      teleports: 0,
      firing: false,
      pendingFallDamage: 0,
      pendingHazardDamage: 0,
      lap: 0,
      nextCp: 0,
      cpTime: 0,
    };
    spawnCharacter(p, spawn);
    resetLoadout(p, config.startWeapons);
    state.players[id] = p;
    refreshLists();
    if (mode && mode.onJoin) mode.onJoin(api, p);
    if (mode && mode.onSpawn) mode.onSpawn(api, p);
    return p;
  }

  function removePlayer(id) {
    const p = state.players[id];
    if (!p) return;
    leaveVehicle(p, true);
    delete state.players[id];
    if (world.physics) world.physics.removeCharacter(id);
    refreshLists();
    if (mode && mode.onLeave) mode.onLeave(api, p);
  }

  /**
   * Inputs that carry a `seq` (real clients) are QUEUED and consumed one per
   * tick, so the server replays exactly what the phone predicted and the ack
   * means "applied". Inputs without a seq (bots, tests) apply immediately.
   * Everything is clamped here so the rest of the sim can trust it.
   */
  function setInput(id, raw) {
    const p = state.players[id];
    if (!p || !raw) return;
    if (!Number.isFinite(raw.seq)) { applyInput(p, normalizeInput(raw, p.input)); return; }
    const seq = raw.seq | 0;
    const queue = p.inputQueue;
    const newest = queue.length ? queue[queue.length - 1].seq : p.lastSeq;
    if (seq <= newest) return;                        // duplicate or out of order
    const entry = normalizeInput(raw, {});
    entry.seq = seq;
    queue.push(entry);
    // A client whose clock runs fast would build latency forever: drop the
    // oldest so we stay within ~maxInputQueue ticks of what it is doing now.
    while (queue.length > config.maxInputQueue) queue.shift();
  }

  /** Pop this tick's input (or keep holding the last one if none arrived). */
  function consumeInput(p) {
    const next = p.inputQueue.length ? p.inputQueue.shift() : null;
    if (!next) return;
    Object.assign(p.input, next);
    p.lastSeq = next.seq;
    applyInput(p, p.input);
  }

  function applyInput(p, input) {
    if (input.use && !p.useHeld) { p.useHeld = true; toggleVehicle(p); }
    else if (!input.use) p.useHeld = false;
    if (input.weapon && p.weapons && p.weapons.indexOf(input.weapon) !== -1) p.weapon = input.weapon;
  }

  /** Drop any buffered input (disconnects): the player stops instead of replaying stale keys. */
  function clearInput(id) {
    const p = state.players[id];
    if (!p) return;
    p.inputQueue.length = 0;
    normalizeInput({}, p.input);
  }

  /**
   * Move a player somewhere new (start grids, round resets): out of any
   * vehicle, at rest, with every movement timer cleared. Bumps `teleports`
   * so the owner's prediction snaps instead of smoothing across the jump.
   * `spot.locked` (optional) also sets whether the player can move — a
   * locked player still falls and gets knocked, but ignores input.
   */
  function teleportPlayer(p, spot) {
    leaveVehicle(p, true);
    p.x = spot.x; p.y = spot.y ?? 0; p.z = spot.z;
    p.yaw = spot.yaw || 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.stunT = 0; p.diveT = 0; p.getUpT = 0; p.jumpBuffer = 0; p.coyote = 0;
    p.grounded = true;
    p.rideId = null;
    p.teleports = (p.teleports || 0) + 1;
    if (spot.locked !== undefined) p.locked = !!spot.locked;
  }

  function damagePlayer(p, amount, sourceId, cause) {
    if (p.hp <= 0 || amount <= 0) return;
    if (!config.friendlyFire && sourceId && sourceId !== p.id) {
      const src = state.players[sourceId];
      if (src && src.team && src.team === p.team) return;
    }
    if (mode && mode.onDamage) {
      const adjusted = mode.onDamage(api, p, amount, sourceId, cause);
      if (adjusted === false) return;
      if (Number.isFinite(adjusted)) amount = adjusted;
    }
    p.hp = Math.max(0, p.hp - amount);
    emit({ e: 'hurt', p: p.id, a: Math.round(amount), s: sourceId || null });
    if (p.hp <= 0) killPlayer(p, sourceId, cause);
  }

  function killPlayer(p, killerId, cause) {
    if (p.deadUntil > state.t) return;
    p.hp = 0;
    p.deaths += 1;
    p.deadUntil = state.t + config.respawnDelay;
    p.anim = 'dead';
    leaveVehicle(p, true);
    const killer = killerId && killerId !== p.id ? state.players[killerId] : null;
    if (killer) killer.kills += 1;
    emit({ e: 'kill', v: p.id, k: killer ? killer.id : null, c: cause || 'hit' });
    if (mode && mode.onDeath) mode.onDeath(api, p, killer, cause);
  }

  function respawnPlayer(p) {
    const spawn = world.pickSpawn(playerList.filter(o => o.hp > 0 && o.id !== p.id), p.spawnTag, rng);
    spawnCharacter(p, spawn);
    p.hp = p.maxHp;
    p.deadUntil = 0;
    resetLoadout(p, config.startWeapons);
    emit({ e: 'spawn', p: p.id });
    if (mode && mode.onSpawn) mode.onSpawn(api, p);
  }

  // --------------------------------------------------------------- vehicles

  function toggleVehicle(p) {
    if (p.hp <= 0) return;
    if (p.veh) leaveVehicle(p, false);
    else enterVehicle(p);
  }

  function enterVehicle(p) {
    let best = null;
    let bestDist = 4.5 * 4.5;
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      const spec = getSpec(v.kind);
      const d = distSq2(p.x, p.z, v.x, v.z);
      if (d > bestDist + spec.halfLength * spec.halfLength) continue;
      if (Math.abs(v.y - p.y) > 3) continue;
      if (v.hp <= 0) continue;
      const seats = spec.seats;
      const taken = (v.driver ? 1 : 0) + v.passengers.length;
      if (taken >= seats) continue;
      best = v;
      bestDist = d;
    }
    if (!best) return;
    if (!best.driver) { best.driver = p.id; p.seat = 0; }
    else {
      // First free passenger seat (seats are 1…n-1; people leave out of order).
      let seat = 1;
      while (best.passengers.some(id => state.players[id] && state.players[id].seat === seat)) seat += 1;
      best.passengers.push(p.id);
      p.seat = seat;
    }
    p.veh = best.id;
    p.vx = 0; p.vy = 0; p.vz = 0;
    best.lastDriver = best.driver;
    emit({ e: 'enter', p: p.id, v: best.id, s: p.seat });
    if (mode && mode.onEnterVehicle) mode.onEnterVehicle(api, p, best);
  }

  function leaveVehicle(p, silent) {
    if (!p.veh) return;
    const v = state.vehicles[p.veh];
    p.veh = null;
    if (v) {
      if (v.driver === p.id) v.driver = null;
      const idx = v.passengers.indexOf(p.id);
      if (idx !== -1) v.passengers.splice(idx, 1);
      const spec = getSpec(v.kind);
      const side = Math.cos(v.yaw);
      const sideZ = -Math.sin(v.yaw);
      p.x = v.x + side * (spec.halfWidth + 0.7);
      p.z = v.z + sideZ * (spec.halfWidth + 0.7);
      p.y = v.y + 0.2;
      p.vx = v.vx * 0.6;
      p.vz = v.vz * 0.6;
      p.vy = 1;
      p.yaw = v.yaw;
      p.grounded = false;
      if (!silent) emit({ e: 'exit', p: p.id, v: v.id });
    }
    p.seat = -1;
  }

  // ---------------------------------------------------------------- combat

  function fire(p) {
    const w = getWeapon(p.weapon);
    if (!canFire(p, state.t)) return;
    p.nextFire = state.t + 60 / w.rpm;
    if (p.ammo[p.weapon] > 0) {
      p.ammo[p.weapon] -= 1;
      if (p.ammo[p.weapon] === 0 && w.reload) p.reloadUntil = state.t + w.reload;
    }

    muzzleOf(p, tmpMuzzle);
    traceCtx.ignoreVehicle = p.veh || null;      // never hit the car you are firing from
    normalizeAim(p, p.input.aimX, p.input.aimY, p.input.aimZ, tmpAim);
    if (p.veh) {
      const v = state.vehicles[p.veh];
      if (v) { tmpMuzzle.x = v.x + tmpAim.x * 2.4; tmpMuzzle.z = v.z + tmpAim.z * 2.4; tmpMuzzle.y = v.y + 1.2; }
    }

    if (w.kind === 'melee') {
      meleeSwing(p, w, tmpAim);
      return;
    }
    if (w.kind === 'projectile') {
      if (state.projectiles.length >= config.maxProjectiles) return;
      state.projectiles.push({
        id: 'b' + (nextProjectileId++),
        owner: p.id,
        weapon: p.weapon,
        x: tmpMuzzle.x, y: tmpMuzzle.y, z: tmpMuzzle.z,
        dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z,
        speed: w.speed,
        life: Math.min(6, w.range / w.speed),
      });
      emit({ e: 'shot', p: p.id, w: p.weapon, x: q(tmpMuzzle.x), h: q(tmpMuzzle.y), y: q(tmpMuzzle.z) });
      return;
    }

    const pellets = w.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      let dx = tmpAim.x;
      let dy = tmpAim.y;
      let dz = tmpAim.z;
      if (w.spread) {
        dx += (rng() - 0.5) * w.spread * 2;
        dy += (rng() - 0.5) * w.spread * 2;
        dz += (rng() - 0.5) * w.spread * 2;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= l; dy /= l; dz /= l;
      }
      const hit = traceShot(traceCtx, p.id, tmpMuzzle.x, tmpMuzzle.y, tmpMuzzle.z, dx, dy, dz, w.range);
      const endX = hit ? hit.x : tmpMuzzle.x + dx * w.range;
      const endY = hit ? hit.y : tmpMuzzle.y + dy * w.range;
      const endZ = hit ? hit.z : tmpMuzzle.z + dz * w.range;
      if (i === 0 || pellets <= 2) {
        emit({
          e: 'shot', p: p.id, w: p.weapon,
          x: q(tmpMuzzle.x), h: q(tmpMuzzle.y), y: q(tmpMuzzle.z),
          ex: q(endX), eh: q(endY), ey: q(endZ),
        });
      }
      if (!hit) continue;
      if (hit.kind === 'player') {
        const dmg = damageAt(w, hit.t);
        applyImpulse(hit.target, dx * w.knockback, Math.max(0, dy) * w.knockback * 0.5, dz * w.knockback, 0);
        damagePlayer(hit.target, dmg, p.id, w.name);
      } else if (hit.kind === 'vehicle') {
        damageVehicle(hit.target, damageAt(w, hit.t) * 0.6, p.id);
      }
    }
  }

  function meleeSwing(p, w, aim) {
    const arc = w.arc || 0.9;
    emit({ e: 'melee', p: p.id });
    for (let i = 0; i < playerList.length; i++) {
      const o = playerList[i];
      if (o.id === p.id || o.hp <= 0 || o.veh) continue;
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > w.range * w.range) continue;
      const d = Math.sqrt(d2) || 1e-4;
      if ((dx / d) * aim.x + (dz / d) * aim.z < Math.cos(arc)) continue;
      applyImpulse(o, (dx / d) * w.knockback, 4.5, (dz / d) * w.knockback, w.stun);
      if (w.damage) damagePlayer(o, w.damage, p.id, 'shove');
      emit({ e: 'hit', p: p.id, t: o.id, w: 'shove' });
    }
  }

  function damageVehicle(v, amount, sourceId) {
    if (v.hp <= 0) return;
    v.hp = Math.max(0, v.hp - amount);
    if (v.hp > 0) return;
    emit({ e: 'wreck', v: v.id, s: sourceId || null });
    const occupants = [v.driver, ...v.passengers].filter(Boolean);
    for (const id of occupants) {
      const rider = state.players[id];
      if (!rider) continue;
      leaveVehicle(rider, true);
      damagePlayer(rider, 45, sourceId, 'explosion');
    }
    v.respawnAt = state.t + config.vehicleRespawnDelay;
  }

  function explode(x, y, z, radius, damage, ownerId, weaponName) {
    emit({ e: 'boom', x: q(x), h: q(y), y: q(z), r: radius });
    for (let i = 0; i < playerList.length; i++) {
      const o = playerList[i];
      if (o.hp <= 0) continue;
      const dx = o.x - x;
      const dy = (o.y + 0.9) - y;
      const dz = o.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const push = 18 * falloff;
      const inv = d > 1e-3 ? 1 / d : 0;
      applyImpulse(o, dx * inv * push, Math.max(3, dy * inv * push + 6), dz * inv * push, 0.7 * falloff);
      damagePlayer(o, damage * falloff, ownerId, weaponName || 'explosion');
    }
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      const d = Math.sqrt(distSq2(v.x, v.z, x, z) + (v.y - y) * (v.y - y));
      if (d > radius) continue;
      damageVehicle(v, damage * (1 - d / radius) * 0.8, ownerId);
    }
  }

  function onProjectileHit(b, w, hit) {
    if (w.splash) {
      explode(hit.x, hit.y, hit.z, w.splash, w.splashDamage ?? w.damage, b.owner, w.name);
      return;
    }
    if (hit.kind === 'player') damagePlayer(hit.target, w.damage, b.owner, w.name);
    else if (hit.kind === 'vehicle') damageVehicle(hit.target, w.damage, b.owner);
  }

  // ------------------------------------------------------------------ step

  function step(dt) {
    state.t += dt;
    state.tick += 1;
    world.update(state.t);
    if (rollers) rollers.preStep(api, dt);
    if (world.physics) world.physics.step();

    if (mode && mode.preTick) mode.preTick(api, dt);

    // --- players
    for (let i = 0; i < playerList.length; i++) consumeInput(playerList[i]);
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      if (p.hp <= 0) {
        if (state.t >= p.deadUntil && (!mode || !mode.blockRespawn || !mode.blockRespawn(api, p))) respawnPlayer(p);
        continue;
      }
      if (p.veh) {
        const v = state.vehicles[p.veh];
        if (!v || v.hp <= 0) { leaveVehicle(p, true); }
        else {
          seatPosition(v, p.seat, tmpSeat);
          p.x = tmpSeat.x; p.y = tmpSeat.y; p.z = tmpSeat.z;
          p.yaw = v.yaw;
          p.anim = 'drive';
          p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
        }
      } else {
        stepCharacter(p, p.input, dt, charCtx);
        if (config.fallDamage && p.pendingFallDamage) {
          const dmg = p.pendingFallDamage;
          p.pendingFallDamage = 0;
          damagePlayer(p, dmg, null, 'fall');
        }
        if (p.pendingHazardDamage) {
          const dmg = p.pendingHazardDamage;
          p.pendingHazardDamage = 0;
          damagePlayer(p, dmg, null, 'hazard');
        }
      }
      if (p.input.fire) fire(p);
      if (p.reloadUntil && state.t >= p.reloadUntil && p.ammo[p.weapon] === 0) {
        p.ammo[p.weapon] = getWeapon(p.weapon).ammo;
        p.reloadUntil = 0;
      }
    }

    // --- player jostle (grid-free: worlds cap at 200 and the radius is tiny)
    for (let i = 0; i < playerList.length; i++) {
      const a = playerList[i];
      if (a.hp <= 0 || a.veh) continue;
      for (let j = i + 1; j < playerList.length; j++) {
        const b = playerList[j];
        if (b.hp <= 0 || b.veh) continue;
        if (Math.abs(a.x - b.x) > 2 || Math.abs(a.z - b.z) > 2) continue;
        resolvePlayerPush(a, b, dt, CHARACTER, pushMove);
      }
    }

    // --- vehicles
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      if (v.hp <= 0) {
        if (v.respawnAt && state.t >= v.respawnAt) { respawnVehicle(v); v.respawnAt = 0; }
        continue;
      }
      const driver = v.driver ? state.players[v.driver] : null;
      stepVehicle(v, driver ? driver.input : null, dt, { collision: world.collision, movers: world.movers });
      if (v.crashImpact) {
        emit({ e: 'crash', v: v.id, s: Math.round(v.crashImpact) });
        v.crashImpact = 0;
        if (v.hp <= 0) damageVehicle(v, 0, null);
      }
      if (!driver && v.idleFor > config.vehicleIdleReset && distSq2(v.x, v.z, v.homeX, v.homeZ) > 100) {
        respawnVehicle(v);
      }
      if (v.y < world.killY) respawnVehicle(v);
    }
    for (let i = 0; i < vehicleList.length; i++) {
      for (let j = i + 1; j < vehicleList.length; j++) {
        const a = vehicleList[i];
        const b = vehicleList[j];
        if (a.hp <= 0 || b.hp <= 0) continue;
        if (Math.abs(a.x - b.x) > 12 || Math.abs(a.z - b.z) > 12) continue;
        const impact = resolveVehiclePair(a, b);
        if (impact > VEHICLE.crashThreshold) emit({ e: 'crash', v: a.id, s: Math.round(impact) });
      }
    }

    // --- cars vs pedestrians
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      if (v.hp <= 0) continue;
      const speed = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
      if (speed < VEHICLE.pedKnockSpeed) continue;
      const spec = getSpec(v.kind);
      const reach = spec.halfLength + 0.9;
      for (let j = 0; j < playerList.length; j++) {
        const p = playerList[j];
        if (p.veh || p.hp <= 0) continue;
        if (Math.abs(p.y - v.y) > 2.2) continue;
        if (distSq2(p.x, p.z, v.x, v.z) > reach * reach) continue;
        const inv = 1 / Math.max(0.001, speed);
        applyImpulse(p, v.vx * 0.9, 4 + speed * 0.18, v.vz * 0.9, 1.1);
        p.x += v.vx * inv * 0.4;
        p.z += v.vz * inv * 0.4;
        damagePlayer(p, Math.round(speed * 3.2), v.driver || null, 'vehicle');
        emit({ e: 'runover', p: p.id, v: v.id });
      }
    }

    // --- projectiles
    traceCtx.ignoreVehicle = null;
    if (state.projectiles.length) stepProjectiles(state, dt, traceCtx, onProjectileHit);
    if (rollers) rollers.postStep(api, dt);

    // --- pickups
    if (world.pickups.length) {
      for (let i = 0; i < world.pickups.length; i++) {
        const spec = world.pickups[i];
        const slot = state.pickups[spec.id];
        if (!slot.ready) {
          if (state.t >= slot.readyAt) slot.ready = true;
          continue;
        }
        for (let j = 0; j < playerList.length; j++) {
          const p = playerList[j];
          if (p.hp <= 0 || p.veh) continue;
          if (Math.abs(p.y - (spec.y ?? 0)) > 2.5) continue;
          if (distSq2(p.x, p.z, spec.x, spec.z) > 1.8 * 1.8) continue;
          takePickup(p, spec, slot);
          break;
        }
      }
    }

    // --- checkpoints
    if (world.checkpoints.length) {
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        if (p.hp <= 0) continue;
        const cp = world.checkpoints[p.nextCp % world.checkpoints.length];
        if (!cp || !atCheckpoint(cp, p.x, p.y, p.z)) continue;
        p.nextCp += 1;
        p.cpTime = state.t;
        if (p.nextCp % world.checkpoints.length === 0) p.lap += 1;
        emit({ e: 'cp', p: p.id, c: cp.id, n: p.nextCp, l: p.lap });
        if (mode && mode.onCheckpoint) mode.onCheckpoint(api, p, cp);
      }
    }

    // --- world limits
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      if (p.hp <= 0 || p.veh) continue;
      if (p.y < world.killY || world.outOfBounds(p.x, p.z)) {
        damagePlayer(p, 1000, null, 'void');
      }
    }

    if (mode && mode.onTick) mode.onTick(api, dt);
    return state;
  }

  function takePickup(p, spec, slot) {
    if (spec.kind === 'health') {
      if (p.hp >= p.maxHp) return;
      p.hp = Math.min(p.maxHp, p.hp + (spec.amount || 50));
    } else if (spec.kind === 'weapon') {
      giveWeapon(p, spec.weapon, spec.ammo);
    } else if (spec.kind === 'boost') {
      applyImpulse(p, Math.sin(p.yaw) * 12, 6, Math.cos(p.yaw) * 12, 0);
    } else if (mode && mode.onPickup) {
      mode.onPickup(api, p, spec);
    }
    slot.ready = false;
    slot.readyAt = state.t + (spec.respawn ?? config.pickupRespawn);
    emit({ e: 'pick', p: p.id, k: spec.id, t: spec.kind });
  }

  // ------------------------------------------------------------- snapshots

  /**
   * Project the world into network entities.
   *
   * Remember the axis convention: `x` = world X, `y` = world Z, `h` = height.
   * The `y` field is what area-of-interest slicing uses, so it MUST be the
   * ground-plane coordinate.
   */
  function projectEntities() {
    const out = {};
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      const e = {
        k: 'p',
        x: q(p.x), y: q(p.z), h: q(p.y),
        a: q(p.yaw, 2),
        n: p.name,
        hp: Math.round(p.hp),
        s: p.anim,
        sc: Math.round(p.score),
        w: p.weapon,
        ak: p.lastSeq,        // input ack — the client reconciles prediction from this
      };
      if (p.team) e.tm = p.team;
      if (p.veh) { e.v = p.veh; e.st = p.seat; }
      if (p.hp <= 0) e.d = 1;
      out[p.id] = e;
    }
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      out[v.id] = {
        k: 'v',
        x: q(v.x), y: q(v.z), h: q(v.y),
        a: q(v.yaw, 2), p: q(v.pitch, 2), r: q(v.roll, 2),
        t: v.kind,
        hp: Math.round(v.hp),
        d: v.driver || null,
        sp: q(Math.sqrt(v.vx * v.vx + v.vz * v.vz), 1),
      };
    }
    for (let i = 0; i < state.projectiles.length; i++) {
      const b = state.projectiles[i];
      out[b.id] = { k: 'b', x: q(b.x), y: q(b.z), h: q(b.y), t: b.weapon };
    }
    if (rollers) rollers.project(out);
    for (let i = 0; i < world.pickups.length; i++) {
      const spec = world.pickups[i];
      if (!state.pickups[spec.id].ready) continue;
      out[spec.id] = { k: 'k', x: q(spec.x), y: q(spec.z), h: q(spec.y ?? 0), t: spec.kind, w: spec.weapon };
    }
    return out;
  }

  /**
   * The global, position-less entity every client receives regardless of
   * where they stand: scoreboard and mode state. It also guarantees that a
   * player alone in an empty corner still gets a frame every tick.
   */
  function projectGlobal() {
    const board = playerList
      .slice()
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .slice(0, 10)
      .map(p => ({ id: p.id, n: p.name, s: Math.round(p.score), k: p.kills, d: p.deaths, tm: p.team || undefined }));
    const g = { k: 'g', t: Math.round(state.t * 10) / 10, board };
    if (mode && mode.projectState) g.m = mode.projectState(api);
    return g;
  }

  /**
   * Everything the OWNER needs to replay its own prediction: exact (not
   * quantized) position and velocity plus every movement timer, stamped with
   * the world time of the tick that consumed input `ak`. Sent only to that
   * player — nobody else needs it.
   */
  function projectSelf(id) {
    const p = state.players[id];
    if (!p) return null;
    return {
      t: state.t, ak: p.lastSeq, tp: p.teleports || 0,
      x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, yaw: p.yaw,
      g: p.grounded ? 1 : 0, co: p.coyote, jb: p.jumpBuffer,
      dv: p.diveT, dc: p.diveCd, st: p.stunT, gu: p.getUpT, rd: p.rideId || null,
      lk: p.locked ? 1 : 0,
    };
  }

  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  const api = {
    state,
    config,
    world,
    mode,
    rng,
    get players() { return playerList; },
    get vehicles() { return vehicleList; },
    addPlayer,
    removePlayer,
    setInput,
    step,
    projectEntities,
    projectGlobal,
    projectSelf,
    clearInput,
    teleportPlayer,
    drainEvents,
    emit,
    damagePlayer,
    killPlayer,
    respawnPlayer,
    damageVehicle,
    explode,
    giveWeapon: (p, name, ammo) => giveWeapon(p, name, ammo),
    enterVehicle,
    leaveVehicle,
    getPlayer: (id) => state.players[id],
    getVehicle: (id) => state.vehicles[id],
    get rollers() { return rollers; },
    spawnVehicle(id, kind, x, y, z, yaw) {
      const v = createVehicle(id, kind, x, y, z, yaw);
      state.vehicles[id] = v;
      refreshLists();
      return v;
    },
  };

  if (mode && mode.init) mode.init(api);
  return api;
}

/**
 * Area-of-interest grid.
 *
 * At world scale you never broadcast the whole world: each player receives
 * only what is near them, so bytes-per-client stay flat as the population
 * grows. This is the same idea as the SDK's `Usion.netcode.createInterestGrid`
 * and the platform rooms runtime's built-in AOI, reimplemented here so the
 * engine core keeps zero dependencies and runs unchanged in a sandbox.
 *
 * Coordinates are the ground plane (world X and Z).
 */
function createInterestGrid(options = {}) {
  const cellSize = options.cellSize || 64;
  const cells = new Map();          // cellKey → Set(entityId)
  const positions = new Map();      // entityId → {x, z, key}
  const observers = new Map();      // observerId → Set(visible entity ids)

  const key = (cx, cz) => cx + '|' + cz;

  function upsert(id, x, z) {
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    const k = key(cx, cz);
    const prev = positions.get(id);
    if (prev) {
      prev.x = x; prev.z = z;
      if (prev.key === k) return;
      const bucket = cells.get(prev.key);
      if (bucket) { bucket.delete(id); if (!bucket.size) cells.delete(prev.key); }
      prev.key = k;
    } else {
      positions.set(id, { x, z, key: k });
    }
    let bucket = cells.get(k);
    if (!bucket) cells.set(k, (bucket = new Set()));
    bucket.add(id);
  }

  function remove(id) {
    const prev = positions.get(id);
    if (!prev) return;
    const bucket = cells.get(prev.key);
    if (bucket) { bucket.delete(id); if (!bucket.size) cells.delete(prev.key); }
    positions.delete(id);
  }

  /** Stateless circle query — every entity id within `radius` of (x, z). */
  function query(x, z, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    const cx0 = Math.floor((x - radius) / cellSize);
    const cx1 = Math.floor((x + radius) / cellSize);
    const cz0 = Math.floor((z - radius) / cellSize);
    const cz1 = Math.floor((z + radius) / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = cells.get(key(cx, cz));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = positions.get(id);
          if (!p) continue;
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * Per-observer diffed query: what entered and left this observer's view
   * since its previous `observe()` call, plus everything currently visible.
   */
  function observe(observerId, x, z, radius) {
    const visible = query(x, z, radius);
    const previous = observers.get(observerId) || new Set();
    const now = new Set(visible);
    const entered = [];
    const left = [];
    for (const id of now) if (!previous.has(id)) entered.push(id);
    for (const id of previous) if (!now.has(id)) left.push(id);
    observers.set(observerId, now);
    return { entered, left, visible };
  }

  function dropObserver(observerId) {
    observers.delete(observerId);
  }

  return {
    cellSize,
    upsert,
    remove,
    query,
    observe,
    dropObserver,
    get size() { return positions.size; },
  };
}

/**
 * One world room: roster, fixed-tick simulation, AOI snapshot fan-out.
 *
 * Rooms are keyed by the token's `room_id` — the PLATFORM owns membership
 * (joinWorld placement and capacity); this server accepts any valid token for
 * its service and keeps a roster of live connections. Many worlds run side by
 * side in one process.
 *
 * Snapshot payloads match the platform rooms runtime exactly
 * (`{seq, t, entities, removed, events, you, keyframe?}`, position-less
 * entities global to everyone), so the same client code works whether the
 * game is developer-hosted or platform-hosted.
 */

const KEYFRAME_MIN_INTERVAL_MS = 1000;
const MAX_CATCH_UP_STEPS = 5;          // after a stall, run at most this many ticks at once
const DEFAULT_GRACE_MS = 15_000;       // matches the platform's reconnect grace
const DEFAULT_MAX_ENTITIES = 96;       // per-observer cap: the nearest N are sent

class WorldRoom {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {object} opts.manifest      world manifest (already generated)
   * @param {object} opts.worldSpec     the tiny spec clients regenerate from
   * @param {object} opts.mode          resolved game mode
   * @param {object} [opts.simConfig]
   * @param {number} [opts.tickHz=30]
   * @param {number} [opts.snapshotHz=15]
   * @param {number} [opts.aoiRadius=140]
   * @param {number} [opts.maxPlayers=200]
   * @param {object} [opts.rapier]      initialised RAPIER → Rapier physics backend
   * @param {number} [opts.graceMs=15000] how long a dropped player keeps their place
   * @param {number} [opts.maxEntities=96] per-observer entity cap
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.log = opts.log || (() => {});
    this.worldSpec = opts.worldSpec;
    this.tickHz = opts.tickHz ?? 30;
    this.snapshotHz = opts.snapshotHz ?? 15;
    this.aoiRadius = opts.aoiRadius ?? 140;
    this.maxPlayers = opts.maxPlayers ?? 200;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;
    this._dt = 1 / this.tickHz;
    this.world = buildWorld(opts.manifest, { rapier: opts.rapier, dt: this._dt });
    this.sim = createSimulation({
      world: this.world,
      mode: opts.mode,
      config: { ...(opts.simConfig || {}), tickHz: this.tickHz },
      seed: opts.seed ?? 12345,
    });
    this.grid = createInterestGrid({ cellSize: Math.max(32, Math.round(this.aoiRadius / 2)) });

    /** @type {Map<string, {id, name, sessionId, ws, lastKeyframeAt}>} */
    this.players = new Map();
    this.seq = 0;                 // advances exactly ONCE per snapshot tick
    this.emptySince = Date.now();
    this._knownIds = new Set();
    this._pendingRemoved = new Set();
    this._tickCount = 0;
    this._lastTickAt = Date.now();
    this._acc = 0;
    this._ticksPerSnapshot = Math.max(1, Math.round(this.tickHz / this.snapshotHz));
    const tickMs = Math.round(1000 / this.tickHz);
    this._tickTimer = setInterval(() => this._tick(), tickMs);
    this._tickTimer.unref?.();
  }

  get playerIds() { return Array.from(this.players.keys()); }
  /** Everyone holding a place, including players inside their reconnect grace. */
  get playerCount() { return this.players.size; }

  /** Admit (or re-attach) an authenticated player. */
  admit(session, ws) {
    const { userId, name, sessionId } = session;
    const existing = this.players.get(userId);
    if (!existing && this.players.size >= this.maxPlayers) {
      return { ok: false, code: 'WORLD_FULL' };
    }
    if (existing) {
      if (existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
        try { existing.ws.close(4409, 'superseded by a newer connection'); } catch { /* gone */ }
      }
      existing.ws = ws;
      existing.sessionId = sessionId;
      existing.disconnectedAt = 0;
      existing.sent = new Map();             // the keyframe below resets their view
    } else {
      this.players.set(userId, {
        id: userId, name, sessionId, ws, lastKeyframeAt: 0, disconnectedAt: 0, sent: new Map(),
      });
      const p = this.sim.addPlayer(userId, name);
      this.grid.upsert(userId, p.x, p.z);
    }
    this.emptySince = null;

    const player = this.players.get(userId);
    // The joined ack AND the join keyframe REUSE the current seq: no unicast
    // frame may consume the broadcast counter, or every other observer sees a
    // phantom gap and asks for a keyframe of their own, forever.
    sendFrame(ws, 'joined', {
      room_id: this.roomId,
      player_id: userId,
      player_ids: this.playerIds,
      seq: this.seq,
      max_players: this.maxPlayers,
      protocol_version: '2',
      server_t: Date.now(),
      engine: 'usion-world',
      world: this.worldSpec,
      mode: this.sim.mode ? { id: this.sim.mode.id, name: this.sim.mode.name } : null,
      sim_hz: this.tickHz,
      snapshot_hz: this.snapshotHz,
      physics: this.world.physics ? 'rapier' : 'arcade',
      aoi_radius: this.aoiRadius,
    });
    sendFrame(ws, 'state_snapshot', this._buildKeyframe(userId));
    player.lastKeyframeAt = Date.now();

    if (!existing) {
      this._broadcastExcept(userId, 'player_joined', {
        room_id: this.roomId, player_id: userId, player_name: name, player_ids: this.playerIds,
      });
      this.log('info', 'player joined world', { room: this.roomId, user: userId, players: this.players.size });
    }
    return { ok: true, reconnect: !!existing };
  }

  /**
   * A socket dropped. Keep the player's place (and body, standing still) for
   * `graceMs` so a phone blinking between networks lands back in the same
   * spot with the same progress; remove only if they never come back.
   */
  disconnectPlayer(userId, expectedWs) {
    const player = this.players.get(userId);
    if (!player) return false;
    if (expectedWs && player.ws !== expectedWs) return false;
    if (this.graceMs <= 0) return this.removePlayer(userId, expectedWs, 'disconnected');
    player.ws = null;
    player.disconnectedAt = Date.now();
    this.sim.clearInput(userId);
    this.log('info', 'player disconnected (grace)', { room: this.roomId, user: userId, grace_ms: this.graceMs });
    return true;
  }

  removePlayer(userId, expectedWs, reason) {
    const player = this.players.get(userId);
    if (!player) return false;
    if (expectedWs && player.ws !== expectedWs) return false;
    this.players.delete(userId);
    for (const other of this.players.values()) other.sent.delete(userId);
    this.sim.removePlayer(userId);
    this.grid.remove(userId);
    this.grid.dropObserver(userId);
    this._pendingRemoved.add(userId);
    this._knownIds.delete(userId);
    this._broadcast('player_left', {
      room_id: this.roomId, player_id: userId, player_ids: this.playerIds, reason: reason || 'left',
    });
    if (this.players.size === 0) this.emptySince = Date.now();
    this.log('info', 'player left world', { room: this.roomId, user: userId, reason, players: this.players.size });
    return true;
  }

  /** Route a validated client action/input into the simulation. */
  handleInput(userId, payload) {
    const type = String(payload.action_type || payload.type || '');
    const data = payload.action_data && typeof payload.action_data === 'object' ? payload.action_data : {};
    if (type === 'input' || type === 'i') {
      this.sim.setInput(userId, data);
      return;
    }
    if (this.onCustomInput) this.onCustomInput(userId, type, data);
  }

  /** SDK resync (`ping {last_sequence}`): unicast keyframe at the CURRENT seq. */
  sendResyncKeyframe(userId, lastSequence) {
    const player = this.players.get(userId);
    if (!player) return;
    if (lastSequence >= this.seq) return;      // already up to date
    const now = Date.now();
    if (now - player.lastKeyframeAt < KEYFRAME_MIN_INTERVAL_MS) return;
    player.lastKeyframeAt = now;
    sendFrame(player.ws, 'state_snapshot', this._buildKeyframe(userId));
  }

  destroy(code = 1001, reason = 'world closed') {
    clearInterval(this._tickTimer);
    for (const player of this.players.values()) {
      try { player.ws?.close(code, reason); } catch { /* gone */ }
    }
    this.players.clear();
    this.world.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Fixed-step loop. Timers fire late and unevenly, so real time accumulates
   * and the simulation always advances in exact 1/tickHz steps — the same
   * steps a phone replays when it predicts. After a long stall we catch up a
   * few ticks and drop the rest rather than spiralling.
   */
  _tick() {
    const now = Date.now();
    this._acc += Math.max(0, now - this._lastTickAt) / 1000;
    this._lastTickAt = now;
    let steps = 0;
    let snapshotDue = false;
    while (this._acc >= this._dt && steps < MAX_CATCH_UP_STEPS) {
      this.sim.step(this._dt);
      this._acc -= this._dt;
      steps += 1;
      this._tickCount += 1;
      if (this._tickCount % this._ticksPerSnapshot === 0) snapshotDue = true;
    }
    if (steps === MAX_CATCH_UP_STEPS && this._acc >= this._dt) this._acc = 0;
    if (snapshotDue) this._snapshotPhase(now);
    this._sweepGrace(now);
  }

  _sweepGrace(now) {
    for (const player of this.players.values()) {
      if (player.disconnectedAt && now - player.disconnectedAt > this.graceMs) {
        this.removePlayer(player.id, null, 'timeout');
      }
    }
  }

  _snapshotPhase(now) {
    this.seq += 1;                             // the only place the counter moves
    const entities = this.sim.projectEntities();
    const global = this.sim.projectGlobal();

    // Track deletions globally (a bullet that hit, a pickup that was taken).
    const nextIds = new Set(Object.keys(entities));
    for (const id of this._knownIds) if (!nextIds.has(id)) this._pendingRemoved.add(id);
    this._knownIds = nextIds;

    for (const id in entities) {
      const e = entities[id];
      this.grid.upsert(id, e.x, e.y);
    }
    const removedIds = this._pendingRemoved.size ? [...this._pendingRemoved] : null;
    for (const id of this._pendingRemoved) this.grid.remove(id);
    this._pendingRemoved = new Set();

    const events = this.sim.drainEvents();

    for (const player of this.players.values()) {
      if (!player.ws || player.ws.readyState !== 1) continue;
      const self = this.sim.getPlayer(player.id);
      let visibleIds = [];
      let removed = removedIds ? removedIds.slice() : [];
      if (self) {
        const { left, visible } = this.grid.observe(player.id, self.x, self.z, this.aoiRadius);
        visibleIds = this._nearest(visible, entities, self, player.id);
        if (left.length) removed = [...new Set([...removed, ...left])];
      }
      // Only what changed since this player last heard about it.
      const slice = { world: global };
      const seen = new Set();
      for (const id of visibleIds) {
        seen.add(id);
        const diff = diffEntity(player.sent.get(id), entities[id]);
        if (diff) slice[id] = diff;
        player.sent.set(id, entities[id]);
      }
      // Entities that fell out of the capped set count as removed for them.
      for (const id of player.sent.keys()) {
        if (!seen.has(id)) { player.sent.delete(id); if (!removed.includes(id)) removed.push(id); }
      }
      sendFrame(player.ws, 'state_snapshot', {
        seq: this.seq,
        t: now,
        entities: slice,
        removed,
        events: [],
        you: player.id,
        ack: self ? self.lastSeq : 0,
        me: self ? this.sim.projectSelf(player.id) : null,
      });
      if (events.length) {
        const mine = events.filter(ev => this._eventVisible(ev, self));
        if (mine.length) {
          // Unicast event frames REUSE the current seq — never advance it.
          sendFrame(player.ws, 'state_delta', { seq: this.seq, event: 'ev', data: { list: mine } });
        }
      }
    }
  }

  /** The observer itself plus the nearest visible entities, capped at maxEntities. */
  _nearest(visible, entities, self, selfId) {
    const ids = [];
    for (const id of visible) if (entities[id] && id !== selfId) ids.push(id);
    if (ids.length > this.maxEntities - 1) {
      const d = (id) => { const e = entities[id]; const dx = e.x - self.x; const dz = e.y - self.z; return dx * dx + dz * dz; };
      ids.sort((a, b) => d(a) - d(b));
      ids.length = this.maxEntities - 1;
    }
    if (entities[selfId]) ids.push(selfId);
    return ids;
  }

  /** Events with a position are area-of-interest filtered like entities. */
  _eventVisible(ev, self) {
    if (!self) return !ev.x;
    if (typeof ev.x !== 'number' || typeof ev.y !== 'number') return true;
    const dx = ev.x - self.x;
    const dz = ev.y - self.z;
    const r = this.aoiRadius * 1.3;
    return dx * dx + dz * dz <= r * r;
  }

  _buildKeyframe(userId) {
    const entities = this.sim.projectEntities();
    const self = this.sim.getPlayer(userId);
    const player = this.players.get(userId);
    const slice = { world: this.sim.projectGlobal() };
    if (player) player.sent = new Map();
    if (self) {
      const ids = this._nearest(this.grid.query(self.x, self.z, this.aoiRadius), entities, self, userId);
      for (const id of ids) {
        slice[id] = entities[id];
        if (player) player.sent.set(id, entities[id]);
      }
    }
    return {
      seq: this.seq,
      t: Date.now(),
      entities: slice,
      removed: [],
      events: [],
      you: userId,
      ack: self ? self.lastSeq : 0,
      me: self ? this.sim.projectSelf(userId) : null,
      keyframe: true,
    };
  }

  _broadcast(type, payload) {
    // (players inside their reconnect grace have no socket; sendFrame skips them)
    for (const player of this.players.values()) sendFrame(player.ws, type, payload);
  }

  _broadcastExcept(excludeId, type, payload) {
    for (const player of this.players.values()) {
      if (player.id !== excludeId) sendFrame(player.ws, type, payload);
    }
  }
}

/**
 * Fields of `next` that differ from `prev` (entities are flat objects of
 * primitives). A new entity is sent whole; an unchanged one not at all.
 */
function diffEntity(prev, next) {
  if (!next) return null;
  if (!prev || prev.k !== next.k) return next;
  let out = null;
  for (const key in next) {
    if (prev[key] !== next[key]) (out || (out = {}))[key] = next[key];
  }
  for (const key in prev) {
    if (!(key in next)) (out || (out = {}))[key] = null;     // field cleared (e.g. left a vehicle)
  }
  return out;
}

/**
 * Procedural city generator.
 *
 * Produces a complete world manifest — streets, kerbs, buildings, props,
 * parked cars, weapon pickups, a race circuit, and an obstacle-course
 * district full of Fall Guys hazards — from a single integer seed. The server
 * and every client generate the identical city from that seed, so a whole
 * GTA-sized map costs a few bytes on the wire instead of a mesh download.
 *
 *   const manifest = generateCity({ seed: 7, blocks: 6 });
 *   const world = buildWorld(manifest);
 */

const PALETTE = ['#8b8f98', '#a5a29b', '#7d8894', '#9b9086', '#6f7681', '#5f6a72'];

function generateCity(options = {}) {
  const seed = options.seed ?? 7;
  const blocks = options.blocks ?? 6;              // blocks per side
  const blockSize = options.blockSize ?? 68;
  const roadWidth = options.roadWidth ?? 16;
  const rng = createRng(seed);

  const pitch = blockSize + roadWidth;
  const half = (blocks * pitch) / 2;
  const solids = [];
  const props = [];
  const movers = [];
  const spawns = [];
  const vehicleSpawns = [];
  const pickups = [];
  const checkpoints = [];
  const zones = [];

  const bounds = { minX: -half - 30, maxX: half + 30, minZ: -half - 30, maxZ: half + 30 };

  // ---- roads (render-only: the ground plane already stops you falling) ----
  for (let i = 0; i <= blocks; i++) {
    const c = -half + i * pitch;
    solids.push({
      kind: 'box', x: 0, y: 0.02, z: c - roadWidth / 2 + roadWidth / 2,
      hx: half + 30, hy: 0.02, hz: roadWidth / 2, solid: false, tag: 'road',
    });
    solids.push({
      kind: 'box', x: c - roadWidth / 2 + roadWidth / 2, y: 0.02, z: 0,
      hx: roadWidth / 2, hy: 0.02, hz: half + 30, solid: false, tag: 'road',
    });
  }

  // ---- city blocks --------------------------------------------------------
  const centerBlock = Math.floor(blocks / 2);
  const courseBlock = { bx: 0, bz: blocks - 1 };

  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const cx = -half + roadWidth / 2 + bx * pitch + blockSize / 2;
      const cz = -half + roadWidth / 2 + bz * pitch + blockSize / 2;

      // Pavement kerb: a 15 cm lip you can step and drive over.
      solids.push(boxAt(cx, 0, cz, blockSize + 2, 0.16, blockSize + 2, 0, 'pavement'));

      if (bx === centerBlock && bz === centerBlock) {
        buildPlaza(cx, cz);
        continue;
      }
      if (bx === courseBlock.bx && bz === courseBlock.bz) {
        buildObstacleCourse(cx, cz);
        continue;
      }
      buildLot(cx, cz, bx, bz);
    }
  }

  // ---- street furniture, parked cars, race circuit ------------------------
  buildStreets();
  buildCircuit();

  return {
    id: options.id || 'usion-city',
    name: options.name || 'Usion City',
    seed,
    groundY: 0,
    killY: -30,
    bounds,
    theme: {
      sky: '#a8c9e8', fog: '#cfe0f0', ground: '#6d7a6f', road: '#3a3d42',
      line: '#e8e0c4', accent: '#ff5a3c', buildings: PALETTE,
    },
    solids, props, movers, spawns, vehicleSpawns, pickups, checkpoints, zones,
    meta: { blocks, blockSize, roadWidth, pitch, half },
  };

  // ------------------------------------------------------------------ parts

  function buildLot(cx, cz, bx, bz) {
    const count = rng.int(2, 4);
    const cell = blockSize / 2;
    for (let i = 0; i < count; i++) {
      const w = rng.range(16, cell * 0.95);
      const d = rng.range(16, cell * 0.95);
      const h = rng.range(10, bx === 0 || bz === 0 ? 26 : 58);
      const ox = rng.range(-cell + w / 2, cell - w / 2);
      const oz = rng.range(-cell + d / 2, cell - d / 2);
      const building = boxAt(cx + ox, 0.16, cz + oz, w, h, d, 0, 'building');
      building.color = PALETTE[rng.int(0, PALETTE.length - 1)];
      building.windows = true;
      solids.push(building);
      // A flat roof you can actually reach makes a city worth exploring.
      if (h < 18 && rng.chance(0.45)) {
        solids.push(rampAt(cx + ox + w / 2 + 3, 0.16, cz + oz, 5, h, 9, rng.chance(0.5) ? 0 : Math.PI, 'ramp'));
      }
    }
    if (rng.chance(0.5)) {
      pickups.push({
        kind: 'weapon',
        weapon: rng.pick(['pistol', 'smg', 'shotgun', 'rifle']),
        x: cx + rng.range(-cell * 0.6, cell * 0.6),
        y: 0.7,
        z: cz + rng.range(-cell * 0.6, cell * 0.6),
        respawn: 25,
      });
    }
    if (rng.chance(0.35)) {
      pickups.push({ kind: 'health', amount: 50, x: cx, y: 0.7, z: cz, respawn: 30 });
    }
    spawns.push({ x: cx, y: 0.2, z: cz - blockSize / 2 - 1, yaw: Math.PI });
  }

  /** Central plaza — the social hub and the elimination finish line. */
  function buildPlaza(cx, cz) {
    solids.push(boxAt(cx, 0.16, cz, 34, 0.5, 34, 0, 'plaza'));
    solids.push(boxAt(cx, 0.66, cz, 6, 3.2, 6, 0, 'monument'));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      movers.push({
        id: 'plaza_spin_' + i,
        kind: 'spinner',
        x: cx + Math.sin(a) * 13, y: 0.9, z: cz + Math.cos(a) * 13,
        w: 11, h: 1.1, d: 0.7,
        period: 4.5 + i * 0.4, phase: i, push: 1.25,
      });
    }
    zones.push({ id: 'plaza', kind: 'goal', x: cx, z: cz, radius: 17 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawns.push({ x: cx + Math.sin(a) * 24, y: 0.2, z: cz + Math.cos(a) * 24, yaw: a + Math.PI, tag: 'plaza' });
    }
    pickups.push({ kind: 'weapon', weapon: 'rocket', x: cx, y: 4.2, z: cz, respawn: 60 });
  }

  /** Obstacle-course district: the Fall Guys corner of the city. */
  function buildObstacleCourse(cx, cz) {
    const startZ = cz - blockSize / 2 + 4;
    solids.push(boxAt(cx, 0.16, cz, blockSize - 6, 0.3, blockSize - 6, 0, 'course'));
    for (let i = 0; i < 5; i++) spawns.push({ x: cx - 8 + i * 4, y: 0.5, z: startZ, yaw: 0, tag: 'start' });

    // Lane 1 — sweeping bars you jump or dive under.
    for (let i = 0; i < 3; i++) {
      movers.push({
        id: 'course_sweep_' + i,
        kind: 'sweeper',
        x: cx - 12 + i * 12, y: 0.6, z: startZ + 12,
        w: 14, h: 1.2, d: 0.8,
        period: 3 + i * 0.5, phase: i * 1.1, sweep: 1.1, push: 1.4,
      });
    }
    // Lane 2 — moving platforms over a gap.
    for (let i = 0; i < 3; i++) {
      movers.push({
        id: 'course_plat_' + i,
        kind: 'platform',
        x: cx - 10 + i * 10, y: 1.2, z: startZ + 26,
        w: 6, h: 0.5, d: 6,
        travel: { x: 0, y: 0, z: 12 },
        period: 6 + i, phase: i * 2,
      });
    }
    // Lane 3 — pistons that shove you off the walkway.
    solids.push(boxAt(cx, 0.46, cz + 6, 26, 0.4, 8, 0, 'walkway'));
    for (let i = 0; i < 4; i++) {
      movers.push({
        id: 'course_push_' + i,
        kind: 'piston',
        x: cx - 12 + i * 8, y: 0.9, z: cz + 11,
        w: 3, h: 2.2, d: 2,
        travel: { x: 0, y: 0, z: -9 },
        period: 3.5, phase: i * 1.6, push: 1.6,
      });
    }
    // Lane 4 — conveyor run to the finish, uphill.
    movers.push({
      id: 'course_belt',
      kind: 'conveyor',
      x: cx, y: 0.5, z: cz + 20,
      w: 16, h: 0.4, d: 10,
      ry: Math.PI, speed: 5,
    });
    solids.push(rampAt(cx, 0.16, cz + 28, 16, 3.2, 9, 0, 'ramp'));
    zones.push({ id: 'course_goal', kind: 'goal', x: cx, z: cz + blockSize / 2 - 5, rx: 10, rz: 4 });
    checkpointsForCourse(cx, cz);
  }

  function checkpointsForCourse(cx, cz) {
    zones.push({ id: 'course_area', kind: 'course', x: cx, z: cz, rx: blockSize / 2, rz: blockSize / 2 });
  }

  function buildStreets() {
    const carKinds = ['sedan', 'sedan', 'sport', 'truck', 'kart'];
    let carIndex = 0;
    for (let i = 0; i <= blocks; i++) {
      const c = -half + i * pitch;
      for (let j = 0; j < blocks; j++) {
        const along = -half + roadWidth / 2 + j * pitch + blockSize / 2;
        if (rng.chance(0.55)) {
          vehicleSpawns.push({
            id: 'car' + (carIndex++),
            kind: rng.pick(carKinds),
            x: c - roadWidth / 4, y: 0.2, z: along, yaw: 0,
          });
        }
        if (rng.chance(0.55)) {
          vehicleSpawns.push({
            id: 'car' + (carIndex++),
            kind: rng.pick(carKinds),
            x: along, y: 0.2, z: c + roadWidth / 4, yaw: Math.PI / 2,
          });
        }
        props.push({ kind: 'lamp', x: c - roadWidth / 2 + 0.8, y: 0.16, z: along, ry: 0 });
        props.push({ kind: 'tree', x: along, y: 0.16, z: c + roadWidth / 2 - 0.8, ry: rng.range(0, 6.28) });
      }
    }
  }

  /** A race circuit that runs the outer ring road, gate by gate. */
  function buildCircuit() {
    const ring = half - roadWidth / 2 - pitch / 2;
    const gates = [];
    const perSide = Math.max(2, blocks - 1);
    for (let i = 0; i < perSide; i++) {
      const t = -ring + (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: t, z: -ring, ry: 0 });
    }
    for (let i = 1; i < perSide; i++) {
      const t = -ring + (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: ring, z: t, ry: Math.PI / 2 });
    }
    for (let i = 1; i < perSide; i++) {
      const t = ring - (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: t, z: ring, ry: 0 });
    }
    for (let i = 1; i < perSide - 1; i++) {
      const t = ring - (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: -ring, z: t, ry: Math.PI / 2 });
    }
    gates.forEach((g, i) => {
      checkpoints.push({
        id: 'cp' + i, order: i,
        x: g.x, y: 0, z: g.z, ry: g.ry,
        radius: 11, height: 14,
        start: i === 0,
      });
    });
    // Starting grid on the straight before gate 0.
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const slotX = -ring + 12 + row * 7;
      const slotZ = -ring + side * 3.5;
      // The racer stands BESIDE their car, not inside it: identical
      // coordinates spawn the player intersecting the vehicle body, and the
      // sprint to your car is half the fun of a standing start anyway.
      spawns.push({ x: slotX - 2.6, y: 0.2, z: slotZ, yaw: Math.PI / 2, tag: 'grid' });
      vehicleSpawns.push({
        id: 'grid' + i,
        kind: i < 2 ? 'sport' : 'sedan',
        x: slotX, y: 0.2, z: slotZ, yaw: Math.PI / 2,
      });
    }
  }
}

/**
 * World generators.
 *
 * A **world spec** is the tiny JSON the server hands every client on join —
 * `{ generator: 'city', options: { seed: 7, blocks: 6 } }` — instead of the
 * full manifest. Both sides run the same seeded generator and end up with
 * byte-identical geometry, so a city with hundreds of buildings costs about
 * eighty bytes on the wire and no asset download at all.
 *
 * A creator with hand-authored geometry can pass `{ manifest: {...} }`
 * instead; everything downstream treats the two identically.
 */

const GENERATORS = {
  city: generateCity,
};

/** Resolve a world spec (or a raw manifest) into a manifest. */
function buildManifest(spec) {
  if (!spec) throw new Error('buildManifest: a world spec or manifest is required');
  if (spec.manifest) return spec.manifest;
  if (spec.solids || spec.spawns) return spec;          // already a manifest
  const factory = GENERATORS[spec.generator];
  if (!factory) throw new Error(`Unknown world generator "${spec.generator}"`);
  return factory(spec.options || {});
}

/**
 * Free roam — the sandbox: no timer, no objective, everyone alive.
 *
 * It is also the smallest possible example of the mode contract:
 *
 *   { id, name, config?, init?, onJoin?, onLeave?, onSpawn?, onDeath?,
 *     onDamage?, onCheckpoint?, onPickup?, preTick?, onTick?,
 *     blockRespawn?, projectState? }
 *
 * Every hook receives the simulation api as its first argument, so a mode can
 * read `sim.players`, score them, spawn vehicles, or end the match — without
 * ever touching the physics.
 *
 * `projectState()` is replicated to every client in the global entity. Return
 * CODES, never sentences: clients localize `phase` themselves.
 */
function freeroamMode(options = {}) {
  return {
    id: 'freeroam',
    name: options.name || 'Free roam',
    config: { respawnDelay: 3, friendlyFire: true, ...(options.config || {}) },

    onDeath(sim, victim, killer) {
      if (killer) killer.score += 1;
    },

    projectState() {
      return { phase: 'open' };
    },
  };
}

/**
 * Deathmatch — rolling rounds of "most kills wins".
 *
 * Written for world rooms: the match never waits for a roster, players drop
 * in and out mid-round, and when the timer expires the scores are announced
 * and everything resets. That is what keeps a 200-player world alive instead
 * of stuck on a lobby screen.
 */
function deathmatchMode(options = {}) {
  const roundSeconds = options.roundSeconds ?? 300;
  const targetScore = options.targetScore ?? 25;
  const intermission = options.intermission ?? 15;
  const weapons = options.weapons || ['pistol', 'smg'];

  return {
    id: 'deathmatch',
    name: options.name || 'Deathmatch',
    config: { respawnDelay: 4, startWeapons: weapons, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = { phase: 'live', endsAt: sim.state.t + roundSeconds, round: 1, winner: null };
    },

    onJoin(sim, p) {
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
    },

    onDeath(sim, victim, killer) {
      if (!killer) { victim.score = Math.max(0, victim.score - 1); return; }
      killer.score += 1;
      if (sim.state.mode.phase === 'live' && killer.score >= targetScore) endRound(sim, killer);
    },

    blockRespawn(sim) {
      return sim.state.mode.phase !== 'live';
    },

    onTick(sim) {
      const m = sim.state.mode;
      if (m.phase === 'live') {
        if (sim.state.t >= m.endsAt) endRound(sim, leader(sim));
        return;
      }
      if (sim.state.t < m.endsAt) return;
      m.phase = 'live';
      m.round += 1;
      m.winner = null;
      m.endsAt = sim.state.t + roundSeconds;
      for (const p of sim.players) {
        p.score = 0;
        p.kills = 0;
        p.deaths = 0;
        sim.respawnPlayer(p);
      }
      sim.emit({ e: 'round', n: m.round });
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        round: m.round,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        target: targetScore,
        winner: m.winner,
      };
    },
  };

  function leader(sim) {
    let best = null;
    for (const p of sim.players) if (!best || p.score > best.score) best = p;
    return best;
  }

  function endRound(sim, winner) {
    const m = sim.state.mode;
    m.phase = 'over';
    m.winner = winner ? { id: winner.id, n: winner.name, s: Math.round(winner.score) } : null;
    m.endsAt = sim.state.t + intermission;
    sim.emit({ e: 'roundend', w: winner ? winner.id : null });
  }
}

/**
 * Race — checkpoint circuits through the world, on wheels or on foot.
 *
 * Built for drop-in worlds: a race starts on a schedule, everyone present is
 * entered automatically (no lobby, no ready-up), latecomers join the NEXT
 * one, and finishing order is scored live so the HUD can show your position
 * without a second round trip.
 *
 * Requires `checkpoints` in the world manifest, ordered by `order`.
 */
function raceMode(options = {}) {
  const laps = options.laps ?? 2;
  const countdown = options.countdown ?? 8;
  const raceSeconds = options.raceSeconds ?? 300;
  const intermission = options.intermission ?? 25;
  const points = options.points || [10, 7, 5, 3, 2, 1];

  return {
    id: 'race',
    name: options.name || 'Race',
    config: { respawnDelay: 3, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = {
        phase: 'countdown',
        startsAt: sim.state.t + countdown,
        endsAt: 0,
        laps,
        results: [],
        race: 1,
      };
    },

    onJoin(sim, p) {
      p.racing = false;
      p.finishTime = 0;
      p.nextCp = 0;
      p.lap = 0;
    },

    onCheckpoint(sim, p, cp) {
      const m = sim.state.mode;
      if (m.phase !== 'racing' || !p.racing || p.finishTime) return;
      if (p.lap < m.laps) return;
      p.finishTime = sim.state.t - (m.startsAt || sim.state.t);
      p.racing = false;
      const place = m.results.length + 1;
      m.results.push({ id: p.id, n: p.name, t: Math.round(p.finishTime * 100) / 100, place });
      p.score += points[place - 1] || 1;
      sim.emit({ e: 'finish', p: p.id, pl: place, t: Math.round(p.finishTime * 10) / 10 });
      if (place === 1) m.endsAt = Math.min(m.endsAt, sim.state.t + (options.finishGrace ?? 45));
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      if (m.phase === 'countdown') {
        if (t < m.startsAt) return;
        m.phase = 'racing';
        m.endsAt = t + raceSeconds;
        m.results = [];
        for (const p of sim.players) startRacer(sim, p);
        sim.emit({ e: 'racestart', n: m.race });
        return;
      }
      if (m.phase === 'racing') {
        const stillRacing = sim.players.some(p => p.racing);
        if (t >= m.endsAt || (!stillRacing && sim.players.length > 0)) {
          m.phase = 'results';
          m.endsAt = t + intermission;
          for (const p of sim.players) p.racing = false;
          sim.emit({ e: 'raceend', w: m.results[0] ? m.results[0].id : null });
        }
        return;
      }
      if (t < m.endsAt) return;
      m.phase = 'countdown';
      m.race += 1;
      m.startsAt = t + countdown;
      m.results = [];
      for (const p of sim.players) {
        p.finishTime = 0;
        p.nextCp = 0;
        p.lap = 0;
      }
      sim.emit({ e: 'racereset', n: m.race });
    },

    projectState(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      return {
        phase: m.phase,
        race: m.race,
        laps: m.laps,
        left: Math.max(0, Math.round((m.phase === 'countdown' ? m.startsAt : m.endsAt) - t)),
        results: m.results.slice(0, 5),
        running: sim.players.filter(p => p.racing).length,
      };
    },

    /** Live position: further round the circuit wins, ties broken by distance. */
    positionOf(sim, player) {
      const list = sim.players.filter(p => p.racing || p.finishTime);
      list.sort((a, b) => {
        if (a.finishTime && b.finishTime) return a.finishTime - b.finishTime;
        if (a.finishTime) return -1;
        if (b.finishTime) return 1;
        return b.nextCp - a.nextCp;
      });
      return list.indexOf(player) + 1;
    },
  };

  function startRacer(sim, p) {
    p.racing = true;
    p.finishTime = 0;
    p.nextCp = 0;
    p.lap = 0;
    const grid = sim.world.spawns.filter(s => s.tag === 'grid');
    if (grid.length) {
      const slot = grid[sim.players.indexOf(p) % grid.length];
      sim.teleportPlayer(p, slot);
    }
  }
}

/**
 * Elimination — the Fall Guys shape: a show of short rounds where a fixed
 * share of the field qualifies and the rest are knocked out, until one
 * contestant is left.
 *
 * Qualifying means reaching a zone tagged `kind: 'goal'` in the world
 * manifest (or crossing the last checkpoint, if the world has a course).
 * Knocked-out players keep playing in the world as spectators — being out of
 * the show should not mean staring at a lock screen — they simply cannot
 * qualify until the next show starts.
 */
function eliminationMode(options = {}) {
  const roundSeconds = options.roundSeconds ?? 120;
  const countdown = options.countdown ?? 10;
  const intermission = options.intermission ?? 20;
  const qualifyFraction = options.qualifyFraction ?? 0.6;
  const minContestants = options.minContestants ?? 2;
  const maxRounds = options.maxRounds ?? 4;

  return {
    id: 'elimination',
    name: options.name || 'Elimination',
    config: { respawnDelay: 2.5, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = {
        phase: 'countdown',
        show: 1,
        round: 1,
        endsAt: sim.state.t + countdown,
        quota: 0,
        qualified: 0,
        contestants: 0,
        winner: null,
      };
    },

    onJoin(sim, p) {
      // Latecomers watch this show and enter the next one.
      p.elim = sim.state.mode.phase !== 'countdown';
      p.qualified = false;
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;

      if (m.phase === 'countdown') {
        if (t < m.endsAt) return;
        beginRound(sim);
        return;
      }

      if (m.phase === 'live') {
        checkGoals(sim);
        const contestants = sim.players.filter(p => !p.elim);
        if (m.qualified >= m.quota || t >= m.endsAt || contestants.length === 0) endRound(sim);
        return;
      }

      if (t < m.endsAt) return;
      if (m.phase === 'roundend') {
        const remaining = sim.players.filter(p => !p.elim);
        if (remaining.length <= 1 || m.round >= maxRounds) {
          m.phase = 'showover';
          m.winner = remaining[0] ? { id: remaining[0].id, n: remaining[0].name } : null;
          m.endsAt = t + intermission;
          if (remaining[0]) remaining[0].score += 25;
          sim.emit({ e: 'showover', w: remaining[0] ? remaining[0].id : null });
          return;
        }
        m.round += 1;
        m.phase = 'countdown';
        m.endsAt = t + countdown;
        sim.emit({ e: 'roundnext', n: m.round });
        return;
      }
      // showover → start a fresh show with everyone present
      m.show += 1;
      m.round = 1;
      m.phase = 'countdown';
      m.winner = null;
      m.endsAt = t + countdown;
      for (const p of sim.players) { p.elim = false; p.qualified = false; p.score = 0; }
      sim.emit({ e: 'shownext', n: m.show });
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        show: m.show,
        round: m.round,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        quota: m.quota,
        qualified: m.qualified,
        contestants: m.contestants,
        winner: m.winner,
      };
    },
  };

  function beginRound(sim) {
    const m = sim.state.mode;
    const contestants = sim.players.filter(p => !p.elim);
    m.phase = 'live';
    m.contestants = contestants.length;
    m.quota = Math.max(1, Math.min(contestants.length - 1, Math.round(contestants.length * qualifyFraction)));
    if (contestants.length < minContestants) m.quota = contestants.length;
    m.qualified = 0;
    m.endsAt = sim.state.t + roundSeconds;
    for (const p of contestants) {
      p.qualified = false;
      p.nextCp = 0;
      p.lap = 0;
      const spawn = sim.world.pickSpawn(null, 'start', sim.rng);
      if (spawn) {
        sim.teleportPlayer(p, spawn);
        p.hp = p.maxHp;
        p.deadUntil = 0;
      }
    }
    sim.emit({ e: 'roundstart', n: m.round, q: m.quota });
  }

  function checkGoals(sim) {
    const m = sim.state.mode;
    const goals = sim.world.zones.filter(z => z.kind === 'goal');
    if (!goals.length) return;
    for (const p of sim.players) {
      if (p.elim || p.qualified || p.hp <= 0) continue;
      const inGoal = goals.some(z => sim.world.zoneContains(z, p.x, p.z));
      if (!inGoal) continue;
      p.qualified = true;
      m.qualified += 1;
      p.score += Math.max(1, m.quota - m.qualified + 1) * 2;
      sim.emit({ e: 'qualify', p: p.id, n: m.qualified });
    }
  }

  function endRound(sim) {
    const m = sim.state.mode;
    let out = 0;
    for (const p of sim.players) {
      if (p.elim) continue;
      if (p.qualified) continue;
      p.elim = true;
      out += 1;
    }
    m.phase = 'roundend';
    m.endsAt = sim.state.t + 6;
    sim.emit({ e: 'roundover', n: m.round, out });
  }
}

/**
 * Built-in game modes.
 *
 * A mode is a plain object of optional hooks — see freeroam.js for the whole
 * contract. Creators write their own the same way and pass it to
 * `createWorldServer({ mode })`; nothing in the physics core needs to change
 * to invent a new competition.
 */

const FACTORIES = {
  freeroam: freeroamMode,
  deathmatch: deathmatchMode,
  race: raceMode,
  elimination: eliminationMode,
};

/** Resolve a mode by id (`'race'`) or `{id, ...options}`. */
function createMode(spec) {
  if (typeof spec === 'function') return spec();
  if (typeof spec === 'string') {
    const factory = FACTORIES[spec];
    if (!factory) throw new Error(`Unknown mode "${spec}"`);
    return factory();
  }
  if (spec.id && FACTORIES[spec.id] && !spec.onTick && !spec.init) {
    return FACTORIES[spec.id](spec);
  }
  return spec;
}

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

async function createWorldServer(options = {}) {
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

/**
 * City Rush — the sample competition built on the Usion World Engine.
 *
 * This file is the *whole game*. The engine owns the city, the physics, the
 * cars, the weapons and the netcode; a creator writes rules like these and
 * nothing else. It is deliberately a composite of the two things the engine
 * is for — GTA-style driving and Fall Guys-style chaos — so it exercises
 * both in one world:
 *
 *   roam      free play: drive, shoot, explore, brawl in the plaza
 *   countdown everyone is placed on the start grid
 *   racing    a checkpoint circuit through the city, on wheels or on foot
 *   results   podium, then straight back to roaming
 *
 * Every value the client shows is a CODE or a number — never an English
 * sentence — so the same world reads correctly in any language.
 */
const ROAM_SECONDS = 90;
const COUNTDOWN_SECONDS = 12;
const RACE_SECONDS = 300;
const RESULTS_SECONDS = 20;
const FINISH_GRACE = 45;
const LAPS = 2;
const POINTS = [12, 9, 7, 5, 4, 3, 2, 1];

function cityRushMode(options = {}) {
  const laps = options.laps ?? LAPS;

  return {
    id: 'city-rush',
    name: 'City Rush',
    config: {
      respawnDelay: 4,
      startWeapons: ['shove'],
      friendlyFire: true,
      ...(options.config || {}),
    },

    init(sim) {
      sim.state.mode = {
        phase: 'roam',
        endsAt: sim.state.t + ROAM_SECONDS,
        race: 1,
        laps,
        results: [],
        winner: null,
      };
    },

    onJoin(sim, p) {
      p.racing = false;
      p.finishTime = 0;
      p.nextCp = 0;
      p.lap = 0;
      // A newcomer joins the next race rather than the one already running:
      // dropping someone into lap two would be worse than a short wait.
      p.waitingForRace = sim.state.mode.phase === 'racing';
    },

    onDeath(sim, victim, killer) {
      if (killer && sim.state.mode.phase === 'roam') killer.score += 1;
      if (victim.racing) {
        // Dying in a race costs you the position, not the race.
        victim.nextCp = Math.max(0, victim.nextCp - 1);
      }
    },

    onCheckpoint(sim, p) {
      const m = sim.state.mode;
      if (m.phase !== 'racing' || !p.racing || p.finishTime) return;
      if (p.lap < m.laps) return;
      p.finishTime = sim.state.t - m.startedAt;
      p.racing = false;
      const place = m.results.length + 1;
      m.results.push({
        id: p.id, n: p.name, place,
        t: Math.round(p.finishTime * 100) / 100,
      });
      p.score += POINTS[place - 1] || 1;
      sim.emit({ e: 'finish', p: p.id, pl: place, t: Math.round(p.finishTime * 10) / 10 });
      if (place === 1) {
        m.winner = { id: p.id, n: p.name };
        m.endsAt = Math.min(m.endsAt, sim.state.t + FINISH_GRACE);
      }
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      if (t < m.endsAt && !(m.phase === 'racing' && everyoneFinished(sim))) return;

      if (m.phase === 'roam') {
        m.phase = 'countdown';
        m.endsAt = t + COUNTDOWN_SECONDS;
        m.results = [];
        m.winner = null;
        for (const p of sim.players) resetRacer(sim, p, true);
        sim.emit({ e: 'racesoon', n: m.race });
        return;
      }

      if (m.phase === 'countdown') {
        m.phase = 'racing';
        m.startedAt = t;
        m.endsAt = t + RACE_SECONDS;
        for (const p of sim.players) {
          p.racing = !p.waitingForRace;
          p.waitingForRace = false;
        }
        sim.emit({ e: 'racestart', n: m.race });
        return;
      }

      if (m.phase === 'racing') {
        m.phase = 'results';
        m.endsAt = t + RESULTS_SECONDS;
        for (const p of sim.players) p.racing = false;
        sim.emit({ e: 'raceend', w: m.winner ? m.winner.id : null });
        return;
      }

      m.phase = 'roam';
      m.race += 1;
      m.endsAt = t + ROAM_SECONDS;
      for (const p of sim.players) resetRacer(sim, p, false);
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        race: m.race,
        laps: m.laps,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        results: m.results.slice(0, 5),
        winner: m.winner,
        running: sim.players.filter(p => p.racing).length,
      };
    },
  };

  function everyoneFinished(sim) {
    return sim.players.length > 0 && !sim.players.some(p => p.racing);
  }

  /** Put a player back on the grid (or just clear their race progress). */
  function resetRacer(sim, p, toGrid) {
    p.finishTime = 0;
    p.nextCp = 0;
    p.lap = 0;
    p.racing = false;
    p.waitingForRace = false;
    if (!toGrid) return;
    const grid = sim.world.spawns.filter(s => s.tag === 'grid');
    if (!grid.length) return;
    const slot = grid[sim.players.indexOf(p) % grid.length];
    sim.teleportPlayer(p, slot);
    p.hp = p.maxHp;
    p.deadUntil = 0;
  }
}

/**
 * Usion City — the reference world-engine game server (direct mode).
 *
 * Everything hard is in `@usions/world-engine`: this file picks a world, a
 * mode and a port. That is the point of the engine — a creator ships rules,
 * not netcode.
 *
 * Environment:
 *   PORT             listen port (Railway injects its own; default 3040)
 *   SERVICE_ID       our service id; token `aud` must be usion-game-service:<id>
 *   USION_API_URL    platform API origin; JWKS is <USION_API_URL>/.well-known/jwks.json
 *   PUBLIC_KEY_PEM   SPKI PEM that replaces the JWKS (local dev only)
 *   WORLD_SEED       city seed — change it and the whole city changes
 *   LOG_LEVEL        debug | info | warn | error
 */

const WORLD_SPEC = {
  generator: 'city',
  options: {
    seed: Number(process.env.WORLD_SEED || 20260728),
    blocks: 6,
    blockSize: 68,
    roadWidth: 16,
    name: 'Usion City',
  },
};

async function startCity(overrides = {}) {
  return createWorldServer({
    serviceId: process.env.SERVICE_ID || 'usion-city',
    port: Number(process.env.PORT || 3040),
    worldSpec: WORLD_SPEC,
    mode: cityRushMode,          // a factory: each world room gets its own rules
    // Relative to the working directory, so it resolves the same whether you
    // run `node server.js` or the bundled `node dist/server.mjs`.
    staticDir: process.env.STATIC_DIR || resolve(process.cwd(), 'client'),
    tickHz: 30,
    snapshotHz: 15,
    aoiRadius: 160,              // metres a player can see other players from
    maxPlayers: 200,
    ...overrides,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.on('unhandledRejection', (reason) => console.error('[usion-city] unhandledRejection', reason));
  process.on('uncaughtException', (err) => console.error('[usion-city] uncaughtException', err));
  const server = await startCity();
  const shutdown = async (signal) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'shutdown', signal }));
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export { WORLD_SPEC, startCity };
