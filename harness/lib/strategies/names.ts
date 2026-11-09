import { CANARY } from '../standin/view.ts';

interface Block { type?: string; text?: unknown; content?: unknown; input?: unknown }

function canariesIn(content: unknown, inputs: boolean) {
  const texts: string[] = [];
  const walk = (b: unknown) => {
    if (typeof b === 'string') { texts.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (typeof (b as Block).text === 'string') texts.push((b as Block).text as string);
    if ((b as Block).type === 'tool_result') { if (Array.isArray((b as Block).content)) ((b as Block).content as unknown[]).forEach(walk); else texts.push(String((b as Block).content ?? '')); }
    if (inputs && (b as Block).type === 'tool_use') texts.push(JSON.stringify((b as Block).input ?? null));
  };
  (Array.isArray(content) ? content : []).forEach(walk);
  return texts.flatMap((t) => t.match(CANARY) ?? []);
}

export const canariesOf = (content: unknown) => canariesIn(content, false);

export const namingCanaries = (content: unknown) => canariesIn(content, true);

export const shortCanary = (canary: string) => /^\[\[c:(.+)\]\]$/.exec(canary)?.[1] ?? canary;

export function messageNames(order: Iterable<unknown>, canaryOf: (id: string) => string | null | undefined) {
  const names = new Map<string, string>(), anchors = new Map<string, number>();
  let anchor = 'start', after = 0;
  for (const raw of order) {
    const id = String(raw);
    const canary = canaryOf(id);
    if (canary) {
      const short = shortCanary(canary);
      const n = (anchors.get(short) ?? 0) + 1;
      anchors.set(short, n);
      anchor = n === 1 ? short : `${short}:${n}`;
      after = 0;
      names.set(id, anchor);
    } else names.set(id, `${anchor}+${++after}`);
  }
  return (id: unknown) => names.get(String(id)) ?? null;
}

export const byStoreOrder = (a: string, b: string) => {
  const x = Number(a), y = Number(b);
  const nx = Number.isFinite(x), ny = Number.isFinite(y);
  return nx && ny ? x - y : nx ? -1 : ny ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export const spanName = (prefix: string, first: unknown, last: unknown) => `${prefix}(${first === last ? first : `${first}-${last}`})`;
