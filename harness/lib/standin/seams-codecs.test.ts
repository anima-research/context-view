// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { chat } from './chat.ts';
import { responses } from './responses.ts';
import { seamOf } from './seams.ts';
import { runVaryingClass } from '../strategies/compare.ts';

const config = { windowTokens: 1_000_000 };
const clock = () => 0;
const mask = runVaryingClass(null);
const MARK = { type: 'ephemeral' };
const words = (n, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

const messages = anthropic({ configuration: config, clock });
const BODY = (msgs, more = {}) => ({ model: 'claude-opus-4-6', max_tokens: 2000, system: [{ type: 'text', text: `the fixture's agent ${words(30, 's')}` }], tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages: msgs, ...more });
const user = (text, more = {}) => ({ role: 'user', content: [{ type: 'text', text, ...more }] });
const said = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'time--now', input: {} }] });
const result = (id, text, more = {}) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...more }] });
const seam = (codec, before, after) => seamOf(codec.parts(before, mask), codec.parts(after, mask));
const tokensOf = (codec, body, pick) => codec.parts(body, mask).filter(pick).reduce((t, p) => t + p.tokens, 0);
const u1 = user(`user: ${words(40, 'a')}`), a1 = said(words(30, 'b')), u2 = user(`user: ${words(40, 'c')}`), a2 = said(words(30, 'd')), u3 = user(`user: ${words(40, 'e')}`);

test('Messages: appending is no seam', () => {
  assert.equal(seam(messages, BODY([u1]), BODY([u1, a1, u2])), 0);
});

test('Messages: a summary replacing messages is a seam of their tokens, and a front drop of the dropped ones alone', () => {
  const before = BODY([u1, a1, u2, a2, u3]);
  const replaced = messages.parts(BODY([u1, a1, u2]), mask).slice(2).reduce((t, p) => t + p.tokens, 0);
  assert.equal(seam(messages, before, BODY([user(`user: summary ${words(10, 'z')}`), a2, u3, said('ok'), user('user: next')])), replaced);
  const dropped = messages.parts(BODY([u1, a1]), mask).slice(2).reduce((t, p) => t + p.tokens, 0);
  assert.equal(seam(messages, before, BODY([u2, a2, u3, said('ok'), user('user: next')])), dropped);
});

test('Messages: a cache marker moved, on a block, nested in a tool result or on a message, is no seam', () => {
  const before = BODY([user(`user: ${words(40, 'a')}`, { cache_control: MARK }), call('t1'), result('t1', 'now'), said('ok')]);
  const nested = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'now', cache_control: MARK }] }] };
  const after = BODY([user(`user: ${words(40, 'a')}`), call('t1'), nested, { ...said('ok'), cache_control: MARK }, user('user: more', { cache_control: MARK })]);
  assert.equal(seam(messages, before, after), 0);
});

test("Messages: a tool result's `is_error: false` sent back with no flag is no seam, and `is_error: true` sent back with none is one", () => {
  const flagged = (e) => BODY([u1, call('t1'), result('t1', 'now', { is_error: e }), said('ok')]);
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
  const ref = (n) => ({ role: 'user', content: [{ type: 'text', text: `[image: image/png, ~352KB, ref img_${n}_1] [Tune-out reader — chat, epoch ${n === 'abc123' ? '8506fa9b' : '1f2e3d4c'}, wake]` }] });
  assert.equal(seamOf(messages.parts(BODY([u1, ref('abc123')]), runVaryingClass('/run/one')), messages.parts(BODY([u1, ref('zz9x8w'), a1]), runVaryingClass('/run/two'))), 0);
});

test("Chat Completions: the previous request's last message grown at its end is no seam, and one rewritten is", () => {
  const openai = chat({ configuration: config, clock, dialect: 'openai' });
  const body = (msgs) => ({ model: 'gpt-5.6-sol', messages: [{ role: 'system', content: `the fixture's agent ${words(30, 's')}` }, ...msgs] });
  const before = body([{ role: 'user', content: 'user: hello' }]);
  assert.equal(seam(openai, before, body([{ role: 'user', content: 'user: hello\nuser: and more' }])), 0);
  assert.ok(seam(openai, before, body([{ role: 'user', content: 'user: goodbye' }])) > 0);
});

test('Responses: a compaction leaves the items before it unrendered, a seam of their tokens', () => {
  const api = responses({ configuration: config, clock });
  const item = (role, text) => ({ role, content: text });
  const body = (input) => ({ model: 'gpt-6.1-sol', instructions: `the fixture's agent ${words(30, 's')}`, input });
  const before = body([item('user', `user: ${words(40, 'a')}`), item('assistant', words(30, 'b')), item('user', `user: ${words(40, 'c')}`)]);
  const gone = tokensOf(api, before, (p) => p.role !== 'system');
  const after = body([item('user', `user: ${words(40, 'a')}`), item('assistant', words(30, 'b')), item('user', `user: ${words(40, 'c')}`), { type: 'compaction', encrypted_content: 'zzz' }, item('user', 'user: next')]);
  assert.equal(seam(api, before, after), gone);
});

test("each codec's parts sum to the tokens its cache model gives the request", () => {
  const cases = [
    ['Messages', messages, BODY([u1, a1, u2])],
    ['Responses', responses({ configuration: config, clock }), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'user: more' }] }],
    ['Codex', responses({ configuration: config, clock, backend: 'codex' }), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }] }],
    ['Chat (openai)', chat({ configuration: config, clock, dialect: 'openai' }), { model: 'gpt-5.6-sol', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
    ['Chat (deepseek)', chat({ configuration: config, clock, dialect: 'deepseek' }), { model: 'deepseek-flash', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
    ['Chat (openrouter)', chat({ configuration: config, clock, dialect: 'openrouter' }), { model: 'anthropic/claude-opus-4.6', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user: hi' }] }],
  ];
  for (const [name, codec, body] of cases) {
    const parts = codec.parts(body, mask);
    assert.ok(parts.length > 0, name);
    const t = codec.tokens(codec.usage(body, 1, []));
    assert.equal(parts.reduce((n, p) => n + p.tokens, 0), t.input + t.cacheRead + t.cacheWrite, name);
  }
  const binding = { ...BODY([u1, { role: 'assistant', content: [{ type: 'thinking', thinking: 'a thought', signature: 'fx1.not-this-conversation' }, { type: 'text', text: 'ok' }] }, u2]), model: 'claude-opus-5-5', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
  const bt = messages.tokens(messages.usage(binding, 1, []));
  assert.equal(messages.parts(binding, mask).reduce((n, p) => n + p.tokens, 0), bt.input + bt.cacheRead + bt.cacheWrite, 'Messages, with an unbound thinking block dropped');
  assert.ok(!messages.parts(binding, mask).some((p) => p.type === 'thinking'), 'the dropped block is no part');
  const front = bedrock({ configuration: config, clock });
  const read = front.read({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [user('user: hi')] }, '/model/us.anthropic.claude-opus-4-6-v1/invoke');
  const body = read.body;
  const t = front.tokens(front.usage(body, 1, []));
  assert.equal(front.parts(body, mask).reduce((n, p) => n + p.tokens, 0), t.input + t.cacheRead + t.cacheWrite, 'Bedrock');
});
