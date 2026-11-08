import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens } from '../lib/standin/anthropic.mjs';
import { decoded, keptBody, startStandin as startServer, tokensSent } from '../lib/standin/standin.mjs';
import { summariser } from '../lib/standin/summariser.mjs';
import { blockRecord, repairMarks } from '../lib/standin/view.mjs';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane } from '@animalabs/membrane';
import { moduleCounts } from '../lib/strategies/ledger.mjs';

const ANSWER_BOUND_MS = 10_000;
const started = new Set();
after(async () => { for (const s of started) await s.close(); });
async function startStandin(options) {
  const s = await startServer(options);
  started.add(s);
  return s;
}

const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
const NOTE = '[host note: this message arrived over IPC and carries no channel locus.]';
const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';
const MERGE = 'You have just reviewed the slices of recent experience above (raw conversation), in chronological order. They cover the stretch of experience you are about to consolidate into a single L2 memory. Write a memory that preserves the through-line. Target ~200 tokens. Output only the memory body — no preamble, no meta-commentary about summarizing.';
const WITNESSED = 'Write the memory of this slice of the log. This part of the record predates your own first turn. Target ~200 tokens.';
const READING = 'You have just been reading a substantial body of text — approximately 4000 tokens total in this piece, of which what you just read is a portion. Target ~200 tokens.';
const READING_MERGE = 'You have just re-experienced the portions of text you read above (raw passages from a larger piece), in chronological order. They cover a contiguous stretch of a substantial body of text you have been reading — approximately 9000 tokens in total across all of it. The portions above cover the stretch you are now consolidating at L2.\n\nReflect across the stretch. Target ~200 tokens.';
// Knowledge's other three openings, as context-manager's knowledge.ts writes them (leadSuffix empty).
const SYNTHESIS = 'Capture the reasoning and conclusions from this discussion. What connections were drawn? What hypotheses were formed or rejected? What decisions were made about what to investigate next? Preserve the logic chain.  Aim for about 200 tokens.';
const LESSON = 'Record what knowledge was captured. What lessons were created or updated? What was the evidence basis? Note any confidence gaps or unresolved questions.  Aim for about 200 tokens.';
const SUBAGENT = 'Summarize the subagent work. What tasks were dispatched, what did each return, and what was the coordinator\'s synthesis of the results? Collapse dispatch/wait mechanics.  Aim for about 200 tokens.';
const FRONTDESK = 'Starting from my last message, please describe everything that has happened. Aim for about 200 tokens. Describe it as you would to yourself, as if you are remembering what has happened.';
const KNOWLEDGE = 'Summarize the research performed. What was searched for, what sources were consulted, and what was found? Aim for about 200 tokens.';

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};

function agentBody({ canary, history = [], model = 'claude-opus-4-6', stream = true, max_tokens = 2048, tail = [], extra = {} }) {
  return {
    model, max_tokens, stream, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [...history, { role: 'user', content: [{ type: 'text', text: `user: ${canary} ${prose(300)}` }, { type: 'text', text: NOTE }, ...tail] }],
    ...extra,
  };
}

function summariserBody({ canaries = ['[[c:x.1]]'], summaries = [], instruction = CHAT, model = 'claude-opus-4-6', max_tokens = 16000, textChars = 400 }) {
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

async function post(url, body, path = '/v1/messages', headers = {}) {
  try {
    return await read(await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ANSWER_BOUND_MS) }));
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`the stand-in sent no whole answer to POST ${path} within ${ANSWER_BOUND_MS} ms`);
    throw error;
  }
}

async function read(res) {
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
  // The blocks as the stream started them, each with its index, in the order they came.
  const starts = events.filter((e) => e.type === 'content_block_start').map((e) => [e.index, e.content_block.type]);
  return { status: res.status, stream: true, starts, opening: start, json: { ...start, content: blocks, stop_reason: delta.delta.stop_reason, stop_sequence: delta.delta.stop_sequence, usage: { ...start.usage, ...delta.usage } } };
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function arrivals(standin) {
  const seen = [];
  let waiters = [];
  standin.onRequest((r) => { seen.push(r); waiters = waiters.filter((w) => (seen.length >= w.n ? (w.resolve(), false) : true)); });
  const until = (n) => (seen.length >= n ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${seen.length} of ${n} requests reached onRequest within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
  }));
  return { seen, until };
}

const step = (id, replies = [{ text: `[[c:${id}.r1]] noted.` }], more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withStandin(opts, fn) {
  const standin = await startStandin({ configuration: { windowTokens: 50_000, ...opts } });
  try { return await fn(standin); } finally { await standin.close(); }
}

test('T1/T3: an agent request carrying the step\'s canary gets the step\'s replies in order, streamed or not', () => withStandin({}, async (s) => {
  s.setStep(step('a', [{ text: '[[c:a.r1]] first' }, { text: '[[c:a.r2]] second' }]));
  const one = await post(s.url, agentBody({ canary: '[[c:a.in]]' }));
  assert.equal(one.status, 200);
  assert.equal(one.stream, true);
  assert.equal(textOf(one.json), '[[c:a.r1]] first');
  assert.equal(one.json.stop_reason, 'end_turn');
  const two = await post(s.url, agentBody({ canary: '[[c:a.in]]', stream: false }));
  assert.equal(two.stream, undefined);
  assert.equal(textOf(two.json), '[[c:a.r2]] second');
}));

test('T3: a reply\'s blocks come thinking, text, then calls, and a reply that calls stops for tool use', () => withStandin({}, async (s) => {
  const input = { size: 400, kind: 'prose', canary: '[[c:b.call1]]' };
  s.setStep(step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'fixture--result', input }] }]));
  for (const stream of [true]) {
    const r = await post(s.url, agentBody({ canary: '[[c:b.in]]', stream }));
    assert.deepEqual(r.json.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(r.starts, [[0, 'thinking'], [1, 'text'], [2, 'tool_use']], 'in that order on the wire, not only by index');
    assert.equal(r.json.content[0].thinking, 'I should look.');
    assert.equal(typeof r.json.content[0].signature, 'string');
    assert.equal(r.json.content[2].name, 'fixture--result');
    assert.deepEqual(r.json.content[2].input, input);
    assert.equal(typeof r.json.content[2].id, 'string');
    assert.equal(r.json.stop_reason, 'tool_use');
  }
}));

