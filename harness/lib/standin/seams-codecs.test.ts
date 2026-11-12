import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic, contextParts, type MessagesBody } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { chat, type ChatBody } from './chat.ts';
import { responses, type ResponsesBody } from './responses.ts';
import { seamOf, type ContextPart } from './seams.ts';
import { runVaryingClass } from '../strategies/compare.ts';
import type { Codec } from './standin.ts';
import type { Block } from './view.ts';

type MessageItem = NonNullable<MessagesBody['messages']>[number];
type ChatMessage = NonNullable<ChatBody['messages']>[number];
type Item = Exclude<NonNullable<ResponsesBody['input']>, string>[number];
type Context<B> = { context(body: B, mask: (v: unknown) => unknown): { parts: ContextPart[] } };
type Flag = { is_error?: boolean };

const config = { windowTokens: 1_000_000 };
const clock = () => 0;
const mask = runVaryingClass(null);
const MARK = { type: 'ephemeral' };
const words = (n: number, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

const messages = anthropic({ configuration: config, clock });
const BODY = (msgs: MessageItem[], more: { system?: Block[] } = {}) => ({ model: 'claude-opus-4-6', max_tokens: 2000, system: [{ type: 'text', text: `the fixture's agent ${words(30, 's')}` }], tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages: msgs, ...more });
const user = (text: string, more: Block = {}) => ({ role: 'user', content: [{ type: 'text', text, ...more }] });
const said = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'time--now', input: {} }] });
const result = (id: string, text: string, more: Flag = {}) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...more }] });
const seam = <B,>(codec: Context<B>, before: NoInfer<B>, after: NoInfer<B>) => seamOf(codec.context(before, mask).parts, codec.context(after, mask).parts);
const tokensOf = <B,>(codec: Context<B>, body: NoInfer<B>, pick: (p: ContextPart) => boolean) => codec.context(body, mask).parts.filter(pick).reduce((t, p) => t + p.tokens, 0);
const u1 = user(`user: ${words(40, 'a')}`), a1 = said(words(30, 'b')), u2 = user(`user: ${words(40, 'c')}`), a2 = said(words(30, 'd')), u3 = user(`user: ${words(40, 'e')}`);

test('Messages: appending is no seam', () => {
  assert.equal(seam(messages, BODY([u1]), BODY([u1, a1, u2])), 0);
});

test('Messages: a summary replacing messages is a seam of their tokens, and a front drop of the dropped ones alone', () => {
  const before = BODY([u1, a1, u2, a2, u3]);
  const replaced = messages.context(BODY([u1, a1, u2]), mask).parts.slice(2).reduce((t, p) => t + p.tokens, 0);
  assert.equal(seam(messages, before, BODY([user(`user: summary ${words(10, 'z')}`), a2, u3, said('ok'), user('user: next')])), replaced);
  const dropped = messages.context(BODY([u1, a1]), mask).parts.slice(2).reduce((t, p) => t + p.tokens, 0);
  assert.equal(seam(messages, before, BODY([u2, a2, u3, said('ok'), user('user: next')])), dropped);
});

test('Messages: a cache marker moved, on a block, nested in a tool result or on a message, is no seam', () => {
  const before = BODY([user(`user: ${words(40, 'a')}`, { cache_control: MARK }), call('t1'), result('t1', 'now'), said('ok')]);
  const nested = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'now', cache_control: MARK }] }] };
  const after = BODY([user(`user: ${words(40, 'a')}`), call('t1'), nested, { ...said('ok'), cache_control: MARK }, user('user: more', { cache_control: MARK })]);
  assert.equal(seam(messages, before, after), 0);
});

test("Messages: a tool result's `is_error: false` sent back with no flag is no seam, and `is_error: true` sent back with none is one", () => {
  const flagged = (e: boolean) => BODY([u1, call('t1'), result('t1', 'now', { is_error: e }), said('ok')]);
  const bare = BODY([u1, call('t1'), result('t1', 'now'), said('ok'), user('user: more')]);
  assert.equal(seam(messages, flagged(false), bare), 0);
  assert.ok(seam(messages, flagged(true), bare) > 0);
});

test('Messages: a part inserted before the end, with nothing taken out, is no seam', () => {
  assert.equal(seam(messages, BODY([u1, a1, u2]), BODY([u1, user(`user: recalled ${words(50, 'r')}`), a1, u2, a2, u3])), 0);
});

