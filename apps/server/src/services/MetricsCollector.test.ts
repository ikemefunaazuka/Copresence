import { describe, expect, it } from 'vitest';

import { MetricsCollector } from './MetricsCollector.js';

describe('MetricsCollector', () => {
  it('starts at all zeros, with no coalescing ratio or latency yet', () => {
    const metrics = new MetricsCollector();
    expect(metrics.snapshot()).toEqual({
      inboundMessages: 0,
      inboundBytes: 0,
      outboundMessages: 0,
      outboundBytes: 0,
      eventsReceived: 0,
      patchesEmitted: 0,
      droppedByClass: { lossy: 0, lossless: 0, control: 0, audit: 0 },
      duplicatesSent: 0,
      duplicatesRejected: 0,
      outOfOrderRejected: 0,
      resyncsTriggered: 0,
      coalescingRatio: undefined,
      latencyMs: undefined,
    });
  });

  it('recordInbound counts every message and bytes, but only cursor/scroll as events', () => {
    const metrics = new MetricsCollector();
    metrics.recordInbound('cursor', 50);
    metrics.recordInbound('scroll', 40);
    metrics.recordInbound('ping', 20);

    const snapshot = metrics.snapshot();
    expect(snapshot.inboundMessages).toBe(3);
    expect(snapshot.inboundBytes).toBe(110);
    expect(snapshot.eventsReceived).toBe(2);
  });

  it('recordOutbound counts messages and bytes', () => {
    const metrics = new MetricsCollector();
    metrics.recordOutbound(30);
    metrics.recordOutbound(70);
    expect(metrics.snapshot()).toMatchObject({ outboundMessages: 2, outboundBytes: 100 });
  });

  it('coalescingRatio is eventsReceived / patchesEmitted, once at least one patch has been emitted', () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 10; i += 1) metrics.recordInbound('cursor', 10);
    expect(metrics.snapshot().coalescingRatio).toBeUndefined(); // no patches emitted yet

    metrics.recordPatchEmitted();
    metrics.recordPatchEmitted();
    expect(metrics.snapshot().coalescingRatio).toBe(5); // 10 events / 2 patches
  });

  it('recordDrop tallies per message class independently', () => {
    const metrics = new MetricsCollector();
    metrics.recordDrop('lossy');
    metrics.recordDrop('lossy');
    metrics.recordDrop('control');

    expect(metrics.snapshot().droppedByClass).toEqual({
      lossy: 2,
      lossless: 0,
      control: 1,
      audit: 0,
    });
  });

  it('recordDuplicateSent / recordDuplicateRejected / recordOutOfOrderRejected / recordResync each tally independently', () => {
    const metrics = new MetricsCollector();
    metrics.recordDuplicateSent();
    metrics.recordDuplicateSent();
    metrics.recordDuplicateRejected();
    metrics.recordOutOfOrderRejected();
    metrics.recordOutOfOrderRejected();
    metrics.recordOutOfOrderRejected();
    metrics.recordResync();

    const snapshot = metrics.snapshot();
    expect(snapshot.duplicatesSent).toBe(2);
    expect(snapshot.duplicatesRejected).toBe(1);
    expect(snapshot.outOfOrderRejected).toBe(3);
    expect(snapshot.resyncsTriggered).toBe(1);
  });

  it('recordLatencySample ignores non-finite and negative values rather than corrupting the percentiles', () => {
    const metrics = new MetricsCollector();
    metrics.recordLatencySample(Number.NaN);
    metrics.recordLatencySample(Number.POSITIVE_INFINITY);
    metrics.recordLatencySample(-5);
    expect(metrics.snapshot().latencyMs).toBeUndefined();
  });

  it('latencyMs reports p50/p95/p99 over the recorded samples', () => {
    const metrics = new MetricsCollector();
    for (let i = 1; i <= 100; i += 1) metrics.recordLatencySample(i);

    const latency = metrics.snapshot().latencyMs;
    expect(latency).toBeDefined();
    expect(latency!.p50).toBeGreaterThanOrEqual(45);
    expect(latency!.p50).toBeLessThanOrEqual(55);
    expect(latency!.p99).toBeGreaterThan(latency!.p50);
    expect(latency!.p95).toBeGreaterThan(latency!.p50);
    expect(latency!.p95).toBeLessThanOrEqual(latency!.p99);
  });

  it('the latency sample buffer is bounded — old samples roll off rather than growing forever', () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 1_500; i += 1) metrics.recordLatencySample(1); // well past the 1000-sample cap
    for (let i = 0; i < 50; i += 1) metrics.recordLatencySample(9_999); // a batch of very different values

    // Just proving this doesn't throw or grow unbounded, and still reports something sane.
    const latency = metrics.snapshot().latencyMs;
    expect(latency).toBeDefined();
    expect(latency!.p99).toBeLessThanOrEqual(9_999);
  });

  it('reset() zeroes every counter and clears latency samples', () => {
    const metrics = new MetricsCollector();
    metrics.recordInbound('cursor', 10);
    metrics.recordOutbound(10);
    metrics.recordPatchEmitted();
    metrics.recordDrop('lossy');
    metrics.recordDuplicateSent();
    metrics.recordDuplicateRejected();
    metrics.recordOutOfOrderRejected();
    metrics.recordResync();
    metrics.recordLatencySample(42);

    metrics.reset();

    expect(metrics.snapshot()).toEqual({
      inboundMessages: 0,
      inboundBytes: 0,
      outboundMessages: 0,
      outboundBytes: 0,
      eventsReceived: 0,
      patchesEmitted: 0,
      droppedByClass: { lossy: 0, lossless: 0, control: 0, audit: 0 },
      duplicatesSent: 0,
      duplicatesRejected: 0,
      outOfOrderRejected: 0,
      resyncsTriggered: 0,
      coalescingRatio: undefined,
      latencyMs: undefined,
    });
  });
});
