import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIResponsesAPIAdapter } from '@animalabs/membrane';
import { countTokens, responses } from './responses.ts';
import { decoded, startStandin as startServer, tokensSent } from './standin.ts';
import type { MembraneError, OpenAIResponsesAPIProviderResponse, ProviderRequest } from '@animalabs/membrane';
import type { AgentStep } from './agent.ts';
import type { ResponsesBody, ResponsesUsage, ResponsesWritten } from './responses.ts';
import type { Configuration, RequestRecord, Step } from './standin.ts';
import type { Block } from './view.ts';

type Standin = Awaited<ReturnType<typeof startServer>>;
type Answered = Omit<OpenAIResponsesAPIProviderResponse, 'content'> & { content: Block[] };
type ResponsesRecord = RequestRecord & ResponsesWritten;
interface Tools {
  s: Standin;
  adapter: OpenAIResponsesAPIAdapter;
  streamed: (request: ProviderRequest) => Promise<Answered>;
  failure: (p: Promise<unknown>) => Promise<MembraneError>;
  close: () => Promise<RequestRecord[]>;
}

const MODEL = 'gpt-6.1-sol';
const TOOLS = [{ type: 'function', name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } }];
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
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const step = (id: string, replies: NonNullable<AgentStep['replies']>, more: Partial<Step> = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const ask = (input: unknown[], more: Partial<ProviderRequest> = {}): ProviderRequest => ({ model: MODEL, maxTokens: 2048, system: SYSTEM, messages: input, tools: TOOLS, ...more });

async function withStandin(configuration: Partial<Configuration>, fn: (tools: Tools) => Promise<void>) {
  const s = await startServer({ configuration: { windowTokens: 922_000, ...configuration } });
  started.add(s);
  const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-fixture', baseURL: `${s.url}/v1` });
  const streamed = (request: ProviderRequest) => adapter.stream(request, { onChunk: () => {} }) as Promise<Answered>;
  const failure = (p: Promise<unknown>) => p.then(() => assert.fail('the call was answered'), (e: MembraneError) => e);
  let records: RequestRecord[] | null = null;
  try {
    await fn({ s, adapter, streamed, failure, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

test('membrane\'s Responses adapter, streamed and not, gets the step\'s reply as its own blocks: the reasoning as encrypted content the stand-in minted, then the text, then the call', () => withStandin({ thinks: true }, async ({ s, adapter, streamed, close }) => {
  s.setStep({ ...step('a', [{ text: '[[c:a.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:a.r2]] done' }]), canaries: ['[[c:a.in]]', '[[c:a.call1]]'] });
  const opening = [user(`user: [[c:a.in]] ${prose(300)}`)];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['redacted_thinking', 'text', 'tool_use']);
  assert.match(first.content[0].data!, /^rx1\./);
  assert.equal(first.content[1].text, '[[c:a.r1]] looking');
  assert.deepEqual([first.content[2].name, first.content[2].input], ['time--now', { zone: 'UTC' }]);
  assert.equal(first.stopReason, 'tool_use');
  const call = first.content[2].id;
  const round = [...opening, ...first.outputItems, { type: 'function_call_output', call_id: call, output: `[[c:a.call1]] ${prose(200)}` }];
  const second = await adapter.complete(ask(round)) as Answered;
  assert.deepEqual(second.content.map((b) => b.type), ['redacted_thinking', 'text']);
  assert.equal(second.content[1].text, '[[c:a.r2]] done');
  assert.equal(second.stopReason, 'end_turn');
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent']);
  assert.equal(records[0].answer!.toolUseIds![0], call, 'the call goes with the id the reply minted');
}));

test('each input item is a message of the record, with its own digest; a reasoning item says whether its encrypted content is the stand-in\'s own, and one that isn\'t is still answered', () => withStandin({ thinks: true }, async ({ s, streamed, close }) => {
  s.setStep({ ...step('b', [{ text: '[[c:b.r1]] calling', calls: [{ name: 'time--now', input: {} }] }, { text: 'one' }, { text: 'two' }]), canaries: ['[[c:b.in]]', '[[c:b.call1]]'] });
  const opening = [user('user: [[c:b.in]] go')];
  const first = await streamed(ask(opening));
  const result = { type: 'function_call_output', call_id: first.content.at(-1)!.id, output: '[[c:b.call1]] it is noon' };
  await streamed(ask([...opening, ...first.outputItems, result]));
  const altered = first.outputItems.map((item) => (item.type === 'reasoning' ? { ...item, encrypted_content: (item.encrypted_content as string).replace('rx1.', 'rx1.AAAA') } : item));
  const answered = await streamed(ask([...opening, ...altered, result]));
  assert.equal(answered.content.at(-1)!.text, 'two', 'no refusal of a changed item is documented, so none is sent');
  const records = await close() as ResponsesRecord[];
  const [, kept, changed] = records;
  assert.deepEqual(kept.messages.map((m) => m.role), ['user', 'reasoning', 'assistant', 'function_call', 'function_call_output']);
  assert.deepEqual(kept.messages.map((m) => m.side), ['user', 'assistant', 'assistant', 'assistant', 'user'], 'each with the side its turn is on');
  assert.equal(new Set(kept.messages.map((m) => m.digest)).size, 5);
  assert.equal(kept.messages[1].blocks[0].sealed, true);
  assert.equal(changed.messages[1].blocks[0].sealed, false);
  assert.notEqual(changed.messages[1].digest, kept.messages[1].digest);
  assert.deepEqual(changed.messages.slice(2).map((m) => m.digest), kept.messages.slice(2).map((m) => m.digest), 'only the changed item\'s digest moves');
  assert.deepEqual(kept.messages[4].blocks[0].canaries, ['[[c:b.call1]]']);
  assert.equal(kept.messages[3].blocks[0].toolUseId, kept.messages[4].blocks[0].toolUseId);
}));

test('a request\'s head names the Responses API and its fields, the instructions as text, and the rest of the body as its text', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('h', [{ text: 'a' }]));
  await adapter.complete(ask([user('user: [[c:h.in]] hello')], { extra: { reasoning: { effort: 'high' }, context_management: [{ type: 'compaction', compact_threshold: 200000 }] } }));
  const [r] = await close() as ResponsesRecord[];
  assert.deepEqual(
    { api: r.head.api, model: r.head.model, maxOutputTokens: r.head.maxOutputTokens, instructions: r.head.instructions, tools: r.head.tools.map((t) => t.name), reasoning: r.head.reasoning, include: r.head.include, store: r.head.store },
    { api: 'responses', model: MODEL, maxOutputTokens: 2048, instructions: SYSTEM, tools: ['time--now'], reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'], store: false },
  );
  assert.equal(r.head.rest, '{"context_management":[{"compact_threshold":200000,"type":"compaction"}]}');
}));

test('the prompt cache follows the guide for GPT-5.6 and later: a prefix of 1,024 tokens or more is written at the latest user message and read back exactly at an earlier one, a read keeps it 30 minutes from then, and usage counts cached and written tokens inside input_tokens, which the totals take apart', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('c', [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }]));
  const long = [user(`user: [[c:c.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(long));
  s.setClock(20 * 60_000);
  const second = await adapter.complete(ask([...long, ...first.outputItems, user('user: [[c:c.in]] and then')]));
  s.setClock(45 * 60_000);
  await adapter.complete(ask([...long, ...first.outputItems, user('user: [[c:c.in]] something else')]));
  const short = await adapter.complete(ask([user('user: [[c:c.in]] hi')]));
  const records = await close();
  const u = records.map((r) => r.usage as ResponsesUsage);
  const written = u[0].input_tokens_details.cache_write_tokens;
  assert.ok(written >= 1024, `${written}`);
  assert.equal(u[0].input_tokens_details.cached_tokens, 0);
  assert.equal(u[1].input_tokens_details.cached_tokens, written, 'read at the first request\'s breakpoint, exactly');
  assert.equal(second.usage.cacheReadTokens, written, 'as membrane reads it');
  assert.equal(u[1].input_tokens_details.cache_write_tokens, u[1].input_tokens - written, 'and its own prefix written past it');
  assert.equal(u[2].input_tokens_details.cached_tokens, written, '45 minutes after it was written, since the read at 20 kept it to 50');
  assert.deepEqual([u[3].input_tokens_details.cached_tokens, u[3].input_tokens_details.cache_write_tokens], [0, 0], 'a prefix under 1,024 tokens is neither read nor written');
  assert.deepEqual(u.map((x) => x.input_tokens_details.cache_write_tokens_details), u.map((x) => ({ ttl_30m_tokens: x.input_tokens_details.cache_write_tokens, ttl_12h_tokens: 0 })), 'each write is broken down by lifetime, both fields there when one is zero');
  assert.equal(short.usage.cacheReadTokens, 0);
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, u.reduce((t, x) => t + x.input_tokens, 0));
  assert.equal(sum.cacheRead, 2 * written);
}));

test('the breakpoint is the latest eligible message, a user message or the last of a run of tool outputs, so a developer message after it isn\'t written', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('d', [{ text: 'one' }, { text: 'two' }]));
  const long = user(`user: [[c:d.in]] ${prose(6000)}`);
  const note = (text: string) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
  await adapter.complete(ask([long, note('note one')]));
  await adapter.complete(ask([long, note('note two')]));
  const [first, second] = (await close()).map((r) => (r.usage as ResponsesUsage).input_tokens_details);
  assert.ok(first.cache_write_tokens >= 1024);
  assert.equal(second.cached_tokens, first.cache_write_tokens);
}));

test('a lookup reaches back 20 eligible message endings before the breakpoint, and no further, a run of tool outputs counting as one', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('l', [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }]));
  const long = [user(`user: [[c:l.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(long));
  const more = (tag: string, n: number) => Array.from({ length: n }, (_, i) => user(`user: [[c:l.in]] ${tag}${i + 1}`));
  const outputs = Array.from({ length: 21 }, (_, i) => ({ type: 'function_call_output', call_id: `call_${i}`, output: `out ${i}` }));
  await adapter.complete(ask([...long, ...first.outputItems, ...more('a', 20)]));
  await adapter.complete(ask([...long, ...first.outputItems, ...more('b', 21)]));
  await adapter.complete(ask([...long, ...first.outputItems, ...outputs, user('user: [[c:l.in]] go')]));
  const [w, reach, beyond, run] = (await close()).map((r) => (r.usage as ResponsesUsage).input_tokens_details);
  assert.ok(w.cache_write_tokens >= 1024, `the first request writes its prefix: ${w.cache_write_tokens}`);
  assert.equal(reach.cached_tokens, w.cache_write_tokens);
  assert.equal(beyond.cached_tokens, 0);
  assert.equal(run.cached_tokens, w.cache_write_tokens, '21 tool outputs in a row end once');
}));

test('a prefix is read back only by a request with the same parallel_tool_calls, text.format, reasoning.effort and text.verbosity, the settings the guide says can change it', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('g', Array.from({ length: 6 }, () => ({ text: 'ok' }))));
  const long = user(`user: [[c:g.in]] ${prose(6000)}`);
  const base = { model: MODEL, instructions: SYSTEM, tools: TOOLS, store: false, parallel_tool_calls: true, reasoning: { effort: 'medium' }, text: { format: { type: 'text' }, verbosity: 'medium' } };
  const post = (more: Record<string, unknown>, input: unknown[]) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, ...more, input }) });
  const later = [long, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, user('user: [[c:g.in]] and then')];
  assert.equal((await post({}, [long])).status, 200);
  for (const more of [{}, { parallel_tool_calls: false }, { text: { ...base.text, format: { type: 'json_object' } } }, { reasoning: { effort: 'high' } }, { text: { ...base.text, verbosity: 'low' } }]) assert.equal((await post(more, later)).status, 200);
  const [written, same, ...changed] = (await close()).map((r) => (r.usage as ResponsesUsage).input_tokens_details);
  assert.ok(written.cache_write_tokens >= 1024, `the first request writes its prefix: ${written.cache_write_tokens}`);
  assert.equal(same.cached_tokens, written.cache_write_tokens);
  assert.deepEqual(changed.map((u) => u.cached_tokens), [0, 0, 0, 0]);
}));