test('T1/T3: a tool round\'s second request is the step\'s when its last message carries the call\'s canary', () => withStandin({}, async (s) => {
  s.setStep({ ...step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] }, { text: '[[c:t.r2]] done' }]), canaries: ['[[c:t.in]]', '[[c:t.call1]]'] });
  const first = await post(s.url, agentBody({ canary: '[[c:t.in]]' }));
  const call = first.json.content.find((b) => b.type === 'tool_use');
  const second = {
    model: 'claude-opus-5-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
      { role: 'assistant', content: first.json.content },
      { role: 'user', content: [{ type: 'text', text: 'user: Clock: Wednesday 2031-01-01, 00:10 UTC' }, { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:t.call1]] ${prose(280)}` }] }] },
    ],
  };
  const r = await post(s.url, second);
  assert.equal(textOf(r.json), '[[c:t.r2]] done');
}));

test('T2: a request to tunnel through the stand-in, which a host under its HTTPS proxy sends for a request that would leave the machine, is refused and recorded as unclassified, naming where it would go', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('t'));
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(s.url).port, method: 'CONNECT', path: 'openrouter.ai:443' });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(seen.at(-1).reason, /tunnel to openrouter\.ai:443/, 'the arrival names where it would go, for the driver\'s failure');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:t.in]]' }))).status, 200, 'and the stand-in still answers what it serves');
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.id, r.kind, r.step]), [['r1', 'unclassified', 't'], ['r2', 'agent', 't']]);
}));

test('a request\'s kept body is read by its API; a refused tunnel, which keeps none, gives its record\'s reason, and a kept body that isn\'t JSON, or that its API can\'t read, says so', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'kept-body-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    s.setStep(step('t'));
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: new URL(s.url).port, method: 'CONNECT', path: 'openrouter.ai:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(); });
      req.on('error', reject);
      req.end();
    });
    assert.equal((await post(s.url, agentBody({ canary: '[[c:t.in]]' }))).status, 200);
    const [tunnel, sent] = await s.close();
    assert.deepEqual(readdirSync(rawDir).filter((f) => !f.includes('answer')).sort(), [`${sent.id}.json`], 'the tunnel keeps no body');
    assert.equal(keptBody(rawDir, tunnel.id, tunnel.head?.api ?? null, tunnel.reason).reason, `the stand-in kept no body for it: ${tunnel.reason}`);
    assert.ok(keptBody(rawDir, sent.id, sent.head.api).view.messages.length > 0);
    writeFileSync(join(rawDir, 'r9.json'), '');
    assert.match(keptBody(rawDir, 'r9', 'messages').reason, /^its kept body isn't JSON: /);
    writeFileSync(join(rawDir, 'r10.json'), JSON.stringify({ messages: [null] }));
    assert.match(keptBody(rawDir, 'r10', 'messages').reason, /^its body couldn't be read as the messages API: the stand-in couldn't read it: TypeError: /);
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
});

test('T42: a reply\'s calls may be worked out from the request it answers, and the reply stops for tool use only when that gives at least one', () => withStandin({}, async (s) => {
  const listed = (messages) => messages.at(-1).content.filter((b) => b.type === 'text').flatMap((b) => [...b.text.matchAll(/look:(\w+)/g)].map((m) => ({ name: 'toolsets--look', input: { tool: m[1] } })));
  s.setStep(step('k', [{ text: '[[c:k.r1]] looking', calls: listed }, { text: '[[c:k.r2]] looking', calls: listed }]));
  const two = await post(s.url, agentBody({ canary: '[[c:k.in]]', tail: [{ type: 'text', text: 'look:alpha look:beta' }] }));
  assert.deepEqual(two.json.content.filter((b) => b.type === 'tool_use').map((b) => b.input.tool), ['alpha', 'beta']);
  assert.equal(two.json.stop_reason, 'tool_use');
  const none = await post(s.url, agentBody({ canary: '[[c:k.in]]' }));
  assert.deepEqual(none.json.content.map((b) => b.type), ['text']);
  assert.equal(none.json.stop_reason, 'end_turn');
}));

test('T43: a step\'s spare replies answer a turn it doesn\'t expect, only after its own replies, and none is left past them', () => withStandin({}, async (s) => {
  s.setStep(step('m', [{ text: '[[c:m.r1]] expected' }], { spare: [{ text: '[[c:m.spare]] unexpected' }] }));
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).json), '[[c:m.r1]] expected');
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).json), '[[c:m.spare]] unexpected');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).status, 400);
  s.setStep(step('q', [], { spare: [{ text: '[[c:q.spare]] unexpected' }] }));
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:q.in]]' }))).json), '[[c:q.spare]] unexpected');
}));

test('T44: a text block that opens with agent-framework\'s batched-wake line is recorded with the count of events it names, and no other block is', () => withStandin({}, async (s) => {
  s.setStep(step('w', [{ text: '[[c:w.r1]] seen' }]));
  const line = { type: 'text', text: 'user: [Gate: 2 events matched]\n\n- 2 messages in w12-debounce (oldest ~60s ago)' };
  const one = { type: 'text', text: '[Gate: 1 event matched]\n\n- a message' };
  const quoted = { type: 'text', text: 'Tavy: as the log said, [Gate: 3 events matched]' };
  await post(s.url, agentBody({ canary: '[[c:w.in]]', tail: [line, one, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.wakeLine ?? null), [null, null, 2, 1, null]);
}));

test('T46: a text block that opens with the notices module\'s `[host-notice]`, or agent-framework\'s `[suppression review]`, `[wake onboarding]`, `[refusal-rewind]` or `[discord-send-failed]`, is recorded as that notice, and one quoting any of them later isn\'t', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const notice = { type: 'text', text: 'user: [host-notice] While you could not respond (instructions-unavailable), the host posted this in chat.' };
  const reviewed = { type: 'text', text: 'user: [suppression review] Since 2026-01-05T09:00:00Z (2 hours), your suppress rules hid 2 events.' };
  const offered = { type: 'text', text: 'user: [wake onboarding] Events from the MCPL server "quiet" reach your context without waking you.' };
  const rewound = { type: 'text', text: 'user: [refusal-rewind] The 1 most recent turn(s) were set aside because the model refused on them (content filter: unknown).' };
  const unposted = { type: 'text', text: 'user: [discord-send-failed] Your previous reply (12 chars) could not be delivered to #chat (the "fixture" server said it didn\'t post the message). Nothing was posted; it is saved in your archive.' };
  const quoted = { type: 'text', text: 'Tavy: it said [host-notice] earlier, and [suppression review], [wake onboarding], [refusal-rewind] and [discord-send-failed] too' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [notice, reviewed, offered, rewound, unposted, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.notice ?? null), [null, null, 'host-notice', 'suppression review', 'wake onboarding', 'refusal-rewind', 'discord-send-failed', null]);
}));

test('T45: a request whose text names its run\'s own directory is recorded the same from any run\'s directory', async () => {
  const recordFrom = async (runDir) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir });
    s.setStep(step('p', [{ text: '[[c:p.r1]] seen' }]));
    await post(s.url, agentBody({ canary: '[[c:p.in]]', tail: [{ type: 'text', text: `{"configPath":"${runDir}/store/sessions/0a1b2c3d/config/gate.json"}` }] }));
    const [record] = await s.close();
    return record.messages.map((m) => m.digest);
  };
  assert.deepEqual(await recordFrom('/tmp/a/runs/H5_W12'), await recordFrom('/runner/b/runs/H5_W12'));
});

test('T47: with its run\'s lessons file of a shape the mask can\'t read, a request is refused as unclassified, naming the file', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 't47-'));
  try {
    mkdirSync(join(runDir, 'store'));
    writeFileSync(join(runDir, 'store', 'lessons.json'), '[]');
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir });
    s.setStep(step('p', [{ text: '[[c:p.r1]] seen' }]));
    const answer = await post(s.url, agentBody({ canary: '[[c:p.in]]' }));
    assert.equal(answer.status, 400);
    const [record] = await s.close();
    assert.equal(record.kind, 'unclassified');
    assert.match(record.reason, /lessons\.json isn't the shape the run-varying masker reads/);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test('T1/T2: a request with no canary of the step, with max_tokens 0, or past the step\'s replies is refused as unclassified, at once, and its arrival says why', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('u'));
  const stranger = await post(s.url, agentBody({ canary: '[[c:other.in]]' }));
  assert.equal(stranger.status, 400);
  assert.equal(stranger.json.error.type, 'invalid_request_error');
  assert.match(stranger.json.error.message, /stand-in.*unclassified/);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(seen.at(-1).reason ?? '', /carries none of step u's canaries/, 'the arrival names why, for the driver\'s failure');
  const keepalive = await post(s.url, agentBody({ canary: '[[c:u.in]]', max_tokens: 0 }));
  assert.equal(keepalive.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:u.in]]' }))).status, 200);
  const extra = await post(s.url, agentBody({ canary: '[[c:u.in]]' }));
  assert.equal(extra.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent', 'unclassified']);
  for (const r of records.filter((x) => x.kind === 'unclassified')) assert.equal(typeof r.reason, 'string');
}));

test('T1: each compression instruction context-manager sends is a summariser request, though its message carries the slice\'s canaries', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('k', []));
  for (const instruction of [CHAT, MERGE, WITNESSED, READING, READING_MERGE, KNOWLEDGE, SYNTHESIS, LESSON, SUBAGENT, FRONTDESK]) {
    const r = await post(s.url, summariserBody({ canaries: ['[[c:k.in]]'], instruction }));
    assert.equal(r.status, 200, instruction.slice(0, 40));
    assert.equal(seen.at(-1).kind, 'summariser', instruction.slice(0, 40));
  }
  await post(s.url, summariserBody({ instruction: 'Please consolidate these 3 L1 summaries (2 synthesis, 1 research) into a single cohesive memory. Aim for about 200 tokens.' }));
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level), [1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(records.map((r) => r.retry), [false, false, false, false, false, false, false, false, false, false, false]);
}));

test('T4/T5: a summary answer opens with an id that is a function of what its request carries, then untagged padding to the target its instruction states, and the record lists what each call was sent', async () => {
  const one = await startStandin({ configuration: { windowTokens: 50_000 } });
  const other = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    one.setStep(step('p', []));
    other.setStep(step('p', []));
    const a = summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~60') });
    const b = summariserBody({ canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'], textChars: 400 });
    const [small, big] = [await post(one.url, a), await post(one.url, b)];
    const [big2, small2] = [await post(other.url, b), await post(other.url, a)];
    const [x, y] = [textOf(small.json), textOf(big.json)];
    assert.match(x, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 1 canaries to c:p\.1: /);
    assert.match(y, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 2 canaries to c:p\.3: /);
    const idOf = (t) => t.match(/^\[\[s:M[0-9a-f]{8}\]\]/)[0];
    assert.notEqual(idOf(x), idOf(y));
    assert.equal(textOf(small2.json), x);
    assert.equal(textOf(big2.json), y);
    const retargeted = await post(one.url, summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~61') }));
    assert.notEqual(idOf(textOf(retargeted.json)), idOf(x));
    assert.equal(/<|>/.test(x + y), false);
    assert.equal(/\[\[c:/.test(x + y), false, 'a summary carries no canary in the form a message carries one');
    for (const [r, target] of [[small, 60], [big, 200]]) {
      assert.ok(Math.abs(r.json.usage.output_tokens - target) <= target * 0.05, `${r.json.usage.output_tokens} for a target of ${target}`);
    }
    records = await one.close();
    assert.deepEqual(records[1].sent, { canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'] });
    assert.equal(records[1].answer.summary, idOf(y));
  } finally {
    if (!records) await one.close();
    await other.close();
  }
});

test('T1/T4: a compression instruction that states no target is refused as unclassified', () => withStandin({}, async (s) => {
  s.setStep(step('nt', []));
  const r = await post(s.url, summariserBody({ instruction: CHAT.replace('Target ~200 tokens. ', '') }));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /no target/);
}));
test('T36: a merge instruction that names no level it asks for is refused as unclassified, not counted as a compression', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('nl', []));
  for (const instruction of [MERGE.replace('single L2 memory', 'single higher memory'), READING_MERGE.replace('consolidating at L2.', 'consolidating one level up.')]) {
    const r = await post(s.url, summariserBody({ instruction }));
    assert.equal(r.status, 400, instruction.slice(0, 40));
    assert.match(r.json.error.message, /its merge instruction names no level/);
    assert.equal(seen.at(-1).kind, 'unclassified');
  }
  await post(s.url, summariserBody({ instruction: MERGE }));
  assert.equal(seen.at(-1).kind, 'summariser', 'one that names its level is still the summariser\'s');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level ?? null), [null, null, 2], 'no level is recorded for a request it couldn\'t classify');
}));
test('T40: an instruction that names a level in none of the forms the stand-in reads is refused as unclassified, not counted as a compression', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('lv', []));
  const reworded = 'Write the memory of this slice of the log. Consolidate the preceding summaries into one L2 memory. Target ~200 tokens.';
  const r = await post(s.url, summariserBody({ instruction: reworded }));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /its instruction names a level \(L2\) in none of the forms the stand-in reads/);
  assert.equal(seen.at(-1).kind, 'unclassified');
  await post(s.url, summariserBody({ instruction: CHAT }));
  assert.equal(seen.at(-1).kind, 'summariser', 'an L1 instruction that names no level is still level 1');
  const records = await s.close();
  assert.deepEqual(records.map((x) => x.level ?? null), [null, 1]);
}));
test('T4: an answer never runs past what max_tokens allows: one that would is cut there, with a max_tokens stop, as a provider cuts it', () => withStandin({}, async (s) => {
  const scripted = `[[c:m.r1]] ${prose(4_000)}`;
  s.setStep(step('m', [{ text: scripted }, { text: scripted }]));
  const summary = await post(s.url, summariserBody({ canaries: ['[[c:m.1]]'], textChars: 40_000, max_tokens: 100 }));
  assert.ok(summary.json.usage.output_tokens <= 100, String(summary.json.usage.output_tokens));
  assert.equal(summary.json.stop_reason, 'max_tokens');
  assert.ok(textOf(summary.json).length <= 100 * 2.2, `the summary itself is cut to what 100 tokens of prose hold: ${textOf(summary.json).length} chars`);
  for (const stream of [false, true]) {
    const reply = (await post(s.url, agentBody({ canary: '[[c:m.in]]', stream, max_tokens: 50 }))).json;
    assert.ok(reply.usage.output_tokens <= 50, String(reply.usage.output_tokens));
    assert.equal(reply.stop_reason, 'max_tokens');
    const text = textOf(reply);
    assert.ok(text.length > 0 && text.length <= 50 * 2.2, `${stream ? 'streamed' : 'whole'}: the text itself is cut to what 50 tokens of prose hold: ${text.length} chars`);
    assert.ok(scripted.startsWith(text), 'the answer is its own beginning, cut');
  }
  const fits = await post(s.url, summariserBody({ canaries: ['[[c:m.2]]'], max_tokens: 16_000 }));
  assert.equal(fits.json.stop_reason, 'end_turn', 'an answer within the ceiling ends as it would');
  const none = await post(s.url, { ...summariserBody({ canaries: ['[[c:m.3]]'] }), max_tokens: undefined });
  assert.equal(none.status, 400, 'a request without max_tokens is refused, as the API refuses it');
}));

test('T6: a step\'s bad answers go one each, in order, to the next first attempts, from that step on; a retry is answered well', () => withStandin({}, async (s) => {
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty', 'max-tokens'] }));
  const retry = (instruction) => summariserBody({ instruction: `${instruction}\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.` });
  const got = [];
  got.push((await post(s.url, summariserBody({}))).json);
  got.push((await post(s.url, retry(CHAT))).json);
  s.setStep(step('bad.cp', []));
  for (let i = 0; i < 3; i++) got.push((await post(s.url, summariserBody({ canaries: [`[[c:x.${i + 2}]]`] }))).json);
  assert.match(textOf(got[0]), /^<thinking>[\s\S]*<\/thinking>$/);
  assert.equal(got[0].stop_reason, 'end_turn');
  assert.match(textOf(got[1]), /^\[\[s:M[0-9a-f]{8}\]\] /, 'the retry gets a good answer');
  assert.deepEqual(got[2].content, [{ type: 'text', text: '' }]);
  assert.equal(got[3].stop_reason, 'max_tokens');
  assert.match(textOf(got[4]), /^\[\[s:M[0-9a-f]{8}\]\] /);
}));
test('T37: a retry of an L1 request answered with only thinking re-sends it, its canaries and summaries alike, and carries a retry hint; one that re-sends it without a hint, or carries a hint with nothing to re-send, is unclassified and refused', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const NO_TOOLS = '\n\nWrite the memory as plain text directly in your response — do not call any tools for this.';
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty'] }));
  assert.match(textOf((await post(s.url, summariserBody({}))).json), /^<thinking>/);
  const reworded = await post(s.url, summariserBody({ instruction: `${CHAT}\n\nWrite the memory as prose, with no tags around it.` }));
  assert.equal(reworded.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(reworded.json.error.message, /re-sends a request answered thinking-only, but carries no retry hint the stand-in knows/);
  assert.match(textOf((await post(s.url, summariserBody({ instruction: `${CHAT}${PLAIN}` }))).json), /^\[\[s:M[0-9a-f]{8}\]\] /, 'a hinted retry is answered well');
  const unprompted = await post(s.url, summariserBody({ canaries: ['[[c:x.9]]'], instruction: `${CHAT}${NO_TOOLS}` }));
  assert.equal(unprompted.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(unprompted.json.error.message, /carries a retry hint, but no earlier request with its canaries and summaries took a bad answer/);
  assert.deepEqual((await post(s.url, summariserBody({ canaries: ['[[c:x.10]]'] }))).json.content, [{ type: 'text', text: '' }], 'a request for another slice is a first attempt');
}));

test('T38: a merge re-sent after a bad answer keeps its last summary, its sources, whatever prior summaries it carries, and carries a retry hint after thinking or nothing but none after max_tokens, as context-manager 0.24.0 re-sends it; an L1 request is re-sent whole', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const S = (n) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const merge = (canary, summaries, hint = '') => summariserBody({ canaries: [canary], summaries, instruction: `${MERGE}${hint}` });
  const good = /^\[\[s:M[0-9a-f]{8}\]\] /;
  s.setStep(step('bad', [], { badAnswers: ['empty', 'max-tokens', 'thinking-only', 'empty'] }));
  assert.deepEqual((await post(s.url, merge('[[c:m.1]]', [S(1), S(2), S(3), S(4)]))).json.content, [{ type: 'text', text: '' }]);
  assert.match(textOf((await post(s.url, merge('[[c:m.1]]', [S(1), S(3), S(4)], PLAIN))).json), good, 'a hinted retry that skipped a prior summary in the middle is a retry');
  assert.equal((await post(s.url, merge('[[c:m.2]]', [S(5), S(6), S(7)]))).json.stop_reason, 'max_tokens');
  const hintedAfterCut = await post(s.url, merge('[[c:m.2]]', [S(7)], PLAIN));
  assert.equal(hintedAfterCut.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(hintedAfterCut.json.error.message, /re-sends a request cut at max_tokens, which context-manager 0\.24\.0 re-sends with no retry hint, but carries one/);
  assert.match(textOf((await post(s.url, merge('[[c:m.2]]', [S(8), S(7)]))).json), good, 'a bare re-send after max_tokens, with a prior the first try didn\'t send, is a retry');
  assert.match(textOf((await post(s.url, merge('[[c:m.2]]', [S(5), S(6)]))).json), /^<thinking>/, 'a merge ending with another summary is another merge, a first attempt');
  assert.deepEqual((await post(s.url, summariserBody({ canaries: ['[[c:l.1]]'], summaries: [S(8), S(9)] }))).json.content, [{ type: 'text', text: '' }]);
  const l1Shrunk = await post(s.url, summariserBody({ canaries: ['[[c:l.1]]'], summaries: [S(9)], instruction: `${CHAT}${PLAIN}` }));
  assert.equal(l1Shrunk.status, 400, 'an L1 retry is re-sent whole');
  assert.match(l1Shrunk.json.error.message, /carries a retry hint, but no earlier request with its canaries and summaries took a bad answer/);
}));

test('T39: until a merge cut at max_tokens is re-sent and answered well, a hintless merge alike in level, target and canaries but ending with another summary is refused, since context-manager 0.24.0 re-sends the merge at its queue\'s head; once it settles, such a merge is a first attempt', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const S = (n) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const merge = (summaries) => summariserBody({ canaries: ['[[c:m.3]]'], summaries, instruction: MERGE });
  s.setStep(step('bad', [], { badAnswers: ['max-tokens', 'empty'] }));
  assert.equal((await post(s.url, merge([S(1), S(2)]))).json.stop_reason, 'max_tokens');
  const unknown = await post(s.url, merge([S(1)]));
  assert.equal(unknown.status, 400, 'it can\'t be told from the cut merge\'s re-send');
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(unknown.json.error.message, /matches a merge cut at max_tokens and not yet re-sent in level, target and canaries, but ends with another summary/);
  assert.match(textOf((await post(s.url, merge([S(2)]))).json), /^\[\[s:M[0-9a-f]{8}\]\] /, 'its re-send is answered well');
  assert.deepEqual((await post(s.url, merge([S(2), S(9)]))).json.content, [{ type: 'text', text: '' }], 'once it settles, a merge ending with another summary is a first attempt');
}));

test('T41: once a re-send is answered well, the same request sent again is a first attempt, served the next queued answer', () => withStandin({}, async (s) => {
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const S = (n) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const good = /^\[\[s:M[0-9a-f]{8}\]\] /;
  const l1 = (hint = '') => summariserBody({ canaries: ['[[c:l.4]]'], summaries: [S(1)], instruction: `${CHAT}${hint}` });
  const merge = () => summariserBody({ canaries: ['[[c:m.4]]'], summaries: [S(2)], instruction: MERGE });
  s.setStep(step('bad', [], { badAnswers: ['empty', 'thinking-only', 'max-tokens', 'empty'] }));
  assert.deepEqual((await post(s.url, l1())).json.content, [{ type: 'text', text: '' }]);
  assert.match(textOf((await post(s.url, l1(PLAIN))).json), good, 'its hinted re-send is answered well');
  assert.match(textOf((await post(s.url, l1())).json), /^<thinking>/, 'the same request again, with no hint, takes the next queued answer');
  assert.equal((await post(s.url, merge())).json.stop_reason, 'max_tokens');
  assert.match(textOf((await post(s.url, merge())).json), good, 'its bare re-send is answered well');
  assert.deepEqual((await post(s.url, merge())).json.content, [{ type: 'text', text: '' }], 'the same merge again takes the next queued answer');
}));

test('T20: with refuseMerges every merge request is refused and an L1 answered; with rejectMerges every merge request is rejected for its request', async () => {
  for (const [opts, check] of [
    [{ refuseMerges: true }, (r) => assert.equal(r.json.stop_reason, 'refusal')],
    [{ rejectMerges: true }, (r) => { assert.equal(r.status, 400); assert.equal(r.json.error.type, 'invalid_request_error'); }],
  ]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...opts });
    try {
      s.setStep(step('m', []));
      check(await post(s.url, summariserBody({ instruction: MERGE })));
      const l1 = await post(s.url, summariserBody({}));
      assert.equal(l1.status, 200);
      assert.equal(l1.json.stop_reason, 'end_turn');
    } finally { await s.close(); }
  }
});

test('T34: with refuseContent a summariser request carrying the refused content anywhere in it is refused, and its record says whether the content sat in the slice, ahead of it, in a merge, or in an L1 request with no single notice opening a slice, also when the request is refused for something else first', async () => {
  const NOTICE = 'Context Manager: System: You will soon form a new memory, get ready. The messages that follow are the slice of recent experience you are about to compress. After them, write the memory in your own voice.';
  const l1 = (ahead, slice) => ({
    model: 'claude-opus-5-5', max_tokens: 16000, stream: false, tools: TOOLS,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `user: [[c:x.1]] ${ahead} ${prose(300, 3)}` },
      { type: 'text', text: NOTICE },
      { type: 'text', text: `user: [[c:x.2]] ${slice} ${prose(300, 5)}` },
      { type: 'text', text: `Context Manager: ${CHAT}` },
    ] }],
  });
  const merge = summariserBody({ instruction: MERGE });
  merge.messages[0].content[0].text = `user: [[c:x.1]] REFUSED-CONTENT ${prose(400, 3)}`;
  const unnoticed = l1('', 'REFUSED-CONTENT');
  unnoticed.messages[0].content.splice(1, 1);
  const quoted = l1('', 'REFUSED-CONTENT');
  quoted.messages[0].content.splice(0, 0, { type: 'text', text: NOTICE });
  const between = l1('REFUSED-CONTENT', '');
  between.messages[0].content.splice(0, 0, { type: 'text', text: NOTICE });
  const inSystem = { ...l1('', ''), system: [{ type: 'text', text: 'REFUSED-CONTENT' }] };
  const inSystemUnnoticed = { ...l1('', ''), system: [{ type: 'text', text: 'REFUSED-CONTENT' }] };
  inSystemUnnoticed.messages = [{ ...inSystemUnnoticed.messages[0], content: inSystemUnnoticed.messages[0].content.filter((b) => b.text !== NOTICE) }];
  const inTools = { ...l1('', ''), tools: [{ ...TOOLS[0], description: 'REFUSED-CONTENT' }, ...TOOLS.slice(1)] };
  const inCall = l1('', '');
  inCall.messages[0].content.splice(3, 0, { type: 'tool_use', id: 'toolu_x', name: 'read', input: { path: 'REFUSED-CONTENT' } });
  const unsized = l1('REFUSED-CONTENT', '');
  delete unsized.max_tokens;
  const sent = [
    ['ahead', l1('REFUSED-CONTENT', ''), 'refusal'],
    ['slice', l1('', 'REFUSED-CONTENT'), 'refusal'],
    ['merge', merge, 'refusal'],
    ['unplaced', unnoticed, 'refusal'],
    ['unplaced', quoted, 'refusal'],
    ['unplaced', between, 'refusal'],
    ['ahead', inSystem, 'refusal'],
    ['ahead', inSystemUnnoticed, 'refusal'],
    ['ahead', inTools, 'refusal'],
    ['slice', inCall, 'refusal'],
    ['ahead', unsized, undefined],
    [undefined, l1('', ''), 'end_turn'],
  ];
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, refuseContent: true });
  s.setStep(step('m', []));
  for (const [, body, stop] of sent) assert.equal((await post(s.url, body)).json.stop_reason, stop);
  const records = (await s.close()).filter((r) => r.kind === 'summariser');
  assert.deepEqual(records.map((r) => r.carried), sent.map(([carried]) => carried));
  assert.deepEqual(records.map((r) => r.answer.shape), ['refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refused', 'summary']);
  assert.equal(records.at(-2).refused, 'max_tokens');
  const plain = await startStandin({ configuration: { windowTokens: 50_000 } });
  plain.setStep(step('m', []));
  assert.equal((await post(plain.url, l1('REFUSED-CONTENT', ''))).json.stop_reason, 'end_turn');
  assert.equal((await plain.close()).find((r) => r.kind === 'summariser').carried, undefined);
});

test('T35: a summariser request the stand-in refuses before answering keeps the level it asked for, so the counts take every summariser request', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('m', []));
  const sent = [
    [{ ...summariserBody({}), max_tokens: undefined }, 400, 1],
    [{ ...summariserBody({ instruction: MERGE }), max_tokens: undefined }, 400, 2],
    [summariserBody({ textChars: 400_000 }), 400, 1],
    [summariserBody({}), 200, 1],
  ];
  for (const [body, status] of sent) assert.equal((await post(s.url, body)).status, status);
  const records = (await s.close()).filter((r) => r.kind === 'summariser');
  assert.deepEqual(records.map((r) => [r.refused ?? null, r.level]), [['max_tokens', 1], ['max_tokens', 2], ['window', 1], [null, 1]]);
  assert.deepEqual(['compressions', 'merges'].map((k) => moduleCounts([], records)[k]), [3, 1], 'every summariser request, refused or answered, is counted under its level');
});

test('T3/T22: a call goes with the id its reply names, and a reply\'s error answers its request with that provider error', () => withStandin({}, async (s) => {
  s.setStep(step('e', [{ text: '[[c:e.r1]] calling', calls: [{ id: 'toolu_same', name: 'time--now', input: {} }, { id: 'toolu_same', name: 'time--now', input: {} }] }, { error: { status: 529, type: 'overloaded_error', message: 'busy' } }]));
  const one = await post(s.url, agentBody({ canary: '[[c:e.in]]' }));
  assert.deepEqual(one.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_same', 'toolu_same']);
  const two = await post(s.url, agentBody({ canary: '[[c:e.in]]', stream: false }));
  assert.equal(two.status, 529);
  assert.equal(two.json.error.type, 'overloaded_error');
}));

test('T23: a step\'s subagent requests are told by the marker in their system prompt and get its own replies, and a text of `also` in the last message names a request the step\'s', () => withStandin({}, async (s) => {
  s.setStep(step('sub', [{ text: '[[c:sub.r1]] primary' }, { text: '[[c:sub.r2]] after the note' }], {
    sub: { marker: '[[sub:x]]', canaries: ['[[c:sub.task]]'], replies: [{ text: '[[c:sub.s1]] the subagent' }] },
    also: ['were set aside'],
  }));
  const sub = await post(s.url, { ...agentBody({ canary: '[[c:sub.task]]' }), system: '[[sub:x]] You are a subagent.' });
  assert.equal(textOf(sub.json), '[[c:sub.s1]] the subagent');
  const primary = await post(s.url, agentBody({ canary: '[[c:sub.in]]' }));
  assert.equal(textOf(primary.json), '[[c:sub.r1]] primary');
  const noted = await post(s.url, { ...agentBody({ canary: '' }), messages: [{ role: 'user', content: [{ type: 'text', text: '[refusal-rewind] The 1 most recent turn(s) were set aside because …' }] }] });
  assert.equal(textOf(noted.json), '[[c:sub.r2]] after the note');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'primary', 'primary']);
}));

test('T24: a step with namedAnywhere is told by its canary or an `also` text in any message of the request, and a step without it only by its last message', () => withStandin({}, async (s) => {
  const earlier = (text) => [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'read' }] }, { role: 'user', content: [{ type: 'text', text: 'and then' }] }];
  s.setStep(step('any', [{ text: '[[c:any.r1]] by canary' }, { text: '[[c:any.r2]] by note' }], { namedAnywhere: true, also: ['addressed message'] }));
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:any.in]] held') })).json), '[[c:any.r1]] by canary');
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[tune-out wake: chat — 1 addressed message]') })).json), '[[c:any.r2]] by note');
  s.setStep(step('last', [{ text: '[[c:last.r1]] never' }], { also: ['addressed message'] }));
  const missed = await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:last.in]] [tune-out wake: chat — 1 addressed message]') });
  assert.notEqual(missed.status, 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'unclassified']);
}));

test('T10: the same request always counts the same, at about 1.3 times context-manager\'s own estimate of prose, and an image counts by its size', () => withStandin({}, async (s) => {
  s.setStep(step('n', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = agentBody({ canary: '[[c:n.in]]' });
  const one = (await post(s.url, body)).json.usage;
  const two = (await post(s.url, body)).json.usage;
  const total = (u) => u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  assert.equal(total(one), total(two));
  const big = 29_000;
  const counted = s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: prose(big, 9) }] }] });
  const cmEstimate = Math.ceil(big / 2.9);
  assert.ok(counted > cmEstimate * 1.2 && counted < cmEstimate * 1.4, `${counted} vs ${cmEstimate}`);
  const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString('base64'); };
  const withImage = (w, h) => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(w, h) } }] }] });
  const small = s.countTokens(withImage(100, 100));
  const large = s.countTokens(withImage(750, 1000));
  assert.ok(large - small > 900, `${small} → ${large}`);
}));

test('T10b: denser text counts more tokens a character (prose, then code, JSON and base64), and a prose opening doesn\'t price a dense body as prose', () => withStandin({}, async (s) => {
  const count = async (text) => s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const empty = await count('');
  const rate = async (text) => (await count(text) - empty) / text.length;
  const code = (n) => 'const value_1 = read(index, total);\n'.repeat(Math.ceil(n / 36)).slice(0, n);
  const json = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const base64 = Buffer.from(Array.from({ length: 4500 }, (_, i) => (i * 37) % 256)).toString('base64');
  const rates = [await rate(prose(6000, 3)), await rate(code(6000)), await rate(json), await rate(base64)];
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2] && rates[2] < rates[3], rates.join(' < '));
  const opening = prose(2500, 4);
  const body = code(30_000);
  const mixed = await count(`${opening}${body}`) - empty;
  const apart = (await count(opening) - empty) + (await count(body) - empty);
  assert.ok(Math.abs(mixed - apart) <= apart * 0.02, `priced in stretches, as its parts are: ${mixed} vs ${apart}`);
  assert.ok(mixed > (await count(prose(32_500, 4)) - empty) * 1.1, 'not as prose');
}));

test('T11: a request over the window is refused as the API refuses it', () => withStandin({ windowTokens: 1000 }, async (s) => {
  s.setStep(step('o'));
  const r = await post(s.url, agentBody({ canary: '[[c:o.in]]', history: [{ role: 'user', content: [{ type: 'text', text: prose(8000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
  assert.match(r.json.error.message, /^prompt is too long: \d+ tokens > 1000 maximum$/);
}));

test('T12: a marked prefix is written, read back byte for byte while live on the virtual clock, and its lifetime follows its marker', () => withStandin({}, async (s) => {
  s.setStep(step('c', Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` }))));
  const history = (ttl, text = prose(4000, 5)) => [
    { role: 'user', content: [{ type: 'text', text: `user: ${text}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }] },
  ];
  const ask = async (h) => (await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:c.in]]', history: h }))).json.usage;
  s.setClock(0);
  const first = await ask(history());
  assert.ok(first.cache_creation_input_tokens > 1000);
  assert.equal(first.cache_read_input_tokens, 0);
  assert.equal(first.cache_creation.ephemeral_5m_input_tokens, first.cache_creation_input_tokens);
  s.setClock(4 * 60_000);
  const second = await ask(history());
  assert.equal(second.cache_read_input_tokens, first.cache_creation_input_tokens);
  assert.equal(second.cache_creation_input_tokens, 0);
  s.setClock(8 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, first.cache_creation_input_tokens);
  s.setClock(14 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, 0);
  await ask(history('1h'));
  s.setClock(40 * 60_000);
  const hour = await ask(history('1h'));
  assert.ok(hour.cache_read_input_tokens > 1000);
  assert.equal((await ask(history('1h', prose(4000, 6)))).cache_read_input_tokens, 0);
  // A one-hour entry is read back a minute before its hour is out, and not at the hour.
  s.setClock(100 * 60_000);
  for (const seed of [7, 8]) assert.ok((await ask(history('1h', prose(4000, seed)))).cache_creation.ephemeral_1h_input_tokens > 1000, 'two fresh one-hour entries');
  s.setClock(159 * 60_000);
  assert.ok((await ask(history('1h', prose(4000, 7)))).cache_read_input_tokens > 1000, 'read back at 59 minutes');
  s.setClock(160 * 60_000);
  assert.equal((await ask(history('1h', prose(4000, 8)))).cache_read_input_tokens, 0, 'gone at 60');
}));

test('T12: a cache entry is the model\'s own', () => withStandin({}, async (s) => {
  s.setStep(step('cm', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  // Above both models' minimum cacheable lengths, Claude Opus 4.6's 4,096 tokens the higher.
  const h = [{ role: 'user', content: [{ type: 'text', text: prose(12000, 5), cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }];
  const first = await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:cm.in]]', history: h }));
  assert.ok(first.json.usage.cache_creation_input_tokens > 4096, `the first request writes its prefix: ${first.json.usage.cache_creation_input_tokens}`);
  const same = await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:cm.in]]', history: h }));
  assert.equal(same.json.usage.cache_read_input_tokens, first.json.usage.cache_creation_input_tokens, 'the same model reads it back');
  const other = await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h, model: 'claude-opus-4-6' }));
  assert.equal(other.json.usage.cache_read_input_tokens, 0);
  assert.ok(other.json.usage.cache_creation_input_tokens > 4096, 'the other model writes its own');
}));

test('T12: the lookback counts 20 positions back from a marker, its own included, with a run of tool_use blocks, or of tool_result blocks, as one', () => withStandin({}, async (s) => {
  s.setStep({ ...step('lb', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:lb.in]]'] });
  const marked = { type: 'ephemeral' };
  const opening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5), cache_control: marked }] };
  const unmarkedOpening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5) }] };
  const ask = (n, k) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:lb.in]] ${n}`, cache_control: marked }, ...k] });
  const first = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [opening, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ask(1, [])] });
  assert.ok(first.json.usage.cache_creation_input_tokens > 0, 'premise: the opening is written');
  const calls = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `lb${i}`, name: 'time--now', input: {} }));
  const results = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `lb${i}`, content: `out ${i}` }));
  const turn = (n) => [{ role: 'assistant', content: [{ type: 'text', text: 'checking' }, ...calls(n)] }, { role: 'user', content: results(n) }];
  const wide = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...turn(25), ask(2, [])] });
  assert.equal(wide.json.usage.cache_read_input_tokens > 0, true, `a run of calls and a run of results are one position each: ${JSON.stringify(wide.json.usage)}`);
  const long = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...Array.from({ length: 21 }, () => turn(1)).flat(), ask(3, [])] });
  assert.equal(long.json.usage.cache_read_input_tokens, 0, `past 20 positions, nothing is read back: ${JSON.stringify(long.json.usage)}`);
  // At the edge: an assistant message of n text blocks puts the marker n + 1 positions after the opening, so the
  // opening is the 20th position counted back from it at n = 18, and the 21st at n = 19.
  const edge = (n, i) => post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, { role: 'assistant', content: Array.from({ length: n }, (_, k) => ({ type: 'text', text: `ok ${k}` })) }, ask(i, [])] });
  assert.ok((await edge(18, 4)).json.usage.cache_read_input_tokens > 0, 'the 20th position back is read');
  assert.equal((await edge(19, 5)).json.usage.cache_read_input_tokens, 0, 'the 21st isn\'t');
}));

