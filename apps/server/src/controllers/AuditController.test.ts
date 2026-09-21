import type {
  AuditAckMessage,
  EventId,
  ParticipantId,
  SessionId,
  VisibilityChangeMessage,
} from '@copresence/protocol';
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { createFakeClock } from '../lib/clock.js';
import { AuditLog } from '../services/AuditLog.js';
import { BroadcastHub } from '../services/BroadcastHub.js';
import { SessionRegistry } from '../services/SessionRegistry.js';

import { handleAuditMessage } from './AuditController.js';
import type { ConnectionContext, ControllerDeps } from './types.js';
import { createConnectionContext } from './types.js';

const sid = (raw: string): SessionId => raw as SessionId;
const eventId = (raw: string): EventId => raw as EventId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function fakeSocket(): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  } as unknown as WebSocket;
  return { socket, sent };
}

function setUp(): { deps: ControllerDeps; ctx: ConnectionContext; sent: string[] } {
  const clock = createFakeClock();
  const hub = new BroadcastHub();
  const { socket, sent } = fakeSocket();
  hub.register({ pid: pid('p1'), sid: sid('s1'), socket });
  const deps: ControllerDeps = {
    registry: new SessionRegistry(clock),
    hub,
    auditLog: new AuditLog(),
    clock,
  };
  const ctx = createConnectionContext(socket, sid('s1'), 0);
  return { deps, ctx, sent };
}

function visibilityChange(
  overrides: Partial<VisibilityChangeMessage> = {},
): VisibilityChangeMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'visibility.change',
    sid: sid('s1'),
    pid: pid('p1'),
    seq: 1,
    ts: 0,
    eventId: eventId('evt-1'),
    visibilityState: 'hidden',
    ...overrides,
  };
}

describe('handleAuditMessage', () => {
  it('records the event in AuditLog with source: client', () => {
    const { deps, ctx } = setUp();

    handleAuditMessage(ctx, visibilityChange(), deps);

    const record = deps.auditLog.get('evt-1');
    expect(record).toMatchObject({ kind: 'visibility.change', source: 'client', pid: pid('p1') });
  });

  it('sends back audit.ack addressed to the reporting participant', () => {
    const { deps, ctx, sent } = setUp();

    handleAuditMessage(ctx, visibilityChange(), deps);

    expect(sent).toHaveLength(1);
    const ack = JSON.parse(sent[0]!) as AuditAckMessage;
    expect(ack).toMatchObject({ t: 'audit.ack', eventId: 'evt-1', sid: sid('s1') });
  });

  it('a duplicate (same eventId) still gets its own audit.ack — the resend case an outbox most needs answered', () => {
    const { deps, ctx, sent } = setUp();

    handleAuditMessage(ctx, visibilityChange(), deps);
    handleAuditMessage(ctx, visibilityChange(), deps); // exact resend

    expect(sent).toHaveLength(2);
    const acks = sent.map((raw) => JSON.parse(raw) as AuditAckMessage);
    expect(acks.every((ack) => ack.eventId === 'evt-1')).toBe(true);
    // Recorded once, not twice — AuditLog's own idempotency, unaffected by acking every attempt.
    expect(deps.auditLog.forSession(sid('s1'))).toHaveLength(1);
  });

  it('session.end carries its reason through to the record detail', () => {
    const { deps, ctx } = setUp();

    handleAuditMessage(
      ctx,
      {
        v: PROTOCOL_VERSION,
        t: 'session.end',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        eventId: eventId('evt-2'),
        reason: 'navigate',
      },
      deps,
    );

    expect(deps.auditLog.get('evt-2')).toMatchObject({ detail: { reason: 'navigate' } });
  });
});
