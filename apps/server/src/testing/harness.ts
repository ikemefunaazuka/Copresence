import type { AddressInfo } from 'node:net';

import { classify, encodeOutbound } from '@copresence/protocol';
import type { OutboundMessage } from '@copresence/protocol';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { createApp } from '../app.js';
import type { ControllerDeps } from '../controllers/types.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import type { CopresenceServer } from '../server.js';
import { createServer } from '../server.js';
import { AuditLog } from '../services/AuditLog.js';
import { AuditReconciler } from '../services/AuditReconciler.js';
import { BroadcastHub } from '../services/BroadcastHub.js';
import { ChaosMiddleware } from '../services/ChaosMiddleware.js';
import { ConvergenceTracker } from '../services/ConvergenceTracker.js';
import { MetricsCollector } from '../services/MetricsCollector.js';
import { Reaper } from '../services/Reaper.js';
import { SessionRegistry } from '../services/SessionRegistry.js';
import { TickScheduler } from '../services/TickScheduler.js';

/**
 * Boots the real composition — `createApp` + `createServer`, real
 * services, a real `http.Server` on an OS-assigned port — for integration
 * tests that need genuine sockets, not mocks. Not unit-tested itself;
 * exercised by every test that uses it. Wires `ChaosMiddleware` +
 * `MetricsCollector` + `ConvergenceTracker` exactly like `index.ts`'s own
 * composition root does, so the chaos-lab exit-criteria tests exercise the
 * real, complete wiring — including the actual `/api/chaos` and
 * `/api/sessions/:sid/convergence` HTTP surface — rather than reaching
 * around it.
 */
export interface TestServer {
  readonly port: number;
  readonly registry: SessionRegistry;
  readonly hub: BroadcastHub;
  readonly auditLog: AuditLog;
  readonly tickScheduler: TickScheduler;
  readonly reaper: Reaper;
  readonly auditReconciler: AuditReconciler;
  readonly chaos: ChaosMiddleware;
  readonly metrics: MetricsCollector;
  readonly convergenceTracker: ConvergenceTracker;
  readonly server: CopresenceServer;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    tickRateHz?: number;
    participantTtlMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatMaxMissed?: number;
    corsOrigin?: string;
  } = {},
): Promise<TestServer> {
  const logger = createLogger('silent');
  const registry = new SessionRegistry(systemClock);
  const auditLog = new AuditLog();
  const metrics = new MetricsCollector();
  const convergenceTracker = new ConvergenceTracker();
  const chaos = new ChaosMiddleware({
    clock: systemClock,
    onDeliver: (pid, message, deliveredAt) => {
      metrics.recordOutbound(Buffer.byteLength(encodeOutbound(message)));
      metrics.recordLatencySample(deliveredAt - message.ts);
      convergenceTracker.recordDelivery(message.sid, pid, message);
    },
    onDrop: (_pid, message) => {
      metrics.recordDrop(classify(message.t));
    },
    onDuplicate: () => {
      metrics.recordDuplicateSent();
    },
  });
  const hub = new BroadcastHub({ chaos });
  const controllerDeps: ControllerDeps = { registry, hub, auditLog, clock: systemClock, metrics };

  const app = createApp({
    corsOrigin: options.corsOrigin ?? '*',
    logger,
    controllerDeps,
    chaos,
    metrics,
    convergenceTracker,
  });
  const server = createServer({
    app,
    controllerDeps,
    logger,
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options.heartbeatMaxMissed !== undefined
      ? { heartbeatMaxMissed: options.heartbeatMaxMissed }
      : {}),
  });

  const tickScheduler = new TickScheduler({
    registry,
    hub,
    clock: systemClock,
    tickRateHz: options.tickRateHz ?? 20,
    metrics,
  });
  const reaper = new Reaper({
    registry,
    hub,
    auditLog,
    clock: systemClock,
    ttlMs: options.participantTtlMs ?? 60_000,
  });
  const auditReconciler = new AuditReconciler({
    auditLog,
    clock: systemClock,
    ttlMs: options.participantTtlMs ?? 60_000,
  });

  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, resolve);
  });
  const address = server.httpServer.address() as AddressInfo;

  tickScheduler.start();

  return {
    port: address.port,
    registry,
    hub,
    auditLog,
    tickScheduler,
    reaper,
    auditReconciler,
    chaos,
    metrics,
    convergenceTracker,
    server,
    async close() {
      tickScheduler.stop();
      reaper.stop();
      auditReconciler.stop();
      await server.close();
    },
  };
}

/** A real `ws` client with a small promise-based API over its message stream. */
export interface TestClient {
  readonly socket: WebSocket;
  send(message: unknown): void;
  /** Resolves with the next message matching `predicate`, or rejects after `timeoutMs`. */
  waitFor<T extends OutboundMessage>(
    predicate: (msg: OutboundMessage) => msg is T,
    timeoutMs?: number,
  ): Promise<T>;
  /** Every message received so far, in arrival order. */
  received(): readonly OutboundMessage[];
  close(): void;
}

/** Same reasoning as server.ts's identical helper: `RawData` is never plain `string`. */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export async function connectTestClient(port: number, sid: string): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?sid=${encodeURIComponent(sid)}`);
  const messages: OutboundMessage[] = [];
  const waiters: {
    predicate: (msg: OutboundMessage) => boolean;
    resolve: (msg: OutboundMessage) => void;
  }[] = [];

  socket.on('message', (data) => {
    const parsed = JSON.parse(rawDataToString(data)) as OutboundMessage;
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter?.predicate(parsed)) {
        waiters.splice(i, 1);
        waiter.resolve(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    socket,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    waitFor<T extends OutboundMessage>(
      predicate: (msg: OutboundMessage) => msg is T,
      timeoutMs = 2_000,
    ): Promise<T> {
      const already = messages.find(predicate);
      if (already) return Promise.resolve(already);

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(
            (w) => w.resolve === (resolve as (msg: OutboundMessage) => void),
          );
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching message`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg as T);
          },
        });
      });
    },
    received: () => messages,
    close: () => socket.close(),
  };
}

let sidCounter = 0;
/** A fresh session id per call, so tests never collide with each other's state. */
export function freshSessionId(): string {
  sidCounter += 1;
  return `test-session-${process.pid}-${sidCounter}`;
}

let pidCounter = 0;
export function freshParticipantId(): string {
  pidCounter += 1;
  return `test-participant-${process.pid}-${pidCounter}`;
}
