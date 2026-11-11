import { createHash } from 'node:crypto';

// OpenAI's prompt cache for GPT-5.6 and later, which the prompt-caching guide specifies whole and which applies to
// the Responses and Chat Completions APIs alike (https://developers.openai.com/api/docs/guides/prompt-caching): "The
// minimum cacheable prompt length is 1,024 tokens"; the implicit breakpoint goes "at the end of the latest eligible
// message", eligible being user messages and "the last tool response in a consecutive group of tool responses" (and
// the initial developer group's last message, which is never the latest in a request the stand-in serves, since each
// codec refuses one whose items or messages are all developer or system ones, a tool output being the user's side, which
// ends an eligible run itself); a lookup walks "the implicit breakpoint, up to 20 earlier eligible message
// endings"; cached tokens are reported at the "exact eligible boundary"; and "a 30-minute read refreshes coverage to at
// least 30 minutes after that read". The guide's other lifetime, `prompt_cache_options.ttl: "12h"`, it offers "in the
// Responses API" alone, and both codecs refuse a request asking for it as unclassified, so the rule models the
// default 30 minutes alone. Each codec's model table decides which models reach this rule.
const CACHE_MINIMUM = 1024;
const EARLIER_LOOKUPS = 20;
const LIFETIME = 30 * 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// The chain starts from the model and, where a codec gives them, the settings OpenAI's prompt-caching guide lists under
// "Which settings affect the cached prefix?" besides the model, the tools and `context_management`, each as sent.
export interface CacheUse {
  cache: number;
  seq: number;
  read: { hash: string; by: string | null; at: number } | null;
  writes: string[];
  passed: string[];
  marks: Array<{ at: number; ttl: number }>;
}
export type CacheUses = Map<string, CacheUse>;
let caches = 0;
export const cacheId = () => ++caches;

export interface Element {
  hash: string;
  tokens: number;
  eligible: boolean;
  part: { value: unknown; role: string; type: string; text: string | null } | null;
}

export function prefixOf(model: string, settings?: unknown) {
  const out: Element[] = [];
  let h = sha(String(model) + JSON.stringify(settings ?? null));
  return {
    push(value: unknown, tokens: number, eligible = false, part: Element['part'] = null) {
      h = sha(h + JSON.stringify(value));
      out.push({ hash: h, tokens, eligible, part });
    },
    elements: out,
  };
}

export function promptCache({ clock, uses = null }: { clock: () => number; uses?: CacheUses | null }) {
  const cache = new Map<string, { expiresAt: number; by: string | null }>();
  const id = cacheId();
  return function use(els: readonly Element[], who: string | null = null) {
    const now = clock();
    const cum: number[] = []; let c = 0;
    for (const e of els) { c += e.tokens; cum.push(c); }
    const eligible = els.map((e, i) => (e.eligible ? i : -1)).filter((i) => i >= 0);
    const breakpoint = eligible.at(-1) ?? -1;
    let readAt = -1;
    const passed: string[] = [];
    for (const i of eligible.slice(-1 - EARLIER_LOOKUPS).reverse()) {
      const entry = cache.get(els[i].hash);
      if (entry && entry.expiresAt > now) { readAt = i; break; }
      passed.push(els[i].hash);
    }
    const read = readAt >= 0 ? cum[readAt] : 0;
    const taken: CacheUse = { cache: id, seq: uses?.size ?? 0, read: null, writes: [], passed, marks: breakpoint < 0 ? [] : [{ at: breakpoint, ttl: LIFETIME }] };
    if (readAt >= 0) {
      const entry = cache.get(els[readAt].hash)!;
      entry.expiresAt = Math.max(entry.expiresAt, now + LIFETIME);
      taken.read = { hash: els[readAt].hash, by: entry.by, at: readAt };
    }
    let written = 0;
    if (breakpoint > readAt && cum[breakpoint] >= CACHE_MINIMUM) {
      cache.set(els[breakpoint].hash, { expiresAt: now + LIFETIME, by: who });
      taken.writes.push(els[breakpoint].hash);
      written = cum[breakpoint] - read;
    }
    if (who !== null) uses?.set(who, taken);
    return { total: c, read, written };
  };
}
