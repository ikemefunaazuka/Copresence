import type { Request, Response } from 'express';
import { z } from 'zod';

import type { ChaosMiddleware } from '../services/ChaosMiddleware.js';
import { renderChaosPanel } from '../views/chaosPanel.js';

/**
 * The HTTP-level ranges here are deliberately loose (just "a finite,
 * non-negative number") — `ChaosMiddleware.configure()` is the single
 * authority on the real ceilings (0.5 drop rate, 10s max partition, etc.),
 * so this schema does not restate them and risk drifting out of sync.
 */
const ChaosConfigPatchSchema = z
  .object({
    dropRate: z.number().finite().min(0).optional(),
    duplicateRate: z.number().finite().min(0).optional(),
    latencyMs: z.number().finite().min(0).optional(),
    jitterMs: z.number().finite().min(0).optional(),
    reorderWindow: z.number().finite().min(0).optional(),
  })
  .strict();

const PartitionRequestSchema = z
  .object({
    durationMs: z.number().finite().min(0).optional(),
  })
  .strict();

const DEFAULT_PARTITION_MS = 10_000;

/**
 * A single global dial for the whole server — see `ChaosMiddleware`'s own
 * doc comment for why this is not per-session. `chaos` is `undefined` only
 * if the composition root ever omits it (never in production; some tests
 * exercise the app without it), in which case every route here reports
 * chaos as disabled rather than pretending to control something that
 * does not exist.
 */
export function createChaosController(chaos: ChaosMiddleware | undefined) {
  return {
    panel: (_req: Request, res: Response): void => {
      res.status(200).type('html').send(renderChaosPanel());
    },

    getConfig: (_req: Request, res: Response): void => {
      if (!chaos) {
        res.status(200).json({ enabled: false });
        return;
      }
      res.status(200).json({
        enabled: true,
        config: chaos.getConfig(),
        partitioned: chaos.isPartitioned(),
        partitionRemainingMs: chaos.partitionRemainingMs(),
      });
    },

    updateConfig: (req: Request, res: Response): void => {
      if (!chaos) {
        res.status(503).json({ error: 'chaos middleware not enabled' });
        return;
      }
      const parsed = ChaosConfigPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid chaos config', issues: parsed.error.issues });
        return;
      }
      res.status(200).json({ config: chaos.configure(parsed.data) });
    },

    partition: (req: Request, res: Response): void => {
      if (!chaos) {
        res.status(503).json({ error: 'chaos middleware not enabled' });
        return;
      }
      const parsed = PartitionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid partition request', issues: parsed.error.issues });
        return;
      }
      res.status(200).json(chaos.startPartition(parsed.data.durationMs ?? DEFAULT_PARTITION_MS));
    },

    reset: (_req: Request, res: Response): void => {
      if (!chaos) {
        res.status(503).json({ error: 'chaos middleware not enabled' });
        return;
      }
      chaos.reset();
      res.status(200).json({ config: chaos.getConfig() });
    },
  };
}
