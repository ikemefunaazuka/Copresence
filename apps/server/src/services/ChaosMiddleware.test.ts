import type { ParticipantId, PongMessage, SessionId } from '@copresence/protocol';
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createFakeClock } from '../lib/clock.js';

import { ChaosMiddleware, DEFAULT_CHAOS_CONFIG } from './ChaosMiddleware.js';

const pid = (raw: string): ParticipantId => raw as ParticipantId;

function pong(seq = 1): PongMessage {
  return { v: PROTOCOL_VERSION, t: 'pong', sid: 's1' as SessionId, seq, ts: 0, pingTs: 0 };
}

/** A queue of fixed values, consumed in order — deterministic in place of `Math.random`. */
function scriptedRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index] ?? values.at(-1) ?? 0;
    index += 1;
    return value;
  };
}

describe('ChaosMiddleware', () => {
  it('with all knobs at zero, sends exactly once and immediately', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });
    expect(sent).toBe(1);
  });

  it('getConfig starts at DEFAULT_CHAOS_CONFIG', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    expect(chaos.getConfig()).toEqual(DEFAULT_CHAOS_CONFIG);
  });

  it('configure clamps every knob to its documented range', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    const config = chaos.configure({
      dropRate: 99,
      duplicateRate: 99,
      latencyMs: 999_999,
      jitterMs: 999_999,
      reorderWindow: 999,
    });
    expect(config).toEqual({
      dropRate: 0.5,
      duplicateRate: 0.2,
      latencyMs: 2_000,
      jitterMs: 500,
      reorderWindow: 10,
    });
  });

  it('configure clamps a negative or non-finite value up to the floor of 0', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    const config = chaos.configure({ dropRate: -5, latencyMs: Number.NaN });
    expect(config.dropRate).toBe(0);
    expect(config.latencyMs).toBe(0);
  });

  it('configure only touches the fields given, leaving the rest as they were', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    chaos.configure({ dropRate: 0.3 });
    const config = chaos.configure({ latencyMs: 100 });
    expect(config).toEqual({ ...DEFAULT_CHAOS_CONFIG, dropRate: 0.3, latencyMs: 100 });
  });

  it('drops a message when the drop roll lands under dropRate, never calling rawSend', () => {
    const onDrop = vi.fn();
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0]), // 0 < any positive dropRate
      onDrop,
    });
    chaos.configure({ dropRate: 0.5 });

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(sent).toBe(0);
    expect(onDrop).toHaveBeenCalledWith(pid('p1'), expect.objectContaining({ t: 'pong' }));
  });

  it('does not drop when the roll lands at or above dropRate', () => {
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0.99]),
    });
    chaos.configure({ dropRate: 0.5 });

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(sent).toBe(1);
  });

  it('sends twice when the duplicate roll lands under duplicateRate', () => {
    const onDuplicate = vi.fn();
    // First roll (drop check) passes; second roll (duplicate check) triggers.
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0.99, 0]),
      onDuplicate,
    });
    chaos.configure({ duplicateRate: 0.2 });

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(sent).toBe(2);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('delays delivery by latencyMs, via the injected setTimeoutFn, and reports the real delivery time', () => {
    const clock = createFakeClock(1_000);
    const scheduled: { cb: () => void; ms: number }[] = [];
    const onDeliver = vi.fn();
    const chaos = new ChaosMiddleware({
      clock,
      random: scriptedRandom([0.99]), // never drop/duplicate
      setTimeoutFn: (cb, ms) => {
        scheduled.push({ cb, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      onDeliver,
    });
    chaos.configure({ latencyMs: 300 });

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(sent).toBe(0); // not yet — waiting on the scheduled delay
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(300);

    clock.advance(300);
    scheduled[0]!.cb();

    expect(sent).toBe(1);
    expect(onDeliver).toHaveBeenCalledWith(
      pid('p1'),
      expect.objectContaining({ t: 'pong' }),
      1_300,
    );
  });

  it('jitter can only ever widen or narrow the delay around latencyMs, never below 0', () => {
    let scheduledDelay: number | undefined;
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0.99, 0]), // no drop/dup; jitter roll of 0 -> minimum jitter (-jitterMs)
      setTimeoutFn: (cb, ms) => {
        scheduledDelay = ms;
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    chaos.configure({ latencyMs: 300, jitterMs: 200 }); // minimum jitter narrows it to 100, still positive

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(scheduledDelay).toBe(100);
    expect(sent).toBe(1);
  });

  it('when jitter clamps the delay all the way to 0, delivery is synchronous rather than a zero-delay timer', () => {
    let usedTimer = false;
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0.99, 0]), // no drop/dup; jitter roll of 0 -> minimum jitter (-jitterMs)
      setTimeoutFn: (cb, ms) => {
        usedTimer = true;
        cb();
        return ms as unknown as ReturnType<typeof setTimeout>;
      },
    });
    chaos.configure({ latencyMs: 100, jitterMs: 500 }); // 100 - 500 clamps to exactly 0

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(usedTimer).toBe(false);
    expect(sent).toBe(1);
  });

  it('a message sent during an active partition is dropped outright, ignoring dropRate entirely', () => {
    const onDrop = vi.fn();
    const clock = createFakeClock();
    const chaos = new ChaosMiddleware({ clock, random: scriptedRandom([0.99]), onDrop });
    chaos.startPartition(10_000);

    let sent = 0;
    chaos.send(pid('p1'), pong(), () => {
      sent += 1;
    });

    expect(sent).toBe(0);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('isPartitioned() clears itself once the clock passes the partition end', () => {
    const clock = createFakeClock();
    const chaos = new ChaosMiddleware({ clock });
    chaos.startPartition(1_000);

    expect(chaos.isPartitioned()).toBe(true);
    clock.advance(1_000);
    expect(chaos.isPartitioned()).toBe(false);
  });

  it('startPartition clamps duration to the documented 30s ceiling', () => {
    const clock = createFakeClock();
    const chaos = new ChaosMiddleware({ clock });
    const { endsAt } = chaos.startPartition(999_999);
    expect(endsAt).toBe(30_000);
  });

  it('partitionRemainingMs is 0 when not partitioned, and the remaining time otherwise', () => {
    const clock = createFakeClock();
    const chaos = new ChaosMiddleware({ clock });
    expect(chaos.partitionRemainingMs()).toBe(0);

    chaos.startPartition(5_000);
    clock.advance(2_000);
    expect(chaos.partitionRemainingMs()).toBe(3_000);
  });

  it('reorderWindow holds messages and releases one at random once the buffer overflows', () => {
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0]), // always pick index 0 of whatever the buffer holds
    });
    chaos.configure({ reorderWindow: 2 });

    const order: number[] = [];
    chaos.send(pid('p1'), pong(1), () => order.push(1));
    chaos.send(pid('p1'), pong(2), () => order.push(2));
    expect(order).toEqual([]); // buffer holds up to the window size before releasing anything

    chaos.send(pid('p1'), pong(3), () => order.push(3));
    expect(order).toEqual([1]); // buffer overflowed (3 items, window 2) — index 0 released
  });

  it('reorder buffers are independent per participant', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock(), random: scriptedRandom([0]) });
    chaos.configure({ reorderWindow: 1 });

    const orderA: number[] = [];
    const orderB: number[] = [];
    chaos.send(pid('a'), pong(1), () => orderA.push(1));
    chaos.send(pid('b'), pong(1), () => orderB.push(1));
    expect(orderA).toEqual([]);
    expect(orderB).toEqual([]);

    chaos.send(pid('a'), pong(2), () => orderA.push(2));
    expect(orderA).toEqual([1]); // a's buffer overflowed on its own second message
    expect(orderB).toEqual([]); // b's buffer is untouched by a's traffic
  });

  it('a buffered message that never gets naturally evicted is still released, via the fallback hold timer', () => {
    // Traffic stops after two messages with a window of 5 — the buffer
    // never overflows, so without a fallback these would be stuck forever.
    const scheduled: (() => void)[] = [];
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      setTimeoutFn: (cb) => {
        scheduled.push(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    chaos.configure({ reorderWindow: 5 });

    const order: number[] = [];
    chaos.send(pid('p1'), pong(1), () => order.push(1));
    chaos.send(pid('p1'), pong(2), () => order.push(2));
    expect(order).toEqual([]); // buffer never overflowed — nothing released yet

    for (const cb of scheduled) cb(); // the two fallback hold-timers firing

    expect(order.sort()).toEqual([1, 2]); // both eventually delivered regardless
  });

  it('the fallback hold timer is a no-op if the message was already released by a natural overflow', () => {
    const scheduled: (() => void)[] = [];
    const chaos = new ChaosMiddleware({
      clock: createFakeClock(),
      random: scriptedRandom([0]),
      setTimeoutFn: (cb) => {
        scheduled.push(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    chaos.configure({ reorderWindow: 1 });

    const order: number[] = [];
    chaos.send(pid('p1'), pong(1), () => order.push(1));
    chaos.send(pid('p1'), pong(2), () => order.push(2)); // overflow: releases message 1
    expect(order).toEqual([1]);

    expect(() => {
      for (const cb of scheduled) cb(); // message 1's fallback timer firing after it's already gone
    }).not.toThrow();
    expect(order).toEqual([1, 2]); // message 1 was not delivered a second time
  });

  it('flush() releases everything still buffered, in arrival order', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    chaos.configure({ reorderWindow: 5 });

    const order: number[] = [];
    chaos.send(pid('p1'), pong(1), () => order.push(1));
    chaos.send(pid('p1'), pong(2), () => order.push(2));
    expect(order).toEqual([]);

    chaos.flush();
    expect(order).toEqual([1, 2]);
  });

  it('flush(pid) only releases that one participant’s buffer', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    chaos.configure({ reorderWindow: 5 });

    const orderA: number[] = [];
    const orderB: number[] = [];
    chaos.send(pid('a'), pong(1), () => orderA.push(1));
    chaos.send(pid('b'), pong(1), () => orderB.push(1));

    chaos.flush(pid('a'));
    expect(orderA).toEqual([1]);
    expect(orderB).toEqual([]);
  });

  it('reset() clears config, partition state and anything buffered', () => {
    const chaos = new ChaosMiddleware({ clock: createFakeClock() });
    chaos.configure({ dropRate: 0.5, reorderWindow: 5 });
    chaos.startPartition(5_000);
    chaos.send(pid('p1'), pong(), () => undefined);

    chaos.reset();

    expect(chaos.getConfig()).toEqual(DEFAULT_CHAOS_CONFIG);
    expect(chaos.isPartitioned()).toBe(false);

    const order: number[] = [];
    chaos.flush(pid('p1'));
    expect(order).toEqual([]); // nothing left buffered to release
  });
});
