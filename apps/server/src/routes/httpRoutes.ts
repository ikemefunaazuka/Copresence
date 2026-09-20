import express, { Router } from 'express';

import { createAuditController } from '../controllers/AuditController.js';
import { createChaosController } from '../controllers/ChaosController.js';
import { createDemoController } from '../controllers/DemoController.js';
import { createHealthController } from '../controllers/HealthController.js';
import { createMetricsController } from '../controllers/MetricsController.js';
import { createSessionController } from '../controllers/SessionController.js';
import type { ControllerDeps } from '../controllers/types.js';
import type { ChaosMiddleware } from '../services/ChaosMiddleware.js';
import type { ConvergenceTracker } from '../services/ConvergenceTracker.js';
import type { MetricsCollector } from '../services/MetricsCollector.js';

export interface ObservabilityDeps {
  readonly chaos?: ChaosMiddleware;
  readonly metrics?: MetricsCollector;
  readonly convergenceTracker?: ConvergenceTracker;
}

/** The HTTP route table — mirrors the realtime dispatch table's shape. */
export function createHttpRoutes(
  deps: ControllerDeps,
  observability: ObservabilityDeps = {},
): Router {
  const router = Router();
  const health = createHealthController();
  const sessions = createSessionController(deps);
  const demo = createDemoController(deps);
  const chaos = createChaosController(observability.chaos);
  const audit = createAuditController(deps);
  const metrics = createMetricsController({
    metrics: observability.metrics,
    convergenceTracker: observability.convergenceTracker,
  });

  router.get('/healthz', health.liveness);
  router.get('/readyz', health.readiness);

  router.post('/api/sessions', sessions.create);
  router.get('/api/sessions/:sid', sessions.getBySessionId);
  router.get('/api/sessions/:sid/convergence', metrics.convergence);
  router.get('/api/sessions/:sid/audit', audit.list);

  // A plain `text/plain` body, not JSON — see ADR 0011 for why (avoids a
  // CORS preflight `sendBeacon`/`fetch(keepalive)` can't rely on
  // completing on the unload path); the body content is still
  // JSON-encoded, parsed by `decodeInbound` inside the handler itself.
  router.post('/audit/beacon', express.text({ type: '*/*' }), audit.beacon);

  router.get('/', demo.landing);
  router.get('/s/new', demo.newSession);
  router.get('/s/:sid', demo.sessionPage);

  router.get('/chaos', chaos.panel);
  router.get('/api/chaos', chaos.getConfig);
  router.patch('/api/chaos', chaos.updateConfig);
  router.post('/api/chaos/partition', chaos.partition);
  router.post('/api/chaos/reset', chaos.reset);

  router.get('/metrics', metrics.prometheus);
  router.get('/api/metrics', metrics.json);

  return router;
}