test('Messages: a system prompt that changed is a seam of the old prompt', () => {
  const before = BODY([u1]);
  const old = tokensOf(messages, before, (p) => p.role === 'system');
  assert.equal(seam(messages, before, BODY([u1, a1, u2], { system: [{ type: 'text', text: 'a new prompt' }] })), old);
});

test("Messages: masked values that differ between two drives aren't seams", () => {
  const ref = (n: string) => ({ role: 'user', content: [{ type: 'text', text: `[image: image/png, ~352KB, ref img_${n}_1] [Tune-out reader — chat, epoch ${n === 'abc123' ? '8506fa9b' : '1f2e3d4c'}, wake]` }] });
  assert.equal(seamOf(messages.context(BODY([u1, ref('abc123')]), runVaryingClass('/run/one')).parts, messages.context(BODY([u1, ref('zz9x8w'), a1]), runVaryingClass('/run/two')).parts), 0);
});

test("Chat Completions: the previous request's last message grown at its end is no seam, and one rewritten is", () => {
  const openai = chat({ configuration: config, clock, dialect: 'openai' });
  const body = (msgs: ChatMessage[]) => ({ model: 'gpt-5.6-sol', messages: [{ role: 'system', content: `the fixture's agent ${words(30, 's')}` }, ...msgs] });
  const before = body([{ role: 'user', content: 'user: hello' }]);
  assert.equal(seam(openai, before, body([{ role: 'user', content: 'user: hello\nuser: and more' }])), 0);
  assert.ok(seam(openai, before, body([{ role: 'user', content: 'user: goodbye' }])) > 0);
});

test('Responses: a compaction leaves the items before it unrendered, a seam of their tokens', () => {
  const api = responses({ configuration: config, clock });
  const item = (role: string, text: string) => ({ role, content: text });
  const body = (input: Item[]) => ({ model: 'gpt-6.1-sol', instructions: `the fixture's agent ${words(30, 's')}`, input });
  const before = body([item('user', `user: ${words(40, 'a')}`), item('assistant', words(30, 'b')), item('user', `user: ${words(40, 'c')}`)]);
  const gone = tokensOf(api, before, (p) => p.role !== 'system');
  const after = body([item('user', `user: ${words(40, 'a')}`), item('assistant', words(30, 'b')), item('user', `user: ${words(40, 'c')}`), { type: 'compaction', encrypted_content: 'zzz' }, item('user', 'user: next')]);
  assert.equal(seam(api, before, after), gone);
});

