#!/bin/sh
# Runs every gate of the repository: the npm tools of package.json and the tools of tools/requirements.txt.
set -eu
cd "$(dirname "$0")/.."

if ! command -v uvx >/dev/null; then
  echo "check: uvx is missing (https://docs.astral.sh/uv/)" >&2
  exit 2
fi

step() {
  echo "==> $1"
  shift
  "$@"
}

tool() {
  uvx --constraints tools/requirements.txt "$@"
}

# Em dash and emoji in tracked text files, lockfiles excluded. git grep: 0 match, 1 no match, anything else an error.
forbidden_characters() {
  rc=0
  LC_ALL=C.UTF-8 git grep -nIP '\x{2014}|[\x{1F000}-\x{1FAFF}\x{2300}-\x{23FF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}]|\x{FE0F}' \
    -- . ':!pnpm-lock.yaml' ':!*package-lock.json' || rc=$?
  if [ "$rc" -eq 0 ]; then echo "check: em dash or emoji found" >&2; return 1; fi
  if [ "$rc" -ne 1 ]; then echo "check: git grep failed ($rc)" >&2; return 1; fi
}

# Each compiled catalog and its generated types match en.po; the compile refuses a message id without a text.
messages_fresh() {
  for package in core cli; do
    generated="packages/$package/src/messages/en.json packages/$package/src/messages/catalog.ts"
    before=$(cat $generated | cksum)
    pnpm --filter "@cedarloom/$package" run messages
    if [ "$(cat $generated | cksum)" != "$before" ]; then
      echo "check: $package messages were stale; run pnpm --filter @cedarloom/$package run messages and commit the result" >&2
      return 1
    fi
  done
}

step characters forbidden_characters
step messages messages_fresh
step typecheck pnpm run typecheck
step lint pnpm run lint
step format pnpm run format:check
step test pnpm run test
step packed sh scripts/packed.sh
step knip pnpm run knip
step jscpd pnpm run jscpd
step licenses pnpm run licenses
step audit pnpm audit --audit-level high
# One process: a process pool needs semaphores that some sandboxes do not grant.
step reuse tool --from reuse --with charset-normalizer reuse --no-multiprocessing lint
step typos tool typos
step actionlint tool --from actionlint-py actionlint
# In CI the zizmor action runs it with the online audits, at the same version.
if [ -n "${CI:-}" ]; then
  echo "==> zizmor: skipped, the workflow runs it in CI"
else
  # Online audits run when GH_TOKEN is set; otherwise zizmor runs the offline ones.
  step zizmor tool zizmor .
fi
echo "check: all gates passed"
