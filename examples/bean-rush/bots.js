/**
 * Bean Rush bots — fill empty seats so a race always feels busy.
 *
 * A bot follows the course's waypoint line (always "the first waypoint ahead
 * of me", so respawning at a checkpoint needs no bookkeeping), jumps the gaps,
 * waits for moving platforms, hops over spinning bars now and then — and
 * makes mistakes in proportion to its skill: it wobbles, mistimes jumps,
 * hesitates. Everything random comes from the simulation's seeded rng, so a
 * room is reproducible.
 *
 * Bots are ordinary simulation players fed input without a `seq`, which the
 * simulation applies immediately (no queue, no prediction).
 */
const NAMES = ['Jelly', 'Gummy', 'Sprinkle', 'Toffee', 'Marsh', 'Fizz', 'Bonbon', 'Mochi', 'Truffle', 'Pudding', 'Taffy', 'Nougat'];

export function isBot(id) {
  return typeof id === 'string' && id.startsWith('bot-');
}

export function createBotBrain(course, rng) {
  const waypoints = course.game.waypoints;
  const minds = new Map();          // bot id → {skill, wobble, hesitateUntil, jumpError, waitSince}
  let named = 0;

  function nextName() {
    const name = NAMES[named % NAMES.length];
    named += 1;
    return name;
  }

  function mind(p) {
    let m = minds.get(p.id);
    if (!m) {
      m = {
        skill: 0.55 + rng() * 0.4,        // 0.55 (clumsy) … 0.95 (sharp)
        wobble: rng() * 6.28,
        hesitateUntil: 0,
        jumpError: 0,
        waitSince: -1,
        lastWp: -1,
      };
      minds.set(p.id, m);
    }
    return m;
  }

  function forget(id) { minds.delete(id); }

  /** The waypoint this bot should head for: the first one clearly ahead of it. */
  function nextWaypoint(p) {
    for (let i = 0; i < waypoints.length; i++) {
      if (waypoints[i].z > p.z + 0.6) return i;
    }
    return waypoints.length - 1;
  }

  /**
   * This tick's input for one bot.
   * @param {object} sim  simulation api
   * @param {object} p    the bot's player
   */
  function think(sim, p) {
    const out = { mx: 0, mz: 0, jump: false, dive: false, sprint: false };
    if (p.locked || p.finished) return out;
    const t = sim.state.t;
    const m = mind(p);
    if (t < m.hesitateUntil) return out;

    const index = nextWaypoint(p);
    const wp = waypoints[index];
    if (index !== m.lastWp) {
      m.lastWp = index;
      m.waitSince = -1;
      m.go = false;
      // A fresh mistake for every jump: early or late by up to ~0.45 m.
      m.jumpError = (rng() - 0.5) * 0.9 * (1 - m.skill);
      // Clumsy bots sometimes freeze for a moment.
      if (rng() < 0.08 * (1 - m.skill)) m.hesitateUntil = t + 0.3 + rng() * 0.7;
    }

    let dx = wp.x - p.x;
    let dz = wp.z - p.z;
    const edge = dz;                 // distance to the waypoint itself (jump timing)
    // When standing on a moving platform, steer for its middle so we stay on.
    if (wp.ride && p.rideId === wp.ride) {
      const plat = sim.world.moverById.get(wp.ride);
      if (plat) dx = plat.solid.x - p.x;
    }

    // Moving platform ahead: wait a few steps back, then commit to a run-up
    // and jump when the platform will be under us on landing.
    if (wp.wait && !m.go) {
      const plat = sim.world.moverById.get(wp.wait);
      if (plat && edge < 3) {
        if (m.waitSince < 0) m.waitSince = t;
        const lead = 0.45 + edge / 7.5;                  // run-up + flight time
        const landX = plat.solid.x + plat.vx * lead;
        const lined = Math.abs(landX - p.x) < (wp.within || 1.5) + (1 - m.skill) * 1.5;
        const impatient = t - m.waitSince > 6;           // never stand forever
        if (!lined && !impatient) return out;
        m.go = true;
      }
    }
    if (wp.wait && m.go) {
      // Run at the platform's middle (several metres ahead), nudging sideways
      // toward where it will be — a mostly-sideways run gives a feeble jump.
      const plat = sim.world.moverById.get(wp.wait);
      if (plat) {
        dz = plat.solid.z - p.z;
        dx = Math.max(-2, Math.min(2, plat.solid.x + plat.vx * 0.45 - p.x));
      }
    }

    // Sidestep a ball rolling at us.
    if (sim.rollers && rng() < 0.6 * m.skill) {
      for (const roller of sim.world.physics.rollers.values()) {
        const b = roller.body.translation();
        const ahead = b.z - p.z;
        if (ahead > 0 && ahead < 9 && Math.abs(b.x - p.x) < roller.r + 1.2) {
          dx = (p.x >= b.x ? 1 : -1) * 6;               // hard sideways
          break;
        }
      }
    }

    const len = Math.hypot(dx, dz) || 1;
    m.wobble += 0.05 + rng() * 0.05;
    const sway = Math.sin(m.wobble) * 0.35 * (1 - m.skill);
    out.mx = dx / len + sway;
    out.mz = dz / len;
    const l2 = Math.hypot(out.mx, out.mz) || 1;
    out.mx /= l2;
    out.mz /= l2;
    out.sprint = m.skill > 0.62 || !!wp.jump;           // steady: toggling it every tick halves the speed

    // Take off a little before the edge (a waypoint stops being "ahead" 0.6 m
    // before it is reached, so the window must open earlier than that).
    if (wp.jump && edge < 1.3 + m.jumpError) out.jump = true;

    // Hop a spinning or swinging bar that is about to reach us. Sharp bots
    // see it in time almost always; clumsy ones often do not.
    if (!out.jump && p.grounded && rng() < 0.35 * m.skill) {
      for (const mv of sim.world.movers) {
        if (mv.rideable || (mv.kind !== 'spinner' && mv.kind !== 'sweeper')) continue;
        if (distanceToBar(mv.solid, p.x, p.z) < 1.3) { out.jump = true; break; }
      }
    }
    // A celebratory dive at the finish line.
    if (index === waypoints.length - 1 && edge < 3 && rng() < 0.1) out.dive = true;
    return out;
  }

  return { think, forget, nextName };
}

/** Ground-plane distance from a point to a bar (a yawed box's long axis). */
function distanceToBar(s, x, z) {
  const dx = x - s.x;
  const dz = z - s.z;
  // Local axes (collision.js convention): along = (cos, -sin) in world X/Z.
  const along = dx * s.cos - dz * s.sin;
  const across = dx * s.sin + dz * s.cos;
  const over = Math.max(0, Math.abs(along) - s.hx);
  return Math.hypot(over, Math.max(0, Math.abs(across) - s.hz));
}
