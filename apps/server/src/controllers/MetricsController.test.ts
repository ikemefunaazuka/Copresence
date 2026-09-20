import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { ConvergenceTracker } from '../services/ConvergenceTracker.js';
import { MetricsCollector } from '../services/MetricsCollector.js';

import { createMetricsController } from './MetricsController.js';

function fakeResponse(): {
  res: Response;
  status: () => number | undefined;
  type: () => string | undefined;
  body: () => unknown;
} {
  let statusCode: number | undefined;
  let contentType: string | undefined;
  let sentBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    type(t: string) {
      contentType = t;
      return res;
    },
    send(body: unknown) {
      sentBody = body;
      return res;
    },
    json(body: unknown) {
      sentBody = body;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, type: () => contentType, body: () => sentBody };
}

describe('MetricsController.prometheus', () => {
  it('reports 503 when metrics is not wired', () => {
    const controller = createMetricsController({ metrics: undefined, convergenceTracker: undefined });
    const { res, status } = fakeResponse();

    controller.prometheus({} as Request, res);

    expect(status()).toBe(503);
  });

  it('renders Prometheus text exposition format with the current counters', () => {
    const metrics = new MetricsCollector();
    metrics.recordInbound('cursor', 10);
    metrics.recordPatchEmitted();
    const controller = createMetricsController({ metrics, convergenceTracker: undefined });
    const { res, status, type, body } = fakeResponse();

    controller.prometheus({} as Request, res);

    expect(status()).toBe(200);
    expect(type()).toContain('text/plain');
    const text = body() as string;
    expect(text).toContain('# TYPE copresence_inbound_messages_total counter');
    expect(text).toContain('copresence_inbound_messages_total 1');
    expect(text).toContain('copresence_coalescing_ratio 1');
    expect(text).toContain('copresence_dropped_total{class="lossy"} 0');
  });

  it('includes latency percentile lines only once a sample has been recorded', () => {
    const metrics = new MetricsCollector();
    const controller = createMetricsController({ metrics, convergenceTracker: undefined });

    const before = fakeResponse();
    controller.prometheus({} as Request, before.res);
    expect(before.body() as string).not.toContain('copresence_delivery_latency_ms');

    metrics.recordLatencySample(42);
    const after = fakeResponse();
    controller.prometheus({} as Request, after.res);
    expect(after.body() as string).toContain('copresence_delivery_latency_ms{quantile="0.5"} 42');
  });
});

describe('MetricsController.json', () => {
  it('returns the metrics snapshot when wired', () => {
    const metrics = new MetricsCollector();
    metrics.recordInbound('scroll', 5);
    const controller = createMetricsController({ metrics, convergenceTracker: undefined });
    const { res, body } = fakeResponse();

    controller.json({} as Request, res);

    expect((body() as { metrics: { eventsReceived: number } }).metrics.eventsReceived).toBe(1);
  });

  it('returns null metrics when not wired, rather than throwing', () => {
    const controller = createMetricsController({ metrics: undefined, convergenceTracker: undefined });
    const { res, body } = fakeResponse();

    expect(() => controller.json({} as Request, res)).not.toThrow();
    expect(body()).toEqual({ metrics: null });
  });
});

describe('MetricsController.convergence', () => {
  it('returns 400 for an invalid session id', () => {
    const controller = createMetricsController({ metrics: undefined, convergenceTracker: undefined });
    const { res, status } = fakeResponse();

    controller.convergence({ params: { sid: '' } } as unknown as Request, res);

    expect(status()).toBe(400);
  });

  it('returns a trivially-converged empty snapshot when no tracker is wired', () => {
    const controller = createMetricsController({ metrics: undefined, convergenceTracker: undefined });
    const { res, body } = fakeResponse();

    controller.convergence({ params: { sid: 'some-session' } } as unknown as Request, res);

    expect(body()).toEqual({ hashes: {}, converged: true });
  });

  it('returns the tracker’s real snapshot for a known session', () => {
    const tracker = new ConvergenceTracker();
    tracker.recordDelivery(
      'known-session' as never,
      'a' as never,
      {
        v: 1,
        t: 'welcome',
        sid: 'known-session' as never,
        pid: 'a' as never,
        seq: 0,
        ts: 0,
        participants: [{ pid: 'a' as never, color: '#f00', lastSeenAt: 0 }],
      } as never,
    );
    const controller = createMetricsController({ metrics: undefined, convergenceTracker: tracker });
    const { res, body } = fakeResponse();

    controller.convergence({ params: { sid: 'known-session' } } as unknown as Request, res);

    expect(body()).toEqual(tracker.snapshot('known-session' as never));
  });
});
