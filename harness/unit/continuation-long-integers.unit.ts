import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultOf } from '../lib/pool.ts';
import { answersIn, callText } from '../lib/record.ts';
import { sorted } from '../lib/standin/view.ts';
import { maskRunDir, runVaryingMasker, sameBodies } from '../lib/strategies/compare.ts';
import { namedReport } from '../lib/strategies/report.ts';
import { transcriptOf } from '../lib/strategies/transcript.ts';
import { OWN, frameOf } from '../lib/frames.ts';
import type { Generated } from '../lib/frames.ts';
import { FIXTURE_AGENT } from '../lib/strategies/checks.ts';
import { toolResult } from '../lib/strategies/results.ts';
import { TOOL, continuation } from '../lib/strategies/script.ts';
import { generatedTexts } from '../lib/strategies/transcript.ts';
import { decodeMessages } from '../lib/standin/anthropic.ts';
import { decodeChat } from '../lib/standin/chat.ts';
import { decodeResponses } from '../lib/standin/responses.ts';
import { startStandin } from '../lib/standin/standin.ts';
import { asWritten } from '../lib/strategies/control.ts';
import type { RequestRecord, Step } from '../lib/standin/standin.ts';

type Standin = Awaited<ReturnType<typeof startStandin>>;
type Input = Record<string, unknown>;
type Wire = { name: string; xml?: boolean; post: (s: Standin) => Promise<Response>; input: (res: Response) => Promise<Input> };

const ID = '1234567890123456789';
const BEFORE = '-2345678901234567891';

// A JSON number token's source text, as `keep` reads one past the safe range: a class, so no JSON value can pass for it.
class Token { source: string; constructor(source: string) { this.source = source; } }
const WANTED = { channel: { id: new Token(ID), before: new Token(BEFORE) }, width: new Token(ID), height: new Token(BEFORE) };
const keepLong = (_key: string, value: unknown, context?: { source: string }) =>
  (typeof value === 'number' && !Number.isSafeInteger(value) && context ? new Token(context.source) : value);
const keep = (text: string) => JSON.parse(text, keepLong) as unknown;
const longOf = (input: Input) => ({ channel: input.channel, width: input.width, height: input.height });

const CANARY = '[[c:c.tool.in]]';
const CALL = '[[c:c.tool.call1]]';
const toolRound = () => continuation().find((s: { id: string }) => s.id === 'c.tool') as Step;
const schema = { type: 'object', properties: { kind: { type: 'string' }, canary: { type: 'string' }, size: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } } };
const MESSAGES_TOOLS = [{ name: TOOL, description: 'result', input_schema: schema }];
const CHAT_TOOLS = [{ type: 'function', function: { name: TOOL, description: 'result', parameters: schema } }];
const RESPONSES_TOOLS = [{ type: 'function', name: TOOL, description: 'result', parameters: schema }];
const asked = [{ role: 'user', content: [{ type: 'text', text: `${CANARY} go` }] }];

const post = (s: Standin, path: string, body: unknown) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sse = async (res: Response) => (await res.text()).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => l.slice(6));

