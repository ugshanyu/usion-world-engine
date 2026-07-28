/**
 * Usion World Engine — deterministic core.
 *
 * Pure JavaScript with no dependencies and no host APIs, so the identical
 * code runs as the authority in a Node game server, inside the platform's
 * sandboxed rooms runtime, and in the browser for client-side prediction.
 */
export * from './math.js';
export { createRng, hashSeed } from './rng.js';
export {
  createCollisionWorld, boxAt, rampAt, prepareSolid, refreshSolid,
  depenetrateSphere, raycastSolid, solidTopAt, solidNormalY,
} from './collision.js';
export { createMover, updateMover, updateMovers, moverVelocityAt, resolveMovers, sampleMoverGround } from './movers.js';
export { CHARACTER, spawnCharacter, stepCharacter, applyImpulse, resolvePlayerPush } from './character.js';
export {
  VEHICLE, VEHICLE_SPECS, getSpec, createVehicle, respawnVehicle, stepVehicle,
  resolveVehiclePair, seatPosition,
} from './vehicle.js';
export {
  WEAPONS, getWeapon, resetLoadout, giveWeapon, canFire, traceShot, rayCapsule,
  rayVehicle, raySphere, muzzleOf, normalizeAim, damageAt, stepProjectiles,
} from './combat.js';
export { buildWorld, normalizeManifest, atCheckpoint, DEFAULT_THEME } from './world.js';
export { createInterestGrid } from './interest.js';
export { createSimulation, SIM_DEFAULTS } from './sim.js';
export const ENGINE_VERSION = '1.0.0';
