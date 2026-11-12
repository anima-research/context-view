// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressionIdleOver, lanePause, notRestingText, pauseHolds, pauseNotes, readSettle, snapshotOver } from './events.ts';

const T = Date.parse('2026-01-06T09:00:05.000Z');
const CLOCK = Date.parse('2026-01-06T09:00:00.000Z');
const UNTIL = `1 chunks pending; compression paused until ${new Date(T).toISOString()} (backoff, failure 1; latest: the chunk of 5 message(s) from 1757 failed (CompressionRefusalHold))`;
const NO_END = '1 chunks pending; compression paused until a restart, a change of model, or an explicit release (the provider stated a wait that cannot be held as an instant) (the provider\'s stated wait, failure 1)';
const host = { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 };
const progress = (pending = false) => ({ totalChunks: 32, chunksCompressed: 30, l1QueueLength: 1, mergeQueueLength: 0, summaryCounts: { l1: 30, l2: 1, l3: 0 }, pending });
const paused = (pending = UNTIL, inFlight = false) => ({ agentName: 'fixture', ready: false, pending, progress: progress(inFlight) });
const worked = { ok: true, maintenance: { ran: true } };
const read = (agents, clock = CLOCK, hostMode = host) => readSettle(snapshotOver(worked, { ticks: {}, agents, hostMode }), null, {}, 'fixture', worked, clock);

test('the host\'s word for a paused lane is its readiness text: an instant of its clock, no end on it, or words the harness doesn\'t read', () => {
  assert.deepEqual(lanePause(UNTIL), { until: T });
  assert.deepEqual(lanePause(NO_END), { noEnd: true });
  for (const words of [
    '1 chunks pending; compression paused for 5 s (backoff, failure 1)',
    '1 chunks pending; compression paused until 2026-13-06T09:00:05.000Z (backoff, failure 1)',
    '1 chunks pending; compression paused until 2026-01-06T09:00:05Z (backoff, failure 1)',
    '1 chunks pending; the lane is paused until 2026-01-06T09:00:05.000Z (backoff, failure 1)',
  ]) assert.deepEqual(lanePause(words), { unread: true }, words);
  for (const none of ['1 chunks pending', 'Compressing chunk 31', '2 chunks + 1 merges pending', undefined, null, 3]) assert.equal(lanePause(none), null, String(none));
});

