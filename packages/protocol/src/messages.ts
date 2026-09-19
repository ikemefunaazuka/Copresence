import type { z } from 'zod';

import type {
  AckMessageSchema,
  ByeMessageSchema,
  CursorMessageSchema,
  HelloMessageSchema,
  ParticipantJoinMessageSchema,
  ParticipantLeaveMessageSchema,
  PingMessageSchema,
  ScrollMessageSchema,
  SessionEndMessageSchema,
  SessionStartMessageSchema,
  VisibilityChangeMessageSchema,
} from './schemas.js';
import type { ParticipantId, SessionId } from './schemas.js';

// Not re-exported here: index.ts already does `export * from './schemas.js'`,
// which surfaces these directly. Re-exporting them again from this module
// too would be a duplicate-export conflict at the barrel.

// ---- Inbound (client → server) — derived from schemas.ts, never hand
// duplicated, so the validated shape and the TypeScript type cannot drift
// apart from one another. ---------------------------------------------------

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type CursorMessage = z.infer<typeof CursorMessageSchema>;
export type ScrollMessage = z.infer<typeof ScrollMessageSchema>;
export type AckMessage = z.infer<typeof AckMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type ByeMessage = z.infer<typeof ByeMessageSchema>;
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;
export type SessionEndMessage = z.infer<typeof SessionEndMessageSchema>;
export type ParticipantJoinMessage = z.infer<typeof ParticipantJoinMessageSchema>;
export type ParticipantLeaveMessage = z.infer<typeof ParticipantLeaveMessageSchema>;
export type VisibilityChangeMessage = z.infer<typeof VisibilityChangeMessageSchema>;

/** MILESTONE Phase 1: "must arrive eventually", deduped on `eventId`. */
export type AuditMessage =
  | SessionStartMessage
  | SessionEndMessage
  | ParticipantJoinMessage
  | ParticipantLeaveMessage
  | VisibilityChangeMessage;

export type InboundMessage =
  | HelloMessage
  | CursorMessage
  | ScrollMessage
  | AckMessage
  | PingMessage
  | ByeMessage
  | AuditMessage;

// ---- Outbound (server → client) — server-authored, never parsed from
// untrusted input, so hand-typed rather than schema-derived. ---------------

export interface ParticipantSnapshot {
  readonly pid: ParticipantId;
  readonly color: string;
  readonly x?: number;
  readonly y?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly lastSeenAt: number;
}

interface OutboundEnvelope<Type extends string> {
  readonly v: number;
  readonly t: Type;
  readonly sid: SessionId;
  /** The server's own broadcast/tick sequence — not per-participant. */
  readonly seq: number;
  readonly ts: number;
}

export interface WelcomeMessage extends OutboundEnvelope<'welcome'> {
  /** The id assigned to the connecting client. */
  readonly pid: ParticipantId;
  readonly participants: readonly ParticipantSnapshot[];
}

export interface JoinMessage extends OutboundEnvelope<'join'> {
  readonly participant: ParticipantSnapshot;
}

export interface LeaveMessage extends OutboundEnvelope<'leave'> {
  readonly pid: ParticipantId;
}

export interface ParticipantPatch {
  readonly pid: ParticipantId;
  readonly x?: number;
  readonly y?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
}

export interface PatchMessage extends OutboundEnvelope<'patch'> {
  readonly patches: readonly ParticipantPatch[];
}

export interface SnapshotMessage extends OutboundEnvelope<'snapshot'> {
  readonly participants: readonly ParticipantSnapshot[];
}

export interface PongMessage extends OutboundEnvelope<'pong'> {
  /** Echoes the ping's `ts`, so the sender can measure round-trip latency. */
  readonly pingTs: number;
}

export type ErrorCode =
  | 'malformed-json'
  | 'validation-failed'
  | 'version-mismatch'
  | 'unauthorized'
  | 'rate-limited'
  | 'internal';

export interface ErrorMessage extends OutboundEnvelope<'error'> {
  readonly code: ErrorCode;
  readonly detail: string;
}

export type OutboundMessage =
  | WelcomeMessage
  | JoinMessage
  | LeaveMessage
  | PatchMessage
  | SnapshotMessage
  | PongMessage
  | ErrorMessage;

export type Message = InboundMessage | OutboundMessage;

// ---- Message classification (MILESTONE Phase 1 / ADR 0009) ----------------
//
// The decision the rest of the system hangs off. `patch` and `bye` are not
// named explicitly in MILESTONE's classification table, so their class is
// inferred here rather than left undefined:
//   - `patch` is the broadcast OUTPUT of coalescing lossy cursor/scroll
//     data. Missing one tick is superseded by the next ~50ms later, so it
//     inherits the lossy policy of the data it carries.
//   - `bye` is a clean-disconnect notification in the same family as
//     hello/join/leave: dropping it silently would be indistinguishable
//     from the disconnect never having been announced, so it is lossless.

export type MessageClass = 'lossy' | 'lossless' | 'control' | 'audit';

export const MESSAGE_CLASS: Readonly<Record<Message['t'], MessageClass>> = {
  cursor: 'lossy',
  scroll: 'lossy',
  patch: 'lossy',

  hello: 'lossless',
  bye: 'lossless',
  join: 'lossless',
  leave: 'lossless',
  welcome: 'lossless',
  snapshot: 'lossless',

  ping: 'control',
  pong: 'control',
  ack: 'control',
  error: 'control',

  'session.start': 'audit',
  'session.end': 'audit',
  'participant.join': 'audit',
  'participant.leave': 'audit',
  'visibility.change': 'audit',
};

/** Total: `Message['t']` is a closed union, so every key is covered. */
export function classify(type: Message['t']): MessageClass {
  return MESSAGE_CLASS[type];
}

export function isAuditMessage(message: InboundMessage): message is AuditMessage {
  return classify(message.t) === 'audit';
}
