// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replyCanaries, inputsOf } from '../strategies/checks.ts';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, runOf } from './workloads.ts';
import { text, store, under } from '../testing/check-builders.ts';

test('W1 and W2 hold the store to L3 by its end: L3 passes, L2 flags, and a run with no state read, a state read with no level or an unreadable one, or a configuration that doesn\'t summarise, is couldn\'t-judge', () => {
  const ran = (maxLevel) => ({ log: [{ kind: 'read', op: 'state', step: 'w.70', answer: { maxLevel } }], records: [] });
  for (const w of ['W1', 'W2']) {
    const atL3 = WORKLOADS[w].check(ran(3), { configuration: {} });
    assert.deepEqual([atL3.length, atL3.judged], [0, 1], w);
    const atL2 = WORKLOADS[w].check(ran(2), { configuration: {} });
    assert.equal(atL2.judged, 1);
    assert.deepEqual(atL2.map((f) => f.message), ['the store reached L2 in 70 turns, short of L3'], w);
    const unread = WORKLOADS[w].check({ log: [], records: [] }, { configuration: {} });
    assert.deepEqual([unread.judged, unread[0].message], [0, 'couldn\'t judge: the run logged no state read'], w);
    const failed = WORKLOADS[w].check(ran({ unreadable: 'boom' }), { configuration: {} });
    assert.deepEqual([failed.judged, failed[0].message], [0, 'couldn\'t judge: the state read gave no level for the store (unreadable: boom)'], w);
    const levelless = WORKLOADS[w].check(ran(undefined), { configuration: {} });
    assert.deepEqual([levelless.judged, levelless[0].message], [0, 'couldn\'t judge: the state read gave no level for the store'], w);
    const plain = WORKLOADS[w].check(ran(3), { configuration: { summarises: false } });
    assert.deepEqual([plain.judged, plain[0].message], [0, 'couldn\'t judge: the property needs a configuration that summarises, and this one doesn\'t'], w);
  }
});

test('under reader forks, each held step\'s wake turn is one checks 4 and 6 judge: its input is its fork\'s summary and its note a reply, both conversational and neither held; under H4 the resident takes no turn there', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const conversational = (c) => /\.(in|r\d+)\]\]$/.test(c);
  const held = (id) => runOf(id, configurations(), facts, lengths).steps().filter((st) => (st.tunedOut ?? []).length && st.reader);
  const forks = held('H4b/W1');
  assert.equal(forks.length, 6);
  assert.ok(forks.every((st) => st.reader.prefix === 'reader/fixture/'), 'the resident\'s forks alone');
  for (const st of forks) {
    assert.ok(inputsOf(st).length && inputsOf(st).every((c) => conversational(c) && !st.tunedOut.includes(c)), `${st.id}'s input`);
    assert.equal(replyCanaries(st).length, 1, `${st.id}'s note`);
    assert.ok(st.subs[0].replies[0].calls[0].input.text.startsWith(inputsOf(st)[0]), `${st.id}'s fork writes its summary under that input's canary`);
  }
  const h4 = runOf('H4/W1', configurations(), facts, lengths).steps().filter((st) => (st.tunedOut ?? []).length);
  assert.equal(h4.filter((st) => st.reader).length, forks.length, 'as many looks as H4b\'s forks');
  assert.ok(h4.every((st) => !(st.replies ?? []).length), 'no step a tune-out holds a message in gives the resident a turn, a look or not');
  const steps = runOf('H4b/W1', configurations(), facts, lengths).steps();
  const undo = steps.find((st) => st.command === '/undo');
  const before = steps.slice(0, steps.indexOf(undo)).filter((st) => st.replies?.length).at(-1);
  assert.deepEqual(undo.undoes, replyCanaries(before), 'under forks, the /undo before the fourth look takes out the third wake turn\'s note, the resident\'s last turn');
});

test('under reader forks, each fork\'s last reply is scripted `settle`, so the stand-in holds it until compression is idle, as it holds a subagent\'s replies', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const looks = runOf('H4b/W1', configurations(), facts, lengths).steps().filter((st) => st.reader?.prefix !== undefined);
  assert.equal(looks.length, 6);
  for (const st of looks) assert.equal(st.subs[0].replies.at(-1).settle, true, `${st.id}'s fork's last reply`);
});

test('under a persistent reader, W1 ends with every channel but one tuned out beside chat\'s own tune-out: the scope\'s entry, a message only the scope holds and one chat\'s tune-out holds, the cadence\'s look at the first alone, and the scope\'s end; the /undo takes the turn that tuned chat out; under reader forks the last look\'s message carries an image instead', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const stepsOf = (id) => runOf(id, configurations(), facts, lengths).steps();
  const h4 = stepsOf('H4/W1');
  const last = h4.findIndex((st) => /\.h6$/.test(st.id));
  const [focus, held, look, release, ...rest] = h4.slice(last + 1);
  assert.deepEqual(rest, [], 'the stretch is the run\'s end');
  assert.equal(focus.channel, 'w1-keep');
  assert.deepEqual(focus.replies[0].calls, [{ name: 'tune_out', input: { channelId: 'w1-keep', scope: 'all-except', durationSeconds: 150, cadenceSeconds: 60 } }], 'every channel but w1-keep, ending on its own after 150 s, looked at every 60 s');
  assert.deepEqual([held.kind, held.messages.map((m) => m.channel)], ['deliver', ['w1-side', 'chat']]);
  assert.deepEqual(held.tunedOut, held.messages.map((m) => m.text.split(' ')[0]), 'both held from the resident');
  assert.deepEqual([look.kind, look.ms > 60_000, look.replies], ['advance', true, []], 'past the cadence, the resident taking no turn');
  assert.deepEqual(look.subs[0].canaries, [held.tunedOut[0]], 'the reader looks at w1-side\'s message');
  assert.equal(look.subs[0].replies[0].calls[0].input.channelId, 'w1-side');
  assert.deepEqual([release.kind, look.ms + release.ms > 150_000], ['advance', true], 'past the duration');
  assert.ok(release.replies.length && release.subs[0].replies.length, 'the resident answers the release, and the reader its end');
  const undoOf = (steps) => steps.find((st) => st.command === '/undo');
  const tune = h4.find((st) => /\.tune$/.test(st.id));
  assert.ok(replyCanaries(tune).length > 0, 'the turn that tuned chat out says something of its own');
  assert.deepEqual(undoOf(h4).undoes, replyCanaries(tune), 'under the persistent reader, which wakes no resident turn, the /undo takes the turn that tuned chat out');
  const forks = stepsOf('H4b/W1');
  assert.deepEqual(forks.filter((st) => st.images).map((st) => st.id.split('.').at(-1)), ['h6'], 'under forks, the last look\'s message carries an image');
  assert.ok(!forks.some((st) => st.channel === 'w1-keep') && !h4.some((st) => st.images), 'each half under its own reader');
});
