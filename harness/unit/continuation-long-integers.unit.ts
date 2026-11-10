import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_AGENT } from '../lib/strategies/checks.ts';
import { TOOL, continuation } from '../lib/strategies/script.ts';
import { startStandin } from '../lib/standin/standin.ts';
import type { Step } from '../lib/standin/standin.ts';

type Standin = Awaited<ReturnType<typeof startStandin>>;
type Json = { [key: string]: Json } | Json[] | string | number | boolean | null;
type Wire = { name: string; xml?: boolean; post: (s: Standin) => Promise<Response>; input: (res: Response) => Promise<Record<string, Json>> };

const ID = '1234567890123456789';
const BEFORE = '-2345678901234567891';
// Each integer as a JSON number token with exactly its digits, as `keep` reads one.
const WANTED = { channel: { id: { number: ID }, before: { number: BEFORE } }, width: { number: ID }, height: { number: BEFORE } };

// JSON.parse with the source text of each number past the safe range kept, so a number token tells apart from a string
// of the same digits and from a rounded number.
const keepLong = (_key: string, value: unknown, context?: { source: string }) =>
  (typeof value === 'number' && !Number.isSafeInteger(value) && context ? { number: context.source } : value);
const keep = (text: string) => JSON.parse(text, keepLong) as Json;
const longOf = (input: Record<string, Json>) => ({ channel: input.channel, width: input.width, height: input.height });

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

// Messages streamed: the call's block opens with an empty input, as Anthropic's does, and its input comes as
// input_json_delta text.
function streamedInput(events: string[]) {
  let start: Json | undefined;
  let index = -1;
  let text = '';
  for (const raw of events) {
    const e = JSON.parse(raw);
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && start === undefined) {
      start = e.content_block;
      index = e.index;
      assert.equal(e.content_block.name, TOOL, 'setup: the block is the scripted call');
      assert.deepEqual(e.content_block.input, {}, 'the block opens with an empty input');
    }
    if (start !== undefined && e.type === 'content_block_delta' && e.index === index && e.delta?.type === 'input_json_delta') text += e.delta.partial_json;
  }
  assert.ok(start !== undefined, 'setup: a tool_use block streamed');
  return keep(text) as Record<string, Json>;
}
function bodyInput(body: Json) {
  const call = ((body as { content: Json[] }).content as Array<Record<string, Json>>).find((b) => b.type === 'tool_use');
  assert.ok(call, 'setup: the reply carries a call');
  assert.equal(call.name, TOOL, 'setup: the call is the scripted one');
  return call.input as Record<string, Json>;
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
function argumentsInput(args: Json) {
  assert.equal(typeof args, 'string', 'the arguments are a JSON string, as the service sends them');
  return keep(args as string) as Record<string, Json>;
}
function xmlInput(text: string) {
  const call = text.split('</invoke>').find((part) => part.includes(`<invoke name="${TOOL}">`) && part.includes(CALL));
  assert.ok(call, 'setup: the XML carries the tool round\'s first call');
  const param = (name: string) => {
    const m = call.match(new RegExp(`<parameter name="${name}">([\\s\\S]*?)</parameter>`));
    assert.ok(m, `the XML call has a ${name} parameter`);
    return keep(m[1]!);
  };
  return { channel: param('channel'), width: param('width'), height: param('height') } as Record<string, Json>;
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
      for (const raw of await sse(res)) for (const c of JSON.parse(raw).choices?.[0]?.delta?.tool_calls ?? []) if (c.index === 0 && typeof c.function?.arguments === 'string') args += c.function.arguments;
      return argumentsInput(args);
    } },
];
const responsesOf = (path: string): Wire[] => [
  { name: `Responses at ${path}`, post: (s) => post(s, path, { model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: `${CANARY} go` }] }], tools: RESPONSES_TOOLS }),
    input: async (res) => argumentsInput((await res.json()).output.find((i: { type: string }) => i.type === 'function_call').arguments) },
  { name: `Responses at ${path}, streamed`, post: (s) => post(s, path, { model: 'gpt-6.1-sol', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: `${CANARY} go` }] }], tools: RESPONSES_TOOLS }),
    input: async (res) => {
      const done = (await sse(res)).map((raw) => JSON.parse(raw)).find((e) => e.type === 'response.function_call_arguments.done');
      assert.ok(done, 'setup: the stream finishes a call\'s arguments');
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
