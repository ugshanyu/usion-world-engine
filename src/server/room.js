/**
 * One world room: roster, fixed-tick simulation, AOI snapshot fan-out.
 *
 * Rooms are keyed by the token's `room_id` — the PLATFORM owns membership
 * (joinWorld placement and capacity); this server accepts any valid token for
 * its service and keeps a roster of live connections. Many worlds run side by
 * side in one process.
 *
 * Snapshot payloads match the platform rooms runtime exactly
 * (`{seq, t, entities, removed, events, you, keyframe?}`, position-less
 * entities global to everyone), so the same client code works whether the
 * game is developer-hosted or platform-hosted.
 */
import { buildWorld } from '../core/world.js';
import { createSimulation } from '../core/sim.js';
import { createInterestGrid } from '../core/interest.js';
import { sendFrame } from './net.js';

const KEYFRAME_MIN_INTERVAL_MS = 1000;
const MAX_CATCH_UP_STEPS = 5;          // after a stall, run at most this many ticks at once
const DEFAULT_GRACE_MS = 15_000;       // matches the platform's reconnect grace
const DEFAULT_MAX_ENTITIES = 96;       // per-observer cap: the nearest N are sent

export class WorldRoom {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {object} opts.manifest      world manifest (already generated)
   * @param {object} opts.worldSpec     the tiny spec clients regenerate from
   * @param {object} opts.mode          resolved game mode
   * @param {object} [opts.simConfig]
   * @param {number} [opts.tickHz=30]
   * @param {number} [opts.snapshotHz=15]
   * @param {number} [opts.aoiRadius=140]
   * @param {number} [opts.maxPlayers=200]
   * @param {object} [opts.rapier]      initialised RAPIER → Rapier physics backend
   * @param {number} [opts.graceMs=15000] how long a dropped player keeps their place
   * @param {number} [opts.maxEntities=96] per-observer entity cap
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.log = opts.log || (() => {});
    this.worldSpec = opts.worldSpec;
    this.tickHz = opts.tickHz ?? 30;
    this.snapshotHz = opts.snapshotHz ?? 15;
    this.aoiRadius = opts.aoiRadius ?? 140;
    this.maxPlayers = opts.maxPlayers ?? 200;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;
    this._dt = 1 / this.tickHz;
    this.world = buildWorld(opts.manifest, { rapier: opts.rapier, dt: this._dt });
    this.sim = createSimulation({
      world: this.world,
      mode: opts.mode,
      config: { ...(opts.simConfig || {}), tickHz: this.tickHz },
      seed: opts.seed ?? 12345,
    });
    this.grid = createInterestGrid({ cellSize: Math.max(32, Math.round(this.aoiRadius / 2)) });

