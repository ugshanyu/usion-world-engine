import { describe, it, expect } from 'vitest';
import { generateCity } from '../src/worlds/city.js';
import { buildManifest } from '../src/worlds/index.js';
import { buildWorld, normalizeManifest } from '../src/core/world.js';
import { createInterestGrid } from '../src/core/interest.js';
import { createWorldBundle } from '../src/hosted/bundle.js';

describe('city generator', () => {
  it('is deterministic for a seed — the whole point of shipping a spec, not a mesh', () => {
    const a = JSON.stringify(generateCity({ seed: 42, blocks: 4 }));
    const b = JSON.stringify(generateCity({ seed: 42, blocks: 4 }));
    expect(a).toBe(b);
    const other = JSON.stringify(generateCity({ seed: 43, blocks: 4 }));
    expect(other).not.toBe(a);
  });

  it('produces a world with everything a game needs', () => {
    const city = generateCity({ seed: 7, blocks: 5 });
    expect(city.solids.length).toBeGreaterThan(50);
    expect(city.spawns.length).toBeGreaterThan(4);
    expect(city.vehicleSpawns.length).toBeGreaterThan(4);
    expect(city.checkpoints.length).toBeGreaterThan(3);
    expect(city.movers.length).toBeGreaterThan(4);
    expect(city.spawns.some(s => s.tag === 'grid')).toBe(true);
    expect(city.spawns.some(s => s.tag === 'start')).toBe(true);
    expect(city.zones.some(z => z.kind === 'goal')).toBe(true);
  });

  it('keeps the world spec tiny even though the city is large', () => {
    const spec = { generator: 'city', options: { seed: 7, blocks: 6 } };
    const manifest = buildManifest(spec);
    expect(JSON.stringify(spec).length).toBeLessThan(80);
    expect(JSON.stringify(manifest).length).toBeGreaterThan(40000);
  });

  it('roads are drawn but not collided with', () => {
    const city = generateCity({ seed: 7, blocks: 4 });
    const roads = city.solids.filter(s => s.tag === 'road');
    expect(roads.length).toBeGreaterThan(0);
    expect(roads.every(r => r.solid === false)).toBe(true);
  });

  it('builds into a working collision world with movers', () => {
    const world = buildWorld(generateCity({ seed: 7, blocks: 4 }));
    expect(world.collision.solids.length).toBeGreaterThan(50);
    expect(world.movers.length).toBeGreaterThan(0);
    world.update(3.5);
    const spinner = world.movers.find(m => m.kind === 'spinner');
    const before = spinner.solid.ry;
    world.update(4.2);
    expect(spinner.solid.ry).not.toBe(before);
  });
});

describe('manifest normalisation', () => {
  it('fills defaults and stamps ids', () => {
    const m = normalizeManifest({ spawns: [{ x: 0, y: 0, z: 0 }], movers: [{ kind: 'spinner', x: 0, y: 0, z: 0 }] });
    expect(m.theme.sky).toBeTruthy();
    expect(m.movers[0].id).toBe('mv0');
    expect(m.bounds).toBeTruthy();
  });

  it('refuses a world nobody can spawn into', () => {
    expect(() => normalizeManifest({ spawns: [] })).toThrow();
  });
});

describe('interest grid', () => {
  it('reports what entered and left each observer view', () => {
    const grid = createInterestGrid({ cellSize: 20 });
    grid.upsert('a', 0, 0);
    grid.upsert('b', 100, 0);
    let res = grid.observe('me', 0, 0, 30);
    expect(res.visible).toContain('a');
    expect(res.visible).not.toContain('b');
    expect(res.entered).toContain('a');

    grid.upsert('b', 10, 10);
    res = grid.observe('me', 0, 0, 30);
    expect(res.entered).toEqual(['b']);
    expect(res.left).toEqual([]);

    grid.remove('a');
    res = grid.observe('me', 0, 0, 30);
    expect(res.left).toEqual(['a']);
  });

  it('is a true circle test, not a box test', () => {
    const grid = createInterestGrid({ cellSize: 16 });
    grid.upsert('corner', 30, 30);
    expect(grid.query(0, 0, 35)).not.toContain('corner');
    expect(grid.query(0, 0, 45)).toContain('corner');
  });
});

describe('hosted bundle contract', () => {
  function fakeRoom() {
    const sent = [];
    return {
      state: {},
      players: [],
      now: 0,
      broadcast: (type, data) => sent.push({ type, data }),
      send: (playerId, type, data) => sent.push({ playerId, type, data }),
      end: () => {},
      sent,
    };
  }

  it('exposes exactly the hooks the rooms runtime calls', () => {
    const bundle = createWorldBundle({ worldSpec: { generator: 'city', options: { seed: 3, blocks: 3 } } });
    expect(bundle.config.tickHz).toBeLessThanOrEqual(30);
    expect(bundle.config.aoi.radius).toBeGreaterThan(0);
    for (const hook of ['init', 'onJoin', 'onLeave', 'onInput', 'tick']) {
      expect(typeof bundle[hook]).toBe('function');
    }
  });

  it('runs a whole turn: init → join → input → tick', () => {
    const bundle = createWorldBundle({
      worldSpec: { generator: 'city', options: { seed: 3, blocks: 3 } },
      mode: 'freeroam',
    });
    const room = fakeRoom();
    bundle.init(room);
    bundle.onJoin(room, { id: 'u1', name: 'Ann' });
    expect(room.sent[0].type).toBe('world');
    expect(room.sent[0].data.world.generator).toBe('city');

    bundle.onInput(room, { id: 'u1' }, { type: 'input', data: { mz: 1, seq: 1 }, channel: 'input' });
    for (let i = 0; i < 30; i++) bundle.tick(room, 1 / 20);

    const entities = room.state.entities;
    expect(entities.u1.k).toBe('p');
    expect(entities.world).toBeTruthy();
    expect(entities.world.x).toBeUndefined();     // position-less → global
    expect(Math.abs(entities.u1.y)).toBeGreaterThan(1);   // it actually walked

    bundle.onLeave(room, { id: 'u1' });
    bundle.tick(room, 1 / 20);
    expect(room.state.entities.u1).toBeUndefined();
  });

  it('keeps room.state JSON-serialisable — it crosses the sandbox every tick', () => {
    const bundle = createWorldBundle({ worldSpec: { generator: 'city', options: { seed: 3, blocks: 3 } } });
    const room = fakeRoom();
    bundle.init(room);
    bundle.onJoin(room, { id: 'u1', name: 'Ann' });
    bundle.tick(room, 0.05);
    expect(() => JSON.stringify(room.state)).not.toThrow();
    const size = JSON.stringify(room.state).length;
    expect(size).toBeLessThan(200000);
  });
});

describe('city starting grid', () => {
  it('stands racers beside their car, never inside it', () => {
    const city = generateCity({ seed: 20260728, blocks: 6 });
    const grid = city.spawns.filter(s => s.tag === 'grid');
    const cars = city.vehicleSpawns.filter(v => String(v.id).startsWith('grid'));
    expect(grid.length).toBe(8);
    expect(cars.length).toBe(8);
    for (const g of grid) {
      for (const c of cars) {
        expect(Math.hypot(g.x - c.x, g.z - c.z)).toBeGreaterThan(1.5);
      }
    }
  });
});
