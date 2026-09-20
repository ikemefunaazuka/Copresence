# 0002 — Shared `protocol` package as the single wire-format source of truth

## Status

Accepted

## Context

The client and the server each need to agree, precisely, on what a `cursor` message looks like, what fields a `hello` carries, and what a version mismatch means. The obvious path — define the shape once in the server's types and once in the client's, by hand, in two different files — works fine until one of them changes. Nothing forces the second file to change with it. The failure mode is not a compile error; it is two ends of a WebSocket connection silently disagreeing about a field's name or type, discovered at runtime, in whichever direction happens to be less observable.

## Decision

`packages/protocol` is the only place the wire format is defined. Both the client and the server depend on it as a real package; neither restates any part of the message shapes, the zod validators, or the encode/decode logic locally. Within the package itself, the zod schemas (`schemas.ts`) are the source of truth for every inbound message, and the TypeScript types (`messages.ts`) are derived from them via `z.infer` rather than hand-duplicated — the same reasoning one level down: a validator and a type that are allowed to drift from each other will, eventually, drift from each other.

## Consequences

A protocol change is now a type error on both sides simultaneously, not a runtime mystery on one side eventually. Adding a field, renaming one, or changing a type breaks the build for whichever consumer has not been updated, at the point of `npm run build`, not at the point some user's cursor stops moving.

The cost is a small one: the client and the server must both take a real dependency on this package, and anything that touches it (lint, typecheck, a fresh test run) must ensure the package is actually built first, since it is consumed through its compiled output like any other npm dependency, not through source directly. That ordering problem is exactly what the root `package.json`'s `pre<script>` npm hooks exist to solve, and is worth naming here because it is a direct, mechanical consequence of this decision, not an unrelated build quirk.
