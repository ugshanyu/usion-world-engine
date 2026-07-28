# @usions/world-engine

**The core world every creator builds on.** A deterministic 3D world — streets
and buildings you collide with, cars you drive, weapons you shoot, hazards that
launch you — running server-authoritative for up to 200 players in one world.

Creators write *rules*. The engine is the world.

```
Your game (a mode object, ~100 lines)
        │
        ▼
@usions/world-engine  ── the same simulation, twice ──┐
        │                                              │
   server: authority (Node or the platform sandbox)    │
   client: prediction + Babylon rendering + HUD ───────┘
```

- **One simulation, two runtimes.** `src/core/` is dependency-free JavaScript
  that runs unchanged as the authority in a Node server, inside the platform's
  sandboxed rooms runtime, and in the browser to predict the local player.
  Server and client cannot disagree about where a wall is.
- **Babylon renders; it does not simulate.** Adding a second physics engine to
  the client would give two solvers that drift apart, and drift is what makes
  multiplayer feel broken.
- **A world costs eighty bytes.** The server sends a *world spec*
  (`{generator:'city', options:{seed:7}}`); both sides generate identical
  geometry from the seed. No mesh downloads, no asset pipeline.
- **Built for world rooms.** Drop-in/drop-out, area-of-interest streaming,
  rolling competitions, 200 players.

## Quick start

### Server — you host it (direct mode)

```js
import { createWorldServer } from '@usions/world-engine/server';

await createWorldServer({
  serviceId: 'my-game',
  worldSpec: { generator: 'city', options: { seed: 7, blocks: 6 } },
  mode: 'race',                  // or 'freeroam' | 'deathmatch' | 'elimination' | your own
  staticDir: './client',         // optional: serve the game client too
});
```

That is a complete authoritative game server: RS256 token verification against
the platform JWKS, world rooms keyed by the token's `room_id`, a 30 Hz
simulation, 15 Hz per-observer AOI snapshots, rate limits, keepalives, resync
keyframes and graceful shutdown.

### Server — the platform hosts it (hosted mode)

```js
module.exports = UsionWorldEngine.createWorldBundle({
  worldSpec: { generator: 'city', options: { seed: 7 } },
  mode: { id: 'elimination', qualifyFraction: 0.6 },
});
```

One file, no server to run: concatenate `dist/usion-world-engine.cjs.js` with
that `module.exports = …` line and register the result as your service's
`server_bundle_url`.

### Client

```html
<script src="https://usions.com/usion-sdk.js"></script>
<script src="https://usions.com/vendor/babylon/9.16.1/babylon.js"></script>
<script src="/usion-world.js"></script>   <!-- dist/usion-world.min.js, served by your game -->
<script>
  Usion.init(function () { UsionWorld.start({ labels: MY_STRINGS }); });
</script>
```

`start()` joins the world, generates the city, renders it, draws touch
controls and a HUD, predicts the local player, interpolates everyone else, and
recovers from disconnects. Pass `labels` in the user's language — the engine
never hardcodes a user-facing string.

## Writing a game mode

A mode is a plain object of optional hooks. Nothing in the physics changes to
invent a new competition:

```js
export function captureTheCarMode() {
  return {
    id: 'capture-the-car',
    config: { respawnDelay: 3, startWeapons: ['shove', 'pistol'] },
    init(sim) { sim.state.mode = { phase: 'live', endsAt: sim.state.t + 300 }; },
    onDeath(sim, victim, killer) { if (killer) killer.score += 1; },
    onCheckpoint(sim, player, cp) { player.score += 5; },
    onTick(sim, dt) { /* your rules */ },
    projectState(sim) { return { phase: sim.state.mode.phase }; },  // codes, not sentences
  };
}
```

Hooks: `init, onJoin, onLeave, onSpawn, onDeath, onDamage, onCheckpoint,
onPickup, onEnterVehicle, preTick, onTick, blockRespawn, projectState`.
Every one receives the simulation api first: `sim.players`, `sim.emit()`,
`sim.damagePlayer()`, `sim.spawnVehicle()`, `sim.world`, `sim.state`.

