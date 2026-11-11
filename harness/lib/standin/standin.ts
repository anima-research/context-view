import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lessonIds, runVaryingClass, runVaryingMasker } from '../strategies/compare.ts';
import { asWritten } from '../strategies/control.ts';
import { agent } from './agent.ts';
import { anthropic, decodeMessages } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { chat, decodeChat } from './chat.ts';
import { judge, type JudgeStep } from './judge.ts';
import { keepalive } from './keepalive.ts';
import { naming } from './naming.ts';
import { decodeResponses, responses } from './responses.ts';
import { retrieval } from './retrieval.ts';
import { review } from './review.ts';
import { partId, seamOf } from './seams.ts';
import { summariser } from './summariser.ts';
import { transition } from './transition.ts';
import { blockTokens, fitToMaxTokens } from './tokens.ts';
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
import { markParsed } from './view.ts';
import type { Block, ReadView, View } from './view.ts';

export type Tokens = Record<Figure, number>;

export type KindName = 'judge' | 'review' | 'concepts' | 'relevance' | 'naming' | 'transition' | 'summariser' | 'agent' | 'probe' | 'keepalive';

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
  [field: string]: unknown;
}

type FieldOf<T> = T extends unknown ? keyof T : never;
export type Unwritten = { [K in FieldOf<Written>]?: undefined };

export type RequestRecord = RecordBase & (Written | Unwritten);

export interface Reply { content: Block[]; stop: string; stopSequence?: string; error?: undefined; held?: undefined }
export interface Failure { error: { status: number; message: string; type?: string; headers?: Record<string, string> }; held?: undefined }
export interface Held { held: () => Reply | Failure; during?: unknown[]; canaries?: string[]; error?: undefined }
export type Answer = Reply | Failure | Held;

export interface Refusal { refused: string; status?: number; message: string; type?: string; param?: string; code?: string; failed?: string }

export type Fields = Record<string, unknown>;
export interface Unclassified { kind: 'unclassified'; reason: string; agent?: undefined; fields?: (mask: Masker) => Fields; refusal?: Refusal | null }
export interface Answering<F extends Fields = Fields> { kind: KindName; agent?: string; forkAt?: number; reason?: undefined; fields?: (mask: Masker) => F; answer(record: RequestRecord & F): Answer }
export type Claim<F extends Fields = Fields> = Unclassified | Answering<F>;

export type Step = AgentStep & SummariserStep & JudgeStep;

export interface Kind {
  claim(view: ReadView): Claim | null;
  onStep?(step: Step): void;
  /** The APIs whose requests it may claim, by their record's `head.api`; every API's when absent. */
  apis?: readonly string[];
}

export type Decoded = { view: View; reason?: undefined } | { reason: string; view?: undefined };
export type Read = { view: ReadView; body?: unknown; reason?: undefined } | { reason: string; body?: unknown; view?: undefined };

export interface Sent { body: unknown; record: RequestRecord; content: Block[]; stop: string; stopSequence: string | null; usage: unknown }

/** Each agent's context at its last answered request, by the key `startStandin` gives it (the codec that read it, its
 *  parts, and the parts it sent that its model didn't get), the run directory its stand-in masked as the run's own, and
 *  how many tool ids its stand-in made, which a run from it goes on from. */
export interface Seed { dir: string | null; lessons: string[]; toolIds: number; contexts: Record<string, AgentContext> }
interface AgentContext { codec: number; parts: ContextPart[]; withheld: ContextPart[] }
type Keyed = { key: string; born: boolean; mask: (v: unknown) => unknown; lessonKey: string };

const isParts = (v: unknown) => Array.isArray(v) && v.every((p) => p && typeof p === 'object' && typeof p.id === 'string' && /^[0-9a-f]{16}$/.test(p.id) && Number.isFinite(p.tokens) && p.tokens >= 0
  && typeof p.role === 'string' && typeof p.type === 'string' && (p.text === null || typeof p.text === 'string'));

