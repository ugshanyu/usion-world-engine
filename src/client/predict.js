/**
 * Client-side prediction with replay.
 *
 * The phone runs the SAME fixed-step character code the server runs, against
 * the SAME geometry, one tick per input it sends — so pressing forward moves
 * you instantly instead of a round trip later.
 *
 * Reconciliation is exact rather than approximate. Every snapshot carries
 * `me`: the server's full state for this player (position, velocity, every
 * movement timer) right after it applied input `ak`, stamped with the world
 * time of that tick. The predictor adopts it and re-simulates every input
 * the server has not applied yet, at the obstacle poses of the ticks they
 * will run on. When nothing unexpected happened the result is identical to
 * what was already predicted; when something did (a ball you could not see
 * coming, a shove), the error is corrected and the remaining visual jump is
 * blended out over ~100 ms. Teleports (round resets) snap.
 *
 * Driving uses the older approach (adopt the server pose, keep a decaying
 * visual offset) until vehicles move to the physics backend.
 */
import { CHARACTER, spawnCharacter, stepCharacter } from '../core/character.js';
import { stepVehicle, getSpec } from '../core/vehicle.js';

const SNAP_DISTANCE = 4;
const CORRECTION_RATE = 12;    // fraction of the visual error removed per second
const MAX_HISTORY = 90;        // 3 s of inputs at 30 Hz

/**
 * @param {object} world   runtime world (buildWorld), the same one the server uses
 * @param {object} [opts]  {dt: fixed step, defaults to 1/30}
 */
