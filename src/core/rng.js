/**
 * Deterministic RNG.
 *
 * `Math.random()` is banned everywhere the server and client must agree
 * (world generation, hazard layout, spawn shuffling): both sides build the
 * same world from the same seed, so a shared stream is the only way the two
 * stay identical. Gameplay randomness that only the server decides (weapon
 * spread) uses a server-owned stream instead.
 *
 * mulberry32 — 32-bit, fast, well-distributed, and identical in every JS
 * engine because it only uses integer ops that stay inside 2^32.
 */
export function createRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const rng = function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Uniform float in [lo, hi). */
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  /** Uniform integer in [lo, hi]. */
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  /** Pick one element. */
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** True with probability p. */
  rng.chance = (p) => rng() < p;
  return rng;
}

/** Stable 32-bit hash of a string — turns ids/names into seeds. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
