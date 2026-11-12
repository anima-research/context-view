// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { msg, text, call, carrying, started, under } from '../testing/check-builders.ts';

const W16_CTX = { seed: 9, capabilities: { 'kept-history': false } };

test('W16 judges that its refused turn\'s tool exchange was shed and retried: one refusal, of the request carrying the call\'s result, then a request at the step carrying one more rewind marker, none of the call\'s round and still the turn\'s message', () => {
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const asked = (id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }) => ({ id, seq, kind: 'agent', agent: 'primary', step: '9.refuse', answer, messages: [msg('user', ...blocks)] });
  const refusal = { shape: 'reply', stop: 'refusal' };
  const check = (...records) => {
    const flags = WORKLOADS.W16.check({ log: [], records }, W16_CTX);
    return { messages: flags.filter((f) => f.step === '9.refuse').map((f) => f.message), judged: flags.judged };
  };
  const input = carrying('[[c:9.refuse.in]]');
  const round = carrying('[[c:9.refuse.r0]]');
  const result = carrying('[[c:9.refuse.call1]]');
  const first = asked('r2', 2, [input], { shape: 'reply', stop: 'tool_use' });
  const refused = asked('r3', 3, [input, round, result], refusal);
  assert.deepEqual(check(first, refused, asked('r4', 4, [input, marker])), { messages: [], judged: 1 });
  assert.deepEqual(check(first, refused, asked('r4', 4, [input, { ...marker, notice: 'turns-set-aside' }])), { messages: [], judged: 1 }, 'the marker under the tag agent-framework renamed it to');
  assert.deepEqual(check(first, refused, asked('r4', 4, [input, round, result])).messages, [
    'request r4, the next after the refused r3, carries 0 rewind marker(s) where r3 carried 0, and the rewind adds one',
    'request r4, the next after the refused r3, still carries the shed call\'s round [[c:9.refuse.r0]] [[c:9.refuse.call1]]: it was replayed, not shed',
  ]);
  assert.deepEqual(check(first, refused, asked('r4', 4, [input, round, marker])).messages, [
    'request r4, the next after the refused r3, still carries the shed call\'s round [[c:9.refuse.r0]]: it was replayed, not shed',
  ], 'a rewind that shed the result alone, leaving its call to be answered in its place');
  assert.deepEqual(check(first, refused, asked('r4', 4, [marker])).messages, [
    'request r4, the next after the refused r3, no longer carries the turn\'s message [[c:9.refuse.in]], which a rewind that sheds the turn\'s call and its result keeps',
  ], 'a rewind that took the message too, as one shedding the whole turn would');
  assert.deepEqual(check(first, asked('r3', 3, [marker, input, round, result], refusal), asked('r4', 4, [marker, input])).messages, ['request r4, the next after the refused r3, carries 1 rewind marker(s) where r3 carried 1, and the rewind adds one'], 'a marker an earlier rewind left is no marker of this one');
  assert.deepEqual(check(first, refused, asked('r4', 4, [input, round, result], refusal), asked('r5', 5, [input, marker])).messages, ['2 requests at this step were answered with a refusal, where the stand-in refuses once: the refusal was replayed']);
  assert.deepEqual(check(first), { messages: ['couldn\'t judge: no request at this step was answered with a refusal'], judged: 0 });
  assert.deepEqual(check(first, refused), { messages: ['couldn\'t judge: no request at this step followed the refused r3'], judged: 0 });
  assert.deepEqual(check(first, asked('r3', 3, [input], refusal), asked('r4', 4, [input, marker])), {
    messages: ['request r3, the one refused at this step, lacks [[c:9.refuse.r0]] [[c:9.refuse.call1]], which its rewind is to shed, so its retry isn\'t judged'],
    judged: 1,
  }, 'a refusal of a request without the call and its result exercises no shedding of a tool exchange, whatever the retry carries');
  assert.deepEqual(check(first, asked('r3', 3, [input, round], refusal), asked('r4', 4, [input, marker])).messages, [
    'request r3, the one refused at this step, lacks [[c:9.refuse.call1]], which its rewind is to shed, so its retry isn\'t judged',
  ], 'a stub in the result\'s place carries none of the result');
});

