import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runVaryingMasker } from '../strategies/compare.mjs';
import { agent } from './agent.mjs';
import { anthropic, decodeMessages } from './anthropic.mjs';
import { bedrock } from './bedrock.mjs';
import { chat, decodeChat } from './chat.mjs';
import { judge } from './judge.mjs';
import { decodeResponses, responses } from './responses.mjs';
import { summariser } from './summariser.mjs';
import { blockTokens, fitToMaxTokens } from './tokens.mjs';

export function tokensSent(records) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const { tokens } of records) {
    if (!tokens) continue;
    for (const k of Object.keys(sum)) sum[k] += tokens[k];
  }
  return sum;
}

// A body read into the view the stand-in's kinds answer from, by the API its record's head names, without the checks
// the stand-in serves by: a request it refused is still read.
const DECODERS = { messages: decodeMessages, responses: (body) => decodeResponses(body, 'api'), codex: (body) => decodeResponses(body, 'codex'), 'chat-completions': decodeChat };

export function decoded(api, body) {
  try {
    return DECODERS[api]?.(body) ?? { reason: `no codec writes the API ${JSON.stringify(api ?? null)}` };
  } catch (e) {
    return { reason: threw('read', e) };
  }
}

// A request's body as the stand-in kept it in `dir`, read by `decoded`; or why there's none to read: a refused tunnel
// keeps no body, so the reason is its record's.
export function keptBody(dir, id, api, reason = null) {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return { reason: `the stand-in kept no body for it${reason ? `: ${reason}` : ''}` };
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf-8')); } catch (e) { return { reason: `its kept body isn't JSON: ${e.message}` }; }
  const read = decoded(api, body);
  return read.view ? read : { reason: `its body couldn't be read as the ${api} API: ${read.reason}` };
}

