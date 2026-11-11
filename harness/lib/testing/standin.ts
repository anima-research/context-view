// @ts-nocheck
import { after } from 'node:test';
import { startStandin as startServer } from '../standin/standin.ts';

export const ANSWER_BOUND_MS = 10_000;
const started = new Set();
after(async () => { for (const s of started) await s.close(); });
export async function startStandin(options) {
  const s = await startServer(options);
  started.add(s);
  return s;
}

export const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
export const NOTE = '[host note: this message arrived over IPC and carries no channel locus.]';
export const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';
export const MERGE = 'You have just reviewed the slices of recent experience above (raw conversation), in chronological order. They cover the stretch of experience you are about to consolidate into a single L2 memory. Write a memory that preserves the through-line. Target ~200 tokens. Output only the memory body — no preamble, no meta-commentary about summarizing.';

export const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};

export function agentBody({ canary, history = [], model = 'claude-opus-4-6', stream = true, max_tokens = 2048, tail = [], extra = {} }) {
  return {
    model, max_tokens, stream, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [...history, { role: 'user', content: [{ type: 'text', text: `user: ${canary} ${prose(300)}` }, { type: 'text', text: NOTE }, ...tail] }],
    ...extra,
  };
}

export function summariserBody({ canaries = ['[[c:x.1]]'], summaries = [], instruction = CHAT, model = 'claude-opus-4-6', max_tokens = 16000, textChars = 400 }) {
  const messages = [];
  for (const s of summaries) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Context Manager: [CM] Recall memory L2-6.' }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `${s} ${prose(200, 7)}` }] });
  }
  const last = { role: 'user', content: [] };
  for (const c of canaries) last.content.push({ type: 'text', text: `user: ${c} ${prose(textChars, 3)}` }, { type: 'text', text: NOTE });
  last.content.push({ type: 'text', text: `Context Manager: ${instruction}` });
  messages.push(last);
  return { model, max_tokens, stream: false, tools: TOOLS, messages };
}

export async function post(url, body, path = '/v1/messages', headers = {}) {
  try {
    return await read(await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ANSWER_BOUND_MS) }));
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`the stand-in sent no whole answer to POST ${path} within ${ANSWER_BOUND_MS} ms`);
    throw error;
  }
}

export async function read(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) return { status: res.status, json: await res.json() };
  const raw = await res.text();
  const events = raw.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  const start = events.find((e) => e.type === 'message_start').message;
  const blocks = [];
  for (const e of events) {
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
    if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (e.delta.type === 'text_delta') b.text += e.delta.text;
      if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
      if (e.delta.type === 'signature_delta') b.signature = (b.signature || '') + e.delta.signature;
      if (e.delta.type === 'input_json_delta') b._json = (b._json || '') + e.delta.partial_json;
    }
  }
  for (const b of blocks) if (b.type === 'tool_use') { b.input = JSON.parse(b._json || '{}'); delete b._json; }
  const delta = events.find((e) => e.type === 'message_delta');
  const starts = events.filter((e) => e.type === 'content_block_start').map((e) => [e.index, e.content_block.type]);
  return { status: res.status, stream: true, starts, opening: start, json: { ...start, content: blocks, stop_reason: delta.delta.stop_reason, stop_sequence: delta.delta.stop_sequence, usage: { ...start.usage, ...delta.usage } } };
}

export const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

export function arrivals(standin) {
  const seen = [];
  let waiters = [];
  standin.onRequest((r) => { seen.push(r); waiters = waiters.filter((w) => (seen.length >= w.n ? (w.resolve(), false) : true)); });
  const until = (n) => (seen.length >= n ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${seen.length} of ${n} requests reached onRequest within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
  }));
  return { seen, until };
}

export const step = (id, replies = [{ text: `[[c:${id}.r1]] noted.` }], more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

export async function withStandin(opts, fn) {
  const standin = await startStandin({ configuration: { windowTokens: 50_000, ...opts } });
  try { return await fn(standin); } finally { await standin.close(); }
}
