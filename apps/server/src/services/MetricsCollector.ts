import type { MessageClass } from '@copresence/protocol';

export interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface MetricsSnapshot {
  readonly inboundMessages: number;
  readonly inboundBytes: number;
  readonly outboundMessages: number;
  readonly outboundBytes: number;
  /** Inbound `cursor`+`scroll` messages — the "events" side of the coalescing ratio. */
  readonly eventsReceived: number;
  /** Non-empty `patch` broadcasts actually emitted — once per session per tick with dirty data, not once per recipient. */
  readonly patchesEmitted: number;
  readonly droppedByClass: Readonly<Record<MessageClass, number>>;
  readonly duplicatesSent: number;
  readonly duplicatesRejected: number;
  readonly outOfOrderRejected: number;
  /** A repeat `hello` from an already-known participant (e.g. a reconnect) re-syncing via a fresh `welcome`. */
  readonly resyncsTriggered: number;
  /** `eventsReceived / patchesEmitted` — undefined until at least one patch has been emitted. The number ADR 0003's whole design exists to earn. */
  readonly coalescingRatio: number | undefined;
  readonly latencyMs: LatencyPercentiles | undefined;
}

const EMPTY_CLASS_COUNTS: Record<MessageClass, number> = {
  lossy: 0,
  lossless: 0,
  control: 0,
  audit: 0,
};

const MAX_LATENCY_SAMPLES = 1_000;

/**
 * Global counters + a bounded latency sample buffer, read by `/metrics`
 * (Prometheus text) and the inspector's own JSON polling. Deliberately a
 * plain in-memory accumulator — the same "no database needed" posture as
 * everything else in this repo (see MILESTONE §3) — reset on restart,
 * which is fine for a live observability surface that is describing the
 * server's current behaviour, not keeping a durable record of it (that is
 * `AuditLog`'s job, a different concern entirely).
 */
export class MetricsCollector {
  #inboundMessages = 0;
  #inboundBytes = 0;
  #outboundMessages = 0;
  #outboundBytes = 0;
  #eventsReceived = 0;
  #patchesEmitted = 0;
  #droppedByClass: Record<MessageClass, number> = { ...EMPTY_CLASS_COUNTS };
  #duplicatesSent = 0;
  #duplicatesRejected = 0;
  #outOfOrderRejected = 0;
  #resyncsTriggered = 0;
  // Fixed-size circular buffer rather than a real streaming percentile
  // structure (t-digest and friends) — proportionate for a toy's traffic
  // volume, and the read-time sort is cheap at this size.
  #latencySamples: number[] = [];
  #latencyWriteIndex = 0;

  recordInbound(type: string, bytes: number): void {
    this.#inboundMessages += 1;
    this.#inboundBytes += bytes;
    if (type === 'cursor' || type === 'scroll') this.#eventsReceived += 1;
  }

  recordOutbound(bytes: number): void {
    this.#outboundMessages += 1;
    this.#outboundBytes += bytes;
  }

  recordPatchEmitted(): void {
    this.#patchesEmitted += 1;
  }

  recordDrop(messageClass: MessageClass): void {
    this.#droppedByClass[messageClass] += 1;
  }

  recordDuplicateSent(): void {
    this.#duplicatesSent += 1;
  }

  recordDuplicateRejected(): void {
    this.#duplicatesRejected += 1;
  }

  recordOutOfOrderRejected(): void {
    this.#outOfOrderRejected += 1;
  }

  recordResync(): void {
    this.#resyncsTriggered += 1;
  }

  recordLatencySample(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.#latencySamples.length < MAX_LATENCY_SAMPLES) {
      this.#latencySamples.push(ms);
      return;
    }
    this.#latencySamples[this.#latencyWriteIndex] = ms;
    this.#latencyWriteIndex = (this.#latencyWriteIndex + 1) % MAX_LATENCY_SAMPLES;
  }

  snapshot(): MetricsSnapshot {
    return {
      inboundMessages: this.#inboundMessages,
      inboundBytes: this.#inboundBytes,
      outboundMessages: this.#outboundMessages,
      outboundBytes: this.#outboundBytes,
      eventsReceived: this.#eventsReceived,
      patchesEmitted: this.#patchesEmitted,
      droppedByClass: { ...this.#droppedByClass },
      duplicatesSent: this.#duplicatesSent,
      duplicatesRejected: this.#duplicatesRejected,
      outOfOrderRejected: this.#outOfOrderRejected,
      resyncsTriggered: this.#resyncsTriggered,
      coalescingRatio:
        this.#patchesEmitted > 0 ? this.#eventsReceived / this.#patchesEmitted : undefined,
      latencyMs: percentilesOf(this.#latencySamples),
    };
  }

  reset(): void {
    this.#inboundMessages = 0;
    this.#inboundBytes = 0;
    this.#outboundMessages = 0;
    this.#outboundBytes = 0;
    this.#eventsReceived = 0;
    this.#patchesEmitted = 0;
    this.#droppedByClass = { ...EMPTY_CLASS_COUNTS };
    this.#duplicatesSent = 0;
    this.#duplicatesRejected = 0;
    this.#outOfOrderRejected = 0;
    this.#resyncsTriggered = 0;
    this.#latencySamples = [];
    this.#latencyWriteIndex = 0;
  }
}

function percentilesOf(samples: readonly number[]): LatencyPercentiles | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: pick(sorted, 0.5), p95: pick(sorted, 0.95), p99: pick(sorted, 0.99) };
}

function pick(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  // Non-empty by construction — percentilesOf already returned for length 0.
  return sorted[index]!;
}
