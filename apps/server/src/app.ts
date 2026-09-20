import { fileURLToPath } from 'node:url';

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
import type { ChaosMiddleware } from './services/ChaosMiddleware.js';
import type { ConvergenceTracker } from './services/ConvergenceTracker.js';
import type { MetricsCollector } from './services/MetricsCollector.js';

/**
 * `packages/client/dist` relative to this module's own location — the
 * same three levels up whether this runs as `src/app.ts` under `tsx` or
 * as the compiled `dist/app.js`, since both sit exactly one directory
 * inside `apps/server/`.
 */
const DEFAULT_CLIENT_DIST_DIR = fileURLToPath(
  new URL('../../../packages/client/dist', import.meta.url),
);

/** Same reasoning as the client bundle above — `apps/inspector`'s own built Vite output. */
const DEFAULT_INSPECTOR_DIST_DIR = fileURLToPath(new URL('../../inspector/dist', import.meta.url));

export interface CreateAppOptions {
  readonly corsOrigin: string;
  readonly logger: Logger;
  readonly controllerDeps: ControllerDeps;
  /** Directory the built client bundle (`copresence.js`) is served from at `/static`. Overridable for tests. */
  readonly clientDistDir?: string;
  /** Directory the built Vue inspector app is served from at `/inspector`. Overridable for tests. */
  readonly inspectorDistDir?: string;
  /** Powers `/chaos` and its JSON API. Omitted, those routes report an empty/disabled config rather than existing with no effect. */
  readonly chaos?: ChaosMiddleware;
  readonly metrics?: MetricsCollector;
  readonly convergenceTracker?: ConvergenceTracker;
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
  app.use('/static', express.static(options.clientDistDir ?? DEFAULT_CLIENT_DIST_DIR));
  app.use('/inspector', express.static(options.inspectorDistDir ?? DEFAULT_INSPECTOR_DIST_DIR));

  app.use(
    createHttpRoutes(options.controllerDeps, {
      ...(options.chaos ? { chaos: options.chaos } : {}),
      ...(options.metrics ? { metrics: options.metrics } : {}),
      ...(options.convergenceTracker ? { convergenceTracker: options.convergenceTracker } : {}),
    }),
  );

  app.use(createErrorHandler(options.logger));

  return app;
}
