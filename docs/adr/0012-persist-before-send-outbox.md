# 0012 — Persist-before-send IndexedDB outbox, cleared only on acknowledgement

## Status

Accepted

## Context

Audit events are classified `audit` in ADR 0009 — they must arrive _eventually_, not necessarily immediately, and must survive things a live WebSocket connection cannot: the tab going offline, the process being killed, the page navigating away before a send completes. None of the existing transport machinery is built for that. `transport/connection.ts`'s outbound queue is in-memory and dies with the page. The live socket itself is exactly what may not exist at the moment an audit event needs to leave.

The two delivery paths available on the way out the door — `navigator.sendBeacon` and `fetch(..., { keepalive: true })` — are both fire-and-forget from the page's perspective by the time it's gone. Neither can be retried by code that no longer exists. Something has to durably remember "this event has not been confirmed yet" across a page load the JavaScript context does not survive, and IndexedDB is the only browser storage that survives a hard reload, let alone a crash.

## Decision

Every audit event is written to an IndexedDB-backed outbox (`packages/client/src/outbox/`) _before_ any attempt to send it — `add()` persists first, unconditionally, regardless of whether the live socket is open. An entry is removed only when the server has actually acknowledged it: an `audit.ack` over the live socket, or a `200` from `POST /audit/beacon`. A `sendBeacon` call returning `true` is not an acknowledgement — it only means the browser accepted the payload into its own outgoing queue, not that the server received it — so `beacon.ts`'s `sendBestEffort` deliberately never confirms an outbox entry itself; only `sendConfirmable`'s real `200` response, or the live socket's `audit.ack`, does.

On every page load, `flushPending()` replays whatever is still sitting in the outbox, oldest first, against the confirmable HTTP path — the same mechanism that recovers a crash or an OS kill also recovers a page that was simply offline when it tried to send. Two bounds keep this from becoming a liability of its own: `OUTBOX_TTL_MS` (24h) drops an entry nobody will ever plausibly want acknowledged that long after the fact, and `OUTBOX_MAX_ENTRIES` (200) caps total storage so a permanently failing endpoint degrades gracefully — oldest entries pruned first — instead of quietly filling the user's storage quota forever.

The storage layer itself is injected behind an `OutboxStorage` interface (`put`/`delete`/`getAll`) rather than reached for directly, matching every other real-browser dependency this SDK already injects (`Clock`, `createSocket`, raf functions) — `jsdom` does not implement IndexedDB, so the outbox's own logic is tested against an in-memory fake, and `createIndexedDbStorage()` is exercised only by the real browser build.

## Consequences

`bfcache` restore becomes a _documented, expected_ duplicate-delivery source rather than a bug to chase: the beacon fires on hide, the entry survives (not yet acknowledged), the page comes back and — on the next hide, or the next flush — fires again with the _same_ `eventId`. This is why `AuditLog.record` (ADR 0013) has to be idempotent on `eventId` in the first place, not an incidental nicety. The cost of that honesty is that "duplicate" is not a failure mode this system tries to eliminate at the source; it is a failure mode it tries to make cheap and correctly recognisable at the destination instead.
