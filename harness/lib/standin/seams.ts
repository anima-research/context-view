import { createHash } from 'node:crypto';
import { sorted } from './view.ts';

// Data a model reads as sent, where a key named `cache_control` is no marker: a tool call's input, and a tool's schema
// on the Messages API (`input_schema`) and on OpenAI's (`parameters`).
const AS_SENT = new Set(['input', 'input_schema', 'parameters']);

export const readAlike = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(readAlike);
  if (!v || typeof v !== 'object' || JSON.isRawJSON(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, AS_SENT.has(k) ? x : readAlike(x)]));
};

export const blockAlike = <B>(b: B): B => {
  const o = b as { type?: unknown; is_error?: unknown } | null;
  if (!o || typeof o !== 'object' || o.type !== 'tool_result' || o.is_error !== false) return b;
  const { is_error: _e, ...rest } = o;
  return rest as B;
};

export const partId = (value: unknown, mask: (v: unknown) => unknown) => createHash('sha256').update(JSON.stringify(sorted(mask(readAlike(value))))).digest('hex').slice(0, 16);

export interface ReadPart { raw: string | null; id: string; text: string | null }

export interface PartMemo { known: ReadonlyMap<string, ReadPart> | null; next: Map<string, ReadPart> }

export const partsFrom = (elements: ReadonlyArray<{ tokens: number; part: { value: unknown; role: string; type: string; text: string | null } | null }>, mask: (v: unknown) => unknown, memo: PartMemo | null = null): ContextPart[] =>
  elements.map(({ tokens, part }) => {
    const raw = part!.text;
    const key = memo ? JSON.stringify(part!.value) : '';
    const was = memo ? memo.next.get(key) ?? memo.known?.get(key) : undefined;
    const read = was && was.raw === raw ? was : { raw, id: partId(part!.value, mask), text: raw === null ? null : String(mask(raw)) };
    memo?.next.set(key, read);
    return { id: read.id, tokens, role: part!.role, type: part!.type, text: read.text };
  });

export interface ContextPart {
  id: string;
  tokens: number;
  role: string;
  type: string;
  text: string | null;
}

export const textOf = (content: unknown, blocks: ReadonlyArray<{ type?: string; text?: string }> | undefined): string | null =>
  typeof content === 'string' ? content : blocks?.length && blocks.every((b) => b.type === 'text') ? blocks.map((b) => b.text ?? '').join('') : null;

export function withheldFrom(sent: readonly ContextPart[], read: readonly ContextPart[]): ContextPart[] {
  const left = new Map<string, number>();
  for (const p of read) left.set(p.id, (left.get(p.id) ?? 0) + 1);
  return sent.filter((p) => {
    const n = left.get(p.id) ?? 0;
    if (n > 0) left.set(p.id, n - 1);
    return n === 0;
  });
}

export function seamOf(previous: readonly ContextPart[] | null, next: readonly ContextPart[], previousWithheld: readonly ContextPart[] = [], nextWithheld: readonly ContextPart[] = []): number {
  if (!previous) return 0;
  const left = new Map<string, number>();
  for (const p of next) left.set(p.id, (left.get(p.id) ?? 0) + 1);
  const uncarried: ContextPart[] = [];
  for (const p of previous) {
    const n = left.get(p.id) ?? 0;
    if (n > 0) left.set(p.id, n - 1);
    else uncarried.push(p);
  }
  const last = previous.at(-1);
  if (last && uncarried.at(-1) === last && last.text !== null) {
    const grown = next.find((p) => (left.get(p.id) ?? 0) > 0 && p.role === last.role && p.type === last.type && p.text !== null && p.text.startsWith(last.text!));
    if (grown) uncarried.pop();
  }
  const lost = withheldFrom(nextWithheld, [...uncarried, ...previousWithheld]);
  return [...uncarried, ...lost].reduce((t, p) => t + p.tokens, 0);
}
