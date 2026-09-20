import { describe, expect, it } from 'vitest';

import { createFakeClock, systemClock } from './clock.js';

describe('systemClock', () => {
  it('reflects the real wall clock, roughly', () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('createFakeClock', () => {
  it('starts at the given time, or 0 by default', () => {
    expect(createFakeClock().now()).toBe(0);
    expect(createFakeClock(500).now()).toBe(500);
  });

  it('advance moves time forward relative to wherever it already is', () => {
    const clock = createFakeClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.advance(50);
    expect(clock.now()).toBe(200);
  });

  it('set jumps to an absolute value, independent of advance', () => {
    const clock = createFakeClock(100);
    clock.advance(50);
    clock.set(1_000);
    expect(clock.now()).toBe(1_000);
  });
});
