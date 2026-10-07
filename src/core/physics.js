/**
 * Rapier physics backend.
 *
 * The core never imports Rapier itself: the host passes in an initialised
 * RAPIER namespace (`@dimforge/rapier3d-deterministic-compat`), so the same
 * code runs in Node, in the browser and — once the platform provides Rapier —
 * inside the rooms-runtime sandbox. The deterministic build gives
 * byte-identical results on every engine and CPU we ship to
 * (spikes/rapier/RESULTS.md), which is what lets a phone predict its own
 * player against the exact geometry the server simulates.
 *
 * What lives in the Rapier world:
 *   - static geometry: manifest boxes, ramps (convex wedges) and meshes
 *     (trimeshes, e.g. exported from Blender)
 *   - movers: colliders posed from world time (movers.js computes the pose;
 *     this file only mirrors it), so they cost no bandwidth
 *   - rollers: dynamic balls, simulated on the server only
 *   - one capsule per player, used purely as the character controller's
 *     shape. Player capsules collide with NOTHING — the controller moves them,
 *     and players jostle each other through the soft push in character.js.
 *
 * Collision groups (membership << 16 | filter):
 */
export const GROUP = {
  STATIC: 0x1,
  RIDE: 0x2,       // platforms, pistons, conveyors: block and carry
  HAZARD: 0x4,     // spinners, sweepers: block and knock you down
  PLAYER: 0x8,
  ROLLER: 0x10,    // dynamic balls
};

const ALL = 0xffff;
const groups = (membership, filter) => ((membership & 0xffff) << 16) | (filter & 0xffff);

// The character controller sees the level and the movers, never other
// players (soft push) or rollers (they knock you over instead of blocking).
const MOVE_GROUPS = groups(GROUP.PLAYER, GROUP.STATIC | GROUP.RIDE | GROUP.HAZARD);
const GROUND_GROUPS = groups(GROUP.PLAYER, GROUP.STATIC | GROUP.RIDE);
const KNOCK_GROUPS = groups(GROUP.PLAYER, GROUP.HAZARD | GROUP.ROLLER);

/** Quaternion for a rotation of `ry` radians about +Y (the engine's yaw). */
function yawQuat(ry, out) {
  out.x = 0; out.y = Math.sin(ry / 2); out.z = 0; out.w = Math.cos(ry / 2);
  return out;
}

/**
 * @param {object} R        initialised RAPIER namespace
 * @param {object} manifest normalised world manifest
 * @param {Array}  movers   runtime movers from movers.js (already posed at t=0)
 * @param {object} [opts]   {character: CHARACTER constants, gravity}
 */