test('a written prefix expires 30 minutes after its last use', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('e', [{ text: 'one' }, { text: 'two' }]));
  const long = [user(`user: [[c:e.in]] ${prose(6000)}`)];
  const first = await adapter.complete(ask(long));
  s.setClock(31 * 60_000);
  await adapter.complete(ask([...long, ...first.outputItems, user('user: [[c:e.in]] later')]));
  const [earlier, later] = await close();
  assert.ok((earlier.usage as ResponsesUsage).input_tokens_details.cache_write_tokens >= 1024, 'the first request writes its prefix');
  assert.equal((later.usage as ResponsesUsage).input_tokens_details.cached_tokens, 0);
}));

test('a request past compact_threshold gets a compaction item ahead of its answer, and its record holds it as an item of its own', () => withStandin({}, async ({ s, adapter, streamed, close }) => {
  s.setStep(step('x', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
  const compacting = { extra: { context_management: [{ type: 'compaction', compact_threshold: 1500 }] } };
  const short = [user('user: [[c:x.in]] hi')];
  const quiet = await adapter.complete(ask(short, compacting));
  assert.deepEqual(quiet.content.map((b) => b.type), ['text'], 'under the threshold, no compaction');
  const long = [user(`user: [[c:x.in]] ${prose(6000)}`)];
  const first = await streamed(ask(long, compacting));
  assert.deepEqual(first.content.map((b) => b.type), ['compaction', 'text']);
  assert.match(first.content[0].encryptedContent as string, /^cx1\./);
  await streamed(ask([...long, ...first.outputItems, user('user: [[c:x.in]] more')], compacting));
  const [, , next] = await close() as ResponsesRecord[];
  assert.deepEqual(next.messages.map((m) => m.role), ['user', 'compaction', 'assistant', 'user']);
}));

test('a request that carries a compaction item is rendered from the latest one: the items before it count for nothing in its usage, its cache, its window or its threshold', () => withStandin({ windowTokens: 4000 }, async ({ s, adapter, streamed, close }) => {
  s.setStep(step('k', [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }, { text: 'five' }, { text: 'six' }, { text: 'seven' }]));
  const compacting = { extra: { context_management: [{ type: 'compaction', compact_threshold: 1500 }] } };
  const long = [user(`user: [[c:k.in]] ${prose(6000)}`)];
  const first = await streamed(ask(long, compacting));
  assert.deepEqual(first.content.map((b) => b.type), ['compaction', 'text']);
  const before = [...long, user(`user: [[c:k.in]] ${prose(6000, 2)}`)];
  const after = [...first.outputItems, user(`user: [[c:k.in]] ${prose(2500, 4)}`)];
  const asSent = countTokens({ model: MODEL, input: [...before, ...after].filter((item) => item.type !== 'compaction') as ResponsesBody['input'] });
  assert.ok(asSent > 4000, `the input as sent, items before the compaction item included, is past the window: ${asSent}`);
  const whole = await streamed(ask([...before, ...after], compacting));
  assert.deepEqual(whole.content.map((b) => b.type), ['text'], 'past the window and the threshold as sent, under both as rendered');
  await streamed(ask(after, compacting));
  const later = [...after, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] }, user(`user: [[c:k.in]] ${prose(3000, 3)}`)];
  const again = await streamed(ask([...before, ...later], compacting));
  assert.deepEqual(again.content.map((b) => b.type), ['compaction', 'text'], 'past the threshold as rendered, so compacted again');
  const next = user('user: [[c:k.in]] after the second');
  await streamed(ask([...before, ...later, ...again.outputItems, next], compacting));
  await streamed(ask([...again.outputItems, next], compacting));
  const [, sent, alone, , both, latest] = (await close()).map((r) => r.usage as ResponsesUsage);
  assert.equal(both.input_tokens, latest.input_tokens, 'a request carrying two compaction items is rendered from the second');
  assert.ok(sent.input_tokens < 1500, `${sent.input_tokens}`);
  assert.ok(sent.input_tokens_details.cache_write_tokens >= 1024, 'its rendered prefix is written');
  assert.equal(alone.input_tokens, sent.input_tokens, 'the same input tokens without the items before the compaction item');
  assert.equal(alone.input_tokens_details.cached_tokens, sent.input_tokens_details.cache_write_tokens, 'and the same prefix, read back');
}));

