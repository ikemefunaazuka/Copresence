import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../lib/clock.js';
import { ChaosMiddleware, DEFAULT_CHAOS_CONFIG } from '../services/ChaosMiddleware.js';

import { createChaosController } from './ChaosController.js';

function fakeResponse(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: unknown) {
      jsonBody = body;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => jsonBody };
}

function fakeRequest(body: unknown = {}): Request {
  return { body } as unknown as Request;
}

describe('ChaosController without chaos wired (disabled)', () => {
  const controller = createChaosController(undefined);

  it('panel still renders (it is just HTML, no chaos state needed to show it)', () => {
    const { res, status } = fakeResponse();
    controller.panel({} as Request, res);
    expect(status()).toBe(200);
  });

  it('getConfig reports enabled: false', () => {
    const { res, body } = fakeResponse();
    controller.getConfig({} as Request, res);
    expect(body()).toEqual({ enabled: false });
  });

  it('updateConfig reports 503', () => {
    const { res, status } = fakeResponse();
    controller.updateConfig(fakeRequest(), res);
    expect(status()).toBe(503);
  });

  it('partition reports 503', () => {
    const { res, status } = fakeResponse();
    controller.partition(fakeRequest(), res);
    expect(status()).toBe(503);
  });

  it('reset reports 503', () => {
    const { res, status } = fakeResponse();
    controller.reset(fakeRequest(), res);
    expect(status()).toBe(503);
  });
});

describe('ChaosController with chaos wired', () => {
  function setUp() {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    return { chaos, controller: createChaosController(chaos) };
  }

  it('getConfig reports enabled: true with the current config and partition state', () => {
    const { controller } = setUp();
    const { res, body } = fakeResponse();

    controller.getConfig({} as Request, res);

    expect(body()).toEqual({
      enabled: true,
      config: DEFAULT_CHAOS_CONFIG,
      partitioned: false,
      partitionRemainingMs: 0,
    });
  });

  it('updateConfig applies a valid partial config and returns the resulting (clamped) config', () => {
    const { controller } = setUp();
    const { res, body, status } = fakeResponse();

    controller.updateConfig(fakeRequest({ dropRate: 0.3, latencyMs: 500 }), res);

    expect(status()).toBe(200);
    expect(body()).toEqual({
      config: { ...DEFAULT_CHAOS_CONFIG, dropRate: 0.3, latencyMs: 500 },
    });
  });

  it('updateConfig returns 400 for a malformed body rather than applying anything', () => {
    const { controller, chaos } = setUp();
    const { res, status } = fakeResponse();

    controller.updateConfig(fakeRequest({ dropRate: 'not a number' }), res);

    expect(status()).toBe(400);
    expect(chaos.getConfig()).toEqual(DEFAULT_CHAOS_CONFIG); // untouched
  });

  it('updateConfig returns 400 for an unknown field (schema is strict)', () => {
    const { controller } = setUp();
    const { res, status } = fakeResponse();

    controller.updateConfig(fakeRequest({ notARealKnob: 1 }), res);

    expect(status()).toBe(400);
  });

  it('partition starts a partition for the given duration', () => {
    const { controller, chaos } = setUp();
    const { res, body } = fakeResponse();

    controller.partition(fakeRequest({ durationMs: 5_000 }), res);

    expect(body()).toEqual({ endsAt: 5_000 });
    expect(chaos.isPartitioned()).toBe(true);
  });

  it('partition defaults to 10s when no duration is given', () => {
    const { controller, chaos } = setUp();
    const { res } = fakeResponse();

    controller.partition(fakeRequest({}), res);

    expect(chaos.partitionRemainingMs()).toBe(10_000);
  });

  it('reset clears the config back to defaults', () => {
    const { controller, chaos } = setUp();
    chaos.configure({ dropRate: 0.4 });
    const { res, body } = fakeResponse();

    controller.reset(fakeRequest(), res);

    expect(body()).toEqual({ config: DEFAULT_CHAOS_CONFIG });
    expect(chaos.getConfig()).toEqual(DEFAULT_CHAOS_CONFIG);
  });
});
