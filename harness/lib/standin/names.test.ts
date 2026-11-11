// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CHAT, agentBody, post, startStandin, step, summariserBody } from '../testing/standin.ts';

async function named(fn) {
  const rawDir = mkdtempSync(join(tmpdir(), 'names-'));
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
  const events = [];
  const held = [];
  s.onRequest((e) => events.push(e));
  s.onHeld((h) => held.push(h));
  const heldId = async (n = 1) => {
    for (const until = performance.now() + 5000; held.length < n;) {
      if (performance.now() > until) assert.fail(`onHeld named ${held.length} of ${n} held calls within 5 s`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return held[n - 1].id;
  };
  await fn(s, heldId);
  return { records: await s.close(), rawDir, events, held };
}

const RETRY = `${CHAT} If you answer, do not wrap it in <thinking> tags.`;

test('an agent\'s request is named by its step, its agent and its count in that step, and its body and answer files by that name', async () => {
  const { records, rawDir } = await named(async (s) => {
    s.setStep(step('a', [{ text: '[[c:a.r1]] one' }, { text: '[[c:a.r2]] two' }]));
    assert.equal((await post(s.url, agentBody({ canary: '[[c:a.in]]' }))).status, 200);
    assert.equal((await post(s.url, agentBody({ canary: '[[c:a.in]]' }))).status, 200);
  });
  assert.deepEqual(records.map((r) => r.id), ['a.primary.1', 'a.primary.2']);
  assert.deepEqual(readdirSync(rawDir).sort(), ['a.primary.1.answer.json', 'a.primary.1.json', 'a.primary.2.answer.json', 'a.primary.2.json']);
});

test('a summariser call is named by the mark its summary carries', async () => {
  const { records } = await named(async (s) => {
    s.setStep(step('b'));
    assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:b.1]]'] }))).status, 200);
  });
  assert.match(records[0].answer.summary, /^\[\[s:M[0-9a-f]{8}\]\]$/);
  assert.equal(records[0].id, `summariser-${records[0].answer.summary.slice(4, -2)}`);
});

test('a second request with a name already given takes a count, in arrival order', async () => {
  const { records } = await named(async (s) => {
    s.setStep(step('c'));
    for (let i = 0; i < 3; i++) assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:c.1]]'] }))).status, 200);
  });
  const [first] = records.map((r) => r.id);
  assert.deepEqual(records.map((r) => r.id), [first, `${first}-2`, `${first}-3`]);
});

test('a request of another kind is named by its kind and a hash of the fields its kind reads, and the fields read for its name hold no mask number', async () => {
  const epoch = (e) => `[[c:d.1]] [Tune-out reader — Wren, epoch ${e}]`;
  const { records } = await named(async (s) => {
    s.setStep(step('d'));
    for (const body of [summariserBody({ canaries: [epoch('aaaa1111')], instruction: RETRY }), summariserBody({ canaries: [epoch('bbbb2222')], instruction: RETRY }), summariserBody({ canaries: ['[[c:d.2]]'], instruction: RETRY })]) {
      assert.equal((await post(s.url, body)).status, 400);
    }
  });
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified']);
  const [one, two, other] = records.map((r) => r.id);
  assert.match(one, /^unclassified\.[0-9a-f]{12}$/);
  assert.equal(two, `${one}-2`);
  assert.match(other, /^unclassified\.[0-9a-f]{12}$/);
  assert.notEqual(other, one);
});

test('a request with no fields to read is named by its step, its kind and its count in that step', async () => {
  const { records } = await named(async (s) => {
    s.setStep(step('e'));
    for (let i = 0; i < 2; i++) assert.equal((await post(s.url, agentBody({ canary: '[[c:elsewhere.in]]' }))).status, 400);
    s.setStep(step('f'));
    assert.equal((await post(s.url, agentBody({ canary: '[[c:elsewhere.in]]' }))).status, 400);
  });
  assert.deepEqual(records.map((r) => [r.id, r.kind]), [['e.unclassified.1', 'unclassified'], ['e.unclassified.2', 'unclassified'], ['f.unclassified.1', 'unclassified']]);
});

test('a name is a safe file name: a step\'s id and an agent\'s label go into it in a safe form, and its body file is kept in the run\'s directory', async () => {
  const { records, rawDir } = await named(async (s) => {
    s.setStep(step('g/1', [], { subs: [{ as: 'scout/one two~', marker: '[[sub:g]]', canaries: ['[[c:g.task]]'], replies: [{ text: '[[c:g.s1]] a' }] }] }));
    assert.equal((await post(s.url, agentBody({ canary: '[[c:g.task]]', extra: { system: 'You are [[sub:g]].' } }))).status, 200);
  });
  assert.equal(records[0].agent, 'scout/one two~');
  assert.equal(records[0].id, 'g~2f1.scout~2fone~20two~7e.1');
  assert.ok(existsSync(join(rawDir, 'g~2f1.scout~2fone~20two~7e.1.json')));
});

test('the stand-in tells the run each request by its name, and holds and releases a held call by it', async () => {
  const { records, events, held } = await named(async (s, heldId) => {
    s.setStep(step('h', [{ text: '[[c:h.r1]] noted.', settle: true }]));
    const answer = post(s.url, agentBody({ canary: '[[c:h.in]]' }));
    const id = await heldId();
    assert.equal(id, 'h.primary.1');
    assert.equal(s.releaseHeld(id), true);
    assert.equal((await answer).status, 200);
  });
  assert.deepEqual(events.map((e) => e.id), ['h.primary.1']);
  assert.deepEqual(held.map((h) => h.id), ['h.primary.1']);
  assert.equal(records[0].id, 'h.primary.1');
});
