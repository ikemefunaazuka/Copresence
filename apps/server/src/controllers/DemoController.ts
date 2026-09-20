import { SessionIdSchema } from '@copresence/protocol';
import type { Request, Response } from 'express';

import { generateId } from '../lib/id.js';
import { renderLandingPage, renderSessionPage } from '../views/demoPage.js';

import type { ControllerDeps } from './types.js';

/** Where `app.ts` serves the built client bundle from — see its static-asset wiring. */
const CLIENT_SCRIPT_SRC = '/static/copresence.js';

/**
 * The server-rendered demo: a landing page, a "mint a session and redirect
 * to it" convenience, and the co-browsing page itself. Deliberately thin —
 * `newSession` reuses the same `getOrCreate` the JSON API
 * (`SessionController.create`) uses, rather than duplicating session
 * creation, and `sessionPage` reads the existing session the same way
 * `SessionController.getBySessionId` does. This controller's only real job
 * is picking a view (HTML instead of JSON) for the same two operations.
 */
export function createDemoController(deps: ControllerDeps) {
  return {
    landing: (_req: Request, res: Response): void => {
      res.status(200).type('html').send(renderLandingPage());
    },

    /** Mints a fresh session and redirects to its page — the link a user then shares. */
    newSession: (_req: Request, res: Response): void => {
      const sid = SessionIdSchema.parse(generateId());
      deps.registry.getOrCreate(sid);
      res.redirect(303, `/s/${sid}`);
    },

    sessionPage: (req: Request, res: Response): void => {
      const parsed = SessionIdSchema.safeParse(req.params['sid']);
      if (!parsed.success) {
        res.status(400).type('html').send('<p>Invalid session id.</p>');
        return;
      }

      const session = deps.registry.get(parsed.data);
      if (!session) {
        res
          .status(404)
          .type('html')
          .send(
            '<p>Session not found — it may have expired. <a href="/s/new">Start a new one</a>.</p>',
          );
        return;
      }

      res
        .status(200)
        .type('html')
        .send(renderSessionPage({ sid: session.sid, clientScriptSrc: CLIENT_SCRIPT_SRC }));
    },
  };
}
