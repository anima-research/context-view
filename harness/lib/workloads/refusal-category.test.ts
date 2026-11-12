// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, refusal, runOf } from './workloads.ts';

const facts = { budget: 100_000, maxTokens: 16_000 };
const scripted = (replies, spare = undefined) => ({ id: 'x.1', segment: 'X', kind: 'text', canaries: ['[[c:x.1.in]]'], replies, ...(spare ? { spare } : {}) });

test('a step can\'t be run where a reply names a refusal category and doesn\'t stop with a refusal, or names a word the Messages API doesn\'t give', () => {
  assert.equal(refusal(scripted([{ stop: 'refusal', category: 'reasoning_extraction' }])), null);
  assert.equal(refusal(scripted([{ stop: 'refusal' }], [{ stop: 'refusal', category: 'cyber' }])), null, 'a spare may name one too');
  assert.match(refusal(scripted([{ text: 'hi', category: 'cyber' }])), /names the refusal category cyber, and stops with its default, not refusal/);
  assert.match(refusal(scripted([{ stop: 'end_turn', category: 'cyber' }])), /stops with end_turn, not refusal/);
  assert.match(refusal(scripted([{ stop: 'refusal' }], [{ text: 'x', category: 'bio' }])), /names the refusal category bio/, 'a spare is read too');
  assert.match(refusal(scripted([{ stop: 'refusal', category: 'chem' }])), /names the refusal category chem, which isn't one of the Messages API's cyber, bio, frontier_llm, reasoning_extraction, general_harms/);
  assert.match(refusal({ ...scripted([]), subs: [{ marker: 'm', as: 'a', replies: [{ stop: 'refusal', category: 'nuclear' }] }] }), /names the refusal category nuclear/, 'a subagent\'s replies are read too');
});

test('a run whose provider gives a refusal no category can\'t name one, in a step\'s reply or in its summariser\'s refusals; Messages and Bedrock runs can', () => {
  const steps = [scripted([{ stop: 'refusal', category: 'reasoning_extraction' }])];
  const workloads = { ...WORKLOADS, Wcat: { from: null, steps: () => steps, check: () => [] } };
  for (const setup of ['H1', 'P3']) assert.equal(runOf(`${setup}/Wcat`, configurations(), facts, { workloads }).steps().length, 1, setup);
  for (const setup of ['P1', 'P2', 'P4', 'P5']) {
    assert.throws(() => runOf(`${setup}/Wcat`, configurations(), facts, { workloads }).steps(), /step x\.1 can't be run: a reply in it names a refusal category, and its run's provider, [a-z-]+, gives a refusal no category/, setup);
    assert.throws(() => runOf(`${setup}/W7/chunk-refused-reasoning-extraction`, configurations(), facts), /its summariser refuses as reasoning_extraction, and its run's provider, [a-z-]+, gives a refusal no category/, setup);
  }
  const unknown = { ...WORKLOADS, Wword: { from: null, standin: () => ({ refusalCategory: 'chem' }), steps: () => [], check: () => [] } };
  assert.throws(() => runOf('H1/Wword', configurations(), facts, { workloads: unknown }), /its summariser refuses as chem, which isn't one of the Messages API's/);
});

test('H1/W7/chunk-refused-reasoning-extraction is chunk-refused under H1 with its summariser\'s refusals named reasoning_extraction', () => {
  const named = runOf('H1/W7/chunk-refused-reasoning-extraction', configurations(), facts);
  const plain = runOf('H1/W7/chunk-refused', configurations(), facts);
  assert.deepEqual(named.standin, { ...plain.standin, refusalCategory: 'reasoning_extraction' });
  assert.equal(Object.hasOwn(plain.standin, 'refusalCategory'), false, 'chunk-refused names none, as before');
  assert.deepEqual(named.configuration, plain.configuration);
  assert.deepEqual(named.owns, plain.owns);
  assert.deepEqual(named.steps().map((s) => [s.kind, s.replies?.length ?? 0, s.mark ?? null]), plain.steps().map((s) => [s.kind, s.replies?.length ?? 0, s.mark ?? null]));
});

test('under Hfold alone W13 has a refusal named reasoning_extraction beside refuse, which meets either fate, with a spare for the re-issue', () => {
  const steps = (setup) => runOf(`${setup}/W13`, configurations(), { ...facts, capabilities: undefined }).steps();
  const fold = steps('Hfold');
  const at = fold.findIndex((s) => s.id.endsWith('.refuse'));
  const named = fold[at + 1];
  assert.ok(named.id.endsWith('.refuse.reasoning-extraction'));
  assert.deepEqual(named.replies, [{ stop: 'refusal', category: 'reasoning_extraction' }]);
  assert.equal(named.spare.length, 1);
  assert.equal(named.fate.refused, 'either');
  assert.deepEqual(named.fate.replayedReceipt, fold[at].fate.receipt, 'a re-issue lands where refuse\'s does');
  for (const setup of ['H1', 'Hretry', 'Hoff']) assert.equal(steps(setup).some((s) => s.id.endsWith('.refuse.reasoning-extraction')), false, setup);
});

test('W16 has a refusal named reasoning_extraction after a turn that answers, so its rewind starts an episode of its own', () => {
  const steps = runOf('H1r/W16', configurations(), { ...facts, capabilities: { 'kept-history': false } }).steps();
  const ids = steps.map((s) => s.id.split('.').slice(1).join('.'));
  const at = ids.indexOf('refuse.reasoning-extraction');
  assert.deepEqual(ids.slice(at - 2, at + 2), ['refuse', 'after', 'refuse.reasoning-extraction', 'after.named']);
  const refusals = steps[at].replies.filter((r) => r.stop === 'refusal');
  assert.deepEqual(refusals, [{ stop: 'refusal', category: 'reasoning_extraction' }]);
  assert.deepEqual(steps[at].replies.length, steps[ids.indexOf('refuse')].replies.length, 'the same shape as refuse: a round, the refusal, the retry\'s answer');
});
