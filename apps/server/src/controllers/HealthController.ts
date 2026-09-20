import type { Request, Response } from 'express';

/**
 * `/healthz` — is the process alive at all. `/readyz` — is it ready to
 * take traffic. The two questions are different (a process can be alive
 * but still booting, or alive but shedding load) and orchestration
 * tooling (a load balancer, a container platform) generally asks them
 * separately, so this keeps them as two endpoints rather than one.
 */
export function createHealthController() {
  return {
    liveness: (_req: Request, res: Response): void => {
      res.status(200).json({ status: 'ok' });
    },

    readiness: (_req: Request, res: Response): void => {
      res.status(200).json({ status: 'ready' });
    },
  };
}