test('W16 judges that its breaker trips at the third failure in a row and not before: the first two failed turns are left alone, and the third is shed and retried', () => {
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const failed = { shape: 'error', status: 400 };
  const asked = (step, id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }, kind = 'agent') => ({ id, seq, kind, ...(kind === 'agent' ? { agent: 'primary' } : {}), step: `9.${step}`, answer, messages: [msg('user', ...blocks)] });
  const old = carrying('[[c:9.refuse.in]]');
  const input = (n) => carrying(`[[c:9.break.${n}.in]]`);
  const alert = (step) => ({ kind: 'ipc', step: `9.${step}`, event: { type: 'ops:alert', kind: 'hard-down', message: '3 consecutive inference failures' } });
  const judge = (log, records) => {
    const flags = WORKLOADS.W16.check({ log, records }, W16_CTX);
    return { messages: flags.filter((f) => f.step.startsWith('9.break.')).map((f) => `${f.step}: ${f.message}`), judged: flags.judged };
  };
  const check = (...records) => judge([alert('break.3')], records);
  const first = [asked('break.1', 'r5', 5, [marker, input(1)], failed), asked('break.2', 'r6', 6, [marker, input(1), input(2)], failed)];
  const third = asked('break.3', 'r7', 7, [marker, input(1), input(2), input(3)], failed);
  const retried = asked('break.3', 'r8', 8, [marker, input(1), input(2), marker]);
  assert.deepEqual(check(...first, third, retried), { messages: [], judged: 4 });
  assert.deepEqual(judge([], [...first, third, retried]).messages, ['9.break.3: 0 hard-down alert(s) at this step, where the breaker\'s trip at the third failure in a row raises one']);
  assert.deepEqual(judge([alert('break.2'), alert('break.3')], [...first, third, retried]).messages, ['9.break.2: 1 hard-down alert(s) at this step, where no streak of failures reaches its third'], 'an early alert, though no request follows its failure, as with the breaker planted at 2');
  assert.deepEqual(judge([alert('break.3'), alert('break.3')], [...first, third, retried]).messages, ['9.break.3: 2 hard-down alert(s) at this step, where the breaker\'s trip at the third failure in a row raises one']);
  assert.deepEqual(check(...first, third, asked('break.3', 'r8', 8, [marker, input(1), input(2)])).messages, ['9.break.3: request r8, the next after the failed r7, carries 1 rewind marker(s) where r7 carried 1, and the rewind adds one'], 'the first rewind\'s marker, still in the window, is no marker of the breaker\'s');
  assert.deepEqual(check(...first, third, asked('break.3', 'r8', 8, [marker, input(1), input(2), marker, marker])).messages, ['9.break.3: request r8, the next after the failed r7, carries 3 rewind marker(s) where r7 carried 1, and the rewind adds one'], 'agent-framework keeps one marker for an episode');
  assert.deepEqual(check(...first, third, asked('break.3', 'r8', 8, [marker, input(1), input(2), input(3), marker])).messages, ['9.break.3: request r8, the next after the failed r7, still carries the shed turn\'s message [[c:9.break.3.in]]: it was replayed, not shed']);
  const early = check(first[0], first[1], asked('break.2', 'r7', 7, [marker, input(1), marker], { shape: 'refused' }, 'unclassified'));
  assert.deepEqual(early.messages.filter((m) => m.startsWith('9.break.2')), ['9.break.2: request r7 followed the failed r6 at this step, where the breaker waits for the third failure in a row'], 'a retry the stand-in has no reply for still counts');
  assert.deepEqual(check(...first, third), { messages: ['9.break.3: couldn\'t judge: no request at this step followed the failed r7'], judged: 3 });
  assert.deepEqual(check(...first, asked('break.3', 'r7', 7, [marker, input(1), input(2)], failed), retried), { messages: ['9.break.3: request r7, the one failed at this step, lacks [[c:9.break.3.in]], which its rewind is to shed, so its retry isn\'t judged'], judged: 4 }, 'a third failure whose request lacked its own message gave the breaker nothing of it to shed');
  assert.deepEqual(check(first[0]).messages, ['9.break.2: couldn\'t judge: no request at this step was answered with the stand-in\'s 400', '9.break.3: couldn\'t judge: no request at this step was answered with the stand-in\'s 400']);
});

