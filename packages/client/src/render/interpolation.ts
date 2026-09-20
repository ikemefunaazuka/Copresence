/**
 * Twenty updates a second rendered raw looks like a stuttering cursor;
 * this is what turns it into something that reads as continuous motion,
 * projecting forward from the latest known point using the velocity
 * implied by the point before it — the same technique multiplayer games
 * call dead reckoning. Deliberately not "wait and blend between two
 * points" (which would add a full tick of extra latency on top of the
 * server's own coalescing delay); low latency matters more here than
 * frame-perfect smoothness.
 */
export interface TimedPoint {
  readonly x: number;
  readonly y: number;
  /** Local clock time this position was received, not the server's `ts`. */
  readonly t: number;
}

/**
 * Total for any input, including a `now` before `latest.t` or a
 * zero-length previous→latest interval — both simply return `latest`
 * unprojected rather than dividing by zero or extrapolating backwards.
 * Projection is capped at exactly the previous interval's distance, so a
 * network stall does not send the cursor flying — it coasts once, then
 * holds at the last known point until staleness fades or removes it.
 */
export function interpolatedPosition(
  previous: TimedPoint | undefined,
  latest: TimedPoint,
  now: number,
): { readonly x: number; readonly y: number } {
  if (!previous) return { x: latest.x, y: latest.y };

  const interval = latest.t - previous.t;
  if (!Number.isFinite(interval) || interval <= 0) return { x: latest.x, y: latest.y };

  const elapsed = now - latest.t;
  const factor = Math.min(1, Math.max(0, elapsed / interval));

  return {
    x: latest.x + (latest.x - previous.x) * factor,
    y: latest.y + (latest.y - previous.y) * factor,
  };
}
