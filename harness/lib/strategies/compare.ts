import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asWritten } from './control.ts';
import type { SelfCheck } from '../shapes/interfaces.ts';
import type { LogEntry } from './driver.ts';
import { slug } from '../against.ts';

export type JsonLike = string | number | boolean | null | undefined | readonly JsonLike[] | { readonly [key: string]: JsonLike };
export interface Masker {
  (value: string): string;
  (value: unknown): unknown;
  request(value: unknown): unknown;
}
export type Masked<T> = T extends string ? string : T extends readonly (infer U)[] ? Masked<U>[] : T extends object ? { [K in keyof T]: K extends 'signature' ? string | Masked<T[K]> : Masked<T[K]> } : T;

const REF = /\bimg_([0-9a-z]+)_(\d+)\b/g;
const SESSION = /(<run>\/store\/sessions\/)[^/\s"'\\]+/g;
const FORK = /\b(fork-[^\s"]*?-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
// membrane 0.8.0's subscription mode keys the Codex backend's prompt cache on `<sessionId>:<12 hex of a digest>`, sent
// as `prompt_cache_key` and the `session_id` header, its sessionId a random UUID for each adapter unless the caller
// pins one (`openai-responses-api.ts`, buildRequest).
// Its shape alone would erase which requests share a key, which moves what the backend can cache, so a masker given a
// run's `keys` numbers each key by its first appearance there.
const CODEX_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{12}$/;
const CODEX_KEY_FIELDS = new Set(['prompt_cache_key', 'session_id']);
// agent-framework 0.32.0 names a reminder `rem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
// (heartbeat.js): its time part reads the workload's clock, and only the last four characters are random.
const REMINDER = /\b(rem_[0-9a-z]+_)([0-9a-z]{4})\b/g;
// agent-framework 0.32.0 and 0.33.0 name a draft `d-` and seven characters of its alphabet, each drawn by
// node:crypto's randomInt (prose-drafts.ts newId). Its drafts tool's schema, and its refusal of a malformed draftIds,
// quote one constant example, "d-k7x3qm2" (framework.ts:14086 and :23245 at 0.33.0, :13189 and :20654 at 0.32.0):
// text the host sends as written, not an id it minted, so it is left as sent.
export const DRAFT_ID = /\bd-[abcdefghjkmnpqrstuvwxyz23456789]{7}\b/g;
// agent-framework 0.33.0 names a reader fork `reader/<resident>/<its tune-out epoch's first 8 hex>/<n>` and heads its
// framing `epoch <the same 8 hex>` (framework.ts invokeReaderFork, tune-out/tools.ts defaultReaderFraming), an epoch
// id it mints at random.
export const READER_EPOCH = /(\breader\/[^/\s"\\]+\/(?=[0-9a-f]{8}\/\d)|\[Tune-out reader — [^\]\n]*?, epoch )([0-9a-f]{8})(?![0-9a-f])/g;
export const RUN_VARYING = { imageRef: REF, fork: FORK, readerEpoch: READER_EPOCH, reminder: REMINDER, draft: DRAFT_ID };

export function epochNames(log: LogEntry[] = [], first: readonly string[] = []) {
  const names = new Map<string, string>();
  const named = (text: string) => text.replace(READER_EPOCH, (_, prefix, epoch) => {
    if (!names.has(epoch)) names.set(epoch, `E${names.size + 1}`);
    return `${prefix}${names.get(epoch)}`;
  });
  for (const agent of first) named(agent);
  for (const e of log) if (e.kind === 'compiles') for (const l of e.lines ?? []) if (typeof l.agent === 'string') named(l.agent);
  return named;
}
export const EXAMPLE_DRAFT_ID = 'd-k7x3qm2';

// agent-framework's history module shows the agent the store sequence of each message a search finds or an extract
// returns (`id`), a search's `skipSequences` and an extract's `anchorId`, and takes one back as `aroundId`
// (modules/history/index.ts).
const HISTORY_RESULT = /^\{"(?:scanned|anchorId)":/;
const HISTORY_ID = /("id":")(\d+)(")/g;
const HISTORY_ANCHOR = /("(?:anchorId|aroundId)":"?)(\d+)/g;
const HISTORY_SKIP = /("skipSequences":\[)([\d,\s]*)(\])/g;
// agent-framework's reply judge's rendering of the agent's context quotes a tool's result on a line of its own text
// (`[history--search returned] {…}`).
const HISTORY_QUOTED = /\{"(?:scanned|anchorId)":[^\n]*/g;
export const historySequences = (name: (n: string) => string) => (s: string) => {
  const named = s.replace(HISTORY_ANCHOR, (_, key, n) => `${key}${name(n)}`).replace(HISTORY_SKIP, (_, open, ns, close) => `${open}${ns.replace(/\d+/g, name)}${close}`);
  const ids = (text: string) => text.replace(HISTORY_ID, (_, open, n, close) => `${open}${name(n)}${close}`);
  return HISTORY_RESULT.test(s) ? ids(named) : named.replace(HISTORY_QUOTED, ids);
};

// connectome-host's lessons module names each lesson `randomUUID().slice(0, 8)` and lists them, in the order it made
// them, in `lessons.json` two levels above the session store (lessons-module.ts, index.ts): the run's `store`.
export function lessonIds(runDir: string): string[] {
  const at = join(runDir, 'store', 'lessons.json');
  let text;
  try { text = readFileSync(at, 'utf-8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return []; throw e; }
  let doc: unknown = null;
  try { doc = JSON.parse(text); } catch { doc = null; }
  const lessons = doc && !Array.isArray(doc) && typeof doc === 'object' ? (doc as { lessons?: unknown }).lessons : null;
  if (!Array.isArray(lessons) || !lessons.every((l) => typeof l?.id === 'string' && l.id !== '')) {
    throw new Error(`the run's ${at} isn't the shape the run-varying masker reads, an object whose \`lessons\` list gives each lesson an \`id\`, so it can't tell which strings are lesson ids (lib/strategies/compare.ts)`);
  }
  return lessons.map((l) => l.id);
}

export type OwnText = ((s: string) => string) & { lessonKey: string };

export function ownTextOf(runDir: string | null | undefined, { numbered = true, also = [] as readonly string[], remembered = null as Set<string> | null, lessons = null as readonly string[] | null } = {}): OwnText {
  if (!runDir) return Object.assign((s: string) => s, { lessonKey: '[]' });
  const nth = new Map<string, number>();
  for (const id of lessons ?? lessonIds(runDir)) {
    if (!nth.has(id)) nth.set(id, nth.size + 1);
    remembered?.add(id);
  }
  for (const id of remembered ?? []) if (!nth.has(id)) nth.set(id, nth.size + 1);
  const anyLesson = nth.size ? new RegExp(`(?<![0-9A-Za-z])(?:${[...nth.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![0-9A-Za-z])`, 'g') : null;
  const dirs = [runDir, ...also.filter((d) => d && d !== runDir)].sort((a, b) => b.length - a.length);
  return Object.assign((s: string) => {
    const own = dirs.reduce((t, d) => t.split(d).join('<run>'), s).replace(SESSION, '$1<session>');
    return anyLesson ? own.replace(anyLesson, (id) => (numbered ? `lesson-${nth.get(id)}` : 'lesson')) : own;
  }, { lessonKey: JSON.stringify([...nth.keys()]) });
}

export function maskRunDir<T extends JsonLike>(value: T, runDir: string | null = process.env.FIXTURE_RUN_DIR || null): Masked<T> {
  if (!runDir) return value as Masked<T>;
  const own = ownTextOf(runDir);
  const walk = (v: unknown): unknown => (typeof v === 'string' ? own(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' && !JSON.isRawJSON(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value) as Masked<T>;
}

// agent-framework 0.32.0 names a tool-result image `img_<nonce>_<seq>`, its nonce minted by a ledger that lives only
// as long as its process (tool-image-ledger.ts).
export function runVaryingMasker(keys: Map<string, number> | null = null, { runDir = process.env.FIXTURE_RUN_DIR || null, epochs = new Map(), lessons = null }: { runDir?: string | null; epochs?: Map<string, number>; lessons?: readonly string[] | null } = {}) {
  const forks = new Map<string, number>();
  const reminders = new Map<string, number>();
  const drafts = new Map<string, number>();
  const nonces = new Map<string, number>();
  const sequences = new Map<string, number>();
  const nth = (map: Map<string, number>, key: string) => { if (!map.has(key)) map.set(key, map.size + 1); return map.get(key); };
  const sequence = (n: string) => `S${nth(sequences, n)}`;
  const shown = historySequences(sequence);
  const own = ownTextOf(runDir, { lessons });
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return shown(own(value)).replace(RUN_VARYING.imageRef, (_, nonce, n) => `img_N${nth(nonces, nonce)}_${n}`).replace(RUN_VARYING.fork, (_, prefix, uuid) => `${prefix}UUID${nth(forks, uuid)}`).replace(RUN_VARYING.readerEpoch, (_, prefix, epoch) => `${prefix}E${nth(epochs, epoch)}`).replace(RUN_VARYING.reminder, (_, prefix, random) => `${prefix}R${nth(reminders, random)}`).replace(RUN_VARYING.draft, (id) => (id === EXAMPLE_DRAFT_ID ? id : `d-D${nth(drafts, id)}`));
    }
    if (Array.isArray(value)) return value.map((v) => mask(v));
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'signature' && (value as { type?: unknown }).type === 'thinking' ? '(masked)' : k === 'aroundId' && typeof v === 'string' && /^\d+$/.test(v) ? sequence(v) : mask(v)]));
  };
  mask.request = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return mask(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CODEX_KEY_FIELDS.has(k) && typeof v === 'string' && CODEX_KEY.test(v) ? (keys ? `<uuid>:<12 hex>#${nth(keys, v)}` : '<uuid>:<12 hex>') : mask(v)]));
  };
  return mask as Masker;
}

export function runVaryingClass(runDir: string | null = process.env.FIXTURE_RUN_DIR || null, also: readonly string[] = [], remembered: Set<string> | null = null, lessons: readonly string[] | null = null) {
  const shown = historySequences(() => 'S');
  const own = ownTextOf(runDir, { numbered: false, also, remembered, lessons });
  const mask = Object.assign((value: unknown): unknown => {
    if (typeof value === 'string') {
      return shown(own(value)).replace(RUN_VARYING.imageRef, 'img_N_#').replace(RUN_VARYING.fork, (_, prefix) => `${prefix}UUID`).replace(RUN_VARYING.readerEpoch, (_, prefix) => `${prefix}E`).replace(RUN_VARYING.reminder, (_, prefix) => `${prefix}R`).replace(RUN_VARYING.draft, (id) => (id === EXAMPLE_DRAFT_ID ? id : 'd-D'));
    }
    if (Array.isArray(value)) return value.map((v) => mask(v));
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'signature' && (value as { type?: unknown }).type === 'thinking' ? '(masked)' : k === 'aroundId' && typeof v === 'string' && /^\d+$/.test(v) ? 'S' : mask(v)]));
  }, {
    lessonKey: own.lessonKey,
    request: (value: unknown): unknown => (!value || typeof value !== 'object' || Array.isArray(value) ? mask(value)
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CODEX_KEY_FIELDS.has(k) && typeof v === 'string' && CODEX_KEY.test(v) ? '<uuid>:<12 hex>' : mask(v)]))),
  });
  return mask as typeof mask & Masker;
}