    /** @type {Map<string, {id, name, sessionId, ws, lastKeyframeAt}>} */
    this.players = new Map();
    this.seq = 0;                 // advances exactly ONCE per snapshot tick
    this.emptySince = Date.now();
    this._knownIds = new Set();
    this._pendingRemoved = new Set();
    this._tickCount = 0;
    this._lastTickAt = Date.now();
    this._acc = 0;
    this._ticksPerSnapshot = Math.max(1, Math.round(this.tickHz / this.snapshotHz));
    const tickMs = Math.round(1000 / this.tickHz);
    this._tickTimer = setInterval(() => this._tick(), tickMs);
    this._tickTimer.unref?.();
  }

  get playerIds() { return Array.from(this.players.keys()); }
  /** Everyone holding a place, including players inside their reconnect grace. */
  get playerCount() { return this.players.size; }

  /** Admit (or re-attach) an authenticated player. */
  admit(session, ws) {
    const { userId, name, sessionId } = session;
    const existing = this.players.get(userId);
    if (!existing && this.players.size >= this.maxPlayers) {
      return { ok: false, code: 'WORLD_FULL' };
    }
    if (existing) {
      if (existing.ws && existing.ws !== ws && existing.ws.readyState === 1) {
        try { existing.ws.close(4409, 'superseded by a newer connection'); } catch { /* gone */ }
      }
      existing.ws = ws;
      existing.sessionId = sessionId;
      existing.disconnectedAt = 0;
      existing.sent = new Map();             // the keyframe below resets their view
    } else {
      this.players.set(userId, {
        id: userId, name, sessionId, ws, lastKeyframeAt: 0, disconnectedAt: 0, sent: new Map(),
      });
      const p = this.sim.addPlayer(userId, name);
      this.grid.upsert(userId, p.x, p.z);
    }
    this.emptySince = null;

    const player = this.players.get(userId);
    // The joined ack AND the join keyframe REUSE the current seq: no unicast
    // frame may consume the broadcast counter, or every other observer sees a
    // phantom gap and asks for a keyframe of their own, forever.
    sendFrame(ws, 'joined', {
      room_id: this.roomId,
      player_id: userId,
      player_ids: this.playerIds,
      seq: this.seq,
      max_players: this.maxPlayers,
      protocol_version: '2',
      server_t: Date.now(),
      engine: 'usion-world',
      world: this.worldSpec,
      mode: this.sim.mode ? { id: this.sim.mode.id, name: this.sim.mode.name } : null,
      sim_hz: this.tickHz,
      snapshot_hz: this.snapshotHz,
      physics: this.world.physics ? 'rapier' : 'arcade',
      aoi_radius: this.aoiRadius,
    });
    sendFrame(ws, 'state_snapshot', this._buildKeyframe(userId));
    player.lastKeyframeAt = Date.now();

    if (!existing) {
      this._broadcastExcept(userId, 'player_joined', {
        room_id: this.roomId, player_id: userId, player_name: name, player_ids: this.playerIds,
      });
      this.log('info', 'player joined world', { room: this.roomId, user: userId, players: this.players.size });
    }
    return { ok: true, reconnect: !!existing };
  }

  /**
   * A socket dropped. Keep the player's place (and body, standing still) for
   * `graceMs` so a phone blinking between networks lands back in the same
   * spot with the same progress; remove only if they never come back.
   */
  disconnectPlayer(userId, expectedWs) {
    const player = this.players.get(userId);
    if (!player) return false;
    if (expectedWs && player.ws !== expectedWs) return false;
    if (this.graceMs <= 0) return this.removePlayer(userId, expectedWs, 'disconnected');
    player.ws = null;
    player.disconnectedAt = Date.now();
    this.sim.clearInput(userId);
    this.log('info', 'player disconnected (grace)', { room: this.roomId, user: userId, grace_ms: this.graceMs });
    return true;
  }

  removePlayer(userId, expectedWs, reason) {
    const player = this.players.get(userId);
    if (!player) return false;
    if (expectedWs && player.ws !== expectedWs) return false;
    this.players.delete(userId);
    for (const other of this.players.values()) other.sent.delete(userId);
    this.sim.removePlayer(userId);
    this.grid.remove(userId);
    this.grid.dropObserver(userId);
    this._pendingRemoved.add(userId);
    this._knownIds.delete(userId);
    this._broadcast('player_left', {
      room_id: this.roomId, player_id: userId, player_ids: this.playerIds, reason: reason || 'left',
    });
    if (this.players.size === 0) this.emptySince = Date.now();
    this.log('info', 'player left world', { room: this.roomId, user: userId, reason, players: this.players.size });
    return true;
  }

  /** Route a validated client action/input into the simulation. */
  handleInput(userId, payload) {
    const type = String(payload.action_type || payload.type || '');
    const data = payload.action_data && typeof payload.action_data === 'object' ? payload.action_data : {};
    if (type === 'input' || type === 'i') {
      this.sim.setInput(userId, data);
      return;
    }
    if (this.onCustomInput) this.onCustomInput(userId, type, data);
  }

  /** SDK resync (`ping {last_sequence}`): unicast keyframe at the CURRENT seq. */
  sendResyncKeyframe(userId, lastSequence) {
    const player = this.players.get(userId);
    if (!player) return;
    if (lastSequence >= this.seq) return;      // already up to date
    const now = Date.now();
    if (now - player.lastKeyframeAt < KEYFRAME_MIN_INTERVAL_MS) return;
    player.lastKeyframeAt = now;
    sendFrame(player.ws, 'state_snapshot', this._buildKeyframe(userId));
  }

  destroy(code = 1001, reason = 'world closed') {
    clearInterval(this._tickTimer);
    for (const player of this.players.values()) {
      try { player.ws?.close(code, reason); } catch { /* gone */ }
    }
    this.players.clear();
    this.world.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Fixed-step loop. Timers fire late and unevenly, so real time accumulates
   * and the simulation always advances in exact 1/tickHz steps — the same
   * steps a phone replays when it predicts. After a long stall we catch up a
   * few ticks and drop the rest rather than spiralling.
   */
  _tick() {
    const now = Date.now();
    this._acc += Math.max(0, now - this._lastTickAt) / 1000;
    this._lastTickAt = now;
    let steps = 0;
    let snapshotDue = false;
    while (this._acc >= this._dt && steps < MAX_CATCH_UP_STEPS) {
      this.sim.step(this._dt);
      this._acc -= this._dt;
      steps += 1;
      this._tickCount += 1;
      if (this._tickCount % this._ticksPerSnapshot === 0) snapshotDue = true;
    }
    if (steps === MAX_CATCH_UP_STEPS && this._acc >= this._dt) this._acc = 0;
    if (snapshotDue) this._snapshotPhase(now);
    this._sweepGrace(now);
  }

  _sweepGrace(now) {
    for (const player of this.players.values()) {
      if (player.disconnectedAt && now - player.disconnectedAt > this.graceMs) {
        this.removePlayer(player.id, null, 'timeout');
      }
    }
  }

  _snapshotPhase(now) {
    this.seq += 1;                             // the only place the counter moves
    const entities = this.sim.projectEntities();
    const global = this.sim.projectGlobal();

    // Track deletions globally (a bullet that hit, a pickup that was taken).
    const nextIds = new Set(Object.keys(entities));
    for (const id of this._knownIds) if (!nextIds.has(id)) this._pendingRemoved.add(id);
    this._knownIds = nextIds;

    for (const id in entities) {
      const e = entities[id];
      this.grid.upsert(id, e.x, e.y);
    }
    const removedIds = this._pendingRemoved.size ? [...this._pendingRemoved] : null;
    for (const id of this._pendingRemoved) this.grid.remove(id);
    this._pendingRemoved = new Set();

    const events = this.sim.drainEvents();

    for (const player of this.players.values()) {
      if (!player.ws || player.ws.readyState !== 1) continue;
      const self = this.sim.getPlayer(player.id);
      let visibleIds = [];
      let removed = removedIds ? removedIds.slice() : [];
      if (self) {
        const { left, visible } = this.grid.observe(player.id, self.x, self.z, this.aoiRadius);
        visibleIds = this._nearest(visible, entities, self, player.id);
        if (left.length) removed = [...new Set([...removed, ...left])];
      }
      // Only what changed since this player last heard about it.
      const slice = { world: global };
      const seen = new Set();
      for (const id of visibleIds) {
        seen.add(id);
        const diff = diffEntity(player.sent.get(id), entities[id]);
        if (diff) slice[id] = diff;
        player.sent.set(id, entities[id]);
      }
      // Entities that fell out of the capped set count as removed for them.
      for (const id of player.sent.keys()) {
        if (!seen.has(id)) { player.sent.delete(id); if (!removed.includes(id)) removed.push(id); }
      }
      sendFrame(player.ws, 'state_snapshot', {
        seq: this.seq,
        t: now,
        entities: slice,
        removed,
        events: [],
        you: player.id,
        ack: self ? self.lastSeq : 0,
        me: self ? this.sim.projectSelf(player.id) : null,
      });
      if (events.length) {
        const mine = events.filter(ev => this._eventVisible(ev, self));
        if (mine.length) {
          // Unicast event frames REUSE the current seq — never advance it.
          sendFrame(player.ws, 'state_delta', { seq: this.seq, event: 'ev', data: { list: mine } });
        }
      }
    }
  }

  /** The observer itself plus the nearest visible entities, capped at maxEntities. */
  _nearest(visible, entities, self, selfId) {
    const ids = [];
    for (const id of visible) if (entities[id] && id !== selfId) ids.push(id);
    if (ids.length > this.maxEntities - 1) {
      const d = (id) => { const e = entities[id]; const dx = e.x - self.x; const dz = e.y - self.z; return dx * dx + dz * dz; };
      ids.sort((a, b) => d(a) - d(b));
      ids.length = this.maxEntities - 1;
    }
    if (entities[selfId]) ids.push(selfId);
    return ids;
  }

  /** Events with a position are area-of-interest filtered like entities. */
  _eventVisible(ev, self) {
    if (!self) return !ev.x;
    if (typeof ev.x !== 'number' || typeof ev.y !== 'number') return true;
    const dx = ev.x - self.x;
    const dz = ev.y - self.z;
    const r = this.aoiRadius * 1.3;
    return dx * dx + dz * dz <= r * r;
  }

  _buildKeyframe(userId) {
    const entities = this.sim.projectEntities();
    const self = this.sim.getPlayer(userId);
    const player = this.players.get(userId);
    const slice = { world: this.sim.projectGlobal() };
    if (player) player.sent = new Map();
    if (self) {
      const ids = this._nearest(this.grid.query(self.x, self.z, this.aoiRadius), entities, self, userId);
      for (const id of ids) {
        slice[id] = entities[id];
        if (player) player.sent.set(id, entities[id]);
      }
    }
    return {
      seq: this.seq,
      t: Date.now(),
      entities: slice,
      removed: [],
      events: [],
      you: userId,
      ack: self ? self.lastSeq : 0,
      me: self ? this.sim.projectSelf(userId) : null,
      keyframe: true,
    };
  }

  _broadcast(type, payload) {
    // (players inside their reconnect grace have no socket; sendFrame skips them)
    for (const player of this.players.values()) sendFrame(player.ws, type, payload);
  }

  _broadcastExcept(excludeId, type, payload) {
    for (const player of this.players.values()) {
      if (player.id !== excludeId) sendFrame(player.ws, type, payload);
    }
  }
}

/**
 * Fields of `next` that differ from `prev` (entities are flat objects of
 * primitives). A new entity is sent whole; an unchanged one not at all.
 */
export function diffEntity(prev, next) {
  if (!next) return null;
  if (!prev || prev.k !== next.k) return next;
  let out = null;
  for (const key in next) {
    if (prev[key] !== next[key]) (out || (out = {}))[key] = next[key];
  }
  for (const key in prev) {
    if (!(key in next)) (out || (out = {}))[key] = null;     // field cleared (e.g. left a vehicle)
  }
  return out;
}