// Messages streamed: every tool block opens with an empty input, as Anthropic's do, and the first call's input comes as
// input_json_delta text.
function streamedInput(events: string[]) {
  let index = -1;
  let text = '';
  for (const raw of events) {
    const e = JSON.parse(raw);
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      assert.deepEqual(e.content_block.input, {}, `the tool block at ${e.index} opens with an empty input`);
      if (index === -1) {
        index = e.index;
        assert.equal(e.content_block.name, TOOL, 'setup: the block is the scripted call');
      }
    }
    if (index !== -1 && e.type === 'content_block_delta' && e.index === index && e.delta?.type === 'input_json_delta') text += e.delta.partial_json;
  }
  assert.ok(index !== -1, 'setup: a tool_use block streamed');
  return keep(text) as Input;
}
function bodyInput(body: unknown) {
  const call = ((body as { content: Input[] }).content).find((b) => b.type === 'tool_use');
  assert.ok(call, 'setup: the reply carries a call');
  assert.equal(call.name, TOOL, 'setup: the call is the scripted one');
  return call.input as Input;
}
// AWS event-stream frames, each a chunk whose payload's `bytes` is a Messages stream event in base64.
function bedrockEvents(buffer: Buffer) {
  const out: string[] = [];
  for (let at = 0; at < buffer.length;) {
    const total = buffer.readUInt32BE(at);
    const headers = buffer.readUInt32BE(at + 4);
    const payload = buffer.subarray(at + 12 + headers, at + total - 4).toString('utf8');
    out.push(Buffer.from(JSON.parse(payload).bytes, 'base64').toString('utf8'));
    at += total;
  }
  return out;
}
function argumentsInput(args: unknown) {
  assert.equal(typeof args, 'string', 'the arguments are a JSON string, as the service sends them');
  return keep(args as string) as Input;
}
function xmlInput(text: string) {
  const call = text.split('</invoke>').find((part) => part.includes(`<invoke name="${TOOL}">`) && part.includes(CALL));
  assert.ok(call, 'setup: the XML carries the tool round\'s first call');
  const param = (name: string) => {
    const m = call.match(new RegExp(`<parameter name="${name}">([\\s\\S]*?)</parameter>`));
    assert.ok(m, `the XML call has a ${name} parameter`);
    return keep(m[1]!);
  };
  return { channel: param('channel'), width: param('width'), height: param('height') };
}

const MESSAGES = (model: string, stream: boolean) => ({ model, max_tokens: 4096, messages: asked, tools: MESSAGES_TOOLS, ...(stream ? { stream } : {}) });
const BEDROCK = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, messages: asked, tools: MESSAGES_TOOLS };
const BEDROCK_PATH = '/model/us.anthropic.claude-opus-4-6-v1';
const chatOf = (path: string, model: string): Wire[] => [
  { name: `Chat Completions at ${path}`, post: (s) => post(s, path, { model, messages: [{ role: 'user', content: `${CANARY} go` }], tools: CHAT_TOOLS }),
    input: async (res) => argumentsInput((await res.json()).choices[0].message.tool_calls[0].function.arguments) },
  { name: `Chat Completions at ${path}, streamed`, post: (s) => post(s, path, { model, stream: true, messages: [{ role: 'user', content: `${CANARY} go` }], tools: CHAT_TOOLS }),
    input: async (res) => {
      let args = '';
      for (const raw of await sse(res)) {
        for (const c of JSON.parse(raw).choices?.[0]?.delta?.tool_calls ?? []) {
          if (c.function && 'arguments' in c.function) assert.equal(typeof c.function.arguments, 'string', `call ${c.index}'s arguments delta is a string`);
          if (c.index === 0 && typeof c.function?.arguments === 'string') args += c.function.arguments;
        }
      }
      return argumentsInput(args);
    } },
];
const responsesOf = (path: string): Wire[] => [
  { name: `Responses at ${path}`, post: (s) => post(s, path, { model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: `${CANARY} go` }] }], tools: RESPONSES_TOOLS }),
    input: async (res) => argumentsInput((await res.json()).output.find((i: { type: string }) => i.type === 'function_call').arguments) },
  { name: `Responses at ${path}, streamed`, post: (s) => post(s, path, { model: 'gpt-6.1-sol', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: `${CANARY} go` }] }], tools: RESPONSES_TOOLS }),
    input: async (res) => {
      const events = (await sse(res)).map((raw) => JSON.parse(raw));
      const done = events.find((e) => e.type === 'response.function_call_arguments.done');
      assert.ok(done, 'setup: the stream finishes a call\'s arguments');
      const deltas = events.filter((e) => e.type === 'response.function_call_arguments.delta');
      for (const d of deltas) assert.equal(typeof d.delta, 'string', 'every arguments delta is a string');
      assert.equal(deltas.filter((d) => d.item_id === done.item_id).map((d) => d.delta).join(''), done.arguments, 'the deltas join to the arguments done gives');
      return argumentsInput(done.arguments);
    } },
];

