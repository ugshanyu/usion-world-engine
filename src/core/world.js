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
import { createCollisionWorld } from './collision.js';
import { createMover, updateMovers } from './movers.js';
import { distSq2 } from './math.js';
import { createPhysics } from './physics.js';
import { CHARACTER } from './character.js';

export const DEFAULT_THEME = {
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
export function normalizeManifest(manifest) {
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
export function buildWorld(manifest, options = {}) {
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
export function atCheckpoint(cp, x, y, z) {
  const r = cp.radius || 9;
  if (distSq2(x, z, cp.x, cp.z) > r * r) return false;
  const height = cp.height || 12;
  return y >= cp.y - 3 && y <= cp.y + height;
}
