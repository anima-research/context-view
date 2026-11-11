// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from './anthropic.ts';

// A binding model's thinking block is signed with the identity of everything before the message it's in. These are the
// identities' exact values for one conversation, by the signatures the stand-in makes and checks, so a change to how
// they're computed that moves any of them fails here.
const codec = anthropic({ configuration: { windowTokens: 1_000_000 }, clock: () => 0 });
const MARK = { type: 'ephemeral' };
const HEAD = {
  model: 'claude-opus-5-5',
  max_tokens: 4096,
  thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  system: [{ type: 'text', text: 'You are the fixture\'s agent. Ünïcode "quoted" \\ back', cache_control: MARK }],
  tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: { zone: { type: 'string' }, at: { type: 'number' } } } }],
};
const SIGNED = ['fx1.I1qQkW02AYPrVewI4A_D12WShZ6htY05CzZ0HHbY8Yu', 'fx1.1HApmMMZ8gmxRJ80ShUyBLM7wdm2oFQU-B04Md3_STa', 'fx1.hBSiMTXgl7quI9KZFRli3y47DEQpj8HBSa-_TImW-5J'];
const conversation = ({ flag = { is_error: false }, input = 'kept: an input is the call\'s own', lima = 'and in Lima?', marked = true } = {}) => [
  { role: 'user', content: [{ type: 'text', text: 'what time is it in Tōkyō?', ...(marked ? { cache_control: MARK } : {}) }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'call the clock', signature: SIGNED[0] }, { type: 'tool_use', id: 'toolu_1', name: 'time--now', input: { zone: 'Asia/Tokyo', cache_control: input } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '09:00' }], ...flag }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'answer it', signature: SIGNED[1] }, { type: 'text', text: 'It is 09:00.' }] },
  { role: 'user', content: lima },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: SIGNED[2] }, { type: 'text', text: 'Nineteen hours earlier.' }] },
  { role: 'user', content: [{ type: 'text', text: 'thanks', ...(marked ? {} : { cache_control: MARK }) }] },
];
const body = (messages, more = {}) => ({ ...HEAD, ...more, messages });
const sealed = (messages, thinking) => codec.seal([{ type: 'thinking', thinking }], body(messages))[0].signature;
// The messages whose thinking the drop control takes out of a request: the blocks whose signatures don't bind.
const THOUGHT = codec.parts(body(conversation()), (v) => v).filter((p) => p.type === 'thinking').map((p) => p.id);
const unbound = (messages) => codec.withheld(body(messages), (v) => v).map((p) => [1, 3, 5][THOUGHT.indexOf(p.id)]);

test('a binding model\'s identities have these exact values: each block is signed for everything before its message, and the whole conversation for the next', () => {
  const messages = conversation();
  assert.deepEqual([1, 3, 5].map((cut) => sealed(messages.slice(0, cut), messages[cut].content[0].thinking)), SIGNED);
  assert.equal(sealed(messages, 'next'), 'fx1.RdZ_4Sb_Nj88MwfTSh4NifxsHJqchUPx5M2YAGTPFiX');
  assert.equal(codec.read(body(messages)).view.seed(), 3512241127);
  assert.equal(new Set(THOUGHT).size, 3, 'premise: the three blocks are told apart');
  assert.deepEqual(unbound(messages), []);
});

test('the identities take a tool result\'s `is_error: false` as no flag and leave cache markers out, but take `is_error: true`, a call\'s input whole and every message\'s text as sent', () => {
  assert.deepEqual(unbound(conversation({ flag: {}, marked: false })), [], 'no flag, and the markers moved');
  assert.equal(sealed(conversation({ flag: {}, marked: false }), 'next'), sealed(conversation(), 'next'));
  assert.deepEqual(unbound(conversation({ flag: { is_error: true } })), [3, 5], '`is_error: true` unbinds both blocks after it');
  assert.deepEqual(unbound(conversation({ input: 'changed' })), [3, 5], 'a call\'s input is read whole, a `cache_control` key in it included');
  assert.deepEqual(unbound(conversation({ lima: 'and in Quito?' })), [5], 'a later message unbinds only the block after it');
});
