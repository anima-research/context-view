import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { BedrockAdapter } from '@animalabs/membrane';
import { startStandin as startServer, tokensSent } from './standin.ts';
import { servedModel } from './bedrock.ts';
import type { MembraneError, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import type { AgentStep } from './agent.ts';
import type { AnthropicUsage, Message } from './anthropic.ts';
import type { BedrockWritten } from './bedrock.ts';
import type { Configuration, RequestRecord, Step } from './standin.ts';
import type { Block } from './view.ts';

type Standin = Awaited<ReturnType<typeof startServer>>;
type Answered = ProviderResponse & { content: Block[] };
type BedrockRecord = RequestRecord & BedrockWritten;
type Frame = { headers: Record<string, string>; event: { type: string; delta?: { text?: string }; message?: { model?: string } } };
interface Tools {
  s: Standin;
  adapter: BedrockAdapter;
  ask: (messages: unknown[], more?: Partial<ProviderRequest>) => ProviderRequest;
  streamed: (request: ProviderRequest) => Promise<Answered>;
  failure: (p: Promise<unknown>) => Promise<MembraneError>;
  post: (path: string, body: unknown) => Promise<Response>;
  close: () => Promise<RequestRecord[]>;
}

const MODEL = 'us.anthropic.claude-opus-4-6-v1';
const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
const SYSTEM = 'You are the fixture agent.';
const KEY = 'AKIAFIXTUREFIXTURE00';

const started = new Set<Standin>();
after(async () => { for (const s of started) await s.close(); });

const prose = (n: number, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const marked = (text: string) => ({ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
const reply = (content: unknown) => ({ role: 'assistant', content });
const result = (id: string, text: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
const step = (id: string, replies: NonNullable<AgentStep['replies']>, more: Partial<Step> = {}): Step & { segment: string; kind: string } => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withBedrock(configuration: Partial<Configuration>, fn: (tools: Tools) => Promise<void>) {
  const s = await startServer({ configuration: { windowTokens: 1_000_000, ...configuration } });
  started.add(s);
  const adapter = new BedrockAdapter({ accessKeyId: KEY, secretAccessKey: 'fixture-secret', region: 'us-west-2', baseURL: s.url });
  const ask = (messages: unknown[], more: Partial<ProviderRequest> = {}): ProviderRequest => ({ model: MODEL, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
  const streamed = (request: ProviderRequest) => adapter.stream(request, { onChunk: () => {} }) as Promise<Answered>;
  const failure = (p: Promise<unknown>) => p.then(() => assert.fail('the call was answered'), (e: MembraneError) => e);
  const post = (path: string, body: unknown) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let records: RequestRecord[] | null = null;
  try {
    await fn({ s, adapter, ask, streamed, failure, post, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

function framesOf(buffer: Buffer) {
  const out: Frame[] = [];
  for (let at = 0; at < buffer.length;) {
    const total = buffer.readUInt32BE(at);
    const headersLength = buffer.readUInt32BE(at + 4);
    const frame = buffer.subarray(at, at + total);
    assert.equal(frame.readUInt32BE(8), crc32(frame.subarray(0, 8)), 'the prelude\'s CRC');
    assert.equal(frame.readUInt32BE(total - 4), crc32(frame.subarray(0, total - 4)), 'the message\'s CRC');
    const headers: Record<string, string> = {};
    for (let h = 12; h < 12 + headersLength;) {
      const n = frame.readUInt8(h); const name = frame.subarray(h + 1, h + 1 + n).toString('utf8'); h += 1 + n;
      assert.equal(frame.readUInt8(h), 7, 'a string header'); h += 1;
      const v = frame.readUInt16BE(h); headers[name] = frame.subarray(h + 2, h + 2 + v).toString('utf8'); h += 2 + v;
    }
    const payload = JSON.parse(frame.subarray(12 + headersLength, total - 4).toString('utf8'));
    out.push({ headers, event: JSON.parse(Buffer.from(payload.bytes, 'base64').toString('utf8')) });
    at += total;
  }
  return out;
}

test('Bedrock\'s front: membrane 0.8.0\'s Bedrock adapter, streamed and not, gets the text, the call and the signed thinking, and a later request carrying that thinking back is served', () => withBedrock({}, async ({ s, adapter, ask, streamed, close }) => {
  s.setStep({ ...step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { thinking: 'Once more.', text: '[[c:b.r2]] again', calls: [{ name: 'time--now', input: { zone: 'CET' } }] }]), canaries: ['[[c:b.in]]', '[[c:b.call1]]'] });
  const opening = [user(`user: [[c:b.in]] ${prose(300)}`)];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.match(first.content[0].signature!, /^fx1\./, 'the thinking is signed');
  assert.deepEqual([first.content[2].name, first.content[2].input, first.stopReason], ['time--now', { zone: 'UTC' }, 'tool_use']);
  const second = await adapter.complete(ask([...opening, reply(first.content), result(first.content[2].id!, `[[c:b.call1]] ${prose(200)}`)])) as Answered;
  assert.deepEqual(second.content.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'unstreamed, the same blocks');
  assert.match(second.content[0].signature!, /^fx1\./);
  assert.deepEqual([second.content[1].text, second.content[2].name, second.content[2].input, second.stopReason], ['[[c:b.r2]] again', 'time--now', { zone: 'CET' }, 'tool_use']);
  const records = await close() as BedrockRecord[];
  assert.deepEqual(records.map((r) => [r.kind, r.refused ?? null]), [['agent', null], ['agent', null]], 'the thinking sent back verifies');
  assert.deepEqual(records.map((r) => [r.head.api, r.head.dialect, r.head.model, r.stream, r.head.path]), [
    ['messages', 'bedrock', MODEL, true, `/model/${MODEL}/invoke-with-response-stream`],
    ['messages', 'bedrock', MODEL, false, `/model/${MODEL}/invoke`],
  ]);
  assert.deepEqual(records[0].head.headers, { beta: [], version: 'bedrock-2023-05-31' }, 'the version rides in the body');
  assert.equal(records[0].head.rest, null, 'and is kept out of the body\'s rest');
  assert.ok(!JSON.stringify(records).includes(KEY), 'AWS\'s signing isn\'t recorded');
}));

test('Bedrock\'s front streams AWS event-stream messages, each a chunk event whose CRCs hold and whose bytes are one of the Messages API\'s stream events', () => withBedrock({}, async ({ s, post, close }) => {
  s.setStep(step('f', [{ text: '[[c:f.r1]] hello' }]));
  const res = await post(`/model/${MODEL}/invoke-with-response-stream`, { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:f.in]] hi' }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.amazon.eventstream');
  const frames = framesOf(Buffer.from(await res.arrayBuffer()));
  assert.ok(frames.every((f) => f.headers[':event-type'] === 'chunk' && f.headers[':message-type'] === 'event'));
  assert.deepEqual(frames.map((f) => f.event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(frames[2].event.delta!.text, '[[c:f.r1]] hello');
  await close();
}));

test('a fleet child\'s /empty request on either Bedrock route is answered as the request path answers the same body: an event stream on invoke-with-response-stream and JSON on invoke, each naming the path\'s model', () => withBedrock({}, async ({ s, post, close }) => {
  s.setStep(step('e', []));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: hi' }] };
  const streamed = await post(`/empty/model/${MODEL}/invoke-with-response-stream`, body);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), 'application/vnd.amazon.eventstream');
  const frames = framesOf(Buffer.from(await streamed.arrayBuffer()));
  assert.equal(frames[0].event.type, 'message_start');
  assert.equal(frames[0].event.message?.model, MODEL);
  const plain = await post(`/empty/model/${MODEL}/invoke`, body);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'application/json');
  assert.equal((await plain.json() as { model?: string }).model, MODEL);
  await close();
}));

test('Bedrock\'s front prices a request by Anthropic\'s cache rule with the model card\'s 4,096-token minimum: a marked prefix past it is written and read back, as membrane reads them, and one short of it isn\'t written', () => withBedrock({}, async ({ s, adapter, ask, close }) => {
  s.setStep(step('k', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]));
  const long = marked(`user: [[c:k.in]] ${prose(20_000)}`);
  const first = await adapter.complete(ask([long]));
  s.setClock(60_000);
  const second = await adapter.complete(ask([long, reply(first.content), user('user: [[c:k.in]] and then')]));
  const short = await adapter.complete(ask([marked(`user: [[c:k.in]] ${prose(8_000, 7)}`)]));
  const records = await close();
  const u = records.map((r) => r.usage as AnthropicUsage);
  assert.ok(u[0].cache_creation_input_tokens >= 4096, JSON.stringify(u[0]));
  assert.equal(u[1].cache_read_input_tokens, u[0].cache_creation_input_tokens);
  assert.deepEqual([first.usage.cacheCreationTokens, second.usage.cacheReadTokens], [u[0].cache_creation_input_tokens, u[1].cache_read_input_tokens], 'as membrane reads them');
  assert.ok(u[2].input_tokens > 1024 && u[2].input_tokens < 4096, `a prefix under the minimum (${u[2].input_tokens} tokens)`);
  assert.deepEqual([u[2].cache_creation_input_tokens, short.usage.cacheCreationTokens], [0, 0]);
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, u.reduce((t, x) => t + x.input_tokens + x.cache_read_input_tokens + x.cache_creation_input_tokens, 0));
}));

test('Bedrock\'s front answers a refusal or an error as Bedrock\'s exception, by name in x-amzn-ErrorType: a prompt past the window as a ValidationException membrane reads as context length, a scripted overload, by the stand-in\'s own choice, as a ServiceUnavailableException membrane reads as a server error, a rate limit as a ThrottlingException, each other status the references give as its exception, and one they give none for as a 400 or a 500', () => withBedrock({ windowTokens: 1000 }, async ({ s, adapter, ask, failure, close }) => {
  s.setStep(step('w', [
    { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } },
    { error: { status: 429, type: 'rate_limit_error', message: 'Too many tokens, please wait before trying again.' } },
    { error: { status: 403, type: 'permission_error', message: 'denied' } },
    { error: { status: 404, type: 'not_found_error', message: 'missing' } },
    { error: { status: 424, type: 'api_error', message: 'the model failed' } },
    { error: { status: 401, type: 'authentication_error', message: 'unknown key' } },
    { error: { status: 502, type: 'api_error', message: 'bad gateway' } },
  ]));
  const window = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  const busy = await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')])));
  const limited = await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')])));
  assert.deepEqual([window.type, window.httpStatus, window.providerErrorCode], ['context_length', 400, 'ValidationException']);
  assert.match(window.message, /Input is too long for requested model\./, 'in Bedrock\'s words, as membrane quotes them');
  assert.deepEqual([busy.type, busy.httpStatus, busy.retryable, busy.providerErrorCode], ['server', 503, true, 'ServiceUnavailableException'], 'not an overload, which membrane takes only from a 529');
  assert.deepEqual([limited.type, limited.httpStatus, limited.providerErrorCode], ['rate_limit', 429, 'ThrottlingException']);
  const rest = [];
  for (let i = 0; i < 5; i++) rest.push(await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')]))));
  assert.deepEqual(rest.map((e) => [e.httpStatus, e.providerErrorCode]), [[403, 'AccessDeniedException'], [404, 'ResourceNotFoundException'], [424, 'ModelErrorException'], [400, 'ValidationException'], [500, 'InternalServerException']]);
  const [refused] = await close();
  assert.equal(refused.refused, 'window');
}));

test('Bedrock\'s front refuses what AWS documents Bedrock refusing: a top-level cache_control on a model without automatic caching, and a body without anthropic_version; and knows only the models it models, by the id in the path', () => withBedrock({}, async ({ s, post, close }) => {
  s.setStep(step('v', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:v.in]] hi' }] };
  const answers = [];
  for (const [path, b] of [
    [`/model/${MODEL}/invoke`, { ...body, cache_control: { type: 'ephemeral' } }],
    [`/model/${MODEL}/invoke`, { ...body, anthropic_version: undefined }],
    [`/model/${MODEL}/invoke`, { ...body, anthropic_version: 'bedrock-2099-01-01' }],
    [`/model/${encodeURIComponent('us.anthropic.claude-opus-4-6-v1:0')}/invoke`, body],
    [`/model/${MODEL}/invoke`, { ...body, model: MODEL }],
    [`/model/${MODEL}/invoke`, { ...body, model: 'another-model' }],
    [`/model/${MODEL}/invoke-with-response-stream`, { ...body, stream: false }],
    ['/model/constructor/invoke', body],
    [`/model/${MODEL}/invoke`, body],
  ] as Array<[string, unknown]>) {
    const res = await post(path, b);
    answers.push([res.status, res.headers.get('x-amzn-errortype')]);
  }
  assert.deepEqual(answers, [[400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [200, null]]);
  const records = await close() as BedrockRecord[];
  assert.deepEqual(records.map((r) => [r.kind, r.refused ?? null]), [['agent', 'automatic-caching'], ['agent', 'version'], ['agent', 'version'], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['agent', null]]);
  assert.match(records[7].reason!, /no Bedrock model constructor/);
  assert.deepEqual([records[5].head.model, records[5].stream], ['another-model', false]);
  assert.deepEqual([records[6].head.model, records[6].stream], [MODEL, false]);
  assert.match(records[3].reason!, /no Bedrock model us\.anthropic\.claude-opus-4-6-v1:0/);
  assert.equal(records[3].head.model, 'us.anthropic.claude-opus-4-6-v1:0', 'the record names the model the path named');
}));

test('Bedrock\'s front refuses as unclassified a body carrying an effort, since the stand-in knows the default effort only of the Anthropic API\'s model ids, and one carrying any other output_config field, naming each', () => withBedrock({}, async ({ s, post, close }) => {
  s.setStep(step('e', [{ text: 'a' }]));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:e.in]] hi' }] };
  for (const output_config of [{ effort: 'high' }, { format: { type: 'json_schema', schema: {} } }]) assert.equal((await post(`/model/${MODEL}/invoke`, { ...body, output_config })).status, 400);
  const records = await close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified']);
  assert.equal(records[0].reason, `it carries \`output_config.effort\`, and the stand-in knows no default effort for the model ${MODEL}`);
  assert.match(records[1].reason!, /`output_config\.format`/);
}));

test('Bedrock\'s front takes the rules of the Messages API model its id serves, Claude Opus 4.6: a thinking type that model rejects is refused in the troubleshooting page\'s words, and its manual thinking doesn\'t interleave after tool results', () => withBedrock({ thinks: true }, async ({ s, post, close }) => {
  s.setStep({ ...step('b', [{ text: 'start', calls: [{ name: 'time--now', input: {} }] }, { text: 'after' }, { text: 'spare' }]), namedAnywhere: true });
  const enabled = { type: 'enabled', budget_tokens: 2048 };
  const body = (messages: unknown[], thinking: unknown) => ({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, messages, thinking });
  const go = user('user: [[c:b.in]] go');
  const start = await (await post(`/model/${MODEL}/invoke`, body([go], enabled))).json() as Message;
  assert.deepEqual(start.content.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'a turn\'s start thinks');
  const call = start.content.find((b) => b.type === 'tool_use');
  const after = await (await post(`/model/${MODEL}/invoke`, body([go, reply(start.content), result(call!.id!, 'now')], enabled))).json() as Message;
  assert.deepEqual(after.content.map((b) => b.type), ['text'], 'after results alone, no thinking');
  const between = await post(`/model/${MODEL}/invoke`, body([go], { type: 'between_tools' }));
  assert.deepEqual([between.status, between.headers.get('x-amzn-errortype'), (await between.json()).message], [400, 'ValidationException', '"thinking.type.between_tools" is not supported for this model.']);
  const records = await close();
  assert.deepEqual(records.map((r) => r.refused ?? null), [null, null, 'thinking-mode']);
}));

test('Bedrock\'s model id resolves to the Messages API model it serves, the one resolution its codec and check 15 share; an id it doesn\'t know stays as it is', () => {
  assert.equal(servedModel(MODEL), 'claude-opus-4-6');
  assert.equal(servedModel('claude-opus-5-5'), 'claude-opus-5-5');
});

test('membrane\'s Bedrock adapter reads a scripted refusal\'s category from Bedrock\'s front, in a body and a stream, and none from an unnamed refusal or an answer', () => withBedrock({}, async ({ s, adapter, ask, streamed, close }) => {
  s.setStep(step('c', [
    { stop: 'refusal', category: 'reasoning_extraction' },
    { stop: 'refusal', category: 'reasoning_extraction' },
    { stop: 'refusal' },
    { text: '[[c:c.r4]] fine' },
  ]));
  const opening = [user('user: [[c:c.in]] hi')];
  const body = await adapter.complete(ask(opening)) as Answered;
  assert.deepEqual([body.stopReason, body.refusalCategory], ['refusal', 'reasoning_extraction']);
  const stream = await streamed(ask(opening));
  assert.deepEqual([stream.stopReason, stream.refusalCategory], ['refusal', 'reasoning_extraction']);
  const unnamed = await adapter.complete(ask(opening)) as Answered;
  assert.deepEqual([unnamed.stopReason, unnamed.refusalCategory, (unnamed.raw as Message).stop_details], ['refusal', undefined, { type: 'refusal', category: null, explanation: null }]);
  const answered = await adapter.complete(ask(opening)) as Answered;
  assert.deepEqual([answered.stopReason, (answered.raw as Message).stop_details], ['end_turn', null]);
  await close();
}));
