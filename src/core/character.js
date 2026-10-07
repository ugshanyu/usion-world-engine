/**
 * On-foot character controller.
 *
 * The feel is deliberately arcade — Fall Guys, not a milsim: quick
 * acceleration, generous air control, a committed dive, and players who bump
 * and jostle each other instead of passing through. It is also deterministic
 * and allocation-free, because the client runs this exact function to predict
 * the local player while the server runs it as the authority.
 *
 * Positions are FEET positions (`y` is ground height, not the capsule centre).
 */
import { clamp, approachAngle, length2, wrapAngle } from './math.js';
import { resolveMovers, sampleMoverGround } from './movers.js';
import { stepCharacterPhysics } from './character-physics.js';

export const CHARACTER = {
  radius: 0.4,
  height: 1.8,
  eyeHeight: 1.6,
  walkSpeed: 5.6,
  sprintSpeed: 8.6,
  groundAccel: 48,
  airAccel: 14,
  groundFriction: 11,
  airDrag: 0.25,
  gravity: 24,
  jumpSpeed: 9.2,
  coyoteTime: 0.12,
  jumpBufferTime: 0.15,
  stepHeight: 0.55,
  maxSlopeNormalY: 0.64,     // ≈ 50°: steeper than this and you slide
  slideAccel: 16,
  diveSpeed: 10.5,
  diveUp: 3.6,
  diveTime: 0.55,
  getUpTime: 0.4,
  diveCooldown: 0.9,
  pushRadius: 0.62,          // player-vs-player jostle radius
  pushStrength: 26,
  maxFallSpeed: 45,
  groundStick: 2,            // physics backend: downward push that keeps the controller snapped
  fallDamageSpeed: 22,       // impact speed where fall damage starts
  fallDamagePerSpeed: 4.5,
};

const push = { x: 0, y: 0, z: 0, hit: false, mover: null, vx: 0, vy: 0, vz: 0 };

/** Reset a player to a spawn point, on foot and fully healed. */
export function spawnCharacter(p, spawn) {
  p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.yaw = spawn.yaw || 0;
  p.grounded = true;
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.diveT = 0;
  p.diveCd = 0;
  p.stunT = 0;
  p.getUpT = 0;
  p.anim = 'idle';
  p.rideId = null;
  p.veh = null;
  p.seat = -1;
  return p;
}

/** Knock a player about — car hits, explosions, spinner bars, shoves. */
export function applyImpulse(p, ix, iy, iz, stun = 0) {
  p.vx += ix;
  p.vy += iy;
  p.vz += iz;
  if (stun > 0) {
    p.stunT = Math.max(p.stunT || 0, stun);
    p.diveT = 0;
    p.grounded = false;
  }
}

/**
 * Advance one on-foot player by `dt`.
 *
 * @param {object} p      player entity (mutated in place)
 * @param {object} input  {mx, mz, aim, jump, sprint, dive}
 * @param {number} dt     seconds
 * @param {object} ctx    {collision, movers, gravity?, config?}
 */
