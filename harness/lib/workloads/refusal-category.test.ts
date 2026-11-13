import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, refusal, runOf } from './workloads.ts';
import type { Reply } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Context, Workload } from './workloads.ts';
import type { W13Step } from './w13.ts';

const facts = { budget: 100_000, maxTokens: 16_000 };
const scripted = (replies: Reply[], spare: Reply[] | undefined = undefined) => ({ id: 'x.1', segment: 'X', kind: 'channel', canaries: ['[[c:x.1.in]]'], replies, ...(spare ? { spare } : {}) });

test('a step can\'t be run where a reply names a refusal category and doesn\'t stop with a refusal, or names a word the Messages API doesn\'t give', () => {
  assert.equal(refusal(scripted([{ stop: 'refusal', category: 'reasoning_extraction' }])), null);
  assert.equal(refusal(scripted([{ stop: 'refusal' }], [{ stop: 'refusal', category: 'cyber' }])), null, 'a spare may name one too');
  assert.match(refusal(scripted([{ text: 'hi', category: 'cyber' }]))!, /names the refusal category cyber, and stops with its default, not refusal/);
  assert.match(refusal(scripted([{ stop: 'end_turn', category: 'cyber' }]))!, /stops with end_turn, not refusal/);
  assert.match(refusal(scripted([{ stop: 'refusal' }], [{ text: 'x', category: 'bio' }]))!, /names the refusal category bio/, 'a spare is read too');
  assert.match(refusal(scripted([{ stop: 'refusal', category: 'chem' }]))!, /names the refusal category chem, which isn't one of the Messages API's cyber, bio, frontier_llm, reasoning_extraction, general_harms/);
  assert.match(refusal({ ...scripted([]), subs: [{ marker: 'm', as: 'a', replies: [{ stop: 'refusal', category: 'nuclear' }] }] })!, /names the refusal category nuclear/, 'a subagent\'s replies are read too');
});

