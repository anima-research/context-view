import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIResponsesAPIAdapter } from '@animalabs/membrane';
import { startStandin as startServer, tokensSent } from '../lib/standin/standin.mjs';

const MODEL = 'gpt-6.1-sol';
const TOOLS = [{ type: 'function', name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } }];
const SYSTEM = 'You are the fixture agent.';

const started = new Set();
after(async () => { for (const s of started) await s.close(); });

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const ask = (messages, more = {}) => ({ model: MODEL, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
const wire = (text) => ({ model: MODEL, instructions: SYSTEM, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], store: false, stream: true });
const events = async (res) => (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

// The host's Codex adapter is membrane's Responses adapter in subscription mode, with a gate token as its credential and
// CODEX_BASE_URL as its base (connectome-host `codex-subscription-adapter.ts`), so the test drives that adapter so.
async function withStandin(configuration, fn, { fastMode = false } = {}) {
  const s = await startServer({ configuration: { windowTokens: 872_000, ...configuration } });
  started.add(s);
  const fallbacks = [];
  const codex = () => new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: async () => ({ token: 'gate-fixture' }), baseURL: `${s.url}/codex`, fastMode, onFastModeFallback: (tier) => fallbacks.push(tier) });
  const adapter = codex();
  const failure = (p) => p.then(() => assert.fail('the call was answered'), (e) => e);
  const post = (body) => fetch(`${s.url}/codex/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let records = null;
  try {
    await fn({ s, adapter, codex, failure, post, fallbacks, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

test('membrane\'s subscription mode gets the step\'s reply as its own blocks from the stream\'s items, since the Codex backend\'s response.completed carries none', () => withStandin({ thinks: true }, async ({ s, adapter, post, close }) => {
  s.setStep({ ...step('a', [{ text: '[[c:a.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:a.r2]] done' }, { text: '[[c:a.r3]] raw' }]), canaries: ['[[c:a.in]]', '[[c:a.call1]]'] });
  const opening = [user(`user: [[c:a.in]] ${prose(300)}`)];
  const first = await adapter.complete(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['redacted_thinking', 'text', 'tool_use']);
  assert.equal(first.content[1].text, '[[c:a.r1]] looking');
  assert.deepEqual(first.raw.output.map((i) => i.type), ['reasoning', 'message', 'function_call'], 'rebuilt by membrane from the items streamed');
  const call = first.content[2];
  const second = await adapter.complete(ask([...opening, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: `[[c:a.call1]] ${prose(200)}` }] }]));
  assert.deepEqual([second.content.at(-1).text, second.stopReason], ['[[c:a.r2]] done', 'end_turn']);
  const raw = await events(await post(wire('user: [[c:a.in]] raw')));
  assert.deepEqual(raw.find((e) => e.type === 'response.completed').response.output, []);
  assert.deepEqual(raw.filter((e) => e.type === 'response.output_item.done').map((e) => e.item.type), ['reasoning', 'message']);
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'agent']);
  assert.deepEqual(records[1].messages.map((m) => m.role), ['user', 'reasoning', 'assistant', 'function_call', 'function_call_output']);
  assert.equal(records[1].messages[1].blocks[0].sealed, true, 'the reasoning went back as the stand-in minted it');
}));

test('a Codex request\'s head names the Codex API, and its cache key and session_id header are recorded by shape, so two adapters\' runs of one conversation record and are answered alike', async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    await withStandin({ thinks: true }, async ({ s, codex, close }) => {
      s.setStep(step('h', [{ text: '[[c:h.r1]] a' }]));
      const reply = await codex().complete(ask([user('user: [[c:h.in]] hello')], { extra: { reasoning: { effort: 'medium' } } }));
      runs.push({ reply: reply.content.map((b) => b.text ?? b.data), records: await close() });
    });
  }
  const [[a], [b]] = runs.map((r) => r.records);
  assert.equal(a.head.api, 'codex');
  assert.equal(a.head.path, undefined, 'the route is the Codex backend\'s own');
  assert.equal(a.head.headers.sessionId, '<uuid>:<12 hex>');
  assert.match(a.head.rest, /"prompt_cache_key":"<uuid>:<12 hex>"/);
  assert.equal(a.head.maxOutputTokens, null, 'subscription mode sends no output limit');
  assert.deepEqual(a.head, b.head);
  assert.deepEqual(runs[0].reply, runs[1].reply);
});

test('fast mode asks for the priority tier, and the answer echoes default as the Codex backend\'s does, which membrane reports once', () => withStandin({}, async ({ s, adapter, close, fallbacks }) => {
  s.setStep(step('f', [{ text: 'a' }, { text: 'b' }]));
  await adapter.complete(ask([user('user: [[c:f.in]] go')]));
  await adapter.complete(ask([user('user: [[c:f.in]] again')]));
  const records = await close();
  assert.deepEqual(records.map((r) => r.head.serviceTier), ['priority', 'priority']);
  assert.deepEqual(fallbacks, ['default']);
}, { fastMode: true }));

test('cache reads are reported in whole blocks of 128 tokens and writes never, as the Codex backend reports them, and the totals take them apart', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('c', [{ text: 'one' }, { text: 'two' }]));
  const long = [user(`user: [[c:c.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(long));
  const second = await adapter.complete(ask([...long, { role: 'assistant', content: first.content }, user('user: [[c:c.in]] and then')]));
  const records = await close();
  const u = records.map((r) => r.usage.input_tokens_details);
  assert.deepEqual(u.map((d) => d.cache_write_tokens), [0, 0]);
  assert.equal(u[0].cached_tokens, 0);
  assert.ok(u[1].cached_tokens >= 1024 && u[1].cached_tokens % 128 === 0, `${u[1].cached_tokens}`);
  assert.equal(second.usage.cacheReadTokens, u[1].cached_tokens, 'as membrane reads it');
  const sum = tokensSent(records);
  assert.equal(sum.cacheWrite, 0);
  assert.equal(sum.input + sum.cacheRead, records.reduce((t, r) => t + r.usage.input_tokens, 0));
}));

