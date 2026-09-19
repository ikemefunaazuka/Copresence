import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EMPTY_PRESENCE, withCursor, withScroll } from './PresenceState.js';

describe('withCursor — last-writer-wins', () => {
  it('accepts the first cursor observation', () => {
    const next = withCursor(EMPTY_PRESENCE, { x: 0.5, y: 100 }, 1);
    expect(next.cursor).toEqual({ x: 0.5, y: 100 });
    expect(next.cursorSeq).toBe(1);
  });

  it('accepts a newer seq and overwrites the value', () => {
    const first = withCursor(EMPTY_PRESENCE, { x: 0.1, y: 10 }, 1);
    const second = withCursor(first, { x: 0.9, y: 90 }, 2);
    expect(second.cursor).toEqual({ x: 0.9, y: 90 });
    expect(second.cursorSeq).toBe(2);
  });

  it('rejects a duplicate seq — returns the exact same reference', () => {
    const first = withCursor(EMPTY_PRESENCE, { x: 0.1, y: 10 }, 5);
    const second = withCursor(first, { x: 0.99, y: 999 }, 5);
    expect(second).toBe(first);
  });

  it('rejects a stale (lower) seq — returns the exact same reference, does not regress', () => {
    const first = withCursor(EMPTY_PRESENCE, { x: 0.5, y: 50 }, 10);
    const second = withCursor(first, { x: 0.1, y: 1 }, 3);
    expect(second).toBe(first);
    expect(second.cursor).toEqual({ x: 0.5, y: 50 });
  });

  it('does not affect scroll fields', () => {
    const withScrollFirst = withScroll(EMPTY_PRESENCE, { x: 0, y: 200 }, 1);
    const next = withCursor(withScrollFirst, { x: 0.5, y: 50 }, 1);
    expect(next.scroll).toEqual({ x: 0, y: 200 });
  });
});

describe('withScroll — last-writer-wins', () => {
  it('accepts a newer seq and rejects a duplicate or stale one, symmetrically with withCursor', () => {
    const first = withScroll(EMPTY_PRESENCE, { x: 0, y: 100 }, 1);
    expect(first.scroll).toEqual({ x: 0, y: 100 });

    const duplicate = withScroll(first, { x: 0, y: 9999 }, 1);
    expect(duplicate).toBe(first);

    const stale = withScroll(first, { x: 0, y: 9999 }, 0);
    expect(stale).toBe(first);

    const newer = withScroll(first, { x: 0, y: 200 }, 2);
    expect(newer.scroll).toEqual({ x: 0, y: 200 });
    expect(newer).not.toBe(first);
  });
});

describe('PresenceState — property tests', () => {
  it('idempotency: applying the same cursor observation N times equals applying it once', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 10 }),
        (x, y, seq, repeats) => {
          const once = withCursor(EMPTY_PRESENCE, { x, y }, seq);
          let repeated = EMPTY_PRESENCE;
          for (let i = 0; i < repeats; i += 1) {
            repeated = withCursor(repeated, { x, y }, seq);
          }
          expect(repeated).toEqual(once);
        },
      ),
    );
  });

  it('order tolerance: the highest-seq observation wins regardless of arrival order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 30 }),
        (seqs) => {
          const observations = seqs.map((seq) => ({ seq, x: seq / 1000, y: seq }));
          const maxSeq = Math.max(...seqs);
          const expected = observations.find((o) => o.seq === maxSeq)!;

          // Apply in the given order.
          let inOrder = EMPTY_PRESENCE;
          for (const o of observations) inOrder = withCursor(inOrder, { x: o.x, y: o.y }, o.seq);

          // Apply in reverse order.
          let reversed = EMPTY_PRESENCE;
          for (const o of [...observations].reverse()) {
            reversed = withCursor(reversed, { x: o.x, y: o.y }, o.seq);
          }

          expect(inOrder.cursor).toEqual({ x: expected.x, y: expected.y });
          expect(reversed.cursor).toEqual({ x: expected.x, y: expected.y });
          expect(inOrder).toEqual(reversed);
        },
      ),
    );
  });
});
