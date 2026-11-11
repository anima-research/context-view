// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { runOf } from './workloads.ts';
import { msg, text, call, result, store, W14_FACTS } from '../testing/check-builders.ts';

test('W14 runs H1\'s stretches from H1\'s W2 store and H1b\'s from empty, with H1b/W14 judged as a run too short to compress, and the stream budget it lowers restored to the setup\'s bound', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, streamBound: 320_000, capabilities: { suppression: true, onboarding: true } };
  const h1 = runOf('H1/W14', configurations(), facts);
  const h1b = runOf('H1b/W14', configurations(), facts);
  assert.equal(h1.from, 'H1/W2');
  assert.equal(h1b.from, null);
  assert.equal(h1.compresses, true);
  assert.equal(h1b.compresses, false);
  const shape = (job) => job.steps().map((s) => [s.id.slice(s.id.indexOf('.') + 1), s.kind, s.command ?? null]);
  assert.deepEqual(shape(h1), [['end', 'channel', null], ['break.budget', 'command', '/budget 1'], ['break', 'channel', null], ['break.restore', 'command', '/budget 320000'], ['sub', 'channel', null], ['topic', 'command', '/newtopic']]);
  assert.deepEqual(shape(h1b), [['end', 'channel', null], ['side', 'channel', null]]);
  assert.equal(h1.configuration.modules.subagents, true);
});

function w14Ran() {
  const job = runOf('H1b/W14', configurations(), W14_FACTS);
  const [end, side] = job.steps();
  const c = (step, part) => `[[c:${step.id}.${part}]]`;
  const agent = (seq, step, ...messages) => ({ id: `r${seq}`, seq, kind: 'agent', agent: 'primary', step: step.id, messages });
  const carry = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const records = [
    agent(1, end, msg('user', carry(c(end, 'in')))),
    agent(2, end, msg('user', carry(c(end, 'in'))), msg('assistant', carry(c(end, 'r1'))), msg('user', carry(c(end, 'call1')))),
    agent(3, end, msg('assistant', carry(c(end, 'r2'))), msg('user', carry(c(end, 'a1.in')))),
    agent(4, side, msg('user', carry(c(side, 'in')))),
    agent(5, side, msg('user', carry(c(side, 'call1')), carry(c(side, 'a3.in')), { type: 'text', chars: 10, notice: 'routing' })),
  ];
  const stored = (step, id) => [
    { kind: 'send', via: 'channel', step: step.id, during: 'x', message: { messageId: id } },
    { kind: 'ipc', step: step.id, event: { type: 'message:added', source: 'mcpl:channel-incoming' } },
  ];
  const log = [
    ...stored(end, `${end.id}.a1`), { kind: 'send', via: 'release', step: end.id, request: 'r2' },
    ...stored(side, `${side.id}.a3`), { kind: 'send', via: 'release', step: side.id, canary: c(side, 'call1') },
  ];
  return { job, end, side, c, records, log };
}

test('check 14 for W14: an arrival at a turn\'s end is first carried by the first request after the turn\'s held final request, after its final reply, and one at a boundary by the request after it, after the held call\'s result, one addressed from another channel with a routing notice after it', () => {
  const { job, records, log } = w14Ran();
  const flags = job.check({ records, log });
  assert.deepEqual(flags, []);
  assert.equal(flags.judged, 2);
});

