import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter, OpenRouterAdapter } from '@animalabs/membrane';
import { chat, decodeChat } from './chat.ts';
import { startStandin as startServer, tokensSent } from './standin.ts';
import type { MembraneError, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import type { AgentStep } from './agent.ts';
import type { ChatReply, ChatUsage, ChatWritten } from './chat.ts';
import type { Configuration, RequestRecord, Step } from './standin.ts';
import type { Block } from './view.ts';

type Standin = Awaited<ReturnType<typeof startServer>>;
type Answered = ProviderResponse & { content: Block[] };
type ChatRecord = RequestRecord & ChatWritten;
type Usage = ChatUsage & { prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number } };
type DeepSeekUsage = ChatUsage & { prompt_cache_hit_tokens: number; prompt_cache_miss_tokens: number };
type Completion = { choices: Array<{ message: ChatReply; finish_reason: string }> };
type Chunk = { choices: Array<{ delta: { content?: string; refusal?: string | null; reasoning?: string } }> };
interface Tools<A> {
  s: Standin;
  adapter: A;
  ask: (messages: unknown[], more?: Partial<ProviderRequest>) => ProviderRequest;
  streamed: (request: ProviderRequest) => Promise<Answered>;
  failure: (p: Promise<unknown>) => Promise<MembraneError>;
  post: (path: string, body: unknown) => Promise<Response>;
  close: () => Promise<RequestRecord[]>;
}

const OPENAI = 'gpt-5.6-sol';
const DEEPSEEK = 'deepseek-flash';
const TOOLS = [{ name: 'time--now', description: 'now', inputSchema: { type: 'object', properties: {} } }];
const SYSTEM = 'You are the fixture agent.';
const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';

const started = new Set<Standin>();
after(async () => { for (const s of started) await s.close(); });

