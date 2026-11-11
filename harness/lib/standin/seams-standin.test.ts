// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStandin } from './standin.ts';

const words = (n, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const said = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const body = (messages, system = 'You are the fixture agent.') => ({ model: 'claude-opus-4-6', max_tokens: 2048, system, tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages });
const post = async (s, b) => { const r = await fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(b) }); await r.text(); return r.status; };
const seams = (records) => records.filter((r) => r.kind === 'agent').map((r) => r.seam ?? 0);

test('each agent is compared with its own previous request, two agents interleaved', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }], { subs: [{ marker: '[[sub:x]]', canaries: ['[[c:sub.task]]'], replies: [{ text: '[[c:sub.s1]] a' }, { text: '[[c:sub.s2]] b' }] }] }));
  const p1 = [user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  const s1 = [user(`[[c:sub.task]] ${words(40, 't')}`)];
  assert.equal(await post(s, body(p1)), 200);
  assert.equal(await post(s, body(s1, 'You are a subagent. [[sub:x]]')), 200);
  assert.equal(await post(s, body([...p1, said('[[c:p.r1]] one'), user(`user: [[c:p.in]] ${words(10, 'b')}`)])), 200);
  assert.equal(await post(s, body([...s1, said('[[c:sub.s1]] a'), user(`[[c:sub.task]] more`)], 'You are a subagent. [[sub:x]]')), 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['primary', 'sub', 'primary', 'sub']);
  assert.deepEqual(seams(records), [0, 0, 0, 0]);
});

test('a request answered with no usage is skipped: the next is compared with the last one answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { error: { status: 529, message: 'overloaded' } }, { text: '[[c:p.r3]] three' }]));
  const p1 = [user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  assert.equal(await post(s, body(p1)), 200);
  assert.equal(await post(s, body([user(`user: [[c:p.in]] ${words(40, 'z')}`)])), 529);
  assert.equal(await post(s, body([...p1, said('[[c:p.r1]] one'), user(`user: [[c:p.in]] again`)])), 200);
  const records = await s.close();
  assert.deepEqual(seams(records), [0, 0, 0]);
});

test("each reader fork is a context of its own, keyed by its messages through its framing, and its first request is compared with nothing", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('h', [], { reader: { prefix: 'reader/' }, subs: [{ marker: '[[reader]]', canaries: ['[[c:h.in]]'], namedAnywhere: true, replies: [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }] }] }));
  const resident = [user(`user: the resident's turn ${words(40, 'a')}`), said('ok')];
  const framing = (n) => user(`[Tune-out wake: chat]\n[[reader]] You read what the resident has tuned out.\nAsh: [[c:h.in]] held ${n}`);
  const one = [...resident, framing(1)];
  assert.equal(await post(s, body(one)), 200);
  assert.equal(await post(s, body([...one, said(`r1 ${words(40, 'f')}`), user('[[c:h.in]] go on')])), 200);
  const two = [...resident, user(`user: the resident's next turn ${words(20, 'b')}`), said('ok'), framing(2)];
  assert.equal(await post(s, body(two)), 200);
  assert.equal(await post(s, body([...two, said('r3'), user('[[c:h.in]] go on')])), 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub', 'sub', 'sub']);
  assert.deepEqual(seams(records), [0, 0, 0, 0]);
});

test("a persistent reader, told by its system prompt, keeps one context across its wakes, so what one wake drops of the last is a seam", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('h', [], { subs: [{ marker: '[[reader]]', canaries: ['[[c:h.in]]'], namedAnywhere: true, replies: [{ text: 'r1' }, { text: 'r2' }] }] }));
  const system = 'You read what the resident has tuned out. [[reader]]';
  const first = [user(`[Tune-out reader — chat, epoch 8506fa9b, wake]\n[[c:h.in]] held ${words(40, 'a')}`)];
  assert.equal(await post(s, body(first, system)), 200);
  assert.equal(await post(s, body([said('r1'), user(`[Tune-out reader — chat, epoch 8506fa9b, wake]\n[[c:h.in]] held again ${words(10, 'b')}`)], system)), 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub']);
  assert.equal(seams(records)[0], 0);
  assert.ok(seams(records)[1] > 0);
});

