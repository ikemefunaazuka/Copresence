import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { OutboundMessage, WelcomeMessage } from '@copresence/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestClient, TestServer } from './harness.js';
import {
  connectTestClient,
  freshParticipantId,
  freshSessionId,
  startTestServer,
} from './harness.js';

/**
 * The five exit criteria from MILESTONE.md's Phase 6, proven against the
 * real composition — real `ws` clients, real HTTP requests, the real
 * `AuditLog`/`Reaper`/`AuditController` wiring `harness.ts` builds. Each
 * `it` below is named after the criterion it proves, in the order the
 * milestone lists them.
 */

function isWelcome(msg: OutboundMessage): msg is WelcomeMessage {
  return msg.t === 'welcome';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let eventIdCounter = 0;
function freshEventId(): string {
  eventIdCounter += 1;
  return `evt-${process.pid}-${eventIdCounter}`;
}

describe('audit lifecycle integration — Phase 6 exit criteria', () => {
  let testServer: TestServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await testServer?.close();
    testServer = undefined;
  });

  function url(path: string): string {
    return `http://127.0.0.1:${testServer!.port}${path}`;
  }

  it('killing the process outright (no close frame, no lifecycle event) still gets a complete session.end from the reaper within its TTL', async () => {
    testServer = await startTestServer({ participantTtlMs: 80 });
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    clients.push(client);
    // No `bye`, no close, no audit message at all — a killed process leaves the connection exactly this silent; only a TTL sweep can ever notice.

    await sleep(120); // past the TTL
    testServer.reaper.sweep();

    const ends = testServer.auditLog
      .forSession(sid as never)
      .filter((record) => record.kind === 'session.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ source: 'inferred', pid });
  });

  it('a bfcache-duplicated beacon (the same eventId sent twice) lands as exactly one event, recording that it was reported twice', async () => {
    testServer = await startTestServer();
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const body = JSON.stringify({
      v: PROTOCOL_VERSION,
      t: 'session.end',
      sid,
      pid,
      seq: 1,
      ts: Date.now(),
      eventId: freshEventId(),
      reason: 'navigate',
    });

    const first = await fetch(url('/audit/beacon'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    // The page came back from bfcache and the same still-unconfirmed outbox entry fired again.
    const second = await fetch(url('/audit/beacon'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const records = testServer.auditLog.forSession(sid as never);
    expect(records).toHaveLength(1);
    expect(records[0]!.reports).toHaveLength(2);
    expect(records[0]!.reports.every((report) => report.source === 'client')).toBe(true);
  });

  it('offline at flush time: unreachable via GET /api/sessions/:sid/audit only means the beacon never landed — the socket-close path still closes the record on its own', async () => {
    testServer = await startTestServer();
    const sid = freshSessionId();
    const pid = freshParticipantId();
    const client = await joinSession(testServer.port, sid, pid);
    client.close(); // abrupt — no `bye`, and (simulating "offline") no beacon POST ever made for this participant either

    await sleep(100); // let the close event settle

    const ends = testServer.auditLog
      .forSession(sid as never)
      .filter((record) => record.kind === 'session.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ source: 'socket', pid });
  });

  it('drop 100% of beacon requests — the socket-close and reaper paths still close the record independently, with zero client-beacon involvement', async () => {
    testServer = await startTestServer({ participantTtlMs: 80 });
    const sid = freshSessionId();

    // Connection goes silent — as if every beacon attempt failed and the tab was killed outright. Only the reaper can close this one.
    const pidSilent = freshParticipantId();
    const silent = await joinSession(testServer.port, sid, pidSilent);
    clients.push(silent);

    // The socket itself closes cleanly at the transport level — as if the tab closed before any beacon got a chance to fire. The socket-close path closes this one.
    const pidClosed = freshParticipantId();
    const closed = await joinSession(testServer.port, sid, pidClosed);
    closed.close();

    await sleep(120);
    testServer.reaper.sweep();

    const ends = testServer.auditLog
      .forSession(sid as never)
      .filter((record) => record.kind === 'session.end');
    const sourceByPid = new Map<string, string>(ends.map((record) => [record.pid, record.source]));
    expect(sourceByPid.get(pidSilent)).toBe('inferred');
    expect(sourceByPid.get(pidClosed)).toBe('socket');
  });

  it('invariant across every session-closure path: no session.start is ever left without a session.end', async () => {
    testServer = await startTestServer({ participantTtlMs: 80 });
    const sid = freshSessionId();

    // (a) an explicit, clean client-reported close.
    const pidClean = freshParticipantId();
    const clean = await joinSession(testServer.port, sid, pidClean);
    clients.push(clean);
    clean.send({
      v: PROTOCOL_VERSION,
      t: 'session.start',
      sid,
      pid: pidClean,
      seq: 2,
      ts: Date.now(),
      eventId: freshEventId(),
    });
    clean.send({
      v: PROTOCOL_VERSION,
      t: 'session.end',
      sid,
      pid: pidClean,
      seq: 3,
      ts: Date.now(),
      eventId: freshEventId(),
      reason: 'navigate',
    });

    // (b) session.start reported, then the connection drops (socket path catches the close).
    const pidDropped = freshParticipantId();
    const dropped = await joinSession(testServer.port, sid, pidDropped);
    dropped.send({
      v: PROTOCOL_VERSION,
      t: 'session.start',
      sid,
      pid: pidDropped,
      seq: 2,
      ts: Date.now(),
      eventId: freshEventId(),
    });
    dropped.close();

    // (c) session.start reported, then the connection goes silent with no close frame at all — only the reaper catches this one.
    const pidSilent = freshParticipantId();
    const silent = await joinSession(testServer.port, sid, pidSilent);
    clients.push(silent);
    silent.send({
      v: PROTOCOL_VERSION,
      t: 'session.start',
      sid,
      pid: pidSilent,
      seq: 2,
      ts: Date.now(),
      eventId: freshEventId(),
    });

    await sleep(150);
    testServer.reaper.sweep();

    const records = testServer.auditLog.forSession(sid as never);
    const starts = new Set(
      records.filter((record) => record.kind === 'session.start').map((record) => record.pid),
    );
    const withEnd = new Set(
      records.filter((record) => record.kind === 'session.end').map((record) => record.pid),
    );
    const danglingStarts = [...starts].filter((pid) => !withEnd.has(pid));

    expect(starts.size).toBe(3);
    expect(danglingStarts).toEqual([]);
  });
});
