import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { ByeMessage, HelloMessage, LeaveMessage, PingMessage } from '@copresence/protocol';

import { generateId } from '../lib/id.js';
import { applyEvent } from '../models/applyEvent.js';
import { removeParticipant } from '../models/Session.js';
import { toWelcome } from '../views/presenters.js';

import type { ConnectionContext, ControllerDeps } from './types.js';

/**
 * The handshake, the heartbeat's application-level counterpart, and both
 * ways a connection ends. `hello`, `bye` and `ping` are all "about this
 * connection" rather than about presence data, which is why they live
 * here and not in `PresenceController`.
 */

/**
 * Registers (or re-registers, for an updated viewport) the connecting
 * participant, sends `welcome` to them alone, and — only for a genuinely
 * new participant — broadcasts `join` to everyone else. A repeat `hello`
 * from an already-known participant (e.g. a window resize) updates their
 * viewport without re-announcing them.
 */
export function handleHello(ctx: ConnectionContext, msg: HelloMessage, deps: ControllerDeps): void {
  const session = deps.registry.getOrCreate(ctx.sid);
  const wasAlreadyPresent = session.participants.has(msg.pid);

  const { state: next } = applyEvent(session, msg);
  deps.registry.save(next);
  ctx.pid = msg.pid;
  deps.hub.register({ pid: msg.pid, sid: ctx.sid, socket: ctx.socket });

  const seq = 0; // handshake-scoped; the tick scheduler owns the broadcast sequence proper
  deps.hub.sendTo(msg.pid, toWelcome(next, msg.pid, seq, deps.clock.now()));

  if (!wasAlreadyPresent) {
    const participant = next.participants.get(msg.pid);
    if (participant) {
      const joinMessage = {
        v: PROTOCOL_VERSION,
        t: 'join' as const,
        sid: ctx.sid,
        seq,
        ts: deps.clock.now(),
        participant: {
          pid: participant.pid,
          color: participant.color,
          lastSeenAt: participant.lastSeenAt,
        },
      };
      deps.hub.broadcastToSession(ctx.sid, joinMessage, msg.pid);
    }
  }
}

/**
 * An explicit, clean disconnect — the client announcing it, not the
 * server inferring it. `msg.pid` is trusted here because the realtime
 * router has already rejected any message whose `pid` does not match
 * this connection's established identity (see routes/realtimeRouter.ts)
 * — every controller can assume that check already happened rather than
 * repeating it.
 */
export function handleBye(ctx: ConnectionContext, msg: ByeMessage, deps: ControllerDeps): void {
  ctx.leftExplicitly = true;
  removeFromSession(ctx, msg.pid, deps);
}

/** Application-level latency ping — distinct from `ws`'s raw protocol-level heartbeat frames (see server.ts). */
export function handlePing(ctx: ConnectionContext, msg: PingMessage, deps: ControllerDeps): void {
  if (!ctx.pid) return;
  deps.hub.sendTo(ctx.pid, {
    v: PROTOCOL_VERSION,
    t: 'pong',
    sid: ctx.sid,
    seq: 0,
    ts: deps.clock.now(),
    pingTs: msg.ts,
  });
}

/**
 * The raw WebSocket 'close' event — called whether or not `bye` was ever
 * received. When it was not, this is the server *observing* the end of a
 * session rather than being told, which is exactly what `source: 'socket'`
 * means (MILESTONE Phase 2, 6) — distinct from the heartbeat-timeout
 * reaper's `source: 'inferred'` (SessionRegistry.reapStale).
 */
export function handleDisconnect(ctx: ConnectionContext, deps: ControllerDeps): void {
  if (!ctx.pid) return; // never completed the handshake — nothing was registered
  const pid = ctx.pid;

  if (!ctx.leftExplicitly) {
    deps.auditLog.record({
      eventId: generateId(),
      sid: ctx.sid,
      pid,
      kind: 'session.end',
      source: 'socket',
      recordedAt: deps.clock.now(),
      detail: { reason: 'connection closed without bye' },
    });
  }

  removeFromSession(ctx, pid, deps);
}

function removeFromSession(
  ctx: ConnectionContext,
  pid: ConnectionContext['pid'],
  deps: ControllerDeps,
): void {
  if (!pid) return;
  const session = deps.registry.get(ctx.sid);
  deps.hub.unregister(pid);
  if (!session?.participants.has(pid)) return;

  deps.registry.save(removeParticipant(session, pid));

  const leaveMessage: LeaveMessage = {
    v: PROTOCOL_VERSION,
    t: 'leave',
    sid: ctx.sid,
    seq: 0,
    ts: deps.clock.now(),
    pid,
  };
  deps.hub.broadcastToSession(ctx.sid, leaveMessage, pid);
}
