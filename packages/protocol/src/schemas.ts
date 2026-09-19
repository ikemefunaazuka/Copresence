import { z } from 'zod';

/**
 * zod validators for every INBOUND (client → server) message, including the
 * audit/lifecycle events — "parse at the boundary, trust everywhere inside"
 * (MILESTONE Phase 1). Outbound messages are server-authored and never
 * parsed from untrusted input, so they are hand-typed in messages.ts
 * instead of schema-derived here.
 *
 * These schemas are the SOURCE OF TRUTH for the inbound message shapes —
 * messages.ts derives its exported types from them via `z.infer`, rather
 * than maintaining a parallel hand-written type that could drift from what
 * is actually validated. One definition, not two kept in sync by hand.
 */

// ---- Branded identifiers -----------------------------------------------
//
// Branding is a compile-time-only tag added by zod's `.brand()`; the
// runtime value is still a plain string. It exists so `SessionId` and
// `ParticipantId` cannot be silently swapped for one another, or for an
// arbitrary string, anywhere they are used as a Map key or a field.

export const SessionIdSchema = z.string().min(1).brand<'SessionId'>();
export const ParticipantIdSchema = z.string().min(1).brand<'ParticipantId'>();
/** Client-generated, the dedupe key for audit events (MILESTONE Phase 1, 6). */
export const EventIdSchema = z.string().min(1).brand<'EventId'>();

export type SessionId = z.infer<typeof SessionIdSchema>;
export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;

// ---- Envelope -------------------------------------------------------------
//
// `v` is a plain positive integer here, NOT `z.literal(PROTOCOL_VERSION)` —
// version negotiation is handled explicitly in codec.ts as its own step,
// so a version mismatch produces a specific, informative error rather than
// a generic schema validation failure.

const BaseEnvelopeSchema = z.object({
  v: z.number().int().positive(),
  sid: SessionIdSchema,
  pid: ParticipantIdSchema,
  seq: z.number().int().nonnegative(),
  /** Advisory only — never used for ordering. See docs/adr/0004. */
  ts: z.number().int().nonnegative(),
});

const AuditEnvelopeSchema = BaseEnvelopeSchema.extend({
  eventId: EventIdSchema,
});

// ---- Presence messages -----------------------------------------------------

export const HelloMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('hello'),
  docWidth: z.number().positive(),
  docHeight: z.number().positive(),
  dpr: z.number().positive(),
  visibilityState: z.enum(['visible', 'hidden']),
});

export const CursorMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('cursor'),
  /** 0..1 of document width — see docs/adr/0005. */
  x: z.number().min(0).max(1),
  /** Absolute document-space y, in CSS pixels. */
  y: z.number().min(0),
});

export const ScrollMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('scroll'),
  scrollX: z.number().min(0),
  scrollY: z.number().min(0),
});

export const AckMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('ack'),
  acked: z.number().int().nonnegative(),
});

export const PingMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('ping'),
});

export const ByeMessageSchema = BaseEnvelopeSchema.extend({
  t: z.literal('bye'),
});

// ---- Audit / lifecycle messages -------------------------------------------

export const SessionStartMessageSchema = AuditEnvelopeSchema.extend({
  t: z.literal('session.start'),
});

export const SessionEndMessageSchema = AuditEnvelopeSchema.extend({
  t: z.literal('session.end'),
  reason: z.enum(['navigate', 'close', 'crash-recovered']),
});

export const ParticipantJoinMessageSchema = AuditEnvelopeSchema.extend({
  t: z.literal('participant.join'),
});

export const ParticipantLeaveMessageSchema = AuditEnvelopeSchema.extend({
  t: z.literal('participant.leave'),
});

export const VisibilityChangeMessageSchema = AuditEnvelopeSchema.extend({
  t: z.literal('visibility.change'),
  visibilityState: z.enum(['visible', 'hidden']),
});

export const InboundMessageSchema = z.discriminatedUnion('t', [
  HelloMessageSchema,
  CursorMessageSchema,
  ScrollMessageSchema,
  AckMessageSchema,
  PingMessageSchema,
  ByeMessageSchema,
  SessionStartMessageSchema,
  SessionEndMessageSchema,
  ParticipantJoinMessageSchema,
  ParticipantLeaveMessageSchema,
  VisibilityChangeMessageSchema,
]);