test('a paused lane is at rest when its pause ends after the clock and no compression call is in flight', () => {
  assert.deepEqual(pauseHolds(paused(), CLOCK), { until: T });
  assert.equal(pauseHolds({ agentName: 'fixture', ready: true, progress: progress() }, CLOCK), null, 'a ready agent holds no pause');
  assert.equal(pauseHolds({ agentName: 'fixture', ready: false, pending: '1 chunks pending', progress: progress() }, CLOCK), null, 'a queue with no pause named');
  for (const [what, agent, clock, why] of [
    ['an end at the clock', paused(), T, /its pause ended at 2026-01-06T09:00:05\.000Z, and the clock reads 2026-01-06T09:00:05\.000Z/],
    ['an end before the clock', paused(), T + 1, /its pause ended at 2026-01-06T09:00:05\.000Z, and the clock reads 2026-01-06T09:00:05\.001Z/],
    ['a call in flight', paused(UNTIL, true), CLOCK, /a compression call is in flight/],
    ['no end on the clock', paused(NO_END), CLOCK, /its pause has no end on the clock/],
    ['unread words', paused('1 chunks pending; compression paused for 5 s (backoff, failure 1)'), CLOCK, /it names a pause in words the harness doesn't read/],
  ] as const) {
    const held = pauseHolds(agent, clock);
    assert.ok(held && 'why' in held, what);
    assert.match(held.why, why, what);
  }
});

test('a settle ends with a paused agent at rest, and names it with its pause\'s end; it doesn\'t where any condition fails, or where the driver gave no clock', () => {
  const at = read([paused()]);
  assert.equal(at.settled, true);
  assert.deepEqual(at.paused, [{ agent: 'fixture', until: T }]);
  for (const [what, r] of [
    ['an end at the clock', read([paused()], T)],
    ['a call in flight', read([paused(UNTIL, true)])],
    ['no end on the clock', read([paused(NO_END)])],
    ['unread words', read([paused('1 chunks pending; compression paused for 5 s')])],
    ['no clock from the driver', readSettle(snapshotOver(worked, { ticks: {}, agents: [paused()], hostMode: host }), null, {}, 'fixture', worked)],
  ] as const) {
    assert.equal(r.settled, false, what);
    assert.deepEqual(r.paused, [], what);
  }
  const two = read([paused(), { agentName: 'reader', ready: false, pending: '1 chunks pending', progress: progress() }]);
  assert.equal(two.settled, false, 'a second agent not at rest');
});

test('a paused agent at rest beside a turn alive goes to the held branch, so a provider hold and a pause can end one settle', () => {
  const r = read([paused()], CLOCK, { ...host, drained: false, activeTurnAgents: ['fixture'] });
  assert.equal(r.waits, true);
  assert.deepEqual(r.paused, [{ agent: 'fixture', until: T }]);
});

test('compression is idle for a held reply where every agent is ready with no call in flight, or at rest in a pause', () => {
  const over = (agents, clock = CLOCK) => compressionIdleOver(snapshotOver(worked, { ticks: {}, agents, hostMode: host }), {}, 'fixture', worked, clock);
  assert.equal(over([{ agentName: 'fixture', ready: true, progress: progress() }]).idle, true);
  assert.equal(over([paused()]).idle, true, 'a pause that holds');
  assert.equal(over([paused()], T).idle, false, 'a pause the clock has passed');
  assert.equal(over([paused(UNTIL, true)]).idle, false, 'a call in flight');
  const busy = over([{ agentName: 'fixture', ready: true, progress: progress(true) }]);
  assert.equal(busy.idle, false, 'ready, with a call in flight');
  assert.equal(busy.why, 'fixture (ready, with a compression call in flight)');
  assert.match(over([paused(NO_END)]).why, /^fixture \(1 chunks pending; compression paused until a restart.*; not a wait the clock ends: its pause has no end on the clock\)$/);
});

test('a settle that gives up names, for each agent not at rest whose text names a pause, why that pause isn\'t a wait the clock ends', () => {
  assert.equal(notRestingText(paused(NO_END), CLOCK), `${NO_END}; not a wait the clock ends: its pause has no end on the clock`);
  assert.equal(notRestingText(paused(), T), `${UNTIL}; not a wait the clock ends: its pause ended at 2026-01-06T09:00:05.000Z, and the clock reads 2026-01-06T09:00:05.000Z`);
  assert.equal(notRestingText({ agentName: 'fixture', ready: false, pending: '1 chunks pending', progress: progress() }, CLOCK), '1 chunks pending', 'no pause named, as before');
  assert.equal(notRestingText({ agentName: 'fixture', ready: false, error: 'boom' }, CLOCK), 'boom');
  assert.equal(notRestingText({ agentName: 'fixture', ready: false }, CLOCK), 'no pending work named');
});

test('each agent\'s pause is noted once for its end, with how long it holds from the clock', () => {
  const seen = new Set<string>();
  assert.deepEqual(pauseNotes([{ agent: 'fixture', until: T }], seen, CLOCK), [{ agent: 'fixture', until: T, ms: 5_000 }]);
  assert.deepEqual(pauseNotes([{ agent: 'fixture', until: T }], seen, CLOCK + 1_000), [], 'the same pause, found again');
  assert.deepEqual(pauseNotes([{ agent: 'fixture', until: T + 10_000 }, { agent: 'reader', until: T + 20_000 }], seen, T + 1_000), [{ agent: 'fixture', until: T + 10_000, ms: 9_000 }, { agent: 'reader', until: T + 20_000, ms: 19_000 }], 'a second pause, and another agent\'s');
});
