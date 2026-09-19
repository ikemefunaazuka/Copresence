import type { ParticipantId, SessionId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import {
  addParticipant,
  clearDirty,
  clearDirtyFor,
  createSession,
  isEmpty,
  markPresenceDirty,
  removeParticipant,
  updateParticipant,
} from './Session.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

describe('createSession', () => {
  it('starts empty', () => {
    const session = createSession(sid('s1'), 0);
    expect(isEmpty(session)).toBe(true);
    expect(session.participants.size).toBe(0);
    expect(session.dirty.size).toBe(0);
  });
});

describe('addParticipant', () => {
  it('adds a new participant', () => {
    const session = addParticipant(createSession(sid('s1'), 0), pid('p1'), 100);
    expect(session.participants.has(pid('p1'))).toBe(true);
    expect(isEmpty(session)).toBe(false);
  });

  it('is idempotent — adding an already-present participant is a no-op (same reference)', () => {
    const once = addParticipant(createSession(sid('s1'), 0), pid('p1'), 100);
    const twice = addParticipant(once, pid('p1'), 200);
    expect(twice).toBe(once);
  });
});

describe('removeParticipant', () => {
  it('removes a present participant', () => {
    const withP = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    const without = removeParticipant(withP, pid('p1'));
    expect(without.participants.has(pid('p1'))).toBe(false);
    expect(isEmpty(without)).toBe(true);
  });

  it('is idempotent — removing an absent participant is a no-op (same reference)', () => {
    const session = createSession(sid('s1'), 0);
    expect(removeParticipant(session, pid('nobody'))).toBe(session);
  });

  it('clears dirty state for the removed participant', () => {
    const withP = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    const dirty = markPresenceDirty(withP, pid('p1'), { cursor: true });
    expect(dirty.dirty.has(pid('p1'))).toBe(true);

    const removed = removeParticipant(dirty, pid('p1'));
    expect(removed.dirty.has(pid('p1'))).toBe(false);
  });
});

describe('updateParticipant', () => {
  it('is total — updating an unknown participant is a no-op rather than throwing', () => {
    const session = createSession(sid('s1'), 0);
    expect(() => updateParticipant(session, pid('nobody'), (p) => p)).not.toThrow();
    expect(updateParticipant(session, pid('nobody'), (p) => p)).toBe(session);
  });

  it('applies the updater to the named participant only', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    session = addParticipant(session, pid('p2'), 0);

    const updated = updateParticipant(session, pid('p1'), (p) => ({ ...p, color: '#000000' }));
    expect(updated.participants.get(pid('p1'))?.color).toBe('#000000');
    expect(updated.participants.get(pid('p2'))?.color).toBe(
      session.participants.get(pid('p2'))?.color,
    );
  });
});

describe('dirty tracking', () => {
  it('starts undirty, and marking merges rather than replaces', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    expect(session.dirty.has(pid('p1'))).toBe(false);

    session = markPresenceDirty(session, pid('p1'), { cursor: true });
    expect(session.dirty.get(pid('p1'))).toEqual({ cursor: true, scroll: false });

    session = markPresenceDirty(session, pid('p1'), { scroll: true });
    expect(session.dirty.get(pid('p1'))).toEqual({ cursor: true, scroll: true });
  });

  it('clearDirty clears every participant at once', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    session = addParticipant(session, pid('p2'), 0);
    session = markPresenceDirty(session, pid('p1'), { cursor: true });
    session = markPresenceDirty(session, pid('p2'), { scroll: true });

    const cleared = clearDirty(session);
    expect(cleared.dirty.size).toBe(0);
  });

  it('clearDirty is a no-op (same reference) when nothing is dirty', () => {
    const session = createSession(sid('s1'), 0);
    expect(clearDirty(session)).toBe(session);
  });

  it('clearDirtyFor clears only the named participant', () => {
    let session = addParticipant(createSession(sid('s1'), 0), pid('p1'), 0);
    session = addParticipant(session, pid('p2'), 0);
    session = markPresenceDirty(session, pid('p1'), { cursor: true });
    session = markPresenceDirty(session, pid('p2'), { scroll: true });

    const next = clearDirtyFor(session, pid('p1'));
    expect(next.dirty.has(pid('p1'))).toBe(false);
    expect(next.dirty.has(pid('p2'))).toBe(true);
  });
});
