<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

interface MetricsSnapshot {
  inboundMessages: number;
  inboundBytes: number;
  outboundMessages: number;
  outboundBytes: number;
  eventsReceived: number;
  patchesEmitted: number;
  droppedByClass: Record<string, number>;
  duplicatesSent: number;
  duplicatesRejected: number;
  outOfOrderRejected: number;
  resyncsTriggered: number;
  coalescingRatio: number | undefined;
  latencyMs: LatencyPercentiles | undefined;
}

interface ChaosState {
  enabled: boolean;
  config?: {
    dropRate: number;
    duplicateRate: number;
    latencyMs: number;
    jitterMs: number;
    reorderWindow: number;
  };
  partitioned?: boolean;
  partitionRemainingMs?: number;
}

interface ConvergenceSnapshot {
  hashes: Record<string, string>;
  converged: boolean;
}

type AuditSource = 'client' | 'socket' | 'inferred';

interface AuditReport {
  source: AuditSource;
  recordedAt: number;
}

interface AuditRecord {
  eventId: string;
  sid: string;
  pid: string;
  kind: string;
  source: AuditSource;
  recordedAt: number;
  detail?: Record<string, unknown>;
  reports: AuditReport[];
}

const POLL_INTERVAL_MS = 500;

const sid = ref(new URLSearchParams(location.search).get('sid') ?? '');
const metrics = ref<MetricsSnapshot | null>(null);
const previousMetrics = ref<{ snapshot: MetricsSnapshot; at: number } | null>(null);
const chaos = ref<ChaosState | null>(null);
const convergence = ref<ConvergenceSnapshot | null>(null);
const audit = ref<AuditRecord[] | null>(null);
const connectionError = ref(false);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** The set of distinct paths that reported this event — `reports` can hold more entries than this when the same path retried (e.g. a bfcache-duplicated beacon), which is why this is separate from `reports.length`. */
function distinctSources(record: AuditRecord): AuditSource[] {
  return [...new Set(record.reports.map((report) => report.source))];
}

const rates = computed(() => {
  if (!metrics.value || !previousMetrics.value) return null;
  const elapsedS = (Date.now() - previousMetrics.value.at) / 1000;
  if (elapsedS <= 0) return null;
  const prev = previousMetrics.value.snapshot;
  const cur = metrics.value;
  return {
    inboundMsgsPerS: (cur.inboundMessages - prev.inboundMessages) / elapsedS,
    inboundBytesPerS: (cur.inboundBytes - prev.inboundBytes) / elapsedS,
    outboundMsgsPerS: (cur.outboundMessages - prev.outboundMessages) / elapsedS,
    outboundBytesPerS: (cur.outboundBytes - prev.outboundBytes) / elapsedS,
  };
});

function formatRate(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n < 1024 ? `${n.toFixed(0)} B/s` : `${(n / 1024).toFixed(1)} KB/s`;
}

async function poll(): Promise<void> {
  try {
    const [metricsRes, chaosRes] = await Promise.all([fetch('/api/metrics'), fetch('/api/chaos')]);
    const metricsBody = (await metricsRes.json()) as { metrics: MetricsSnapshot | null };
    if (metrics.value) previousMetrics.value = { snapshot: metrics.value, at: lastPollAt };
    metrics.value = metricsBody.metrics;
    chaos.value = (await chaosRes.json()) as ChaosState;
    connectionError.value = false;

    if (sid.value.trim()) {
      const encodedSid = encodeURIComponent(sid.value.trim());
      const [convergenceRes, auditRes] = await Promise.all([
        fetch(`/api/sessions/${encodedSid}/convergence`),
        fetch(`/api/sessions/${encodedSid}/audit`),
      ]);
      convergence.value = (await convergenceRes.json()) as ConvergenceSnapshot;
      const auditBody = (await auditRes.json()) as { records: AuditRecord[] };
      audit.value = auditBody.records;
    } else {
      convergence.value = null;
      audit.value = null;
    }
  } catch {
    connectionError.value = true;
  } finally {
    lastPollAt = Date.now();
  }
}

