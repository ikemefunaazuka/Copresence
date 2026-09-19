/**
 * Tracks the highest sequence number seen from a single participant and
 * rejects any regression — the single primitive that gives both
 * idempotency (re-applying the same seq is a no-op) and out-of-order
 * rejection (MILESTONE Phase 1).
 *
 * Also records which sequence numbers were skipped over, so a caller can
 * tell "8 was lost" apart from "the participant went quiet". What a gap
 * MEANS is deliberately not this class's job — see
 * `@copresence/protocol`'s `MESSAGE_CLASS` and docs/adr/0009: a gap on a
 * lossy channel is expected and ignored, a gap on lossless/audit triggers
 * repair. This class only knows the fact of the gap.
 */
// A real participant's seq advances by roughly one per message; a jump of
// tens or low hundreds covers even a burst of dropped frames. A jump past
// this span is adversarial or corrupt input, not a plausible gap — see
// `accept()`. Without this bound, `seq` jumping to something near
// `Number.MAX_SAFE_INTEGER` would try to enumerate and store a quadrillion
// missing numbers, an easy denial-of-service vector; the "totality"
// property test in SequenceGuard.test.ts exists specifically to catch
// exactly this class of adversarial-input bug.
const MAX_TRACKED_GAP_SPAN = 10_000;

export class SequenceGuard {
  #lastSeen: number | undefined;
  #gaps = new Set<number>();

  /**
   * Records `seq` as seen and returns `true` if it is newer than anything
   * seen before; returns `false` — and leaves `lastSeen` unchanged — for a
   * duplicate or a late/out-of-order arrival. Total for any input,
   * including NaN and negative numbers: never throws.
   *
   * A late arrival that fills a previously-recorded gap still removes
   * that number from `observedGaps()` even though it returns `false` here
   * — the data arrived, just too late to move `lastSeen` forward.
   */
  accept(seq: number): boolean {
    if (!Number.isFinite(seq)) return false;

    if (this.#lastSeen === undefined) {
      this.#lastSeen = seq;
      return true;
    }

    if (seq <= this.#lastSeen) {
      this.#gaps.delete(seq);
      return false;
    }

    const span = seq - this.#lastSeen;
    if (span <= MAX_TRACKED_GAP_SPAN) {
      for (let missed = this.#lastSeen + 1; missed < seq; missed += 1) {
        this.#gaps.add(missed);
      }
    }
    // A larger span is still accepted as newer data — `seq` is real
    // information the caller should act on — it is only the exhaustive
    // enumeration of every individual missing number that is skipped.
    this.#lastSeen = seq;
    return true;
  }

  /** The sequence numbers skipped over that have not (yet) arrived, ascending. */
  observedGaps(): readonly number[] {
    return Array.from(this.#gaps).sort((a, b) => a - b);
  }

  lastSeen(): number | undefined {
    return this.#lastSeen;
  }
}
