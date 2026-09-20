import type { LeaveMessage, ParticipantId, SessionId } from '@copresence/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { createFakeClock } from '../lib/clock.js';
import { addParticipant, touchAndSetViewport } from '../models/Session.js';

import { AuditLog } from './AuditLog.js';
import { BroadcastHub } from './BroadcastHub.js';
import { Reaper } from './Reaper.js';
import { SessionRegistry } from './SessionRegistry.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function fakeSocket(): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const socket = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data) } as unknown as WebSocket;
  return { socket, sent };
}

describe('Reaper.sweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes an inferred audit record for each reaped participant', () => {
    const clock = createFakeClock(0);
    const registry = new SessionRegistry(clock);
    const hub = new BroadcastHub();
    const auditLog = new AuditLog();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('stale'), 0));

    clock.set(20_000);
    const reaper = new Reaper({ registry, hub, auditLog, clock, ttlMs: 15_000 });
    reaper.sweep();

    const records = auditLog.forSession(sid('s1'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: pid('stale'), kind: 'session.end', source: 'inferred' });
  });

  it('broadcasts leave to remaining participants and unregisters the reaped one from the hub', () => {
    const clock = createFakeClock(0);
    const registry = new SessionRegistry(clock);
    const hub = new BroadcastHub();
    const auditLog = new AuditLog();
    let session = addParticipant(registry.getOrCreate(sid('s1')), pid('stale'), 0);
    session = addParticipant(session, pid('fresh'), 0);
    registry.save(session);

    const staleSocket = fakeSocket();
    const freshSocket = fakeSocket();
    hub.register({ pid: pid('stale'), sid: sid('s1'), socket: staleSocket.socket });
    hub.register({ pid: pid('fresh'), sid: sid('s1'), socket: freshSocket.socket });

    // Both participants start at lastSeenAt=0; without this, advancing
    // the clock would make BOTH stale, not just the one this test means
    // to reap. 'fresh' is touched to bring its lastSeenAt up to date,
    // exactly as a real heartbeat/presence message would.
    clock.set(20_000);
    registry.save(touchAndSetViewport(registry.get(sid('s1'))!, pid('fresh'), 0, 0, 1, 20_000));

    const reaper = new Reaper({ registry, hub, auditLog, clock, ttlMs: 15_000 });
    reaper.sweep();

    expect(hub.isConnected(pid('stale'))).toBe(false);
    expect(staleSocket.sent).toHaveLength(0); // never notified of its own removal
    expect(freshSocket.sent).toHaveLength(1);
    const leave = JSON.parse(freshSocket.sent[0]!) as LeaveMessage;
    expect(leave).toMatchObject({ t: 'leave', pid: pid('stale') });
  });

  it('sweeping with nothing stale writes no audit records and broadcasts nothing', () => {
    const clock = createFakeClock(0);
    const registry = new SessionRegistry(clock);
    const hub = new BroadcastHub();
    const auditLog = new AuditLog();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));

    const reaper = new Reaper({ registry, hub, auditLog, clock, ttlMs: 15_000 });
    reaper.sweep();

    expect(auditLog.all()).toEqual([]);
  });

  it('start/stop wire a real interval and are idempotent', () => {
    vi.useFakeTimers();
    const clock = createFakeClock(0);
    const registry = new SessionRegistry(clock);
    const hub = new BroadcastHub();
    const auditLog = new AuditLog();
    const reaper = new Reaper({ registry, hub, auditLog, clock, ttlMs: 15_000 });
    const sweepSpy = vi.spyOn(reaper, 'sweep');

    reaper.start(5_000);
    reaper.start(5_000); // idempotent
    expect(sweepSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    reaper.stop();
    reaper.stop(); // idempotent
    vi.advanceTimersByTime(20_000);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });
});
