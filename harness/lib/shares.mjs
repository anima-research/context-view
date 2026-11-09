export function shares(ids, n, table = {}, checkpointKey = () => null, drives = 1, release = () => null) {
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 1; };
  const runSeconds = (id) => drives * (table.runs?.[id] ?? median(Object.values(table.runs ?? {})));
  const checkpointSeconds = (key) => (key === null ? 0 : table.checkpoints?.[key] ?? median(Object.values(table.checkpoints ?? {})));
  const installSeconds = (tag) => (tag === null ? 0 : table.installs?.[tag] ?? median(Object.values(table.installs ?? {})));
  const out = Array.from({ length: n }, () => ({ seconds: 0, checkpoints: new Set(), releases: new Set(), ids: new Set() }));
  const whole = (id) => runSeconds(id) + checkpointSeconds(checkpointKey(id)) + installSeconds(release(id));
  for (const id of [...ids].sort((a, b) => whole(b) - whole(a) || ids.indexOf(a) - ids.indexOf(b))) {
    const key = checkpointKey(id);
    const tag = release(id);
    const adds = (share) => runSeconds(id) + (key !== null && !share.checkpoints.has(key) ? checkpointSeconds(key) : 0) + (tag !== null && !share.releases.has(tag) ? installSeconds(tag) : 0);
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

/** The order a share's work starts in, longest first: a run's drives rank by the run's seconds, and a checkpoint by
 *  its own and the longest run that starts from it. Seconds come from `table` as `shares()` reads them; ties keep
 *  `ids`' order. Each rank is a key for `slots`. */
export function orderOf(ids, table = {}, checkpointKey = () => null) {
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 1; };
  const runSeconds = (id) => table.runs?.[id] ?? median(Object.values(table.runs ?? {}));
  const checkpointSeconds = (key) => table.checkpoints?.[key] ?? median(Object.values(table.checkpoints ?? {}));
  const longest = new Map();
  for (const id of ids) {
    const key = checkpointKey(id);
    const prior = key === null ? null : longest.get(key);
    if (key !== null && (!prior || runSeconds(id) > prior.seconds)) longest.set(key, { seconds: runSeconds(id), at: ids.indexOf(id) });
  }
  return {
    run: (id) => [-runSeconds(id), ids.indexOf(id)],
    checkpoint: (key) => [-(checkpointSeconds(key) + (longest.get(key)?.seconds ?? 0)), longest.get(key)?.at ?? -1],
  };
}
