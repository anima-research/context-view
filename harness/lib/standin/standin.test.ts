// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, runOf } from '../workloads/workloads.ts';
import { ANSWER_BOUND_MS, TOOLS, agentBody, arrivals, post, prose, read, startStandin, step, textOf, withStandin } from '../testing/standin.ts';

test('T1/T3: an agent request carrying the step\'s canary gets the step\'s replies in order, streamed or not', () => withStandin({}, async (s) => {
  s.setStep(step('a', [{ text: '[[c:a.r1]] first' }, { text: '[[c:a.r2]] second' }]));
  const one = await post(s.url, agentBody({ canary: '[[c:a.in]]' }));
  assert.equal(one.status, 200);
  assert.equal(one.stream, true);
  assert.equal(textOf(one.json), '[[c:a.r1]] first');
  assert.equal(one.json.stop_reason, 'end_turn');
  const two = await post(s.url, agentBody({ canary: '[[c:a.in]]', stream: false }));
  assert.equal(two.stream, undefined);
  assert.equal(textOf(two.json), '[[c:a.r2]] second');
}));

test('T3: a reply\'s blocks come thinking, text, then calls, and a reply that calls stops for tool use', () => withStandin({}, async (s) => {
  const input = { size: 400, kind: 'prose', canary: '[[c:b.call1]]' };
  s.setStep(step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'fixture--result', input }] }]));
  for (const stream of [true]) {
    const r = await post(s.url, agentBody({ canary: '[[c:b.in]]', stream }));
    assert.deepEqual(r.json.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(r.starts, [[0, 'thinking'], [1, 'text'], [2, 'tool_use']], 'in that order on the wire, not only by index');
    assert.equal(r.json.content[0].thinking, 'I should look.');
    assert.equal(typeof r.json.content[0].signature, 'string');
    assert.equal(r.json.content[2].name, 'fixture--result');
    assert.deepEqual(r.json.content[2].input, input);
    assert.equal(typeof r.json.content[2].id, 'string');
    assert.equal(r.json.stop_reason, 'tool_use');
  }
}));

