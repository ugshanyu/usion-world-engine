/**
 * Arcade vehicles.
 *
 * The model is deliberately a *driving* model, not a rigid-body simulation:
 * forward/lateral velocity split, speed-sensitive steering, grip that drops
 * on the handbrake so the car drifts, four ground samples for suspension and
 * body angles, and sphere collisions that bounce you off buildings. It reads
 * like GTA to a player and, unlike a real solver, it is deterministic, cheap,
 * and safe to run inside a sandboxed isolate for dozens of cars at once.
 */
import { clamp, wrapAngle, length2 } from './math.js';
import { resolveMovers } from './movers.js';

/** Built-in vehicle classes. Creators can pass their own spec object. */
export const VEHICLE_SPECS = {
  sedan: {
    name: 'sedan', mass: 1300, halfLength: 2.2, halfWidth: 0.95, height: 1.5,
    maxSpeed: 30, reverseSpeed: 9, accel: 12, brake: 26, drag: 0.0045,
    rollingResist: 2.2, grip: 9, driftGrip: 2.6, maxSteer: 0.62,
    steerSpeed: 6, wheelBase: 3.4, hp: 100, seats: 4,
  },
  sport: {
    name: 'sport', mass: 1150, halfLength: 2.1, halfWidth: 0.9, height: 1.25,
    maxSpeed: 41, reverseSpeed: 10, accel: 17, brake: 30, drag: 0.0038,
    rollingResist: 2.0, grip: 10.5, driftGrip: 2.4, maxSteer: 0.58,
    steerSpeed: 7, wheelBase: 3.2, hp: 90, seats: 2,
  },
  truck: {
    name: 'truck', mass: 3400, halfLength: 3.2, halfWidth: 1.25, height: 2.6,
    maxSpeed: 22, reverseSpeed: 7, accel: 7.5, brake: 18, drag: 0.0075,
    rollingResist: 3.0, grip: 6.5, driftGrip: 2.2, maxSteer: 0.5,
    steerSpeed: 4.5, wheelBase: 4.6, hp: 180, seats: 2,
  },
  kart: {
    name: 'kart', mass: 420, halfLength: 1.35, halfWidth: 0.75, height: 1.0,
    maxSpeed: 26, reverseSpeed: 8, accel: 16, brake: 24, drag: 0.005,
    rollingResist: 2.4, grip: 12, driftGrip: 3.2, maxSteer: 0.75,
    steerSpeed: 9, wheelBase: 2.2, hp: 60, seats: 1,
  },
};

export const VEHICLE = {
  gravity: 24,
  maxFallSpeed: 45,
  suspensionSnap: 14,     // how fast the body settles onto the wheels
  crashDamagePerSpeed: 2.4,
  crashThreshold: 8,      // m/s of impact before paint gets scratched
  bounce: 0.35,
  pedKnockSpeed: 4,       // relative speed that knocks a pedestrian down
};

const push = { x: 0, y: 0, z: 0, hit: false, mover: null, vx: 0, vy: 0, vz: 0 };

export function getSpec(kind) {
  return VEHICLE_SPECS[kind] || VEHICLE_SPECS.sedan;
}

/** Create a vehicle entity ready to be dropped into `state.vehicles`. */
export function createVehicle(id, kind, x, y, z, yaw = 0) {
  const spec = getSpec(kind);
  return {
    id,
    kind,
    x, y, z, yaw,
    vx: 0, vy: 0, vz: 0,
    steer: 0,
    yawRate: 0,
    pitch: 0, roll: 0,
    grounded: true,
    hp: spec.hp,
    maxHp: spec.hp,
    driver: null,
    passengers: [],
    homeX: x, homeY: y, homeZ: z, homeYaw: yaw,
    idleFor: 0,
    lastDriver: null,
  };
}

/** Put a wrecked or abandoned vehicle back where it spawned. */
export function respawnVehicle(v) {
  const spec = getSpec(v.kind);
  v.x = v.homeX; v.y = v.homeY; v.z = v.homeZ; v.yaw = v.homeYaw;
  v.vx = 0; v.vy = 0; v.vz = 0;
  v.steer = 0; v.yawRate = 0; v.pitch = 0; v.roll = 0;
  v.hp = spec.hp;
  v.driver = null;
  v.passengers = [];
  v.idleFor = 0;
  return v;
}

/**
 * Advance one vehicle.
 *
 * @param {object} v     vehicle entity (mutated)
 * @param {object} input {throttle:-1..1, steer:-1..1, handbrake:boolean} or null when driverless
 * @param {number} dt    seconds
 * @param {object} ctx   {collision, movers}
 */