test('T12: the messages cache keys on the thinking configuration\'s mode and budget, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('tk', Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))));
  const ask = async (thinking) => {
    const body = agentBody({ model: 'claude-opus-4-6', canary: '[[c:tk.in]]', history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(24000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ], extra: thinking ? { thinking } : {} });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(24000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage;
  };
  const first = await ask(null);
  assert.ok(first.cache_creation_input_tokens > 0 && first.cache_read_input_tokens === 0, 'premise: the system and the messages are written');
  const whole = (await ask(null)).cache_read_input_tokens;
  assert.equal(whole, first.cache_creation_input_tokens, 'premise: the same request reads both');
  const adaptive = await ask({ type: 'adaptive' });
  assert.ok(adaptive.cache_read_input_tokens > 0 && adaptive.cache_read_input_tokens < whole, `a new mode reads the system's prefix only (${adaptive.cache_read_input_tokens} of ${whole})`);
  assert.equal((await ask({ type: 'adaptive', display: 'summarized' })).cache_read_input_tokens, whole, 'the same mode with another display reads what it wrote');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 1024 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'another mode reads the system\'s prefix only');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 2048 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'and so does another budget');
}));

test('T12: the messages cache keys on whether any image is sent, in a message or a tool result, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('im', Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))));
  const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const ask = async (tail) => {
    const body = agentBody({ model: 'claude-opus-5-5', canary: '[[c:im.in]]', tail, history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(4000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ] });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(3000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage;
  };
  const first = await ask([]);
  const whole = (await ask([])).cache_read_input_tokens;
  assert.ok(whole > 0 && whole === first.cache_creation_input_tokens, 'premise: the same request reads what the first wrote');
  const inResult = await ask([{ type: 'tool_result', tool_use_id: 'x', content: [IMAGE] }]);
  assert.ok(inResult.cache_read_input_tokens > 0 && inResult.cache_read_input_tokens < whole, `an image in a tool result after the marker reads the system's prefix only (${inResult.cache_read_input_tokens} of ${whole})`);
  assert.equal((await ask([IMAGE])).cache_read_input_tokens, whole, 'an image in a message reads what that request wrote');
  assert.equal((await ask([])).cache_read_input_tokens, whole, 'and the request without one still reads its own');
}));

