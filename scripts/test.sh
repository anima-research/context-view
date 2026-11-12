#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
part() {
  local name=$1 command=$2
  printf '== %s: %s\n' "$name" "$command"
  bash -c "$command" || { printf 'test: %s failed\n' "$name" >&2; exit 1; }
}
case ${1-} in
  vps)
    part types "bun install --frozen-lockfile --ignore-scripts && npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && bun run typecheck"
    part run "bun test ./run --timeout 30000"
    part harness "npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm --prefix harness test"
    part held-close "bash scripts/held-close.sh"
    part module "npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm --prefix harness run test:module"
    ;;
  house)
    part view "cd view && bun install --frozen-lockfile --ignore-scripts && bun run typecheck && bun test . --timeout 30000"
    part workflow "bun test ./workflow --timeout 30000"
    ;;
  *)
    printf "test: name a half, vps or house: vps runs types, run, harness, held-close and module, the last two of which run connectome-host from a clone, and house runs view, which builds against the house's review-workflow, and workflow, whose tests read the house's records (AGENTS.md)\n" >&2
    exit 2
    ;;
esac
echo "test: every part of the $1 half passed"
