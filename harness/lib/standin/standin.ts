import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lessonIds, runVaryingClass, runVaryingMasker } from '../strategies/compare.ts';
import { asWritten } from '../strategies/control.ts';
import { agent } from './agent.ts';
import { anthropic, decodeMessages, MESSAGES_ROWS } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { CHAT_ROWS, chat, decodeChat } from './chat.ts';
import { spawnName } from '../strategies/checks.ts';
import { judge, type JudgeStep } from './judge.ts';
import { KIND_NAMES, fieldsName, stepName } from './name.ts';
import { orderStep, type OrderLine } from './order.ts';
import { keepalive } from './keepalive.ts';
import { naming } from './naming.ts';
import { CODEX_ROWS, decodeResponses, RESPONSES_ROWS, responses } from './responses.ts';
import { retrieval } from './retrieval.ts';
import { review } from './review.ts';
import { partId, seamOf } from './seams.ts';
import { summariser } from './summariser.ts';
import { transition } from './transition.ts';
import * as value from './value-kinds.ts';
import { blockTokens, fitToMaxTokens } from './tokens.ts';
import { carriedBy, heldBy, untraced } from './trace.ts';
import { giversOf, unorderedUses } from './cache-guard.ts';
import type { Unordered } from './cache-guard.ts';
import type { CacheUses } from './openai-cache.ts';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Figure } from '../shapes/interfaces.ts';
import type { Masker } from '../strategies/compare.ts';
import type { ContextPart, PartMemo, ReadPart } from './seams.ts';
import type { AgentConfiguration, AgentStep } from './agent.ts';
import type { MessagesWritten } from './anthropic.ts';
import type { BedrockWritten } from './bedrock.ts';
import type { ChatWritten } from './chat.ts';
import type { ResponsesWritten } from './responses.ts';
import type { SummariserStep } from './summariser.ts';
import type { Trace } from './trace.ts';
import { markParsed } from './view.ts';
import type { Block, ReadView, View } from './view.ts';

export type Tokens = Record<Figure, number>;

export type KindName = (typeof KIND_NAMES)[number];

export interface AnswerRecord {
  shape: 'refused' | 'cut' | 'error' | 'verdict' | 'reply' | 'summary' | 'refusal' | 'rejection' | 'empty' | 'thinking-only' | 'max-tokens' | 'refresh';
  status?: number;
  verdict?: string;
  chars?: number;
  stop?: string;
  toolUseIds?: string[];
  summary?: string;
}

export type Written = MessagesWritten | BedrockWritten | ResponsesWritten | ChatWritten;

interface RecordBase {
  id: string;
  seq: number;
  at: number;
  arrived: string;
  clock: number;
  step: string | null;
  kind: KindName | 'unclassified';
  agent?: string;
  reason?: string;
  answer?: AnswerRecord;
  refused?: string;
  usage?: unknown;
  tokens?: Tokens;
  untraced?: Array<{ token: string; givenBy: string[] }>;
  unordered?: Unordered[];
  tied?: string[];
  [field: string]: unknown;
}

type FieldOf<T> = T extends unknown ? keyof T : never;
export type Unwritten = { [K in FieldOf<Written>]?: undefined };

export type RequestRecord = RecordBase & (Written | Unwritten);

export interface Reply { content: Block[]; stop: string; stopSequence?: string; category?: string; error?: undefined; held?: undefined }
export interface Failure { error: { status: number; message: string; type?: string; headers?: Record<string, string> }; held?: undefined }
export interface Held { held: () => Reply | Failure; during?: unknown[]; canaries?: string[]; error?: undefined }
export type Answer = Reply | Failure | Held;

export interface Refusal { refused: string; status?: number; message: string; type?: string; param?: string; code?: string; failed?: string }

export type Fields = Record<string, unknown>;
export interface Unclassified { kind: 'unclassified'; reason: string; agent?: undefined; name?: undefined; resendOf?: undefined; fields?: (mask: Masker) => Fields; refusal?: Refusal | null }
export interface HostLine { ref: string; agent: string; at: bigint | null; needs: readonly string[] }
type Pending = { record: RequestRecord; body: unknown; again: (headers: IncomingHttpHeaders, mask: Masker) => Written; headers: IncomingHttpHeaders; writer: Codec; fields: ((mask: Masker) => Fields) | null; lessons: readonly string[] | null; query: string | null; path: string; base: string; resends?: string };

