import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '@animalabs/membrane';
import { startStandin as startServer, tokensSent } from '../lib/standin/standin.mjs';

const OPENAI = 'gpt-5.6-sol';
const DEEPSEEK = 'deepseek-flash';
const TOOLS = [{ name: 'time--now', description: 'now', inputSchema: { type: 'object', properties: {} } }];
const SYSTEM = 'You are the fixture agent.';
const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';

const started = new Set();
after(async () => { for (const s of started) await s.close(); });

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (content) => ({ role: 'assistant', content });
const result = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withStandin(configuration, dialect, fn) {
  const s = await startServer({ configuration: { windowTokens: 922_000, ...configuration } });
  started.add(s);
  const model = dialect === 'deepseek' ? DEEPSEEK : OPENAI;
  const adapter = new OpenAICompatibleAdapter({ baseURL: dialect === 'deepseek' ? s.url : `${s.url}/v1`, apiKey: 'sk-fixture' });
  const ask = (messages, more = {}) => ({ model, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
  const streamed = (request) => adapter.stream(request, { onChunk: () => {} });
  const failure = (p) => p.then(() => assert.fail('the call was answered'), (e) => e);
  // A request built by hand, for what membrane's adapter never sends.
  const post = (path, body) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let records = null;
  try {
    await fn({ s, adapter, ask, streamed, failure, post, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

test('membrane\'s OpenAI-compatible adapter, streamed and not, gets the step\'s reply from OpenAI\'s Chat Completions as its own blocks: the text, then the call; the reasoning isn\'t sent, and its tokens count in completion_tokens', () => withStandin({ thinks: true }, 'openai', async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('a', [{ text: '[[c:a.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:a.r2]] done' }]), canaries: ['[[c:a.in]]', '[[c:a.call1]]'] });
  const opening = [user(`user: [[c:a.in]] ${prose(300)}`)];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(first.content[0].text, '[[c:a.r1]] looking');
  assert.deepEqual([first.content[1].name, first.content[1].input], ['time--now', { zone: 'UTC' }]);
  assert.equal(first.stopReason, 'tool_use');
  const call = first.content[1].id;
  const second = await adapter.complete(ask([...opening, reply(first.content), result(call, `[[c:a.call1]] ${prose(200)}`)]));
  assert.deepEqual(second.content.map((b) => b.type), ['text']);
  assert.equal(second.content[0].text, '[[c:a.r2]] done');
  assert.equal(second.stopReason, 'end_turn');
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent']);
  assert.equal(records[0].answer.toolUseIds[0], call, 'the call goes with the id the reply minted');
  for (const [r, got] of [[records[0], first], [records[1], second]]) {
    assert.ok(r.usage.completion_tokens_details.reasoning_tokens > 0, 'the model reasons on every reply');
    assert.ok(r.usage.completion_tokens > r.usage.completion_tokens_details.reasoning_tokens, 'and the visible reply counts beside it');
    assert.equal(got.usage.outputTokens, r.usage.completion_tokens, 'as membrane reads it');
  }
}));

test('each wire message is a message of the record, with its own digest and the side its turn is on; a tool message is one of its own', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep({ ...step('b', [{ text: 'calling', calls: [{ name: 'time--now', input: {} }, { name: 'time--now', input: { zone: 'UTC' } }] }, { text: 'one' }, { text: 'two' }]), canaries: ['[[c:b.in]]'] });
  const opening = [user('user: [[c:b.in]] go')];
  const first = await adapter.complete(ask(opening));
  const [c1, c2] = first.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const results = { role: 'user', content: [{ type: 'tool_result', tool_use_id: c1, content: '[[c:b.in]] noon' }, { type: 'tool_result', tool_use_id: c2, content: 'midday' }] };
  await adapter.complete(ask([...opening, reply(first.content), results]));
  await adapter.complete(ask([...opening, reply(first.content), { ...results, content: [results.content[0], { ...results.content[1], content: 'twelve' }] }]));
  const [, kept, changed] = await close();
  assert.deepEqual(kept.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(kept.messages.map((m) => m.side), ['system', 'user', 'assistant', 'user', 'user']);
  assert.equal(new Set(kept.messages.map((m) => m.digest)).size, 5);
  assert.deepEqual(kept.messages[2].blocks.map((b) => [b.type, b.toolUseId]), [['text', undefined], ['tool_use', c1], ['tool_use', c2]]);
  assert.deepEqual(kept.messages.slice(3).map((m) => m.blocks[0].toolUseId), [c1, c2]);
  assert.deepEqual(kept.messages[3].blocks[0].canaries, ['[[c:b.in]]']);
  assert.deepEqual(changed.messages.slice(0, 4).map((m) => m.digest), kept.messages.slice(0, 4).map((m) => m.digest));
  assert.notEqual(changed.messages[4].digest, kept.messages[4].digest, 'only the changed tool message\'s digest moves');
}));

test('membrane sends a message\'s text blocks as one string and a tool result as text only, so a block\'s record keeps its summaries\' and canaries\' order in `marks` and counts membrane\'s text for an image it didn\'t show', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep({ ...step('j', [{ text: 'x' }]), canaries: ['[[c:j.in]]'] });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await adapter.complete(ask([
    user('user: [[c:j.0]] hi'),
    reply([{ type: 'text', text: '[[s:M0123abcd]] a summary' }, { type: 'text', text: '[[c:j.r0]] a reply' }, { type: 'tool_use', id: 'call_1', name: 'time--now', input: {} }]),
    result('call_1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: '[[c:j.call1]]' }]),
    user('user: [[c:j.in]] go'),
  ]));
  const [r] = await close();
  const [joined] = r.messages.find((m) => m.role === 'assistant').blocks;
  assert.deepEqual(joined.marks, ['[[s:M0123abcd]]', '[[c:j.r0]]']);
  assert.equal(r.messages.find((m) => m.role === 'user').blocks[0].marks, undefined, 'a block with one kind has none');
  const tool = r.messages.find((m) => m.role === 'tool').blocks[0];
  assert.deepEqual([tool.imagesNotShown, tool.images, tool.canaries], [1, undefined, ['[[c:j.call1]]']]);
}));

test('a request\'s head names the Chat Completions API and its fields, and the rest of the body as its text', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep(step('h', [{ text: 'a' }]));
  await adapter.complete(ask([user('user: [[c:h.in]] hello')], { extra: { reasoning_effort: 'high', parallel_tool_calls: false } }));
  const [r] = await close();
  assert.deepEqual(
    { api: r.head.api, model: r.head.model, maxTokens: r.head.maxTokens, maxCompletionTokens: r.head.maxCompletionTokens, reasoningEffort: r.head.reasoningEffort, tools: r.head.tools.map((t) => t.name) },
    { api: 'chat-completions', model: OPENAI, maxTokens: null, maxCompletionTokens: 2048, reasoningEffort: 'high', tools: ['time--now'] },
    'membrane sends a GPT-5 model max_completion_tokens',
  );
  assert.equal(r.head.rest, '{"parallel_tool_calls":false}');
}));