export function createPhysics(R, manifest, movers, opts = {}) {
  const C = opts.character;
  const world = new R.World({ x: 0, y: -(opts.gravity ?? 20), z: 0 });
  world.timestep = opts.dt ?? 1 / 30;
  const q = { x: 0, y: 0, z: 0, w: 1 };

  // ---- static level -------------------------------------------------------
  const staticGroups = groups(GROUP.STATIC, ALL);
  for (const s of manifest.solids) {
    if (s.solid === false) continue;
    let desc;
    if (s.kind === 'ramp') {
      // Wedge rising along local +Z, matching collision.js ramps exactly.
      desc = R.ColliderDesc.convexHull(new Float32Array([
        -s.hx, -s.hy, -s.hz, s.hx, -s.hy, -s.hz,
        -s.hx, -s.hy, s.hz, s.hx, -s.hy, s.hz,
        -s.hx, s.hy, s.hz, s.hx, s.hy, s.hz,
      ]));
    } else {
      desc = R.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    }
    desc.setTranslation(s.x, s.y, s.z).setRotation(yawQuat(s.ry || 0, q)).setCollisionGroups(staticGroups);
    world.createCollider(desc);
  }
  for (const mesh of manifest.meshes || []) {
    const desc = R.ColliderDesc.trimesh(Float32Array.from(mesh.vertices), Uint32Array.from(mesh.indices));
    desc.setCollisionGroups(staticGroups);
    world.createCollider(desc);
  }
  if (manifest.groundY !== null && manifest.groundY !== undefined) {
    const b = manifest.bounds;
    const hx = (b.maxX - b.minX) / 2 + 50;
    const hz = (b.maxZ - b.minZ) / 2 + 50;
    world.createCollider(R.ColliderDesc.cuboid(hx, 1, hz)
      .setTranslation((b.minX + b.maxX) / 2, manifest.groundY - 1, (b.minZ + b.maxZ) / 2)
      .setCollisionGroups(staticGroups));
  }

  // ---- movers -------------------------------------------------------------
  // Movers are STANDALONE colliders (no rigid body) re-posed every tick.
  // Rapier treats them like fixed geometry, which matters: on kinematic
  // bodies the character controller silently adds platform motion, and only
  // when the body was moved with setNextKinematic* — the server and a phone
  // replaying history would then disagree. Our own carry (character-physics)
  // is identical on both sides.
  const moverByCollider = new Map();
  const moverColliders = [];
  for (const m of movers) {
    const s = m.solid;
    const col = world.createCollider(R.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
      .setTranslation(s.x, s.y, s.z).setRotation(yawQuat(s.ry, q))
      .setCollisionGroups(groups(m.rideable ? GROUP.RIDE : GROUP.HAZARD, ALL)));
    moverByCollider.set(col.handle, m);
    moverColliders.push({ m, col });
  }

  /** Mirror the movers' current poses (set by updateMovers) into Rapier. */
  const v3 = { x: 0, y: 0, z: 0 };
  function syncMovers() {
    for (let i = 0; i < moverColliders.length; i++) {
      const { m, col } = moverColliders[i];
      const s = m.solid;
      v3.x = s.x; v3.y = s.y; v3.z = s.z;
      col.setTranslation(v3);
      col.setRotation(yawQuat(s.ry, q));
    }
  }

  // ---- rollers (server-only dynamic balls) --------------------------------
  const rollers = new Map();      // id → {id, body, collider, r}
  const rollerByCollider = new Map();
  function addRoller(id, x, y, z, r, vx = 0, vy = 0, vz = 0, push = 0.6) {
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z).setLinvel(vx, vy, vz).setCcdEnabled(true));
    const collider = world.createCollider(R.ColliderDesc.ball(r).setDensity(2).setRestitution(0.2)
      // PLAYER in the filter only makes balls visible to the knock query:
      // player capsules accept no contacts, so balls never bounce off people.
      .setFriction(0.8).setCollisionGroups(groups(GROUP.ROLLER,
        GROUP.STATIC | GROUP.RIDE | GROUP.HAZARD | GROUP.ROLLER | GROUP.PLAYER)), body);
    const roller = { id, body, collider, r, push };     // push: share of its speed a hit transfers
    rollers.set(id, roller);
    rollerByCollider.set(collider.handle, roller);
    return roller;
  }
  function removeRoller(id) {
    const roller = rollers.get(id);
    if (!roller) return;
    rollerByCollider.delete(roller.collider.handle);
    world.removeRigidBody(roller.body);
    rollers.delete(id);
  }

  // ---- characters ---------------------------------------------------------
  const halfHeight = (C.height - 2 * C.radius) / 2;
  const centerY = C.radius + halfHeight;            // feet → capsule centre
  const capsules = new Map();                        // player id → collider
  const capsuleShape = new R.Capsule(halfHeight, C.radius);

  const kcc = world.createCharacterController(0.02);
  kcc.enableAutostep(C.stepHeight, 0.2, false);
  kcc.enableSnapToGround(0.3);
  kcc.setMaxSlopeClimbAngle(Math.acos(C.maxSlopeNormalY));
  kcc.setMinSlopeSlideAngle(Math.acos(C.maxSlopeNormalY));
  kcc.setApplyImpulsesToDynamicBodies(false);

  function capsuleOf(p) {
    let col = capsules.get(p.id);
    if (!col) {
      col = world.createCollider(R.ColliderDesc.capsule(halfHeight, C.radius)
        .setTranslation(p.x, p.y + centerY, p.z)
        .setCollisionGroups(groups(GROUP.PLAYER, 0)));     // collides with nothing
      capsules.set(p.id, col);
    }
    return col;
  }
  function removeCharacter(id) {
    const col = capsules.get(id);
    if (!col) return;
    world.removeCollider(col, false);
    capsules.delete(id);
  }

  /**
   * Move a player by (dx, dy, dz) with the character controller.
   * Mutates p.x/y/z and returns a SHARED result — read it before the next call.
   */
  const moveResult = { grounded: false, x: 0, y: 0, z: 0, contacts: 0 };
  const contacts = [];          // reused: {nx, ny, nz, mover}
  const delta = { x: 0, y: 0, z: 0 };
  function moveCharacter(p, dx, dy, dz) {
    const col = capsuleOf(p);
    v3.x = p.x; v3.y = p.y + centerY; v3.z = p.z;
    col.setTranslation(v3);
    delta.x = dx; delta.y = dy; delta.z = dz;
    kcc.computeColliderMovement(col, delta, undefined, MOVE_GROUPS);
    const m = kcc.computedMovement();
    p.x += m.x; p.y += m.y; p.z += m.z;
    v3.x = p.x; v3.y = p.y + centerY; v3.z = p.z;
    col.setTranslation(v3);
    moveResult.grounded = kcc.computedGrounded();
    moveResult.x = m.x; moveResult.y = m.y; moveResult.z = m.z;
    const n = kcc.numComputedCollisions();
    moveResult.contacts = n;
    for (let i = 0; i < n; i++) {
      const hit = kcc.computedCollision(i);
      let c = contacts[i];
      if (!c) contacts[i] = c = { nx: 0, ny: 0, nz: 0, mover: null };
      const nrm = hit.normal1;
      c.nx = nrm.x; c.ny = nrm.y; c.nz = nrm.z;
      c.mover = hit.collider ? (moverByCollider.get(hit.collider.handle) || null) : null;
    }
    return moveResult;
  }

  /** What is directly under a player's feet: {normalY, mover} or null. */
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const groundResult = { normalY: 1, mover: null, gap: 0 };
  function groundUnder(p, reach = 0.35) {
    ray.origin.x = p.x; ray.origin.y = p.y + 0.15; ray.origin.z = p.z;
    const hit = world.castRayAndGetNormal(ray, 0.15 + reach, true, undefined, GROUND_GROUPS);
    if (!hit) return null;
    groundResult.normalY = hit.normal.y;
    groundResult.mover = moverByCollider.get(hit.collider.handle) || null;
    groundResult.gap = hit.timeOfImpact - 0.15;        // feet → surface (≈ the controller's skin)
    return groundResult;
  }

  /**
   * Hazards and rollers overlapping a player — catches a spinning bar that
   * swings INTO a player standing still, which the controller (it only
   * resolves the player's own motion) never reports.
   */
  const pos = { x: 0, y: 0, z: 0 };
  const ident = { x: 0, y: 0, z: 0, w: 1 };
  function overlapKnockers(p, cb) {
    pos.x = p.x; pos.y = p.y + centerY; pos.z = p.z;
    world.intersectionsWithShape(pos, ident, capsuleShape, (collider) => {
      const h = collider.handle;
      const mover = moverByCollider.get(h);
      if (mover) cb(mover, null);
      else {
        const roller = rollerByCollider.get(h);
        if (roller) cb(null, roller);
      }
      return true;
    }, undefined, KNOCK_GROUPS);
  }

  return {
    R,
    world,
    centerY,
    syncMovers,
    step() { world.step(); },
    moveCharacter,
    contacts,
    groundUnder,
    overlapKnockers,
    removeCharacter,
    addRoller,
    removeRoller,
    rollers,
    free() { world.free(); },
  };
}
