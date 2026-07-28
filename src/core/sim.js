/**
 * The simulation — one authoritative world tick.
 *
 * This is the piece the server runs as truth and the client re-runs to
 * predict the local player. It owns players, vehicles, projectiles, pickups
 * and the interaction between them; the *rules* (who scores, when a round
 * ends) live in a mode object so creators never fork this file.
 *
 * Network entity convention (matters — the platform's area-of-interest grid
 * slices on `x`/`y`):
 *   x = world X, y = world Z (the ground plane), h = world Y (height).
 */
import { clamp, q, distSq2, wrapAngle } from './math.js';
import { createRng } from './rng.js';
import { CHARACTER, spawnCharacter, stepCharacter, applyImpulse, resolvePlayerPush } from './character.js';
import {
  VEHICLE, createVehicle, stepVehicle, resolveVehiclePair, respawnVehicle, getSpec, seatPosition,
} from './vehicle.js';
import {
  WEAPONS, getWeapon, resetLoadout, giveWeapon, canFire, traceShot, muzzleOf,
  normalizeAim, damageAt, stepProjectiles,
} from './combat.js';
import { atCheckpoint } from './world.js';

export const SIM_DEFAULTS = {
  tickHz: 30,
  respawnDelay: 4,
  vehicleRespawnDelay: 20,
  vehicleIdleReset: 90,      // abandoned far from home → returns after this
  friendlyFire: false,
  fallDamage: true,
  startWeapons: ['shove'],
  maxProjectiles: 120,
  pickupRespawn: 20,
  eventBudget: 60,           // per-tick cap on broadcast events
};

const ZERO_INPUT = { mx: 0, mz: 0, aim: undefined, jump: false, sprint: false, dive: false };
const tmpSeat = { x: 0, y: 0, z: 0 };
const tmpMuzzle = { x: 0, y: 0, z: 0 };
const tmpAim = { x: 0, y: 0, z: 0 };

