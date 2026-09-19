# 0001 — Record architecture decisions

## Status

Accepted

## Context

This repository makes a number of decisions that are expensive to reverse
once code is built on top of them — the wire protocol's message
classification, server-assigned ordering over client timestamps, an
in-memory session store instead of a database, a hard budget on the client
bundle. Each one has a real trade-off, and "why" tends to evaporate faster
than "what": six months on, the code still shows what was built, but not
what was rejected or why the obvious alternative lost.

A reviewer reading this repository — including, specifically, an engineer
evaluating it as evidence of judgement rather than of output — needs the
"why" as much as the "what."

## Decision

Record every decision that would be expensive to reverse as a short,
numbered Architecture Decision Record in `docs/adr/`, using this shape:

- **Status** — Accepted, Superseded, or Deprecated
- **Context** — the problem, stated plainly enough that the decision looks
  inevitable once you've read it
- **Decision** — what was chosen, in one or two sentences
- **Consequences** — what this makes easy, what it makes hard, and what it
  forecloses

One ADR per decision, one page each. An ADR is a record of a choice made,
not a design document — if it needs diagrams and multiple sections to make
its point, the decision was probably too large to be one ADR.

Numbered sequentially, never renumbered. A reversed decision gets a new ADR
that supersedes the old one; the old one's Status changes to `Superseded by
000X` and its content stays as written, because the history of having been
wrong is part of what makes this record worth reading.

## Consequences

Every phase that introduces an irreversible choice writes the ADR in the
same evening as the code, not retroactively — a decision written down after
the fact tends to be a justification rather than a record.

The cost is small and constant: a few extra minutes per decision. The
alternative — a reviewer, or a future me, reconstructing intent from git
blame and commit messages — costs more, later, and gets the reasoning wrong
more often than it gets it right.
