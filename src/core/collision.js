/**
 * Static collision world.
 *
 * The world is built from two convex primitives — yawed **boxes** (buildings,
 * walls, kerbs, crates, platforms) and yawed **ramps** (a box whose top is a
 * slope rising along its local +Z). Everything a GTA-style city needs is one
 * of those two, and keeping the set that small is what lets the same code run
 * in a sandboxed isolate at 30 Hz for 200 players.
 *
 * Solids live in a uniform XZ grid so a query touches a handful of candidates
 * instead of the whole city. Nothing here allocates per query except the
 * candidate array, which callers reuse.
 *
 *   box:  { kind:'box',  x, y, z, hx, hy, hz, ry?, tag? }   // centre + half-extents
 *   ramp: { kind:'ramp', x, y, z, hx, hy, hz, ry?, tag? }   // top rises along local +Z
 *
 * `y` is the CENTRE height. Use `boxAt`/`rampAt` if you'd rather think in
 * "sits on the ground and is N tall".
 *
 * The same primitives back the moving hazards (see movers.js): a mover is a
 * prepared solid whose transform is recomputed from server time each step.
 */
import { clamp } from './math.js';

const EPS = 1e-6;

/** Build a ground-anchored box: base at `y`, `w`×`d` footprint, `h` tall. */
export function boxAt(x, y, z, w, h, d, ry = 0, tag) {
  return { kind: 'box', x, y: y + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, ry, tag };
}

/** Build a ground-anchored ramp rising along its local +Z. */
export function rampAt(x, y, z, w, h, d, ry = 0, tag) {
  return { kind: 'ramp', x, y: y + h / 2, z, hx: w / 2, hy: h / 2, hz: d / 2, ry, tag };
}

/** Turn a solid description into the cached form every query below expects. */
export function prepareSolid(solid) {
  const s = {
    kind: solid.kind || 'box',
    x: solid.x, y: solid.y, z: solid.z,
    hx: solid.hx, hy: solid.hy, hz: solid.hz,
    ry: solid.ry || 0,
    cos: 1, sin: 0,
    tag: solid.tag,
    solid: solid.solid !== false,
    k: (solid.kind === 'ramp') ? solid.hy / solid.hz : 0,
    minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0,
  };
  refreshSolid(s);
  return s;
}

/** Recompute the cached rotation + world AABB after a mover has moved. */
export function refreshSolid(s) {
  s.cos = Math.cos(s.ry);
  s.sin = Math.sin(s.ry);
  const ex = s.hx * Math.abs(s.cos) + s.hz * Math.abs(s.sin);
  const ez = s.hx * Math.abs(s.sin) + s.hz * Math.abs(s.cos);
  s.minX = s.x - ex; s.maxX = s.x + ex;
  s.minZ = s.z - ez; s.maxZ = s.z + ez;
  s.minY = s.y - s.hy; s.maxY = s.y + s.hy;
  return s;
}

/** world → solid-local (yaw only; Y is never rotated). */
export function toLocalX(s, dx, dz) { return dx * s.cos - dz * s.sin; }
export function toLocalZ(s, dx, dz) { return dx * s.sin + dz * s.cos; }
/** solid-local → world. */
export function toWorldX(s, lx, lz) { return lx * s.cos + lz * s.sin; }
export function toWorldZ(s, lx, lz) { return -lx * s.sin + lz * s.cos; }

/** Local top surface height at a local Z (ramps slope, boxes are flat). */
function localTop(s, lz) {
  if (s.kind !== 'ramp') return s.hy;
  return -s.hy + (clamp(lz, -s.hz, s.hz) + s.hz) * s.k;
}

/**
 * World-space top surface height of a solid at (x, z), or null when the point
 * is outside its footprint (`radius` widens the footprint test).
 */
