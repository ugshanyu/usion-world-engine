/**
 * Client-side prediction.
 *
 * The local player runs the SAME step functions the server runs, against the
 * SAME world geometry, so pressing forward moves you instantly instead of one
 * round trip later — and because the physics is identical, the prediction is
 * usually right to within centimetres.
 *
 * Reconciliation is deliberately gentle: on every snapshot the simulated body
 * is moved to the authoritative position, and the difference is kept as a
 * *visual* offset that decays over ~150 ms. You never see a teleport, and the
 * simulation never drifts away from the server. Big disagreements (a car hit
 * you, you were teleported to a start grid) snap immediately — pretending
 * otherwise would just look wrong for longer.
 *
 * Prediction is switched off while stunned or dead: those states are driven by
 * forces the client did not simulate, and fighting them looks worse than a
 * short lag.
 */
import { CHARACTER, spawnCharacter, stepCharacter } from '../core/character.js';
import { stepVehicle, getSpec } from '../core/vehicle.js';

const SNAP_DISTANCE = 5;
const CORRECTION_RATE = 12;    // fraction of the visual error removed per second

export function createPredictor(world) {
  const ctx = { collision: world.collision, movers: world.movers };
  const me = {};
  spawnCharacter(me, { x: 0, y: 0, z: 0, yaw: 0 });
  me.hp = 100;
  me.maxHp = 100;

  const car = {
    id: null, kind: 'sedan',
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0,
    steer: 0, yawRate: 0, pitch: 0, roll: 0, grounded: true, hp: 100,
    passengers: [], driver: null,
  };

  const offset = { x: 0, y: 0, z: 0 };
  let driving = false;
  let active = false;
  let lastServerSeq = -1;

  /** Adopt the authoritative state for this player (and the car they drive). */
  function sync(self, entityLookup) {
    if (!self) { active = false; return; }
    const alive = !self.d && self.hp > 0;
    const frozen = !alive || self.s === 'stun' || self.s === 'getup';
    const wasDriving = driving;
    driving = !!self.v;
    me.hp = self.hp;
    me.maxHp = 100;

    if (driving) {
      const vehicle = entityLookup(self.v);
      if (vehicle) {
        if (car.id !== self.v || !wasDriving) {
          car.id = self.v;
          car.kind = vehicle.t || 'sedan';
          car.vx = 0; car.vy = 0; car.vz = 0;
          car.steer = 0;
          offset.x = 0; offset.y = 0; offset.z = 0;
        }
        reconcile(car, vehicle.x, vehicle.h, vehicle.y, frozen);
        car.yaw = vehicle.a;
        car.pitch = vehicle.p || 0;
        car.roll = vehicle.r || 0;
        car.hp = vehicle.hp;
      }
      active = !frozen;
      return;
    }

    if (wasDriving) { offset.x = 0; offset.y = 0; offset.z = 0; }
    reconcile(me, self.x, self.h, self.y, frozen);
    if (frozen) {
      me.yaw = self.a;
      me.vx = 0; me.vy = 0; me.vz = 0;
    }
    me.anim = self.s;
    active = !frozen;
  }

  function reconcile(body, x, y, z, hard) {
    const dx = body.x - x;
    const dy = body.y - y;
    const dz = body.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (hard || dist > SNAP_DISTANCE) {
      offset.x = 0; offset.y = 0; offset.z = 0;
      body.vx = 0; body.vy = 0; body.vz = 0;
    } else {
      // Keep the visual difference, hand the physics the server's truth.
      offset.x = dx; offset.y = dy; offset.z = dz;
    }
    body.x = x;
    body.y = y;
    body.z = z;
  }

  /** Advance the prediction one render frame. */
  function step(input, dt) {
    const decay = Math.exp(-CORRECTION_RATE * dt);
    offset.x *= decay;
    offset.y *= decay;
    offset.z *= decay;
    if (!active) return;
    if (driving) {
      if (car.id) stepVehicle(car, input, dt, ctx);
      return;
    }
    stepCharacter(me, input, dt, ctx);
  }

  /** Where to put the camera and the local avatar this frame. */
  function view(out = {}) {
    const body = driving ? car : me;
    out.x = body.x + offset.x;
    out.y = body.y + offset.y;
    out.z = body.z + offset.z;
    out.yaw = body.yaw;
    out.driving = driving;
    out.grounded = body.grounded;
    out.speed = Math.sqrt(body.vx * body.vx + body.vz * body.vz);
    out.height = driving ? getSpec(car.kind).height : CHARACTER.height;
    out.anim = driving ? 'drive' : me.anim;
    return out;
  }

  return {
    me,
    car,
    sync,
    step,
    view,
    get driving() { return driving; },
    get active() { return active; },
    get lastServerSeq() { return lastServerSeq; },
    set lastServerSeq(v) { lastServerSeq = v; },
  };
}
