const FIGURES = ['input', 'cacheRead', 'cacheWrite', 'output'];

export const droppedIn = (record) => (record.transformations ?? []).filter((t) => t.type === 'thinking_dropped').length;

export function historySteps(steps, segment) {
  const own = steps.filter((s) => s.segment === segment);
  const closing = own.at(-1)?.kind === 'checkpoint' && own.at(-1).copyStore ? own.at(-1) : null;
  return new Set(own.filter((s) => s !== closing).map((s) => s.id));
}

export function usageOf(records, log, agent, built = new Set()) {
  const kinds = sums(records);
  const last = records.filter((r) => r.tokens && r.kind === 'agent' && (r.agent ?? 'primary') === 'primary' && !built.has(r.step)).at(-1);
  return {
    kinds,
    ...(built.size ? { history: sums(records.filter((r) => built.has(r.step))) } : {}),
    lastDropped: last ? droppedIn(last) : null,
    calibration: calibrationOf(log, agent),
  };
}

function sums(records) {
  const kinds = {};
  for (const r of records) {
    if (!r.tokens) continue;
    const k = (kinds[r.kind] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, dropped: 0 });
    k.requests += 1;
    for (const f of FIGURES) k[f] += r.tokens[f] ?? 0;
    k.dropped += droppedIn(r);
  }
  return kinds;
}

function calibrationOf(log, agent) {
  const read = log.filter((e) => e.health).at(-1);
  const c = read?.health.data?.contextComposition?.[agent]?.calibration;
  if (!c || typeof c.multiplier !== 'number') return null;
  return { multiplier: c.multiplier, provisional: c.provisional === true, reset: c.reset != null };
}