test('T12: a marked prefix shorter than its model\'s minimum isn\'t written: 4,096 tokens for Claude Opus 4.6 and Claude Haiku 4.5, 512 for Claude Opus 5.5 and Claude Haiku 5.5', () => withStandin({}, async (s) => {
  s.setStep(step('mn', Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` }))));
  const marked = (model, chars) => agentBody({ canary: '[[c:mn.in]]', model, history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(chars, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], tail: [{ type: 'text', text: 'end', cache_control: { type: 'ephemeral' } }] });
  for (const [model, minimum, under, over] of [['claude-opus-4-6', 4096, 7000, 10_000], ['claude-opus-5-5', 512, 200, 1600], ['claude-haiku-5-5', 512, 200, 1600], ['claude-haiku-4-5-20251001', 4096, 7000, 10_000]]) {
    const short = marked(model, under);
    const long = marked(model, over);
    assert.ok(countTokens(short) < minimum && countTokens(long) >= minimum, `premise: ${countTokens(short)} under ${minimum}, ${countTokens(long)} not`);
    const shortUsage = (await post(s.url, short)).json.usage;
    assert.equal(shortUsage.cache_creation_input_tokens, 0, `${model}: a ${countTokens(short)}-token prefix isn't written`);
    assert.equal(shortUsage.input_tokens, countTokens(short), 'and goes as input');
    assert.equal((await post(s.url, short)).json.usage.cache_read_input_tokens, 0, 'so nothing reads it');
    assert.equal((await post(s.url, long)).json.usage.cache_creation_input_tokens, countTokens(long), `${model}: a ${countTokens(long)}-token prefix is written`);
  }
}));

test('T48: the messages cache keys on output_config\'s effort, an effort the model takes by default reading as none sent, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('ef', Array.from({ length: 24 }, (_, i) => ({ text: `r${i}` }))));
  const ask = async (model, effort) => {
    const body = agentBody({ canary: '[[c:ef.in]]', model, history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(16_000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ], extra: effort ? { output_config: { effort } } : {} });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(16_000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.usage;
  };
  // The effort page: Claude Opus 5.5 and Claude Haiku 5.5 default to medium, every other model that takes effort to high.
  for (const [model, byDefault, other] of [['claude-haiku-5-5', 'medium', 'low'], ['claude-opus-5-5', 'medium', 'high'], ['claude-opus-4-6', 'high', 'low']]) {
    const first = await ask(model, null);
    const whole = (await ask(model, null)).cache_read_input_tokens;
    assert.ok(whole > 0 && whole === first.cache_creation_input_tokens, `premise: ${model}'s same request reads what the first wrote`);
    assert.equal((await ask(model, byDefault)).cache_read_input_tokens, whole, `${model}: ${byDefault}, its default, reads what no effort wrote`);
    const moved = await ask(model, other);
    assert.ok(moved.cache_read_input_tokens > 0 && moved.cache_read_input_tokens < whole, `${model}: ${other} reads the system's prefix only (${moved.cache_read_input_tokens} of ${whole})`);
    assert.equal((await ask(model, other)).cache_read_input_tokens, whole, `${model}: and ${other} again reads what it wrote`);
  }
}));

test('T56: a request carrying output_config.effort for a model that takes none, Claude Haiku 4.5, is refused as unclassified, naming the model, and the same request without it is answered', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const model = 'claude-haiku-4-5-20251001';
  s.setStep(step('he', [{ text: 'r1' }, { text: 'r2' }]));
  for (const effort of ['low', 'high']) {
    const r = await post(s.url, agentBody({ canary: '[[c:he.in]]', model, extra: { output_config: { effort } } }));
    assert.equal(r.status, 400, `${effort}: ${JSON.stringify(r.json)}`);
    assert.equal(seen.at(-1).kind, 'unclassified');
    assert.equal(seen.at(-1).reason, `it carries \`output_config.effort\`, and the model ${model} takes no effort`);
  }
  assert.equal((await post(s.url, agentBody({ canary: '[[c:he.in]]', model }))).status, 200, 'with no effort it is answered');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:he.in]]', model: 'claude-haiku-5-5', extra: { output_config: { effort: 'low' } } }))).status, 200, 'a model that takes effort is answered with one');
  await s.close();
}));

test('T57: a request carrying an output_config.effort the model doesn\'t take, as the effort page lists them, is refused as unclassified, naming the value and the model, and each value the page gives the model is answered', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('ev', Array.from({ length: 24 }, (_, i) => ({ text: `r${i}` }))));
  const send = (model, effort) => post(s.url, agentBody({ canary: '[[c:ev.in]]', model, extra: { output_config: { effort } } }));
  for (const [model, effort] of [['claude-opus-5-5', 'bogus'], ['claude-opus-4-6', 'bogus'], ['claude-opus-5-5', null], ['claude-opus-5-5', 'HIGH'], ['claude-opus-4-6', 'xhigh']]) {
    const r = await send(model, effort);
    assert.equal(r.status, 400, `${model} ${effort}: ${JSON.stringify(r.json)}`);
    assert.equal(seen.at(-1).kind, 'unclassified');
    assert.equal(seen.at(-1).reason, `it carries \`output_config.effort\` ${JSON.stringify(effort)}, which the model ${model} doesn't take`);
  }
  for (const [model, efforts] of [['claude-opus-4-6', ['low', 'medium', 'high', 'max']], ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']], ['claude-haiku-5-5', ['low', 'medium', 'high', 'xhigh', 'max']]]) {
    for (const effort of efforts) assert.equal((await send(model, effort)).status, 200, `${model} takes ${effort}`);
  }
  await s.close();
}));

function judgeBody({ events, document = `user: # fixture's context\n\n## Conversation (oldest shown first)\n\n[user] Tavy: [[c:old.in]] [[wake]] ${prose(2400, 2)}\n\n`, instructions = 'Wake me for [[wake]].' }) {
  const question = [`<new_events count="${events.length}">`, ...events.map((e) => `- 60s ago in w12-judge from u-tavy: ${e}`), '</new_events>', '', '<if_you_wait>', 'If you answer WAIT and nothing new arrives, fixture is next woken by:', '- in 57 min: its heartbeat (a check-in prompt, every 60 min)', '</if_you_wait>', '', '<instructions_from_fixture>', instructions, '</instructions_from_fixture>', '', 'Should fixture be woken now to respond? One line: "REPLY: <reason>" or "WAIT: <reason>".'].join('\n');
  return {
    model: 'claude-haiku-5-5', max_tokens: 4096, stream: false, output_config: { effort: 'low' },
    system: 'You are the reply judge for an AI agent named fixture. The agent isn\'t woken for every message: when new\nevents arrive, you decide whether now is a good time to wake it so it can respond.',
    messages: [{ role: 'user', content: [
      { type: 'text', text: document, cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'user: ## fixture\'s system prompt\n\nYou are the strategy fixture\'s agent.' },
      { type: 'text', text: `user: ${question}` },
    ] }],
  };
}

test('T49: the reply judge\'s request is answered REPLY when its batch carries the wake mark and WAIT when it doesn\'t, whatever the document and instructions carry, whatever the step; its record names the verdict and the batch\'s canaries', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const yes = await post(s.url, judgeBody({ events: ['[[c:j.a.in]] Tavy asks [[wake]] about the garden', '[[c:j.b.in]] and more'] }));
    assert.equal(yes.status, 200, JSON.stringify(yes.json));
    assert.match(textOf(yes.json), /^REPLY: \S/);
    const no = await post(s.url, judgeBody({ events: ['[[c:j.c.in]] Tavy talks to Ash'] }));
    assert.equal(no.status, 200, JSON.stringify(no.json));
    assert.match(textOf(no.json), /^WAIT: \S/);
    s.setStep(null);
    assert.match(textOf((await post(s.url, judgeBody({ events: ['[[c:j.d.in]] [[wake]]'] }))).json), /^REPLY: /, 'with no step set too');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['judge', 'reply', ['[[c:j.a.in]]', '[[c:j.b.in]]']], ['judge', 'wait', ['[[c:j.c.in]]']], ['judge', 'reply', ['[[c:j.d.in]]']]]);
});

test('T49: a reply judge\'s request whose last block holds no batch is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const body = judgeBody({ events: ['[[c:j.e.in]] [[wake]]'] });
  body.messages[0].content.at(-1).text = 'user: Should fixture be woken now to respond?';
  const r = await post(s.url, body);
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /new_events/);
}));

function reviewBody(events) {
  const text = [
    'The agent\'s rule "w12-mute" hides events from its context. The agent described it as:',
    '"the muted channel\'s chatter"',
    'The rule matches: {"channel":"*w12-mute"}',
    'From 2026-01-05T09:00:00.000Z to 2026-01-05T11:00:00.000Z it hid 2 events. Here they are:',
    '',
    ...events.map((e, i) => `#${i + 1} [09:01] mcpl:channel-incoming · fixture · w12-mute · u-tavy: ${e}`),
    '',
    'Which of these, if any, should the agent have seen? Answer with the JSON object.',
  ].join('\n');
  return {
    model: 'claude-haiku-5-5', max_tokens: 4096, stream: false, output_config: { effort: 'low' },
    system: 'You review a filter an AI agent set on its own attention. The agent wrote a rule that hides some incoming events',
    messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${text}` }] }],
  };
}

test('T50: a suppression review\'s request is answered with the JSON the review reads, flagging by number each event that carries the flag mark, and fitting when none does, whatever the step; its record names the verdict, every listed event\'s canary and the flagged ones\'', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const flagged = await post(s.url, reviewBody(['[[c:m.1.in]] the eye went on', '[[c:m.2.in]] [[flag]] Ash asks the fixture something', '[[c:m.3.in]] the eye went off']));
    assert.equal(flagged.status, 200, JSON.stringify(flagged.json));
    assert.deepEqual({ ...JSON.parse(textOf(flagged.json)), note: undefined }, { fits: false, flagged: [2], note: undefined });
    s.setStep(null);
    const fits = await post(s.url, reviewBody(['[[c:m.4.in]] the eye went on']));
    assert.deepEqual({ ...JSON.parse(textOf(fits.json)), note: undefined }, { fits: true, flagged: [], note: undefined });
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch, r.flagged]), [['review', 'flagged', ['[[c:m.1.in]]', '[[c:m.2.in]]', '[[c:m.3.in]]'], ['[[c:m.2.in]]']], ['review', 'fits', ['[[c:m.4.in]]'], []]]);
});

test('T50: a suppression review\'s request that lists no event is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const r = await post(s.url, reviewBody([]));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /lists no event/);
}));

function retrievalBody(system, text) {
  return { model: 'claude-haiku-4-5-20251001', max_tokens: 500, stream: false, temperature: 0, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${text}` }] }] };
}
const CONCEPTS_SYSTEM = 'You are a knowledge retrieval assistant. Given the recent conversation below, identify concepts, entities, topics, or themes that might benefit from background knowledge or lessons learned from previous research.';
const RELEVANCE_SYSTEM = 'You are a relevance filter. Given the current conversation context and a set of candidate knowledge lessons, determine which lessons are actually relevant to the current discussion.';

test('T51: retrieval\'s concept request is answered with a JSON array of the canaries its conversation names, in order and once each, or an empty one; its record names them', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const named = await post(s.url, retrievalBody(CONCEPTS_SYSTEM, 'Recent conversation:\nuser: Tavy: [[c:m.1.in]] the eye [[c:l.lesson-a]]\n\nfixture: [[c:m.1.r1]] went on [[c:l.lesson-a]]'));
    assert.equal(named.status, 200, JSON.stringify(named.json));
    assert.deepEqual(JSON.parse(textOf(named.json)), ['[[c:m.1.in]]', '[[c:l.lesson-a]]', '[[c:m.1.r1]]']);
    s.setStep(null);
    const none = await post(s.url, retrievalBody(CONCEPTS_SYSTEM, 'Recent conversation:\nuser: Tavy: the eye went on'));
    assert.deepEqual(JSON.parse(textOf(none.json)), []);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['concepts', 'named', ['[[c:m.1.in]]', '[[c:l.lesson-a]]', '[[c:m.1.r1]]']], ['concepts', 'none', []]]);
});

test('T51: retrieval\'s relevance request is answered with the ids of the candidate lessons whose content doesn\'t carry the stale mark; its record names every candidate\'s canary and the kept ones\'', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const asking = (lines) => retrievalBody(RELEVANCE_SYSTEM, `Current conversation:\nuser: Tavy: [[c:m.2.in]] [[c:l.lesson-a]] [[c:l.lesson-d]]\n\nCandidate lessons:\n${lines.join('\n')}`);
  try {
    s.setStep(step('elsewhere'));
    const filtered = await post(s.url, asking(['[370a9eb3] (0.50) [[c:l.lesson-a]] the eye went on', '[74bb5736] (0.50) [[c:l.lesson-d]] [[stale]] the eye went off']));
    assert.equal(filtered.status, 200, JSON.stringify(filtered.json));
    assert.deepEqual(JSON.parse(textOf(filtered.json)), ['370a9eb3']);
    const kept = await post(s.url, asking(['[1b49fcf3] (0.50) [[c:l.lesson-b]] the eye went on']));
    assert.deepEqual(JSON.parse(textOf(kept.json)), ['1b49fcf3']);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch, r.kept]), [['relevance', 'filtered', ['[[c:l.lesson-a]]', '[[c:l.lesson-d]]'], ['[[c:l.lesson-a]]']], ['relevance', 'kept', ['[[c:l.lesson-b]]'], ['[[c:l.lesson-b]]']]]);
});

test('T51: a relevance request that lists no candidate lesson is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const r = await post(s.url, retrievalBody(RELEVANCE_SYSTEM, 'Current conversation:\nuser: Tavy: [[c:m.2.in]] the eye\n\nCandidate lessons:\n'));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /lists no candidate lesson/);
}));

test('T52: a text block that opens with retrieval\'s `## Retrieved Knowledge` heading, as placed or as stored, is recorded as retrieved, and one quoting the heading later isn\'t', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const placed = { type: 'text', text: '## Retrieved Knowledge\n- [50%] [[c:l.lesson-a]] the eye went on (tags: fixture)' };
  const stored = { type: 'text', text: 'system_context:retrieval: ## Retrieved Knowledge, for the message beginning "Tavy: [[c:h.in]] the…"\n- [50%] [[c:l.lesson-a]] the eye went on (tags: fixture)' };
  const quoted = { type: 'text', text: 'Tavy: it said ## Retrieved Knowledge earlier' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [placed, stored, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.retrieved ?? null), [null, null, true, true, null]);
}));

const NAMING_SYSTEM = 'You are a session naming assistant. Given a brief summary of a conversation, generate a short, evocative name (2-4 words) that captures its essence. The name should be memorable and descriptive, like a chapter title.\n\nExamples of good names:\n- "Context Window Budgeting"\n\nRespond with ONLY the name, nothing else. No quotes, no explanation.';

