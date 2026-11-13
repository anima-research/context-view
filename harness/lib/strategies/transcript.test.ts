import { test } from 'node:test';
import assert from 'node:assert/strict';
import { png } from './png.ts';
import { prose } from './prose.ts';
import { toolResult } from './results.ts';
import { TOOL } from './script.ts';
import { RESULT_FORM, generatedTexts, transcriptOf } from './transcript.ts';
import { anthropic, decodeMessages } from '../standin/anthropic.ts';
import { responses } from '../standin/responses.ts';
import { decoded } from '../standin/standin.ts';
import type { Generated } from './transcript.ts';
import type { MessagesBody } from '../standin/anthropic.ts';
import type { JsonLike } from './compare.ts';
import type { Step } from './script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Block, View } from '../standin/view.ts';

const TOOLS = [{ name: 'time--now', description: 'Returns the time.', input_schema: { type: 'object', properties: {} } }];
const IN = '[[c:x.1.in]]';
const said = `${IN} ${prose(600, 'x.1:in')}`;
const turn = { id: 'x.1', kind: 'channel', text: said, canaries: [IN], replies: [{ text: `[[c:x.1.r1]] ${prose(300, 'x.1:r1')}` }] } satisfies Step;
const head = (text: string, from = 0) => `${text.slice(from).trimStart().slice(0, 40)}…`;
const body = (messages: MessagesBody['messages'], more: Partial<MessagesBody> = {}) => decodeMessages({ model: 'claude-opus-4-6', max_tokens: 2048, system: 'You are the fixture agent.', tools: TOOLS, messages, ...more }).view!;
const messagesTranscript = (view: View, generated: Generated, seen?: Set<string>) => transcriptOf(view, generated, seen, { api: 'messages' });
const user = (...texts: string[]) => ({ role: 'user', content: texts.map((text) => ({ type: 'text', text })) });

test('X1: a text the run generated shows as its mark, its length and a head; the stack\'s words around it, the system and the tools show verbatim', () => {
  const generated = generatedTexts({ steps: [turn] });
  const lines = messagesTranscript(body([user(`user: Ash: ${said}`, 'Context Manager: What do you remember from earlier?')]), generated);
  assert.deepEqual(lines, [
    'system: You are the fixture agent.',
    'tool time--now:',
    '    | description: Returns the time.',
    '    | input_schema: {"type":"object","properties":{}}',
    '#0 user',
    `  text: user: Ash: ⟪${IN} ${said.length} chars: ${head(said, IN.length + 1)}⟫`,
    '  text: Context Manager: What do you remember from earlier?',
  ]);
});

test('X2: a stack word from the generator\'s vocabulary right after the run\'s content stays the stack\'s, after a whole text or a cut one, and a one-word stack change shows verbatim', () => {
  const generated = generatedTexts({ steps: [turn] });
  const [whole] = messagesTranscript(body([user(`${said} River notes the stack wrote.`)]), generated).slice(-1);
  assert.equal(whole, `  text: ⟪${IN} ${said.length} chars: ${head(said, IN.length + 1)}⟫ River notes the stack wrote.`);
  const cutAt = 300;
  assert.notEqual(said.slice(cutAt, cutAt + 8), ' lantern', 'the generated text goes on differently, so the word is the stack\'s');
  const [cut] = messagesTranscript(body([user(`${said.slice(0, cutAt)} lantern`)]), generated).slice(-1);
  assert.equal(cut, `  text: ⟪${IN} chars 0–${cutAt} of ${said.length}: ${head(said, IN.length + 1)}⟫ lantern`);
  const before = messagesTranscript(body([user(said, 'Context Manager: What do you remember from earlier?')]), generated).at(-1);
  const after = messagesTranscript(body([user(said, 'Context Manager: What do you remember from harbor?')]), generated).at(-1);
  assert.equal(before, '  text: Context Manager: What do you remember from earlier?');
  assert.equal(after, '  text: Context Manager: What do you remember from harbor?');
});

