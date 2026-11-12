import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic, type MessagesBody } from './anthropic.ts';

type MessageItem = NonNullable<MessagesBody['messages']>[number];

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
const conversation = ({ flag = { is_error: false }, input = 'kept: an input is the call\'s own', lima = 'and in Lima?', marked = true }: { flag?: { is_error?: boolean }; input?: string; lima?: string; marked?: boolean } = {}) => [
  { role: 'user', content: [{ type: 'text', text: 'what time is it in Tōkyō?', ...(marked ? { cache_control: MARK } : {}) }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'call the clock', signature: SIGNED[0] }, { type: 'tool_use', id: 'toolu_1', name: 'time--now', input: { zone: 'Asia/Tokyo', cache_control: input } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '09:00' }], ...flag }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'answer it', signature: SIGNED[1] }, { type: 'text', text: 'It is 09:00.' }] },
  { role: 'user', content: lima },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: SIGNED[2] }, { type: 'text', text: 'Nineteen hours earlier.' }] },
  { role: 'user', content: [{ type: 'text', text: 'thanks', ...(marked ? {} : { cache_control: MARK }) }] },
];
const body = (messages: MessageItem[], more: Partial<typeof HEAD> = {}) => ({ ...HEAD, ...more, messages });
const sealed = (messages: MessageItem[], thinking: string) => codec.seal([{ type: 'thinking', thinking }], body(messages))[0].signature;
const THOUGHT = codec.context(body(conversation()), (v) => v).parts.filter((p) => p.type === 'thinking').map((p) => p.id);
const unbound = (messages: MessageItem[]) => codec.context(body(messages), (v) => v).withheld.map((p) => [1, 3, 5][THOUGHT.indexOf(p.id)]);

test('a binding model\'s identities have these exact values: each block is signed for everything before its message, and the whole conversation for the next', () => {
  const messages = conversation();
  assert.deepEqual([1, 3, 5].map((cut) => sealed(messages.slice(0, cut), (messages[cut].content[0] as { thinking: string }).thinking)), SIGNED);
  assert.equal(sealed(messages, 'next'), 'fx1.RdZ_4Sb_Nj88MwfTSh4NifxsHJqchUPx5M2YAGTPFiX');
  assert.equal(codec.read(body(messages)).view!.seed(), 3512241127);
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

test("the codec keeps what it builds from a body only while the body is frozen: an unfrozen body changed between two reads reads as changed, both ways", () => {
  const same = (v: unknown) => v;
  const b = body(conversation());
  assert.deepEqual(codec.context(b, same).withheld, []);
  const whole = codec.countTokens(b);
  b.messages[4] = { role: 'user', content: 'and in Lima, now?' };
  assert.equal(codec.context(b, same).withheld.length, 1, 'the changed message unbinds the block after it, and only that block is withheld');
  const dropped = codec.countTokens(b);
  assert.notEqual(dropped, whole);
  b.messages[4] = conversation()[4];
  assert.deepEqual(codec.context(b, same).withheld, [], 'changed back, it binds again');
  assert.equal(codec.countTokens(b), whole);
  b.messages.push({ role: 'user', content: 'and one more' });
  assert.ok(codec.countTokens(b) > whole, 'grown at its end, where nothing is dropped and the body is read as sent, it counts grown');
});

test("the codec keeps what it builds only for a body the stand-in parsed: one frozen at its top alone, changed below it, reads as changed, and reading it freezes nothing of the caller's", () => {
  const same = (v: unknown) => v;
  const b = Object.freeze(body(conversation()));
  const whole = codec.countTokens(b);
  b.messages.push({ role: 'user', content: 'and one more' });
  assert.ok(codec.countTokens(b) > whole, 'grown below its frozen top, it counts grown');
  const c = Object.freeze(body(conversation({ lima: 'and in Lima, now?' })));
  assert.equal(codec.context(c, same).withheld.length, 1, 'premise: a block is dropped, so the codec builds a read');
  assert.ok(!Object.isFrozen(c.messages[4]), "the caller's own message, kept whole in the read, isn't frozen by it");
  c.messages[4] = conversation()[4];
  assert.deepEqual(codec.context(c, same).withheld, [], 'changed back below its frozen top, it binds again');
});
