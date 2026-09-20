import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { interpolatedPosition } from './interpolation.js';

describe('interpolatedPosition', () => {
  it('returns the latest point exactly, with no previous point', () => {
    const latest = { x: 10, y: 20, t: 1000 };
    expect(interpolatedPosition(undefined, latest, 1050)).toEqual({ x: 10, y: 20 });
  });

  it('returns the latest point exactly at the moment it was received', () => {
    const previous = { x: 0, y: 0, t: 900 };
    const latest = { x: 10, y: 0, t: 1000 };
    expect(interpolatedPosition(previous, latest, 1000)).toEqual({ x: 10, y: 0 });
  });

  it('projects forward at the halfway point of the previous interval', () => {
    const previous = { x: 0, y: 0, t: 900 }; // 100ms interval, moved 10px in x
    const latest = { x: 10, y: 0, t: 1000 };
    const result = interpolatedPosition(previous, latest, 1050); // 50ms past latest = half the interval
    expect(result.x).toBeCloseTo(15, 5); // projected another 5px forward
  });

  it('caps projection at exactly one interval past latest — no runaway extrapolation', () => {
    const previous = { x: 0, y: 0, t: 900 };
    const latest = { x: 10, y: 0, t: 1000 };
    const farFuture = interpolatedPosition(previous, latest, 100_000); // way past the interval
    expect(farFuture.x).toBeCloseTo(20, 5); // exactly double the interval's delta, not more
  });

  it('does not project backwards for a `now` before latest.t', () => {
    const previous = { x: 0, y: 0, t: 900 };
    const latest = { x: 10, y: 0, t: 1000 };
    const result = interpolatedPosition(previous, latest, 950); // before latest arrived, clamped to factor 0
    expect(result).toEqual({ x: 10, y: 0 });
  });

  it('falls back to the latest point unprojected for a zero-length interval', () => {
    const previous = { x: 0, y: 0, t: 1000 };
    const latest = { x: 10, y: 0, t: 1000 };
    expect(interpolatedPosition(previous, latest, 1050)).toEqual({ x: 10, y: 0 });
  });

  it('falls back to the latest point unprojected for a negative interval (out-of-order arrival)', () => {
    const previous = { x: 0, y: 0, t: 1000 };
    const latest = { x: 10, y: 0, t: 900 };
    expect(interpolatedPosition(previous, latest, 950)).toEqual({ x: 10, y: 0 });
  });

  it('is total: never throws for any finite input', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -1e9, max: 1e9 }),
        fc.double({ noNaN: true, min: -1e9, max: 1e9 }),
        fc.double({ noNaN: true, min: -1e9, max: 1e9 }),
        fc.double({ noNaN: true, min: -1e9, max: 1e9 }),
        fc.double({ noNaN: true, min: -1e9, max: 1e9 }),
        (px, pt, lx, lt, now) => {
          const result = interpolatedPosition({ x: px, y: 0, t: pt }, { x: lx, y: 0, t: lt }, now);
          expect(Number.isFinite(result.x)).toBe(true);
          expect(Number.isFinite(result.y)).toBe(true);
        },
      ),
    );
  });
});