export function stepVehicle(v, input, dt, ctx) {
  const spec = getSpec(v.kind);
  const collision = ctx.collision;
  const movers = ctx.movers || [];

  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  const rx = fz;
  const rz = -fx;

  let vf = v.vx * fx + v.vz * fz;      // forward speed (signed)
  let vl = v.vx * rx + v.vz * rz;      // lateral slip

  const throttle = input ? clamp(input.throttle || 0, -1, 1) : 0;
  const steerInput = input ? clamp(input.steer || 0, -1, 1) : 0;
  const handbrake = !!(input && input.handbrake);

  // ---- steering: less lock the faster you go, more yaw while drifting -----
  const speedFrac = Math.min(1, Math.abs(vf) / spec.maxSpeed);
  const steerLimit = spec.maxSteer * (1 - 0.62 * speedFrac);
  const targetSteer = steerInput * steerLimit;
  v.steer += clamp(targetSteer - v.steer, -spec.steerSpeed * dt, spec.steerSpeed * dt);

  if (v.grounded) {
    // ---- engine / brakes --------------------------------------------------
    if (throttle > 0) {
      if (vf < -0.5) vf += spec.brake * throttle * dt;
      else vf += spec.accel * throttle * dt;
    } else if (throttle < 0) {
      if (vf > 0.5) vf += spec.brake * throttle * dt;
      else vf += spec.accel * 0.55 * throttle * dt;
    }
    if (handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), spec.brake * 0.6 * dt);

    // ---- resistance -------------------------------------------------------
    vf -= vf * Math.abs(vf) * spec.drag * dt * 10;
    const roll = spec.rollingResist * dt;
    if (Math.abs(vf) <= roll && throttle === 0) vf = 0;
    else vf -= Math.sign(vf) * roll * (throttle === 0 ? 1 : 0.25);
    vf = clamp(vf, -spec.reverseSpeed, spec.maxSpeed);

    // ---- yaw from the steered wheels --------------------------------------
    const turn = (vf / spec.wheelBase) * Math.tan(v.steer);
    v.yawRate = turn * (handbrake ? 1.55 : 1);
    v.yaw = wrapAngle(v.yaw + v.yawRate * dt);

    // ---- grip: how much sideways slide survives the step -------------------
    const grip = handbrake ? spec.driftGrip : spec.grip;
    vl *= Math.exp(-grip * dt);
  } else {
    v.yaw = wrapAngle(v.yaw + v.yawRate * dt * 0.6);
    vl *= Math.exp(-0.4 * dt);
  }

  // recompose after yaw changed
  const nfx = Math.sin(v.yaw);
  const nfz = Math.cos(v.yaw);
  v.vx = nfx * vf + nfz * vl;
  v.vz = nfz * vf - nfx * vl;

  // ---- vertical -----------------------------------------------------------
  if (!v.grounded) {
    v.vy -= VEHICLE.gravity * dt;
    if (v.vy < -VEHICLE.maxFallSpeed) v.vy = -VEHICLE.maxFallSpeed;
  }

  v.x += v.vx * dt;
  v.y += v.vy * dt;
  v.z += v.vz * dt;

  // ---- suspension: four ground samples give height, pitch and roll --------
  const wl = spec.halfLength * 0.85;
  const ww = spec.halfWidth * 0.9;
  const probeY = v.y + 0.9;
  const fl = groundAt(collision, v.x + nfx * wl - nfz * ww, v.z + nfz * wl + nfx * ww, probeY);
  const fr = groundAt(collision, v.x + nfx * wl + nfz * ww, v.z + nfz * wl - nfx * ww, probeY);
  const rl = groundAt(collision, v.x - nfx * wl - nfz * ww, v.z - nfz * wl + nfx * ww, probeY);
  const rr = groundAt(collision, v.x - nfx * wl + nfz * ww, v.z - nfz * wl - nfx * ww, probeY);
  const support = Math.max(Math.max(fl, fr), Math.max(rl, rr));

  if (support > -Infinity && v.y <= support + 0.35) {
    v.y += (support - v.y) * Math.min(1, VEHICLE.suspensionSnap * dt);
    if (v.y < support) v.y = support;
    if (v.vy < 0) v.vy = 0;
    v.grounded = true;
    const front = (fl + fr) * 0.5;
    const rear = (rl + rr) * 0.5;
    const left = (fl + rl) * 0.5;
    const right = (fr + rr) * 0.5;
    if (Number.isFinite(front) && Number.isFinite(rear)) {
      v.pitch = Math.atan2(rear - front, wl * 2);
    }
    if (Number.isFinite(left) && Number.isFinite(right)) {
      v.roll = Math.atan2(right - left, ww * 2);
    }
  } else {
    v.grounded = false;
    v.pitch *= Math.exp(-3 * dt);
    v.roll *= Math.exp(-3 * dt);
  }

  // ---- body collision: three spheres along the chassis --------------------
  // The spheres ride ABOVE the wheels: one big enough to reach the tarmac
  // would fight the suspension on every ramp and kerb, and the car would
  // simply refuse to climb.
  const bodyR = spec.halfWidth;
  const bodyY = v.y + bodyR + 0.2;
  let impact = 0;
  for (let i = -1; i <= 1; i += 1) {
    const cx = v.x + nfx * (spec.halfLength - bodyR) * i;
    const cz = v.z + nfz * (spec.halfLength - bodyR) * i;
    const fix = collision.resolveSphere(cx, bodyY, cz, bodyR);
    if (fix.hit) impact = Math.max(impact, applyCrash(v, fix.x, fix.y, fix.z));
    if (movers.length) {
      resolveMovers(movers, cx + (fix.hit ? fix.x : 0), bodyY, cz + (fix.hit ? fix.z : 0), bodyR, push);
      if (push.hit) impact = Math.max(impact, applyCrash(v, push.x, push.y, push.z));
    }
  }
  if (impact > VEHICLE.crashThreshold) {
    v.hp = Math.max(0, v.hp - Math.round((impact - VEHICLE.crashThreshold) * VEHICLE.crashDamagePerSpeed));
    v.crashImpact = impact;
  }

  v.speed = length2(v.vx, v.vz);
  if (v.driver) v.idleFor = 0;
  else v.idleFor += dt;
  return v;
}

