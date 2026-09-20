import type { CursorMessage, ScrollMessage } from '@copresence/protocol';

import { applyEvent } from '../models/applyEvent.js';

import type { ConnectionContext, ControllerDeps } from './types.js';

/**
 * Cursor and scroll ingest. Deliberately does nothing but fold the event
 * into `Session` via `applyEvent` and save — no broadcast happens here.
 * That is the entire point of coalescing (docs/adr/0003): the next tick
 * picks up whatever is dirty and sends one patch, however many `cursor`
 * messages arrived in between.
 */
export function handleCursor(
  ctx: ConnectionContext,
  msg: CursorMessage,
  deps: ControllerDeps,
): void {
  const session = deps.registry.get(ctx.sid);
  if (!session) return; // no session to update presence in — nothing to do
  const { state: next } = applyEvent(session, msg);
  deps.registry.save(next);
}

export function handleScroll(
  ctx: ConnectionContext,
  msg: ScrollMessage,
  deps: ControllerDeps,
): void {
  const session = deps.registry.get(ctx.sid);
  if (!session) return;
  const { state: next } = applyEvent(session, msg);
  deps.registry.save(next);
}
