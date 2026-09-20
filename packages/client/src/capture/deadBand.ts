import { CURSOR_DEAD_BAND_PX } from '@copresence/protocol';

/**
 * Suppresses cursor deltas under the dead-band threshold — a position
 * that moved 0.3 viewport px is noise, not information, and sending it
 * anyway would spend part of the next tick's bandwidth on nothing.
 * Applied in raw viewport-pixel space, before normalisation to document
 * space (where `x` becomes a 0..1 fraction and "2px" stops meaning
 * anything).
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export function exceedsDeadBand(
  previous: Point | undefined,
  next: Point,
  thresholdPx: number = CURSOR_DEAD_BAND_PX,
): boolean {
  if (!previous) return true; // nothing sent yet — the first observation always emits
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  return Math.hypot(dx, dy) >= thresholdPx;
}
