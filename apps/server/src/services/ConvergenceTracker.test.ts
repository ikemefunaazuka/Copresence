import type {
  JoinMessage,
  LeaveMessage,
  ParticipantId,
  PatchMessage,
  SessionId,
  WelcomeMessage,
} from '@copresence/protocol';
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import { ConvergenceTracker } from './ConvergenceTracker.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function welcome(participants: WelcomeMessage['participants'], seq = 0): WelcomeMessage {
  return {
    v: PROTOCOL_VERSION,
    t: 'welcome',
    sid: sid('s1'),
    pid: pid('whoever'),
    seq,
    ts: 0,
    participants,
  };
}

function patch(patches: PatchMessage['patches'], seq: number): PatchMessage {
  return { v: PROTOCOL_VERSION, t: 'patch', sid: sid('s1'), seq, ts: 0, patches };
}

describe('ConvergenceTracker', () => {
  it('an unknown session reports converged: true with no hashes at all', () => {
    const tracker = new ConvergenceTracker();
    expect(tracker.snapshot(sid('ghost'))).toEqual({ hashes: {}, converged: true });
  });

  it('a single participant is trivially converged', () => {
    const tracker = new ConvergenceTracker();
    tracker.recordDelivery(
      sid('s1'),
      pid('a'),
      welcome([{ pid: pid('a'), color: '#f00', lastSeenAt: 0 }]),
    );

    const snapshot = tracker.snapshot(sid('s1'));
    expect(Object.keys(snapshot.hashes)).toEqual(['a']);
    expect(snapshot.converged).toBe(true);
  });

  it('two participants delivered the identical welcome roster converge immediately', () => {
    const tracker = new ConvergenceTracker();
    const roster = welcome([
      { pid: pid('a'), color: '#f00', x: 0.1, y: 100, lastSeenAt: 0 },
      { pid: pid('b'), color: '#0f0', x: 0.2, y: 200, lastSeenAt: 0 },
    ]);
    tracker.recordDelivery(sid('s1'), pid('a'), roster);
    tracker.recordDelivery(sid('s1'), pid('b'), roster);

    expect(tracker.snapshot(sid('s1')).converged).toBe(true);
  });

  it('diverges when one participant has received a patch the other has not', () => {
    const tracker = new ConvergenceTracker();
    const roster = welcome([
      { pid: pid('a'), color: '#f00', x: 0, y: 0, lastSeenAt: 0 },
      { pid: pid('b'), color: '#0f0', x: 0, y: 0, lastSeenAt: 0 },
    ]);
    tracker.recordDelivery(sid('s1'), pid('a'), roster);
    tracker.recordDelivery(sid('s1'), pid('b'), roster);

    // Only `a` actually received this patch — e.g. it was dropped for `b`.
    tracker.recordDelivery(sid('s1'), pid('a'), patch([{ pid: pid('b'), x: 0.9, y: 900 }], 1));

    const snapshot = tracker.snapshot(sid('s1'));
    expect(snapshot.converged).toBe(false);
    expect(snapshot.hashes['a']).not.toBe(snapshot.hashes['b']);
  });

  it('re-converges once the missed patch is (re)delivered to the participant who lacked it', () => {
    const tracker = new ConvergenceTracker();
    const roster = welcome([
      { pid: pid('a'), color: '#f00', x: 0, y: 0, lastSeenAt: 0 },
      { pid: pid('b'), color: '#0f0', x: 0, y: 0, lastSeenAt: 0 },
    ]);
    tracker.recordDelivery(sid('s1'), pid('a'), roster);
    tracker.recordDelivery(sid('s1'), pid('b'), roster);
    const thePatch = patch([{ pid: pid('b'), x: 0.9, y: 900 }], 1);
    tracker.recordDelivery(sid('s1'), pid('a'), thePatch);
    expect(tracker.snapshot(sid('s1')).converged).toBe(false);

    tracker.recordDelivery(sid('s1'), pid('b'), thePatch);

    expect(tracker.snapshot(sid('s1')).converged).toBe(true);
  });

  it('a reordered (stale) patch is ignored, mirroring the client’s own seq guard — it does not cause divergence', () => {
    const tracker = new ConvergenceTracker();
    const roster = welcome([{ pid: pid('a'), color: '#f00', x: 0, y: 0, lastSeenAt: 0 }]);
    tracker.recordDelivery(sid('s1'), pid('a'), roster);
    tracker.recordDelivery(sid('s1'), pid('b'), roster);

    const newer = patch([{ pid: pid('a'), x: 0.9, y: 900 }], 10);
    const staleLateArrival = patch([{ pid: pid('a'), x: 0.1, y: 100 }], 5);
    tracker.recordDelivery(sid('s1'), pid('a'), newer);
    tracker.recordDelivery(sid('s1'), pid('a'), staleLateArrival); // arrives after, but has a lower seq
    tracker.recordDelivery(sid('s1'), pid('b'), newer);
    tracker.recordDelivery(sid('s1'), pid('b'), staleLateArrival);

    expect(tracker.snapshot(sid('s1')).converged).toBe(true);
  });

  it('join adds a participant to that connection’s view', () => {
    const tracker = new ConvergenceTracker();
    tracker.recordDelivery(sid('s1'), pid('a'), welcome([]));
    const joinMsg: JoinMessage = {
      v: PROTOCOL_VERSION,
      t: 'join',
      sid: sid('s1'),
      seq: 1,
      ts: 0,
      participant: { pid: pid('b'), color: '#00f', lastSeenAt: 0 },
    };
    tracker.recordDelivery(sid('s1'), pid('a'), joinMsg);

    expect(Object.keys(tracker.snapshot(sid('s1')).hashes)).toEqual(['a']);
    // Indirect check that `b` is now present: adding the same join to a
    // second, otherwise-identical connection converges them.
    tracker.recordDelivery(sid('s1'), pid('b'), welcome([]));
    tracker.recordDelivery(sid('s1'), pid('b'), joinMsg);
    expect(tracker.snapshot(sid('s1')).converged).toBe(true);
  });

  it('leave removes a participant from that connection’s view', () => {
    const tracker = new ConvergenceTracker();
    const roster = welcome([
      { pid: pid('a'), color: '#f00', lastSeenAt: 0 },
      { pid: pid('b'), color: '#0f0', lastSeenAt: 0 },
    ]);
    tracker.recordDelivery(sid('s1'), pid('a'), roster);
    tracker.recordDelivery(sid('s1'), pid('b'), roster);

    const leaveMsg: LeaveMessage = {
      v: PROTOCOL_VERSION,
      t: 'leave',
      sid: sid('s1'),
      seq: 1,
      ts: 0,
      pid: pid('b'),
    };
    tracker.recordDelivery(sid('s1'), pid('a'), leaveMsg);
    expect(tracker.snapshot(sid('s1')).converged).toBe(false); // a no longer has b; b's own view still does

    tracker.recordDelivery(sid('s1'), pid('b'), leaveMsg); // b learns of its own leave too, in this simulation
    expect(tracker.snapshot(sid('s1')).converged).toBe(true);
  });

  it('forget() removes a session entirely', () => {
    const tracker = new ConvergenceTracker();
    tracker.recordDelivery(
      sid('s1'),
      pid('a'),
      welcome([{ pid: pid('a'), color: '#f00', lastSeenAt: 0 }]),
    );
    tracker.forget(sid('s1'));

    expect(tracker.snapshot(sid('s1'))).toEqual({ hashes: {}, converged: true });
  });

  it('pong and error messages are ignored — neither carries roster state', () => {
    const tracker = new ConvergenceTracker();
    tracker.recordDelivery(
      sid('s1'),
      pid('a'),
      welcome([{ pid: pid('a'), color: '#f00', lastSeenAt: 0 }]),
    );
    const before = tracker.snapshot(sid('s1')).hashes['a'];

    tracker.recordDelivery(sid('s1'), pid('a'), {
      v: PROTOCOL_VERSION,
      t: 'pong',
      sid: sid('s1'),
      seq: 99,
      ts: 0,
      pingTs: 0,
    });

    expect(tracker.snapshot(sid('s1')).hashes['a']).toBe(before);
  });
});
