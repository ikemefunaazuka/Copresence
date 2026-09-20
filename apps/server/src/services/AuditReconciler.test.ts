import type { ParticipantId, SessionId } from '@copresence/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../lib/clock.js';

import { AuditLog } from './AuditLog.js';
import { AuditReconciler } from './AuditReconciler.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

describe('AuditReconciler.sweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes an inferred session.end for a start with no end, once the TTL has passed', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    auditLog.record({
      eventId: 'start-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 0,
    });

    clock.set(20_000);
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    reconciler.sweep();

    const records = auditLog.forSession(sid('s1'));
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ pid: pid('p1'), kind: 'session.end', source: 'inferred' });
  });

  it('does nothing while still within the TTL grace period', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    auditLog.record({
      eventId: 'start-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 0,
    });

    clock.set(5_000); // under the 15s TTL
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    reconciler.sweep();

    expect(auditLog.forSession(sid('s1'))).toHaveLength(1); // just the original start
  });

  it('does nothing when a session.end already exists after the start', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    auditLog.record({
      eventId: 'start-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 0,
    });
    auditLog.record({
      eventId: 'end-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.end',
      source: 'socket',
      recordedAt: 1_000,
    });

    clock.set(20_000);
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    reconciler.sweep();

    expect(auditLog.forSession(sid('s1'))).toHaveLength(2); // no third, inferred record added
  });

  it('reconciles the most recent start/end pair, not an older already-closed one', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    // An earlier, already-closed session for the same participant (e.g. a
    // hidden -> visible -> hidden cycle emitting a fresh pair each time).
    auditLog.record({
      eventId: 'start-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 0,
    });
    auditLog.record({
      eventId: 'end-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.end',
      source: 'client',
      recordedAt: 1_000,
    });
    // A newer start with no matching end yet.
    auditLog.record({
      eventId: 'start-2',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 2_000,
    });

    clock.set(20_000);
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    reconciler.sweep();

    const inferred = auditLog
      .forSession(sid('s1'))
      .filter((record) => record.source === 'inferred');
    expect(inferred).toHaveLength(1); // only the second, still-open pair gets reconciled
  });

  it('is idempotent — a second sweep does not add another inferred record', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    auditLog.record({
      eventId: 'start-1',
      sid: sid('s1'),
      pid: pid('p1'),
      kind: 'session.start',
      source: 'client',
      recordedAt: 0,
    });

    clock.set(20_000);
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    reconciler.sweep();
    reconciler.sweep();

    const inferred = auditLog
      .forSession(sid('s1'))
      .filter((record) => record.source === 'inferred');
    expect(inferred).toHaveLength(1);
  });

  it('sweeping with nothing to reconcile writes no records', () => {
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });

    expect(() => reconciler.sweep()).not.toThrow();
    expect(auditLog.all()).toEqual([]);
  });

  it('start/stop wire a real interval and are idempotent', () => {
    vi.useFakeTimers();
    const clock = createFakeClock(0);
    const auditLog = new AuditLog();
    const reconciler = new AuditReconciler({ auditLog, clock, ttlMs: 15_000 });
    const sweepSpy = vi.spyOn(reconciler, 'sweep');

    reconciler.start(5_000);
    reconciler.start(5_000); // idempotent
    expect(sweepSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    reconciler.stop();
    reconciler.stop(); // idempotent
    vi.advanceTimersByTime(20_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });
});
