/**
 * The one seam between "what time is it" and everything that needs to
 * know. Services (SessionRegistry's TTL reaper, the heartbeat, the tick
 * scheduler) take a `Clock` rather than calling `Date.now()` directly —
 * the same reasoning that keeps `models/` pure by taking `now` as a
 * parameter (MILESTONE Phase 1), one layer up: real time makes timing-
 * dependent behaviour slow and flaky to test, so tests inject a fake one
 * instead of racing real timers.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * A controllable clock for tests: `advance()` moves time forward without
 * waiting for it, and `now()` never drifts from what the test expects.
 */
export function createFakeClock(startAt = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startAt;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}