test('W16 judges, where the installed breaker raises history-kept, that a probe failing as the request did keeps the history: the probe after the third failure, no retry, one history-kept alert keyed fails-without-history and a hard-down alert there, and the next turn carrying all three messages and as many rewind markers; without it, it judges none of that and flags any history-kept alert', () => {
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const failed = { shape: 'error', status: 400 };
  const asked = (step, id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }, agent = 'primary') => ({ id, seq, kind: 'agent', agent, step: `9.${step}`, answer, messages: [msg('user', ...blocks)] });
  const input = (n) => carrying(`[[c:9.keep.${n}.in]]`);
  const hardDown = (step) => ({ kind: 'ipc', step: `9.${step}`, event: { type: 'ops:alert', kind: 'hard-down', message: '3 consecutive inference failures' } });
  const historyKept = (step, probe = 'fails-without-history', message = 'kept its history') => ({ kind: 'ipc', step: `9.${step}`, event: { type: 'ops:alert', kind: 'history-kept', message, data: { probe } } });
  const all = (log, records, keeps = true) => WORKLOADS.W16.check({ log, records }, { seed: 9, capabilities: { 'kept-history': keeps } });
  const judge = (log, records, keeps = true) => {
    const flags = all(log, records, keeps);
    return { messages: flags.filter((f) => /^9\.(keep\.|kept)/.test(f.step)).map((f) => `${f.step}: ${f.message}`), judged: flags.judged };
  };
  const streak = [asked('keep.1', 'r20', 20, [marker, input(1)], failed), asked('keep.2', 'r21', 21, [marker, input(1), input(2)], failed)];
  const third = asked('keep.3', 'r22', 22, [marker, input(1), input(2), input(3)], failed);
  const probe = { id: 'r23', seq: 23, kind: 'probe', step: '9.keep.3', answer: failed };
  const turn = asked('kept', 'r24', 24, [marker, input(1), input(2), input(3), carrying('[[c:9.kept.in]]')]);
  const held = [hardDown('keep.3'), historyKept('keep.3')];
  const whole = judge(held, [...streak, third, probe, turn]);
  assert.deepEqual(whole.messages, []);
  assert.equal(whole.judged - judge(held, [...streak, third, probe, turn], false).judged, 4, 'keep.1, keep.2, the kept history and the trip at keep.3 are each judged');
  const lacksProbe = '9.keep.3: no probe reached the stand-in at this step after the failed r22, where a breaker that raises history-kept sends the failed request without its history before it sheds';
  assert.deepEqual(judge(held, [...streak, third, turn]).messages, [lacksProbe]);
  assert.deepEqual(judge(held, [...streak, { ...probe, id: 'r19', seq: 19 }, third, turn]).messages, [lacksProbe], 'a probe before the failed request isn\'t its probe');
  const retry = asked('keep.3', 'r24', 24, [marker, input(1), input(2), marker]);
  const retried = '9.keep.3: request r24 followed the failed r22 at this step, where a probe that fails as the request did keeps the history and queues no retry';
  assert.deepEqual(judge(held, [...streak, third, probe, retry, turn]).messages, [retried]);
  assert.deepEqual(judge([hardDown('keep.3')], [...streak, third, retry, { ...turn, id: 'r25', seq: 25 }]).messages, [
    lacksProbe, retried, '9.keep.3: 0 history-kept alert(s) keyed fails-without-history at this step, where a probe that fails as the request did raises one',
  ], 'a missing probe doesn\'t stop the rest of the step\'s checks');
  assert.deepEqual(judge([hardDown('keep.3')], [...streak, third, probe, turn]).messages, ['9.keep.3: 0 history-kept alert(s) keyed fails-without-history at this step, where a probe that fails as the request did raises one']);
  assert.deepEqual(judge([...held, historyKept('keep.3')], [...streak, third, probe, turn]).messages, ['9.keep.3: 2 history-kept alert(s) keyed fails-without-history at this step, where a probe that fails as the request did raises one']);
  const stray = (step, key, message = 'kept its history') => `9.${step}: a history-kept alert keyed ${key} at this step, other than the one a probe failing as the request did raises at the third failure of the kept-history turns: ${message}`;
  assert.deepEqual(judge([hardDown('keep.3'), historyKept('keep.3', 'could-not-tell', 'couldn\'t tell')], [...streak, third, probe, turn]).messages, [
    stray('keep.3', 'could-not-tell', 'couldn\'t tell'),
    '9.keep.3: 0 history-kept alert(s) keyed fails-without-history at this step, where a probe that fails as the request did raises one',
  ]);
  assert.deepEqual(judge([...held, historyKept('kept')], [...streak, third, probe, turn]).messages, [stray('kept', 'fails-without-history')]);
  for (const keeps of [true, false]) {
    const flags = all([...held, historyKept('break.3', 'fails-without-history', 'kept at break.3')], [...streak, third, probe, turn], keeps);
    assert.deepEqual(flags.filter((f) => f.step === '9.break.3' && /history-kept alert/.test(f.message)).map((f) => f.message), [stray('break.3', 'fails-without-history', 'kept at break.3').slice('9.break.3: '.length)], `a history-kept alert at break.3 is flagged with its message, ${keeps ? 'with' : 'without'} the capability`);
  }
  assert.deepEqual(judge([historyKept('keep.3')], [...streak, third, probe, turn]).messages, ['9.keep.3: 0 hard-down alert(s) at this step, where the breaker\'s trip at the third failure in a row raises one']);
  const early = (n) => asked(`keep.${n}`, `r${30 + n}`, 20 + n + 0.5, [marker, input(1), marker]);
  assert.deepEqual(judge(held, [...streak, early(1), early(2), third, probe, turn]).messages, [
    '9.keep.1: request r31 followed the failed r20 at this step, where the breaker waits for the third failure in a row',
    '9.keep.2: request r32 followed the failed r21 at this step, where the breaker waits for the third failure in a row',
  ]);
  const keptTurn = (...blocks) => judge(held, [...streak, third, probe, asked('kept', 'r24', 24, [...blocks, carrying('[[c:9.kept.in]]')])]).messages;
  assert.deepEqual(keptTurn(marker, input(2)), ['9.kept: request r24, the first after the third failure in a row at 9.keep.3, lacks [[c:9.keep.1.in]] [[c:9.keep.3.in]], which a kept history still holds']);
  assert.deepEqual(keptTurn(marker, input(1), input(2), input(3), marker), ['9.kept: request r24, the first after the third failure in a row at 9.keep.3, carries 2 rewind marker(s) where r22 carried 1, and a kept history adds none']);
  assert.deepEqual(keptTurn(input(1), input(2), input(3)), ['9.kept: request r24, the first after the third failure in a row at 9.keep.3, carries 0 rewind marker(s) where r22 carried 1, and a kept history adds none'], 'a lost marker is flagged as an added one is');
  assert.deepEqual(judge(held, [...streak, third, probe]).messages, ['9.kept: couldn\'t judge: no request at this step, after the third failure in a row at 9.keep.3']);
  assert.deepEqual(judge(held, [...streak, third, probe, turn], false).messages, [
    stray('keep.3', 'fails-without-history'),
    '9.keep.3: 1 hard-down alert(s) at this step, where no streak of failures reaches its third',
  ], 'without the capability the branch isn\'t judged, and an alert it would explain is flagged');
  const steps = WORKLOADS.W16.steps({ seed: 9, capabilities: { 'kept-history': true } });
  assert.deepEqual(steps.map((s) => s.id.slice('9.'.length)), ['1', 'pre.con', 'refuse', 'after', 'refuse.reasoning-extraction', 'after.named', 'break.1', 'break.2', 'break.3', 'unstick', 'failpub', 'told', 'keep.1', 'keep.2', 'keep.3', 'kept']);
  const at = (id) => steps.find((s) => s.id === `9.${id}`);
  for (const id of ['keep.1', 'keep.2', 'keep.3']) {
    assert.deepEqual([at(id).mayFail, at(id).replies.map((r) => r.error)], [true, [at('break.1').replies[0].error]], `${id} fails with the breaker turns' own error`);
    assert.deepEqual([at(id).spare.length, at(id).spare[0].error, at(id).spare[0].text.startsWith(`[[c:9.${id}.r1]] `)], [1, undefined, true], `${id}'s spare is an ordinary reply`);
  }
  assert.deepEqual(at('keep.3').probe, { error: at('keep.3').replies[0].error }, 'the probe fails exactly as the turn did');
  assert.deepEqual([at('keep.1').probe, at('keep.2').probe], [undefined, undefined]);
  const outcome = [{ type: 'inference:started' }, { type: 'ops:alert', kind: 'history-kept' }];
  assert.deepEqual([at('break.3').probe, at('break.3').awaits.events, at('keep.3').awaits.events], [{ text: 'Word.' }, outcome, outcome]);
  const without = WORKLOADS.W16.steps({ seed: 9, capabilities: { 'kept-history': false } });
  const atW = (id) => without.find((s) => s.id === `9.${id}`);
  assert.deepEqual([atW('break.3').probe, atW('break.3').awaits.events], [{ text: 'Word.' }, outcome], 'break.3 answers a probe on every framework, so the gate decides only whether the kept history runs');
  assert.deepEqual(without.filter((s) => s.probe || s.awaits).map((s) => s.id), ['9.break.3']);
  const absent = without.at(-1);
  assert.deepEqual([absent.id, absent.kind, absent.stretch, absent.segment], ['9.absent.kept-history', 'absent', 'kept-history', 'W16']);
});

