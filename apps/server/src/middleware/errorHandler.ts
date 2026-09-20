import type { ErrorRequestHandler } from 'express';

import type { Logger } from '../lib/logger.js';

/**
 * The one place an uncaught error in an HTTP handler ends up. Errors are
 * never thrown to the socket layer (MILESTONE Phase 2) — this is the
 * HTTP-side equivalent: whatever went wrong, the client gets a clean 500
 * and the real detail goes to the log, not the response body.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    logger.error({ err, path: req.path, method: req.method }, 'unhandled request error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  };
}
