// Rapier spike scene — the SAME code runs in Node, Chromium, WebKit and the
// rooms-runtime sandbox, so their hashes can be compared byte for byte.
// No Math.random, no Date: every input is derived from (entity index, tick).

export const PROFILES = {
  // Authoritative server: a Blender-scale mesh map, 200 players, 50 cars, 100 loose boxes.
  server: { grid: 128, cell: 4, chars: 200, cars: 50, boxes: 100, dt: 1 / 30 },
  // Phone predicting itself: same map, its own character + car, 30 remote players as kinematic proxies.
  client: { grid: 128, cell: 4, chars: 1, cars: 1, boxes: 20, proxies: 30, dt: 1 / 60 },
  // Small scene for the cross-engine determinism check (fast on every engine).
  det: { grid: 48, cell: 4, chars: 40, cars: 10, boxes: 40, dt: 1 / 30 },
};

// Integer hash → [0,1). Deterministic across engines (32-bit integer math only).
function h(a, b) {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

// Terrain height from integer-derived values only (no sin/cos: those can differ
// between JS engines, and the point is to test Rapier, not the JS math library).
function height(i, j) {
  return Math.floor(h(i >> 3, j >> 3) * 6) * 0.5 + h(i, j) * 0.25;
}

export function buildWorld(R, p) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = p.dt;
  const n = p.grid, s = p.cell, half = (n - 1) * s / 2;

  // Static "Blender map": one trimesh (n-1)^2*2 triangles + a city of boxes.
  const verts = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = (i * n + j) * 3;
    verts[k] = i * s - half; verts[k + 1] = height(i, j); verts[k + 2] = j * s - half;
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let t = 0;
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
    idx.set([a, b, c, b, d, c], t); t += 6;
  }
  world.createCollider(R.ColliderDesc.trimesh(verts, idx));
  const buildings = [];
  for (let bx = 0; bx < 6; bx++) for (let bz = 0; bz < 6; bz++) {
    if (h(bx, bz + 99) < 0.3) continue;
    buildings.push([bx * 40 - 100, bz * 40 - 100]);
    const hy = 3 + Math.floor(h(bx, bz) * 8);
    world.createCollider(R.ColliderDesc.cuboid(6, hy, 6).setTranslation(bx * 40 - 100, hy, bz * 40 - 100));
  }

  // Spawn on open ground: re-roll (deterministically) until clear of every building.
  const spawn = (k, lift) => {
    for (let r = 0; ; r++) {
      const i = 8 + Math.floor(h(k, 1 + r * 7) * (n - 16)), j = 8 + Math.floor(h(k, 2 + r * 7) * (n - 16));
      const x = i * s - half, z = j * s - half;
      if (buildings.some(([cx, cz]) => Math.abs(x - cx) < 8 && Math.abs(z - cz) < 8)) continue;
      return { x, y: height(i, j) + lift, z };
    }
  };

  // Players: kinematic capsules driven by Rapier's character controller.
  const kcc = world.createCharacterController(0.02);
  kcc.enableAutostep(0.5, 0.2, true);
  kcc.enableSnapToGround(0.5);
  kcc.setMaxSlopeClimbAngle(0.8);
  kcc.setApplyImpulsesToDynamicBodies(true);
  const chars = [];
  for (let c = 0; c < p.chars; c++) {
    const pos = spawn(c, 2);
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const col = world.createCollider(R.ColliderDesc.capsule(0.5, 0.35), body);
    chars.push({ body, col, vy: 0 });
  }

  // Cars: dynamic chassis + ray-cast wheels with suspension (Sketchbook's car model).
  const cars = [];
  for (let v = 0; v < p.cars; v++) {
    const pos = spawn(1000 + v, 3);
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z));
    world.createCollider(R.ColliderDesc.cuboid(0.9, 0.4, 2).setDensity(100), body);
    const ctrl = world.createVehicleController(body);
    for (const [x, z] of [[-0.8, 1.4], [0.8, 1.4], [-0.8, -1.4], [0.8, -1.4]]) {
      ctrl.addWheel({ x, y: -0.2, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.5, 0.4);
    }
    for (let w = 0; w < 4; w++) { ctrl.setWheelSuspensionStiffness(w, 24); ctrl.setWheelFrictionSlip(w, 1.4); }
    cars.push({ body, ctrl });
  }

  // Loose boxes in towers of 5: the stacking/tumbling the current core cannot do.
  const boxes = [];
  for (let b = 0; b < p.boxes; b++) {
    const base = spawn(2000 + Math.floor(b / 5), 0.6);
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(base.x, base.y + (b % 5) * 1.01, base.z));
    world.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    boxes.push(body);
  }

  // Remote players on a phone: kinematic proxies moved to (scripted) server positions.
  const proxies = [];
  for (let q = 0; q < (p.proxies || 0); q++) {
    const pos = spawn(3000 + q, 1);
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    world.createCollider(R.ColliderDesc.capsule(0.5, 0.35), body);
    proxies.push({ body, home: pos });
  }

  return { world, kcc, chars, cars, boxes, proxies, p };
}

