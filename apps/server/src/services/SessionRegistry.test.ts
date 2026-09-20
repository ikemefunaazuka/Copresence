import type { ParticipantId, SessionId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../lib/clock.js';
import { addParticipant, touchAndSetViewport } from '../models/Session.js';

import { SessionRegistry } from './SessionRegistry.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

describe('SessionRegistry', () => {
  it('getOrCreate creates once and returns the same session on repeat calls', () => {
    const registry = new SessionRegistry(createFakeClock());
    const first = registry.getOrCreate(sid('s1'));
    const second = registry.getOrCreate(sid('s1'));
    expect(second).toBe(first);
  });

  it('save then get round-trips the exact session', () => {
    const registry = new SessionRegistry(createFakeClock());
    const session = addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0);
    registry.save(session);
    expect(registry.get(sid('s1'))).toBe(session);
  });

  it('get returns undefined for an unknown session', () => {
    const registry = new SessionRegistry(createFakeClock());
    expect(registry.get(sid('ghost'))).toBeUndefined();
  });

  it('delete removes a session', () => {
    const registry = new SessionRegistry(createFakeClock());
    registry.getOrCreate(sid('s1'));
    registry.delete(sid('s1'));
    expect(registry.get(sid('s1'))).toBeUndefined();
  });

  it('all lists every session', () => {
    const registry = new SessionRegistry(createFakeClock());
    registry.getOrCreate(sid('s1'));
    registry.getOrCreate(sid('s2'));
    expect(
      registry
        .all()
        .map((s) => s.sid)
        .sort(),
    ).toEqual(['s1', 's2']);
  });

  describe('reapStale', () => {
    it('removes a participant whose lastSeenAt exceeds the TTL, leaving the session (and its other participant) in place', () => {
      const clock = createFakeClock(0);
      const registry = new SessionRegistry(clock);
      let session = addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0);
      session = addParticipant(session, pid('anchor'), 0);
      registry.save(session);

      clock.set(20_000);
      registry.save(touchAndSetViewport(registry.get(sid('s1'))!, pid('anchor'), 0, 0, 1, 20_000));
      const reaped = registry.reapStale(15_000);

      expect(reaped).toEqual([{ sid: sid('s1'), pid: pid('p1'), lastSeenAt: 0 }]);
      expect(registry.get(sid('s1'))?.participants.has(pid('p1'))).toBe(false);
      expect(registry.get(sid('s1'))?.participants.has(pid('anchor'))).toBe(true);
    });

    it('leaves a participant seen within the TTL untouched', () => {
      const clock = createFakeClock(0);
      const registry = new SessionRegistry(clock);
      registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));

      clock.set(10_000); // under the 15_000ms TTL
      const reaped = registry.reapStale(15_000);

      expect(reaped).toEqual([]);
      expect(registry.get(sid('s1'))?.participants.has(pid('p1'))).toBe(true);
    });

    it('drops a session entirely once its last participant is reaped', () => {
      const clock = createFakeClock(0);
      const registry = new SessionRegistry(clock);
      registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));

      clock.set(20_000);
      registry.reapStale(15_000);

      expect(registry.get(sid('s1'))).toBeUndefined();
    });

    it('reaps only the stale participant, keeping a freshly-touched one in the same session', () => {
      const clock = createFakeClock(0);
      const registry = new SessionRegistry(clock);
      let session = addParticipant(registry.getOrCreate(sid('s1')), pid('stale'), 0);
      session = addParticipant(session, pid('fresh'), 0);
      registry.save(session);

      clock.set(20_000);
      registry.save(touchAndSetViewport(registry.get(sid('s1'))!, pid('fresh'), 0, 0, 1, 20_000));

      const reaped = registry.reapStale(15_000);

      expect(reaped.map((r) => r.pid)).toEqual([pid('stale')]);
      const remaining = registry.get(sid('s1'));
      expect(remaining?.participants.has(pid('fresh'))).toBe(true);
      expect(remaining?.participants.has(pid('stale'))).toBe(false);
    });

    it('is idempotent — sweeping with nothing stale reports an empty list and changes nothing', () => {
      const clock = createFakeClock(0);
      const registry = new SessionRegistry(clock);
      registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));

      const before = registry.get(sid('s1'));
      const reaped = registry.reapStale(15_000);

      expect(reaped).toEqual([]);
      expect(registry.get(sid('s1'))).toBe(before);
    });
  });
});
