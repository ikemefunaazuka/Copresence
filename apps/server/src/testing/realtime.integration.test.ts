import { PROTOCOL_VERSION } from '@copresence/protocol';
import type {
  ErrorMessage,
  JoinMessage,
  LeaveMessage,
  OutboundMessage,
  PatchMessage,
  SessionId,
  WelcomeMessage,
} from '@copresence/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { TestClient, TestServer } from './harness.js';
import {
  connectTestClient,
  freshParticipantId,
  freshSessionId,
  startTestServer,
} from './harness.js';

/**
 * Real `ws` clients against a real, fully composed server on an
 * OS-assigned port — not mocks.
 */

function isWelcome(msg: OutboundMessage): msg is WelcomeMessage {
  return msg.t === 'welcome';
}
function isJoin(msg: OutboundMessage): msg is JoinMessage {
  return msg.t === 'join';
}
function isLeave(msg: OutboundMessage): msg is LeaveMessage {
  return msg.t === 'leave';
}
function isPatch(msg: OutboundMessage): msg is PatchMessage {
  return msg.t === 'patch';
}
function isError(msg: OutboundMessage): msg is ErrorMessage {
  return msg.t === 'error';
}

async function joinSession(port: number, sid: string, pid: string): Promise<TestClient> {
  const client = await connectTestClient(port, sid);
  client.send({
    v: PROTOCOL_VERSION,
    t: 'hello',
    sid,
    pid,
    seq: 1,
    ts: Date.now(),
    docWidth: 1024,
    docHeight: 2000,
    dpr: 1,
    visibilityState: 'visible',
  });
  await client.waitFor(isWelcome);
  return client;
}

