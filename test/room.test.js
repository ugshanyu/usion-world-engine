import { describe, it, expect, afterEach } from 'vitest';
import { WorldRoom, diffEntity } from '../src/server/room.js';
import { boxAt } from '../src/core/collision.js';

const MANIFEST = {
  id: 'room-test',
  bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  spawns: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: -4, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }],
  solids: [boxAt(0, 0, 40, 10, 3, 1)],
};

const rooms = [];
function makeRoom(opts = {}) {
  const room = new WorldRoom({ roomId: 'r', manifest: MANIFEST, worldSpec: { manifest: MANIFEST }, ...opts });
  clearInterval(room._tickTimer);            // tests drive ticks by hand
  rooms.push(room);
  return room;
}
afterEach(() => { while (rooms.length) rooms.pop().destroy(); });

function fakeSocket() {
  const frames = [];
  return {
    frames,
    readyState: 1,
    send(raw) { frames.push(JSON.parse(raw)); },
    close() { this.readyState = 3; },
    snapshots() { return frames.filter(f => f.type === 'state_snapshot').map(f => f.payload); },
  };
}

function session(id) { return { userId: id, name: id.toUpperCase(), sessionId: 's-' + id }; }

/** Pretend `ms` of wall time passed, then run the room's tick. */
function elapse(room, ms) {
  room._lastTickAt -= ms;
  room._tick();
}

describe('room — fixed step', () => {
  it('advances the simulation in whole fixed ticks, catching up after a late timer', () => {
    const room = makeRoom({ tickHz: 30 });
    const before = room.sim.state.tick;
    elapse(room, 100);                       // 3 ticks of 33.3 ms
    expect(room.sim.state.tick - before).toBe(3);
    expect(room.sim.state.t).toBeCloseTo(3 / 30, 9);
  });

  it('runs at most 5 ticks after a long stall instead of spiralling', () => {
    const room = makeRoom({ tickHz: 30 });
    const before = room.sim.state.tick;
    elapse(room, 2000);
    expect(room.sim.state.tick - before).toBe(5);
    elapse(room, 0);
    expect(room.sim.state.tick - before).toBe(5);   // the backlog was dropped, not queued
  });
});

describe('room — reconnect grace', () => {
  it('keeps a dropped player in place and re-attaches them on reconnect', () => {
    const room = makeRoom({ graceMs: 15_000 });
    const ws1 = fakeSocket();
    room.admit(session('a'), ws1);
    const body = room.sim.getPlayer('a');
    body.x = 7; body.z = -3;

    room.disconnectPlayer('a', ws1);
    expect(room.sim.getPlayer('a')).toBe(body);
    expect(room.playerCount).toBe(1);
    elapse(room, 500);
    expect(room.sim.getPlayer('a')).toBe(body);   // still there inside the grace

    const ws2 = fakeSocket();
    const res = room.admit(session('a'), ws2);
    expect(res.reconnect).toBe(true);
    expect(room.sim.getPlayer('a')).toBe(body);
    const keyframe = ws2.snapshots().find(sn => sn.keyframe);
    expect(keyframe.me.x).toBeCloseTo(7, 1);
  });

  it('removes the player once the grace runs out', () => {
    const room = makeRoom({ graceMs: 1000 });
    const ws = fakeSocket();
    room.admit(session('a'), ws);
    room.disconnectPlayer('a', ws);
    room.players.get('a').disconnectedAt = Date.now() - 1500;
    elapse(room, 34);
    expect(room.sim.getPlayer('a')).toBeUndefined();
    expect(room.playerCount).toBe(0);
  });

  it('ignores a stale socket closing after a newer one took over', () => {
    const room = makeRoom();
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    room.admit(session('a'), ws1);
    room.admit(session('a'), ws2);
    expect(room.disconnectPlayer('a', ws1)).toBe(false);
    expect(room.players.get('a').ws).toBe(ws2);
  });
});

describe('room — snapshots', () => {
  it('sends only changed fields after the first sight of an entity', () => {
    const room = makeRoom({ tickHz: 30, snapshotHz: 15 });
    const wa = fakeSocket();
    room.admit(session('a'), wa);
    room.admit(session('b'), fakeSocket());
    elapse(room, 67);                        // first broadcast snapshot
    elapse(room, 67);                        // nobody moved
    const snaps = wa.snapshots().filter(sn => !sn.keyframe);
    const last = snaps[snaps.length - 1];
    expect(last.entities.b).toBeUndefined();     // unchanged → not sent at all
    expect(last.entities.world).toBeDefined();  // the global entity always goes
    expect(last.me).toMatchObject({ ak: 0 });

    room.sim.getPlayer('b').x += 3;
    elapse(room, 67);
    const moved = wa.snapshots().pop();
    expect(Object.keys(moved.entities.b)).toEqual(['x']);
  });

  it('caps what each player receives to the nearest entities', () => {
    const room = makeRoom({ maxEntities: 3 });
    const wa = fakeSocket();
    room.admit(session('a'), wa);
    for (const id of ['b', 'c', 'd', 'e', 'f']) room.admit(session(id), fakeSocket());
    ['b', 'c', 'd', 'e', 'f'].forEach((id, i) => { room.sim.getPlayer(id).x = 5 + i * 5; });
    elapse(room, 67);
    elapse(room, 67);
    const keyframe = { ...wa.snapshots().find(sn => sn.keyframe).entities };
    for (const sn of wa.snapshots()) Object.assign(keyframe, sn.entities);
    const visible = [...room.players.get('a').sent.keys()];
    expect(visible.length).toBe(3);
    expect(visible).toContain('a');
    expect(visible).toContain('b');                     // nearest
    expect(visible).not.toContain('f');                 // farthest dropped
  });

  it('diffEntity reports changed and cleared fields only', () => {
    expect(diffEntity(undefined, { k: 'p', x: 1 })).toEqual({ k: 'p', x: 1 });
    expect(diffEntity({ k: 'p', x: 1 }, { k: 'p', x: 1 })).toBeNull();
    expect(diffEntity({ k: 'p', x: 1, v: 'car' }, { k: 'p', x: 2 })).toEqual({ x: 2, v: null });
  });
});