export function solidTopAt(s, x, z, radius = 0) {
  const lx = toLocalX(s, x - s.x, z - s.z);
  const lz = toLocalZ(s, x - s.x, z - s.z);
  if (lx < -s.hx - radius || lx > s.hx + radius) return null;
  if (lz < -s.hz - radius || lz > s.hz + radius) return null;
  return s.y + localTop(s, lz);
}

/** Slope of a solid's surface at a local Z — 1 on flats, < 1 on ramps. */
export function solidNormalY(s) {
  return s.kind === 'ramp' ? 1 / Math.sqrt(1 + s.k * s.k) : 1;
}

/**
 * Depenetrate a sphere from ONE solid, accumulating the correction into
 * `out` (`{x, y, z, hit}`). Returns true when the sphere overlapped.
 */
export function depenetrateSphere(s, px, py, pz, r, out) {
  if (!s.solid) return false;
  if (py - r > s.maxY || py + r < s.minY) return false;
  const dx = px - s.x;
  const dz = pz - s.z;
  const ly = py - s.y;
  const lx = toLocalX(s, dx, dz);
  const lz = toLocalZ(s, dx, dz);

  const top = localTop(s, lz);
  const cx = clamp(lx, -s.hx, s.hx);
  const cz = clamp(lz, -s.hz, s.hz);
  const cy = clamp(ly, -s.hy, top);
  let nx = lx - cx;
  let ny = ly - cy;
  let nz = lz - cz;
  const d2 = nx * nx + ny * ny + nz * nz;
  if (d2 > r * r) return false;

  if (d2 > EPS) {
    const d = Math.sqrt(d2);
    const pen = r - d;
    nx = (nx / d) * pen;
    ny = (ny / d) * pen;
    nz = (nz / d) * pen;
  } else {
    // Centre is inside the solid: escape along the cheapest face. For ramps
    // the slope face is a candidate too, and usually the right one — it is
    // the surface you walk and drive on.
    const facePX = s.hx - lx, faceNX = lx + s.hx;
    const facePZ = s.hz - lz, faceNZ = lz + s.hz;
    const faceBottom = ly + s.hy;
    let best = facePX, axis = 0;
    if (faceNX < best) { best = faceNX; axis = 1; }
    if (facePZ < best) { best = facePZ; axis = 2; }
    if (faceNZ < best) { best = faceNZ; axis = 3; }
    if (faceBottom < best) { best = faceBottom; axis = 4; }
    if (s.kind === 'ramp') {
      const inv = 1 / Math.sqrt(1 + s.k * s.k);
      const slopePen = (top - ly) * inv;
      if (slopePen < best) {
        const move = slopePen + r;
        out.x += toWorldX(s, 0, -move * s.k * inv);
        out.y += move * inv;
        out.z += toWorldZ(s, 0, -move * s.k * inv);
        out.hit = true;
        return true;
      }
    } else if (top - ly < best) {
      best = top - ly; axis = 5;
    }
    nx = 0; ny = 0; nz = 0;
    if (axis === 0) nx = best + r;
    else if (axis === 1) nx = -(best + r);
    else if (axis === 2) nz = best + r;
    else if (axis === 3) nz = -(best + r);
    else if (axis === 4) ny = -(best + r);
    else ny = best + r;
  }

  out.x += toWorldX(s, nx, nz);
  out.y += ny;
  out.z += toWorldZ(s, nx, nz);
  out.hit = true;
  return true;
}

/**
 * Raycast against ONE solid. Returns the entry distance or -1.
 * On a hit, `out` receives the surface normal (`nx`, `ny`, `nz`).
 */
