// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyCanaries, windowsRaw, coverage, bookkeeping, heldFramed, readerForkOf, undoneSent } from './checks.ts';
import { msg, text, call, result, carrying, store, panel, asked, sent, under, turnStep } from '../testing/check-builders.ts';

const summaryBlock = (...summaries) => ({ type: 'text', chars: 10, summaries });

test('check 6 without a store read still holds a request to the two turns before it, less what was suppressed before it', () => {
  const suppress = { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] };
  const before = [turnStep('a'), turnStep('b'), suppress, turnStep('c')];
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), suppress];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const withoutSuppressed = req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([withoutSuppressed], before, [], null), [], 'a.r1 was suppressed before c, so it isn\'t wanted');
  assert.deepEqual(windowsRaw([withoutSuppressed], after, [], null).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a suppression scripted after c excuses nothing at c');
  const lacking = windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]'])], before, [], null);
  assert.deepEqual(lacking.map((f) => f.message), ['the recent window lacks [[c:b.r1]]']);
});

test('check 6 asks for no canary of a scripted reply that has no text, since it carries none, and still asks for the turn\'s replies that have text', () => {
  const quiet = { ...turnStep('b', 3), replies: [{ text: '[[c:b.r1]] x' }, { calls: [{ name: 'channel_publish', input: {} }] }, { text: '[[c:b.r3]] x' }] };
  const script = [turnStep('a'), quiet, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r3]]', '[[c:c.in]]'])], script, [], null), []);
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], script, [], null).map((f) => f.message), ['the recent window lacks [[c:b.r3]]']);
});

test('check 6 without a store read asks for nothing a /branchto before the request rolled back, and says it couldn\'t judge it; a rollback after the request excuses nothing', () => {
  const rollback = { id: 'x', segment: 's', kind: 'command', command: '/branchto [[c:a.r1]]' };
  const req = (step, canaries) => ({ id: 'r', step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const script = [turnStep('a'), turnStep('b'), rollback, turnStep('c')];
  const rolled = windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], script, [], null);
  assert.deepEqual(rolled.map((f) => f.message), [], 'b was rolled back before c, so c isn\'t asked for it');
  assert.equal(rolled.besides, '2 recent messages not judged, as a rollback before their requests may have dropped them and no final store was read');
  assert.equal(rolled.judged, 1);
  const later = [turnStep('a'), turnStep('b'), turnStep('c'), rollback];
  assert.deepEqual(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], later, [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]] [[c:b.r1]]'], 'a rollback scripted after c excuses nothing at c');
  assert.equal(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], later, [], null).besides, undefined);
  const suppressedToo = [turnStep('a'), turnStep('b'), { id: 'y', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:b.r1]]' }] }, rollback, turnStep('c')];
  assert.equal(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], suppressedToo, [], null).besides, '1 recent message not judged, as a rollback before its request may have dropped it and no final store was read', 'a message suppressed before the rollback isn\'t counted as the rollback\'s');
});

test('check 6 owes a refused step\'s retried reply by the canary its text carries, and owes a later request nothing of a step that sheds its message', () => {
  const refusing = (sheds) => ({ ...turnStep('b'), replies: [{ stop: 'refusal' }, { text: '[[c:b.r1]] x' }], ...(sheds ? { sheds: ['[[c:b.in]]'] } : {}) });
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const retried = req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(true), turnStep('c')], [], null), [], 'the retry\'s reply is b.r1, and the shed b.in isn\'t owed');
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(false), turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], 'a refusal that isn\'t rewound leaves its message owed');
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(true), turnStep('c')], [], store), [], 'a store that keeps the shed message owes it to no later request');
  const atB = (id, answer, ...canaries) => ({ id, step: 'b', kind: 'agent', answer, messages: [msg('user', carrying(...canaries))] });
  const refusedAtB = atB('r2', { shape: 'reply', stop: 'refusal' }, '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]');
  const answeredRetry = atB('r3', { shape: 'reply', stop: 'end_turn' }, '[[c:a.in]]', '[[c:a.r1]]');
  const lacking = req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([refusedAtB, answeredRetry, lacking], [turnStep('a'), refusing(true), turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.r1]]'], 'the answered retry\'s reply is owed to the next turn');
  const toolsFirst = { ...turnStep('b'), replies: [{ calls: [{ name: 'skip_reply' }] }, { text: '[[c:b.r2]] x' }] };
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r2]]', '[[c:c.in]]'])], [turnStep('a'), toolsFirst, turnStep('c')], [], null), [], 'a reply of tool calls alone carries no canary, so none is owed for it');
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]'])], [turnStep('a'), toolsFirst, turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.r2]]'], 'the text reply after it is owed');
});

test('check 6 owes a later request what a refused tool round\'s rewind keeps, the step\'s message, and not what it sheds, the call\'s round', () => {
  const step = { ...turnStep('b'), replies: [{ text: '[[c:b.r1]] x', calls: [{ name: 't', input: { canary: '[[c:b.call1]]' } }] }, { stop: 'refusal' }, { text: '[[c:b.r2]] x' }], sheds: ['[[c:b.r1]]'] };
  const script = [turnStep('a'), step, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r2]]', '[[c:c.in]]'])], script, [], null), [], 'the retry\'s reply is b.r2, and the shed b.r1 isn\'t owed');
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.r2]]', '[[c:c.in]]'])], script, [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], 'the message the rewind kept is owed');
});

test('check 6 with a store read holds a request to a message an operator suppressed only after it, which the final store no longer holds', () => {
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] }];
  const store = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]']);
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store), []);
  const failedLater = [{ kind: 'ipc', step: 'a', event: { type: 'inference:failed' } }];
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, failedLater, store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a reply an operator suppressed was stored, even in a step that failed on a later round');
});

test('check 6 flags a request that loses a raw message of the head the host reported, or lacks the two turns before it raw', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const noHead = { ...full, id: 'nohead', messages: [msg('user', carrying('[[c:p.1.in]]')), ...full.messages.slice(1)] };
  const noRecent = { ...full, id: 'norecent', messages: [head, msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'))] };
  const flags = [full, noHead, noRecent].flatMap((r) => windowsRaw([r], script, log, store));
  assert.deepEqual(flags.map((f) => f.request), ['nohead', 'norecent'], 'p.2, past the reported head, may fold');
  assert.match(flags[0].message, /p\.1\.r1/);
  assert.match(flags[1].message, /b\.r2/);
  const sized = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { tail: { messages: 0, tokens: 0 } } } } } }];
  assert.deepEqual(windowsRaw([full], script, sized, store).map((f) => f.message), ["no head size was reported at segment s's checkpoint"]);
  assert.deepEqual(windowsRaw([noHead, full], script, sized, store).map((f) => [f.request, f.message]), [['ok', "no head size was reported at segment s's checkpoint"]], 'once a segment, on its last request');
  assert.deepEqual(windowsRaw([noHead], script, [], store).filter((f) => /head/.test(f.message)), [], 'a segment that ends at no checkpoint, as a workload\'s, has no head to hold it to');
  assert.deepEqual(windowsRaw([noHead], script, log, null), [], 'with no store read, only the recent window is checked');
});

