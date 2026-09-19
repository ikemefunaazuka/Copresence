import type { ParticipantId } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import {
  colorForParticipant,
  createParticipant,
  touchParticipant,
  withViewport,
} from './Participant.js';

const pid = (raw: string): ParticipantId => raw as ParticipantId;

describe('colorForParticipant', () => {
  it('is deterministic — the same id always gets the same colour', () => {
    const id = pid('participant-42');
    expect(colorForParticipant(id)).toBe(colorForParticipant(id));
  });

  it('produces a hex colour string', () => {
    expect(colorForParticipant(pid('anyone'))).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('spreads different ids across more than one colour', () => {
    const colors = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((id) =>
        colorForParticipant(pid(id)),
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('createParticipant', () => {
  it('starts with empty presence and the given lastSeenAt', () => {
    const participant = createParticipant(pid('p1'), 1_000);
    expect(participant.presence).toEqual({});
    expect(participant.lastSeenAt).toBe(1_000);
    expect(participant.pid).toBe('p1');
  });

  it('assigns a colour deterministically derived from the pid', () => {
    const participant = createParticipant(pid('p1'), 0);
    expect(participant.color).toBe(colorForParticipant(pid('p1')));
  });
});

describe('touchParticipant', () => {
  it('updates lastSeenAt and nothing else', () => {
    const participant = createParticipant(pid('p1'), 0);
    const touched = touchParticipant(participant, 5_000);
    expect(touched.lastSeenAt).toBe(5_000);
    expect(touched.pid).toBe(participant.pid);
    expect(touched.color).toBe(participant.color);
    expect(touched.presence).toBe(participant.presence);
  });
});

describe('withViewport', () => {
  it('updates viewport metadata and nothing else', () => {
    const participant = createParticipant(pid('p1'), 0);
    const withVp = withViewport(participant, 1024, 4000, 2);
    expect(withVp.docWidth).toBe(1024);
    expect(withVp.docHeight).toBe(4000);
    expect(withVp.dpr).toBe(2);
    expect(withVp.lastSeenAt).toBe(participant.lastSeenAt);
  });
});
