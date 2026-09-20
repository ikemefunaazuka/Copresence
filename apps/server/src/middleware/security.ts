import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Standard security headers. `contentSecurityPolicy` is switched off here
 * deliberately: Phase 4 serves a real demo page from this server, and
 * Phase 7's proxy explicitly needs to control CSP itself per-response
 * (docs/adr forthcoming) — a blanket default CSP from this middleware
 * would fight both. Every other helmet default stays on.
 */
export function createSecurityMiddleware(): RequestHandler {
  return helmet({ contentSecurityPolicy: false });
}
