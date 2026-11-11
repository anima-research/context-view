// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentBody, post, startStandin, step, summariserBody } from '../testing/standin.ts';

const epochCall = (canary, epoch) => {
  const body = summariserBody({ canaries: [canary] });
  body.messages.at(-1).content.unshift({ type: 'text', text: `reader/fixture/${epoch}/1: a note` });
  return body;
};
const shownEpoch = (record) => record.texts.find((t) => t.startsWith('reader/fixture/'))?.split('/')[2];

test('a step\'s records number what crosses requests along the step\'s order, not along arrival', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    s.setStep(step('n'));
    assert.equal((await post(s.url, epochCall('[[c:n.2]]', 'bbbbbbbb'))).status, 200);
    assert.equal((await post(s.url, epochCall('[[c:n.1]]', 'aaaaaaaa'))).status, 200);
    const order = s.endStep();
    assert.equal(order.length, 2);
    records = new Map((await s.close()).map((r) => [r.id, r]));
    assert.deepEqual(order.map((id) => shownEpoch(records.get(id))), ['E1', 'E2'], 'the call the order writes first numbers first');
  } finally { if (!records) await s.close(); }
});

test('a step that didn\'t end is ordered and numbered when the stand-in closes', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    s.setStep(step('n'));
    assert.equal((await post(s.url, epochCall('[[c:n.2]]', 'bbbbbbbb'))).status, 200);
    assert.equal((await post(s.url, epochCall('[[c:n.1]]', 'aaaaaaaa'))).status, 200);
  } finally { records = await s.close(); }
  const byCanary = (c) => records.find((r) => r.sent.canaries.includes(c));
  assert.deepEqual([shownEpoch(byCanary('[[c:n.1]]')), shownEpoch(byCanary('[[c:n.2]]'))], ['E1', 'E2']);
});

test('a host line goes before its agent\'s first request that arrived after its stamp, and one with no stamp after its agent\'s last', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let closed = false;
  try {
    s.setStep(step('h', [{ text: '[[c:h.r1]] one' }, { text: '[[c:h.r2]] two' }]));
    assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]' }))).status, 200);
    const between = process.hrtime.bigint();
    assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]' }))).status, 200);
    const order = s.endStep([{ ref: 'c1:7', agent: 'fixture', at: null, needs: [] }, { ref: 'c1:5', agent: 'fixture', at: between, needs: [] }], 'fixture');
    assert.deepEqual(order, ['h.primary.1', 'c1:5', 'h.primary.2', 'c1:7']);
    await s.close();
    closed = true;
  } finally { if (!closed) await s.close(); }
});

const marked = (summaries, at) => {
  const body = summariserBody({ canaries: [`[[c:g.${summaries.length}]]`], summaries });
  body.messages[at].content[0].cache_control = { type: 'ephemeral' };
  return body;
};

test('a step\'s requests whose cache figures rest on their arrival carry what the guard found, in either arrival order', async () => {
  const w = marked(['[[s:M11111111]] '.padEnd(40000, 'x')], 1);
  const r = marked(['[[s:M11111111]] '.padEnd(40000, 'x'), '[[s:M22222222]] '.padEnd(40000, 'y')], 3);
  for (const [first, second, why] of [[w, r, 'markers'], [r, w, 'passed']]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    try {
      s.setStep(step('g'));
      assert.equal((await post(s.url, first)).status, 200);
      assert.equal((await post(s.url, second)).status, 200);
      s.endStep();
    } finally { records = await s.close(); }
    const [rid, wid] = [r, w].map((b) => records.find((x) => x.sent.canaries.includes(b.messages.at(-1).content[0].text.split(' ')[1])).id);
    assert.deepEqual(records.find((x) => x.id === rid).unordered, [{ with: wid, why }], `${why}: ${JSON.stringify(records.map((x) => [x.id, x.usage]))}`);
    assert.equal(records.find((x) => x.id === wid).unordered, undefined);
  }
});
