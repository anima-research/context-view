import { createHash } from 'node:crypto';
import { sorted } from './view.ts';

/** A value as a model reads it: every cache marker left out, but inside a tool call's `input`, and a tool result's
 *  `is_error: false` read as no flag. */
export const readAlike = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(readAlike);
  if (!v || typeof v !== 'object' || JSON.isRawJSON(v)) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.entries(o).filter(([k, x]) => k !== 'cache_control' && !(k === 'is_error' && x === false && o.type === 'tool_result')).map(([k, x]) => [k, k === 'input' ? x : readAlike(x)]));
};

/** A part's identity: a hash of what the model reads of `value`, its run-varying values masked to their class. */
export const partId = (value: unknown, mask: (v: unknown) => unknown) => createHash('sha256').update(JSON.stringify(sorted(mask(readAlike(value))))).digest('hex').slice(0, 16);

/** The parts of a request's context as a codec's cache model renders them, from its elements in order. */
export const partsFrom = (elements: ReadonlyArray<{ tokens: number; part: { value: unknown; role: string; type: string; text: string | null } | null }>, mask: (v: unknown) => unknown): ContextPart[] =>
  elements.map(({ tokens, part }) => ({ id: partId(part!.value, mask), tokens, role: part!.role, type: part!.type, text: part!.text === null ? null : String(mask(part!.text)) }));

// A part of a request's context as a codec's cache model renders it: its identity (what the model reads of it, with
// cache markers, a tool result's `is_error: false`, its place and run-varying values set aside), the tokens the model
// counts for it, its role and type, and its text where it has one.
export interface ContextPart {
  id: string;
  tokens: number;
  role: string;
  type: string;
  text: string | null;
}

/** The tokens of `previous`'s parts that `next` no longer carries: 0 where it carries them all. A part is carried where
 *  `next` has one of the same identity, anywhere, each of `next`'s parts carrying at most one; `previous`'s last part
 *  is carried too where one of `next`'s parts left over has its role and type and a text that begins with its text. */
export function seamOf(previous: readonly ContextPart[] | null, next: readonly ContextPart[]): number {
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
  return uncarried.reduce((t, p) => t + p.tokens, 0);
}
