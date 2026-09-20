# 0003 — Server-side tick coalescing at 20 Hz instead of per-event forwarding

## Status

Accepted

## Context

`mousemove` fires up to ~240 Hz on a high-polling mouse. Forwarding every `cursor` message to every other participant the moment it arrives is the obvious implementation, and it makes outbound bandwidth a direct function of the sender's hardware and how fast they happen to be moving their hand — a quantity the server has no control over and that grows linearly with both participant count and input rate. Two participants moving continuously is already a lot of tiny frames; five is a different problem entirely.

## Decision

The server never forwards a `cursor`/`scroll` message as it arrives. `applyEvent` (Phase 1) folds it into `Session`'s per-field dirty state; `TickScheduler` (Phase 2) runs on a fixed 20 Hz timer, and on each tick builds one `patch` per session from whatever is currently dirty — the newest value only, one entry per participant who actually changed — then clears the dirty flags. A tick with nothing dirty costs nothing: `toPatch` returns `undefined` and is skipped.

## Consequences

Outbound bandwidth becomes `tickRate × participants`, full stop — independent of how fast anyone moves their mouse or how many raw events arrived between two ticks. A participant dragging at 240 Hz costs the same downstream as one moving occasionally.

The cost is a deliberate latency floor of up to one tick interval (50 ms at 20 Hz) between an event happening and it reaching anyone else. This is paid back, not just absorbed: Phase 3's client interpolates between the last two received positions on `requestAnimationFrame`, which is what turns 20 discrete updates a second into something that reads as continuous motion. The two decisions only make sense read together — coalescing buys the bandwidth, interpolation buys the smoothness back — and one without the other is a worse trade than either alone.

The other cost, found only once real tooling ran rather than anticipated up front: consuming this design correctly means `apps/server` depends on `@copresence/protocol`'s compiled output, not its source, so every script that touches either package needs that dependency built first on a cold checkout. See the `pre<script>` npm hooks in the root `package.json`, and the Phase 2 "Notes from the actual build."