export function createPredictor(world, opts = {}) {
  const dt = opts.dt ?? 1 / 30;
  const ctx = { collision: world.collision, movers: world.movers, physics: world.physics, moverById: world.moverById };
  const me = { id: '__me__' };
  spawnCharacter(me, { x: 0, y: 0, z: 0, yaw: 0 });
  me.hp = 100;
  me.maxHp = 100;

  const car = {
    id: null, kind: 'sedan',
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0,
    steer: 0, yawRate: 0, pitch: 0, roll: 0, grounded: true, hp: 100,
    passengers: [], driver: null,
  };

  const history = [];                 // [{seq, input}] not yet applied by the server
  const offset = { x: 0, y: 0, z: 0 };
  const prev = { x: 0, y: 0, z: 0, yaw: 0 };
  let time = 0;                       // world time of the latest predicted tick
  let driving = false;
  let alive = true;
  let synced = false;
  let teleports = -1;
  let lastAck = 0;
  let exact = false;                  // receiving the server's exact state (`me`)?

  /** World time → obstacles, for both the physics queries and the renderer. */
  function poseWorld(t) {
    world.update(t);
    if (world.physics) world.physics.step();
  }

  function stepOnce(input) {
    time += dt;
    poseWorld(time);
    stepCharacter(me, input, dt, ctx);
  }

  /**
   * Predict one fixed tick with the input just sent as `seq`.
   * `input` must already be normalised (core/input.js), exactly as sent.
   */
  function tick(input, seq) {
    prev.x = me.x; prev.y = me.y; prev.z = me.z; prev.yaw = me.yaw;
    const decay = Math.exp(-CORRECTION_RATE * dt);
    offset.x *= decay; offset.y *= decay; offset.z *= decay;
    if (seq) {
      history.push({ seq, input: { ...input } });
      if (history.length > MAX_HISTORY) history.shift();
    }
    if (!synced) { time += dt; return; }
    if (driving) {
      time += dt;
      poseWorld(time);
      if (car.id && alive) stepVehicle(car, input, dt, ctx);
      return;
    }
    if (!alive) { time += dt; poseWorld(time); return; }
    stepOnce(input);
  }

  /**
   * Adopt the server's view of this player.
   * @param {object} self   the player's network entity (position, anim, vehicle…)
   * @param {object|null} state  the snapshot's `me` block (exact state), if any
   * @param {Function} entityLookup  id → network entity
   */
  function sync(self, state, entityLookup) {
    if (!self) return;
    alive = !self.d && self.hp > 0;
    const wasDriving = driving;
    driving = !!self.v;
    me.hp = self.hp;

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
        softAdopt(car, vehicle.x, vehicle.h, vehicle.y);
        car.yaw = vehicle.a;
        car.pitch = vehicle.p || 0;
        car.roll = vehicle.r || 0;
        car.hp = vehicle.hp;
      }
      if (state) { time = Math.max(time, state.t); dropApplied(state.ak); }
      synced = true;
      return;
    }

    if (!state) {
      // Hosted rooms do not send `me` yet: fall back to adopting the entity.
      exact = false;
      softAdopt(me, self.x, self.h, self.y);
      if (!alive) { me.vx = 0; me.vy = 0; me.vz = 0; me.yaw = self.a; }
      synced = true;
      return;
    }
    if (synced && state.ak < lastAck) return;   // an older frame arrived late
    lastAck = state.ak;
    exact = true;

    const beforeX = me.x + offset.x;
    const beforeY = me.y + offset.y;
    const beforeZ = me.z + offset.z;

    adopt(state);
    dropApplied(state.ak);
    time = state.t;
    for (let i = 0; i < history.length; i++) {
      if (!alive) break;
      stepOnce(history[i].input);
    }
    if (!alive) poseWorld(time);

    const teleported = state.tp !== teleports;
    teleports = state.tp;
    const dx = beforeX - me.x;
    const dy = beforeY - me.y;
    const dz = beforeZ - me.z;
    if (!synced || teleported || dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
      offset.x = 0; offset.y = 0; offset.z = 0;
      prev.x = me.x; prev.y = me.y; prev.z = me.z; prev.yaw = me.yaw;
    } else {
      offset.x = dx; offset.y = dy; offset.z = dz;
    }
    if (wasDriving) { offset.x = 0; offset.y = 0; offset.z = 0; }
    synced = true;
  }

  function adopt(s) {
    me.x = s.x; me.y = s.y; me.z = s.z;
    me.vx = s.vx; me.vy = s.vy; me.vz = s.vz;
    me.yaw = s.yaw;
    me.grounded = !!s.g;
    me.coyote = s.co; me.jumpBuffer = s.jb;
    me.diveT = s.dv; me.diveCd = s.dc;
    me.stunT = s.st; me.getUpT = s.gu;
    me.rideId = s.rd || null;
  }

  function dropApplied(ack) {
    let n = 0;
    while (n < history.length && history[n].seq <= ack) n++;
    if (n) history.splice(0, n);
  }

  function softAdopt(body, x, y, z) {
    const dx = body.x - x;
    const dy = body.y - y;
    const dz = body.z - z;
    if (!synced || dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
      offset.x = 0; offset.y = 0; offset.z = 0;
    } else {
      offset.x = dx; offset.y = dy; offset.z = dz;
    }
    body.x = x; body.y = y; body.z = z;
  }

  /**
   * Where to draw the camera and the local avatar. `alpha` (0…1) is how far
   * the render frame is between the previous and the latest predicted tick.
   */
  function view(alpha = 1, out = {}) {
    const body = driving ? car : me;
    const a = driving ? 1 : alpha;
    out.x = prev.x + (body.x - prev.x) * a + offset.x;
    out.y = prev.y + (body.y - prev.y) * a + offset.y;
    out.z = prev.z + (body.z - prev.z) * a + offset.z;
    if (driving) { out.x = body.x + offset.x; out.y = body.y + offset.y; out.z = body.z + offset.z; }
    out.yaw = body.yaw;
    out.driving = driving;
    out.grounded = body.grounded;
    out.speed = Math.sqrt(body.vx * body.vx + body.vz * body.vz);
    out.height = driving ? getSpec(car.kind).height : CHARACTER.height;
    out.anim = driving ? 'drive' : me.anim;
    return out;
  }

  /**
   * Without exact state (hosted rooms) the phone has no tick-accurate clock:
   * ease its obstacle time toward the server's world time instead.
   */
  function followServerTime(serverT, frameDt) {
    if (exact || typeof serverT !== 'number') return;
    const drift = serverT - time;
    if (Math.abs(drift) > 1.5) time = serverT;
    else time += drift * Math.min(1, frameDt * 2);
  }

  return {
    me,
    car,
    dt,
    tick,
    sync,
    view,
    followServerTime,
    /** World time of the latest predicted tick (drives obstacle rendering). */
    get time() { return time; },
    get driving() { return driving; },
    get pending() { return history.length; },
    get synced() { return synced; },
  };
}
