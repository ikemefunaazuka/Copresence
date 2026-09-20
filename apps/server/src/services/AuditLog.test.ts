import type { ParticipantId, SessionId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import type { AuditRecordInput } from './AuditLog.js';
import { AuditLog } from './AuditLog.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function record(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
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
    expect(log.get('evt-1')).toEqual({ ...record(), reports: [{ source: 'client', recordedAt: 1_000 }] });
  });

  it('is idempotent on eventId — a duplicate is a true no-op that still appends to `reports`', () => {
    const log = new AuditLog();
    log.record(record());
    const second = log.record(record({ detail: { different: true }, recordedAt: 2_000 }));

    expect(second).toBe(false);
    // The original content is kept, not overwritten by the duplicate — only its report trail grows.
    const stored = log.get('evt-1');
    expect(stored?.detail).toBeUndefined();
    expect(stored?.reports).toEqual([
      { source: 'client', recordedAt: 1_000 },
      { source: 'client', recordedAt: 2_000 },
    ]);
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

  describe('session.end convergence across sources', () => {
    it('three independent paths closing the same instance collapse into one record, tagged with every path that saw it', () => {
      const log = new AuditLog();
      log.record(record({ eventId: 'start-1', kind: 'session.start', source: 'client', recordedAt: 0 }));

      expect(
        log.record({
          eventId: 'end-client',
          sid: sid('s1'),
          pid: pid('p1'),
          kind: 'session.end',
          source: 'client',
          recordedAt: 100,
        }),
      ).toBe(true); // the first report creates the canonical record

      expect(
        log.record({
          eventId: 'end-socket',
          sid: sid('s1'),
          pid: pid('p1'),
          kind: 'session.end',
          source: 'socket',
          recordedAt: 105,
        }),
      ).toBe(false); // converges onto end-client instead of becoming a second record

      expect(
        log.record({
          eventId: 'end-inferred',
          sid: sid('s1'),
          pid: pid('p1'),
          kind: 'session.end',
          source: 'inferred',
          recordedAt: 6_000,
        }),
      ).toBe(false);

      const ends = log.forSession(sid('s1')).filter((r) => r.kind === 'session.end');
      expect(ends).toHaveLength(1);
      expect(ends[0]!.eventId).toBe('end-client'); // the first-arriving path's eventId is kept as canonical
      expect(ends[0]!.reports.map((r) => r.source)).toEqual(['client', 'socket', 'inferred']);
      expect(ends[0]!.reports[0]!.source).toBe('client'); // which path arrived first
    });

    it('a session.end reported after a fresh session.start reopened the instance is a genuinely new event, not a duplicate of the old one', () => {
      const log = new AuditLog();
      log.record(record({ eventId: 'start-1', kind: 'session.start', recordedAt: 0 }));
      log.record({
        eventId: 'end-1',
        sid: sid('s1'),
        pid: pid('p1'),
        kind: 'session.end',
        source: 'client',
        recordedAt: 100,
      });
      log.record(record({ eventId: 'start-2', kind: 'session.start', recordedAt: 200 })); // reconnected

      const created = log.record({
        eventId: 'end-2',
        sid: sid('s1'),
        pid: pid('p1'),
        kind: 'session.end',
        source: 'client',
        recordedAt: 300,
      });

      expect(created).toBe(true);
      expect(log.forSession(sid('s1')).filter((r) => r.kind === 'session.end')).toHaveLength(2);
    });
  });
});
