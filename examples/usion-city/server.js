/**
 * Usion City — the reference world-engine game server (direct mode).
 *
 * Everything hard is in `@usions/world-engine`: this file picks a world, a
 * mode and a port. That is the point of the engine — a creator ships rules,
 * not netcode.
 *
 * Environment:
 *   PORT             listen port (Railway injects its own; default 3040)
 *   SERVICE_ID       our service id; token `aud` must be usion-game-service:<id>
 *   USION_API_URL    platform API origin; JWKS is <USION_API_URL>/.well-known/jwks.json
 *   PUBLIC_KEY_PEM   SPKI PEM that replaces the JWKS (local dev only)
 *   WORLD_SEED       city seed — change it and the whole city changes
 *   LOG_LEVEL        debug | info | warn | error
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldServer } from '@usions/world-engine/server';
import { cityRushMode } from './mode.js';

export const WORLD_SPEC = {
  generator: 'city',
  options: {
    seed: Number(process.env.WORLD_SEED || 20260728),
    blocks: 6,
    blockSize: 68,
    roadWidth: 16,
    name: 'Usion City',
  },
};

export async function startCity(overrides = {}) {
  return createWorldServer({
    serviceId: process.env.SERVICE_ID || 'usion-city',
    port: Number(process.env.PORT || 3040),
    worldSpec: WORLD_SPEC,
    mode: cityRushMode,          // a factory: each world room gets its own rules
    // Relative to the working directory, so it resolves the same whether you
    // run `node server.js` or the bundled `node dist/server.mjs`.
    staticDir: process.env.STATIC_DIR || resolve(process.cwd(), 'client'),
    tickHz: 30,
    snapshotHz: 15,
    aoiRadius: 160,              // metres a player can see other players from
    maxPlayers: 200,
    ...overrides,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.on('unhandledRejection', (reason) => console.error('[usion-city] unhandledRejection', reason));
  process.on('uncaughtException', (err) => console.error('[usion-city] uncaughtException', err));
  const server = await startCity();
  const shutdown = async (signal) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'shutdown', signal }));
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
