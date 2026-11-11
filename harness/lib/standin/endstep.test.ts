// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { MERGE, agentBody, judgeBody, post, prose, startStandin, step, summariserBody, textOf } from '../testing/standin.ts';
import { perCheckReport, unmeasuredOfRun } from '../strategies/report.ts';

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

const tiedOrder = async (bodies) => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    s.setStep(step('t'));
    for (const body of bodies) assert.equal((await post(s.url, body)).status, 200);
    const order = s.endStep();
    records = new Map((await s.close()).map((r) => [r.id, r]));
    return order.map((id) => records.get(id));
  } finally { if (!records) await s.close(); }
};

test('two calls of one name that differ only in a reader epoch go in the order the epochs numbered before them give, not by arrival', async () => {
  const known = epochCall('[[c:t.2]]', 'aaaaaaaa');
  const fresh = epochCall('[[c:t.2]]', 'bbbbbbbb');
  for (const later of [[known, fresh], [fresh, known]]) {
    const order = await tiedOrder([epochCall('[[c:t.1]]', 'aaaaaaaa'), ...later]);
    assert.deepEqual(order.map(shownEpoch), ['E1', 'E2', 'E1'], 'the call carrying the epoch not yet numbered is placed first, in both arrival orders');
  }
});

test('two calls of one name that differ only in a Codex key go in the order the keys numbered before them give, not by the keys\' random text', async () => {
  const keyed = (canary, key) => ({ ...summariserBody({ canaries: [canary] }), prompt_cache_key: key });
  const [low, high] = ['00000000-0000-4000-8000-000000000000:000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff:ffffffffffff'];
  const shownKey = (record) => JSON.parse(record.head.rest).prompt_cache_key;
  for (const later of [[keyed('[[c:t.2]]', low), keyed('[[c:t.2]]', high)], [keyed('[[c:t.2]]', high), keyed('[[c:t.2]]', low)]]) {
    const order = await tiedOrder([keyed('[[c:t.1]]', low), ...later]);
    assert.deepEqual(order.map(shownKey), ['<uuid>:<12 hex>#1', '<uuid>:<12 hex>#2', '<uuid>:<12 hex>#1'], 'the call carrying the key not yet numbered is placed first, in both arrival orders');
  }
});

test('two calls of one name that tie in all the order reads stop the run in either arrival order where their bodies differ, naming each other, and not where their bodies are the same', async () => {
  const a = epochCall('[[c:t.2]]', 'aaaaaaaa');
  const b = epochCall('[[c:t.2]]', 'bbbbbbbb');
  for (const bodies of [[a, b], [b, a]]) {
    const order = await tiedOrder(bodies);
    assert.deepEqual(order.map((r) => r.tied), [[order[1].id], [order[0].id]], 'differing bodies, whichever arrived first');
  }
  const same = await tiedOrder([a, a]);
  assert.deepEqual(same.map((r) => r.tied), [undefined, undefined], 'identical bodies write the same record either way');
});

