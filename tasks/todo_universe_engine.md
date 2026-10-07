# Plan: the Usion universe engine

Goal: one engine where the **server runs the world** (like Roblox) and every
game is a set of rules on top of it, so new games get fair multiplayer,
physics and progress for free. Players keep one avatar across games and move
between them through a shared hub.

How we got here (2026-10-07 study):
- **Sketchbook** (`~/usion-sketchbook`) has the feel — character states,
  springs, cars/planes/helicopters, Blender maps, tuned touch controls — but
  runs only on the phone, so every game rebuilt multiplayer and trusts the
  client. Only 3 of 11 games really use it.
- **World Engine** (this repo) has the right shape — the same simulation on
  server and phone, small "mode" files as games, signed-token auth, AOI — but
  its physics are arcade boxes and its multiplayer pieces are unfinished.
- **Rapier spike** (`spikes/rapier/RESULTS.md`): byte-identical results on
  Node ARM/x86, Chromium, WebKit and the rooms sandbox; 3.7 ms/tick for 200
  players + 50 cars + 100 boxes; 0.36 ms per phone step at 6× slowdown;
  0.86 MB download. Runs in rooms-runtime with three shims; needs the runtime
  to provide Rapier (bundle cap 512 KB).

Decision taken: **World Engine's architecture + Rapier physics + Sketchbook's
feel.** This repo stays outside `usionTheMobile`; only platform pieces
(rooms-runtime, SDK) change in the monorepo.

## Open decisions (need an answer before Phase 2/3)

- [ ] **Renderer:** Babylon (World Engine today; pinned on usions.com, has
      instancing/LOD) or three.js (Sketchbook today; our team's experience).
      Recommendation: Babylon — one renderer, already hosted.
- [ ] **Where universe servers run:** platform rooms-runtime (hosted mode,
      creators run nothing) vs. our own Node service (direct mode, simpler to
      start). Recommendation: direct mode first, hosted once Phase 3 lands.
- [ ] **First game to move:** Oval Rush (cars, bots, laps) or UP (climbing,
      shared world). Recommendation: Oval Rush — exercises vehicles + modes.

## Phase 0 — Spike ✅
- [x] Rapier determinism across Node ARM/x86, Chromium, WebKit, isolated-vm
- [x] Server/phone speed, download size, room boot time
- [x] Snapshot/restore determinism
- [ ] Real-device check: open `spikes/rapier/page.html` on an iPhone and a
      low-end Android; hashes must equal `84164aac` / `0dcfc544`
- [ ] Confirm whether isolated-vm's 128 MB limit counts WebAssembly memory

## Phase 1 — Fix World Engine's multiplayer basics (no physics change yet)
Each item is a known bug from the study; each gets a test.
- [x] Fixed-step simulation: accumulator on server and client (never step
      with wall-clock dt); `tickHz` actually used
- [x] Input queue per player (not "latest wins"); ack by `seq`
- [x] Client prediction with replay: reset own player to the acked server
      state, replay unacked inputs — own character/vehicle only, never a
      full-world snapshot (3.3 MB)
- [x] Disconnect grace (15 s, matching the platform) instead of instant removal
- [x] Smaller snapshots: send only changed fields, cap entities per observer,
      serialize shared AOI cells once instead of once per player
      (done: deltas + cap; shared-cell serialization not needed at 8 players)
- [x] Fix seat numbering, own-vehicle self-hit, `mode.config` never merged,
      race/elimination teleports while seated
- [ ] Pin the SDK version; submit to the leaderboard when it's enabled
- [ ] Load test: 200 bots for 1 hour on one process; record CPU, memory,
      bandwidth per player

## Phase 2 — Rapier as the physics core
- [x] Rapier behind the sim API for characters, movers and rollers
      (`physics: 'rapier'`); vehicles still on the arcade model
- [ ] Ship the shims from the spike in one place (`TextDecoder`,
      sync WebAssembly instantiate, `performance.now`)
- [ ] Maps from Blender: build step that turns a `.glb` into (a) a compact
      collision file (trimesh/boxes) and (b) the render mesh; keep the seeded
      city generator as a second source producing Rapier colliders
- [ ] Character: port Sketchbook's state machine (idle/walk/sprint/jump/fall/
      land/roll, enter/exit vehicle as states not teleports) and spring
      smoothing on top of Rapier's character controller
- [ ] Vehicles: car on Rapier's ray-cast vehicle (tune to Sketchbook's feel);
      then airplane and helicopter as force models; vehicle kinds registered
      as data, not hard-coded
- [ ] Dynamic props (boxes, balls, doors) simulated on the server, interpolated
      on phones
- [~] Determinism check: `scripts/check-determinism.cjs` (Node + Chromium +
      WebKit, same hash); not yet wired into CI

## Phase 3 — Platform support (monorepo: `packages/rooms-runtime`, SDK)
- [ ] rooms-runtime provides Rapier as a built-in library (like the blessed
      Phaser/Babylon builds) so game bundles stay under 512 KB; versioned,
      old versions kept
- [ ] Add the three shims to the sandbox bootstrap
- [ ] Fix hosted-mode gaps found in the study: world spec lost on reconnect
      (no `onJoin` on reconnect), protocol v3 inputs arriving as `'default'`,
      `ALLOWED_SERVICE_IDS` only allowing one service
- [ ] Update the `usion-app` skill + `scripts.sync_skill_docs` for anything
      that changes the SDK/hosting contract

## Phase 4 — The universe layer
- [ ] Profile + avatar look + inventory saved server-side (`Usion.cloud`
      written by the server, not the phone)
- [ ] **Place** = world (map or seed) + mode; registry of places
- [ ] Hub world: where players meet; doors/portals list places
- [ ] Travel between places: matchmake into the place's room with a handoff
      that carries the avatar; come back to the hub afterwards
- [ ] Records, rewards and currency checked on the server (leaderboard,
      Game Center, wallet)
- [ ] Friends: see who is in the hub / which place, join them

## Phase 5 — Games on the universe
- [ ] Rebuild the first game (see open decision) as a mode + map; ship it
      next to the current version, compare play time before switching
- [ ] Move the other 3D games that fit (UP, Breach); leave 2D/puzzle games as
      they are
- [ ] Teach the AI Creator to write universe modes (rules on an existing
      world) instead of whole apps

## Phase 6 — Phone rendering budget
- [ ] Instanced avatars and vehicles, LOD, device-pixel-ratio cap, no
      per-frame DOM rebuilds in the HUD
- [ ] Target: 60 fps on a mid-range Android with 50 players in view

## Done means
Two phones and a desktop in the same hub, walk to a portal, race, return to
the hub with the result saved, with no cheating possible from a modified
client, on a real low-end Android.
