import { classify, encodeOutbound } from '@copresence/protocol';

import { createApp } from './app.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import type { ControllerDeps } from './controllers/types.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';
import { createServer } from './server.js';
import { AuditLog } from './services/AuditLog.js';
import { BroadcastHub } from './services/BroadcastHub.js';
import { ChaosMiddleware } from './services/ChaosMiddleware.js';
import { ConvergenceTracker } from './services/ConvergenceTracker.js';
import { MetricsCollector } from './services/MetricsCollector.js';
import { Reaper } from './services/Reaper.js';
import { SessionRegistry } from './services/SessionRegistry.js';
import { TickScheduler } from './services/TickScheduler.js';

/**
 * Composition root. Assembles every service exactly once, wires the
 * transport on top of them, and owns the one graceful-shutdown sequence
 * that stops all of it in a sane order.
 */
function main(): void {
  let env;

  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // console is used deliberately here: no logger can exist until config
      // is known to be valid, since the logger's own level comes from it.
      console.error(error.message);
    } else {
      console.error('Unexpected error while loading configuration:', error);
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  const clock = systemClock;

  const registry = new SessionRegistry(clock);
  const auditLog = new AuditLog();
  const metrics = new MetricsCollector();
  const convergenceTracker = new ConvergenceTracker();

  // Sits between BroadcastHub's decision to send and the raw socket write
  // — every knob starts at zero (a pure passthrough) until the `/chaos`
  // panel dials one up. `onDeliver` only ever fires for a message that
  // genuinely left the wire, which is exactly what both outbound metrics
  // and the convergence simulation need: a dropped message should affect
  // neither.
  const chaos = new ChaosMiddleware({
    clock,
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
  const controllerDeps: ControllerDeps = { registry, hub, auditLog, clock, metrics };

  const app = createApp({ corsOrigin: env.CORS_ORIGIN, logger, controllerDeps, chaos, metrics, convergenceTracker });
  const server = createServer({ app, controllerDeps, logger });

  const tickScheduler = new TickScheduler({
    registry,
    hub,
    clock,
    tickRateHz: env.TICK_RATE_HZ,
    metrics,
  });
  const reaper = new Reaper({ registry, hub, auditLog, clock, ttlMs: env.PARTICIPANT_TTL_MS });

  server.httpServer.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, tickRateHz: env.TICK_RATE_HZ, participantTtlMs: env.PARTICIPANT_TTL_MS },
      'server listening',
    );
    tickScheduler.start();
    // A sweep well within one TTL window, not tied to the presence tick
    // rate — see services/Reaper.ts.
    reaper.start(Math.max(1_000, Math.floor(env.PARTICIPANT_TTL_MS / 3)));
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    tickScheduler.stop();
    reaper.stop();

    server
      .close()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ error }, 'error during shutdown');
        process.exit(1);
      });
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main();