test('under reasoning.context current_turn, the reasoning items before the input\'s last user message are not rendered, in its tokens or its cache; those after it, and every one under another context, are', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('r', Array.from({ length: 6 }, () => ({ text: 'ok' }))));
  const reasoning = (n: number) => ({ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `rx1.${'q'.repeat(3000 + n)}.0000000000000000000000` });
  const earlier = reasoning(1);
  const current = reasoning(2);
  const input = (...drop: unknown[]) => [
    user(`user: [[c:r.in]] ${prose(3000)}`), earlier, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }] },
    user('user: [[c:r.in]] next'), current, { type: 'function_call', call_id: 'call_1', name: 'time--now', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: '[[c:r.in]] noon' },
  ].filter((item) => !drop.includes(item));
  const post = (items: unknown[], context: string | null) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, instructions: SYSTEM, tools: TOOLS, store: false, input: items, reasoning: { effort: 'medium', ...(context ? { context } : {}) } }) });
  for (const [items, context] of [[input(), 'current_turn'], [input(earlier), 'current_turn'], [input(earlier, current), 'current_turn'], [input(), 'all_turns'], [input(), null], [input(earlier), 'all_turns']] as Array<[unknown[], string | null]>) { const res = await post(items, context); assert.equal(res.status, 200, await res.clone().text()); }
  const [whole, withoutEarlier, withoutBoth, all, none, allWithoutEarlier] = (await close()).map((r) => r.usage as ResponsesUsage);
  assert.ok(whole.input_tokens_details.cache_write_tokens >= 1024, 'the first request writes its prefix');
  assert.equal(whole.input_tokens, withoutEarlier.input_tokens, 'the earlier turn\'s reasoning renders nothing');
  assert.equal(withoutEarlier.input_tokens_details.cached_tokens, whole.input_tokens_details.cache_write_tokens, 'and the prefix without it is the one written');
  assert.ok(withoutBoth.input_tokens < withoutEarlier.input_tokens, 'the current turn\'s reasoning renders');
  assert.ok(all.input_tokens > whole.input_tokens, 'all_turns renders the earlier turn\'s reasoning');
  assert.equal(none.input_tokens, all.input_tokens, 'and so does a request that names no context');
  assert.equal(allWithoutEarlier.input_tokens, whole.input_tokens);
}));

