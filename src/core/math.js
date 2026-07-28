/**
 * Scalar math helpers for the world core.
 *
 * Everything here is allocation-free on purpose: the simulation steps up to
 * 200 players plus vehicles and projectiles 30×/s inside a sandboxed isolate,
 * so hot paths must not create garbage. Vectors are passed as loose scalars
 * (x, y, z) rather than objects.
 *
 * World space: X = east, Y = up, Z = north. Units are metres, seconds,
 * radians. Yaw 0 faces +Z and increases toward +X (Babylon's convention),
 * so forward = (sin(yaw), 0, cos(yaw)).
 */

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  return angleDelta(0, a);
}

/** Move `from` toward `to` by at most `maxStep` radians (shortest arc). */
export function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (d > maxStep) return wrapAngle(from + maxStep);
  if (d < -maxStep) return wrapAngle(from - maxStep);
  return wrapAngle(to);
}

/** Move `from` toward `to` by at most `maxStep`. */
export function approach(from, to, maxStep) {
  const d = to - from;
  if (d > maxStep) return from + maxStep;
  if (d < -maxStep) return from - maxStep;
  return to;
}

export function length2(x, z) {
  return Math.sqrt(x * x + z * z);
}

export function length3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function distSq3(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/** Round to `dp` decimals — used to quantize network payloads. */
export function q(value, dp = 2) {
  const m = dp === 2 ? 100 : Math.pow(10, dp);
  return Math.round(value * m) / m;
}

/**
 * Exponential smoothing that is stable at any timestep.
 * `rate` is the fraction of the remaining distance covered per second.
 */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