const headOf = (record: RequestRecord, query: string | null, path: string, writer: Codec) => {
  if (query !== null && record.head) record.head.query = query;
  if (path !== writer.path && record.head) record.head.path = path;
};
export interface Answering<F extends Fields = Fields> { kind: KindName; agent?: string; name?: string; resendOf?: string; forkAt?: number; reason?: undefined; fields?: (mask: Masker) => F; answer(record: RequestRecord & F): Answer }
export type Claim<F extends Fields = Fields> = Unclassified | Answering<F>;

export type Step = AgentStep & SummariserStep & JudgeStep;

export interface Kind {
  claim(view: ReadView): Claim | null;
  onStep?(step: Step): void;
  apis?: readonly string[];
}

export type Decoded = { view: View; reason?: undefined } | { reason: string; view?: undefined };
export type Read = { view: ReadView; reason?: undefined } | { reason: string; view?: undefined };

export type Admitted =
  | { reason: string; body: unknown; read?: undefined; record?: undefined }
  | { reason?: undefined; body: unknown; read: () => Read; record: ((headers: IncomingHttpHeaders, mask: Masker) => Written) | null };

export interface Sent { body: unknown; record: RequestRecord; content: Block[]; stop: string; stopSequence: string | null; category?: string | null; usage: unknown }

export interface Seed { dir: string | null; lessons: string[]; given: string[]; contexts: Record<string, AgentContext> }
interface AgentContext { codec: number; parts: ContextPart[]; withheld: ContextPart[] }
type Keyed = { key: string; born: boolean; mask: (v: unknown) => unknown; lessonKey: string };

const isParts = (v: unknown) => Array.isArray(v) && v.every((p) => p && typeof p === 'object' && typeof p.id === 'string' && /^[0-9a-f]{16}$/.test(p.id) && Number.isFinite(p.tokens) && p.tokens >= 0
  && typeof p.role === 'string' && typeof p.type === 'string' && (p.text === null || typeof p.text === 'string'));

type CodecOptions = { configuration: Configuration; clock: () => number; runDir: string | null; refreshes: boolean; uses: CacheUses | null };
const CODECS: Array<(o: CodecOptions) => Codec> = [
  (o) => anthropic(o),
  ({ refreshes: _, ...o }) => responses(o),
  ({ refreshes: _, ...o }) => responses({ ...o, backend: 'codex' }),
  ({ refreshes: _, ...o }) => chat({ ...o, dialect: 'openai' }),
  ({ refreshes: _, ...o }) => chat({ ...o, dialect: 'deepseek' }),
  ({ refreshes: _, ...o }) => chat({ ...o, dialect: 'openrouter' }),
  (o) => bedrock(o),
];

export function seedOf(text: string): Seed {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`it isn't JSON: ${(e as Error).message}`); }
  const o = v as Partial<Seed> | null;
  const strings = (a: unknown) => Array.isArray(a) && a.every((s) => typeof s === 'string' && s !== '');
  if (!o || typeof o !== 'object' || !(o.dir === null || typeof o.dir === 'string') || !strings(o.lessons) || !strings(o.given)
    || !o.contexts || typeof o.contexts !== 'object' || Array.isArray(o.contexts)) {
    throw new Error("it isn't a seed: an object with `dir`, `lessons` (each a lesson id), `given` (each a token its build's answers gave) and `contexts`");
  }
  for (const [key, c] of Object.entries(o.contexts)) {
    if (!c || !Number.isInteger(c.codec) || c.codec < 0 || c.codec >= CODECS.length || !isParts(c.parts) || !isParts(c.withheld)) throw new Error(`${key}'s context isn't a codec index with its parts and withheld parts`);
  }
  return o as Seed;
}