test('check 6 holds only a segment\'s last request to the head its checkpoint reported, since the panel describes that compile alone', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]')), msg('assistant', summaryBlock('[[s:P2]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const lastLost = { ...last, id: 'last-lost', messages: [msg('user', carrying('[[c:p.1.in]]')), ...last.messages.slice(1)] };
  assert.deepEqual(windowsRaw([early, last], script, log, store), []);
  assert.deepEqual(windowsRaw([early, lastLost], script, log, store).map((f) => [f.request, f.message]), [['last-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});

test('check 6 holds a checkpoint\'s head and tail to nothing the script says a rewind shed or an /undo took out, which a presented window\'s store keeps', () => {
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), ...['p.1.in', 'p.1.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries.map((c) => `[[c:${c}]]`)))] });
  const rest = ['a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'd.in'];
  const shedding = [{ ...turnStep('p.1'), sheds: ['[[c:p.1.r1]]'] }, turnStep('a'), turnStep('b'), turnStep('c'), turnStep('d')];
  const undoing = [turnStep('p.1'), { id: 'u', segment: 's', kind: 'command', command: '/undo', undoes: ['[[c:p.1.r1]]'] }, turnStep('a'), turnStep('b'), turnStep('c'), turnStep('d')];
  const head = [panel('s', { head: 3, tail: 0 })];
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], shedding, head, store), [], 'the head');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], undoing, head, store), [], 'the head, after an /undo');
  const tail = [panel('s', { head: 0, tail: 9 })];
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], shedding, tail, store), [], 'the tail');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], undoing, tail, store), [], 'the tail, after an /undo');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], [turnStep('p.1'), ...shedding.slice(1)], head, store).map((f) => f.message), ['the head window\'s [[c:p.1.r1]] isn\'t raw'], 'without either, the head owes it');
});