const WIRES: Wire[] = [
  { name: 'Anthropic Messages', post: (s) => post(s, '/v1/messages', MESSAGES('claude-opus-4-6', false)), input: async (res) => bodyInput(keep(await res.text())) },
  { name: 'Anthropic Messages, streamed', post: (s) => post(s, '/v1/messages', MESSAGES('claude-opus-4-6', true)), input: async (res) => streamedInput(await sse(res)) },
  { name: 'Bedrock', post: (s) => post(s, `${BEDROCK_PATH}/invoke`, BEDROCK), input: async (res) => bodyInput(keep(await res.text())) },
  { name: 'Bedrock, streamed', post: (s) => post(s, `${BEDROCK_PATH}/invoke-with-response-stream`, BEDROCK), input: async (res) => streamedInput(bedrockEvents(Buffer.from(await res.arrayBuffer()))) },
  ...chatOf('/v1/chat/completions', 'gpt-5.6-sol'),
  ...chatOf('/api/v1/chat/completions', 'anthropic/claude-opus-4.6'),
  ...responsesOf('/v1/responses'),
  { name: 'anthropic-xml\'s prefill', xml: true,
    post: (s) => post(s, '/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, stop_sequences: ['</function_calls>'], messages: [...asked, { role: 'assistant', content: [{ type: 'text', text: `${FIXTURE_AGENT}:` }] }] }),
    input: async (res) => xmlInput(((await res.json()).content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text).join('')) },
];

const started = new Set<Standin>();
after(async () => { for (const s of started) await s.close(); });

for (const wire of WIRES) {
  test(`the continuation's tool round writes a 19-digit integer and a negative one unquoted in its call: ${wire.name}`, async () => {
    const s = await startStandin({ configuration: { windowTokens: 1_000_000, ...(wire.xml ? { agent: { formatter: 'anthropic-xml' } } : {}) } });
    started.add(s);
    s.setStep(toolRound());
    const res = await wire.post(s);
    assert.equal(res.status, 200, `setup: the stand-in answered (${res.status})`);
    const input = await wire.input(res);
    if (!wire.xml) assert.equal(input.canary, CALL, 'setup: the call is the tool round\'s first');
    assert.deepEqual(longOf(input), WANTED);
  });
}

// The tool round's first call's input as a host could deliver it to the fixture: each long integer as the script holds
// it (raw), as its digit string, or as the number JSON.parse rounds it to.
const delivered = (form: 'raw' | 'digits' | 'rounded') => {
  const scripted = (toolRound() as unknown as { replies: Array<{ calls?: Array<{ input: Input }> }> }).replies[0]!.calls![0]!.input;
  const map = (v: unknown): unknown => (JSON.isRawJSON(v) ? (form === 'raw' ? v : form === 'digits' ? v.rawJSON : Number(v.rawJSON))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)])) : v);
  return map(scripted) as Input;
};
const callOf = (input: Input) => ({ type: 'tool_use', id: 'toolu_fx000001', name: TOOL, input });
const RECEIVED = {
  raw: `the long integers as received: channel.before ${BEFORE}, channel.id ${ID}, height ${BEFORE}, width ${ID}`,
  digits: `the long integers as received: channel.before "${BEFORE}", channel.id "${ID}", height "${BEFORE}", width "${ID}"`,
  rounded: 'the long integers as received: channel.before -2345678901234567700, channel.id 1234567890123456800, height -2345678901234567700, width 1234567890123456800',
};
const textsOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((b) => (b.type === 'text' ? b.text : `(${b.type})`));

test('the fixture\'s result for the tool round\'s call is the same prose whichever way a host carries its long integers, then says each as the tool received it', () => {
  const results = (['raw', 'digits', 'rounded'] as const).map((form) => textsOf(toolResult(delivered(form))));
  assert.equal(results[0]!.length, 2, 'the prose, then what the tool received');
  assert.ok(results[0]![0]!.startsWith(CALL), 'setup: the first block is the call\'s prose');
  assert.deepEqual(results.map((r) => r[0]), [results[0]![0], results[0]![0], results[0]![0]], 'one prose for every form');
  assert.deepEqual(results.map((r) => r[1]), [RECEIVED.raw, RECEIVED.digits, RECEIVED.rounded]);
  const plain = textsOf(toolResult({ kind: 'prose', size: 18_000, canary: CALL }));
  assert.equal(plain.length, 1, 'a call without a long integer gets no received block');
});

