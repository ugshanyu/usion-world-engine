/**
 * Deathmatch — rolling rounds of "most kills wins".
 *
 * Written for world rooms: the match never waits for a roster, players drop
 * in and out mid-round, and when the timer expires the scores are announced
 * and everything resets. That is what keeps a 200-player world alive instead
 * of stuck on a lobby screen.
 */
export function deathmatchMode(options = {}) {
  const roundSeconds = options.roundSeconds ?? 300;
  const targetScore = options.targetScore ?? 25;
  const intermission = options.intermission ?? 15;
  const weapons = options.weapons || ['pistol', 'smg'];

  return {
    id: 'deathmatch',
    name: options.name || 'Deathmatch',
    config: { respawnDelay: 4, startWeapons: weapons, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = { phase: 'live', endsAt: sim.state.t + roundSeconds, round: 1, winner: null };
    },

    onJoin(sim, p) {
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
    },

    onDeath(sim, victim, killer) {
      if (!killer) { victim.score = Math.max(0, victim.score - 1); return; }
      killer.score += 1;
      if (sim.state.mode.phase === 'live' && killer.score >= targetScore) endRound(sim, killer);
    },

    blockRespawn(sim) {
      return sim.state.mode.phase !== 'live';
    },

    onTick(sim) {
      const m = sim.state.mode;
      if (m.phase === 'live') {
        if (sim.state.t >= m.endsAt) endRound(sim, leader(sim));
        return;
      }
      if (sim.state.t < m.endsAt) return;
      m.phase = 'live';
      m.round += 1;
      m.winner = null;
      m.endsAt = sim.state.t + roundSeconds;
      for (const p of sim.players) {
        p.score = 0;
        p.kills = 0;
        p.deaths = 0;
        sim.respawnPlayer(p);
      }
      sim.emit({ e: 'round', n: m.round });
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        round: m.round,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        target: targetScore,
        winner: m.winner,
      };
    },
  };

  function leader(sim) {
    let best = null;
    for (const p of sim.players) if (!best || p.score > best.score) best = p;
    return best;
  }

  function endRound(sim, winner) {
    const m = sim.state.mode;
    m.phase = 'over';
    m.winner = winner ? { id: winner.id, n: winner.name, s: Math.round(winner.score) } : null;
    m.endsAt = sim.state.t + intermission;
    sim.emit({ e: 'roundend', w: winner ? winner.id : null });
  }
}
