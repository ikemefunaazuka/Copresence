import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  MAX_INBOUND_MESSAGE_BYTES,
  SessionIdSchema,
} from '@copresence/protocol';
import type { Express } from 'express';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { handleDisconnect } from './controllers/ConnectionController.js';
import { createConnectionContext } from './controllers/types.js';
import type { ControllerDeps } from './controllers/types.js';
import type { Logger } from './lib/logger.js';
import { handleRealtimeMessage } from './routes/realtimeRouter.js';

/**
 * `ws`'s message payload is `Buffer | ArrayBuffer | Buffer[]`, never
 * plain `string` — calling `.toString()` on the array case would give
 * `Object.prototype.toString`'s default (effectively `"[object
 * Object],[object Object]"`), not the frame's actual bytes.
 */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export interface CreateServerOptions {
  readonly app: Express;
  readonly controllerDeps: ControllerDeps;
  readonly logger: Logger;
  /** Overridable so tests can observe heartbeat termination without a real 15s wait. */
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMaxMissed?: number;
}

export interface CopresenceServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  /** Closes every socket with 1001 ("going away"), then the WS and HTTP servers — MILESTONE Phase 2. */
  close(): Promise<void>;
}

/**
 * Composition root for the transport layer: binds HTTP and WebSocket
 * traffic to one port, one `http.Server` underneath both — `ws` attaches
 * to it rather than listening separately (MILESTONE Phase 2).
 *
 * A connection joins a session via `?sid=<id>` on the WebSocket URL — the
 * same id `POST /api/sessions` returns and `GET /api/sessions/:sid`
 * reads — rather than the session id arriving only inside the first
 * message; the server can reject the upgrade outright for a missing or
 * malformed one.
 */
export function createServer(options: CreateServerOptions): CopresenceServer {
  const { app, controllerDeps, logger } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeatMaxMissed = options.heartbeatMaxMissed ?? HEARTBEAT_MAX_MISSED;
  const httpServer = createHttpServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // A frame over this is rejected by `ws` itself — the connection is
    // closed with code 1009 before the oversized payload is ever fully
    // buffered, let alone parsed (see docs/adr and MAX_INBOUND_MESSAGE_BYTES).
    maxPayload: MAX_INBOUND_MESSAGE_BYTES,
  });

  const missedPongs = new WeakMap<WebSocket, number>();

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const parsedSid = SessionIdSchema.safeParse(url.searchParams.get('sid'));
    if (!parsedSid.success) {
      socket.close(1008, 'sid query parameter is required');
      return;
    }

    const ctx = createConnectionContext(socket, parsedSid.data, controllerDeps.clock.now());
    missedPongs.set(socket, 0);

    socket.on('pong', () => missedPongs.set(socket, 0));

    socket.on('message', (data) => {
      handleRealtimeMessage(ctx, rawDataToString(data), controllerDeps, logger);
    });

    socket.on('close', () => {
      handleDisconnect(ctx, controllerDeps);
    });

    socket.on('error', (err) => {
      logger.warn({ err, sid: ctx.sid, pid: ctx.pid }, 'websocket error');
    });
  });

  // `ws` does not detect a half-open TCP connection on its own — this is
  // the raw protocol-level ping/pong heartbeat that does, distinct from
  // the application-level `ping`/`pong` JSON messages ConnectionController
  // handles for round-trip latency (MILESTONE Phase 2).
  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      const missed = missedPongs.get(socket) ?? 0;
      if (missed >= heartbeatMaxMissed) {
        socket.terminate();
        continue;
      }
      missedPongs.set(socket, missed + 1);
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  async function close(): Promise<void> {
    clearInterval(heartbeatTimer);

    for (const socket of wss.clients) {
      socket.close(1001, 'server shutting down');
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { httpServer, wss, close };
}
