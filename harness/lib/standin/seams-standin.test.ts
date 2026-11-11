// @ts-nocheck
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { parsedBody, seedOf, startStandin } from './standin.ts';
import { contextParts } from './anthropic.ts';
import { runVaryingClass } from '../strategies/compare.ts';

const words = (n, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const said = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const body = (messages, system = 'You are the fixture agent.') => ({ model: 'claude-opus-4-6', max_tokens: 2048, system, tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages });
const post = async (s, b) => { const r = await fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(b) }); await r.text(); return r.status; };
const seams = (records) => records.filter((r) => r.kind === 'agent').map((r) => r.seam ?? 0);
const contextsOf = (s) => Object.keys(s.seed().contexts).length;
const tokensOf = (b, text) => contextParts(b, runVaryingClass(null)).filter((p) => p.text === text).reduce((t, p) => t + p.tokens, 0);

test('each agent is compared with its own previous request, two agents interleaved', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }], { subs: [{ marker: '[[sub:x]]', canaries: ['[[c:sub.task]]'], replies: [{ text: '[[c:sub.s1]] a' }, { text: '[[c:sub.s2]] b' }, { text: '[[c:sub.s3]] c' }] }] }));
  const p1 = [user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  const s1 = [user(`[[c:sub.task]] ${words(40, 't')}`)];
  assert.equal(await post(s, body(p1)), 200);
  assert.equal(await post(s, body(s1, 'You are a subagent. [[sub:x]]')), 200);
  assert.equal(await post(s, body([...p1, said('[[c:p.r1]] one'), user(`user: [[c:p.in]] ${words(10, 'b')}`)])), 200);
  assert.equal(await post(s, body([...s1, said('[[c:sub.s1]] a'), user(`[[c:sub.task]] more`)], 'You are a subagent. [[sub:x]]')), 200);
  assert.equal(await post(s, body([said('[[c:p.r2]] two'), user('user: [[c:p.in]] the rest dropped')])), 200);
  assert.equal(await post(s, body([said('[[c:sub.s2]] b'), user('[[c:sub.task]] the rest dropped')], 'You are a subagent. [[sub:x]]')), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 2, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(records.map((r) => r.agent), ['primary', 'sub', 'primary', 'sub', 'primary', 'sub']);
  assert.deepEqual(seams(records).slice(0, 4), [0, 0, 0, 0]);
  assert.ok(seams(records)[4] > 0 && seams(records)[5] > 0, 'each agent found its own previous request: what each later drops is a seam');
});

test('a request answered with no usage is skipped: the next is compared with the last one answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { error: { status: 529, message: 'overloaded' } }, { text: '[[c:p.r3]] three' }, { text: '[[c:p.r4]] four' }]));
  const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
  const p1 = [user(lead), said('noted'), user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  assert.equal(await post(s, body(p1)), 200);
  assert.equal(await post(s, body([user(`user: [[c:p.in]] ${words(40, 'z')}`)])), 529);
  assert.equal(await post(s, body([...p1.slice(1), said('[[c:p.r1]] one'), user(`user: [[c:p.in]] again`)])), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 1, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(seams(records), [0, 0, tokensOf(body(p1), lead)], 'the third is compared with the first across the failed one: it took out the first\'s lead, and only that');
});

test("each reader fork is a context of its own, keyed by its messages through its framing, and its first request is compared with nothing", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('h', [], { reader: { prefix: 'reader/' }, subs: [{ marker: '[[reader]]', canaries: ['[[c:h.in]]'], namedAnywhere: true, replies: [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }, { text: 'r5' }] }] }));
  const resident = [user(`user: the resident's turn ${words(40, 'a')}`), said('ok')];
  const framing = (n) => user(`[Tune-out wake: chat]\n[[reader]] You read what the resident has tuned out.\nAsh: [[c:h.in]] held ${n}`);
  const one = [...resident, framing(1)];
  assert.equal(await post(s, body(one)), 200);
  assert.equal(await post(s, body([...one, said(`r1 ${words(40, 'f')}`), user('[[c:h.in]] go on')])), 200);
  const two = [...resident, user(`user: the resident's next turn ${words(20, 'b')}`), said('ok'), framing(2)];
  assert.equal(await post(s, body(two)), 200);
  assert.equal(await post(s, body([...two, said('r3'), user('[[c:h.in]] go on')])), 200);
  assert.equal(await post(s, body([...two, user('[[c:h.in]] its own turns dropped')])), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 2, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub', 'sub', 'sub', 'sub']);
  assert.deepEqual(seams(records).slice(0, 4), [0, 0, 0, 0]);
  assert.ok(seams(records)[4] > 0, 'a continuing fork finds its own previous request: what it drops of its own turns is a seam');
});

