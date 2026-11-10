import { png } from './png.ts';
import { WORDS, prose, seeded } from './prose.ts';

export const KINDS = ['prose', 'code', 'json', 'image', 'mixed'];
export const MAX_TEXT = 306_000_000;
export const MAX_SIDE = 2708;

const IDENTS = ['value', 'index', 'record', 'buffer', 'offset', 'cursor', 'result', 'total', 'entry', 'count'];
const CALLS = ['read', 'merge', 'split', 'store', 'parse', 'apply', 'shift', 'fold'];

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function isLong(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v);
  const digits = typeof v === 'string' ? v : JSON.isRawJSON(v) ? v.rawJSON : null;
  if (digits === null || !/^-?\d+$/.test(digits)) return false;
  const n = BigInt(digits);
  return n > SAFE || n < -SAFE;
}

function longOnly(v: unknown): unknown {
  if (isLong(v)) return v;
  if (!v || typeof v !== 'object') return undefined;
  const kept = Object.keys(v).sort().flatMap((k) => {
    const x = longOnly((v as Record<string, unknown>)[k]);
    return x === undefined ? [] : [[k, x] as const];
  });
  return kept.length ? Object.fromEntries(kept) : undefined;
}

function canonical(v: unknown): string {
  if (isLong(v)) return '"long integer"';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

type Pick = (m: number) => number;

function words(pick: Pick, length: number) {
  let s = '';
  while (s.length < length) s += (s ? ' ' : '') + WORDS[pick(WORDS.length)];
  return s.slice(0, length);
}

const proseOf = (canary: string, size: number, r: () => number) => (size > canary.length ? `${canary} ${prose(size - canary.length - 1, r)}` : canary);

function code(canary: string, size: number, pick: Pick) {
  let s = canary;
  while (s.length < size) {
    const lhs = `${IDENTS[pick(IDENTS.length)]}_${pick(64)}`;
    const args = [IDENTS[pick(IDENTS.length)], IDENTS[pick(IDENTS.length)]].join(', ');
    s += `\n${'  '.repeat(pick(3))}const ${lhs} = ${CALLS[pick(CALLS.length)]}(${args});`;
  }
  return s.slice(0, size);
}

function jsonText(canary: string, size: number, pick: Pick) {
  let s = `{"canary":${JSON.stringify(canary)},"rows":[`;
  const tail = ']}';
  let first = true;
  for (;;) {
    const row = `${first ? '' : ','}"${words(pick, 20 + pick(60))}"`;
    if (s.length + row.length + tail.length > size) break;
    s += row;
    first = false;
  }
  const room = size - s.length - tail.length;
  const shell = first ? 2 : 3;
  s += room >= shell ? `${first ? '' : ','}"${words(pick, room - shell)}"` : ' '.repeat(room);
  return s + tail;
}

function jsonFloor(canary: string) { return `{"canary":${JSON.stringify(canary)},"rows":[]}`.length; }

const isWhole = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const refuse = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

type Args = { kind?: unknown; canary?: unknown; width?: unknown; height?: unknown; size?: unknown };

export const fixtureWords = (args: unknown) => answer(args && typeof args === 'object' ? args : {});

export function toolResult(args: unknown) {
  const result = fixtureWords(args);
  const longs = longOnly(args);
  if ('isError' in result || longs === undefined) return result;
  return { ...result, content: [...result.content, { type: 'text', text: `the long integers as received: ${JSON.stringify(longs)}` }] };
}

function answer(a: Args) {
  if (!(KINDS as unknown[]).includes(a.kind)) return refuse(`kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(a.kind)})`);
  if (typeof a.canary !== 'string' || a.canary === '') return refuse(`canary must be a non-empty string (got ${JSON.stringify(a.canary)})`);
  const r = seeded(canonical(a));
  const pick = (m: number) => Math.floor(r() * m);
  if (a.kind === 'mixed') {
    if (!isWhole(a.width, 1, MAX_SIDE) || !isWhole(a.height, 1, MAX_SIDE) || !isWhole(a.size, a.canary.length * 2, MAX_TEXT)) {
      return refuse(`mixed needs width and height from 1 to ${MAX_SIDE} and a size from ${a.canary.length * 2} to ${MAX_TEXT} (got ${JSON.stringify([a.width, a.height, a.size])})`);
    }
    const half = Math.floor(a.size / 2);
    return { content: [{ type: 'text', text: proseOf(a.canary, half, r) }, { type: 'image', data: png(a.width, a.height, pick), mimeType: 'image/png' }, { type: 'text', text: proseOf(a.canary, a.size - half, r) }] };
  }
  if (a.kind === 'image') {
    if (!isWhole(a.width, 1, MAX_SIDE) || !isWhole(a.height, 1, MAX_SIDE)) {
      return refuse(`width and height must be whole numbers from 1 to ${MAX_SIDE} (got ${JSON.stringify(a.width)} by ${JSON.stringify(a.height)})`);
    }
    return { content: [{ type: 'image', data: png(a.width, a.height, pick), mimeType: 'image/png' }, { type: 'text', text: a.canary }] };
  }
  const floor = a.kind === 'json' ? jsonFloor(a.canary) : a.canary.length;
  if (!isWhole(a.size, floor, MAX_TEXT)) {
    return refuse(`size must be a whole number of characters from ${floor} to ${MAX_TEXT} for this kind and canary (got ${JSON.stringify(a.size)})`);
  }
  const text = a.kind === 'prose' ? proseOf(a.canary, a.size, r) : (a.kind === 'code' ? code : jsonText)(a.canary, a.size, pick);
  return { content: [{ type: 'text', text }] };
}