test('the prompt cache is OpenAI\'s for GPT-5.6 and later, as on the Responses API: written at the latest user message, read back exactly there, cached and written tokens inside prompt_tokens, which the totals take apart', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep(step('c', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
  const long = [user(`user: [[c:c.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(long));
  s.setClock(20 * 60_000);
  await adapter.complete(ask([...long, reply(first.content), user('user: [[c:c.in]] and then')]));
  const short = await adapter.complete(ask([user('user: [[c:c.in]] hi')]));
  const records = await close();
  const u = records.map((r) => r.usage.prompt_tokens_details);
  assert.ok(u[0].cache_write_tokens >= 1024, `${u[0].cache_write_tokens}`);
  assert.equal(u[0].cached_tokens, 0);
  assert.equal(u[1].cached_tokens, u[0].cache_write_tokens, 'read at the first request\'s breakpoint, exactly');
  assert.equal(u[1].cache_write_tokens, records[1].usage.prompt_tokens - u[0].cache_write_tokens);
  assert.deepEqual([u[2].cached_tokens, u[2].cache_write_tokens], [0, 0], 'a prefix under 1,024 tokens is neither read nor written');
  assert.equal(short.usage.cacheReadTokens ?? 0, 0);
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, records.reduce((t, r) => t + r.usage.prompt_tokens, 0));
  assert.equal(sum.cacheRead, u[0].cache_write_tokens);
}));

test('a tool message ends an eligible message only as the last of a run of them', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep({ ...step('t', [{ text: 'calling', calls: [{ name: 'time--now', input: {} }, { name: 'time--now', input: { a: 1 } }] }, { text: 'one' }, { text: 'two' }]), canaries: ['[[c:t.in]]'] });
  const opening = [user(`user: [[c:t.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(opening));
  const [c1, c2] = first.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const one = { type: 'tool_result', tool_use_id: c1, content: `[[c:t.in]] ${prose(3000, 2)}` };
  await adapter.complete(ask([...opening, reply(first.content), { role: 'user', content: [one] }]));
  await adapter.complete(ask([...opening, reply(first.content), { role: 'user', content: [one, { type: 'tool_result', tool_use_id: c2, content: 'b' }] }]));
  const [opened, alone, run] = (await close()).map((r) => r.usage.prompt_tokens_details);
  assert.ok(alone.cache_write_tokens > 0, 'a request ending with one tool message writes at its end');
  assert.equal(run.cached_tokens, opened.cache_write_tokens, 'in a run of two, the first one\'s end is no lookup ending, so the read is the opening\'s prefix');
}));

test('a request over the window is refused with a 400 membrane reads as context length, and a reply cut at its limit ends with finish_reason length, which membrane reads as max_tokens', () => withStandin({ windowTokens: 1000 }, 'openai', async ({ s, adapter, ask, failure, close }) => {
  s.setStep(step('w', [{ text: 'never' }, { text: prose(4000) }]));
  const err = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  assert.equal(err.type, 'context_length');
  const cut = await adapter.complete(ask([user('user: [[c:w.in]] short')], { maxTokens: 50 }));
  assert.equal(cut.stopReason, 'max_tokens');
  const [refused] = await close();
  assert.equal(refused.refused, 'window');
}));

test('a scripted overloaded error reaches membrane as the API\'s 503 server_is_overloaded, which it retries', () => withStandin({}, 'openai', async ({ s, adapter, ask, failure }) => {
  s.setStep(step('o', [{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }]));
  const err = await failure(adapter.complete(ask([user('user: [[c:o.in]] hi')])));
  assert.equal(err.httpStatus, 503);
  assert.equal(err.retryable, true);
}));

test('a refusal is the API\'s `refusal` field with no content, which membrane 0.8.0\'s OpenAI-compatible adapter doesn\'t read, so the reply reaches it with no text', () => withStandin({}, 'openai', async ({ s, adapter, ask, streamed }) => {
  s.setStep(step('r', [{ text: 'I can\'t help with that.', stop: 'refusal' }, { text: 'I can\'t help with that.', stop: 'refusal' }]));
  const plain = await adapter.complete(ask([user('user: [[c:r.in]] hi')]));
  const flowing = await streamed(ask([user('user: [[c:r.in]] hi')]));
  for (const got of [plain, flowing]) {
    assert.deepEqual(got.content, []);
    assert.equal(got.stopReason, 'end_turn');
  }
}));

test('a summariser request on Chat Completions is the summariser\'s, answered with a memory', () => withStandin({}, 'openai', async ({ s, adapter, close }) => {
  s.setStep(step('m', []));
  const got = await adapter.complete({ model: OPENAI, maxTokens: 2048, system: 'You summarise.', messages: [user(`[[c:m.in]] ${prose(400)}`), { role: 'assistant', content: [{ type: 'text', text: 'noted' }] }, user(CHAT)] });
  assert.ok(got.content[0].text.length > 0);
  const [r] = await close();
  assert.equal(r.kind, 'summariser');
}));

test('a request the stand-in can\'t serve as OpenAI\'s Chat Completions is refused as unclassified, naming why', () => withStandin({}, 'openai', async ({ s, post, close }) => {
  s.setStep(step('u', [{ text: 'a' }]));
  const base = { model: OPENAI, messages: [{ role: 'user', content: 'user: [[c:u.in]] hi' }] };
  for (const body of [
    { ...base, model: 'gpt-6.1-sol' },
    { ...base, n: 2 },
    { ...base, prompt_cache_options: { mode: 'explicit' } },
    { ...base, messages: [{ role: 'system', content: 'only' }] },
    { ...base, messages: [{ role: 'function', content: 'x' }] },
  ]) assert.equal((await post('/v1/chat/completions', body)).status, 400);
  const reasons = (await close()).map((r) => r.reason);
  assert.match(reasons[0], /no output limit or cache rules for the model gpt-6\.1-sol/);
  assert.match(reasons[1], /2 choices/);
  assert.match(reasons[2], /explicit cache breakpoints/);
  assert.match(reasons[3], /only system or developer messages/);
  assert.match(reasons[4], /role is "function"/);
}));

test('DeepSeek\'s dialect: membrane gets the reasoning, sent as reasoning_content and sealed as the stand-in\'s own, as a thinking block ahead of the text and the call', () => withStandin({ thinks: true }, 'deepseek', async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('d', [{ text: '[[c:d.r1]] looking', calls: [{ name: 'time--now', input: {} }] }, { text: 'plain' }]), canaries: ['[[c:d.in]]'] });
  const first = await streamed(ask([user('user: [[c:d.in]] go')]));
  assert.deepEqual(first.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.match(first.content[0].thinking, /\nrx1\.[A-Za-z0-9_-]{22}$/);
  const plain = await adapter.complete(ask([user('user: [[c:d.in]] again')], { tools: undefined }));
  assert.deepEqual(plain.content.map((b) => b.type), ['thinking', 'text']);
  const records = await close();
  assert.equal(records[0].head.api, 'chat-completions');
  assert.ok(records[0].usage.prompt_cache_miss_tokens > 0);
}));

test('DeepSeek\'s dialect refuses, as its thinking-mode guide documents, a request with tools whose earlier assistant turn didn\'t pass back reasoning_content, so membrane 0.8.0\'s next request in a conversation is refused: it sends the reasoning back as `reasoning`', () => withStandin({ thinks: true }, 'deepseek', async ({ s, adapter, ask, failure, post, close }) => {
  s.setStep({ ...step('p', [{ text: 'first' }, { text: 'never' }, { text: 'answered' }, { text: 'without tools' }]), canaries: ['[[c:p.in]]'] });
  const opening = [user('user: [[c:p.in]] one')];
  const first = await adapter.complete(ask(opening));
  const err = await failure(adapter.complete(ask([...opening, reply(first.content), user('user: [[c:p.in]] two')])));
  assert.equal(err.httpStatus, 400);
  assert.equal(err.retryable, false);
  const tools = [{ type: 'function', function: { name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } } }];
  const system = { role: 'system', content: SYSTEM };
  const answered = { role: 'assistant', content: 'first', reasoning_content: first.content[0].thinking };
  const passedBack = await post('/chat/completions', { model: DEEPSEEK, max_tokens: 100, tools, messages: [system, { role: 'user', content: 'user: [[c:p.in]] one' }, answered, { role: 'user', content: 'user: [[c:p.in]] two' }] });
  assert.equal(passedBack.status, 200, 'the same request, with reasoning_content passed back, is answered');
  const noTools = await post('/chat/completions', { model: DEEPSEEK, max_tokens: 100, messages: [system, { role: 'user', content: 'user: [[c:p.in]] one' }, { role: 'assistant', content: 'first' }, { role: 'user', content: 'user: [[c:p.in]] two' }] });
  assert.equal(noTools.status, 200, 'without tools the guide asks for no pass-back');
  const records = await close();
  assert.equal(records[1].refused, 'reasoning-content');
  assert.deepEqual(records[1].messages[2].blocks.map((b) => [b.type, b.field, b.sealed]), [['thinking', 'reasoning', true], ['text', undefined, undefined]], 'the record shows the reasoning came back, the stand-in\'s own, under `reasoning`');
  assert.ok(records[2].usage.prompt_cache_hit_tokens > 0, 'a cache unit at the end of the first answer, which the passed-back request matches');
}));
