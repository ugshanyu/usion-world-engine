/**
 * Race — checkpoint circuits through the world, on wheels or on foot.
 *
 * Built for drop-in worlds: a race starts on a schedule, everyone present is
 * entered automatically (no lobby, no ready-up), latecomers join the NEXT
 * one, and finishing order is scored live so the HUD can show your position
 * without a second round trip.
 *
 * Requires `checkpoints` in the world manifest, ordered by `order`.
 */
export function raceMode(options = {}) {
  const laps = options.laps ?? 2;
  const countdown = options.countdown ?? 8;
  const raceSeconds = options.raceSeconds ?? 300;
  const intermission = options.intermission ?? 25;
  const points = options.points || [10, 7, 5, 3, 2, 1];

  return {
    id: 'race',
    name: options.name || 'Race',
    config: { respawnDelay: 3, ...(options.config || {}) },

    init(sim) {
      sim.state.mode = {
        phase: 'countdown',
        startsAt: sim.state.t + countdown,
        endsAt: 0,
        laps,
        results: [],
        race: 1,
      };
    },

    onJoin(sim, p) {
      p.racing = false;
      p.finishTime = 0;
      p.nextCp = 0;
      p.lap = 0;
    },

    onCheckpoint(sim, p, cp) {
      const m = sim.state.mode;
      if (m.phase !== 'racing' || !p.racing || p.finishTime) return;
      if (p.lap < m.laps) return;
      p.finishTime = sim.state.t - (m.startsAt || sim.state.t);
      p.racing = false;
      const place = m.results.length + 1;
      m.results.push({ id: p.id, n: p.name, t: Math.round(p.finishTime * 100) / 100, place });
      p.score += points[place - 1] || 1;
      sim.emit({ e: 'finish', p: p.id, pl: place, t: Math.round(p.finishTime * 10) / 10 });
      if (place === 1) m.endsAt = Math.min(m.endsAt, sim.state.t + (options.finishGrace ?? 45));
      void cp;
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      if (m.phase === 'countdown') {
        if (t < m.startsAt) return;
        m.phase = 'racing';
        m.endsAt = t + raceSeconds;
        m.results = [];
        for (const p of sim.players) startRacer(sim, p);
        sim.emit({ e: 'racestart', n: m.race });
        return;
      }
      if (m.phase === 'racing') {
        const stillRacing = sim.players.some(p => p.racing);
        if (t >= m.endsAt || (!stillRacing && sim.players.length > 0)) {
          m.phase = 'results';
          m.endsAt = t + intermission;
          for (const p of sim.players) p.racing = false;
          sim.emit({ e: 'raceend', w: m.results[0] ? m.results[0].id : null });
        }
        return;
      }
      if (t < m.endsAt) return;
      m.phase = 'countdown';
      m.race += 1;
      m.startsAt = t + countdown;
      m.results = [];
      for (const p of sim.players) {
        p.finishTime = 0;
        p.nextCp = 0;
        p.lap = 0;
      }
      sim.emit({ e: 'racereset', n: m.race });
    },

    projectState(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      return {
        phase: m.phase,
        race: m.race,
        laps: m.laps,
        left: Math.max(0, Math.round((m.phase === 'countdown' ? m.startsAt : m.endsAt) - t)),
        results: m.results.slice(0, 5),
        running: sim.players.filter(p => p.racing).length,
      };
    },

    /** Live position: further round the circuit wins, ties broken by distance. */
    positionOf(sim, player) {
      const list = sim.players.filter(p => p.racing || p.finishTime);
      list.sort((a, b) => {
        if (a.finishTime && b.finishTime) return a.finishTime - b.finishTime;
        if (a.finishTime) return -1;
        if (b.finishTime) return 1;
        return b.nextCp - a.nextCp;
      });
      return list.indexOf(player) + 1;
    },
  };

  function startRacer(sim, p) {
    p.racing = true;
    p.finishTime = 0;
    p.nextCp = 0;
    p.lap = 0;
    const grid = sim.world.spawns.filter(s => s.tag === 'grid');
    if (grid.length) {
      const slot = grid[sim.players.indexOf(p) % grid.length];
      sim.teleportPlayer(p, slot);
    }
  }
}
