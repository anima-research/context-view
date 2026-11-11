// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { runOf } from './workloads.ts';
import { msg, text, under, W14_FACTS } from '../testing/check-builders.ts';

test('W15 runs under H4 from empty, with the Web UI, the history module and the fixture\'s send tool, judged as a run too short to compress', () => {
  const job = runOf('H4/W15', configurations(), W14_FACTS);
  assert.equal(job.from, null);
  assert.equal(job.compresses, false);
  assert.equal(job.configuration.fixtureSend, true);
  assert.equal(job.configuration.modules.history, true);
  assert.ok(job.configuration.modules.webui);
  assert.deepEqual(job.steps().map((s) => [s.id.slice(s.id.indexOf('.') + 1), s.kind, s.command ?? null]), [
    ['1', 'channel', null], ['tune', 'channel', null], ['h1', 'channel', null], ['checkpoint', 'command', '/checkpoint w15'], ['h2', 'deliver', null], ['restore', 'command', '/restore w15'],
    ['h3', 'channel', null], ['back', 'command', '/checkout main'], ['suppress', 'suppress', null], ['side', 'channel', null], ['restart', 'restart', null], ['h4', 'channel', null],
  ]);
});

function w15Ran() {
  const job = runOf('H4/W15', configurations(), W14_FACTS);
  const steps = job.steps();
  const at = (name) => steps.find((s) => s.id.endsWith(`.${name}`));
  const c = (name) => `[[c:${at(name).id}.in]]`;
  const start = '[[c:x.tune.r1]]';
  const read = (id, step, ...canaries) => ({ id, kind: 'agent', agent: 'sub', step: at(step).id, messages: [msg('user', ...[start, ...canaries].map((x) => ({ type: 'text', chars: 10, canaries: [x] })))] });
  const records = [read('r5', 'h1', c('h1')), read('r7', 'h3', c('h1'), c('h3')), read('r11', 'h4', c('h2'), c('h4'))];
  return { job, c, read, records, run: { records, log: [] } };
}

test('check 14 for W15: the reader\'s read after /restore doesn\'t carry h2, the row stored between the checkpoint and the restore, its read after the restart carries h2 and not h3, none after the suppression carries h1, and the read after the restart starts at the row the read before it did', () => {
  const { job, run } = w15Ran();
  const flags = job.check(run);
  assert.deepEqual(flags, []);
  assert.equal(flags.judged, 4);
});

test('check 14 for W15 flags each of its four, and can\'t judge a read that isn\'t there, a suppression with no reader request before it or whose last before it didn\'t show it h1, or h3 left out after the restart when its read after /restore didn\'t carry h3', () => {
  const said = (records) => { const { job } = w15Ran(); return job.check({ records, log: [] }).map((f) => f.message); };
  const { c, read } = w15Ran();
  const h3 = read('r7', 'h3', c('h1'), c('h3'));
  assert.deepEqual(said([read('r5', 'h1', c('h1')), read('r7', 'h3', c('h1'), c('h2'), c('h3')), read('r11', 'h4', c('h2'), c('h4'))]), [`request r7, the reader's read after /restore, carries ${c('h2')}, which was stored after the checkpoint`]);
  assert.deepEqual(said([h3, read('r11', 'h4', c('h4'))]), [`request r11, the reader's read after the restart, doesn't carry ${c('h2')}, which the branch /checkout went back to holds`]);
  assert.deepEqual(said([h3, read('r11', 'h4', c('h2'), c('h3'))]), [`request r11, the reader's read after the restart, carries ${c('h3')}, which only the restore's branch holds`]);
  assert.deepEqual(said([h3, read('r11', 'h4', c('h1'), c('h2'))]), [`request r11, the reader's after the suppression, carries ${c('h1')}, which the suppression removed`]);
  const moved = { ...read('r11', 'h4', c('h2')), messages: [msg('user', { type: 'text', chars: 10, canaries: ['[[c:x.1.in]]'] }, { type: 'text', chars: 10, canaries: [c('h2')] })] };
  assert.deepEqual(said([h3, moved]), ['request r11, the reader\'s read after the restart, starts at [[c:x.1.in]], where r7, its read before it, starts at [[c:x.tune.r1]]']);
  assert.deepEqual(said([read('r5', 'h1', c('h1')), read('r7', 'h3', c('h3')), read('r11', 'h4', c('h2'), c('h4'))]), [`couldn't judge the suppression: request r7, the reader's last before it, doesn't carry ${c('h1')}`]);
  assert.deepEqual(said([read('r5', 'h1', c('h1')), read('r7', 'h3', c('h1')), read('r11', 'h4', c('h2'), c('h3'), c('h4'))]), [`couldn't judge whether the reader's read after the restart leaves out ${c('h3')}: r7, its read after /restore, doesn't carry it`]);
  assert.ok(said([read('r11', 'h4', c('h2'), c('h4'))]).includes('couldn\'t judge the suppression: the reader made no request before it'));
  const none = (() => { const { job } = w15Ran(); return job.check({ records: [], log: [] }); })();
  assert.equal(none.judged, 0);
  assert.equal(none.length, 3, 'the read after the restore, the read after the restart and the suppression can\'t be judged; the start needs both reads');
});
