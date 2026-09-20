/**
 * The reviewer-facing control surface for `ChaosMiddleware` — plain HTML
 * and vanilla JS polling/posting a small JSON API, matching demoPage.ts's
 * own style. No build step, no framework: this panel exists to prove the
 * failure handling is a switch someone can flip, not a claim in a README.
 */
export function renderChaosPanel(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copresence — chaos panel</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0 auto; padding: 1.5rem; max-width: 42rem; }
  h1 { margin-bottom: 0.25rem; }
  .sub { opacity: 0.7; margin-top: 0; }
  fieldset { border: 1px solid rgba(127,127,127,0.35); border-radius: 8px; margin: 1.5rem 0; padding: 1rem 1.25rem; }
  legend { padding: 0 0.4rem; font-weight: 600; }
  label { display: block; margin: 0.9rem 0 0.3rem; font-size: 14px; }
  .row { display: flex; align-items: center; gap: 0.75rem; }
  input[type="range"] { flex: 1; }
  .value { min-width: 5.5rem; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  button { font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4); background: transparent; cursor: pointer; }
  button.primary { background: #4363d8; color: #fff; border-color: #4363d8; }
  #partition-status { margin-top: 0.5rem; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 0.5rem; }
  td { padding: 0.2rem 0; }
  td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: rgba(127,127,127,0.15); padding: 0.1em 0.35em; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Chaos panel</h1>
  <p class="sub">Every knob here is global — one dial for the whole server, not per-session. Real networks do not respect message importance; this simulates exactly that.</p>

  <fieldset>
    <legend>Network conditions</legend>

    <label for="dropRate">Drop rate — <span id="dropRate-value" class="value">0%</span></label>
    <input type="range" id="dropRate" min="0" max="0.5" step="0.01" value="0">

    <label for="duplicateRate">Duplicate rate — <span id="duplicateRate-value" class="value">0%</span></label>
    <input type="range" id="duplicateRate" min="0" max="0.2" step="0.01" value="0">

    <label for="latencyMs">Latency — <span id="latencyMs-value" class="value">0 ms</span></label>
    <input type="range" id="latencyMs" min="0" max="2000" step="10" value="0">

    <label for="jitterMs">Jitter (±) — <span id="jitterMs-value" class="value">0 ms</span></label>
    <input type="range" id="jitterMs" min="0" max="500" step="10" value="0">

    <label for="reorderWindow">Reorder window — <span id="reorderWindow-value" class="value">0 msgs</span></label>
    <input type="range" id="reorderWindow" min="0" max="10" step="1" value="0">

    <div class="row" style="margin-top:1.25rem">
      <button id="reset" type="button">Reset to clean network</button>
    </div>
  </fieldset>

  <fieldset>
    <legend>Partition (total outage)</legend>
    <div class="row">
      <button id="partition-10" class="primary" type="button">Partition for 10s</button>
      <button id="partition-30" type="button">Partition for 30s</button>
    </div>
    <div id="partition-status">Not partitioned.</div>
  </fieldset>

  <fieldset>
    <legend>Live counters</legend>
    <table id="stats"></table>
    <p style="opacity:0.7; font-size:13px;">For live per-participant convergence hashes and the full dashboard, see the <a href="/inspector/">session inspector</a>. Raw counters also at <a href="/metrics">/metrics</a> (Prometheus) and <a href="/api/metrics">/api/metrics</a> (JSON).</p>
  </fieldset>

  <script>
  (function () {
    var knobs = ['dropRate', 'duplicateRate', 'latencyMs', 'jitterMs', 'reorderWindow'];
    var formatters = {
      dropRate: function (v) { return Math.round(v * 100) + '%'; },
      duplicateRate: function (v) { return Math.round(v * 100) + '%'; },
      latencyMs: function (v) { return Math.round(v) + ' ms'; },
      jitterMs: function (v) { return Math.round(v) + ' ms'; },
      reorderWindow: function (v) { return Math.round(v) + ' msgs'; }
    };
    var applying = false; // guards against a poll's response fighting an in-progress drag

    function applyConfigToInputs(config) {
      if (applying) return;
      knobs.forEach(function (k) {
        var input = document.getElementById(k);
        if (document.activeElement === input) return; // don't yank the slider out from under the user
        input.value = config[k];
        document.getElementById(k + '-value').textContent = formatters[k](config[k]);
      });
    }

    function patchConfig(partial) {
      applying = true;
      fetch('/api/chaos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial)
      })
        .then(function (r) { return r.json(); })
        .then(function () { applying = false; })
        .catch(function () { applying = false; });
    }

    knobs.forEach(function (k) {
      var input = document.getElementById(k);
      input.addEventListener('input', function () {
        document.getElementById(k + '-value').textContent = formatters[k](Number(input.value));
      });
      input.addEventListener('change', function () {
        var body = {};
        body[k] = Number(input.value);
        patchConfig(body);
      });
    });

    document.getElementById('reset').addEventListener('click', function () {
      fetch('/api/chaos/reset', { method: 'POST' });
    });
    document.getElementById('partition-10').addEventListener('click', function () {
      fetch('/api/chaos/partition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 10000 })
      });
    });
    document.getElementById('partition-30').addEventListener('click', function () {
      fetch('/api/chaos/partition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 30000 })
      });
    });

    var statNames = {
      inboundMessages: 'Inbound messages',
      outboundMessages: 'Outbound messages (delivered)',
      eventsReceived: 'Events received',
      patchesEmitted: 'Patches emitted',
      coalescingRatio: 'Coalescing ratio',
      duplicatesSent: 'Duplicates sent',
      duplicatesRejected: 'Duplicates rejected',
      outOfOrderRejected: 'Out-of-order rejected',
      resyncsTriggered: 'Resyncs triggered'
    };

    function renderStats(metrics) {
      var table = document.getElementById('stats');
      table.innerHTML = '';
      Object.keys(statNames).forEach(function (key) {
        var value = metrics[key];
        if (key === 'coalescingRatio') value = value === null || value === undefined ? '—' : value.toFixed(1) + ':1';
        var tr = document.createElement('tr');
        var td1 = document.createElement('td');
        td1.textContent = statNames[key];
        var td2 = document.createElement('td');
        td2.textContent = String(value);
        tr.append(td1, td2);
        table.appendChild(tr);
      });
      if (metrics.droppedByClass) {
        Object.keys(metrics.droppedByClass).forEach(function (cls) {
          var tr = document.createElement('tr');
          var td1 = document.createElement('td');
          td1.textContent = 'Dropped (' + cls + ')';
          var td2 = document.createElement('td');
          td2.textContent = String(metrics.droppedByClass[cls]);
          tr.append(td1, td2);
          table.appendChild(tr);
        });
      }
      if (metrics.latencyMs) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td');
        td1.textContent = 'Delivery latency p50 / p95 / p99';
        var td2 = document.createElement('td');
        td2.textContent = Math.round(metrics.latencyMs.p50) + ' / ' + Math.round(metrics.latencyMs.p95) + ' / ' + Math.round(metrics.latencyMs.p99) + ' ms';
        tr.append(td1, td2);
        table.appendChild(tr);
      }
    }

    function poll() {
      fetch('/api/chaos')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.enabled) {
            applyConfigToInputs(data.config);
            var status = document.getElementById('partition-status');
            status.textContent = data.partitioned
              ? 'PARTITIONED — heals in ' + Math.ceil(data.partitionRemainingMs / 1000) + 's'
              : 'Not partitioned.';
          }
        })
        .catch(function () {});

      fetch('/api/metrics')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.metrics) renderStats(data.metrics);
        })
        .catch(function () {});
    }

    poll();
    setInterval(poll, 500);
  })();
  </script>
</body>
</html>`;
}
