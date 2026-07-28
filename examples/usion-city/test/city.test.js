import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld } from '@usions/world-engine';
import { buildManifest } from '@usions/world-engine/worlds';
import { createSimulation } from '@usions/world-engine';
import { cityRushMode } from '../mode.js';
import { WORLD_SPEC } from '../server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DT = 1 / 30;

function makeSim() {
  const world = buildWorld(buildManifest(WORLD_SPEC));
  return createSimulation({ world, mode: cityRushMode(), seed: 7 });
}

function run(sim, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) sim.step(DT);
}

describe('Usion City', () => {
  it('generates a city with cars, hazards and a race circuit', () => {
    const manifest = buildManifest(WORLD_SPEC);
    expect(manifest.name).toBe('Usion City');
    expect(manifest.vehicleSpawns.length).toBeGreaterThan(10);
    expect(manifest.movers.length).toBeGreaterThan(8);
    expect(manifest.checkpoints.length).toBeGreaterThan(5);
    expect(manifest.spawns.filter(s => s.tag === 'grid').length).toBe(8);
  });

  it('starts in free roam and cycles through a race', () => {
    const sim = makeSim();
    sim.addPlayer('u1', 'Ann');
    expect(sim.state.mode.phase).toBe('roam');

    sim.state.mode.endsAt = sim.state.t;      // fast-forward the roam phase
    run(sim, DT);
    expect(sim.state.mode.phase).toBe('countdown');

    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);
    expect(sim.state.mode.phase).toBe('racing');
    expect(sim.getPlayer('u1').racing).toBe(true);
  });

  it('puts racers on the starting grid, out of their cars', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    const car = sim.vehicles[0];
    p.x = car.x; p.z = car.z;
    sim.setInput('u1', { use: true });
    expect(p.veh).toBeTruthy();

    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);
    const grid = sim.world.spawns.filter(s => s.tag === 'grid');
    expect(p.veh).toBeNull();
    expect(grid.some(s => Math.abs(s.x - p.x) < 0.01 && Math.abs(s.z - p.z) < 0.01)).toBe(true);
  });

  it('scores finishers by place and ends the race when everyone is home', () => {
    const sim = makeSim();
    const a = sim.addPlayer('u1', 'Ann');
    const b = sim.addPlayer('u2', 'Bob');
    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);                              // → countdown
    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);                              // → racing

    finish(sim, a);
    finish(sim, b);
    expect(sim.state.mode.results.map(r => r.id)).toEqual(['u1', 'u2']);
    expect(a.score).toBeGreaterThan(b.score);

    run(sim, DT);
    expect(sim.state.mode.phase).toBe('results');
  });

  it('lets a latecomer roam and race in the NEXT race', () => {
    const sim = makeSim();
    sim.addPlayer('u1', 'Ann');
    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);
    sim.state.mode.endsAt = sim.state.t;
    run(sim, DT);
    expect(sim.state.mode.phase).toBe('racing');

    const late = sim.addPlayer('u2', 'Late');
    expect(late.waitingForRace).toBe(true);
    run(sim, DT);
    expect(late.racing).toBeFalsy();
  });

  it('keeps the built artifacts in sync with the source', () => {
    execFileSync('node', ['scripts/bundle.mjs', '--check'], { cwd: root, stdio: 'pipe' });
  });
});

/** Walk a player through every checkpoint for the configured number of laps. */
function finish(sim, player) {
  const laps = sim.state.mode.laps;
  const gates = sim.world.checkpoints;
  for (let lap = 0; lap < laps; lap++) {
    for (const cp of gates) {
      player.x = cp.x;
      player.y = cp.y;
      player.z = cp.z;
      sim.step(DT);
    }
  }
}