const prose = (n: number, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (content: unknown) => ({ role: 'assistant', content });
const result = (id: string, text: unknown) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
const AUDIO = { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } };
const step = (id: string, replies: NonNullable<AgentStep['replies']>, more: Partial<Step> = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withStandin(configuration: Partial<Configuration>, dialect: 'openai' | 'deepseek', fn: (tools: Tools<OpenAICompatibleAdapter>) => Promise<void>) {
  const s = await startServer({ configuration: { windowTokens: 922_000, ...configuration } });
  started.add(s);
  const model = dialect === 'deepseek' ? DEEPSEEK : OPENAI;
  const adapter = new OpenAICompatibleAdapter({ baseURL: dialect === 'deepseek' ? s.url : `${s.url}/v1`, apiKey: 'sk-fixture' });
  const ask = (messages: unknown[], more: Partial<ProviderRequest> = {}): ProviderRequest => ({ model, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
  const streamed = (request: ProviderRequest) => adapter.stream(request, { onChunk: () => {} }) as Promise<Answered>;
  const failure = (p: Promise<unknown>) => p.then(() => assert.fail('the call was answered'), (e: MembraneError) => e);
  const post = (path: string, body: unknown) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let records: RequestRecord[] | null = null;
  try {
    await fn({ s, adapter, ask, streamed, failure, post, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

test('membrane\'s OpenAI-compatible adapter, streamed and not, gets the step\'s reply from OpenAI\'s Chat Completions as its own blocks: the text, then the call; the reasoning isn\'t sent, and its tokens count in completion_tokens', () => withStandin({ thinks: true }, 'openai', async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('a', [{ text: '[[c:a.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:a.r2]] again', calls: [{ name: 'time--now', input: { zone: 'CET' } }] }]), canaries: ['[[c:a.in]]', '[[c:a.call1]]'] });
  const opening = [user(`user: [[c:a.in]] ${prose(300)}`)];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(first.content[0].text, '[[c:a.r1]] looking');
  assert.deepEqual([first.content[1].name, first.content[1].input], ['time--now', { zone: 'UTC' }]);
  assert.equal(first.stopReason, 'tool_use');
  const call = first.content[1].id!;
  const second = await adapter.complete(ask([...opening, reply(first.content), result(call, `[[c:a.call1]] ${prose(200)}`)])) as Answered;
  assert.deepEqual(second.content.map((b) => b.type), ['text', 'tool_use'], 'unstreamed, the same blocks');
  assert.deepEqual([second.content[0].text, second.content[1].name, second.content[1].input, second.stopReason], ['[[c:a.r2]] again', 'time--now', { zone: 'CET' }, 'tool_use']);
  const records = await close() as ChatRecord[];
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent']);
  assert.equal(records[0].answer!.toolUseIds![0], call, 'the call goes with the id the reply minted');
  for (const [r, got] of [[records[0], first], [records[1], second]] as Array<[{ usage: ChatUsage }, Answered]>) {
    assert.ok(r.usage.completion_tokens_details.reasoning_tokens > 0, 'the model reasons on every reply');
    assert.ok(r.usage.completion_tokens > r.usage.completion_tokens_details.reasoning_tokens, 'and the visible reply counts beside it');
    assert.equal(got.usage.outputTokens, r.usage.completion_tokens, 'as membrane reads it');
  }
}));

test('each wire message is a message of the record, with its own digest and the side its turn is on; a tool message is one of its own', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep({ ...step('b', [{ text: 'calling', calls: [{ name: 'time--now', input: {} }, { name: 'time--now', input: { zone: 'UTC' } }] }, { text: 'one' }, { text: 'two' }]), canaries: ['[[c:b.in]]'] });
  const opening = [user('user: [[c:b.in]] go')];
  const first = await adapter.complete(ask(opening)) as Answered;
  const [c1, c2] = first.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const results = { role: 'user', content: [{ type: 'tool_result', tool_use_id: c1, content: '[[c:b.in]] noon' }, { type: 'tool_result', tool_use_id: c2, content: 'midday' }] };
  await adapter.complete(ask([...opening, reply(first.content), results]));
  await adapter.complete(ask([...opening, reply(first.content), { ...results, content: [results.content[0], { ...results.content[1], content: 'twelve' }] }]));
  const [, kept, changed] = await close() as ChatRecord[];
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
  const [r] = await close() as ChatRecord[];
  const [joined] = r.messages.find((m) => m.role === 'assistant')!.blocks;
  assert.deepEqual(joined.marks, ['[[s:M0123abcd]]', '[[c:j.r0]]']);
  assert.equal(r.messages.find((m) => m.role === 'user')!.blocks[0].marks, undefined, 'a block with one kind has none');
  const tool = r.messages.find((m) => m.role === 'tool')!.blocks[0];
  assert.deepEqual([tool.imagesNotShown, tool.images, tool.canaries], [1, undefined, ['[[c:j.call1]]']]);
}));

test('a request asking a cache lifetime other than "30m" is unclassified, since the Chat Completions reference gives "30m" as the only supported value; "30m" is served', () => withStandin({}, 'openai', async ({ s, post, close }) => {
  s.setStep(step('t', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = (ttl: string) => ({ model: OPENAI, messages: [{ role: 'user', content: 'user: [[c:t.in]] hi' }], prompt_cache_options: { ttl } });
  const statuses: number[] = [];
  for (const ttl of ['12h', '24h', '30m']) statuses.push((await post('/v1/chat/completions', body(ttl))).status);
  assert.deepEqual(statuses, [400, 400, 200]);
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent']);
  assert.equal(records[0].reason, 'it asks for a cache lifetime of "12h", and the Chat Completions reference gives "30m" as the only supported value');
}));

test('a request\'s `rest` is masked as the object it is, then written, so a key-shaped `prompt_cache_key` there is masked as the request\'s own top-level key', () => withStandin({}, 'openai', async ({ s, post, close }) => {
  s.setStep(step('k', [{ text: 'a' }]));
  const key = '0b8f1c3e-4d2a-4f6b-9c1d-2e3f4a5b6c7d:abcdef012345';
  assert.equal((await post('/v1/chat/completions', { model: OPENAI, messages: [{ role: 'user', content: 'user: [[c:k.in]] hi' }], prompt_cache_key: key })).status, 200);
  const [r] = await close() as ChatRecord[];
  assert.equal(r.head.rest, '{"prompt_cache_key":"<uuid>:<12 hex>#1"}');
}));

test('a request\'s head names the Chat Completions API and its fields, and the rest of the body as its text', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep(step('h', [{ text: 'a' }]));
  await adapter.complete(ask([user('user: [[c:h.in]] hello')], { extra: { reasoning_effort: 'high', parallel_tool_calls: false } }));
  const [r] = await close() as ChatRecord[];
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
  const u = records.map((r) => (r.usage as Usage).prompt_tokens_details);
  assert.ok(u[0].cache_write_tokens >= 1024, `${u[0].cache_write_tokens}`);
  assert.equal(u[0].cached_tokens, 0);
  assert.equal(u[1].cached_tokens, u[0].cache_write_tokens, 'read at the first request\'s breakpoint, exactly');
  assert.equal(u[1].cache_write_tokens, (records[1].usage as Usage).prompt_tokens - u[0].cache_write_tokens);
  assert.deepEqual([u[2].cached_tokens, u[2].cache_write_tokens], [0, 0], 'a prefix under 1,024 tokens is neither read nor written');
  assert.equal(short.usage.cacheReadTokens ?? 0, 0);
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, records.reduce((t, r) => t + (r.usage as Usage).prompt_tokens, 0));
  assert.equal(sum.cacheRead, u[0].cache_write_tokens);
}));

test('a tool message ends an eligible message only as the last of a run of them', () => withStandin({}, 'openai', async ({ s, adapter, ask, close }) => {
  s.setStep({ ...step('t', [{ text: 'calling', calls: [{ name: 'time--now', input: {} }, { name: 'time--now', input: { a: 1 } }] }, { text: 'one' }, { text: 'two' }]), canaries: ['[[c:t.in]]'] });
  const opening = [user(`user: [[c:t.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(opening)) as Answered;
  const [c1, c2] = first.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const one = { type: 'tool_result', tool_use_id: c1, content: `[[c:t.in]] ${prose(3000, 2)}` };
  await adapter.complete(ask([...opening, reply(first.content), { role: 'user', content: [one] }]));
  await adapter.complete(ask([...opening, reply(first.content), { role: 'user', content: [one, { type: 'tool_result', tool_use_id: c2, content: 'b' }] }]));
  const [opened, alone, run] = (await close()).map((r) => (r.usage as Usage).prompt_tokens_details);
  assert.ok(alone.cache_write_tokens > 0, 'a request ending with one tool message writes at its end');
  assert.equal(run.cached_tokens, opened.cache_write_tokens, 'in a run of two, the first one\'s end is no lookup ending, so the read is the opening\'s prefix');
}));

test('a request over the window is refused with a 400 membrane reads as context length, and a reply cut at its limit ends with finish_reason length, which membrane reads as max_tokens', () => withStandin({ windowTokens: 1000 }, 'openai', async ({ s, adapter, ask, failure, close }) => {
  s.setStep(step('w', [{ text: prose(4000) }]));
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

test('a refusal is the API\'s `refusal` field with no content, which membrane 0.8.0\'s OpenAI-compatible adapter doesn\'t read, so the reply reaches it with no text', () => withStandin({}, 'openai', async ({ s, adapter, ask, streamed, post }) => {
  const words = 'I can\'t help with that.';
  s.setStep(step('r', [1, 2, 3, 4].map(() => ({ text: words, stop: 'refusal' }))));
  const body = (stream: boolean) => ({ model: OPENAI, messages: [{ role: 'user', content: 'user: [[c:r.in]] hi' }], ...(stream ? { stream: true } : {}) });
  const sent = (await (await post('/v1/chat/completions', body(false))).json() as Completion).choices[0];
  assert.deepEqual([sent.message.refusal, sent.message.content, sent.finish_reason], [words, null, 'stop']);
  const chunks = (await (await post('/v1/chat/completions', body(true))).text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as Chunk);
  const deltas = chunks.flatMap((c) => c.choices.map((x) => x.delta));
  assert.equal(deltas.map((d) => d.refusal ?? '').join(''), words);
  assert.ok(deltas.every((d) => !d.content), 'no content in any delta');
  const plain = await adapter.complete(ask([user('user: [[c:r.in]] hi')]));
  const flowing = await streamed(ask([user('user: [[c:r.in]] hi')]));
  for (const got of [plain, flowing]) {
    assert.deepEqual(got.content, []);
    assert.equal(got.stopReason, 'end_turn');
  }
}));

test('a summariser request on Chat Completions is the summariser\'s, answered with a memory', () => withStandin({}, 'openai', async ({ s, adapter, close }) => {
  s.setStep(step('m', []));
  const got = await adapter.complete({ model: OPENAI, maxTokens: 2048, system: 'You summarise.', messages: [user(`[[c:m.in]] ${prose(400)}`), { role: 'assistant', content: [{ type: 'text', text: 'noted' }] }, user(CHAT)] }) as Answered;
  assert.ok(got.content[0].text!.length > 0);
  const [r] = await close();
  assert.equal(r.kind, 'summariser');
}));

test('membrane joins a message\'s text blocks, so a slice and the instruction after it come as one string: the summariser reads the instruction as its tail, and the call record keeps it', () => withStandin({}, 'openai', async ({ s, adapter, close }) => {
  s.setStep(step('j', []));
  const slice = `[[c:j.in]] ${prose(300)} The plan said Target ~20 tokens, and L2 came up.\n[[c:j.r1]] ${prose(200, 3)}`;
  const instruction = 'Context Manager: Write the memory of events since the most recent memory system notification. Target ~300 tokens. Output only the memory body.';
  await adapter.complete({ model: OPENAI, maxTokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: slice }, { type: 'text', text: instruction }] }] });
  const [r] = await close();
  assert.deepEqual([r.kind, r.target, r.level], ['summariser', 300, 1]);
  assert.deepEqual(r.texts, [instruction]);
}));

test('a request the stand-in can\'t serve as OpenAI\'s Chat Completions is refused as unclassified, naming why', () => withStandin({}, 'openai', async ({ s, post, close }) => {
  s.setStep(step('u', [{ text: 'a' }]));
  const base = { model: OPENAI, messages: [{ role: 'user', content: 'user: [[c:u.in]] hi' }] };
  for (const body of [
    { ...base, model: 'gpt-6.1-sol' },
    { ...base, model: 'constructor' },
    { ...base, n: 2 },
    { ...base, prompt_cache_options: { mode: 'explicit' } },
    { ...base, messages: [{ role: 'system', content: 'only' }] },
    { ...base, messages: [{ role: 'function', content: 'x' }] },
    { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:u.in]] hi' }, AUDIO] }] },
    { ...base, tools: [null] },
    { ...base, messages: [{ role: 'user', content: { text: 'user: [[c:u.in]] hi' } }] },
    { ...base, messages: [{ role: 'constructor', content: 'x' }, ...base.messages] },
  ]) assert.equal((await post('/v1/chat/completions', body)).status, 400);
  const reasons = (await close()).map((r) => r.reason!);
  assert.match(reasons[0], /no output limit or cache rules for the model gpt-6\.1-sol/);
  assert.match(reasons[1], /no output limit or cache rules for the model constructor/);
  assert.match(reasons[2], /2 choices/);
  assert.match(reasons[3], /explicit cache breakpoints/);
  assert.match(reasons[4], /only system or developer messages/);
  assert.match(reasons[5], /role is "function"/);
  assert.equal(reasons[6], 'it carries a content part of type "input_audio", which the stand-in doesn\'t model');
  assert.equal(reasons[7], 'its tools aren\'t a list of objects');
  assert.equal(reasons[8], 'it carries a user message whose content is an object, neither text nor a list of parts');
  assert.equal(reasons[9], 'it carries a message whose role is "constructor"');
  assert.deepEqual(decodeChat({ ...base, messages: [{ role: 'user', content: [AUDIO] }] }).view!.messages[0].content, [AUDIO]);
}));

test('in each dialect, an output limit, in either field, that isn\'t an integer of at least 1 is refused with a 400 naming its field and never answered; 1, null and none are answered', async () => {
  const routes = [['openai', OPENAI, '/v1/chat/completions'], ['deepseek', DEEPSEEK, '/chat/completions'], ['openrouter', 'anthropic/claude-opus-4.6', '/api/v1/chat/completions']] as const;
  const bad = [['max_completion_tokens', 0], ['max_completion_tokens', '2048'], ['max_completion_tokens', 1.5], ['max_tokens', -1], ['max_tokens', 'Infinity']] as const;
  for (const [dialect, model, path] of routes) {
    const s = await startServer({ configuration: { windowTokens: 1_000_000 } });
    started.add(s);
    s.setStep(step('m', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
    const post = (more: Record<string, unknown>) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'user: [[c:m.in]] hi' }], ...more }) });
    for (const [field, value] of bad) {
      const res = await post({ [field]: value });
      assert.equal(res.status, 400, `${dialect}: ${field} ${JSON.stringify(value)}`);
      assert.equal(((await res.json()) as { error: { message: string } }).error.message, `stand-in: \`${field}\` must be an integer of at least 1`);
    }
    for (const more of [{ max_completion_tokens: 1 }, { max_tokens: null }, {}]) assert.equal((await post(more)).status, 200, `${dialect}: ${JSON.stringify(more)}`);
    assert.deepEqual((await s.close()).map((r) => r.refused ?? null), [...bad.map(([field]) => field), null, null, null], dialect);
  }
});

test('DeepSeek\'s dialect: membrane gets the reasoning, sent as reasoning_content and sealed as the stand-in\'s own, as a thinking block ahead of the text and the call', () => withStandin({ thinks: true }, 'deepseek', async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('d', [{ text: '[[c:d.r1]] looking', calls: [{ name: 'time--now', input: {} }] }, { text: 'plain' }]), canaries: ['[[c:d.in]]'] });
  const first = await streamed(ask([user('user: [[c:d.in]] go')]));
  assert.deepEqual(first.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.match(first.content[0].thinking!, /\nrx1\.[A-Za-z0-9_-]{22}$/);
  const plain = await adapter.complete(ask([user('user: [[c:d.in]] again')], { tools: undefined })) as Answered;
  assert.deepEqual(plain.content.map((b) => b.type), ['thinking', 'text']);
  const records = await close() as ChatRecord[];
  assert.equal(records[0].head.api, 'chat-completions');
  assert.ok((records[0].usage as DeepSeekUsage).prompt_cache_miss_tokens > 0);
}));

