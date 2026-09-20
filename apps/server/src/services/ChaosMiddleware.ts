import type { ParticipantId, OutboundMessage } from '@copresence/protocol';

import type { Clock } from '../lib/clock.js';

export interface ChaosConfig {
  /** Probability (0..0.5) a message is dropped outright. */
  readonly dropRate: number;
  /** Probability (0..0.2) a message is sent a second time. */
  readonly duplicateRate: number;
  readonly latencyMs: number;
  readonly jitterMs: number;
  /** How many messages to hold per connection before releasing one at random — 0 disables reordering. */
  readonly reorderWindow: number;
}

export const DEFAULT_CHAOS_CONFIG: ChaosConfig = {
  dropRate: 0,
  duplicateRate: 0,
  latencyMs: 0,
  jitterMs: 0,
  reorderWindow: 0,
};

const MAX_DROP_RATE = 0.5;
const MAX_DUPLICATE_RATE = 0.2;
const MAX_LATENCY_MS = 2_000;
const MAX_JITTER_MS = 500;
const MAX_REORDER_WINDOW = 10;
const MAX_PARTITION_MS = 30_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

interface QueuedSend {
  readonly message: OutboundMessage;
  readonly rawSend: () => void;
}

export interface ChaosMiddlewareDeps {
  readonly clock: Clock;
  readonly random?: () => number;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Fires exactly once a message actually leaves the wire — after every drop/duplicate/latency decision has been made. `deliveredAt` is when the real `rawSend()` happened. */
  readonly onDeliver?: (pid: ParticipantId, message: OutboundMessage, deliveredAt: number) => void;
  readonly onDrop?: (pid: ParticipantId, message: OutboundMessage) => void;
  readonly onDuplicate?: (pid: ParticipantId, message: OutboundMessage) => void;
}

/**
 * Sits between `BroadcastHub`'s decision to send a message to one
 * participant and the raw socket write. Deliberately indifferent to what
 * "should" happen — a real network does not respect a message's
 * classification, and this exists to simulate exactly that honestly
 * rather than being "nice" about which messages it touches. What makes
 * the system resilient to that is the rest of the design (absolute,
 * last-writer-wins `patch` values; the client's own seq guard against a
 * reordered delivery) doing its job — not this middleware pulling its
 * punches. See docs/FAILURE-MODES.md.
 *
 * Every knob is global, not per-session — a single dial the `/chaos`
 * panel's reviewer flips for the whole server, matching how the panel is
 * described in the project plan.
 */
export class ChaosMiddleware {
  #config: ChaosConfig = DEFAULT_CHAOS_CONFIG;
  #partitionEndsAt: number | undefined;
  #clock: Clock;
  #random: () => number;
  #setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  #onDeliver: ChaosMiddlewareDeps['onDeliver'];
  #onDrop: ChaosMiddlewareDeps['onDrop'];
  #onDuplicate: ChaosMiddlewareDeps['onDuplicate'];
  #reorderBuffers = new Map<ParticipantId, QueuedSend[]>();

  constructor(deps: ChaosMiddlewareDeps) {
    this.#clock = deps.clock;
    this.#random = deps.random ?? Math.random;
    this.#setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.#onDeliver = deps.onDeliver;
    this.#onDrop = deps.onDrop;
    this.#onDuplicate = deps.onDuplicate;
  }

