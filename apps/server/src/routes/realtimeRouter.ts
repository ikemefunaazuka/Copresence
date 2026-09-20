import { PROTOCOL_VERSION, decodeInbound, isAuditMessage } from '@copresence/protocol';
import type { ErrorCode, ErrorMessage } from '@copresence/protocol';

import { handleAuditMessage } from '../controllers/AuditController.js';
import { handleBye, handleHello, handlePing } from '../controllers/ConnectionController.js';
import { handleCursor, handleScroll } from '../controllers/PresenceController.js';
import type { ConnectionContext, ControllerDeps } from '../controllers/types.js';
import type { Logger } from '../lib/logger.js';

/**
 * The realtime dispatch table: `messageType → controller`, mirroring the
 * HTTP router (MILESTONE §2.1). TypeScript cannot type a `Record`-keyed
 * lookup table safely over a discriminated union without an unsafe cast
 * at every entry — so the actual narrowing below is a `switch`, but built
 * to have the property that matters: one line per case, no inline logic,
 * every case calling straight into an independently-testable controller
 * function. That is the real architectural goal "a dispatch table, not a
 * switch sprawled through the handler" is protecting against, whichever
 * JS construct expresses it.
 */
function sendError(
  ctx: ConnectionContext,
  code: ErrorCode,
  detail: string,
  sid: ConnectionContext['sid'],
  now: number,
): void {
  const message: ErrorMessage = {
    v: PROTOCOL_VERSION,
    t: 'error',
    sid,
    seq: 0,
    ts: now,
    code,
    detail,
  };
  if (ctx.socket.readyState === ctx.socket.OPEN) {
    ctx.socket.send(JSON.stringify(message));
  }
}

/**
 * Handles one raw frame from one connection. Never throws — a malformed
 * or adversarial frame gets an `error` frame back and the connection
 * survives (MILESTONE Phase 2 exit criteria), exactly like `decodeInbound`
 * itself is total by construction (MILESTONE Phase 1).
 */
export function handleRealtimeMessage(
  ctx: ConnectionContext,
  raw: string,
  deps: ControllerDeps,
  logger: Logger,
): void {
  const now = deps.clock.now();
  const result = decodeInbound(raw);

  if (!result.ok) {
    const code: ErrorCode = result.error.kind;
    const detail =
      result.error.kind === 'malformed-json'
        ? result.error.detail
        : result.error.kind === 'validation-failed'
          ? result.error.issues.join('; ')
          : `expected v${result.error.expected}, received v${result.error.received}`;
    sendError(ctx, code, detail, ctx.sid, now);
    return;
  }

  const msg = result.message;

  // Handshake required: the first message on a connection must be `hello`.
  if (!ctx.pid && msg.t !== 'hello') {
    sendError(ctx, 'unauthorized', 'hello must be the first message on a connection', ctx.sid, now);
    return;
  }

  // Identity is fixed at handshake — no message may claim a different pid
  // than the one this connection registered with.
  if (ctx.pid && msg.pid !== ctx.pid) {
    sendError(ctx, 'unauthorized', 'pid does not match this connection', ctx.sid, now);
    return;
  }

  // Duplicate or out-of-order at the connection level: expected, not an
  // error (docs/adr/0009) — silently dropped, logged for visibility only.
  if (!ctx.sequenceGuard.accept(msg.seq)) {
    logger.debug(
      { sid: ctx.sid, pid: msg.pid, seq: msg.seq, type: msg.t },
      'dropped stale/duplicate seq',
    );
    return;
  }

  if (isAuditMessage(msg)) {
    handleAuditMessage(ctx, msg, deps);
    return;
  }

  switch (msg.t) {
    case 'hello':
      handleHello(ctx, msg, deps);
      return;
    case 'bye':
      handleBye(ctx, msg, deps);
      return;
    case 'ping':
      handlePing(ctx, msg, deps);
      return;
    case 'cursor':
      handleCursor(ctx, msg, deps);
      return;
    case 'scroll':
      handleScroll(ctx, msg, deps);
      return;
    case 'ack':
      // Nothing consumes acks yet — no lossless-redelivery mechanism is
      // built until a later phase needs one. Accepting and discarding is
      // correct for now: an ack the server does nothing with is inert,
      // not wrong.
      return;
  }
}
