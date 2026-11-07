import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { BedrockAdapter } from '@animalabs/membrane';
import { startStandin as startServer, tokensSent } from '../lib/standin/standin.mjs';

const MODEL = 'us.anthropic.claude-opus-4-6-v1';
const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
const SYSTEM = 'You are the fixture agent.';
const KEY = 'AKIAFIXTUREFIXTURE00';

const started = new Set();
after(async () => { for (const s of started) await s.close(); });

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const marked = (text) => ({ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
const reply = (content) => ({ role: 'assistant', content });
const result = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withBedrock(configuration, fn) {
  const s = await startServer({ configuration: { windowTokens: 1_000_000, ...configuration } });
  started.add(s);
  const adapter = new BedrockAdapter({ accessKeyId: KEY, secretAccessKey: 'fixture-secret', region: 'us-west-2', baseURL: s.url });
  const ask = (messages, more = {}) => ({ model: MODEL, maxTokens: 2048, system: SYSTEM, messages, tools: TOOLS, ...more });
  const streamed = (request) => adapter.stream(request, { onChunk: () => {} });
  const failure = (p) => p.then(() => assert.fail('the call was answered'), (e) => e);
  // A request built by hand, for what membrane's adapter never sends.
  const post = (path, body) => fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let records = null;
  try {
    await fn({ s, adapter, ask, streamed, failure, post, close: async () => { records = await s.close(); return records; } });
  } finally { if (!records) await s.close(); }
}

// Reads AWS event-stream messages back, checking both CRCs of each.
function framesOf(buffer) {
  const out = [];
  for (let at = 0; at < buffer.length;) {
    const total = buffer.readUInt32BE(at);
    const headersLength = buffer.readUInt32BE(at + 4);
    const frame = buffer.subarray(at, at + total);
    assert.equal(frame.readUInt32BE(8), crc32(frame.subarray(0, 8)), 'the prelude\'s CRC');
    assert.equal(frame.readUInt32BE(total - 4), crc32(frame.subarray(0, total - 4)), 'the message\'s CRC');
    const headers = {};
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
  s.setStep({ ...step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'time--now', input: { zone: 'UTC' } }] }, { text: '[[c:b.r2]] done' }]), canaries: ['[[c:b.in]]', '[[c:b.call1]]'] });
  const opening = [user(`user: [[c:b.in]] ${prose(300)}`)];
  const first = await streamed(ask(opening));
  assert.deepEqual(first.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.match(first.content[0].signature, /^fx1\./, 'the thinking is signed');
  assert.deepEqual([first.content[2].name, first.content[2].input, first.stopReason], ['time--now', { zone: 'UTC' }, 'tool_use']);
  const second = await adapter.complete(ask([...opening, reply(first.content), result(first.content[2].id, `[[c:b.call1]] ${prose(200)}`)]));
  assert.deepEqual(second.content.map((b) => [b.type, b.text]), [['text', '[[c:b.r2]] done']]);
  const records = await close();
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
  assert.equal(frames[2].event.delta.text, '[[c:f.r1]] hello');
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
  const u = records.map((r) => r.usage);
  assert.ok(u[0].cache_creation_input_tokens >= 4096, JSON.stringify(u[0]));
  assert.equal(u[1].cache_read_input_tokens, u[0].cache_creation_input_tokens);
  assert.deepEqual([first.usage.cacheCreationTokens, second.usage.cacheReadTokens], [u[0].cache_creation_input_tokens, u[1].cache_read_input_tokens], 'as membrane reads them');
  assert.ok(u[2].input_tokens > 1024 && u[2].input_tokens < 4096, `a prefix under the minimum (${u[2].input_tokens} tokens)`);
  assert.deepEqual([u[2].cache_creation_input_tokens, short.usage.cacheCreationTokens], [0, 0]);
  const sum = tokensSent(records);
  assert.equal(sum.input + sum.cacheRead + sum.cacheWrite, u.reduce((t, x) => t + x.input_tokens + x.cache_read_input_tokens + x.cache_creation_input_tokens, 0));
}));

test('Bedrock\'s front answers a refusal or an error as Bedrock\'s exception, by name in x-amzn-ErrorType: a prompt past the window as a ValidationException membrane reads as context length, a scripted overload, by the stand-in\'s own choice, as a ServiceUnavailableException membrane reads as a server error, a rate limit as a ThrottlingException', () => withBedrock({ windowTokens: 1000 }, async ({ s, adapter, ask, failure, close }) => {
  s.setStep(step('w', [
    { text: 'never' },
    { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } },
    { error: { status: 429, type: 'rate_limit_error', message: 'Too many tokens, please wait before trying again.' } },
  ]));
  const window = await failure(adapter.complete(ask([user(`user: [[c:w.in]] ${prose(8000)}`)])));
  const busy = await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')])));
  const limited = await failure(adapter.complete(ask([user('user: [[c:w.in]] hi')])));
  assert.deepEqual([window.type, window.httpStatus, window.providerErrorCode], ['context_length', 400, 'ValidationException']);
  assert.match(window.message, /Input is too long for requested model\./, 'in Bedrock\'s words, as membrane quotes them');
  assert.deepEqual([busy.type, busy.httpStatus, busy.retryable, busy.providerErrorCode], ['server', 503, true, 'ServiceUnavailableException'], 'not an overload, which membrane takes only from a 529');
  assert.deepEqual([limited.type, limited.httpStatus, limited.providerErrorCode], ['rate_limit', 429, 'ThrottlingException']);
  const [refused] = await close();
  assert.equal(refused.refused, 'window');
}));

test('Bedrock\'s front refuses what AWS documents Bedrock refusing: a top-level cache_control on a model without automatic caching, and a body without anthropic_version; and knows only the models it models, by the id in the path', () => withBedrock({}, async ({ s, post, close }) => {
  s.setStep(step('v', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:v.in]] hi' }] };
  const answers = [];
  for (const [path, b] of [
    [`/model/${MODEL}/invoke`, { ...body, cache_control: { type: 'ephemeral' } }],
    [`/model/${MODEL}/invoke`, { ...body, anthropic_version: undefined }],
    [`/model/${encodeURIComponent('us.anthropic.claude-opus-4-6-v1:0')}/invoke`, body],
    [`/model/${MODEL}/invoke`, { ...body, model: MODEL }],
    [`/model/${MODEL}/invoke`, { ...body, model: 'another-model' }],
    [`/model/${MODEL}/invoke-with-response-stream`, { ...body, stream: false }],
    ['/model/constructor/invoke', body],
    [`/model/${MODEL}/invoke`, body],
  ]) {
    const res = await post(path, b);
    answers.push([res.status, res.headers.get('x-amzn-errortype')]);
  }
  assert.deepEqual(answers, [[400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [400, 'ValidationException'], [200, null]]);
  const records = await close();
  assert.deepEqual(records.map((r) => [r.kind, r.refused ?? null]), [['agent', 'automatic-caching'], ['agent', 'version'], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['unclassified', null], ['agent', null]]);
  assert.match(records[6].reason, /no Bedrock model constructor/);
  // A body that names its own model or streaming is recorded as it came, with the path's model only where it names none.
  assert.deepEqual([records[4].head.model, records[4].stream], ['another-model', false]);
  assert.deepEqual([records[5].head.model, records[5].stream], [MODEL, false]);
  assert.match(records[2].reason, /no Bedrock model us\.anthropic\.claude-opus-4-6-v1:0/);
  assert.equal(records[2].head.model, 'us.anthropic.claude-opus-4-6-v1:0', 'the record names the model the path named');
}));
