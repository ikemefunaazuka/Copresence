import { SessionIdSchema } from '@copresence/protocol';
import type { Request, Response } from 'express';

import type { ConvergenceTracker } from '../services/ConvergenceTracker.js';
import type { MetricsCollector, MetricsSnapshot } from '../services/MetricsCollector.js';

function metricLines(name: string, help: string, type: 'counter' | 'gauge', value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`];
}

/** Plain Prometheus text exposition format (v0.0.4) — no client library needed for a handful of scalar metrics. */
function toPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [
    ...metricLines('copresence_inbound_messages_total', 'Inbound WebSocket messages received.', 'counter', snapshot.inboundMessages),
    ...metricLines('copresence_inbound_bytes_total', 'Inbound bytes received.', 'counter', snapshot.inboundBytes),
    ...metricLines('copresence_outbound_messages_total', 'Outbound messages actually delivered, post-chaos.', 'counter', snapshot.outboundMessages),
    ...metricLines('copresence_outbound_bytes_total', 'Outbound bytes actually delivered, post-chaos.', 'counter', snapshot.outboundBytes),
    ...metricLines('copresence_events_received_total', 'Inbound cursor/scroll events received.', 'counter', snapshot.eventsReceived),
    ...metricLines('copresence_patches_emitted_total', 'Coalesced patch broadcasts emitted.', 'counter', snapshot.patchesEmitted),
    ...metricLines('copresence_duplicates_sent_total', 'Outbound messages duplicated by chaos.', 'counter', snapshot.duplicatesSent),
    ...metricLines('copresence_duplicates_rejected_total', 'Inbound duplicate messages rejected.', 'counter', snapshot.duplicatesRejected),
    ...metricLines('copresence_out_of_order_rejected_total', 'Inbound out-of-order messages rejected.', 'counter', snapshot.outOfOrderRejected),
    ...metricLines('copresence_resyncs_triggered_total', 'Resyncs triggered by a repeat hello.', 'counter', snapshot.resyncsTriggered),
  ];

  lines.push('# HELP copresence_dropped_total Outbound messages dropped by chaos, by message class.');
  lines.push('# TYPE copresence_dropped_total counter');
  for (const [messageClass, count] of Object.entries(snapshot.droppedByClass)) {
    lines.push(`copresence_dropped_total{class="${messageClass}"} ${count}`);
  }

  if (snapshot.coalescingRatio !== undefined) {
    lines.push('# HELP copresence_coalescing_ratio Events received per patch emitted.');
    lines.push('# TYPE copresence_coalescing_ratio gauge');
    lines.push(`copresence_coalescing_ratio ${snapshot.coalescingRatio}`);
  }

  if (snapshot.latencyMs) {
    lines.push('# HELP copresence_delivery_latency_ms Applied send-to-delivery latency, post-chaos, in milliseconds.');
    lines.push('# TYPE copresence_delivery_latency_ms gauge');
    lines.push(`copresence_delivery_latency_ms{quantile="0.5"} ${snapshot.latencyMs.p50}`);
    lines.push(`copresence_delivery_latency_ms{quantile="0.95"} ${snapshot.latencyMs.p95}`);
    lines.push(`copresence_delivery_latency_ms{quantile="0.99"} ${snapshot.latencyMs.p99}`);
  }

  return `${lines.join('\n')}\n`;
}

export interface MetricsControllerDeps {
  readonly metrics: MetricsCollector | undefined;
  readonly convergenceTracker: ConvergenceTracker | undefined;
}

export function createMetricsController(deps: MetricsControllerDeps) {
  return {
    prometheus: (_req: Request, res: Response): void => {
      if (!deps.metrics) {
        res.status(503).type('text/plain').send('metrics not enabled\n');
        return;
      }
      res.status(200).type('text/plain; version=0.0.4').send(toPrometheusText(deps.metrics.snapshot()));
    },

    json: (_req: Request, res: Response): void => {
      res.status(200).json({ metrics: deps.metrics?.snapshot() ?? null });
    },

    convergence: (req: Request, res: Response): void => {
      const parsed = SessionIdSchema.safeParse(req.params['sid']);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid session id' });
        return;
      }
      if (!deps.convergenceTracker) {
        res.status(200).json({ hashes: {}, converged: true });
        return;
      }
      res.status(200).json(deps.convergenceTracker.snapshot(parsed.data));
    },
  };
}
