/**
 * Network client — join, snapshot store, interpolation.
 *
 * Handles both transports without the game noticing: a platform-hosted room
 * and a developer-run direct server send the identical
 * `{seq, t, entities, removed, you, keyframe}` frames, and both deliver
 * creator events as `{event, data}`.
 *
 * Remote entities are interpolated in the ARRIVAL-TIME domain (render ~100 ms
 * in the past), which needs no clock sync and survives the jitter of a mobile
 * network. The local player is predicted instead — see predict.js.
 */
import { angleDelta } from '../core/math.js';

const RESERVED_EVENTS = new Set(['idle', 'heartbeat']);

export function createNetClient(options = {}) {
  const Usion = options.Usion || (typeof window !== 'undefined' ? window.Usion : null);
  if (!Usion) throw new Error('createNetClient: the Usion SDK is required');
  const bufferMs = options.bufferMs ?? 110;

  const entities = new Map();          // id → {k, prev, curr, ...fields}
  let meId = null;
  let lastSeq = null;
  let lastResyncAt = 0;
  let worldInfo = null;
  let joined = false;

  const handlers = {
    onWorld: options.onWorld || (() => {}),
    onEvents: options.onEvents || (() => {}),
    onSelf: options.onSelf || (() => {}),
    onStatus: options.onStatus || (() => {}),
  };

  function reset() {
    entities.clear();
    lastSeq = null;
  }

  function applySnapshot(m) {
    if (m.keyframe) {
      reset();
      lastSeq = m.seq;
    } else if (typeof m.seq === 'number') {
      // A gap means real missed ticks: a `removed` we never saw would leave
      // ghosts behind, so ask for one keyframe (throttled — it costs a slice).
      if (lastSeq !== null && m.seq > lastSeq + 1) requestResync();
      if (lastSeq === null || m.seq > lastSeq) lastSeq = m.seq;
    }
    if (m.you) meId = m.you;

    const now = performance.now();
    const incoming = m.entities || {};
    for (const id in incoming) {
      const data = incoming[id];
      if (id === 'world') { handleGlobal(data); continue; }
      let e = entities.get(id);
      if (!e) {
        e = {
          id, k: data.k,
          prev: { t: now, x: data.x, y: data.y, h: data.h, a: data.a || 0 },
          curr: { t: now, x: data.x, y: data.y, h: data.h, a: data.a || 0 },
        };
        entities.set(id, e);
      } else {
        e.prev = e.curr;
        // Unwrap the angle so interpolation always takes the shortest arc.
        const a = e.prev.a + angleDelta(e.prev.a, data.a || 0);
        e.curr = { t: now, x: data.x, y: data.y, h: data.h, a };
      }
      Object.assign(e, data);
    }
    const removed = m.removed || [];
    // AOI churn is normal: ids enter and leave the visible slice constantly.
    for (let i = 0; i < removed.length; i++) entities.delete(removed[i]);

    if (meId) {
      const self = entities.get(meId);
      if (self) handlers.onSelf(self, m);
    }
  }

  let globalState = null;
  function handleGlobal(data) {
    globalState = data;
  }

  function requestResync() {
    const now = Date.now();
    if (now - lastResyncAt < 2000) return;
    lastResyncAt = now;
    Usion.game.requestSync(lastSeq || 0);
  }

  function onRealtime(m) {
    if (!m) return;
    if (typeof m.event === 'string') {
      if (RESERVED_EVENTS.has(m.event)) return;
      if (m.event === 'world') { worldInfo = m.data; handlers.onWorld(m.data); return; }
      if (m.event === 'ev' && m.data && Array.isArray(m.data.list)) { handlers.onEvents(m.data.list); return; }
      return;
    }
    if (!m.entities && !m.removed) return;
    applySnapshot(m);
  }

  /**
   * Interpolated view of every visible entity, in WORLD space.
   * Network fields are `x` (world X), `y` (world Z) and `h` (height); the
   * view exposes them as `wx`, `wy`, `wz` so renderer code reads naturally.
   */
  const view = [];
  function getView(now = performance.now()) {
    const renderT = now - bufferMs;
    view.length = 0;
    for (const e of entities.values()) {
      const span = e.curr.t - e.prev.t;
      let alpha = span > 0 ? (renderT - e.prev.t) / span : 1;
      alpha = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
      e.wx = e.prev.x + (e.curr.x - e.prev.x) * alpha;
      e.wz = e.prev.y + (e.curr.y - e.prev.y) * alpha;
      e.wy = e.prev.h + (e.curr.h - e.prev.h) * alpha;
      e.a = e.prev.a + (e.curr.a - e.prev.a) * alpha;
      view.push(e);
    }
    return view;
  }

  function getEntity(id) {
    return entities.get(id);
  }

  /** joinWorld() → connectDirect(), with the SDK's stable error codes. */
  async function join() {
    handlers.onStatus('connecting');
    await Usion.game.joinWorld();
    await Usion.game.connectDirect();
    joined = true;
    handlers.onStatus('connected');
  }

  function attach() {
    Usion.game.onRealtime(onRealtime);
    Usion.game.onPlayerJoined(() => { /* roster churn is normal; AOI reveals them */ });
    Usion.game.onPlayerLeft(() => { /* entity removal arrives via snapshots */ });
    Usion.game.onDisconnect(() => { joined = false; handlers.onStatus('disconnected'); });
    Usion.game.onReconnect(() => { joined = true; handlers.onStatus('connected'); });
    Usion.game.onError((err) => handlers.onStatus('error', err));
    // A direct-mode `joined` frame carries the world spec; the SDK surfaces it.
    if (Usion.game.onJoined) {
      Usion.game.onJoined((data) => {
        if (data && data.world) { worldInfo = data; handlers.onWorld(data); }
      });
    }
  }

  let inputSeq = 0;
  function sendInput(input) {
    if (!joined) return;
    inputSeq += 1;
    input.seq = inputSeq;
    Usion.game.realtime('input', input);
    return inputSeq;
  }

  return {
    attach,
    join,
    onRealtime,
    getView,
    getEntity,
    sendInput,
    reset,
    get meId() { return meId; },
    get joined() { return joined; },
    get inputSeq() { return inputSeq; },
    get global() { return globalState; },
    get worldInfo() { return worldInfo; },
  };
}
