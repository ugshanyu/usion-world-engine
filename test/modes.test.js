import { describe, it, expect } from 'vitest';
import { buildWorld } from '../src/core/world.js';
import { createSimulation } from '../src/core/sim.js';
import { createMode, raceMode, eliminationMode, deathmatchMode } from '../src/modes/index.js';

const DT = 1 / 30;

function run(sim, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) sim.step(DT);
}

function courseWorld() {
  return buildWorld({
    id: 'course',
    bounds: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
    spawns: [
      { x: 0, y: 0, z: 0, yaw: 0, tag: 'start' },
      { x: 4, y: 0, z: 0, yaw: 0, tag: 'grid' },
      { x: -4, y: 0, z: 0, yaw: 0, tag: 'grid' },
    ],
    checkpoints: [
      { id: 'c0', order: 0, x: 0, y: 0, z: 30, radius: 10 },
      { id: 'c1', order: 1, x: 0, y: 0, z: -30, radius: 10 },
    ],
    zones: [{ id: 'goal', kind: 'goal', x: 0, z: 60, radius: 12 }],
  });
}

describe('game modes', () => {
  it('resolves modes by id, by spec object, and passes custom objects through', () => {
    expect(createMode('race').id).toBe('race');
    expect(createMode({ id: 'deathmatch', targetScore: 3 }).id).toBe('deathmatch');
    const custom = { id: 'mine', onTick() {} };
    expect(createMode(custom)).toBe(custom);
    expect(() => createMode('nope')).toThrow();
  });

  it('race: counts down, starts, scores finishers, then resets', () => {
    const sim = createSimulation({
      world: courseWorld(),
      mode: raceMode({ laps: 1, countdown: 1, raceSeconds: 30, intermission: 1, finishGrace: 0.2 }),
      seed: 4,
    });
    const p = sim.addPlayer('u1', 'Ann');
    expect(sim.state.mode.phase).toBe('countdown');

    run(sim, 1.2);
    expect(sim.state.mode.phase).toBe('racing');
    expect(p.racing).toBe(true);

    p.x = 0; p.z = 30;
    run(sim, DT);
    p.x = 0; p.z = -30;
    run(sim, DT);
    expect(p.finishTime).toBeGreaterThan(0);
    expect(sim.state.mode.results[0].id).toBe('u1');
    expect(p.score).toBeGreaterThan(0);

    run(sim, 0.5);
    expect(sim.state.mode.phase).toBe('results');
    run(sim, 1.2);
    expect(sim.state.mode.phase).toBe('countdown');
    expect(p.lap).toBe(0);
  });

  it('race: reports a localizable phase and never an English sentence', () => {
    const sim = createSimulation({ world: courseWorld(), mode: raceMode(), seed: 4 });
    sim.addPlayer('u1', 'Ann');
    const state = sim.projectGlobal().m;
    expect(state.phase).toBe('countdown');
    expect(typeof state.left).toBe('number');
    expect(state.laps).toBe(2);
  });

  it('elimination: qualifies the players who reach the goal and knocks out the rest', () => {
    const sim = createSimulation({
      world: courseWorld(),
      mode: eliminationMode({ countdown: 0.2, roundSeconds: 2, qualifyFraction: 0.5, maxRounds: 3 }),
      seed: 4,
    });
    const a = sim.addPlayer('u1', 'Ann');
    const b = sim.addPlayer('u2', 'Bob');
    const c = sim.addPlayer('u3', 'Cid');
    const d = sim.addPlayer('u4', 'Dee');
    run(sim, 0.3);
    expect(sim.state.mode.phase).toBe('live');
    expect(sim.state.mode.quota).toBe(2);

    a.x = 0; a.z = 60;
    b.x = 0; b.z = 60;
    run(sim, DT * 2);
    expect(a.qualified).toBe(true);
    expect(b.qualified).toBe(true);
    expect(sim.state.mode.phase).toBe('roundend');
    expect(c.elim).toBe(true);
    expect(d.elim).toBe(true);
    expect(a.score).toBeGreaterThan(0);
  });

  it('elimination: a latecomer watches this show and enters the next one', () => {
    const sim = createSimulation({
      world: courseWorld(),
      mode: eliminationMode({ countdown: 0.2, roundSeconds: 1 }),
      seed: 4,
    });
    sim.addPlayer('u1', 'Ann');
    run(sim, 0.4);
    const late = sim.addPlayer('u2', 'Late');
    expect(late.elim).toBe(true);
  });

  it('deathmatch: ends the round when someone hits the target score', () => {
    const sim = createSimulation({
      world: courseWorld(),
      mode: deathmatchMode({ targetScore: 2, roundSeconds: 60, intermission: 1 }),
      seed: 4,
    });
    const a = sim.addPlayer('u1', 'Ann');
    const b = sim.addPlayer('u2', 'Bob');
    sim.damagePlayer(b, 500, 'u1', 'test');
    b.deadUntil = 0;
    b.hp = 100;
    sim.damagePlayer(b, 500, 'u1', 'test');
    expect(a.score).toBe(2);
    expect(sim.state.mode.phase).toBe('over');
    expect(sim.state.mode.winner.id).toBe('u1');

    run(sim, 1.2);
    expect(sim.state.mode.phase).toBe('live');
    expect(a.score).toBe(0);
  });
});