test('X3: a generated text stored in parts shows each part, marked or not, by the text\'s mark and where the part sits in it', () => {
  const doc = `[[c:x.2.in]] ${prose(5000, 'x.2:in')}`;
  const generated = generatedTexts({ steps: [{ id: 'x.2', kind: 'channel', text: doc }] });
  const lines = messagesTranscript(body([user(`user: ${doc.slice(0, 2600)}`, `user: ${doc.slice(2600)}`)]), generated);
  assert.deepEqual(lines.slice(-2), [
    `  text: user: ⟪[[c:x.2.in]] chars 0–2,600 of ${doc.length.toLocaleString('en-US')}: ${head(doc, 13)}⟫`,
    `  text: user: ⟪[[c:x.2.in]] chars 2,600–${doc.length.toLocaleString('en-US')} of ${doc.length.toLocaleString('en-US')}: ${head(doc, 2600)}⟫`,
  ]);
});

test('X8: where a request carries one generated text on past a stretch another also holds, the stretch shows as part of the text it continues in, not of the other', () => {
  const doc = `[[c:x.5.in]] ${prose(3000, 'x.5:in')}`;
  const at = 1001;
  const reply = `[[c:x.5.r1]] zz${doc.slice(at + 1, at + 46)} zz ${prose(200, 'x.5:r1')}`;
  const generated = generatedTexts({ steps: [{ id: 'x.5', kind: 'channel', text: doc, replies: [{ text: reply }] }] });
  const [line] = messagesTranscript(body([user(`user: ${doc.slice(at)}`)]), generated).slice(-1);
  assert.equal(line, `  text: user: ⟪[[c:x.5.in]] chars 1,001–${doc.length.toLocaleString('en-US')} of ${doc.length.toLocaleString('en-US')}: ${head(doc, at)}⟫`);
});

test('X10: a cache marker shows as the record shows it, its TTL when plain and whole otherwise; the system shows as one text, its blocks\' markers and other fields left to the record', () => {
  const generated = generatedTexts({ steps: [turn] });
  const odd = { type: 'ephemeral', ttl: '1h', scope: 'x' };
  const lines = messagesTranscript(body([user(said)], { system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: odd, citations: { enabled: true } }, { type: 'text', text: ' Be brief.' }] }), generated);
  assert.equal(lines[0], 'system: You are the fixture agent. Be brief.');
  const marked = (cc: JsonLike) => messagesTranscript(body([{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: cc }] }]), generated).at(-1);
  assert.equal(marked({ type: 'ephemeral', ttl: '1h' }), '  text [cache 1h]: hello');
  assert.equal(marked({ type: 'persistent' }), '  text [cache {"type":"persistent"}]: hello');
  assert.equal(marked(false), '  text [cache false]: hello');
  const systemLine = (block: Block) => messagesTranscript(body([user(said)], { system: [block] }), generated)[0];
  for (const block of [{ type: 'document', text: 'You are the fixture agent.' }, { text: 'You are the fixture agent.', citations: { enabled: true } }, { type: 'text', text: 'You are the fixture agent.', cache_control: false }]) {
    assert.equal(systemLine(block as unknown as Block), 'system: You are the fixture agent.', JSON.stringify(block));
  }
});

test('X11: a message\'s other envelope fields show beside its role, its own cache marker as a block\'s does', () => {
  const generated = generatedTexts({ steps: [turn] });
  const header = (extra: Record<string, JsonLike>) => messagesTranscript(body([{ ...user('hello'), ...extra }]), generated).at(-2);
  assert.equal(header({}), '#0 user');
  assert.equal(header({ name: 'ash' }), '#0 user {"name":"ash"}');
  assert.equal(header({ cache_control: { type: 'ephemeral', ttl: '1h' } }), '#0 user [cache 1h]');
});

test('X12: thinking is matched like any text, so the run\'s thinking shows as its mark and the stack\'s words in it verbatim', () => {
  const thought = prose(200, 'x.4:think');
  const generated = generatedTexts({ answers: [[{ type: 'thinking', thinking: thought }]] });
  const line = (said: string) => messagesTranscript(body([{ role: 'assistant', content: [{ type: 'thinking', thinking: said, signature: 'fx1.abc' }] }]), generated).at(-1);
  assert.equal(line(`${thought} keep this`), `  thinking signed: ⟪(thinking) 200 chars: ${head(thought)}⟫ keep this`);
  assert.notEqual(line(`${thought} drop this`), line(`${thought} keep this`));
});

