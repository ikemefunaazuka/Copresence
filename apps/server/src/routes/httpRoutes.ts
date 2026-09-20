import { Router } from 'express';

import { createHealthController } from '../controllers/HealthController.js';
import { createSessionController } from '../controllers/SessionController.js';
import type { ControllerDeps } from '../controllers/types.js';

/** The HTTP route table — mirrors the realtime dispatch table's shape. */
export function createHttpRoutes(deps: ControllerDeps): Router {
  const router = Router();
  const health = createHealthController();
  const sessions = createSessionController(deps);

  router.get('/healthz', health.liveness);
  router.get('/readyz', health.readiness);

  router.post('/api/sessions', sessions.create);
  router.get('/api/sessions/:sid', sessions.getBySessionId);

  return router;
}
