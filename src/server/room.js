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
   */
  constructor(opts) {
    this.roomId = opts.roomId;
    this.log = opts.log || (() => {});
    this.worldSpec = opts.worldSpec;
    this.tickHz = opts.tickHz ?? 30;
    this.snapshotHz = opts.snapshotHz ?? 15;
    this.aoiRadius = opts.aoiRadius ?? 140;
    this.maxPlayers = opts.maxPlayers ?? 200;
    this.world = buildWorld(opts.manifest);
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
    this._ticksPerSnapshot = Math.max(1, Math.round(this.tickHz / this.snapshotHz));
    this._maxDt = 0.25;
    const tickMs = Math.round(1000 / this.tickHz);
    this._tickTimer = setInterval(() => this._tick(), tickMs);
    this._tickTimer.unref?.();
  }

  get playerIds() { return Array.from(this.players.keys()); }
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
    } else {
      this.players.set(userId, { id: userId, name, sessionId, ws, lastKeyframeAt: 0 });
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

  removePlayer(userId, expectedWs, reason) {
    const player = this.players.get(userId);
    if (!player) return false;
    if (expectedWs && player.ws !== expectedWs) return false;
    this.players.delete(userId);
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
  }

  // ── internals ──────────────────────────────────────────────────────────

  _tick() {
    const now = Date.now();
    const dt = Math.min(this._maxDt, Math.max(0, (now - this._lastTickAt) / 1000) || (1 / this.tickHz));
    this._lastTickAt = now;

    this.sim.step(dt);

    this._tickCount += 1;
    if (this._tickCount % this._ticksPerSnapshot === 0) this._snapshotPhase(now);
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
      const slice = { world: global };
      let removed = removedIds ? removedIds.slice() : [];
      if (self) {
        const { left, visible } = this.grid.observe(player.id, self.x, self.z, this.aoiRadius);
        for (const id of visible) {
          const e = entities[id];
          if (e) slice[id] = e;
        }
        slice[player.id] = entities[player.id];
        if (left.length) removed = [...new Set([...removed, ...left])];
      }
      sendFrame(player.ws, 'state_snapshot', {
        seq: this.seq,
        t: now,
        entities: slice,
        removed,
        events: [],
        you: player.id,
        ack: self ? self.lastSeq : 0,
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
    const slice = { world: this.sim.projectGlobal() };
    if (self) {
      for (const id of this.grid.query(self.x, self.z, this.aoiRadius)) {
        if (entities[id]) slice[id] = entities[id];
      }
      if (entities[userId]) slice[userId] = entities[userId];
    }
    return {
      seq: this.seq,
      t: Date.now(),
      entities: slice,
      removed: [],
      events: [],
      you: userId,
      ack: self ? self.lastSeq : 0,
      keyframe: true,
    };
  }

  _broadcast(type, payload) {
    for (const player of this.players.values()) sendFrame(player.ws, type, payload);
  }

  _broadcastExcept(excludeId, type, payload) {
    for (const player of this.players.values()) {
      if (player.id !== excludeId) sendFrame(player.ws, type, payload);
    }
  }
}