test('where one arm sent such a pair in one order and the other arm in the other, both runs stop, with one note', async () => {
  const report = perCheckReport({ configuration: { name: 'H1/W1' }, candidate: { flags: [], missing: [] } });
  const a = epochCall('[[c:t.2]]', 'aaaaaaaa');
  const b = epochCall('[[c:t.2]]', 'bbbbbbbb');
  const notes = [];
  for (const bodies of [[a, b], [b, a]]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    let order;
    try {
      s.setStep(step('t'));
      for (const body of bodies) assert.equal((await post(s.url, body)).status, 200);
      order = s.endStep();
    } finally { records = await s.close(); }
    notes.push(unmeasuredOfRun(report, { completed: true, records, log: [{ kind: 'order', step: 't', order, ended: true }] }));
  }
  assert.equal(notes[0].length, 1, notes[0].join('\n'));
  assert.match(notes[0][0], /^a record's numbering rests on arrival: requests summariser-M[0-9a-f]{8}#1 and summariser-M[0-9a-f]{8}#2 share a name/);
  assert.deepEqual(notes[1], notes[0]);
});

test('two subagents\' requests that nothing orders, each answered with a call its script gives no id, write the same records, ids and usage in either arrival order, and only their arrival stamps show the reversal', async () => {
  const sub = (as) => ({ as, marker: `[[sub:${as}]]`, canaries: [`[[c:o.${as}]]`], replies: [{ text: `[[c:o.${as}.r1]] looking`, calls: [{ name: 'time--now', input: {} }] }] });
  const body = (as) => agentBody({ canary: `[[c:o.${as}]]`, extra: { system: `You are [[sub:${as}]].` } });
  const drive = async (labels) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    const ids = {};
    try {
      s.setStep(step('o', [], { subs: [sub('a'), sub('b')] }));
      for (const as of labels) {
        const res = await post(s.url, body(as));
        assert.equal(res.status, 200);
        ids[as] = res.json.content.filter((c) => c.type === 'tool_use').map((c) => c.id);
      }
      s.endStep([], 'fixture', new Map(), new Set(['fixture', 'spawn-a-1767690000000', 'spawn-b-1767690000000']));
    } finally { records = await s.close(); }
    return { ids, records: new Map(records.map((r) => [r.id, r])) };
  };
  const [ab, ba] = [await drive(['a', 'b']), await drive(['b', 'a'])];
  assert.deepEqual(ba.ids, ab.ids, 'each call\'s id comes from its own request\'s name');
  assert.equal(ab.ids.a.length, 1);
  assert.notEqual(ab.ids.a[0], ab.ids.b[0]);
  assert.deepEqual([...ab.records.keys()].sort(), ['o.a.1', 'o.b.1'], 'each subagent counts its own requests');
  assert.deepEqual([...ba.records.keys()].sort(), [...ab.records.keys()].sort());
  const arrival = ['arrived', 'seq', 'at', 'clock'];
  const rest = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !arrival.includes(k)));
  for (const [id, r] of ab.records) assert.deepEqual(rest(ba.records.get(id)), rest(r), id);
  const seqOf = (d) => [...d.records.values()].sort((x, y) => x.seq - y.seq).map((r) => r.agent);
  assert.deepEqual([seqOf(ab), seqOf(ba)], [['a', 'b'], ['b', 'a']], 'the raw records keep each drive\'s own arrival');
});

test('one agent\'s requests go in the order they arrived whole, the order its count names them in, though the later one\'s headers came first', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    s.setStep(step('h', [{ text: '[[c:h.r1]] one.' }, { text: '[[c:h.r2]] two.' }]));
    const text = JSON.stringify(agentBody({ canary: '[[c:h.in]]', tail: [{ type: 'text', text: 'the slow one' }] }));
    const slow = request(new URL('/v1/messages', s.url), { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(text) } });
    const answered = new Promise((resolve, reject) => { slow.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); slow.on('error', reject); });
    slow.flushHeaders();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]' }))).status, 200);
    slow.end(text);
    assert.equal(await answered, 200);
    assert.deepEqual(s.endStep(), ['h.primary.1', 'h.primary.2']);
  } finally { records = await s.close(); }
  const [first, second] = ['h.primary.1', 'h.primary.2'].map((id) => records.find((r) => r.id === id));
  assert.ok(BigInt(second.arrived) < BigInt(first.arrived), 'the second\'s headers came first');
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

