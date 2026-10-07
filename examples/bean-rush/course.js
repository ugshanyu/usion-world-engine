/**
 * The Bean Rush course — one level, built along +Z over a strawberry-milk sea.
 *
 *   start pad → spinner field → gap jumps → hammer bridge → pusher deck →
 *   moving platforms → rolling-ball ramp → finish
 *
 * Every platform top is a whole number so bots and checkpoints can reason
 * about it. Each section ends on a checkpoint (where you respawn after a
 * fall); the last checkpoint is the finish line. `waypoints` are the line a
 * bot follows: `jump` = jump when you reach it, `wait` = hold until that
 * moving platform is within `within` metres of the waypoint.
 */
import { boxAt, rampAt } from '@usions/world-engine/core';

const C = {
  // Deck colours are saturated on purpose: pastels wash out to white in the sun.
  pink: '#ff8fbf', mint: '#4fd8b0', lemon: '#ffcf4a', lilac: '#a58bff',
  sky: '#5fbcff', peach: '#ff9f6b', cream: '#ffd36e',
  berry: '#ff4f8b', grape: '#7a5cff', orange: '#ff8a3d', minty: '#2fcf9b',
  stick: '#fffaf0', choc: '#7a4a35', rim: '#ffffff',
};

/** A platform whose walkable top is at `top`, spanning z0…z1. */
function deck(x, z0, z1, w, color, top = 0) {
  const s = boxAt(x, top - 1, (z0 + z1) / 2, w, 1, z1 - z0, 0, 'deck');
  s.color = color;
  return s;
}

function rail(x, z0, z1, top = 0) {
  const s = boxAt(x, top, (z0 + z1) / 2, 0.6, 0.9, z1 - z0, 0, 'rail');
  s.color = C.rim;
  return s;
}

/** Decorative lollipop (no collision). */
function lollipop(x, z, top, color, height = 3) {
  return [
    { kind: 'cylinder', x, y: top + height / 2, z, h: height, d: 0.18, color: C.stick },
    { kind: 'sphere', x, y: top + height + 0.6, z, d: 1.4, color },
  ];
}

function gumdrop(x, z, top, color) {
  return { kind: 'sphere', x, y: top + 0.35, z, d: 1.1, color };
}

/** Decorative arch; pillars stand at the deck edges (`half`) so the camera never hides behind one. */
function arch(z, top, color, half = 7.5) {
  return [
    { kind: 'cylinder', x: -half, y: top + 3, z, h: 6, d: 0.6, color },
    { kind: 'cylinder', x: half, y: top + 3, z, h: 6, d: 0.6, color },
    { kind: 'box', x: 0, y: top + 6.2, z, w: half * 2 + 0.6, h: 0.8, d: 0.8, color },
  ];
}

