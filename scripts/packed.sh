#!/bin/sh
# Packs core, use-cases and cli as they would be published, installs the three tarballs and the locked zod in an empty
# folder and runs both bins from there, so the packed files run without the workspace.
set -eu
cd "$(dirname "$0")/.."

expected=$(node -p "require('./packages/cli/package.json').version")
# A template, since macOS mktemp -d alone ignores TMPDIR.
work=$(mktemp -d "${TMPDIR:-/tmp}/cedarloom-packed.XXXXXX")
trap 'rm -rf "$work"' EXIT

for package in core use-cases cli; do
  # The package's prepack script builds it, so a tarball never holds a stale dist.
  pnpm --filter "@cedarloom/$package" pack --pack-destination "$work"
done

# zod comes from the installed workspace, the version the lockfile pins, so npm needs no registry lookup for it. The
# override serves it only to packages that declare zod, so a missing declaration still fails.
zod=$(pnpm --filter @cedarloom/core exec node -p "require('node:path').dirname(require.resolve('zod/package.json'))")
(cd "$zod" && pnpm pack --silent --out "$work/zod.tgz")

cd "$work"
echo '{ "private": true, "overrides": { "zod": "file:./zod.tgz" } }' >package.json
npm install --ignore-scripts --no-audit --no-fund ./cedarloom-*.tgz
for bin in cedarloom cloom; do
  found=$(npx --no-install "$bin" --version)
  if [ "$found" != "$expected" ]; then
    echo "packed: $bin --version printed $found, expected $expected" >&2
    exit 1
  fi
done
echo "packed: cedarloom and cloom run from the packed tarballs"
