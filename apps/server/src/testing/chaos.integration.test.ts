import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { OutboundMessage, WelcomeMessage } from '@copresence/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TestClient, TestServer } from './harness.js';
import {
  connectTestClient,
  freshParticipantId,
  freshSessionId,
  startTestServer,
} from './harness.js';

/**
 * The chaos lab's own headline exit criteria, proven against the real
 * composition — real `ws` clients, the real `ChaosMiddleware`,
 * `MetricsCollector` and `ConvergenceTracker` wired exactly as
 * `index.ts`'s composition root wires them (see harness.ts). Not mocked
 * or reached-around: these are the same knobs `/api/chaos` exposes to a
 * reviewer, driven directly here for a fast, deterministic-enough CI run.
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

function sendCursor(client: TestClient, sid: string, pid: string, seq: number): void {
  client.send({
    v: PROTOCOL_VERSION,
    t: 'cursor',
    sid,
    pid,
    seq,
    ts: Date.now(),
    x: Math.random(),
    y: Math.random() * 1000,
  });
}

describe('chaos lab integration', () => {
  let testServer: TestServer;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    testServer = await startTestServer({ tickRateHz: 20 }); // the real, documented default
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await testServer.close();
  });

  it('coalescing ratio is measurably >= 5:1 under continuous mouse movement across participants', async () => {
    const sid = freshSessionId();
    const pidA = freshParticipantId();
    const pidB = freshParticipantId();
    const a = await joinSession(testServer.port, sid, pidA);
    const b = await joinSession(testServer.port, sid, pidB);
    clients.push(a, b);

    // A burst rather than paced sends: both participants' combined event
    // volume arrives well before the server's next 20Hz tick even fires,
    // which is exactly the case ADR 0003's coalescing design targets —
    // outbound cost stays bounded by the tick rate no matter how many
    // events arrived in between.
    const EVENTS_PER_PARTICIPANT = 200;
    let seqA = 2;
    let seqB = 2;
    for (let i = 0; i < EVENTS_PER_PARTICIPANT; i += 1) {
      sendCursor(a, sid, pidA, seqA++);
      sendCursor(b, sid, pidB, seqB++);
    }

    await new Promise((resolve) => setTimeout(resolve, 400)); // let several ticks (and the settle window) flush

    const snapshot = testServer.metrics.snapshot();
    expect(snapshot.eventsReceived).toBe(EVENTS_PER_PARTICIPANT * 2);
    expect(snapshot.patchesEmitted).toBeGreaterThan(0);
    expect(snapshot.coalescingRatio).toBeGreaterThanOrEqual(5);
  });

  it(
    'two clients converge to identical simulated state within 500ms of input stopping, under sustained chaos (20% drop, 5% duplicate, 300±150ms latency, reorder window 5)',
    async () => {
      const sid = freshSessionId();
      const pidA = freshParticipantId();
      const pidB = freshParticipantId();
      const a = await joinSession(testServer.port, sid, pidA);
      const b = await joinSession(testServer.port, sid, pidB);
      clients.push(a, b);

      // Chaos is enabled only after both are already connected — it
      // represents degraded *ongoing* network conditions, not an
      // unreliable initial handshake (see MILESTONE.md's Phase 5 build
      // notes for why this scope choice was made).
      testServer.chaos.configure({
        dropRate: 0.2,
        duplicateRate: 0.05,
        latencyMs: 300,
        jitterMs: 150,
        reorderWindow: 5,
      });

      let seqA = 2;
      let seqB = 2;
      const inputDurationMs = 1_000;
      const start = Date.now();
      while (Date.now() - start < inputDurationMs) {
        sendCursor(a, sid, pidA, seqA++);
        sendCursor(b, sid, pidB, seqB++);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Input has now stopped.

      const deadline = Date.now() + 500;
      let converged = false;
      while (Date.now() < deadline) {
        const snapshot = testServer.convergenceTracker.snapshot(sid as never);
        if (snapshot.converged && Object.keys(snapshot.hashes).length === 2) {
          converged = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(converged).toBe(true);
    },
    10_000,
  );

  it(
    'a 10s partition, then healed, converges within 1s with zero manual intervention',
    async () => {
      const sid = freshSessionId();
      const pidA = freshParticipantId();
      const pidB = freshParticipantId();
      const a = await joinSession(testServer.port, sid, pidA);
      const b = await joinSession(testServer.port, sid, pidB);
      clients.push(a, b);

      let seqA = 2;
      let seqB = 2;
      sendCursor(a, sid, pidA, seqA++);
      sendCursor(b, sid, pidB, seqB++);
      await new Promise((resolve) => setTimeout(resolve, 150)); // let the pre-partition state actually land on both sides

      testServer.chaos.startPartition(10_000);

      // Traffic continues during the outage — none of it should arrive.
      const duringPartition = Date.now() + 10_000;
      while (Date.now() < duringPartition) {
        sendCursor(a, sid, pidA, seqA++);
        sendCursor(b, sid, pidB, seqB++);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(testServer.chaos.isPartitioned()).toBe(false); // the 10s window has now elapsed on its own

      // Input continues briefly past the heal, then stops.
      for (let i = 0; i < 10; i += 1) {
        sendCursor(a, sid, pidA, seqA++);
        sendCursor(b, sid, pidB, seqB++);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const deadline = Date.now() + 1_000;
      let converged = false;
      while (Date.now() < deadline) {
        const snapshot = testServer.convergenceTracker.snapshot(sid as never);
        if (snapshot.converged && Object.keys(snapshot.hashes).length === 2) {
          converged = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(converged).toBe(true);
    },
    15_000,
  );
});