test('W16 judges, where the installed breaker raises history-kept, that its first trip probes before it sheds: a probe after the failed request and before the retry', () => {
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const failed = { shape: 'error', status: 400 };
  const asked = (step, id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }) => ({ id, seq, kind: 'agent', agent: 'primary', step: `9.${step}`, answer, messages: [msg('user', ...blocks)] });
  const input = (n) => carrying(`[[c:9.break.${n}.in]]`);
  const records = (...more) => [asked('break.1', 'r5', 5, [marker, input(1)], failed), asked('break.2', 'r6', 6, [marker, input(1), input(2)], failed), asked('break.3', 'r7', 7, [marker, input(1), input(2), input(3)], failed), ...more];
  const retry = asked('break.3', 'r9', 9, [marker, input(1), input(2), marker]);
  const probe = (seq) => ({ id: `r${seq}`, seq, kind: 'probe', step: '9.break.3', answer: { shape: 'verdict', verdict: 'answered' } });
  const judge = (recs, keeps = true) => {
    const flags = WORKLOADS.W16.check({ log: [{ kind: 'ipc', step: '9.break.3', event: { type: 'ops:alert', kind: 'hard-down', message: '3' } }], records: recs }, { seed: 9, capabilities: { 'kept-history': keeps } });
    return { messages: flags.filter((f) => f.step === '9.break.3').map((f) => f.message), judged: flags.judged };
  };
  const good = judge(records(probe(8), retry));
  assert.deepEqual(good.messages, []);
  assert.equal(good.judged - judge(records(probe(8), retry), false).judged, 1, 'the probe is judged where the capability holds');
  assert.deepEqual(judge(records(retry)).messages, ['no probe reached the stand-in at this step after the failed r7, where a breaker that raises history-kept sends the failed request without its history before it sheds']);
  assert.deepEqual(judge(records(retry, probe(10))).messages, ['request r9 came after the failed r7 and before its probe, where a breaker that raises history-kept sheds and retries only once its probe is answered']);
  assert.deepEqual(judge(records(retry), false).messages, [], 'without the capability the first trip isn\'t asked to probe');
});

