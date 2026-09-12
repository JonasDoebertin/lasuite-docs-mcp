# lasuite-docs-mcp

[![ci](https://github.com/JonasDoebertin/lasuite-docs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/JonasDoebertin/lasuite-docs-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

An MCP server for a self-hosted [La Suite Docs](https://github.com/suitenumerique/docs)
instance. It lets an MCP client such as Claude Code search, browse, read, create,
and edit Docs documents, and @-mention a favorited document straight into context.

> [!WARNING]
> **This is under active development and should be treated as experimental.**
> Things break, behaviour changes without notice, and parts of it may not work
> against your instance at all. It is not on npm yet, there is no release, and
> the API surface it depends on includes undocumented Docs endpoints that can
> change under it. Do not point it at documents you care about until you have
> tried it against a scratch instance.

## Tools

| Tool | What it does |
| --- | --- |
| `docs_search` | Full-text search across the instance. Returns id, title, and path. |
| `docs_list` | Browse by recency, favorites, or documents you created, without a search query. |
| `docs_tree` | A document's ancestors and children, to orient in a wiki without reading content. |
| `docs_create` | Create a document from markdown, optionally nested under a parent. |
| `docs_read` | A document's content as markdown. Large documents return a section outline instead of truncating. |
| `docs_edit` | Replace, append, prepend, or edit one section of an existing document. |

Favorited documents are also exposed as MCP resources (`docs://document/<id>`),
so they can be @-mentioned directly instead of fetched through `docs_read`.

## Instance requirements

The Docs instance must run with token authentication enabled for external
clients:

```ini
OIDC_RESOURCE_SERVER_ENABLED=True
OIDC_OP_URL=...
OIDC_OP_INTROSPECTION_ENDPOINT=...
OIDC_RS_CLIENT_ID=...
OIDC_RS_CLIENT_SECRET=...
OIDC_RS_AUDIENCE_CLAIM=...
OIDC_RS_ALLOWED_AUDIENCES=...
```

It also needs an `EXTERNAL_API` allowlist covering what this server uses:

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

`favorite_list` and `duplicate` are always permitted by Docs and need no entry.
Ask the instance owner to set these values. Once the server runs, `doctor`
tells you exactly which actions are still missing.

## Setup

### 1. Install

There is no npm release yet, so install from source:

```bash
git clone https://github.com/JonasDoebertin/lasuite-docs-mcp.git
cd lasuite-docs-mcp
npm ci
npm run build
npm link
```

Node 22 or newer is required.

### 2. Configure

Three environment variables are required:

```bash
export DOCS_URL=https://docs.example.org
export DOCS_OIDC_ISSUER=https://sso.example.org/realms/main
export DOCS_OIDC_CLIENT_ID=lasuite-docs-mcp
```

Two more are optional: `DOCS_OIDC_SCOPE` (default `openid`) and `DOCS_PROFILE`
(default `default`), which lets you keep more than one instance's credentials
side by side.

### 3. Log in

```bash
lasuite-docs-mcp login
```

This opens a browser for an OAuth authorization-code-with-PKCE flow against your
identity provider and stores the resulting tokens at
`~/.config/lasuite-docs-mcp/<profile>.json`, mode 0600.

### 4. Check the instance

```bash
lasuite-docs-mcp doctor
```

`doctor` probes each action Docs might have disabled and, if anything is
blocked, prints the exact `EXTERNAL_API` JSON to set.

## Connecting an MCP client

For Claude Code:

```bash
claude mcp add lasuite-docs \
  -e DOCS_URL=https://docs.example.org \
  -e DOCS_OIDC_ISSUER=https://sso.example.org/realms/main \
  -e DOCS_OIDC_CLIENT_ID=lasuite-docs-mcp \
  -- lasuite-docs-mcp-server
```

For any other client, run `lasuite-docs-mcp-server` over stdio with the same
environment.

> [!IMPORTANT]
> The server binary never performs the login flow. It only reads the credentials
> that `login` already stored. Run `login` from a terminal first, because a
> server launched by an MCP client cannot open a browser for you.

## CLI reference

| Command | What it does |
| --- | --- |
| `lasuite-docs-mcp login` | Perform the OAuth login and store credentials. |
| `lasuite-docs-mcp logout` | Delete the stored credentials for the active profile. |
| `lasuite-docs-mcp status` | Show whether a profile is logged in and when its token expires. |
| `lasuite-docs-mcp doctor` | Probe the instance's `EXTERNAL_API` allowlist and print any fix needed. |
| `lasuite-docs-mcp-server` | The MCP server itself, over stdio. |

## Known limitations

These are design constraints rather than bugs. Most of them come from what the
Docs API does and does not offer.

### An edit resets the document's Yjs history

Docs stores a document as a Yjs CRDT state, and every write from this tool
replaces that state in full, the same way a fresh document would be written.
Collaborative undo across that edit is gone afterwards. You can still step back
through changes made after the edit, but not through the edit itself. Upstream
Docs' own markdown import behaves identically, so this is not a shortcut this
tool takes. It is how the endpoint works.

### Editing is refused while someone has the document open

Docs rejects a write while a collaborative session is active over the websocket,
and this tool does not use the flag that would bypass that check, because
bypassing it would silently overwrite whatever that person is typing.
`docs_edit` fails immediately in that case rather than retrying or queuing.

### A whole-document `replace` refuses to discard unrepresentable blocks

Callouts, PDF blocks, upload loaders, and page breaks have no markdown
representation, so a `replace` built from markdown alone would drop them
silently. The tool refuses unless `confirmLossy` is set. `append`, `prepend`,
and the section operations need no such guard, since they only touch the range
you named.

### Concurrent-modification detection is best effort

Before writing, the client re-reads the document's ETag and compares it against
the value read at the start of the edit. Docs' `PATCH /documents/{id}/content/`
endpoint has no conditional-write support, so there is no `If-Match` and this is
a manual before-and-after comparison rather than an atomic check. A narrow
window remains where a concurrent write landing between the second read and the
write itself can be lost. On an instance that strips ETags, such as one sitting
behind a proxy that does not forward them, the check cannot run at all, and
`docs_edit` says so plainly in its result.

### BlockNote is pinned to `0.54.0` to match Docs `v5.6.1`

Content conversion runs `@blocknote/server-util` locally against block specs
vendored from that Docs release. Upgrading the target instance to a version with
a different block schema may require re-running `npm run vendor` and the
contract suite before this tool can be trusted against it again.

### Only the first 50 favorites become resources

If your account has more than 50 favorited documents, the rest are not
registered as `docs://document/<id>` resources and will not appear in
@-mention. Docs' `favorite_list` endpoint takes no ordering parameter, so which
50 you get is whatever order the API happens to return, not "most recent" or
anything else guaranteed. Documents past the cap remain reachable through
`docs_list` and `docs_read`. When the cap is hit, the server writes a
truncation notice to stderr; it does not appear anywhere in the MCP protocol
responses.

## Development

```bash
npm test                  # unit tests
npx tsc --noEmit          # typecheck
npm run check:drift       # vendored block specs vs pinned upstream
npm run test:contract     # live-instance suite, see tests/contract/README.md
```

The contract suite talks to a real Docs instance, creates documents, and never
deletes them. Point it at a scratch instance only.

See [CLAUDE.md](CLAUDE.md) for the architecture and the invariants worth knowing
before changing the edit or conversion paths.

## License

MIT