test("a run's first request is compared with its checkpoint's last, from the seed the checkpoint's stand-in gave", async () => {
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('p', [{ text: '[[c:p.r1]] one' }]));
  const before = [user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  assert.equal(await post(cp, body(before)), 200);
  const seed = cp.seed();
  await cp.close();
  const carry = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  carry.setStep(step('q', [{ text: '[[c:q.r1]] two' }]));
  assert.equal(await post(carry, body([...before, said('[[c:p.r1]] one'), user('user: [[c:q.in]] next')])), 200);
  assert.deepEqual(seams(await carry.close()), [0]);
  const rewrite = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  rewrite.setStep(step('q', [{ text: '[[c:q.r1]] two' }]));
  assert.equal(await post(rewrite, body([user('user: [[c:q.in]] a summary')])), 200);
  assert.ok(seams(await rewrite.close())[0] > 0);
});

test('a request through another API than its previous one is compared with nothing, and its record says so', async () => {
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('p', [{ text: '[[c:p.r1]] one' }]));
  assert.equal(await post(cp, body([user(`user: [[c:p.in]] ${words(40, 'a')}`)])), 200);
  const seed = Object.fromEntries(Object.entries(cp.seed()).map(([k, v]) => [k, { ...v, codec: v.codec + 1 }]));
  await cp.close();
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  s.setStep(step('q', [{ text: '[[c:q.r1]] two' }, { text: '[[c:q.r2]] three' }]));
  assert.equal(await post(s, body([user('user: [[c:q.in]] another context')])), 200);
  assert.equal(await post(s, body([user('user: [[c:q.in]] another context'), said('[[c:q.r1]] two'), user('user: [[c:q.in]] more')])), 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.apiChanged ?? false), [true, false]);
  assert.deepEqual(seams(records), [0, 0]);
});

test("two subagents that share a name but not a system prompt are two contexts: the second's first request is compared with nothing", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [], { subs: [{ marker: '[[sub:fork]]', canaries: ['[[c:p.in]]'], replies: [{ text: 'a' }] }] }));
  assert.equal(await post(s, body([user(`[[c:p.in]] ${words(60, 'f')}`), said('a'), user('[[c:p.in]] go on')], 'You are a fork of the resident. [[sub:fork]]')), 200);
  s.setStep(step('q', [], { subs: [{ marker: '[[sub:spawn]]', canaries: ['[[c:q.in]]'], replies: [{ text: 'c' }] }] }));
  assert.equal(await post(s, body([user('a context it was handed'), said('handed'), user('[[c:q.in]] a task of your own')], 'You are a spawned subagent. [[sub:spawn]]')), 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub']);
  assert.deepEqual(seams(records), [0, 0]);
});

test('a subagent request holding no assistant message is a birth: two spawns of one kind, one name and one prompt, count no seam', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const system = 'You are a spawned subagent. [[sub:spawn]]';
  for (const [id, task] of [['p', words(60, 'f')], ['q', words(10, 'g')]]) {
    s.setStep(step(id, [], { subs: [{ marker: '[[sub:spawn]]', canaries: [`[[c:${id}.in]]`], replies: [{ text: `${id}1` }, { text: `${id}2` }] }] }));
    const first = [user(`[[c:${id}.in]] ${task}`)];
    assert.equal(await post(s, body(first, system)), 200);
    assert.equal(await post(s, body([...first, said(`${id}1`), user(`[[c:${id}.in]] go on`)], system)), 200);
  }
  const records = await s.close();
  assert.deepEqual(seams(records), [0, 0, 0, 0]);
});