test('T1/T3: a tool round\'s second request is the step\'s when its last message carries the call\'s canary', () => withStandin({}, async (s) => {
  s.setStep({ ...step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] }, { text: '[[c:t.r2]] done' }]), canaries: ['[[c:t.in]]', '[[c:t.call1]]'] });
  const first = await post(s.url, agentBody({ canary: '[[c:t.in]]' }));
  const call = first.json.content.find((b) => b.type === 'tool_use');
  const second = {
    model: 'claude-opus-5-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
      { role: 'assistant', content: first.json.content },
      { role: 'user', content: [{ type: 'text', text: 'user: Clock: Wednesday 2031-01-01, 00:10 UTC' }, { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:t.call1]] ${prose(280)}` }] }] },
    ],
  };
  const r = await post(s.url, second);
  assert.equal(textOf(r.json), '[[c:t.r2]] done');
}));

test('T2: a request to tunnel through the stand-in, which a host under its HTTPS proxy sends for a request that would leave the machine, is refused and recorded as unclassified, naming where it would go', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('t'));
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(s.url).port, method: 'CONNECT', path: 'openrouter.ai:443' });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(seen.at(-1).reason, /tunnel to openrouter\.ai:443/, 'the arrival names where it would go, for the driver\'s failure');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:t.in]]' }))).status, 200, 'and the stand-in still answers what it serves');
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.id, r.kind, r.step]), [['r1', 'unclassified', 't'], ['r2', 'agent', 't']]);
}));

test('T42: a reply\'s calls may be worked out from the request it answers, and the reply stops for tool use only when that gives at least one', () => withStandin({}, async (s) => {
  const listed = (messages) => messages.at(-1).content.filter((b) => b.type === 'text').flatMap((b) => [...b.text.matchAll(/look:(\w+)/g)].map((m) => ({ name: 'toolsets--look', input: { tool: m[1] } })));
  s.setStep(step('k', [{ text: '[[c:k.r1]] looking', calls: listed }, { text: '[[c:k.r2]] looking', calls: listed }]));
  const two = await post(s.url, agentBody({ canary: '[[c:k.in]]', tail: [{ type: 'text', text: 'look:alpha look:beta' }] }));
  assert.deepEqual(two.json.content.filter((b) => b.type === 'tool_use').map((b) => b.input.tool), ['alpha', 'beta']);
  assert.equal(two.json.stop_reason, 'tool_use');
  const none = await post(s.url, agentBody({ canary: '[[c:k.in]]' }));
  assert.deepEqual(none.json.content.map((b) => b.type), ['text']);
  assert.equal(none.json.stop_reason, 'end_turn');
}));

test('T43: a step\'s spare replies answer a turn it doesn\'t expect, only after its own replies, and none is left past them', () => withStandin({}, async (s) => {
  s.setStep(step('m', [{ text: '[[c:m.r1]] expected' }], { spare: [{ text: '[[c:m.spare]] unexpected' }] }));
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).json), '[[c:m.r1]] expected');
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).json), '[[c:m.spare]] unexpected');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:m.in]]' }))).status, 400);
  s.setStep(step('q', [], { spare: [{ text: '[[c:q.spare]] unexpected' }] }));
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:q.in]]' }))).json), '[[c:q.spare]] unexpected');
}));

test('a step that declares a probe answers it once: a one-message request carrying no canary and none of the step\'s marks is the probe, while a one-message request carrying a canary, the step\'s or another\'s, or one of the step\'s marks is never claimed as it, and with no probe declared stays unclassified', () => withStandin({}, async (s) => {
  const probe = { model: 'claude-opus-4-6', max_tokens: 2048, stream: false, system: 'You are the fixture agent.', tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: 'User: Reply with one word.' }] }] };
  const mark = '[refusal-rewind] The ';
  s.setStep(step('n'));
  assert.equal((await post(s.url, probe)).status, 400);
  s.setStep(step('p', [{ text: '[[c:p.r1]] own' }, { text: '[[c:p.r2]] own' }], { probe: { text: 'Word.' }, also: [mark] }));
  assert.equal((await post(s.url, agentBody({ canary: '[[c:other.in]]' }))).status, 400);
  assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:p.in]]' }))).json), '[[c:p.r1]] own');
  assert.equal(textOf((await post(s.url, agentBody({ canary: '', tail: [{ type: 'text', text: `${mark}1 most recent turn(s) were set aside.` }] }))).json), '[[c:p.r2]] own');
  const two = { ...probe, messages: [{ role: 'user', content: [{ type: 'text', text: 'User: Reply with one word.' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Word.' }] }, { role: 'user', content: [{ type: 'text', text: 'User: Reply with one word.' }] }] };
  assert.equal((await post(s.url, two)).status, 400, 'a request of more than one message, with no canary or mark, isn\'t the probe');
  assert.equal(textOf((await post(s.url, probe)).json), 'Word.');
  assert.equal((await post(s.url, probe)).status, 400);
  s.setStep(step('e', [], { probe: { error: { status: 529, type: 'overloaded_error', message: 'stand-in: the probe, scripted to fail', headers: { 'retry-after': '7' } } } }));
  const failed = await post(s.url, probe);
  assert.equal(failed.status, 529);
  assert.equal(failed.json.error.message, 'stand-in: the probe, scripted to fail');
  assert.equal((await fetch(s.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(probe) })).status, 400, 'a failed probe is answered once too');
  s.setStep(step('h', [], { probe: { error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded', headers: { 'retry-after': '7' } } } }));
  assert.equal((await fetch(s.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(probe) })).headers.get('retry-after'), '7', 'a scripted probe error keeps its headers');
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.step, r.kind, r.kind === 'agent' ? r.agent ?? 'primary' : null]), [
    ['n', 'unclassified', null], ['p', 'unclassified', null], ['p', 'agent', 'primary'], ['p', 'agent', 'primary'], ['p', 'unclassified', null], ['p', 'probe', null], ['p', 'unclassified', null], ['e', 'probe', null], ['e', 'unclassified', null], ['h', 'probe', null],
  ]);
  assert.deepEqual(records.filter((r) => r.kind === 'probe').map((r) => r.answer), [{ shape: 'verdict', verdict: 'answered', chars: 5 }, { shape: 'error', status: 529 }, { shape: 'error', status: 529 }]);
}));

test('T1/T2: a request with no canary of the step, with max_tokens 0, or past the step\'s replies is refused as unclassified, at once, and its arrival says why', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('u'));
  const stranger = await post(s.url, agentBody({ canary: '[[c:other.in]]' }));
  assert.equal(stranger.status, 400);
  assert.equal(stranger.json.error.type, 'invalid_request_error');
  assert.match(stranger.json.error.message, /stand-in.*unclassified/);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.match(seen.at(-1).reason ?? '', /carries none of step u's canaries/, 'the arrival names why, for the driver\'s failure');
  const keepalive = await post(s.url, agentBody({ canary: '[[c:u.in]]', max_tokens: 0 }));
  assert.equal(keepalive.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:u.in]]' }))).status, 200);
  const extra = await post(s.url, agentBody({ canary: '[[c:u.in]]' }));
  assert.equal(extra.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent', 'unclassified']);
  for (const r of records.filter((x) => x.kind === 'unclassified')) assert.equal(typeof r.reason, 'string');
}));

test('T3/T22: a call goes with the id its reply names, and a reply\'s error answers its request with that provider error', () => withStandin({}, async (s) => {
  s.setStep(step('e', [{ text: '[[c:e.r1]] calling', calls: [{ id: 'toolu_same', name: 'time--now', input: {} }, { id: 'toolu_same', name: 'time--now', input: {} }] }, { error: { status: 529, type: 'overloaded_error', message: 'busy' } }]));
  const one = await post(s.url, agentBody({ canary: '[[c:e.in]]' }));
  assert.deepEqual(one.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_same', 'toolu_same']);
  const two = await post(s.url, agentBody({ canary: '[[c:e.in]]', stream: false }));
  assert.equal(two.status, 529);
  assert.equal(two.json.error.type, 'overloaded_error');
}));

test('T23: a step\'s subagent requests are told by the marker in their system prompt and get its own replies, a primary request quoting the marker elsewhere stays the primary\'s, and a text of `also` in the last message names a request the step\'s', () => withStandin({}, async (s) => {
  s.setStep(step('sub', [{ text: '[[c:sub.r1]] primary' }, { text: '[[c:sub.r2]] after the note' }], {
    subs: [{ marker: '[[sub:x]]', canaries: ['[[c:sub.task]]'], replies: [{ text: '[[c:sub.s1]] the subagent' }] }],
    also: ['were set aside'],
  }));
  const sub = await post(s.url, { ...agentBody({ canary: '[[c:sub.task]]' }), system: '[[sub:x]] You are a subagent.' });
  assert.equal(textOf(sub.json), '[[c:sub.s1]] the subagent');
  const primary = await post(s.url, agentBody({ canary: '[[c:sub.in]]' }));
  assert.equal(textOf(primary.json), '[[c:sub.r1]] primary');
  const noted = await post(s.url, { ...agentBody({ canary: '' }), messages: [{ role: 'user', content: [{ type: 'text', text: '[refusal-rewind] The 1 most recent turn(s) were set aside because …' }] }] });
  assert.equal(textOf(noted.json), '[[c:sub.r2]] after the note');
  const quoting = await post(s.url, { ...agentBody({ canary: '' }), messages: [{ role: 'user', content: [{ type: 'text', text: '[[c:sub.in]] spawn it with [[sub:x]] in its prompt' }] }] });
  assert.equal(quoting.status, 400);
  const records = await s.close();
  assert.deepEqual(records.slice(0, 3).map((r) => r.agent), ['sub', 'primary', 'primary']);
  assert.match(records[3].reason, /^step sub has no scripted reply left/, 'a request quoting the marker in a message, at a step whose sub side is no reader fork, is read as the primary\'s, which has no reply left');
}));

test('W16\'s rewound steps, the refused turn, the breaker\'s and the unstick, know agent-framework\'s rewind marker by either of its tags: a request whose only mark of the step is `[refusal-rewind] The …` or `[turns-set-aside] The …` gets the step\'s next reply', async () => {
  const steps = WORKLOADS.W16.steps({ seed: 7, capabilities: { 'kept-history': true } });
  const at = (id) => steps.find((x) => x.id === `7.${id}`);
  for (const tag of ['refusal-rewind', 'turns-set-aside']) {
    const marker = { type: 'text', text: `user: [${tag}] The 1 most recent turn(s) were set aside because the model refused on them (content filter: unknown).` };
    await withStandin({}, async (s) => {
      s.setStep(at('refuse'));
      const calling = await post(s.url, agentBody({ canary: '[[c:7.refuse.in]]' }));
      assert.equal(calling.json.stop_reason, 'tool_use', 'the refused turn makes a call first');
      const refused = await post(s.url, agentBody({ canary: '[[c:7.refuse.in]]', tail: [{ type: 'text', text: '[[c:7.refuse.call1]] the call\'s result' }] }));
      assert.equal(refused.json.stop_reason, 'refusal', 'the request carrying the call\'s result is refused');
      const retry = await post(s.url, agentBody({ canary: '', tail: [marker] }));
      assert.equal(retry.status, 200, `the retry after the refusal, carrying [${tag}]`);
      assert.match(textOf(retry.json), /^\[\[c:7\.refuse\.r1\]\] /);
      s.setStep(at('break.3'));
      const failed = await post(s.url, agentBody({ canary: '[[c:7.break.3.in]]' }));
      assert.equal(failed.status, 400);
      const shed = await post(s.url, agentBody({ canary: '', tail: [marker, marker] }));
      assert.equal(shed.status, 200, `the breaker's retry after the third failure, carrying [${tag}]`);
      assert.match(textOf(shed.json), /^\[\[c:7\.break\.3\.r1\]\] /);
      s.setStep(at('unstick'));
      const unstuck = await post(s.url, agentBody({ canary: '', tail: [marker] }));
      assert.equal(unstuck.json.stop_reason, 'refusal', `the unstick's turn, known by [${tag}] alone`);
    });
  }
});