test("a persistent reader, told by its system prompt, keeps one context across its wakes, so what one wake drops of the last is a seam", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('h', [], { subs: [{ marker: '[[reader]]', canaries: ['[[c:h.in]]'], namedAnywhere: true, replies: [{ text: 'r1' }, { text: 'r2' }] }] }));
  const system = 'You read what the resident has tuned out. [[reader]]';
  const first = [user(`[Tune-out reader — chat, epoch 8506fa9b, wake]\n[[c:h.in]] held ${words(40, 'a')}`)];
  assert.equal(await post(s, body(first, system)), 200);
  assert.equal(await post(s, body([said('r1'), user(`[Tune-out reader — chat, epoch 8506fa9b, wake]\n[[c:h.in]] held again ${words(10, 'b')}`)], system)), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 1, 'one context for each agent: no request missed its own agent\'s previous one');
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
  carry.setStep(step('q', [{ text: '[[c:q.r1]] two' }, { text: '[[c:q.r2]] three' }]));
  const carried = body([...before, said('[[c:p.r1]] one'), user('user: [[c:q.in]] next')]);
  assert.equal(await post(carry, carried), 200);
  assert.equal(await post(carry, body([said('[[c:p.r1]] one'), user('user: [[c:q.in]] next'), said('[[c:q.r1]] two'), user('user: [[c:q.in]] then')])), 200);
  const contexts = contextsOf(carry);
  assert.deepEqual(seams(await carry.close()), [0, tokensOf(carried, before[0].content[0].text)], 'it carried the seed\'s request, and the same context then took out its first message alone');
  assert.equal(contexts, 1, 'one context: the run\'s requests found the seed\'s');
  const rewrite = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  rewrite.setStep(step('q', [{ text: '[[c:q.r1]] two' }]));
  assert.equal(await post(rewrite, body([user('user: [[c:q.in]] a summary')])), 200);
  assert.deepEqual(seams(await rewrite.close()), [tokensOf(body(before), before[0].content[0].text)], 'a rewrite took out the seed\'s message alone');
});

test('a request through another API than its previous one is compared with nothing, and its record says so', async () => {
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('p', [{ text: '[[c:p.r1]] one' }]));
  assert.equal(await post(cp, body([user(`user: [[c:p.in]] ${words(40, 'a')}`)])), 200);
  const built = cp.seed();
  const seed = { ...built, contexts: Object.fromEntries(Object.entries(built.contexts).map(([k, v]) => [k, { ...v, codec: v.codec + 1 }])) };
  await cp.close();
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  s.setStep(step('q', [{ text: '[[c:q.r1]] two' }, { text: '[[c:q.r2]] three' }, { text: '[[c:q.r3]] four' }]));
  assert.equal(await post(s, body([user('user: [[c:q.in]] another context')])), 200);
  assert.equal(await post(s, body([user('user: [[c:q.in]] another context'), said('[[c:q.r1]] two'), user('user: [[c:q.in]] more')])), 200);
  assert.equal(await post(s, body([user('user: [[c:q.in]] the rest dropped')])), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 1, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(records.map((r) => r.apiChanged ?? false), [true, false, false]);
  assert.deepEqual(seams(records).slice(0, 2), [0, 0]);
  assert.ok(seams(records)[2] > 0, 'after the change, the agent is compared again on its new API');
});

