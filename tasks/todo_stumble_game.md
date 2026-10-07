# Plan: Bean Rush — first universe game (one-level party obstacle race)

A Stumble Guys–style game, built as our own original: own name, characters,
art and level. One level. It is the first game on the universe engine
(`tasks/todo_universe_engine.md`), so building it also delivers that plan's
Phases 1–2 (multiplayer fixes + Rapier core) in a form players can feel.

## The game in one paragraph

Up to **8 players** (bots fill empty seats) spawn on a start line. Countdown, then
everyone races through one obstacle course: spinning bars, swinging hammers,
pushers, gaps over a drop, rolling balls, a final climb. Get hit and you
tumble; fall off and you respawn at the last checkpoint. The first ~60% across
the finish line qualify; the round ends when the qualify slots fill or the
timer runs out. Results screen, then "Play again". No instructions needed:
move, jump, dive.

## Design decisions (defaults — change if you disagree)

- **Server runs the match** (direct mode, our own Node server on Railway,
  like Usion City); phones predict only their own player.
- **Obstacles are functions of time** (World Engine's movers): every phone
  poses them from the server clock, so they cost no bandwidth and collisions
  with them predict perfectly. Only rolling balls are real physics bodies,
  simulated on the server and interpolated on phones.
- **Player = Rapier character controller + our own velocity and stumble
  state** (not a fully physical ragdoll): deterministic, predictable, and the
  knock-back still looks physical. A short visual tumble animation plays on hits.
- **Renderer: Babylon** (already hosted on usions.com).
- **Theme: candy toy course** — bright sweets-and-toys colours.
- **Art: made in code** — round "bean" characters with eyes and colour/hat
  options, a bright candy-coloured course from simple shapes. No downloads
  of third-party character art, no Stumble Guys assets.
- **Mobile first:** left stick, Jump and Dive buttons, drag to look; keyboard
  on desktop. Text in English + Mongolian; no hard-coded strings.

## Milestones

### M1 — Engine groundwork ✅ (branch `bean-rush/m1`)
- [x] Fixed-step simulation on server and client
- [x] Input queue + acks; prediction that replays unacked inputs (own player only)
- [x] 15 s disconnect grace; smaller snapshots (changed fields, per-observer cap)
- [x] Rapier core behind the sim API (`physics: 'rapier'`); arcade backend unchanged
- [x] Player on Rapier's character controller: run, jump (coyote time + jump
      buffer), dive, stumble/knock-back, get-up, fall → respawn
- [x] Player-vs-player shoving (through the controller, never into walls)
- [x] Tests: determinism (Node ARM/x86, Chromium, WebKit: same hash for an
      8-player match), prediction replay (< 1 µm at 100/250 ms), knock-back
      from spinner, sweeper and rolling ball, platform riding, mesh floors
- Moved on: respawn at the last *checkpoint* is a Bean Rush mode rule → M2;
  the rooms-runtime sandbox shims → universe plan Phase 3 (hosted mode)
- Also fixed (universe plan Phase 1): mode `config` was never applied, seat
  numbering, shooting your own vehicle, race/elimination teleports while seated

### M2 — The level, playable alone with bots ✅ (`examples/bean-rush`)
- [x] Candy course: start pad, railed spinner field, three gap jumps, hammer
      bridge, pusher deck, moving platforms, walled ball ramp (two alternating
      lanes), finish; 4 checkpoints + finish line
- [x] Length: bots finish in ~50–100 s; the 5-of-8 quota fills before the
      150 s limit (tested over a full simulated race)
- [x] Bots with skill-based mistakes: route following, timed gap jumps,
      platform timing (aim where it will be on landing), bar hopping, ball dodging
- [x] Rules: countdown lock (predicted on the phone too), respawn at the last
      checkpoint, qualify, results, next round, late joiners wait, empty rooms park
- [x] Camera: third-person follow (props kept clear of its path)
- [x] Local play in the browser: dev harness on :3050, keyboard + touch
      (only Jump/Dive shown), en + mn strings, countdown + results overlays
- [x] Engine additions: per-world character tuning (one run speed — phones have
      no sprint), camera-relative stick (was world-fixed: a real bug), locked
      players, hazard pistons, ball despawn lines + push, game data in manifests,
      configurable touch buttons, renderer meshes/props/rollers/sea/bean avatar
- Not yet: real-phone feel test, bean animations (M4), sound (M4)

### M3 — Online match
- [ ] Match flow: join → waiting (fill with bots after a short wait) →
      countdown → race → qualify → results → play again
- [ ] Usion integration: matchmaking into 8-seat rooms, signed-token auth,
      `reportResult`, leaderboard (best finish time, server-recorded), invites
      from chat
- [ ] Spectate after qualifying or being eliminated
- [ ] Load test: full 8-seat match (bots + 4 real clients) on throttled networks;
      one server process hosting many matches at once

### M4 — Feel and polish
- [ ] Animations (run, jump, dive, tumble, celebrate), squash-and-stretch
- [ ] Sound and haptics, hit flashes, confetti at the finish, camera shake
- [ ] Character look picker (colour + hat), saved with `Usion.cloud`
      (first step toward the universe avatar)
- [ ] Phone performance: 60 fps on a mid-range Android with all players in
      view (instancing, DPR cap, no per-frame DOM work)
- [ ] Accessibility: large touch targets, readable contrast, reduced-motion option

### M5 — Ship
- [ ] Deploy server + client on Railway; register as a **private** Usion
      service first (creator + named testers)
- [ ] Playtest on real phones (iPhone + low-end Android), incl. the Rapier
      determinism hash check from the spike
- [ ] Make public once it's fun and stable

## Done means
Several real phones and bots race the level together; hits and falls feel
right on a low-end phone; a modified client can't skip obstacles or fake a
finish; results and best times are saved; nobody needs instructions.
