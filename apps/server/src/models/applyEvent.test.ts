import type { ParticipantId, SessionId } from '@copresence/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { applyEvent } from './applyEvent.js';
import type { SessionEvent } from './applyEvent.js';
import { addParticipant, createSession } from './Session.js';
import type { Session } from './Session.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function sessionWithParticipant(id: string): Session {
  return addParticipant(createSession(sid('s1'), 0), pid(id), 0);
}

function cursorEvent(p: string, seq: number, x: number, y: number): SessionEvent {
  return { v: 1, t: 'cursor', sid: sid('s1'), pid: pid(p), seq, ts: seq, x, y };
}

function scrollEvent(p: string, seq: number, scrollX: number, scrollY: number): SessionEvent {
  return { v: 1, t: 'scroll', sid: sid('s1'), pid: pid(p), seq, ts: seq, scrollX, scrollY };
}

function helloEvent(p: string, seq: number, docWidth = 1024, docHeight = 2000): SessionEvent {
  return {
    v: 1,
    t: 'hello',
    sid: sid('s1'),
    pid: pid(p),
    seq,
    ts: seq,
    docWidth,
    docHeight,
    dpr: 1,
    visibilityState: 'visible',
  };
}

function byeEvent(p: string, seq: number): SessionEvent {
  return { v: 1, t: 'bye', sid: sid('s1'), pid: pid(p), seq, ts: seq };
}

describe('applyEvent — unit behaviour', () => {
  it('hello adds an unknown participant and marks the roster changed', () => {
    const session = createSession(sid('s1'), 0);
    const result = applyEvent(session, helloEvent('p1', 1));
    expect(result.state.participants.has(pid('p1'))).toBe(true);
    expect(result.changed).toEqual({ cursor: false, scroll: false, roster: true });
  });

  it('hello on an existing participant updates viewport rather than duplicating', () => {
    const session = applyEvent(createSession(sid('s1'), 0), helloEvent('p1', 1, 800, 600)).state;
    const result = applyEvent(session, helloEvent('p1', 2, 1600, 1200));
    expect(result.state.participants.size).toBe(1);
    expect(result.state.participants.get(pid('p1'))?.docWidth).toBe(1600);
  });

  it('cursor on a known participant updates presence and marks cursor dirty', () => {
    const session = sessionWithParticipant('p1');
    const result = applyEvent(session, cursorEvent('p1', 1, 0.5, 100));
    expect(result.state.participants.get(pid('p1'))?.presence.cursor).toEqual({ x: 0.5, y: 100 });
    expect(result.changed).toEqual({ cursor: true, scroll: false, roster: false });
    expect(result.state.dirty.get(pid('p1'))).toEqual({ cursor: true, scroll: false });
  });

  it('cursor on an unknown participant is a total no-op — same reference, no throw', () => {
    const session = createSession(sid('s1'), 0);
    expect(() => applyEvent(session, cursorEvent('ghost', 1, 0.5, 0))).not.toThrow();
    const result = applyEvent(session, cursorEvent('ghost', 1, 0.5, 0));
    expect(result.state).toBe(session);
    expect(result.changed).toEqual({ cursor: false, scroll: false, roster: false });
  });

  it('a stale cursor seq is a true no-op — same reference, changed: false', () => {
    const afterFirst = applyEvent(
      sessionWithParticipant('p1'),
      cursorEvent('p1', 5, 0.5, 50),
    ).state;
    const result = applyEvent(afterFirst, cursorEvent('p1', 3, 0.9, 90));
    expect(result.state).toBe(afterFirst);
    expect(result.changed.cursor).toBe(false);
  });

  it('scroll on a known participant updates presence and marks scroll dirty', () => {
    const session = sessionWithParticipant('p1');
    const result = applyEvent(session, scrollEvent('p1', 1, 0, 400));
    expect(result.state.participants.get(pid('p1'))?.presence.scroll).toEqual({ x: 0, y: 400 });
    expect(result.changed).toEqual({ cursor: false, scroll: true, roster: false });
  });

  it('bye removes a present participant and marks the roster changed', () => {
    const session = sessionWithParticipant('p1');
    const result = applyEvent(session, byeEvent('p1', 1));
    expect(result.state.participants.has(pid('p1'))).toBe(false);
    expect(result.changed).toEqual({ cursor: false, scroll: false, roster: true });
  });

  it('bye on an unknown participant is a total no-op', () => {
    const session = createSession(sid('s1'), 0);
    expect(() => applyEvent(session, byeEvent('ghost', 1))).not.toThrow();
    const result = applyEvent(session, byeEvent('ghost', 1));
    expect(result.state).toBe(session);
  });

  it('cursor and scroll updates for one participant do not disturb another', () => {
    let session = sessionWithParticipant('p1');
    session = applyEvent(session, helloEvent('p2', 0)).state;
    session = applyEvent(session, cursorEvent('p1', 1, 0.2, 20)).state;
    session = applyEvent(session, cursorEvent('p2', 1, 0.8, 80)).state;

    expect(session.participants.get(pid('p1'))?.presence.cursor).toEqual({ x: 0.2, y: 20 });
    expect(session.participants.get(pid('p2'))?.presence.cursor).toEqual({ x: 0.8, y: 80 });
  });
});