// A codec that throws on a body is a body it can't read or answer: the request is refused as unclassified with the
// exception as its reason, which check 1 flags, so a codec's gap shows in the run's record rather than ending it.
const threw = (what, e) => `the stand-in couldn't ${what} it: ${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;

export async function startStandin({ configuration, rawDir = null, runDir = null, refuseMerges = false, rejectMerges = false, refuseContent = false }) {
  const config = { ...configuration };
  const t0 = performance.now();
  const records = [];
  // A Codex cache key's number in this run's record, by first appearance (compare.mjs, CODEX_KEY).
  const codexKeys = new Map();
  const listeners = [];
  const sockets = new Set();
  let step = null;
  let clock = 0;
  const held = [];
  const heldListeners = [];
  const codecs = [
    anthropic({ configuration: config, clock: () => clock, runDir }),
    responses({ configuration: config, clock: () => clock, runDir }),
    responses({ configuration: config, clock: () => clock, backend: 'codex', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'openai', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'deepseek', runDir }),
    chat({ configuration: config, clock: () => clock, dialect: 'openrouter', runDir }),
    bedrock({ configuration: config, clock: () => clock, runDir }),
  ];
  const kinds = [judge(), summariser({ refuseMerges, rejectMerges, refuseContent }), agent({ configuration: config })];
  if (rawDir) mkdirSync(rawDir, { recursive: true });

  function classify(view) {
    for (const kind of kinds) {
      const claim = kind.claim(view);
      if (claim) return claim;
    }
  }

  function reply(res, codec, body, view, record, answer) {
    const fit = fitToMaxTokens(codec.seal(answer.content, body), view.maxTokens);
    const content = fit.content;
    const stop = fit.cut ? 'max_tokens' : answer.stop;
    if (fit.cut) Object.assign(record.answer, { stop, chars: content.reduce((t, b) => t + (b.text || b.thinking || '').length, 0), ...(record.answer.toolUseIds ? { toolUseIds: content.filter((b) => b.type === 'tool_use').map((b) => b.id) } : {}) });
    const outputTokens = content.reduce((t, b) => t + blockTokens(b), 0) || 1;
    const usage = codec.usage(body, stop === 'max_tokens' && view.maxTokens ? view.maxTokens : outputTokens, content);
    record.usage = usage;
    record.tokens = codec.tokens(usage);
    if (rawDir) writeFileSync(join(rawDir, `${record.id}.answer.json`), JSON.stringify(content));
    codec.send(res, { body, record, content, stop, usage });
  }

  function handle(req, res, raw, arrived) {
    const url = req.url || '';
    const path = url.split('?')[0];
    // A query selects an endpoint's behaviour (the SDK's beta messages add `?beta=true`), so the head keeps one.
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : null;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const seq = records.length + 1;
    const id = `r${seq}`;
    let mask;
    let unmaskable = null;
    try { mask = runVaryingMasker(codexKeys, { runDir }); } catch (e) {
      unmaskable = `its run's records can't be masked: ${e.message}`;
      mask = runVaryingMasker(codexKeys, { runDir: null });
    }
    const codec = codecs.find((c) => c.routes(req.method, path)) ?? null;
    const writer = codec ?? codecs[0];
    const at = Math.round(performance.now() - t0);
    let read, claim, record;
    try {
      read = unmaskable ? { reason: unmaskable } : codec ? codec.read(body, path) : { reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` };
      // A codec whose API puts part of a request in its path (Bedrock's model and streaming) gives the body its other
      // members take.
      if (read.body) body = read.body;
      // Written before the request is classified, so a writer that throws leaves the step's scripted replies as they were.
      const written = body ? writer.record(body, req.headers, mask) : {};
      claim = read.view ? classify(read.view) : { kind: 'unclassified', reason: read.reason };
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, ...(claim.agent ? { agent: claim.agent } : {}), ...(claim.reason ? { reason: claim.reason } : {}), ...written };
      if (query !== null && record.head) record.head.query = query;
      if (path !== writer.path && record.head) record.head.path = path;
      if (claim.fields) Object.assign(record, claim.fields(mask));
    } catch (e) {
      // A read that already gave its reason keeps it; the writer's throw is on the same body.
      claim = { kind: 'unclassified', reason: read?.reason ?? threw('read', e) };
      record = { id, seq, at, arrived, clock, step: step?.id ?? null, kind: claim.kind, reason: claim.reason };
    }
    const { kind, reason } = claim;
    records.push(record);
    if (rawDir) writeFileSync(join(rawDir, `${id}.json`), raw);
    for (const cb of listeners) cb({ id, seq, kind, ...(reason ? { reason } : {}), step: record.step, at: record.at, clock });
    if (kind === 'unclassified') {
      record.answer = { shape: 'refused' };
      return writer.error(res, codec ? 400 : 404, `stand-in: unclassified request ${id}: ${reason}`);
    }
    // Past the read, a throw while answering leaves the request recorded as unclassified, with the exception as its
    // reason, tells onRequest so, as it tells every unclassified request, and answers it as a stand-in error.
    const answering = (fn) => {
      try { fn(); } catch (e) {
        Object.assign(record, { kind: 'unclassified', reason: threw('answer', e), answer: { shape: 'refused' } });
        for (const cb of listeners) cb({ id, seq, kind: record.kind, reason: record.reason, step: record.step, at: record.at, clock });
        if (!res.headersSent) writer.error(res, 400, `stand-in: unclassified request ${id}: ${record.reason}`);
        else res.destroy();
      }
    };
    answering(() => {
      const refusal = codec.refusal(body);
      if (refusal) {
        record.refused = refusal.refused;
        record.answer = { shape: 'refused' };
        return codec.error(res, refusal.status, refusal.message, refusal);
      }
      const answer = claim.answer(record);
      if (answer.error) return codec.error(res, answer.error.status, answer.error.message, { type: answer.error.type, headers: answer.error.headers });
      if (answer.held) {
        held.push(() => answering(() => reply(res, codec, body, read.view, record, answer.held())));
        for (const cb of heldListeners) cb({ id, agent: claim.agent, step: record.step });
        return;
      }
      reply(res, codec, body, read.view, record, answer);
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
  // A host under HTTPS_PROXY (driver.mjs hostEnv) asks the stand-in to tunnel a request that would leave the machine.
  // It tunnels nothing: the request is recorded unclassified, which fails the run, and refused.
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    const seq = records.length + 1;
    const record = { id: `r${seq}`, seq, at: Math.round(performance.now() - t0), arrived: String(process.hrtime.bigint()), clock, step: step?.id ?? null, kind: 'unclassified', reason: `it asks the stand-in to tunnel to ${req.url}, a request that would leave the machine`, answer: { shape: 'refused' } };
    records.push(record);
    for (const cb of listeners) cb({ id: record.id, seq, kind: record.kind, reason: record.reason, step: record.step, at: record.at, clock });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setStep(next) { step = next; for (const kind of kinds) kind.onStep?.(next); },
    setClock(ms) { clock = ms; },
    countTokens(body) { return codecs[0].countTokens(body); },
    onRequest(cb) { listeners.push(cb); },
    onHeld(cb) { heldListeners.push(cb); },
    releaseHeld() { held.shift()?.(); },
    async close() {
      await new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
      return records;
    },
  };
}
