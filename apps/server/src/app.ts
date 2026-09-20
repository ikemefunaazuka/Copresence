import express from 'express';
import type { Express } from 'express';

import type { ControllerDeps } from './controllers/types.js';
import type { Logger } from './lib/logger.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { createRequestLogging } from './middleware/requestLogging.js';
import { createSecurityMiddleware } from './middleware/security.js';
import { createHttpRoutes } from './routes/httpRoutes.js';

export interface CreateAppOptions {
  readonly corsOrigin: string;
  readonly logger: Logger;
  readonly controllerDeps: ControllerDeps;
}

/**
 * Express app only — no `.listen()` here, so tests can exercise it
 * directly (a real HTTP request against an ephemeral port, or in-process)
 * without needing the WebSocket half `server.ts` adds on top.
 *
 * Middleware order: request id → structured logging → security headers →
 * CORS → rate limit → routes → centralised error handler last, so it
 * catches whatever the routes above it did not.
 */
export function createApp(options: CreateAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(createRequestLogging(options.logger));
  app.use(createSecurityMiddleware());
  app.use(createCorsMiddleware(options.corsOrigin));
  app.use(createRateLimitMiddleware());
  app.use(express.json());

  app.use(createHttpRoutes(options.controllerDeps));

  app.use(createErrorHandler(options.logger));

  return app;
}
