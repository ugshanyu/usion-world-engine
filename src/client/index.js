/**
 * `UsionWorld.start()` — the whole client in one call.
 *
 * A creator's mini-app is then genuinely this small:
 *
 *   <script src="https://usions.com/vendor/babylon/9.16.1/babylon.js"></script>
 *   <script src="/usion-world.js"></script>
 *   <script>
 *     Usion.init(function () { UsionWorld.start({ labels: MY_STRINGS }); });
 *   </script>
 *
 * Everything below — world generation, rendering, touch controls, camera,
 * HUD, prediction, interpolation, reconnects — is handled for them. What a
 * creator changes is the world, the mode, and the strings.
 */
import { buildManifest } from '../worlds/index.js';
import { buildWorld } from '../core/world.js';
import { updateMovers } from '../core/movers.js';
import { createRenderer } from './renderer.js';
import { createControls } from './controls.js';
import { createHud } from './hud.js';
import { createCameraRig } from './camera.js';
import { createNetClient } from './net.js';
import { createPredictor } from './predict.js';

const DEFAULT_LABELS = {
  connecting: 'Connecting…',
  connectFailed: 'Could not connect',
  worldFull: 'This world is full',
  matchTimeout: 'No world available right now',
  retry: 'Retry',
  reconnecting: 'Reconnecting…',
  loading: 'Building the city…',
  unsupported: 'This device cannot run 3D worlds',
  eliminated: 'Eliminated',
  respawning: 'Respawning…',
  health: 'Health', leaderboard: 'Leaderboard', speed: 'km/h',
  fire: 'Fire', use: 'Enter', exit: 'Exit', jump: 'Jump', dive: 'Dive', drift: 'Drift',
  phases: {
    open: 'Free roam', live: 'Fight', over: 'Round over',
    countdown: 'Starts in', racing: 'Race', results: 'Results',
    roundend: 'Round over', showover: 'Winner',
  },
  lapOf: 'Lap {n}/{total}',
  qualified: 'Qualified {n}/{quota}',
  place: 'P{n}',
  killed: '{killer} knocked out {victim}',
  youQualified: 'You qualified!',
  youFinished: 'Finished {place}',
  weapons: {},
};

const INPUT_HZ = 20;

