import { describe, it, expect, beforeAll } from 'vitest';
import R from '@dimforge/rapier3d-deterministic-compat';
import { buildWorld } from '../src/core/world.js';
import { createSimulation } from '../src/core/sim.js';
import { boxAt, rampAt } from '../src/core/collision.js';
import { createRng } from '../src/core/rng.js';

const DT = 1 / 30;

beforeAll(async () => { await R.init(); });

function makeSim(extra = {}, spawn = { x: 0, y: 0, z: 0, yaw: 0 }) {
  const world = buildWorld({
    id: 'phys',
    bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
    spawns: [spawn],
    ...extra,
  }, { rapier: R, dt: DT });
  return createSimulation({ world, seed: 3 });
}

function hold(sim, id, input, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) { sim.setInput(id, input); sim.step(DT); }
}

describe('Rapier backend — character', () => {
  it('walks on flat ground and stays grounded', () => {
    const sim = makeSim();
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', { mx: 0, mz: 1 }, 1);
    expect(p.z).toBeGreaterThan(4);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.y)).toBeLessThan(0.05);
  });

  it('is stopped by a wall instead of passing through it', () => {
    const sim = makeSim({ solids: [boxAt(0, 0, 6, 10, 4, 1)] });
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', { mx: 0, mz: 1 }, 2);
    expect(p.z).toBeLessThan(5.5 - 0.39);          // wall face at 5.5, capsule radius 0.4
    expect(p.z).toBeGreaterThan(4.5);
    expect(Math.abs(p.vz)).toBeLessThan(0.5);
  });

  it('walks up a ramp', () => {
    const sim = makeSim({ solids: [rampAt(0, 0, 5, 4, 2, 8)] });
    const p = sim.addPlayer('a', 'A');
    let maxY = 0;
    for (let i = 0; i < 45; i++) { sim.setInput('a', { mx: 0, mz: 1 }); sim.step(DT); maxY = Math.max(maxY, p.y); }
    expect(maxY).toBeGreaterThan(1.5);
  });

  it('lands and stands on mesh geometry (e.g. exported from Blender)', () => {
    const sim = makeSim({
      groundY: null,
      killY: -20,
      meshes: [{ vertices: [10, 1, 10, 20, 1, 10, 20, 1, 20, 10, 1, 20], indices: [0, 2, 1, 0, 3, 2] }],
    }, { x: 15, y: 3, z: 15, yaw: 0 });
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', {}, 1.5);
    expect(p.y).toBeCloseTo(1, 1);
    expect(p.grounded).toBe(true);
    expect(p.hp).toBeGreaterThan(0);
  });

  it('jumps and lands again', () => {
    const sim = makeSim();
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', {}, 0.2);
    let peak = 0;
    sim.setInput('a', { jump: true }); sim.step(DT);
    for (let i = 0; i < 40; i++) { sim.setInput('a', {}); sim.step(DT); peak = Math.max(peak, p.y); }
    expect(peak).toBeGreaterThan(1.2);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeLessThan(0.05);
  });

  it('dives forward', () => {
    const sim = makeSim();
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', {}, 0.2);
    sim.setInput('a', { dive: true }); sim.step(DT);
    expect(p.diveT).toBeGreaterThan(0);
    hold(sim, 'a', {}, 0.5);
    expect(p.z).toBeGreaterThan(3);
  });
});