test("two subagents that share a name but not a system prompt are two contexts: the second's first request is compared with nothing", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [], { subs: [{ marker: '[[sub:fork]]', canaries: ['[[c:p.in]]'], replies: [{ text: 'a' }] }] }));
  assert.equal(await post(s, body([user(`[[c:p.in]] ${words(60, 'f')}`), said('a'), user('[[c:p.in]] go on')], 'You are a fork of the resident. [[sub:fork]]')), 200);
  s.setStep(step('q', [], { subs: [{ marker: '[[sub:spawn]]', canaries: ['[[c:q.in]]'], replies: [{ text: 'c' }, { text: 'd' }] }] }));
  assert.equal(await post(s, body([user('a context it was handed'), said('handed'), user('[[c:q.in]] a task of your own')], 'You are a spawned subagent. [[sub:spawn]]')), 200);
  assert.equal(await post(s, body([said('c'), user('[[c:q.in]] the handed context dropped')], 'You are a spawned subagent. [[sub:spawn]]')), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 2, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'sub', 'sub']);
  assert.deepEqual(seams(records).slice(0, 2), [0, 0]);
  assert.ok(seams(records)[2] > 0, 'the spawned subagent found its own previous request');
});

test('a subagent request holding no assistant message is a birth: two spawns of one kind, one name and one prompt, count no seam', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const system = 'You are a spawned subagent. [[sub:spawn]]';
  for (const [id, task] of [['p', words(60, 'f')], ['q', words(10, 'g')]]) {
    s.setStep(step(id, [], { subs: [{ marker: '[[sub:spawn]]', canaries: [`[[c:${id}.in]]`], replies: [{ text: `${id}1` }, { text: `${id}2` }, { text: `${id}3` }] }] }));
    const first = [user(`[[c:${id}.in]] ${task}`)];
    assert.equal(await post(s, body(first, system)), 200);
    assert.equal(await post(s, body([...first, said(`${id}1`), user(`[[c:${id}.in]] go on`)], system)), 200);
  }
  assert.equal(await post(s, body([said('q1'), user('[[c:q.in]] its task dropped')], system)), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 1, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(seams(records).slice(0, 4), [0, 0, 0, 0]);
  assert.ok(seams(records)[4] > 0, 'the second spawn was compared with its own previous request');
});

test("a request of another kind, such as a breaker's probe, is no agent's context: it carries no seam, and the next is compared with the one before it", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }], { probe: { text: 'pong' } }));
  const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
  const p1 = [user(lead), said('noted'), user(`user: [[c:p.in]] ${words(40, 'a')}`)];
  assert.equal(await post(s, body(p1)), 200);
  assert.equal(await post(s, body([user('ping')])), 200);
  assert.equal(await post(s, body([...p1.slice(1), said('[[c:p.r1]] one'), user('user: [[c:p.in]] again')])), 200);
  const contexts = contextsOf(s);
  const records = await s.close();
  assert.equal(contexts, 1, 'one context for each agent: no request missed its own agent\'s previous one');
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'probe', 'agent']);
  assert.deepEqual(records.map((r) => r.seam ?? 0), [0, 0, tokensOf(body(p1), lead)], 'the primary is compared across the probe: it took out the first request\'s lead, and only that');
});

const bound = (messages, maxTokens) => ({ ...body(messages), model: 'claude-opus-5-5', max_tokens: maxTokens, thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } });
const postBound = async (s, b) => {
  const r = await fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'thinking-binding-controls-2026-08-01' }, body: JSON.stringify({ ...b, stream: false }) });
  return r.json();
};
const thinkingTokens = (b) => contextParts(b, runVaryingClass(null)).filter((p) => p.type === 'thinking').reduce((t, p) => t + p.tokens, 0);

