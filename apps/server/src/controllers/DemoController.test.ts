import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../lib/clock.js';
import { AuditLog } from '../services/AuditLog.js';
import { BroadcastHub } from '../services/BroadcastHub.js';
import { SessionRegistry } from '../services/SessionRegistry.js';

import { createDemoController } from './DemoController.js';
import type { ControllerDeps } from './types.js';

/** Same direct-unit-test shape as SessionController.test.ts, extended with the response methods this controller also uses. */
function fakeResponse(): {
  res: Response;
  status: () => number | undefined;
  type: () => string | undefined;
  body: () => string | undefined;
  redirectedTo: () => { status: number; url: string } | undefined;
} {
  let statusCode: number | undefined;
  let contentType: string | undefined;
  let sentBody: string | undefined;
  let redirect: { status: number; url: string } | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    type(t: string) {
      contentType = t;
      return res;
    },
    send(body: string) {
      sentBody = body;
      return res;
    },
    redirect(code: number, url: string) {
      redirect = { status: code, url };
      return res;
    },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    type: () => contentType,
    body: () => sentBody,
    redirectedTo: () => redirect,
  };
}

function deps(): ControllerDeps {
  return {
    registry: new SessionRegistry(createFakeClock()),
    hub: new BroadcastHub(),
    auditLog: new AuditLog(),
    clock: createFakeClock(),
  };
}

describe('DemoController', () => {
  it('landing sends the landing page as HTML', () => {
    const controller = createDemoController(deps());
    const { res, status, type, body } = fakeResponse();

    controller.landing({} as Request, res);

    expect(status()).toBe(200);
    expect(type()).toBe('html');
    expect(body()).toContain('Start a new session');
  });

  it('newSession mints a session and redirects to its page', () => {
    const controllerDeps = deps();
    const controller = createDemoController(controllerDeps);
    const { res, redirectedTo } = fakeResponse();

    controller.newSession({} as Request, res);

    const redirect = redirectedTo();
    expect(redirect?.status).toBe(303);
    expect(redirect?.url).toMatch(/^\/s\/.+/);

    const sid = redirect?.url.replace('/s/', '');
    expect(controllerDeps.registry.get(sid as never)).toBeDefined();
  });

  it('sessionPage returns 400 for a param that fails validation', () => {
    const controller = createDemoController(deps());
    const { res, status } = fakeResponse();

    controller.sessionPage({ params: { sid: '' } } as unknown as Request, res);

    expect(status()).toBe(400);
  });

  it('sessionPage returns 404 for a well-formed but unknown session', () => {
    const controller = createDemoController(deps());
    const { res, status } = fakeResponse();

    controller.sessionPage({ params: { sid: 'never-created' } } as unknown as Request, res);

    expect(status()).toBe(404);
  });

  it('sessionPage returns 200 with HTML embedding the session id for a known session', () => {
    const controllerDeps = deps();
    controllerDeps.registry.getOrCreate('known-session' as never);
    const controller = createDemoController(controllerDeps);
    const { res, status, type, body } = fakeResponse();

    controller.sessionPage({ params: { sid: 'known-session' } } as unknown as Request, res);

    expect(status()).toBe(200);
    expect(type()).toBe('html');
    expect(body()).toContain('data-sid="known-session"');
    expect(body()).toContain('/static/copresence.js');
  });
});
