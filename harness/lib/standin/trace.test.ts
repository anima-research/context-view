// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CHAT, agentBody, post, startStandin, step, summariserBody, textOf } from '../testing/standin.ts';
import { carriedBy } from './trace.ts';

// A stand-in's records once it closes, after `fn` has driven it; `heldId(n)` waits for its nth held call.
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

const untracedOf = (records) => records.map((r) => [r.id, r.kind, r.untraced ?? null]);

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
  assert.deepEqual(untracedOf(records), [['r1', 'agent', null], ['r2', 'summariser', [{ token: '[[c:a.r1]]', givenBy: ['r1'] }]], ['r3', 'summariser', null]]);
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
  assert.deepEqual(untracedOf(records), [['r1', 'agent', null], ['r2', 'summariser', null]]);
});

test('carrying is read from a request\'s whole body, and giving from an answer\'s whole content: a call\'s id and the canary in its input, carried only as a tool result\'s id and inside a tool call\'s input, before the answer that makes the call was sent, are both named', async () => {
  const records = await traced(async (s, heldId) => {
    s.setStep({ ...step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }], settle: true }]) });
    const answer = post(s.url, agentBody({ canary: '[[c:t.in]]' }));
    const id = await heldId();
    const early = {
      model: 'claude-opus-4-6', max_tokens: 16000, stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fx000001', name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: 'done' }, { type: 'text', text: `Context Manager: ${CHAT}` }] },
      ],
    };
    assert.equal((await post(s.url, early)).status, 200);
    s.releaseHeld(id);
    const sent = await answer;
    assert.deepEqual(sent.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_fx000001'], 'the call goes with the id the early request carried');
  });
  assert.deepEqual(untracedOf(records), [['r1', 'agent', null], ['r2', 'summariser', [{ token: '[[c:t.call1]]', givenBy: ['r1'] }, { token: 'toolu_fx000001', givenBy: ['r1'] }]]]);
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
  assert.deepEqual(untracedOf(records), [['r1', 'agent', null], ['r2', 'summariser', [{ token: 't7_named_1', givenBy: ['r1'] }]]]);
});

test('a token the run\'s checkpoint gave makes no edge in the run, though an answer in the run gives it again: a request carrying it from the copied store before that answer is traced, and the checkpoint\'s seed lists what its answers gave', async () => {
  const replies = [{ text: '[[c:k.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose' } }] }];
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('k', replies));
  assert.equal((await post(cp.url, agentBody({ canary: '[[c:k.in]]' }))).status, 200);
  await cp.close();
  const seed = cp.seed();
  assert.deepEqual(seed.given, ['[[c:k.r1]]', 'toolu_fx000001']);
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
  fromStore.messages.at(-1).content.unshift({ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: 'done' });
  assert.equal((await post(s.url, fromStore)).status, 200);
  s.releaseHeld(held[0].id);
  assert.match(textOf((await answer).json), /^\[\[c:k\.r1\]\]/, 'the run\'s answer gives the canary again');
  assert.deepEqual(untracedOf(await s.close()), [['r1', 'agent', null], ['r2', 'summariser', null]]);
});

test('a request carries every token in any of its strings, in text, in a tool\'s JSON arguments as the Responses and Chat Completions APIs send them, a summary\'s mark, and a tool id of the stand-in\'s form quoted in a text; and each of its strings that could be an id whole, with no whitespace and up to 128 characters', () => {
  const long = `t${'x'.repeat(128)}`;
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:r.in]] recalling [[s:Mfa57cd24]], quoting t51116_9 and toolu_fx000077' }] },
      { type: 'function_call', call_id: 'toolu_fx000042', name: 'note', arguments: JSON.stringify({ text: 'quote [[c:r.call1]]' }) },
      { type: 'function_call_output', call_id: 't51116_1', output: long },
    ],
  };
  const carried = carriedBy(body);
  for (const t of ['[[c:r.in]]', '[[s:Mfa57cd24]]', '[[c:r.call1]]', 'toolu_fx000042', 'toolu_fx000077', 't51116_1']) assert.ok(carried.has(t), t);
  assert.ok(!carried.has(long), 'a string of 129 characters is no id');
  assert.ok(!carried.has('t51116_9'), 'an id in another form, inside a longer text, isn\'t found');
});