  /**
   * Every field `| undefined` rather than plain optional: a caller
   * forwarding a parsed zod object's optional fields (e.g. ChaosController)
   * has values typed `number | undefined`, which `exactOptionalPropertyTypes`
   * only accepts if the parameter type says so explicitly.
   */
  configure(partial: {
    dropRate?: number | undefined;
    duplicateRate?: number | undefined;
    latencyMs?: number | undefined;
    jitterMs?: number | undefined;
    reorderWindow?: number | undefined;
  }): ChaosConfig {
    this.#config = {
      dropRate: clamp(partial.dropRate ?? this.#config.dropRate, 0, MAX_DROP_RATE),
      duplicateRate: clamp(
        partial.duplicateRate ?? this.#config.duplicateRate,
        0,
        MAX_DUPLICATE_RATE,
      ),
      latencyMs: clamp(partial.latencyMs ?? this.#config.latencyMs, 0, MAX_LATENCY_MS),
      jitterMs: clamp(partial.jitterMs ?? this.#config.jitterMs, 0, MAX_JITTER_MS),
      reorderWindow: Math.round(
        clamp(partial.reorderWindow ?? this.#config.reorderWindow, 0, MAX_REORDER_WINDOW),
      ),
    };
    return this.#config;
  }

  getConfig(): ChaosConfig {
    return this.#config;
  }

  /** Back to a clean network: zeroed knobs, partition cleared, nothing left buffered. */
  reset(): void {
    this.#config = DEFAULT_CHAOS_CONFIG;
    this.#partitionEndsAt = undefined;
    this.#reorderBuffers.clear();
  }

  /** Total outage: every send is dropped until this heals, regardless of `dropRate`. */
  startPartition(durationMs: number): { readonly endsAt: number } {
    const clampedDuration = clamp(durationMs, 0, MAX_PARTITION_MS);
    this.#partitionEndsAt = this.#clock.now() + clampedDuration;
    return { endsAt: this.#partitionEndsAt };
  }

  isPartitioned(): boolean {
    return this.#partitionEndsAt !== undefined && this.#clock.now() < this.#partitionEndsAt;
  }

  partitionRemainingMs(): number {
    if (!this.isPartitioned()) return 0;
    return this.#partitionEndsAt! - this.#clock.now();
  }

  /**
   * `pid` scopes the reorder buffer to one connection's own traffic —
   * real reordering never mixes two different recipients' packets — and
   * every drop/duplicate/latency decision below is rolled independently
   * per `(pid, message)`, not shared across one broadcast's whole fan-out.
   */
  send(pid: ParticipantId, message: OutboundMessage, rawSend: () => void): void {
    if (this.isPartitioned()) {
      this.#onDrop?.(pid, message);
      return;
    }

    const window = this.#config.reorderWindow;
    if (window <= 0) {
      this.#dispatch(pid, message, rawSend);
      return;
    }

    const buffer = this.#reorderBuffers.get(pid) ?? [];
    buffer.push({ message, rawSend });
    this.#reorderBuffers.set(pid, buffer);

    if (buffer.length > window) {
      const index = Math.floor(this.#random() * buffer.length);
      const picked = buffer.splice(index, 1)[0];
      if (picked) this.#dispatch(pid, picked.message, picked.rawSend);
    }
  }

  /** Releases anything still buffered for reordering, in arrival order — nothing is left silently stuck when the window is turned down or off. */
  flush(pid?: ParticipantId): void {
    const targets = pid !== undefined ? [pid] : Array.from(this.#reorderBuffers.keys());
    for (const target of targets) {
      const buffer = this.#reorderBuffers.get(target);
      if (!buffer) continue;
      this.#reorderBuffers.delete(target);
      for (const queued of buffer) this.#dispatch(target, queued.message, queued.rawSend);
    }
  }

  #dispatch(pid: ParticipantId, message: OutboundMessage, rawSend: () => void): void {
    if (this.#random() < this.#config.dropRate) {
      this.#onDrop?.(pid, message);
      return;
    }

    this.#deliver(pid, message, rawSend);

    if (this.#random() < this.#config.duplicateRate) {
      this.#onDuplicate?.(pid, message);
      this.#deliver(pid, message, rawSend);
    }
  }

  #deliver(pid: ParticipantId, message: OutboundMessage, rawSend: () => void): void {
    const jitter = this.#config.jitterMs > 0 ? (this.#random() * 2 - 1) * this.#config.jitterMs : 0;
    const delay = Math.max(0, this.#config.latencyMs + jitter);

    if (delay <= 0) {
      rawSend();
      this.#onDeliver?.(pid, message, this.#clock.now());
      return;
    }

    this.#setTimeoutFn(() => {
      rawSend();
      this.#onDeliver?.(pid, message, this.#clock.now());
    }, delay);
  }
}
