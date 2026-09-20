import { PATCH_SETTLE_WINDOW_MS, PROTOCOL_VERSION } from '@copresence/protocol';
import type { ParticipantPatch, PatchMessage, SessionId } from '@copresence/protocol';

import type { Clock } from '../lib/clock.js';
import { clearDirty } from '../models/Session.js';
import { toPatch } from '../views/presenters.js';

import type { BroadcastHub } from './BroadcastHub.js';
import type { MetricsCollector } from './MetricsCollector.js';
import type { SessionRegistry } from './SessionRegistry.js';

export interface TickSchedulerDeps {
  readonly registry: SessionRegistry;
  readonly hub: BroadcastHub;
  readonly clock: Clock;
  readonly tickRateHz: number;
  /** Optional — records one "patch emitted" per non-empty broadcast, the denominator of the coalescing ratio. */
  readonly metrics?: MetricsCollector;
}

interface SettleEntry {
  readonly patches: readonly ParticipantPatch[];
  readonly settleUntil: number;
}

/**
 * Owns the 20 Hz timer and what happens on every tick of it. The server
 * never forwards a `cursor`/`scroll` message as it arrives — `applyEvent`
 * already folded it into `Session`'s dirty-field state, and this is
 * where that state actually goes out: build the coalesced patch,
 * broadcast it, clear the dirty flags. A session with nothing dirty
 * costs nothing here — `toPatch` returns `undefined` and the tick moves
 * on (docs/adr/0003) — except during its settle window, see below.
 *
 * Patches carry absolute, last-writer-wins values and are broadcast
 * exactly once per dirty flush, with no acknowledgement or redelivery.
 * Under any packet loss, that single final patch after real movement
 * stops could simply never arrive for someone — and nothing would ever
 * correct it, since nothing stays dirty once input has stopped. So for
 * `PATCH_SETTLE_WINDOW_MS` after a session's last genuinely dirty tick,
 * this keeps re-broadcasting that same last-known content on every
 * subsequent tick (each still carrying a fresh, higher seq, so it is
 * never mistaken for a stale duplicate) — cheap insurance against exactly
 * the packet loss this project's chaos lab exists to simulate, without
 * needing a full ack/retry mechanism.
 *
 * `tick()` is exposed as a plain method precisely so tests can call it
 * directly rather than waiting on a real interval to fire.
 */
export class TickScheduler {
  #registry: SessionRegistry;
  #hub: BroadcastHub;
  #clock: Clock;
  #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #seq = 0;
  #metrics: MetricsCollector | undefined;
  #settling = new Map<SessionId, SettleEntry>();

  constructor(deps: TickSchedulerDeps) {
    this.#registry = deps.registry;
    this.#hub = deps.hub;
    this.#clock = deps.clock;
    this.#intervalMs = 1000 / deps.tickRateHz;
    this.#metrics = deps.metrics;
  }

  start(): void {
    if (this.#timer) return; // idempotent — calling start() twice does not double the rate
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    // Does not, on its own, keep the Node process alive — matters for
    // graceful shutdown and for tests that never call start() at all.
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  isRunning(): boolean {
    return this.#timer !== undefined;
  }

  tick(): void {
    this.#seq += 1;
    const now = this.#clock.now();

    for (const session of this.#registry.all()) {
      const patch = toPatch(session, this.#seq, now);
      if (patch) {
        this.#hub.broadcastToSession(session.sid, patch);
        this.#metrics?.recordPatchEmitted();
        this.#registry.save(clearDirty(session));
        this.#settling.set(session.sid, {
          patches: patch.patches,
          settleUntil: now + PATCH_SETTLE_WINDOW_MS,
        });
        continue;
      }

      const settle = this.#settling.get(session.sid);
      if (!settle) continue;
      if (now >= settle.settleUntil) {
        this.#settling.delete(session.sid);
        continue;
      }
      const resend: PatchMessage = {
        v: PROTOCOL_VERSION,
        t: 'patch',
        sid: session.sid,
        seq: this.#seq,
        ts: now,
        patches: settle.patches,
      };
      this.#hub.broadcastToSession(session.sid, resend);
      // Still one broadcast operation, and still real outbound bytes —
      // counting it keeps the coalescing ratio an honest reflection of
      // actual traffic rather than only counting genuinely-new data.
      this.#metrics?.recordPatchEmitted();
    }
  }
}
