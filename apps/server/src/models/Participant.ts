import type { ParticipantId } from '@copresence/protocol';

import { EMPTY_PRESENCE } from './PresenceState.js';
import type { PresenceState } from './PresenceState.js';

export interface Participant {
  readonly pid: ParticipantId;
  readonly color: string;
  readonly presence: PresenceState;
  readonly lastSeenAt: number;
  readonly docWidth: number;
  readonly docHeight: number;
  readonly dpr: number;
}

// A small fixed, high-contrast palette rather than an arbitrary hash-to-hue
// — keeps every assigned colour readable against a light or dark page.
const PARTICIPANT_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#008080',
  '#e6a100',
  '#f032e6',
  '#469990',
  '#9a6324',
] as const;

/**
 * A deterministic colour for a participant id — same id, same colour,
 * every time, on every client, with no coordination required between them.
 */
export function colorForParticipant(pid: ParticipantId): string {
  let hash = 0;
  for (let index = 0; index < pid.length; index += 1) {
    hash = (hash * 31 + pid.charCodeAt(index)) | 0;
  }
  const paletteIndex = Math.abs(hash) % PARTICIPANT_COLORS.length;
  // paletteIndex is always in range by construction (modulo the array length).
  return PARTICIPANT_COLORS[paletteIndex] as string;
}

/**
 * `now` is always taken as a parameter, never read internally via
 * `Date.now()` — models/ stays pure and deterministic; the service layer
 * owns the real clock.
 */
export function createParticipant(pid: ParticipantId, now: number): Participant {
  return {
    pid,
    color: colorForParticipant(pid),
    presence: EMPTY_PRESENCE,
    lastSeenAt: now,
    docWidth: 0,
    docHeight: 0,
    dpr: 1,
  };
}

export function touchParticipant(participant: Participant, now: number): Participant {
  return { ...participant, lastSeenAt: now };
}

export function withViewport(
  participant: Participant,
  docWidth: number,
  docHeight: number,
  dpr: number,
): Participant {
  return { ...participant, docWidth, docHeight, dpr };
}
