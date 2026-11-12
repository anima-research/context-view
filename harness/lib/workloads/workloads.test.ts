import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { continuation, configurations } from '../strategies/script.ts';
import { RUNS, WORKLOADS, runOf } from './workloads.ts';
import { text } from '../testing/check-builders.ts';
import type { Step } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Breaches } from './fates.ts';
import type { Context } from './workloads.ts';

type Job = ReturnType<typeof runOf>;

test('no workload text a run sends, its checkpoints\' included, names a summary level, so none can be quoted into an L1 instruction the stand-in refuses or miscounts', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true, 'kept-history': true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  const driven = new Set<string>();
  for (let id of RUNS as (string | null)[]) for (; id && !driven.has(id); id = runOf(id, configurations(), facts, lengths).from) driven.add(id);
  assert.ok(driven.has('H1/prefix') && driven.has('H1/W2'), 'the runs\' checkpoint chains are driven too');
  const named = [...driven].flatMap((id) => runOf(id, configurations(), facts, lengths).steps().flatMap((st) => strings(st).filter((t) => /\bL\d+\b/.test(t)).map((t) => `${id} ${st.id}: ${t.match(/\bL\d+\b/)![0]}`)));
  assert.deepEqual(named, []);
});

test('no run that queues a bad summariser answer has a second agent that can compress, its checkpoints\' included, so the agent a re-send is read as re-sending is its own', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const driven = new Set<string>();
  for (let id of RUNS as (string | null)[]) for (; id && !driven.has(id); id = runOf(id, configurations(), facts, lengths).from) driven.add(id);
  const runs = [...driven].map((id) => runOf(id, configurations(), facts, lengths));
  const second = (run: Job) => !([undefined, false] as unknown[]).includes(run.configuration.modules?.subagents) || run.configuration.subconscious?.enabled === true;
  const queues = (run: Job) => run.steps().some((st) => ((st.badAnswers ?? []) as unknown[]).length > 0);
  assert.ok(runs.some(queues) && runs.some(second), 'some run queues bad answers, and some has a second agent');
  assert.ok(runs.some((run) => typeof run.configuration.modules?.subagents === 'object' && second(run)), 'subagents turned on with options count');
  assert.deepEqual(runs.filter((run) => second(run) && queues(run)).map((run) => run.id), []);
});

test('W8 and H4\'s reader let a turn end unanswered from the first cut through two turns after the restore, W11 only between its cut and its restore, and H1/W11\'s scripted 529 makes its step one that retries', () => {
  const steps = (w: keyof typeof WORKLOADS, ctx: Partial<Context>): Step[] => WORKLOADS[w].steps({ seed: 5, budget: 100_000, reserve: 4_000, configuration: {}, ...ctx } satisfies DeepPartial<Context> as unknown as Context);
  const failing = (list: Step[]) => list.filter((s) => s.mayFail).map((s) => s.id);
  assert.deepEqual(failing(steps('W8', { configurationName: 'C6h' })), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => `5.${n}`));
  assert.deepEqual(failing(steps('W11', { configurationName: 'C6h' })), [9, 10, 11, 12].map((n) => `5.${n}`));
  assert.deepEqual(failing(steps('W8', { configurationName: 'H4' })), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((k) => `5.h${k}`), 'H4\'s reader takes W8\'s window');
  const h1 = steps('W11', { configurationName: 'H1' });
  assert.deepEqual(h1.filter((s) => s.retries).map((s) => s.id), ['5.2']);
  assert.ok(!h1.find((s) => s.id === '5.2')!.mayFail, 'the retried turn must still answer');
});

test('a property another check judges names it: the continuation check 2, W7\'s variants but merges-refused and chunk-refused check 1, and W9 check 12', () => {
  assert.equal(WORKLOADS.continuation.check().judgedBy, 2);
  for (const variant of ['merges-rejected', 'fable-no-tools', 'no-tools']) {
    const flags: Breaches = WORKLOADS.W7.check({ log: [], records: [] }, { variant });
    assert.deepEqual([flags.length, flags.judgedBy], [0, 1], variant);
  }
  assert.equal(WORKLOADS.W9.check().judgedBy, 12);
});