test('the record writer knows the tool round\'s prose as the fixture\'s own, from the script and the call as the parent reads them, whichever way the host delivered the long integers; what the tool received is wholly frame text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cv-long-'));
  try {
    writeFileSync(join(dir, 'r1.answer.json'), JSON.stringify([callOf(delivered('raw'))]));
    writeFileSync(join(dir, 'steps.json'), JSON.stringify({ value: continuation() }));
    const generated = (generatedTexts as (from: object) => Generated)({ steps: resultOf(join(dir, 'steps.json')).value, answers: answersIn(dir), callText });
    for (const form of ['raw', 'digits', 'rounded'] as const) {
      const frame = frameOf(textsOf(toolResult(delivered(form))) as string[], generated);
      assert.ok(frame !== null && !frame.split('\n').slice(1).join('\n').includes('\u27e8own text'), `${form}: none of what the tool received reads as own text: ${frame}`);
      assert.equal(frame, `${OWN}\n${RECEIVED[form]}`, form);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the stand-in reads a request body\'s integer past the safe range as written, so an exact long id, a rounded one and its digit string digest apart', async () => {
  const s = await startStandin({ configuration: { windowTokens: 1_000_000 } });
  started.add(s);
  const sent = [JSON.rawJSON(ID), JSON.rawJSON('1234567890123456800'), ID];
  for (const width of sent) {
    s.setStep(toolRound());
    const body = { model: 'claude-opus-4-6', max_tokens: 4096, tools: MESSAGES_TOOLS, messages: [
      ...asked,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fx000001', name: TOOL, input: { kind: 'prose', size: 18_000, canary: CALL, width } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: 'done' }, { type: 'text', text: `${CANARY} again` }] },
    ] };
    await (await post(s, '/v1/messages', body)).text();
  }
  const records = (await s.close()) as Array<RequestRecord & { messages: Array<{ digest: string }> }>;
  started.delete(s);
  const digests = records.map((r) => r.messages[1]!.digest);
  assert.equal(digests.length, 3, 'setup: three requests recorded');
  assert.equal(new Set(digests).size, 3, `the call's message digests apart: exact ${digests[0]}, rounded ${digests[1]}, digits ${digests[2]}`);
});

const ARGS = (width: string) => `{"kind":"prose","size":18000,"canary":"${CALL}","width":${width}}`;
const ECHOES: Array<{ name: string; decode: (body: never) => { view?: { messages: Array<{ content: unknown }> } }; body: (width: string) => unknown }> = [
  { name: 'Messages', decode: decodeMessages, body: (width) => ({ model: 'claude-opus-4-6', max_tokens: 4096, tools: MESSAGES_TOOLS, messages: [
    ...asked,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fx000001', name: TOOL, input: { kind: 'prose', size: 18_000, canary: CALL, width: JSON.rawJSON(width) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: 'done' }, { type: 'text', text: `${CANARY} again` }] },
  ] }) },
  { name: 'Chat Completions', decode: decodeChat, body: (width) => ({ model: 'gpt-5.6-sol', tools: CHAT_TOOLS, messages: [
    { role: 'user', content: `${CANARY} go` },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_fx000001', type: 'function', function: { name: TOOL, arguments: ARGS(width) } }] },
    { role: 'tool', tool_call_id: 'call_fx000001', content: 'done' },
    { role: 'user', content: `${CANARY} again` },
  ] }) },
  { name: 'Responses', decode: decodeResponses, body: (width) => ({ model: 'gpt-6.1-sol', tools: RESPONSES_TOOLS, input: [
    { role: 'user', content: [{ type: 'input_text', text: `${CANARY} go` }] },
    { type: 'function_call', call_id: 'call_fx000001', name: TOOL, arguments: ARGS(width) },
    { type: 'function_call_output', call_id: 'call_fx000001', output: 'done' },
    { role: 'user', content: [{ type: 'input_text', text: `${CANARY} again` }] },
  ] }) },
];

for (const wire of ECHOES) {
  test(`the stand-in decodes a long integer in a call's echo as written, exact, rounded or as its digit string: ${wire.name}`, () => {
    const widths = [ID, '1234567890123456800', `"${ID}"`];
    const decoded = widths.map((width) => {
      const view = wire.decode(JSON.parse(JSON.stringify(wire.body(width)), asWritten) as never).view;
      const call = (view?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b?.type === 'tool_use');
      assert.ok(call, `setup: the ${width} echo decodes to a call`);
      return JSON.stringify(call.input.width);
    });
    assert.deepEqual(decoded, widths);
  });
}

// The parent reads a host's and the script's long integers as written: what a child's result and the stand-in's answers
// hold, and every walk over them, keep an exact long integer exact.

test('a child\'s result and the stand-in\'s kept answers give an exact long integer as written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cv-long-'));
  try {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ value: { width: JSON.rawJSON(ID) } }));
    assert.equal(JSON.stringify(resultOf(join(dir, 'result.json'))), `{"value":{"width":${ID}}}`, 'the child\'s result');
    writeFileSync(join(dir, 'r1.answer.json'), JSON.stringify([callOf(delivered('raw'))]));
    assert.equal(JSON.stringify(answersIn(dir)[0][0].input.width), ID, 'the kept answer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every walk the record writer and the stand-in make over a body leaves an exact long integer as it is', () => {
  const body = { b: JSON.rawJSON(ID), a: [JSON.rawJSON(BEFORE)] };
  assert.equal(JSON.stringify(sorted(body)), `{"a":[${BEFORE}],"b":${ID}}`, 'the digest\'s sorted form');
  assert.equal(JSON.stringify(runVaryingMasker()(body)), `{"b":${ID},"a":[${BEFORE}]}`, 'the run-varying mask');
  assert.equal(JSON.stringify(maskRunDir(body as never, '/run/dir')), `{"b":${ID},"a":[${BEFORE}]}`, 'the run directory\'s mask');
  assert.equal(JSON.stringify(namedReport(body)), `{"b":${ID},"a":[${BEFORE}]}`, 'a report\'s epoch names');
  assert.equal(callText(callOf({ width: JSON.rawJSON(ID), kind: 'prose' })), `${TOOL} {"kind":"prose","width":${ID}}`, 'a call\'s text');
  const shown = transcriptOf({ messages: [{ role: 'assistant', content: [callOf({ width: JSON.rawJSON(ID) })] }] }, generatedTexts({}) as Generated).join('\n');
  assert.ok(shown.includes(`"width":${ID}`) && !shown.includes('rawJSON'), `a transcript gives it as written: ${shown}`);
});