test('T23b: a reader fork, which shares the resident\'s system prompt, is told by the marker in the message its voice comes in, there and in its later rounds, and gets the reader\'s replies', () => withStandin({}, async (s) => {
  s.setStep(step('h1', [], {
    reader: { prefix: 'reader/' },
    subs: [{ marker: '[[reader]]', canaries: ['[[c:h1.in]]'], namedAnywhere: true, replies: [{ text: '[[c:h1.s1]] reading', calls: [{ name: 'time--now', input: {} }] }, { text: '[[c:h1.s2]] read' }] }],
  }));
  const prefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:h0.in]] the resident\'s turn' }] };
  const framing = { role: 'user', content: [{ type: 'text', text: '[Tune-out wake: chat]\n[[reader]] You read what the resident has tuned out.\nAsh: [[c:h1.in]] held' }] };
  const opened = await post(s.url, { ...agentBody({ canary: '' }), messages: [prefix, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, framing] });
  assert.equal(textOf(opened.json), '[[c:h1.s1]] reading');
  const call = opened.json.content.find((b) => b.type === 'tool_use');
  const round = await post(s.url, { ...agentBody({ canary: '' }), messages: [prefix, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, framing, { role: 'assistant', content: opened.json.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'now' }] }] });
  assert.equal(textOf(round.json), '[[c:h1.s2]] read', 'its later round, whose last message is a tool result, is still the fork\'s');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub']);
}));