export function createSimulation(options) {
  const world = options.world;
  const config = { ...SIM_DEFAULTS, ...(options.config || {}) };
  const mode = options.mode || null;
  const rng = options.rng || createRng(options.seed ?? 12345);

  const state = {
    t: 0,
    tick: 0,
    players: {},
    vehicles: {},
    projectiles: [],
    pickups: {},
    mode: {},
  };

  let events = [];
  let nextProjectileId = 1;
  const playerList = [];
  const vehicleList = [];
  const traceCtx = { collision: world.collision, players: playerList, vehicles: vehicleList };

  // Parked vehicles come from the manifest and live for the world's lifetime.
  (world.vehicleSpawns || []).forEach((vs, i) => {
    const id = vs.id || ('veh' + i);
    state.vehicles[id] = createVehicle(id, vs.kind || 'sedan', vs.x, vs.y ?? 0, vs.z, vs.yaw || 0);
  });
  (world.pickups || []).forEach((pk) => {
    state.pickups[pk.id] = { id: pk.id, ready: true, readyAt: 0 };
  });
  refreshLists();

  function refreshLists() {
    playerList.length = 0;
    for (const id in state.players) playerList.push(state.players[id]);
    vehicleList.length = 0;
    for (const id in state.vehicles) vehicleList.push(state.vehicles[id]);
  }

  function emit(event) {
    if (events.length < config.eventBudget) events.push(event);
  }

  // ---------------------------------------------------------------- players

  function addPlayer(id, name, extra) {
    const spawn = world.pickSpawn(playerList.filter(p => p.hp > 0), extra && extra.spawnTag, rng);
    const p = {
      id,
      name: name || 'Player',
      team: (extra && extra.team) || null,
      hp: 100,
      maxHp: 100,
      score: 0,
      kills: 0,
      deaths: 0,
      deadUntil: 0,
      joinedAt: state.t,
      lastSeq: 0,
      input: { ...ZERO_INPUT },
      firing: false,
      pendingFallDamage: 0,
      pendingHazardDamage: 0,
      lap: 0,
      nextCp: 0,
      cpTime: 0,
    };
    spawnCharacter(p, spawn);
    resetLoadout(p, config.startWeapons);
    state.players[id] = p;
    refreshLists();
    if (mode && mode.onJoin) mode.onJoin(api, p);
    if (mode && mode.onSpawn) mode.onSpawn(api, p);
    return p;
  }

  function removePlayer(id) {
    const p = state.players[id];
    if (!p) return;
    leaveVehicle(p, true);
    delete state.players[id];
    refreshLists();
    if (mode && mode.onLeave) mode.onLeave(api, p);
  }

  /**
   * Latest input wins — this is a realtime stream, not a command queue.
   * Everything is clamped here so the rest of the sim can trust it.
   */
  function setInput(id, raw) {
    const p = state.players[id];
    if (!p || !raw) return;
    const input = p.input;
    input.mx = clamp(Number(raw.mx) || 0, -1, 1);
    input.mz = clamp(Number(raw.mz) || 0, -1, 1);
    input.aim = Number.isFinite(raw.aim) ? wrapAngle(Number(raw.aim)) : undefined;
    input.jump = !!raw.jump;
    input.sprint = !!raw.sprint;
    input.dive = !!raw.dive;
    input.throttle = clamp(Number(raw.throttle) || 0, -1, 1);
    input.steer = clamp(Number(raw.steer) || 0, -1, 1);
    input.handbrake = !!raw.handbrake;
    input.fire = !!raw.fire;
    input.aimX = Number(raw.aimX) || 0;
    input.aimY = Number(raw.aimY) || 0;
    input.aimZ = Number(raw.aimZ) || 0;
    if (Number.isFinite(raw.seq)) p.lastSeq = Math.max(p.lastSeq, raw.seq | 0);

    if (raw.use && !p.useHeld) { p.useHeld = true; toggleVehicle(p); }
    else if (!raw.use) p.useHeld = false;

    if (raw.weapon && p.weapons && p.weapons.indexOf(raw.weapon) !== -1) p.weapon = raw.weapon;
  }

  function damagePlayer(p, amount, sourceId, cause) {
    if (p.hp <= 0 || amount <= 0) return;
    if (!config.friendlyFire && sourceId && sourceId !== p.id) {
      const src = state.players[sourceId];
      if (src && src.team && src.team === p.team) return;
    }
    if (mode && mode.onDamage) {
      const adjusted = mode.onDamage(api, p, amount, sourceId, cause);
      if (adjusted === false) return;
      if (Number.isFinite(adjusted)) amount = adjusted;
    }
    p.hp = Math.max(0, p.hp - amount);
    emit({ e: 'hurt', p: p.id, a: Math.round(amount), s: sourceId || null });
    if (p.hp <= 0) killPlayer(p, sourceId, cause);
  }

  function killPlayer(p, killerId, cause) {
    if (p.deadUntil > state.t) return;
    p.hp = 0;
    p.deaths += 1;
    p.deadUntil = state.t + config.respawnDelay;
    p.anim = 'dead';
    leaveVehicle(p, true);
    const killer = killerId && killerId !== p.id ? state.players[killerId] : null;
    if (killer) killer.kills += 1;
    emit({ e: 'kill', v: p.id, k: killer ? killer.id : null, c: cause || 'hit' });
    if (mode && mode.onDeath) mode.onDeath(api, p, killer, cause);
  }

  function respawnPlayer(p) {
    const spawn = world.pickSpawn(playerList.filter(o => o.hp > 0 && o.id !== p.id), p.spawnTag, rng);
    spawnCharacter(p, spawn);
    p.hp = p.maxHp;
    p.deadUntil = 0;
    resetLoadout(p, config.startWeapons);
    emit({ e: 'spawn', p: p.id });
    if (mode && mode.onSpawn) mode.onSpawn(api, p);
  }

  // --------------------------------------------------------------- vehicles

  function toggleVehicle(p) {
    if (p.hp <= 0) return;
    if (p.veh) leaveVehicle(p, false);
    else enterVehicle(p);
  }

  function enterVehicle(p) {
    let best = null;
    let bestDist = 4.5 * 4.5;
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      const spec = getSpec(v.kind);
      const d = distSq2(p.x, p.z, v.x, v.z);
      if (d > bestDist + spec.halfLength * spec.halfLength) continue;
      if (Math.abs(v.y - p.y) > 3) continue;
      if (v.hp <= 0) continue;
      const seats = spec.seats;
      const taken = (v.driver ? 1 : 0) + v.passengers.length;
      if (taken >= seats) continue;
      best = v;
      bestDist = d;
    }
    if (!best) return;
    if (!best.driver) { best.driver = p.id; p.seat = 0; }
    else { best.passengers.push(p.id); p.seat = 1 + best.passengers.length; }
    p.veh = best.id;
    p.vx = 0; p.vy = 0; p.vz = 0;
    best.lastDriver = best.driver;
    emit({ e: 'enter', p: p.id, v: best.id, s: p.seat });
    if (mode && mode.onEnterVehicle) mode.onEnterVehicle(api, p, best);
  }

  function leaveVehicle(p, silent) {
    if (!p.veh) return;
    const v = state.vehicles[p.veh];
    p.veh = null;
    if (v) {
      if (v.driver === p.id) v.driver = null;
      const idx = v.passengers.indexOf(p.id);
      if (idx !== -1) v.passengers.splice(idx, 1);
      const spec = getSpec(v.kind);
      const side = Math.cos(v.yaw);
      const sideZ = -Math.sin(v.yaw);
      p.x = v.x + side * (spec.halfWidth + 0.7);
      p.z = v.z + sideZ * (spec.halfWidth + 0.7);
      p.y = v.y + 0.2;
      p.vx = v.vx * 0.6;
      p.vz = v.vz * 0.6;
      p.vy = 1;
      p.yaw = v.yaw;
      p.grounded = false;
      if (!silent) emit({ e: 'exit', p: p.id, v: v.id });
    }
    p.seat = -1;
  }

  // ---------------------------------------------------------------- combat

  function fire(p) {
    const w = getWeapon(p.weapon);
    if (!canFire(p, state.t)) return;
    p.nextFire = state.t + 60 / w.rpm;
    if (p.ammo[p.weapon] > 0) {
      p.ammo[p.weapon] -= 1;
      if (p.ammo[p.weapon] === 0 && w.reload) p.reloadUntil = state.t + w.reload;
    }

    muzzleOf(p, tmpMuzzle);
    normalizeAim(p, p.input.aimX, p.input.aimY, p.input.aimZ, tmpAim);
    if (p.veh) {
      const v = state.vehicles[p.veh];
      if (v) { tmpMuzzle.x = v.x + tmpAim.x * 2.4; tmpMuzzle.z = v.z + tmpAim.z * 2.4; tmpMuzzle.y = v.y + 1.2; }
    }

    if (w.kind === 'melee') {
      meleeSwing(p, w, tmpAim);
      return;
    }
    if (w.kind === 'projectile') {
      if (state.projectiles.length >= config.maxProjectiles) return;
      state.projectiles.push({
        id: 'b' + (nextProjectileId++),
        owner: p.id,
        weapon: p.weapon,
        x: tmpMuzzle.x, y: tmpMuzzle.y, z: tmpMuzzle.z,
        dx: tmpAim.x, dy: tmpAim.y, dz: tmpAim.z,
        speed: w.speed,
        life: Math.min(6, w.range / w.speed),
      });
      emit({ e: 'shot', p: p.id, w: p.weapon, x: q(tmpMuzzle.x), h: q(tmpMuzzle.y), y: q(tmpMuzzle.z) });
      return;
    }

    const pellets = w.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      let dx = tmpAim.x;
      let dy = tmpAim.y;
      let dz = tmpAim.z;
      if (w.spread) {
        dx += (rng() - 0.5) * w.spread * 2;
        dy += (rng() - 0.5) * w.spread * 2;
        dz += (rng() - 0.5) * w.spread * 2;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= l; dy /= l; dz /= l;
      }
      const hit = traceShot(traceCtx, p.id, tmpMuzzle.x, tmpMuzzle.y, tmpMuzzle.z, dx, dy, dz, w.range);
      const endX = hit ? hit.x : tmpMuzzle.x + dx * w.range;
      const endY = hit ? hit.y : tmpMuzzle.y + dy * w.range;
      const endZ = hit ? hit.z : tmpMuzzle.z + dz * w.range;
      if (i === 0 || pellets <= 2) {
        emit({
          e: 'shot', p: p.id, w: p.weapon,
          x: q(tmpMuzzle.x), h: q(tmpMuzzle.y), y: q(tmpMuzzle.z),
          ex: q(endX), eh: q(endY), ey: q(endZ),
        });
      }
      if (!hit) continue;
      if (hit.kind === 'player') {
        const dmg = damageAt(w, hit.t);
        applyImpulse(hit.target, dx * w.knockback, Math.max(0, dy) * w.knockback * 0.5, dz * w.knockback, 0);
        damagePlayer(hit.target, dmg, p.id, w.name);
      } else if (hit.kind === 'vehicle') {
        damageVehicle(hit.target, damageAt(w, hit.t) * 0.6, p.id);
      }
    }
  }

  function meleeSwing(p, w, aim) {
    const arc = w.arc || 0.9;
    emit({ e: 'melee', p: p.id });
    for (let i = 0; i < playerList.length; i++) {
      const o = playerList[i];
      if (o.id === p.id || o.hp <= 0 || o.veh) continue;
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > w.range * w.range) continue;
      const d = Math.sqrt(d2) || 1e-4;
      if ((dx / d) * aim.x + (dz / d) * aim.z < Math.cos(arc)) continue;
      applyImpulse(o, (dx / d) * w.knockback, 4.5, (dz / d) * w.knockback, w.stun);
      if (w.damage) damagePlayer(o, w.damage, p.id, 'shove');
      emit({ e: 'hit', p: p.id, t: o.id, w: 'shove' });
    }
  }

  function damageVehicle(v, amount, sourceId) {
    if (v.hp <= 0) return;
    v.hp = Math.max(0, v.hp - amount);
    if (v.hp > 0) return;
    emit({ e: 'wreck', v: v.id, s: sourceId || null });
    const occupants = [v.driver, ...v.passengers].filter(Boolean);
    for (const id of occupants) {
      const rider = state.players[id];
      if (!rider) continue;
      leaveVehicle(rider, true);
      damagePlayer(rider, 45, sourceId, 'explosion');
    }
    v.respawnAt = state.t + config.vehicleRespawnDelay;
  }

  function explode(x, y, z, radius, damage, ownerId, weaponName) {
    emit({ e: 'boom', x: q(x), h: q(y), y: q(z), r: radius });
    for (let i = 0; i < playerList.length; i++) {
      const o = playerList[i];
      if (o.hp <= 0) continue;
      const dx = o.x - x;
      const dy = (o.y + 0.9) - y;
      const dz = o.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const push = 18 * falloff;
      const inv = d > 1e-3 ? 1 / d : 0;
      applyImpulse(o, dx * inv * push, Math.max(3, dy * inv * push + 6), dz * inv * push, 0.7 * falloff);
      damagePlayer(o, damage * falloff, ownerId, weaponName || 'explosion');
    }
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      const d = Math.sqrt(distSq2(v.x, v.z, x, z) + (v.y - y) * (v.y - y));
      if (d > radius) continue;
      damageVehicle(v, damage * (1 - d / radius) * 0.8, ownerId);
    }
  }

  function onProjectileHit(b, w, hit) {
    if (w.splash) {
      explode(hit.x, hit.y, hit.z, w.splash, w.splashDamage ?? w.damage, b.owner, w.name);
      return;
    }
    if (hit.kind === 'player') damagePlayer(hit.target, w.damage, b.owner, w.name);
    else if (hit.kind === 'vehicle') damageVehicle(hit.target, w.damage, b.owner);
  }

  // ------------------------------------------------------------------ step

  function step(dt) {
    state.t += dt;
    state.tick += 1;
    world.update(state.t);

    if (mode && mode.preTick) mode.preTick(api, dt);

    // --- players
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      if (p.hp <= 0) {
        if (state.t >= p.deadUntil && (!mode || !mode.blockRespawn || !mode.blockRespawn(api, p))) respawnPlayer(p);
        continue;
      }
      if (p.veh) {
        const v = state.vehicles[p.veh];
        if (!v || v.hp <= 0) { leaveVehicle(p, true); }
        else {
          seatPosition(v, p.seat, tmpSeat);
          p.x = tmpSeat.x; p.y = tmpSeat.y; p.z = tmpSeat.z;
          p.yaw = v.yaw;
          p.anim = 'drive';
          p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
        }
      } else {
        stepCharacter(p, p.input, dt, { collision: world.collision, movers: world.movers });
        if (config.fallDamage && p.pendingFallDamage) {
          const dmg = p.pendingFallDamage;
          p.pendingFallDamage = 0;
          damagePlayer(p, dmg, null, 'fall');
        }
        if (p.pendingHazardDamage) {
          const dmg = p.pendingHazardDamage;
          p.pendingHazardDamage = 0;
          damagePlayer(p, dmg, null, 'hazard');
        }
      }
      if (p.input.fire) fire(p);
      if (p.reloadUntil && state.t >= p.reloadUntil && p.ammo[p.weapon] === 0) {
        p.ammo[p.weapon] = getWeapon(p.weapon).ammo;
        p.reloadUntil = 0;
      }
    }

    // --- player jostle (grid-free: worlds cap at 200 and the radius is tiny)
    for (let i = 0; i < playerList.length; i++) {
      const a = playerList[i];
      if (a.hp <= 0 || a.veh) continue;
      for (let j = i + 1; j < playerList.length; j++) {
        const b = playerList[j];
        if (b.hp <= 0 || b.veh) continue;
        if (Math.abs(a.x - b.x) > 2 || Math.abs(a.z - b.z) > 2) continue;
        resolvePlayerPush(a, b, dt);
      }
    }

    // --- vehicles
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      if (v.hp <= 0) {
        if (v.respawnAt && state.t >= v.respawnAt) { respawnVehicle(v); v.respawnAt = 0; }
        continue;
      }
      const driver = v.driver ? state.players[v.driver] : null;
      stepVehicle(v, driver ? driver.input : null, dt, { collision: world.collision, movers: world.movers });
      if (v.crashImpact) {
        emit({ e: 'crash', v: v.id, s: Math.round(v.crashImpact) });
        v.crashImpact = 0;
        if (v.hp <= 0) damageVehicle(v, 0, null);
      }
      if (!driver && v.idleFor > config.vehicleIdleReset && distSq2(v.x, v.z, v.homeX, v.homeZ) > 100) {
        respawnVehicle(v);
      }
      if (v.y < world.killY) respawnVehicle(v);
    }
    for (let i = 0; i < vehicleList.length; i++) {
      for (let j = i + 1; j < vehicleList.length; j++) {
        const a = vehicleList[i];
        const b = vehicleList[j];
        if (a.hp <= 0 || b.hp <= 0) continue;
        if (Math.abs(a.x - b.x) > 12 || Math.abs(a.z - b.z) > 12) continue;
        const impact = resolveVehiclePair(a, b);
        if (impact > VEHICLE.crashThreshold) emit({ e: 'crash', v: a.id, s: Math.round(impact) });
      }
    }

    // --- cars vs pedestrians
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      if (v.hp <= 0) continue;
      const speed = Math.sqrt(v.vx * v.vx + v.vz * v.vz);
      if (speed < VEHICLE.pedKnockSpeed) continue;
      const spec = getSpec(v.kind);
      const reach = spec.halfLength + 0.9;
      for (let j = 0; j < playerList.length; j++) {
        const p = playerList[j];
        if (p.veh || p.hp <= 0) continue;
        if (Math.abs(p.y - v.y) > 2.2) continue;
        if (distSq2(p.x, p.z, v.x, v.z) > reach * reach) continue;
        const inv = 1 / Math.max(0.001, speed);
        applyImpulse(p, v.vx * 0.9, 4 + speed * 0.18, v.vz * 0.9, 1.1);
        p.x += v.vx * inv * 0.4;
        p.z += v.vz * inv * 0.4;
        damagePlayer(p, Math.round(speed * 3.2), v.driver || null, 'vehicle');
        emit({ e: 'runover', p: p.id, v: v.id });
      }
    }

    // --- projectiles
    if (state.projectiles.length) stepProjectiles(state, dt, traceCtx, onProjectileHit);

    // --- pickups
    if (world.pickups.length) {
      for (let i = 0; i < world.pickups.length; i++) {
        const spec = world.pickups[i];
        const slot = state.pickups[spec.id];
        if (!slot.ready) {
          if (state.t >= slot.readyAt) slot.ready = true;
          continue;
        }
        for (let j = 0; j < playerList.length; j++) {
          const p = playerList[j];
          if (p.hp <= 0 || p.veh) continue;
          if (Math.abs(p.y - (spec.y ?? 0)) > 2.5) continue;
          if (distSq2(p.x, p.z, spec.x, spec.z) > 1.8 * 1.8) continue;
          takePickup(p, spec, slot);
          break;
        }
      }
    }

    // --- checkpoints
    if (world.checkpoints.length) {
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        if (p.hp <= 0) continue;
        const cp = world.checkpoints[p.nextCp % world.checkpoints.length];
        if (!cp || !atCheckpoint(cp, p.x, p.y, p.z)) continue;
        p.nextCp += 1;
        p.cpTime = state.t;
        if (p.nextCp % world.checkpoints.length === 0) p.lap += 1;
        emit({ e: 'cp', p: p.id, c: cp.id, n: p.nextCp, l: p.lap });
        if (mode && mode.onCheckpoint) mode.onCheckpoint(api, p, cp);
      }
    }

    // --- world limits
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      if (p.hp <= 0 || p.veh) continue;
      if (p.y < world.killY || world.outOfBounds(p.x, p.z)) {
        damagePlayer(p, 1000, null, 'void');
      }
    }

    if (mode && mode.onTick) mode.onTick(api, dt);
    return state;
  }

  function takePickup(p, spec, slot) {
    if (spec.kind === 'health') {
      if (p.hp >= p.maxHp) return;
      p.hp = Math.min(p.maxHp, p.hp + (spec.amount || 50));
    } else if (spec.kind === 'weapon') {
      giveWeapon(p, spec.weapon, spec.ammo);
    } else if (spec.kind === 'boost') {
      applyImpulse(p, Math.sin(p.yaw) * 12, 6, Math.cos(p.yaw) * 12, 0);
    } else if (mode && mode.onPickup) {
      mode.onPickup(api, p, spec);
    }
    slot.ready = false;
    slot.readyAt = state.t + (spec.respawn ?? config.pickupRespawn);
    emit({ e: 'pick', p: p.id, k: spec.id, t: spec.kind });
  }

  // ------------------------------------------------------------- snapshots

  /**
   * Project the world into network entities.
   *
   * Remember the axis convention: `x` = world X, `y` = world Z, `h` = height.
   * The `y` field is what area-of-interest slicing uses, so it MUST be the
   * ground-plane coordinate.
   */
  function projectEntities() {
    const out = {};
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      const e = {
        k: 'p',
        x: q(p.x), y: q(p.z), h: q(p.y),
        a: q(p.yaw, 2),
        n: p.name,
        hp: Math.round(p.hp),
        s: p.anim,
        sc: Math.round(p.score),
        w: p.weapon,
        ak: p.lastSeq,        // input ack — the client reconciles prediction from this
      };
      if (p.team) e.tm = p.team;
      if (p.veh) { e.v = p.veh; e.st = p.seat; }
      if (p.hp <= 0) e.d = 1;
      out[p.id] = e;
    }
    for (let i = 0; i < vehicleList.length; i++) {
      const v = vehicleList[i];
      out[v.id] = {
        k: 'v',
        x: q(v.x), y: q(v.z), h: q(v.y),
        a: q(v.yaw, 2), p: q(v.pitch, 2), r: q(v.roll, 2),
        t: v.kind,
        hp: Math.round(v.hp),
        d: v.driver || null,
        sp: q(Math.sqrt(v.vx * v.vx + v.vz * v.vz), 1),
      };
    }
    for (let i = 0; i < state.projectiles.length; i++) {
      const b = state.projectiles[i];
      out[b.id] = { k: 'b', x: q(b.x), y: q(b.z), h: q(b.y), t: b.weapon };
    }
    for (let i = 0; i < world.pickups.length; i++) {
      const spec = world.pickups[i];
      if (!state.pickups[spec.id].ready) continue;
      out[spec.id] = { k: 'k', x: q(spec.x), y: q(spec.z), h: q(spec.y ?? 0), t: spec.kind, w: spec.weapon };
    }
    return out;
  }

  /**
   * The global, position-less entity every client receives regardless of
   * where they stand: scoreboard and mode state. It also guarantees that a
   * player alone in an empty corner still gets a frame every tick.
   */
  function projectGlobal() {
    const board = playerList
      .slice()
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .slice(0, 10)
      .map(p => ({ id: p.id, n: p.name, s: Math.round(p.score), k: p.kills, d: p.deaths, tm: p.team || undefined }));
    const g = { k: 'g', t: Math.round(state.t * 10) / 10, board };
    if (mode && mode.projectState) g.m = mode.projectState(api);
    return g;
  }

  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  const api = {
    state,
    config,
    world,
    mode,
    rng,
    get players() { return playerList; },
    get vehicles() { return vehicleList; },
    addPlayer,
    removePlayer,
    setInput,
    step,
    projectEntities,
    projectGlobal,
    drainEvents,
    emit,
    damagePlayer,
    killPlayer,
    respawnPlayer,
    damageVehicle,
    explode,
    giveWeapon: (p, name, ammo) => giveWeapon(p, name, ammo),
    enterVehicle,
    leaveVehicle,
    getPlayer: (id) => state.players[id],
    getVehicle: (id) => state.vehicles[id],
    spawnVehicle(id, kind, x, y, z, yaw) {
      const v = createVehicle(id, kind, x, y, z, yaw);
      state.vehicles[id] = v;
      refreshLists();
      return v;
    },
  };

  if (mode && mode.init) mode.init(api);
  return api;
}

export { CHARACTER, WEAPONS };