test('T53: connectome-host\'s session naming request is answered with one name of at most 60 characters on one line, whatever the summary and the step; its record names the summary\'s canaries', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const ask = (summary) => post(s.url, { model: 'claude-haiku-4-5-20251001', max_tokens: 30, temperature: 0.8, stream: false, system: [{ type: 'text', text: NAMING_SYSTEM }], messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${summary}` }] }] });
  try {
    s.setStep(step('elsewhere'));
    const first = await ask('user: Tavy: [[c:n.1.in]] the eye\nfixture: [[c:n.1.r1]] went on');
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const name = textOf(first.json);
    assert.ok(name.length > 0 && name.length <= 60 && !name.includes('\n'), `a name the host keeps: ${JSON.stringify(name)}`);
    s.setStep(null);
    assert.equal(textOf((await ask('user: Tavy: nothing marked')).json), name, 'the same name for any summary');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['naming', 'named', ['[[c:n.1.in]]', '[[c:n.1.r1]]']], ['naming', 'named', []]]);
});

test('T54: a text block that opens with one of agent-framework\'s tags it has marked as supplied text, `\\[Gate: …]`, `\\[suppression review]` or `\\[wake onboarding]`, is recorded as that marked tag with the names written before it, a participant\'s and an author\'s, and not as a notice; an unmarked one is still the notice, and one quoting a marked tag later is neither', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const typed = { type: 'text', text: 'user: \\[Gate: 2 events matched] [[c:h.in]] typed at the console' };
  const sent = { type: 'text', text: 'user: Tavy: \\[Gate: 2 events matched] [[c:h.b]] sent on a channel' };
  const reviewed = { type: 'text', text: 'Tavy: \\[suppression review] and on' };
  const offered = { type: 'text', text: '\\[wake onboarding] and on' };
  const real = { type: 'text', text: 'user: [suppression review] Since 2026-01-05T09:00:00Z (2 hours), your suppress rules hid 2 events.' };
  const quoted = { type: 'text', text: 'Tavy: it said \\[Gate: 2 events matched] earlier' };
  const other = { type: 'text', text: 'user: Tavy: \\[host-notice] not one of its tags' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [typed, sent, reviewed, offered, real, quoted, other] }));
  const [record] = await s.close();
  const blocks = record.messages.at(-1).blocks.slice(-7);
  assert.deepEqual(blocks.map((b) => [b.markedNotice ?? null, b.notice ?? null, b.wakeLine ?? null]), [[{ tag: 'Gate', after: ['user'] }, null, null], [{ tag: 'Gate', after: ['user', 'Tavy'] }, null, null], [{ tag: 'suppression review', after: ['Tavy'] }, null, null], [{ tag: 'wake onboarding', after: [] }, null, null], [null, 'suppression review', null], [null, null, null], [null, null, null]]);
}));

test('T55: a text block holding agent-framework\'s `[delivered]` receipt as 0.32.0 and 0.33.0 write it when a turn\'s speech could be neither sent nor held as drafts is recorded as saying so; a receipt that sent or kept the speech, the same words supplied by someone else, and a summary quoting a receipt are not', () => withStandin({}, async (s) => {
  // appendProseDeliveryReceipt's notes, word for word: framework.ts:21091 at 0.32.0, :23709 at 0.33.0.
  const NOT_HELD = {
    '0.32.0': (count, error) => `${count} plain-speech segment(s) suppressed and NOT held as drafts (${error}) — the words remain only in your history`,
    '0.33.0': (count, error) => `${count} plain-speech segment(s) suppressed and NOT held as drafts (${error}) — the words remain only in your history`,
  };
  const KEPT = (count) => `${count} plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)`;
  s.setStep(step('d', [{ text: '[[c:d.r1]] seen' }]));
  const text = (t) => ({ type: 'text', text: t });
  const blocks = [
    ...Object.values(NOT_HELD).flatMap((note) => [
      text(`user: [delivered] nothing — ${note(1, 'ENOSPC: no space left on device')}`),
      text(`user: [delivered] plain speech → chat · ${note(2, 'the journal is closed')}`),
    ]),
    text(`user: [delivered] nothing — ${KEPT(1)}`),
    text('user: [delivered] plain speech → chat'),
    text(`user: Tavy: \\[delivered] nothing — ${NOT_HELD['0.33.0'](1, 'forged')}`),
    text(`Tavy: it said [delivered] nothing — ${NOT_HELD['0.33.0'](1, 'quoted')}`),
    text(`[user] [delivered] nothing — ${NOT_HELD['0.33.0'](1, 'summarised')}`),
  ];
  await post(s.url, agentBody({ canary: '[[c:d.in]]', tail: blocks }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.slice(-blocks.length).map((b) => b.notHeld ?? false), [true, true, true, true, false, false, false, false, false]);
}));

test('T1/T12: a request carrying a field the stand-in\'s cache doesn\'t model, or naming a model it knows no minimum for, is refused as unclassified, naming it; its record keeps its head', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('uf'));
    for (const [extra, named] of [[{ tool_choice: { type: 'auto' } }, '`tool_choice`'], [{ speed: 'fast' }, '`speed`'], [{ output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } } }, '`output_config.format`'], [{ model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5'], [{ model: 'constructor' }, 'constructor']]) {
      const r = await post(s.url, agentBody({ canary: '[[c:uf.in]]', extra }));
      assert.equal(r.status, 400);
      assert.ok(r.json.error.message.includes(named), `${r.json.error.message} names ${named}`);
    }
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
  assert.deepEqual(records[0].head.toolChoice, { type: 'auto' });
  assert.equal(records[1].head.rest, '{"speed":"fast"}');
});

test('T13: when the request\'s model binds thinking, a block whose request changed is refused, or set aside uncounted under the drop control; on a model that doesn\'t bind it\'s taken', async () => {
  const DROP = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  for (const [binds, control] of [[true, false], [true, true], [false, false]]) {
    const model = binds ? 'claude-opus-5-5' : 'claude-opus-4-6';
    await withStandin({}, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]', model }), ...(control ? { thinking: DROP } : binds ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}) };
      const first = (await post(s.url, opening)).json;
      const call = first.content.find((b) => b.type === 'tool_use');
      const next = (prefix, reply) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
        ],
      });
      assert.equal((await post(s.url, next(opening.messages[0], first.content))).status, 200, 'the block sent after the prefix it was minted under is taken');
      const count = async (body) => s.countTokens(body);
      assert.ok(await count(next(opening.messages[0], first.content)) > await count(next(opening.messages[0], first.content.filter((b) => b.type !== 'thinking'))), 'and it counts, under the drop control too');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const changed = next(changedPrefix, first.content);
      const withoutBlock = next(changedPrefix, first.content.filter((b) => b.type !== 'thinking'));
      const r = await post(s.url, changed);
      if (binds && !control) {
        assert.equal(r.status, 400);
        assert.equal(r.json.error.message, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.', 'the provider\'s own wording, which hosts read as a binding refusal');
        const reordered = { role: 'user', content: opening.messages[0].content.map(({ type, ...rest }) => ({ ...rest, type })) };
        assert.equal((await post(s.url, next(reordered, first.content))).status, 200, 'the same prefix with its keys in another order keeps the binding');
      } else if (binds) {
        assert.equal(r.status, 200);
        assert.equal(await count(changed), await count(withoutBlock), 'the block set aside counts for nothing');
        const billed = r.json.usage.input_tokens + r.json.usage.cache_read_input_tokens + r.json.usage.cache_creation_input_tokens;
        assert.equal(billed, await count(withoutBlock), 'nor is it billed');
        await withStandin({ windowTokens: await count(withoutBlock) }, async (t) => {
          t.setStep({ ...step('g', [{ text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
          assert.equal((await post(t.url, changed)).status, 200, 'nor counted against the window: it fits once the block is set aside');
        });
      } else {
        assert.equal(r.status, 200);
        assert.ok(await count(changed) > await count(withoutBlock), 'a block the model reads counts');
      }
    });
  }
});

test('T25: each request\'s record carries its head, the body\'s fields but its messages, and its anthropic-beta and anthropic-version headers: the API it is, the fields it names by value, and the rest as its text, masked as other texts are', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }, { text: 'g' }, { text: 'h' }, { text: 'i' }, { text: 'j' }, { text: 'k' }, { text: 'l' }, { text: 'm' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    const variants = [
      base,
      base,
      { ...base, tools: base.tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} (changed)` } : t)) },
      { ...base, system: [{ type: 'text', text: base.system, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { ...base, thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } },
      { ...base, metadata: { user_id: 'u' } },
    ];
    for (const v of variants) assert.equal((await post(s.url, v)).status, 200);
    assert.equal((await post(s.url, { ...base, metadata: { user_id: 'v' } })).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages', { 'anthropic-beta': 'b2-2026, b1-2026,b2-2026' })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: true } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: false } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system, citations: { enabled: true } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, metadata: { user_id: 'fork-x-0a1b2c3d-0000-4000-8000-000000000001' } })).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [same, again, tool, system, thinking, more, otherUser, beta, cited, uncited, typeless, typelessCited, forked] = records;
  assert.deepEqual(same.head, again.head, 'the same body, the same head');
  assert.equal(same.head.api, 'messages');
  assert.deepEqual(same.head.tools.map((t) => t.name), ['time--now']);
  assert.notEqual(tool.head.tools[0].sha, same.head.tools[0].sha, 'a tool\'s description moves its definition\'s digest');
  assert.deepEqual(system.head.system, [{ text: same.head.system[0].text, cache: '1h' }], 'a system block keeps its text and its marker');
  assert.deepEqual(thinking.head.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.equal(same.head.rest, null, 'nothing else on the body');
  assert.equal(more.head.rest, '{"metadata":{"user_id":"u"}}', 'a field no part names is kept as text');
  assert.equal(forked.head.rest, '{"metadata":{"user_id":"fork-x-UUID1"}}', 'with a fork\'s UUID masked');
  assert.notEqual(otherUser.head.rest, more.head.rest, 'by its value');
  assert.deepEqual(same.head.headers, { beta: [], version: '2023-06-01' }, 'the headers that change what a provider does');
  assert.deepEqual(beta.head.headers, { beta: ['b1-2026', 'b2-2026'], version: '2023-06-01' }, 'betas as a set');
  assert.match(cited.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a system block\'s other fields are digested');
  assert.equal('other' in same.head.system[0], false);
  assert.notEqual(uncited.head.system[0].other, cited.head.system[0].other, 'by its value');
  assert.match(typeless.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a block that lost its type differs from one that has it');
  assert.notEqual(typelessCited.head.system[0].other, cited.head.system[0].other, 'and so does one that lost it beside another field');
});

test('T13d: on a configuration that doesn\'t bind, thinking altered in the latest assistant message is refused with the page\'s 400, and the same thinking after a changed request ahead of it, or altered in an earlier message, is taken', () => withStandin({}, async (s) => {
  s.setStep({ ...step('th', [{ text: 'first', thinking: 'a thought' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:th.in]]'] });
  const opening = agentBody({ canary: '[[c:th.in]]', stream: false });
  const first = await post(s.url, opening);
  const thought = first.json.content.find((b) => b.type === 'thinking');
  assert.ok(thought?.signature, 'premise: the reply carries signed thinking');
  const next = (reply, system = opening.system, earlier = []) => ({ ...opening, system, messages: [...earlier, ...opening.messages, { role: 'assistant', content: reply }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:th.in]] and then' }] }] });
  const altered = await post(s.url, next([{ ...thought, thinking: `${thought.thinking} (changed)` }, { type: 'text', text: 'first' }]));
  assert.equal(altered.status, 400);
  assert.match(altered.json.error.message, /^messages\.1\.content\.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified$/);
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], 'You are the fixture agent, with another prompt.'))).status, 200, 'the request ahead changed, the thinking didn\'t');
  const older = [{ role: 'user', content: [{ type: 'text', text: 'user: before' }] }, { role: 'assistant', content: [{ ...thought, thinking: 'not what was signed' }, { type: 'text', text: 'old' }] }];
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], opening.system, older))).status, 200, 'the page says nothing of an earlier message');
}));

test('T1: a POST to count_tokens, or to another path not ending in /v1/messages, is recorded as unclassified, naming its method and route, and refused', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('ct'));
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:ct.in]] count me' }] }] };
  const counted = await post(s.url, body, '/v1/messages/count_tokens');
  const elsewhere = await post(s.url, body, '/v1/models');
  assert.deepEqual([counted.status, elsewhere.status], [404, 404]);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.reason]), [
    ['unclassified', 'it goes to POST /v1/messages/count_tokens, which no run sends and the stand-in doesn\'t model'],
    ['unclassified', 'it goes to POST /v1/models, which no run sends and the stand-in doesn\'t model'],
  ]);
});

test('a Messages body the codec can\'t read is refused as unclassified, naming why, never thrown on, and a transcript still reads the system and tools of one with no messages', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('bad'));
  const ok = agentBody({ canary: '[[c:bad.in]]', stream: false });
  for (const body of [{ ...ok, messages: {} }, { ...ok, system: {}, tool_choice: { type: 'auto' } }, { ...ok, messages: [] }]) {
    assert.equal((await post(s.url, body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.reason]), [
    ['unclassified', 'no messages'],
    ['unclassified', 'it carries `tool_choice`, which the stand-in\'s prompt cache doesn\'t model'],
    ['unclassified', 'no messages'],
  ]);
  const { view } = decoded('messages', { ...ok, messages: [] });
  assert.deepEqual([view.system, view.tools.map((t) => t.name), view.messages], ['You are the fixture agent.', ['time--now'], []]);
});

test('a body a codec throws on, reading, recording or answering it, is refused as unclassified with the exception as its reason, and the stand-in goes on serving', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('t', [{ text: '[[c:t.r1]] fine' }]));
  const ok = agentBody({ canary: '[[c:t.in]]', stream: false });
  const raw = (path, body) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sent = [
    ['/v1/messages', { ...ok, messages: [null] }],
    ['/elsewhere', { messages: [null] }],
    ['/v1/messages', { ...ok, tools: {} }],
    ['/v1/messages', { ...ok, messages: [{ role: 'user', content: [{ type: 'text', text: 123 }] }] }],
    ['/v1/responses', { model: 'gpt-6.1-sol', store: false, input: [{ type: 'reasoning', summary: {} }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:t.in]] go' }] }] }],
  ];
  const statuses = [];
  for (const [path, body] of sent) statuses.push((await raw(path, body)).status);
  assert.deepEqual(statuses, [400, 404, 400, 400, 400]);
  assert.equal((await post(s.url, ok)).status, 200, 'and serves the next request');
  const records = await s.close();
  assert.deepEqual(records.slice(0, 5).map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
  for (const i of [0, 3, 4]) assert.match(records[i].reason, /^the stand-in couldn't (read|answer) it: TypeError: /, records[i].reason);
  assert.equal(records[1].reason, 'it goes to POST /elsewhere, which no run sends and the stand-in doesn\'t model', 'a read that gave its reason keeps it, though the writer threw on the body');
  assert.equal(records[2].reason, 'its tools are not a list of tools');
  assert.match(decoded('messages', { messages: [null] }).reason, /^the stand-in couldn't read it: TypeError: /);
});

test('a throw while answering a claimed request, refusing it or sending a held reply after its release, records it as unclassified, tells onRequest so the driver fails the run, and the stand-in goes on serving', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen } = arrivals(s);
  try {
    s.setStep(step('t', [{ text: '[[c:t.r2]] two', settle: true, calls: [{ name: 'look', input: { n: 1n } }] }, { text: '[[c:t.r3]] three' }]));
    const badThinking = agentBody({ canary: '[[c:t.in]]', stream: false, history: [{ role: 'user', content: [{ type: 'text', text: 'before' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: ['bad'], signature: 'x' }, { type: 'text', text: 'ok' }] }] });
    assert.equal((await post(s.url, badThinking)).status, 400, 'refusing it throws');
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    const held = post(s.url, agentBody({ canary: '[[c:t.in]]', stream: false }));
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    s.releaseHeld(heldSeen[0].id);
    assert.equal((await held).status, 400, 'its held reply throws once released');
    assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:t.in]]', stream: false }))).json), '[[c:t.r3]] three', 'and the next request is served');
  } finally {
    const records = await s.close();
    assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent']);
    for (const r of records.slice(0, 2)) assert.match(r.reason, /^the stand-in couldn't answer it: TypeError: /, r.reason);
    for (const r of records.slice(0, 2)) assert.deepEqual(seen.filter((t) => t.id === r.id).map((t) => t.kind), ['agent', 'unclassified'], 'each is told to onRequest as claimed on arrival, then as unclassified');
    for (const r of seen.filter((t) => t.kind === 'unclassified')) assert.match(r.reason, /^the stand-in couldn't answer it: TypeError: /);
  }
});

