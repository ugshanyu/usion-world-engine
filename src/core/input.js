/**
 * Input normalisation shared by the server and the phone.
 *
 * The server clamps every raw client input with this before simulating it,
 * and the phone runs the SAME function on what it sends, so a predicted tick
 * and the server's tick see bit-identical input.
 */
import { clamp, wrapAngle } from './math.js';

/** Clamp one raw input into `out` (allocation-free when `out` is reused). */
export function normalizeInput(raw, out = {}) {
  out.mx = clamp(Number(raw.mx) || 0, -1, 1);
  out.mz = clamp(Number(raw.mz) || 0, -1, 1);
  out.aim = Number.isFinite(raw.aim) ? wrapAngle(Number(raw.aim)) : undefined;
  out.jump = !!raw.jump;
  out.sprint = !!raw.sprint;
  out.dive = !!raw.dive;
  out.throttle = clamp(Number(raw.throttle) || 0, -1, 1);
  out.steer = clamp(Number(raw.steer) || 0, -1, 1);
  out.handbrake = !!raw.handbrake;
  out.fire = !!raw.fire;
  out.aimX = Number(raw.aimX) || 0;
  out.aimY = Number(raw.aimY) || 0;
  out.aimZ = Number(raw.aimZ) || 0;
  out.use = !!raw.use;
  out.weapon = typeof raw.weapon === 'string' ? raw.weapon.slice(0, 32) : undefined;
  return out;
}
