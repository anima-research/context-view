import type { JsonLike } from '../strategies/compare.ts';

type JsonObject = { [field: string]: JsonLike };

export interface ValueKind<T extends JsonLike> {
  readonly name: string;
  readonly is: (value: unknown) => value is T;
  readonly rows?: Rows;
}

export type Rows = { readonly [field: string]: ValueKind<JsonLike> };

export type TypeOf<K> = K extends ValueKind<infer T> ? T : never;

export type Fielded<R extends Rows> = { [F in keyof R]?: TypeOf<R[F]> | null } & JsonObject;

export const isObject = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) && !JSON.isRawJSON(v);

export const string: ValueKind<string> = { name: 'a string', is: (v): v is string => typeof v === 'string' };
export const number: ValueKind<number> = { name: 'a number', is: (v): v is number => typeof v === 'number' };
export const boolean: ValueKind<boolean> = { name: 'a boolean', is: (v): v is boolean => typeof v === 'boolean' };
export const json: ValueKind<JsonLike> = { name: 'any JSON', is: (_v): _v is JsonLike => true };
export const list = <E extends JsonLike = JsonLike>(): ValueKind<E[]> => ({ name: 'a list', is: (v): v is E[] => Array.isArray(v) });
export const listOf = <E extends JsonObject = JsonObject>(): ValueKind<E[]> => ({ name: 'a list of objects', is: (v): v is E[] => Array.isArray(v) && v.every(isObject) });
export const object = <R extends Rows = Record<never, never>>(rows?: R): ValueKind<Fielded<R>> => ({ name: 'an object', is: (v): v is Fielded<R> => isObject(v), ...(rows ? { rows } : {}) });
export const choice = <K extends Array<ValueKind<JsonLike>>>(...kinds: K): ValueKind<TypeOf<K[number]>> => ({
  name: kinds.map((k) => k.name).join(' or '),
  is: (v): v is TypeOf<K[number]> => kinds.some((k) => k.is(v)),
});

export const kindOf = (v: unknown) => (typeof v === 'string' ? 'a string' : JSON.isRawJSON(v) ? 'an integer too large to hold exactly' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a boolean' : Array.isArray(v) ? 'a list' : 'an object');

export type Checked<B> = { body: B | null; reason?: undefined } | { reason: string; body?: undefined };

export function check<R extends Rows>(api: string, rows: R, body: unknown): Checked<Fielded<R>> {
  if (!isObject(body)) return { body: null };
  const reason = gate(api, rows, body);
  return reason === null ? { body: body as Fielded<R> } : { reason };
}

function gate(api: string, rows: Rows, body: unknown, at = ''): string | null {
  if (!isObject(body)) return null;
  for (const [field, kind] of Object.entries(rows)) {
    const value = body[field];
    if (value == null) continue;
    if (!kind.is(value)) return `a ${api} request's \`${at}${field}\` is ${kindOf(value)}, and the stand-in reads it as ${kind.name}`;
    const inner = kind.rows ? gate(api, kind.rows, value, `${at}${field}.`) : null;
    if (inner) return inner;
  }
  return null;
}