// ---- Property tests ---------------------------------------------------

/** A realistic cursor/scroll/hello/bye event for a single fixed participant. */
const eventArb: fc.Arbitrary<{ seq: number; x: number; y: number; kind: 'cursor' | 'scroll' }> =
  fc.record({
    seq: fc.integer({ min: 0, max: 500 }),
    x: fc.double({ min: 0, max: 1, noNaN: true }),
    y: fc.double({ min: 0, max: 10_000, noNaN: true }),
    kind: fc.constantFrom('cursor', 'scroll'),
  });

function toSessionEvent(e: {
  seq: number;
  x: number;
  y: number;
  kind: 'cursor' | 'scroll';
}): SessionEvent {
  return e.kind === 'cursor'
    ? cursorEvent('p1', e.seq, e.x, e.y)
    : scrollEvent('p1', e.seq, e.x, e.y);
}

function applyAll(session: Session, events: SessionEvent[]): Session {
  let state = session;
  for (const event of events) {
    state = applyEvent(state, event).state;
  }
  return state;
}

describe('applyEvent — property tests', () => {
  it('idempotency: applying any single event N times equals applying it once', () => {
    fc.assert(
      fc.property(eventArb, fc.integer({ min: 1, max: 8 }), (e, repeats) => {
        const base = sessionWithParticipant('p1');
        const event = toSessionEvent(e);

        const once = applyEvent(base, event).state;
        let repeated = base;
        for (let i = 0; i < repeats; i += 1) {
          repeated = applyEvent(repeated, event).state;
        }

        expect(repeated.participants.get(pid('p1'))?.presence).toEqual(
          once.participants.get(pid('p1'))?.presence,
        );
      }),
    );
  });

  it('order tolerance: any permutation of a lossy event set converges to the same final state as the in-order sequence', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          eventArb.filter((e) => e.kind === 'cursor'),
          {
            minLength: 1,
            maxLength: 20,
            selector: (e) => e.seq,
          },
        ),
        fc.integer({ min: 0 }), // shuffle seed
        (events, shuffleSeed) => {
          const base = sessionWithParticipant('p1');
          const inOrderEvents = [...events].sort((a, b) => a.seq - b.seq).map(toSessionEvent);

          const shuffled = fc
            .sample(fc.shuffledSubarray(events, { minLength: events.length }), {
              seed: shuffleSeed,
              numRuns: 1,
            })[0]!
            .map(toSessionEvent);

          const inOrderResult = applyAll(base, inOrderEvents);
          const shuffledResult = applyAll(base, shuffled);

          expect(shuffledResult.participants.get(pid('p1'))?.presence).toEqual(
            inOrderResult.participants.get(pid('p1'))?.presence,
          );
        },
      ),
    );
  });

  it('totality: no combination of hello/cursor/scroll/bye events throws, on a known or unknown participant', () => {
    const anyEventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
      eventArb.map(toSessionEvent),
      fc.record({ seq: fc.integer({ min: 0, max: 500 }) }).map((e) => helloEvent('p1', e.seq)),
      fc.record({ seq: fc.integer({ min: 0, max: 500 }) }).map((e) => byeEvent('p1', e.seq)),
    );

    fc.assert(
      fc.property(fc.array(anyEventArb, { maxLength: 50 }), (events) => {
        // Deliberately starts from an EMPTY session — every event may land
        // on a participant that was never added (or was just removed by a
        // prior `bye` in the same array), which is exactly the "unknown
        // participant" no-op path every handler must tolerate.
        const session = createSession(sid('s1'), 0);
        expect(() => applyAll(session, events)).not.toThrow();
      }),
    );
  });

  it('totality: never throws for adversarial coordinate values, even on a known participant', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.integer({ min: 0, max: 1000 }),
        (x, y, seq) => {
          const session = sessionWithParticipant('p1');
          expect(() => applyEvent(session, cursorEvent('p1', seq, x, y))).not.toThrow();
        },
      ),
    );
  });
});