export interface Codec {
  path: string | null;
  routes(method: string | undefined, path: string): boolean;
  admit(body: unknown, path: string): Admitted;
  refusal(body: unknown): Refusal | null;
  seal(content: Block[], body: unknown): Block[];
  shown(content: Block[]): Block[];
  usage(body: unknown, outputTokens: number, content: Block[], who?: string | null): unknown;
  tokens(usage: unknown): Tokens;
  send(res: ServerResponse, sent: Sent): void;
  error(res: ServerResponse, status: number | undefined, message: string, details?: Omit<Refusal, 'refused' | 'status' | 'message'> & { headers?: Record<string, string> }): void;
  countTokens(body: unknown): number;
  context(body: unknown, mask: (v: unknown) => unknown, memo?: PartMemo | null): { parts: ContextPart[]; withheld: ContextPart[] };
}

export interface Configuration extends AgentConfiguration {
  windowTokens: number;
  account?: string;
  thinkingWrappedSummaries?: boolean;
  recording?: boolean;
}

export interface RequestEvent { id: string; seq: number; kind: RequestRecord['kind']; reason?: string; agent?: string; step: string | null; at: number; clock: number }
export interface HeldEvent { id: string; agent?: string; step: string | null; during?: unknown[]; canaries?: string[] }

export function tokensSent(records: ReadonlyArray<{ tokens?: Tokens }>): Tokens {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { tokens } of records) {
    if (!tokens) continue;
    for (const k of Object.keys(sum) as Figure[]) sum[k] += tokens[k];
  }
  return sum;
}

const decodedBy = <B>(checked: value.Checked<B>, decode: (body: B | null) => Decoded): Decoded => (checked.reason !== undefined ? { reason: checked.reason } : decode(checked.body));
const DECODERS: Record<string, (body: unknown) => Decoded> = {
  messages: (body) => decodedBy(value.check('Messages', MESSAGES_ROWS, body), decodeMessages),
  responses: (body) => decodedBy(value.check('Responses', RESPONSES_ROWS, body), (b) => decodeResponses(b, 'api')),
  codex: (body) => decodedBy(value.check('Codex', CODEX_ROWS, body), (b) => decodeResponses(b, 'codex')),
  'chat-completions': (body) => decodedBy(value.check('Chat Completions', CHAT_ROWS, body), decodeChat),
};

export function decoded(api: string | null, body: unknown): Decoded {
  try {
    return (api === null ? undefined : DECODERS[api]?.(body)) ?? { reason: `no codec writes the API ${JSON.stringify(api ?? null)}` };
  } catch (e) {
    return { reason: threw('read', e) };
  }
}

export function keptBody(dir: string, id: string, api: string | null, reason: string | null = null): Decoded {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return { reason: `the stand-in kept no body for it${reason ? `: ${reason}` : ''}` };
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf-8'), asWritten); } catch (e) { return { reason: `its kept body isn't JSON: ${(e as Error).message}` }; }
  if (api === null && reason !== null) return { reason };
  const read = decoded(api, body);
  return read.view ? read : { reason: `its body couldn't be read as the ${api} API: ${read.reason}` };
}

export const EMPTY = '/empty';

export const parsedBody = (raw: string): unknown => markParsed(JSON.parse(raw, (key: string, value: unknown, context?: { source: string }) => {
  const v = asWritten(key, value, context);
  return v !== null && typeof v === 'object' && !JSON.isRawJSON(v) ? Object.freeze(v) : v;
}));

const threw = (what: string, e: unknown) => `the stand-in couldn't ${what} it: ${(e as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(e as Partial<Error> | null | undefined)?.message ?? String(e)}`;