export function stepCharacter(p, input, dt, ctx) {
  if (ctx.physics) return stepCharacterPhysics(p, input, dt, ctx);
  const C = ctx.config || CHARACTER;
  const collision = ctx.collision;
  const movers = ctx.movers || [];

  const ctl = beginCharacterStep(p, input, dt, C);

  // ---- ground probe -------------------------------------------------------
  const feetProbe = p.y + 0.25;
  const ground = collision.sampleGround(p.x, p.z, feetProbe, C.radius * 0.9);
  const moverGround = sampleMoverGround(movers, p.x, p.z, feetProbe, C.radius * 0.9);
  let groundY = ground.y;
  let groundNormalY = ground.normalY;
  let rider = null;
  if (moverGround.mover && moverGround.y >= groundY) {
    groundY = moverGround.y;
    groundNormalY = 1;
    rider = moverGround.mover;
  }

  const wasGrounded = p.grounded;
  const nearGround = groundY > -Infinity && p.y <= groundY + 0.08 && p.vy <= 0.001;
  const steep = groundNormalY < C.maxSlopeNormalY;
  p.grounded = nearGround && !steep;
  if (p.grounded) {
    p.coyote = C.coyoteTime;
  } else if (p.coyote > 0) {
    p.coyote = Math.max(0, p.coyote - dt);
  }

  const impactSpeed = wasGrounded ? 0 : -p.vy;

  applyCharacterControls(p, input, dt, C, ctl);
  const stunned = ctl.stunned;
  const diving = ctl.diving;

  // ---- gravity / slopes ---------------------------------------------------
  if (p.grounded) {
    if (p.vy < 0) p.vy = 0;
  } else {
    p.vy -= C.gravity * dt;
    if (p.vy < -C.maxFallSpeed) p.vy = -C.maxFallSpeed;
  }
  if (nearGround && steep) {
    p.vx += ground.slopeX * C.slideAccel * dt;
    p.vz += ground.slopeZ * C.slideAccel * dt;
  }
  if (rider) {
    // Ride the platform: carry its motion without fighting the ground snap.
    p.x += rider.vx * dt;
    p.z += rider.vz * dt;
    if (rider.vy > 0) p.y += rider.vy * dt;
  }

  // ---- integrate ----------------------------------------------------------
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;

  // ---- static + mover collision ------------------------------------------
  // Only the UPPER body is resolved against solids: anything below the step
  // height is the ground probe's job. Sampling a sphere at ankle level fights
  // the ground snap on every ramp and kerb, which reads as walking through
  // treacle up a slope.
  const r = C.radius;
  const heights = diving
    ? [r + 0.1, r * 2]
    : [C.stepHeight + r * 0.5, C.height * 0.55, C.height - r];
  for (let i = 0; i < heights.length; i++) {
    const cy = p.y + heights[i];
    const fix = collision.resolveSphere(p.x, cy, p.z, r);
    if (fix.hit) {
      p.x += fix.x;
      p.z += fix.z;
      if (fix.y > 0 && p.vy < 0) { p.y += fix.y; p.vy = 0; }
      else if (fix.y < 0 && p.vy > 0) { p.y += fix.y; p.vy = 0; }
      cancelIntoNormal(p, fix.x, 0, fix.z);
    }
    if (movers.length) {
      resolveMovers(movers, p.x, p.y + heights[i], p.z, r, push);
      if (push.hit) {
        p.x += push.x;
        p.z += push.z;
        if (push.y !== 0) p.y += push.y;
        const m = push.mover;
        if (m && !m.rideable) {
          // Hazard bar: transfer its surface velocity, then knock you down.
          knockFromHazard(p, m, push.vx, push.vz);
        } else {
          cancelIntoNormal(p, push.x, 0, push.z);
        }
      }
    }
  }

  // ---- ground snap + step up ---------------------------------------------
  const after = collision.sampleGround(p.x, p.z, p.y + (p.grounded ? C.stepHeight : 0.08), C.radius * 0.9);
  const afterMover = sampleMoverGround(movers, p.x, p.z, p.y + (p.grounded ? C.stepHeight : 0.15), C.radius * 0.9);
  let snapY = after.y;
  if (afterMover.mover && afterMover.y > snapY) snapY = afterMover.y;
  if (snapY > -Infinity) {
    if (p.y < snapY) {
      p.y = snapY;
      if (p.vy < 0) p.vy = 0;
      p.grounded = after.normalY >= C.maxSlopeNormalY || afterMover.mover != null;
      // Landing is detected HERE, not before integration: at terminal velocity
      // a body covers 1.5 m per tick and would never be seen "near" the floor.
      if (impactSpeed > C.fallDamageSpeed) {
        p.pendingFallDamage = Math.round((impactSpeed - C.fallDamageSpeed) * C.fallDamagePerSpeed);
      }
    } else if (p.grounded && p.y - snapY < 0.2) {
      p.y = snapY;
    }
  }

  p.yaw = wrapAngle(p.yaw);
  p.anim = p.stunT > 0 ? 'stun'
    : p.diveT > 0 ? 'dive'
      : p.getUpT > 0 ? 'getup'
        : !p.grounded ? 'air'
          : length2(p.vx, p.vz) > 0.6 ? (input && input.sprint ? 'sprint' : 'run')
            : 'idle';
  return p;
}

/**
 * Shared opening of a character step (both physics backends): tick the
 * timers and turn the body toward the camera / stick. Returns a SHARED
 * control record — read it before the next call.
 */
