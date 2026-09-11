#!/usr/bin/env bash
# Fails when the vendored block specs no longer match the pinned upstream ref.
#
# This re-downloads the pinned files and applies the exact same rewrites
# scripts/vendor-blockspecs.sh applies when vendoring, then diffs the result
# against what is checked in. It deliberately mirrors every rewrite in that
# script (not just the import path one) -- applying only a subset would flag
# the vendoring script's own transformations as "drift" on every run. It also
# never touches env.ts: that file is hand-written by us, not fetched from
# upstream, so there is nothing upstream to compare it against.
set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
VENDOR_SCRIPT="${SCRIPT_DIR}/vendor-blockspecs.sh"

REF="$(grep -oE 'REF="[^"]+"' "$VENDOR_SCRIPT" | cut -d'"' -f2)"
FILES_LINE="$(grep -oE 'FILES=\([^)]+\)' "$VENDOR_SCRIPT")"
# shellcheck disable=SC2086 # word-splitting is intentional: FILES_LINE is a
# bash array literal like FILES=(index Callout Pdf UploadLoader ...).
eval "$FILES_LINE"

BASE="https://raw.githubusercontent.com/suitenumerique/docs/${REF}/src/frontend/servers/y-provider/src/blockSpecs"
VENDORED="${SCRIPT_DIR}/../src/content/blockSpecs"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

for file in "${FILES[@]}"; do
  curl -fsSL "${BASE}/${file}.ts" -o "${TEMP}/${file}.ts"
done

# Re-apply the same rewrites scripts/vendor-blockspecs.sh performs, in the
# same order, so a correctly-vendored tree diffs as empty.
sed -i.bak "s|from '@/blockSpecs'|from './blockSpecs/index.js'|g" "${TEMP}"/*.ts
sed -i.bak "s|from '@/env'|from './env.js'|g" "${TEMP}"/*.ts
sed -i.bak -E "s|from '(\./[A-Za-z0-9_-]+)'|from '\1.js'|g" "${TEMP}"/*.ts
sed -i.bak "s|COLLABORATION_SERVER_ORIGIN\.split(',')\[0\]\.replace(|(COLLABORATION_SERVER_ORIGIN.split(',')[0] ?? '').replace(|g" "${TEMP}"/*.ts
rm -f "${TEMP}"/*.bak

status=0
for file in "${FILES[@]}"; do
  if ! diff -u "${TEMP}/${file}.ts" "${VENDORED}/${file}.ts" > "${TEMP}/${file}.diff"; then
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "block specs match upstream ${REF}"
  exit 0
fi

echo "Vendored block specs have drifted from upstream ${REF}:"
for file in "${FILES[@]}"; do
  if [ -s "${TEMP}/${file}.diff" ]; then
    cat "${TEMP}/${file}.diff"
  fi
done
echo
echo "Run 'npm run vendor', then 'npm run test:contract' before committing."
exit 1