test('W16 judges that an unstick whose turn the model refuses sheds the newest message, the breaker retry\'s reply, and retries with one more rewind marker', () => {
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const refusal = { shape: 'reply', stop: 'refusal' };
  const asked = (id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }) => ({ id, seq, kind: 'agent', agent: 'primary', step: '9.unstick', answer, messages: [msg('user', ...blocks)] });
  const newest = carrying('[[c:9.break.3.r1]]');
  const check = (...records) => {
    const flags = WORKLOADS.W16.check({ log: [], records }, W16_CTX);
    return { messages: flags.filter((f) => f.step === '9.unstick').map((f) => f.message), judged: flags.judged };
  };
  assert.deepEqual(check(asked('r9', 9, [marker, marker, newest], refusal), asked('r10', 10, [marker, marker, marker])), { messages: [], judged: 1 });
  assert.deepEqual(check(asked('r9', 9, [marker, marker, newest], refusal), asked('r10', 10, [marker, marker])).messages, ['request r10, the next after the refused r9, carries 2 rewind marker(s) where r9 carried 2, and the rewind adds one']);
  assert.deepEqual(check(asked('r9', 9, [marker, marker, newest], refusal), asked('r10', 10, [marker, marker, newest, marker])).messages, ['request r10, the next after the refused r9, still carries the shed turn\'s message [[c:9.break.3.r1]]: it was replayed, not shed']);
  assert.deepEqual(check(asked('r9', 9, [marker, newest])), { messages: ['couldn\'t judge: no request at this step was answered with a refusal'], judged: 0 });
  assert.deepEqual(check(asked('r9', 9, [marker, marker], refusal), asked('r10', 10, [marker, marker, marker])), { messages: ['request r9, the one refused at this step, lacks [[c:9.break.3.r1]], which its rewind is to shed, so its retry isn\'t judged'], judged: 1 }, 'a refused unstick whose request lacked the breaker retry\'s reply');
  assert.deepEqual(WORKLOADS.W16.steps(W16_CTX).find((s) => s.id === '9.unstick').sheds, ['[[c:9.break.3.r1]]'], 'the unstick\'s step says what its rewind takes out, as refuse\'s and break.3\'s do');
});

