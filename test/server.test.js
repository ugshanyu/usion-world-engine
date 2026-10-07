import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createWorldServer } from '../src/server/server.js';

const SERVICE_ID = 'world-test';
const ROOM_ID = 'world-test-room';

let server;
let privateKey;
let port;

async function mintToken(userId, name, overrides = {}) {
  return new SignJWT({
    room_id: ROOM_ID,
    service_id: SERVICE_ID,
    session_id: randomUUID(),
    permissions: ['play'],
    name,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'game-access-v1' })
    .setIssuer('usion-backend')
    .setAudience(`usion-game-service:${SERVICE_ID}`)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

/** A tiny client that speaks the SDK's direct-mode envelope. */
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString('utf8'));
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  const api = {
    ws,
    frames,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(type, payload) {
      ws.send(JSON.stringify({
        type, room_id: ROOM_ID, ts: Date.now(), seq: 1,
        session_id: 'sess', protocol_version: '2', payload: payload || {},
      }));
    },
    input(data) {
      api.send('input', { action_type: 'input', action_data: data });
    },
    wait(match, timeoutMs = 4000) {
      const existing = frames.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
    close: () => new Promise((resolve) => {
      // `leave` makes the SERVER close the socket, so it may already be gone.
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    }),
  };
  return api;
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  privateKey = keys.privateKey;
  const publicKeyPem = await exportSPKI(keys.publicKey);
  server = await createWorldServer({
    port: 0,
    serviceId: SERVICE_ID,
    publicKeyPem,
    logLevel: 'error',
    worldSpec: { generator: 'city', options: { seed: 11, blocks: 3 } },
    mode: 'freeroam',
    tickHz: 30,
    snapshotHz: 15,
    aoiRadius: 120,
  });
  port = server.port;
});

afterAll(async () => {
  await server?.close();
});

describe('world server (direct mode)', () => {
  it('serves health with the world spec', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.engine).toBe('usion-world');
    expect(body.world.generator).toBe('city');
  });

  it('rejects a connection with no token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise((resolve) => ws.once('close', resolve));
    expect(code).toBe(4401);
  });

  it('rejects a token minted for another service', async () => {
    const bad = await new SignJWT({
      room_id: ROOM_ID, service_id: 'someone-else', session_id: 's', permissions: ['play'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'game-access-v1' })
      .setIssuer('usion-backend')
      .setAudience('usion-game-service:someone-else')
      .setSubject('u9')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${bad}`);
    const code = await new Promise((resolve) => ws.once('close', resolve));
    expect(code).toBe(4401);
  });

  it('admits a player and hands them the world spec, not a mesh', async () => {
    const client = connect(await mintToken('u1', 'Ann'));
    await client.open();
    client.send('join');
    const joined = await client.wait(f => f.type === 'joined');
    expect(joined.payload.player_id).toBe('u1');
    expect(joined.payload.engine).toBe('usion-world');
    expect(joined.payload.world.generator).toBe('city');
    expect(JSON.stringify(joined.payload.world).length).toBeLessThan(200);

    const keyframe = await client.wait(f => f.type === 'state_snapshot' && f.payload.keyframe);
    expect(keyframe.payload.you).toBe('u1');
    expect(keyframe.payload.entities.u1).toBeTruthy();
    expect(keyframe.payload.entities.world).toBeTruthy();
    await client.close();
  });

  it('moves the player when it receives input, and acks the input sequence', async () => {
    const client = connect(await mintToken('u2', 'Bob'));
    await client.open();
    client.send('join');
    const keyframe = await client.wait(f => f.type === 'state_snapshot' && f.payload.keyframe);
    const start = keyframe.payload.entities.u2;

    const pump = setInterval(() => client.input({ mx: 0, mz: 1, aim: 0, seq: 42 }), 50);
    // Entities arrive as deltas; the owner's own full state rides in `me`.
    const moved = await client.wait((f) => {
      if (f.type !== 'state_snapshot' || f.payload.keyframe) return false;
      const me = f.payload.me;
      return me && Math.hypot(me.x - start.x, me.z - start.y) > 2;
    }, 6000);
    clearInterval(pump);
    expect(moved.payload.me.ak).toBe(42);
    expect(moved.payload.ack).toBe(42);
    await client.close();
  });

  it('advances seq exactly once per snapshot and never on a unicast keyframe', async () => {
    const client = connect(await mintToken('u3', 'Cid'));
    await client.open();
    client.send('join');
    await client.wait(f => f.type === 'state_snapshot' && f.payload.keyframe);
    await new Promise(r => setTimeout(r, 1200));   // the keyframe throttle is 1 s

    const before = client.frames.filter(f => f.type === 'state_snapshot').pop().payload.seq;
    client.send('ping', { t: 1, last_sequence: 0 });        // force a resync keyframe
    const resync = await client.wait(f => f.type === 'state_snapshot' && f.payload.keyframe && f.payload.seq >= before);
    // The keyframe reuses the counter of the last broadcast before it, never
    // advances it (a broadcast may legitimately land between ping and reply).
    const at = client.frames.indexOf(resync);
    const lastBroadcast = client.frames.slice(0, at)
      .filter(f => f.type === 'state_snapshot' && !f.payload.keyframe).pop();
    expect(resync.payload.seq).toBe(lastBroadcast.payload.seq);

    const seqs = client.frames
      .filter(f => f.type === 'state_snapshot' && !f.payload.keyframe)
      .map(f => f.payload.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    await client.close();
  });

  it('tells peers about a player who joins and one who leaves', async () => {
    const a = connect(await mintToken('u4', 'Dee'));
    await a.open();
    a.send('join');
    await a.wait(f => f.type === 'joined');

    const b = connect(await mintToken('u5', 'Eve'));
    await b.open();
    b.send('join');
    await b.wait(f => f.type === 'joined');

    const announced = await a.wait(f => f.type === 'player_joined' && f.payload.player_id === 'u5');
    expect(announced.payload.player_ids).toContain('u5');

    b.send('leave');
    const left = await a.wait(f => f.type === 'player_left' && f.payload.player_id === 'u5');
    expect(left.payload.player_ids).not.toContain('u5');
    await a.close();
    await b.close();
  });

  it('answers pings and heartbeats so proxies never see a silent socket', async () => {
    const client = connect(await mintToken('u6', 'Fay'));
    await client.open();
    client.send('join');
    await client.wait(f => f.type === 'joined');
    client.send('ping', { t: 123 });
    const pong = await client.wait(f => f.type === 'pong');
    expect(pong.payload.t).toBe(123);
    client.send('heartbeat');
    const ack = await client.wait(f => f.type === 'state_delta' && f.payload.event === 'heartbeat');
    expect(ack.payload.data.server_t).toBeGreaterThan(0);
    await client.close();
  });
});
