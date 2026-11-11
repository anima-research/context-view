// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CHAT, agentBody, post, startStandin, step, summariserBody, textOf } from '../testing/standin.ts';
import { carriedBy, heldBy } from './trace.ts';
import { chat } from './chat.ts';

async function traced(fn) {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const held = [];
  s.onHeld((h) => held.push(h));
  const heldId = async (n = 1) => {
    for (const until = performance.now() + 5000; held.length < n;) {
      if (performance.now() > until) assert.fail(`onHeld named ${held.length} of ${n} held calls within 5 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return held[n - 1].id;
  };
  await fn(s, heldId);
  return s.close();
}

const untracedOf = (records) => records.map((r, i) => [i, r.kind, r.untraced?.map(({ token, givenBy }) => ({ token, givenBy: givenBy.map((id) => records.findIndex((x) => x.id === id)) })) ?? null]);

async function callIds(stepped, canary) {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(stepped);
  const ids = (await post(s.url, agentBody({ canary }))).json.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  await s.close();
  return ids;
}

test('a request that carries a canary an answer gives, and arrived before that answer began to be sent, names the canary and the request whose answer gives it; one that arrived after is traced', async () => {
  const records = await traced(async (s, heldId) => {
    s.setStep(step('a', [{ text: '[[c:a.r1]] noted.', settle: true }]));
    const answer = post(s.url, agentBody({ canary: '[[c:a.in]]' }));
    const id = await heldId();
    assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:a.in]]', '[[c:a.r1]]'] }))).status, 200);
    assert.equal(s.releaseHeld(id), true);
    assert.equal((await answer).status, 200);
    assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:a.in]]', '[[c:a.r1]]'], textChars: 300 }))).status, 200);
  });
  assert.deepEqual(untracedOf(records), [[0, 'agent', null], [1, 'summariser', [{ token: '[[c:a.r1]]', givenBy: [0] }]], [2, 'summariser', null]]);
});

test('an answer gives only what its own request didn\'t carry: a reply that repeats its request\'s canary gives nothing, so a request that carried that canary before the reply was sent is traced', async () => {
  const records = await traced(async (s, heldId) => {
    s.setStep(step('e', [{ text: '[[c:e.in]] you said so.', settle: true }]));
    const answer = post(s.url, agentBody({ canary: '[[c:e.in]]' }));
    const id = await heldId();
    assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:e.in]]'] }))).status, 200);
    s.releaseHeld(id);
    assert.equal((await answer).status, 200);
  });
  assert.deepEqual(untracedOf(records), [[0, 'agent', null], [1, 'summariser', null]]);
});

test('carrying is read from a request\'s whole body, and giving from an answer\'s whole content: a call\'s id and the canary in its input, carried only as a tool result\'s id and inside a tool call\'s input, before the answer that makes the call was sent, are both named', async () => {
  const calling = step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }], settle: true }]);
  const [call] = await callIds({ ...calling, replies: calling.replies.map(({ settle, ...r }) => r) }, '[[c:t.in]]');
  const records = await traced(async (s, heldId) => {
    s.setStep(calling);
    const answer = post(s.url, agentBody({ canary: '[[c:t.in]]' }));
    const id = await heldId();
    const early = {
      model: 'claude-opus-4-6', max_tokens: 16000, stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: call, name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'done' }, { type: 'text', text: `Context Manager: ${CHAT}` }] },
      ],
    };
    assert.equal((await post(s.url, early)).status, 200);
    s.releaseHeld(id);
    const sent = await answer;
    assert.deepEqual(sent.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), [call], 'the call goes with the id the early request carried');
  });
  assert.deepEqual(untracedOf(records), [[0, 'agent', null], [1, 'summariser', [{ token: '[[c:t.call1]]', givenBy: [0] }, { token: call, givenBy: [0] }]]]);
});

test('an answer gives its calls\' ids whatever their form: a call whose id the script names, carried as a tool result\'s id before the answer that makes the call was sent, is named', async () => {
  const records = await traced(async (s, heldId) => {
    s.setStep(step('n', [{ text: '[[c:n.r1]] calling', calls: [{ id: 't7_named_1', name: 'fixture--result', input: { size: 300, kind: 'prose' } }], settle: true }]));
    const answer = post(s.url, agentBody({ canary: '[[c:n.in]]' }));
    const id = await heldId();
    const early = summariserBody({ canaries: ['[[c:n.in]]'] });
    early.messages.at(-1).content.unshift({ type: 'tool_result', tool_use_id: 't7_named_1', content: 'done' });
    assert.equal((await post(s.url, early)).status, 200);
    s.releaseHeld(id);
    assert.deepEqual((await answer).json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['t7_named_1']);
  });
  assert.deepEqual(untracedOf(records), [[0, 'agent', null], [1, 'summariser', [{ token: 't7_named_1', givenBy: [0] }]]]);
});

test('a token the run\'s checkpoint gave makes no edge in the run, though an answer in the run gives it again: a request carrying it from the copied store before that answer is traced, and the checkpoint\'s seed lists what its answers gave', async () => {
  const replies = [{ text: '[[c:k.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose' } }] }];
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('k', replies));
  assert.equal((await post(cp.url, agentBody({ canary: '[[c:k.in]]' }))).status, 200);
  await cp.close();
  const seed = cp.seed();
  const [call] = await callIds(step('k', replies), '[[c:k.in]]');
  assert.deepEqual(seed.given, ['[[c:k.r1]]', call]);
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  const held = [];
  s.onHeld((h) => held.push(h));
  s.setStep(step('k', [{ ...replies[0], settle: true }]));
  const answer = post(s.url, agentBody({ canary: '[[c:k.in]]' }));
  for (const until = performance.now() + 5000; !held.length;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  const fromStore = summariserBody({ canaries: ['[[c:k.in]]', '[[c:k.r1]]'] });
  fromStore.messages.at(-1).content.unshift({ type: 'tool_result', tool_use_id: call, content: 'done' });
  assert.equal((await post(s.url, fromStore)).status, 200);
  s.releaseHeld(held[0].id);
  assert.match(textOf((await answer).json), /^\[\[c:k\.r1\]\]/, 'the run\'s answer gives the canary again');
  assert.deepEqual(untracedOf(await s.close()), [[0, 'agent', null], [1, 'summariser', null]]);
  assert.deepEqual(s.reissued(), [{ request: 'k.primary.1', ids: [call] }], 'and gives the call\'s id again, which its checkpoint\'s build gave: a tool id the run can\'t tell from the store\'s');
  assert.deepEqual(cp.reissued(), [], 'a stand-in with no seed reissues nothing');
});

test('a request carries every token in any of its strings, in text, in a tool\'s JSON arguments as the Responses and Chat Completions APIs send them, a summary\'s mark, and a tool id of the stand-in\'s form quoted in a text; and each of its strings that could be an id whole, with no whitespace and up to 128 characters', () => {
  const long = `t${'x'.repeat(128)}`;
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:r.in]] recalling [[s:Mfa57cd24]], quoting t51116_9 and toolu_fx0123456789abcdef' }] },
      { type: 'function_call', call_id: 'toolu_fxfedcba9876543210', name: 'note', arguments: JSON.stringify({ text: 'quote [[c:r.call1]]' }) },
      { type: 'function_call_output', call_id: 't51116_1', output: long },
    ],
  };
  const carried = carriedBy(body);
  for (const t of ['[[c:r.in]]', '[[s:Mfa57cd24]]', '[[c:r.call1]]', 'toolu_fxfedcba9876543210', 'toolu_fx0123456789abcdef', 't51116_1']) assert.ok(carried.has(t), t);
  assert.ok(!carried.has(long), 'a string of 129 characters is no id');
  const astral = (n) => `t${'\u{1F600}'.repeat(n - 1)}`;
  assert.ok(carriedBy({ id: astral(128) }).has(astral(128)), '128 characters, though 255 UTF-16 code units');
  assert.ok(!carriedBy({ id: astral(129) }).has(astral(129)), '129 characters');
  assert.ok(!carried.has('t51116_9'), 'an id in another form, inside a longer text, isn\'t found');
});

const givenBy = async (replies, send, configuration = {}) => {
  const s = await startStandin({ configuration: { windowTokens: 50_000, ...configuration } });
  s.setStep(step('g', replies));
  try { await send(s); } finally { await s.close(); }
  return s.seed().given;
};

test('an answer gives what its API sends as text: a thinking block\'s tokens where the Messages API sends its text, and none where the Responses API sends the block sealed', async () => {
  const replies = [{ text: '[[c:g.r1]] done', thinking: '[[c:g.think]] musing' }];
  const messages = await givenBy(replies, async (s) => assert.equal((await post(s.url, agentBody({ canary: '[[c:g.in]]', extra: { thinking: { type: 'enabled', budget_tokens: 1024 } } }))).status, 200));
  assert.deepEqual(messages.filter((t) => t.startsWith('[[c:')).sort(), ['[[c:g.r1]]', '[[c:g.think]]']);
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:g.in]] hello' }] }];
  const sealed = await givenBy(replies, async (s) => assert.equal((await post(s.url, { model: 'gpt-6.1-sol', instructions: 'You are the fixture agent.', input, tools: [{ type: 'function', name: 'time--now', description: 'now', parameters: { type: 'object', properties: {} } }], stream: false, max_output_tokens: 2048 }, '/v1/responses')).status, 200), { thinks: true });
  assert.deepEqual(sealed.filter((t) => t.startsWith('[[c:')), ['[[c:g.r1]]']);
});

test('a Chat Completions answer gives a thinking block\'s tokens where its dialect sends the reasoning as text, as DeepSeek\'s and OpenRouter\'s do, and none where it sends none, as OpenAI\'s', () => {
  const content = [{ type: 'thinking', thinking: '[[c:g.think]] musing' }, { type: 'text', text: '[[c:g.r1]] done' }];
  const gives = (dialect) => [...heldBy(chat({ configuration: { windowTokens: 922_000 }, clock: () => 0, dialect }).shown(content))].filter((t) => t.startsWith('[[c:')).sort();
  assert.deepEqual(gives('deepseek'), ['[[c:g.r1]]', '[[c:g.think]]']);
  assert.deepEqual(gives('openrouter'), ['[[c:g.r1]]', '[[c:g.think]]']);
  assert.deepEqual(gives('openai'), ['[[c:g.r1]]']);
});

test('a token in a tool input\'s property name is read alike on both sides: the answer that calls with it gives it, and a later request that carries the call carries it; a property name that is no token is carried as nothing', () => {
  const call = { type: 'tool_use', id: 'toolu_fx0000000000000001', name: 'note', input: { '[[c:from-key]]': 1, plain: 2 } };
  assert.ok(heldBy([call]).has('[[c:from-key]]'));
  const carried = carriedBy({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }, { role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] }] });
  assert.ok(carried.has('[[c:from-key]]'), 'carried, as given');
  assert.ok(carried.has(call.id));
  assert.deepEqual(['plain', 'messages', 'role', 'input'].filter((k) => carried.has(k)), [], 'a property name is read for tokens only');
});

test('an answer gives nothing where it never reached the host: a scripted error, a provider\'s refusal, and a held answer whose request was cut while it was held, and that was never released; a streamed answer gives as a whole one does', async () => {
  const sent = (body, status = 200) => async (s) => { assert.equal((await post(s.url, body)).status, status); };
  assert.deepEqual(await givenBy([{ text: '[[c:g.r1]] no', error: { status: 529, message: 'overloaded' } }], sent(agentBody({ canary: '[[c:g.in]]', stream: false }), 529)), [], 'the scripted error was sent');
  assert.deepEqual(await givenBy([{ text: '[[c:g.r1]] no' }], sent(agentBody({ canary: '[[c:g.in]]', stream: false, max_tokens: 0 }), 400)), [], 'the provider refuses a request with no max_tokens');
  assert.deepEqual(await givenBy([{ text: '[[c:g.r1]] held', hold: true }], async (s) => {
    const held = [];
    s.onHeld((h) => held.push(h));
    const cut = new AbortController();
    const p = fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(agentBody({ canary: '[[c:g.in]]', stream: false })), signal: cut.signal }).catch(() => null);
    for (const until = performance.now() + 5000; held.length < 1;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    cut.abort();
    await p.catch(() => {});
  }), [], 'a held answer whose request was cut while it was held, and then never released');
  assert.deepEqual((await givenBy([{ text: '[[c:g.r1]] streamed' }], sent(agentBody({ canary: '[[c:g.in]]', stream: true })))), ['[[c:g.r1]]']);
});
