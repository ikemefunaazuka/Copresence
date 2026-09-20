import { PROTOCOL_VERSION } from '@copresence/protocol';
import type {
  ByeMessage,
  CursorMessage,
  EventId,
  HelloMessage,
  ParticipantId,
  PingMessage,
  ScrollMessage,
  SessionEndMessage,
  SessionId,
  SessionStartMessage,
  VisibilityChangeMessage,
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

/**
 * Validates and brands a raw id without going through
 * `SessionIdSchema`/`ParticipantIdSchema` — those are zod validators, and
 * zod's `.brand()` is a type-only marker with no runtime effect (a branded
 * `.parse()` returns the same string it was given), so importing the
 * *schema* here at runtime just to re-derive that no-op would pull the
 * whole zod engine into this bundle for zero behavioral gain. See ADR
 * 0010 — this SDK ships with zero runtime dependencies.
 */
function brand(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

export function createWireContext(sid: string, pid: string): WireContext {
  const brandedSid = brand(sid, 'SessionId') as SessionId;
  const brandedPid = brand(pid, 'ParticipantId') as ParticipantId;
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
  return {
    v: PROTOCOL_VERSION,
    t: 'cursor',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    x,
    y,
  };
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
  return {
    v: PROTOCOL_VERSION,
    t: 'ping',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
  };
}

export function buildBye(ctx: WireContext): ByeMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'bye',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
  };
}

/**
 * A fresh, client-generated id for one audit event — a plain
 * `crypto.randomUUID()` cast to the branded type, the same no-runtime-
 * effect reasoning `brand()` above already relies on for `sid`/`pid`.
 * Every retry of the *same* logical event (a resend after a dropped
 * `audit.ack`, an outbox replay) must reuse the *same* `eventId` it was
 * first built with — this function is only ever called once per event,
 * at the point it is first created, never at resend time.
 */
export function generateEventId(): string {
  return crypto.randomUUID();
}

export function buildSessionStart(ctx: WireContext, eventId: string): SessionStartMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'session.start',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    eventId: eventId as EventId,
  };
}

export function buildSessionEnd(
  ctx: WireContext,
  eventId: string,
  reason: SessionEndMessage['reason'],
): SessionEndMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'session.end',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    eventId: eventId as EventId,
    reason,
  };
}

export function buildVisibilityChange(
  ctx: WireContext,
  eventId: string,
  visibilityState: VisibilityChangeMessage['visibilityState'],
): VisibilityChangeMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'visibility.change',
    sid: ctx.sid,
    pid: ctx.pid,
    seq: ctx.nextSeq(),
    ts: Date.now(),
    eventId: eventId as EventId,
    visibilityState,
  };
}