// One fixed step with scripted inputs for every entity.
export function step(s, tick) {
  const { world, kcc, chars, cars, proxies, p } = s;
  const dt = p.dt;
  for (let c = 0; c < chars.length; c++) {
    const ch = chars[c];
    const turn = h(c, tick >> 5) * 6.2831853;      // new heading every ~1 s
    const speed = 5.6 * dt;
    // Direction via a small polynomial instead of Math.sin/cos (engine-independent).
    const dx = cosApprox(turn) * speed, dz = sinApprox(turn) * speed;
    if (h(c, tick) < 0.01 && ch.grounded) ch.vy = 5;  // occasional jump
    ch.vy -= 9.81 * dt;
    kcc.computeColliderMovement(ch.col, { x: dx, y: ch.vy * dt, z: dz });
    const m = kcc.computedMovement();
    ch.grounded = kcc.computedGrounded();
    if (ch.grounded && ch.vy < 0) ch.vy = 0;
    const tr = ch.body.translation();
    ch.body.setNextKinematicTranslation({ x: tr.x + m.x, y: tr.y + m.y, z: tr.z + m.z });
  }
  for (let v = 0; v < cars.length; v++) {
    const { ctrl } = cars[v];
    const steer = (h(v, tick >> 6) - 0.5) * 0.8;
    const engine = h(v + 77, tick >> 7) < 0.8 ? 600 : -300;
    ctrl.setWheelSteering(0, steer); ctrl.setWheelSteering(1, steer);
    ctrl.setWheelEngineForce(2, engine); ctrl.setWheelEngineForce(3, engine);
    ctrl.updateVehicle(dt);
  }
  for (let q = 0; q < proxies.length; q++) {
    const pr = proxies[q], a = (tick + q * 13) * 0.02;
    pr.body.setNextKinematicTranslation({ x: pr.home.x + cosApprox(a) * 4, y: pr.home.y, z: pr.home.z + sinApprox(a) * 4 });
  }
  world.step();
}

function sinApprox(a) { // range-reduced Bhaskara-free Taylor; only + - * /
  a = a - 6.2831853 * Math.floor(a / 6.2831853) - 3.14159265;
  const a2 = a * a;
  return -(a * (1 - a2 / 6 * (1 - a2 / 20 * (1 - a2 / 42 * (1 - a2 / 72)))));
}
function cosApprox(a) { return sinApprox(a + 1.57079633); }

// FNV-1a over every dynamic/kinematic body's f32 position + rotation, in creation order.
export function hashWorld(s) {
  const bodies = [...s.chars.map((c) => c.body), ...s.cars.map((c) => c.body), ...s.boxes, ...s.proxies.map((q) => q.body)];
  const f = new Float32Array(bodies.length * 7);
  bodies.forEach((b, i) => {
    const t = b.translation(), r = b.rotation();
    f.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], i * 7);
  });
  const u = new Uint8Array(f.buffer);
  let x = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { x ^= u[i]; x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, '0');
}

// Shared scripted run used by every host: returns per-tick timings + hashes.
export function run(R, profileName, ticks, now) {
  const p = PROFILES[profileName];
  const t0 = now();
  const s = buildWorld(R, p);
  const buildMs = now() - t0;
  const times = [];
  for (let tick = 0; tick < ticks; tick++) {
    const a = now(); step(s, tick); times.push(now() - a);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const out = { profile: profileName, ticks, buildMs: +buildMs.toFixed(1), avgMs: +avg.toFixed(3),
    p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(3), maxMs: +times[times.length - 1].toFixed(3),
    hash: hashWorld(s) };
  s.world.free();
  return out;
}