test('DeepSeek\'s dialect refuses, as its thinking-mode guide documents, a request with tools whose earlier assistant turn didn\'t pass back reasoning_content, so membrane 0.8.0\'s next request in a conversation is refused: it sends the reasoning back as `reasoning`', () => withStandin({ thinks: true }, 'deepseek', async ({ s, adapter, ask, failure, post, close }) => {
  s.setStep({ ...step('p', [{ text: 'first' }, { text: 'answered' }, { text: 'without tools' }]), canaries: ['[[c:p.in]]'] });
  const opening = [user('user: [[c:p.in]] one')];
  const first = await adapter.complete(ask(opening)) as Answered;
  const err = await failure(adapter.complete(ask([...opening, reply(first.content), user('user: [[c:p.in]] two')])));
  assert.equal(err.httpStatus, 400);
  assert.equal(err.retryable, false);
  const tools = [{ type: 'function', function: { name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } } }];
  const system = { role: 'system', content: SYSTEM };
  const answered = { role: 'assistant', content: 'first', reasoning_content: first.content[0].thinking };
  const sent = (assistant: { role: string; content: string; reasoning_content?: string }) => ({ model: DEEPSEEK, max_tokens: 100, tools, messages: [system, { role: 'user', content: 'user: [[c:p.in]] one' }, assistant, { role: 'user', content: 'user: [[c:p.in]] two' }] });
  const neither = await post('/chat/completions', sent({ role: 'assistant', content: 'first' }));
  assert.equal(neither.status, 400, 'with tools, an earlier assistant turn carrying neither reasoning field is refused too');
  const passedBack = await post('/chat/completions', sent(answered));
  assert.equal(passedBack.status, 200, 'the same request, with reasoning_content passed back, is answered');
  const noTools = await post('/chat/completions', { model: DEEPSEEK, max_tokens: 100, messages: [system, { role: 'user', content: 'user: [[c:p.in]] one' }, { role: 'assistant', content: 'first' }, { role: 'user', content: 'user: [[c:p.in]] two' }] });
  assert.equal(noTools.status, 200, 'without tools the guide asks for no pass-back');
  const records = await close() as ChatRecord[];
  assert.deepEqual([records[1].refused, records[2].refused], ['reasoning-content', 'reasoning-content']);
  assert.deepEqual(records[1].messages[2].blocks.map((b) => [b.type, b.field, b.sealed]), [['thinking', 'reasoning', true], ['text', undefined, undefined]], 'the record shows the reasoning came back, the stand-in\'s own, under `reasoning`');
  assert.ok((records[3].usage as DeepSeekUsage).prompt_cache_hit_tokens > 0, 'a cache unit at the end of the first answer, which the passed-back request matches');
}));