test('a request carrying what the Codex backend refuses is refused with a 400 naming it, which membrane reads as an invalid request', () => withStandin({}, async ({ s, adapter, failure, post, close }) => {
  s.setStep(step('r', Array.from({ length: 8 }, () => ({ text: 'a' }))));
  const e = await failure(adapter.complete(ask([user('user: [[c:r.in]] go')], { extra: { metadata: { who: 'fixture' } } })));
  assert.deepEqual([e.httpStatus, e.type], [400, 'invalid_request']);
  const body = { model: MODEL, instructions: SYSTEM, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:r.in]] go' }] }], store: false, stream: true };
  const cases = [
    [{ temperature: 0.5 }, 'temperature'],
    [{ input: 'user: [[c:r.in]] go' }, 'input'],
    [{ instructions: undefined }, 'instructions'],
    [{ store: true }, 'store'],
    [{ service_tier: 'flex' }, 'service_tier'],
    [{ tools: [{ type: 'web_search_preview' }] }, 'tools'],
  ];
  for (const [change] of cases) {
    const res = await post({ ...body, ...change });
    assert.equal(res.status, 400, JSON.stringify(change));
  }
  assert.equal((await post({ ...body, service_tier: 'priority' })).status, 200);
  const records = await close();
  assert.deepEqual(records.map((r) => r.refused ?? null), ['request', ...cases.map(() => 'request'), null]);
  assert.deepEqual(records.slice(1, -1).map((r) => r.answer.shape), cases.map(() => 'refused'));
}));

test('an input past the window is a streamed response.failed for context_length_exceeded, which membrane reads as context length', () => withStandin({ windowTokens: 1000 }, async ({ s, adapter, failure, post, close }) => {
  s.setStep(step('w', [{ text: 'a' }, { text: 'b' }]));
  const e = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  assert.equal(e.type, 'context_length');
  const res = await post(wire(`user: [[c:w.in]] ${prose(8000)}`));
  assert.equal(res.status, 200);
  assert.deepEqual((await events(res)).at(-1).response.error.code, 'context_length_exceeded');
  const records = await close();
  assert.deepEqual(records.map((r) => r.refused), ['window', 'window']);
}));

test('a scripted overload is a streamed response.failed for server_is_overloaded, which membrane retries', () => withStandin({}, async ({ s, adapter, failure, post }) => {
  const overload = { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } };
  s.setStep(step('o', [overload, overload]));
  const e = await failure(adapter.complete(ask([user('user: [[c:o.in]] go')])));
  assert.equal(e.retryable, true);
  const res = await post(wire('user: [[c:o.in]] go'));
  assert.equal(res.status, 200);
  assert.deepEqual((await events(res)).at(-1).response.error.code, 'server_is_overloaded');
}));

test('a request the stand-in has no model of on the Codex backend is refused as unclassified, naming why, and the Responses API\'s route is still the API\'s', () => withStandin({}, async ({ s, adapter, failure, post, close }) => {
  s.setStep(step('u', [{ text: 'a' }, { text: 'b' }]));
  const body = { model: MODEL, instructions: SYSTEM, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:u.in]] go' }] }], store: false, stream: true };
  assert.equal((await post({ ...body, stream: false })).status, 400);
  await failure(adapter.complete(ask([user('user: [[c:u.in]] go')], { extra: { context_management: [{ type: 'compaction', compact_threshold: 1000 }] } })));
  assert.equal((await post({ ...body, prompt_cache_retention: '24h' })).status, 400);
  await fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'agent']);
  assert.match(records[0].reason, /isn't streamed/);
  assert.match(records[1].reason, /`context_management`/);
  assert.match(records[2].reason, /`prompt_cache_retention`/);
  assert.equal(records[3].head.api, 'responses');
}));
