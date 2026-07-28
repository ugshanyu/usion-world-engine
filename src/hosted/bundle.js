/**
 * Hosted-mode bundle factory.
 *
 * The platform's rooms runtime (`packages/rooms-runtime`) executes ONE
 * sandboxed JS file per service and provides the tick loop, per-observer AOI
 * snapshots, token auth, rate limits and watchdogs. This wraps a world
 * simulation in that contract, so the same world, the same physics and the
 * same client work whether you run your own server (direct mode) or hand the
 * platform a bundle and run none at all.
 *
 * Build a bundle with `npm run build` in this package — the output is a
 * single CommonJS file ending in:
 *
 *   module.exports = UsionWorld.createWorldBundle({
 *     worldSpec: { generator: 'city', options: { seed: 7 } },
 *     mode: { id: 'race', laps: 2 },
 *   });
 *
 * The sandbox has no `require`, no network and no filesystem, and `room.state`
 * makes one JSON round trip per tick — so the live simulation stays in this
 * closure and only its projection is written into `room.state.entities`.
 */
import { buildManifest } from '../worlds/index.js';
import { createMode } from '../modes/index.js';
import { buildWorld } from '../core/world.js';
import { createSimulation } from '../core/sim.js';

export function createWorldBundle(options = {}) {
  const worldSpec = options.worldSpec || { generator: 'city', options: {} };
  const tickHz = options.tickHz ?? 20;          // the runtime caps tickHz at 30
  const aoiRadius = options.aoiRadius ?? 150;
  let sim = null;

  return {
    config: {
      tickHz,
      aoi: options.aoi === false ? false : { radius: aoiRadius, cellSize: Math.round(aoiRadius / 2) },
    },

    init(room) {
      const world = buildWorld(buildManifest(worldSpec));
      sim = createSimulation({
        world,
        mode: createMode(options.mode || 'freeroam'),
        config: { ...(options.simConfig || {}), tickHz },
        seed: options.seed ?? 12345,
      });
      room.state.entities = {};
      room.state.world = worldSpec;
    },

    onJoin(room, player) {
      sim.addPlayer(player.id, player.name);
      // Hand the newcomer the world spec so it can generate identical
      // geometry locally; this is the only per-join payload the client needs.
      room.send(player.id, 'world', {
        world: worldSpec,
        mode: sim.mode ? { id: sim.mode.id, name: sim.mode.name } : null,
        sim_hz: tickHz,
        aoi_radius: aoiRadius,
        engine: 'usion-world',
      });
    },

    onLeave(room, player) {
      sim.removePlayer(player.id);
    },

    onInput(room, player, input) {
      const type = String(input.type || '');
      if (type === 'input' || type === 'i') {
        sim.setInput(player.id, input.data || {});
      }
    },

    tick(room, dt) {
      sim.step(dt);
      const entities = sim.projectEntities();
      entities.world = sim.projectGlobal();     // position-less → global to everyone
      room.state.entities = entities;
      const events = sim.drainEvents();
      if (events.length) room.broadcast('ev', { list: events });
    },

    /** Exposed for tests: the live simulation inside the sandbox. */
    _sim() { return sim; },
  };
}
