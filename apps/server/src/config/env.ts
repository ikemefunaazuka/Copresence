import { z } from 'zod';

/**
 * Every variable the server reads, in one place, validated at boot.
 *
 * A misconfigured server must not start and serve wrong behaviour quietly
 * (MILESTONE Phase 0) — so this schema is the single source of truth for
 * what "valid configuration" means, and .env.example documents it for
 * humans. If a variable is read anywhere via `process.env` directly instead
 * of through `loadEnv()`, that is a bug.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().max(65_535).default(3000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  CORS_ORIGIN: z.string().min(1).default('*'),

  /** Silence before the heartbeat reaper drops a participant (Phase 2, 6). */
  PARTICIPANT_TTL_MS: z.coerce.number().int().positive().default(15_000),

  /** Server broadcast tick rate — see docs/adr/0003. */
  TICK_RATE_HZ: z.coerce.number().int().positive().max(60).default(20),

  /** Optional. Only read by the optional durable-event-log phase. Unset for v1. */
  MONGODB_URI: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses and validates `source` (defaulting to `process.env`) against the
 * schema above. Throws `EnvValidationError` — with every problem listed,
 * not just the first — rather than returning a partial or best-guess
 * config. The caller decides how to fail; this function never calls
 * `process.exit` itself, so it stays a plain, unit-testable function.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Every field in envSchema is a top-level key, so every issue's path
    // is guaranteed non-empty — no root-level fallback needed.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