/** A checkpoint's `seed.json`, read whole, or an error saying what in it isn't a seed. */
type CodecOptions = { configuration: Configuration; clock: () => number; runDir: string | null; refreshes: boolean };
// Each API the stand-in answers, in the order it tries them; a seed's context names its codec by its place here.
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
  if (!o || typeof o !== 'object' || !(o.dir === null || typeof o.dir === 'string') || !Array.isArray(o.lessons) || !o.lessons.every((l) => typeof l === 'string' && l !== '')
    || !Number.isSafeInteger(o.toolIds) || o.toolIds! < 0
    || !o.contexts || typeof o.contexts !== 'object' || Array.isArray(o.contexts)) {
    throw new Error("it isn't a seed: an object with `dir`, `lessons` (each a lesson id), `toolIds` (how many tool ids its stand-in made) and `contexts`");
  }
  for (const [key, c] of Object.entries(o.contexts)) {
    if (!c || !Number.isInteger(c.codec) || c.codec < 0 || c.codec >= CODECS.length || !isParts(c.parts) || !isParts(c.withheld)) throw new Error(`${key}'s context isn't a codec index with its parts and withheld parts`);
  }
  return o as Seed;
}

export interface Codec {
  path: string | null;
  routes(method: string | undefined, path: string): boolean;
  read(body: unknown, path: string): Read;
  record(body: unknown, headers: IncomingHttpHeaders, mask: Masker): Written;
  refusal(body: unknown): Refusal | null;
  seal(content: Block[], body: unknown): Block[];
  usage(body: unknown, outputTokens: number, content: Block[]): unknown;
  tokens(usage: unknown): Tokens;
  send(res: ServerResponse, sent: Sent): void;
  error(res: ServerResponse, status: number | undefined, message: string, details?: Omit<Refusal, 'refused' | 'status' | 'message'> & { headers?: Record<string, string> }): void;
  countTokens(body: unknown): number;
  /** What a request's model reads of it, as parts, and the parts it sends that its model doesn't get. */
  context(body: unknown, mask: (v: unknown) => unknown, memo?: PartMemo | null): { parts: ContextPart[]; withheld: ContextPart[] };
}

