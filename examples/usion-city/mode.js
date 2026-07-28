/**
 * City Rush — the sample competition built on the Usion World Engine.
 *
 * This file is the *whole game*. The engine owns the city, the physics, the
 * cars, the weapons and the netcode; a creator writes rules like these and
 * nothing else. It is deliberately a composite of the two things the engine
 * is for — GTA-style driving and Fall Guys-style chaos — so it exercises
 * both in one world:
 *
 *   roam      free play: drive, shoot, explore, brawl in the plaza
 *   countdown everyone is placed on the start grid
 *   racing    a checkpoint circuit through the city, on wheels or on foot
 *   results   podium, then straight back to roaming
 *
 * Every value the client shows is a CODE or a number — never an English
 * sentence — so the same world reads correctly in any language.
 */
const ROAM_SECONDS = 90;
const COUNTDOWN_SECONDS = 12;
const RACE_SECONDS = 300;
const RESULTS_SECONDS = 20;
const FINISH_GRACE = 45;
const LAPS = 2;
const POINTS = [12, 9, 7, 5, 4, 3, 2, 1];

export function cityRushMode(options = {}) {
  const laps = options.laps ?? LAPS;

  return {
    id: 'city-rush',
    name: 'City Rush',
    config: {
      respawnDelay: 4,
      startWeapons: ['shove'],
      friendlyFire: true,
      ...(options.config || {}),
    },

    init(sim) {
      sim.state.mode = {
        phase: 'roam',
        endsAt: sim.state.t + ROAM_SECONDS,
        race: 1,
        laps,
        results: [],
        winner: null,
      };
    },

    onJoin(sim, p) {
      p.racing = false;
      p.finishTime = 0;
      p.nextCp = 0;
      p.lap = 0;
      // A newcomer joins the next race rather than the one already running:
      // dropping someone into lap two would be worse than a short wait.
      p.waitingForRace = sim.state.mode.phase === 'racing';
    },

    onDeath(sim, victim, killer) {
      if (killer && sim.state.mode.phase === 'roam') killer.score += 1;
      if (victim.racing) {
        // Dying in a race costs you the position, not the race.
        victim.nextCp = Math.max(0, victim.nextCp - 1);
      }
    },

    onCheckpoint(sim, p) {
      const m = sim.state.mode;
      if (m.phase !== 'racing' || !p.racing || p.finishTime) return;
      if (p.lap < m.laps) return;
      p.finishTime = sim.state.t - m.startedAt;
      p.racing = false;
      const place = m.results.length + 1;
      m.results.push({
        id: p.id, n: p.name, place,
        t: Math.round(p.finishTime * 100) / 100,
      });
      p.score += POINTS[place - 1] || 1;
      sim.emit({ e: 'finish', p: p.id, pl: place, t: Math.round(p.finishTime * 10) / 10 });
      if (place === 1) {
        m.winner = { id: p.id, n: p.name };
        m.endsAt = Math.min(m.endsAt, sim.state.t + FINISH_GRACE);
      }
    },

    onTick(sim) {
      const m = sim.state.mode;
      const t = sim.state.t;
      if (t < m.endsAt && !(m.phase === 'racing' && everyoneFinished(sim))) return;

      if (m.phase === 'roam') {
        m.phase = 'countdown';
        m.endsAt = t + COUNTDOWN_SECONDS;
        m.results = [];
        m.winner = null;
        for (const p of sim.players) resetRacer(sim, p, true);
        sim.emit({ e: 'racesoon', n: m.race });
        return;
      }

      if (m.phase === 'countdown') {
        m.phase = 'racing';
        m.startedAt = t;
        m.endsAt = t + RACE_SECONDS;
        for (const p of sim.players) {
          p.racing = !p.waitingForRace;
          p.waitingForRace = false;
        }
        sim.emit({ e: 'racestart', n: m.race });
        return;
      }

      if (m.phase === 'racing') {
        m.phase = 'results';
        m.endsAt = t + RESULTS_SECONDS;
        for (const p of sim.players) p.racing = false;
        sim.emit({ e: 'raceend', w: m.winner ? m.winner.id : null });
        return;
      }

      m.phase = 'roam';
      m.race += 1;
      m.endsAt = t + ROAM_SECONDS;
      for (const p of sim.players) resetRacer(sim, p, false);
    },

    projectState(sim) {
      const m = sim.state.mode;
      return {
        phase: m.phase,
        race: m.race,
        laps: m.laps,
        left: Math.max(0, Math.round(m.endsAt - sim.state.t)),
        results: m.results.slice(0, 5),
        winner: m.winner,
        running: sim.players.filter(p => p.racing).length,
      };
    },
  };

  function everyoneFinished(sim) {
    return sim.players.length > 0 && !sim.players.some(p => p.racing);
  }

  /** Put a player back on the grid (or just clear their race progress). */
  function resetRacer(sim, p, toGrid) {
    p.finishTime = 0;
    p.nextCp = 0;
    p.lap = 0;
    p.racing = false;
    p.waitingForRace = false;
    if (!toGrid) return;
    const grid = sim.world.spawns.filter(s => s.tag === 'grid');
    if (!grid.length) return;
    const slot = grid[sim.players.indexOf(p) % grid.length];
    sim.leaveVehicle(p, true);
    p.x = slot.x;
    p.y = slot.y;
    p.z = slot.z;
    p.yaw = slot.yaw || 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.hp = p.maxHp;
    p.deadUntil = 0;
  }
}
