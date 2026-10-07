/**
 * A full simulated match used by the cross-engine determinism check: the
 * same function runs in Node (vitest) and in Chromium + WebKit
 * (scripts/check-determinism.cjs), and all must produce the same hash.
 * Only engine code and integer-hashed inputs — no Math.random, no clocks.
 */
import { buildWorld } from '../../src/core/world.js';
import { createSimulation } from '../../src/core/sim.js';
import { boxAt, rampAt } from '../../src/core/collision.js';

export const COURSE = {
  id: 'determinism',
  bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
  spawns: [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ x: (i - 3.5) * 2.5, y: 0, z: -20, yaw: 0 })),
  solids: [boxAt(8, 0, 10, 8, 3, 1), rampAt(-8, 0, 6, 5, 2, 8), boxAt(0, 2, 20, 10, 0.5, 6)],
  meshes: [{ vertices: [-20, 0.5, 30, 20, 0.5, 30, 20, 3, 45, -20, 3, 45], indices: [0, 2, 1, 0, 3, 2] }],
  movers: [
    { id: 'spin', kind: 'spinner', x: 0, y: 0.3, z: -6, w: 12, h: 0.8, d: 0.5, period: 2.4 },
    { id: 'sweep', kind: 'sweeper', x: 6, y: 0.3, z: 0, w: 9, h: 0.8, d: 0.5, period: 1.8, sweep: 0.8 },
    { id: 'plat', kind: 'platform', x: -10, y: 0, z: -10, w: 4, h: 0.4, d: 4, period: 3, travel: { x: 8 } },
  ],
  rollers: [{ id: 'ball', x: 0, y: 3, z: 25, radius: 1.1, every: 1.5, vz: -5, life: 8 }],
};

function h(a, b) {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

export function runDeterminismMatch(R, ticks = 600) {
  const dt = 1 / 30;
  const sim = createSimulation({ world: buildWorld(COURSE, { rapier: R, dt }), seed: 5 });
  for (let i = 0; i < 8; i++) sim.addPlayer('p' + i, 'P' + i);
  for (let tick = 0; tick < ticks; tick++) {
    for (let i = 0; i < 8; i++) {
      const k = tick >> 4;
      sim.setInput('p' + i, {
        seq: tick + 1,
        mx: Math.round((h(i, k) * 2 - 1) * 100) / 100,
        mz: Math.round((h(i + 50, k) * 2 - 0.6) * 100) / 100,
        aim: Math.round((h(i + 99, k) * 6 - 3) * 100) / 100,
        jump: h(i, tick) < 0.05, dive: h(i + 7, tick) < 0.01, sprint: (tick >> 5) % 2 === 0,
      });
    }
    sim.step(dt);
  }
  const values = [];
  for (const p of sim.players) values.push(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.stunT);
  for (const r of sim.world.physics.rollers.values()) { const t = r.body.translation(); values.push(t.x, t.y, t.z); }
  sim.world.dispose();
  // FNV-1a over the float64 bytes: any difference at all changes the hash.
  const bytes = new Uint8Array(new Float64Array(values).buffer);
  let x = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { x ^= bytes[i]; x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, '0') + ':' + values.length;
}
