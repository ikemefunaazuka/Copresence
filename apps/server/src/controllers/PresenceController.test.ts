import { describe, expect, it } from 'vitest';

import type { ParticipantId, SessionId } from '@copresence/protocol';
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { createFakeClock } from '../lib/clock.js';
import { addParticipant } from '../models/Session.js';
import { AuditLog } from '../services/AuditLog.js';
import { BroadcastHub } from '../services/BroadcastHub.js';
import { SessionRegistry } from '../services/SessionRegistry.js';
import { handleCursor, handleScroll } from './PresenceController.js';
import type { ConnectionContext, ControllerDeps } from './types.js';
import { createConnectionContext } from './types.js';

const sid = (raw: string): SessionId => raw as SessionId;
const pid = (raw: string): ParticipantId => raw as ParticipantId;

function setUp(): { deps: ControllerDeps; ctx: ConnectionContext } {
  const clock = createFakeClock();
  const deps: ControllerDeps = {
    registry: new SessionRegistry(clock),
    hub: new BroadcastHub(),
    auditLog: new AuditLog(),
    clock,
  };
  const ctx = createConnectionContext({} as ConnectionContext['socket'], sid('s1'), 0);
  return { deps, ctx };
}

describe('handleCursor', () => {
  it('is a total no-op when the session does not exist yet', () => {
    const { deps, ctx } = setUp();
    expect(() =>
      handleCursor(ctx, { v: PROTOCOL_VERSION, t: 'cursor', sid: sid('s1'), pid: pid('p1'), seq: 1, ts: 0, x: 0.5, y: 1 }, deps),
    ).not.toThrow();
    expect(deps.registry.get(sid('s1'))).toBeUndefined();
  });

  it('updates presence when the session and participant exist', () => {
    const { deps, ctx } = setUp();
    deps.registry.save(addParticipant(deps.registry.getOrCreate(sid('s1')), pid('p1'), 0));

    handleCursor(ctx, { v: PROTOCOL_VERSION, t: 'cursor', sid: sid('s1'), pid: pid('p1'), seq: 1, ts: 0, x: 0.5, y: 1 }, deps);

    expect(deps.registry.get(sid('s1'))?.participants.get(pid('p1'))?.presence.cursor).toEqual({ x: 0.5, y: 1 });
  });
});

describe('handleScroll', () => {
  it('is a total no-op when the session does not exist yet', () => {
    const { deps, ctx } = setUp();
    expect(() =>
      handleScroll(
        ctx,
        { v: PROTOCOL_VERSION, t: 'scroll', sid: sid('s1'), pid: pid('p1'), seq: 1, ts: 0, scrollX: 0, scrollY: 1 },
        deps,
      ),
    ).not.toThrow();
    expect(deps.registry.get(sid('s1'))).toBeUndefined();
  });

  it('updates presence when the session and participant exist', () => {
    const { deps, ctx } = setUp();
    deps.registry.save(addParticipant(deps.registry.getOrCreate(sid('s1')), pid('p1'), 0));

    handleScroll(
      ctx,
      { v: PROTOCOL_VERSION, t: 'scroll', sid: sid('s1'), pid: pid('p1'), seq: 1, ts: 0, scrollX: 0, scrollY: 1 },
      deps,
    );

    expect(deps.registry.get(sid('s1'))?.participants.get(pid('p1'))?.presence.scroll).toEqual({ x: 0, y: 1 });
  });
});
