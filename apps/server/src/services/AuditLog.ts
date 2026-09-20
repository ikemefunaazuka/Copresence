import type { AuditMessage, ParticipantId, SessionId } from '@copresence/protocol';

/**
 * Where an audit record came from — MILESTONE Phase 6 names three
 * reporting paths that will eventually converge on one record: `client`
 * (a beacon, landing in Phase 6), `socket` (the live connection, built
 * here), and `inferred` (the reaper noticing a participant vanished,
 * also built here). Phase 2 only has two of the three sources; the type
 * already has room for the third so Phase 6 is additive, not a rewrite.
 */
export type AuditSource = 'client' | 'socket' | 'inferred';

export type AuditEventKind = AuditMessage['t'];

export interface AuditRecord {
  readonly eventId: string;
  readonly sid: SessionId;
  readonly pid: ParticipantId;
  readonly kind: AuditEventKind;
  readonly source: AuditSource;
  readonly recordedAt: number;
  readonly detail?: Record<string, unknown>;
}

/**
 * Append-only and idempotent on `eventId` (MILESTONE Phase 2). In-memory
 * for now — Phase 6 is explicit that the audit log's JSONL persistence,
 * the reconciliation sweep, and the client beacon path are its own scope
 * (MILESTONE §3, Data & Persistence), not something Phase 2 needs to
 * anticipate beyond leaving the shape able to grow into it.
 */
export class AuditLog {
  #records = new Map<string, AuditRecord>();

  /** Returns `false` — a true no-op — when `eventId` was already recorded. */
  record(entry: AuditRecord): boolean {
    if (this.#records.has(entry.eventId)) return false;
    this.#records.set(entry.eventId, entry);
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
}