test('check 6 asks a request for a head message only once it was stored, through the turn\'s own earlier replies', () => {
  const script = [turnStep('p.1', 2), turnStep('p.2')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: ['p.1.in', 'p.1.r1', 'p.1.r2', 'p.2.in', 'p.2.r1'].map((c) => stored(`[[c:${c}]]`)), summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 5, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const first = { id: 'first', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  const second = { id: 'second', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', carrying('[[c:p.1.r1]]'))] };
  const secondLost = { id: 'second-lost', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  assert.deepEqual(windowsRaw([first], script, log, store), [], 'the first request isn\'t asked for its own reply');
  assert.deepEqual(windowsRaw([first, second], script, log, store), []);
  const flags = windowsRaw([first, secondLost], script, log, store);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['second-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});

test('check 4: each message stored before a request reaches it raw or in a summary, and no more often than stored rows carry it, and an unmapped summary is flagged', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merged = { id: 'merged', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const lost = { id: 'lost', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const unmapped = { id: 'unmapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]', '[[s:P9]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = [ok, merged, lost, twice, unmapped].flatMap((r) => coverage([r], store));
  assert.deepEqual(flags.map((f) => f.request), ['lost', 'twice', 'unmapped']);
  assert.match(flags[0].message, /b\.in.*b\.r1/);
});

test('check 4: a step\'s later request also needs that step\'s earlier replies', () => {
  const first = { id: 'one', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const second = { id: 'two', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = coverage([first, second], store);
  assert.deepEqual(flags.map((f) => f.request), ['two']);
  assert.match(flags[0].message, /c\.r1/);
  const toolsFirst = [{ id: 'c', replies: [{ calls: [{ name: 'skip_reply' }] }, { text: '[[c:c.r2]] x' }] }];
  assert.deepEqual(coverage([first, second], store, toolsFirst), [], 'a reply of tool calls alone carries no canary, so the second request owes none of c\'s');
  const third = { ...second, id: 'three' };
  const owed = coverage([first, second, third], store, toolsFirst);
  assert.deepEqual(owed.map((f) => f.request), ['three'], 'the third request owes c.r2, the text reply after it');
  assert.match(owed[0].message, /c\.r2/);
});

test('check 4: what the script says a step\'s rewind sheds is owed by no request from that step on, whether it was the step\'s own reply or a row the store kept', () => {
  // agent-framework's shedNewestTurn retracts a presented window's rows and leaves them stored.
  const kept = { ...store, messages: [...store.messages, { id: 'm7', canaries: ['[[c:c.r0]]'] }, { id: 'm8', canaries: ['[[c:c.r1]]'] }, { id: 'm9', canaries: ['[[c:d.in]]'] }] };
  const sheds = (shed) => [{ id: 'c', replies: [{ text: '[[c:c.r0]] x', calls: [{ name: 'fixture--result' }] }, { stop: 'refusal' }, { text: '[[c:c.r1]] y' }], ...(shed ? { sheds: ['[[c:c.r0]]'] } : {}) }, { id: 'd', replies: [{ text: '[[c:d.r1]] z' }] }];
  const asked = (id, step, answer, ...canaries) => ({ id, step, kind: 'agent', answer, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]', ...canaries))] });
  const records = [
    asked('first', 'c', { shape: 'reply', stop: 'tool_use' }),
    asked('refused', 'c', { shape: 'reply', stop: 'refusal' }, '[[c:c.r0]]'),
    asked('retry', 'c', { shape: 'reply', stop: 'end_turn' }),
    asked('later', 'd', { shape: 'reply', stop: 'end_turn' }, '[[c:c.r1]]', '[[c:d.in]]'),
  ];
  assert.deepEqual(coverage(records, kept, sheds(true)), []);
  assert.deepEqual(coverage(records, kept, sheds(false)).map((f) => [f.request, f.message]), [
    ['retry', '1 stored message(s) reach the request neither raw nor in a summary: [[c:c.r0]]'],
    ['later', '1 stored message(s) reach the request neither raw nor in a summary: [[c:c.r0]]'],
  ], 'without the shed list both owe it');
});

test('check 4: a stored row a suppress rule hid is owed to no request, and one that quotes it is owed as any row is', () => {
  // agent-framework stamps a row a suppress rule hid `metadata.suppressed` and never renders it; its suppression review
  // is a row of its own that may quote one of them.
  const hid = {
    messages: [
      { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
      { id: 'h1', canaries: ['[[c:h.in]]'], suppressed: true }, { id: 'h2', canaries: ['[[c:k.in]]'], suppressed: true },
      { id: 'v1', canaries: ['[[c:k.in]]'] },
      { id: 'm3', canaries: ['[[c:c.in]]'] },
    ],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
  };
  const quiet = { id: 'quiet', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:k.in]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([quiet], hid), [], 'neither hidden row is owed, and the review that quotes one carries it once');
  const noReview = { ...quiet, id: 'noReview', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([noReview], hid).map((f) => [f.request, f.what, f.message]), [['noReview', 'not-reached', '1 stored message(s) reach the request neither raw nor in a summary: [[c:k.in]]']], 'the review row is owed');
  const twiceK = { ...quiet, id: 'twiceK', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:k.in]]'), carrying('[[c:k.in]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([twiceK], hid).map((f) => [f.what, f.message]), [['more-than-once', '1 message(s) reach the request more often than stored rows carry them: [[c:k.in]] (2 for 1 row)']], 'the hidden row that shares the review\'s canary adds nothing to what the request may carry');
});

test('check 4: a canary may reach a request as many times as stored rows carry it, a message and a row that quotes it each once, and no more; once is enough', () => {
  // connectome-host's knowledge retrieval stores a row of its own after a message, opening "## Retrieved Knowledge, for
  // the message beginning" and its text, canary and all.
  const quoted = {
    messages: [
      { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
      { id: 'm3', canaries: ['[[c:d.in]]'] }, { id: 'q3', canaries: ['[[c:d.in]]'] }, { id: 'm4', canaries: ['[[c:d.r1]]'] },
      { id: 'm5', canaries: ['[[c:c.in]]'] },
    ],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
  };
  const each = { id: 'each', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([each], quoted), [], 'each of the two rows once');
  const thrice = { ...each, id: 'thrice', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]', '[[c:a.in]]'), carrying('[[c:d.in]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([thrice], quoted).filter((f) => f.what === 'more-than-once').map((f) => [f.what, f.message]), [['more-than-once', '2 message(s) reach the request more often than stored rows carry them: [[c:a.in]] (2 for 1 row) [[c:d.in]] (3 for 2 rows)']], 'each named once, with its count and its rows');
  const one = { ...each, id: 'one', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([one], quoted), [], 'a canary it carries at all reaches it; which row went out is check 11\'s');
});

test('check 5: a summary declares only what its request showed, a child by its number or by all it covers', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const flags = bookkeeping([
    shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']),
    shown('[[s:C2]]', ['[[c:b.in]]']),
    shown('[[s:C3]]', ['[[c:a.in]]', '[[c:a.r1]]'], ['[[s:C2]]']),
  ], store);
  assert.deepEqual(flags.map((f) => f.request), ['[[s:C2]]']);
  const childUnseen = bookkeeping([shown('[[s:C3]]', ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]'])], store);
  assert.match(childUnseen[0].message, /L1-1/);
  const l3store = { ...store, summaries: [...store.summaries, { id: 'L3-1', level: 3, sourceLevel: 2, sourceIds: ['L2-1'], number: '[[s:C4]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }] };
  assert.deepEqual(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]', '[[s:C2]]'])], l3store), []);
  assert.equal(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]'])], l3store).length, 1);
  const holed = { ...store, messages: store.messages.filter((m) => m.id !== store.summaries.find((x) => x.number === '[[s:C1]]').sourceIds[0]) };
  const unread = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], holed);
  assert.deepEqual(unread.map((f) => f.what), ['unread-source']);
  assert.equal(unread.judged, 0);
  const tooled = { ...store, messages: [...store.messages, { id: 't1', canaries: ['[[c:a.call1]]'] }], summaries: [...store.summaries, { id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['t1'], number: '[[s:C9]]', covers: ['[[c:a.call1]]'] }] };
  const nothingHeld = bookkeeping([shown('[[s:C9]]', [])], tooled);
  assert.deepEqual(nothingHeld, []);
  assert.equal(nothingHeld.judged, 0, 'a summary of tool results alone holds no source to its request, so it isn\'t counted as judged');
  const merged = { ...tooled, summaries: [...tooled.summaries, { id: 'L2-9', level: 2, sourceLevel: 1, sourceIds: ['L1-9'], number: '[[s:C10]]', covers: ['[[c:a.call1]]'] }] };
  const unshownChild = bookkeeping([shown('[[s:C10]]', [])], merged);
  assert.deepEqual(unshownChild, [], 'a child covering no conversational message, its number not sent, may have gone as its sources raw, which carry nothing to judge by');
  assert.equal(unshownChild.judged, 0, 'so it isn\'t judged, and nothing passes on it');
  const shownChild = bookkeeping([shown('[[s:C10]]', [], ['[[s:C9]]'])], merged);
  assert.deepEqual(shownChild, []);
  assert.equal(shownChild.judged, 1, 'its number sent shows it');
  assert.equal(bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], store).judged, 1);
});

test('checks 4 and 5 read a stitched summary by all its fold parts: its later marks map to it, it is judged once against what all its parts\' requests showed, and a source it declares by a placeholder passes only where its text names that message', () => {
  const stitched = {
    messages: [{ id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] }, { id: 'm3', canaries: ['[[c:b.in]]'] }, { id: 'm4', canaries: ['[[c:b.r1]]'] }, { id: 'm5', canaries: ['[[c:c.in]]'] }],
    summaries: [{ id: 'L1-7', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2', 'm3', 'm4'], number: '[[s:Ma]]', parts: ['[[s:Mb]]'], placeheld: ['m3'], covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }],
  };
  const agentRequest = { id: 'r9', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:Ma]]', '[[s:Mb]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const part = (id, number, canaries) => ({ id, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries: [] } });
  const parts = [part('r1', '[[s:Ma]]', ['[[c:a.in]]', '[[c:a.r1]]']), part('r2', '[[s:Mb]]', ['[[c:b.r1]]'])];
  assert.deepEqual(coverage([...parts, agentRequest], stitched), [], 'its part\'s mark maps to it, and its coverage counts once');
  const unmapped = (records) => coverage(records, stitched).filter((f) => f.what === 'unmapped-summary').map((f) => f.message);
  assert.deepEqual(unmapped([parts[0], agentRequest]), ['summary [[s:Mb]] is in the request, and no store read maps it'], 'a later mark no fold answer wrote isn\'t a part');
  const alone = { ...agentRequest, messages: [msg('user', summaryBlock('[[s:Ma]]')), msg('user', summaryBlock('[[s:Mb]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(unmapped([...parts, alone]), ['summary [[s:Mb]] is in the request, and no store read maps it'], 'a part sent in a block without its summary\'s number');
  const judged = bookkeeping(parts, stitched);
  assert.deepEqual([...judged], [], 'm2 and m4 were each shown by one part\'s request, and m3 is its placeholder');
  assert.equal(judged.judged, 1, 'judged once');
  const unnamed = { ...stitched, summaries: [{ ...stitched.summaries[0], placeheld: [] }] };
  assert.deepEqual(bookkeeping(parts, unnamed).map((f) => f.message), ['summary [[s:Ma]] (L1-7, L1) declares 1 source(s) its request didn\'t show: m3'], 'a placeholder its text doesn\'t name is a source it didn\'t show');
});

test('a stored summary\'s marks: its number is its text\'s first; a stitched one\'s later marks are its parts, and its placeholders the messages its text names as left unsummarized', async () => {
  const { summaryMarks } = await import('./read-store.ts');
  assert.deepEqual(summaryMarks({ content: '[[s:M00000001]] one [[s:M00000002]]' }), { number: '[[s:M00000001]]' }, 'an ordinary summary\'s other marks are its text\'s, not its parts');
  const note = (id) => `[Operator note — not the resident's words: one preserved message at this point (message id ${id}) was not summarized in this entry; its exact source remains in the record.]`;
  const stitched = { content: `[[s:M0000000a]] left\n\n${note('17')}\n\n[[s:M0000000b]] right`, stitched: { placeholders: [{ messageId: '17', text: note('17') }, { messageId: '18', text: note('18') }] } };
  assert.deepEqual(summaryMarks(stitched), { number: '[[s:M0000000a]]', parts: ['[[s:M0000000b]]'], placeheld: ['17'] });
});

const resetStore = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: [], topicTransition: true },
    { id: 'm4', canaries: ['[[c:b.in]]'] }, { id: 'm5', canaries: ['[[c:b.r1]]'] },
    { id: 'm6', canaries: ['[[c:c.in]]'] },
  ],
  summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
};

const resetScript = [turnStep('a'), turnStep('b'), turnStep('c')];

const headOf3 = [panel('s', { head: 3, tail: 0 })];

test('K3b: after a head-window reset, store order holds within the head window and within what follows it, not across them', () => {
  // context-manager renders the head (from the transition on) first, then the summary of what came before it.
  const correct = { id: 'correct', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedHead = { id: 'swapped-head', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedRest = { id: 'swapped-rest', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'), summaryBlock('[[s:C1]]'))] };
  const order = (r) => coverage([r], resetStore, resetScript, headOf3).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(order), ['swapped-head', 'swapped-rest']);
  const unsized = (r) => coverage([r], resetStore).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(unsized), ['swapped-head']);
});

test('check 4 reads a block carrying both summaries and canaries in the order its marks give, as on the Chat Completions API, where membrane joins a message\'s text blocks into one', () => {
  const joined = (marks) => ({ type: 'text', chars: 10, canaries: marks.filter((x) => x.startsWith('[[c:')), summaries: marks.filter((x) => x.startsWith('[[s:')), marks });
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', joined(['[[s:C1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']))] };
  const outOfOrder = { id: 'out-of-order', step: 'c', kind: 'agent', messages: [msg('user', joined(['[[c:b.in]]', '[[s:C1]]', '[[c:b.r1]]', '[[c:c.in]]']))] };
  const unmarked = { id: 'unmarked', step: 'c', kind: 'agent', messages: [msg('user', { ...joined(['[[s:C1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']), marks: undefined })] };
  const store = { messages: resetStore.messages.filter((m) => !m.topicTransition), summaries: resetStore.summaries };
  const order = (r) => coverage([r], store).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([inOrder, outOfOrder].flatMap(order), ['out-of-order']);
  assert.deepEqual(order(unmarked), ['unmarked'], 'without marks a block\'s canaries are read before its summaries, which is why a block carrying both keeps them');
});

test('check 4 holds only a segment\'s last request to the head its checkpoint reported; an earlier one splits at the head\'s start alone', () => {
  const store = {
    messages: [...resetStore.messages, { id: 'm7', canaries: ['[[c:c.r1]]'] }, { id: 'm8', canaries: ['[[c:d.in]]'] }],
    summaries: resetStore.summaries,
  };
  const script = [...resetScript, turnStep('d')];
  const headOf2 = [panel('s', { head: 2, tail: 0 })];
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]')), msg('assistant', carrying('[[c:c.r1]]')), msg('user', carrying('[[c:d.in]]'))] };
  const lastSwapped = { ...last, id: 'last-swapped', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]')), ...last.messages.slice(3)] };
  const earlySwapped = { ...early, id: 'early-swapped', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), early.messages[2]] };
  const order = (rs) => coverage(rs, store, script, headOf2).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual(order([early, last]), []);
  assert.deepEqual(order([early, lastSwapped]), ['last-swapped'], 'b.r1 is past the reported head, so it comes after the history before the head');
  assert.deepEqual(order([earlySwapped, last]), ['early-swapped'], 'from the head\'s start on, an earlier request still runs in store order');
});

test('K6b: check 6\'s head window starts at the last topic transition stored before the request', () => {
  const r = { id: 'after-reset', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.deepEqual(windowsRaw([r], resetScript, headOf3, resetStore).filter((f) => /head window/.test(f.message)), [], 'a.in and a.r1 are before the head now, and may fold');
  const lost = { ...r, id: 'lost', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.match(windowsRaw([lost], resetScript, headOf3, resetStore).find((f) => /head window/.test(f.message))?.message ?? '', /b\.r1/);
});

test('K3: check 4 flags a request whose raw messages and summaries don\'t run in store order', () => {
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merge = { id: 'merge', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:c.in]]'))] };
  const swapped = { id: 'swapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C2]]', '[[s:C1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const rawFirst = { id: 'raw-first', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]')), msg('user', summaryBlock('[[s:C3]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const flags = [inOrder, merge, swapped, rawFirst, twice].flatMap((r) => coverage([r], store)).filter((f) => /store order/.test(f.message));
  assert.deepEqual(flags.map((f) => f.request), ['swapped', 'raw-first']);
});

test('K4: check 6 holds a segment\'s last request to the raw tail the host reported, past the two turns before it, among what was stored before it', () => {
  const script = [turnStep('q'), turnStep('p'), turnStep('a'), turnStep('b'), turnStep('c')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [...['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1'].map((c) => stored(`[[c:${c}]]`)), stored(), stored('[[c:c.in]]'), stored('[[c:c.r1]]')], summaries: [] };
  const all = ['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in'].map((c) => `[[c:${c}]]`);
  const without = (c) => all.filter((x) => x !== c);
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const log = [panel('s', { head: 1, tail: 7 })];
  assert.deepEqual(windowsRaw([req('b-early', 'b', without('[[c:q.r1]]')), req('ok', 'c', all)], script, log, store), []);
  const folded = windowsRaw([req('folded', 'c', without('[[c:p.r1]]'))], script, log, store);
  assert.deepEqual(folded.map((f) => [f.check, f.request]), [[6, 'folded']], 'p.r1 is past the two turns before c, inside the reported tail');
  assert.match(folded[0].message, /tail.*p\.r1/);
  const errored = { ...req('err', 'c', all), answer: { shape: 'error', status: 529 } };
  assert.deepEqual(windowsRaw([errored, req('retry', 'c', all)], script, log, store), [], 'an error gave c no reply, so its retry is held to the tail before c.r1');
  const noTail = windowsRaw([req('ok', 'c', all)], script, [panel('s', { head: 1 })], store);
  assert.deepEqual(noTail.map((f) => f.message), ["no tail size was reported at segment s's checkpoint"]);
});

test('K4b: check 6 anchors a segment\'s last request\'s tail after the call of a reply answered before it, though a refusal came first', () => {
  const turn = { ...turnStep('c'), replies: [{ stop: 'refusal' }, { text: '[[c:c.r1]] x', calls: [{ name: 'result', input: { kind: 'prose', canary: '[[c:c.call1]]' } }] }, { text: '[[c:c.r2]] y' }] };
  const script = [turnStep('a'), turnStep('b'), turn];
  const stored = (c) => ({ canaries: [`[[c:${c}]]`] });
  const store = { messages: ['a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'c.call1', 'c.r2'].map(stored), summaries: [] };
  const req = (id, canaries, answer) => ({ id, step: 'c', kind: 'agent', ...(answer ? { answer } : {}), messages: [msg('user', carrying(...canaries.map((c) => `[[c:${c}]]`)))] });
  const before = ['a.in', 'a.r1', 'b.in', 'b.r1'];
  const records = [req('refused', [...before, 'c.in'], { shape: 'reply', stop: 'refusal' }), req('called', [...before, 'c.in']), req('last', [...before, 'c.r1', 'c.call1'])];
  const flags = windowsRaw(records, script, [panel('s', { head: 1, tail: 2 })], store);
  assert.deepEqual(flags.filter((f) => /tail/.test(f.message)).map((f) => f.message), [], 'the tail of two ends at c.call1, so it holds c.r1 and not c.in');
  const lacking = windowsRaw([...records.slice(0, 2), req('last', [...before, 'c.call1'])], script, [panel('s', { head: 1, tail: 2 })], store);
  assert.deepEqual(lacking.filter((f) => /tail/.test(f.message)).map((f) => f.message), ['the reported tail\'s [[c:c.r1]] isn\'t raw'], 'the tail is judged there, and owes c.r1');
});

test('check 4: a request the stand-in answered with an error gives its step no reply, so its retry needs none', () => {
  const failed = { id: 'r3', step: 'c', kind: 'agent', answer: { shape: 'error', status: 529 }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const retry = { id: 'r4', step: 'c', kind: 'agent', answer: { shape: 'reply' }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([failed, retry], store).map((f) => f.request), [], 'the retry is held to what the step had stored, not to a reply the error never gave');
});

test('check 4 on a subagent: its requests are held to its own store up to the last canary each carries, whatever the canaries are named', () => {
  const sub = {
    messages: [{ id: 's1', canaries: ['[[c:k.task]]'] }, { id: 's2', canaries: ['[[c:k.s1]]'] }, { id: 's3', canaries: ['[[c:k.s1call1]]'] }, { id: 's4', canaries: ['[[c:k.s2]]'] }],
    summaries: [{ id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['s2', 's3'], number: '[[s:C9]]', covers: ['[[c:k.s1]]', '[[c:k.s1call1]]'] }],
  };
  const whole = { id: 'whole', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('assistant', summaryBlock('[[s:C9]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const lost = { id: 'lost', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const primaryOnly = coverage([whole, lost], sub);
  assert.equal(primaryOnly.judged, 0, 'the primary\'s side judges none of a subagent\'s requests');
  const flags = coverage([whole, lost], sub, [], [], { side: 'sub' });
  assert.equal(flags.judged, 2);
  assert.deepEqual(flags.map((f) => [f.request, f.what]), [['lost', 'not-reached']]);
  assert.match(flags[0].message, /\[\[c:k\.s1\]\] \[\[c:k\.s1call1\]\]/);
});

test('check 6 counts a request as judged only where it held it to some message', () => {
  const script = ['a', 'b', 'c'].map((id) => ({ id, segment: 's', replies: [{ text: `[[c:${id}.r1]]` }] }));
  const empty = { messages: [], summaries: [] };
  const r = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]'))] };
  assert.equal(windowsRaw([r], script, [], empty).judged, 0, 'nothing stored, so nothing to hold it to');
  assert.equal(windowsRaw([r], script, [], null).judged, 1, 'without a store read, the script\'s turns hold it');
});

test('check 5 holds a subagent\'s summary to every source it covers, as check 4 does, since a subagent\'s inputs and replies carry their own canaries', () => {
  const store = { messages: [{ id: 'k1', canaries: ['[[c:k.task]]'] }, { id: 'k2', canaries: ['[[c:k.s1]]'] }], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['k1', 'k2'], number: '[[s:C1]]', covers: ['[[c:k.task]]', '[[c:k.s1]]'] }] };
  const call = (canaries) => ({ id: 'c1', step: 'k', kind: 'summariser', answer: { summary: '[[s:C1]]' }, sent: { canaries, summaries: [] } });
  const primary = bookkeeping([call([])], store);
  assert.equal(primary.judged, 0, 'by the primary\'s rule these are no turn\'s input or reply');
  const sub = bookkeeping([call(['[[c:k.task]]', '[[c:k.s1]]'])], store, { side: 'sub' });
  assert.deepEqual(sub, []);
  assert.equal(sub.judged, 1);
  assert.deepEqual(bookkeeping([call(['[[c:k.task]]'])], store, { side: 'sub' }).map((f) => f.request), ['c1'], 'a source its request didn\'t show');
});

test('check 4 counts, beside what it judged, each request it couldn\'t judge because the final store doesn\'t hold its own input', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const gone = { id: 'gone', step: 'z', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:z.in]]'))] };
  const both = coverage([ok, gone], store);
  assert.equal(both.judged, 1);
  assert.equal(both.besides, '1 request not judged, as the final store doesn\'t hold its own input');
  assert.equal(coverage([ok], store).besides, undefined, 'nothing is said where every request was judged');
});

test('check 6 counts, beside what it judged, each message of the two turns before a request that it didn\'t ask for because the final store doesn\'t hold it', () => {
  const turns = [turnStep('a'), turnStep('b'), turnStep('c')];
  const withoutA = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] };
  const flags = windowsRaw([req], turns, [], withoutA);
  assert.deepEqual([...flags], []);
  assert.equal(flags.besides, '1 recent message not asked for, as the final store doesn\'t hold it');
  const whole = { ...withoutA, messages: [{ id: '0', canaries: ['[[c:a.in]]'] }, { id: '00', canaries: ['[[c:a.r1]]'] }, ...withoutA.messages.slice(1)] };
  assert.equal(windowsRaw([{ ...req, messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] }], turns, [], whole).besides, undefined);
});

test('check 5 counts the answers and sources it can\'t judge beside what it judged, never skipping them silently', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const gone = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']), shown('[[s:C9]]', ['[[c:a.in]]'])], store);
  assert.match(gone.besides ?? '', /^1 summariser answer not judged, as the final store doesn't hold its summary/);
  const blank = { ...store, messages: store.messages.map((m) => ({ ...m, canaries: [] })) };
  const unknown = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], blank);
  assert.match(unknown.besides ?? '', /source(s)? not judged, as nothing (it covers|they cover) carries a canary to tell by/);
});

test('check 6 counts each checkpoint tail it judges, and counts one it can\'t place in the final store beside them', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const all = ['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'];
  const storeOf = (names) => ({ messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), ...names.map((c) => stored(`[[c:${c}]]`))], summaries: [] });
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const placed = windowsRaw([full], script, log, storeOf(all));
  const lost = windowsRaw([full], script, log, storeOf(all.filter((c) => c !== 'd.in')));
  assert.equal(placed.judged, lost.judged + 1, 'a tail it judges counts');
  assert.ok(!/checkpoint tail/.test(placed.besides ?? ''));
  assert.match(lost.besides ?? '', /1 checkpoint tail not judged, as the final store doesn't hold its last input/);
});

test('a step\'s reply canaries are the ones its replies\' text carries: a reply with none carries none, a contained one is owed nowhere, and a step the script doesn\'t hold is numbered', () => {
  const step = { id: 's', replies: [{ stop: 'refusal' }, { text: '[[c:s.r1]] words' }, { calls: [{ name: 'skip_reply' }] }, { error: { status: 529 } }, { text: '>>#side {{unsent}}' }, { text: '[[c:s.r2]] more [[c:other.r1]]' }] };
  assert.deepEqual(replyCanaries(step), ['[[c:s.r1]]', '[[c:s.r2]]']);
  assert.deepEqual(replyCanaries(step, 1), ['[[c:s.r1]]'], 'the refusal and the error are no answered reply');
  assert.deepEqual(replyCanaries(step, 2), ['[[c:s.r1]]'], 'tool calls alone carry no canary');
  assert.deepEqual(replyCanaries(step, 4), ['[[c:s.r1]]', '[[c:s.r2]]'], 'the error is no answered reply either, so the fourth answered reply is s.r2\'s');
  assert.deepEqual(replyCanaries({ id: 'w', ends: 'contained', replies: [{ text: '<t>[[c:w.r1]]</t>' }] }), []);
  assert.deepEqual(replyCanaries({ id: 'u' }, 2), ['[[c:u.r1]]', '[[c:u.r2]]']);
  assert.deepEqual(replyCanaries({ id: 'u' }), [], 'nothing past a request\'s own step needs it unbounded');
  const stalled = { id: 'k', replies: [{ hold: true, cut: true }, { text: '[[c:k.r1]] fresh' }] };
  assert.deepEqual(replyCanaries(stalled, 1), ['[[c:k.r1]]'], 'a reply its client cuts is no answered reply, so the first answered reply is the fresh call\'s');
});

test('check 4: where the store\'s window is presented, a request is held to the order its rows entered the window, not store order, and a row the last window doesn\'t hold is left out of that order and counted once as not judged for it, whatever its canaries and however it was sent; a store whose window is the record is held to store order, and a presented window that holds no row orders nothing', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ...(ordinal !== undefined ? { ordinal } : {}) });
  const windowed = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]'], 2), at('m3', ['[[c:b.in]]'], 4), at('m4', ['[[c:a.r2]]'], 3)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'b', segment: 's' }];
  const request = (id, ...canaries) => ({ id, step: 'b', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const order = (store, r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => [f.what, f.message]);
  assert.deepEqual(order(windowed, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), []);
  assert.deepEqual(order(windowed, request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:a.r2]]')), [['window-order', 'it carries [[c:a.r2]] after [[c:b.in]], out of the order its window presented them in']]);
  const record = { presented: false, messages: windowed.messages.map(({ ordinal, ...m }) => m), summaries: [] };
  assert.deepEqual(order(record, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), [['store-order', 'it carries [[c:b.in]] after [[c:a.r2]], out of store order']]);
  const emptied = { ...record, presented: true };
  assert.deepEqual(order(emptied, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), [], 'a presented window that holds no row orders nothing, rather than falling back to store order');
  const left = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]'], 2), at('m3', ['[[c:b.in]]'], 4), at('m4', ['[[c:a.r2]]'])], summaries: [] };
  const leftFlags = coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:a.r2]]')], left, script);
  assert.deepEqual(leftFlags.filter((f) => /order/.test(f.what ?? '')), [], 'a row the last window doesn\'t hold isn\'t ordered');
  assert.equal(leftFlags.besides, '1 row not judged for order, as the final window doesn\'t hold it');
  const two = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]', '[[c:a.r2]]']), at('m3', ['[[c:b.in]]'], 2)], summaries: [] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], two, script).besides, '1 row not judged for order, as the final window doesn\'t hold it', 'a row carrying two counted canaries counts once');
  const summed = { presented: true, messages: [at('m1', ['[[c:a.in]]']), at('m2', ['[[c:a.r1]]']), at('m3', ['[[c:b.in]]'], 1)], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }] };
  const under = (id, ...items) => ({ id, step: 'b', kind: 'agent', messages: [msg('user', { type: 'text', chars: 10, canaries: items.filter((x) => x.startsWith('[[c:')), summaries: items.filter((x) => x.startsWith('[[s:')) })] });
  assert.equal(coverage([under('s', '[[s:C1]]', '[[c:b.in]]')], summed, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a summary over two rows the window doesn\'t hold counts both');
  assert.equal(coverage([under('s', '[[c:a.r1]]', '[[c:b.in]]'), under('t', '[[s:C1]]', '[[c:b.in]]')], summed, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a row sent raw in one request and under a summary in another counts once');
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:z.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], windowed, script).besides, '1 canary not judged for order, as no row the final store holds carries it');
  const quoted = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), { ...at('h1', ['[[c:a.r1]]', '[[c:a.r2]]']), suppressed: true }, at('v1', ['[[c:a.r1]]']), at('v2', ['[[c:a.r2]]']), at('m3', ['[[c:b.in]]'], 2)], summaries: [] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], quoted, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a hidden row is no row a sent canary came from: the two rows that quote it are counted');
  const hiddenOnly = { ...quoted, messages: [...quoted.messages, { ...at('h2', ['[[c:x.in]]']), suppressed: true }] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:x.in]]', '[[c:b.in]]')], hiddenOnly, script).besides, '3 rows not judged for order, as the final window doesn\'t hold them', 'a canary only a hidden row carries, sent anyway, is counted by that row, which the store holds');
});