test('a run whose provider gives a refusal no category can\'t name one, in a step\'s reply or in its summariser\'s refusals; Messages and Bedrock runs can', () => {
  const steps = [scripted([{ stop: 'refusal', category: 'reasoning_extraction' }])];
  const workloads = { ...WORKLOADS, Wcat: { from: null, steps: () => steps, check: () => [] } satisfies DeepPartial<Workload> as unknown as Workload };
  for (const setup of ['H1', 'P3']) assert.equal(runOf(`${setup}/Wcat`, configurations(), facts, { workloads }).steps().length, 1, setup);
  for (const setup of ['P1', 'P2', 'P4', 'P5']) {
    assert.throws(() => runOf(`${setup}/Wcat`, configurations(), facts, { workloads }).steps(), /step x\.1 can't be run: a reply in it names a refusal category, and its run's provider, [a-z-]+, gives a refusal no category/, setup);
    assert.throws(() => runOf(`${setup}/W7/chunk-refused-reasoning-extraction`, configurations(), facts), /its summariser refuses as reasoning_extraction, and its run's provider, [a-z-]+, gives a refusal no category/, setup);
  }
  const unknown = { ...WORKLOADS, Wword: { from: null, standin: () => ({ refusalCategory: 'chem' }), steps: () => [], check: () => [] } satisfies DeepPartial<Workload> as unknown as Workload };
  assert.throws(() => runOf('H1/Wword', configurations(), facts, { workloads: unknown }), /its summariser refuses as chem, which isn't one of the Messages API's/);
});

test('H1/W7/chunk-refused-reasoning-extraction is chunk-refused under H1 with its summariser\'s refusals named reasoning_extraction', () => {
  const named = runOf('H1/W7/chunk-refused-reasoning-extraction', configurations(), facts);
  const plain = runOf('H1/W7/chunk-refused', configurations(), facts);
  assert.deepEqual(named.standin, { ...plain.standin, refusalCategory: 'reasoning_extraction' });
  assert.equal(Object.hasOwn(plain.standin, 'refusalCategory'), false, 'chunk-refused names none, as before');
  assert.deepEqual(named.configuration, plain.configuration);
  assert.deepEqual(named.owns, plain.owns);
  const steps = (variant: string) => WORKLOADS.W7.steps({ seed: 7, variant, configurationName: 'H1' } satisfies DeepPartial<Context> as unknown as Context);
  const json = (list: unknown) => JSON.stringify(list, (k, v) => (typeof v === 'function' ? String(v) : v));
  const extra = steps('chunk-refused-reasoning-extraction').filter((s) => s.kind === 'advance');
  assert.equal(json(steps('chunk-refused-reasoning-extraction').filter((s) => s.kind !== 'advance')), json(steps('chunk-refused')), 'but for its advance, its steps are chunk-refused\'s whole, at one seed: its call ids, its suppressions and its replies');
  assert.equal(steps('chunk-refused').some((s) => s.kind === 'advance'), false, 'chunk-refused moves no clock, as before');
  assert.equal(extra.length, 1);
});

test('H1/W7/chunk-refused-reasoning-extraction moves the clock past a pause\'s first backoff, 5 s, after the turn that runs under it, by a bare advance under 30 s', () => {
  const steps = WORKLOADS.W7.steps({ seed: 7, variant: 'chunk-refused-reasoning-extraction', configurationName: 'H1' } satisfies DeepPartial<Context> as unknown as Context);
  const at = steps.findIndex((s) => s.kind === 'advance');
  assert.equal(steps[at - 1].id, '7.14', 'after turn 14, the first turn under the pause turn 13\'s refusal starts');
  const advance = steps[at];
  assert.ok(advance.ms! > 5_000 && advance.ms! < 30_000, `${advance.ms} ms`);
  assert.deepEqual(Object.keys(advance).sort(), ['id', 'kind', 'ms', 'segment']);
  assert.equal(refusal(advance), null, 'no rule refuses it');
  assert.equal(steps.slice(at + 1).filter((s) => s.kind !== 'suppress').length, 7, 'turns 15 to 21 follow it');
  assert.equal(runOf('H1/W7/chunk-refused-reasoning-extraction', configurations(), facts).steps().some((s) => s.kind === 'advance'), true, 'and the run builds with it');
});

test('under Hfold alone W13 has a refusal named reasoning_extraction beside refuse, which meets either fate, with a spare for the re-issue', () => {
  const steps = (setup: string) => runOf(`${setup}/W13`, configurations(), { ...facts, capabilities: undefined }).steps();
  const fold = steps('Hfold');
  const at = fold.findIndex((s) => s.id.endsWith('.refuse'));
  const named = fold[at + 1];
  assert.ok(named.id.endsWith('.refuse.reasoning-extraction'));
  assert.deepEqual(named.replies, [{ stop: 'refusal', category: 'reasoning_extraction' }]);
  assert.equal(named.spare!.length, 1);
  assert.equal((named as W13Step).fate!.refused, 'either');
  assert.equal(named.ends, 'either', 'its turn may end spoken or unspoken, and the driver waits for either');
  assert.deepEqual((named as W13Step).fate!.replayedReceipt, (fold[at] as W13Step).fate!.receipt, 'a re-issue lands where refuse\'s does');
  for (const setup of ['H1', 'Hretry', 'Hoff']) assert.equal(steps(setup).some((s) => s.id.endsWith('.refuse.reasoning-extraction')), false, setup);
});

test('W16 has a refusal named reasoning_extraction after a turn that answers, so its rewind starts an episode of its own', () => {
  const steps = runOf('H1r/W16', configurations(), { ...facts, capabilities: { 'kept-history': false } }).steps();
  const ids = steps.map((s) => s.id.split('.').slice(1).join('.'));
  const at = ids.indexOf('refuse.reasoning-extraction');
  assert.deepEqual(ids.slice(at - 2, at + 2), ['refuse', 'after', 'refuse.reasoning-extraction', 'after.named']);
  const refusals = steps[at].replies!.filter((r) => r.stop === 'refusal');
  assert.deepEqual(refusals, [{ stop: 'refusal', category: 'reasoning_extraction' }]);
  assert.deepEqual(steps[at].replies!.length, steps[ids.indexOf('refuse')].replies!.length, 'the same shape as refuse: a round, the refusal, the retry\'s answer');
});