test('a request over the window is refused with a 400 membrane reads as context length, and the record says the stand-in refused it', () => withStandin({ windowTokens: 1000 }, async ({ s, adapter, failure, close }) => {
  s.setStep(step('w', [{ text: 'a' }]));
  const e = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  assert.deepEqual([e.type, e.httpStatus], ['context_length', 400]);
  const [r] = await close();
  assert.equal(r.refused, 'window');
}));

test('a reply cut at its output limit ends incomplete for max_output_tokens, which membrane reads as max_tokens', () => withStandin({}, async ({ s, adapter }) => {
  s.setStep(step('m', [{ text: `[[c:m.r1]] ${prose(4000)}` }]));
  const r = await adapter.complete(ask([user('user: [[c:m.in]] go')], { maxTokens: 50 }));
  assert.equal(r.stopReason, 'max_tokens');
  assert.equal(r.raw.status, 'incomplete');
  assert.ok(r.usage.outputTokens <= 50);
}));

test('a scripted overloaded error reaches membrane as the API\'s 503 server_is_overloaded, which it retries', () => withStandin({}, async ({ s, adapter, failure }) => {
  s.setStep(step('o', [{ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } }]));
  const e = await failure(adapter.complete(ask([user('user: [[c:o.in]] go')])));
  assert.deepEqual([e.httpStatus, e.type, e.retryable], [503, 'server', true]);
}));

