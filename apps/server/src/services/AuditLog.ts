import type { AuditMessage, ParticipantId, SessionId } from '@copresence/protocol';

/**
 * Where an audit record came from — three reporting paths that will
 * eventually converge on one record: `client` (a beacon, landing later),
 * `socket` (the live connection, built here), and `inferred` (the reaper
 * noticing a participant vanished, also built here). Only two of the
 * three sources exist yet; the type already has room for the third so
 * adding it later is additive, not a rewrite.
 */
export type AuditSource = 'client' | 'socket' | 'inferred';

export type AuditEventKind = AuditMessage['t'];

/** One path's report of a logical event, kept in arrival order — `reports[0]` answers "which path saw this first", and `reports.length`/counting by `source` answers "how many times has this been reported" (see ADR 0013). */
export interface AuditReport {
  readonly source: AuditSource;
  readonly recordedAt: number;
}

export interface AuditRecordInput {
  readonly eventId: string;
  readonly sid: SessionId;
  readonly pid: ParticipantId;
  readonly kind: AuditEventKind;
  readonly source: AuditSource;
  readonly recordedAt: number;
  readonly detail?: Record<string, unknown>;
}

export interface AuditRecord extends AuditRecordInput {
  readonly reports: readonly AuditReport[];
}

/**
 * Append-only and idempotent on `eventId` — but idempotency alone is not
 * enough for `session.end`: `client` (beacon), `socket` (connection
 * close) and `inferred` (reconciliation sweep) each generate their OWN
 * `eventId` when they independently notice the same session closing, so
 * a literal `eventId` match would never catch that convergence. For
 * `session.end` specifically, a second report is also recognised by
 * *closing the same still-open instance* — the one most recently opened
 * by a `session.start` with no `session.end` after it — and folded into
 * the existing record's `reports` rather than stored as a second,
 * independent event. A `session.end` for an instance a fresh
 * `session.start` has since reopened is a genuinely new event, not a
 * duplicate of the old one. See ADR 0013.
 */
export class AuditLog {
  #records = new Map<string, AuditRecord>();

  /** Returns `false` — a true no-op as far as the stored *count* of events goes — when this report converges onto an existing record (same `eventId`, or the same still-open `session.end` instance) instead of creating a new one. */
  record(entry: AuditRecordInput): boolean {
    const report: AuditReport = { source: entry.source, recordedAt: entry.recordedAt };

    const existingById = this.#records.get(entry.eventId);
    if (existingById) {
      this.#records.set(entry.eventId, {
        ...existingById,
        reports: [...existingById.reports, report],
      });
      return false;
    }

    if (entry.kind === 'session.end') {
      const convergent = this.#openSessionEnd(entry.sid, entry.pid);
      if (convergent) {
        this.#records.set(convergent.eventId, {
          ...convergent,
          reports: [...convergent.reports, report],
        });
        return false;
      }
    }

    this.#records.set(entry.eventId, { ...entry, reports: [report] });
    return true;
  }

  has(eventId: string): boolean {
    return this.#records.has(eventId);
  }

  get(eventId: string): AuditRecord | undefined {
    return this.#records.get(eventId);
  }

  all(): readonly AuditRecord[] {
    return Array.from(this.#records.values());
  }

  forSession(sid: SessionId): readonly AuditRecord[] {
    return this.all().filter((record) => record.sid === sid);
  }

  /** The `session.end` record, if any, that already closes `(sid, pid)`'s currently-open instance. */
  #openSessionEnd(sid: SessionId, pid: ParticipantId): AuditRecord | undefined {
    let latestStart: AuditRecord | undefined;
    let latestEnd: AuditRecord | undefined;
    for (const record of this.#records.values()) {
      if (record.sid !== sid || record.pid !== pid) continue;
      if (record.kind === 'session.start') {
        if (!latestStart || record.recordedAt > latestStart.recordedAt) latestStart = record;
      } else if (record.kind === 'session.end') {
        if (!latestEnd || record.recordedAt > latestEnd.recordedAt) latestEnd = record;
      }
    }
    if (!latestEnd) return undefined;
    // A newer session.start has already reopened this (sid, pid) since latestEnd closed it — that makes this a fresh close, not a duplicate of the old one.
    if (latestStart && latestStart.recordedAt > latestEnd.recordedAt) return undefined;
    return latestEnd;
  }
}
