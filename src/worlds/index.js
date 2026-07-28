/**
 * World generators.
 *
 * A **world spec** is the tiny JSON the server hands every client on join —
 * `{ generator: 'city', options: { seed: 7, blocks: 6 } }` — instead of the
 * full manifest. Both sides run the same seeded generator and end up with
 * byte-identical geometry, so a city with hundreds of buildings costs about
 * eighty bytes on the wire and no asset download at all.
 *
 * A creator with hand-authored geometry can pass `{ manifest: {...} }`
 * instead; everything downstream treats the two identically.
 */
import { generateCity } from './city.js';

export { generateCity };

const GENERATORS = {
  city: generateCity,
};

/** Register a custom generator so `{generator: name}` specs resolve to it. */
export function registerGenerator(name, factory) {
  GENERATORS[name] = factory;
  return factory;
}

/** Resolve a world spec (or a raw manifest) into a manifest. */
export function buildManifest(spec) {
  if (!spec) throw new Error('buildManifest: a world spec or manifest is required');
  if (spec.manifest) return spec.manifest;
  if (spec.solids || spec.spawns) return spec;          // already a manifest
  const factory = GENERATORS[spec.generator];
  if (!factory) throw new Error(`Unknown world generator "${spec.generator}"`);
  return factory(spec.options || {});
}
