#!/usr/bin/env bash
# H1/W13 with the stand-in taking each held call's close 50 ms late (WHOLE_HOST_HELD_CLOSE_DELAY_MS), so the host's own
# report of a cut reaches the driver first, as it can when the harness's event loop is busy. The driver must still
# release the call as cut: check 14 flags "1 of the step's 2 request(s) cut" at 877092.stall.failed where it doesn't.
# The driver's log must show at least one cut call whose close came while its release waited, or the late close never
# reached the race and the run shows nothing.
# It drives connectome-host v0.25.0, cloned here, or the checkout HELD_CLOSE_HOST names.
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
WHOLE_HOST_HELD_CLOSE_DELAY_MS=50 node harness/run.ts --host "$H" --runs H1/W13 --width 1 --checkpoints "$T/c" --workdir "$T/w" --out "$T/o" > "$T/run.log" 2>&1
rc=$?
node - "$T/o/run.json" "$T/o/H1_W13/log.jsonl" <<'JS' || { tail -20 "$T/run.log" >&2; exit 1; }
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).results.find((x) => x.run === 'H1/W13');
if (!r || r.outcome === 'couldnt-run') { console.error(`held-close: H1/W13 did not run: ${r?.reason ?? 'no result'}`); process.exit(1); }
const flags = [...(r.flags?.new ?? []), ...(r.flags?.kept ?? [])].filter((f) => f.check === 14);
if (flags.length) { for (const f of flags) console.error(`held-close: check 14 at ${f.step}: ${f.detail}`); process.exit(1); }
const closes = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'held-close');
const came = closes.filter((e) => e.close === 'came').length;
if (!came) { console.error(`held-close: of the ${closes.length} cut calls released, none had its close come while the release waited (${closes.map((e) => e.close).join(', ') || 'none logged'}), so the late close never reached the race`); process.exit(1); }
console.log(`held-close: H1/W13 ${r.outcome}, with no check 14 flag though each held call's close was taken 50 ms late; ${came} of ${closes.length} cut calls had their close come while the release waited`);
JS
[ "$rc" = 0 ] || { echo "held-close: run.ts exited $rc" >&2; tail -20 "$T/run.log" >&2; exit 1; }
