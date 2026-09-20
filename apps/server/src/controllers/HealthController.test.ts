import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { createHealthController } from './HealthController.js';

function fakeResponse(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
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

describe('HealthController', () => {
  it('liveness reports ok', () => {
    const controller = createHealthController();
    const { res, status, body } = fakeResponse();

    controller.liveness({} as Request, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ status: 'ok' });
  });

  it('readiness reports ready', () => {
    const controller = createHealthController();
    const { res, status, body } = fakeResponse();

    controller.readiness({} as Request, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ status: 'ready' });
  });
});
