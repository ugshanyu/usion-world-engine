# Usion City — the reference world-engine game

A whole city shared by up to 200 players: run the streets, take a car, brawl
in the plaza, dodge spinning bars in the obstacle park — then the horn sounds
and everyone races a checkpoint circuit through town.

**Live:** <https://usion-city-production.up.railway.app> · service id
`usion-city` · engine: [the repo root](../..).

## What is actually in this directory

| File | Lines | What it is |
|------|------:|------------|
| `mode.js` | ~165 | **the whole game** — the rolling roam → countdown → race → results competition |
| `server.js` | ~60 | picks a world spec, a mode and a port |
| `client/index.html` | ~110 | three script tags, translations, one `UsionWorld.start()` |
| `dev.js` | ~120 | local harness: self-signed tokens, no backend needed |

Everything else — the city, the physics, the cars, the weapons, the hazards,
the netcode, the touch controls, the HUD — is the engine. That is the point:
a creator ships rules, not netcode.

## Run it locally

```bash
npm install && npm run build          # in the repo root, builds the engine
cd examples/usion-city && npm install && npm run build
npm run dev
# open http://localhost:3040 in two tabs = two players in the same city
```

The dev harness mints its own RS256 keypair and shims the two calls that
normally go through the platform (`joinWorld` placement and access-token
minting), so the whole loop runs with no backend.

## Deploy

The deploy unit is `dist/server.mjs` (the server with the engine inlined) plus
`client/`, so a host only ever needs `ws` and `jose`:

```bash
npm run build          # regenerates dist/server.mjs + client/usion-world.js
npm test               # fails if those artifacts are stale
railway up --service usion-city
```

Railway builds the `Dockerfile` and health-checks `/health`. Then point the
registry at the deployment:

```bash
DATABASE_URL='mongodb+srv://…' python ../../scripts/seed_usion_city.py
# override with USION_CITY_WS_URL / USION_CITY_IFRAME_URL
```

The service is registered **direct mode** with the `world` tag: clients call
`joinWorld()` for placement, the backend mints an RS256 game token, and the
client connects straight to `wss://…/ws`. The platform never relays gameplay.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | 3040 | listen port (Railway injects its own) |
| `SERVICE_ID` | `usion-city` | token `aud` must be `usion-game-service:<id>` |
| `USION_API_URL` | `https://mobile.mongolai.mn` | platform origin; JWKS is derived from it |
| `PUBLIC_KEY_PEM` | — | SPKI PEM replacing the JWKS (local dev only) |
| `WORLD_SEED` | `20260728` | change it and the entire city changes |
| `LOG_LEVEL` | `info` | `debug` prints per-connection auth |

## The competition

```
roam       90 s   free play — drive, shoot, explore, brawl
countdown  12 s   everyone is placed on the starting grid, out of their cars
racing   ≤300 s   2 laps of the city circuit; first home shortens the clock
results    20 s   podium, then back to roaming
```

Latecomers roam immediately and enter the *next* race — dropping someone into
lap two is worse than a short wait. Points: 12/9/7/5/4/3/2/1 by finishing
place, plus a point per knockout during free roam.

## Health and metrics

`GET /health` reports rooms, players, connections, tick rates and the world
spec. `GET /world.json` returns the world spec alone — the same eighty bytes
every client regenerates the city from.