export const maskRunVarying = <T extends JsonLike>(value: T, options?: Parameters<typeof runVaryingMasker>[1]) => runVaryingMasker(null, options)(value) as Masked<T>;
export const maskRequest = <T extends JsonLike>(value: T, options?: Parameters<typeof runVaryingMasker>[1]) => runVaryingMasker(null, options).request(value) as Masked<T>;

const baseOf = (name: string) => name.replace(/-\d+$/, '');

function inRecordOrder(names: Set<string>, log: LogEntry[] | null) {
  const placed: string[] = [];
  for (const e of log ?? []) {
    if (e.kind !== 'order') continue;
    for (const ref of e.order) if (names.has(ref) && !placed.includes(ref)) placed.push(ref);
  }
  return [...placed, ...[...names].filter((n) => !placed.includes(n)).sort()];
}

export function sameBodies(onDir: string, offDir: string, { onRun = null, offRun = null, onLog = null }: { onRun?: string | null; offRun?: string | null; onLog?: LogEntry[] | null } = {}): SelfCheck {
  const namesIn = (dir: string) => new Set((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.json') && !f.endsWith('.answer.json')).map((f) => f.slice(0, -5)));
  const [onNames, offNames] = [namesIn(onDir), namesIn(offDir)];
  const order = inRecordOrder(new Set([...onNames, ...offNames]), onLog);
  const read = (dir: string, runDir: string | null, names: Set<string>) => {
    const keys = new Map<string, number>();
    const epochs = new Map<string, number>();
    const groups = new Map<string, Array<{ name: string; text: string }>>();
    for (const name of order.filter((n) => names.has(n))) {
      const text = JSON.stringify(runVaryingMasker(keys, { runDir, epochs }).request(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf-8'), asWritten)));
      groups.set(baseOf(name), [...(groups.get(baseOf(name)) ?? []), { name, text }]);
    }
    return { groups, count: names.size };
  };
  const [a, b] = [read(onDir, onRun, onNames), read(offDir, offRun, offNames)];
  if (!a.count) return { outcome: 'differs', at: null, detail: `no request bodies were saved in ${onDir}` };
  const changed: Array<{ base: string; on: string | null; off: string | null }> = [];
  for (const base of new Set([...a.groups.keys(), ...b.groups.keys()])) {
    const left = [...(b.groups.get(base) ?? [])];
    const unmatched = (a.groups.get(base) ?? []).filter((x) => {
      const i = left.findIndex((y) => y.text === x.text);
      if (i < 0) return true;
      left.splice(i, 1);
      return false;
    });
    if (unmatched.length || left.length) changed.push({ base, on: unmatched[0]?.name ?? null, off: left[0]?.name ?? null });
  }
  if (!changed.length) return { outcome: 'same', requests: a.count };
  const [first] = changed;
  const pair = [first.on && a.groups.get(first.base)!.find((x) => x.name === first.on)!.text, first.off && b.groups.get(first.base)!.find((x) => x.name === first.off)!.text];
  const [x, y] = pair.map((t) => (t ? JSON.parse(t) as Record<string, unknown> : null));
  const field = x && y ? Object.keys({ ...x, ...y }).find((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])) : null;
  const counted = (base: string) => [a.groups.get(base)?.length ?? 0, b.groups.get(base)?.length ?? 0];
  const what = (c: typeof first) => {
    const [on, off] = counted(c.base);
    return on && off ? (on === off ? `${c.base} changed` : `${c.base}: ${on} with recording on, ${off} with it off`) : on ? `${c.base} only with recording on` : `${c.base} only with recording off`;
  };
  const keptOn = first.on ?? changed.find((c) => !b.groups.has(c.base) && c.on)?.on ?? null;
  const keptOff = first.off ?? changed.find((c) => !a.groups.has(c.base) && c.off)?.off ?? null;
  return { outcome: 'differs', at: first.base, files: [keptOn && `${keptOn}.json`, keptOff && `${keptOff}.json`], detail: `${a.count} requests with recording on, ${b.count} with it off; ${changed.length} name${changed.length === 1 ? '' : 's'} differ: ${changed.slice(0, 5).map(what).join(', ')}${changed.length > 5 ? ', …' : ''}${field ? `; ${first.base}'s ${field} differs` : ''}` };
}

export function selfCheckOf({ on, off, onBodies, offBodies, onRun = null, offRun = null }: {
  on: { ok: boolean; reason?: string | null; log?: LogEntry[] };
  off: { couldnt?: string; ok?: boolean; reason?: string | null; log?: LogEntry[] };
  onBodies: string;
  offBodies: string;
  onRun?: string | null;
  offRun?: string | null;
}): SelfCheck {
  if (!on.ok) return { outcome: 'couldnt-run', reason: `the run with recording on failed: ${on.reason ?? 'no reason given'}` };
  if (off.couldnt !== undefined) return { outcome: 'couldnt-run', reason: `the run with recording off couldn't run: ${off.couldnt}` };
  if (!off.ok) return { outcome: 'couldnt-run', reason: `the run with recording off failed: ${off.reason === undefined || off.reason === null ? 'no reason given' : epochNames(off.log ?? [])(off.reason)}` };
  const recorded = (off.log ?? []).filter((e) => e.kind === 'compiles').length;
  if (recorded) return { outcome: 'couldnt-run', reason: `the run with recording off logged ${recorded} compile batch${recorded === 1 ? '' : 'es'}, so the test module recorded though its recording was off` };
  return sameBodies(onBodies, offBodies, { onRun, offRun, onLog: on.log ?? null });
}

// Where each drive of a run keeps its stores, inside its arm's work directory: `runs/RUN` with recording on and
// `roff/RUN` with it off. A store's path reaches requests (a gate's config path, in a tool result), and both token
// counters a run meets count by character class: context-manager's estimate (`defaultTokenEstimator`,
// message-store.ts 2381-2396 at 0.25.1) by a text's length at a rate set by its share of punctuation and of
// characters above 126, and the stand-in's (`textTokens`, standin/tokens.ts) by its length at a rate set by a JSON
// parse, a base64 test that reads uppercase apart from lowercase, or its share of punctuation. So the two names
// are of one length and made of lowercase ASCII letters: each path counts the same in both drives, and what is
// placed by those counts, such as the cache markers context-manager's kv-unified folding places at thirds of the
// history's tokens, sits in the same place in both.
const DRIVE_DIRS = { on: 'runs', off: 'roff' };
export const driveScratch = (work: string, id: string, recording: boolean): string => join(work, recording ? DRIVE_DIRS.on : DRIVE_DIRS.off, slug(id));
