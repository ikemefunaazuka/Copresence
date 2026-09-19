import type { ParticipantId, SessionId } from '@copresence/protocol';

import { createParticipant, touchParticipant, withViewport } from './Participant.js';
import type { Participant } from './Participant.js';

/** Which presence fields have changed for a participant since the last flush. */
export interface PresenceDirty {
  readonly cursor: boolean;
  readonly scroll: boolean;
}

/**
 * The roster and per-participant presence for one session, plus dirty-
 * field tracking for delta emission (MILESTONE Phase 1). Every mutation
 * returns a new `Session` — this is a pure, immutable update pattern, not
 * a class with internal mutable state, so equality and time-travel in
 * tests are just object comparison.
 *
 * Dirty tracking here covers presence fields (cursor/scroll) only, which
 * is what Phase 2's coalesced `patch` broadcast needs to build a minimal
 * delta. Roster changes (join/leave) are LOSSLESS and, per the message
 * classification, sent immediately rather than batched — they need no
 * dirty tracking of their own.
 */
export interface Session {
  readonly sid: SessionId;
  readonly participants: ReadonlyMap<ParticipantId, Participant>;
  readonly createdAt: number;
  readonly dirty: ReadonlyMap<ParticipantId, PresenceDirty>;
}

export function createSession(sid: SessionId, now: number): Session {
  return { sid, participants: new Map(), createdAt: now, dirty: new Map() };
}

/** Idempotent: adding a participant who is already present is a no-op. */
export function addParticipant(session: Session, pid: ParticipantId, now: number): Session {
  if (session.participants.has(pid)) return session;
  const next = new Map(session.participants);
  next.set(pid, createParticipant(pid, now));
  return { ...session, participants: next };
}

/** Idempotent: removing a participant who is already gone is a no-op. */
export function removeParticipant(session: Session, pid: ParticipantId): Session {
  if (!session.participants.has(pid)) return session;
  const nextParticipants = new Map(session.participants);
  nextParticipants.delete(pid);
  return { ...clearDirtyFor(session, pid), participants: nextParticipants };
}

/**
 * Total: applying an updater to an unknown participant is a no-op rather
 * than a thrown error.
 */
export function updateParticipant(
  session: Session,
  pid: ParticipantId,
  updater: (participant: Participant) => Participant,
): Session {
  const existing = session.participants.get(pid);
  if (!existing) return session;
  const next = new Map(session.participants);
  next.set(pid, updater(existing));
  return { ...session, participants: next };
}

export function touchAndSetViewport(
  session: Session,
  pid: ParticipantId,
  docWidth: number,
  docHeight: number,
  dpr: number,
  now: number,
): Session {
  return updateParticipant(session, pid, (participant) =>
    touchParticipant(withViewport(participant, docWidth, docHeight, dpr), now),
  );
}

export function isEmpty(session: Session): boolean {
  return session.participants.size === 0;
}

/** Merges `fields` (true values only) into whatever is already dirty for `pid`. */
export function markPresenceDirty(
  session: Session,
  pid: ParticipantId,
  fields: Partial<PresenceDirty>,
): Session {
  const existing: PresenceDirty = session.dirty.get(pid) ?? { cursor: false, scroll: false };
  const merged: PresenceDirty = {
    cursor: existing.cursor || fields.cursor === true,
    scroll: existing.scroll || fields.scroll === true,
  };
  if (
    merged.cursor === existing.cursor &&
    merged.scroll === existing.scroll &&
    session.dirty.has(pid)
  ) {
    return session;
  }
  const nextDirty = new Map(session.dirty);
  nextDirty.set(pid, merged);
  return { ...session, dirty: nextDirty };
}

/** Called by the (Phase 2) tick scheduler once a patch has been flushed for everyone. */
export function clearDirty(session: Session): Session {
  if (session.dirty.size === 0) return session;
  return { ...session, dirty: new Map() };
}

export function clearDirtyFor(session: Session, pid: ParticipantId): Session {
  if (!session.dirty.has(pid)) return session;
  const next = new Map(session.dirty);
  next.delete(pid);
  return { ...session, dirty: next };
}