test('check 14 for W14 flags an arrival carried before what its point puts ahead of it, one first carried by another request than its point gives, and one addressed from another channel with no routing notice after it', () => {
  const said = (run) => run.job.check(run).map((f) => f.message);
  const before = w14Ran();
  before.records[2].messages.reverse();
  assert.deepEqual(said(before), [`request r3 carries ${before.c(before.end, 'a1.in')} before ${before.c(before.end, 'r2')}`]);
  const late = w14Ran();
  late.records[2].messages.pop();
  late.records[3].messages.unshift(msg('user', { type: 'text', chars: 10, canaries: [late.c(late.end, 'a1.in')] }));
  assert.match(said(late)[0], /a1\.in\]\] is first carried by request r4, where its point gives request r3, its wake turn's first request/);
  const early = w14Ran();
  early.records[1].messages.push(msg('user', { type: 'text', chars: 10, canaries: [early.c(early.side, 'a3.in')] }));
  assert.match(said(early)[0], /a3\.in\]\] is first carried by request r2, where its point gives request r5, the request after its boundary/);
  const later = w14Ran();
  later.records[4].messages[0].blocks.splice(-1, 0, { type: 'text', chars: 10, canaries: [later.c(later.side, 'r3')] });
  assert.deepEqual(said(later), [`request r5 carries ${later.c(later.side, 'a3.in')}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary`], 'a routing notice after the next canary, as the bounce\'s is, isn\'t the arrival\'s');
  const quiet = w14Ran();
  quiet.records[4].messages[0].blocks.pop();
  assert.deepEqual(said(quiet), [`request r5 carries ${quiet.c(quiet.side, 'a3.in')}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary`]);
  const bare = w14Ran();
  bare.records[2].messages.shift();
  assert.deepEqual(said(bare), [`request r3 carries ${bare.c(bare.end, 'a1.in')} without ${bare.c(bare.end, 'r2')}, which its point puts ahead of it`]);
});

test('check 14 for W14 judges a subagent\'s result by the end the driver logged before the hold\'s release: first carried by the request after its boundary, after the held call\'s result', () => {
  const job = runOf('H1/W14', configurations(), { ...W14_FACTS, streamBound: 320_000 });
  const sub = job.steps().find((s) => s.id.endsWith('.sub'));
  const c = (part) => `[[c:${sub.id}.${part}]]`;
  const agent = (seq, ...messages) => ({ id: `r${seq}`, seq, kind: 'agent', agent: 'primary', step: sub.id, messages });
  const carry = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const said = (records, log) => job.check({ records, log }).filter((f) => f.step === sub.id).map((f) => f.message);
  const ended = [{ kind: 'agent-end', step: sub.id }, { kind: 'send', via: 'release', step: sub.id, canary: c('call1') }];
  const r1 = agent(1, msg('user', carry(c('in'))));
  assert.deepEqual(said([r1, agent(2, msg('user', carry(c('call1')), carry(c('s1'))))], ended), []);
  assert.match(said([r1, agent(2, msg('user', carry(c('call1')))), agent(3, msg('user', carry(c('s1'))))], ended)[0], /sub\.s1\]\] is first carried by request r3, where its point gives request r2/);
  assert.deepEqual(said([r1, agent(2, msg('user', carry(c('call1')), carry(c('s1'))))], [...ended].reverse()), [`couldn't judge ${c('s1')}: it wasn't stored before its hold's release`]);
  assert.deepEqual(said([r1, agent(2, msg('user', carry(c('s1')), carry(c('call1'))))], ended), [`request r2 carries ${c('s1')} before ${c('call1')}`]);
});

test('check 14 for W14 can\'t judge an arrival no request carries, or one the host hadn\'t stored before its hold\'s release, and counts neither as judged', () => {
  const lost = w14Ran();
  lost.records[4].messages[0].blocks.splice(1, 1);
  const lostFlags = lost.job.check(lost);
  assert.deepEqual(lostFlags.map((f) => f.message), [`couldn't judge ${lost.c(lost.side, 'a3.in')}: no request carries it`]);
  assert.equal(lostFlags.judged, 1);
  const unstored = w14Ran();
  unstored.log.splice(1, 1);
  const unstoredFlags = unstored.job.check(unstored);
  assert.deepEqual(unstoredFlags.map((f) => f.message), [`couldn't judge ${unstored.c(unstored.end, 'a1.in')}: it wasn't stored before its hold's release`]);
  assert.equal(unstoredFlags.judged, 1);
});