Built-ins: `freeroam`, `deathmatch`, `race`, `elimination`.

## Building a world

`generateCity({ seed, blocks, blockSize, roadWidth })` produces a full
manifest: roads, kerbs, buildings, street furniture, parked cars, weapon and
health pickups, a race circuit with a starting grid, a central plaza with
spinning hazards, and an obstacle-course district (sweepers, moving platforms,
pistons, a conveyor, a launch ramp).

Hand-authored worlds are the same JSON:

```js
{
  bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
  solids: [ boxAt(0, 0, 20, 30, 12, 4), rampAt(0, 0, 40, 8, 3, 12) ],
  movers: [ { id: 'bar', kind: 'spinner', x: 0, y: 1, z: 0, w: 12, h: 1, d: 0.6, period: 4 } ],
  spawns: [ { x: 0, y: 0, z: 0, yaw: 0, tag: 'start' } ],
  vehicleSpawns: [ { kind: 'sport', x: 6, y: 0, z: 0 } ],
  checkpoints: [ { id: 'c0', order: 0, x: 0, y: 0, z: 60, radius: 10 } ],
  zones: [ { id: 'goal', kind: 'goal', x: 0, z: 120, radius: 12 } ],
}
```

Collision is two primitives — yawed **boxes** and yawed **ramps** — because
everything a city needs is one of them and a small set is what keeps 200
players affordable inside a sandbox. Movers (`spinner`, `sweeper`, `piston`,
`platform`, `crusher`, `conveyor`) are pure functions of world time, so they
cost nothing on the wire.

## What the world simulates

| | |
|---|---|
| **On foot** | walk, sprint, jump with coyote time and buffering, committed dive, step-up over kerbs, ramps, slope sliding, fall damage, stun and knockback, player-vs-player jostling |
| **Vehicles** | four classes (kart, sedan, sport, truck), speed-sensitive steering, grip that breaks into a handbrake drift, four-wheel suspension with pitch and roll, crashes that damage and bounce, car-vs-car mass exchange, running players over, wrecks that respawn |
| **Combat** | hitscan and projectile weapons with spread, falloff, splash and knockback; server-side traces that cannot shoot through walls; melee shove; health, death, respawn |
| **World** | moving hazards, ride-able platforms, conveyors, pickups, checkpoints and laps, goal zones, out-of-bounds kill |

## Networking

Network entities use `x` = world X, `y` = world Z, `h` = height — the ground
plane in `x`/`y` is what the platform's AOI grid slices on, so interest
management works for free.

The client predicts the local player by running the same step functions, then
adopts the authoritative position on every snapshot and decays the visual
difference over ~150 ms. Remote players are interpolated ~110 ms in the past in
the arrival-time domain (no clock sync). Snapshot `seq` advances exactly once
per tick, and unicast keyframes reuse it — the direct-mode pitfall that made
remote players freeze and jump in earlier games.

## Development

```bash
npm install
npm test        # 73 tests: collision, character, vehicle, modes, sim, world, live WebSocket protocol
npm run build   # dist/usion-world.js, dist/usion-world.min.js, dist/usion-world-engine.cjs.js
```

## Reference game

[`examples/usion-city`](examples/usion-city) — Usion City, a 200-player world
running the "City Rush" competition, deployed to Railway and registered on the
Usion platform. Live at <https://usion-city-production.up.railway.app>.

```bash
npm install && npm run build
cd examples/usion-city && npm install && npm run build && npm run dev
# open http://localhost:3040 in two tabs
```

## Relationship to the Usion platform

This repo is **standalone** — it is not part of the Usion monorepo and nothing
here has to be deployed with the platform. It consumes two public platform
assets at runtime (the Usion SDK and the pinned Babylon build), and it speaks
the platform's direct-mode WebSocket protocol and RS256 game tokens. A game
built on it registers itself with the registry like any other third-party
service; see [`scripts/seed_usion_city.py`](scripts/seed_usion_city.py).
