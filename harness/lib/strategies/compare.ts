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
// run's `keys` numbers each key by its first appearance there. Only a request's own top-level field of either name, on
// any API, or its `session_id` header, is masked so, through `mask.request`: a string of that shape anywhere else, a
// nested field of either name included, is content.
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
// The values a request's digest masks wherever its text holds them, since each run mints its own. The record writer masks
// the same ones in the texts a record shows (record.ts), and its tests hold it to each one here.
export const RUN_VARYING = { imageRef: REF, fork: FORK, readerEpoch: READER_EPOCH, reminder: REMINDER, draft: DRAFT_ID };

// Each epoch a run's compiles met, named in that order, and any other by its first appearance after them.
export function epochNames(log: LogEntry[] = []) {
  const names = new Map<string, string>();
  const named = (text: string) => text.replace(READER_EPOCH, (_, prefix, epoch) => {
    if (!names.has(epoch)) names.set(epoch, `E${names.size + 1}`);
    return `${prefix}${names.get(epoch)}`;
  });
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
// The reply judge's rendering of the agent's context quotes a tool's result on a line of its own text
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

export function ownTextOf(runDir: string | null | undefined, { numbered = true, also = [] as readonly string[], remembered = null as Set<string> | null, lessons = null as readonly string[] | null } = {}) {
  if (!runDir) return (s: string) => s;
  const nth = new Map<string, number>();
  for (const id of lessons ?? lessonIds(runDir)) {
    if (!nth.has(id)) nth.set(id, nth.size + 1);
    remembered?.add(id);
  }
  for (const id of remembered ?? []) if (!nth.has(id)) nth.set(id, nth.size + 1);
  const anyLesson = nth.size ? new RegExp(`(?<![0-9A-Za-z])(?:${[...nth.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![0-9A-Za-z])`, 'g') : null;
  const dirs = [runDir, ...also.filter((d) => d && d !== runDir)].sort((a, b) => b.length - a.length);
  return (s: string) => {
    const own = dirs.reduce((t, d) => t.split(d).join('<run>'), s).replace(SESSION, '$1<session>');
    return anyLesson ? own.replace(anyLesson, (id) => (numbered ? `lesson-${nth.get(id)}` : 'lesson')) : own;
  };
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
  // A request body, the record's other body fields, or the header wrapped as `{ session_id }`.
  mask.request = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return mask(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CODEX_KEY_FIELDS.has(k) && typeof v === 'string' && CODEX_KEY.test(v) ? (keys ? `<uuid>:<12 hex>#${nth(keys, v)}` : '<uuid>:<12 hex>') : mask(v)]));
  };
  return mask as Masker;
}

/** `runVaryingMasker`'s values masked to their class, none numbered by its first appearance or its place in the
 *  lessons file, with `also`'s directories, such as the one a checkpoint was built in, read as the run's own, and each
 *  lesson id in `remembered`, which this read adds the lessons file's to, masked though the file no longer lists it. */
export function runVaryingClass(runDir: string | null = process.env.FIXTURE_RUN_DIR || null, also: readonly string[] = [], remembered: Set<string> | null = null, lessons: readonly string[] | null = null) {
  const shown = historySequences(() => 'S');
  const own = ownTextOf(runDir, { numbered: false, also, remembered, lessons });
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return shown(own(value)).replace(RUN_VARYING.imageRef, 'img_N_#').replace(RUN_VARYING.fork, (_, prefix) => `${prefix}UUID`).replace(RUN_VARYING.readerEpoch, (_, prefix) => `${prefix}E`).replace(RUN_VARYING.reminder, (_, prefix) => `${prefix}R`).replace(RUN_VARYING.draft, (id) => (id === EXAMPLE_DRAFT_ID ? id : 'd-D'));
    }
    if (Array.isArray(value)) return value.map((v) => mask(v));
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'signature' && (value as { type?: unknown }).type === 'thinking' ? '(masked)' : k === 'aroundId' && typeof v === 'string' && /^\d+$/.test(v) ? 'S' : mask(v)]));
  };
  return mask;
}

export const maskRunVarying = <T extends JsonLike>(value: T, options?: Parameters<typeof runVaryingMasker>[1]) => runVaryingMasker(null, options)(value) as Masked<T>;
export const maskRequest = <T extends JsonLike>(value: T, options?: Parameters<typeof runVaryingMasker>[1]) => runVaryingMasker(null, options).request(value) as Masked<T>;

export function sameBodies(onDir: string, offDir: string, { onRun = null, offRun = null }: { onRun?: string | null; offRun?: string | null } = {}): SelfCheck {
  const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => /^r\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  const read = (dir: string, runDir: string | null) => { const keys = new Map<string, number>(); const epochs = new Map<string, number>(); return files(dir).map((f) => runVaryingMasker(keys, { runDir, epochs }).request(JSON.parse(readFileSync(join(dir, f), 'utf-8'), asWritten))) as Array<Record<string, unknown>>; };
  const [a, b] = [read(onDir, onRun), read(offDir, offRun)];
  if (!a.length) return { outcome: 'differs', at: 0, detail: `no request bodies were saved in ${onDir}` };
  const at = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
  if (at === -1 && a.length === b.length) return { outcome: 'same', requests: a.length };
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const field = a[i] && b[i] ? Object.keys({ ...a[i], ...b[i] }).find((k) => JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) : null;
  return { outcome: 'differs', at: i, files: [files(onDir)[i], files(offDir)[i]], detail: `${a.length} requests with recording on, ${b.length} with it off${field ? `; its ${field} differs` : ''}` };
}

export function selfCheckOf({ on, off, onBodies, offBodies, onRun = null, offRun = null }: {
  on: { ok: boolean; reason?: string | null };
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
  return sameBodies(onBodies, offBodies, { onRun, offRun });
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
