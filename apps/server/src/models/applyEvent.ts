import type { ByeMessage, CursorMessage, HelloMessage, ScrollMessage } from '@copresence/protocol';

import { withCursor, withScroll } from './PresenceState.js';
import {
  addParticipant,
  markPresenceDirty,
  removeParticipant,
  touchAndSetViewport,
  updateParticipant,
} from './Session.js';
import type { Session } from './Session.js';

/**
 * The presence-affecting subset of `InboundMessage`. Audit messages
 * (session.*, participant.*, visibility.change) and control messages
 * (ping/ack) do not mutate presence state and are handled elsewhere
 * (Phase 2's AuditLog service and connection controller, respectively) —
 * `models/` only owns what changes `Session`.
 */
export type SessionEvent = HelloMessage | CursorMessage | ScrollMessage | ByeMessage;

/** Which parts of a session changed as a result of one `applyEvent` call. */
export interface FieldMask {
  readonly cursor: boolean;
  readonly scroll: boolean;
  readonly roster: boolean;
}

const NO_CHANGE: FieldMask = { cursor: false, scroll: false, roster: false };

export interface ApplyResult {
  readonly state: Session;
  readonly changed: FieldMask;
}

function unchanged(session: Session): ApplyResult {
  return { state: session, changed: NO_CHANGE };
}

/**
 * The single reducer every presence-affecting inbound message passes
 * through. Pure and total: every branch returns a `Session` — the exact
 * same reference when nothing changed — and `changed` tells the (Phase 2)
 * broadcaster whether this tick has anything worth sending, so a no-op
 * tick can be skipped cheaply under load.
 *
 * Precise no-op detection matters most for `cursor`/`scroll` (the hot
 * path the tick-skipping optimisation exists for); `hello` always reports
 * `roster: true` when processed, since it always touches at least
 * `lastSeenAt` — see PresenceState.withCursor/withScroll for how
 * reference-equality no-ops are actually produced.
 */
export function applyEvent(session: Session, event: SessionEvent): ApplyResult {
  switch (event.t) {
    case 'hello': {
      const withParticipant = addParticipant(session, event.pid, event.ts);
      const next = touchAndSetViewport(
        withParticipant,
        event.pid,
        event.docWidth,
        event.docHeight,
        event.dpr,
        event.ts,
      );
      return { state: next, changed: { cursor: false, scroll: false, roster: true } };
    }

    case 'cursor': {
      const participant = session.participants.get(event.pid);
      if (!participant) return unchanged(session);

      const updatedPresence = withCursor(
        participant.presence,
        { x: event.x, y: event.y },
        event.seq,
      );
      if (updatedPresence === participant.presence) return unchanged(session);

      const next = updateParticipant(session, event.pid, (p) => ({
        ...p,
        presence: updatedPresence,
      }));
      return {
        state: markPresenceDirty(next, event.pid, { cursor: true }),
        changed: { cursor: true, scroll: false, roster: false },
      };
    }

    case 'scroll': {
      const participant = session.participants.get(event.pid);
      if (!participant) return unchanged(session);

      const updatedPresence = withScroll(
        participant.presence,
        { x: event.scrollX, y: event.scrollY },
        event.seq,
      );
      if (updatedPresence === participant.presence) return unchanged(session);

      const next = updateParticipant(session, event.pid, (p) => ({
        ...p,
        presence: updatedPresence,
      }));
      return {
        state: markPresenceDirty(next, event.pid, { scroll: true }),
        changed: { cursor: false, scroll: true, roster: false },
      };
    }

    case 'bye': {
      if (!session.participants.has(event.pid)) return unchanged(session);
      return {
        state: removeParticipant(session, event.pid),
        changed: { cursor: false, scroll: false, roster: true },
      };
    }
  }
}
