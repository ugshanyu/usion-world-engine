/**
 * Rollers — balls that spawn on a schedule and tumble down the level
 * (Rapier backend only, simulated on the server and interpolated on phones).
 *
 * Spec (from the world manifest):
 *   { id, x, y, z, radius?, every?, first?, life?, max?, vx?, vy?, vz? }
 *     every  — seconds between balls (default 3)
 *     first  — world time of the first ball (default 0)
 *     life   — seconds before a ball is removed (default 12)
 *     max    — cap on live balls from this spawner (default 6)
 *     v*     — launch velocity
 *
 * Spawning is a pure function of world time, so a restarted room produces
 * the same balls at the same moments.
 */
import { q } from './math.js';

export function createRollers(world) {
  const physics = world.physics;
  const spawners = (world.manifest.rollers || []).map((spec) => ({
    spec,
    every: Math.max(0.25, spec.every ?? 3),
    first: spec.first ?? 0,
    life: spec.life ?? 12,
    max: spec.max ?? 6,
    radius: spec.radius ?? 1.2,
    lastIndex: -1,
    live: [],          // [{id, until}]
  }));

  function preStep(sim) {
    const t = sim.state.t;
    for (const sp of spawners) {
      if (t < sp.first) continue;
      const index = Math.floor((t - sp.first) / sp.every);
      if (index <= sp.lastIndex) continue;
      sp.lastIndex = index;
      if (sp.live.length >= sp.max) continue;
      const s = sp.spec;
      const id = s.id + '_' + index;
      physics.addRoller(id, s.x, s.y ?? 0, s.z, sp.radius, s.vx || 0, s.vy || 0, s.vz || 0);
      sp.live.push({ id, until: t + sp.life });
      sim.emit({ e: 'roll', id, x: q(s.x), y: q(s.z) });
    }
  }

  function postStep(sim) {
    const t = sim.state.t;
    const killY = world.killY;
    for (const sp of spawners) {
      for (let i = sp.live.length - 1; i >= 0; i--) {
        const ball = sp.live[i];
        const roller = physics.rollers.get(ball.id);
        const y = roller ? roller.body.translation().y : -Infinity;
        if (t < ball.until && y > killY) continue;
        physics.removeRoller(ball.id);
        sp.live.splice(i, 1);
      }
    }
  }

  /** Project live balls as network entities: k 'o', x/y on the ground plane, h height. */
  function project(out) {
    for (const roller of physics.rollers.values()) {
      const p = roller.body.translation();
      out[roller.id] = { k: 'o', x: q(p.x), y: q(p.z), h: q(p.y), r: roller.r };
    }
  }

  return { preStep, postStep, project, spawners };
}
