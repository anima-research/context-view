import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { RUNS, refusal, runOf } from './workloads.ts';
import type { Step } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';

const sub = (as?: string) => ({ ...(as === undefined ? {} : { as }), marker: `[[sub:${as}]]`, replies: [] });
const advance = (ms: number, more: DeepPartial<Step> = {}) => ({ id: 's', kind: 'advance', ms, ...more }) satisfies DeepPartial<Step> as unknown as Step;

test('a step that starts two or more subagents is refused unless each has a label of its own; one subagent needs none; no subagent is labelled primary', () => {
  assert.equal(refusal({ id: 's', subs: [sub()] } satisfies DeepPartial<Step> as unknown as Step), null);
  assert.equal(refusal({ id: 's', subs: [sub('a'), sub('b')] } satisfies DeepPartial<Step> as unknown as Step), null);
  assert.match(refusal({ id: 's', subs: [sub('a'), sub()] } satisfies DeepPartial<Step> as unknown as Step)!, /tells two apart only by a label each \(a, none\)/);
  assert.match(refusal({ id: 's', subs: [sub(), sub()] } satisfies DeepPartial<Step> as unknown as Step)!, /2 subagents/);
  assert.match(refusal({ id: 's', subs: [sub('a'), sub('a')] } satisfies DeepPartial<Step> as unknown as Step)!, /\(a, a\)/);
  assert.match(refusal({ id: 's', subs: [sub('primary')] } satisfies DeepPartial<Step> as unknown as Step)!, /labels a subagent primary/);
});

test('a subagent\'s label is refused where it is a name the stand-in gives requests of its own, a request kind or `sub`, or holds a dot, since a name joins a step, a label and a count with dots', () => {
  for (const label of ['probe', 'summariser', 'agent', 'judge', 'naming', 'keepalive', 'unclassified', 'sub']) assert.match(refusal({ id: 's', subs: [sub(label)] } satisfies DeepPartial<Step> as unknown as Step)!, new RegExp(`labels a subagent ${label}, a name the stand-in gives requests of its own`), label);
  assert.match(refusal({ id: 's', subs: [sub('b.c')] } satisfies DeepPartial<Step> as unknown as Step)!, /labels a subagent b\.c, and a dot in a label would make two names one/);
  for (const label of ['scout', 'probe-2', 'sub1', 'a_b']) assert.equal(refusal({ id: 's', subs: [sub(label)] } satisfies DeepPartial<Step> as unknown as Step), null, label);
});

test('a clock move under 30 s is refused where the script waits on what it starts, a step with scripted replies of its own or a subagent\'s, a judge\'s verdict, before or after its turn, a review or a gate to expect, or a move inside a hold; a short move that waits on nothing is not, nor data a call sends', () => {
  assert.equal(refusal(advance(2_000)), null, 'W12\'s ws.later: it moves the host\'s Date past the gate\'s once-a-second reread');
  assert.equal(refusal(advance(2_000, { subs: [sub('a')] })), null, 'a subagent with no reply scripted');
  for (const more of [{ replies: [{ text: 'x' }] }, { spare: [{ text: 'x' }] }, { subs: [{ ...sub('a'), replies: [{ text: 'x' }] }] }, { subs: [{ ...sub('a'), spare: [{ text: 'x' }] }] }, { verdict: 'w12-judge' }, { verdictAfterTurn: 'w12-quick' }, { review: true }, { gate: { expect: 'batch' } }] satisfies DeepPartial<Step>[]) {
    assert.match(refusal(advance(29_999, more))!, /moves the clock 29999 ms and waits on what that starts/, JSON.stringify(more));
    assert.equal(refusal(advance(30_000, more)), null, JSON.stringify(more));
  }
  assert.match(refusal({ id: 's', kind: 'deliver', replies: [{ hold: true, during: [{ deliver: {} }, { advance: 2_000 }] }] } satisfies DeepPartial<Step> as unknown as Step)!, /a hold in it moves the clock 2000 ms/);
  assert.match(refusal({ id: 's', subs: [{ as: 'a', replies: [{ calls: [{ name: 't', input: {}, during: [{ advance: 1_000 }] }] }] }] } satisfies DeepPartial<Step> as unknown as Step)!, /1000 ms/);
  assert.match(refusal({ id: 's', summariserHold: { level: 1, during: [{ advance: 5 }] } } satisfies DeepPartial<Step> as unknown as Step)!, /5 ms/);
  assert.equal(refusal({ id: 's', replies: [{ hold: true, during: [{ advance: 31_000 }] }] } satisfies DeepPartial<Step> as unknown as Step), null);
  assert.equal(refusal({ id: 's', replies: [{ calls: [{ name: 't', input: { during: [{ advance: 1_000 }] } }] }] } satisfies DeepPartial<Step> as unknown as Step), null, 'a call\'s input is data the tool reads, not a hold\'s acts');
});

test('every view run builds, refused nowhere, whether its host brings each capability or none', () => {
  const all = configurations();
  const every = (has: boolean) => new Proxy({}, { get: (_, name) => (name === 'unreadable' ? undefined : has) });
  for (const has of [true, false]) {
    for (const id of RUNS) assert.ok(runOf(id, all, { capabilities: every(has) }).steps().length > 0, `${id} with every capability ${has}`);
  }
});
