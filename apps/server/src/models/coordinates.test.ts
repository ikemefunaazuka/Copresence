import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toDocumentSpace, toViewportSpace } from './coordinates.js';

describe('toDocumentSpace', () => {
  it('places the left edge at x=0 and the right edge at x=1', () => {
    expect(toDocumentSpace({ x: 0, y: 0 }, 1000, 0)).toEqual({ x: 0, y: 0 });
    expect(toDocumentSpace({ x: 1000, y: 0 }, 1000, 0)).toEqual({ x: 1, y: 0 });
  });

  it('folds scroll offset into an absolute document y', () => {
    expect(toDocumentSpace({ x: 0, y: 50 }, 1000, 2000)).toEqual({ x: 0, y: 2050 });
  });

  it('degrades to a safe value rather than dividing by zero for a zero-width document', () => {
    expect(() => toDocumentSpace({ x: 10, y: 10 }, 0, 0)).not.toThrow();
    expect(toDocumentSpace({ x: 10, y: 10 }, 0, 0).x).toBe(0);
  });

  it('is total: never throws for any finite or non-finite numeric input', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        (px, py, width, scrollY) => {
          const result = toDocumentSpace({ x: px, y: py }, width, scrollY);
          expect(Number.isFinite(result.x)).toBe(true);
          expect(Number.isFinite(result.y)).toBe(true);
        },
      ),
    );
  });

  it('always produces x within the normalised 0..1 range', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.double({ min: 1, max: 1_000_000, noNaN: true }),
        (px, width) => {
          const result = toDocumentSpace({ x: px, y: 0 }, width, 0);
          expect(result.x).toBeGreaterThanOrEqual(0);
          expect(result.x).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('always produces a non-negative y', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ noNaN: false }), (py, scrollY) => {
        const result = toDocumentSpace({ x: 0, y: py }, 1000, scrollY);
        expect(result.y).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('falls back to a safe y when viewportPoint.y + scrollY itself overflows', () => {
    // Both individually finite (and both well within the "always non-
    // finite" cases already covered above); only their SUM overflows.
    // Pinned deterministically for the same reason as the toViewportSpace
    // case: relying on random sampling to keep this branch covered is
    // unreliable.
    const result = toDocumentSpace({ x: 0, y: 1.5e308 }, 1000, 1.5e308);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(result.y).toBe(0);
  });
});

describe('toViewportSpace', () => {
  it('is the inverse of toDocumentSpace for a well-formed round trip', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 20_000, noNaN: true }),
        fc.double({ min: 1, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 20_000, noNaN: true }),
        (px, py, width, scrollY) => {
          const doc = toDocumentSpace({ x: px, y: py }, width, scrollY);
          const back = toViewportSpace(doc, width, scrollY);
          // x is clamped on the way in when px is outside [0, width], so
          // the round trip is only exact for a point that was on-page.
          if (px >= 0 && px <= width) {
            expect(back.x).toBeCloseTo(px, 6);
          }
          expect(back.y).toBeCloseTo(py, 6);
        },
      ),
    );
  });

  it('is total: never throws for any finite or non-finite numeric input', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        (dx, dy, width, scrollY) => {
          const result = toViewportSpace({ x: dx, y: dy }, width, scrollY);
          expect(Number.isFinite(result.x)).toBe(true);
          expect(Number.isFinite(result.y)).toBe(true);
        },
      ),
    );
  });

  it('falls back to a safe y when the subtraction itself overflows — not just when an input is non-finite', () => {
    // Both inputs are individually finite; only their DIFFERENCE overflows.
    // The property test above found this by luck of random sampling, which
    // is not a reliable way to keep it covered — pinned as a deterministic
    // case so this exact regression can't silently stop being exercised.
    const result = toViewportSpace({ x: 0, y: -1.5e293 }, 0, 1.7976931348623157e308);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(result.y).toBe(0);
  });
});
