/**
 * Third-person chase camera.
 *
 * One camera for both states — it simply sits further back and lower when you
 * are driving. It also raycasts against the same collision world the physics
 * uses, so it never ends up inside a building; without that, a city is
 * unplayable the moment you reverse into an alley.
 */
import { damp, wrapAngle } from '../core/math.js';

export function createCameraRig(camera, world, options = {}) {
  const footDistance = options.footDistance ?? 6.2;
  const carDistance = options.carDistance ?? 9.5;
  const state = { x: 0, y: 5, z: -10, targetX: 0, targetY: 0, targetZ: 0, distance: footDistance };

  function update(target, look, dt) {
    const driving = target.driving;
    const wantDistance = driving ? carDistance : footDistance;
    state.distance = damp(state.distance, wantDistance, 6, dt);

    const height = target.height || 1.8;
    const tx = target.x;
    const ty = target.y + height * (driving ? 0.9 : 0.85);
    const tz = target.z;
    state.targetX = damp(state.targetX || tx, tx, 22, dt);
    state.targetY = damp(state.targetY || ty, ty, 14, dt);
    state.targetZ = damp(state.targetZ || tz, tz, 22, dt);

    const yaw = wrapAngle(look.yaw);
    const pitch = look.pitch;
    const flat = Math.cos(pitch) * state.distance;
    let cx = state.targetX - Math.sin(yaw) * flat;
    let cy = state.targetY + Math.sin(pitch) * state.distance + 0.4;
    let cz = state.targetZ - Math.cos(yaw) * flat;

    // Pull in when the wall gets between the player and the camera.
    const dx = cx - state.targetX;
    const dy = cy - state.targetY;
    const dz = cz - state.targetZ;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const hit = world.collision.raycast(
      state.targetX, state.targetY, state.targetZ,
      dx / len, dy / len, dz / len, len,
    );
    if (hit && hit.t < len) {
      const safe = Math.max(1.2, hit.t - 0.45);
      cx = state.targetX + (dx / len) * safe;
      cy = state.targetY + (dy / len) * safe;
      cz = state.targetZ + (dz / len) * safe;
    }

    state.x = damp(state.x, cx, 20, dt);
    state.y = damp(state.y, cy, 20, dt);
    state.z = damp(state.z, cz, 20, dt);

    camera.position.set(state.x, state.y, state.z);
    camera.setTarget(new BABYLON.Vector3(state.targetX, state.targetY, state.targetZ));
  }

  function reset(target) {
    state.targetX = target.x;
    state.targetY = target.y;
    state.targetZ = target.z;
    state.x = target.x;
    state.y = target.y + 6;
    state.z = target.z - 8;
  }

  return { update, reset, state };
}
