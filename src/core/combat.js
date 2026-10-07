/**
 * Weapons, damage and projectiles.
 *
 * Shooting is server-authoritative: a client sends "I fired, aiming here" and
 * the server does every trace, so a modified client cannot invent hits. Aim
 * direction is the one thing we take from the client (it is a view property),
 * and it is normalised and range-clamped before use.
 *
 * Hitscan traces run against the static world, players and vehicles; the
 * nearest blocker wins, so you cannot shoot through a building.
 */
import { clamp } from './math.js';
import { CHARACTER } from './character.js';
import { getSpec } from './vehicle.js';

/**
 * Built-in weapons. `kind` is 'hitscan' | 'projectile' | 'melee'.
 * `rpm` is rounds per minute; `spread` is the cone half-angle in radians.
 */
export const WEAPONS = {
  shove: {
    name: 'shove', kind: 'melee', damage: 8, range: 2.6, rpm: 90,
    knockback: 13, stun: 0.8, ammo: Infinity, reload: 0, arc: 0.9,
  },
  pistol: {
    name: 'pistol', kind: 'hitscan', damage: 20, range: 90, rpm: 300,
    spread: 0.012, pellets: 1, ammo: 12, reload: 1.4, knockback: 1.5, falloff: 0.45,
  },
  smg: {
    name: 'smg', kind: 'hitscan', damage: 12, range: 65, rpm: 780,
    spread: 0.045, pellets: 1, ammo: 30, reload: 1.8, knockback: 1, falloff: 0.55,
  },
  shotgun: {
    name: 'shotgun', kind: 'hitscan', damage: 9, range: 32, rpm: 75,
    spread: 0.13, pellets: 8, ammo: 6, reload: 2.4, knockback: 6, falloff: 0.75,
  },
  rifle: {
    name: 'rifle', kind: 'hitscan', damage: 28, range: 150, rpm: 400,
    spread: 0.01, pellets: 1, ammo: 25, reload: 2.1, knockback: 2, falloff: 0.25,
  },
  rocket: {
    name: 'rocket', kind: 'projectile', damage: 85, range: 200, rpm: 45,
    speed: 42, splash: 7, splashDamage: 60, ammo: 3, reload: 3.2,
    knockback: 22, gravity: 2,
  },
};

export function getWeapon(name) {
  return WEAPONS[name] || WEAPONS.shove;
}

/** Fresh loadout for a spawning player. */
export function resetLoadout(p, weapons = ['shove']) {
  p.weapons = weapons.slice();
  p.weapon = weapons[0];
  p.ammo = {};
  for (const name of weapons) {
    const w = getWeapon(name);
    p.ammo[name] = w.ammo === Infinity ? -1 : w.ammo;
  }
  p.nextFire = 0;
  p.reloadUntil = 0;
  return p;
}

export function giveWeapon(p, name, ammo) {
  const w = getWeapon(name);
  if (!p.weapons) resetLoadout(p, [name]);
  if (p.weapons.indexOf(name) === -1) p.weapons.push(name);
  const cap = w.ammo === Infinity ? -1 : w.ammo;
  p.ammo[name] = cap === -1 ? -1 : Math.min(cap, (p.ammo[name] > 0 ? p.ammo[name] : 0) + (ammo ?? cap));
  p.weapon = name;
  return p;
}

/** Can this player pull the trigger right now? */
export function canFire(p, now) {
  if (!p.weapons || p.hp <= 0 || p.stunT > 0) return false;
  if (now < p.nextFire || now < p.reloadUntil) return false;
  const ammo = p.ammo[p.weapon];
  return ammo === -1 || ammo > 0;
}

