/**
 * Server-side entry point (Node only — pulls in `ws` and `jose`).
 *
 * Two ways to run a world, one engine:
 *   createWorldServer(...)  — you host it (direct mode: Railway, Fly, EC2)
 *   createWorldBundle(...)  — the platform hosts it (rooms runtime bundle)
 */
export { createWorldServer } from './server.js';
export { WorldRoom } from './room.js';
export { createVerifier } from './auth.js';
export { createGate, sendFrame, sendError, parseClientMessage } from './net.js';
export { createWorldBundle } from '../hosted/bundle.js';
export { buildManifest, generateCity, registerGenerator } from '../worlds/index.js';
export { createMode, freeroamMode, deathmatchMode, raceMode, eliminationMode } from '../modes/index.js';
export * from '../core/index.js';