test('two labelled subagents\' compiles that sent no request go on their own chains, by their labels, whichever the host listed first', async () => {
  const b = { ref: 'c1:1', agent: 'spawn-b-1767690000000', at: null, needs: [] };
  const a = { ref: 'c1:2', agent: 'spawn-a-1767690000000', at: null, needs: [] };
  for (const listed of [[b, a], [a, b]]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let closed = false;
    try {
      s.setStep(step('l', [], { subs: [{ as: 'a', marker: '[[sub:a]]', replies: [] }, { as: 'b', marker: '[[sub:b]]', replies: [] }] }));
      assert.deepEqual(s.endStep(listed, 'fixture'), ['c1:2', 'c1:1'], listed.map((l) => l.ref).join(' '));
      await s.close();
      closed = true;
    } finally { if (!closed) await s.close(); }
  }
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

test('a token an earlier step\'s answer gave too makes no edge, so a pair that only it would order trips in either arrival order', async () => {
  const recalled = ['[[s:M11111111]] '.padEnd(40000, 'x')];
  const w = marked(recalled, 1);
  const earlier = summariserBody({ canaries: ['[[c:g.1]]'], summaries: recalled, textChars: 300 });
  const markOf = (res) => JSON.stringify(res.json).match(/\[\[s:M[0-9a-f]{8}\]\]/)?.[0];
  for (const [order, why] of [['wr', 'markers'], ['rw', 'passed']]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    try {
      s.setStep(step('e'));
      const mark = markOf(await post(s.url, earlier));
      assert.ok(mark, 'the earlier step\'s summary carries its mark');
      s.endStep();
      const r = marked([...recalled, '[[s:M22222222]] '.padEnd(40000, 'y')], 3);
      r.messages.at(-1).content.splice(-1, 0, { type: 'text', text: `quoting ${mark}` });
      s.setStep(step('g'));
      for (const b of order === 'wr' ? [w, r] : [r, w]) {
        const res = await post(s.url, b);
        assert.equal(res.status, 200);
        if (b === w) assert.equal(markOf(res), mark, 'the step\'s writer gives the same mark again');
      }
      s.endStep();
    } finally { records = await s.close(); }
    const inStep = records.filter((x) => x.step === 'g');
    const [rid, wid] = ['[[c:g.2]]', '[[c:g.1]]'].map((c) => inStep.find((x) => x.sent.canaries.includes(c)).id);
    assert.deepEqual(inStep.find((x) => x.id === rid).unordered, [{ with: wid, why }], order);
  }
});

test('a request that carries what an earlier answer of its step gave is placed after that answer\'s request, by the token the stand-in traced through the server', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let order;
  let records;
  try {
    s.setStep(step('t'));
    const mark = textOf((await post(s.url, summariserBody({ canaries: ['[[c:t.1]]'] }))).json).match(/\[\[s:M[0-9a-f]{8}\]\]/)[0];
    assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:t.2]]'], summaries: [mark], instruction: MERGE }))).status, 200);
    order = s.endStep([], 'fixture');
  } finally { records = await s.close(); }
  const idOf = (canary) => records.find((r) => r.sent?.canaries?.includes(canary)).id;
  assert.deepEqual(order, [idOf('[[c:t.1]]'), idOf('[[c:t.2]]')]);
});

test('an answer held past its step\'s end and released in the next step gives there: a later request carrying its token is traced', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    const held = [];
    s.onHeld((h) => held.push(h));
    s.setStep(step('a', [{ text: '[[c:a.r1]] held', hold: true }]));
    const first = post(s.url, agentBody({ canary: '[[c:a.in]]', stream: false }));
    for (const until = performance.now() + 5000; held.length < 1;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    s.endStep([], 'fixture');
    s.setStep(step('b', [{ text: '[[c:b.r1]] after' }]));
    s.releaseHeld(held[0].id);
    assert.equal((await first).status, 200);
    assert.equal((await post(s.url, agentBody({ canary: '[[c:b.in]]', tail: [{ type: 'text', text: 'quoting [[c:a.r1]]' }] }))).status, 200);
    s.endStep([], 'fixture');
  } finally { records = await s.close(); }
  assert.ok(s.seed().given.includes('[[c:a.r1]]'), 'the answer released in the next step gave its token');
  assert.deepEqual(records.filter((r) => r.untraced).map((r) => [r.id, r.untraced]), []);
  assert.ok(records.some((r) => r.step === 'b' && r.kind === 'agent' && JSON.stringify(r.messages ?? r).includes('[[c:a.r1]]')), 'the later request carried the held answer\'s token');
});

