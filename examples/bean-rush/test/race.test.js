import { describe, it, expect, beforeAll } from 'vitest';
import R from '@dimforge/rapier3d-deterministic-compat';
import { buildWorld, createSimulation } from '@usions/world-engine/core';
import { buildCourse } from '../course.js';
import { beanRushMode } from '../mode.js';
import { isBot } from '../bots.js';

const DT = 1 / 30;
beforeAll(async () => { await R.init(); });

function makeRace(seed = 7, options) {
  const world = buildWorld(buildCourse(), { rapier: R, dt: DT });
  const sim = createSimulation({ world, mode: beanRushMode(options), seed });
  return { world, sim };
}

/** Step until `done(sim, events)` or `seconds` pass; returns all events. */
function runUntil(sim, seconds, done = () => false) {
  const events = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    const batch = sim.drainEvents();
    events.push(...batch);
    if (done(sim, batch)) break;
  }
  return events;
}

describe('Bean Rush — round flow', () => {
  it('fills the empty seats with bots and holds everyone still during the countdown', () => {
    const { sim, world } = makeRace();
    sim.addPlayer('u1', 'Me');
    runUntil(sim, 10, s => s.state.mode.phase === 'countdown');
    expect(sim.state.mode.phase).toBe('countdown');
    expect(sim.players.length).toBe(8);
    expect(sim.players.filter(p => isBot(p.id)).length).toBe(7);
    const me = sim.getPlayer('u1');
    const start = { x: me.x, z: me.z };
    for (let i = 0; i < 30; i++) { sim.setInput('u1', { seq: i + 1, mz: 1 }); sim.step(DT); }
    expect(sim.state.mode.phase).toBe('countdown');
    expect(Math.hypot(me.x - start.x, me.z - start.z)).toBeLessThan(0.05);   // locked
    world.dispose();
  });

  it('runs a full race: the qualifying quota finishes within the time limit, then a new round starts', () => {
    const { sim, world } = makeRace(7);
    sim.addPlayer('u1', 'Me');
    const events = runUntil(sim, 200, (s, batch) => batch.some(e => e.e === 'countdown' && e.n === 2));
    const finishes = events.filter(e => e.e === 'finish');
    const end = events.find(e => e.e === 'roundend');
    expect(end).toBeDefined();
    expect(end.r).toBe('quota');                                   // not a timeout
    expect(finishes.length).toBe(5);                               // 60% of 8
    expect(finishes.every(f => f.tm > 30 && f.tm < 150)).toBe(true);
    expect(finishes.map(f => f.pl)).toEqual([1, 2, 3, 4, 5]);
    expect(events.some(e => e.e === 'countdown' && e.n === 2)).toBe(true);
    world.dispose();
  }, 60_000);

  it('a fall puts you back at the last checkpoint, not the start', () => {
    const { sim, world } = makeRace();
    sim.addPlayer('u1', 'Me');
    runUntil(sim, 12, s => s.state.mode.phase === 'racing');
    const me = sim.getPlayer('u1');
    me.nextCp = 2;                                // reached checkpoints 1 and 2 (z 38, z 67)
    me.x = 20; me.y = -20; me.z = 70;             // off the course, below the kill line
    runUntil(sim, 0.2);
    expect(me.z).toBeCloseTo(67, 0);
    expect(me.y).toBeGreaterThan(-1);
    expect(me.hp).toBe(100);                      // nobody loses health in Bean Rush
    world.dispose();
  });

  it('someone who joins mid-race waits on the start pad for the next round', () => {
    const { sim, world } = makeRace();
    sim.addPlayer('u1', 'Me');
    runUntil(sim, 12, s => s.state.mode.phase === 'racing');
    runUntil(sim, 2);
    const late = sim.addPlayer('u2', 'Late');
    expect(sim.players.length).toBe(8);           // took a bot's seat
    expect(late.locked).toBe(true);
    expect(late.racing).toBe(false);
    expect(late.z).toBeLessThan(0);               // on the start pad
    world.dispose();
  });

  it('parks the room when the last person leaves', () => {
    const { sim, world } = makeRace();
    sim.addPlayer('u1', 'Me');
    runUntil(sim, 12, s => s.state.mode.phase === 'racing');
    sim.removePlayer('u1');
    expect(sim.players.length).toBe(0);
    expect(sim.state.mode.phase).toBe('waiting');
    world.dispose();
  });
});
