import type {
  OutboundMessage,
  ParticipantId,
  ParticipantPatch,
  ParticipantSnapshot,
  SessionId,
} from '@copresence/protocol';

interface SimulatedParticipant {
  color: string;
  x?: number;
  y?: number;
  scrollX?: number;
  scrollY?: number;
}

interface ParticipantView {
  readonly participants: Map<ParticipantId, SimulatedParticipant>;
  lastPatchSeq: number;
}

export interface ConvergenceSnapshot {
  /** pid -> hash of that connection's simulated current view of the full roster. */
  readonly hashes: Readonly<Record<string, string>>;
  /** True when every reported hash agrees — trivially true with fewer than two participants. */
  readonly converged: boolean;
}

/**
 * Mirrors, per (session, participant), exactly what that connection would
 * have reconstructed from the outbound messages actually delivered to it
 * — same reconciliation `packages/client/src/index.ts` applies
 * (`welcome`/`snapshot` reseeds the roster, `join`/`leave`/`patch` update
 * it incrementally, and a `patch` at or below the last accepted seq is
 * ignored, exactly like the client's own seq guard). Not a client stand-in
 * exercised for its own sake — this is the actual mechanism behind the
 * "per-participant state-hash" the inspector shows live, and behind the
 * automated convergence test, without needing a real browser to report
 * anything back. It runs off `ChaosMiddleware`'s own `onDeliver` hook, so
 * a dropped message never reaches it — exactly like a real client, which
 * never sees what never arrived.
 *
 * Each pid's simulated view deliberately includes every participant's
 * state, itself included: the server never excludes the recipient from
 * its own `patch` broadcasts (see TickScheduler), so this is a like-for-
 * like comparison across participants — unlike the client's own `remotes`
 * map, which intentionally excludes self for rendering purposes only.
 */
export class ConvergenceTracker {
  #sessions = new Map<SessionId, Map<ParticipantId, ParticipantView>>();

  recordDelivery(sid: SessionId, pid: ParticipantId, message: OutboundMessage): void {
    const session = this.#sessions.get(sid) ?? new Map<ParticipantId, ParticipantView>();
    this.#sessions.set(sid, session);
    const entry = session.get(pid) ?? { participants: new Map(), lastPatchSeq: -Infinity };
    session.set(pid, entry);

    switch (message.t) {
      case 'welcome':
      case 'snapshot':
        entry.participants.clear();
        for (const snapshot of message.participants) upsert(entry.participants, snapshot);
        return;
      case 'join':
        upsert(entry.participants, message.participant);
        return;
      case 'leave':
        entry.participants.delete(message.pid);
        return;
      case 'patch':
        if (message.seq <= entry.lastPatchSeq) return; // mirrors the client's own reordering guard
        entry.lastPatchSeq = message.seq;
        for (const patch of message.patches) applyPatch(entry.participants, patch);
        return;
      case 'pong':
      case 'error':
        return; // neither carries roster state
    }
  }

  forget(sid: SessionId): void {
    this.#sessions.delete(sid);
  }

  snapshot(sid: SessionId): ConvergenceSnapshot {
    const session = this.#sessions.get(sid);
    if (!session || session.size === 0) return { hashes: {}, converged: true };

    const hashes: Record<string, string> = {};
    for (const [pid, entry] of session) hashes[pid] = hashOf(entry.participants);

    const distinctHashes = new Set(Object.values(hashes));
    return { hashes, converged: distinctHashes.size <= 1 };
  }
}

function upsert(
  participants: Map<ParticipantId, SimulatedParticipant>,
  snapshot: ParticipantSnapshot,
): void {
  const existing = participants.get(snapshot.pid) ?? { color: snapshot.color };
  existing.color = snapshot.color;
  if (snapshot.x !== undefined && snapshot.y !== undefined) {
    existing.x = snapshot.x;
    existing.y = snapshot.y;
  }
  if (snapshot.scrollX !== undefined && snapshot.scrollY !== undefined) {
    existing.scrollX = snapshot.scrollX;
    existing.scrollY = snapshot.scrollY;
  }
  participants.set(snapshot.pid, existing);
}

function applyPatch(
  participants: Map<ParticipantId, SimulatedParticipant>,
  patch: ParticipantPatch,
): void {
  const existing = participants.get(patch.pid) ?? { color: '#888888' };
  if (patch.x !== undefined && patch.y !== undefined) {
    existing.x = patch.x;
    existing.y = patch.y;
  }
  if (patch.scrollX !== undefined && patch.scrollY !== undefined) {
    existing.scrollX = patch.scrollX;
    existing.scrollY = patch.scrollY;
  }
  participants.set(patch.pid, existing);
}

/**
 * FNV-1a over a canonical, sorted representation — chosen purely for
 * "are these two views identical" comparison speed and simplicity, never
 * for anything security-sensitive (a collision here just means two
 * genuinely-different views look momentarily converged, which the next
 * patch tick would correct — no different from any other coalescing-ratio
 * false negative this design already accepts).
 */
function hashOf(participants: Map<ParticipantId, SimulatedParticipant>): string {
  const canonical = Array.from(participants.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([pid, p]) => `${pid}:${p.color}:${p.x ?? ''}:${p.y ?? ''}:${p.scrollX ?? ''}:${p.scrollY ?? ''}`,
    )
    .join('|');

  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