test('W16 judges that a turn whose answer the fixture refused to post is followed by a request carrying one more of agent-framework\'s [discord-send-failed] notices, once the driver heard a route failure at that turn other than one with no locus', () => {
  const notice = { type: 'text', chars: 10, notice: 'discord-send-failed' };
  const asked = (step, id, seq, blocks) => ({ id, seq, kind: 'agent', agent: 'primary', step: `9.${step}`, answer: { shape: 'reply', stop: 'end_turn' }, messages: [msg('user', ...blocks)] });
  const refused = (reason = 'the "fixture" server said it didn\'t post the message') => ({ kind: 'undelivered', step: '9.failpub', reason });
  const judge = (log, records) => {
    const flags = WORKLOADS.W16.check({ log, records }, W16_CTX);
    return { messages: flags.filter((f) => ['9.failpub', '9.told'].includes(f.step)).map((f) => `${f.step}: ${f.message}`), judged: flags.judged };
  };
  const check = (...records) => judge([refused()], records);
  const published = asked('failpub', 'r12', 12, [carrying('[[c:9.failpub.in]]')]);
  const told = asked('told', 'r13', 13, [notice, carrying('[[c:9.told.in]]')]);
  assert.deepEqual(check(published, told), { messages: [], judged: 1 });
  assert.deepEqual(check(published, asked('told', 'r13', 13, [carrying('[[c:9.told.in]]')])).messages, ['9.told: request r13, the next after r12, at whose step the driver heard a route failure other than one with no locus, carries 0 [discord-send-failed] notice(s) where r12 carried 0, and agent-framework adds one for such a failure of a reply routed by its turn']);
  const already = asked('failpub', 'r12', 12, [notice, carrying('[[c:9.failpub.in]]')]);
  assert.deepEqual(check(already, told).messages, ['9.told: request r13, the next after r12, at whose step the driver heard a route failure other than one with no locus, carries 1 [discord-send-failed] notice(s) where r12 carried 1, and agent-framework adds one for such a failure of a reply routed by its turn'], 'a notice already there before the refusal is no notice of it');
  assert.deepEqual(check(published, asked('told', 'r13', 13, [notice, notice, carrying('[[c:9.told.in]]')])).messages, ['9.told: request r13, the next after r12, at whose step the driver heard a route failure other than one with no locus, carries 2 [discord-send-failed] notice(s) where r12 carried 0, and agent-framework adds one for such a failure of a reply routed by its turn'], 'two new notices are one too many');
  assert.deepEqual(judge([], [published, told]), { messages: ['9.failpub: couldn\'t judge: the driver heard no route failure at this step other than one with no locus, so nothing for a later request to tell of'], judged: 0 });
  assert.deepEqual(judge([refused('turn has no locus (no home/trigger channel; nothing to deliver into)')], [published, told]).messages, ['9.failpub: couldn\'t judge: the driver heard no route failure at this step other than one with no locus, so nothing for a later request to tell of'], 'a no-locus failure is no refused publish');
  assert.deepEqual(judge([refused('the "fixture" server\'s answer didn\'t say whether it posted the message (delivery uncertain)')], [published, told]), { messages: [], judged: 1 }, 'any other route failure there is judged alike');
  assert.deepEqual(check(published), { messages: ['9.failpub: couldn\'t judge: no request followed r12, at whose step the driver heard a route failure other than one with no locus'], judged: 0 });
});