describe('Rapier backend — obstacles', () => {
  it('a spinning bar knocks over a player who is standing still', () => {
    const sim = makeSim({
      movers: [{ id: 'spin', kind: 'spinner', x: 0, y: 0.3, z: 5, w: 9, h: 0.8, d: 0.6, period: 2 }],
    }, { x: 3, y: 0, z: 5, yaw: 0 });
    const p = sim.addPlayer('a', 'A');
    let knocked = false;
    for (let i = 0; i < 70 && !knocked; i++) { sim.setInput('a', {}); sim.step(DT); knocked = p.stunT > 0; }
    expect(knocked).toBe(true);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(3);
  });

  it('running into a swinging sweeper knocks the player over', () => {
    const sim = makeSim({
      movers: [{ id: 'sw', kind: 'sweeper', x: 0, y: 0.3, z: 6, w: 10, h: 0.8, d: 0.6, period: 1.5, sweep: 0.6 }],
    });
    const p = sim.addPlayer('a', 'A');
    let knocked = false;
    for (let i = 0; i < 90 && !knocked; i++) { sim.setInput('a', { mz: 1 }); sim.step(DT); knocked = p.stunT > 0; }
    expect(knocked).toBe(true);
  });

  it('a moving platform carries the player standing on it', () => {
    const sim = makeSim({
      groundY: null,
      killY: -20,
      movers: [{ id: 'plat', kind: 'platform', x: 0, y: 0, z: 0, w: 4, h: 0.5, d: 4, period: 4, travel: { x: 10 } }],
    }, { x: 0, y: 0.6, z: 0, yaw: 0 });
    const p = sim.addPlayer('a', 'A');
    hold(sim, 'a', {}, 1.5);
    expect(p.grounded).toBe(true);
    expect(p.rideId).toBe('plat');
    expect(p.x).toBeGreaterThan(3);              // carried along +X
    expect(p.y).toBeGreaterThan(0.3);            // still on top, not fallen through
  });

  it('a rolling ball knocks the player over', () => {
    const sim = makeSim({
      rollers: [{ id: 'ball', x: 0, y: 1.5, z: 12, radius: 1, every: 10, first: 0.05, vz: -9 }],
    });
    const p = sim.addPlayer('a', 'A');
    let knocked = false;
    for (let i = 0; i < 90 && !knocked; i++) { sim.setInput('a', {}); sim.step(DT); knocked = p.stunT > 0; }
    expect(knocked).toBe(true);
    const ents = sim.projectEntities();
    expect(Object.values(ents).some(e => e.k === 'o')).toBe(true);
  });

  it('removes balls when their life runs out', () => {
    const sim = makeSim({ rollers: [{ id: 'b', x: 30, y: 2, z: 30, radius: 1, every: 100, life: 1 }] });
    sim.step(DT);
    expect(sim.world.physics.rollers.size).toBe(1);
    for (let i = 0; i < 40; i++) sim.step(DT);
    expect(sim.world.physics.rollers.size).toBe(0);
  });
});

describe('Rapier backend — determinism', () => {
  function runCourse() {
    const sim = makeSim({
      solids: [boxAt(0, 0, 12, 6, 3, 1), rampAt(-8, 0, 4, 4, 1.5, 6)],
      movers: [
        { id: 's1', kind: 'spinner', x: 4, y: 0.3, z: 6, w: 7, h: 0.8, d: 0.5, period: 2.2 },
        { id: 'p1', kind: 'platform', x: 8, y: 0, z: -6, w: 4, h: 0.5, d: 4, period: 3, travel: { z: 6 } },
      ],
      rollers: [{ id: 'r', x: 0, y: 2, z: 20, radius: 1, every: 2, vz: -6 }],
      spawns: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }],
    });
    for (let i = 0; i < 8; i++) sim.addPlayer('p' + i, 'P' + i);
    const rng = createRng(77);
    for (let tick = 0; tick < 300; tick++) {
      for (let i = 0; i < 8; i++) {
        sim.setInput('p' + i, { mx: rng() * 2 - 1, mz: rng() * 2 - 1, jump: rng() < 0.05, dive: rng() < 0.01, aim: rng() * 6 });
      }
      sim.step(DT);
    }
    const out = sim.players.map(p => [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.stunT].map(v => v.toFixed(9)).join(','));
    for (const r of sim.world.physics.rollers.values()) { const t = r.body.translation(); out.push([t.x, t.y, t.z].join(',')); }
    sim.world.dispose();
    return out.join('|');
  }

  it('produces identical results for identical inputs', () => {
    expect(runCourse()).toBe(runCourse());
  });
});

describe('Rapier backend — players', () => {
  it('players running into each other shove apart instead of overlapping', () => {
    const sim = makeSim({ spawns: [{ x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 3 }] });
    const a = sim.addPlayer('a', 'A');
    const b = sim.addPlayer('b', 'B');
    a.x = 0; a.z = -3; b.x = 0; b.z = 3;
    let closest = Infinity;
    for (let i = 0; i < 60; i++) {
      sim.setInput('a', { mz: 1 }); sim.setInput('b', { mz: -1 });
      sim.step(DT);
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
    }
    expect(closest).toBeGreaterThan(0.6);       // bodies never pass through each other
  });

  it('a full 8-player match is deterministic (same hash the browsers must match)', async () => {
    const { runDeterminismMatch } = await import('./fixtures/determinism-course.js');
    const first = runDeterminismMatch(R);
    expect(runDeterminismMatch(R)).toBe(first);
    console.log('[determinism] node hash', first);
  });
});
