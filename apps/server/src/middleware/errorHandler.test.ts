import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import { Writable } from 'node:stream';
import { createLogger } from '../lib/logger.js';
import { createErrorHandler } from './errorHandler.js';

function fakeResponse(headersSent = false): { res: Response; status: () => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    headersSent,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => jsonBody };
}

describe('errorHandler', () => {
  it('logs the error and responds with a clean 500, never leaking the raw error to the client', () => {
    const logger = createLogger('silent', new Writable({ write: (_c, _e, cb) => cb() }));
    const handler = createErrorHandler(logger);
    const { res, status, body } = fakeResponse();
    const req = { path: '/boom', method: 'GET' } as Request;

    expect(() => handler(new Error('something broke'), req, res, () => {})).not.toThrow();

    expect(status()).toBe(500);
    expect(body()).toEqual({ error: 'internal server error' });
  });

  it('does nothing further once headers are already sent', () => {
    const logger = createLogger('silent', new Writable({ write: (_c, _e, cb) => cb() }));
    const handler = createErrorHandler(logger);
    const { res, status } = fakeResponse(true);
    const req = { path: '/boom', method: 'GET' } as Request;

    handler(new Error('too late'), req, res, () => {});

    expect(status()).toBeUndefined();
  });
});