test('a request reads into the view the other codecs give: system, messages by side with each call\'s id and each result\'s, and tools by name with their schema', () => {
  const codec = chat({ configuration: { windowTokens: 922_000 }, clock: () => 0, dialect: 'openai' });
  const { view } = codec.read({
    model: OPENAI,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: 'looking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'time--now', arguments: '{"zone":"UTC"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'noon' },
    ],
    tools: [{ type: 'function', function: { name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } } }],
  });
  assert.equal(view!.system, SYSTEM);
  assert.deepEqual(view!.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'call_1', name: 'time--now', input: { zone: 'UTC' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'noon' }] },
  ]);
  assert.deepEqual(view!.tools, [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }]);
});

const ROUTED = 'anthropic/claude-opus-4.6';
async function withOpenRouter(configuration: Partial<Configuration>, fn: (tools: Omit<Tools<OpenRouterAdapter>, 'post'>) => Promise<void>) {
  const s = await startServer({ configuration: { windowTokens: 1_000_000, ...configuration } });
  started.add(s);
  const adapter = new OpenRouterAdapter({ apiKey: 'sk-or-fixture', baseURL: `${s.url}/api/v1`, xTitle: 'fixture' });
  const ask = (messages: unknown[], more: Partial<ProviderRequest> = {}): ProviderRequest => ({ model: ROUTED, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
  const streamed = (request: ProviderRequest) => adapter.stream(request, { onChunk: () => {} }) as Promise<Answered>;
  const failure = (p: Promise<unknown>) => p.then(() => assert.fail('the call was answered'), (e: MembraneError) => e);
  let records: RequestRecord[] | null = null;
  try {
    await fn({ s, adapter, ask, streamed, failure, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}
const marked = (text: string) => ({ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });

test('OpenRouter\'s dialect: membrane 0.8.0\'s OpenRouter adapter, streamed and not, gets the text and the call, and none of the reasoning OpenRouter sends, which it doesn\'t read', () => withOpenRouter({ thinks: true }, async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('o', [{ text: '[[c:o.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:o.r2]] again', calls: [{ name: 'time--now', input: { zone: 'CET' } }] }, { text: 'by hand' }, { text: 'by hand, streamed' }]), canaries: ['[[c:o.in]]', '[[c:o.call1]]'] });
  const opening = [user('user: [[c:o.in]] go')];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(first.stopReason, 'tool_use');
  const second = await adapter.complete(ask([...opening, reply(first.content), result(first.content[1].id!, '[[c:o.call1]] noon')])) as Answered;
  assert.deepEqual(second.content.map((b) => b.type), ['text', 'tool_use'], 'unstreamed, the same blocks');
  assert.deepEqual([second.content[0].text, second.content[1].name, second.content[1].input, second.stopReason], ['[[c:o.r2]] again', 'time--now', { zone: 'CET' }, 'tool_use']);
  const raw = await (await fetch(`${s.url}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ROUTED, max_tokens: 4000, messages: [{ role: 'user', content: 'user: [[c:o.in]] once more' }] }) })).json() as Completion;
  assert.equal(typeof raw.choices[0].message.reasoning, 'string', 'the reasoning OpenRouter sends, on the message');
  const stream = await (await fetch(`${s.url}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ROUTED, max_tokens: 4000, stream: true, messages: [{ role: 'user', content: 'user: [[c:o.in]] once more' }] }) })).text();
  const deltas = stream.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as Chunk).flatMap((c) => c.choices.map((x) => x.delta ?? {}));
  assert.ok(deltas.some((d) => typeof d.reasoning === 'string' && d.reasoning), 'and in the stream\'s deltas, which membrane\'s streamed reply above didn\'t read');
  const records = await close() as ChatRecord[];
  assert.deepEqual(records.slice(0, 2).map((r) => [r.kind, r.head.api, r.head.dialect, r.head.headers.title]), [['agent', 'chat-completions', 'openrouter', 'fixture'], ['agent', 'chat-completions', 'openrouter', 'fixture']]);
  assert.ok((records[0].usage as ChatUsage).completion_tokens_details.reasoning_tokens > 0, 'the stand-in reasoned, and sent it as `reasoning`');
  assert.ok(!records[1].messages.some((m) => m.blocks.some((b) => b.type === 'thinking')), 'and nothing of it came back');
}));

