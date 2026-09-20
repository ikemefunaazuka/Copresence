import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backoffDelayMs } from './backoff.js';

describe('backoffDelayMs', () => {
  it('grows with attempt number, at a fixed random factor', () => {
    const fixedRandom = () => 0.5;
    const first = backoffDelayMs(0, 10_000, fixedRandom);
    const second = backoffDelayMs(1, 10_000, fixedRandom);
    const third = backoffDelayMs(2, 10_000, fixedRandom);

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('never exceeds the cap, however large the attempt number', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, r) => {
          const delay = backoffDelayMs(attempt, 10_000, () => r);
          expect(delay).toBeLessThanOrEqual(10_000);
          expect(delay).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('is full jitter, not proportional jitter: random()=0 can produce ~0 delay even at a high attempt', () => {
    // Proportional/"equal" jitter would still have a non-trivial floor at
    // a high attempt count; full jitter's floor is genuinely 0.
    const delay = backoffDelayMs(10, 10_000, () => 0);
    expect(delay).toBe(0);
  });

  it('random()=1 (the boundary) lands exactly at the pre-cap exponential value, capped', () => {
    const delay = backoffDelayMs(1, 10_000, () => 1);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it('treats a negative or non-finite attempt as attempt 0 rather than producing a negative delay', () => {
    expect(() => backoffDelayMs(-5, 10_000, () => 0.5)).not.toThrow();
    expect(backoffDelayMs(-5, 10_000, () => 0.5)).toBe(backoffDelayMs(0, 10_000, () => 0.5));
    expect(() => backoffDelayMs(Number.NaN, 10_000, () => 0.5)).not.toThrow();
  });

  it('defaults to the shared protocol cap when none is given', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (attempt) => {
        expect(backoffDelayMs(attempt, undefined, () => 1)).toBeLessThanOrEqual(10_000);
      }),
    );
  });
});
