#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
part() {
  local name=$1 command=$2
  printf '== %s: %s\n' "$name" "$command"
  bash -c "$command" || { printf 'test: %s failed\n' "$name" >&2; exit 1; }
}
part types "bun install --frozen-lockfile --ignore-scripts && npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && bun run typecheck"
part run "bun test ./run --timeout 120000"
part harness "npm --prefix harness ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm --prefix harness test"
part view "cd view && UV_NO_BUILD=0 uv run --frozen python -m unittest discover -q"
part workflow "bun test ./workflow --timeout 30000"
echo "test: every part passed"