export interface Configuration extends AgentConfiguration {
  windowTokens: number;
  account?: string;
  thinkingWrappedSummaries?: boolean;
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

// A body read into the view the stand-in's kinds answer from, by the API its record's head names, without the checks
// the stand-in serves by: a request it refused is still read.
const DECODERS: Record<string, (body: never) => Decoded> = { messages: decodeMessages, responses: (body) => decodeResponses(body, 'api'), codex: (body) => decodeResponses(body, 'codex'), 'chat-completions': decodeChat };

export function decoded(api: string, body: unknown): Decoded {
  try {
    return DECODERS[api]?.(body as never) ?? { reason: `no codec writes the API ${JSON.stringify(api ?? null)}` };
  } catch (e) {
    return { reason: threw('read', e) };
  }
}

// A request's body as the stand-in kept it in `dir`, read by `decoded`; or why there's none to read: a refused tunnel
// keeps no body, so the reason is its record's.
export function keptBody(dir: string, id: string, api: string, reason: string | null = null): Decoded {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return { reason: `the stand-in kept no body for it${reason ? `: ${reason}` : ''}` };
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf-8'), asWritten); } catch (e) { return { reason: `its kept body isn't JSON: ${(e as Error).message}` }; }
  const read = decoded(api, body);
  return read.view ? read : { reason: `its body couldn't be read as the ${api} API: ${read.reason}` };
}

// The base path of a fleet child's model, which answers every request empty (startStandin's `empty`).
export const EMPTY = '/empty';

// A codec that throws on a body is a body it can't read or answer: the request is refused as unclassified with the
// exception as its reason, which check 1 flags, so a codec's gap shows in the run's record rather than ending it.
// A request's body as the stand-in reads it: parsed with every object and array in it frozen, so nothing that reads it can
// change it, and what a codec builds from a body can be kept by the body for the rest of its request (anthropic.ts).
export const parsedBody = (raw: string): unknown => markParsed(JSON.parse(raw, (key: string, value: unknown, context?: { source: string }) => {
  const v = asWritten(key, value, context);
  return v !== null && typeof v === 'object' && !JSON.isRawJSON(v) ? Object.freeze(v) : v;
}));

const threw = (what: string, e: unknown) => `the stand-in couldn't ${what} it: ${(e as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(e as Partial<Error> | null | undefined)?.message ?? String(e)}`;

// `heldCloseDelayMs`, 0 in every run, is how long after a held call's connection closes the stand-in takes it as closed: a
// test sets it so the close reaches the stand-in after the host's own report of the cut, as it can when the harness's
// event loop is busy.
// `summaryTokens` and `refreshes` are a workloads module's (run.ts --workloads): a summary's length by level, and keepalive
// refreshes answered (keepalive.ts). Every run of the view's own leaves both out. An option it doesn't take is refused,
// naming it: drive.ts spreads a workload's `standin(variant)` in, so a module naming an option this renamed or dropped
// fails its drive rather than running without it.
export async function startStandin({ configuration, rawDir = null, runDir = null, refuseMerges = false, rejectMerges = false, refuseContent = false, seed = null, heldCloseDelayMs = 0, summaryTokens = null, refreshes = false, ...rest }: { configuration: Configuration; rawDir?: string | null; runDir?: string | null; refuseMerges?: boolean; rejectMerges?: boolean; refuseContent?: boolean; seed?: Seed | null; heldCloseDelayMs?: number; summaryTokens?: Record<number, number> | null; refreshes?: boolean }) {
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`the stand-in takes no setup option ${unknown.map((k) => `\`${k}\``).join(', ')}`);
  const config = { ...configuration };
  const contexts = new Map<string, AgentContext>(Object.entries(seed?.contexts ?? {}));
  // Each context's previous request's parts as read, under the lesson ids its masker was made with, in its pattern's
  // order. Never part of the seed: a run from a checkpoint reads its first requests whole.
  const known = new Map<string, { lessonKey: string; parts: Map<string, ReadPart> }>();
  // The directory the seed's stand-in ran in, such as a checkpoint's build: text the run replays from its copied store
  // quotes it, so the run masks it as its own.
  const builtIn = seed?.dir ? [seed.dir] : [];
  // Every lesson id the run's stand-ins have read, the seed's build's among them: text quoting one that the lessons file
  // has since lost is masked as it was when it was first carried.
  const remembered = new Set<string>(seed?.lessons ?? []);
  const t0 = performance.now();
  const records: RequestRecord[] = [];
  // A Codex cache key's number in this run's record, by first appearance (compare.ts, CODEX_KEY).
  const codexKeys = new Map<string, number>();
  // A reader fork's epoch in this run's requests, by first appearance (compare.ts, READER_EPOCH).
  const epochs = new Map<string, number>();
  const listeners: Array<(event: RequestEvent) => void> = [];
  const sockets = new Set<Socket>();
  let step: Step | null = null;
  let clock = 0;
  const held = new Map<string, () => void>();
  // Each held call whose client closed its connection before the stand-in answered it, which a release records as cut,
  // and those waiting to hear of it. A close the stand-in makes itself, at its own close, is no client's.
  const closedHeld = new Set<string>();
  const closeWaiters = new Map<string, ((came: boolean) => void)[]>();
  const closeTimers = new Set<ReturnType<typeof setTimeout>>();
  let closing = false;
  const heldListeners: Array<(event: HeldEvent) => void> = [];
  const codecsOf = (): Codec[] => CODECS.map((make) => make({ configuration: config, clock: () => clock, runDir, refreshes }));
  const codecs = codecsOf();
  const agents = agent({ configuration: config, toolIds: seed?.toolIds ?? 0 });
  const kinds: Kind[] = [...(refreshes ? [keepalive()] : []), judge(), review(), retrieval(), naming(), transition(), summariser({ refuseMerges, rejectMerges, refuseContent, thinkingWrapped: config.thinkingWrappedSummaries === true, summaryTokens }), agents];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  // Each agent's context: the primary's by its name; a reader fork's by its messages through its framing message; any other
  // agent's by its name and system prompt, its request born, compared with nothing, where it holds no assistant message.
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
    // A keepalive refresh (keepalive.ts) bills no output; every other answer bills at least one token.
    const outputTokens = record.kind === 'keepalive' ? 0 : content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = codec.usage(body, stop === 'max_tokens' && view.maxTokens ? view.maxTokens : outputTokens, content);
    record.usage = usage;
    record.tokens = codec.tokens(usage);
    if (rawDir) writeFileSync(join(rawDir, `${record.id}.answer.json`), JSON.stringify(content));
    codec.send(res, { body, record, content, stop, stopSequence, usage });
    if (context === null) return;
    try {
      // What the context's previous request read is taken again where its masker had this one's lesson ids, in the same
      // order. A part's reading is a function of its value, its text and those alone, so whose request kept it doesn't
      // matter: the context only bounds what is kept to one request's parts.
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

  // A fleet child's model (fleet.ts fleetChildren): a request under `/empty` is answered as its API answers a reply
  // with no content that ends the turn, and is neither recorded, kept nor told to the run, so a child's requests leave
  // the record as the parent's requests write it. It answers through codecs of its own, so it moves no state the
  // recorded requests are answered from, such as a codec's prompt cache. One the stand-in can't answer is refused, and
  // told to the run as an unclassified request is.
  const emptyCodecs = codecsOf();
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
    if (body === null || typeof body !== 'object') return refuse(400, 'its body isn\'t a JSON object');
    try {
      codec.send(res, { body, record: { id } as RequestRecord, content: [], stop: 'end_turn', stopSequence: null, usage: codec.usage(body, 1, []) });
    } catch (e) { refuse(400, threw('answer', e)); }
  }

  function handle(req: IncomingMessage, res: ServerResponse, raw: string, arrived: string) {
    const url = req.url || '';
    if (url.startsWith(`${EMPTY}/`)) return empty(req, res, raw, url);
    const path = url.split('?')[0];
    // A query selects an endpoint's behaviour (the SDK's beta messages add `?beta=true`), so the head keeps one.
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
    let body: unknown = null;
    try { body = raw ? parsedBody(raw) : null; } catch { body = null; }
    const seq = records.length + 1;
    const id = `r${seq}`;
    let mask: Masker;
    let classMask: ReturnType<typeof runVaryingClass>;
    // The lesson ids the class masker is made with, in the order its pattern tries them. Taken on this path alone, so
    // the fallback masker below, which a request reaches only as unclassified, is never kept against them.
    let lessonKey = '';
    let unmaskable: string | null = null;
    try {
      const lessons = runDir ? lessonIds(runDir) : null;
      mask = runVaryingMasker(codexKeys, { runDir, epochs, lessons });
      classMask = runVaryingClass(runDir, builtIn, remembered, lessons);
      lessonKey = classMask.lessonKey;
    } catch (e) {
      unmaskable = `its run's records can't be masked: ${(e as Error).message}`;
      mask = runVaryingMasker(codexKeys, { runDir: null, epochs });
      classMask = runVaryingClass(null);
    }
    const codec = codecs.find((c) => c.routes(req.method, path)) ?? null;
    const writer = codec ?? codecs[0];
    const at = Math.round(performance.now() - t0);
    let read: Read | undefined, claim: Claim, record: RequestRecord, context: Keyed | null = null;
    try {
      read = unmaskable ? { reason: unmaskable } : codec ? codec.read(body, path) : { reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` };
      // A codec whose API puts part of a request in its path (Bedrock's model and streaming) gives the body its other
      // members take.
      if (read.body) body = read.body;
      // Written before the request is classified, so a writer that throws leaves the step's scripted replies as they were.
      const written = body ? writer.record(body, req.headers, mask) : {} as Unwritten;
      claim = read.view ? classify(read.view, (written as { head?: { api?: string } }).head?.api ?? null)! : { kind: 'unclassified', reason: read.reason };
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, ...(claim.agent ? { agent: claim.agent } : {}), ...(claim.reason ? { reason: claim.reason } : {}), ...written };
      if (query !== null && record.head) record.head.query = query;
      if (path !== writer.path && record.head) record.head.path = path;
      if (claim.fields) Object.assign(record, claim.fields(mask));
      if (claim.kind === 'agent') context = contextOf(claim as Answering, read.view!, classMask, lessonKey);
    } catch (e) {
      // A read that already gave its reason keeps it; the writer's throw is on the same body.
      claim = { kind: 'unclassified', reason: read?.reason ?? threw('read', e) };
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, reason: claim.reason };
    }
    // A request the API refuses before any model reads it is refused so, whether or not the stand-in classifies it; a
    // refusal check that throws leaves it as the stand-in classified it.
    if (claim.kind === 'unclassified' && read?.view) {
      try { claim.refusal = codec!.refusal(body); } catch { claim.refusal = null; }
    }
    const { kind, reason } = claim;
    records.push(record);
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
    // Past the read, a throw while answering leaves the request recorded as unclassified, with the exception as its
    // reason, tells onRequest so, as it tells every unclassified request, and answers it as a stand-in error.
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
          if (heldCloseDelayMs > 0) {
            const t = setTimeout(() => { closeTimers.delete(t); seen(); }, heldCloseDelayMs);
            closeTimers.add(t);
          } else seen();
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

  const server = createServer((req, res) => {
    const arrived = String(process.hrtime.bigint());
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handle(req, res, raw, arrived));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  // A host under HTTPS_PROXY (recipe.ts hostEnv) asks the stand-in to tunnel a request that would leave the machine.
  // It tunnels nothing: the request is recorded unclassified, which fails the run, and refused.
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    const seq = records.length + 1;
    const record: RequestRecord = { id: `r${seq}`, seq, at: Math.round(performance.now() - t0), arrived: String(process.hrtime.bigint()), clock, step: step?.id ?? null, kind: 'unclassified', reason: `it asks the stand-in to tunnel to ${req.url}, a request that would leave the machine`, answer: { shape: 'refused' } };
    records.push(record);
    for (const cb of listeners) cb({ id: record.id, seq, kind: record.kind, reason: record.reason, step: record.step, at: record.at, clock });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setStep(next: Step) { step = next; for (const kind of kinds) kind.onStep?.(next); },
    setClock(ms: number) { clock = ms; },
    countTokens(body: unknown) { return codecs[0].countTokens(body); },
    onRequest(cb: (event: RequestEvent) => void) { listeners.push(cb); },
    onHeld(cb: (event: HeldEvent) => void) { heldListeners.push(cb); },
    /** When the stand-in takes held call `id`'s connection as closed by its client, so that its release records it as
     *  cut: `seen` where it already has, `came` once it does, and `never` once the stand-in closes first. */
    whenHeldClosed(id: string): Promise<'seen' | 'came' | 'never'> {
      if (closedHeld.has(id)) return Promise.resolve('seen');
      if (closing) return Promise.resolve('never');
      return new Promise((resolve) => {
        closeWaiters.set(id, [...(closeWaiters.get(id) ?? []), (came) => resolve(came ? 'came' : 'never')]);
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
      for (const t of closeTimers) clearTimeout(t);
      closeTimers.clear();
      for (const w of [...closeWaiters.values()].flat()) w(false);
      await new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      return records;
    },
    seed(): Seed { return { dir: runDir, lessons: [...remembered], toolIds: agents.toolIds(), contexts: Object.fromEntries(contexts) }; },
  };
}