test('W16 types a console message right after its first turn, so its later turns follow private input', () => {
  const steps = WORKLOADS.W16.steps({ seed: 7, capabilities: { 'kept-history': false } });
  assert.deepEqual(steps.map((s) => s.id.slice('7.'.length)), ['1', 'pre.con', 'refuse', 'after', 'refuse.reasoning-extraction', 'after.named', 'break.1', 'break.2', 'break.3', 'unstick', 'failpub', 'told', 'absent.kept-history']);
  const con = steps[1];
  assert.deepEqual([con.kind, con.addressed, con.namedAnywhere, con.canaries], ['console', false, true, ['[[c:7.pre.con.in]]']]);
  assert.match(con.text, /^\[\[c:7\.pre\.con\.in\]\] /);
  assert.equal(con.replies.length, 1);
  assert.match(con.replies[0].text, /^\[\[c:7\.pre\.con\.r1\]\] /);
  assert.deepEqual(con.replies[0].calls, [{ name: 'skip_reply', input: {} }]);
});

test('W16 judges its refusal named reasoning_extraction as it judges refuse, and a rewind that rewrote the earlier marker in place of adding one is flagged', () => {
  const step = '9.refuse.reasoning-extraction';
  const marker = { type: 'text', chars: 10, notice: 'refusal-rewind' };
  const asked = (id, seq, blocks, answer = { shape: 'reply', stop: 'end_turn' }) => ({ id, seq, kind: 'agent', agent: 'primary', step, answer, messages: [msg('user', ...blocks)] });
  const check = (...records) => WORKLOADS.W16.check({ log: [], records }, W16_CTX).filter((f) => f.step === step).map((f) => f.message);
  const input = carrying(`[[c:${step}.in]]`);
  const round = carrying(`[[c:${step}.r0]]`);
  const result = carrying(`[[c:${step}.call1]]`);
  const first = asked('r6', 6, [marker, input], { shape: 'reply', stop: 'tool_use' });
  const refused = asked('r7', 7, [marker, input, round, result], { shape: 'reply', stop: 'refusal' });
  assert.deepEqual(check(first, refused, asked('r8', 8, [marker, input, marker])), []);
  assert.deepEqual(check(first, refused, asked('r8', 8, [marker, input])), ['request r8, the next after the refused r7, carries 1 rewind marker(s) where r7 carried 1, and the rewind adds one']);
  assert.deepEqual(check(), ['couldn\'t judge: no request at this step was answered with a refusal']);
});
