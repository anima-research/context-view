// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { text } from '../testing/check-builders.ts';

test('W9 rolls the record back with /branchto to turn 18\'s last reply, after turn 19 and its restart and before turn 20, and no step after it names a turn-19 message', () => {
  const steps = WORKLOADS.W9.steps({ seed: 5, budget: 100_000, reserve: 4_000, configuration: {}, configurationName: 'H1' });
  const ids = steps.map((s) => s.id);
  const at = ids.indexOf('5.19.branchto');
  assert.deepEqual(ids.slice(at - 1, at + 2), ['5.19.head', '5.19.branchto', '5.20']);
  const step = steps[at];
  assert.equal(step.kind, 'command');
  const named = /^\/branchto (\[\[c:[^\]\s]+\]\])$/.exec(step.command)?.[1];
  const eighteen = steps.find((s) => s.id === '5.18');
  assert.ok(named && eighteen.replies.at(-1).text.startsWith(named), 'it names turn 18\'s last reply by its canary');
  assert.equal(step.reads?.[0]?.op, 'dry-compile');
  const nineteen = steps.find((s) => s.id === '5.19');
  const nineteens = new Set([...nineteen.canaries, ...nineteen.replies.map((r) => /^\[\[c:[^\]\s]+\]\]/.exec(r.text)[0])]);
  assert.ok(!JSON.stringify(steps.slice(at)).match(/\[\[c:[^\]\s]+\]\]/g)?.some((c) => nineteens.has(c)), 'no later step names a turn-19 message');
});
