# lasuite-docs-mcp

An MCP server for a self-hosted [La Suite Docs](https://github.com/suitenumerique/docs)
instance. It lets an MCP client such as Claude Code search, browse, read,
create, and edit Docs documents, and @-mention a favorited document straight
into context.

## Instance requirements

The Docs instance must run with token authentication enabled for external
clients:

```
OIDC_RESOURCE_SERVER_ENABLED=True
OIDC_OP_URL=...
OIDC_OP_INTROSPECTION_ENDPOINT=...
OIDC_RS_CLIENT_ID=...
OIDC_RS_CLIENT_SECRET=...
OIDC_RS_AUDIENCE_CLAIM=...
OIDC_RS_ALLOWED_AUDIENCES=...
```

and an `EXTERNAL_API` allowlist covering what this server uses:

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

`favorite_list` and `duplicate` are always permitted by Docs and need no
entry. Ask the instance owner to set these values; `doctor` (below) tells
you exactly which actions are still missing once the server is running.

## Setup

Install the package:

```
npm install -g lasuite-docs-mcp
```

Set the three required environment variables:

```
export DOCS_URL=https://docs.example.org
export DOCS_OIDC_ISSUER=https://sso.example.org/realms/main
export DOCS_OIDC_CLIENT_ID=lasuite-docs-mcp
```

`DOCS_OIDC_SCOPE` (default `openid`) and `DOCS_PROFILE` (default `default`,
lets you keep more than one instance's credentials side by side) are
optional.

Log in once — this opens a browser for an OAuth authorization-code-with-PKCE
flow against your identity provider and stores the resulting tokens at
`~/.config/lasuite-docs-mcp/<profile>.json`, mode 0600:

```
lasuite-docs-mcp login
```

Then confirm the instance is configured correctly:

```
lasuite-docs-mcp doctor
```

`doctor` probes each action Docs might have disabled and, if anything is
blocked, prints the exact `EXTERNAL_API` JSON to set.

## Claude Code registration

```
claude mcp add lasuite-docs \
  -e DOCS_URL=https://docs.example.org \
  -e DOCS_OIDC_ISSUER=https://sso.example.org/realms/main \
  -e DOCS_OIDC_CLIENT_ID=lasuite-docs-mcp \
  -- lasuite-docs-mcp-server
```

The server itself (`lasuite-docs-mcp-server`) never performs the login flow —
it only reads the credentials `login` already stored. Run `login` from a
terminal first; a server launched by Claude Code cannot open a browser for
you.

## Tools

- **docs_search** — full-text search across the instance; returns id, title, path, and an excerpt.
- **docs_list** — browse by recency, favorites, or documents you created, without a search query.
- **docs_tree** — a document's ancestors and children, to orient in a wiki without reading content.
- **docs_read** — a document's content as markdown; large documents return a section outline instead of truncating.
- **docs_create** — create a document from markdown, optionally nested under a parent.
- **docs_edit** — replace, append, prepend, or edit one section of an existing document.

A favorited document is also available as an MCP resource
(`docs://document/<id>`), so it can be @-mentioned directly instead of
fetched through `docs_read`.

## Known limitations

- **An edit resets the document's Yjs history.** Docs stores a document as a
  Yjs CRDT state, and every write from this tool replaces that state in
  full, the same way a fresh document would be written. Collaborative undo
  across that edit is gone afterward — there is no way to step back through
  the edit itself, only through changes made after it. Upstream Docs' own
  markdown import does the same thing; this is not a shortcut this tool
  takes, it is how the endpoint works.
- **Editing is refused while someone has the document open in a browser.**
  Docs rejects a write while a collaborative session is active over the
  websocket, and this tool does not use the flag that would bypass that
  check, because bypassing it would silently overwrite whatever that person
  is typing. `docs_edit` fails immediately in that case rather than
  retrying or queuing.
- **A whole-document `replace` refuses to discard callouts, PDF blocks,
  upload loaders, or page breaks unless `confirmLossy` is set.** These
  block types have no markdown representation, so a `replace` built from
  markdown alone would drop them silently otherwise. `append`, `prepend`,
  and the section operations do not need this guard — they only touch the
  range you named.
- **Concurrent-modification detection is best-effort.** Before writing, the
  client re-reads the document's ETag immediately beforehand and compares
  it against the value read at the start of the edit. Docs' `PATCH
  /documents/{id}/content/` endpoint has no conditional-write support —
  there is no `If-Match` — so this is a manual before/after comparison, not
  an atomic check, and a narrow window remains where a concurrent write
  between the second read and the write itself can be lost. On an instance
  that strips ETags (for instance, behind a proxy that does not forward
  them), the check cannot run at all, and `docs_edit` says so plainly in
  its result when that happens.
- **BlockNote is pinned to `0.54.0` to match Docs `v5.6.1`.** Content
  conversion runs `@blocknote/server-util` locally against block specs
  vendored from that Docs release. Upgrading the target Docs instance to a
  version with a different block schema may require re-running `npm run
  vendor` and the contract test suite (`npm run test:contract`) before
  this tool can be trusted against it again.

## CLI reference

- `lasuite-docs-mcp login` — perform the OAuth login and store credentials.
- `lasuite-docs-mcp logout` — delete the stored credentials for the active profile.
- `lasuite-docs-mcp status` — show whether a profile is logged in and when its token expires.
- `lasuite-docs-mcp doctor` — probe the instance's `EXTERNAL_API` allowlist and print any fix needed.
