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
> it depends on Docs API actions that are undocumented upstream and can change
> under it. Do not point it at documents you care about before working through
> [Before you point it at real documents](#before-you-point-it-at-real-documents).

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Setup](#setup)
  - [1. Register an OAuth client](#1-register-an-oauth-client)
  - [2. Configure the Docs instance](#2-configure-the-docs-instance)
  - [3. Install](#3-install)
  - [4. Configure this tool](#4-configure-this-tool)
  - [5. Log in](#5-log-in)
  - [6. Check the instance](#6-check-the-instance)
  - [7. Connect your MCP client](#7-connect-your-mcp-client)
- [Before you point it at real documents](#before-you-point-it-at-real-documents)
- [Troubleshooting](#troubleshooting)
- [CLI reference](#cli-reference)
- [Known limitations](#known-limitations)
- [Development](#development)

## What it does

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

## Requirements

| | |
| --- | --- |
| Docs instance | `v5.6.1`. Other versions may work, but see [BlockNote is pinned](#blocknote-is-pinned-to-0540-to-match-docs-v561). |
| Docs configuration | Resource server enabled, plus an `EXTERNAL_API` allowlist. |
| Identity provider | Any OIDC provider that supports authorization code with PKCE and loopback redirects. |
| Node | 22 or newer. |

Setup touches three systems in order: your identity provider, the Docs
instance, and then your own machine. The first two usually need whoever
administers them.

## Setup

### 1. Register an OAuth client

This tool logs in as a **public** OAuth client. Register one with your
identity provider:

| Setting | Value |
| --- | --- |
| Client ID | `lasuite-docs-mcp` (you will pass this as `DOCS_OIDC_CLIENT_ID`) |
| Client type | Public. No client secret. |
| Grant type | Authorization code with PKCE, method `S256` |
| Redirect URI | `http://127.0.0.1:*/callback` |
| Scopes | Must include `openid` |

The redirect URI needs that wildcard port. `login` starts a loopback listener
on an ephemeral port and builds the redirect URI from whatever port the OS
hands it, so the port is different on every login. A single fixed-port entry
works once and then fails. Providers that follow
[RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)
allow this; in Keycloak, `http://127.0.0.1:*/callback` is accepted verbatim.

> [!TIP]
> Consider requesting `offline_access` as well, via
> `DOCS_OIDC_SCOPE="openid offline_access"`. The MCP server refreshes its token
> silently but can never run the browser login itself, so once the refresh
> token expires, every tool starts failing until you run `login` again by hand.
> How long that takes depends on your provider's session settings.

### 2. Configure the Docs instance

Docs must run as an OIDC resource server:

```ini
OIDC_RESOURCE_SERVER_ENABLED=True
OIDC_OP_URL=https://sso.example.org/realms/main
OIDC_OP_INTROSPECTION_ENDPOINT=https://sso.example.org/realms/main/protocol/openid-connect/token/introspect
OIDC_RS_CLIENT_ID=docs-resource-server
OIDC_RS_CLIENT_SECRET=<secret of docs-resource-server>
OIDC_RS_AUDIENCE_CLAIM=client_id
OIDC_RS_ALLOWED_AUDIENCES=lasuite-docs-mcp
```

> [!IMPORTANT]
> **`OIDC_RS_ALLOWED_AUDIENCES` must contain this tool's client ID.** Docs
> introspects every incoming token, reads the claim named by
> `OIDC_RS_AUDIENCE_CLAIM` (default `client_id`), and rejects the request
> unless that value appears in `OIDC_RS_ALLOWED_AUDIENCES`. Miss this and
> login succeeds while every single tool call returns 403.

Two different clients are involved here, and both are called a client ID:

| Variable | Which client | Type |
| --- | --- | --- |
| `DOCS_OIDC_CLIENT_ID` | The one this tool logs in as, from step 1. | Public |
| `OIDC_RS_CLIENT_ID` | The one Docs itself uses to call the introspection endpoint. | Confidential |

Docs also needs an `EXTERNAL_API` allowlist covering the actions this server
calls:

```json
{
  "documents": {
    "enabled": true,
    "actions": [
      "list", "retrieve", "create", "children", "tree", "search",
      "content", "content_retrieve", "formatted_content", "can_edit"
    ]
  }
}
```

`favorite_list` and `duplicate` are always permitted by Docs and need no entry.
Restart Docs after changing either block.

### 3. Install

There is no npm release yet, so install from source:

```bash
git clone https://github.com/JonasDoebertin/lasuite-docs-mcp.git
cd lasuite-docs-mcp
npm ci
npm run build
npm link
```

### 4. Configure this tool

```bash
export DOCS_URL=https://docs.example.org
export DOCS_OIDC_ISSUER=https://sso.example.org/realms/main
export DOCS_OIDC_CLIENT_ID=lasuite-docs-mcp
```

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DOCS_URL` | Yes | | Base URL of the Docs instance. |
| `DOCS_OIDC_ISSUER` | Yes | | Issuer URL. Must serve `/.well-known/openid-configuration`. |
| `DOCS_OIDC_CLIENT_ID` | Yes | | The public client from step 1. |
| `DOCS_OIDC_SCOPE` | No | `openid` | See the note on `offline_access` above. |
| `DOCS_PROFILE` | No | `default` | Keeps several instances' credentials side by side. |

### 5. Log in

```bash
lasuite-docs-mcp login
```

This opens a browser for an authorization-code-with-PKCE flow against your
identity provider and stores the resulting tokens at
`~/.config/lasuite-docs-mcp/<profile>.json`, mode 0600.

### 6. Check the instance

```bash
lasuite-docs-mcp doctor
```

`doctor` probes four of the ten actions (`list`, `search`, `tree`, and
`formatted_content`) and prints the full `EXTERNAL_API` value to set if any of
them is blocked. The other six cannot be probed without creating or modifying
something, so they are assumed available and report a classified error on first
use instead. A clean `doctor` is a good sign rather than a guarantee that
editing works.

### 7. Connect your MCP client

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
> The server binary never performs the login flow. It only reads the
> credentials that `login` already stored. Run `login` from a terminal first,
> because a server launched by an MCP client has no browser to open.

## Before you point it at real documents

Writes replace a document's Yjs state in full, and the conversion that produces
that state runs against block specs vendored from Docs `v5.6.1`. If your
instance's block schema differs, a write can fail or mangle content.

`npm run check:drift` does not tell you this. It compares the vendored files
against the pinned upstream release, not against your instance. The only real
check is the contract suite:

```bash
npm run test:contract
```

Point it at a scratch instance, not your real one. It creates documents and
deliberately never deletes them. Once it passes there, switch `DOCS_URL` over.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Browser shows "invalid redirect URI" during login | The redirect URI is not registered with a wildcard port. See [step 1](#1-register-an-oauth-client). |
| Login succeeds, but every tool call returns 403 | `DOCS_OIDC_CLIENT_ID` is not in `OIDC_RS_ALLOWED_AUDIENCES`, or `OIDC_RS_AUDIENCE_CLAIM` does not match the claim your provider sends. |
| "The Docs instance does not permit the *X* action" | `X` is missing from the `EXTERNAL_API` allowlist. Run `doctor` for the exact value to set. |
| Some tools never appear in the client at all | The startup probe got a 403 for them. Run `doctor`, fix the allowlist, restart the client. |
| "Not authenticated with Docs. Run login" after idling | The refresh token expired. Run `login` again, and consider `offline_access`. |
| `docs_edit` says someone has the document open | A collaborative session is active. This is deliberate, see [Known limitations](#editing-is-refused-while-someone-has-the-document-open). |
| `ConversionError`, or a write that mentions schema drift | The instance's block schema disagrees with the vendored specs. Re-run `npm run vendor` and the contract suite. |
| `doctor` is clean but creating or editing fails | Only four actions are probed. The rest fail at call time by design. |

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

See [CLAUDE.md](CLAUDE.md) for the architecture and the invariants worth knowing
before changing the edit or conversion paths.

## License

MIT