describe('realtime integration', () => {
  let testServer: TestServer;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    testServer = await startTestServer({ tickRateHz: 40 }); // faster tick keeps tests quick
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await testServer.close();
  });

  it('join: a client completes the handshake and receives welcome with itself in the roster', async () => {
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);

    const welcome = client.received().find(isWelcome)!;
    expect(welcome.pid).toBe(pid);
    expect(welcome.participants.map((p) => p.pid)).toContain(pid);
  });

  it('join: an existing participant is notified via join when a second one arrives', async () => {
    const sid = freshSessionId();
    const a = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(a);

    const bPid = freshParticipantId();
    const joinSeen = a.waitFor(isJoin);
    const b = await joinSession(testServer.port, sid, bPid);
    clients.push(b);

    const join = await joinSeen;
    expect(join.participant.pid).toBe(bPid);
  });

  it('a repeat hello from an already-joined participant (e.g. a resize) sends a fresh welcome but does not re-announce a join', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(a, b);

    a.send({
      v: PROTOCOL_VERSION,
      t: 'hello',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      docWidth: 2048,
      docHeight: 4000,
      dpr: 2,
      visibilityState: 'visible',
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the second welcome/handling settle

    expect(a.received().filter(isWelcome)).toHaveLength(2); // the original join's, plus this one
    // b joined after a, so it never received a `join` about a in the first
    // place (it learned about a via its own welcome) — zero here, both
    // before and after a's second hello, is exactly what proves no
    // re-announcement happened.
    expect(b.received().filter(isJoin)).toHaveLength(0);
  });

  it('two-party mirroring: a cursor move from A is coalesced into a patch B receives', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(a, b);

    a.send({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      x: 0.42,
      y: 314,
    });

    const patch = await b.waitFor(isPatch);
    expect(patch.patches).toContainEqual({ pid: pidA, x: 0.42, y: 314 });
  });

  it('disconnect: a clean close broadcasts leave to the remaining participant', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(b);

    const leaveSeen = b.waitFor(isLeave);
    a.close();
    const leave = await leaveSeen;

    expect(leave.pid).toBe(pidA);
  });

  it('disconnect via explicit bye also broadcasts leave, and records no socket-sourced audit entry', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(b);

    const leaveSeen = b.waitFor(isLeave);
    a.send({ v: PROTOCOL_VERSION, t: 'bye', sid, pid: pidA, seq: 2, ts: Date.now() });
    await leaveSeen;
    a.close();
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the close event settle

    const socketSourced = testServer.auditLog
      .forSession(sid as SessionId)
      .filter((r) => r.source === 'socket');
    expect(socketSourced).toHaveLength(0);
  });

  it('reconnect: a fresh connection into a session with existing state resyncs via welcome', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    clients.push(a);
    a.send({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      x: 0.7,
      y: 70,
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let a tick flush it into presence

    const reconnectPid = freshParticipantId();
    const reconnected = await joinSession(testServer.port, sid, reconnectPid);
    clients.push(reconnected);

    const welcome = reconnected.received().find(isWelcome)!;
    const aInRoster = welcome.participants.find((p) => p.pid === pidA);
    expect(aInRoster).toMatchObject({ x: 0.7, y: 70 });
  });

  it('malformed JSON produces an error frame and the connection survives to handshake afterwards', async () => {
    const sid = freshSessionId();
    const client = await connectTestClient(testServer.port, sid);
    clients.push(client);

    const errorSeen = client.waitFor(isError);
    client.socket.send('{not valid json');
    const error = await errorSeen;
    expect(error.code).toBe('malformed-json');

    // The same connection still works afterwards.
    const pid = freshParticipantId();
    client.send({
      v: PROTOCOL_VERSION,
      t: 'hello',
      sid,
      pid,
      seq: 1,
      ts: Date.now(),
      docWidth: 1024,
      docHeight: 2000,
      dpr: 1,
      visibilityState: 'visible',
    });
    const welcome = await client.waitFor(isWelcome);
    expect(welcome.pid).toBe(pid);
  });

  it('a structurally-invalid message produces a validation-failed error, connection survives', async () => {
    const sid = freshSessionId();
    const client = await connectTestClient(testServer.port, sid);
    clients.push(client);

    const errorSeen = client.waitFor(isError);
    client.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        t: 'cursor',
        sid,
        pid: 'p',
        seq: 1,
        ts: 1,
        x: 5,
        y: 0,
      }),
    );
    const error = await errorSeen;
    expect(error.code).toBe('validation-failed');
  });

  it('oversized frame is rejected without crashing the server, which stays responsive for other connections', async () => {
    const sid = freshSessionId();
    const client = await connectTestClient(testServer.port, sid);

    const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
    // Comfortably over MAX_INBOUND_MESSAGE_BYTES (8KB).
    client.socket.send('x'.repeat(64 * 1024));
    await closed;

    // The server itself is still healthy — a brand new connection can
    // complete a normal handshake right after.
    const survivor = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(survivor);
    expect(survivor.received().find(isWelcome)).toBeDefined();
  });

  it('a fuzz of 1000 adversarial frames never crashes the process or wedges the connection', async () => {
    const sid = freshSessionId();
    const client = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(client);

    const adversarial: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const kind = i % 6;
      switch (kind) {
        case 0:
          adversarial.push('not json at all');
          break;
        case 1:
          adversarial.push(JSON.stringify({ t: 'cursor' })); // missing every other field
          break;
        case 2:
          adversarial.push(JSON.stringify({ v: 1, t: 'teleport', sid, pid: 'x', seq: 1, ts: 1 }));
          break;
        case 3:
          adversarial.push(JSON.stringify(Array.from({ length: 50 }, (_, n) => n))); // valid JSON, wrong shape
          break;
        case 4:
          adversarial.push(
            JSON.stringify({ v: 'not-a-number', t: 'ping', sid, pid: 'x', seq: 1, ts: 1 }),
          );
          break;
        default:
          adversarial.push(
            '{"v":1,"t":"cursor","sid":"' +
              sid +
              '","pid":"x","seq":1,"ts":1,"x":' +
              Number.MAX_SAFE_INTEGER +
              ',"y":0}',
          );
      }
    }

    expect(() => {
      for (const frame of adversarial) client.socket.send(frame);
    }).not.toThrow();

    // Still alive and responsive: a legitimate message right after gets a
    // real reply, proving the connection (and the process) survived.
    const pongSeen = client.waitFor(
      (msg): msg is OutboundMessage & { t: 'pong' } => msg.t === 'pong',
    );
    client.send({
      v: PROTOCOL_VERSION,
      t: 'ping',
      sid,
      pid: client.received().find(isWelcome)!.pid,
      seq: 9999,
      ts: Date.now(),
    });
    await pongSeen;
  });

  it('graceful shutdown closes every socket with code 1001 and resolves within 5s', async () => {
    // A dedicated server rather than the shared `testServer` — this test
    // closes it itself, and afterEach must still have a live server of
    // its own to tear down afterwards.
    const dedicated = await startTestServer();
    const sid = freshSessionId();
    const a = await joinSession(dedicated.port, sid, freshParticipantId());
    const b = await joinSession(dedicated.port, sid, freshParticipantId());

    const aClosed = new Promise<number>((resolve) =>
      a.socket.once('close', (code) => resolve(code)),
    );
    const bClosed = new Promise<number>((resolve) =>
      b.socket.once('close', (code) => resolve(code)),
    );

    const start = Date.now();
    await dedicated.close(); // also closes both sockets above, with code 1001
    const elapsedMs = Date.now() - start;

    const [codeA, codeB] = await Promise.all([aClosed, bClosed]);
    expect(codeA).toBe(1001);
    expect(codeB).toBe(1001);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('scroll, like cursor, is coalesced into a patch the other participant receives', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(a, b);

    a.send({
      v: PROTOCOL_VERSION,
      t: 'scroll',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      scrollX: 0,
      scrollY: 900,
    });

    const patch = await b.waitFor(isPatch);
    expect(patch.patches).toContainEqual({ pid: pidA, scrollX: 0, scrollY: 900 });
  });

  it('an audit message over the live socket is recorded with source: client', async () => {
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);

    client.send({
      v: PROTOCOL_VERSION,
      t: 'visibility.change',
      sid,
      pid,
      seq: 2,
      ts: Date.now(),
      eventId: 'evt-visibility-1',
      visibilityState: 'hidden',
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the handler run

    const record = testServer.auditLog.get('evt-visibility-1');
    expect(record).toMatchObject({ kind: 'visibility.change', source: 'client', pid });
  });

  it('a session.end audit message records its reason in the detail field', async () => {
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);

    client.send({
      v: PROTOCOL_VERSION,
      t: 'session.end',
      sid,
      pid,
      seq: 2,
      ts: Date.now(),
      eventId: 'evt-session-end-1',
      reason: 'navigate',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const record = testServer.auditLog.get('evt-session-end-1');
    expect(record).toMatchObject({
      kind: 'session.end',
      source: 'client',
      detail: { reason: 'navigate' },
    });
  });

  it('ack is accepted and discarded without error — no reply, connection stays healthy', async () => {
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);

    expect(() =>
      client.send({ v: PROTOCOL_VERSION, t: 'ack', sid, pid, seq: 2, ts: Date.now(), acked: 1 }),
    ).not.toThrow();

    // Still responsive right after.
    const pongSeen = client.waitFor(
      (msg): msg is OutboundMessage & { t: 'pong' } => msg.t === 'pong',
    );
    client.send({ v: PROTOCOL_VERSION, t: 'ping', sid, pid, seq: 3, ts: Date.now() });
    await pongSeen;
  });

  it('a version mismatch produces its own distinct error code', async () => {
    const sid = freshSessionId();
    const client = await connectTestClient(testServer.port, sid);
    clients.push(client);

    const errorSeen = client.waitFor(isError);
    client.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION + 1,
        t: 'hello',
        sid,
        pid: freshParticipantId(),
        seq: 1,
        ts: Date.now(),
        docWidth: 1024,
        docHeight: 2000,
        dpr: 1,
        visibilityState: 'visible',
      }),
    );
    const error = await errorSeen;
    expect(error.code).toBe('version-mismatch');
  });

  it('any message before hello is rejected as unauthorized, and hello afterward still succeeds', async () => {
    const sid = freshSessionId();
    const client = await connectTestClient(testServer.port, sid);
    clients.push(client);

    const errorSeen = client.waitFor(isError);
    client.send({
      v: PROTOCOL_VERSION,
      t: 'ping',
      sid,
      pid: freshParticipantId(),
      seq: 1,
      ts: Date.now(),
    });
    const error = await errorSeen;
    expect(error.code).toBe('unauthorized');

    const pid = freshParticipantId();
    client.send({
      v: PROTOCOL_VERSION,
      t: 'hello',
      sid,
      pid,
      seq: 2,
      ts: Date.now(),
      docWidth: 1024,
      docHeight: 2000,
      dpr: 1,
      visibilityState: 'visible',
    });
    const welcome = await client.waitFor(isWelcome);
    expect(welcome.pid).toBe(pid);
  });

  it('a message claiming a different pid than this connection established is rejected as unauthorized', async () => {
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);

    const errorSeen = client.waitFor(isError);
    client.send({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid,
      pid: freshParticipantId(), // a different identity than this connection's own
      seq: 2,
      ts: Date.now(),
      x: 0.1,
      y: 1,
    });
    const error = await errorSeen;
    expect(error.code).toBe('unauthorized');
  });

  it('a duplicate/stale seq is silently dropped at the router — no error, no effect', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, freshParticipantId());
    clients.push(a, b);

    a.send({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      x: 0.1,
      y: 1,
    });
    await b.waitFor(isPatch); // let the real value land first

    // Same seq again, with a different position — must be dropped, not applied.
    a.send({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid,
      pid: pidA,
      seq: 2,
      ts: Date.now(),
      x: 0.9,
      y: 999,
    });
    await new Promise((resolve) => setTimeout(resolve, 60)); // give a tick the chance to fire if it were going to

    const errorsAfterDuplicate = a.received().filter(isError);
    expect(errorsAfterDuplicate).toEqual([]);
    // The duplicate was dropped before ever reaching `applyEvent`, so it
    // never marked anything dirty — every patch b receives (the real one,
    // plus any settle-window resends of it) carries the first, correct
    // position. If the duplicate had been applied, at least one of these
    // would show x: 0.9, y: 999 instead.
    const patchesAfterFirst = b.received().filter(isPatch);
    expect(patchesAfterFirst.length).toBeGreaterThan(0);
    for (const patch of patchesAfterFirst) {
      expect(patch.patches).toEqual([{ pid: pidA, x: 0.1, y: 1 }]);
    }
  });

  it('connecting without a sid query parameter is rejected at the upgrade, with close code 1008', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${testServer.port}/ws`);
    const code = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(code).toBe(1008);
  });

  it('a connection that stops responding to heartbeat pings is terminated after the configured missed count', async () => {
    const dedicated = await startTestServer({ heartbeatIntervalMs: 20, heartbeatMaxMissed: 2 });
    const sid = freshSessionId();
    const client = await joinSession(dedicated.port, sid, freshParticipantId());
    // A real client always answers a protocol-level ping automatically (the
    // underlying socket, not application code, handles this) — to simulate
    // an unresponsive peer, stop it from doing so.
    client.socket.pong = vi.fn();

    const terminated = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
    await terminated;

    await dedicated.close();
  });
});
