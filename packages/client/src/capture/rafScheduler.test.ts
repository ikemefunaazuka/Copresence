// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { createRafScheduler } from './rafScheduler.js';

/** A manually-driven fake `requestAnimationFrame` — fires only when the test tells it to. */
function fakeFrameSource(): {
  requestFrame: (cb: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  fire: () => void;
  pendingCount: () => number;
} {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    requestFrame: (cb) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle) => {
      pending.delete(handle);
    },
    fire: () => {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb(0);
    },
    pendingCount: () => pending.size,
  };
}

describe('createRafScheduler', () => {
  it('does not invoke the callback before a frame fires', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const callback = vi.fn();

    scheduler.schedule(callback);

    expect(callback).not.toHaveBeenCalled();
  });

  it('invokes the callback once the frame fires', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const callback = vi.fn();

    scheduler.schedule(callback);
    frames.fire();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple schedule() calls within one frame into a single, latest callback', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule(first);
    scheduler.schedule(second); // replaces `first` — only one frame was ever requested
    expect(frames.pendingCount()).toBe(1);

    frames.fire();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('schedules a fresh frame after the previous one has fired', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const callback = vi.fn();

    scheduler.schedule(callback);
    frames.fire();
    scheduler.schedule(callback);
    frames.fire();

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('cancel() prevents a pending callback from firing', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const callback = vi.fn();

    scheduler.schedule(callback);
    scheduler.cancel();
    frames.fire();

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancel() with nothing scheduled is a no-op', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    expect(() => scheduler.cancel()).not.toThrow();
  });

  it('uses the real global requestAnimationFrame/cancelAnimationFrame by default', async () => {
    const scheduler = createRafScheduler();
    const callback = vi.fn();
    scheduler.schedule(callback);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
