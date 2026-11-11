import { TOOL_ID } from './agent.ts';
import { CANARY, SUMMARY } from './view.ts';
import type { Block } from './view.ts';

const TOKEN = new RegExp(`${CANARY.source}|${SUMMARY.source}|${TOOL_ID.source}`, 'g');
const ID = /^\S{1,128}$/;

function strings(value: unknown, each: (s: string) => void) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') each(v);
    else if (v !== null && typeof v === 'object' && !JSON.isRawJSON(v)) for (const x of Object.values(v)) stack.push(x);
  }
}

/** What a request's body carries: every token in its strings, at any depth (a canary, a summary's mark or a tool id in
 *  the form the stand-in gives one), and each of its strings that could be an id whole: no whitespace, up to 128
 *  characters. */
export function carriedBy(body: unknown): Set<string> {
  const out = new Set<string>();
  strings(body, (s) => {
    for (const t of s.match(TOKEN) ?? []) out.add(t);
    if (ID.test(s)) out.add(s);
  });
  return out;
}

/** What an answer's content holds: every token in its strings, at any depth, and each of its calls' ids, whatever their
 *  form. */
export function heldBy(content: readonly Block[]): Set<string> {
  const out = new Set<string>();
  strings(content, (s) => { for (const t of s.match(TOKEN) ?? []) out.add(t); });
  for (const b of content) if (b.type === 'tool_use' && typeof b.id === 'string') out.add(b.id);
  return out;
}

/** A request's trace: what its body carries and when it arrived whole; once its answer began to be sent, when that was and
 *  what the answer gives, what its content holds that the request didn't carry. */
export interface Trace { carries: ReadonlySet<string>; whole: bigint; gives?: ReadonlySet<string>; began?: bigint }

export interface Untraced<K> { token: string; givenBy: K[] }

/** Each request that carries a token some answer gives, where none of those answers began to be sent before the request
 *  arrived whole, with each such token, in string order, and the requests whose answers give it, in the traces' order. */
export function untraced<K>(traces: ReadonlyMap<K, Trace>): Map<K, Untraced<K>[]> {
  const givers = new Map<string, K[]>();
  for (const [k, t] of traces) {
    for (const token of t.gives ?? []) {
      const g = givers.get(token);
      if (g) g.push(k);
      else givers.set(token, [k]);
    }
  }
  const out = new Map<K, Untraced<K>[]>();
  for (const [k, t] of traces) {
    const broken = [...t.carries].filter((token) => givers.has(token) && !givers.get(token)!.some((g) => traces.get(g)!.began! < t.whole)).sort();
    if (broken.length) out.set(k, broken.map((token) => ({ token, givenBy: givers.get(token)! })));
  }
  return out;
}