test('a summariser request on Responses is the summariser\'s, answered with a memory, and a refusal is the API\'s refusal part', () => withStandin({}, async ({ s, adapter, close }) => {
  s.setStep(step('k', [{ text: 'no', stop: 'refusal' }]));
  const memory = await adapter.complete(ask([user(`user: [[c:k.1]] ${prose(400)}`), user(`Context Manager: ${CHAT}`)], { tools: undefined })) as Answered;
  assert.match(memory.content[0].text!, /^\[\[s:M[0-9a-f]{8}\]\] Memory /);
  const refused = await adapter.complete(ask([user('user: [[c:k.in]] go')])) as Answered;
  assert.deepEqual([refused.stopReason, refused.content[0].text], ['refusal', 'no']);
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['summariser', 'agent']);
}));

test('a request reads into the view every codec gives: system, messages by side with each call\'s id and each result\'s, and tools by name with their schema', () => {
  for (const backend of ['api', 'codex'] as const) {
    const { view } = responses({ configuration: { windowTokens: 922_000 }, clock: () => 0, backend }).read({
      model: MODEL,
      instructions: SYSTEM,
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'time--now', arguments: '{"zone":"UTC"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'noon' },
      ],
      tools: TOOLS,
    });
    assert.equal(view!.system, `${SYSTEM}\nbe brief`, backend);
    assert.deepEqual(view!.messages, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'time--now', input: { zone: 'UTC' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'noon' }] },
    ], backend);
    assert.deepEqual(view!.tools, [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], backend);
  }
});

