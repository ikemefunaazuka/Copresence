import type { AuditMessage } from '@copresence/protocol';

import type { ConnectionContext, ControllerDeps } from './types.js';

/**
 * The five audit/lifecycle message kinds (MILESTONE Phase 1), arriving
 * over the live socket — one of the two write paths Phase 2 wires into
 * `AuditLog`, tagged `source: 'client'` because the client is the one
 * reporting them, just over this transport rather than the `POST
 * /audit/beacon` path Phase 6 adds. Idempotency on `eventId` is
 * `AuditLog.record`'s job, not this controller's — a duplicate (the
 * canonical case being a message resent after a dropped `ack`) is simply
 * recorded as a no-op.
 */
export function handleAuditMessage(ctx: ConnectionContext, msg: AuditMessage, deps: ControllerDeps): void {
  deps.auditLog.record({
    eventId: msg.eventId,
    sid: ctx.sid,
    pid: msg.pid,
    kind: msg.t,
    source: 'client',
    recordedAt: deps.clock.now(),
    ...(msg.t === 'session.end' ? { detail: { reason: msg.reason } } : {}),
  });
}