test("each codec's parts sum to the tokens its cache model gives the request", () => {
  const cases: Array<[string, Codec, unknown]> = [
    ['Messages', messages, BODY([u1, a1, u2])],
    ['Responses', responses({ configuration: config, clock }), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'user: more' }] }],
    ['Codex', responses({ configuration: config, clock, backend: 'codex' }), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }] }],
    ['Chat (openai)', chat({ configuration: config, clock, dialect: 'openai' }), { model: 'gpt-5.6-sol', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
    ['Chat (deepseek)', chat({ configuration: config, clock, dialect: 'deepseek' }), { model: 'deepseek-flash', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
    ['Chat (openrouter)', chat({ configuration: config, clock, dialect: 'openrouter' }), { model: 'anthropic/claude-opus-4.6', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
  ];
  for (const [name, codec, body] of cases) {
    const parts = codec.context(body, mask).parts;
    assert.ok(parts.length > 0, name);
    const t = codec.tokens(codec.usage(body, 1, []));
    assert.equal(parts.reduce((n, p) => n + p.tokens, 0), t.input + t.cacheRead + t.cacheWrite, name);
  }
  const binding = { ...BODY([u1, { role: 'assistant', content: [{ type: 'thinking', thinking: 'a thought', signature: 'fx1.not-this-conversation' }, { type: 'text', text: 'ok' }] }, u2]), model: 'claude-opus-5-5', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
  const bt = messages.tokens(messages.usage(binding, 1, []));
  assert.equal(messages.context(binding, mask).parts.reduce((n, p) => n + p.tokens, 0), bt.input + bt.cacheRead + bt.cacheWrite, 'Messages, with an unbound thinking block dropped');
  assert.ok(!messages.context(binding, mask).parts.some((p) => p.type === 'thinking'), 'the dropped block is no part');
  const front: Codec = bedrock({ configuration: config, clock });
  const body = front.admit({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [user('user: hi')] }, '/model/us.anthropic.claude-opus-4-6-v1/invoke').body;
  const t = front.tokens(front.usage(body, 1, []));
  assert.equal(front.context(body, mask).parts.reduce((n, p) => n + p.tokens, 0), t.input + t.cacheRead + t.cacheWrite, 'Bedrock');
});

test('withheld: a binding model\'s unbound thinking block, dropped under the drop control, is what the Messages API withholds, at the tokens it weighs as sent; Bedrock, serving no model that binds, and the other APIs withhold nothing', () => {
  const thought = { role: 'assistant', content: [{ type: 'thinking', thinking: 'a thought', signature: 'fx1.not-this-conversation' }, { type: 'text', text: 'ok' }] };
  const binding = { ...BODY([u1, thought, u2]), model: 'claude-opus-5-5', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
  const sent = contextParts(binding, mask).filter((p) => p.type === 'thinking');
  assert.equal(sent.length, 1);
  assert.deepEqual(messages.context(binding, mask).withheld, sent);
  assert.deepEqual(messages.context({ ...binding, thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } } }, mask).withheld, [], 'nothing is withheld without the drop control');
  assert.deepEqual(messages.context(BODY([u1, a1, u2]), mask).withheld, []);
  const front: Codec = bedrock({ configuration: config, clock });
  const path = '/model/us.anthropic.claude-opus-4-6-v1/invoke';
  const admitted = front.admit({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, thinking: binding.thinking, messages: [u1, thought, u2] }, path);
  const body = admitted.body;
  assert.equal(admitted.read!().reason, undefined);
  assert.deepEqual(front.context(body, mask).withheld, [], 'Bedrock serves no model that binds thinking, so it withholds nothing');
  assert.deepEqual(responses({ configuration: config, clock }).context({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'user: hi' }] }, mask).withheld, []);
  assert.deepEqual(chat({ configuration: config, clock, dialect: 'openai' }).context({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'user: hi' }] }, mask).withheld, []);
});

test('a last message of text parts that grows is carried on the Responses API and Chat Completions, as a string one is', () => {
  const r = responses({ configuration: config, clock });
  const rb = (text: string) => ({ model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: `user: ${words(30, 'a')}` }] }, { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, { role: 'user', content: [{ type: 'input_text', text }] }] });
  assert.equal(seam(r, rb('user: hello'), rb('user: hello and more')), 0, 'Responses');
  assert.ok(seam(r, rb('user: hello'), rb('user: goodbye')) > 0, 'Responses, a change that is no growth');
  const c = chat({ configuration: config, clock, dialect: 'openai' });
  const cb = (text: string) => ({ model: 'gpt-5.6-sol', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: `user: ${words(30, 'a')}` }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [{ type: 'text', text }] }] });
  assert.equal(seam(c, cb('user: hello'), cb('user: hello and more')), 0, 'Chat Completions');
  assert.ok(seam(c, cb('user: hello'), cb('user: goodbye')) > 0, 'Chat Completions, a change that is no growth');
});

test('a binding model binds a tool result\'s `is_error: false` as no flag on a message\'s own block only: the same literal inside a tool\'s schema is bound as sent, so a block made with it there is withheld once the schema comes back without it', () => {
  const probe = (flag: Flag) => ({ name: 'fixture--probe', description: 'probe', input_schema: { type: 'object', properties: { r: { const: { type: 'tool_result', tool_use_id: 'x', ...flag } } } } });
  const drop = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const at = (flag: Flag, msgs: MessageItem[]) => { const b = BODY(msgs); return { ...b, model: 'claude-opus-5-5', thinking: drop, tools: [...b.tools, probe(flag)] }; };
  const made = messages.seal([{ type: 'thinking', thinking: 'a thought' }, { type: 'text', text: 'ok' }], at({ is_error: false }, [u1]));
  assert.ok(made.some((b) => b.type === 'thinking' && typeof b.signature === 'string'), 'premise: sealing signs the block');
  const replay = (flag: Flag) => at(flag, [u1, { role: 'assistant', content: made }, u2]);
  assert.deepEqual(messages.context(replay({ is_error: false }), mask).withheld, [], 'the schema as it was sent');
  assert.equal(messages.context(replay({}), mask).withheld.length, 1, 'the nested literal\'s flag gone: the block is bound to another prefix');
  const top = (flag: Flag) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'now', ...flag }] });
  const sealedAfter = messages.seal([{ type: 'thinking', thinking: 'b thought' }, { type: 'text', text: 'ok' }], at({}, [u1, call('t1'), top({ is_error: false })]));
  assert.deepEqual(messages.context(at({}, [u1, call('t1'), top({}), { role: 'assistant', content: sealedAfter }, u2]), mask).withheld, [], 'a message\'s own tool result: `is_error: false` and no flag alike');
  assert.ok(seam(messages, at({ is_error: false }, [u1]), at({}, [u1, a1, u2])) > 0, 'and a tool whose schema changed so is a seam');
});

