import type { ParticipantId, PatchMessage, SessionId } from '@copresence/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { createFakeClock } from '../lib/clock.js';
import { applyEvent } from '../models/applyEvent.js';
import { addParticipant } from '../models/Session.js';

import { BroadcastHub } from './BroadcastHub.js';
import { MetricsCollector } from './MetricsCollector.js';
import { SessionRegistry } from './SessionRegistry.js';
import { TickScheduler } from './TickScheduler.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function fakeSocket(): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  } as unknown as WebSocket;
  return { socket, sent };
}

function setUp() {
  const clock = createFakeClock(0);
  const registry = new SessionRegistry(clock);
  const hub = new BroadcastHub();
  const scheduler = new TickScheduler({ registry, hub, clock, tickRateHz: 20 });
  return { clock, registry, hub, scheduler };
}

describe('TickScheduler.tick', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts a patch only for a session with dirty presence state', () => {
    const { registry, hub, scheduler } = setUp();
    let session = addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0);
    session = addParticipant(session, pid('p2'), 0);
    registry.save(session);

    const p1 = fakeSocket();
    const p2 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });
    hub.register({ pid: pid('p2'), sid: sid('s1'), socket: p2.socket });

    // p1 moves, p2 does not.
    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );

    scheduler.tick();

    expect(p1.sent).toHaveLength(1);
    expect(p2.sent).toHaveLength(1); // p2 receives the patch too — it describes p1's movement
    const patch = JSON.parse(p1.sent[0]!) as PatchMessage;
    expect(patch.t).toBe('patch');
    expect(patch.patches).toEqual([{ pid: pid('p1'), x: 0.5, y: 100 }]);
  });

  it('sends nothing on a tick with no dirty state anywhere', () => {
    const { registry, hub, scheduler } = setUp();
    const session = addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0);
    registry.save(session);
    const p1 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });

    scheduler.tick();

    expect(p1.sent).toHaveLength(0);
  });

  it('clears dirty state after flushing, so a further tick never re-derives the same change from Session itself', () => {
    const { registry, hub, scheduler } = setUp();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));
    const p1 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });

    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );

    scheduler.tick();
    expect(registry.get(sid('s1'))!.dirty.size).toBe(0); // cleared — nothing left to re-derive a patch from
  });

  it('settles by re-confirming the last-known patch for a short window after a session goes quiet, then stops entirely', () => {
    const { registry, hub, scheduler, clock } = setUp();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));
    const p1 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });

    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );

    scheduler.tick(); // the real, dirty-triggered patch
    expect(p1.sent).toHaveLength(1);

    scheduler.tick(); // nothing newly dirty, but still within the settle window -> a redundant resend
    expect(p1.sent).toHaveLength(2);
    expect((JSON.parse(p1.sent[1]!) as PatchMessage).patches).toEqual([
      { pid: pid('p1'), x: 0.5, y: 100 },
    ]);

    clock.advance(10_000); // well past PATCH_SETTLE_WINDOW_MS
    scheduler.tick();
    expect(p1.sent).toHaveLength(2); // settle window elapsed — fully quiet now
  });

  it('a settle resend still carries a fresh, strictly-higher seq than the patch it repeats', () => {
    const { registry, hub, scheduler } = setUp();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));
    const p1 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });

    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );

    scheduler.tick();
    scheduler.tick();

    const [first, second] = p1.sent.map((raw) => JSON.parse(raw) as PatchMessage);
    expect(second!.seq).toBeGreaterThan(first!.seq);
  });

  it('advances the broadcast seq on every tick, even a no-op one', () => {
    const { registry, hub, scheduler } = setUp();
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));
    const p1 = fakeSocket();
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: p1.socket });

    scheduler.tick(); // no-op, seq -> 1 internally
    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );
    scheduler.tick(); // seq -> 2, this is the one that actually sends

    const patch = JSON.parse(p1.sent[0]!) as PatchMessage;
    expect(patch.seq).toBe(2);
  });

  it('records one patch-emitted metric per non-empty broadcast, and none for a no-op tick', () => {
    const { registry, hub, clock } = setUp();
    const metrics = new MetricsCollector();
    const scheduler = new TickScheduler({ registry, hub, clock, tickRateHz: 20, metrics });
    registry.save(addParticipant(registry.getOrCreate(sid('s1')), pid('p1'), 0));
    hub.register({ pid: pid('p1'), sid: sid('s1'), socket: fakeSocket().socket });

    scheduler.tick(); // nothing dirty
    expect(metrics.snapshot().patchesEmitted).toBe(0);

    registry.save(
      applyEvent(registry.get(sid('s1'))!, {
        v: 1,
        t: 'cursor',
        sid: sid('s1'),
        pid: pid('p1'),
        seq: 1,
        ts: 0,
        x: 0.5,
        y: 100,
      }).state,
    );
    scheduler.tick();

    expect(metrics.snapshot().patchesEmitted).toBe(1);
  });

  it('start/stop are idempotent and start does not fire synchronously', () => {
    vi.useFakeTimers();
    const { scheduler } = setUp();
    const tickSpy = vi.spyOn(scheduler, 'tick');

    scheduler.start();
    scheduler.start(); // second call should not double the interval
    expect(tickSpy).not.toHaveBeenCalled();
    expect(scheduler.isRunning()).toBe(true);

    vi.advanceTimersByTime(50); // one 20Hz interval (50ms)
    expect(tickSpy).toHaveBeenCalledTimes(1);

    scheduler.stop();
    scheduler.stop(); // idempotent
    expect(scheduler.isRunning()).toBe(false);

    vi.advanceTimersByTime(200);
    expect(tickSpy).toHaveBeenCalledTimes(1); // no further ticks after stop
  });
});
