import { describe, it, expect } from 'vitest';
import { createCollisionWorld, boxAt, rampAt } from '../src/core/collision.js';
import { CHARACTER, spawnCharacter, stepCharacter, applyImpulse, resolvePlayerPush } from '../src/core/character.js';
import { createMover, updateMovers } from '../src/core/movers.js';

const DT = 1 / 30;

function makeCtx(solids = [], movers = []) {
  return { collision: createCollisionWorld({ solids }), movers };
}

function run(p, input, ctx, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepCharacter(p, input, DT, ctx);
  return p;
}

describe('character controller', () => {
  it('stands still on the ground', () => {
    const ctx = makeCtx();
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    run(p, null, ctx, 1);
    expect(p.y).toBeCloseTo(0, 5);
    expect(p.grounded).toBe(true);
    expect(p.anim).toBe('idle');
  });

  it('walks forward at roughly the walk speed', () => {
    const ctx = makeCtx();
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    run(p, { mx: 0, mz: 1, aim: 0 }, ctx, 1);
    expect(p.z).toBeGreaterThan(CHARACTER.walkSpeed * 0.7);
    expect(p.z).toBeLessThan(CHARACTER.walkSpeed * 1.1);
    expect(p.anim).toBe('run');
  });

  it('sprints faster than it walks', () => {
    const ctx = makeCtx();
    const walker = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    const runner = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    run(walker, { mx: 0, mz: 1 }, ctx, 2);
    run(runner, { mx: 0, mz: 1, sprint: true }, ctx, 2);
    expect(runner.z).toBeGreaterThan(walker.z + 3);
  });

  it('falls back to the ground after a jump', () => {
    const ctx = makeCtx();
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    stepCharacter(p, { jump: true }, DT, ctx);
    expect(p.vy).toBeGreaterThan(5);
    run(p, {}, ctx, 3);
    expect(p.y).toBeCloseTo(0, 3);
    expect(p.grounded).toBe(true);
  });

  it('cannot walk through a wall', () => {
    const ctx = makeCtx([boxAt(0, 0, 5, 20, 4, 1)]);
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    run(p, { mx: 0, mz: 1 }, ctx, 3);
    expect(p.z).toBeLessThan(4.6);
  });

  it('walks up a ramp', () => {
    const ctx = makeCtx([rampAt(0, 0, 6, 8, 3, 12)]);
    const p = spawnCharacter({}, { x: 0, y: 0, z: -2 });
    run(p, { mx: 0, mz: 1 }, ctx, 2);
    expect(p.y).toBeGreaterThan(1.5);
    expect(p.grounded).toBe(true);
  });

  it('steps up a kerb without jumping', () => {
    const ctx = makeCtx([boxAt(0, 0, 6, 20, 0.16, 20)]);
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    run(p, { mx: 0, mz: 1 }, ctx, 1.5);
    expect(p.y).toBeCloseTo(0.16, 2);
    expect(p.z).toBeGreaterThan(3);
  });

  it('dives forward, then gets up', () => {
    const ctx = makeCtx();
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    stepCharacter(p, { dive: true, aim: 0 }, DT, ctx);
    expect(p.anim).toBe('dive');
    const speed = Math.hypot(p.vx, p.vz);
    expect(speed).toBeGreaterThan(CHARACTER.walkSpeed);
    run(p, {}, ctx, 1.5);
    expect(p.anim).not.toBe('dive');
    expect(p.z).toBeGreaterThan(2);
  });

  it('ignores input while stunned and recovers', () => {
    const ctx = makeCtx();
    const p = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    applyImpulse(p, 0, 0, 0, 0.6);
    run(p, { mx: 0, mz: 1 }, ctx, 0.3);
    expect(Math.abs(p.z)).toBeLessThan(0.2);
    run(p, { mx: 0, mz: 1 }, ctx, 1.2);
    expect(p.z).toBeGreaterThan(1);
  });

  it('takes fall damage from a long drop but not a short one', () => {
    const ctx = makeCtx();
    const short = spawnCharacter({}, { x: 0, y: 4, z: 0 });
    run(short, {}, ctx, 2);
    expect(short.pendingFallDamage || 0).toBe(0);

    const long = spawnCharacter({}, { x: 0, y: 60, z: 0 });
    run(long, {}, ctx, 5);
    expect(long.pendingFallDamage).toBeGreaterThan(0);
  });

  it('rides a moving platform', () => {
    const mover = createMover({
      id: 'lift', kind: 'platform', x: 0, y: 1, z: 0, w: 8, h: 0.4, d: 8,
      travel: { x: 20, y: 0, z: 0 }, period: 12,
    });
    updateMovers([mover], 0);
    const ctx = makeCtx([], [mover]);
    const p = spawnCharacter({}, { x: 0, y: 1.4, z: 0 });
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += DT;
      updateMovers([mover], t);
      stepCharacter(p, null, DT, ctx);
    }
    expect(p.x).toBeGreaterThan(0.5);
    expect(p.y).toBeGreaterThan(1);
  });

  it('is launched by a spinning hazard bar', () => {
    const mover = createMover({
      id: 'spin', kind: 'spinner', x: 0, y: 0.5, z: 0, w: 10, h: 1.2, d: 0.6, period: 3,
    });
    const ctx = makeCtx([], [mover]);
    const p = spawnCharacter({}, { x: 3.2, y: 0, z: 0 });
    let t = 0;
    let stunned = false;
    for (let i = 0; i < 90 && !stunned; i++) {
      t += DT;
      updateMovers([mover], t);
      stepCharacter(p, null, DT, ctx);
      stunned = p.stunT > 0;
    }
    expect(stunned).toBe(true);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(1);
  });

  it('separates two players standing in the same spot', () => {
    const a = spawnCharacter({}, { x: 0, y: 0, z: 0 });
    const b = spawnCharacter({}, { x: 0.1, y: 0, z: 0 });
    resolvePlayerPush(a, b, DT);
    const gap = Math.hypot(b.x - a.x, b.z - a.z);
    expect(gap).toBeCloseTo(CHARACTER.pushRadius * 2, 2);
  });
});
