import type { CacheUse } from './openai-cache.ts';

export interface Guarded {
  id: string;
  kind: string;
  agent: string | null;
  arrived: bigint;
  whole: bigint;
  began?: bigint;
  carries: ReadonlySet<string>;
  gives: ReadonlySet<string>;
  use?: CacheUse;
}

export type Why = 'kinds' | 'markers' | 'passed';
export interface Unordered { with: string; why: Why }

const MARKED = /^summariser-M([0-9a-f]{8})(?:-\d+)?$/;
const markOf = (r: Guarded) => {
  const m = r.kind === 'summariser' ? MARKED.exec(r.id) : null;
  return m ? `[[s:M${m[1]}]]` : null;
};

export function unorderedUses(step: readonly Guarded[], wrote: ReadonlyMap<string, string>, oneManager = false): Map<string, Unordered[]> {
  const byId = new Map(step.map((r) => [r.id, r]));
  const next = new Map<string, Set<string>>(step.map((r) => [r.id, new Set()]));
  const edge = (a: Guarded, b: Guarded) => { if (a !== b) next.get(a.id)!.add(b.id); };
  for (const w of step) {
    if (w.began === undefined) continue;
    for (const r of step) if (w.began < r.whole && [...w.gives].some((t) => r.carries.has(t))) edge(w, r);
  }
  const chains = new Map<string, Guarded[]>();
  for (const r of step) if (r.kind === 'agent' && r.agent !== null) chains.set(r.agent, [...(chains.get(r.agent) ?? []), r]);
  for (const chain of chains.values()) {
    const sorted = [...chain].sort((a, b) => (a.arrived < b.arrived ? -1 : a.arrived > b.arrived ? 1 : 0));
    sorted.forEach((r, i) => { if (i) edge(sorted[i - 1], r); });
  }
  const callsOf = new Map<string, number>();
  for (const r of step) { const m = markOf(r); if (m !== null) callsOf.set(m, (callsOf.get(m) ?? 0) + 1); }
  const writer = (r: Guarded) => { const m = markOf(r); return m === null || callsOf.get(m)! > 1 ? undefined : wrote.get(m); };
  const oneManagersCalls = (a: Guarded, b: Guarded) => (oneManager ? a.kind === 'summariser' && b.kind === 'summariser' : writer(a) !== undefined && writer(a) === writer(b));
  for (const a of step) {
    if (a.began === undefined) continue;
    for (const b of step) if (b !== a && a.began < b.arrived && oneManagersCalls(a, b)) edge(a, b);
  }
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const u = stack.pop()!;
      if (u === to) return true;
      if (seen.has(u)) continue;
      seen.add(u);
      stack.push(...next.get(u)!);
    }
    return false;
  };
  const out = new Map<string, Unordered[]>();
  for (const r of step) {
    const read = r.use?.read;
    const w = read?.by == null ? undefined : byId.get(read.by);
    if (!read || !w || w === r || reaches(w.id, r.id) || reaches(r.id, w.id)) continue;
    const upTo = (u: CacheUse | undefined) => (u?.marks ?? []).filter((m) => m.at <= read.at).map((m) => `${m.at}:${m.ttl}`).join(' ');
    const why: Why | null = w.kind !== r.kind ? 'kinds' : upTo(w.use) !== upTo(r.use) ? 'markers' : null;
    if (why) out.set(r.id, [...(out.get(r.id) ?? []), { with: w.id, why }]);
  }
  for (const e of step) {
    if (!e.use?.passed.length) continue;
    const passed = new Set(e.use.passed);
    for (const l of step) {
      const u = l.use;
      if (l === e || !u || u.cache !== e.use.cache || u.seq < e.use.seq || !u.writes.some((h) => passed.has(h))) continue;
      if (!reaches(e.id, l.id) && !reaches(l.id, e.id)) out.set(e.id, [...(out.get(e.id) ?? []), { with: l.id, why: 'passed' }]);
    }
  }
  return out;
}