test('T24: a step with namedAnywhere is told by its canary or an `also` text in any message of the request, and a step without it only by its last message', () => withStandin({}, async (s) => {
  const earlier = (text) => [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'read' }] }, { role: 'user', content: [{ type: 'text', text: 'and then' }] }];
  s.setStep(step('any', [{ text: '[[c:any.r1]] by canary' }, { text: '[[c:any.r2]] by note' }], { namedAnywhere: true, also: ['addressed message'] }));
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:any.in]] held') })).json), '[[c:any.r1]] by canary');
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[tune-out wake: chat — 1 addressed message]') })).json), '[[c:any.r2]] by note');
  s.setStep(step('last', [{ text: '[[c:last.r1]] never' }], { also: ['addressed message'] }));
  const missed = await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:last.in]] [tune-out wake: chat — 1 addressed message]') });
  assert.notEqual(missed.status, 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'unclassified']);
}));

test('T24b: W12\'s batches the agent read whole, answered or not, are told by their events anywhere in the request, so a wake that writes no gate line still gets the step\'s reply', () => withStandin({}, async (s) => {
  const capabilities = { suppression: true, onboarding: true, conversations: true };
  const steps = WORKLOADS.W12.steps({ seed: 7, capabilities, configurationName: 'H5', configuration: runOf('H5/W12', configurations(), { budget: 100_000, maxTokens: 16_000, capabilities }).configuration });
  const read = ['answered.fire', 'judge.yes', 'judge.err2'].map((n) => steps.find((x) => x.id === `7.${n}`));
  assert.deepEqual(read.map((x) => x?.gate.expect), ['answered-batch', 'batch', 'answered-batch'], 'an answered batch, the judged batch the agent read whole, and the failed judge\'s answered batch');
  for (const x of read) {
    s.setStep(x);
    const [first] = x.replies ?? x.spare;
    const history = [{ role: 'user', content: [{ type: 'text', text: `user: Tavy: ${x.gate.canaries.join(' ')}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'read' }] }];
    const res = await post(s.url, { ...agentBody({ canary: '', history }), stream: false });
    assert.equal(res.status, 200, `${x.id}: a wake whose last message carries no gate line and none of the batch`);
    assert.equal(textOf(res.json), first.text, `${x.id}: it gets the step's reply`);
  }
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'agent']);
}));

test('T24c: W12\'s orphan step answers a third request of the resident\'s, the turn agent-framework can wake for the held result\'s notice, with skip_reply', () => withStandin({}, async (s) => {
  const capabilities = { suppression: true, onboarding: true, conversations: true };
  const steps = WORKLOADS.W12.steps({ seed: 7, capabilities, configurationName: 'H5', configuration: runOf('H5/W12', configurations(), { budget: 100_000, maxTokens: 16_000, capabilities }).configuration });
  s.setStep(steps.find((x) => x.id === '7.orphan'));
  const heldSeen = [];
  s.onHeld((h) => heldSeen.push(h));
  const ask = () => post(s.url, { ...agentBody({ canary: '[[c:7.orphan.in]]' }), stream: false });
  const calls = (res) => res.json.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
  assert.deepEqual(calls(await ask()), ['subagent--spawn']);
  const answering = ask();
  for (const until = performance.now() + 5000; !heldSeen.length;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(s.releaseHeld(heldSeen[0].id), true);
  assert.equal((await answering).status, 200);
  const woken = await ask();
  assert.equal(woken.status, 200, 'a third request at the step is answered, not left unclassified');
  assert.deepEqual(calls(woken), ['skip_reply'], 'the woken turn owes no one words');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'agent']);
}));

test('a scripted reply with `hold` is held, and the stand-in tells onHeld its request and the reply\'s acts; a release sends the reply of the request it names and leaves the request held before it held', () => withStandin({}, async (s) => {
  const acts = [{ deliver: { id: 'h.arrival', participant: 'Tavy', text: '[[c:h.arr]] now' } }];
  s.setStep(step('h', [{ text: '[[c:h.r1]] settled', settle: true }, { text: '[[c:h.r2]] held', hold: true, during: acts }]));
  const heldSeen = [];
  s.onHeld((h) => heldSeen.push(h));
  const waitHeld = async (n) => {
    for (const until = performance.now() + 5000; heldSeen.length < n;) {
      if (performance.now() > until) assert.fail(`onHeld named ${heldSeen.length} of ${n} requests within 5 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const first = post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }));
  await waitHeld(1);
  const second = post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }));
  await waitHeld(2);
  assert.equal(heldSeen[0].during, undefined, 'a settle reply carries no acts');
  assert.deepEqual(heldSeen[1].during, acts, 'a held reply carries its acts');
  assert.equal(s.releaseHeld(heldSeen[1].id), true);
  assert.equal(textOf((await second).json), '[[c:h.r2]] held');
  assert.equal(s.releaseHeld(heldSeen[0].id), true, 'the request held before it is still held after that release');
  assert.equal(textOf((await first).json), '[[c:h.r1]] settled');
  assert.equal(s.releaseHeld(heldSeen[0].id), false, 'a request is released once');
}));

test('a held request its client closes before the release is recorded as cut, with nothing sent and no tool id spent, and the next request takes the next scripted reply', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const calls = [{ name: 'look', input: {} }];
  s.setStep(step('k', [{ text: '[[c:k.r1]] held', hold: true, calls }, { text: '[[c:k.r2]] fresh', calls }, { text: '[[c:k.r3]] after', calls }]));
  const heldSeen = [];
  s.onHeld((h) => heldSeen.push(h));
  const client = new AbortController();
  const cut = fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(agentBody({ canary: '[[c:k.in]]', stream: false })), signal: client.signal }).catch((e) => e);
  for (const until = performance.now() + 5000; !heldSeen.length;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  client.abort();
  assert.equal((await cut).name, 'AbortError');
  const fresh = await post(s.url, agentBody({ canary: '[[c:k.in]]', stream: false }));
  assert.equal(s.releaseHeld(heldSeen[0].id), true);
  assert.equal(textOf(fresh.json), '[[c:k.r2]] fresh', 'the fresh request takes the reply after the held one');
  const after = await post(s.url, agentBody({ canary: '[[c:k.in]]', stream: false }));
  assert.deepEqual(after.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_fx000002'], 'the cut reply spent no tool id');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.answer.shape), ['cut', 'reply', 'reply']);
  assert.deepEqual(records[0].answer, { shape: 'cut' });
});

test('T26: a reply marked settle waits until releaseHeld, after onHeld names its request; an ordinary reply is answered at once', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    s.setStep({ ...step('q', [{ text: '[[c:q.r1]] held', settle: true }, { text: '[[c:q.r2]] plain' }]), canaries: ['[[c:q.in]]'] });
    let answered = null;
    const first = post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false })).then((r) => { answered = r; return r; });
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(Object.keys(heldSeen[0]).sort(), ['agent', 'id', 'step']);
    assert.equal(heldSeen[0].step, 'q');
    const second = await post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false }));
    assert.equal(textOf(second.json), '[[c:q.r2]] plain', 'the next request is answered while the first is held');
    assert.equal(answered, null, 'the held one is still waiting');
    s.releaseHeld(heldSeen[0].id);
    assert.equal(textOf((await first).json), '[[c:q.r1]] held');
  } finally { await s.close(); }
});

test('a request under /empty moves no state the recorded requests are answered from: after one with a marked prefix, the same prefix on the recorded route is written, not read', () => withStandin({}, async (s) => {
  s.setStep(step('c', [{ text: 'r1' }]));
  const history = [
    { role: 'user', content: [{ type: 'text', text: `user: ${prose(4000, 5)}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
  ];
  const body = agentBody({ model: 'claude-opus-5-5', canary: '[[c:c.in]]', history });
  s.setClock(0);
  assert.equal((await post(s.url, body, '/empty/v1/messages')).status, 200);
  const usage = (await post(s.url, body)).json.usage;
  assert.equal(usage.cache_read_input_tokens, 0);
  assert.ok(usage.cache_creation_input_tokens > 1000);
}));

test('a request under /empty that the stand-in can\'t answer is refused with a stand-in error naming the URL it was sent to and why, and is told to the run as unclassified', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen } = arrivals(s);
  s.setStep(step('e'));
  const sent = async (path, body) => {
    const r = await read(await fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body, signal: AbortSignal.timeout(ANSWER_BOUND_MS) }));
    return { status: r.status, text: JSON.stringify(r.json) };
  };
  const got = [
    await sent('/empty/v1/messages', '{"model":'),
    await sent('/empty/v1/messages', JSON.stringify({ model: 'claude-opus-4-6', messages: {} })),
    await sent('/empty/v1/other', JSON.stringify(agentBody({ canary: '[[c:e.in]]' }))),
  ];
  assert.deepEqual(got.map((g) => g.status), [400, 400, 404]);
  assert.match(got[0].text, /POST \/empty\/v1\/messages: its body isn't JSON/);
  assert.match(got[1].text, /POST \/empty\/v1\/messages: the stand-in couldn't answer it: TypeError/);
  assert.match(got[2].text, /POST \/empty\/v1\/other: no model request the stand-in models goes there/);
  const ok = await post(s.url, agentBody({ canary: '[[c:e.in]]' }));
  assert.equal(textOf(ok.json), '[[c:e.r1]] noted.', 'the stand-in answers on');
  await s.close();
  assert.deepEqual(seen.map((r) => [r.id, r.kind]), [['empty1', 'unclassified'], ['empty2', 'unclassified'], ['empty3', 'unclassified'], ['r1', 'agent']]);
  assert.match(seen[1].reason, /^a fleet child's request, POST \/empty\/v1\/messages: the stand-in couldn't answer it: TypeError/);
});

test('a request under /empty, a fleet child\'s model, is answered with an empty reply that ends the turn, streamed or not, and is neither recorded, kept nor told to the run', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'empty-route-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    const { seen } = arrivals(s);
    s.setStep(step('e'));
    for (const stream of [true, false]) {
      const r = await post(s.url, agentBody({ canary: '[[c:e.in]]', stream }), '/empty/v1/messages');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.content, []);
      assert.equal(r.json.stop_reason, 'end_turn');
    }
    const ok = await post(s.url, agentBody({ canary: '[[c:e.in]]' }));
    assert.equal(textOf(ok.json), '[[c:e.r1]] noted.', 'the step\'s own replies are untouched');
    const records = await s.close();
    assert.deepEqual(records.map((r) => r.id), ['r1'], 'only the request outside /empty is recorded');
    assert.deepEqual(seen.map((r) => r.id), ['r1']);
    assert.deepEqual(readdirSync(rawDir).sort(), ['r1.answer.json', 'r1.json']);
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
});
