/**
 * Bean Rush — the rules. One race on the candy course, again and again.
 *
 *   waiting → countdown → racing → results → (next round) countdown → …
 *
 * - Up to `seats` beans race; bots fill whatever seats people do not.
 * - Everyone starts locked on the start pad; the countdown releases them.
 * - Falling off is never death: you reappear at the last checkpoint you
 *   reached (or the start pad).
 * - The first `quota` (≈60%) across the finish line qualify. The round ends
 *   when the quota is full, everyone has finished, or time runs out.
 * - Finishers stand on the podium behind the line, out of the way.
 * - Someone who joins mid-race waits on the start pad for the next round.
 *
 * Bots think in `preTick`, before the players move, through the same input
 * path as people (minus the network).
 */
import { createBotBrain, isBot } from './bots.js';

export function beanRushMode(options = {}) {
  const cfg = {
    seats: 8,
    qualifyFraction: 0.6,
    waitSeconds: 4,          // after the first person arrives, before the first countdown
    countdownSeconds: 3,
    raceSeconds: 150,
    resultsSeconds: 8,
    fillWithBots: true,
    ...options,
  };
  const m = { phase: 'waiting', endsAt: 0, round: 0, quota: 0, finished: [], startedAt: 0 };
  let brain = null;
  let course = null;
  let botSerial = 0;

  function humans(sim) { return sim.players.filter(p => !isBot(p.id)); }
  function bots(sim) { return sim.players.filter(p => isBot(p.id)); }

  function startSpot(sim, p) {
    const spawns = sim.world.spawns.filter(s => s.tag === 'start');
    const index = Math.max(0, sim.players.indexOf(p)) % spawns.length;
    return spawns[index];
  }

  function respawnSpot(sim, p) {
    const reached = (p.nextCp || 0) - 1;
    const cp = reached >= 0 ? sim.world.checkpoints[reached] : null;
    if (cp && cp.respawn) {
      // Spread respawns a little so beans do not stack on one point.
      const jitter = ((p.respawns || 0) % 5 - 2) * 1.2;
      return { x: cp.respawn.x + jitter, y: cp.respawn.y, z: cp.respawn.z, yaw: cp.respawn.yaw || 0 };
    }
    return startSpot(sim, p);
  }

  /** Bring the seat count to exactly `seats` with bots (between rounds only). */
  function fillSeats(sim) {
    if (!cfg.fillWithBots) return;
    let total = sim.players.length;
    while (total > cfg.seats) {
      const bot = bots(sim).pop();
      if (!bot) break;
      brain.forget(bot.id);
      sim.removePlayer(bot.id);
      total -= 1;
    }
    while (total < cfg.seats) {
      botSerial += 1;
      sim.addPlayer('bot-' + botSerial, brain.nextName());
      total += 1;
    }
  }

  function lineUp(sim) {
    for (const p of sim.players) {
      p.finished = false;
      p.qualified = false;
      p.finishTime = 0;
      p.place = 0;
      p.nextCp = 0;
      p.lap = 0;
      p.racing = true;
      p.respawns = 0;
      sim.teleportPlayer(p, { ...startSpot(sim, p), locked: true });
    }
  }

  function startCountdown(sim) {
    m.round += 1;
    fillSeats(sim);
    lineUp(sim);
    m.finished = [];
    m.quota = Math.max(1, Math.round(sim.players.length * cfg.qualifyFraction));
    m.phase = 'countdown';
    m.endsAt = sim.state.t + cfg.countdownSeconds;
    sim.emit({ e: 'countdown', n: m.round, s: cfg.countdownSeconds });
  }

  function startRace(sim) {
    m.phase = 'racing';
    m.startedAt = sim.state.t;
    m.endsAt = sim.state.t + cfg.raceSeconds;
    for (const p of sim.players) if (p.racing) p.locked = false;
    sim.emit({ e: 'go', n: m.round });
  }

  function finish(sim, p) {
    p.finished = true;
    p.finishTime = sim.state.t - m.startedAt;
    p.place = m.finished.length + 1;
    p.qualified = p.place <= m.quota;
    m.finished.push(p.id);
    sim.emit({ e: 'finish', p: p.id, pl: p.place, tm: Math.round(p.finishTime * 100) / 100 });
    if (p.qualified) sim.emit({ e: 'qualify', p: p.id });
    const spot = course.game.podium[(p.place - 1) % course.game.podium.length];
    sim.teleportPlayer(p, { ...spot, locked: true });
  }

  function endRound(sim, reason) {
    m.phase = 'results';
    m.endsAt = sim.state.t + cfg.resultsSeconds;
    const standings = sim.players
      .filter(p => p.racing)
      .map(p => ({ id: p.id, n: p.name, pl: p.place || 0, q: !!p.qualified, tm: p.finishTime || 0, bot: isBot(p.id) }))
      .sort((a, b) => (a.pl || 99) - (b.pl || 99));
    m.standings = standings;
    for (const p of sim.players) p.locked = true;
    sim.emit({ e: 'roundend', n: m.round, r: reason });
  }

  return {
    id: 'bean-rush',
    name: 'Bean Rush',
    // A party race: no health, no fall damage, nearly instant "respawn".
    config: { respawnDelay: 0.1, fallDamage: false, startWeapons: [] },

    init(sim) {
      course = sim.world.manifest;
      brain = createBotBrain(course, sim.rng);
      sim.state.mode = m;
    },

    onJoin(sim, p) {
      p.racing = false;
      p.finished = false;
      if (isBot(p.id)) return;
      // A person takes a bot's seat; if the race is on, they wait for the next round.
      if (cfg.fillWithBots && sim.players.length > cfg.seats) {
        const bot = bots(sim).find(b => !b.finished) || bots(sim)[0];
        if (bot) { brain.forget(bot.id); sim.removePlayer(bot.id); }
      }
      if (m.phase === 'waiting' && m.endsAt === 0) m.endsAt = sim.state.t + cfg.waitSeconds;
      if (m.phase === 'racing' || m.phase === 'results') {
        sim.teleportPlayer(p, { ...startSpot(sim, p), locked: true });
      } else {
        p.racing = m.phase === 'countdown';
        sim.teleportPlayer(p, { ...startSpot(sim, p), locked: true });
      }
    },

    onLeave(sim, p) {
      if (!isBot(p.id) && humans(sim).length === 0) {
        // Nobody left to watch: park the room until someone arrives.
        for (const b of bots(sim)) { brain.forget(b.id); sim.removePlayer(b.id); }
        m.phase = 'waiting';
        m.endsAt = 0;
      }
    },

    /** Falling into the sea is not death: back to your last checkpoint. */
    onDamage(sim, p, amount, sourceId, cause) {
      if (cause === 'void') {
        p.respawns = (p.respawns || 0) + 1;
        const spot = p.finished ? course.game.podium[(p.place - 1) % course.game.podium.length] : respawnSpot(sim, p);
        sim.teleportPlayer(p, { ...spot, locked: p.locked });
        sim.emit({ e: 'splash', p: p.id });
      }
      return false;           // nobody ever loses health in Bean Rush
    },

    onCheckpoint(sim, p, cp) {
      if (m.phase !== 'racing' || !p.racing || p.finished) return;
      if (cp.finish) finish(sim, p);
    },

    preTick(sim) {
      const t = sim.state.t;
      if (m.phase === 'waiting') {
        if (humans(sim).length > 0 && m.endsAt && t >= m.endsAt) startCountdown(sim);
      } else if (m.phase === 'countdown') {
        if (t >= m.endsAt) startRace(sim);
      } else if (m.phase === 'racing') {
        const racers = sim.players.filter(p => p.racing);
        const done = racers.filter(p => p.finished).length;
        if (m.finished.length >= m.quota) endRound(sim, 'quota');
        else if (done >= racers.length) endRound(sim, 'all');
        else if (t >= m.endsAt) endRound(sim, 'time');
      } else if (m.phase === 'results') {
        if (t >= m.endsAt) {
          if (humans(sim).length > 0) startCountdown(sim);
          else { m.phase = 'waiting'; m.endsAt = 0; }
        }
      }

      for (const p of sim.players) {
        if (isBot(p.id)) sim.setInput(p.id, brain.think(sim, p));
      }
    },

    projectState(sim) {
      const out = {
        phase: m.phase,
        left: Math.max(0, Math.ceil(m.endsAt - sim.state.t)),
        round: m.round,
        quota: m.quota,
        qualified: m.finished.filter(id => { const p = sim.getPlayer(id); return p && p.qualified; }).length,
      };
      if (m.phase === 'results' && m.standings) out.standings = m.standings;
      return out;
    },
  };
}