test('check 4: an event\'s place in the window is its own row\'s, though a later gate line quotes it, and a gate line\'s quote of an event its batch held isn\'t judged as that event\'s place in a request', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'b', segment: 's' }];
  const block = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const gate = (...canaries) => ({ type: 'text', chars: 10, wakeLine: canaries.length, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'))] }), [], 'the event in its own place, before a row stored after it');
  assert.deepEqual(order({ id: 'r2', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'), gate('[[c:c.in]]'))] }), [], 'and quoted again by the gate line after it');
  assert.deepEqual(order({ id: 'r3', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'the event itself out of its place still flags');
});

test('check 4: in a block that opens with a gate line, only the canaries the request carried before it go unjudged for order, so a row joined after the line, as the Chat Completions API joins a message\'s text blocks, is judged', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4), at('m4', ['[[c:d.in]]'], 5)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'd', segment: 's' }];
  const block = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const joined = (...canaries) => ({ type: 'text', chars: 10, wakeLine: 1, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'd', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'), joined('[[c:c.in]]', '[[c:d.in]]'))] }), [], 'the line\'s quote skipped, the row joined after it in its place');
  assert.deepEqual(order({ id: 'r2', step: 'd', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:d.in]]'), joined('[[c:c.in]]', '[[c:b.in]]'))] }), ['it carries [[c:b.in]] after [[c:d.in]], out of the order its window presented them in'], 'a row joined after the line out of its place flags');
  const summarised = { ...store, summaries: [{ number: '[[s:1]]', covers: ['[[c:a.in]]', '[[c:c.in]]'] }] };
  const sum = (...marks) => ({ type: 'text', chars: 10, summaries: marks });
  assert.deepEqual(coverage([{ id: 'r3', step: 'd', kind: 'agent', messages: [msg('user', sum('[[s:1]]'), block('[[c:b.in]]'), joined('[[c:c.in]]', '[[c:d.in]]'))] }], summarised, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message), [], 'an event a summary sent before the line covers is a quote too');
});

test('check 4: in a block where the gate line opens a line after earlier rows, as the Chat Completions API joins a message\'s text blocks, the line\'s quote of an event whose own row came before it in the block goes unjudged, and the rows before the line are judged in their place', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4), at('m4', ['[[c:d.in]]'], 5)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'd', segment: 's' }];
  const joined = (after, ...canaries) => ({ type: 'text', chars: 10, wakeLine: 1, wakeAfter: after, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'd', kind: 'agent', messages: [msg('user', joined(3, '[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), [], 'the event\'s own row and a row after it, then the line quoting the event, then a row after the line');
  assert.deepEqual(order({ id: 'r2', step: 'd', kind: 'agent', messages: [msg('user', joined(3, '[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'a row before the line out of its place still flags');
  assert.deepEqual(order({ id: 'r3', step: 'd', kind: 'agent', messages: [msg('user', joined(2, '[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'an event after the line that the request carried nowhere before it is judged as any row is');
  const summarised = { ...store, summaries: [{ number: '[[s:1]]', covers: ['[[c:a.in]]', '[[c:c.in]]'] }] };
  assert.deepEqual(coverage([{ id: 'r4', step: 'd', kind: 'agent', messages: [msg('user', { type: 'text', chars: 10, wakeLine: 1, wakeAfter: 2, canaries: ['[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'], summaries: ['[[s:1]]'], marks: ['[[s:1]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'] })] }], summarised, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message), [], 'an event a summary before the line in the block covers is a quote too');
});

const heldStep = (k, forks = true) => ({ id: `h${k}`, segment: 's', kind: 'channel', canaries: [`[[c:h${k}.in]]`, ...(forks ? [`[[c:h${k}.sum.in]]`] : [])], tunedOut: [`[[c:h${k}.in]]`], reader: forks ? { prefix: 'reader/fixture/' } : { name: 'Subconscious' }, ...(forks ? { inputs: [`[[c:h${k}.sum.in]]`], replies: [{ text: `[[c:h${k}.r1]] noted`, calls: [{ name: 'skip_reply' }] }] } : { replies: [] }) });

test('a reader fork is an agent named reader/<resident>/…, the resident\'s alone', () => {
  assert.equal(readerForkOf('reader/fixture/1a2b3c4d/1'), true);
  assert.equal(readerForkOf('reader/other/1a2b3c4d/1'), false);
  assert.equal(readerForkOf('fixture'), false);
  assert.equal(readerForkOf('Subconscious'), false);
  assert.equal(readerForkOf(undefined), false);
});

test('check 4 owes the resident no message its tune-out holds, by the script\'s tunedOut, and still owes it every other', () => {
  const held = { messages: [{ id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] }, { id: 'm3', canaries: ['[[c:h1.in]]'] }, { id: 'm4', canaries: ['[[c:h1.sum.in]]'] }, { id: 'm5', canaries: ['[[c:h1.r1]]'] }, { id: 'm6', canaries: ['[[c:h2.in]]'] }, { id: 'm7', canaries: ['[[c:h2.sum.in]]'] }], summaries: [] };
  const script = [turnStep('a'), heldStep(1), heldStep(2)];
  const wake = (step, ...canaries) => ({ id: `w${step}`, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(coverage([wake('h1', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]')], held, script), [], 'the held message is owed to no request of the resident\'s');
  assert.deepEqual(coverage([wake('h1', '[[c:a.in]]', '[[c:h1.sum.in]]')], held, script).map((f) => f.what), ['not-reached'], 'a message no tune-out holds is owed as before');
  assert.deepEqual(coverage([wake('h2', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]')], held, script), [], 'the next wake turn: the earlier summary and note, and its own summary');
  const lost = coverage([wake('h2', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h2.sum.in]]')], held, script);
  assert.deepEqual(lost.map((f) => f.what), ['not-reached'], 'the earlier wake turn\'s note is owed');
  assert.match(lost[0].message, /h1\.r1/);
  const windows = (...canaries) => windowsRaw([wake('h2', ...canaries)], script, [], held);
  assert.deepEqual(windows('[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]'), [], 'check 6 at the next wake turn');
  assert.deepEqual(windows('[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]').map((f) => f.message), ['the recent window lacks [[c:h1.sum.in]]'], 'check 6 owes the earlier fork\'s summary');
  const sub = { id: 's', step: 'h1', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]'))] };
  const subSide = coverage([sub], held, script, [], { side: 'sub' });
  assert.deepEqual([[...subSide], subSide.judged], [[], 1], 'a sub side is held to what it carries, as before');
});

test('check 6 owes no request a message the script\'s tune-out holds, with a store read or without one', () => {
  const persistent = { ...heldStep(1, false), replies: [{ text: '[[c:h1.r1]] x' }] };
  const script = [turnStep('a'), persistent, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.in]]', '[[c:h1.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  for (const s of [null, store]) {
    assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.r1]]', '[[c:c.in]]'])], script, [], s), [], `the held h1.in isn't owed (${s ? 'store' : 'no store'})`);
    assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:h1.r1]]', '[[c:c.in]]'])], script, [], s).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], `the rest is owed (${s ? 'store' : 'no store'})`);
  }
});

test('check 4 holds each message a tune-out held to its reader fork\'s requests at its step, where the fork\'s framing shows it: a framed message passes, a dropped framing line is flagged, and so is a step with no fork request', () => {
  const script = [turnStep('a'), heldStep(1), heldStep(2)];
  const fork = (step, ...canaries) => ({ id: `f${step}`, step, kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:a.in]]', ...canaries))] });
  const compiled = (step, agent) => ({ kind: 'compiles', step, lines: [{ kind: 'request', agent, outcome: 'compiled' }] });
  const log = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('h2', 'reader/fixture/aa/2')];
  const framed = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, log);
  assert.deepEqual([[...framed], framed.judged], [[], 2]);
  const dropped = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2')], script, log);
  assert.deepEqual(dropped.map((f) => [f.check, f.step, f.what]), [[4, 'h2', 'held-unframed']]);
  assert.match(dropped[0].message, /\[\[c:h2\.in\]\]/);
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]')], script, log).map((f) => f.step), ['h2'], 'no fork request at its step');
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]', '[[c:h2.in]]'), fork('h2')], script, log).map((f) => f.step), ['h2'], 'h2\'s held message only in h1\'s fork request, the wrong step');
  assert.deepEqual(heldFramed([{ ...fork('h2', '[[c:h2.in]]'), agent: 'primary' }, fork('h1', '[[c:h1.in]]')], script, log).map((f) => f.step), ['h2'], 'the resident\'s request carries no fork\'s framing');
  const other = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('h2', 'knowledge')];
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, other).map((f) => f.step), ['h2'], 'a sub-side request at h2 that no reader fork owns');
  assert.equal(heldFramed([], [turnStep('a'), heldStep(1, false)], log).judged, 0, 'a persistent reader\'s view is check 11\'s, not this');
  const crowded = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), { kind: 'compiles', step: 'h2', lines: [{ kind: 'request', agent: 'reader/fixture/aa/2', outcome: 'compiled' }, { kind: 'request', agent: 'knowledge', outcome: 'compiled' }] }];
  const unplaced = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, crowded);
  assert.deepEqual([[...unplaced], unplaced.judged], [[], 0], 'where check 13 can\'t place the sub side, nothing is judged, which the report flags as couldn\'t-judge');
  const beside = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('a', 'spawn-w-1')];
  const labelled = heldFramed([fork('h1', '[[c:h1.in]]'), { id: 'w1', step: 'a', kind: 'agent', agent: 'w', messages: [] }], [turnStep('a'), heldStep(1)], beside);
  assert.deepEqual([[...labelled], labelled.judged], [[], 1], 'a labelled subagent beside the one reader fork leaves the fork the one unlabelled agent, as check 13 places it');
});

test('checks 4 and 6 owe no request after an operator\'s /undo what the script says it took out (its `undoes`), check 4 flags it sent raw after the /undo, and both still owe everything else', () => {
  const undo = { id: 'u', segment: 's', kind: 'command', command: '/undo', undoes: ['[[c:b.r1]]'] };
  const script = [turnStep('a'), turnStep('b'), undo, turnStep('c')];
  const req = (...canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], store, script), [], 'check 4');
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]')], store, script).map((f) => f.what), ['not-reached'], 'check 4 still owes a.r1');
  for (const s of [null, store]) {
    assert.deepEqual(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], script, [], s), [], `check 6 (${s ? 'store' : 'no store'})`);
    assert.equal(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], script, [], s).besides ?? null, null, 'nor counted as one the final store doesn\'t hold');
    assert.deepEqual(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]')], script, [], s).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], `check 6 still owes b.in (${s ? 'store' : 'no store'})`);
  }
  const back = undoneSent([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]')], script);
  assert.deepEqual([back.map((f) => [f.check, f.step, f.what]), back.judged], [[[4, 'c', 'undone-sent']], 1], 'what the /undo took out, sent raw after it, is flagged, with no store read');
  assert.match(back[0].message, /\[\[c:b\.r1\]\]/);
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]')], store, script).map((f) => f.what), [], 'coverage leaves it to that part');
  const before = { ...req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]'), step: 'b', id: 'rb' };
  assert.deepEqual(coverage([before, { ...before, id: 'rb2' }], store, [turnStep('a'), { ...turnStep('b'), replies: [{ text: '[[c:b.r1]] x' }, { text: '[[c:b.r2]] y' }] }, undo, turnStep('c')]).map((f) => f.request), ['rb2'], 'a request before the /undo is still owed it');
});

const callShowing = (canary) => ({ type: 'tool_use', chars: 10, toolUseId: 't1', canaries: [canary] });

test('check 4 reads a request by the blocks a store row is read from, its texts and results, so a call\'s input showing its row\'s canary is no second copy of that row', () => {
  const sub = { messages: [{ id: 's1', canaries: ['[[c:k.task]]'] }, { id: 's2', canaries: ['[[c:k.s1]]'] }, { id: 's3', canaries: ['[[c:k.s1call1]]'] }], summaries: [] };
  const round = { id: 'round', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('assistant', carrying('[[c:k.s1]]'), callShowing('[[c:k.s1call1]]')), msg('user', { ...result('t1'), canaries: ['[[c:k.s1call1]]'] })] };
  const four = coverage([round], sub, [], [], { side: 'sub' });
  assert.equal(four.judged, 1);
  assert.deepEqual(four, [], 'the call and its result show one row\'s canary, which that row carries once');
});

test('check 6 reads a request by the blocks a store row is read from, its texts and results, so a call\'s input quoting a row\'s canary doesn\'t carry that row', () => {
  const script = [turnStep('a'), turnStep('b'), turnStep('c')];
  const quoted = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]')), msg('assistant', callShowing('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(windowsRaw([quoted], script, [], null).map((f) => f.message), ['the recent window lacks [[c:b.r1]]'], 'a call quoting b.r1 doesn\'t carry b.r1\'s row');
});