test('an input given as a string, and a message whose content is a string, are read as their text', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('t', [{ text: 'a' }, { text: 'b' }]));
  const post = (input: unknown) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, input }) });
  assert.equal((await post('user: [[c:t.in]] go')).status, 200);
  assert.equal((await post([{ role: 'user', content: 'user: [[c:t.in]] again' }])).status, 200);
  const records = await close() as ResponsesRecord[];
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent']);
  assert.deepEqual(records.map((r) => r.messages[0].blocks[0].canaries), [['[[c:t.in]]'], ['[[c:t.in]]']]);
}));

test('`max_output_tokens` that isn\'t an integer of at least 16, the Responses reference\'s minimum, is refused with a 400 naming it and never answered; 16, null and none are answered', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('o', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const post = (more: Record<string, unknown>) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, instructions: SYSTEM, store: false, input: [user('user: [[c:o.in]] go')], ...more }) });
  const bad = [15, 0, '64', 16.5];
  for (const value of bad) {
    const res = await post({ max_output_tokens: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    const { error } = await res.json() as { error: { param: string; message: string } };
    assert.deepEqual([error.param, error.message], ['max_output_tokens', 'stand-in: `max_output_tokens` must be an integer of at least 16']);
  }
  for (const more of [{ max_output_tokens: 16 }, { max_output_tokens: null }, {}]) assert.equal((await post(more)).status, 200, JSON.stringify(more));
  assert.deepEqual((await close()).map((r) => r.refused ?? null), [...bad.map(() => 'max_output_tokens'), null, null, null]);
}));

