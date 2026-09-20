import { ParticipantIdSchema, PROTOCOL_VERSION, SessionIdSchema } from '@copresence/protocol';
import type {
  ByeMessage,
  CursorMessage,
  HelloMessage,
  ParticipantId,
  PingMessage,
  ScrollMessage,
  SessionId,
} from '@copresence/protocol';

/**
 * Message construction — deliberately kept out of transport/connection.ts
 * (whose job is sending and receiving already-built messages, not
 * knowing what a `hello` looks like) and out of index.ts (which has
 * enough to do orchestrating everything else). One shared, ever-
 * incrementing `seq` per connection lifetime — it never resets on
 * reconnect, which is simpler than trying to reset it to exactly the
 * right value relative to a new connection and no less correct, since
 * the server's `SequenceGuard` only requires strictly increasing within
 * one connection, and a counter that never goes down trivially satisfies
 * that everywhere.
 */
export interface WireContext {
  readonly sid: SessionId;
  readonly pid: ParticipantId;
  nextSeq(): number;
}

export function createWireContext(sid: string, pid: string): WireContext {
  const brandedSid = SessionIdSchema.parse(sid);
  const brandedPid = ParticipantIdSchema.parse(pid);
  let seq = 0;
  return {
    sid: brandedSid,
    pid: brandedPid,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
  };
}

export interface ViewportInfo {
  readonly docWidth: number;
  readonly docHeight: number;
  readonly dpr: number;
}

export function buildHello(
  ctx: WireContext,
  viewport: ViewportInfo,
  visibilityState: 'visible' | 'hidden',
): HelloMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'hello',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    docWidth: viewport.docWidth,
    docHeight: viewport.docHeight,
    dpr: viewport.dpr,
    visibilityState,
  };
}

export function buildCursor(ctx: WireContext, x: number, y: number): CursorMessage {
  return { v: PROTOCOL_VERSION, t: 'cursor', sid: ctx.sid, pid: ctx.pid, seq: ctx.nextSeq(), ts: Date.now(), x, y };
}

export function buildScroll(ctx: WireContext, scrollX: number, scrollY: number): ScrollMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'scroll',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    scrollX,
    scrollY,
  };
}

export function buildPing(ctx: WireContext): PingMessage {
  return { v: PROTOCOL_VERSION, t: 'ping', sid: ctx.sid, pid: ctx.pid, seq: ctx.nextSeq(), ts: Date.now() };
}

export function buildBye(ctx: WireContext): ByeMessage {
  return { v: PROTOCOL_VERSION, t: 'bye', sid: ctx.sid, pid: ctx.pid, seq: ctx.nextSeq(), ts: Date.now() };
}
