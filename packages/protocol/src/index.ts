/**
 * @copresence/protocol
 *
 * The wire contract shared by the client and the server. Phase 0 exists only
 * to prove the package boundary — that both ends of the monorepo import from
 * here, and fail to compile together the moment this file changes.
 *
 * The real contract — message unions, zod schemas, the codec, and the
 * lossy/lossless/control/audit classification — lands in Phase 1.
 */

/** Bumped whenever a breaking change lands in the wire format. */
export const PROTOCOL_VERSION = 1 as const;
