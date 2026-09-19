import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SequenceGuard } from './SequenceGuard.js';

describe('SequenceGuard.accept — unit behaviour', () => {
  it('accepts the first sequence number seen, whatever it is', () => {
    const guard = new SequenceGuard();
    expect(guard.accept(5)).toBe(true);
    expect(guard.lastSeen()).toBe(5);
  });

  it('accepts a strictly increasing sequence', () => {
    const guard = new SequenceGuard();
    expect(guard.accept(1)).toBe(true);
    expect(guard.accept(2)).toBe(true);
    expect(guard.accept(3)).toBe(true);
    expect(guard.lastSeen()).toBe(3);
  });

  it('rejects an exact duplicate', () => {
    const guard = new SequenceGuard();
    guard.accept(5);
    expect(guard.accept(5)).toBe(false);
    expect(guard.lastSeen()).toBe(5);
  });

  it('rejects a regression', () => {
    const guard = new SequenceGuard();
    guard.accept(10);
    expect(guard.accept(3)).toBe(false);
    expect(guard.lastSeen()).toBe(10);
  });

  it('records a gap when a sequence number is skipped', () => {
    const guard = new SequenceGuard();
    guard.accept(1);
    guard.accept(7);
    expect(guard.observedGaps()).toEqual([2, 3, 4, 5, 6]);
  });

  it('distinguishes "8 was lost" from "the participant went quiet"', () => {
    const wentQuiet = new SequenceGuard();
    wentQuiet.accept(1);
    // ...no further calls; nothing was skipped, there is simply no more data.
    expect(wentQuiet.observedGaps()).toEqual([]);

    const lostOne = new SequenceGuard();
    lostOne.accept(1);
    lostOne.accept(2);
    lostOne.accept(3);
    lostOne.accept(5);
    lostOne.accept(6);
    lostOne.accept(7);
    // 4 never arrived, sandwiched between data that did — a real gap.
    expect(lostOne.observedGaps()).toEqual([4]);
  });

  it('fills a gap when the late arrival shows up, even though accept() returns false for it', () => {
    const guard = new SequenceGuard();
    guard.accept(1);
    guard.accept(7);
    expect(guard.observedGaps()).toEqual([2, 3, 4, 5, 6]);

    const accepted = guard.accept(4); // late — arrives after 7
    expect(accepted).toBe(false); // ordering-wise, too late to matter
    expect(guard.observedGaps()).toEqual([2, 3, 5, 6]); // but no longer an unexplained hole
    expect(guard.lastSeen()).toBe(7); // and lastSeen did not regress
  });

  it('is total: never throws for NaN, Infinity, or negative input', () => {
    const guard = new SequenceGuard();
    expect(() => guard.accept(Number.NaN)).not.toThrow();
    expect(guard.accept(Number.NaN)).toBe(false);
    expect(() => guard.accept(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => guard.accept(Number.NEGATIVE_INFINITY)).not.toThrow();
    expect(() => guard.accept(-5)).not.toThrow();
  });

  it('accepts a pathologically large jump as newer data without hanging or recording every skipped number', () => {
    const guard = new SequenceGuard();
    guard.accept(1);
    const start = performance.now();
    const accepted = guard.accept(Number.MAX_SAFE_INTEGER);
    const elapsedMs = performance.now() - start;

    expect(accepted).toBe(true);
    expect(guard.lastSeen()).toBe(Number.MAX_SAFE_INTEGER);
    // The exhaustive gap list for a span this large is neither useful nor
    // safe to materialise — see MAX_TRACKED_GAP_SPAN in SequenceGuard.ts.
    expect(guard.observedGaps()).toEqual([]);
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('SequenceGuard — property tests (MILESTONE Phase 1 exit criteria)', () => {
  it('monotonicity: never accepts a regression, under any shuffled input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 200 }),
        (seqs) => {
          const guard = new SequenceGuard();
          let observedMax = -Infinity;
          for (const seq of seqs) {
            const accepted = guard.accept(seq);
            if (accepted) {
              // accept() must never report success for something no newer
              // than what has already been seen.
              expect(seq).toBeGreaterThan(observedMax);
              observedMax = seq;
            }
            // lastSeen never regresses, regardless of what was just offered.
            expect(guard.lastSeen()).toBe(observedMax === -Infinity ? undefined : observedMax);
          }
        },
      ),
    );
  });

  it('gap exactness: observedGaps() is always precisely the numbers between the first and last delivered value that were never seen', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 150 }),
        (seqs) => {
          const guard = new SequenceGuard();
          const delivered = new Set<number>();
          // The FIRST call always sets lastSeen unconditionally, whatever its
          // value — there is no evidence anything below it was ever sent, so
          // gaps are only meaningful starting after it, not from 0.
          const firstSeen = seqs[0]!;
          for (const seq of seqs) {
            guard.accept(seq);
            delivered.add(seq);
          }

          const lastSeen = guard.lastSeen();
          if (lastSeen === undefined) return; // unreachable given minLength: 1, kept for totality

          const expectedGaps: number[] = [];
          for (let n = firstSeen + 1; n < lastSeen; n += 1) {
            if (!delivered.has(n)) expectedGaps.push(n);
          }

          expect(guard.observedGaps()).toEqual(expectedGaps);
        },
      ),
    );
  });

  it('idempotency: re-delivering the same sequence any number of times leaves lastSeen and gaps unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 100 }),
        fc.integer({ min: 1, max: 5 }),
        (seqs, repeats) => {
          const once = new SequenceGuard();
          for (const seq of seqs) once.accept(seq);

          const repeated = new SequenceGuard();
          for (const seq of seqs) {
            for (let i = 0; i < repeats; i += 1) repeated.accept(seq);
          }

          expect(repeated.lastSeen()).toBe(once.lastSeen());
          expect(repeated.observedGaps()).toEqual(once.observedGaps());
        },
      ),
    );
  });

  it('totality: never throws — and never hangs — for any array of finite, non-finite, or NaN input', () => {
    // Deliberately unbounded (fc.double with no min/max): this is the exact
    // test that first found a real bug — a finite value near
    // Number.MAX_VALUE arriving after a small one made the (then-
    // unbounded) gap-filling loop try to enumerate a near-infinite range,
    // hanging the process. Left unbounded on purpose as a regression guard.
    fc.assert(
      fc.property(fc.array(fc.double({ noNaN: false }), { maxLength: 100 }), (seqs) => {
        const guard = new SequenceGuard();
        expect(() => {
          for (const seq of seqs) guard.accept(seq);
        }).not.toThrow();
      }),
      { interruptAfterTimeLimit: 5_000 },
    );
  });
});