test('X4: a long stack text already shown is named the next time, and a one-word change to it shows it whole again', () => {
  const long = (word: string) => [{ name: 'notes', description: `Keeps notes. ${'Each note is kept as written and returned on request. '.repeat(5)}The ${word} is optional.`, input_schema: { type: 'object' } }];
  const generated = generatedTexts({ steps: [turn] });
  const seen = new Set<string>();
  const first = messagesTranscript(body([user(said)], { tools: long('title') }), generated, seen);
  const second = messagesTranscript(body([user(said)], { tools: long('title') }), generated, seen);
  const changed = messagesTranscript(body([user(said)], { tools: long('heading') }), generated, seen);
  assert.ok(first.some((l) => l.includes('The title is optional.')));
  const named = second.find((l) => l.startsWith('tool notes'));
  assert.match(named!, /^tool notes: \(as above: tool notes, [\d,]+ chars, [0-9a-f]{8}\)$/);
  assert.ok(changed.some((l) => l.includes('The heading is optional.')), 'the changed definition is shown, not named');
  assert.equal(second.find((l) => l.startsWith('system')), 'system: You are the fixture agent.', 'a short text is always shown');
  const notice = (word: string) => `Context Manager: ${'This note is the stack\'s own wording, kept as written. '.repeat(5)}The ${word} closes it.`;
  const shown = messagesTranscript(body([user(said, notice('word'))]), generated, seen).at(-1);
  const again = messagesTranscript(body([user(said, notice('word'))]), generated, seen).at(-1);
  const reworded = messagesTranscript(body([user(said, notice('phrase'))]), generated, seen).at(-1);
  assert.equal(shown, `  text: ${notice('word')}`);
  assert.match(again!, /^ {2}text: \(as above: "Context Manager: This note is the stack'…", [\d,]+ chars, [0-9a-f]{8}\)$/);
  assert.equal(reworded, `  text: ${notice('phrase')}`, 'a one-word change shows it whole');
});

test('X9: a call\'s input is matched as its strings read, so a run text with a newline or a quote in it still shows as the run\'s, and the stack\'s strings stay JSON', () => {
  const task = `[[c:x.6.task]] ${prose(200, 'x.6:task')}\n"${prose(100, 'x.6:quoted')}"`;
  const generated = generatedTexts({ steps: [{ id: 'x.6', replies: [{ calls: [{ name: 'subagent--spawn', input: { task } }] }] }] satisfies DeepPartial<Step>[] as unknown as Step[] });
  const [line] = messagesTranscript(body([{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'subagent--spawn', input: { note: 'line one\nline "two"', task, sync: true } }] }]), generated).slice(-1);
  assert.equal(line, `  tool_use toolu_1 subagent--spawn: {"note":"line one\\nline \\"two\\"","task":"⟪[[c:x.6.task]] ${task.length} chars: ${head(task, '[[c:x.6.task]] '.length)}⟫","sync":true}`);
});

