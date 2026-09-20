import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { LeaveMessage } from '@copresence/protocol';

import type { Clock } from '../lib/clock.js';
import { generateId } from '../lib/id.js';

import type { AuditLog } from './AuditLog.js';
import type { BroadcastHub } from './BroadcastHub.js';
import type { SessionRegistry } from './SessionRegistry.js';

export interface ReaperDeps {
  readonly registry: SessionRegistry;
  readonly hub: BroadcastHub;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly ttlMs: number;
}

/**
 * The server never waits to be told a session ended:
 * `SessionRegistry.reapStale` finds participants nobody has heard from in
 * a while, and this is what happens to each one — an audit record tagged
 * `source: 'inferred'` (nobody reported this; the server noticed it), and
 * a `leave` broadcast to whoever is left, exactly as if they had said
 * goodbye.
 *
 * Runs on its own, slower timer, separate from `TickScheduler`'s 20 Hz
 * presence loop — a TTL sweep has no business running twenty times a
 * second.
 */
export class Reaper {
  #deps: ReaperDeps;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: ReaperDeps) {
    this.#deps = deps;
  }

  start(intervalMs: number): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Exposed directly so tests can trigger a sweep without waiting on a real timer. */
  sweep(): void {
    const reaped = this.#deps.registry.reapStale(this.#deps.ttlMs);
    const now = this.#deps.clock.now();

    for (const participant of reaped) {
      this.#deps.hub.unregister(participant.pid);

      this.#deps.auditLog.record({
        eventId: generateId(),
        sid: participant.sid,
        pid: participant.pid,
        kind: 'session.end',
        source: 'inferred',
        recordedAt: now,
        detail: { reason: 'heartbeat timeout', lastSeenAt: participant.lastSeenAt },
      });

      const leaveMessage: LeaveMessage = {
        v: PROTOCOL_VERSION,
        t: 'leave',
        sid: participant.sid,
        seq: 0,
        ts: now,
        pid: participant.pid,
      };
      this.#deps.hub.broadcastToSession(participant.sid, leaveMessage, participant.pid);
    }
  }
}
