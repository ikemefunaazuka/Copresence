import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { exceedsDeadBand } from './deadBand.js';

describe('exceedsDeadBand', () => {
  it('always emits the first observation, with no previous point', () => {
    expect(exceedsDeadBand(undefined, { x: 0, y: 0 })).toBe(true);
  });

  it('suppresses a delta under the threshold', () => {
    expect(exceedsDeadBand({ x: 100, y: 100 }, { x: 101, y: 100 }, 2)).toBe(false);
  });

  it('allows a delta at or over the threshold', () => {
    expect(exceedsDeadBand({ x: 100, y: 100 }, { x: 102, y: 100 }, 2)).toBe(true);
    expect(exceedsDeadBand({ x: 100, y: 100 }, { x: 103, y: 100 }, 2)).toBe(true);
  });

  it('measures Euclidean distance, not per-axis', () => {
    // 1.5 + 1.5 per-axis would each individually be under a threshold of 2,
    // but the actual distance (~2.12) is over it.
    expect(exceedsDeadBand({ x: 0, y: 0 }, { x: 1.5, y: 1.5 }, 2)).toBe(true);
  });

  it('defaults to the shared protocol constant when no threshold is given', () => {
    expect(exceedsDeadBand({ x: 0, y: 0 }, { x: 0.1, y: 0 })).toBe(false);
    expect(exceedsDeadBand({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
  });

  it('is total: never throws for any finite point pair', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        (px, py, nx, ny) => {
          expect(() => exceedsDeadBand({ x: px, y: py }, { x: nx, y: ny })).not.toThrow();
        },
      ),
    );
  });
});
