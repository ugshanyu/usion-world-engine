/**
 * Sandbox entry — the surface a platform-hosted server bundle gets.
 *
 * Built as an IIFE named `UsionWorldEngine` because the rooms-runtime sandbox
 * has no `require` and no module loader: the whole engine has to arrive as
 * one self-contained script, with the bundle's own `module.exports` assigned
 * at the end of the file.
 *
 * Nothing here may touch the DOM, the network or the filesystem — the sandbox
 * exposes JS intrinsics only.
 */
import * as core from '../core/index.js';
import { buildManifest, generateCity, registerGenerator } from '../worlds/index.js';
import { createMode, freeroamMode, deathmatchMode, raceMode, eliminationMode } from '../modes/index.js';
import { createWorldBundle } from './bundle.js';

export default {
  ...core,
  buildManifest,
  generateCity,
  registerGenerator,
  createMode,
  freeroamMode,
  deathmatchMode,
  raceMode,
  eliminationMode,
  createWorldBundle,
};
