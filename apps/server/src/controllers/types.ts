import type { ParticipantId, SessionId } from '@copresence/protocol';
import type { WebSocket } from 'ws';

import type { Clock } from '../lib/clock.js';
import { SequenceGuard } from '../models/SequenceGuard.js';
import type { AuditLog } from '../services/AuditLog.js';
import type { BroadcastHub } from '../services/BroadcastHub.js';
import type { SessionRegistry } from '../services/SessionRegistry.js';

/**
 * Realtime controllers take `(ctx, msg)`, mirroring HTTP's `(req, res)`
 * (MILESTONE §2.1). One `ConnectionContext` per live WebSocket connection
 * — created when the socket is accepted, before `hello` has necessarily
 * arrived, which is why `pid` starts undefined and is set once the
 * handshake completes.
 */
export interface ConnectionContext {
  readonly socket: WebSocket;
  readonly sid: SessionId;
  /** Unset until `hello` is processed — see ConnectionController.handleHello. */
  pid: ParticipantId | undefined;
  /** This connection's own inbound ordering guard — one per connection, not shared. */
  readonly sequenceGuard: SequenceGuard;
  readonly connectedAt: number;
  /**
   * True once an explicit `bye` has been handled — read by the raw
   * socket 'close' handler to decide whether a `source: 'socket'` audit
   * record is still warranted, or whether the disconnect was already
   * accounted for.
   */
  leftExplicitly: boolean;
}

export function createConnectionContext(
  socket: WebSocket,
  sid: SessionId,
  now: number,
): ConnectionContext {
  return {
    socket,
    sid,
    pid: undefined,
    sequenceGuard: new SequenceGuard(),
    connectedAt: now,
    leftExplicitly: false,
  };
}

/** Every service a realtime or HTTP controller might need — assembled once in the composition root. */
export interface ControllerDeps {
  readonly registry: SessionRegistry;
  readonly hub: BroadcastHub;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
}
