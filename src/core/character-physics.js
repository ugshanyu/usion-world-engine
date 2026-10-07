/**
 * On-foot character step on the Rapier backend.
 *
 * Same feel as the arcade backend in character.js — it shares the controls
 * (`beginCharacterStep` / `applyCharacterControls`) and the hazard knock —
 * but collision is Rapier's character controller against real geometry:
 * meshes, rotated boxes, ramps and kinematic movers, with autostep, slope
 * limits and snap-to-ground.
 *
 * Deterministic and allocation-free in the hot path: the phone runs this
 * exact function to predict (and replay) the local player.
 */
import { length2, wrapAngle } from './math.js';
import { moverVelocityAt } from './movers.js';
import {
  CHARACTER, beginCharacterStep, applyCharacterControls, knockFromHazard, cancelIntoNormal,
} from './character.js';

const surface = { vx: 0, vy: 0, vz: 0 };

/**
 * @param {object} p      player entity (mutated in place)
 * @param {object} input  {mx, mz, aim, jump, sprint, dive}
 * @param {number} dt     seconds (fixed step)
 * @param {object} ctx    {physics, movers, moverById, config?}
 */
export function stepCharacterPhysics(p, input, dt, ctx) {
  const C = ctx.config || CHARACTER;
  const phys = ctx.physics;
  if (p.locked) input = null;          // countdowns, spectating: physics only, no control

  const ctl = beginCharacterStep(p, input, dt, C);

  // Grounded state comes from the controller's previous move.
  const wasGrounded = p.grounded;
  if (p.grounded) p.coyote = C.coyoteTime;
  else if (p.coyote > 0) p.coyote = Math.max(0, p.coyote - dt);
  const impactSpeed = wasGrounded ? 0 : -p.vy;

  applyCharacterControls(p, input, dt, C, ctl);
  const knockedBefore = p.stunT;

  // ---- gravity ------------------------------------------------------------
  if (p.grounded && p.vy <= 0) {
    p.vy = -C.groundStick;
  } else {
    p.vy -= C.gravity * dt;
    if (p.vy < -C.maxFallSpeed) p.vy = -C.maxFallSpeed;
  }

  // ---- ride platforms -----------------------------------------------------
  let carryX = 0, carryY = 0, carryZ = 0;
  const rider = p.rideId ? ctx.moverById.get(p.rideId) : null;
  if (rider) {
    moverVelocityAt(rider, p.x, p.z, surface);
    carryX = surface.vx * dt;
    carryZ = surface.vz * dt;
    carryY = surface.vy * dt;
  }

  // ---- move ---------------------------------------------------------------
  const res = phys.moveCharacter(p, p.vx * dt + carryX, p.vy * dt + carryY, p.vz * dt + carryZ);
  for (let i = 0; i < res.contacts; i++) {
    const c = phys.contacts[i];
    const m = c.mover;
    if (m && !m.rideable) {
      moverVelocityAt(m, p.x, p.z, surface);
      const nl = length2(c.nx, c.nz) || 1;
      knockFromHazard(p, m, surface.vx, surface.vz, c.nx / nl, c.nz / nl);
      p.diveT = 0;
    } else {
      cancelIntoNormal(p, c.nx, c.ny, c.nz);
    }
  }

  // ---- hazards that swept INTO us -----------------------------------------
  if (p.stunT === knockedBefore) {
    phys.overlapKnockers(p, (m, roller) => {
      if (p.stunT !== knockedBefore) return;     // one knock per step
      let ax = p.x, az = p.z;
      if (m) {
        moverVelocityAt(m, p.x, p.z, surface);
        ax -= m.solid.x; az -= m.solid.z;
        const al = length2(ax, az) || 1;
        knockFromHazard(p, m, surface.vx, surface.vz, ax / al, az / al);
      } else {
        const v = roller.body.linvel();
        const t = roller.body.translation();
        ax -= t.x; az -= t.z;
        const al = length2(ax, az) || 1;
        knockFromHazard(p, roller, v.x, v.z, ax / al, az / al);
      }
      p.diveT = 0;
    });
  }

  // ---- ground -------------------------------------------------------------
  // Grounded = our own short ray finds walkable ground right under the feet.
  // (The controller's own flag flickers off for single ticks while running
  // on flat ground, which breaks coyote time and the run animation.)
  const rising = p.vy > 0.001 && p.stunT === knockedBefore;
  const ground = rising ? null : phys.groundUnder(p);
  p.grounded = !rising && !!ground && ground.gap < 0.12 && ground.normalY >= C.maxSlopeNormalY;
  p.rideId = p.grounded && ground.mover && ground.mover.rideable ? ground.mover.id : null;
  if (p.grounded) {
    if (p.vy < 0) p.vy = 0;
    if (!wasGrounded && impactSpeed > C.fallDamageSpeed) {
      p.pendingFallDamage = Math.round((impactSpeed - C.fallDamageSpeed) * C.fallDamagePerSpeed);
    }
  } else if (p.vy > 0 && res.y < (p.vy * dt + carryY) * 0.5) {
    p.vy = 0;                                    // bumped a ceiling
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
