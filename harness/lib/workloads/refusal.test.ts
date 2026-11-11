// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { RUNS, refusal, runOf } from './workloads.ts';

const sub = (as) => ({ ...(as === undefined ? {} : { as }), marker: `[[sub:${as}]]`, replies: [] });
const advance = (ms, more = {}) => ({ id: 's', kind: 'advance', ms, ...more });

test('a step that starts two or more subagents is refused unless each has a label of its own; one subagent needs none', () => {
  assert.equal(refusal({ id: 's', subs: [sub()] }), null);
  assert.equal(refusal({ id: 's', subs: [sub('a'), sub('b')] }), null);
  assert.match(refusal({ id: 's', subs: [sub('a'), sub()] }), /tells two apart only by a label each \(a, none\)/);
  assert.match(refusal({ id: 's', subs: [sub(), sub()] }), /2 subagents/);
  assert.match(refusal({ id: 's', subs: [sub('a'), sub('a')] }), /\(a, a\)/);
});

test('a clock move under 30 s is refused where the script waits on what it starts, a step with scripted replies of its own or a subagent\'s, a judge\'s verdict, a review or a gate to expect, or a move inside a hold; a short move that waits on nothing is not', () => {
  assert.equal(refusal(advance(2_000)), null, 'W12\'s ws.later: it moves the host\'s Date past the gate\'s once-a-second reread');
  assert.equal(refusal(advance(2_000, { subs: [sub('a')] })), null, 'a subagent with no reply scripted');
  for (const more of [{ replies: [{ text: 'x' }] }, { spare: [{ text: 'x' }] }, { subs: [{ ...sub('a'), replies: [{ text: 'x' }] }] }, { subs: [{ ...sub('a'), spare: [{ text: 'x' }] }] }, { verdict: 'w12-judge' }, { review: true }, { gate: { expect: 'batch' } }]) {
    assert.match(refusal(advance(29_999, more)), /moves the clock 29999 ms and waits on what that starts/, JSON.stringify(more));
    assert.equal(refusal(advance(30_000, more)), null, JSON.stringify(more));
  }
  assert.match(refusal({ id: 's', kind: 'deliver', replies: [{ hold: true, during: [{ deliver: {} }, { advance: 2_000 }] }] }), /a hold in it moves the clock 2000 ms/);
  assert.match(refusal({ id: 's', subs: [{ as: 'a', replies: [{ calls: [{ name: 't', input: {}, during: [{ advance: 1_000 }] }] }] }] }), /1000 ms/);
  assert.match(refusal({ id: 's', summariserHold: { level: 1, during: [{ advance: 5 }] } }), /5 ms/);
  assert.equal(refusal({ id: 's', replies: [{ hold: true, during: [{ advance: 31_000 }] }] }), null);
});

test('every view run that needs no host facts builds, refused nowhere', () => {
  const all = configurations();
  let built = 0;
  for (const id of RUNS) {
    let job;
    try { job = runOf(id, all, {}); } catch { continue; }
    let steps;
    try { steps = job.steps(); } catch (e) {
      if (/can't be run/.test(e.message)) assert.fail(`${id}: ${e.message}`);
      continue;
    }
    built += steps.length > 0 ? 1 : 0;
  }
  assert.ok(built > 60, `${built} runs built`);
});
