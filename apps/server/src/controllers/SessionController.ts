import { SessionIdSchema } from '@copresence/protocol';
import type { Request, Response } from 'express';

import { generateId } from '../lib/id.js';
import { toSessionDTO } from '../views/presenters.js';

import type { ControllerDeps } from './types.js';

/**
 * HTTP: create, join, inspect. "Join" and "inspect" are the same read —
 * a client about to open a WebSocket checks the session exists exactly
 * the way a human or a tool checking its state would. The shareable-link
 * UX around this comes later; this is the plain REST surface it will be
 * built on.
 */
export function createSessionController(deps: ControllerDeps) {
  return {
    create: (_req: Request, res: Response): void => {
      const sid = SessionIdSchema.parse(generateId());
      const session = deps.registry.getOrCreate(sid);
      res.status(201).json(toSessionDTO(session));
    },

    getBySessionId: (req: Request, res: Response): void => {
      const parsed = SessionIdSchema.safeParse(req.params['sid']);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid session id' });
        return;
      }

      const session = deps.registry.get(parsed.data);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }

      res.status(200).json(toSessionDTO(session));
    },
  };
}