const ctlState = { mx: 0, mz: 0, stunned: false, diving: false };
export function beginCharacterStep(p, input, dt, C) {
  if (p.stunT > 0) p.stunT = Math.max(0, p.stunT - dt);
  if (p.diveCd > 0) p.diveCd = Math.max(0, p.diveCd - dt);
  if (p.getUpT > 0) p.getUpT = Math.max(0, p.getUpT - dt);

  const stunned = p.stunT > 0 || p.getUpT > 0;
  let mx = 0;
  let mz = 0;
  if (input && !stunned) {
    mx = input.mx || 0;
    mz = input.mz || 0;
    const len = length2(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    if (typeof input.aim === 'number') {
      // Facing follows the aim/camera yaw; it snaps faster while moving.
      p.yaw = approachAngle(p.yaw, input.aim, (len > 0.1 ? 14 : 9) * dt);
    } else if (len > 0.1) {
      p.yaw = approachAngle(p.yaw, Math.atan2(mx, mz), 12 * dt);
    }
  }
  ctlState.mx = mx;
  ctlState.mz = mz;
  ctlState.stunned = stunned;
  ctlState.diving = p.diveT > 0;
  return ctlState;
}

/**
 * Shared controls (both backends): dive, buffered jump with coyote time, and
 * arcade horizontal acceleration / friction. Needs p.grounded and p.coyote
 * to be current for this step.
 */
export function applyCharacterControls(p, input, dt, C, ctl) {
  const { mx, mz, stunned, diving } = ctl;
  if (input && !stunned) {
    if (input.jump) p.jumpBuffer = C.jumpBufferTime;
    if (input.dive && !diving && p.diveCd <= 0 && (p.grounded || p.coyote > 0)) {
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      p.vx = fx * C.diveSpeed;
      p.vz = fz * C.diveSpeed;
      p.vy = C.diveUp;
      p.diveT = C.diveTime;
      p.diveCd = C.diveCooldown;
      p.grounded = false;
      p.coyote = 0;
      p.jumpBuffer = 0;
    }
  }
  if (p.jumpBuffer > 0) p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  if (p.jumpBuffer > 0 && (p.grounded || p.coyote > 0) && !diving && !stunned) {
    p.vy = C.jumpSpeed;
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
  }

  if (p.diveT > 0) {
    p.diveT = Math.max(0, p.diveT - dt);
    if (p.diveT === 0) p.getUpT = C.getUpTime;
  }

  // ---- horizontal movement ------------------------------------------------
  const canSteer = !stunned && !diving;
  const speedCap = input && input.sprint ? C.sprintSpeed : C.walkSpeed;
  if (canSteer) {
    const accel = p.grounded ? C.groundAccel : C.airAccel;
    const targetX = mx * speedCap;
    const targetZ = mz * speedCap;
    p.vx += clamp(targetX - p.vx, -accel * dt, accel * dt);
    p.vz += clamp(targetZ - p.vz, -accel * dt, accel * dt);
    if (p.grounded && mx === 0 && mz === 0) {
      const drop = C.groundFriction * dt;
      const speed = length2(p.vx, p.vz);
      const scale = speed > 0 ? Math.max(0, speed - drop) / speed : 0;
      p.vx *= scale;
      p.vz *= scale;
    }
  } else if (p.grounded) {
    const drop = (diving ? 5 : 8) * dt;
    const speed = length2(p.vx, p.vz);
    const scale = speed > 0 ? Math.max(0, speed - drop) / speed : 0;
    p.vx *= scale;
    p.vz *= scale;
  }
}

/**
 * A hazard (spinning bar, sweeper, rolling ball) hits a player: carry its
 * surface velocity — never less than a firm shove away from it — then knock
 * the player over. `awayX/awayZ` (optional, unit) is the fallback direction
 * when the surface itself is barely moving (near a spinner's hub).
 */
export function knockFromHazard(p, m, svx, svz, awayX, awayZ) {
  const kick = m.push ?? 1;
  let vx = svx * kick;
  let vz = svz * kick;
  const minSpeed = 5 * kick;
  if (awayX !== undefined && vx * vx + vz * vz < minSpeed * minSpeed) {
    vx = awayX * minSpeed;
    vz = awayZ * minSpeed;
  }
  p.vx = vx;
  p.vz = vz;
  p.vy = Math.max(p.vy, 3.5 * Math.min(2, kick));
  p.stunT = Math.max(p.stunT, 0.9);
  p.grounded = false;
  if (m.damage) p.pendingHazardDamage = (p.pendingHazardDamage || 0) + m.damage;
}

/** Remove the velocity component pointing into a contact normal. */
export function cancelIntoNormal(p, nx, ny, nz) {
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-6) return;
  nx /= len; ny /= len; nz /= len;
  const dot = p.vx * nx + p.vy * ny + p.vz * nz;
  if (dot >= 0) return;
  p.vx -= nx * dot;
  p.vy -= ny * dot;
  p.vz -= nz * dot;
}

/**
 * Player-vs-player jostle: equal-mass separation so a crowd funnelling
 * through a doorway shoves instead of overlapping. Runs once per step over
 * the whole roster (O(n) with the caller's spatial buckets). `move(p, dx, dz)`
 * replaces the direct position change (the physics backend passes one).
 */
export function resolvePlayerPush(a, b, dt, C = CHARACTER, move = null) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  if (Math.abs(dy) > C.height * 0.9) return false;
  const minDist = C.pushRadius * 2;
  const d2 = dx * dx + dz * dz;
  if (d2 > minDist * minDist) return false;
  const d = Math.sqrt(d2) || 0.0001;
  const overlap = (minDist - d) * 0.5;
  const nx = dx / d;
  const nz = dz / d;
  if (move) {
    // Physics backend: separate through the character controller, so a
    // shove can never push someone into (or through) a wall.
    move(a, -nx * overlap, -nz * overlap);
    move(b, nx * overlap, nz * overlap);
  } else {
    a.x -= nx * overlap;
    a.z -= nz * overlap;
    b.x += nx * overlap;
    b.z += nz * overlap;
  }
  const impulse = Math.min(overlap * C.pushStrength, 9) * dt * 30;
  a.vx -= nx * impulse * dt;
  a.vz -= nz * impulse * dt;
  b.vx += nx * impulse * dt;
  b.vz += nz * impulse * dt;
  return true;
}