test('a scripted reply with `hold` is held, and the stand-in tells onHeld its request and the reply\'s acts; a release sends the reply of the request it names and leaves the request held before it held', () => withStandin({}, async (s) => {
  const acts = [{ deliver: { id: 'h.arrival', participant: 'Tavy', text: '[[c:h.arr]] now' } }];
  s.setStep(step('h', [{ text: '[[c:h.r1]] settled', settle: true }, { text: '[[c:h.r2]] held', hold: true, during: acts }]));
  const heldSeen = [];
  s.onHeld((h) => heldSeen.push(h));
  const waitHeld = async (n) => {
    for (const until = performance.now() + 5000; heldSeen.length < n;) {
      if (performance.now() > until) assert.fail(`onHeld named ${heldSeen.length} of ${n} requests within 5 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const first = post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }));
  await waitHeld(1);
  const second = post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }));
  await waitHeld(2);
  assert.equal(heldSeen[0].during, undefined, 'a settle reply carries no acts');
  assert.deepEqual(heldSeen[1].during, acts, 'a held reply carries its acts');
  assert.equal(s.releaseHeld(heldSeen[1].id), true);
  assert.equal(textOf((await second).json), '[[c:h.r2]] held');
  assert.equal(s.releaseHeld(heldSeen[0].id), true, 'the request held before it is still held after that release');
  assert.equal(textOf((await first).json), '[[c:h.r1]] settled');
  assert.equal(s.releaseHeld(heldSeen[0].id), false, 'a request is released once');
}));

test('a Messages body whose system or tools are of the wrong kind is refused as unclassified, naming them, not read as having none', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('w', [{ text: '[[c:w.r1]] a' }, { text: '[[c:w.r1]] b' }, { text: '[[c:w.r1]] c' }]));
  const ok = agentBody({ canary: '[[c:w.in]]', stream: false });
  for (const body of [{ ...ok, system: {} }, { ...ok, system: [null] }, { ...ok, tools: [null] }]) assert.equal((await post(s.url, body)).status, 400, JSON.stringify(body.system ?? body.tools));
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.reason), [
    'its system is neither a string nor a list of blocks',
    'its system is neither a string nor a list of blocks',
    'its tools are not a list of tools',
  ]);
});

test('T25b: a request to another path ending in /v1/messages, one with an empty query, and a system block whose cache_control is null each record a head of their own', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep({ ...step('u', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:u.in]]'] });
  const base = agentBody({ canary: '[[c:u.in]]', stream: false });
  for (const [body, path] of [[base, '/v1/messages'], [base, '/proxy/v1/messages'], [base, '/v1/messages?'], [{ ...base, system: [{ type: 'text', text: base.system }] }, '/v1/messages'], [{ ...base, system: [{ type: 'text', text: base.system, cache_control: null }] }, '/v1/messages']]) {
    assert.equal((await post(s.url, body, path)).status, 200, path);
  }
  const [plain, prefixed, emptyQuery, absent, nulled] = await s.close();
  assert.equal('path' in plain.head || 'query' in plain.head, false, 'the path every host sends, with no query, adds nothing');
  assert.equal(prefixed.head.path, '/proxy/v1/messages');
  assert.equal(emptyQuery.head.query, '');
  assert.deepEqual([absent.head.system[0].cache, nulled.head.system[0].cache], [null, 'null']);
  assert.notDeepEqual(absent.head, nulled.head);
});

test('T26: a reply marked settle waits until releaseHeld, after onHeld names its request; an ordinary reply is answered at once', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    s.setStep({ ...step('q', [{ text: '[[c:q.r1]] held', settle: true }, { text: '[[c:q.r2]] plain' }]), canaries: ['[[c:q.in]]'] });
    let answered = null;
    const first = post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false })).then((r) => { answered = r; return r; });
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(Object.keys(heldSeen[0]).sort(), ['agent', 'id', 'step']);
    assert.equal(heldSeen[0].step, 'q');
    const second = await post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false }));
    assert.equal(textOf(second.json), '[[c:q.r2]] plain', 'the next request is answered while the first is held');
    assert.equal(answered, null, 'the held one is still waiting');
    s.releaseHeld(heldSeen[0].id);
    assert.equal(textOf((await first).json), '[[c:q.r1]] held');
  } finally { await s.close(); }
});

test('T27: a summary\'s id comes from what its request carries as sets (target, canaries, recalled summaries), not its wording, order or repeats', () => withStandin({}, async (s) => {
  s.setStep(step('i', []));
  const idOf = async (body) => textOf((await post(s.url, body)).json).match(/^\[\[s:M[0-9a-f]{8}\]\]/)[0];
  const base = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.2]]', '[[c:i.1]]', '[[c:i.2]]'] })), base, 'order and repeats leave it');
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], instruction: CHAT.replace('Speak in the first person', 'Use the first person'), textChars: 900 })), base, 'rewording and longer text leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]'] })), base, 'a recalled summary moves it');
  const recalled = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]', '[[s:M89abcdef]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M89abcdef]]', '[[s:M0123abcd]]', '[[s:M89abcdef]]'] })), recalled, 'recalled summaries\' order and repeats leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.3]]'] })), base, 'another canary moves it');
}));

test('T13b: a model that thinks leads every reply with signed thinking minted for its own request, and a scripted reply\'s thinking stands', async () => {
  await withStandin({ thinks: true }, async (s) => {
    s.setStep({ ...step('h', [{ text: 'first' }, { thinking: 'scripted', text: 'second' }]), canaries: ['[[c:h.in]]'] });
    const opening = { ...agentBody({ canary: '[[c:h.in]]', model: 'claude-opus-5-5' }), thinking: { type: 'adaptive', display: 'summarized' } };
    const one = (await post(s.url, opening)).json;
    assert.equal(one.content[0].type, 'thinking');
    assert.ok(one.content[0].thinking.length > 0 && typeof one.content[0].signature === 'string');
    const again = { ...opening, messages: [opening.messages[0], { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] and then?' }] }] };
    const two = await post(s.url, again);
    assert.equal(two.status, 200, 'its thinking, sent back after the prefix it was minted under, is taken by a binding model');
    assert.equal(two.json.content[0].thinking, 'scripted');
  });
  await withStandin({}, async (s) => {
    s.setStep({ ...step('k', [{ text: 'plain' }]), canaries: ['[[c:k.in]]'] });
    const one = (await post(s.url, agentBody({ canary: '[[c:k.in]]' }))).json;
    assert.deepEqual(one.content.map((b) => b.type), ['text'], 'a model that doesn\'t think replies without thinking');
  });
});

test('T13c: a thinking model\'s thinking comes from its request as the run-varying mask reads it, so an image ref\'s nonce doesn\'t change the words', () => withStandin({ thinks: true }, async (s) => {
  s.setStep({ ...step('q', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]), canaries: ['[[c:q.in]]'] });
  const ask = (ref) => ({ ...agentBody({ canary: '[[c:q.in]]' }), messages: [{ role: 'user', content: [{ type: 'text', text: `user: [[c:q.in]] see ${ref}` }] }] });
  const [one, two, other] = [await post(s.url, ask('img_abc123_4')), await post(s.url, ask('img_def456_4')), await post(s.url, ask('img_abc123_5'))].map((r) => r.json.content[0].thinking);
  assert.equal(one, two, 'the nonce masked');
  assert.notEqual(one, other, 'the ref\'s number still moves it');
}));

test('T7/T14/T15: summariser requests are answered at once, every arrival is reported, and close() returns each request\'s normalised record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen, until } = arrivals(s);
  s.setClock(123);
  s.setStep(step('r', [{ text: '[[c:r.r1]] ok' }, { text: '[[c:r.r2]] ok' }]));
  assert.equal((await post(s.url, summariserBody({ model: 'claude-opus-5-5', canaries: ['[[c:r.in]]'] }))).status, 200);
  await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:r.in]]' }));
  await until(2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'clock', 'id', 'kind', 'seq', 'step']);
  assert.equal(seen[0].clock, 123);
  assert.equal(seen[0].step, 'r');
  const records = await s.close();
  const [summ, agent] = records;
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.model, 'claude-opus-5-5');
  assert.equal(agent.maxTokens, 2048);
  assert.equal(agent.stream, true);
  assert.equal(agent.system.chars, 'You are the fixture agent.'.length);
  assert.match(agent.system.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(agent.tools, ['time--now']);
  assert.equal(agent.messages.at(-1).role, 'user');
  assert.deepEqual(agent.messages.at(-1).blocks[0].canaries, ['[[c:r.in]]']);
  assert.equal(typeof agent.usage.input_tokens, 'number');
  assert.equal(summ.kind, 'summariser');
  assert.equal(summ.answer.shape, 'summary');
});

test('T28: with a raw directory, each answer\'s content goes beside its request as r<n>.answer.json, a refused request leaves none, and tokensSent sums what the answers billed', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'standin-raw-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    s.setStep(step('w', [{ text: '[[c:w.r1]] noted', thinking: 'a thought' }, { text: '[[c:w.r2]] again' }]));
    const summBody = summariserBody({ model: 'claude-opus-5-5', canaries: ['[[c:w.in]]'] });
    const marked = agentBody({ model: 'claude-opus-5-5', canary: '[[c:w.in]]', history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(2000, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    marked.messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
    assert.ok(countTokens(marked) >= 512, 'premise: the marked prefix is over the model\'s minimum');
    const refusedBody = agentBody({ model: 'claude-opus-5-5', canary: '[[c:other.in]]' });
    const summ = await post(s.url, summBody);
    const agent = await post(s.url, marked);
    const again = await post(s.url, marked);
    const refused = await post(s.url, refusedBody);
    const records = await s.close();
    assert.equal(refused.status, 400);
    assert.deepEqual(readdirSync(rawDir).sort(), ['r1.answer.json', 'r1.json', 'r2.answer.json', 'r2.json', 'r3.answer.json', 'r3.json', 'r4.json']);
    const saved = (name) => JSON.parse(readFileSync(join(rawDir, name), 'utf-8'));
    assert.deepEqual([saved('r1.json'), saved('r2.json'), saved('r3.json'), saved('r4.json')], [summBody, marked, marked, refusedBody], 'each body as it was sent');
    assert.deepEqual(saved('r1.answer.json'), summ.json.content);
    assert.deepEqual(saved('r2.answer.json'), agent.json.content);
    assert.deepEqual(saved('r3.answer.json'), again.json.content);
    const billed = [summ.json.usage, agent.json.usage, again.json.usage];
    const sum = (k) => billed.reduce((t, u) => t + u[k], 0);
    assert.ok(sum('cache_creation_input_tokens') > 0 && sum('cache_read_input_tokens') > 0, 'the marked prefix was written, then read');
    assert.deepEqual(tokensSent(records), { input: sum('input_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), output: sum('output_tokens') });
  } finally { rmSync(rawDir, { recursive: true, force: true }); }
});

test('T29: every non-null cache marker moves the record: on the system, a message block or inside a tool result it shows as sent, a plain one as its TTL and any other shape whole; on a tool or the body it is held in that one\'s digest', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('k', Array.from({ length: 16 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:k.in]]'] });
    const odd = { type: 'ephemeral', ttl: '1h', scope: 'x' };
    const base = { ...agentBody({ canary: '[[c:k.in]]', stream: false }), system: [{ type: 'text', text: 'You are the fixture agent.' }] };
    const text = (cc) => ({ type: 'text', text: 'user: [[c:k.in]] hello', ...(cc !== null ? { cache_control: cc } : {}) });
    const nested = (cc) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[[c:k.in]] one' }, { type: 'text', text: 'two', ...(cc !== null ? { cache_control: cc } : {}) }] });
    const bodies = [
      { ...base, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral' })] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '1h' })] }] },
      { ...base, messages: [{ role: 'user', content: [text(odd)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'persistent' })] }] },
      { ...base, messages: [{ role: 'user', content: [nested(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(odd)] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: odd }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, tools: [{ ...TOOLS[0], cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text(false)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '' })] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: false }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(false)] }] },
    ];
    for (const body of bodies) assert.equal((await post(s.url, body)).status, 200, 'the stand-in judges no marker; the record shows it');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [none, plain, hour, oddBlock, persistent, nestedNone, nestedOdd, system, tool, top, falsy, emptyTtl, systemFalse, nestedFalse] = records;
  const shown = '{"scope":"x","ttl":"1h","type":"ephemeral"}';
  assert.deepEqual([none, plain, hour, oddBlock, persistent].map((r) => r.messages[0].blocks[0].cache ?? null), [null, '5m', '1h', shown, '{"type":"persistent"}']);
  assert.equal('contentCache' in nestedNone.messages[0].blocks[0], false);
  assert.deepEqual(nestedOdd.messages[0].blocks[0].contentCache, [null, shown]);
  assert.deepEqual(system.head.system, [{ text: 'You are the fixture agent.', cache: shown }]);
  assert.notEqual(tool.head.tools[0].sha, none.head.tools[0].sha, 'a tool\'s marker is in its definition\'s digest');
  assert.notEqual(top.head.rest, none.head.rest, 'the body\'s marker is in its rest');
  assert.deepEqual([falsy, emptyTtl].map((r) => r.messages[0].blocks[0].cache), ['false', '{"ttl":"","type":"ephemeral"}'], 'a falsy marker and an empty ttl are shown as sent, not as none or 5m');
  assert.equal(systemFalse.head.system[0].cache, 'false', 'on a system block');
  assert.deepEqual(nestedFalse.messages[0].blocks[0].contentCache, [null, 'false'], 'inside a tool result');
});

test('T30: a request\'s messages are masked together, so a result answering another fork than its call digests apart, and the same pair under other UUIDs alike', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('f', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]), canaries: ['[[c:f.in]]'] });
    const pair = (call, answered) => ({ ...agentBody({ canary: '[[c:f.in]]', stream: false }), messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:f.in]] fork it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `fork-fork-x-${call}`, name: 'subagent--fork', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-fork-x-${answered}`, content: [{ type: 'text', text: '[[c:f.in]] done' }] }] },
    ] });
    const [u1, u2, u3] = ['0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', '11111111-2222-4333-8444-555555555555'];
    for (const body of [pair(u1, u1), pair(u3, u3), pair(u1, u2)]) assert.equal((await post(s.url, body)).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [matched, other, crossed] = records;
  assert.deepEqual(other.messages.map((m) => m.digest), matched.messages.map((m) => m.digest), 'the same pairing under other UUIDs');
  assert.equal(crossed.messages[1].digest, matched.messages[1].digest);
  assert.notEqual(crossed.messages[2].digest, matched.messages[2].digest, 'a result naming another fork');
});

test('T31: each request\'s record carries when it arrived, in nanoseconds on the process\'s monotonic clock, after it was sent and before it was answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const stamps = [];
  try {
    s.setStep({ ...step('h', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:h.in]]'] });
    for (let i = 0; i < 2; i++) {
      const before = process.hrtime.bigint();
      assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }))).status, 200);
      stamps.push([before, process.hrtime.bigint()]);
    }
    records = await s.close();
  } finally { if (!records) await s.close(); }
  records.forEach((r, i) => {
    assert.match(r.arrived, /^\d+$/);
    assert.ok(BigInt(r.arrived) > stamps[i][0] && BigInt(r.arrived) < stamps[i][1], `${r.arrived} within its post`);
  });
});

test('T32: a message\'s other envelope fields are in its digest, its own cache marker among them, so adding or changing one moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('e', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:e.in]]'] });
    const ask = (extra) => ({ ...agentBody({ canary: '[[c:e.in]]', stream: false }), messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:e.in]] hello' }], ...extra }] });
    for (const extra of [{}, { name: 'ash' }, { name: 'tavy' }, { cache_control: { type: 'ephemeral' } }]) assert.equal((await post(s.url, ask(extra))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, named, renamed, marked] = records.map((r) => r.messages[0].digest);
  assert.notEqual(named, plain, 'a field added');
  assert.notEqual(renamed, named, 'a field changed');
  assert.notEqual(marked, plain, 'a marker on the message itself');
});

