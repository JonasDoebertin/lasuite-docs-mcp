#!/usr/bin/env bash
# Vendors the Docs BlockNote block specs from upstream.
# The pinned ref must match the BlockNote version in package.json.
set -euo pipefail

REF="v5.6.1"
BASE="https://raw.githubusercontent.com/suitenumerique/docs/${REF}/src/frontend/servers/y-provider/src/blockSpecs"
DEST="$(dirname "$0")/../src/content/blockSpecs"

mkdir -p "$DEST"
for file in index Callout Pdf UploadLoader InterlinkingLinkInline; do
  curl -fsSL "${BASE}/${file}.ts" -o "${DEST}/${file}.ts"
  echo "vendored ${file}.ts"
done

# Upstream resolves './blockSpecs' through a path alias we do not use.
sed -i.bak "s|from '@/blockSpecs'|from './blockSpecs/index.js'|g" "${DEST}"/*.ts

# Our tsconfig uses NodeNext module resolution, which requires explicit .js
# extensions on relative imports. Upstream builds with a resolver that allows
# extensionless imports (e.g. `from './Callout'`), so rewrite sibling imports
# to add the extension. The character class excludes '.', so already-suffixed
# imports (`./Callout.js`) do not match again, keeping this idempotent.
sed -i.bak -E "s|from '(\./[A-Za-z0-9_-]+)'|from '\1.js'|g" "${DEST}"/*.ts
rm -f "${DEST}"/*.bak

echo "vendored from ${REF}"
