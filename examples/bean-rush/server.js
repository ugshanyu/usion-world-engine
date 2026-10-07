/**
 * Bean Rush — game server (direct mode).
 *
 * The engine does the hard parts (Rapier physics, fixed-step simulation,
 * prediction acks, deltas, auth); this file picks the course, the rules and
 * the room size.
 *
 * Environment:
 *   PORT           listen port (default 3050)
 *   SERVICE_ID     our service id; token `aud` must be usion-game-service:<id>
 *   USION_API_URL  platform API origin (JWKS = <USION_API_URL>/.well-known/jwks.json)
 *   PUBLIC_KEY_PEM SPKI PEM replacing the JWKS (local dev only)
 *   LOG_LEVEL      debug | info | warn | error
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldServer } from '@usions/world-engine/server';
import { buildCourse } from './course.js';
import { beanRushMode } from './mode.js';

export const WORLD_SPEC = { manifest: buildCourse() };

export async function startBeanRush(overrides = {}) {
  return createWorldServer({
    serviceId: process.env.SERVICE_ID || 'bean-rush',
    port: Number(process.env.PORT || 3050),
    worldSpec: WORLD_SPEC,
    mode: beanRushMode,           // a factory: every room gets its own rules
    physics: 'rapier',
    staticDir: process.env.STATIC_DIR || resolve(process.cwd(), 'client'),
    tickHz: 30,
    snapshotHz: 15,
    aoiRadius: 400,               // one small course: everyone always sees everyone
    maxPlayers: 8,
    ...overrides,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.on('unhandledRejection', (reason) => console.error('[bean-rush] unhandledRejection', reason));
  const server = await startBeanRush();
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
