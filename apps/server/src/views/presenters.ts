import { PROTOCOL_VERSION } from '@copresence/protocol';
import type {
  ParticipantId,
  ParticipantPatch,
  ParticipantSnapshot,
  PatchMessage,
  SessionId,
  SnapshotMessage,
  WelcomeMessage,
} from '@copresence/protocol';

import type { Participant } from '../models/Participant.js';
import type { Session } from '../models/Session.js';

/**
 * Presenters: domain state → wire DTOs, and nothing else. No business
 * logic, no I/O (MILESTONE §2.1, the `views/` row) — every function here
 * is a pure mapping a controller calls once it already has the state it
 * needs.
 *
 * `exactOptionalPropertyTypes` means an absent cursor/scroll cannot be
 * expressed as `x: undefined` — the key must be omitted entirely, not
 * present with an undefined value — so these build the optional fields
 * with a conditional spread rather than a direct assignment.
 */
function toParticipantSnapshot(participant: Participant): ParticipantSnapshot {
  const { cursor, scroll } = participant.presence;
  return {
    pid: participant.pid,
    color: participant.color,
    lastSeenAt: participant.lastSeenAt,
    ...(cursor ? { x: cursor.x, y: cursor.y } : {}),
    ...(scroll ? { scrollX: scroll.x, scrollY: scroll.y } : {}),
  };
}

function toParticipantSnapshots(session: Session): readonly ParticipantSnapshot[] {
  return Array.from(session.participants.values(), toParticipantSnapshot);
}

/** Sent once, to the connecting client only, on a successful handshake. */
export function toWelcome(
  session: Session,
  connectingPid: ParticipantId,
  seq: number,
  now: number,
): WelcomeMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'welcome',
    sid: session.sid,
    pid: connectingPid,
    seq,
    ts: now,
    participants: toParticipantSnapshots(session),
  };
}

/** The full roster, broadcast to everyone on a resync (e.g. after reconnect). */
export function toSnapshot(session: Session, seq: number, now: number): SnapshotMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'snapshot',
    sid: session.sid,
    seq,
    ts: now,
    participants: toParticipantSnapshots(session),
  };
}

/**
 * The coalesced tick output — only the fields marked dirty since the last
 * flush, one entry per participant who actually changed. Returns
 * `undefined` when nothing is dirty, so the (Phase 2) tick scheduler can
 * skip broadcasting an empty patch entirely, the whole point of Session's
 * dirty-field tracking (MILESTONE Phase 1).
 */
export function toPatch(session: Session, seq: number, now: number): PatchMessage | undefined {
  if (session.dirty.size === 0) return undefined;

  const patches: ParticipantPatch[] = [];
  for (const [pid, dirty] of session.dirty) {
    const participant = session.participants.get(pid);
    if (!participant) continue; // left between being marked dirty and this flush — nothing to report

    const { cursor, scroll } = participant.presence;
    const patch: ParticipantPatch = {
      pid,
      ...(dirty.cursor && cursor ? { x: cursor.x, y: cursor.y } : {}),
      ...(dirty.scroll && scroll ? { scrollX: scroll.x, scrollY: scroll.y } : {}),
    };
    patches.push(patch);
  }

  if (patches.length === 0) return undefined;

  return { v: PROTOCOL_VERSION, t: 'patch', sid: session.sid, seq, ts: now, patches };
}

/** A plain, JSON-serialisable summary for the HTTP session-inspection endpoint — not a protocol message. */
export interface SessionDTO {
  readonly sid: SessionId;
  readonly createdAt: number;
  readonly participantCount: number;
  readonly participants: readonly {
    readonly pid: ParticipantId;
    readonly color: string;
    readonly lastSeenAt: number;
  }[];
}

export function toSessionDTO(session: Session): SessionDTO {
  return {
    sid: session.sid,
    createdAt: session.createdAt,
    participantCount: session.participants.size,
    participants: Array.from(session.participants.values(), (p) => ({
      pid: p.pid,
      color: p.color,
      lastSeenAt: p.lastSeenAt,
    })),
  };
}