export async function startStandin({ configuration, rawDir = null, runDir = null, refuseMerges = false, rejectMerges = false, refuseContent = false, refusalCategory = null, seed = null, heldCloseOnWait = false, summaryTokens = null, refreshes = false, ...rest }: { configuration: Configuration; rawDir?: string | null; runDir?: string | null; refuseMerges?: boolean; rejectMerges?: boolean; refuseContent?: boolean; refusalCategory?: string | null; seed?: Seed | null; heldCloseOnWait?: boolean; summaryTokens?: Record<number, number> | null; refreshes?: boolean }) {
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`the stand-in takes no setup option ${unknown.map((k) => `\`${k}\``).join(', ')}`);
  const config = { ...configuration };
  const contexts = new Map<string, AgentContext>(Object.entries(seed?.contexts ?? {}));
  const known = new Map<string, { lessonKey: string; parts: Map<string, ReadPart> }>();
  const builtIn = seed?.dir ? [seed.dir] : [];
  const remembered = new Set<string>(seed?.lessons ?? []);
  const t0 = performance.now();
  const records: RequestRecord[] = [];
  const named = new Map<string, number>();
  const unique = (name: string) => {
    const n = (named.get(name) ?? 0) + 1;
    named.set(name, n);
    return n === 1 ? name : `${name}-${n}`;
  };
  const counts = new Map<string, number>();
  const counted = (who: string) => {
    const key = `${step?.id ?? ''}\u0000${who}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return unique(stepName(step?.id ?? null, who, counts.get(key)!));
  };
  const traces = new Map<RequestRecord, Trace>();
  const seeded = new Set<string>(seed?.given ?? []);
  const reissued: Array<{ request: string; ids: string[] }> = [];
  const pending: Pending[] = [];
  const codexKeys = new Map<string, number>();
  const epochs = new Map<string, number>();
  const listeners: Array<(event: RequestEvent) => void> = [];
  const sockets = new Set<Socket>();
  let step: Step | null = null;
  let clock = 0;
  const held = new Map<string, () => void>();
  const closedHeld = new Set<string>();
  const closeWaiters = new Map<string, ((came: boolean) => void)[]>();
  const untaken = new Map<string, { take: () => void; record: RequestRecord }>();
  let closing = false;
  const heldListeners: Array<(event: HeldEvent) => void> = [];
  const uses: CacheUses = new Map();
  const codecsOf = (kept: CacheUses | null): Codec[] => CODECS.map((make) => make({ configuration: config, clock: () => clock, runDir, refreshes, uses: kept }));
  const codecs = codecsOf(uses);
  const agents = agent({ configuration: config });
  const kinds: Kind[] = [...(refreshes ? [keepalive()] : []), judge(), review(), retrieval(), naming(), transition(), summariser({ refuseMerges, rejectMerges, refuseContent, refusalCategory, thinkingWrapped: config.thinkingWrappedSummaries === true, summaryTokens }), agents];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  const contextOf = (claim: Answering, view: ReadView, mask: (v: unknown) => unknown, lessonKey: string): Keyed => {
    const agent = claim.agent ?? 'primary';
    if (agent === 'primary') return { key: agent, born: false, mask, lessonKey };
    if (claim.forkAt !== undefined) return { key: `${agent} ${partId(view.messages.slice(0, claim.forkAt + 1), mask)}`, born: false, mask, lessonKey };
    return { key: `${agent} ${partId(view.system, mask)}`, born: !view.messages.some((m) => m.role === 'assistant'), mask, lessonKey };
  };
  function carried({ key: context, born }: Keyed, codec: number, parts: ContextPart[], withheld: ContextPart[], record: RequestRecord) {
    const before = born ? undefined : contexts.get(context);
    if (before && before.codec !== codec) record.apiChanged = true;
    else {
      const seam = seamOf(before?.parts ?? null, parts, before?.withheld, withheld);
      if (seam > 0) record.seam = seam;
    }
    contexts.set(context, { codec, parts, withheld });
  }

  function classify(view: ReadView, api: string | null) {
    for (const kind of kinds) {
      if (kind.apis && (api === null || !kind.apis.includes(api))) continue;
      const claim = kind.claim(view);
      if (claim) return claim;
    }
  }

  function reply(res: ServerResponse, codec: Codec, body: unknown, view: ReadView, record: RequestRecord, answer: Reply, context: Keyed | null) {
    const sealed = codec.seal(answer.content, body);
    const shaped = sealed.length !== answer.content.length || sealed.some((b, i) => b.type === 'thinking' && b.thinking !== answer.content[i]?.thinking);
    const fit = fitToMaxTokens(sealed, view.maxTokens!);
    const content = fit.content;
    const stop = fit.cut ? 'max_tokens' : answer.stop;
    const stopSequence = fit.cut ? null : answer.stopSequence ?? null;
    if (fit.cut || shaped) Object.assign(record.answer!, { stop, chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), ...(record.answer!.toolUseIds ? { toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id!) } : {}) });
    const outputTokens = record.kind === 'keepalive' ? 0 : content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = codec.usage(body, stop === 'max_tokens' && view.maxTokens ? view.maxTokens : outputTokens, content, record.id);
    record.usage = usage;
    record.tokens = codec.tokens(usage);
    if (rawDir) writeFileSync(join(rawDir, `${record.id}.answer.json`), JSON.stringify(content));
    const trace = traces.get(record);
    if (trace) Object.assign(trace, { gives: new Set([...heldBy(codec.shown(content))].filter((t) => !trace.carries.has(t) && !seeded.has(t))), began: process.hrtime.bigint() });
    if (trace) res.once('finish', () => { trace.ended = process.hrtime.bigint(); });
    const again = content.filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && seeded.has(b.id)).map((b) => b.id as string);
    if (again.length) reissued.push({ request: record.id, ids: again });
    codec.send(res, { body, record, content, stop, stopSequence, category: answer.category ?? null, usage });
    if (context === null) return;
    try {
      const was = known.get(context.key);
      const memo = { known: was && was.lessonKey === context.lessonKey ? was.parts : null, next: new Map<string, ReadPart>() };
      const { parts, withheld } = codec.context(body, context.mask, memo);
      carried(context, codecs.indexOf(codec), parts, withheld, record);
      known.set(context.key, { lessonKey: context.lessonKey, parts: memo.next });
    } catch (e) {
      record.contextUnread = `request ${record.id}'s context couldn't be read: ${(e as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(e as Partial<Error> | null | undefined)?.message ?? String(e)}`;
      contexts.delete(context.key);
      known.delete(context.key);
    }
  }

  const emptyCodecs = codecsOf(null);
  let emptied = 0;
  function empty(req: IncomingMessage, res: ServerResponse, raw: string, url: string) {
    const id = `empty${++emptied}`;
    const path = url.slice(EMPTY.length).split('?')[0];
    const codec = emptyCodecs.find((c) => c.routes(req.method, path));
    const refuse = (status: number, why: string) => {
      const reason = `a fleet child's request, ${req.method} ${url}: ${why}`;
      for (const cb of listeners) cb({ id, seq: emptied, kind: 'unclassified', reason, step: step?.id ?? null, at: Math.round(performance.now() - t0), clock });
      if (!res.headersSent) (codec ?? emptyCodecs[0]).error(res, status, `stand-in: ${reason}`);
      else res.destroy();
    };
    if (!codec) return refuse(404, 'no model request the stand-in models goes there');
    let body: unknown;
    try { body = raw ? parsedBody(raw) : null; } catch { return refuse(400, 'its body isn\'t JSON'); }
    if (!value.isObject(body)) return refuse(400, 'its body isn\'t a JSON object');
    const admitted = codec.admit(body, path);
    if (admitted.reason !== undefined) return refuse(400, admitted.reason);
    body = admitted.body;
    try {
      codec.send(res, { body, record: { id } as RequestRecord, content: [], stop: 'end_turn', stopSequence: null, usage: codec.usage(body, 1, []) });
    } catch (e) { refuse(400, threw('answer', e)); }
  }

  function handle(req: IncomingMessage, res: ServerResponse, raw: string, arrived: string) {
    const whole = process.hrtime.bigint();
    const url = req.url || '';
    if (url.startsWith(`${EMPTY}/`)) return empty(req, res, raw, url);
    const path = url.split('?')[0];
    // A query selects an endpoint's behaviour (Anthropic's SDK's beta messages add `?beta=true`), so the head keeps one.
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
    let body: unknown = null;
    try { body = raw ? parsedBody(raw) : null; } catch { body = null; }
    const seq = records.length + 1;
    let id: string;
    let classMask: ReturnType<typeof runVaryingClass>;
    let lessonKey = '';
    let lessons: readonly string[] | null = null;
    let unmaskable: string | null = null;
    try {
      lessons = runDir ? lessonIds(runDir) : null;
      classMask = runVaryingClass(runDir, builtIn, remembered, lessons);
      lessonKey = classMask.lessonKey;
    } catch (e) {
      unmaskable = `its run's records can't be masked: ${(e as Error).message}`;
      classMask = runVaryingClass(null);
    }
    const codec = codecs.find((c) => c.routes(req.method, path)) ?? null;
    const writer = codec ?? codecs[0];
    const at = Math.round(performance.now() - t0);
    let read: Read | undefined, claim: Claim, record: RequestRecord, context: Keyed | null = null, kept: Pending | null = null;
    try {
      const admitted = writer.admit(body, path);
      body = admitted.body;
      read = unmaskable ? { reason: unmaskable } : !codec ? { reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` } : admitted.reason !== undefined ? { reason: admitted.reason } : admitted.read();
      const written = admitted.record ? admitted.record(req.headers, classMask) : {} as Unwritten;
      claim = read.view ? classify(read.view, (written as { head?: { api?: string } }).head?.api ?? null)! : { kind: 'unclassified', reason: read.reason };
      const fields = claim.fields ? claim.fields(classMask) : null;
      const base = claim.name ?? (fields ? fieldsName(claim.kind, fields) : null);
      id = base ? unique(base) : counted(claim.kind);
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, ...(claim.agent ? { agent: claim.agent } : {}), ...(claim.reason ? { reason: claim.reason } : {}), ...written, ...fields };
      headOf(record, query, path, writer);
      if (admitted.record && !unmaskable) kept = { record, body, again: admitted.record, headers: req.headers, writer, fields: claim.fields ?? null, lessons, query, path, base: base ?? id, ...(claim.resendOf ? { resends: claim.resendOf } : {}) };
      if (claim.kind === 'agent') context = contextOf(claim as Answering, read.view!, classMask, lessonKey);
    } catch (e) {
      claim = { kind: 'unclassified', reason: read?.reason ?? threw('read', e) };
      id = counted(claim.kind);
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, reason: claim.reason };
    }
    if (claim.kind === 'unclassified' && read?.view) {
      try { claim.refusal = codec!.refusal(body); } catch { claim.refusal = null; }
    }
    const { kind, reason } = claim;
    records.push(record);
    if (kept) pending.push(kept);
    traces.set(record, { carries: carriedBy(body), whole });
    if (rawDir) writeFileSync(join(rawDir, `${id}.json`), raw);
    for (const cb of listeners) cb({ id, seq, kind, ...(reason ? { reason } : {}), ...(claim.agent ? { agent: claim.agent } : {}), step: record.step, at: record.at, clock });
    if (kind === 'unclassified') {
      record.answer = { shape: 'refused' };
      if (claim.refusal) {
        record.refused = claim.refusal.refused;
        return codec!.error(res, claim.refusal.status, claim.refusal.message, claim.refusal);
      }
      return writer.error(res, codec ? 400 : 404, `stand-in: unclassified request ${id}: ${reason}`);
    }
    const answering = (fn: () => void) => {
      try { fn(); } catch (e) {
        Object.assign(record, { kind: 'unclassified', reason: threw('answer', e), answer: { shape: 'refused' } });
        for (const cb of listeners) cb({ id, seq, kind: record.kind, reason: record.reason, step: record.step, at: record.at, clock });
        if (!res.headersSent) writer.error(res, 400, `stand-in: unclassified request ${id}: ${record.reason}`);
        else res.destroy();
      }
    };
    answering(() => {
      const refusal = codec!.refusal(body);
      if (refusal) {
        record.refused = refusal.refused;
        record.answer = { shape: 'refused' };
        return codec!.error(res, refusal.status, refusal.message, refusal);
      }
      const answer = claim.answer(record);
      if (answer.error) return codec!.error(res, answer.error.status, answer.error.message, { type: answer.error.type, headers: answer.error.headers });
      if (answer.held) {
        let cut = false;
        res.on('close', () => {
          if (res.writableEnded || closing) return;
          const seen = () => {
            cut = true;
            closedHeld.add(id);
            for (const w of closeWaiters.get(id) ?? []) w(true);
            closeWaiters.delete(id);
          };
          if (heldCloseOnWait && !closeWaiters.has(id)) untaken.set(id, { take: () => { untaken.delete(id); seen(); }, record });
          else seen();
        });
        held.set(id, () => {
          if (cut) record.answer = { shape: 'cut' };
          else answering(() => {
            const late = answer.held();
            if (late.error) return codec!.error(res, late.error.status, late.error.message, { type: late.error.type, headers: late.error.headers });
            return reply(res, codec!, body, read!.view!, record, late, context);
          });
        });
        for (const cb of heldListeners) cb({ id, agent: claim.agent, step: record.step, ...(answer.during ? { during: answer.during } : {}), ...(answer.canaries ? { canaries: answer.canaries } : {}) });
        return;
      }
      reply(res, codec!, body, read!.view!, record, answer, context);
    });
  }

  function endStep(lines: readonly HostLine[] = [], primary: string | null = null, wrote: ReadonlyMap<string, string> = new Map(), managers: ReadonlySet<string> = new Set()): string[] {
    const these = pending.splice(0);
    if (!these.length && !lines.length) return [];
    const byName = new Map(these.map((p) => [p.record.id, p]));
    const labels = new Set([...records.filter((r) => r.kind === 'agent').map((r) => r.agent ?? 'primary'), ...(step?.subs ?? []).flatMap((s) => (s.as === undefined ? [] : [s.as]))]);
    const labelOf = (host: string) => (host === primary ? 'primary' : labels.has(spawnName(host) ?? '') ? spawnName(host)! : 'sub');
    const shared = new Map<string, number>();
    for (const p of these) shared.set(p.base, (shared.get(p.base) ?? 0) + 1);
    const lineOf = (p: Pending): OrderLine => {
      const t = traces.get(p.record);
      const carries = t?.carries ?? new Set<string>();
      return {
        ref: p.record.id,
        agent: p.record.kind === 'agent' ? p.record.agent ?? 'primary' : null,
        request: true,
        carries,
        gives: t?.gives ?? new Set(),
        base: p.base,
        ...(p.resends ? { resends: p.resends } : {}),
      };
    };
    const chains = new Map<string, OrderLine[]>();
    const free: OrderLine[] = [];
    const wholeOf = (p: Pending) => traces.get(p.record)?.whole ?? BigInt(p.record.arrived);
    for (const p of [...these].sort((a, b) => (wholeOf(a) < wholeOf(b) ? -1 : wholeOf(a) > wholeOf(b) ? 1 : 0))) {
      const l = lineOf(p);
      if (l.agent === null) free.push(l);
      else chains.set(l.agent, [...(chains.get(l.agent) ?? []), l]);
    }
    for (const h of lines) {
      const agent = labelOf(h.agent);
      const chain = chains.get(agent) ?? [];
      const line: OrderLine = { ref: h.ref, agent, request: false, carries: new Set(), gives: new Set(), needs: h.needs };
      const at = h.at === null ? -1 : chain.findIndex((l) => l.request && BigInt(byName.get(l.ref)!.record.arrived) > h.at!);
      chain.splice(at < 0 ? chain.length : at, 0, line);
      chains.set(agent, chain);
    }
    let written = 0;
    const writeThrough = (refs: readonly string[]) => {
      for (; written < refs.length; written++) {
        const p = byName.get(refs[written]);
        if (!p) continue;
        try {
          const mask = runVaryingMasker(codexKeys, { runDir, epochs, lessons: p.lessons });
          Object.assign(p.record, p.again(p.headers, mask), p.fields ? p.fields(mask) : null);
          headOf(p.record, p.query, p.path, p.writer);
        } catch (e) {
          Object.assign(p.record, { kind: 'unclassified', reason: threw('mask', e) });
        }
      }
    };
    const textAt = (l: OrderLine, before: readonly string[]) => {
      const p = byName.get(l.ref);
      if (!p || shared.get(p.base)! < 2) return '';
      writeThrough(before);
      return JSON.stringify(runVaryingClass(runDir, builtIn, remembered, p.lessons, { keys: codexKeys, epochs }).request(p.body));
    };
    const ties: Array<[Pending, Pending]> = [];
    const order = orderStep([...[...chains.values()].flat(), ...free], textAt, (a, b) => ties.push([byName.get(a)!, byName.get(b)!]));
    writeThrough(order);
    if (config.recording === false) return order;
    for (const [p, q] of ties) {
      if (JSON.stringify(p.body) === JSON.stringify(q.body)) continue;
      p.record.tied = [...(p.record.tied ?? []), q.record.id];
      q.record.tied = [...(q.record.tied ?? []), p.record.id];
    }
    const guarded = these.flatMap((p) => {
      const t = traces.get(p.record);
      const r = p.record;
      return t ? [{ id: r.id, kind: r.kind, agent: r.kind === 'agent' ? r.agent ?? 'primary' : null, arrived: BigInt(r.arrived), whole: t.whole, began: t.began, ended: t.ended, carries: t.carries, gives: t.gives ?? new Set<string>(), use: uses.get(r.id) }] : [];
    });
    const oneManager = primary !== null && [...managers].every((m) => m === primary) && records.every((r) => r.kind !== 'agent' || (r.agent ?? 'primary') === 'primary');
    for (const [id, found] of unorderedUses(guarded, wrote, oneManager, giversOf(traces.values()))) byName.get(id)!.record.unordered = found;
    return order;
  }

  const server = createServer((req, res) => {
    const arrived = String(process.hrtime.bigint());
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handle(req, res, raw, arrived));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  // Under HTTPS_PROXY (recipe.ts hostEnv), Bun's fetch in the host asks the stand-in to tunnel a request that would
  // leave the machine.
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    const seq = records.length + 1;
    const record: RequestRecord = { id: counted('unclassified'), seq, at: Math.round(performance.now() - t0), arrived: String(process.hrtime.bigint()), clock, step: step?.id ?? null, kind: 'unclassified', reason: `it asks the stand-in to tunnel to ${req.url}, a request that would leave the machine`, answer: { shape: 'refused' } };
    records.push(record);
    for (const cb of listeners) cb({ id: record.id, seq, kind: record.kind, reason: record.reason, step: record.step, at: record.at, clock });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setStep(next: Step) { step = next; for (const kind of kinds) kind.onStep?.(next); },
    endStep,
    setClock(ms: number) { clock = ms; },
    countTokens(body: unknown) { return codecs[0].countTokens(body); },
    onRequest(cb: (event: RequestEvent) => void) { listeners.push(cb); },
    onHeld(cb: (event: HeldEvent) => void) { heldListeners.push(cb); },
    whenHeldClosed(id: string): Promise<'seen' | 'came' | 'never'> {
      if (closedHeld.has(id)) return Promise.resolve('seen');
      if (closing) return Promise.resolve('never');
      return new Promise((resolve) => {
        closeWaiters.set(id, [...(closeWaiters.get(id) ?? []), (came) => resolve(came ? 'came' : 'never')]);
        untaken.get(id)?.take();
      });
    },
    releaseHeld(id: string) {
      const send = held.get(id);
      held.delete(id);
      send?.();
      return send !== undefined;
    },
    async close() {
      closing = true;
      for (const { record } of untaken.values()) record.closeUntaken = true;
      untaken.clear();
      for (const w of [...closeWaiters.values()].flat()) w(false);
      await new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      endStep();
      for (const [record, broken] of untraced(traces)) record.untraced = broken.map(({ token, givenBy }) => ({ token, givenBy: givenBy.map((r) => r.id) }));
      return records;
    },
    reissued() { return reissued.splice(0); },
    seed(): Seed {
      const given = new Set(seeded);
      for (const t of traces.values()) for (const token of t.gives ?? []) given.add(token);
      return { dir: runDir, lessons: [...remembered], given: [...given].sort(), contexts: Object.fromEntries(contexts) };
    },
  };
}
