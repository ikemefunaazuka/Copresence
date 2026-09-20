/**
 * Shared tuning constants, defined once so the client, the server and the
 * protocol package never restate (and silently drift from) each other's
 * defaults.
 */

/** Bumped whenever a breaking change lands in the wire format. */
export const PROTOCOL_VERSION = 1 as const;

/** Server broadcast tick rate, in Hz — see docs/adr/0003. */
export const TICK_RATE_HZ = 20;

/**
 * How long the server keeps re-confirming a session's last-known presence
 * state via redundant patch resends after it goes quiet (nothing newly
 * dirty). Patches carry absolute, last-writer-wins values and are
 * broadcast exactly once per dirty flush with no acknowledgement or
 * redelivery — so under any packet loss, the single final patch after
 * real movement stops could simply never arrive for someone, with nothing
 * afterward to self-correct it (nothing stays dirty once input has
 * stopped). Redundant resends for a short window close that gap cheaply,
 * without needing a full ack/retry mechanism.
 */
export const PATCH_SETTLE_WINDOW_MS = 750;

/** Silence before the heartbeat reaper drops a participant. */
export const PARTICIPANT_TTL_MS = 15_000;

/** Heartbeat ping interval and missed-pong threshold. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MAX_MISSED = 2;

/** A remote cursor with no update for this long fades (client render). */
export const CURSOR_STALE_MS = 2_000;
/** ...and is removed entirely after this long. */
export const CURSOR_REMOVE_MS = 10_000;

/** Cursor deltas under this many device-independent px are suppressed (client capture). */
export const CURSOR_DEAD_BAND_PX = 2;

/** Outbound socket buffer threshold above which lossy frames are dropped (client transport). */
export const BACKPRESSURE_BYTES = 64 * 1024;

/** Reconnect backoff cap — jittered, never exceeded (client transport). */
export const RECONNECT_MAX_BACKOFF_MS = 10_000;

/** Shared budget for sendBeacon / fetch(keepalive) audit flushes. */
export const AUDIT_BEACON_BUDGET_BYTES = 64 * 1024;

/**
 * Hard ceiling on one inbound WebSocket frame, enforced at the transport
 * level (`ws`'s `maxPayload`) so an oversized frame is rejected before it
 * is ever fully buffered — not after parsing it, which would already have
 * spent the memory this exists to protect. Generous for any legitimate
 * message this protocol defines, all of which are a handful of short
 * fields.
 */
export const MAX_INBOUND_MESSAGE_BYTES = 8 * 1024;

/** Injected client bundle budget, gzipped — see .size-limit.json and docs/adr/0010. */
export const CLIENT_BUNDLE_BUDGET_BYTES = 10 * 1024;
