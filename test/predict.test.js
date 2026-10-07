import { describe, it, expect, beforeAll } from 'vitest';
import R from '@dimforge/rapier3d-deterministic-compat';
import { buildWorld } from '../src/core/world.js';
import { createSimulation } from '../src/core/sim.js';
import { boxAt, rampAt } from '../src/core/collision.js';
import { normalizeInput } from '../src/core/input.js';
import { createPredictor } from '../src/client/predict.js';
import { createRng } from '../src/core/rng.js';

const DT = 1 / 30;

const COURSE = {
  id: 'predict-course',
  bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
  spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }],
  solids: [boxAt(6, 0, 14, 8, 3, 1), rampAt(-6, 0, 10, 4, 1.5, 6), boxAt(0, 0, -12, 20, 2, 1)],
  movers: [
    { id: 'spin', kind: 'spinner', x: 0, y: 0.3, z: 6, w: 9, h: 0.8, d: 0.5, period: 2.4 },
    { id: 'sweep', kind: 'sweeper', x: 8, y: 0.3, z: 2, w: 8, h: 0.8, d: 0.5, period: 1.8, sweep: 0.7 },
    { id: 'plat', kind: 'platform', x: -8, y: 0, z: -4, w: 4, h: 0.4, d: 4, period: 3, travel: { x: 6 } },
  ],
};

beforeAll(async () => { await R.init(); });

/**
 * One server + one phone, connected by a fake network with `latency` ticks
 * each way. The phone sends a seq'd input every tick and predicts it; the
 * server snapshots every 2 ticks. Returns the size of every steady-state
 * correction the phone had to make (distance between what it had predicted
 * and the replayed result).
 */
function playSession({ latency = 3, ticks = 450, inputs, onServerTick }) {
  const server = createSimulation({ world: buildWorld(COURSE, { rapier: R, dt: DT }), seed: 1 });
  server.addPlayer('me', 'Me');
  const phoneWorld = buildWorld(COURSE, { rapier: R, dt: DT });
  const phone = createPredictor(phoneWorld, { dt: DT });

  const toServer = [];      // [{at, raw}]
  const toPhone = [];       // [{at, self, me}]
  const corrections = [];
  let seq = 0;

  // Join: the phone adopts the first keyframe before it predicts anything.
  phone.sync(server.projectEntities().me, server.projectSelf('me'), () => null);

  for (let tick = 1; tick <= ticks; tick++) {
    // phone: predict + send
    seq += 1;
    const raw = inputs(tick);
    phone.tick(normalizeInput(raw), seq);
    toServer.push({ at: tick + latency, raw: { ...raw, seq } });

    // server: receive, step, snapshot
    while (toServer.length && toServer[0].at <= tick) server.setInput('me', toServer.shift().raw);
    server.step(DT);
    if (onServerTick) onServerTick(server, tick);
    if (tick % 2 === 0) toPhone.push({ at: tick + latency, self: server.projectEntities().me, me: server.projectSelf('me') });

    // phone: receive snapshots and reconcile
    while (toPhone.length && toPhone[0].at <= tick) {
      const snap = toPhone.shift();
      const before = { x: phone.me.x, y: phone.me.y, z: phone.me.z };
      phone.sync(snap.self, snap.me, () => null);
      const err = Math.hypot(phone.me.x - before.x, phone.me.y - before.y, phone.me.z - before.z);
      // The first applied input re-anchors the phone's clock to the server's
      // (it predicted its opening inputs before the server had any of them);
      // from then on every correction should be zero.
      if (snap.me.ak >= 2) corrections.push(err);
    }
  }
  const final = { server: server.getPlayer('me'), phone: phone.me, pending: phone.pending };
  server.world.dispose();
  phoneWorld.dispose();
  return { corrections, final };
}

function wander(seed) {
  const rng = createRng(seed);
  let mx = 0, mz = 1, aim = 0;
  return (tick) => {
    if (tick % 20 === 0) { mx = rng() * 2 - 1; mz = rng() * 2 - 1; aim = Math.round((rng() * 6 - 3) * 100) / 100; }
    return {
      mx: Math.round(mx * 100) / 100, mz: Math.round(mz * 100) / 100, aim,
      jump: rng() < 0.04, dive: rng() < 0.01, sprint: tick % 90 < 45,
    };
  };
}

describe('client prediction with replay', () => {
  it('predicts exactly what the server computes — no corrections — on a course full of obstacles', () => {
    for (const seed of [1, 2, 3]) {
      const { corrections, final } = playSession({ inputs: wander(seed) });
      const worst = Math.max(...corrections);
      expect(worst).toBeLessThan(1e-6);
      expect(final.pending).toBeLessThanOrEqual(8);
    }
  });

  it('still predicts exactly with a slow (250 ms) connection', () => {
    const { corrections } = playSession({ latency: 8, inputs: wander(9) });
    expect(Math.max(...corrections)).toBeLessThan(1e-6);
  });

  it('gets knocked by a spinning bar on the phone at the same moment as on the server', () => {
    let serverKnockTick = 0;
    const { corrections } = playSession({
      inputs: () => ({ mz: 1, aim: 0 }),        // walk straight into the spinner's path
      ticks: 120,
      onServerTick: (server, tick) => { if (!serverKnockTick && server.getPlayer('me').stunT > 0) serverKnockTick = tick; },
    });
    expect(serverKnockTick).toBeGreaterThan(0);
    expect(Math.max(...corrections)).toBeLessThan(1e-6);
  });

  it('corrects to the server when something unpredictable happens', () => {
    const { corrections, final } = playSession({
      inputs: () => ({}),
      ticks: 120,
      onServerTick: (server, tick) => {
        if (tick === 40) { const p = server.getPlayer('me'); p.vx = 12; p.vy = 4; p.stunT = 1; p.grounded = false; }
      },
    });
    expect(Math.max(...corrections)).toBeGreaterThan(0.5);          // it did have to correct
    expect(Math.hypot(final.phone.x - final.server.x, final.phone.z - final.server.z)).toBeLessThan(1e-6);
  });
});
