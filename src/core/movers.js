/**
 * Movers — the kinematic hazards and platforms that give a world its Fall
 * Guys character: spinning bars, swinging sweepers, pistons, lifts, crushers
 * and conveyors.
 *
 * A mover's transform is a **pure function of world time**, so the server and
 * every client compute the identical pose from `state.t` without a single
 * byte on the wire. That is what keeps a hazard-dense world affordable at 200
 * players: only the things that make real decisions (players, cars, bullets)
 * are replicated.
 *
 * Spec (from the world manifest):
 *   { id, kind, x, y, z, w, h, d, ry?, period?, phase?, ... }
 *     spinner  — bar rotating about its centre       (period = one full turn)
 *     sweeper  — bar swinging back and forth         (sweep = half-angle)
 *     piston   — box sliding along `travel`          (period = out and back)
 *     platform — same motion, but riders are carried (smooth easing)
 *     crusher  — vertical piston (travel defaults to straight down)
 *     conveyor — static box with a surface velocity  (speed along local +Z)
 *   Optional: `push` (extra knockback multiplier), `damage` (per hit).
 */
import { TAU } from './math.js';
import { prepareSolid, refreshSolid, depenetrateSphere, solidTopAt } from './collision.js';

const RIDEABLE = new Set(['platform', 'piston', 'crusher', 'conveyor']);

export function createMover(spec) {
  const kind = spec.kind || 'platform';
  const solid = prepareSolid({
    kind: 'box',
    x: spec.x, y: spec.y + (spec.h || 1) / 2, z: spec.z,
    hx: (spec.w || 1) / 2, hy: (spec.h || 1) / 2, hz: (spec.d || 1) / 2,
    ry: spec.ry || 0,
    tag: spec.id,
  });
  return {
    id: spec.id,
    kind,
    spec,
    solid,
    baseX: spec.x, baseY: spec.y + (spec.h || 1) / 2, baseZ: spec.z,
    baseRy: spec.ry || 0,
    period: Math.max(0.1, spec.period || 4),
    phase: spec.phase || 0,
    sweep: spec.sweep ?? Math.PI * 0.6,
    travelX: (spec.travel && spec.travel.x) || 0,
    travelY: (spec.travel && spec.travel.y) || (kind === 'crusher' ? -(spec.height ?? 4) : 0),
    travelZ: (spec.travel && spec.travel.z) || 0,
    speed: spec.speed ?? 6,
    push: spec.push ?? 1,
    damage: spec.damage ?? 0,
    rideable: RIDEABLE.has(kind),
    // Current kinematics, refreshed by update():
    vx: 0, vy: 0, vz: 0, omega: 0,
  };
}

/** Advance every mover to world time `t` (seconds). Deterministic. */
export function updateMovers(movers, t) {
  for (let i = 0; i < movers.length; i++) updateMover(movers[i], t);
}

export function updateMover(m, t) {
  const s = m.solid;
  const w = TAU / m.period;
  const phase = t * w + m.phase;
  switch (m.kind) {
    case 'spinner': {
      s.ry = m.baseRy + phase;
      m.omega = w;
      m.vx = 0; m.vy = 0; m.vz = 0;
      break;
    }
    case 'sweeper': {
      s.ry = m.baseRy + Math.sin(phase) * m.sweep;
      m.omega = Math.cos(phase) * m.sweep * w;
      m.vx = 0; m.vy = 0; m.vz = 0;
      break;
    }
    case 'conveyor': {
      m.omega = 0;
      m.vx = Math.sin(s.ry) * m.speed;
      m.vy = 0;
      m.vz = Math.cos(s.ry) * m.speed;
      break;
    }
    case 'piston':
    case 'crusher':
    case 'platform':
    default: {
      // 0 → 1 → 0 with smooth ends so riders are not launched at the turn.
      const u = 0.5 - 0.5 * Math.cos(phase);
      const du = 0.5 * Math.sin(phase) * w;
      s.x = m.baseX + m.travelX * u;
      s.y = m.baseY + m.travelY * u;
      s.z = m.baseZ + m.travelZ * u;
      m.vx = m.travelX * du;
      m.vy = m.travelY * du;
      m.vz = m.travelZ * du;
      m.omega = 0;
      break;
    }
  }
  refreshSolid(s);
  return m;
}

/** Surface velocity of a mover at a world point (rotation + translation). */
export function moverVelocityAt(m, x, z, out) {
  const rx = x - m.solid.x;
  const rz = z - m.solid.z;
  out.vx = m.vx + m.omega * rz;
  out.vy = m.vy;
  out.vz = m.vz - m.omega * rx;
  return out;
}

/**
 * Depenetrate a sphere from all movers near it.
 *
 * `out` accumulates the positional correction (`x`,`y`,`z`,`hit`) and also
 * reports the strongest contact — `mover`, plus that mover's surface velocity
 * (`vx`,`vy`,`vz`) at the contact point — so callers can transfer momentum
 * (a spinner bar launching a player) instead of merely blocking movement.
 */
const contactVel = { vx: 0, vy: 0, vz: 0 };
export function resolveMovers(movers, px, py, pz, r, out) {
  out.x = 0; out.y = 0; out.z = 0; out.hit = false;
  out.mover = null; out.vx = 0; out.vy = 0; out.vz = 0;
  let bestPush = 0;
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i];
    const s = m.solid;
    if (px + r < s.minX || px - r > s.maxX || pz + r < s.minZ || pz - r > s.maxZ) continue;
    const beforeX = out.x, beforeY = out.y, beforeZ = out.z;
    if (!depenetrateSphere(s, px + out.x, py + out.y, pz + out.z, r, out)) continue;
    const dx = out.x - beforeX, dy = out.y - beforeY, dz = out.z - beforeZ;
    const mag = dx * dx + dy * dy + dz * dz;
    if (mag <= bestPush) continue;
    bestPush = mag;
    moverVelocityAt(m, px, pz, contactVel);
    out.mover = m;
    out.vx = contactVel.vx;
    out.vy = contactVel.vy;
    out.vz = contactVel.vz;
  }
  return out;
}

/**
 * Highest rideable mover surface under (x, z) at or below `fromY`.
 * Only platforms/pistons/conveyors carry riders — you do not stand on a
 * spinning bar, it hits you.
 */
const moverGround = { y: -Infinity, mover: null };
export function sampleMoverGround(movers, x, z, fromY, radius = 0) {
  moverGround.y = -Infinity;
  moverGround.mover = null;
  for (let i = 0; i < movers.length; i++) {
    const m = movers[i];
    if (!m.rideable) continue;
    const top = solidTopAt(m.solid, x, z, radius);
    if (top === null || top > fromY + 0.15 || top <= moverGround.y) continue;
    moverGround.y = top;
    moverGround.mover = m;
  }
  return moverGround;
}
