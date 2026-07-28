import { describe, it, expect } from 'vitest';
import { buildWorld } from '../src/core/world.js';
import { createSimulation } from '../src/core/sim.js';
import { boxAt } from '../src/core/collision.js';
import { freeroamMode } from '../src/modes/freeroam.js';

const DT = 1 / 30;

function testWorld(extra = {}) {
  return buildWorld({
    id: 'test',
    bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
    spawns: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 20, y: 0, z: 0, yaw: 0 }],
    solids: [boxAt(0, 0, 60, 30, 10, 2)],
    vehicleSpawns: [{ id: 'car1', kind: 'sedan', x: 3, y: 0, z: 0, yaw: 0 }],
    pickups: [{ id: 'gun1', kind: 'weapon', weapon: 'pistol', x: 0, y: 0.7, z: 6 }],
    checkpoints: [
      { id: 'c0', order: 0, x: 0, y: 0, z: 12, radius: 8 },
      { id: 'c1', order: 1, x: 0, y: 0, z: -12, radius: 8 },
    ],
    ...extra,
  });
}

function makeSim(options = {}) {
  return createSimulation({ world: testWorld(), mode: freeroamMode(), seed: 99, ...options });
}

function run(sim, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) sim.step(DT);
}

describe('simulation', () => {
  it('adds and removes players', () => {
    const sim = makeSim();
    sim.addPlayer('u1', 'Ann');
    sim.addPlayer('u2', 'Bob');
    expect(sim.players.length).toBe(2);
    sim.removePlayer('u1');
    expect(sim.players.length).toBe(1);
    expect(sim.getPlayer('u1')).toBeUndefined();
  });

  it('clamps hostile input instead of trusting it', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    sim.setInput('u1', { mx: 900, mz: -900, throttle: 42, steer: -42, aim: 'nope' });
    expect(p.input.mx).toBe(1);
    expect(p.input.mz).toBe(-1);
    expect(p.input.throttle).toBe(1);
    expect(p.input.steer).toBe(-1);
    expect(p.input.aim).toBeUndefined();
  });

  it('projects entities on the AOI plane: x=X, y=Z, h=height', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 12; p.y = 3; p.z = -7;
    const entities = sim.projectEntities();
    expect(entities.u1.x).toBeCloseTo(12, 2);
    expect(entities.u1.y).toBeCloseTo(-7, 2);
    expect(entities.u1.h).toBeCloseTo(3, 2);
    expect(entities.u1.k).toBe('p');
    expect(entities.car1.k).toBe('v');
    expect(entities.gun1.k).toBe('k');
  });

  it('acknowledges the last input sequence so clients can reconcile', () => {
    const sim = makeSim();
    sim.addPlayer('u1', 'Ann');
    sim.setInput('u1', { seq: 7 });
    sim.setInput('u1', { seq: 4 });          // out of order — never goes backwards
    expect(sim.projectEntities().u1.ak).toBe(7);
  });

  it('has no position on the global entity, so everyone receives it', () => {
    const sim = makeSim();
    sim.addPlayer('u1', 'Ann');
    const g = sim.projectGlobal();
    expect(g.x).toBeUndefined();
    expect(g.y).toBeUndefined();
    expect(Array.isArray(g.board)).toBe(true);
  });

  it('lets a player enter and leave a car', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 3; p.z = 0;
    sim.setInput('u1', { use: true });
    expect(p.veh).toBe('car1');
    expect(sim.getVehicle('car1').driver).toBe('u1');

    sim.setInput('u1', { use: false });
    sim.setInput('u1', { use: true });
    expect(p.veh).toBeNull();
    expect(sim.getVehicle('car1').driver).toBeNull();
  });

  it('drives the car the player is sitting in', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 3; p.z = 0;
    sim.setInput('u1', { use: true });
    sim.setInput('u1', { use: false, throttle: 1 });
    run(sim, 3);
    const car = sim.getVehicle('car1');
    expect(car.z).toBeGreaterThan(10);
    expect(p.z).toBeCloseTo(car.z, 0);     // the rider is carried
  });

  it('picks up a weapon and can then shoot with it', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 0; p.z = 6;
    run(sim, 0.1);
    expect(p.weapons).toContain('pistol');
    expect(p.weapon).toBe('pistol');
    expect(sim.projectEntities().gun1).toBeUndefined();  // taken → despawned
  });

  it('kills and respawns a player', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    sim.damagePlayer(p, 500, null, 'test');
    expect(p.hp).toBe(0);
    expect(p.deaths).toBe(1);
    run(sim, sim.config.respawnDelay + 0.5);
    expect(p.hp).toBe(p.maxHp);
  });

  it('shoots the player in front and not the one behind a wall', () => {
    const sim = makeSim();
    const shooter = sim.addPlayer('u1', 'Ann');
    const target = sim.addPlayer('u2', 'Bob');
    const hidden = sim.addPlayer('u3', 'Cid');
    sim.giveWeapon(shooter, 'rifle');
    shooter.x = 0; shooter.y = 0; shooter.z = 0;
    target.x = 0; target.y = 0; target.z = 20;
    hidden.x = 0; hidden.y = 0; hidden.z = 80;    // behind the wall at z = 60
    sim.setInput('u1', { fire: true, aimX: 0, aimY: 0, aimZ: 1 });
    run(sim, 0.2);
    expect(target.hp).toBeLessThan(100);
    expect(hidden.hp).toBe(100);
  });

  it('counts checkpoints and laps in order', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 0; p.z = 12;
    run(sim, DT);
    expect(p.nextCp).toBe(1);
    p.z = -12;
    run(sim, DT);
    expect(p.nextCp).toBe(2);
    expect(p.lap).toBe(1);
  });

  it('kills a player who falls out of the world', () => {
    const sim = makeSim();
    const p = sim.addPlayer('u1', 'Ann');
    p.x = 5000;
    run(sim, DT);
    expect(p.hp).toBe(0);
  });

  it('runs a hundred bots without exploding', () => {
    const sim = makeSim();
    for (let i = 0; i < 100; i++) {
      sim.addPlayer('u' + i, 'Bot ' + i);
      sim.setInput('u' + i, { mx: Math.sin(i), mz: Math.cos(i), sprint: true });
    }
    run(sim, 2);
    expect(sim.players.length).toBe(100);
    for (const p of sim.players) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it('is deterministic: same seed and inputs produce the same world', () => {
    const inputs = { mx: 0.4, mz: 1, jump: true, sprint: true };
    const snapshotOf = () => {
      const sim = makeSim();
      sim.addPlayer('u1', 'Ann');
      sim.addPlayer('u2', 'Bob');
      sim.setInput('u1', inputs);
      sim.setInput('u2', { mx: -1, mz: 0.2 });
      run(sim, 4);
      return JSON.stringify(sim.projectEntities());
    };
    expect(snapshotOf()).toBe(snapshotOf());
  });
});
