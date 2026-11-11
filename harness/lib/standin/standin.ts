import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runVaryingMasker } from '../strategies/compare.ts';
import { asWritten } from '../strategies/control.ts';
import { agent } from './agent.ts';
import { anthropic, decodeMessages } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { chat, decodeChat } from './chat.ts';
import { judge, type JudgeStep } from './judge.ts';
import { naming } from './naming.ts';
import { decodeResponses, responses } from './responses.ts';
import { retrieval } from './retrieval.ts';
import { review } from './review.ts';
import { summariser } from './summariser.ts';
import { transition } from './transition.ts';
import { blockTokens, fitToMaxTokens } from './tokens.ts';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Figure } from '../shapes.ts';
import type { Masker } from '../strategies/compare.ts';
import type { AgentConfiguration, AgentStep } from './agent.ts';
import type { MessagesWritten } from './anthropic.ts';
import type { BedrockWritten } from './bedrock.ts';
import type { ChatWritten } from './chat.ts';
import type { ResponsesWritten } from './responses.ts';
import type { SummariserStep } from './summariser.ts';
import type { Block, ReadView, View } from './view.ts';

export type Tokens = Record<Figure, number>;

export type KindName = 'judge' | 'review' | 'concepts' | 'relevance' | 'naming' | 'transition' | 'summariser' | 'agent' | 'probe';

export interface AnswerRecord {
  shape: 'refused' | 'cut' | 'error' | 'verdict' | 'reply' | 'summary' | 'refusal' | 'rejection' | 'empty' | 'thinking-only' | 'max-tokens';
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
export interface Answering<F extends Fields = Fields> { kind: KindName; agent?: string; reason?: undefined; fields?: (mask: Masker) => F; answer(record: RequestRecord & F): Answer }
export type Claim<F extends Fields = Fields> = Unclassified | Answering<F>;

export type Step = AgentStep & SummariserStep & JudgeStep;

export interface Kind {
  claim(view: ReadView): Claim | null;
  onStep?(step: Step): void;
}

export type Decoded = { view: View; reason?: undefined } | { reason: string; view?: undefined };
export type Read = { view: ReadView; body?: unknown; reason?: undefined } | { reason: string; body?: unknown; view?: undefined };

export interface Sent { body: unknown; record: RequestRecord; content: Block[]; stop: string; stopSequence: string | null; usage: unknown }

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
const threw = (what: string, e: unknown) => `the stand-in couldn't ${what} it: ${(e as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(e as Partial<Error> | null | undefined)?.message ?? String(e)}`;

export async function startStandin({ configuration, rawDir = null, runDir = null, refuseMerges = false, rejectMerges = false, refuseContent = false }: { configuration: Configuration; rawDir?: string | null; runDir?: string | null; refuseMerges?: boolean; rejectMerges?: boolean; refuseContent?: boolean }) {
  const config = { ...configuration };
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
  const heldListeners: Array<(event: HeldEvent) => void> = [];
  const codecsOf = (): Codec[] => [
    anthropic({ configuration: config, clock: () => clock, runDir }),
    responses({ configuration: config, clock: () => clock, runDir }),
    responses({ configuration: config, clock: () => clock, backend: 'codex', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'openai', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'deepseek', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'openrouter', runDir }),
    bedrock({ configuration: config, clock: () => clock, runDir }),
  ];
  const codecs = codecsOf();
  const kinds: Kind[] = [judge(), review(), retrieval(), naming(), transition(), summariser({ refuseMerges, rejectMerges, refuseContent, thinkingWrapped: config.thinkingWrappedSummaries === true }), agent({ configuration: config })];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  function classify(view: ReadView) {
    for (const kind of kinds) {
      const claim = kind.claim(view);
      if (claim) return claim;
    }
  }

  function reply(res: ServerResponse, codec: Codec, body: unknown, view: ReadView, record: RequestRecord, answer: Reply) {
    const sealed = codec.seal(answer.content, body);
    const shaped = sealed.length !== answer.content.length || sealed.some((b, i) => b.type === 'thinking' && b.thinking !== answer.content[i]?.thinking);
    const fit = fitToMaxTokens(sealed, view.maxTokens!);
    const content = fit.content;
    const stop = fit.cut ? 'max_tokens' : answer.stop;
    const stopSequence = fit.cut ? null : answer.stopSequence ?? null;
    if (fit.cut || shaped) Object.assign(record.answer!, { stop, chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), ...(record.answer!.toolUseIds ? { toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id!) } : {}) });
    const outputTokens = content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = codec.usage(body, stop === 'max_tokens' && view.maxTokens ? view.maxTokens : outputTokens, content);
    record.usage = usage;
    record.tokens = codec.tokens(usage);
    if (rawDir) writeFileSync(join(rawDir, `${record.id}.answer.json`), JSON.stringify(content));
    codec.send(res, { body, record, content, stop, stopSequence, usage });
  }

  // A fleet child's model (driver.ts fleetChildren): a request under `/empty` is answered as its API answers a reply
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
    try { body = raw ? JSON.parse(raw, asWritten) : null; } catch { return refuse(400, 'its body isn\'t JSON'); }
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
    try { body = raw ? JSON.parse(raw, asWritten) : null; } catch { body = null; }
    const seq = records.length + 1;
    const id = `r${seq}`;
    let mask: Masker;
    let unmaskable: string | null = null;
    try { mask = runVaryingMasker(codexKeys, { runDir, epochs }); } catch (e) {
      unmaskable = `its run's records can't be masked: ${(e as Error).message}`;
      mask = runVaryingMasker(codexKeys, { runDir: null, epochs });
    }
    const codec = codecs.find((c) => c.routes(req.method, path)) ?? null;
    const writer = codec ?? codecs[0];
    const at = Math.round(performance.now() - t0);
    let read: Read | undefined, claim: Claim, record: RequestRecord;
    try {
      read = unmaskable ? { reason: unmaskable } : codec ? codec.read(body, path) : { reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` };
      // A codec whose API puts part of a request in its path (Bedrock's model and streaming) gives the body its other
      // members take.
      if (read.body) body = read.body;
      // Written before the request is classified, so a writer that throws leaves the step's scripted replies as they were.
      const written = body ? writer.record(body, req.headers, mask) : {} as Unwritten;
      claim = read.view ? classify(read.view)! : { kind: 'unclassified', reason: read.reason };
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, ...(claim.agent ? { agent: claim.agent } : {}), ...(claim.reason ? { reason: claim.reason } : {}), ...written };
      if (query !== null && record.head) record.head.query = query;
      if (path !== writer.path && record.head) record.head.path = path;
      if (claim.fields) Object.assign(record, claim.fields(mask));
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
        res.on('close', () => { if (!res.writableEnded) cut = true; });
        held.set(id, () => {
          if (cut) record.answer = { shape: 'cut' };
          else answering(() => {
            const late = answer.held();
            if (late.error) return codec!.error(res, late.error.status, late.error.message, { type: late.error.type, headers: late.error.headers });
            return reply(res, codec!, body, read!.view!, record, late);
          });
        });
        for (const cb of heldListeners) cb({ id, agent: claim.agent, step: record.step, ...(answer.during ? { during: answer.during } : {}), ...(answer.canaries ? { canaries: answer.canaries } : {}) });
        return;
      }
      reply(res, codec!, body, read!.view!, record, answer);
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
  // A host under HTTPS_PROXY (driver.ts hostEnv) asks the stand-in to tunnel a request that would leave the machine.
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
    releaseHeld(id: string) {
      const send = held.get(id);
      held.delete(id);
      send?.();
      return send !== undefined;
    },
    async close() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      return records;
    },
  };
}