test('X5: thinking shows signed or not with the run\'s thinking marked, a call its input with the run\'s texts marked, a result its blocks, an image its type, size and bytes, and a cache marker on its block', () => {
  const image = png(4, 3, () => 1);
  const task = `[[c:x.3.task]] ${prose(400, 'x.3:task')}`;
  const thought = prose(120, 'x.3:think');
  const call = { kind: 'prose', size: 900, canary: '[[c:x.3.call1]]' };
  const resultText = toolResult(call).content[0].text!;
  const generated = generatedTexts({ steps: [{ id: 'x.3', replies: [{ calls: [{ name: TOOL, input: call }, { name: 'subagent--spawn', input: { task } }] }] }] satisfies DeepPartial<Step>[] as unknown as Step[], answers: [[{ type: 'thinking', thinking: thought }]] });
  const lines = messagesTranscript(body([
    { role: 'assistant', content: [{ type: 'thinking', thinking: thought, signature: 'fx1.abc' }, { type: 'thinking', thinking: thought }, { type: 'tool_use', id: 'toolu_1', name: TOOL, input: call }, { type: 'tool_use', id: 'toolu_2', name: 'subagent--spawn', input: { task } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: resultText }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }], cache_control: { type: 'ephemeral', ttl: '1h' } }] },
  ]), generated);
  assert.deepEqual(lines.slice(-9), [
    '#0 assistant',
    `  thinking signed: ⟪(thinking) 120 chars: ${head(thought)}⟫`,
    `  thinking unsigned: ⟪(thinking) 120 chars: ${head(thought)}⟫`,
    `  tool_use toolu_1 ${TOOL}: {"kind":"prose","size":900,"canary":"[[c:x.3.call1]]"}`,
    `  tool_use toolu_2 subagent--spawn: {"task":"⟪[[c:x.3.task]] ${task.length} chars: ${head(task, '[[c:x.3.task]] '.length)}⟫"}`,
    '#1 user',
    '  tool_result toolu_1 (no is_error) (content as blocks) [cache 1h]',
    `    text: ⟪[[c:x.3.call1]] 900 chars: ${head(resultText, '[[c:x.3.call1]] '.length)}⟫`,
    `    image: image/png 4×3, ${Buffer.from(image, 'base64').length} bytes`,
  ]);
});

test('X6: the run\'s texts include the words the fixture gives each call, both texts of a mixed one, and what the stand-in answered, each text of 32 characters or more among them', () => {
  const json = { kind: 'json', size: 700, canary: '[[c:x.4.call1]]' };
  const mixed = { kind: 'mixed', size: 1200, width: 2, height: 2, canary: '[[c:x.4.call2]]' };
  const summary = `[[s:M0123abcd]] Memory 0123abcd, carried 1 canaries to c:x.4.in: ${prose(500, 7)}`;
  const thought = prose(300, 9);
  const generated = generatedTexts({ steps: [{ id: 'x.4', replies: [{ calls: [{ name: TOOL, input: json }, { name: TOOL, input: mixed }] }] }] satisfies DeepPartial<Step>[] as unknown as Step[], answers: [[{ type: 'text', text: summary }], [{ type: 'thinking', thinking: thought, signature: 's' }]] });
  const [jsonText] = toolResult(json).content.map((b) => b.text) as [string];
  const [first, , second] = toolResult(mixed).content.map((b) => b.text) as [string, undefined, string];
  const lines = messagesTranscript(body([user(jsonText, first, second, summary, `Thought: ${thought}`)]), generated);
  assert.deepEqual(lines.slice(-5), [
    `  text: ⟪[[c:x.4.call1]] 700 chars: ${head(jsonText)}⟫`,
    `  text: ⟪[[c:x.4.call2]] 600 chars: ${head(first, 16)}⟫`,
    `  text: ⟪[[c:x.4.call2]] 600 chars: ${head(second, 16)}⟫`,
    `  text: ⟪[[s:M0123abcd]] ${summary.length} chars: ${head(summary, 16)}⟫`,
    `  text: Thought: ⟪(thinking) 300 chars: ${head(thought)}⟫`,
  ]);
});

