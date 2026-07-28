import { describe, it, expect } from 'vitest';
import { createCollisionWorld, boxAt, rampAt } from '../src/core/collision.js';

describe('collision world', () => {
  const world = createCollisionWorld({
    solids: [
      boxAt(0, 0, 0, 10, 6, 10),            // a 10×6×10 building at the origin
      rampAt(30, 0, 0, 6, 3, 12),           // ramp rising toward +Z
      boxAt(0, 0, 40, 4, 0.4, 4),           // a low platform
    ],
  });

  it('reports the ground plane away from any solid', () => {
    const g = world.sampleGround(100, 100, 5);
    expect(g.y).toBe(0);
    expect(g.normalY).toBe(1);
  });

  it('reports the roof of a building underneath a point', () => {
    const g = world.sampleGround(0, 0, 20);
    expect(g.y).toBeCloseTo(6, 5);
  });

  it('never reports a surface above the probe height', () => {
    const g = world.sampleGround(0, 0, 2);
    expect(g.y).toBe(0);
  });

  it('slopes the ramp surface along its length', () => {
    // sampleGround reuses one result object — read the values, don't keep it.
    const low = world.sampleGround(30, -5, 10).y;
    const midHit = world.sampleGround(30, 0, 10);
    const mid = midHit.y;
    const midNormal = midHit.normalY;
    const high = world.sampleGround(30, 5, 10).y;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeCloseTo(2.75, 2);
    expect(midNormal).toBeLessThan(1);
    expect(midNormal).toBeGreaterThan(0.7);
  });

  it('pushes a sphere out of a wall, sideways', () => {
    const fix = world.resolveSphere(4.8, 2, 0, 0.5);
    expect(fix.hit).toBe(true);
    expect(fix.x).toBeGreaterThan(0);
    expect(Math.abs(fix.z)).toBeLessThan(0.01);
  });

  it('leaves a sphere clear of the wall alone', () => {
    const fix = world.resolveSphere(8, 2, 0, 0.5);
    expect(fix.hit).toBe(false);
  });

  it('escapes a sphere buried inside a solid', () => {
    const fix = world.resolveSphere(0, 3, 0, 0.5);
    expect(fix.hit).toBe(true);
    const moved = Math.hypot(fix.x, fix.y, fix.z);
    expect(moved).toBeGreaterThan(0.4);
  });

  it('raycasts onto the ground', () => {
    const hit = world.raycast(50, 10, 50, 0, -1, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit.t).toBeCloseTo(10, 5);
    expect(hit.ny).toBe(1);
  });

  it('raycasts into a wall and stops there', () => {
    const hit = world.raycast(-20, 3, 0, 1, 0, 0, 40);
    expect(hit).not.toBeNull();
    expect(hit.x).toBeCloseTo(-5, 1);
    expect(hit.nx).toBeLessThan(0);
  });

  it('misses when nothing is in the way', () => {
    const hit = world.raycast(-20, 30, 0, 1, 0, 0, 40);
    expect(hit).toBeNull();
  });

  it('respects yaw when testing rotated solids', () => {
    const rotated = createCollisionWorld({
      solids: [{ kind: 'box', x: 0, y: 2, z: 0, hx: 8, hy: 2, hz: 1, ry: Math.PI / 2 }],
    });
    // The box is 16 long on its local X, rotated to lie along world Z.
    expect(rotated.raycast(0, 2, -20, 0, 0, 1, 40)).not.toBeNull();
    expect(rotated.raycast(20, 2, 0, -1, 0, 0, 15)).toBeNull();
  });
});

