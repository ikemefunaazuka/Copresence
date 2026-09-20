import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * `CORS_ORIGIN` is `"*"` for local development (MILESTONE Phase 0's
 * `.env.example`) and a single explicit origin once deployed. `cors`
 * accepts either directly — no allowlist-parsing logic needed here for
 * the single-origin case this project actually has.
 */
export function createCorsMiddleware(allowedOrigin: string): RequestHandler {
  return cors({ origin: allowedOrigin === '*' ? true : allowedOrigin });
}
