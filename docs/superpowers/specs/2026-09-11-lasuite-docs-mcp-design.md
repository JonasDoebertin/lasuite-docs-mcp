# LaSuite Docs MCP Server — Design

Date: 2026-09-11
Status: Approved, ready for implementation planning

## Context

[LaSuite Docs](https://github.com/suitenumerique/docs) is an open-source
collaborative editor built by DINUM on Django and React. Documents are stored as
Yjs CRDT state rather than text, and edited through BlockNote over a Hocuspocus
websocket server.

We want to use a self-hosted Docs instance from Claude Code: read and search
existing documents, author new ones, and edit documents that already exist. The
MCP server should also work against instances other than our own where the
instance permits it.

## Goals

- Search and browse an instance, and read documents as markdown
- Create new documents and sub-documents from markdown
- Edit existing documents without destroying content the editor can't express in
  markdown
- Run against any Docs instance the user can authenticate to, degrading to
  whatever that instance permits

## Non-goals

Deliberately excluded because they weren't asked for and each carries real
surface area: comments and threads, sharing and link configuration, invitations
and access management, version history and restore, the AI proxy endpoints, and
document moves.

## Research findings

These were read from upstream `main` rather than assumed, and they constrain
everything below.

### The API surface is rich

`core/api/viewsets.py::DocumentViewSet` exposes list/retrieve/create, a
`tree`/`children` hierarchy, `search`, `versions`, `trashbin`, `favorites`,
nested `accesses`/`invitations`/`threads`, and
`GET /documents/{id}/formatted-content/?content_format=(json|markdown|html)`.
That last one matters: documents can be read as markdown even though they are
stored as Yjs.

### Authentication is the binding constraint

`impress/settings.py` sets `DEFAULT_AUTHENTICATION_CLASSES` to
`SessionAuthentication` alone, so the main `/api/v1.0/` accepts browser cookies
and nothing else. The supported machine-to-machine path is the resource server
at `/external_api/v1.0/`, which takes OAuth2 bearer tokens validated by
introspection.

`DJANGO_SERVER_TO_SERVER_API_TOKENS` exists but only covers
`create-for-owner`, and authenticates no user, so it is not useful here.

### The resource server allowlist is more permissive than its documentation

`documentation/resource_server.md` lists a fixed set of available actions.
Reading `core/external_api/viewsets.py` and `core/external_api/permissions.py`
shows something more useful: `ResourceServerDocumentViewSet` inherits the full
`DocumentViewSet`, and `ResourceServerClientPermission` permits any action whose
name appears in `settings.EXTERNAL_API["documents"]["actions"]`. Undocumented
actions such as `search`, `formatted_content`, `content` and `tree` are
therefore reachable on an instance we configure.

The default allowlist is only `list`, `retrieve`, `create`, `children` plus
`users/get_me`, which is what portability has to degrade to.

### Conversion is a thin wrapper over a public library

`src/frontend/servers/y-provider/src/handlers/convertHandler.ts` is roughly 150
lines of `@blocknote/server-util`:

```ts
editor.tryParseMarkdownToBlocks(md)            // markdown -> blocks
editor.blocksToYDoc(blocks, 'document-store')  // blocks -> Y.Doc
Y.encodeStateAsUpdate(ydoc)                    // -> binary
editor.yDocToBlocks(ydoc, 'document-store')    // Yjs -> blocks
editor.blocksToMarkdownLossy(blocks)           // blocks -> markdown
```

The Yjs XML fragment key is `document-store`. The schema in
`y-provider/src/blockSpecs/index.ts` is BlockNote's defaults wrapped in
`withPageBreak`, plus four custom specs: `callout`, `pdf`, `uploadLoader`, and
the `interlinkingLinkInline` inline content. The file carries a comment warning
it must stay in sync with the frontend schema or Yjs documents lose nodes on
round trip.

### Writes are full-state, and guarded

`PATCH /documents/{id}/content/` writes the supplied base64 blob to S3 as the
document's entire state, so a complete state from a fresh `Y.Doc` is the correct
payload rather than an incremental update.

Two guards apply. `COLLABORATION_WS_NOT_CONNECTED_READ_ONLY` plus
`_can_user_edit_document` reject a PATCH while another party holds the document
open over the websocket. The serializer accepts a `websocket: true` flag that
bypasses this check. Separately, `content_retrieve` returns an S3 `ETag` header,
and the PATCH path calls `document.save()`.

Note that `_can_user_edit_document` keys off `request.session.session_key`, which
does not exist for token authentication. The no-websocket branch is therefore
less meaningful for our client than for the browser, which is part of why we
also carry our own concurrency guard.

## Architecture decision

**The MCP server converts content itself, using the same library upstream uses.**

It vendors the four Docs block specs, runs `@blocknote/server-util` in-process,
and authenticates with an OAuth2 bearer token against `/external_api/v1.0/`.
Reads prefer the instance's own `formatted-content` endpoint because that is
authoritative regardless of which BlockNote version we pin; local conversion is
the write path and the read fallback.

This is portable to any instance the user can log into and needs no privileged
shared secret.

### Alternatives rejected

**Delegate conversion to the instance's y-provider.** Calling
`POST {y-provider}/api/convert/` with `Y_PROVIDER_API_KEY` is less code and has
no drift risk, but it requires y-provider to be reachable from the client, places
an instance-wide privileged secret in MCP config, and can never work against an
instance we don't own. Rejected as the primary path; it remains a plausible
opt-in addition if drift proves painful.

**Join the collaboration websocket as a Yjs peer.** Editing through
`/collaboration/ws/` as a real Hocuspocus client is the only approach that is
genuinely correct under concurrent editing, and edits would appear live in open
browser tabs. It is also substantially more complex and stateful, and the
websocket auth path is cookie-oriented, which fights the token model. Recorded as
a future upgrade, not built now.

### Accepted risk

Pinning BlockNote means a Docs upgrade can change the block schema underneath us
and corrupt documents on write. This is the project's main risk and is addressed
by the contract test and drift canary described under Testing.

## Process model

One MCP server process serves one Docs instance, configured by environment.
Portability comes from configuration, not runtime multi-tenancy. Users needing
two instances register the server twice in Claude Code. An `instance` parameter
on every tool would tax every call for a case most users don't have.

## Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `config/` | Load and validate env plus profile file, via zod | — |
| `auth/` | PKCE login, token store, silent refresh, authenticated `fetch` | `config` |
| `api/` | Typed client, one method per Docs endpoint, capability probe | `auth` |
| `content/` | markdown / blocks / Yjs conversion, vendored Docs schema | — |
| `edit/` | Editing semantics: replace, append, prepend, section operations | `api`, `content` |
| `tools/` | MCP tool definitions; arg parse, call, format | `api`, `edit` |
| `server.ts` | MCP wiring, capability-gated tool registration | `tools` |
| `cli.ts` | `login`, `logout`, `status`, `doctor` | `auth`, `api` |

`content/` is dependency-free by design. It is the riskiest logic in the system
and pure functions make it the cheapest to test.

## Authentication and configuration

Authorization Code with PKCE against the instance's IdP, using a loopback
redirect.

The flow does not run inside the MCP server. A server launched by Claude Code
must not block on an interactive browser login, so `npx lasuite-docs-mcp login`
performs it once and writes tokens to
`~/.config/lasuite-docs-mcp/<profile>.json` at mode 0600. The server reads and
silently refreshes. With no valid token, every tool fails immediately with a
message naming the command to run.

The access token's audience must satisfy the instance's
`OIDC_RS_ALLOWED_AUDIENCES`.

### Instance configuration required

The instance owner needs:

```
OIDC_RESOURCE_SERVER_ENABLED=True
OIDC_OP_URL=...
OIDC_OP_INTROSPECTION_ENDPOINT=...
OIDC_RS_CLIENT_ID=...
OIDC_RS_CLIENT_SECRET=...
OIDC_RS_AUDIENCE_CLAIM=...
OIDC_RS_ALLOWED_AUDIENCES=...
```

and an `EXTERNAL_API` allowlist covering what the MCP uses:

```json
{
  "documents": {
    "enabled": true,
    "actions": [
      "list", "retrieve", "create", "children", "tree", "search",
      "content", "content_retrieve", "formatted_content", "can_edit"
    ]
  },
  "users": { "enabled": true, "actions": ["get_me"] }
}
```

`favorite_list` and `duplicate` are always permitted and need no entry.

`doctor` prints this block, pre-filled, based on what it probes.

## Tool surface

Six tools. Every tool description occupies the context window on every turn, so
the surface is task-shaped rather than endpoint-shaped.

### `docs_search`
Query in, ranked hits out: `id`, `title`, `path`, `updated_at`, and an excerpt
when the backend provides one. Backed by `/documents/search/`. On instances
without the Find indexer this becomes a title search, matching what the backend
already does by feature flag, so behaviour tracks the web UI.

### `docs_list`
Browsing rather than searching. Passes through `is_creator_me`, `is_favorite`,
`title`, `ordering`, `page_size`.

### `docs_tree`
Ancestors and children for one document, rendered as an indented outline. How
the agent orients itself in a wiki without reading anything.

### `docs_read`
Markdown for a document, via `formatted-content`. Optional `section` reads one
heading's subtree. Optional `max_chars`; past the limit it returns the heading
outline plus a notice naming the `section` values to request, rather than
truncating silently.

### `docs_create`
Parameters: `title`, `markdown`, optional `parent_id`. With `parent_id` the
document is nested under an existing one through the `children` endpoint;
without it, created at root.

### `docs_edit`
Parameters: `id`, `operation`, `markdown`, `section`, `confirm_lossy`.

`operation` is one of `replace`, `append`, `prepend`, `replace_section`,
`insert_after_section`. `section` is a heading anchor and is required for the two
section operations, rejected for the other three. `confirm_lossy` defaults to
false and is only consulted when the write would discard non-representable
blocks.

These operations share the read-modify-write cycle, the lock check, and the
conversion path. Splitting them into five tools would duplicate every hard part
while spending five times the context budget.

### Heading anchors

`docs_read` and `docs_edit` must agree on how to name a section, and that scheme
should be legible rather than clever. A heading is addressed by its exact text,
with a `#n` suffix only when the text repeats: `Setup`, `Setup#2`. No hidden
IDs, no state to keep in sync, and the agent can derive an anchor from content it
just read.

### Resources

Beyond tools, expose a `docs://document/{id}` resource template plus an
enumerated list of the user's favorites, so a document can be @-mentioned
directly into context instead of fetched by the agent.

## Content pipeline

### Read

Prefer `GET formatted-content?content_format=markdown`, which runs the
instance's own converter and is authoritative regardless of the BlockNote
version we pin. Fall back to `GET content/` then `Y.applyUpdate`,
`yDocToBlocks`, `blocksToMarkdownLossy` for instances that don't expose the
endpoint.

### Write

`markdown -> tryParseMarkdownToBlocks -> blocksToYDoc(blocks, 'document-store')
-> Y.encodeStateAsUpdate -> base64 -> PATCH content`. Always a complete state
from a fresh `Y.Doc`, matching what the backend stores and what upstream's
markdown import does.

### Editing happens in block space, not markdown space

This is the core of the design. The naive approach reads markdown, splices text,
and converts the whole document back. But `blocksToMarkdownLossy` is lossy by
name and by nature: callouts, PDF blocks, upload loaders, interlinking links,
page breaks, and text styling have no markdown representation. Round-tripping a
whole document through markdown to change one paragraph would quietly destroy
all of them.

Instead:

1. `GET formatted-content?content_format=json` for full-fidelity BlockNote JSON
2. Build a heading index over those blocks, giving each anchor a block range:
   the heading, plus following blocks until a heading of equal or higher level
3. Convert only the incoming markdown to blocks
4. Splice block ranges according to `operation`
5. `blocksToYDoc` over the spliced array, then PATCH

Content the user didn't touch never passes through markdown, so it survives
exactly. Only newly authored content goes through the markdown parser, which is
appropriate because it arrived as markdown.

### Lossiness is reported, never silent

Before writing, scan the blocks being discarded for non-representable types. A
section-scoped edit that drops a callout says so in its result. A whole-document
`replace` on a document containing such blocks refuses unless called with
`confirm_lossy: true`, because at that point the agent would be destroying
content it may never have seen.

### History is reset by an edit

Because we write a complete fresh state, an MCP edit discards the document's Yjs
history and collaborative undo across that edit is gone. Upstream's import path
behaves the same way. This belongs in the README rather than being discovered
later.

### Concurrency

Two guards.

`GET can-edit` before writing. If another party holds the document open, refuse
with an explanation rather than competing for it.

Optimistic concurrency on the ETag: capture it from `GET content/` during the
read phase, re-check immediately before the PATCH, abort if it moved.

We never send `websocket: true`. It would bypass the lock, and bypassing the lock
means overwriting someone's live editing session.

## Error handling

Error text is part of the API, because the agent reads failures and decides what
to do next.

- **401** — one silent refresh, then "run `npx lasuite-docs-mcp login`"
- **403** — the resource server returns this both for an action missing from
  `EXTERNAL_API` and for no permission on a document. Distinguish using what the
  startup probe learned; the configuration case names the env var to change
- **404** — state plainly that the document may not exist or may not be readable
  by this user, because Docs deliberately does not leak which
- **429** — respect `Retry-After`
- **Conversion failure** — report where it failed and write nothing

Retries are asymmetric. Idempotent GETs retry with jittered backoff. Writes
never retry automatically, because a PATCH that may have landed is not something
to guess about.

## Capability degradation

Read actions are probed cheaply at startup, and tools backed by disabled actions
are not registered, so the agent never spends a turn on a call that will 403.

Write actions cannot be probed without side effects, so they stay registered and
rely on precise 403 handling instead. This asymmetry is deliberate and stated
rather than papered over. `doctor` closes the gap by printing the exact
`EXTERNAL_API` JSON the instance needs.

## Testing

Red-green throughout, failing test first.

The bulk of the suite lands on `content/`, which is pure functions and therefore
cheap to test hard:

- Golden-file round trips (markdown -> blocks -> Yjs -> blocks -> markdown) with
  fixtures covering every custom block type, pinning lossiness behaviour instead
  of assuming it
- Block splicing, table-driven over nested heading levels, duplicate heading
  text, documents with no headings, edits at the first and last block, and the
  empty document

`api/` tests run against recorded HTTP fixtures, so CI needs no live instance.

`tools/` tests cover argument validation and the exact error text, since that
text is contractual.

**Contract suite (opt-in).** Runs against upstream's docker-compose Docs and
asserts that Yjs generated locally is accepted by the real backend and round
trips identically to the instance's own converter. Schema drift is the one
genuine risk in this architecture and this is the only thing that will catch it.
It belongs in scheduled CI and as a required check on any BlockNote version
bump.

**Drift canary.** A cheap test asserting our vendored block spec list still
matches upstream's, so a Docs upgrade fails loudly rather than corrupting a
document.

## Open risks

| Risk | Mitigation |
|---|---|
| BlockNote schema drift on Docs upgrade | Contract suite, drift canary, pinned versions |
| `can-edit` semantics differ for token auth (no session key) | Own ETag concurrency guard, never bypass the lock |
| Instance runs default `EXTERNAL_API` and blocks search/edit | Capability probe, tool gating, `doctor` output |
| `formatted-content` unavailable on some instance | Local conversion fallback on the read path |
