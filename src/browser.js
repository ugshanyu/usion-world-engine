/**
 * Browser entry — everything a mini-app needs, exposed as `window.UsionWorld`.
 *
 * Build it with `npm run build` and serve `dist/usion-world.min.js` from your
 * own game's origin, next to its `index.html`. Each game pins its own engine
 * version that way, and upgrading one game never moves another.
 */
import * as core from './core/index.js';
import { buildManifest, generateCity, registerGenerator } from './worlds/index.js';
import { createMode, freeroamMode, deathmatchMode, raceMode, eliminationMode } from './modes/index.js';
import {
  start, createRenderer, createControls, createHud, createCameraRig, createNetClient, createPredictor,
} from './client/index.js';

const UsionWorld = {
  ...core,
  start,
  buildManifest,
  generateCity,
  registerGenerator,
  createMode,
  freeroamMode,
  deathmatchMode,
  raceMode,
  eliminationMode,
  createRenderer,
  createControls,
  createHud,
  createCameraRig,
  createNetClient,
  createPredictor,
};

export default UsionWorld;