export function buildCourse() {
  const solids = [];
  const movers = [];
  const props = [];
  const waypoints = [];
  const checkpoints = [];

  // ---- start pad (z -14…6) ------------------------------------------------
  solids.push(deck(0, -14, 6, 22, C.pink), rail(-11.3, -14, 6), rail(11.3, -14, 6));
  solids.push(Object.assign(boxAt(0, 0, -14.3, 22, 1.2, 0.6, 0, 'rail'), { color: C.rim }));
  const spawns = [];
  for (let i = 0; i < 8; i++) spawns.push({ x: -7 + i * 2, y: 0, z: -9, yaw: 0, tag: 'start' });
  props.push(...arch(4, 0, C.berry, 10.7));
  for (const x of [-9.5, 9.5]) props.push(...lollipop(x, -11, 0, x < 0 ? C.berry : C.grape));

  // ---- spinner field (z 6…40) ---------------------------------------------
  // Low rails: a spinner hit bounces you along the deck, not into the sea.
  solids.push(deck(0, 6, 40, 22, C.mint), rail(-11.3, 6, 40), rail(11.3, 6, 40));
  movers.push(
    { id: 'spin1', kind: 'spinner', x: -5, y: 0.15, z: 14, w: 10, h: 0.7, d: 0.6, period: 3.2, push: 0.75, color: C.berry },
    { id: 'spin2', kind: 'spinner', x: 5, y: 0.15, z: 22, w: 10, h: 0.7, d: 0.6, period: 2.6, phase: 1, push: 0.75, color: C.berry },
    { id: 'spin3', kind: 'spinner', x: 0, y: 0.15, z: 28, w: 12, h: 0.7, d: 0.6, period: 3.6, phase: 2, push: 0.75, color: C.berry },
  );
  for (const [x, z] of [[-10, 9], [10, 18], [-10, 27], [10, 36]]) props.push(gumdrop(x, z, 0, z % 2 ? C.grape : C.orange));
  waypoints.push({ x: 0, z: 8 }, { x: 2, z: 17 }, { x: -3, z: 25 }, { x: 0, z: 36.5 });
  // Respawn well back from the edge: the first gap needs a run-up.
  checkpoints.push({ x: 0, y: 0, z: 38, radius: 11, respawn: { x: 0, y: 0, z: 35.5, yaw: 0 } });

  // ---- gap jumps (z 40…72) --------------------------------------------------
  waypoints.push({ x: 0, z: 39.2, jump: true });
  solids.push(deck(0, 42.5, 50, 10, C.lemon));          // first gap: 2.5 m, an easy one
  waypoints.push({ x: 0, z: 46 }, { x: 0, z: 49.2, jump: true });
  solids.push(deck(1, 53.5, 60, 8, C.lemon));
  waypoints.push({ x: 1, z: 57 }, { x: 1, z: 59.2, jump: true });
  solids.push(deck(0, 63, 72, 12, C.lemon));
  waypoints.push({ x: 0, z: 68 });
  checkpoints.push({ x: 0, y: 0, z: 67, radius: 6, respawn: { x: 0, y: 0, z: 67, yaw: 0 } });
  props.push(...lollipop(-5, 70, 0, C.minty), ...lollipop(5, 70, 0, C.berry));

  // ---- hammer bridge (z 72…100) -------------------------------------------
  // The hammers swing about the bridge's centre line, so the way past is to
  // jump the bar as it comes round.
  solids.push(deck(0, 72, 100, 8, C.lilac));
  movers.push(
    { id: 'ham1', kind: 'sweeper', x: 0, y: 0.2, z: 80, w: 9, h: 0.9, d: 0.7, period: 2.2, sweep: 0.75, color: C.grape },
    { id: 'ham2', kind: 'sweeper', x: 0, y: 0.2, z: 90, w: 9, h: 0.9, d: 0.7, period: 2.6, phase: 1.5, sweep: 0.75, color: C.grape },
  );
  waypoints.push({ x: 0, z: 76 }, { x: 0, z: 85 }, { x: 0, z: 95 });

  // ---- pusher deck (z 100…140) --------------------------------------------
  solids.push(deck(0, 100, 140, 16, C.sky));
  checkpoints.push({ x: 0, y: 0, z: 105, radius: 8, respawn: { x: 0, y: 0, z: 105, yaw: 0 } });
  for (const [i, z] of [116, 123, 130, 137].entries()) {
    const fromLeft = i % 2 === 0;
    movers.push({
      id: 'push' + (i + 1), kind: 'piston', rideable: false, push: 0.7,
      x: fromLeft ? -9 : 9, y: 0, z, w: 3, h: 1.8, d: 3,
      period: 2.4, phase: i * 1.1, travel: { x: fromLeft ? 8 : -8 }, color: C.orange,
    });
  }
  waypoints.push({ x: 0, z: 112 }, { x: 0, z: 126 }, { x: 0, z: 138 });

  // ---- moving platforms (z 140…163) ---------------------------------------
  // Gaps of ~2 m along Z: a jump from standing still at the edge reaches,
  // the challenge is timing it to where the platform will be.
  const plats = [
    { id: 'plat1', x: -4, z: 145, travel: 8, phase: 0 },
    { id: 'plat2', x: 4, z: 151.5, travel: -8, phase: 0 },
    { id: 'plat3', x: -4, z: 158, travel: 8, phase: Math.PI },
  ];
  for (const pl of plats) {
    movers.push({
      id: pl.id, kind: 'platform', x: pl.x, y: -0.5, z: pl.z, w: 5, h: 0.5, d: 6,
      period: 4, phase: pl.phase, travel: { x: pl.travel }, color: C.minty,
    });
  }
  waypoints.push({ x: 0, z: 139.4, wait: 'plat1', within: 1.4, jump: true });
  waypoints.push({ x: 0, z: 146, ride: 'plat1' });
  waypoints.push({ x: 0, z: 147.4, wait: 'plat2', within: 1.4, jump: true, ride: 'plat1' });
  waypoints.push({ x: 0, z: 152.5, ride: 'plat2' });
  waypoints.push({ x: 0, z: 153.9, wait: 'plat3', within: 1.4, jump: true, ride: 'plat2' });
  waypoints.push({ x: 0, z: 159, ride: 'plat3' });
  waypoints.push({ x: 0, z: 160.4, jump: true, ride: 'plat3' });     // plat3 always overlaps the landing

  // ---- landing + rolling-ball ramp (z 165…214) ----------------------------
  solids.push(deck(0, 163, 178, 16, C.pink));
  checkpoints.push({ x: 0, y: 0, z: 172, radius: 8, respawn: { x: 0, y: 0, z: 172, yaw: 0 } });
  waypoints.push({ x: 0, z: 168 }, { x: 0, z: 176 });
  const ramp = rampAt(0, 0, 196, 12, 7, 36, 0, 'ramp');
  ramp.color = C.peach;
  solids.push(ramp);
  // Side walls: a ball hit tumbles you back down the ramp, not into the sea.
  for (const x of [-6.3, 6.3]) solids.push(Object.assign(boxAt(x, 0, 196, 0.6, 8.5, 36, 0, 'wall'), { color: C.rim }));
  waypoints.push({ x: -3, z: 186 }, { x: 3, z: 198 }, { x: 0, z: 210 });
  for (const x of [-6.8, 6.8]) props.push(...lollipop(x, 179, 0, x < 0 ? C.grape : C.minty, 2.5));

  // ---- finish (z 214…240, top 7) ------------------------------------------
  solids.push(deck(0, 214, 240, 16, C.cream, 7), rail(-8.3, 214, 240, 7), rail(8.3, 214, 240, 7));
  solids.push(Object.assign(boxAt(0, 7, 240.3, 16, 1.2, 0.6, 0, 'rail'), { color: C.rim }));
  // Two lanes, one ball every 2.6 s alternating sides: there is always a
  // lane to dodge into. Balls vanish at the foot of the ramp.
  const rollers = [
    { id: 'ballL', x: -3.2, y: 8.2, z: 216, radius: 1.0, every: 5.2, vz: -3, life: 12, max: 2, push: 0.6, despawn: { minZ: 179 } },
    { id: 'ballR', x: 3.2, y: 8.2, z: 216, radius: 1.0, every: 5.2, first: 2.6, vz: -3, life: 12, max: 2, push: 0.6, despawn: { minZ: 179 } },
  ];
  checkpoints.push({ x: 0, y: 7, z: 228, radius: 8, finish: true });
  waypoints.push({ x: 0, z: 222 }, { x: 0, z: 230 });
  props.push(...arch(228, 7, C.berry));
  for (const x of [-6, -2, 2, 6]) props.push(gumdrop(x, 238.6, 7, x < 0 ? C.berry : C.grape));
  // Where finishers wait for the round to end: out of the racers' way.
  const podium = [];
  for (let i = 0; i < 8; i++) podium.push({ x: -5.25 + i * 1.5, y: 7, z: 236, yaw: Math.PI });

  return {
    id: 'bean-rush-candy-1',
    name: 'Candy Course',
    groundY: null,
    killY: -12,
    gravity: 20,
    // One run speed for everyone (no sprint button on phones), Fall Guys-style.
    character: { walkSpeed: 7.5, sprintSpeed: 7.5 },
    bounds: { minX: -40, maxX: 40, minZ: -30, maxZ: 260 },
    theme: {
      sky: '#bfe9ff', fog: '#ffe3f1', water: '#c93d86', ground: '#c93d86',
      accent: C.berry, buildings: [C.pink],
    },
    solids, movers, props, spawns, checkpoints, rollers,
    // Game data (the engine carries it untouched): bot route and finish podium.
    game: { waypoints, podium },
  };
}
