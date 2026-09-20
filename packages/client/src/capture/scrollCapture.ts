import { readScrollOffset } from './viewport.js';
import { createRafScheduler } from './rafScheduler.js';
import type { RafScheduler } from './rafScheduler.js';

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

export interface ScrollCaptureOptions {
  readonly onCapture: (scroll: ScrollPosition) => void;
  readonly target?: EventTarget;
  readonly win?: Window;
  readonly rafScheduler?: RafScheduler;
}

export interface ScrollCapture {
  start(): void;
  stop(): void;
}

/**
 * Passive, capture-phase, rAF-coalesced — the same reasoning as pointer
 * capture, one event type over: never block the host page's own scroll
 * handling, and never fire more than once per frame regardless of how
 * many `scroll` events the browser dispatches in between.
 */
export function createScrollCapture(options: ScrollCaptureOptions): ScrollCapture {
  const target = options.target ?? window;
  const win = options.win ?? window;
  const scheduler = options.rafScheduler ?? createRafScheduler();

  function flush(): void {
    options.onCapture(readScrollOffset(win));
  }

  function handleScroll(): void {
    scheduler.schedule(flush);
  }

  function start(): void {
    target.addEventListener('scroll', handleScroll, { passive: true, capture: true });
  }

  function stop(): void {
    target.removeEventListener('scroll', handleScroll, { capture: true });
    scheduler.cancel();
  }

  return { start, stop };
}
