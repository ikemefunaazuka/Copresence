# Contributing

This is a solo demonstration project attached to a job application, not
actively seeking outside contributions — but it is built the way a real
project should be, and the workflow below is real.

## Setup

```bash
git clone https://github.com/ikemefunaazuka/copresence.git
cd copresence
nvm use        # or install the Node version named in .nvmrc
npm install
npm run verify # lint + typecheck + test + build + bundle-size — must be green
```

To run the end-to-end suite, Playwright needs its browser binaries once:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

## Before committing

`npm run verify` must pass. It is the same gate CI runs, so a failure
locally is a failure in CI — there is no separate, looser local path.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body, if the summary needs it — the "why", not a restatement of the diff>
```

Types in use here: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.
Scope is usually the package or app touched (`protocol`, `client`, `server`,
`inspector`, `e2e`).

## Architecture decisions

A decision that would be expensive to reverse gets a short ADR in
`docs/adr/`, not just a paragraph in a commit message. See
`docs/adr/0001-record-architecture-decisions.md` for the format, and the
existing ADRs for the tone — one page, the decision and its trade-off, not a
design document.

## Code style

Enforced by `npm run lint` and `npm run format`, not by this document. If
the linter is quiet, the style is fine.