test('two judge calls of one rule in a step that meet in one cache trip as `alike`, the later arriving after the earlier\'s answer ended or while it was held: nothing orders one rule\'s judges', async () => {
  const document = `user: # fixture's context\n\n## Conversation (oldest shown first)\n\n[user] Tavy: [[c:old.in]] [[wake]] ${prose(6000, 2)}\n\n`;
  const drive = async (overlap) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    try {
      const held = [];
      s.onHeld((h) => held.push(h));
      s.setStep({ ...step('j'), ...(overlap ? { judgeHold: { during: [] } } : {}) });
      const first = post(s.url, judgeBody({ document, events: [`[[c:j.1.in]] ${overlap ? '[[judge-holds]] ' : ''}Tavy asks`] }));
      if (overlap) {
        for (const until = performance.now() + 5000; held.length < 1;) {
          if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } else assert.equal((await first).status, 200);
      assert.equal((await post(s.url, judgeBody({ document, events: ['[[c:j.2.in]] Ash asks'] }))).status, 200);
      if (overlap) { s.releaseHeld(held[0].id); assert.equal((await first).status, 200); }
      s.endStep([], 'fixture', new Map(), new Set(['fixture']));
    } finally { records = await s.close(); }
    const judges = records.filter((r) => r.kind === 'judge');
    assert.equal(judges.length, 2);
    const named = (id) => (id === judges[0].id ? 'first' : 'second');
    return judges.flatMap((r) => (r.unordered ?? []).map((u) => [...[named(r.id), named(u.with)].sort(), u.why]));
  };
  assert.deepEqual(await drive(false), [['first', 'second', 'alike']], 'one after the other');
  assert.deepEqual(await drive(true), [['first', 'second', 'alike']], 'the later arriving while the earlier was held, whichever of the two read the other\'s entry');
});

test('two summariser calls of one manager are not ordered where the later arrived while the earlier\'s answer was held, so before it ended, and the pair trips', async () => {
  const w = marked(['[[s:M11111111]] '.padEnd(40000, 'x')], 1);
  const r = marked(['[[s:M11111111]] '.padEnd(40000, 'x'), '[[s:M22222222]] '.padEnd(40000, 'y')], 3);
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records;
  try {
    const held = [];
    s.onHeld((h) => held.push(h));
    s.setStep(step('g', [], { summariserHold: { level: 1, during: [] } }));
    const first = post(s.url, w);
    for (const until = performance.now() + 5000; held.length < 1;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await post(s.url, r)).status, 200, 'the later call is answered while the earlier is held');
    s.releaseHeld(held[0].id);
    assert.equal((await first).status, 200);
    s.endStep([], 'fixture', new Map(), new Set(['fixture']));
  } finally { records = await s.close(); }
  const [rid, wid] = [r, w].map((b) => records.find((x) => x.kind === 'summariser' && x.sent.canaries.includes(b.messages.at(-1).content[0].text.split(' ')[1])).id);
  assert.deepEqual(records.find((x) => x.id === rid).unordered, [{ with: wid, why: 'passed' }], 'the held answer wrote its entry after the later call\'s look-back passed it');
});

test('two summariser calls of a step are ordered when only the primary\'s manager can have sent them and the later arrived after the earlier\'s answer, and not once another agent has acted in the run', async () => {
  const w = marked(['[[s:M11111111]] '.padEnd(40000, 'x')], 1);
  const r = marked(['[[s:M11111111]] '.padEnd(40000, 'x'), '[[s:M22222222]] '.padEnd(40000, 'y')], 3);
  const found = async (managers, subFirst = false) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    let records;
    try {
      if (subFirst) {
        s.setStep(step('a', [], { subs: [{ as: 'scout', marker: '[[sub:a]]', canaries: ['[[c:a.task]]'], replies: [{ text: '[[c:a.s1]] a' }] }] }));
        assert.equal((await post(s.url, agentBody({ canary: '[[c:a.task]]', extra: { system: 'You are [[sub:a]].' } }))).status, 200);
        s.endStep([], 'fixture', new Map(), new Set(['fixture']));
      }
      s.setStep(step('g'));
      assert.equal((await post(s.url, w)).status, 200);
      assert.equal((await post(s.url, r)).status, 200);
      s.endStep([], 'fixture', new Map(), managers);
    } finally { records = await s.close(); }
    const [rid, wid] = [r, w].map((b) => records.find((x) => x.kind === 'summariser' && x.sent.canaries.includes(b.messages.at(-1).content[0].text.split(' ')[1])).id);
    return [records.find((x) => x.id === rid).unordered, wid];
  };
  assert.equal((await found(new Set(['fixture'])))[0], undefined);
  const [two, wid] = await found(new Set(['fixture', 'spawn-scout-1']));
  assert.deepEqual(two, [{ with: wid, why: 'markers' }], 'another agent compiled or started');
  const [sub, wid2] = await found(new Set(['fixture']), true);
  assert.deepEqual(sub, [{ with: wid2, why: 'markers' }], 'a subagent sent a request earlier in the run');
});
