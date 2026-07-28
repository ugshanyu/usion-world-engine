/**
 * Area-of-interest grid.
 *
 * At world scale you never broadcast the whole world: each player receives
 * only what is near them, so bytes-per-client stay flat as the population
 * grows. This is the same idea as the SDK's `Usion.netcode.createInterestGrid`
 * and the platform rooms runtime's built-in AOI, reimplemented here so the
 * engine core keeps zero dependencies and runs unchanged in a sandbox.
 *
 * Coordinates are the ground plane (world X and Z).
 */
export function createInterestGrid(options = {}) {
  const cellSize = options.cellSize || 64;
  const cells = new Map();          // cellKey → Set(entityId)
  const positions = new Map();      // entityId → {x, z, key}
  const observers = new Map();      // observerId → Set(visible entity ids)

  const key = (cx, cz) => cx + '|' + cz;

  function upsert(id, x, z) {
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    const k = key(cx, cz);
    const prev = positions.get(id);
    if (prev) {
      prev.x = x; prev.z = z;
      if (prev.key === k) return;
      const bucket = cells.get(prev.key);
      if (bucket) { bucket.delete(id); if (!bucket.size) cells.delete(prev.key); }
      prev.key = k;
    } else {
      positions.set(id, { x, z, key: k });
    }
    let bucket = cells.get(k);
    if (!bucket) cells.set(k, (bucket = new Set()));
    bucket.add(id);
  }

  function remove(id) {
    const prev = positions.get(id);
    if (!prev) return;
    const bucket = cells.get(prev.key);
    if (bucket) { bucket.delete(id); if (!bucket.size) cells.delete(prev.key); }
    positions.delete(id);
  }

  /** Stateless circle query — every entity id within `radius` of (x, z). */
  function query(x, z, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    const cx0 = Math.floor((x - radius) / cellSize);
    const cx1 = Math.floor((x + radius) / cellSize);
    const cz0 = Math.floor((z - radius) / cellSize);
    const cz1 = Math.floor((z + radius) / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = cells.get(key(cx, cz));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = positions.get(id);
          if (!p) continue;
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * Per-observer diffed query: what entered and left this observer's view
   * since its previous `observe()` call, plus everything currently visible.
   */
  function observe(observerId, x, z, radius) {
    const visible = query(x, z, radius);
    const previous = observers.get(observerId) || new Set();
    const now = new Set(visible);
    const entered = [];
    const left = [];
    for (const id of now) if (!previous.has(id)) entered.push(id);
    for (const id of previous) if (!now.has(id)) left.push(id);
    observers.set(observerId, now);
    return { entered, left, visible };
  }

  function dropObserver(observerId) {
    observers.delete(observerId);
  }

  return {
    cellSize,
    upsert,
    remove,
    query,
    observe,
    dropObserver,
    get size() { return positions.size; },
  };
}
