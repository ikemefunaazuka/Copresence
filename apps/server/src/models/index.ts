/**
 * apps/server/src/models/
 *
 * Domain entities and the pure state reducer. Owns all convergence logic.
 * May import `@copresence/protocol` only — nothing from Node, nothing from
 * the browser (enforced by eslint.config.js's `no-restricted-imports` rule
 * for this directory). See MILESTONE §2.1.
 */

export * from './coordinates.js';
export * from './SequenceGuard.js';
export * from './PresenceState.js';
export * from './Participant.js';
export * from './Session.js';
export * from './applyEvent.js';
