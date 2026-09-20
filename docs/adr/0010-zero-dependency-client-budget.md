# 0010 — Zero-dependency client, 10 KB gzipped budget enforced in CI

## Status

Accepted

## Context

This SDK is pasted into someone else's page as a single `<script>` tag, so its weight is a tax paid by every visitor of every host page it is injected into, on every load — unlike a normal app dependency that a build step can dedupe or code-split around. `@copresence/protocol` (the shared wire contract with the server, see ADR 0002) is real, necessary code this package needs; the decision is how it gets there without becoming a runtime dependency the budget cannot absorb.

## Decision

`@copresence/protocol` is declared as a `devDependency` of `packages/client`, not a `dependency` — there is no `dependencies` section in `packages/client/package.json` at all. `esbuild` (`build.mjs`) bundles the protocol package's source directly into the single IIFE output at build time, so at runtime there is no separate module to load and nothing on `npm ls --omit=dev` for this package. The 10 KB gzipped ceiling is enforced by `size-limit` (`.size-limit.json`, root `npm run size`), wired into `npm run verify` as a real build failure, not a warning that can be scrolled past.

That budget was blown by roughly 10x on the first real build — 464 KB minified, ~97 KB gzipped — and the cause was instructive enough to record here rather than just fix silently. `wire.ts` branded `sid`/`pid` by calling `SessionIdSchema.parse()` / `ParticipantIdSchema.parse()`, the same zod schemas `apps/server` uses to validate untrusted input off the wire. Zod's `.brand()` is a type-only marker with no runtime transformation — a branded schema's `.parse()` returns the exact string it was given — so this call bought nothing at runtime `wire.ts` could not get from a five-line hand-written length check, while pulling the entire zod v4 engine (including every locale's error-message strings, none of which this client ever surfaces) into the bundle. Fixed by replacing the schema call with a local `brand()` helper in `wire.ts` that does the same non-empty-string check and returns the value `as SessionId` — behaviorally identical, since branding was never more than a compile-time cast to begin with.

Removing that one call did not fix the bundle by itself. `@copresence/protocol`'s `dist/index.js` is a `tsc`-compiled barrel (`export * from './schemas.js'` among others), and the package had no `sideEffects` field. Without it, `esbuild` cannot prove that `schemas.js`'s top-level `z.object(...)`/`z.discriminatedUnion(...)` calls are side-effect-free, so — once any name from the barrel is imported anywhere in the client's module graph — it conservatively keeps every other top-level statement in every module the barrel re-exports, whether or not that statement's binding is ever used downstream. Adding `"sideEffects": false` to `packages/protocol/package.json` (true here: nothing in the package touches global state on import) let `esbuild` drop `schemas.js` entirely once nothing in the client referenced it anymore, and the build landed at 10,012 B raw / ~4 KB gzipped — well inside budget, with real headroom for what's still to come.

## Consequences

The client ships with genuinely zero runtime dependencies and comfortable headroom under the 10 KB gate, but the margin this phase actually needed came from a bundler-analysis fix (`sideEffects: false`), not from writing less code — meaning any future addition to `@copresence/protocol` that both the server and client import must be re-checked for the same failure mode: a schema or validator built eagerly at module scope, reachable through the barrel, with nothing downstream marking it prunable. The type-only imports this package relies on everywhere else (`import type { CursorMessage } from '@copresence/protocol'`) are unaffected by any of this — they are erased at compile time regardless of `sideEffects` — so the risk is specifically confined to _runtime_ imports of protocol values from client code, which after this fix is only ever plain constants and functions (`PROTOCOL_VERSION`, `classify`, `CURSOR_DEAD_BAND_PX`, and siblings), never a zod schema.
