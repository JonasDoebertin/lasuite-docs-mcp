#!/usr/bin/env bash
# Vendors the Docs BlockNote block specs from upstream.
# The pinned ref must match the BlockNote version in package.json.
set -euo pipefail

REF="v5.6.1"
BASE="https://raw.githubusercontent.com/suitenumerique/docs/${REF}/src/frontend/servers/y-provider/src/blockSpecs"
DEST="$(dirname "$0")/../src/content/blockSpecs"

mkdir -p "$DEST"
# NOTE: env.ts in this directory is hand-written, not vendored (see below for
# why). Do not add it to this list and do not let any rewrite below overwrite
# it — this loop only ever fetches the files named here.
for file in index Callout Pdf UploadLoader InterlinkingLinkInline; do
  curl -fsSL "${BASE}/${file}.ts" -o "${DEST}/${file}.ts"
  echo "vendored ${file}.ts"
done

# Upstream resolves './blockSpecs' through a path alias we do not use.
sed -i.bak "s|from '@/blockSpecs'|from './blockSpecs/index.js'|g" "${DEST}"/*.ts

# Upstream reads the collaboration server's own origin through its server-only
# '@/env' module, which we don't have (and don't want the baggage of: it also
# reads secrets and ports irrelevant to block specs). InterlinkingLinkInline.ts
# only needs COLLABORATION_SERVER_ORIGIN, so we supply an equivalent value via
# our own hand-written env.ts (see above) instead of vendoring upstream's env
# module and its unrelated concerns.
sed -i.bak "s|from '@/env'|from './env.js'|g" "${DEST}"/*.ts

# Our tsconfig uses NodeNext module resolution, which requires explicit .js
# extensions on relative imports. Upstream builds with a resolver that allows
# extensionless imports (e.g. `from './Callout'`), so rewrite sibling imports
# to add the extension. The character class excludes '.', so already-suffixed
# imports (`./Callout.js`) do not match again, keeping this idempotent.
sed -i.bak -E "s|from '(\./[A-Za-z0-9_-]+)'|from '\1.js'|g" "${DEST}"/*.ts

# Our tsconfig sets noUncheckedIndexedAccess, so a plain `string` (what our
# env.ts exports) makes `.split(',')[0]` type as `string | undefined`.
# Upstream's own '@/env' module also exports a plain string, so this is a
# genuine gap between upstream's type-checking and ours, not an artifact of
# our shim. Fall back to '' to keep the value a plain string; behavior is
# unaffected since split() on a non-empty string always yields a first
# element. Matching on the literal call keeps this idempotent — after the
# rewrite, "[0].replace(" no longer appears verbatim.
sed -i.bak "s|COLLABORATION_SERVER_ORIGIN\.split(',')\[0\]\.replace(|(COLLABORATION_SERVER_ORIGIN.split(',')[0] ?? '').replace(|g" "${DEST}"/*.ts
rm -f "${DEST}"/*.bak

echo "vendored from ${REF}"