test("a thinking block the model first doesn't get, though it was never carried, is a seam of its tokens once: a reply's block first sent back unbound", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ thinking: words(80, 't'), text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }, { text: '[[c:p.r4]] four' }]));
  const u1 = user(`user: [[c:p.in]] ${words(40, 'a')}`);
  const a1 = { role: 'assistant', content: (await postBound(s, bound([u1], 2048))).content };
  assert.ok(a1.content.some((b) => b.type === 'thinking'), 'the reply thinks');
  const second = bound([u1, a1, user('user: [[c:p.in]] again')], 4096);
  await postBound(s, second);
  const third = bound([u1, a1, user('user: [[c:p.in]] again'), said('[[c:p.r2]] two'), user('user: [[c:p.in]] more')], 4096);
  await postBound(s, third);
  await postBound(s, bound([u1, a1, user('user: [[c:p.in]] again'), user('user: [[c:p.in]] more'), said('[[c:p.r3]] three'), user('user: [[c:p.in]] last')], 4096));
  const records = await s.close();
  assert.ok(thinkingTokens(second) > 0);
  assert.deepEqual(seams(records), [0, thinkingTokens(second), 0, tokensOf(third, '[[c:p.r2]] two')], 'counted at the request where the model first doesn\'t get it, and not again; the same context then took out one reply alone');
});

test('a thinking block carried and then withheld is counted once, by what its agent no longer carries, not again as withheld', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('p', [{ thinking: words(80, 't'), text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }]));
  const u1 = user(`user: [[c:p.in]] ${words(40, 'a')}`);
  const a1 = { role: 'assistant', content: (await postBound(s, bound([u1], 2048))).content };
  const carriedBody = bound([u1, a1, user('user: [[c:p.in]] again')], 2048);
  await postBound(s, carriedBody);
  await postBound(s, bound([u1, a1, user('user: [[c:p.in]] again'), said('[[c:p.r2]] two'), user('user: [[c:p.in]] more')], 4096));
  const records = await s.close();
  assert.ok(thinkingTokens(carriedBody) > 0);
  assert.deepEqual(seams(records), [0, 0, thinkingTokens(carriedBody)]);
});

test("a withheld block a checkpoint's seed already withheld isn't counted again at the first request of a run from it", async () => {
  const replies = [{ thinking: words(80, 't'), text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }];
  const build = await startStandin({ configuration: { windowTokens: 50_000 } });
  build.setStep(step('p', replies));
  const u1 = user(`user: [[c:p.in]] ${words(40, 'a')}`);
  const a1 = { role: 'assistant', content: (await postBound(build, bound([u1], 2048))).content };
  const later = [u1, a1, user('user: [[c:p.in]] again')];
  await postBound(build, bound(later, 4096));
  const seed = JSON.parse(JSON.stringify(build.seed()));
  await build.close();
  assert.deepEqual(seed.contexts.primary.withheld.map((p) => p.type), ['thinking'], 'the seed keeps the block it withheld');
  const run = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  run.setStep(step('p', replies.slice(1)));
  const first = bound([...later.slice(1), said('[[c:p.r2]] two'), user('user: [[c:p.in]] more')], 4096);
  await postBound(run, first);
  assert.deepEqual(seams(await run.close()), [tokensOf(bound(later, 4096), u1.content[0].text)], "compared with the seed's last request: it took out its first message, and the block withheld there isn't counted again");
});

test("a run from a checkpoint masks the build's directory as its own, so stored text quoting the build's path is carried, and keys found", async () => {
  const built = mkdtempSync(join(tmpdir(), 'seam-build-')), run = mkdtempSync(join(tmpdir(), 'seam-run-longer-'));
  const open = [];
  try {
    const cp = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: built });
    open.push(cp);
    cp.setStep(step('p', [{ text: '[[c:p.r1]] one' }], { subs: [{ marker: '[[sub:x]]', canaries: ['[[c:p.in]]'], replies: [{ text: 's1' }] }] }));
    const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
    const quoted = [user(lead), said('noted'), user(`user: [[c:p.in]] read ${built}/store/workspace/notes.md ${words(30, 'a')}`)];
    const system = `You are a subagent of ${built}/store. [[sub:x]]`;
    const task = user(`[[c:p.in]] a task ${words(30, 't')}`);
    assert.equal(await post(cp, body(quoted)), 200);
    assert.equal(await post(cp, body([task], system)), 200);
    const seed = cp.seed();
    open.pop(); await cp.close();
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: run, seed });
    open.push(s);
    s.setStep(step('q', [{ text: '[[c:q.r1]] two' }], { subs: [{ marker: '[[sub:x]]', canaries: ['[[c:q.in]]'], replies: [{ text: 's2' }] }] }));
    assert.equal(await post(s, body([...quoted.slice(1), said('[[c:p.r1]] one'), user('user: [[c:q.in]] next')])), 200);
    assert.equal(await post(s, body([said('s1'), user('[[c:q.in]] the task dropped')], system)), 200);
    open.pop();
    const records = await s.close();
    assert.equal(records[0].seam ?? 0, tokensOf(body(quoted), lead), "compared with the seed: it took out the lead alone, since the build's path in replayed text is the run's own");
    assert.equal(records[1].seam ?? 0, tokensOf(body([task], system), task.content[0].text), "a subagent whose prompt quotes the build's path finds its seeded context: it took out the task alone");
  } finally {
    for (const o of open) await o.close();
    rmSync(built, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true });
  }
});

