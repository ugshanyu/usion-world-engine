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
export const MAX_FRAME_BYTES = 8 * 1024;
export const RATE_LIMIT_PER_SECOND = 60;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_STALE = 4000;
const STALE_CONN_MS = 90_000;          // the SDK heartbeats every 25 s
const PRE_AUTH_BUFFER_MAX = 32;
const KEEPALIVE_SWEEP_MS = 1_000;

export function sendFrame(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify({ type, payload: payload || {} }));
    ws._lastSentAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

export function sendError(ws, code, message) {
  return sendFrame(ws, 'error', { code, message });
}

export function parseClientMessage(raw) {
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

export function createGate({ verifier, getRoom, requestJoin, log, idleFrameMs = 15_000 }) {
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
      default:
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
        getRoom(conn.session.roomId)?.removePlayer(conn.session.userId, ws, 'disconnected');
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
