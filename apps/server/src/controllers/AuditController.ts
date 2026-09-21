import {
  decodeInbound,
  isAuditMessage,
  PROTOCOL_VERSION,
  SessionIdSchema,
} from '@copresence/protocol';
import type { AuditAckMessage, AuditMessage, SessionId } from '@copresence/protocol';
import type { Request, Response } from 'express';

import type { ConnectionContext, ControllerDeps } from './types.js';

/** Shared by both write paths below — `source` is the only thing that differs between them. */
function recordAuditMessage(
  msg: AuditMessage,
  sid: SessionId,
  source: 'client',
  deps: ControllerDeps,
): void {
  deps.auditLog.record({
    eventId: msg.eventId,
    sid,
    pid: msg.pid,
    kind: msg.t,
    source,
    recordedAt: deps.clock.now(),
    ...(msg.t === 'session.end' ? { detail: { reason: msg.reason } } : {}),
  });
}

/**
 * The five audit/lifecycle message kinds, arriving over the live socket
 * — one of the two write paths that feed `AuditLog`, tagged
 * `source: 'client'` because the client is the one reporting them, just
 * over this transport rather than the `POST /audit/beacon` path below.
 * The `POST` path is acknowledged by its own HTTP response; this one
 * always sends back `audit.ack` — including for a duplicate, which is
 * exactly the case that most needs one (a resend after a dropped
 * `audit.ack` on the *first* attempt must still convince the client's
 * outbox it can stop retrying).
 */
export function handleAuditMessage(
  ctx: ConnectionContext,
  msg: AuditMessage,
  deps: ControllerDeps,
): void {
  recordAuditMessage(msg, ctx.sid, 'client', deps);

  const ack: AuditAckMessage = {
    v: PROTOCOL_VERSION,
    t: 'audit.ack',
    sid: ctx.sid,
    seq: 0,
    ts: deps.clock.now(),
    eventId: msg.eventId,
  };
  deps.hub.sendTo(msg.pid, ack);
}

/**
 * `POST /audit/beacon` — the write path for an audit event sent while the
 * page has no live connection to send it over instead (see ADR 0011): a
 * `visibilitychange`/`pagehide` firing after the socket already closed,
 * or before a reconnect has completed. Reuses `decodeInbound` — the exact
 * same parse-and-validate path the live socket goes through — so a
 * beacon body is held to the same standard, not a looser one.
 *
 * The HTTP response itself *is* the acknowledgement here: a 200 means
 * `AuditLog.record` ran (idempotently — a resend of an already-recorded
 * `eventId` still answers 200), so the client's outbox may clear this
 * entry once it sees one. There is no separate `audit.ack` message for
 * this path; unlike the live socket, there is nothing to send it over.
 */
export function createAuditController(deps: ControllerDeps) {
  return {
    beacon: (req: Request, res: Response): void => {
      const body = typeof req.body === 'string' ? req.body : '';
      const result = decodeInbound(body);
      if (!result.ok) {
        res.status(400).json({ error: result.error.kind });
        return;
      }
      if (!isAuditMessage(result.message)) {
        res.status(400).json({ error: 'not an audit message' });
        return;
      }

      const msg = result.message;
      recordAuditMessage(msg, msg.sid, 'client', deps);
      res.status(200).json({ eventId: msg.eventId, acked: true });
    },

    /** For the inspector's audit-trail view — every record for a session, oldest first. */
    list: (req: Request, res: Response): void => {
      const parsed = SessionIdSchema.safeParse(req.params['sid']);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid session id' });
        return;
      }
      const records = [...deps.auditLog.forSession(parsed.data)].sort(
        (a, b) => a.recordedAt - b.recordedAt,
      );
      res.status(200).json({ records });
    },
  };
}
