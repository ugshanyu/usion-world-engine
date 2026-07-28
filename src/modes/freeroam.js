/**
 * Free roam — the sandbox: no timer, no objective, everyone alive.
 *
 * It is also the smallest possible example of the mode contract:
 *
 *   { id, name, config?, init?, onJoin?, onLeave?, onSpawn?, onDeath?,
 *     onDamage?, onCheckpoint?, onPickup?, preTick?, onTick?,
 *     blockRespawn?, projectState? }
 *
 * Every hook receives the simulation api as its first argument, so a mode can
 * read `sim.players`, score them, spawn vehicles, or end the match — without
 * ever touching the physics.
 *
 * `projectState()` is replicated to every client in the global entity. Return
 * CODES, never sentences: clients localize `phase` themselves.
 */
export function freeroamMode(options = {}) {
  return {
    id: 'freeroam',
    name: options.name || 'Free roam',
    config: { respawnDelay: 3, friendlyFire: true, ...(options.config || {}) },

    onDeath(sim, victim, killer) {
      if (killer) killer.score += 1;
    },

    projectState() {
      return { phase: 'open' };
    },
  };
}