test('OpenRouter\'s dialect prices a Claude model\'s request by Anthropic\'s cache rule, over the Messages body it forwards: a marked prefix of 4,096 tokens or more is written, then read back, reported as cached_tokens and cache_write_tokens inside prompt_tokens, of which membrane reads the reads', () => withOpenRouter({}, async ({ s, adapter, ask, close }) => {
  s.setStep(step('k', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
  const long = marked(`user: [[c:k.in]] ${prose(20_000)}`);
  const first = await adapter.complete(ask([long]));
  s.setClock(60_000);
  const second = await adapter.complete(ask([long, reply(first.content), user('user: [[c:k.in]] and then')]));
  await adapter.complete(ask([user('user: [[c:k.in]] unmarked and short')]));
  const records = await close() as ChatRecord[];
  const u = records.map((r) => r.usage as Usage);
  assert.ok(u[0].prompt_tokens_details.cache_write_tokens >= 4096, JSON.stringify(u[0]));
  assert.equal(u[0].prompt_tokens_details.cached_tokens, 0);
  assert.equal(u[1].prompt_tokens_details.cached_tokens, u[0].prompt_tokens_details.cache_write_tokens, 'read back at the marked block');
  assert.equal(second.usage.cacheReadTokens, u[1].prompt_tokens_details.cached_tokens, 'as membrane reads it');
  assert.deepEqual([u[2].prompt_tokens_details.cached_tokens, u[2].prompt_tokens_details.cache_write_tokens], [0, 0], 'nothing marked, nothing cached');
  assert.equal(records[0].messages[1].blocks[0].cache, '5m', 'the record keeps the block\'s marker');
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, u.reduce((t, x) => t + x.prompt_tokens, 0));
}));

test('OpenRouter\'s dialect refuses a request over the window with its documented 400, in Anthropic\'s words, which membrane reads as context length, and an overloaded provider as its 503, which membrane retries', () => withOpenRouter({ windowTokens: 1000 }, async ({ s, adapter, ask, failure, close }) => {
  s.setStep(step('w', [{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }]));
  const window = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  assert.equal(window.type, 'context_length');
  const busy = await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')])));
  assert.deepEqual([busy.httpStatus, busy.retryable], [503, true]);
  const [refused] = await close();
  assert.equal(refused.refused, 'window');
}));

test('OpenRouter\'s dialect refuses an image part that carries cache_control, since its Chat Completions reference gives a marker to text parts alone', () => withOpenRouter({}, async ({ s, close }) => {
  s.setStep(step('i', [{ text: 'never' }, { text: 'a' }]));
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
  const body = (part: unknown) => ({ model: ROUTED, max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:i.in]] look' }, part] }] });
  const post = (b: unknown) => fetch(`${s.url}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post(body({ ...image, cache_control: { type: 'ephemeral' } }))).status, 400);
  assert.equal((await post(body(image))).status, 200, 'an unmarked image is served');
  const [refused] = await close();
  assert.equal(refused.reason, 'it marks an image part with cache_control, which OpenRouter\'s Chat Completions reference gives text parts alone, so what it forwards isn\'t documented');
}));

test('OpenRouter\'s dialect knows only the models whose limits and cache it models', () => withOpenRouter({}, async ({ s, close }) => {
  s.setStep(step('u', [{ text: 'a' }]));
  const res = await fetch(`${s.url}/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'user: [[c:u.in]] hi' }] }) });
  assert.equal(res.status, 400);
  const [r] = await close();
  assert.match(r.reason!, /no output limit or cache rules for the model openai\/gpt-5\.6-sol on openrouter/);
}));
