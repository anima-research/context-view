import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runVaryingMasker } from '../strategies/compare.mjs';
import { agent } from './agent.mjs';
import { anthropic, decodeMessages } from './anthropic.mjs';
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
const DECODERS = { messages: decodeMessages, responses: (body) => decodeResponses(body, 'api'), codex: (body) => decodeResponses(body, 'codex') };

export function decoded(api, body) {
  return DECODERS[api]?.(body) ?? { reason: `no codec writes the API ${JSON.stringify(api ?? null)}` };
}

export async function startStandin({ configuration, rawDir = null, refuseMerges = false, rejectMerges = false, refuseContent = false }) {
  const config = { ...configuration };
  const t0 = performance.now();
  const records = [];
  const listeners = [];
  const sockets = new Set();
  let step = null;
  let clock = 0;
  const held = [];
  const heldListeners = [];
  const codecs = [anthropic({ configuration: config, clock: () => clock }), responses({ configuration: config, clock: () => clock }), responses({ configuration: config, clock: () => clock, backend: 'codex' })];
  const kinds = [summariser({ refuseMerges, rejectMerges, refuseContent }), agent({ configuration: config })];
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
    const codec = codecs.find((c) => c.routes(req.method, path)) ?? null;
    const read = codec ? codec.read(body) : { reason: `it goes to ${req.method} ${path}, which no run sends and the stand-in doesn't model` };
    const claim = read.view ? classify(read.view) : { kind: 'unclassified', reason: read.reason };
    const { kind, reason } = claim;
    const writer = codec ?? codecs[0];
    const mask = runVaryingMasker();
    const record = { id, seq, at: Math.round(performance.now() - t0), arrived, clock, step: step?.id ?? null, kind, ...(claim.agent ? { agent: claim.agent } : {}), ...(reason ? { reason } : {}), ...(body ? writer.record(body, req.headers, mask) : {}) };
    if (query !== null && record.head) record.head.query = query;
    if (path !== writer.path && record.head) record.head.path = path;
    if (claim.fields) Object.assign(record, claim.fields(mask));
    records.push(record);
    if (rawDir) writeFileSync(join(rawDir, `${id}.json`), raw);
    for (const cb of listeners) cb({ id, seq, kind, ...(reason ? { reason } : {}), step: record.step, at: record.at, clock });
    if (kind === 'unclassified') {
      record.answer = { shape: 'refused' };
      return writer.error(res, codec ? 400 : 404, `stand-in: unclassified request ${id}: ${reason}`);
    }
    const refusal = codec.refusal(body);
    if (refusal) {
      record.refused = refusal.refused;
      record.answer = { shape: 'refused' };
      return codec.error(res, refusal.status, refusal.message, refusal);
    }
    const answer = claim.answer(record);
    if (answer.error) return codec.error(res, answer.error.status, answer.error.message, { type: answer.error.type, headers: answer.error.headers });
    if (answer.held) {
      held.push(() => reply(res, codec, body, read.view, record, answer.held()));
      for (const cb of heldListeners) cb({ id, agent: claim.agent, step: record.step });
      return;
    }
    reply(res, codec, body, read.view, record, answer);
  }

  const server = createServer((req, res) => {
    const arrived = String(process.hrtime.bigint());
    let raw = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handle(req, res, raw, arrived));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
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