test("a lesson id is masked to its class with no number, and stays masked once read: a lessons file that renumbers or loses a lesson changes nothing a request carries", async () => {
  const run = mkdtempSync(join(tmpdir(), 'seam-lessons-'));
  try {
    mkdirSync(join(run, 'store'));
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'aaaa1111' }, { id: 'bbbb2222' }] }));
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: run });
    s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }]));
    const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
    const first = [user(lead), said('noted'), user(`user: [[c:p.in]] lessons aaaa1111 and bbbb2222 hold ${words(30, 'a')}`)];
    assert.equal(await post(s, body(first)), 200);
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'bbbb2222' }] }));
    assert.equal(await post(s, body([...first.slice(1), said('[[c:p.r1]] one'), user('user: [[c:p.in]] next')])), 200);
    assert.deepEqual(seams(await s.close()), [0, tokensOf(body(first), lead)], 'compared with the first: it took out the lead alone');
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test("an identity kept from an agent's previous request is reused only under the same lesson set: a lesson made since, whose id a carried part quotes, reads that part anew", async () => {
  const run = mkdtempSync(join(tmpdir(), 'seam-memo-'));
  try {
    mkdirSync(join(run, 'store'));
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [] }));
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: run });
    s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }]));
    const quoting = `user: [[c:p.in]] lesson cccc3333 holds ${words(30, 'a')}`;
    const first = [user(quoting), said('noted'), user(`user: [[c:p.in]] ${words(20, 'b')}`)];
    assert.equal(await post(s, body(first)), 200);
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'cccc3333' }] }));
    assert.equal(await post(s, body([...first, said('[[c:p.r1]] one'), user('user: [[c:p.in]] next')])), 200);
    assert.deepEqual(seams(await s.close()), [0, tokensOf(body(first), quoting)], 'the quoting message reads anew, as a lesson, so it no longer carries');
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test("the lessons file's order is part of what an identity kept from an agent's previous request is reused under: where two ids overlap, the same set reordered reads a quoting part anew, as the masker reads it", async () => {
  const run = mkdtempSync(join(tmpdir(), 'seam-order-'));
  try {
    mkdirSync(join(run, 'store'));
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'aa' }, { id: 'aa-bb' }] }));
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: run });
    s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }]));
    const quoting = `user: [[c:p.in]] lesson aa-bb holds ${words(30, 'a')}`;
    const first = [user(quoting), said('noted'), user(`user: [[c:p.in]] ${words(20, 'b')}`)];
    assert.equal(await post(s, body(first)), 200);
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'aa-bb' }, { id: 'aa' }] }));
    assert.equal(await post(s, body([...first, said('[[c:p.r1]] one'), user('user: [[c:p.in]] next')])), 200);
    assert.deepEqual(seams(await s.close()), [0, tokensOf(body(first), quoting)], "'aa-bb' was masked as 'aa' and its rest, and is now masked whole, so the quoting message no longer carries");
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test("a run from a checkpoint keeps masking the lesson ids its build read, though its copied lessons file has lost one", async () => {
  const built = mkdtempSync(join(tmpdir(), 'seam-lb-')), run = mkdtempSync(join(tmpdir(), 'seam-lr-'));
  const open = [];
  try {
    for (const d of [built, run]) mkdirSync(join(d, 'store'));
    writeFileSync(join(built, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: 'aaaa1111' }] }));
    const cp = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: built });
    open.push(cp);
    cp.setStep(step('p', [{ text: '[[c:p.r1]] one' }]));
    const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
    const before = [user(lead), said('noted'), user(`user: [[c:p.in]] lesson aaaa1111 holds ${words(30, 'a')}`)];
    assert.equal(await post(cp, body(before)), 200);
    const seed = cp.seed();
    open.pop(); await cp.close();
    writeFileSync(join(run, 'store', 'lessons.json'), JSON.stringify({ lessons: [] }));
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir: run, seed });
    open.push(s);
    s.setStep(step('q', [{ text: '[[c:q.r1]] two' }]));
    assert.equal(await post(s, body([...before.slice(1), said('[[c:p.r1]] one'), user('user: [[c:q.in]] next')])), 200);
    open.pop();
    assert.deepEqual(seams(await s.close()), [tokensOf(body(before), lead)]);
  } finally {
    for (const o of open) await o.close();
    rmSync(built, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true });
  }
});

