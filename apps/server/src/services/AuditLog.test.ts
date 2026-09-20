import type { ParticipantId, SessionId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import type { AuditRecord } from './AuditLog.js';
import { AuditLog } from './AuditLog.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    eventId: 'evt-1',
    sid: sid('s1'),
    pid: pid('p1'),
    kind: 'session.start',
    source: 'client',
    recordedAt: 1_000,
    ...overrides,
  };
}

describe('AuditLog', () => {
  it('records a new event and reports it recorded', () => {
    const log = new AuditLog();
    expect(log.record(record())).toBe(true);
    expect(log.has('evt-1')).toBe(true);
    expect(log.get('evt-1')).toEqual(record());
  });

  it('is idempotent on eventId — a duplicate is a true no-op', () => {
    const log = new AuditLog();
    log.record(record());
    const second = log.record(record({ detail: { different: true } }));

    expect(second).toBe(false);
    // The original record is kept, not overwritten by the duplicate.
    expect(log.get('evt-1')).toEqual(record());
  });

  it('has() and get() report absence for an unknown eventId', () => {
    const log = new AuditLog();
    expect(log.has('nope')).toBe(false);
    expect(log.get('nope')).toBeUndefined();
  });

  it('all() lists every recorded event', () => {
    const log = new AuditLog();
    log.record(record({ eventId: 'evt-1' }));
    log.record(record({ eventId: 'evt-2' }));
    expect(
      log
        .all()
        .map((r) => r.eventId)
        .sort(),
    ).toEqual(['evt-1', 'evt-2']);
  });

  it('forSession filters to only that session', () => {
    const log = new AuditLog();
    log.record(record({ eventId: 'evt-1', sid: sid('s1') }));
    log.record(record({ eventId: 'evt-2', sid: sid('s2') }));

    expect(log.forSession(sid('s1')).map((r) => r.eventId)).toEqual(['evt-1']);
  });

  it('accepts records from all three reporting sources', () => {
    const log = new AuditLog();
    expect(log.record(record({ eventId: 'a', source: 'client' }))).toBe(true);
    expect(log.record(record({ eventId: 'b', source: 'socket' }))).toBe(true);
    expect(log.record(record({ eventId: 'c', source: 'inferred' }))).toBe(true);
    expect(log.all()).toHaveLength(3);
  });
});
