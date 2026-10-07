// node node-bench.mjs — server speed, repeatability, snapshot/restore.
import R from '@dimforge/rapier3d-deterministic-compat';
import { performance } from 'node:perf_hooks';
import { PROFILES, buildWorld, step, hashWorld, run } from './scene.mjs';

await R.init();
const now = () => performance.now();
const results = {};

// 1. Speed: authoritative server and phone-side profiles.
results.server = run(R, 'server', 600, now);
results.client = run(R, 'client', 600, now);

// 2. Repeatability: the same run twice in one process must hash identically.
const a = run(R, 'det', 300, now), b = run(R, 'det', 300, now);
results.det = { hashA: a.hash, hashB: b.hash, same: a.hash === b.hash };

// 3. Snapshot/restore mid-run (what client prediction rollback needs).
//    Rapier snapshots the physics world, not our controllers: rebuild them from handles.
function rebind(world, s) {
  const r = { ...s, world };
  r.kcc = world.createCharacterController(0.02);
  r.kcc.enableAutostep(0.5, 0.2, true); r.kcc.enableSnapToGround(0.5);
  r.kcc.setMaxSlopeClimbAngle(0.8); r.kcc.setApplyImpulsesToDynamicBodies(true);
  r.chars = s.chars.map((c) => ({ ...c, body: world.getRigidBody(c.body.handle), col: world.getCollider(c.col.handle) }));
  r.boxes = s.boxes.map((bd) => world.getRigidBody(bd.handle));
  r.proxies = s.proxies.map((q) => ({ ...q, body: world.getRigidBody(q.body.handle) }));
  r.cars = s.cars.map((c) => {
    const body = world.getRigidBody(c.body.handle);
    const ctrl = world.createVehicleController(body);
    for (const [x, z] of [[-0.8, 1.4], [0.8, 1.4], [-0.8, -1.4], [0.8, -1.4]]) {
      ctrl.addWheel({ x, y: -0.2, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.5, 0.4);
    }
    for (let w = 0; w < 4; w++) { ctrl.setWheelSuspensionStiffness(w, 24); ctrl.setWheelFrictionSlip(w, 1.4); }
    return { body, ctrl };
  });
  return r;
}
for (const withCars of [false, true]) {
  const prof = { ...PROFILES.det, cars: withCars ? 10 : 0 };
  const s = buildWorld(R, prof);
  for (let t = 0; t < 150; t++) step(s, t);
  const chars = s.chars.map((c) => ({ vy: c.vy, grounded: c.grounded }));
  const snap = s.world.takeSnapshot();
  for (let t = 150; t < 300; t++) step(s, t);
  const straight = hashWorld(s);
  const w2 = R.World.restoreSnapshot(snap);
  const s2 = rebind(w2, s);
  s2.chars.forEach((c, i) => Object.assign(c, chars[i]));
  for (let t = 150; t < 300; t++) step(s2, t);
  results[withCars ? 'restoreWithCars' : 'restoreNoCars'] = { straight, restored: hashWorld(s2), same: straight === hashWorld(s2) };
}

// 4. Cost of a rollback on the phone profile: snapshot size, take, restore.
{
  const s = buildWorld(R, PROFILES.client);
  for (let t = 0; t < 60; t++) step(s, t);
  let t0 = now(); let snap; for (let i = 0; i < 50; i++) snap = s.world.takeSnapshot();
  const takeMs = (now() - t0) / 50;
  t0 = now(); for (let i = 0; i < 20; i++) R.World.restoreSnapshot(snap).free();
  const restoreMs = (now() - t0) / 20;
  results.clientSnapshot = { bytes: snap.length, takeMs: +takeMs.toFixed(3), restoreMs: +restoreMs.toFixed(3) };
}

console.log(JSON.stringify(results, null, 1));