test('a request whose answer fails after it is answered is no agent\'s previous request', async () => {
  const raw = mkdtempSync(join(tmpdir(), 'seam-raw-'));
  try {
    mkdirSync(join(raw, 'p.primary.2.answer.json'));
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir: raw });
    s.setStep(step('p', [{ text: '[[c:p.r1]] one' }, { text: '[[c:p.r2]] two' }, { text: '[[c:p.r3]] three' }]));
    const lead = `user: [[c:p.in]] ${words(20, 'l')}`;
    const p1 = [user(lead), said('noted'), user(`user: [[c:p.in]] ${words(40, 'a')}`)];
    assert.equal(await post(s, body(p1)), 200);
    assert.equal((await post(s, body([user(`user: [[c:p.in]] ${words(40, 'z')}`)]))) >= 400, true);
    assert.equal(await post(s, body([...p1.slice(1), said('[[c:p.r1]] one'), user('user: [[c:p.in]] again')])), 200);
    const records = (await s.close()).filter((r) => r.kind === 'agent');
    assert.deepEqual(records.map((r) => r.seam ?? 0), [0, tokensOf(body(p1), lead)], 'the third is compared with the first, not the failed second: it took out the first\'s lead, and only that');
  } finally { rmSync(raw, { recursive: true, force: true }); }
});

test("a call that names no id takes `toolu_fx` and 16 hex characters hashed from its request's name and its place in the reply: two calls in one reply differ, a request of one name takes the same ids whatever came before it, a run from a checkpoint, whose steps have its own ids, gives none of its build's, and a seed counts no ids", async () => {
  const calls = async (s, canary) => {
    const r = await fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ ...body([user(`user: ${canary} go`)]), stream: false }) });
    assert.equal(r.status, 200);
    return (await r.json()).content.filter((b) => b.type === 'tool_use').map((b) => b.id);
  };
  const call = (n) => ({ name: 'time--now', input: { n } });
  const cp = await startStandin({ configuration: { windowTokens: 50_000 } });
  cp.setStep(step('p', [{ text: '[[c:p.r1]] two calls', calls: [call(1), call(2)] }]));
  const built = await calls(cp, '[[c:p.in]]');
  await cp.close();
  assert.equal(built.length, 2);
  for (const id of built) assert.match(id, /^toolu_fx[0-9a-f]{16}$/);
  assert.notEqual(built[0], built[1]);
  const seed = cp.seed();
  assert.equal('toolIds' in seed, false, 'a seed counts no tool ids');
  const run = await startStandin({ configuration: { windowTokens: 50_000 }, seed });
  const again = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    run.setStep(step('q', [{ text: '[[c:q.r1]] one call', calls: [call(3)] }]));
    const ran = await calls(run, '[[c:q.in]]');
    assert.match(ran[0], /^toolu_fx[0-9a-f]{16}$/);
    assert.equal(built.includes(ran[0]), false, "the run's id isn't its build's");
    again.setStep(step('q', [{ text: '[[c:q.r0]] first', calls: [call(9)] }, { text: '[[c:q.r1]] one call', calls: [call(3)] }]));
    await calls(again, '[[c:q.in]]');
    assert.equal(seed.given.includes(ran[0]), false);
    again.setStep(step('p', [{ text: '[[c:p.r1]] two calls', calls: [call(1), call(2)] }]));
    assert.deepEqual(await calls(again, '[[c:p.in]]'), built, 'a request of the same name takes the same ids, after other requests');
  } finally {
    await run.close();
    await again.close();
  }
});