test('the registry knows the tool round\'s call as the script wrote it, from the kept answers: an exact echo is the fixture\'s own, a rounded one or a digit-string one is frame text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cv-long-'));
  try {
    writeFileSync(join(dir, 'r1.answer.json'), JSON.stringify([callOf(delivered('raw'))]));
    const generated = (generatedTexts as (from: object) => Generated)({ answers: answersIn(dir), callText });
    assert.equal(frameOf([callText(callOf(delivered('raw')))], generated), null, 'an exact echo');
    const rounded = frameOf([callText(callOf(delivered('rounded')))], generated);
    assert.ok(rounded?.includes('1234567890123456800') && rounded.includes('-2345678901234567700'), `a rounded echo shows its rounding: ${rounded}`);
    const digits = frameOf([callText(callOf(delivered('digits')))], generated);
    assert.ok(digits?.includes(`"${ID}"`) && digits.includes(`"${BEFORE}"`), `a digit-string echo shows its strings: ${digits}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the self-check tells two drives\' kept bodies apart when they differ only in a long integer\'s form, and finds the same ones the same', () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-long-'));
  try {
    const kept = (name: string, width: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'r1.json'), `{"model":"claude-opus-4-6","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fx000001","name":"${TOOL}","input":{"width":${width}}}]}]}`);
      return dir;
    };
    const [exact, again, rounded] = [kept('exact', ID), kept('again', ID), kept('rounded', '1234567890123456800')];
    assert.equal(sameBodies(exact, again).outcome, 'same', 'setup: one body twice is the same');
    assert.equal(sameBodies(exact, rounded).outcome, 'differs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
