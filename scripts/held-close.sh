#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
H=${HELD_CLOSE_HOST:-}
if [ -z "$H" ]; then
  H="$T/host"
  git clone -q --depth 1 --branch v0.25.0 https://github.com/anima-research/connectome-host.git "$H" || exit 1
  (cd "$H" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) || exit 1
fi
WHOLE_HOST_HELD_CLOSE_ON_WAIT=1 node harness/run.ts --host "$H" --runs H1/W13 --width 1 --checkpoints "$T/c" --workdir "$T/w" --out "$T/o" > "$T/run.log" 2>&1
rc=$?
case $rc in
  0 | 1) ;;
  *) echo "held-close: run.ts exited $rc" >&2; tail -20 "$T/run.log" >&2; exit 1 ;;
esac
said=$(node - "$T/o/run.json" "$T/o/H1_W13/log.jsonl" "$T/o/H1_W13/records.json" <<'JS'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).results.find((x) => x.run === 'H1/W13');
if (!r || r.outcome === 'couldnt-run') { console.error(`held-close: H1/W13 did not run: ${r?.reason ?? 'no result'}`); process.exit(1); }
const untaken = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).filter((x) => x.closeUntaken).map((x) => x.id);
if (untaken.length) { console.error(`held-close: ${untaken.join(', ')}: the host closed the call with no release waiting on the close, so the stand-in never took it, and a release answers such a call as one the host kept open`); process.exit(1); }
const flags = [...(r.flags?.new ?? []), ...(r.flags?.kept ?? [])].filter((f) => f.check === 14);
if (flags.length) { for (const f of flags) console.error(`held-close: check 14 at ${f.step}: ${f.detail}`); process.exit(1); }
const closes = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'held-close');
if (!closes.length) { console.error('held-close: no cut call was released, so the run reached no race'); process.exit(1); }
const other = closes.filter((e) => e.close !== 'came');
if (other.length) { console.error(`held-close: of the ${closes.length} cut calls released, ${other.map((e) => `${e.request}'s close was ${e.close}`).join(' and ')}, where each should have come while its release waited`); process.exit(1); }
console.log(`held-close: H1/W13 ${r.outcome}, with no check 14 flag though each held call's close was taken only once its release waited; all ${closes.length} cut calls had their close come while the release waited`);
JS
) || { tail -20 "$T/run.log" >&2; exit 1; }
[ "$rc" = 0 ] || { echo "held-close: run.ts exited $rc" >&2; tail -20 "$T/run.log" >&2; exit 1; }
echo "$said"