test('T33: a message\'s digest leaves out only the markers its record keeps, a block\'s and a tool result\'s blocks\' when not null, so a marker anywhere else, or a null one, moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('m', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:m.in]]'] });
    const image = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' };
    const result = (inner = {}, outer = {}, source = {}) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[[c:m.in]] one', ...inner }, { type: 'image', source: { ...image, ...source } }], ...outer });
    const ask = (block) => ({ ...agentBody({ canary: '[[c:m.in]]', stream: false }), messages: [{ role: 'user', content: [block] }] });
    const marker = { cache_control: { type: 'ephemeral' } };
    for (const block of [result(), result(marker), result({}, marker), result({}, {}, marker), result({}, { cache_control: null })]) assert.equal((await post(s.url, ask(block))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, inner, outer, deeper, nulled] = records.map((r) => r.messages[0].digest);
  assert.equal(inner, plain, 'a tool result block\'s marker is in contentCache');
  assert.equal(outer, plain, 'the block\'s own marker is its cache');
  assert.notEqual(deeper, plain, 'a marker on an image\'s source is kept nowhere else, so the digest takes it');
  assert.notEqual(nulled, plain, 'a null marker isn\'t kept as a marker, so the digest takes it');
});

test('T18: each message in a record has a digest that a non-null cache marker on any of its blocks and a tool image ref\'s nonce leave unchanged and a change in its text moves, and an answer records the tool_use ids it minted', async () => {
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    standin.setStep({ ...step('d', [{ text: '[[c:d.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call1]]' } }, { name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call2]]' } }] }, { text: '[[c:d.r2]] done' }, { text: '[[c:d.r3]] again' }]), canaries: ['[[c:d.in]]', '[[c:d.call1]]'] });
    const head = { model: 'claude-opus-4-6', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS };
    const opening = (ref, marked) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:d.in]] look at ${ref}`, ...(marked ? { cache_control: { type: 'ephemeral' } } : {}) }] });
    const first = await post(standin.url, { ...head, messages: [opening('img_abc123_4', false)] });
    const ids = first.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    const round = [{ role: 'assistant', content: first.json.content }, { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '[[c:d.call1]] ok' }] })) }];
    await post(standin.url, { ...head, messages: [opening('img_def456_4', true), ...round] });
    await post(standin.url, { ...head, messages: [opening('img_abc123_5', false), ...round] });
    records = await standin.close();
    const [one, two, three] = records;
    assert.ok(records.every((r) => r.kind === 'agent'), 'all three are the step\'s');
    assert.match(one.messages[0].digest, /^[0-9a-f]{16}$/);
    assert.equal(two.messages[0].digest, one.messages[0].digest, 'a cache marker and a ref\'s nonce leave it as it was');
    assert.notEqual(three.messages[0].digest, one.messages[0].digest, 'a change elsewhere in it, the ref\'s number here, changes it');
    assert.deepEqual(three.messages.slice(1).map((m) => m.digest), two.messages.slice(1).map((m) => m.digest), 'the round carried unchanged keeps its digests');
    assert.notEqual(two.messages[1].digest, two.messages[2].digest);
    assert.equal(ids.length, 2);
    assert.deepEqual(one.answer.toolUseIds, ids, 'the ids it minted, in order');
    assert.deepEqual(two.answer.toolUseIds, [], 'an answer that calls no tool mints none');
  } finally { if (!records) await standin.close(); }
});


test('T13e: where the request\'s model binds, thinking a host edited is refused with the page\'s 400 in any assistant message, under the drop control too, and a block whose text verifies but whose request changed is still refused, or set aside under the drop control', async () => {
  const DROP = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const modified = (i) => `messages.${i}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
  for (const control of [false, true]) {
    await withStandin({}, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, ...Array.from({ length: 6 }, () => ({ text: 'ok' }))]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]', model: 'claude-opus-5-5' }), thinking: control ? DROP : { type: 'adaptive', display: 'summarized' } };
      const first = (await post(s.url, opening)).json;
      const call = first.content.find((b) => b.type === 'tool_use');
      const next = (reply, prefix = opening.messages[0], more = []) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
          ...more,
        ],
      });
      const later = [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] and then' }] }];
      assert.equal((await post(s.url, next(first.content))).status, 200, 'the block as it was minted is taken');
      const altered = first.content.map((b) => (b.type === 'thinking' ? { ...b, thinking: `${b.thinking} (trimmed)` } : b));
      const latest = await post(s.url, next(altered));
      assert.deepEqual([latest.status, latest.json.error?.message], [400, modified(1)], 'edited in the latest assistant message');
      const earlier = await post(s.url, next(altered, opening.messages[0], later));
      assert.deepEqual([earlier.status, earlier.json.error?.message], [400, modified(1)], 'edited in an earlier one');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const moved = await post(s.url, next(first.content, changedPrefix, later));
      if (control) {
        assert.equal(moved.status, 200, 'its text verifies, so only its request changed, and the drop control sets it aside');
        const withoutBlock = next(first.content.filter((b) => b.type !== 'thinking'), changedPrefix, later);
        assert.equal(await s.countTokens(next(first.content, changedPrefix, later)), await s.countTokens(withoutBlock), 'set aside in an earlier message, it counts for nothing');
        assert.equal(moved.json.usage.input_tokens + moved.json.usage.cache_read_input_tokens + moved.json.usage.cache_creation_input_tokens, await s.countTokens(withoutBlock), 'nor is it billed');
      }
      else assert.deepEqual([moved.status, moved.json.error?.message], [400, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.']);
    });
  }
});

test('a request\'s head keeps its URL\'s query, so a move to an endpoint that adds one moves the record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    assert.equal((await post(s.url, base)).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages?beta=true')).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.head.query ?? null), [null, 'beta=true']);
});

test('repair marks: membrane\'s textified results and pending result, and context-manager\'s dropped-block, moved-result and stub texts, each by who wrote it', () => {
  assert.deepEqual(repairMarks('text', 'user: [orphan tool_result for toolu_1]: out; [duplicate tool_result for toolu_2, an error]: x'), ['membrane:orphan', 'membrane:duplicate']);
  assert.deepEqual(repairMarks('tool_result', '[pending]'), ['membrane:pending']);
  assert.deepEqual(repairMarks('text', 'a reply that says [pending] in passing'), [], 'only a result that is nothing but `[pending]` is membrane\'s');
  assert.deepEqual(repairMarks('text', 'user: [tool call omitted]'), ['context-manager:omitted']);
  assert.deepEqual(repairMarks('text', '[tool result moved during context repair]'), ['context-manager:moved']);
  assert.deepEqual(repairMarks('tool_result', '[this call\'s result isn\'t shown in this context. If you need its output and the tool only reads, call it again; you\'ll get what it returns now.]'), ['context-manager:stub']);
  assert.deepEqual(repairMarks('text', 'plain words'), []);
});

