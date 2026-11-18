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

step typecheck pnpm run typecheck
step lint pnpm run lint
step format pnpm run format:check
step test pnpm run test
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