test('Chat Completions: a last message whose text parts grow is carried though it also carries reasoning, which is no text of its content', () => {
  const c = chat({ configuration: config, clock, dialect: 'deepseek' });
  const ends = (text: string, more: ChatMessage[] = []) => ({ model: 'deepseek-flash', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `user: ${words(30, 'a')}` }, { role: 'assistant', content: [{ type: 'text', text }], reasoning_content: 'a plan' }, ...more] });
  assert.equal(seam(c, ends('hello'), ends('hello and more', [{ role: 'user', content: 'user: next' }])), 0, 'grown at its end');
  assert.ok(seam(c, ends('hello'), ends('goodbye', [{ role: 'user', content: 'user: next' }])) > 0, 'a change that is no growth');
});

test("a tool's schema is read as sent, a property named `cache_control` in it too: changing it is a seam on Messages, Chat Completions and the Responses API", () => {
  const schema = (v: string) => ({ type: 'object', properties: { cache_control: { type: 'string', description: v } } });
  const mb = (v: string) => ({ ...BODY([u1, a1, u2]), tools: [{ name: 'fixture--probe', description: 'probe', input_schema: schema(v) }] });
  assert.ok(seam(messages, mb('one'), mb('two')) > 0, 'Messages');
  const c = chat({ configuration: config, clock, dialect: 'openai' });
  const cb = (v: string) => ({ model: 'gpt-5.6-sol', tools: [{ type: 'function', function: { name: 'probe', description: 'probe', parameters: schema(v) } }], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: `user: ${words(30, 'a')}` }] });
  assert.ok(seam(c, cb('one'), cb('two')) > 0, 'Chat Completions');
  const r = responses({ configuration: config, clock });
  const rb = (v: string) => ({ model: 'gpt-6.1-sol', instructions: 'sys', tools: [{ type: 'function', name: 'probe', description: 'probe', parameters: schema(v) }], input: [{ role: 'user', content: [{ type: 'input_text', text: `user: ${words(30, 'a')}` }] }] });
  assert.ok(seam(r, rb('one'), rb('two')) > 0, 'Responses');
  assert.equal(seam(messages, BODY([u1, a1, u2]), { ...BODY([u1, a1, u2]), tools: BODY([]).tools.map((t) => ({ ...t, cache_control: MARK })) }), 0, 'a cache marker on the tool itself is still no seam');
});

test('Messages: a withheld thinking block is the one the drop control drops, by its place: of two copies of one thought, the first block of its message, unbound, weighs its message overhead too', () => {
  const drop = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const at = (msgs: MessageItem[]) => ({ ...BODY(msgs), model: 'claude-opus-5-5', thinking: drop });
  const thought = words(40, 't');
  const early = messages.seal([{ type: 'thinking', thinking: thought }, { type: 'text', text: 'one' }], at([user('user: a first ask')]));
  const m1 = { role: 'assistant', content: early };
  const late = messages.seal([{ type: 'thinking', thinking: thought }, { type: 'text', text: 'two' }], at([u1, m1, u2]));
  const m2 = { role: 'assistant', content: [{ type: 'text', text: 'and' }, ...late] };
  const body = at([u1, m1, u2, m2, u3]);
  const sent = contextParts(body, mask).filter((p) => p.type === 'thinking');
  assert.equal(sent.length, 2, 'premise: two copies of the thought are sent');
  assert.equal(sent[0].id, sent[1].id, 'premise: alike, by identity');
  assert.ok(sent[0].tokens > sent[1].tokens, 'premise: the first opens its message, so it weighs the message overhead');
  const withheld = messages.context(body, mask).withheld;
  assert.deepEqual(withheld.map((p) => p.tokens), [sent[0].tokens], 'the first copy, signed for another prefix, is the one dropped');
});