let lastPollAt = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <main>
    <header>
      <h1>Session inspector</h1>
      <p class="sub">
        Live, read-only — chaos itself is controlled from
        <a href="/chaos">/chaos</a>. Polling every {{ POLL_INTERVAL_MS }}ms.
      </p>
      <p v-if="connectionError" class="error">Can't reach the API — is the server running?</p>
    </header>

    <section class="card">
      <h2>Throughput</h2>
      <div class="grid">
        <div class="stat">
          <span class="label">Inbound</span>
          <span class="value">{{ formatRate(rates?.inboundMsgsPerS) }} msg/s</span>
          <span class="sub-value">{{ formatBytes(rates?.inboundBytesPerS) }}</span>
        </div>
        <div class="stat">
          <span class="label">Outbound (delivered)</span>
          <span class="value">{{ formatRate(rates?.outboundMsgsPerS) }} msg/s</span>
          <span class="sub-value">{{ formatBytes(rates?.outboundBytesPerS) }}</span>
        </div>
        <div class="stat">
          <span class="label">Coalescing ratio</span>
          <span class="value">{{
            metrics?.coalescingRatio === undefined ? '—' : metrics.coalescingRatio.toFixed(1) + ':1'
          }}</span>
          <span class="sub-value">events received per patch emitted</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Delivery integrity</h2>
      <div class="grid">
        <div class="stat">
          <span class="label">Dropped (lossy)</span>
          <span class="value">{{ metrics?.droppedByClass?.['lossy'] ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="label">Dropped (lossless)</span>
          <span class="value">{{ metrics?.droppedByClass?.['lossless'] ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="label">Duplicates sent</span>
          <span class="value">{{ metrics?.duplicatesSent ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="label">Duplicates rejected</span>
          <span class="value">{{ metrics?.duplicatesRejected ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="label">Out-of-order rejected</span>
          <span class="value">{{ metrics?.outOfOrderRejected ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="label">Resyncs triggered</span>
          <span class="value">{{ metrics?.resyncsTriggered ?? 0 }}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Delivery latency (applied, post-chaos)</h2>
      <div v-if="metrics?.latencyMs" class="grid">
        <div class="stat">
          <span class="label">p50</span>
          <span class="value">{{ metrics.latencyMs.p50.toFixed(0) }} ms</span>
        </div>
        <div class="stat">
          <span class="label">p95</span>
          <span class="value">{{ metrics.latencyMs.p95.toFixed(0) }} ms</span>
        </div>
        <div class="stat">
          <span class="label">p99</span>
          <span class="value">{{ metrics.latencyMs.p99.toFixed(0) }} ms</span>
        </div>
      </div>
      <p v-else class="sub">No samples yet.</p>
    </section>

    <section class="card">
      <h2>Chaos (current config)</h2>
      <p v-if="!chaos?.enabled" class="sub">Not enabled on this server.</p>
      <template v-else>
        <div class="grid">
          <div class="stat">
            <span class="label">Drop rate</span>
            <span class="value">{{ ((chaos.config?.dropRate ?? 0) * 100).toFixed(0) }}%</span>
          </div>
          <div class="stat">
            <span class="label">Duplicate rate</span>
            <span class="value">{{ ((chaos.config?.duplicateRate ?? 0) * 100).toFixed(0) }}%</span>
          </div>
          <div class="stat">
            <span class="label">Latency ± jitter</span>
            <span class="value"
              >{{ chaos.config?.latencyMs ?? 0 }} ± {{ chaos.config?.jitterMs ?? 0 }} ms</span
            >
          </div>
          <div class="stat">
            <span class="label">Reorder window</span>
            <span class="value">{{ chaos.config?.reorderWindow ?? 0 }} msgs</span>
          </div>
        </div>
        <p v-if="chaos.partitioned" class="partition-banner">
          PARTITIONED — heals in {{ Math.ceil((chaos.partitionRemainingMs ?? 0) / 1000) }}s
        </p>
      </template>
    </section>

    <section class="card">
      <h2>Convergence</h2>
      <label class="sid-input">
        Session id
        <input
          v-model="sid"
          type="text"
          placeholder="paste a session id, e.g. from /s/&lt;sid&gt;"
        />
      </label>

      <p v-if="!sid.trim()" class="sub">Enter a session id above to watch it converge.</p>
      <template v-else-if="convergence">
        <p class="convergence-banner" :class="convergence.converged ? 'converged' : 'diverged'">
          {{ convergence.converged ? 'CONVERGED' : 'DIVERGED' }}
        </p>
        <table v-if="Object.keys(convergence.hashes).length > 0">
          <tbody>
            <tr v-for="(hash, pid) in convergence.hashes" :key="pid">
              <td>{{ pid }}</td>
              <td class="hash">{{ hash }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="sub">No participants tracked for this session yet.</p>
      </template>
    </section>

    <section class="card">
      <h2>Audit trail</h2>
      <p class="sub">
        Three independent paths report a session's lifecycle — <code>client</code> (a beacon or the
        live socket), <code>socket</code> (the server noticing its own connection close),
        <code>inferred</code> (the reconciliation sweep). This is the demo moment: for one
        <code>session.end</code>, which path arrived first, and whether more than one reported it.
      </p>

      <p v-if="!sid.trim()" class="sub">Enter a session id above to see its audit trail.</p>
      <template v-else-if="audit">
        <table v-if="audit.length > 0">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Participant</th>
              <th>First reported by</th>
              <th>All paths</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in [...audit].reverse()" :key="record.eventId">
              <td class="sub-value">{{ formatTime(record.recordedAt) }}</td>
              <td>{{ record.kind }}</td>
              <td class="mono">{{ record.pid }}</td>
              <td>
                <span class="source-badge" :class="`source-${record.source}`">{{
                  record.source
                }}</span>
              </td>
              <td>
                <span
                  v-for="path in distinctSources(record)"
                  :key="path"
                  class="source-badge"
                  :class="`source-${path}`"
                  >{{ path }}</span
                >
                <span
                  v-if="record.reports.length > distinctSources(record).length"
                  class="sub-value"
                >
                  ({{ record.reports.length }} reports total — a duplicate was reported and
                  rejected)
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="sub">No audit events recorded for this session yet.</p>
      </template>
    </section>
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
}
body {
  margin: 0;
  font:
    15px/1.5 system-ui,
    sans-serif;
  background: light-dark(#f7f7f8, #111);
  color: light-dark(#111, #eee);
}
main {
  max-width: 56rem;
  margin: 0 auto;
  padding: 1.5rem;
}
h1 {
  margin-bottom: 0.25rem;
}
.sub {
  opacity: 0.7;
  font-size: 13px;
}
.error {
  color: #c0392b;
}
.card {
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin: 1rem 0;
}
.card h2 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 0;
  opacity: 0.8;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 1rem;
}
.stat {
  display: flex;
  flex-direction: column;
}
.label {
  font-size: 12px;
  opacity: 0.65;
}
.value {
  font-size: 1.4rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.sub-value {
  font-size: 12px;
  opacity: 0.6;
}
.partition-banner {
  margin-top: 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: #c0392b;
  color: #fff;
  font-weight: 600;
  display: inline-block;
}
.sid-input {
  display: block;
  font-size: 13px;
  margin-bottom: 0.75rem;
}
.sid-input input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  padding: 0.4rem 0.6rem;
  margin-top: 0.25rem;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: transparent;
  color: inherit;
}
.convergence-banner {
  display: inline-block;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.convergence-banner.converged {
  background: #2e7d32;
  color: #fff;
}
.convergence-banner.diverged {
  background: #c0392b;
  color: #fff;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.75rem;
  font-size: 13px;
}
td {
  padding: 0.3rem 0;
  border-bottom: 1px solid rgba(127, 127, 127, 0.15);
}
td.hash {
  text-align: right;
  font-family: ui-monospace, monospace;
}
th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.6;
  padding: 0.3rem 0.5rem 0.3rem 0;
}
td {
  padding-right: 0.5rem;
}
.mono {
  font-family: ui-monospace, monospace;
}
.source-badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  margin-right: 0.3rem;
  color: #fff;
}
.source-badge.source-client {
  background: #2e7d32;
}
.source-badge.source-socket {
  background: #1565c0;
}
.source-badge.source-inferred {
  background: #6a1b9a;
}
</style>
