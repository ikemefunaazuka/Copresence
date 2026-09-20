import type { ParticipantId, SessionId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import { applyEvent } from '../models/applyEvent.js';
import { addParticipant, createSession, markPresenceDirty } from '../models/Session.js';

import { toPatch, toSessionDTO, toSnapshot, toWelcome } from './presenters.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

describe('toWelcome', () => {
  it('carries the connecting pid and the full roster', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = addParticipant(session, pid('b'), 0);

    const welcome = toWelcome(session, pid('a'), 1, 1_000);

    expect(welcome.t).toBe('welcome');
    expect(welcome.pid).toBe('a');
    expect(welcome.participants.map((p) => p.pid).sort()).toEqual(['a', 'b']);
  });

  it('omits cursor/scroll fields for a participant with no presence yet, rather than sending undefined', () => {
    const session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    const welcome = toWelcome(session, pid('a'), 1, 1_000);

    const snapshot = welcome.participants[0]!;
    expect('x' in snapshot).toBe(false);
    expect('y' in snapshot).toBe(false);
    expect('scrollX' in snapshot).toBe(false);
  });

  it('includes cursor/scroll fields once presence exists', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = applyEvent(session, {
      v: 1, t: 'cursor', sid: sid('s1'), pid: pid('a'), seq: 1, ts: 0, x: 0.5, y: 200,
    }).state;

    const welcome = toWelcome(session, pid('a'), 1, 1_000);
    expect(welcome.participants[0]).toMatchObject({ x: 0.5, y: 200 });
  });
});

describe('toSnapshot', () => {
  it('carries the full roster with no connecting-participant concept', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = addParticipant(session, pid('b'), 0);

    const snapshot = toSnapshot(session, 5, 1_000);
    expect(snapshot.t).toBe('snapshot');
    expect(snapshot.seq).toBe(5);
    expect(snapshot.participants).toHaveLength(2);
  });
});

describe('toPatch', () => {
  it('returns undefined when nothing is dirty', () => {
    const session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    expect(toPatch(session, 1, 1_000)).toBeUndefined();
  });

  it('includes only the fields marked dirty, for only the participants marked dirty', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = addParticipant(session, pid('b'), 0);
    session = applyEvent(session, {
      v: 1, t: 'cursor', sid: sid('s1'), pid: pid('a'), seq: 1, ts: 0, x: 0.5, y: 200,
    }).state;

    const patch = toPatch(session, 1, 1_000);
    expect(patch).toBeDefined();
    expect(patch?.patches).toEqual([{ pid: pid('a'), x: 0.5, y: 200 }]);
  });

  it('reports a scroll-only patch without cursor fields when only scroll is dirty', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = applyEvent(session, {
      v: 1, t: 'scroll', sid: sid('s1'), pid: pid('a'), seq: 1, ts: 0, scrollX: 0, scrollY: 400,
    }).state;

    const patch = toPatch(session, 1, 1_000);
    const entry = patch?.patches[0];
    expect(entry).toEqual({ pid: pid('a'), scrollX: 0, scrollY: 400 });
    expect(entry && 'x' in entry).toBe(false);
  });

  it('skips a participant marked dirty who has since left the session, without throwing', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('a'), 0);
    session = markPresenceDirty(session, pid('ghost'), { cursor: true }); // dirty but never actually added

    expect(() => toPatch(session, 1, 1_000)).not.toThrow();
    expect(toPatch(session, 1, 1_000)).toBeUndefined();
  });
});

describe('toSessionDTO', () => {
  it('summarises the session without exposing presence data', () => {
    const session = addParticipant(createSession(sid('s1'), 500), pid('a'), 500);
    const dto = toSessionDTO(session);

    expect(dto.sid).toBe('s1');
    expect(dto.createdAt).toBe(500);
    expect(dto.participantCount).toBe(1);
    expect(dto.participants[0]).toEqual({ pid: pid('a'), color: expect.any(String) as string, lastSeenAt: 500 });
  });
});
