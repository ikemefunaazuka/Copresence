import { classify } from '@copresence/protocol';
import type { InboundMessage } from '@copresence/protocol';

export interface OutboundQueue {
  enqueue(message: InboundMessage): void;
  /** Everything ready to send, in arrival order, clearing the queue. */
  drain(): readonly InboundMessage[];
  size(): number;
}

/**
 * The class-based drop policy applied to the client's own outbound
 * buffer (queued while a connection is not yet open, or while
 * backpressured): a lossy message replaces whatever was already queued
 * of the same type, in its original position, rather than being appended
 * again — only the newest `cursor` and the newest `scroll` are ever
 * worth sending. Lossless, control and audit messages are never
 * replaced or dropped; they queue in strict arrival order.
 */
export function createOutboundQueue(): OutboundQueue {
  const items: InboundMessage[] = [];
  const lossySlot = new Map<InboundMessage['t'], number>();

  function enqueue(message: InboundMessage): void {
    if (classify(message.t) !== 'lossy') {
      items.push(message);
      return;
    }
    const existingIndex = lossySlot.get(message.t);
    if (existingIndex !== undefined) {
      items[existingIndex] = message;
      return;
    }
    lossySlot.set(message.t, items.length);
    items.push(message);
  }

  function drain(): readonly InboundMessage[] {
    const drained = items.slice();
    items.length = 0;
    lossySlot.clear();
    return drained;
  }

  function size(): number {
    return items.length;
  }

  return { enqueue, drain, size };
}
