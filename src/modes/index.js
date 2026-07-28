/**
 * Built-in game modes.
 *
 * A mode is a plain object of optional hooks — see freeroam.js for the whole
 * contract. Creators write their own the same way and pass it to
 * `createWorldServer({ mode })`; nothing in the physics core needs to change
 * to invent a new competition.
 */
export { freeroamMode } from './freeroam.js';
export { deathmatchMode } from './deathmatch.js';
export { raceMode } from './race.js';
export { eliminationMode } from './elimination.js';

import { freeroamMode } from './freeroam.js';
import { deathmatchMode } from './deathmatch.js';
import { raceMode } from './race.js';
import { eliminationMode } from './elimination.js';

const FACTORIES = {
  freeroam: freeroamMode,
  deathmatch: deathmatchMode,
  race: raceMode,
  elimination: eliminationMode,
};

/** Resolve a mode by id (`'race'`) or `{id, ...options}`. */
export function createMode(spec) {
  if (!spec) return freeroamMode();
  if (typeof spec === 'function') return spec();
  if (typeof spec === 'string') {
    const factory = FACTORIES[spec];
    if (!factory) throw new Error(`Unknown mode "${spec}"`);
    return factory();
  }
  if (spec.id && FACTORIES[spec.id] && !spec.onTick && !spec.init) {
    return FACTORIES[spec.id](spec);
  }
  return spec;
}
