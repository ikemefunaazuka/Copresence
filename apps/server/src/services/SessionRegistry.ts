import type { ParticipantId, SessionId } from '@copresence/protocol';

import type { Clock } from '../lib/clock.js';
import { createSession, isEmpty, removeParticipant } from '../models/Session.js';
import type { Session } from '../models/Session.js';

/**
 * The storage port. In-memory (`SessionRegistry` below) is the only
 * implementation this repository builds — see the project plan's Data &
 * Persistence section for why that is a considered choice, not an
 * omission. The interface is the point: a Redis-backed implementation
 * for horizontal scale-out is a new file behind this port, not a
 * refactor of every caller.
 */
export interface SessionStore {
  get(sid: SessionId): Session | undefined;
  getOrCreate(sid: SessionId): Session;
  save(session: Session): void;
  delete(sid: SessionId): void;
  all(): readonly Session[];
}

/** A participant the TTL reaper removed, for the caller to react to (broadcast `leave`, write an audit record). */
export interface ReapedParticipant {
  readonly sid: SessionId;
  readonly pid: ParticipantId;
  readonly lastSeenAt: number;
}

/**
 * `Map<SessionId, Session>` behind the `SessionStore` port, plus the TTL
 * reaper: `ws` does not detect a half-open TCP connection for you, so a
 * participant who vanished without a clean `bye` would otherwise sit in
 * the roster forever, a ghost cursor on
 * everyone else's screen. `reapStale` sweeps them out and reports exactly
 * who was removed and from where, so the caller can broadcast a `leave`
 * and write the inferred audit record — this class only owns the storage
 * decision, not what reaping means to the rest of the system.
 */
export class SessionRegistry implements SessionStore {
  #sessions = new Map<SessionId, Session>();
  #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get(sid: SessionId): Session | undefined {
    return this.#sessions.get(sid);
  }

  getOrCreate(sid: SessionId): Session {
    const existing = this.#sessions.get(sid);
    if (existing) return existing;
    const created = createSession(sid, this.#clock.now());
    this.#sessions.set(sid, created);
    return created;
  }

  save(session: Session): void {
    this.#sessions.set(session.sid, session);
  }

  delete(sid: SessionId): void {
    this.#sessions.delete(sid);
  }

  all(): readonly Session[] {
    return Array.from(this.#sessions.values());
  }

  /**
   * Removes every participant whose `lastSeenAt` is older than `ttlMs`,
   * across every session, and drops any session left with no participants
   * at all. Total and idempotent: calling this with nothing stale is a
   * no-op that reports an empty list.
   */
  reapStale(ttlMs: number): readonly ReapedParticipant[] {
    const now = this.#clock.now();
    const reaped: ReapedParticipant[] = [];

    for (const session of this.#sessions.values()) {
      let next = session;
      for (const participant of session.participants.values()) {
        if (now - participant.lastSeenAt <= ttlMs) continue;
        reaped.push({ sid: session.sid, pid: participant.pid, lastSeenAt: participant.lastSeenAt });
        next = removeParticipant(next, participant.pid);
      }

      if (next === session) continue; // nothing changed for this session

      if (isEmpty(next)) {
        this.#sessions.delete(session.sid);
      } else {
        this.#sessions.set(session.sid, next);
      }
    }

    return reaped;
  }
}
