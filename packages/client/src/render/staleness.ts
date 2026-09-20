import { CURSOR_REMOVE_MS, CURSOR_STALE_MS } from '@copresence/protocol';

/**
 * A dropped frame and a departed participant look identical from the
 * receiving end: nothing arriving. Rather than guess which one it is,
 * the render layer expresses the uncertainty honestly — a cursor fades
 * as it ages, and only disappears once the silence has gone on long
 * enough that continuing to show it would be actively misleading.
 */
export type Staleness = 'fresh' | 'stale' | 'expired';

export function stalenessOf(
  lastUpdateAt: number,
  now: number,
  staleAfterMs: number = CURSOR_STALE_MS,
  removeAfterMs: number = CURSOR_REMOVE_MS,
): Staleness {
  const age = now - lastUpdateAt;
  if (age >= removeAfterMs) return 'expired';
  if (age >= staleAfterMs) return 'stale';
  return 'fresh';
}

export function opacityFor(staleness: Staleness): number {
  return staleness === 'stale' ? 0.4 : 1;
}
