// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNS, WORKLOADS } from './workloads.ts';
import { msg, text, call } from '../testing/check-builders.ts';

test('W19 runs on H6 alone, from empty: a round of words and a call, then a 400, a 529 once and a console turn\'s 400; it flags a request after the failure that carries no [speech-not-posted] notice after the round\'s call, and the round\'s words posted', () => {
  assert.equal(WORKLOADS.W19.from, null);
  assert.ok(RUNS.includes('H6/W19'));
  assert.deepEqual(RUNS.filter((r) => r.endsWith('/W19')), ['H6/W19']);
  const ctx = { seed: 7 };
  const steps = WORKLOADS.W19.steps(ctx);
  assert.deepEqual(steps.map((s) => [s.id, s.kind]), [['7.1', 'channel'], ['7.fail', 'channel'], ['7.told', 'channel'], ['7.retry', 'channel'], ['7.after', 'channel'], ['7.private', 'console'], ['7.last', 'channel']]);
  const shape = (r) => (r.error ? `E${r.error.status}${r.error.headers ? 'h' : ''}` : r.calls?.length ? 'call' : 'text');
  assert.deepEqual(steps.map((s) => s.replies.map(shape).join('+')), ['text', 'call+E400', 'text', 'call+E529+text', 'text', 'call+E400', 'text']);
  const by = Object.fromEntries(steps.map((s) => [s.id.slice(2), s]));
  assert.deepEqual([by.fail.mayFail, by.retry.retries, by.private.mayFail, by.private.addressed], [true, true, true, false]);
  assert.deepEqual(by.fail.w19, { call: '[[c:7.fail.call1]]', round: '[[c:7.fail.r1]]' });
  assert.deepEqual(Object.keys(by).filter((k) => by[k].w19), ['fail', 'retry', 'private']);
  const NOTICE = '[speech-not-posted]';
  const prefill = (id, step, marks, answer) => ({ id, seq: Number(id.slice(1)), kind: 'agent', step, messages: [msg('assistant', { type: 'text', chars: 10, xmlMarks: marks })], ...(answer ? { answer } : {}) });
  const error = { shape: 'error', status: 400 };
  const c = (step, part) => `[[c:7.${step}.${part}]]`;
  const records = ({ fail = [c('fail', 'call1'), NOTICE, c('told', 'in')], retry = [c('retry', 'call1'), NOTICE], priv = [c('private', 'call1'), NOTICE, c('last', 'in')] } = {}) => [
    prefill('r1', '7.fail', [c('fail', 'in')]), prefill('r2', '7.fail', [c('fail', 'r1'), c('fail', 'call1')], error), prefill('r3', '7.told', fail),
    prefill('r4', '7.retry', [c('retry', 'in')]), prefill('r5', '7.retry', [c('retry', 'r1'), c('retry', 'call1')], { shape: 'error', status: 529 }), prefill('r6', '7.retry', retry),
    prefill('r7', '7.private', [c('private', 'in')]), prefill('r8', '7.private', [c('private', 'r1'), c('private', 'call1')], error), prefill('r9', '7.last', priv),
  ];
  const run = (o = {}, log = []) => WORKLOADS.W19.check({ records: records(o), log }, ctx);
  const said = (fs) => fs.map((f) => [f.step, f.message]);
  const clean = run();
  assert.deepEqual([clean.length, clean.judged], [0, 3]);
  assert.deepEqual(said(run({ priv: [c('private', 'call1'), c('last', 'in')] })), [['7.private', `request r9, the first after the failed round at 7.private, carries no ${NOTICE} notice after ${c('private', 'call1')}`]]);
  assert.deepEqual(said(run({ fail: [NOTICE, c('fail', 'call1'), c('told', 'in')] })), [['7.fail', `request r3, the first after the failed round at 7.fail, carries no ${NOTICE} notice after ${c('fail', 'call1')}`]], 'a notice before the round\'s call is an older one');
  assert.deepEqual(said(run({ retry: [c('retry', 'call1'), '[inference-failed]'] })), [['7.retry', `request r6, the first after the failed round at 7.retry, carries no ${NOTICE} notice after ${c('retry', 'call1')}`]], 'judged by its tag');
  const posted = run({}, [{ step: '7.retry', kind: 'ipc', event: { type: 'inference:published', text: `${c('retry', 'r1')} words` } }, { step: '7.fail', kind: 'ipc', event: { type: 'mcpl:speech-routed', text: `${c('fail', 'r1')} words` } }]);
  assert.deepEqual(said(posted), [['7.fail', `the round's words ${c('fail', 'r1')} were posted: mcpl:speech-routed`], ['7.retry', `the round's words ${c('retry', 'r1')} were posted: inference:published`]]);
  const unfailed = WORKLOADS.W19.check({ records: records().map((r) => (r.id === 'r8' ? { ...r, answer: undefined } : r)), log: [] }, ctx);
  assert.deepEqual([unfailed.judged, said(unfailed)], [2, [['7.private', 'couldn\'t judge: no request at this step was answered with an error']]]);
  const split = WORKLOADS.W19.check({ records: records().map((r) => (r.id === 'r3' ? { ...r, messages: [msg('assistant', { type: 'text', chars: 10, canaries: [c('fail', 'call1')] }), msg('user', { type: 'text', chars: 10, xmlMarks: [NOTICE] }), msg('user', text([c('told', 'in')]))] } : r)), log: [] }, ctx);
  assert.deepEqual([split.judged, said(split)], [3, []], 'a block with no marks gives its canaries, and the order runs across blocks');
  const splitLate = WORKLOADS.W19.check({ records: records().map((r) => (r.id === 'r3' ? { ...r, messages: [msg('user', { type: 'text', chars: 10, xmlMarks: [NOTICE] }), msg('assistant', { type: 'text', chars: 10, canaries: [c('fail', 'call1')] })] } : r)), log: [] }, ctx);
  assert.deepEqual(said(splitLate), [['7.fail', `request r3, the first after the failed round at 7.fail, carries no ${NOTICE} notice after ${c('fail', 'call1')}`]], 'across blocks too, a notice before the call is an older one');
  const ends = WORKLOADS.W19.check({ records: records().filter((r) => r.id !== 'r9'), log: [] }, ctx);
  assert.deepEqual([ends.judged, said(ends)], [2, [['7.private', 'couldn\'t judge: no request followed the failed r8']]]);
});
