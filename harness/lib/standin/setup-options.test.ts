// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE } from './tokens.ts';
import { CHAT, MERGE, agentBody, arrivals, post, prose, startStandin, step, summariserBody, textOf } from '../testing/standin.ts';

test('under the setup option `refreshes`, a request with max_tokens 0 is a cache keepalive refresh: no content, stop max_tokens and no output tokens, usage from the cache model, which it refreshes; recorded as keepalive, taking none of the step\'s replies', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, refreshes: true });
  const { seen } = arrivals(s);
  s.setStep(step('k', [{ text: '[[c:k.r1]] first' }, { text: '[[c:k.r2]] second' }]));
  // A prefix over claude-opus-4-6's minimum of 4,096 tokens, so the first request writes it.
  const body = agentBody({ canary: '[[c:k.in]]', stream: false, tail: [{ type: 'text', text: prose(12_000, 5) }], extra: { cache_control: { type: 'ephemeral', ttl: '1h' } } });
  const first = await post(s.url, body);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const u = first.json.usage;
  const whole = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  assert.ok(u.cache_creation_input_tokens > 0, 'the first request writes its prefix');
  // membrane's keepalive replays the recorded request with max_tokens 0 and no stream (cache-keepalive.ts refresh).
  s.setClock(50 * 60_000);
  const { stream: _stream, ...unstreamed } = body;
  const refresh = await post(s.url, { ...unstreamed, max_tokens: 0 });
  assert.equal(refresh.status, 200, JSON.stringify(refresh.json));
  assert.deepEqual(refresh.json.content, []);
  assert.equal(refresh.json.stop_reason, 'max_tokens');
  assert.equal(refresh.json.usage.output_tokens, 0);
  assert.equal(refresh.json.usage.cache_read_input_tokens, whole);
  assert.equal(refresh.json.usage.cache_creation_input_tokens, 0);
  s.setClock(100 * 60_000);
  const second = await post(s.url, body);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(textOf(second.json), '[[c:k.r2]] second', 'the refresh took none of the step\'s replies');
  assert.equal(second.json.usage.cache_read_input_tokens, whole, 'read at 100 minutes, past the write\'s hour, since the refresh at 50 restarted it');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'keepalive', 'agent']);
  assert.deepEqual(seen.map((r) => r.kind), ['agent', 'keepalive', 'agent']);
  assert.equal(records[1].answer.shape, 'refresh');
});

test('the setup option `summaryTokens` sets a summary\'s length per level; a level it doesn\'t name, and every level without it, keep the instruction\'s target', async () => {
  const lengths = async (options) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...options });
    s.setStep(step('st', []));
    const out = [];
    for (const instruction of [CHAT, MERGE]) {
      const r = await post(s.url, summariserBody({ instruction }));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      out.push(textOf(r.json).length);
    }
    const records = await s.close();
    assert.deepEqual(records.map((r) => r.level), [1, 2]);
    return { out, targets: records.map((r) => r.target) };
  };
  const plain = await lengths({});
  assert.deepEqual(plain.out, plain.targets.map((t) => Math.floor(t * RATE.prose)), 'without the option, today\'s length: the instruction\'s target');
  const set = await lengths({ summaryTokens: { 1: 500 } });
  assert.deepEqual(set.targets, plain.targets);
  assert.equal(set.out[0], Math.floor(500 * RATE.prose), 'level 1 at the option\'s 500 tokens');
  assert.equal(set.out[1], plain.out[1], 'level 2, which the option doesn\'t name, as without it');
});

test('startStandin refuses a setup option it doesn\'t take, naming it, so a workload\'s `standin()` naming an option the stand-in renamed or dropped fails its drive rather than running without it', async () => {
  await assert.rejects(startStandin({ configuration: { windowTokens: 50_000 }, summaryLengths: { 1: 300 } }), /summaryLengths/);
  await assert.rejects(startStandin({ configuration: { windowTokens: 50_000 }, refuseMerges: true, refresh: true }), (e) => /\brefresh\b/.test(e.message) && !/refuseMerges/.test(e.message));
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir: null, runDir: null, refuseMerges: false, rejectMerges: false, refuseContent: false, summaryTokens: null, refreshes: false });
  await s.close();
});

