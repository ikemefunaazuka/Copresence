/**
 * Server-rendered HTML for the demo — a landing page that mints a session,
 * and the co-browsing page itself. Plain template strings, no templating
 * engine: two functions, both pure, both taking already-known data and
 * returning a string. No business logic and no I/O lives here, same rule
 * as `presenters.ts`, just targeting HTML instead of wire DTOs.
 */

/** The only untrusted-ish value ever interpolated into these pages is a session id — escaped anyway, on principle rather than because a UUID needs it. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SHARED_STYLES = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 0 1.5rem; max-width: 68ch; }
  h1, h2 { line-height: 1.25; }
  a { color: #4363d8; }
  code { background: rgba(127,127,127,0.15); padding: 0.15em 0.4em; border-radius: 4px; }
`;

export function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copresence — live demo</title>
<style>${SHARED_STYLES}</style>
</head>
<body>
  <h1>Copresence</h1>
  <p>A toy co-browsing core: two browsers sharing cursor position and scroll state over WebSockets, built to survive duplicate, late, out-of-order and missing messages.</p>
  <p><a href="/s/new" id="start">Start a new session →</a></p>
  <p>Open the link it gives you in a second tab (or send it to someone) to see two cursors on the same page.</p>
</body>
</html>`;
}

export interface SessionPageOptions {
  readonly sid: string;
  readonly clientScriptSrc: string;
}

export function renderSessionPage(options: SessionPageOptions): string {
  const sid = escapeHtml(options.sid);
  const clientScriptSrc = escapeHtml(options.clientScriptSrc);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copresence — session ${sid}</title>
<style>
  ${SHARED_STYLES}
  body { padding: 0 1.5rem 4rem 220px; }
  #panel {
    position: fixed; top: 0; left: 0; bottom: 0; width: 200px;
    padding: 1rem; box-sizing: border-box; overflow-y: auto;
    border-right: 1px solid rgba(127,127,127,0.3);
    font-size: 13px;
  }
  #panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; margin: 1.25rem 0 0.5rem; }
  #panel h2:first-child { margin-top: 0; }
  #link { width: 100%; box-sizing: border-box; font: inherit; font-size: 11px; padding: 0.3rem; }
  #participants { list-style: none; margin: 0; padding: 0; }
  #participants li { display: flex; align-items: center; gap: 0.4rem; padding: 0.25rem 0; cursor: pointer; border-radius: 4px; }
  #participants li:hover { background: rgba(127,127,127,0.12); }
  #participants li[data-following="true"] { font-weight: 600; }
  #participants .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  #latency, #status { font-variant-numeric: tabular-nums; }
  article h2 { margin-top: 2.5rem; }
</style>
</head>
<body data-sid="${sid}">
  <div id="panel">
    <h2>Share this session</h2>
    <input id="link" type="text" readonly>

    <h2>You</h2>
    <div id="self">pid <code id="self-pid"></code></div>
    <div>status: <span id="status">idle</span></div>
    <div>latency: <span id="latency">—</span></div>

    <h2>Participants</h2>
    <ul id="participants"></ul>
    <p style="opacity:0.7">Click a participant to follow their scroll. Click again to stop.</p>
  </div>

  <article>
    <h1>How Copresence stays in sync</h1>
    <p>Scroll this page in one tab, and — if another tab is following you — its viewport follows along. Move your mouse here, and every other participant sees a labeled cursor track it in real time. This article exists to give that scrolling something real to sync, rather than a blank page with a scrollbar.</p>

    <h2>The problem this project is actually about</h2>
    <p>Real-time session state over WebSockets is the same class of problem as webhook reconciliation: events you cannot trust to arrive once, in order, or at all — and state that has to converge anyway. Two browsers watching the same session do not share a clock, do not share a network path, and can each drop, duplicate or reorder what the other sends. The interesting engineering is not "send a message when the mouse moves." It is deciding, precisely, what happens when that message is late, or missing, or arrives twice.</p>

    <h2>Cursors are sent in document space, not pixels</h2>
    <p>Two browsers at different window sizes must place a shared cursor on the same paragraph, not the same pixel offset. So every cursor position that crosses the wire is normalised to <code>{ x: 0..1 of document width, y: absolute document px }</code> before it is sent, and converted back to viewport pixels only at the moment it is drawn. This is the single most-missed bug in naive cursor-sharing demos, and it gets its own architecture decision record.</p>

    <h2>The server does not forward messages as they arrive</h2>
    <p>A mouse can report position at up to 240 Hz on a fast, high-polling device. Forwarding every one of those events to every other participant would mean bandwidth that scales with how fast someone happens to be moving their mouse, not with anything the system controls. Instead, the server accumulates the newest value per participant per field and flushes on a fixed tick — by default twenty times a second — so outbound bandwidth is bounded by the tick rate alone, regardless of how many events arrived in between.</p>

    <h2>Sending less doesn't have to look worse</h2>
    <p>Twenty updates a second, drawn raw, looks visibly stepped. The client instead interpolates between the last two positions it received, extrapolating slightly ahead rather than buffering and lagging behind — dead reckoning, not a replay buffer. The two decisions have to be read together: coalescing on the server is only free of visible cost because interpolation exists on the client to smooth over the gaps it creates.</p>

    <h2>Ordering without a shared clock</h2>
    <p>Client clocks lie — they drift, they get adjusted, and two different machines' <code>Date.now()</code> values are not comparable. So nothing here trusts a client-supplied timestamp for ordering. Every message instead carries a server-assigned, per-participant monotonic sequence number, and a guard rejects anything at or below the last one accepted. That single primitive gives both idempotency (replaying the same event twice is a no-op) and out-of-order rejection, for free, from one comparison.</p>

    <h2>Silence is ambiguous, and the UI says so</h2>
    <p>A cursor that stops updating might mean a slow network, or it might mean the other person left. Rather than guessing, a cursor with no update for two seconds fades to reduced opacity, and is removed entirely after ten. The uncertainty is communicated, not resolved by lying in either direction.</p>

    <h2>What happens when you close this tab</h2>
    <p>Closing this tab (or losing the connection outright) is what "leave" actually means here — not a button, an event. The server notices the socket drop, tells everyone else, and a heartbeat reaper cleans up anything that vanished without even that: a frozen tab, a killed process, a laptop lid closed mid-session. The server never waits to be told a session ended, because a client that has vanished cannot tell it anything.</p>

    <h2>Reconnecting recovers full state</h2>
    <p>Lose the connection and get it back — a flaky network, a laptop waking from sleep — and this client re-announces itself the moment the socket reopens. The server answers with the full current roster, not a diff, so a client that missed an unknown number of updates while it was gone converges to the truth in one message rather than trying to reconstruct what it missed.</p>

    <h2>Small, deliberate motions don't cross the wire</h2>
    <p>A hand resting near a trackpad produces motion — a pixel or two of drift with no intent behind it. Every cursor sample is compared against the last one actually sent, and anything under a small fixed threshold is suppressed before it is ever queued for transport. It costs nothing to compute and it means the network never carries noise, only movement a person would recognise as movement.</p>

    <h2>Reconnecting doesn't happen all at once</h2>
    <p>If a server restarts, every connected client notices at roughly the same moment — and if each one reconnected immediately, the server would face the exact same herd of connections again, right as it finished recovering from the first one. So reconnection backs off exponentially with full jitter: each attempt waits a random interval up to a growing cap, not a fixed delay every client would compute identically. Jitter here is not polish; without it, the thundering herd is worse the second time.</p>

    <h2>A slow reader must not mean unbounded memory growth</h2>
    <p>Sooner or later, some connection falls behind — a slow network, a backgrounded tab, a browser under memory pressure. The socket's own outbound buffer is watched, and once it grows past a threshold, cursor and scroll updates for that connection are dropped outright rather than queued to wait. A participant behind a slow link sees a stuttering cursor. They do not become the reason the server itself runs out of memory.</p>

    <h2>The page you're on can't be trusted with its own styles</h2>
    <p>This whole SDK is designed to be dropped into a page whose CSS it does not control. Everything it renders lives inside a closed shadow root, so the host page's stylesheets cannot reach in and the SDK's own styles cannot leak out. The one element outside that boundary — the shadow host itself — sets its own position with <code>!important</code> on every declaration, specifically so a host page's own aggressive reset (even one that also uses <code>!important</code>) cannot silently break where the cursor layer renders.</p>

    <h2>The whole client fits in about four kilobytes, gzipped</h2>
    <p>Every visitor of every page this SDK is injected into downloads it, on every load — so its weight is a tax, not a one-time cost a build step can amortise away. The bundle ships with zero runtime dependencies: nothing it imports from the shared protocol package survives past build time, all of it inlined and dead-code-eliminated by the bundler rather than fetched separately. A ten-kilobyte gzipped ceiling is enforced as an actual build failure, not a number quoted in a README.</p>

    <p style="margin-top:3rem; opacity:0.7">You've reached the bottom. Scroll back up, or watch someone else's cursor find its way down here too.</p>
  </article>

  <script src="${clientScriptSrc}"></script>
  <script>
  (function () {
    var sid = document.body.dataset.sid;
    document.getElementById('link').value = location.href;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var wsUrl = proto + location.host + '/ws?sid=' + encodeURIComponent(sid);

    var participantsEl = document.getElementById('participants');
    var statusEl = document.getElementById('status');
    var latencyEl = document.getElementById('latency');
    var selfPidEl = document.getElementById('self-pid');
    var following = null;
    var lastParticipants = [];

    var instance = window.__copresence.init({
      wsUrl: wsUrl,
      sid: sid,
      onPresenceChange: function (participants) {
        lastParticipants = participants;
        renderParticipants();
      },
      onLatency: function (ms) { latencyEl.textContent = ms + ' ms'; },
      // Also fires on the local-intent break (a real scroll from this
      // tab's own user silently releases follow) — the list has to stay
      // accurate for that even though the roster itself did not change.
      onFollowChange: function (followingPid) {
        following = followingPid;
        renderParticipants();
      }
    });
    window.__copresenceInstance = instance;
    selfPidEl.textContent = instance.pid.slice(0, 8);

    function renderParticipants() {
      participantsEl.innerHTML = '';
      lastParticipants.forEach(function (p) {
        var li = document.createElement('li');
        li.dataset.pid = p.pid;
        li.dataset.following = String(p.pid === following);
        if (p.cursor) {
          li.dataset.x = String(p.cursor.x);
          li.dataset.y = String(p.cursor.y);
        }
        var dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = p.color;
        var label = document.createElement('span');
        label.textContent = p.pid.slice(0, 8);
        li.append(dot, label);
        li.addEventListener('click', function () {
          if (following === p.pid) {
            instance.stopFollowing();
          } else {
            instance.followParticipant(p.pid);
          }
        });
        participantsEl.appendChild(li);
      });
    }

    setInterval(function () {
      statusEl.textContent = instance.status();
    }, 500);

    instance.connect();
  })();
  </script>
</body>
</html>`;
}
