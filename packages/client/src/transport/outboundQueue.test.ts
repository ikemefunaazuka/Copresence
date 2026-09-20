import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { ByeMessage, CursorMessage, PingMessage } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import { createOutboundQueue } from './outboundQueue.js';

const BASE = { v: PROTOCOL_VERSION, sid: 's1', pid: 'p1' } as const;

function cursor(seq: number, x: number): CursorMessage {
  return { ...BASE, t: 'cursor', seq, ts: seq, x, y: 0 } as CursorMessage;
}
function ping(seq: number): PingMessage {
  return { ...BASE, t: 'ping', seq, ts: seq } as PingMessage;
}
function bye(seq: number): ByeMessage {
  return { ...BASE, t: 'bye', seq, ts: seq } as ByeMessage;
}

describe('createOutboundQueue', () => {
  it('starts empty', () => {
    const queue = createOutboundQueue();
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('a lossy message replaces a previously-queued one of the same type, in place', () => {
    const queue = createOutboundQueue();
    queue.enqueue(ping(1));
    queue.enqueue(cursor(2, 0.1));
    queue.enqueue(cursor(3, 0.9)); // replaces the previous cursor, does not append

    expect(queue.size()).toBe(2);
    const drained = queue.drain();
    expect(drained.map((m) => m.t)).toEqual(['ping', 'cursor']); // original relative order preserved
    expect((drained[1] as CursorMessage).x).toBe(0.9); // the newer value, not the older one
  });

  it('lossless/control messages are never replaced — every one is kept, in order', () => {
    const queue = createOutboundQueue();
    queue.enqueue(ping(1));
    queue.enqueue(ping(2));
    queue.enqueue(bye(3));

    const drained = queue.drain();
    expect(drained.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('drain() empties the queue', () => {
    const queue = createOutboundQueue();
    queue.enqueue(ping(1));
    queue.drain();
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('a lossy message enqueued after drain() starts a fresh slot rather than reusing a stale index', () => {
    const queue = createOutboundQueue();
    queue.enqueue(cursor(1, 0.1));
    queue.drain();
    queue.enqueue(ping(2));
    queue.enqueue(cursor(3, 0.5));

    const drained = queue.drain();
    expect(drained.map((m) => m.t)).toEqual(['ping', 'cursor']);
  });
});
