// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { msg, text, call } from '../testing/check-builders.ts';

test('W4 flags a call of its own that goes out without thinking between the call before it and itself, and counts each of its calls', () => {
  const think = { type: 'thinking', chars: 10 };
  const ran = (...blocks) => ({ log: [], records: [{ id: 'r1', kind: 'agent', step: '7.1', messages: [msg('assistant', ...blocks)] }] });
  const led = WORKLOADS.W4.check(ran(think, text(), call('t7_1')), { seed: 7 });
  assert.deepEqual([led.length, led.judged], [0, 1]);
  const bare = WORKLOADS.W4.check(ran(text(), call('t7_1')), { seed: 7 });
  assert.deepEqual(bare.map((f) => f.message), ['request r1: a call went out without its thinking (t7_1)']);
  const after = WORKLOADS.W4.check(ran(call('t7_1'), think), { seed: 7 });
  assert.equal(after.length, 1, 'thinking after the call isn\'t what led to it');
  const other = WORKLOADS.W4.check(ran(text(), call('toolu_fx000001')), { seed: 7 });
  assert.deepEqual([other.length, other.judged], [0, 0], 'a call the workload didn\'t make isn\'t its to judge');
  const merged = WORKLOADS.W4.check(ran(think, call('t7_1'), call('t7_2')), { seed: 7 });
  assert.deepEqual([merged.judged, merged.map((f) => f.message)], [2, ['request r1: a call went out without its thinking (t7_2)']]);
  const both = WORKLOADS.W4.check(ran(think, call('t7_1'), think, call('t7_2')), { seed: 7 });
  assert.deepEqual([both.length, both.judged], [0, 2], 'each call with its own thinking ahead of it');
});