export function raycastSolid(s, ox, oy, oz, dx, dy, dz, maxT, out) {
  if (!s.solid) return -1;
  const rx = toLocalX(s, ox - s.x, oz - s.z);
  const rz = toLocalZ(s, ox - s.x, oz - s.z);
  const ry0 = oy - s.y;
  const vx = toLocalX(s, dx, dz);
  const vz = toLocalZ(s, dx, dz);

  let t0 = 0;
  let t1 = maxT;
  let axis = -1;
  let sign = 0;

  let r = slab(rx, vx, s.hx, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 0; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  r = slab(rz, vz, s.hz, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 2; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  r = slab(ry0, dy, s.hy, t0, t1);
  if (!r) return -1;
  if (r.t0 > t0) { t0 = r.t0; axis = 1; sign = r.sign; }
  t1 = Math.min(t1, r.t1);

  if (s.kind === 'ramp') {
    // Clip to the half-space below the slope: (y + hy) - k*(z + hz) <= 0
    const c0 = (ry0 + s.hy) - s.k * (rz + s.hz);
    const cv = dy - s.k * vz;
    if (Math.abs(cv) < EPS) {
      if (c0 > 0) return -1;
    } else {
      const tc = -c0 / cv;
      if (cv > 0) {
        if (tc < t1) t1 = tc;
      } else if (tc > t0) {
        t0 = tc; axis = 3; sign = 1;
      }
    }
  }

  if (t0 > t1 || t0 < 0 || t0 > maxT) return -1;

  if (axis === 0) { out.nx = toWorldX(s, sign, 0); out.ny = 0; out.nz = toWorldZ(s, sign, 0); }
  else if (axis === 2) { out.nx = toWorldX(s, 0, sign); out.ny = 0; out.nz = toWorldZ(s, 0, sign); }
  else if (axis === 1) { out.nx = 0; out.ny = sign; out.nz = 0; }
  else {
    const inv = 1 / Math.sqrt(1 + s.k * s.k);
    out.nx = toWorldX(s, 0, -s.k * inv);
    out.ny = inv;
    out.nz = toWorldZ(s, 0, -s.k * inv);
  }
  return t0;
}

const slabResult = { t0: 0, t1: 0, sign: 1 };
function slab(origin, dir, half, t0, t1) {
  if (Math.abs(dir) < EPS) {
    if (origin < -half || origin > half) return null;
    slabResult.t0 = t0; slabResult.t1 = t1; slabResult.sign = 1;
    return slabResult;
  }
  let near = (-half - origin) / dir;
  let far = (half - origin) / dir;
  let sign = dir > 0 ? -1 : 1;
  if (near > far) { const tmp = near; near = far; far = tmp; sign = -sign; }
  if (near > t1 || far < t0) return null;
  slabResult.t0 = near; slabResult.t1 = far; slabResult.sign = sign;
  return slabResult;
}

export function createCollisionWorld(options = {}) {
  const cellSize = options.cellSize || 16;
  const groundY = options.groundY === null ? null : (options.groundY ?? 0);
  const cells = new Map();
  const all = [];

  function add(solid) {
    const s = prepareSolid(solid);
    all.push(s);
    const cx0 = Math.floor(s.minX / cellSize);
    const cx1 = Math.floor(s.maxX / cellSize);
    const cz0 = Math.floor(s.minZ / cellSize);
    const cz1 = Math.floor(s.maxZ / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = cx + '|' + cz;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = []));
        bucket.push(s);
      }
    }
    return s;
  }

  for (const solid of options.solids || []) add(solid);

  /** Candidate solids overlapping an XZ rectangle. Reuses `out`. */
  function query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const cx0 = Math.floor(minX / cellSize);
    const cx1 = Math.floor(maxX / cellSize);
    const cz0 = Math.floor(minZ / cellSize);
    const cz1 = Math.floor(maxZ / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = cells.get(cx + '|' + cz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          if (s.maxX < minX || s.minX > maxX || s.maxZ < minZ || s.minZ > maxZ) continue;
          if (out.indexOf(s) === -1) out.push(s);
        }
      }
    }
    return out;
  }

  const pushOut = { x: 0, y: 0, z: 0, hit: false };
  const scratch = [];

  /**
   * Depenetrate a sphere from the static world. Returns a shared
   * `{x, y, z, hit}` — the correction to ADD to the sphere centre.
   */
  function resolveSphere(px, py, pz, r) {
    pushOut.x = 0; pushOut.y = 0; pushOut.z = 0; pushOut.hit = false;
    const list = query(px - r, pz - r, px + r, pz + r, scratch);
    for (let i = 0; i < list.length; i++) {
      depenetrateSphere(list[i], px + pushOut.x, py + pushOut.y, pz + pushOut.z, r, pushOut);
    }
    return pushOut;
  }

  /**
   * Highest walkable surface at (x, z) at or below `fromY`.
   * `normalY` is 1 on flat tops and less on ramps — the character and the
   * vehicle both use it to decide "too steep to hold".
   *
   * Returns a SHARED object (no allocation in the hot path): read the fields
   * you need before the next call, never hold on to it.
   */
  const groundHit = { y: 0, normalY: 1, solid: null, slopeX: 0, slopeZ: 0 };
  function sampleGround(x, z, fromY, radius = 0) {
    groundHit.y = groundY === null ? -Infinity : groundY;
    groundHit.normalY = 1;
    groundHit.slopeX = 0;
    groundHit.slopeZ = 0;
    groundHit.solid = null;
    const list = query(x - radius, z - radius, x + radius, z + radius, scratch);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.solid || s.minY > fromY + 0.05) continue;
      const top = solidTopAt(s, x, z, radius);
      if (top === null || top > fromY + 0.05 || top <= groundHit.y) continue;
      groundHit.y = top;
      groundHit.solid = s;
      if (s.kind === 'ramp') {
        const inv = solidNormalY(s);
        groundHit.normalY = inv;
        groundHit.slopeX = toWorldX(s, 0, -s.k * inv);
        groundHit.slopeZ = toWorldZ(s, 0, -s.k * inv);
      } else {
        groundHit.normalY = 1;
        groundHit.slopeX = 0;
        groundHit.slopeZ = 0;
      }
    }
    return groundHit;
  }

  /**
   * Raycast the static world (bullets, line of sight, camera).
   * Returns a shared `{t, x, y, z, nx, ny, nz, solid}` or null.
   */
  const rayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, solid: null };
  const rayNormal = { nx: 0, ny: 1, nz: 0 };
  function raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let bestT = maxT;
    let bestNX = 0, bestNY = 1, bestNZ = 0, bestSolid = null;
    let hitAny = false;

    if (groundY !== null && dy < -EPS && oy > groundY) {
      const t = (groundY - oy) / dy;
      if (t >= 0 && t < bestT) {
        bestT = t; bestNX = 0; bestNY = 1; bestNZ = 0; bestSolid = null; hitAny = true;
      }
    }

    const minX = Math.min(ox, ox + dx * maxT);
    const maxX = Math.max(ox, ox + dx * maxT);
    const minZ = Math.min(oz, oz + dz * maxT);
    const maxZ = Math.max(oz, oz + dz * maxT);
    const list = query(minX, minZ, maxX, maxZ, scratch);
    for (let i = 0; i < list.length; i++) {
      const t = raycastSolid(list[i], ox, oy, oz, dx, dy, dz, bestT, rayNormal);
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      bestNX = rayNormal.nx; bestNY = rayNormal.ny; bestNZ = rayNormal.nz;
      bestSolid = list[i];
      hitAny = true;
    }

    if (!hitAny) return null;
    rayHit.t = bestT;
    rayHit.x = ox + dx * bestT;
    rayHit.y = oy + dy * bestT;
    rayHit.z = oz + dz * bestT;
    rayHit.nx = bestNX; rayHit.ny = bestNY; rayHit.nz = bestNZ;
    rayHit.solid = bestSolid;
    return rayHit;
  }

  return { cellSize, groundY, solids: all, add, query, resolveSphere, sampleGround, raycast };
}
