import { PROTOCOL_VERSION } from './constants.js';
import type { InboundMessage, OutboundMessage } from './messages.js';
import { InboundMessageSchema } from './schemas.js';

/**
 * Every way `decodeInbound` can fail, as data rather than a thrown
 * exception — the codec is "no input throws" total by construction, the
 * same guarantee `models/applyEvent.ts` relies on never surfacing an
 * exception it would have to catch.
 */
export type DecodeError =
  | { readonly kind: 'malformed-json'; readonly detail: string }
  | { readonly kind: 'validation-failed'; readonly issues: readonly string[] }
  | { readonly kind: 'version-mismatch'; readonly received: number; readonly expected: number };

export type DecodeResult =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly error: DecodeError };

/**
 * Parses and validates a raw inbound frame. Schema validation happens
 * before the version check, so a version mismatch on an otherwise
 * well-formed message is reported precisely rather than folded into a
 * generic validation failure — the "version negotiation" this file is
 * named for.
 */
export function decodeInbound(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'malformed-json',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const result = InboundMessageSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: 'validation-failed',
        issues: result.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      },
    };
  }

  const message = result.data;
  if (message.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: { kind: 'version-mismatch', received: message.v, expected: PROTOCOL_VERSION },
    };
  }

  return { ok: true, message };
}

/** Server-authored outbound messages are trusted by construction — no validation, just serialisation. */
export function encodeOutbound(message: OutboundMessage): string {
  return JSON.stringify(message);
}
