import { RECONNECT_MAX_BACKOFF_MS } from '@copresence/protocol';

const BASE_DELAY_MS = 250;

/**
 * Exponential backoff with *full* jitter, not proportional jitter: the
 * delay is a uniform random value in `[0, min(cap, base * 2^attempt))`,
 * not `base * 2^attempt` merely shrunk by a random factor. Full jitter is
 * what actually breaks a thundering herd — a server restart bringing
 * every client back at the same moment is a second outage worse than the
 * first, and that is exactly the failure mode jitter exists to prevent,
 * not just soften.
 */
export function backoffDelayMs(
  attempt: number,
  capMs: number = RECONNECT_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 0;
  const exponential = Math.min(capMs, BASE_DELAY_MS * 2 ** safeAttempt);
  return Math.floor(random() * exponential);
}