test('under `refreshes`, a Bedrock Messages request with max_tokens 0 is a keepalive refresh too, and a Chat Completions request asking for no output is left to its codec, which refuses it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 1_000_000 }, refreshes: true });
  s.setStep(step('b'));
  const bedrock = await post(s.url, { anthropic_version: 'bedrock-2023-05-31', max_tokens: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:b.in]] hi' }] }] }, '/model/us.anthropic.claude-opus-4-6-v1/invoke');
  assert.equal(bedrock.status, 200, JSON.stringify(bedrock.json));
  assert.deepEqual(bedrock.json.content, []);
  assert.equal(bedrock.json.stop_reason, 'max_tokens');
  const chat = await post(s.url, { model: 'gpt-5.6-sol', max_tokens: 0, messages: [{ role: 'user', content: 'user: [[c:b.in]] hi' }] }, '/v1/chat/completions');
  assert.equal(chat.status, 400, JSON.stringify(chat.json));
  assert.equal(chat.json?.error?.message, 'stand-in: `max_tokens` must be an integer of at least 1', 'the Chat codec\'s own refusal of a request asking for no output');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind === 'keepalive'), [true, false], JSON.stringify(records.map((r) => [r.kind, r.head?.api])));
});

test('the refresh faults need `refreshes`, act only on a refresh to Anthropic\'s Messages front, and count what they did', async () => {
  await assert.rejects(startStandin({ configuration: { windowTokens: 50_000 }, overloadedRefreshes: 1 }), /overloadedRefreshes/);
  await assert.rejects(startStandin({ configuration: { windowTokens: 50_000 }, lateRefreshesMs: 100 }), /lateRefreshesMs/);
  const s = await startStandin({ configuration: { windowTokens: 1_000_000 }, refreshes: true, overloadedRefreshes: 1 });
  s.setStep(step('f'));
  const user = [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:f.in]] hi' }] }];
  const chat = await post(s.url, { model: 'gpt-5.6-sol', max_tokens: 0, messages: [{ role: 'user', content: 'user: [[c:f.in]] hi' }] }, '/v1/chat/completions');
  assert.equal(chat.status, 400, 'a Chat Completions request asking for no output is its codec\'s to refuse');
  const bedrock = await post(s.url, { anthropic_version: 'bedrock-2023-05-31', max_tokens: 0, messages: user }, '/model/us.anthropic.claude-opus-4-6-v1/invoke');
  assert.equal(bedrock.status, 200, 'a Bedrock refresh is answered');
  const overloaded = await post(s.url, { model: 'claude-opus-4-6', max_tokens: 0, messages: user });
  assert.equal(overloaded.status, 529);
  assert.equal(overloaded.json?.error?.type, 'overloaded_error');
  const again = await post(s.url, { model: 'claude-opus-4-6', max_tokens: 0, messages: user });
  assert.equal(again.status, 200, 'only the first refresh is overloaded');
  assert.deepEqual(s.faults(), { held: 0, overloaded: 1 });
  await s.close();
  const late = await startStandin({ configuration: { windowTokens: 1_000_000 }, refreshes: true, lateRefreshesMs: 200 });
  late.setStep(step('g'));
  const from = performance.now();
  assert.equal((await post(late.url, { model: 'claude-opus-4-6', max_tokens: 0, messages: user })).status, 200);
  assert.ok(performance.now() - from >= 200, 'the refresh is answered once its hold has passed');
  assert.deepEqual(late.faults(), { held: 1, overloaded: 0 });
  await late.close();
  const plain = await startStandin({ configuration: { windowTokens: 50_000 } });
  assert.equal(plain.faults(), null, 'a stand-in given no fault has none to count');
  await plain.close();
});

test('a refresh fault given is a fault: each is a positive whole number, or the stand-in refuses to start', async () => {
  for (const name of ['lateRefreshesMs', 'overloadedRefreshes']) {
    for (const value of [0, -1, 1.5, '2', null]) {
      await assert.rejects(startStandin({ configuration: { windowTokens: 50_000 }, refreshes: true, [name]: value }), new RegExp(`${name}. is a positive whole number`), `${name}: ${JSON.stringify(value)}`);
    }
  }
});

test('a refresh still held when the stand-in closes is never handled after it', { timeout: 5_000 }, async () => {
  const s = await startStandin({ configuration: { windowTokens: 1_000_000 }, refreshes: true, lateRefreshesMs: 300 });
  s.setStep(step('h'));
  const held = post(s.url, { model: 'claude-opus-4-6', max_tokens: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] hi' }] }] }).catch(() => null);
  while (s.faults()?.held !== 1) await new Promise((r) => setImmediate(r));
  const records = await s.close();
  await held;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(records.map((r) => r.kind), [], 'nothing is recorded for it, then or once its hold has passed');
});

