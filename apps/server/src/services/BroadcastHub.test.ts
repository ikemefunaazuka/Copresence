
import type { ParticipantId, PongMessage, SessionId } from '@copresence/protocol';
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { BroadcastHub } from './BroadcastHub.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

/**
 * A minimal stand-in for `ws`'s `WebSocket` — BroadcastHub only ever
 * touches `readyState`, `OPEN` and `send`. Real-socket behaviour (actual
 * bytes over an actual connection) is covered by the end-to-end suite,
 * not duplicated here.
 */
function fakeSocket(readyState: 0 | 1 | 2 | 3 = 1): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const socket = {
    readyState,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  } as unknown as WebSocket;
  return { socket, sent };
}

function pong(overrides: Partial<PongMessage> = {}): PongMessage {
  return { v: PROTOCOL_VERSION, t: 'pong', sid: sid('s1'), seq: 1, ts: 1, pingTs: 0, ...overrides };
}

describe('BroadcastHub', () => {
  it('sendTo delivers to a registered, open connection', () => {
    const hub = new BroadcastHub();
    const { socket, sent } = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket });

    const delivered = hub.sendTo(pid('p1'), pong());

    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual(pong());
  });

  it('sendTo returns false for an unregistered participant', () => {
    const hub = new BroadcastHub();
    expect(hub.sendTo(pid('ghost'), pong())).toBe(false);
  });

  it('sendTo returns false for a registered but non-open socket, without throwing', () => {
    const hub = new BroadcastHub();
    const { socket, sent } = fakeSocket(3 /* CLOSED */);
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket });

    expect(() => hub.sendTo(pid('p1'), pong())).not.toThrow();
    expect(hub.sendTo(pid('p1'), pong())).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('unregister makes the participant unreachable', () => {
    const hub = new BroadcastHub();
    const { socket } = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket });
    hub.unregister(pid('p1'));

    expect(hub.isConnected(pid('p1'))).toBe(false);
    expect(hub.sendTo(pid('p1'), pong())).toBe(false);
  });

  it('unregister is a total no-op for an unknown participant', () => {
    const hub = new BroadcastHub();
    expect(() => hub.unregister(pid('ghost'))).not.toThrow();
  });

  it('broadcastToSession reaches every participant in that session and no other', () => {
    const hub = new BroadcastHub();
    const a = fakeSocket();
    const b = fakeSocket();
    const c = fakeSocket(); // different session
    hub.register({ pid: pid('a'), sid: sid('s1'), socket: a.socket });
    hub.register({ pid: pid('b'), sid: sid('s1'), socket: b.socket });
    hub.register({ pid: pid('c'), sid: sid('s2'), socket: c.socket });

    hub.broadcastToSession(sid('s1'), pong());

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
  });

  it('broadcastToSession excludes the given participant', () => {
    const hub = new BroadcastHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.register({ pid: pid('a'), sid: sid('s1'), socket: a.socket });
    hub.register({ pid: pid('b'), sid: sid('s1'), socket: b.socket });

    hub.broadcastToSession(sid('s1'), pong(), pid('a'));

    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  it('participantsOf returns an empty list for an unknown session', () => {
    const hub = new BroadcastHub();
    expect(hub.participantsOf(sid('ghost'))).toEqual([]);
  });

  it('removes an empty session bucket once its last participant unregisters', () => {
    const hub = new BroadcastHub();
    const { socket } = fakeSocket();
    hub.register({ pid: pid('a'), sid: sid('s1'), socket });
    hub.unregister(pid('a'));

    expect(hub.participantsOf(sid('s1'))).toEqual([]);
  });
});
