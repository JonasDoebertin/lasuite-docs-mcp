# Contract suite

These tests run against a live Docs instance. They are excluded from `npm test`
and only run via `npm run test:contract`.

## What they need

- A reachable Docs instance with the full `EXTERNAL_API` allowlist from the
  README, and `OIDC_RESOURCE_SERVER_ENABLED=True`
- A stored session: run `npx lasuite-docs-mcp login` first
- `DOCS_URL`, `DOCS_OIDC_ISSUER`, and `DOCS_OIDC_CLIENT_ID` in the environment

## What they do to it

They create real documents and leave them in place. Point this at a scratch
instance, not anything holding content worth keeping.

There is deliberately no cleanup step. The Docs `EXTERNAL_API` surface this
client uses has no delete endpoint, so there is nothing to call; adding one
purely to tear down test fixtures would grow the production API surface for
a testing concern. A best-effort cleanup that could itself fail partway
(deleting some but not all of a run's documents) would also leave the
instance in a less predictable state than simply always leaving every
created document behind. Do not point this suite at an instance you care
about the contents of.

## When they fail

A failure means the vendored BlockNote schema and the instance disagree. Check
whether the instance's Docs version still matches the ref pinned in
`scripts/vendor-blockspecs.sh`, re-run `npm run vendor`, and re-run
`npm run check:drift`.
