import { canaryOrder } from './summariser.ts';

export interface OrderLine {
  ref: string;
  agent: string | null;
  request: boolean;
  carries: ReadonlySet<string>;
  gives: ReadonlySet<string>;
  needs?: readonly string[];
  base?: string;
  text?: string;
  resends?: string;
}

const CANARY = /^\[\[c:[^\]\s]+\]\]$/;
const canariesOf = (l: OrderLine) => [...l.carries].filter((t) => CANARY.test(t)).sort(canaryOrder);
const byLabel = (a: string, b: string) => (a === b ? 0 : a === 'primary' ? -1 : b === 'primary' ? 1 : a < b ? -1 : 1);

function compareFree(a: OrderLine, b: OrderLine): number {
  const ca = canariesOf(a);
  const cb = canariesOf(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const c = canaryOrder(ca[i], cb[i]);
    if (c) return c;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  for (const [x, y] of [[a.base ?? a.ref, b.base ?? b.ref], [a.text ?? '', b.text ?? ''], [a.ref, b.ref]]) if (x !== y) return x < y ? -1 : 1;
  return 0;
}

export function orderStep(lines: readonly OrderLine[]): string[] {
  const byRef = new Map(lines.map((l) => [l.ref, l]));
  const requests = lines.filter((l) => l.request).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const edge = (u: string, v: string) => {
    if (!next.has(u)) next.set(u, new Set());
    if (!prev.has(v)) prev.set(v, new Set());
    next.get(u)!.add(v);
    prev.get(v)!.add(u);
  };
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const u = stack.pop()!;
      if (u === to) return true;
      if (seen.has(u)) continue;
      seen.add(u);
      stack.push(...(next.get(u) ?? []));
    }
    return false;
  };

  const givers = new Map<string, string[]>();
  for (const r of requests) for (const t of r.gives) givers.set(t, [...(givers.get(t) ?? []), r.ref]);
  const tokens = [...givers.keys()].sort();
  const carriers = (t: string) => requests.filter((r) => r.carries.has(t)).map((r) => r.ref);
  for (const t of tokens) {
    const g = givers.get(t)!;
    if (g.length === 1) for (const c of carriers(t)) if (c !== g[0]) edge(g[0], c);
  }
  for (const t of tokens) {
    const g = givers.get(t)!;
    if (g.length > 1) for (const c of carriers(t)) for (const x of g) if (x !== c && !reaches(c, x)) edge(x, c);
  }
  for (const r of requests) if (r.resends !== undefined && byRef.has(r.resends) && !reaches(r.ref, r.resends)) edge(r.resends, r.ref);

  const chains = new Map<string, OrderLine[]>();
  for (const l of lines) if (l.agent !== null) chains.set(l.agent, [...(chains.get(l.agent) ?? []), l]);
  const ancestors = new Map<string, Set<string>>();
  const agentAncestors = (ref: string) => {
    if (!ancestors.has(ref)) {
      const out = new Set<string>();
      const seen = new Set<string>();
      const stack = [...(prev.get(ref) ?? [])];
      while (stack.length) {
        const u = stack.pop()!;
        if (seen.has(u)) continue;
        seen.add(u);
        if (byRef.get(u)!.agent !== null) out.add(u);
        else stack.push(...(prev.get(u) ?? []));
      }
      ancestors.set(ref, out);
    }
    return ancestors.get(ref)!;
  };
  const labels = [...chains.keys()].sort(byLabel);
  const at = new Map(labels.map((a) => [a, 0]));
  const written = new Set<string>();
  const agentOrder: string[] = [];
  const head = (a: string) => chains.get(a)![at.get(a)!];
  const ready = (a: string) => {
    const l = head(a);
    return l !== undefined && [...agentAncestors(l.ref)].every((u) => written.has(u));
  };
  let current: string | null = null;
  const total = [...chains.values()].reduce((n, c) => n + c.length, 0);
  while (agentOrder.length < total) {
    const a: string = current !== null && ready(current) ? current : labels.find(ready) ?? (current !== null && head(current) ? current : labels.find((x) => head(x) !== undefined)!);
    const l = head(a);
    at.set(a, at.get(a)! + 1);
    written.add(l.ref);
    agentOrder.push(l.ref);
    current = a;
  }

  const index = new Map(agentOrder.map((ref, i) => [ref, i]));
  const shownBy = new Map<string, number[]>();
  for (const l of lines) if (!l.request) for (const t of l.needs ?? []) shownBy.set(t, [...(shownBy.get(t) ?? []), index.get(l.ref)!]);
  const free = requests.filter((r) => r.agent === null);
  const placeOf = (ref: string) => {
    let best = Infinity;
    const seen = new Set<string>();
    const stack = [ref];
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      for (const t of byRef.get(u)!.gives) for (const i of shownBy.get(t) ?? []) best = Math.min(best, i);
      for (const v of next.get(u) ?? []) {
        if (byRef.get(v)!.agent !== null) best = Math.min(best, index.get(v)!);
        else stack.push(v);
      }
    }
    return best;
  };
  const groups = new Map<number, OrderLine[]>();
  for (const r of free) {
    const p = placeOf(r.ref);
    groups.set(p, [...(groups.get(p) ?? []), r]);
  }
  const sortGroup = (group: OrderLine[]) => {
    const left = new Set(group.map((r) => r.ref));
    const out: string[] = [];
    while (left.size) {
      const candidates = group.filter((r) => left.has(r.ref));
      const open = candidates.filter((r) => ![...(prev.get(r.ref) ?? [])].some((u) => left.has(u)));
      const pick = (open.length ? open : candidates).sort(compareFree)[0];
      left.delete(pick.ref);
      out.push(pick.ref);
    }
    return out;
  };
  const out: string[] = [];
  agentOrder.forEach((ref, i) => {
    if (groups.has(i)) out.push(...sortGroup(groups.get(i)!));
    out.push(ref);
  });
  if (groups.has(Infinity)) out.push(...sortGroup(groups.get(Infinity)!));
  return out;
}