// The summariser's reading of the instruction, as `claim` makes it from a request's last text block.
const claimOf = (text) => {
  const c = summariser({}).claim({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  if (!c) return null;
  const f = c.fields((x) => x);
  return { kind: c.kind, ...(c.reason ? { reason: c.reason } : {}), level: f.level, target: f.target, texts: f.texts };
};

test('the summariser reads a block with no canary or summary marker as the instruction whole, on every API, and ends on every text, one that opens with a newline included', () => {
  // A text that opens with a newline is read, not looped on.
  for (const text of ['\nhello', '\n', '\n\n', '\n[[c:x.in]] hello', '']) assert.equal(claimOf(text), null, JSON.stringify(text));
  // A target before the opening's line stays the instruction's.
  assert.deepEqual(claimOf('Target ~300 tokens\nWrite the memory of this slice of the log.'), { kind: 'summariser', level: 1, target: 300, texts: ['Target ~300 tokens\nWrite the memory of this slice of the log.'] });
  // A later line quoting an opening doesn't take over: the merge stays a merge, at its own target.
  const merge = 'You have just reviewed the summaries in chronological order.\ninto a single L2 memory. Target ~300 tokens\nEarlier summary: Write the memory of this slice of the log. Target ~20 tokens';
  assert.deepEqual([claimOf(merge).level, claimOf(merge).target], [2, 300]);
  const repeated = 'Write the memory of this slice of the log. Target ~100 tokens\nWrite the memory of this slice of the log.';
  assert.deepEqual([claimOf(repeated).kind, claimOf(repeated).target], ['summariser', 100]);
});

test('the summariser reads a block whose slice carries canaries or summaries as the slice joined to the instruction: the instruction opens at the line of the first opening after the last marked line', () => {
  const instruction = 'Context Manager: Write the memory of events since the most recent memory system notification. Target ~300 tokens.\nEarlier: Write the memory of this slice of the log. Target ~20 tokens';
  const joined = claimOf(`[[c:j.in]] The plan said Target ~20 tokens, and L2 came up. Write the memory of this slice of the log.\nmore of that message\n${instruction}`);
  // The text before the instruction is the slice's, left out of the record's texts as it carries a canary.
  assert.deepEqual(joined, { kind: 'summariser', level: 1, target: 300, texts: [instruction] });
  // Summaries mark a merge's slice the same way.
  const merge = claimOf('[[s:M0123abcd]] Memory 0123abcd.\nContext Manager: You have just reviewed the L1 memories above, in chronological order. Merge them into a single L2 memory. Target ~400 tokens.');
  assert.deepEqual([merge.kind, merge.level, merge.target], ['summariser', 2, 400]);
  // No opening after the last marked line: an opening quoted in the slice doesn't make it the summariser's.
  assert.equal(claimOf('Write the memory of this slice of the log. Target ~20 tokens\n[[c:q.in]] hi'), null);
});

// The prefill membrane 0.8.0's anthropic-xml formatter sends: its opening user message, the transcript as the assistant's
// with a cache marker, and the agent's name to continue from.
const PREFILL = { agent: { formatter: 'anthropic-xml' } };
const prefillBody = ({ canary, model = 'claude-haiku-4-5-20251001', stream = true, before = '' }) => ({
  model, max_tokens: 2048, stream, system: 'You are the fixture agent.', stop_sequences: ['\nuser:', '</function_calls>'],
  messages: [
    { role: 'user', content: 'The transcript follows.' },
    { role: 'assistant', content: [{ type: 'text', text: `${before}user: ${canary} ${prose(300)}`, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    { role: 'assistant', content: 'fixture:' },
  ],
});
const fixtureCall = (canary) => ({ name: 'fixture--result', input: { kind: 'prose', size: 400, canary } });

test('T58: on the prefill formatter, a request ending in the assistant\'s prefill that carries the step\'s canary anywhere is answered by continuing it: the reply\'s literal thinking, its text, then its calls as membrane\'s XML, stopping on `</function_calls>`, which the text leaves out; a reply with no calls ends its turn; the stop sequence is null where a stream opens and in a reply cut at max_tokens', () => withStandin(PREFILL, async (s) => {
  s.setStep(step('p', [{ text: '[[c:p.r1]] first' }, { thinking: 'I should look.', text: '[[c:p.r2]] looking', calls: [fixtureCall('[[c:p.call1]]'), { name: 'time--now', input: {} }] }, { text: '[[c:p.r3]] again', calls: [fixtureCall('[[c:p.call2]]')] }, { text: `[[c:p.r4]] ${prose(400)}`, calls: [fixtureCall('[[c:p.call3]]')] }]));
  const one = await post(s.url, prefillBody({ canary: '[[c:p.in]]' }));
  assert.deepEqual(one.json.content, [{ type: 'text', text: ' [[c:p.r1]] first' }]);
  assert.deepEqual([one.json.stop_reason, one.json.stop_sequence], ['end_turn', null]);
  const calls = '<function_calls>\n<invoke name="fixture--result">\n<parameter name="kind">prose</parameter>\n<parameter name="size">400</parameter>\n<parameter name="canary">[[c:p.call1]]</parameter>\n</invoke>\n<invoke name="time--now">\n</invoke>\n';
  const second = await post(s.url, prefillBody({ canary: '[[c:p.in]]', stream: false, before: 'user: [[c:p.0]] earlier\n' }));
  const third = await post(s.url, prefillBody({ canary: '[[c:p.in]]' }));
  for (const [r, text] of [[second, ` <thinking>I should look.</thinking>\n[[c:p.r2]] looking\n${calls}`], [third, ' [[c:p.r3]] again\n<function_calls>\n<invoke name="fixture--result">\n<parameter name="kind">prose</parameter>\n<parameter name="size">400</parameter>\n<parameter name="canary">[[c:p.call2]]</parameter>\n</invoke>\n']]) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.content, [{ type: 'text', text }]);
    assert.deepEqual([r.json.stop_reason, r.json.stop_sequence], ['stop_sequence', '</function_calls>']);
  }
  assert.deepEqual([third.opening.stop_reason, third.opening.stop_sequence], [null, null], 'a stream opens with neither');
  const cut = await post(s.url, { ...prefillBody({ canary: '[[c:p.in]]' }), max_tokens: 20 });
  assert.deepEqual([cut.json.stop_reason, cut.json.stop_sequence], ['max_tokens', null], 'a reply cut at max_tokens stops on no sequence');
}));

test('T58: membrane\'s anthropic-xml formatter, built as the host builds it, reads the stand-in\'s prefill replies: the calls it parses are the scripted calls, it sends their results back in the transcript, and the turn ends on the scripted text', async () => {
  const s = await startStandin({ configuration: { windowTokens: 200_000, ...PREFILL } });
  s.setStep({ ...step('m', [{ text: '[[c:m.r1]] looking', calls: [fixtureCall('[[c:m.call1]]')] }, { text: '[[c:m.r2]] done' }]), canaries: ['[[c:m.in]]', '[[c:m.call1]]'] });
  const membrane = new Membrane(new AnthropicAdapter({ apiKey: 'sk-ant-fixture', baseURL: s.url, cacheKeepalive: { enabled: false } }), { formatter: new AnthropicXmlFormatter({ toolMode: 'xml', toolInjectionMode: 'system' }) });
  const seen = [];
  const answer = await membrane.stream({
    system: 'You are the fixture agent.', assistantParticipant: 'fixture',
    messages: [{ participant: 'user', content: [{ type: 'text', text: '[[c:m.in]] look this up' }] }],
    tools: [{ name: 'fixture--result', description: 'A result.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, size: { type: 'number' }, canary: { type: 'string' } } } }],
    config: { model: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
  }, { onToolCalls: async (calls) => { seen.push(...calls.map((c) => ({ name: c.name, input: c.input }))); return calls.map((c) => ({ toolUseId: c.id, content: '[[c:m.call1]] the result' })); } });
  assert.deepEqual(seen, [fixtureCall('[[c:m.call1]]')]);
  assert.match(answer.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), /\[\[c:m\.r2\]\] done/);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.answer?.stop]), [['agent', 'stop_sequence'], ['agent', 'end_turn']]);
  assert.deepEqual(records[1].messages.flatMap((m) => m.blocks.flatMap((b) => b.xmlResults ?? [])), ['[[c:m.call1]]']);
});

test('T59: an assistant-ended request is unclassified off the prefill formatter, and on it one whose prefill carries none of the step\'s canaries is unclassified, naming the prefill', async () => {
  for (const [configuration, canary, reason] of [[{}, '[[c:u.in]]', 'the last message is the assistant\'s'], [PREFILL, '[[c:x.in]]', 'its prefill carries none of step u\'s canaries (it carries [[c:x.in]])']]) {
    await withStandin(configuration, async (s) => {
      const { seen, until } = arrivals(s);
      s.setStep(step('u'));
      assert.equal((await post(s.url, prefillBody({ canary }))).status, 400);
      await until(1);
      assert.deepEqual([seen[0].kind, seen[0].reason], ['unclassified', reason]);
    });
  }
});

test('T59: on the prefill formatter, an assistant-ended request is the agent\'s only where its transcript ends in the agent\'s turn: in the agent\'s name, or in a tool round\'s results within the agent\'s run; one ending in another participant\'s is unclassified, naming why', () => withStandin(PREFILL, async (s) => {
  const { seen, until } = arrivals(s);
  s.setStep(step('y', [{ text: '[[c:y.r1]] one' }, { text: '[[c:y.r2]] two' }]));
  const ending = (tail) => ({ ...prefillBody({ canary: '[[c:y.in]]', stream: false }), messages: [...prefillBody({ canary: '[[c:y.in]]' }).messages.slice(0, -1), { role: 'assistant', content: tail }] });
  const results = '<function_calls>\n<invoke name="time--now">\n</invoke>\n</function_calls><function_results>\n<result>\n<stdout>\nnow\n</stdout>\n</result>\n</function_results>';
  assert.equal((await post(s.url, ending('reviewer:'))).status, 400);
  assert.equal((await post(s.url, ending(`reviewer: looking\n${results}`))).status, 400);
  assert.equal((await post(s.url, ending(`fixture: looking\n${results}`))).status, 200);
  assert.equal((await post(s.url, ending('fixture:'))).status, 200);
  await until(4);
  assert.deepEqual(seen.map((x) => [x.kind, x.reason ?? null]), [['unclassified', 'its prefill ends in no turn of fixture\'s'], ['unclassified', 'its prefill ends in no turn of fixture\'s'], ['agent', null], ['agent', null]]);
}));

test('T60: a prefill to a model the errors page says takes none, Claude Opus 4.6, Claude Opus 5.5 or Claude Haiku 5.5, is refused with its 400; Claude Haiku 4.5\'s is answered', () => withStandin(PREFILL, async (s) => {
  s.setStep({ ...step('v', Array.from({ length: 4 }, (_, i) => ({ text: `[[c:v.r${i}]] ok` }))) });
  for (const model of ['claude-opus-4-6', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    const r = await post(s.url, prefillBody({ canary: '[[c:v.in]]', model, stream: false }));
    assert.deepEqual([r.status, r.json.error.type, r.json.error.message], [400, 'invalid_request_error', 'This model does not support assistant message prefill. The conversation must end with a user message.'], model);
  }
  assert.equal((await post(s.url, prefillBody({ canary: '[[c:v.in]]', stream: false }))).status, 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.refused ?? null), ['prefill', 'prefill', 'prefill', null]);
}));

test('T60: a request the API refuses spends no scripted reply, so the request after it gets the step\'s next one', () => withStandin({}, async (s) => {
  s.setStep(step('w', [{ text: '[[c:w.r1]] first' }, { text: '[[c:w.r2]] second' }]));
  const refused = await post(s.url, { ...agentBody({ canary: '[[c:w.in]]', stream: false }), thinking: { type: 'between_tools' } });
  assert.equal(refused.status, 400);
  const answered = await post(s.url, agentBody({ canary: '[[c:w.in]]', stream: false }));
  assert.deepEqual(answered.json.content.map((b) => b.text), ['[[c:w.r1]] first']);
}));

test('T60: an assistant-ended request off the prefill formatter, which the stand-in doesn\'t classify, gets the API\'s prefill refusal where the model takes none, Claude Opus 4.6, and stays the stand-in\'s refusal where it takes one, Claude Haiku 4.5', () => withStandin({}, async (s) => {
  s.setStep(step('x'));
  const opus = await post(s.url, prefillBody({ canary: '[[c:x.in]]', model: 'claude-opus-4-6', stream: false }));
  assert.deepEqual([opus.status, opus.json.error.message], [400, 'This model does not support assistant message prefill. The conversation must end with a user message.']);
  const haiku = await post(s.url, prefillBody({ canary: '[[c:x.in]]', stream: false }));
  assert.equal(haiku.status, 400);
  assert.match(haiku.json.error.message, /^stand-in: unclassified request r2: the last message is the assistant's/);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.refused ?? null]), [['unclassified', 'prefill'], ['unclassified', null]]);
}));

test('T61: a text block holding membrane\'s XML transcript is recorded with the canaries of its results, including results an image split off at the block\'s end, and of the calls literal thinking led since the round before', () => {
  const call = (c) => `<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">${c}</parameter>\n</invoke>\n</function_calls>`;
  const results = (...cs) => `<function_results>\n${cs.map((c) => `<result>\n<stdout>\n${c} text\n</stdout>\n</result>\n`).join('')}</function_results>`;
  const transcript = `user: [[c:a.in]] go\nfixture: <thinking>look</thinking>\n[[c:a.r1]] looking\n${call('[[c:a.call1]]')}${results('[[c:a.call1]]')}\n[[c:a.r2]] again\n${call('[[c:a.call2]]')}${results('[[c:a.call2]]')}\nfixture: <thinking>more</thinking>\n${call('[[c:a.call3]]')}<function_results>\n<result>\n<stdout>\n[[c:a.call3]] split`;
  const r = blockRecord({ type: 'text', text: transcript });
  assert.deepEqual(r.xmlResults, ['[[c:a.call1]]', '[[c:a.call2]]', '[[c:a.call3]]']);
  assert.deepEqual(r.xmlThoughtCalls, ['[[c:a.call1]]', '[[c:a.call3]]']);
  const plain = blockRecord({ type: 'text', text: 'user: [[c:a.in]] <thinking>quoted</thinking> no rounds' });
  assert.deepEqual([plain.xmlResults, plain.xmlThoughtCalls], [undefined, undefined]);
  const later = blockRecord({ type: 'text', text: `fixture: <thinking>done</thinking>\n[[c:b.r1]] answered\nuser: [[c:b.in]] and now\nfixture: \n${call('[[c:b.call1]]')}` });
  assert.equal(later.xmlThoughtCalls, undefined, 'thinking that opened an earlier turn leads no call of a later one');
  const quoted = blockRecord({ type: 'text', text: `user: [[c:b.in]] it ends </thinking> there\nfixture: \n${call('[[c:b.call2]]')}` });
  assert.equal(quoted.xmlThoughtCalls, undefined, 'a closing tag in another participant\'s text leads no call');
  const afterResults = blockRecord({ type: 'text', text: `fixture: <thinking>look</thinking>\n${call('[[c:b.call3]]')}<function_results>\n<result>\n<stdout>\n[[c:b.call3]] it printed </thinking>\n</stdout>\n</result>\n</function_results>\n${call('[[c:b.call4]]')}` });
  assert.deepEqual(afterResults.xmlThoughtCalls, ['[[c:b.call3]]'], 'a closing tag in a result leads no later call');
});

test('T61: a text block holding membrane\'s XML transcript is recorded with the canaries of the results whose own result holds an image\'s placeholder, and of no other', () => {
  const placed = blockRecord({ type: 'text', text: '<function_results>\n<result>\n<stdout>\n[[c:p.c1]] text\n</stdout>\n</result>\n<result>\n<stdout>\n[image: image/png, ~3KB, ref img_a]\n[[c:p.c2]]\n</stdout>\n</result>\n</function_results>\nuser: [[c:p.in]] [image: image/png, ~2KB, ref img_b]' });
  assert.deepEqual(placed.xmlPlaceheld, ['[[c:p.c2]]']);
  const split = blockRecord({ type: 'text', text: '<function_results>\n<result>\n<stdout>\n[image: image/png, ~3KB, ref img_a]\n[[c:p.c3]]' });
  assert.deepEqual(split.xmlPlaceheld, ['[[c:p.c3]]'], 'a result an image split off at the block\'s end');
});

test('T62: on a configuration whose summaries come wrapped in thinking (C9h), a summary answer is the same memory wrapped whole in one closed literal `<thinking>` tag pair with no tag inside, the shape context-manager\'s recoverLiteralThinkingWrappedCompression reads as prose; its other answers are as without it', async () => {
  const answers = {};
  for (const wrapped of [false, true]) {
    await withStandin({ thinkingWrappedSummaries: wrapped }, async (s) => {
      s.setStep({ ...step('w'), badAnswers: ['thinking-only'] });
      const bad = (await post(s.url, summariserBody({ canaries: ['[[c:w.1]]'] }))).json.content[0].text;
      const good = (await post(s.url, summariserBody({ canaries: ['[[c:w.2]]'] }))).json.content[0].text;
      answers[wrapped] = { bad, good };
    });
  }
  assert.equal(answers.true.good, `<thinking>${answers.false.good}</thinking>`);
  assert.match(answers.true.good, /^<thinking>\[\[s:M[0-9a-f]{8}\]\] Memory [^<>]*<\/thinking>$/);
  assert.equal(answers.true.bad, answers.false.bad, 'a bad answer is as without it');
});

test('T63: on Claude Opus 5.5, whose thinking is always on, and Claude Haiku 5.5, which thinks unless asked not to, every answer leads with thinking signed for its request, empty unless the request asks display summarized: a summariser answer, which asks nothing, gains an empty block, and an agent\'s thinking goes empty under updates and stays under summarized; a summariser request disabling thinking on Haiku 5.5 is answered without; on Claude Opus 4.6 nothing changes', async () => {
  const asking = (thinking) => ({ ...agentBody({ canary: '[[c:a.in]]', stream: false }), thinking });
  const thinksUnasked = (summ, updates, summarized) => {
    assert.deepEqual(summ.content.map((b) => [b.type, b.thinking ?? null]), [['thinking', ''], ['text', null]]);
    assert.equal(typeof summ.content[0].signature, 'string');
    assert.deepEqual(updates.content.map((b) => [b.type, b.thinking ?? null]).slice(0, 1), [['thinking', '']]);
    assert.ok(summarized.content[0].thinking.length > 0, 'summarized keeps the thinking\'s text');
  };
  for (const [model, check] of [
    ['claude-opus-5-5', thinksUnasked],
    ['claude-haiku-5-5', thinksUnasked],
    ['claude-opus-4-6', (summ, updates, summarized) => {
      assert.deepEqual(summ.content.map((b) => b.type), ['text'], 'no thinking added on a model that thinks only when asked');
      assert.ok(updates.content[0].thinking.length > 0 && summarized.content[0].thinking.length > 0);
    }],
  ]) {
    await withStandin({ thinks: true }, async (s) => {
      s.setStep({ ...step('a', [{ text: 'one' }, { text: 'two' }]) });
      const summ = (await post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model })).json;
      const updates = (await post(s.url, { ...asking({ type: 'adaptive', display: 'updates' }), model })).json;
      const summarized = (await post(s.url, { ...asking({ type: 'adaptive', display: 'summarized' }), model })).json;
      check(summ, updates, summarized);
    });
  }
  await withStandin({}, async (s) => {
    const off = (await post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })).json;
    assert.deepEqual(off.content.map((b) => b.type), ['text'], 'Haiku 5.5 with thinking disabled answers without');
  });
});

test('T65: each thinking type the troubleshooting page\'s table rejects on a model is refused with a 400 in that page\'s words: enabled, disabled and between_tools on Claude Opus 5.5; enabled, between_tools, and disabled at effort xhigh or max on Claude Haiku 5.5; between_tools on Claude Opus 4.6; adaptive and between_tools on Claude Haiku 4.5; disabled at high on Haiku 5.5 is answered', () => withStandin({}, async (s) => {
  const ENABLED = '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  const DISABLED = '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  const BETWEEN = '"thinking.type.between_tools" is not supported for this model.';
  const ask = (model, thinking, effort) => post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model, thinking, ...(effort ? { output_config: { effort } } : {}) });
  for (const [model, thinking, effort, message] of [
    ['claude-opus-5-5', { type: 'enabled', budget_tokens: 2048 }, null, ENABLED],
    ['claude-opus-5-5', { type: 'disabled' }, null, DISABLED],
    ['claude-opus-5-5', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-5-5', { type: 'enabled', budget_tokens: 2048 }, null, ENABLED],
    ['claude-haiku-5-5', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-5-5', { type: 'disabled' }, 'xhigh', 'output_config.effort \'xhigh\' is not supported when thinking is disabled on this model. Use effort \'high\' or below, or enable thinking.'],
    ['claude-haiku-5-5', { type: 'disabled' }, 'max', 'output_config.effort \'max\' is not supported when thinking is disabled on this model. Use effort \'high\' or below, or enable thinking.'],
    ['claude-opus-4-6', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-4-5-20251001', { type: 'adaptive' }, null, 'adaptive thinking is not supported on this model'],
    ['claude-haiku-4-5-20251001', { type: 'between_tools' }, null, BETWEEN],
  ]) {
    const answer = await ask(model, thinking, effort);
    assert.deepEqual([answer.status, answer.json?.error?.message], [400, message], `${model} ${thinking.type}${effort ? ` at ${effort}` : ''}`);
  }
  assert.equal((await ask('claude-haiku-5-5', { type: 'disabled' }, 'high')).status, 200, 'disabled at high is accepted');
}));

test('T64: on Claude Opus 4.6, whose manual thinking doesn\'t interleave, an answer to a request asking `type: enabled` carries thinking only at a turn\'s start: after a user turn holding tool results it carries none, whether the results come alone, with text after them, or over two messages; under adaptive thinking, which interleaves, it keeps its thinking', () => withStandin({ thinks: true }, async (s) => {
  s.setStep({ ...step('i', [{ text: 'start', calls: [{ name: 'time--now', input: {} }] }, { text: 'after' }, { text: 'after, with text' }, { text: 'after, over two' }, { text: 'adaptive after' }]), canaries: ['[[c:i.in]]'], namedAnywhere: true });
  const enabled = { type: 'enabled', budget_tokens: 2048, display: 'summarized' };
  const start = (await post(s.url, { ...agentBody({ canary: '[[c:i.in]]', model: 'claude-opus-4-6', stream: false }), thinking: enabled })).json;
  assert.deepEqual(start.content.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'a turn\'s start thinks');
  const call = start.content.find((b) => b.type === 'tool_use');
  const history = [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:i.in]] go' }] }, { role: 'assistant', content: start.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'now' }] }];
  const round = (thinking) => ({ model: 'claude-opus-4-6', max_tokens: 2048, stream: false, system: 'You are the fixture agent.', tools: TOOLS, thinking, messages: history });
  assert.deepEqual((await post(s.url, round(enabled))).json.content.map((b) => b.type), ['text'], 'after results alone, no thinking');
  const withText = { ...round(enabled), messages: [...history.slice(0, -1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'now' }, { type: 'text', text: 'and more' }] }] };
  assert.deepEqual((await post(s.url, withText)).json.content.map((b) => b.type), ['text'], 'after results with text after them, no thinking');
  const overTwo = { ...round(enabled), messages: [...history, { role: 'user', content: [{ type: 'text', text: 'and more' }] }] };
  assert.deepEqual((await post(s.url, overTwo)).json.content.map((b) => b.type), ['text'], 'after results and a second user message, which the API joins to them, no thinking');
  assert.deepEqual((await post(s.url, round({ type: 'adaptive', display: 'summarized' }))).json.content.map((b) => b.type), ['thinking', 'text'], 'adaptive interleaves');
}));

test('W9\'s witnessed restart sets its own instruction for an inherited record, which the summariser reads as an L1 request with the target context-manager fills in', async () => {
  const { configurations } = await import('../lib/strategies/script.mjs');
  const { runOf } = await import('../lib/strategies/workloads.mjs');
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true } };
  const restart = runOf('H1/W9', configurations(), facts).steps().find((st) => st.id.endsWith('6.witnessed'));
  const { strategy } = restart.agent;
  assert.equal(typeof strategy.witnessedInstruction, 'string');
  assert.equal(typeof strategy.witnessedIdentityReminder, 'string');
  const claimed = claimOf(`Context Manager: ${strategy.witnessedInstruction.replace('{targetTokens}', '300')}\n\n${strategy.witnessedIdentityReminder}`);
  assert.deepEqual([claimed.kind, claimed.level, claimed.target], ['summariser', 1, 300]);
});