/**
 * Ray vs vertical capsule (a standing player). Returns entry distance or -1.
 * Solves the closest-approach of the ray to the capsule's core segment.
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, cx, cy0, cz, cy1, radius, maxT) {
  // The capsule axis is vertical, so this reduces to a 2D circle test in XZ
  // plus a height check at the hit — accurate enough for 0.4 m capsules and
  // far cheaper than the general segment-segment form.
  const mx = ox - cx;
  const mz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - radius * radius;
  if (a < 1e-9) {
    if (c > 0) return -1;
    // Straight down/up the axis: hit the cap we reach first.
    const t = dy > 0 ? (cy0 - oy) / dy : (cy1 - oy) / dy;
    return t >= 0 && t <= maxT ? t : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  const hy = oy + dy * t;
  if (hy >= cy0 - radius && hy <= cy1 + radius) return t;
  // Clip against the cap planes when the ray enters above/below the body.
  if (Math.abs(dy) < 1e-9) return -1;
  const tTop = (cy1 - oy) / dy;
  const tBot = (cy0 - oy) / dy;
  for (const tc of [tTop, tBot]) {
    if (tc < 0 || tc > maxT) continue;
    const px = ox + dx * tc - cx;
    const pz = oz + dz * tc - cz;
    if (px * px + pz * pz <= radius * radius) return tc;
  }
  return -1;
}

/** Ray vs a vehicle body, approximated by two spheres along the chassis. */
export function rayVehicle(v, ox, oy, oz, dx, dy, dz, maxT) {
  const spec = getSpec(v.kind);
  const r = Math.max(spec.halfWidth, spec.halfLength * 0.55);
  const fx = Math.sin(v.yaw);
  const fz = Math.cos(v.yaw);
  let best = -1;
  for (let i = -1; i <= 1; i += 2) {
    const cx = v.x + fx * (spec.halfLength - r) * i;
    const cy = v.y + spec.height * 0.5;
    const cz = v.z + fz * (spec.halfLength - r) * i;
    const t = raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - 4 * c;      // direction is unit length, so a = 1
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / 2;
  if (t < 0) t = (-b + sq) / 2;
  return (t >= 0 && t <= maxT) ? t : -1;
}

/**
 * Trace one shot through the world.
 *
 * `ctx` provides `collision`, `players` (array), `vehicles` (array) and the
 * shooter id to skip. Returns the closest hit as
 * `{kind:'player'|'vehicle'|'world', id, t, x, y, z}` or null.
 */
export function traceShot(ctx, shooterId, ox, oy, oz, dx, dy, dz, maxT) {
  let bestT = maxT;
  let hit = null;

  const wall = ctx.collision.raycast(ox, oy, oz, dx, dy, dz, maxT);
  if (wall) {
    bestT = wall.t;
    hit = { kind: 'world', id: null, t: wall.t, x: wall.x, y: wall.y, z: wall.z };
  }

  const players = ctx.players || [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.id === shooterId || p.hp <= 0 || p.veh) continue;
    const t = rayCapsule(
      ox, oy, oz, dx, dy, dz,
      p.x, p.y + CHARACTER.radius, p.z, p.y + CHARACTER.height - CHARACTER.radius,
      CHARACTER.radius * 1.15, bestT,
    );
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    hit = { kind: 'player', id: p.id, t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, target: p };
  }

  const vehicles = ctx.vehicles || [];
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (v.id === ctx.ignoreVehicle) continue;
    const t = rayVehicle(v, ox, oy, oz, dx, dy, dz, bestT);
    if (t < 0 || t >= bestT) continue;
    bestT = t;
    hit = { kind: 'vehicle', id: v.id, t, x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, target: v };
  }

  return hit;
}

/** Muzzle position for a player (eye height, slightly forward). */
export function muzzleOf(p, out) {
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  out.x = p.x + fx * 0.35;
  out.y = p.y + CHARACTER.eyeHeight;
  out.z = p.z + fz * 0.35;
  return out;
}

/** Normalise a client-supplied aim vector; falls back to the player's facing. */
export function normalizeAim(p, ax, ay, az, out) {
  let x = Number(ax);
  let y = Number(ay);
  let z = Number(az);
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(len) || len < 1e-4) {
    out.x = Math.sin(p.yaw);
    out.y = 0;
    out.z = Math.cos(p.yaw);
    return out;
  }
  out.x = x / len;
  out.y = clamp(y / len, -0.95, 0.95);
  out.z = z / len;
  const l2 = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  out.x /= l2; out.y /= l2; out.z /= l2;
  return out;
}

/** Damage falloff over distance — full damage up close, `falloff` at max range. */
export function damageAt(weapon, distance) {
  const f = weapon.falloff ?? 0;
  const t = clamp(distance / Math.max(1, weapon.range), 0, 1);
  return weapon.damage * (1 - f * t);
}

/** Step every projectile: move, trace the segment it covered, explode. */
export function stepProjectiles(state, dt, ctx, onHit) {
  const list = state.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    const w = getWeapon(b.weapon);
    b.life -= dt;
    if (b.life <= 0) { list.splice(i, 1); continue; }
    const stepLen = b.speed * dt;
    const hit = traceShot(ctx, b.owner, b.x, b.y, b.z, b.dx, b.dy, b.dz, stepLen);
    b.x += b.dx * stepLen;
    b.y += b.dy * stepLen;
    b.z += b.dz * stepLen;
    if (w.gravity) {
      b.dy -= (w.gravity * dt) / Math.max(1e-3, b.speed);
      const l = Math.sqrt(b.dx * b.dx + b.dy * b.dy + b.dz * b.dz);
      b.dx /= l; b.dy /= l; b.dz /= l;
    }
    if (!hit) continue;
    list.splice(i, 1);
    onHit(b, w, hit);
  }
}