export async function start(options = {}) {
  const Usion = options.Usion || window.Usion;
  if (!Usion) throw new Error('UsionWorld.start: the Usion SDK must be loaded first');
  if (typeof BABYLON === 'undefined') throw new Error('UsionWorld.start: Babylon.js must be loaded first');

  const labels = mergeLabels(DEFAULT_LABELS, options.labels || {});
  const locale = options.locale || (Usion.getLanguage ? Usion.getLanguage() : 'en');
  const mount = options.mount || document.body;
  // The HUD, controls and canvas are absolutely positioned inside the mount,
  // so it has to be a positioning context. Check the COMPUTED position, not
  // the inline one: writing `relative` over a stylesheet's `fixed`/`absolute`
  // strips the element of the inset-based sizing it was relying on and
  // collapses it to zero height — which silently kills the renderer.
  if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none';
  canvas.setAttribute('aria-label', options.canvasLabel || 'Game world');
  mount.appendChild(canvas);

  const hud = createHud(mount, { labels, locale });
  const controls = createControls(mount, { labels });
  hud.overlay(labels.connecting, labels.loading);

  let renderer = null;
  let world = null;
  let manifest = null;
  let camera = null;
  let predictor = null;
  let worldTime = 0;
  let worldTimeTarget = 0;
  let ready = false;
  let status = 'connecting';

  const net = createNetClient({
    Usion,
    bufferMs: options.bufferMs,
    onWorld: (info) => setupWorld(info),
    onEvents: (list) => handleEvents(list),
    onSelf: (self) => {
      if (predictor) predictor.sync(self, (id) => net.getEntity(id));
      controls.setDriving(!!self.v);
    },
    onStatus: (next, err) => {
      status = next;
      if (next === 'disconnected') hud.overlay(labels.reconnecting, '');
      else if (next === 'connected' && ready) hud.hideOverlay();
      else if (next === 'error' && options.onError) options.onError(err);
    },
  });
  net.attach();

  function setupWorld(info) {
    if (world) return;
    const spec = info.world || info;
    manifest = buildManifest(spec);
    world = buildWorld(manifest);
    predictor = createPredictor(world);
    if (options.onWorldReady) options.onWorldReady(world, manifest);
    tryCreateRenderer();
    // A mount that never gains a size would otherwise hang on the loading
    // overlay forever, looking exactly like a dead connection. Say so.
    if (!ready) {
      setTimeout(() => {
        if (ready) return;
        const rect = mount.getBoundingClientRect();
        const detail = `viewport ${Math.round(rect.width)}×${Math.round(rect.height)}`;
        console.warn('[usion-world] renderer never started —', detail);
        hud.overlay(labels.unsupported, detail, labels.retry, () => tryCreateRenderer());
      }, 6000);
    }
  }

  /**
   * Never build the engine while the frame is 0×0: embedded WebViews reveal
   * the iframe after a loading state, and a canvas created at zero size stays
   * black for the whole session. The CONNECTION is never gated on this.
   */
  function tryCreateRenderer() {
    if (renderer || !world) return;
    const rect = mount.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    try {
      renderer = createRenderer(canvas, manifest, options.render || {});
    } catch (err) {
      hud.overlay(labels.unsupported, String(err && err.message ? err.message : err));
      return;
    }
    camera = createCameraRig(renderer.camera, world, options.camera || {});
    ready = true;
    if (status === 'connected') hud.hideOverlay();
    renderer.engine.runRenderLoop(frame);
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    if (renderer) renderer.resize();
    else tryCreateRenderer();
  }) : null;
  if (ro) ro.observe(mount);
  window.addEventListener('resize', () => { if (renderer) renderer.resize(); else tryCreateRenderer(); });

  // ---- join ---------------------------------------------------------------
  async function join() {
    try {
      hud.overlay(labels.connecting, labels.loading);
      await net.join();
      if (ready) hud.hideOverlay();
    } catch (err) {
      const code = err && err.code;
      const message = code === 'WORLD_FULL' ? labels.worldFull
        : code === 'MATCH_TIMEOUT' ? labels.matchTimeout
          : labels.connectFailed;
      hud.overlay(message, '', labels.retry, join);
    }
  }
  join();

  // ---- input --------------------------------------------------------------
  const inputTimer = setInterval(() => {
    if (!net.joined || !ready) return;
    const input = controls.sample();
    net.sendInput({
      mx: round2(input.mx), mz: round2(input.mz),
      aim: round2(input.aim),
      jump: input.jump, sprint: input.sprint, dive: input.dive,
      throttle: round2(input.throttle), steer: round2(input.steer),
      handbrake: input.handbrake,
      fire: input.fire, use: input.use,
      aimX: round2(input.aimX), aimY: round2(input.aimY), aimZ: round2(input.aimZ),
      weapon: input.weapon || undefined,
    });
  }, Math.round(1000 / INPUT_HZ));

  // ---- frame --------------------------------------------------------------
  let lastFrame = performance.now();
  const selfView = {};

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000) || 0.016;
    lastFrame = now;

    // World time drives every hazard on both sides; nudge toward the server's
    // clock rather than snapping, so platforms never stutter.
    const globalState = net.global;
    if (globalState && typeof globalState.t === 'number') worldTimeTarget = globalState.t;
    worldTime += dt;
    if (worldTimeTarget) {
      const drift = worldTimeTarget - worldTime;
      if (Math.abs(drift) > 1.5) worldTime = worldTimeTarget;
      else worldTime += drift * Math.min(1, dt * 2);
    }
    updateMovers(world.movers, worldTime);

    const input = controls.sample();
    predictor.step(input, dt);
    const me = predictor.view(selfView);

    const view = net.getView(now);
    const meId = net.meId;
    for (let i = 0; i < view.length; i++) {
      const e = view[i];
      if (e.id === meId) {
        if (!me.driving) { e.wx = me.x; e.wy = me.y; e.wz = me.z; e.a = me.yaw; }
      } else if (predictor.driving && e.id === predictor.car.id) {
        e.wx = me.x; e.wy = me.y; e.wz = me.z; e.a = me.yaw;
      }
    }

    camera.update(me, controls.look, dt);
    renderer.render({
      entities: view,
      meId,
      hideId: null,
      movers: world.movers,
      time: worldTime,
      dt,
    });

    updateHud(view, meId, now);
    if (options.onFrame) options.onFrame({ dt, me, view, world });
  }

  // ---- HUD ----------------------------------------------------------------
  function updateHud(view, meId, now) {
    hud.tickToasts(now);
    const self = net.getEntity(meId);
    if (self) {
      hud.setHealth(self.hp ?? 100);
      hud.setWeapon(self.w, null);
    }
    hud.setSpeed(predictor.driving ? predictor.view(selfView).speed * 3.6 : null);

    const globalState = net.global;
    if (globalState) {
      hud.setBoard(globalState.board || [], meId);
      const objective = (options.objective || defaultObjective)(globalState.m, labels, { self, view });
      if (objective) hud.setObjective(objective.title, objective.seconds, objective.sub);
    }
    hud.drawMap({
      bounds: manifest.bounds,
      checkpoints: manifest.checkpoints,
      entities: view,
      me: view.find(e => e.id === meId),
    });
  }

  function handleEvents(list) {
    for (const ev of list) {
      if (ev.e === 'shot' && renderer && typeof ev.ex === 'number') {
        renderer.addTracer(ev.x, ev.h, ev.y, ev.ex, ev.eh, ev.ey);
      } else if (ev.e === 'kill') {
        const victim = net.getEntity(ev.v);
        const killer = ev.k ? net.getEntity(ev.k) : null;
        if (victim && killer) {
          hud.toast(format(labels.killed, { killer: killer.n, victim: victim.n }));
        }
      } else if (ev.e === 'qualify' && ev.p === net.meId) {
        hud.toast(labels.youQualified);
      } else if (ev.e === 'finish' && ev.p === net.meId) {
        hud.toast(format(labels.youFinished, { place: format(labels.place, { n: ev.pl }) }));
      }
      if (options.onEvent) options.onEvent(ev);
    }
  }

  function destroy() {
    clearInterval(inputTimer);
    ro?.disconnect();
    controls.destroy();
    hud.destroy();
    renderer?.dispose();
  }

  return {
    get net() { return net; },
    get world() { return world; },
    get manifest() { return manifest; },
    get predictor() { return predictor; },
    hud,
    controls,
    destroy,
  };
}

/** Default objective line for the built-in modes. */
function defaultObjective(modeState, labels, extra) {
  if (!modeState) return null;
  const phase = labels.phases[modeState.phase] || modeState.phase;
  let sub = '';
  // Lap counters only mean something while a race is actually running.
  if (modeState.laps && extra.self && modeState.phase === 'racing') {
    sub = format(labels.lapOf, { n: Math.min(modeState.laps, (extra.self.lap || 0) + 1), total: modeState.laps });
  } else if (modeState.quota) {
    sub = format(labels.qualified, { n: modeState.qualified || 0, quota: modeState.quota });
  }
  return { title: phase, seconds: modeState.left, sub };
}

function format(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] != null ? values[key] : ''));
}

function mergeLabels(base, extra) {
  const out = { ...base, ...extra };
  out.phases = { ...base.phases, ...(extra.phases || {}) };
  out.weapons = { ...base.weapons, ...(extra.weapons || {}) };
  return out;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

export { createRenderer, createControls, createHud, createCameraRig, createNetClient, createPredictor };