function groundAt(collision, x, z, fromY) {
  return collision.sampleGround(x, z, fromY, 0.2).y;
}

/** Push the car out of a solid, kill the velocity into it, report impact. */
function applyCrash(v, nx, ny, nz) {
  v.x += nx;
  v.z += nz;
  if (ny > 0) { v.y += ny; if (v.vy < 0) v.vy = 0; }
  const len = Math.sqrt(nx * nx + nz * nz);
  if (len < 1e-6) return 0;
  const ux = nx / len;
  const uz = nz / len;
  const into = v.vx * ux + v.vz * uz;
  if (into >= 0) return 0;
  v.vx -= ux * into * (1 + VEHICLE.bounce);
  v.vz -= uz * into * (1 + VEHICLE.bounce);
  return -into;
}

/**
 * Elastic-ish collision between two vehicles: separate them, then exchange
 * momentum by mass so a truck shunts a kart and not the other way round.
 */
export function resolveVehiclePair(a, b) {
  const sa = getSpec(a.kind);
  const sb = getSpec(b.kind);
  const ra = Math.max(sa.halfWidth, sa.halfLength * 0.6);
  const rb = Math.max(sb.halfWidth, sb.halfLength * 0.6);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.abs(b.y - a.y) > 2.5) return 0;
  const minDist = ra + rb;
  const d2 = dx * dx + dz * dz;
  if (d2 > minDist * minDist || d2 < 1e-9) return 0;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const nz = dz / d;
  const overlap = minDist - d;
  const total = sa.mass + sb.mass;
  a.x -= nx * overlap * (sb.mass / total);
  a.z -= nz * overlap * (sb.mass / total);
  b.x += nx * overlap * (sa.mass / total);
  b.z += nz * overlap * (sa.mass / total);

  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel >= 0) return 0;
  const impulse = -(1 + VEHICLE.bounce) * rel / (1 / sa.mass + 1 / sb.mass);
  a.vx -= (impulse / sa.mass) * nx;
  a.vz -= (impulse / sa.mass) * nz;
  b.vx += (impulse / sb.mass) * nx;
  b.vz += (impulse / sb.mass) * nz;
  const speed = -rel;
  if (speed > VEHICLE.crashThreshold) {
    const dmg = Math.round((speed - VEHICLE.crashThreshold) * VEHICLE.crashDamagePerSpeed);
    a.hp = Math.max(0, a.hp - Math.round(dmg * (sb.mass / total) * 2));
    b.hp = Math.max(0, b.hp - Math.round(dmg * (sa.mass / total) * 2));
  }
  return speed;
}

/** Seat offset for a rider, in world space. */
export function seatPosition(v, seat, out) {
  const spec = getSpec(v.kind);
  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  const side = seat % 2 === 0 ? -1 : 1;
  const row = seat < 2 ? 0.35 : -0.75;
  const lateral = spec.halfWidth * 0.5 * side;
  out.x = v.x + fx * (spec.halfLength * row) + fz * lateral;
  out.y = v.y + spec.height * 0.35;
  out.z = v.z + fz * (spec.halfLength * row) - fx * lateral;
  return out;
}
