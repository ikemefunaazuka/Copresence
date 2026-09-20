import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import type { ParticipantId, SessionId } from '@copresence/protocol';
import { createFakeClock } from '../lib/clock.js';
import { addParticipant } from '../models/Session.js';
import { AuditLog } from '../services/AuditLog.js';
import { BroadcastHub } from '../services/BroadcastHub.js';
import { SessionRegistry } from '../services/SessionRegistry.js';
import { createSessionController } from './SessionController.js';
import type { ControllerDeps } from './types.js';

/**
 * Direct unit tests for the branches real HTTP traffic cannot reach:
 * Express's own router guarantees a non-empty `:sid` path segment before
 * this controller ever sees it, so the "invalid id" 400 path is only
 * reachable by calling the handler directly with a malformed param.
 */
function fakeResponse(): { res: Response; status: () => number | undefined; body: () => unknown } {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => jsonBody };
}

function deps(): ControllerDeps {
  return {
    registry: new SessionRegistry(createFakeClock()),
    hub: new BroadcastHub(),
    auditLog: new AuditLog(),
    clock: createFakeClock(),
  };
}

describe('SessionController', () => {
  it('create returns 201 with a fresh session DTO', () => {
    const controllerDeps = deps();
    const controller = createSessionController(controllerDeps);
    const { res, status, body } = fakeResponse();

    controller.create({} as Request, res);

    expect(status()).toBe(201);
    expect((body() as { participantCount: number }).participantCount).toBe(0);
  });

  it('getBySessionId returns 400 for a param that fails validation', () => {
    const controller = createSessionController(deps());
    const { res, status } = fakeResponse();

    controller.getBySessionId({ params: { sid: '' } } as unknown as Request, res);

    expect(status()).toBe(400);
  });

  it('getBySessionId returns 404 for a well-formed but unknown id', () => {
    const controller = createSessionController(deps());
    const { res, status } = fakeResponse();

    controller.getBySessionId({ params: { sid: 'never-created' } } as unknown as Request, res);

    expect(status()).toBe(404);
  });

  it('getBySessionId returns 200 with the DTO for a known session', () => {
    const controllerDeps = deps();
    controllerDeps.registry.save(
      addParticipant(controllerDeps.registry.getOrCreate('s1' as SessionId), 'p1' as ParticipantId, 0),
    );
    const controller = createSessionController(controllerDeps);
    const { res, status, body } = fakeResponse();

    controller.getBySessionId({ params: { sid: 's1' } } as unknown as Request, res);

    expect(status()).toBe(200);
    expect((body() as { sid: string }).sid).toBe('s1');
  });
});
