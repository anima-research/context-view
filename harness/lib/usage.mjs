// What a run's requests cost by the stand-in's model of each provider's caching and token rules, for run.json's `usage`:
// each request kind's sums, as the stand-in answered them (`record.tokens`, `tokensSent`'s figures), with the thinking
// blocks it dropped under the drop control; how many the last request the stand-in answered for the script's primary
// agent had dropped; and the judged agent's calibration as the run's last health read gave it. A request the stand-in refused has no tokens, and isn't counted.
const FIGURES = ['input', 'cacheRead', 'cacheWrite', 'output'];

export const droppedIn = (record) => (record.transformations ?? []).filter((t) => t.type === 'thinking_dropped').length;

export function usageOf(records, log, agent) {
  const kinds = {};
  for (const r of records) {
    if (!r.tokens) continue;
    const k = (kinds[r.kind] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, dropped: 0 });
    k.requests += 1;
    for (const f of FIGURES) k[f] += r.tokens[f] ?? 0;
    k.dropped += droppedIn(r);
  }
  const last = records.filter((r) => r.tokens && r.kind === 'agent' && r.agent === 'primary').at(-1);
  return { kinds, lastDropped: last ? droppedIn(last) : null, calibration: calibrationOf(log, agent) };
}

// The judged agent's calibration at the last read of the host's health panel the run made, a checkpoint's or its end's:
// `{multiplier, provisional, reset}`, provisional and reset as context-manager's panel gives them (a provisional
// multiplier, one a reset restarted), or null where no read gave one, as for a strategy that keeps none.
function calibrationOf(log, agent) {
  const read = log.filter((e) => e.health?.data).at(-1);
  const c = read?.health.data.contextComposition?.[agent]?.calibration;
  if (!c || typeof c.multiplier !== 'number') return null;
  return { multiplier: c.multiplier, provisional: c.provisional === true, reset: c.reset != null };
}
