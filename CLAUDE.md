# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # tsc -p tsconfig.json -> dist/
npx tsc --noEmit           # typecheck only (CI runs this before tests)
npm test                   # vitest, excludes tests/contract/**
npx vitest run tests/edit/editDocument.test.ts   # a single file
npx vitest run -t 'refuses'                      # a single test by name
npm run check:drift        # vendored block specs vs pinned upstream (network)
npm run vendor             # re-fetch the block specs, then re-run check:drift
npm run test:contract      # live-instance suite, see below
```

CI runs `npm ci`, `npx tsc --noEmit`, `npm test`, `npm run check:drift`.

`npm run test:contract` talks to a real Docs instance, creates documents, and
never deletes them. It needs `DOCS_URL`, `DOCS_OIDC_ISSUER`,
`DOCS_OIDC_CLIENT_ID`, and a session from `lasuite-docs-mcp login`. Point it at
a scratch instance only. See `tests/contract/README.md`.

## Two entry points

`src/cli.ts` (`lasuite-docs-mcp`) handles `login`, `logout`, `status`, and
`doctor`. It may open a browser.

`src/index.ts` (`lasuite-docs-mcp-server`) is the stdio MCP server. It only
reads credentials that `login` already stored. It must never start an
interactive auth flow, because a server launched by an MCP client has no
terminal or browser to hand the user.

## Request path

`config` parses and validates the environment. `auth/client.ts` wraps `fetch`
with a bearer token, refreshing it from the stored refresh token when it is
within 30s of expiry, and bounds every request at 30s so a hung connection
cannot stall the process. `api/client.ts` adds retries and turns every HTTP
failure into a `DocsApiError` with a classified `kind`; only `server`,
`network`, and `throttled` retry, and only on GET. `server.ts` probes what the
instance permits, then registers the subset of tools that can actually work.

## Capability probing fails open, the edit path fails closed

`api/capabilities.ts` probes four actions at startup and disables a tool **only**
on a documented 403. Timeouts, 400s, 500s, and unrecognised exceptions all count
as "assume it works." A wrongly-enabled tool fails loudly and classifiably the
first time someone calls it; a wrongly-disabled tool is simply absent, with no
error and nothing to search for. Do not add a new condition that disables a tool
on anything other than a 403.

`edit/editDocument.ts` is the opposite. Every ambiguity refuses the write:
`canEdit` throwing (rather than returning false) propagates, an empty
formatted-content read that does not decode to zero blocks locally throws
`UnreadableDocumentError`, and a changed ETag throws `StaleDocumentError`. The
asymmetry is intentional: the cost of guessing wrong is losing someone's work.

## Documents are Yjs state, not markdown

A Docs document is a Yjs CRDT state. `content/convert.ts` is the only bridge:
markdown -> blocks -> Yjs base64 and back, all through the
`ServerBlockNoteEditor` in `content/editor.ts`.

Edits splice at the block level (`content/splice.ts`) and never round-trip a
whole document through markdown. Markdown cannot represent `callout`, `pdf`,
`uploadLoader`, or `pageBreak`, so a markdown round trip would silently destroy
them; `content/lossy.ts` detects them, recursing into children because a callout
nested in a list item is just as destructible as a top-level one. Only a
whole-document `replace` is blocked on this without `confirmLossy`. Section
operations name their own target, so a discard there is the caller's stated
intent.

Two further consequences worth knowing before changing this layer: every write
replaces the document's Yjs state in full, discarding collaborative undo
history, and staleness detection is a manual before/after ETag comparison
because `PATCH /documents/{id}/content/` supports no `If-Match`. `EditResult`
reports `staleCheckPerformed: false` rather than pretending the check ran when
the instance strips ETags.

## The vendored block specs are a pinned contract

`src/content/blockSpecs/` is copied from Docs `v5.6.1` by
`scripts/vendor-blockspecs.sh`, and `@blocknote/core` is pinned to `0.54.0` to
match. `scripts/check-drift.sh` re-downloads those files, re-applies the exact
same rewrites, and diffs. Any rewrite added to the vendor script must also be
added to the drift script in the same order, or a correctly vendored tree starts
reporting drift.

`blockSpecs/env.ts` is hand-written, not vendored. Both scripts target an
explicit file list rather than a `*.ts` glob specifically so they cannot
overwrite it.

Conversion failures surface through `edit/conversion.ts` as `ConversionError`,
which names the offending block type and points at `npm run vendor`. Raw
BlockNote failures (`Cannot read properties of undefined`) mean nothing to an
agent deciding what to do next, so new conversion call sites should wrap too.

## Conventions

Tools depend on `McpServerLike` (`src/tools/types.ts`) rather than the SDK's
`McpServer`, which keeps them constructible in tests without a real server.
Tests mock `fetch` and inject a `Delay` into `DocsClient` so retry behaviour is
asserted without sleeping.

Error messages are written for the agent that will read them: say what failed,
whether retrying helps, and which command fixes it.

Comments here carry the *why* behind a decision, especially the fail-closed
ones and the places where an obvious simpler approach was tried and rejected.
When changing such code, update the reasoning rather than deleting it.
