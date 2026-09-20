/**
 * Opt-in scroll-follow with a local-intent break: any real scroll input
 * from the local user releases follow immediately. Hijacking someone's
 * scroll and not letting go is the cardinal sin of co-browsing.
 *
 * Pure state machine, no DOM — the actual `window.scrollTo` call and the
 * real `scroll` event listener live in index.ts's wiring, which must
 * call {@link beginProgrammaticScroll}/{@link endProgrammaticScroll}
 * around its own follow-scroll so the `scroll` event that call itself
 * provokes is not mistaken for the user's own input.
 */
export interface ScrollFollow {
  enable(pid: string): void;
  disable(): void;
  /** With no argument: is *anyone* being followed. With one: is exactly this pid being followed. */
  isFollowing(pid?: string): boolean;
  /** Call on every real `scroll` event, local or programmatic — a no-op while a programmatic scroll is in flight. */
  notifyScrollEvent(): void;
  beginProgrammaticScroll(): void;
  endProgrammaticScroll(): void;
}

export function createScrollFollow(): ScrollFollow {
  let followingPid: string | undefined;
  let programmatic = false;

  return {
    enable(pid: string): void {
      followingPid = pid;
    },
    disable(): void {
      followingPid = undefined;
    },
    isFollowing(pid?: string): boolean {
      if (pid === undefined) return followingPid !== undefined;
      return followingPid === pid;
    },
    notifyScrollEvent(): void {
      if (programmatic) return; // this scroll was caused by us following someone — not local intent
      followingPid = undefined;
    },
    beginProgrammaticScroll(): void {
      programmatic = true;
    },
    endProgrammaticScroll(): void {
      programmatic = false;
    },
  };
}
