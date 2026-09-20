import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

import { generateId } from '../lib/id.js';
import type { Logger } from '../lib/logger.js';

/**
 * Request id → structured logging, as one middleware rather than two:
 * `pino-http` generates the id (via `generateId`, the same id generator
 * everything else in the server uses) and attaches a per-request child
 * logger carrying it to every log line for that request, including the
 * one it emits automatically on `res.finish` (MILESTONE Phase 2).
 */
export function createRequestLogging(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: () => generateId(),
  }) as RequestHandler;
}
