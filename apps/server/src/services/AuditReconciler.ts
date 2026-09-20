import type { Clock } from '../lib/clock.js';
import { generateId } from '../lib/id.js';

import type { AuditLog, AuditRecord } from './AuditLog.js';

export interface AuditReconcilerDeps {
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly ttlMs: number;
}

/**
 * The independent safety net behind the `client`/`socket`/`inferred`
 * paths that normally close a `session.start`: on its own, slower timer,
 * separate from `TickScheduler` and `Reaper`, this looks for any
 * participant whose most recent `session.start` has no `session.end`
 * *after* it (from any of the three sources) once `ttlMs` has passed,
 * and writes one itself, tagged `source: 'inferred'` — the same tag
 * `Reaper` uses for the same reason: nobody reported this, the system
 * noticed it. See ADR 0013.
 *
 * "Most recent" matters because one participant can have several
 * start/end pairs across a session (a `hidden → visible → hidden` cycle
 * emits a fresh pair each time, see `client/lifecycle`) — an old,
 * already-closed pair must never block reconciling a newer one.
 */
export class AuditReconciler {
  #deps: AuditReconcilerDeps;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: AuditReconcilerDeps) {
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
    const now = this.#deps.clock.now();
    const latestStart = new Map<string, AuditRecord>();
    const latestEnd = new Map<string, AuditRecord>();

    for (const record of this.#deps.auditLog.all()) {
      const key = `${record.sid}:${record.pid}`;
      if (record.kind === 'session.start') {
        const existing = latestStart.get(key);
        if (!existing || record.recordedAt > existing.recordedAt) latestStart.set(key, record);
      } else if (record.kind === 'session.end') {
        const existing = latestEnd.get(key);
        if (!existing || record.recordedAt > existing.recordedAt) latestEnd.set(key, record);
      }
    }

    for (const start of latestStart.values()) {
      const end = latestEnd.get(`${start.sid}:${start.pid}`);
      if (end && end.recordedAt >= start.recordedAt) continue; // already closed after this start
      if (now - start.recordedAt < this.#deps.ttlMs) continue; // still within the grace period

      this.#deps.auditLog.record({
        eventId: generateId(),
        sid: start.sid,
        pid: start.pid,
        kind: 'session.end',
        source: 'inferred',
        recordedAt: now,
        detail: { reason: 'reconciliation sweep: no session.end seen within TTL' },
      });
    }
  }
}