test('X7: a per-process image ref nonce and a fork call\'s UUID are masked, so two processes\' requests give the same lines, and a result naming another fork than its call shows it', () => {
  const generated = generatedTexts({ steps: [turn] });
  const of = (ref: string, uuid: string, answered = uuid) => messagesTranscript(body([
    user(said, `[image: image/png, ~1KB, ref ${ref}]`),
    { role: 'assistant', content: [{ type: 'tool_use', id: `fork-fork-x-${uuid}`, name: 'subagent--fork', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-fork-x-${answered}`, content: 'done' }] },
  ]), generated);
  const one = of('img_k7x3q2_7', '0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6');
  const two = of('img_zz91aa_7', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d');
  assert.deepEqual(one, two);
  assert.ok(one.includes('  text: [image: image/png, ~1KB, ref img_N1_7]'));
  assert.ok(one.includes('  tool_use fork-fork-x-UUID1 subagent--fork: {}'));
  assert.ok(one.includes('  tool_result fork-fork-x-UUID1 (no is_error)'));
  const crossed = of('img_k7x3q2_7', '0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d');
  assert.ok(crossed.includes('  tool_result fork-fork-x-UUID2 (no is_error)'), 'a result answering another fork is named apart');
});

test('X13: a block\'s fields its line doesn\'t otherwise show appear beside its type, masked as the message\'s digest masks them, and a result departing from the form the transcript\'s first line states says how', () => {
  const generated = generatedTexts({ steps: [turn] });
  const image = png(4, 3, () => 1);
  const lines = messagesTranscript(body([
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'fx1.abc', extra: 1 },
      { type: 'redacted_thinking', data: 'abcd', extra: 2 },
      { type: 'text', text: 'hello', citations: [{ ref: 'img_k7x3q2_7' }] },
      { type: 'tool_use', id: 'toolu_1', name: 'time--now', input: {}, caller: { type: 'direct' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: [
        { type: 'text', text: 'ok', cache_control: { type: 'ephemeral' }, extra: 3 },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image, extra: 4 }, extra: 5 },
      ] },
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'failed' },
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'fine' },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'bare' },
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: 'no', content: 'odd' },
    ] },
  ]), generated);
  assert.equal(lines[0], RESULT_FORM);
  assert.equal(RESULT_FORM, 'Results below went with their content as a string and is_error: false, unless a line says otherwise.');
  assert.deepEqual(lines.slice(-17), [
    '#0 assistant',
    '  thinking signed {"extra":1}: plan',
    '  redacted_thinking {"extra":2}: 4 chars',
    '  text {"citations":[{"ref":"img_N1_7"}]}: hello',
    '  tool_use toolu_1 time--now {"caller":{"type":"direct"}}: {}',
    '#1 user',
    '  tool_result toolu_1 (content as blocks)',
    '    text [cache 5m] {"extra":3}: ok',
    `    image {"extra":5,"source":{"extra":4}}: image/png 4×3, ${Buffer.from(image, 'base64').length} bytes`,
    '  tool_result toolu_1 (error)',
    '    text: failed',
    '  tool_result toolu_1',
    '    text: fine',
    '  tool_result toolu_1 (no is_error)',
    '    text: bare',
    '  tool_result toolu_1 {"is_error":"no"}',
    '    text: odd',
  ]);
  assert.match(messagesTranscript(body([user('hello')]), generated)[0], /^system: /, 'a request with no result has no form line');
});

test('X15: a request on the Responses API, on either backend, reads through its codec\'s view: its input items as the conversation by side, its tools by name with their schema, and no is_error form, which that API doesn\'t have', () => {
  const generated = generatedTexts({ steps: [turn] });
  const wire = {
    model: 'gpt-6.1-sol', instructions: 'You are the fixture agent.', stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'rx1.abc' },
      { type: 'function_call', call_id: 'call_1', name: 'time--now', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'noon' },
    ],
    tools: [{ type: 'function', name: 'time--now', description: 'Returns the time.', parameters: { type: 'object', properties: {} }, strict: false }],
  };
  for (const api of ['responses', 'codex']) {
    const read = decoded(api, wire);
    assert.deepEqual(transcriptOf(read.view!, generated, new Set(), { api }), [
      'system: You are the fixture agent.',
      'tool time--now:',
      '    | description: Returns the time.',
      '    | input_schema: {"type":"object","properties":{}}',
      '#0 user',
      '  text: hello',
      '#1 assistant',
      '  redacted_thinking: 7 chars',
      '  tool_use call_1 time--now: {}',
      '#2 user',
      '  tool_result call_1',
      '    text: noon',
    ], api);
  }
});

test('X15b: a request on the Chat Completions API, in any dialect, reads through its codec\'s view: its system message as the system prompt, its messages by side with a tool message as a result, its tools by name with their schema, and no is_error form, which that API doesn\'t have', () => {
  const generated = generatedTexts({ steps: [turn] });
  const wire = {
    model: 'gpt-5.6-sol', stream: true, max_completion_tokens: 2048,
    messages: [
      { role: 'system', content: 'You are the fixture agent.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'time--now', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'noon' },
    ],
    tools: [{ type: 'function', function: { name: 'time--now', description: 'Returns the time.', parameters: { type: 'object', properties: {} } } }],
  };
  const read = decoded('chat-completions', wire);
  assert.deepEqual(transcriptOf(read.view!, generated, new Set(), { api: 'chat-completions' }), [
    'system: You are the fixture agent.',
    'tool time--now:',
    '    | description: Returns the time.',
    '    | input_schema: {"type":"object","properties":{}}',
    '#0 user',
    '  text: hello',
    '#1 assistant',
    '  tool_use call_1 time--now: {}',
    '#2 user',
    '  tool_result call_1',
    '    text: noon',
  ]);
  assert.equal(decoded('chat-completions', { model: 'gpt-5.6-sol', n: 2, messages: [{ role: 'user', content: 'hi' }] }).view!.messages.length, 1, 'a request the stand-in refuses, here for asking two choices, is still read');
});

test('X16: a changed request\'s body is read by the API it\'s decoded as, even one the stand-in refused, and a body its codec can\'t read, or an API no codec writes, says why', () => {
  const refused = { model: 'claude-opus-4-6', max_tokens: 2048, tool_choice: { type: 'auto' }, messages: [user('hello')] };
  assert.deepEqual(decoded('messages', refused).view!.messages, [user('hello')]);
  assert.equal(decoded('responses', { model: 'gpt-6.1-sol', input: [{ type: 'file_search_call' }] }).reason, 'it carries an input item of type "file_search_call", which the stand-in doesn\'t model');
  assert.equal(decoded('carrier-pigeon', {}).reason, 'no codec writes the API "carrier-pigeon"');
});

test('X14: a cache_control of null shows as one, apart from none, on a tool, a message, a block and a result\'s inner block, as the record and the digest tell them apart; a system block\'s is the record\'s to show', () => {
  const generated = generatedTexts({ steps: [turn] });
  const of = (cc: null | undefined) => {
    const marked = cc === undefined ? {} : { cache_control: cc };
    return messagesTranscript(body([
      { role: 'user', ...marked, content: [{ type: 'text', text: 'hello', ...marked }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'time--now', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: [{ type: 'text', text: 'ok', ...marked }] }] },
    ], { system: [{ type: 'text', text: 'You are the fixture agent.', ...marked }], tools: TOOLS.map((t) => ({ ...t, ...marked })) }), generated);
  };
  const none = of(undefined);
  const nulled = of(null);
  assert.deepEqual(nulled.filter((l) => !none.includes(l)), [
    nulled.find((l) => l.startsWith('tool time--now')),
    '#0 user [cache null]',
    '  text [cache null]: hello',
    '    text [cache null]: ok',
  ]);
  assert.ok(nulled.find((l) => l.startsWith('tool time--now'))!.startsWith('tool time--now [cache null]'));
  assert.equal(none.length, nulled.length);
});

test('X17: a block that isn\'t one shows as sent, named so, a tool result\'s inner block too, and a big integer as its digits', () => {
  const generated = generatedTexts({ steps: [turn] });
  const head = ['system: You are the fixture agent.'];
  const tool = ['tool time--now:', '    | description: Returns the time.', '    | input_schema: {"type":"object","properties":{}}'];
  const blocks = [null, 'x', 7, [1], { type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: [null, { type: 'text', text: 'ok' }] }];
  assert.deepEqual(messagesTranscript(body([{ role: 'user', content: blocks as never }]), generated), [
    RESULT_FORM, ...head, ...tool, '#0 user',
    '  (not a block): null', '  (not a block): "x"', '  (not a block): 7', '  (not a block): [1]', '  text: hello',
    '  tool_result toolu_1 (content as blocks)', '    (not a block): null', '    text: ok',
  ]);
  const big = JSON.rawJSON('12345678901234567890');
  assert.deepEqual(messagesTranscript(body([{ role: 'user', content: [big, { type: 'text', text: 'hello' }] as never }]), generated), [
    ...head, ...tool, '#0 user', '  (not a block): 12345678901234567890', '  text: hello',
  ]);
});

test('X17d: a block\'s field the API requires, holding another kind, shows as sent beside the block\'s type, and an absent one doesn\'t show, not as an empty field', () => {
  const generated = generatedTexts({ steps: [turn] });
  const lines = messagesTranscript(body([
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 5, signature: 'fx1.abc' },
      { type: 'thinking', thinking: 'plan', signature: null },
      { type: 'redacted_thinking', data: 5 },
      { type: 'text', text: null },
      { type: 'tool_use', id: 5, name: 7, input: {} },
      { type: 'text' },
      { type: 'tool_use', id: 'toolu_1', name: 'time--now' },
      { type: 'redacted_thinking' },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 5, is_error: false, content: [{ type: 'text', text: 5 }] },
    ] },
  ] as never), generated);
  assert.deepEqual(lines.slice(-12), [
    '#0 assistant',
    '  thinking signed {"thinking":5}',
    '  thinking unsigned {"signature":null}: plan',
    '  redacted_thinking {"data":5}',
    '  text {"text":null}',
    '  tool_use {"id":5,"name":7}: {}',
    '  text',
    '  tool_use toolu_1 time--now',
    '  redacted_thinking',
    '#1 user',
    '  tool_result (content as blocks) {"tool_use_id":5}',
    '    text {"text":5}',
  ]);
});

test('X17b: a Messages body the codec reads keeps its tools in the view as sent, and the codec\'s gate turns away a tools value that isn\'t a list of objects', () => {
  const codec = anthropic({ configuration: { windowTokens: 1_000_000 }, clock: () => 0 });
  const of = (tools: unknown) => ({ model: 'claude-opus-4-6', max_tokens: 2048, messages: [user('hello')], ...(tools === undefined ? {} : { tools }) }) as MessagesBody;
  for (const tools of [undefined, null, [], TOOLS]) {
    const read = codec.read(of(tools));
    assert.ok(read.view, `the codec reads tools ${JSON.stringify(tools)}`);
    assert.deepEqual(read.view.tools, tools ?? [], JSON.stringify(tools));
  }
  for (const tools of [undefined, null, [], TOOLS]) assert.equal(codec.admit(of(tools)).reason, undefined, JSON.stringify(tools));
  for (const tools of [false, 0, '', {}, [null]]) assert.match(codec.admit(of(tools)).reason ?? '', /^a Messages request's `tools` is .*, and the stand-in reads it as a list of objects$/, JSON.stringify(tools));
});

test('X17c: a Responses body the codec reads keeps the tools it had in its view, and the codec\'s gate turns away a tools value that isn\'t a list of objects', () => {
  const codec = responses({ configuration: { windowTokens: 1_000_000 }, clock: () => 0 });
  const fn = { type: 'function', name: 'time--now', description: 'Returns the time.', parameters: { type: 'object', properties: {} }, strict: false };
  const of = (tools: unknown) => ({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], ...(tools === undefined ? {} : { tools }) }) as never;
  for (const [tools, view] of [[undefined, []], [null, []], [[], []], [[fn], [{ name: 'time--now', description: 'Returns the time.', input_schema: { type: 'object', properties: {} } }]]] as const) {
    const read = codec.read(of(tools));
    assert.ok(read.view, `the codec reads tools ${JSON.stringify(tools)}`);
    assert.deepEqual(read.view.tools, view, JSON.stringify(tools));
  }
  for (const tools of [undefined, null, [], [fn]]) assert.equal(codec.admit(of(tools)).reason, undefined, JSON.stringify(tools));
  for (const tools of [false, 0, '', {}, 5]) {
    const reason = `a Responses request's \`tools\` is ${typeof tools === 'boolean' ? 'a boolean' : typeof tools === 'number' ? 'a number' : typeof tools === 'string' ? 'a string' : 'an object'}, and the stand-in reads it as a list of objects`;
    assert.equal(codec.admit(of(tools)).reason, reason);
    assert.equal(decoded('responses', of(tools)).reason, reason);
  }
});