test("a checkpoint's seed is read whole or refused with what's wrong", () => {
  assert.deepEqual(seedOf('{"dir":"/w/c","lessons":["aaaa1111"],"given":["[[c:a.r1]]","toolu_fx000001"],"contexts":{}}'), { dir: '/w/c', lessons: ['aaaa1111'], given: ['[[c:a.r1]]', 'toolu_fx000001'], contexts: {} });
  assert.throws(() => seedOf('{"dir":"/w/c","lessons":[],"given":[],"contexts":'), /isn't JSON/);
  assert.throws(() => seedOf('{"primary":{"codec":0}}'), /isn't a seed: an object with `dir`, `lessons` \(each a lesson id\), `given` \(each a token its build's answers gave\) and `contexts`/);
  assert.throws(() => seedOf('{"dir":null,"lessons":["aaaa1111",""],"given":[],"contexts":{}}'), /isn't a seed/, 'an empty lesson id, which no lessons file gives');
  for (const given of ['absent', null, '"[[c:a.r1]]"', '[""]', '[3]']) {
    assert.throws(() => seedOf(`{"dir":null,"lessons":[],${given === 'absent' ? '' : `"given":${given},`}"contexts":{}}`), /isn't a seed/, `given ${given}`);
  }
  assert.throws(() => seedOf('{"dir":null,"lessons":[],"given":[],"contexts":{"primary":{"codec":0}}}'), /primary's context isn't a codec index with its parts and withheld parts/);
  const part = { id: '0123456789abcdef', tokens: 10, role: 'user', type: 'text', text: 'hi' };
  assert.ok(seedOf(JSON.stringify({ dir: null, lessons: [], given: [], contexts: { primary: { codec: 0, parts: [part], withheld: [] } } })));
  for (const bad of [{ id: part.id, tokens: 10 }, { ...part, id: 'x' }, { ...part, tokens: -1 }, { ...part, text: 3 }, { ...part, role: null }]) {
    assert.throws(() => seedOf(JSON.stringify({ dir: null, lessons: [], given: [], contexts: { primary: { codec: 0, parts: [bad], withheld: [] } } })), /primary's context/, JSON.stringify(bad));
  }
  for (const codec of [-1, 7, 999]) {
    assert.throws(() => seedOf(JSON.stringify({ dir: null, lessons: [], given: [], contexts: { primary: { codec, parts: [part], withheld: [] } } })), /primary's context/, `codec ${codec}, past the stand-in's seven`);
  }
  assert.ok(seedOf(JSON.stringify({ dir: null, lessons: [], given: [], contexts: { primary: { codec: 6, parts: [part], withheld: [] } } })), 'Bedrock, the last');
});

test("a request's body is frozen as the stand-in parses it, every object and array in it, so nothing that reads it can change it", () => {
  const b = parsedBody(JSON.stringify(body([user('user: [[c:p.in]] hello'), said('noted')])));
  for (const v of [b, b.messages, b.messages[0], b.messages[0].content, b.messages[0].content[0], b.tools[0].input_schema]) assert.ok(Object.isFrozen(v));
  assert.throws(() => { b.messages[0].content[0].text = 'changed'; }, TypeError);
  assert.throws(() => { b.messages.push(user('more')); }, TypeError);
  assert.equal(parsedBody('{"n": 12345678901234567890}').n.rawJSON, '12345678901234567890', 'a large integer is kept as written');
});
