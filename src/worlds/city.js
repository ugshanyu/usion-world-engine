/**
 * Procedural city generator.
 *
 * Produces a complete world manifest — streets, kerbs, buildings, props,
 * parked cars, weapon pickups, a race circuit, and an obstacle-course
 * district full of Fall Guys hazards — from a single integer seed. The server
 * and every client generate the identical city from that seed, so a whole
 * GTA-sized map costs a few bytes on the wire instead of a mesh download.
 *
 *   const manifest = generateCity({ seed: 7, blocks: 6 });
 *   const world = buildWorld(manifest);
 */
import { createRng } from '../core/rng.js';
import { boxAt, rampAt } from '../core/collision.js';

const PALETTE = ['#8b8f98', '#a5a29b', '#7d8894', '#9b9086', '#6f7681', '#5f6a72'];

export function generateCity(options = {}) {
  const seed = options.seed ?? 7;
  const blocks = options.blocks ?? 6;              // blocks per side
  const blockSize = options.blockSize ?? 68;
  const roadWidth = options.roadWidth ?? 16;
  const rng = createRng(seed);

  const pitch = blockSize + roadWidth;
  const half = (blocks * pitch) / 2;
  const solids = [];
  const props = [];
  const movers = [];
  const spawns = [];
  const vehicleSpawns = [];
  const pickups = [];
  const checkpoints = [];
  const zones = [];

  const bounds = { minX: -half - 30, maxX: half + 30, minZ: -half - 30, maxZ: half + 30 };

  // ---- roads (render-only: the ground plane already stops you falling) ----
  for (let i = 0; i <= blocks; i++) {
    const c = -half + i * pitch;
    solids.push({
      kind: 'box', x: 0, y: 0.02, z: c - roadWidth / 2 + roadWidth / 2,
      hx: half + 30, hy: 0.02, hz: roadWidth / 2, solid: false, tag: 'road',
    });
    solids.push({
      kind: 'box', x: c - roadWidth / 2 + roadWidth / 2, y: 0.02, z: 0,
      hx: roadWidth / 2, hy: 0.02, hz: half + 30, solid: false, tag: 'road',
    });
  }

  // ---- city blocks --------------------------------------------------------
  const centerBlock = Math.floor(blocks / 2);
  const courseBlock = { bx: 0, bz: blocks - 1 };

  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const cx = -half + roadWidth / 2 + bx * pitch + blockSize / 2;
      const cz = -half + roadWidth / 2 + bz * pitch + blockSize / 2;

      // Pavement kerb: a 15 cm lip you can step and drive over.
      solids.push(boxAt(cx, 0, cz, blockSize + 2, 0.16, blockSize + 2, 0, 'pavement'));

      if (bx === centerBlock && bz === centerBlock) {
        buildPlaza(cx, cz);
        continue;
      }
      if (bx === courseBlock.bx && bz === courseBlock.bz) {
        buildObstacleCourse(cx, cz);
        continue;
      }
      buildLot(cx, cz, bx, bz);
    }
  }

  // ---- street furniture, parked cars, race circuit ------------------------
  buildStreets();
  buildCircuit();

  return {
    id: options.id || 'usion-city',
    name: options.name || 'Usion City',
    seed,
    groundY: 0,
    killY: -30,
    bounds,
    theme: {
      sky: '#a8c9e8', fog: '#cfe0f0', ground: '#6d7a6f', road: '#3a3d42',
      line: '#e8e0c4', accent: '#ff5a3c', buildings: PALETTE,
    },
    solids, props, movers, spawns, vehicleSpawns, pickups, checkpoints, zones,
    meta: { blocks, blockSize, roadWidth, pitch, half },
  };

  // ------------------------------------------------------------------ parts

  function buildLot(cx, cz, bx, bz) {
    const count = rng.int(2, 4);
    const cell = blockSize / 2;
    for (let i = 0; i < count; i++) {
      const w = rng.range(16, cell * 0.95);
      const d = rng.range(16, cell * 0.95);
      const h = rng.range(10, bx === 0 || bz === 0 ? 26 : 58);
      const ox = rng.range(-cell + w / 2, cell - w / 2);
      const oz = rng.range(-cell + d / 2, cell - d / 2);
      const building = boxAt(cx + ox, 0.16, cz + oz, w, h, d, 0, 'building');
      building.color = PALETTE[rng.int(0, PALETTE.length - 1)];
      building.windows = true;
      solids.push(building);
      // A flat roof you can actually reach makes a city worth exploring.
      if (h < 18 && rng.chance(0.45)) {
        solids.push(rampAt(cx + ox + w / 2 + 3, 0.16, cz + oz, 5, h, 9, rng.chance(0.5) ? 0 : Math.PI, 'ramp'));
      }
    }
    if (rng.chance(0.5)) {
      pickups.push({
        kind: 'weapon',
        weapon: rng.pick(['pistol', 'smg', 'shotgun', 'rifle']),
        x: cx + rng.range(-cell * 0.6, cell * 0.6),
        y: 0.7,
        z: cz + rng.range(-cell * 0.6, cell * 0.6),
        respawn: 25,
      });
    }
    if (rng.chance(0.35)) {
      pickups.push({ kind: 'health', amount: 50, x: cx, y: 0.7, z: cz, respawn: 30 });
    }
    spawns.push({ x: cx, y: 0.2, z: cz - blockSize / 2 - 1, yaw: Math.PI });
  }

  /** Central plaza — the social hub and the elimination finish line. */
  function buildPlaza(cx, cz) {
    solids.push(boxAt(cx, 0.16, cz, 34, 0.5, 34, 0, 'plaza'));
    solids.push(boxAt(cx, 0.66, cz, 6, 3.2, 6, 0, 'monument'));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      movers.push({
        id: 'plaza_spin_' + i,
        kind: 'spinner',
        x: cx + Math.sin(a) * 13, y: 0.9, z: cz + Math.cos(a) * 13,
        w: 11, h: 1.1, d: 0.7,
        period: 4.5 + i * 0.4, phase: i, push: 1.25,
      });
    }
    zones.push({ id: 'plaza', kind: 'goal', x: cx, z: cz, radius: 17 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawns.push({ x: cx + Math.sin(a) * 24, y: 0.2, z: cz + Math.cos(a) * 24, yaw: a + Math.PI, tag: 'plaza' });
    }
    pickups.push({ kind: 'weapon', weapon: 'rocket', x: cx, y: 4.2, z: cz, respawn: 60 });
  }

  /** Obstacle-course district: the Fall Guys corner of the city. */
  function buildObstacleCourse(cx, cz) {
    const startZ = cz - blockSize / 2 + 4;
    solids.push(boxAt(cx, 0.16, cz, blockSize - 6, 0.3, blockSize - 6, 0, 'course'));
    for (let i = 0; i < 5; i++) spawns.push({ x: cx - 8 + i * 4, y: 0.5, z: startZ, yaw: 0, tag: 'start' });

    // Lane 1 — sweeping bars you jump or dive under.
    for (let i = 0; i < 3; i++) {
      movers.push({
        id: 'course_sweep_' + i,
        kind: 'sweeper',
        x: cx - 12 + i * 12, y: 0.6, z: startZ + 12,
        w: 14, h: 1.2, d: 0.8,
        period: 3 + i * 0.5, phase: i * 1.1, sweep: 1.1, push: 1.4,
      });
    }
    // Lane 2 — moving platforms over a gap.
    for (let i = 0; i < 3; i++) {
      movers.push({
        id: 'course_plat_' + i,
        kind: 'platform',
        x: cx - 10 + i * 10, y: 1.2, z: startZ + 26,
        w: 6, h: 0.5, d: 6,
        travel: { x: 0, y: 0, z: 12 },
        period: 6 + i, phase: i * 2,
      });
    }
    // Lane 3 — pistons that shove you off the walkway.
    solids.push(boxAt(cx, 0.46, cz + 6, 26, 0.4, 8, 0, 'walkway'));
    for (let i = 0; i < 4; i++) {
      movers.push({
        id: 'course_push_' + i,
        kind: 'piston',
        x: cx - 12 + i * 8, y: 0.9, z: cz + 11,
        w: 3, h: 2.2, d: 2,
        travel: { x: 0, y: 0, z: -9 },
        period: 3.5, phase: i * 1.6, push: 1.6,
      });
    }
    // Lane 4 — conveyor run to the finish, uphill.
    movers.push({
      id: 'course_belt',
      kind: 'conveyor',
      x: cx, y: 0.5, z: cz + 20,
      w: 16, h: 0.4, d: 10,
      ry: Math.PI, speed: 5,
    });
    solids.push(rampAt(cx, 0.16, cz + 28, 16, 3.2, 9, 0, 'ramp'));
    zones.push({ id: 'course_goal', kind: 'goal', x: cx, z: cz + blockSize / 2 - 5, rx: 10, rz: 4 });
    checkpointsForCourse(cx, cz);
  }

  function checkpointsForCourse(cx, cz) {
    zones.push({ id: 'course_area', kind: 'course', x: cx, z: cz, rx: blockSize / 2, rz: blockSize / 2 });
  }

  function buildStreets() {
    const carKinds = ['sedan', 'sedan', 'sport', 'truck', 'kart'];
    let carIndex = 0;
    for (let i = 0; i <= blocks; i++) {
      const c = -half + i * pitch;
      for (let j = 0; j < blocks; j++) {
        const along = -half + roadWidth / 2 + j * pitch + blockSize / 2;
        if (rng.chance(0.55)) {
          vehicleSpawns.push({
            id: 'car' + (carIndex++),
            kind: rng.pick(carKinds),
            x: c - roadWidth / 4, y: 0.2, z: along, yaw: 0,
          });
        }
        if (rng.chance(0.55)) {
          vehicleSpawns.push({
            id: 'car' + (carIndex++),
            kind: rng.pick(carKinds),
            x: along, y: 0.2, z: c + roadWidth / 4, yaw: Math.PI / 2,
          });
        }
        props.push({ kind: 'lamp', x: c - roadWidth / 2 + 0.8, y: 0.16, z: along, ry: 0 });
        props.push({ kind: 'tree', x: along, y: 0.16, z: c + roadWidth / 2 - 0.8, ry: rng.range(0, 6.28) });
      }
    }
  }

  /** A race circuit that runs the outer ring road, gate by gate. */
  function buildCircuit() {
    const ring = half - roadWidth / 2 - pitch / 2;
    const gates = [];
    const perSide = Math.max(2, blocks - 1);
    for (let i = 0; i < perSide; i++) {
      const t = -ring + (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: t, z: -ring, ry: 0 });
    }
    for (let i = 1; i < perSide; i++) {
      const t = -ring + (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: ring, z: t, ry: Math.PI / 2 });
    }
    for (let i = 1; i < perSide; i++) {
      const t = ring - (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: t, z: ring, ry: 0 });
    }
    for (let i = 1; i < perSide - 1; i++) {
      const t = ring - (i / (perSide - 1 || 1)) * (ring * 2);
      gates.push({ x: -ring, z: t, ry: Math.PI / 2 });
    }
    gates.forEach((g, i) => {
      checkpoints.push({
        id: 'cp' + i, order: i,
        x: g.x, y: 0, z: g.z, ry: g.ry,
        radius: 11, height: 14,
        start: i === 0,
      });
    });
    // Starting grid on the straight before gate 0.
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const slotX = -ring + 12 + row * 7;
      const slotZ = -ring + side * 3.5;
      // The racer stands BESIDE their car, not inside it: identical
      // coordinates spawn the player intersecting the vehicle body, and the
      // sprint to your car is half the fun of a standing start anyway.
      spawns.push({ x: slotX - 2.6, y: 0.2, z: slotZ, yaw: Math.PI / 2, tag: 'grid' });
      vehicleSpawns.push({
        id: 'grid' + i,
        kind: i < 2 ? 'sport' : 'sedan',
        x: slotX, y: 0.2, z: slotZ, yaw: Math.PI / 2,
      });
    }
  }
}
