export interface SecondsTable { runs?: Record<string, number>; checkpoints?: Record<string, number>; installs?: Record<string, number> }

export function shares(ids: string[], n: number, table: SecondsTable = {}, checkpointKey: (id: string) => string | null = () => null, drives = 1, release: (id: string) => string | null = () => null) {
  const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 1; };
  const runSeconds = (id: string) => drives * (table.runs?.[id] ?? median(Object.values(table.runs ?? {})));
  const checkpointSeconds = (key: string | null) => (key === null ? 0 : table.checkpoints?.[key] ?? median(Object.values(table.checkpoints ?? {})));
  const installSeconds = (tag: string | null) => (tag === null ? 0 : table.installs?.[tag] ?? median(Object.values(table.installs ?? {})));
  const out = Array.from({ length: n }, () => ({ seconds: 0, checkpoints: new Set<string>(), releases: new Set<string>(), ids: new Set<string>() }));
  const whole = (id: string) => runSeconds(id) + checkpointSeconds(checkpointKey(id)) + installSeconds(release(id));
  for (const id of [...ids].sort((a, b) => whole(b) - whole(a) || ids.indexOf(a) - ids.indexOf(b))) {
    const key = checkpointKey(id);
    const tag = release(id);
    const adds = (share: (typeof out)[number]) => runSeconds(id) + (key !== null && !share.checkpoints.has(key) ? checkpointSeconds(key) : 0) + (tag !== null && !share.releases.has(tag) ? installSeconds(tag) : 0);
    const placed = tag === null ? [] : out.filter((x) => x.releases.has(tag));
    const open = placed.length ? placed : out.filter((x) => tag === null || x.releases.size === 0);
    const share = (open.length ? open : out).reduce((best, x) => (x.seconds + adds(x) < best.seconds + adds(best) ? x : best));
    share.seconds += adds(share);
    if (key !== null) share.checkpoints.add(key);
    if (tag !== null) share.releases.add(tag);
    share.ids.add(id);
  }
  return out.map((x) => ({ seconds: Math.round(x.seconds), ids: ids.filter((id) => x.ids.has(id)) }));
}

export function orderOf(ids: string[], table: SecondsTable = {}, checkpointKey: (id: string) => string | null = () => null) {
  const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 1; };
  const runSeconds = (id: string) => table.runs?.[id] ?? median(Object.values(table.runs ?? {}));
  const checkpointSeconds = (key: string) => table.checkpoints?.[key] ?? median(Object.values(table.checkpoints ?? {}));
  const longest = new Map<string, { seconds: number; at: number }>();
  for (const id of ids) {
    const key = checkpointKey(id);
    const prior = key === null ? null : longest.get(key);
    if (key !== null && (!prior || runSeconds(id) > prior.seconds)) longest.set(key, { seconds: runSeconds(id), at: ids.indexOf(id) });
  }
  return {
    run: (id: string) => [-runSeconds(id), ids.indexOf(id)],
    checkpoint: (key: string) => [-(checkpointSeconds(key) + (longest.get(key)?.seconds ?? 0)), longest.get(key)?.at ?? -1],
  };
}
