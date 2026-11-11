// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNS, WORKLOADS } from './workloads.ts';
import { msg, text, carrying, store, sent } from '../testing/check-builders.ts';

test('W18 starts from its setup\'s W2 store and holds the second turn\'s first L1 request while the slice\'s first message is removed, then answers it empty; it flags each request that arrives after the removal lands carrying a removed canary, agent or summariser, and can\'t judge a removal that didn\'t land before the release or had no request after it', () => {
  assert.equal(WORKLOADS.W18.from, 'checkpoint');
  assert.ok(RUNS.includes('H1/W18'));
  const ctx = { seed: 7 };
  const steps = WORKLOADS.W18.steps(ctx);
  assert.deepEqual(steps.map((s) => s.id), ['7.1', '7.2', '7.3']);
  assert.deepEqual(steps[1].summariserHold, { level: 1, during: [{ remove: { messages: [{ fromHeld: 0 }] } }] });
  assert.deepEqual(steps[1].badAnswers, ['empty']);
  const [A, B] = ['[[c:w2.68.in]]', '[[c:w2.68.r1]]'];
  const agent = (id, step, canaries) => ({ id, kind: 'agent', step, messages: [msg('user', text(canaries))] });
  const summariser = (id, canaries) => ({ id, kind: 'summariser', step: '7.2', sent: { canaries } });
  const requested = (r) => ({ step: r.step, kind: 'request', request: { id: r.id } });
  const ran = ({ before = [], removal = true, release = 'after', between = [], after, agentHold = false, send = true, twice = false }) => {
    const held = summariser('r5', [A, B]);
    const log = [...before.map(requested), requested(held), ...(agentHold ? [{ step: '7.2', kind: 'send', via: 'release', canary: '[[c:7.2.call1]]' }] : [])];
    const landed = { step: '7.2', kind: 'remove', messageIds: ['1566'], canaries: [A], during: 'r5' };
    const released = { step: '7.2', kind: 'send', via: 'release', request: 'r5' };
    const sending = { step: '7.2', kind: 'send', via: 'module', op: 'remove', messageIds: ['1566'], during: 'r5' };
    if (removal && release === 'after') log.push(...(send ? [sending] : []), ...between.map(requested), landed, ...(twice ? [sending, landed] : []), released);
    else if (removal) log.push(released, sending, landed);
    else log.push(released);
    log.push(...after.map(requested));
    return WORKLOADS.W18.check({ records: [...before, held, ...between, ...after], log }, ctx);
  };
  const said = (fs) => fs.map((f) => [f.step, f.message]);
  const head = ran({ before: [agent('r3', '7.2', [A])], after: [summariser('r6', [B]), agent('r7', '7.3', [B])] });
  assert.deepEqual([head.length, head.judged], [0, 1], 'requests before the removal, the held one among them, may carry it');
  assert.deepEqual(said(ran({ after: [summariser('r6', [A, B]), agent('r7', '7.3', [B])] })), [['7.2', 'request r6, which arrived after the removal at 7.2 landed, carries [[c:w2.68.in]]']]);
  assert.deepEqual(said(ran({ after: [summariser('r6', [B]), agent('r7', '7.3', [B, A])] })), [['7.3', 'request r7, which arrived after the removal at 7.2 landed, carries [[c:w2.68.in]]']]);
  const unjudged = (r) => [r.judged, said(r)];
  assert.deepEqual(unjudged(ran({ removal: false, after: [summariser('r6', [A])] })), [0, [['7.2', 'couldn\'t judge: no removal landed while the step\'s summariser request was held']]]);
  assert.deepEqual(unjudged(ran({ release: 'before', after: [summariser('r6', [A])] })), [0, [['7.2', 'couldn\'t judge: no removal landed while the step\'s summariser request was held']]]);
  assert.deepEqual(unjudged(ran({ after: [] })), [0, [['7.2', 'couldn\'t judge: no request came after the removal landed']]]);
  assert.deepEqual(unjudged(ran({ agentHold: true, after: [summariser('r6', [B])] })), [1, []], 'an agent hold\'s release at the same step, before the removal, isn\'t the held summariser request\'s');
  assert.deepEqual(unjudged(ran({ between: [agent('r6', '7.2', [B])], after: [summariser('r7', [B])] })), [0, [['7.2', 'couldn\'t judge: request r6 arrived while the removal was being made, between the driver\'s remove and its answer, so whether it was built before the removal or after can\'t be told']]], 'a request inside the removal\'s window fails closed, whatever it carries');
  assert.deepEqual(unjudged(ran({ between: [agent('r6', '7.2', [B])], after: [summariser('r7', [A])] })), [0, [['7.2', 'couldn\'t judge: request r6 arrived while the removal was being made, between the driver\'s remove and its answer, so whether it was built before the removal or after can\'t be told'], ['7.2', 'request r7, which arrived after the removal at 7.2 landed, carries [[c:w2.68.in]]']]], 'and a request after the removal\'s answer is still judged, so a leak there still flags');
  assert.deepEqual(unjudged(ran({ send: false, after: [summariser('r6', [B])] })), [0, [['7.2', 'couldn\'t judge: the removal\'s send isn\'t in the log']]]);
  assert.deepEqual(unjudged(ran({ twice: true, after: [summariser('r6', [B])] })), [0, [['7.2', 'couldn\'t judge: the step made 2 removals, and W18 judges a step\'s one removal']]]);
});