test('a content part of a type the codec doesn\'t model, and a model name only an object\'s prototype holds, are refused as unclassified, naming them; a refused request\'s view keeps the part whole', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('p', [{ text: 'a' }]));
  const post = (body: unknown) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const file = { type: 'input_file', file_id: 'file-1' };
  const body = { model: MODEL, instructions: SYSTEM, store: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:p.in]] read this' }, file] }] };
  const output = { ...body, input: [user('user: [[c:p.in]] go'), { type: 'function_call', call_id: 'c1', name: 'time--now', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: '[[c:p.in]] noon' }, { type: 'input_audio', data: 'AAAA' }] }] };
  for (const b of [body, output, { ...body, model: 'constructor', input: [user('user: [[c:p.in]] go')] }]) assert.equal((await post(b)).status, 400);
  const records = await close();
  assert.deepEqual(records.map((r) => r.reason), [
    'it carries a content part of type "input_file", which the stand-in doesn\'t model',
    'it carries a content part of type "input_audio", which the stand-in doesn\'t model',
    'the stand-in knows no cache rules or output limit for the model constructor',
  ]);
  assert.deepEqual(decoded('responses', body).view!.messages[0].content.at(-1), file);
}));

test('a Responses body with instructions, content, tools or a role of the wrong kind, or a null content part, is refused as unclassified, naming it', () => withStandin({}, async ({ s, close }) => {
  s.setStep(step('k', [{ text: 'a' }]));
  const post = (body: unknown) => fetch(`${s.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = { model: MODEL, instructions: SYSTEM, store: false, input: [user('user: [[c:k.in]] go')] };
  const bodies = [
    { ...base, instructions: { text: SYSTEM } },
    { ...base, input: [{ type: 'message', role: 'user', content: { text: 'x' } }, ...base.input] },
    { ...base, tools: [null] },
    { ...base, input: [{ type: 'message', role: 'constructor', content: 'x' }, ...base.input] },
    { ...base, input: [{ type: 'message', role: 'user', content: [null, { type: 'input_file', file_id: 'f' }, { type: 'input_text', text: 'user: [[c:k.in]] go' }] }] },
  ];
  for (const b of bodies) assert.equal((await post(b)).status, 400, JSON.stringify(b).slice(0, 120));
  const records = await close();
  assert.deepEqual(records.map((r) => r.reason), [
    'its instructions are not a string',
    'it carries a message whose content is neither a string nor a list of parts',
    'its tools are not a list of tools',
    'it carries a message whose role is "constructor"',
    'it carries a content part of type null, which the stand-in doesn\'t model',
  ]);
}));

test('a request the stand-in can\'t serve as the Responses API is refused as unclassified, naming why', () => withStandin({}, async ({ s, adapter, failure, close }) => {
  s.setStep(step('u', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  for (const request of [ask([user('user: [[c:u.in]] go')], { model: 'gpt-4.1' }), ask([user('user: [[c:u.in]] go')], { extra: { previous_response_id: 'resp_1' } }), ask([user('user: [[c:u.in]] go')], { extra: { prompt_cache_options: { ttl: '12h' } } }), ask([user('user: [[c:u.in]] go')], { extra: { prompt_cache_options: { ttl: '1h' } } }), ask([user('user: [[c:u.in]] go')], { extra: { prompt_cache_options: { ttl: '24h' } } })]) {
    const e = await failure(adapter.complete(request));
    assert.equal(e.httpStatus, 400);
  }
  assert.equal((await adapter.complete(ask([user('user: [[c:u.in]] go')], { extra: { prompt_cache_options: { ttl: '30m' } } }))).stopReason, 'end_turn');
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified', 'agent']);
  assert.match(records[0].reason!, /no cache rules or output limit for the model gpt-4\.1/);
  assert.match(records[1].reason!, /`previous_response_id`/);
  assert.deepEqual(records.slice(2, 5).map((r) => r.reason), ['"12h"', '"1h"', '"24h"'].map((t) => `it asks for a cache lifetime of ${t}, and the stand-in's prompt cache models the default 30 minutes alone`));
}));
