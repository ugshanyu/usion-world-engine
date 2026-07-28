import { describe, it, expect } from 'vitest';
import { createCollisionWorld, boxAt, rampAt } from '../src/core/collision.js';
import { createVehicle, stepVehicle, resolveVehiclePair, getSpec, VEHICLE } from '../src/core/vehicle.js';

const DT = 1 / 30;

function ctxWith(solids = []) {
  return { collision: createCollisionWorld({ solids }), movers: [] };
}

function drive(v, input, ctx, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepVehicle(v, input, DT, ctx);
  return v;
}

describe('arcade vehicle', () => {
  it('accelerates forward and tops out below its max speed', () => {
    const ctx = ctxWith();
    const car = createVehicle('c1', 'sedan', 0, 0, 0, 0);
    drive(car, { throttle: 1 }, ctx, 12);
    const speed = Math.hypot(car.vx, car.vz);
    expect(car.z).toBeGreaterThan(50);
    expect(speed).toBeGreaterThan(15);
    expect(speed).toBeLessThanOrEqual(getSpec('sedan').maxSpeed + 0.001);
  });

  it('rolls to a stop when the throttle is released', () => {
    const ctx = ctxWith();
    const car = createVehicle('c1', 'sedan', 0, 0, 0, 0);
    drive(car, { throttle: 1 }, ctx, 4);
    drive(car, { throttle: 0 }, ctx, 25);
    expect(Math.hypot(car.vx, car.vz)).toBeLessThan(0.5);
  });

  it('turns when steering, and only while moving', () => {
    const ctx = ctxWith();
    const parked = createVehicle('c0', 'sedan', 0, 0, 0, 0);
    drive(parked, { throttle: 0, steer: 1 }, ctx, 2);
    expect(Math.abs(parked.yaw)).toBeLessThan(0.001);

    const moving = createVehicle('c1', 'sedan', 0, 0, 0, 0);
    drive(moving, { throttle: 1, steer: 1 }, ctx, 3);
    expect(Math.abs(moving.yaw)).toBeGreaterThan(0.5);
    expect(Math.abs(moving.x)).toBeGreaterThan(2);
  });

  it('drifts wider on the handbrake than on grip', () => {
    const ctx = ctxWith();
    const gripped = createVehicle('a', 'sport', 0, 0, 0, 0);
    const drifting = createVehicle('b', 'sport', 0, 0, 0, 0);
    drive(gripped, { throttle: 1 }, ctx, 3);
    drive(drifting, { throttle: 1 }, ctx, 3);
    drive(gripped, { throttle: 1, steer: 1 }, ctx, 1.5);
    drive(drifting, { throttle: 1, steer: 1, handbrake: true }, ctx, 1.5);
    // The drifting car ends up pointing further round than it has turned.
    const gripSlip = slip(gripped);
    const driftSlip = slip(drifting);
    expect(driftSlip).toBeGreaterThan(gripSlip);
  });

  function slip(v) {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const rx = fz;
    const rz = -fx;
    return Math.abs(v.vx * rx + v.vz * rz);
  }

  it('crashes into a building instead of driving through it', () => {
    const ctx = ctxWith([boxAt(0, 0, 40, 40, 12, 4)]);
    const car = createVehicle('c1', 'sedan', 0, 0, 0, 0);
    drive(car, { throttle: 1 }, ctx, 6);
    expect(car.z).toBeLessThan(38);
    expect(car.hp).toBeLessThan(getSpec('sedan').hp);
  });

  it('drives up a ramp and jumps off the lip', () => {
    const ctx = ctxWith([rampAt(0, 0, 14, 10, 4, 16)]);
    const car = createVehicle('c1', 'sport', 0, 0, 0, 0);
    let peak = 0;
    let airborne = false;
    for (let i = 0; i < 90; i++) {
      stepVehicle(car, { throttle: 1 }, DT, ctx);
      peak = Math.max(peak, car.y);
      if (car.z > 22 && !car.grounded) airborne = true;
    }
    expect(peak).toBeGreaterThan(3);
    expect(airborne).toBe(true);
  });

  it('shunts a kart harder than the kart shunts a truck', () => {
    const truck = createVehicle('t', 'truck', 0, 0, 0, 0);
    const kart = createVehicle('k', 'kart', 0, 0, 2, 0);
    truck.vz = 14;
    resolveVehiclePair(truck, kart);
    expect(kart.vz).toBeGreaterThan(3);
    expect(truck.vz).toBeGreaterThan(kart.vz * 0.4);
  });

  it('damages both cars in a heavy head-on', () => {
    const a = createVehicle('a', 'sedan', 0, 0, 0, 0);
    const b = createVehicle('b', 'sedan', 0, 0, 2, Math.PI);
    a.vz = 20;
    b.vz = -20;
    const impact = resolveVehiclePair(a, b);
    expect(impact).toBeGreaterThan(VEHICLE.crashThreshold);
    expect(a.hp).toBeLessThan(100);
    expect(b.hp).toBeLessThan(100);
  });
});
