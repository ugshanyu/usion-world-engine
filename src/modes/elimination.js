/**
 * Elimination — the Fall Guys shape: a show of short rounds where a fixed
 * share of the field qualifies and the rest are knocked out, until one
 * contestant is left.
 *
 * Qualifying means reaching a zone tagged `kind: 'goal'` in the world
 * manifest (or crossing the last checkpoint, if the world has a course).
 * Knocked-out players keep playing in the world as spectators — being out of
 * the show should not mean staring at a lock screen — they simply cannot
 * qualify until the next show starts.
 */
export function eliminationMode(options = {}) {
  const roundSeconds = options.roundSeconds ?? 120;
  const countdown = options.countdown ?? 10;
  const intermission = options.intermission ?? 20;
  const qualifyFraction = options.qualifyFraction ?? 0.6;
  const minContestants = options.minContestants ?? 2;
  const maxRounds = options.maxRounds ?? 4;

  return {
    id: 'elimination',
    name: options.name || 'Elimination',
    config: { respawnDelay: 2.5, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = {
        phase: 'countdown',
        show: 1,
        round: 1,
        endsAt: sim.state.t + countdown,
        quota: 0,
        qualified: 0,
        contestants: 0,
        winner: null,
      };
    },

    onJoin(sim, p) {
      // Latecomers watch this show and enter the next one.
      p.elim = sim.state.mode.phase !== 'countdown';
      p.qualified = false;
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;

      if (m.phase === 'countdown') {
        if (t < m.endsAt) return;
        beginRound(sim);
        return;
      }

      if (m.phase === 'live') {
        checkGoals(sim);
        const contestants = sim.players.filter(p => !p.elim);
        if (m.qualified >= m.quota || t >= m.endsAt || contestants.length === 0) endRound(sim);
        return;
      }

      if (t < m.endsAt) return;
      if (m.phase === 'roundend') {
        const remaining = sim.players.filter(p => !p.elim);
        if (remaining.length <= 1 || m.round >= maxRounds) {
          m.phase = 'showover';
          m.winner = remaining[0] ? { id: remaining[0].id, n: remaining[0].name } : null;
          m.endsAt = t + intermission;
          if (remaining[0]) remaining[0].score += 25;
          sim.emit({ e: 'showover', w: remaining[0] ? remaining[0].id : null });
          return;
        }
        m.round += 1;
        m.phase = 'countdown';
        m.endsAt = t + countdown;
        sim.emit({ e: 'roundnext', n: m.round });
        return;
      }
      // showover → start a fresh show with everyone present
      m.show += 1;
      m.round = 1;
      m.phase = 'countdown';
      m.winner = null;
      m.endsAt = t + countdown;
      for (const p of sim.players) { p.elim = false; p.qualified = false; p.score = 0; }
      sim.emit({ e: 'shownext', n: m.show });
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        show: m.show,
        round: m.round,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        quota: m.quota,
        qualified: m.qualified,
        contestants: m.contestants,
        winner: m.winner,
      };
    },
  };

  function beginRound(sim) {
    const m = sim.state.mode;
    const contestants = sim.players.filter(p => !p.elim);
    m.phase = 'live';
    m.contestants = contestants.length;
    m.quota = Math.max(1, Math.min(contestants.length - 1, Math.round(contestants.length * qualifyFraction)));
    if (contestants.length < minContestants) m.quota = contestants.length;
    m.qualified = 0;
    m.endsAt = sim.state.t + roundSeconds;
    for (const p of contestants) {
      p.qualified = false;
      p.nextCp = 0;
      p.lap = 0;
      const spawn = sim.world.pickSpawn(null, 'start', sim.rng);
      if (spawn) {
        p.x = spawn.x; p.y = spawn.y; p.z = spawn.z; p.yaw = spawn.yaw || 0;
        p.vx = 0; p.vy = 0; p.vz = 0;
        p.hp = p.maxHp;
        p.deadUntil = 0;
      }
    }
    sim.emit({ e: 'roundstart', n: m.round, q: m.quota });
  }

  function checkGoals(sim) {
    const m = sim.state.mode;
    const goals = sim.world.zones.filter(z => z.kind === 'goal');
    if (!goals.length) return;
    for (const p of sim.players) {
      if (p.elim || p.qualified || p.hp <= 0) continue;
      const inGoal = goals.some(z => sim.world.zoneContains(z, p.x, p.z));
      if (!inGoal) continue;
      p.qualified = true;
      m.qualified += 1;
      p.score += Math.max(1, m.quota - m.qualified + 1) * 2;
      sim.emit({ e: 'qualify', p: p.id, n: m.qualified });
    }
  }

  function endRound(sim) {
    const m = sim.state.mode;
    let out = 0;
    for (const p of sim.players) {
      if (p.elim) continue;
      if (p.qualified) continue;
      p.elim = true;
      out += 1;
    }
    m.phase = 'roundend';
    m.endsAt = sim.state.t + 6;
    sim.emit({ e: 'roundover', n: m.round, out });
  }
}
