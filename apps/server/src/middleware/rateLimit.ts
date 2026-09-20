import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

/**
 * A plain fixed-window limiter on the HTTP surface — session creation and
 * lookup, not the WebSocket data path (which has its own defence:
 * backpressure and the lossy-drop policy land in Phase 3, not here).
 * Generous enough not to bother a real user or a reviewer clicking
 * around, tight enough to blunt a trivial script hammering
 * `POST /api/sessions`.
 */
export function createRateLimitMiddleware(): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
}
