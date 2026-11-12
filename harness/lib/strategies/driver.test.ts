// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitRefreshEnds, commandEnds, decisionTimer, moveClockTo, refreshEndCounter, refreshesBegun, speechWaits } from './driver.ts';
import { chokidarVersion, configWatched, hostCapabilities, hostFacts, reviewInterval } from './probes.ts';
import { fixtureChannels, hostEnv, laneRecipe } from './recipe.ts';
import { awaitedAfter, bootEchoesOwed, budgetHeld, budgetHeldAt, budgetReportDone, echoWindows, movedSinceJudged, echoOwed, configWriteEcho, addedRules, exitWithin, heldRefusal, heldTurns, lastTake, lateBudgetHold, readSettle, shutdownFailure, speechEnd, subagentResult, givesUp, snapshotOver, unowedConfigEchoes } from './events.ts';
import { configurations } from './script.ts';
import { runOf } from '../workloads/workloads.ts';
import { asRun } from './lane.ts';
import { reachAttach, reachLaunch } from '../reach/interfaces.ts';

const REACH_FIX = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reach', 'testing', 'fixtures'));

test('a shutdown\'s wait for the host to exit doesn\'t count the time the harness spends reading it where it exits', { timeout: 60_000 }, async () => {
  const LIMIT_MS = 2000;
  const READ_MS = 4000;
  const logDir = mkdtempSync(join(tmpdir(), 'exit-within-'));
  const waited = async (counted) => {
    const launch = await reachLaunch({ logDir });
    const child = spawn('bun', [...launch.args, join(REACH_FIX, 'host-exit.mjs')], { cwd: REACH_FIX, env: { ...process.env, ...launch.env }, stdio: 'ignore' });
    let held = false;
    const holdingFirstAsk = (path) => {
      if (!held) { held = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_MS); }
      return path.startsWith(`${REACH_FIX}/`);
    };
    const reach = reachAttach({ launch, child, wanted: holdingFirstAsk });
    try {
      await reach.attached;
      const verdict = await exitWithin(child, LIMIT_MS, counted ? reach : null);
      return { verdict, held, exited: child.exitCode !== null || child.signalCode !== null };
    } finally { child.kill('SIGKILL'); reach.close(); }
  };
  try {
    assert.deepEqual(await waited(true), { verdict: true, held: true, exited: true }, 'the read was entered, and the host exited');
    const uncounted = await waited(false);
    assert.deepEqual([uncounted.verdict, uncounted.held], [false, true], 'the read was entered before the wait gave up');
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

const answer = ({ ready = true, pending = false, queue = 0, compressed = 30, drained = true, deferredWrites = 0, gatedRequests = 0, activeTurnAgents = [], parkedAdmissions = 0, ok = true } = {}) => ({
  ok,
  maintenance: { ran: true, agents: [{ agentName: 'fixture', ready, ...(ready ? {} : { pending: pending ? 'Compressing chunk 31' : `${queue} chunks pending` }), progress: { totalChunks: 32, chunksCompressed: compressed, l1QueueLength: queue, mergeQueueLength: 0, summaryCounts: { l1: compressed, l2: 1, l3: 0 }, pending } }] },
  hostMode: { drained, deferredWrites, gatedRequests, activeTurnAgents, parkedAdmissions },
});

test('a settle decides on the module\'s one-run snapshot: its readiness and host status stand in for `maintain`\'s, which still says whether the pass ran; a turn held by its provider still reaches the held branch', () => {
  const ran = answer({ ready: true, drained: true });
  const snap = (agents, hostMode) => ({ ticks: {}, agents, hostMode });
  const seen = snapshotOver(ran, snap([{ agentName: 'fixture', ready: false, pending: 'Compressing chunk 3' }], { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 }));
  assert.equal(seen.ok, true);
  assert.equal(seen.maintenance.ran, true);
  assert.equal(readSettle(seen, null, {}, 'fixture').settled, false, 'what a turn left between the two requests shows as not ready');
  const held = snapshotOver(ran, snap([{ agentName: 'fixture', ready: true }], { drained: false, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: ['fixture'], parkedAdmissions: 0 }));
  assert.equal(readSettle(held, null, {}, 'fixture').waits, true, 'a turn alive is the held branch\'s to judge');
  assert.equal(snapshotOver(ran, { ticks: {}, agents: null, hostMode: null }), null, 'no snapshot, no settle read');
});

test('a settle reads what `maintain` did from its own answer: a compression it left in flight, and what it moved, keep a pass going where the snapshot read after it shows the queue at rest', () => {
  const worked = answer({ ready: false, pending: true });
  const atRest = { ticks: {}, agents: [{ agentName: 'fixture', ready: false, pending: '2 chunks pending', progress: { totalChunks: 32, chunksCompressed: 30, l1QueueLength: 2, mergeQueueLength: 0, summaryCounts: { l1: 30, l2: 1, l3: 0 }, pending: false } }], hostMode: { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 } };
  const first = readSettle(snapshotOver(worked, atRest), null, {}, 'fixture', worked);
  const again = readSettle(snapshotOver(worked, atRest), first.progress, {}, 'fixture', worked);
  assert.equal(again.inFlight, true, 'the compression maintain\'s answer shows in flight');
  assert.equal(again.settled, false, 'the snapshot isn\'t ready');
  const further = answer({ ready: false, pending: true, compressed: 31 });
  assert.equal(readSettle(snapshotOver(further, atRest), first.progress, {}, 'fixture', further).moved, true, 'what maintain moved, though the snapshot reads the same');
  const idle = answer({ ready: false, queue: 2 });
  const stalled = readSettle(snapshotOver(idle, atRest), readSettle(snapshotOver(idle, atRest), null, {}, 'fixture', idle).progress, {}, 'fixture', idle);
  assert.deepEqual([stalled.inFlight, stalled.moved], [false, false], 'nothing in flight and nothing moved, in either reading, is a stall');
});

test('a later pass gives up only where neither reading moved and neither shows work in flight: work a turn left between `maintain`\'s answer and the snapshot keeps the settle going, and a pass where both readings stay as they were still gives up', () => {
  const host = { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 };
  const progress = (queue) => ({ totalChunks: 32, chunksCompressed: 30, l1QueueLength: queue, mergeQueueLength: 0, summaryCounts: { l1: 30, l2: 1, l3: 0 }, pending: false });
  const ready = { ticks: {}, agents: [{ agentName: 'fixture', ready: true, progress: progress(0) }], hostMode: host };
  const left = { ticks: {}, agents: [{ agentName: 'fixture', ready: false, pending: '1 chunks pending', progress: progress(1) }], hostMode: host };
  const worked = answer({ ready: true });
  const pass = (snap, previous) => readSettle(snapshotOver(worked, snap), previous, {}, 'fixture', worked);
  const first = pass(ready, null);
  const second = pass(ready, first.progress);
  const turned = pass(left, second.progress);
  assert.equal(turned.settled, false, 'the snapshot shows the work the turn left');
  assert.equal(givesUp(turned), false, '`maintain` answered the same, but the snapshot moved');
  const again = pass(left, turned.progress);
  assert.equal(givesUp(again), true, 'both readings as they were, nothing in flight: a stall');
  const other = { ticks: {}, agents: [{ agentName: 'fixture', ready: false, pending: '1 merges pending', progress: { ...progress(0), mergeQueueLength: 1 } }], hostMode: host };
  assert.equal(givesUp(pass(other, again.progress)), false, 'not ready for other work reads as a move');
  assert.equal(pass(left, null).moved, true, 'a first pass has moved, since no pass came before it');
  const compressing = { ticks: {}, agents: [{ agentName: 'fixture', ready: false, pending: 'Compressing chunk 31', progress: { ...progress(1), pending: true } }], hostMode: host };
  const started = pass(compressing, pass(compressing, null).progress);
  assert.deepEqual([started.moved, started.inFlight, givesUp(started)], [false, true, false], 'a compression the snapshot shows in flight, which started after `maintain` answered, keeps the settle going');
  const turning = answer({ ready: false, queue: 1, drained: false, activeTurnAgents: ['fixture'] });
  const afterTurn = readSettle(snapshotOver(turning, left), readSettle(snapshotOver(turning, left), null, {}, 'fixture', turning).progress, {}, 'fixture', turning);
  assert.deepEqual([afterTurn.moved, afterTurn.inFlight, givesUp(afterTurn)], [false, true, false], 'a turn `maintain`\'s answer shows alive, which ended before the snapshot, is work in flight by that reading');
  const writing = (n) => ({ ticks: {}, agents: [{ agentName: 'fixture', ready: true, progress: progress(0) }], hostMode: { ...host, deferredWrites: n } });
  const landing = pass(writing(1), pass(writing(2), null).progress);
  assert.deepEqual([landing.settled, givesUp(landing)], [false, false], 'a deferred write that landed between the two reads moves the snapshot\'s reading, as everything the settle decides on does');
});

test('R7: a settle is settled only when every agent is ready, the host is drained and nothing it deferred is still to land', () => {
  assert.equal(readSettle(answer(), null, {}, 'fixture').settled, true);
  for (const [what, a] of [
    ['a deferred write', answer({ deferredWrites: 1 })],
    ['a host not drained', answer({ drained: false, activeTurnAgents: ['fixture'] })],
    ['an agent not ready', answer({ ready: false, pending: true })],
    ['an answer that isn\'t ok', answer({ ok: false })],
  ]) assert.equal(readSettle(a, null, {}, 'fixture').settled, false, what);
  const two = answer();
  two.maintenance.agents.push({ ...two.maintenance.agents[0], agentName: 'reader', ready: false, pending: 'Compressing chunk 3', progress: { ...two.maintenance.agents[0].progress, pending: true } });
  assert.equal(readSettle(two, null, {}, 'fixture').settled, false, 'one agent of two not ready');
  two.maintenance.agents[1] = { ...two.maintenance.agents[0], agentName: 'reader' };
  assert.equal(readSettle(two, null, {}, 'fixture').settled, true, 'both ready');
});

test('R7f: a pass only waits when it would settle but for a turn alive or a wake waiting to start one, and otherwise doesn\'t', () => {
  for (const [what, a] of [
    ['a turn alive', answer({ drained: false, activeTurnAgents: ['fixture'] })],
    ['a wake waiting', answer({ gatedRequests: 1 })],
    ['both', answer({ drained: false, activeTurnAgents: ['fixture'], gatedRequests: 1 })],
  ]) assert.equal(readSettle(a, null, {}, 'fixture').waits, true, what);
  for (const [what, a, ticks] of [
    ['a settled host', answer(), {}],
    ['a deferred write beside the turn', answer({ drained: false, activeTurnAgents: ['fixture'], deferredWrites: 1 }), {}],
    ['an agent not ready beside the turn', answer({ drained: false, activeTurnAgents: ['fixture'], ready: false, pending: true }), {}],
    ['a compression ticking beside the turn', answer({ drained: false, activeTurnAgents: ['fixture'] }), { fixture: 1 }],
    ['a wake parked on admission beside the turn', answer({ drained: false, activeTurnAgents: ['fixture'], parkedAdmissions: 1 }), {}],
    ['an answer that isn\'t ok', answer({ drained: false, activeTurnAgents: ['fixture'], ok: false }), {}],
  ]) assert.equal(readSettle(a, null, ticks, 'fixture').waits, false, what);
});

const readout = ({ status = 'idle', primaryActive = false, auxiliaryInFlight = 0, cooldownUntil = 160_000, heldRequests = 1, budgetHold = null, pendingRequests = 0, activeStreams = [], name = 'fixture' } = {}) => ({
  agents: [{ name, status, primaryActive, auxiliaryInFlight, cooldownUntil, heldRequests, budgetHold }], pendingRequests, activeStreams,
});

test('D23: every turn alive, and every wake waiting, is provider-held when each agent with one is idle, starts nothing, has no auxiliary call in flight and has a request held by a hold that ends after the clock, with nothing pending outside the holds and no stream open; otherwise the reason names what isn\'t so', () => {
  const alive = answer({ drained: false, activeTurnAgents: ['fixture'] });
  assert.deepEqual(heldTurns(alive, readout(), 100_000), { holds: [{ agent: 'fixture', until: 160_000 }] });
  assert.match(heldTurns(alive, readout(), 100_000, new Set()).why, /fixture's hold ends at 160000 on a timer the workload's clock doesn't run/, 'a hold whose end no virtual timer is due at runs on a real timer');
  assert.deepEqual(heldTurns(alive, readout(), 100_000, new Set([160_000])), { holds: [{ agent: 'fixture', until: 160_000 }] });
  assert.deepEqual(heldTurns(answer({ drained: false, activeTurnAgents: ['fixture'], gatedRequests: 1 }), readout({ heldRequests: 2 }), 100_000), { holds: [{ agent: 'fixture', until: 160_000 }] }, 'a wake held beside the turn\'s retry');
  assert.deepEqual(heldTurns(answer({ gatedRequests: 1 }), readout(), 100_000), { holds: [{ agent: 'fixture', until: 160_000 }] }, 'a wake held with no turn alive');
  assert.match(heldTurns(answer({ gatedRequests: 1 }), readout({ heldRequests: 0 }), 100_000).why, /1 wake\(s\) waiting outside any hold/);
  for (const [what, r, said] of [
    ['a request pending outside the hold', readout({ pendingRequests: 1 }), /1 request\(s\) pending outside any hold/],
    ['a stream open', readout({ activeStreams: ['fixture'] }), /a stream open \(fixture\)/],
    ['an agent not idle', readout({ status: 'streaming' }), /fixture is streaming/],
    ['a start under way', readout({ primaryActive: true }), /fixture is starting a turn/],
    ['an auxiliary call in flight', readout({ auxiliaryInFlight: 1 }), /fixture has 1 auxiliary call\(s\) in flight/],
    ['no request held', readout({ heldRequests: 0 }), /fixture has no request held/],
    ['a hold until released', readout({ cooldownUntil: null }), /fixture's hold has no end on the clock/],
    ['a hold whose end has come', readout({ cooldownUntil: 100_000 }), /fixture's hold ended at 100000, and the clock reads 100000/],
    ['an agent the readout doesn\'t list', readout({ name: 'other' }), /the readout lists no agent fixture/],
  ]) {
    const read = heldTurns(alive, r, 100_000);
    assert.equal(read.holds, undefined, what);
    assert.match(read.why, said, what);
  }
  assert.match(heldTurns(answer(), readout({ heldRequests: 0 }), 100_000).why, /no turn is alive and no wake waits/);
});

test('D23c: a budget hold on any agent refuses a held end, naming it, since it waits on compression and no move of the clock ends it; agent-framework counts its wakes among the gated, and its agent gives up its turn', () => {
  const budgetHeld = { name: 'researcher', status: 'idle', primaryActive: false, auxiliaryInFlight: 0, cooldownUntil: null, heldRequests: 0, budgetHold: { since: 90_000, heldRequests: 1 } };
  const both = { ...readout(), agents: [...readout().agents, budgetHeld] };
  const read = heldTurns(answer({ drained: false, activeTurnAgents: ['fixture'], gatedRequests: 2 }), both, 100_000);
  assert.equal(read.holds, undefined, 'one agent provider-held and another budget-held');
  assert.match(read.why, /researcher waits in a budget hold, which no move of the clock ends/);
  const own = heldTurns(answer({ drained: false, activeTurnAgents: ['fixture'] }), readout({ budgetHold: { since: 90_000, heldRequests: 1 } }), 100_000);
  assert.match(own.why, /fixture waits in a budget hold/, 'a budget hold on the provider-held agent itself');
  assert.deepEqual(heldTurns(answer({ drained: false, activeTurnAgents: ['fixture'] }), readout({ budgetHold: null }), 100_000), { holds: [{ agent: 'fixture', until: 160_000 }] }, 'none, as the readout gives it');
});

test('D23d: a readout the test module couldn\'t take, and a maintain answer with no count of gated requests, refuse a held end, saying why', () => {
  const alive = answer({ drained: false, activeTurnAgents: ['fixture'] });
  assert.match(heldTurns(alive, { why: 'the host\'s agent-framework gives no healthSnapshot()' }, 100_000).why, /the held readout: the host's agent-framework gives no healthSnapshot\(\)/);
  const uncounted = { ...alive, hostMode: { ...alive.hostMode } };
  delete uncounted.hostMode.gatedRequests;
  assert.match(heldTurns(uncounted, readout(), 100_000).why, /no count of gated requests in the host's answer/);
});

test('D23b: a settle that must find the host drained, before a checkpoint, a restart or the run\'s end, refuses a held end, naming each hold and what needs the host drained; any other settle takes it', () => {
  const holds = [{ agent: 'fixture', until: Date.UTC(2026, 0, 5, 12, 36, 30) }, { agent: 'reader', until: Date.UTC(2026, 0, 5, 12, 37, 0) }];
  assert.equal(heldRefusal(holds, 'the run\'s end'), 'a provider hold keeps fixture waiting until 2026-01-05T12:36:30.000Z and reader waiting until 2026-01-05T12:37:00.000Z, where the run\'s end needs the host drained');
  assert.equal(heldRefusal(holds, null), null);
});

test('D23b: a hold whose agent the host gave no name is named in the refusal as the record writes its line, (no agent name)', () => {
  const holds = [{ agent: null, until: Date.UTC(2026, 0, 5, 12, 36, 30) }, { agent: 'reader', until: Date.UTC(2026, 0, 5, 12, 37, 0) }];
  assert.equal(heldRefusal(holds, 'the run\'s end'), 'a provider hold keeps (no agent name) waiting until 2026-01-05T12:36:30.000Z and reader waiting until 2026-01-05T12:37:00.000Z, where the run\'s end needs the host drained');
});

test('R7c: a compression the host\'s auto-tick started holds the settle while the test module counts it, though maintenance looks settled', () => {
  assert.equal(readSettle(answer(), null, { fixture: 0 }, 'fixture').settled, true);
  const read = readSettle(answer(), null, { fixture: 1 }, 'fixture');
  assert.equal(read.settled, false);
  assert.equal(read.inFlight, true);
  assert.deepEqual(read.ticking, ['fixture 1']);
});

test('R7: work is in flight while a compression runs, a turn is alive or a wake is parked, and otherwise isn\'t', () => {
  assert.equal(readSettle(answer({ ready: false, pending: true }), null, {}, 'fixture').inFlight, true);
  assert.equal(readSettle(answer({ drained: false, activeTurnAgents: ['fixture'] }), null, {}, 'fixture').inFlight, true);
  assert.equal(readSettle(answer({ drained: false, parkedAdmissions: 1 }), null, {}, 'fixture').inFlight, true);
  assert.equal(readSettle(answer({ ready: false, queue: 2 }), null, {}, 'fixture').inFlight, false);
  assert.equal(readSettle(answer({ deferredWrites: 1 }), null, {}, 'fixture').inFlight, false);
});

test('R7: a pass moved the work on when its progress or its deferred writes differ from the pass before, and the first pass always has', () => {
  const before = answer({ ready: false, queue: 2, compressed: 29 });
  assert.equal(readSettle(before, null, {}, 'fixture').moved, true);
  const seen = readSettle(before, null, {}, 'fixture').progress;
  assert.equal(readSettle(answer({ ready: false, queue: 1, compressed: 30 }), seen, {}, 'fixture').moved, true, 'a chunk compressed');
  assert.equal(readSettle(answer({ ready: false, queue: 2, compressed: 29 }), seen, {}, 'fixture').moved, false, 'nothing changed');
  const deferred = readSettle(answer({ deferredWrites: 2 }), null, {}, 'fixture').progress;
  assert.equal(readSettle(answer({ deferredWrites: 1 }), deferred, {}, 'fixture').moved, true, 'a deferred write landed');
  assert.equal(readSettle(answer({ deferredWrites: 2 }), deferred, {}, 'fixture').moved, false, 'none landed');
});

test('D12: `/budget`\'s output is whole once it holds the agent\'s own line, or a line that is no part of the report, and not before', () => {
  const header = '--- Stream Token Budgets ---';
  assert.equal(budgetReportDone([], 'fixture'), false);
  assert.equal(budgetReportDone([header], 'fixture'), false);
  assert.equal(budgetReportDone([header, '  other: 150.0k (last: 0, 0%)'], 'fixture'), false, 'another agent\'s line: ours is still to come');
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%)'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixturette: 1.0k (last: 0, 0%)'], 'fixture'), false, 'another agent whose name starts with ours');
  assert.equal(budgetReportDone(['No agents.'], 'fixture'), true);
  assert.equal(budgetReportDone(['Unknown command: /budget'], 'fixture'), true, 'a host without the report doesn\'t hold the run');
});

test('R7b: an answer with no deferred-write count isn\'t settled, so a host that stops reporting it fails the settle', () => {
  const unreported = answer();
  delete unreported.hostMode.deferredWrites;
  assert.equal(readSettle(unreported, null, {}, 'fixture').settled, false);
  assert.equal(readSettle(answer(), null, {}, 'fixture').settled, true);
});

test('R7e: a wake the gate let through that no turn has taken up yet holds the settle, and an answer with no count of such wakes is never settled', () => {
  const read = readSettle(answer({ gatedRequests: 1 }), null, {}, 'fixture');
  assert.equal(read.settled, false);
  assert.equal(read.inFlight, true);
  const unreported = answer();
  delete unreported.hostMode.gatedRequests;
  assert.equal(readSettle(unreported, null, {}, 'fixture').settled, false);
});

test('R7d: an ok answer whose agents aren\'t a list, or list no agent with the run\'s name, is unreadable and never settled', () => {
  const moved = answer();
  moved.maintenance.members = moved.maintenance.agents;
  delete moved.maintenance.agents;
  const keyed = answer();
  keyed.maintenance.agents = { fixture: keyed.maintenance.agents[0] };
  const empty = answer();
  empty.maintenance.agents = [];
  const renamed = answer();
  renamed.maintenance.agents = renamed.maintenance.agents.map(({ agentName, ...rest }) => ({ name: agentName, ...rest }));
  for (const [what, a, said] of [
    ['agents moved', moved, 'holds no list of agents'],
    ['agents keyed by name', keyed, 'holds no list of agents'],
    ['an empty list', empty, 'lists no agent named "fixture"'],
    ['each agent\'s name under another key', renamed, 'lists no agent named "fixture"'],
  ]) {
    const read = readSettle(a, null, {}, 'fixture');
    assert.equal(read.settled, false, what);
    assert.equal(read.unreadable, said, what);
  }
  assert.equal(readSettle(answer(), null, {}, 'other').unreadable, 'lists no agent named "other"');
  assert.equal(readSettle(answer({ ok: false }), null, {}, 'fixture').unreadable, undefined, 'an answer that isn\'t ok is the settle\'s own failure');
  assert.equal(readSettle(answer(), null, {}, 'fixture').unreadable, undefined);
});

test('D14: a step whose decision a timer starts waits, after the round that fires that timer, for the decision before that round\'s settle, and then for the turns it starts before the clock moves on, so what the decision writes, and the turn it starts, come at the time the timer fired; a round firing any other timer doesn\'t wait; and a step whose timer never fires is undecided', { timeout: 5_000 }, async () => {
  const host = (rounds) => {
    const h = { clock: 0, order: [], decidedAt: null, pending: false, turnAt: null };
    h.advance = async (to) => {
      const r = rounds.shift();
      h.clock = r ? r.at : to;
      h.order.push(`advance ${h.clock}`);
      if (r?.decides) {
        h.pending = true;
        setImmediate(() => {
          h.decidedAt = h.clock;
          h.order.push(`decision ${h.clock}`);
          setImmediate(() => { h.turnAt = h.clock; h.order.push(`turn ${h.clock}`); });
        });
      }
      return r ? r.fired : null;
    };
    h.settle = async () => { h.order.push('settle'); };
    const until = (done) => new Promise((resolve) => { const look = () => (done() ? resolve() : setImmediate(look)); look(); });
    h.landed = () => until(() => h.decidedAt !== null && h.turnAt !== null);
    h.made = () => {
      h.order.push(`wait ${h.clock}`);
      return h.pending ? until(() => h.decidedAt !== null) : Promise.reject(new Error(`waited for a decision at ${h.clock}, where no timer that starts one has fired`));
    };
    h.turns = () => {
      h.order.push(`turns ${h.clock}`);
      return until(() => h.turnAt !== null);
    };
    return h;
  };
  const judge = { delay: 60_000, repeat: false };
  const tick = { delay: 60_000, repeat: true };
  const h = host([{ at: 58_000, fired: tick }, { at: 60_000, fired: judge, decides: true }]);
  const moved = await moveClockTo(61_000, { advance: h.advance, settle: h.settle, decision: { timer: judge, made: h.made, turns: h.turns } });
  await h.landed();
  assert.equal(h.decidedAt, 60_000, 'the decision is written at the time its timer fired, not at the step\'s end');
  assert.equal(h.turnAt, 60_000, 'the turn the decision starts comes at that time too');
  assert.deepEqual(h.order, ['advance 58000', 'settle', 'advance 60000', 'wait 60000', 'decision 60000', 'settle', 'turns 60000', 'turn 60000', 'advance 61000']);
  assert.deepEqual(moved, { decided: true });
  const never = host([{ at: 58_000, fired: tick }, { at: 60_000, fired: { delay: 30_000, repeat: false } }]);
  assert.deepEqual(await moveClockTo(61_000, { advance: never.advance, settle: never.settle, decision: { timer: judge, made: never.made, turns: never.turns } }), { decided: false });
  assert.deepEqual(never.order, ['advance 58000', 'settle', 'advance 60000', 'settle', 'advance 61000']);
});

test('D24: a move ends where a settle inside it has already taken the clock past its target, as a held reply\'s acts do, without asking the clock to go back', { timeout: 5_000 }, async () => {
  const order = [];
  let clock = 0;
  const judge = { delay: 30_000, repeat: false };
  const rounds = [{ at: 30_000, fired: judge }];
  const advance = async (to) => {
    const r = rounds.shift();
    clock = r ? r.at : to;
    order.push(`advance ${clock}`);
    return r ? r.fired : null;
  };
  const settle = async () => { order.push('settle'); clock = 61_000; };
  assert.deepEqual(await moveClockTo(31_000, { advance, settle, now: () => clock }), { decided: false });
  assert.deepEqual(order, ['advance 30000', 'settle']);
});

test('a move waits for the end of every keepalive refresh begun, asking again after each end, since the next lineage\'s refresh begins only then', { timeout: 5_000 }, async () => {
  let ends = 0;
  const order = [];
  const begun = async () => {
    const count = ends === 0 ? 1 : 2;
    order.push(`begun ${count}`);
    return count;
  };
  const wait = async (done, count) => {
    order.push(`wait ${count}`);
    assert.equal(done(), false, 'the wait starts before its refresh has ended');
    ends += 1;
    assert.equal(done(), true, 'and is done at its end');
  };
  await awaitRefreshEnds({ begun, ended: () => ends, wait });
  assert.equal(ends, 2, 'the refresh begun after the first one ended is waited for too');
  assert.deepEqual(order, ['begun 1', 'wait 1', 'begun 2', 'wait 2', 'begun 2']);
  const none = async () => assert.fail('nothing is waited for');
  await awaitRefreshEnds({ begun: async () => 0, ended: () => 0, wait: none });
  await awaitRefreshEnds({ begun: async () => 1, ended: () => 1, wait: none });
});

test('a move whose clock answers while an end is on its way asks again, so the refresh the next lineage begins after that end is waited for too', { timeout: 5_000 }, async () => {
  let ends = 0;
  const asked = [];
  const begun = async () => {
    const count = asked.length === 0 ? 1 : 2;
    asked.push(count);
    if (asked.length === 1) ends = 1;
    return count;
  };
  const waited = [];
  const wait = async (done, count) => {
    waited.push(count);
    ends = count;
    assert.equal(done(), true);
  };
  await awaitRefreshEnds({ begun, ended: () => ends, wait });
  assert.equal(ends, 2, 'the second lineage\'s refresh, begun after the end that came with the first answer, is waited for');
  assert.deepEqual(asked, [1, 2, 2]);
});

test('a count with a request the clock couldn\'t read is refused, naming how many, rather than taken as the refreshes begun', () => {
  assert.equal(refreshesBegun({ begun: 2, unreadable: 0 }), 2);
  assert.throws(() => refreshesBegun({ begun: 2, unreadable: 1 }), /^Error: the host sent 1 request to a Messages front whose body the clock can't read as a string, so whether it was a keepalive refresh can't be told, nor its end waited for$/);
});

test('a refresh\'s end is a whole "[cache-keepalive]" line of the host\'s of type refreshed, ineffective or error, counted once a line split across chunks is whole', () => {
  const ends = refreshEndCounter();
  const line = (type) => `[cache-keepalive] ${JSON.stringify({ type, key: 'k' })}\n`;
  assert.equal(ends(line('refreshed') + line('ineffective') + line('error')), 3);
  assert.equal(ends(line('skipped') + line('expired') + line('disabled') + 'refreshed\n'), 0, 'no other event, and no other line, ends a refresh');
  const split = line('refreshed');
  assert.equal(ends(split.slice(0, 25)), 0, 'half a line ends nothing');
  assert.equal(ends(split.slice(25)), 1, 'and its other half ends one refresh');
});

test('D25: a judged step\'s timer is also found for a rule an earlier step\'s scripted call adds at run time, the latest add of that name deciding; a rule the step\'s own or a later call adds isn\'t', () => {
  const configuration = { modules: { wake: { policies: [] } } };
  const add = (name, debounceMs) => ({ name: 'toolsets--act', input: { tool: 'wake_add_rule', args: { name, match: { channel: `*${name}` }, judge: { debounceMs, instructions: 'x' } } } });
  const steps = [
    { id: 'a', kind: 'console', replies: [{ calls: [add('quick', 45_000)] }, { calls: [add('quick', 30_000)] }] },
    { id: 'b', kind: 'advance', ms: 31_000, verdict: 'quick', replies: [{ calls: [add('own', 30_000)] }] },
    { id: 'c', kind: 'console', replies: [{ calls: [add('late', 30_000)] }] },
  ];
  const added = addedRules(steps, steps[1]);
  assert.deepEqual(decisionTimer(steps[1], { configuration, facts: {}, added }), { delay: 30_000, repeat: false });
  for (const name of ['own', 'late']) assert.throws(() => decisionTimer({ ...steps[1], verdict: name }, { configuration, facts: {}, added }), new RegExp(`rule ${name}'s reply judge`));
});

test('D25c: a judged or reviewed step names its decision\'s timer by the delay cut to whole milliseconds, as the clock arms and reports it', () => {
  const configuration = { modules: { wake: { policies: [{ name: 'half', match: { channel: '*half' }, behavior: { judge: { debounceMs: 30_000.5, instructions: 'x' } } }] } } };
  const add = { name: 'toolsets--act', input: { tool: 'wake_add_rule', args: { name: 'scripted', match: { channel: '*scripted' }, judge: { debounceMs: 45_000.9, instructions: 'x' } } } };
  const steps = [{ id: 'a', kind: 'console', replies: [{ calls: [add] }] }, { id: 'b', kind: 'advance', ms: 61_000, verdict: 'half' }];
  assert.deepEqual(decisionTimer(steps[1], { configuration, facts: {}, added: addedRules(steps, steps[1]) }), { delay: 30_000, repeat: false });
  assert.deepEqual(decisionTimer({ ...steps[1], verdict: 'scripted' }, { configuration, facts: {}, added: addedRules(steps, steps[1]) }), { delay: 45_000, repeat: false });
  assert.deepEqual(decisionTimer({ id: 'c', kind: 'advance', ms: 61_000, review: true }, { configuration, facts: { reviewMs: 60_000.7 }, added: [] }), { delay: 60_000, repeat: false });
});

test('D25b: a rule an earlier step\'s scripted wake_remove_rule removed, the recipe\'s or one added at run time, has no timer, and the step is refused, naming the removal; a rule added again after its removal has its new one', () => {
  const configuration = { modules: { wake: { policies: [{ name: 'kept', match: { channel: '*kept' }, behavior: { judge: { debounceMs: 45_000, instructions: 'x' } } }] } } };
  const act = (tool, args) => ({ name: 'toolsets--act', input: { tool, args } });
  const add = (name, debounceMs) => act('wake_add_rule', { name, match: { channel: `*${name}` }, judge: { debounceMs, instructions: 'x' } });
  const steps = [
    { id: 'a', kind: 'console', replies: [{ calls: [add('quick', 30_000), act('wake_remove_rule', { name: 'quick' }), act('wake_remove_rule', { name: 'kept' })] }] },
    { id: 'b', kind: 'console', replies: [{ calls: [add('again', 30_000)] }, { calls: [act('wake_remove_rule', { name: 'again' }), add('again', 20_000)] }] },
    { id: 'c', kind: 'advance', ms: 31_000, verdict: 'quick' },
  ];
  const added = addedRules(steps, steps[2]);
  for (const name of ['quick', 'kept']) assert.throws(() => decisionTimer({ ...steps[2], verdict: name }, { configuration, facts: {}, added }), new RegExp(`rule ${name}'s reply judge: an earlier step's wake_remove_rule removed it`));
  assert.deepEqual(decisionTimer({ ...steps[2], verdict: 'again' }, { configuration, facts: {}, added }), { delay: 20_000, repeat: false });
  const plain = [{ id: 'a', kind: 'console', replies: [{ calls: [act('wake_remove_rule', { name: 'kept' }), act('wake_add_rule', { name: 'kept', match: { channel: '*kept' }, behavior: 'defer' })] }] }, steps[2]];
  assert.throws(() => decisionTimer({ ...steps[2], verdict: 'kept' }, { configuration, facts: {}, added: addedRules(plain, plain[1]) }), /rule kept's reply judge: the earlier step's wake_add_rule that last added it gives it no judge debounceMs/, 'a rule added again with no judge has none, whatever the recipe gave it');
});

test('D15: a judged step\'s timer is its rule\'s debounceMs as the recipe gives it, and a reviewed step\'s the review interval in the host\'s facts, each one-shot; any other step has none; and one the driver can\'t tell is refused, naming why', () => {
  const configuration = { modules: { wake: { policies: [{ name: 'quiet', match: { channel: '*quiet' }, behavior: 'defer' }, { name: 'judged', match: { channel: '*judged' }, behavior: { judge: { debounceMs: 45_000, instructions: 'x' } } }] } } };
  const facts = { reviewMs: 5_400_000 };
  assert.deepEqual(decisionTimer({ kind: 'advance', ms: 46_000, verdict: 'judged' }, { configuration, facts }), { delay: 45_000, repeat: false });
  assert.deepEqual(decisionTimer({ kind: 'advance', ms: 1_000, review: true }, { configuration, facts }), { delay: 5_400_000, repeat: false });
  assert.equal(decisionTimer({ kind: 'advance', ms: 61_000 }, { configuration, facts }), null);
  assert.throws(() => decisionTimer({ kind: 'advance', ms: 1, verdict: 'quiet' }, { configuration, facts }), /can't tell which timer starts rule quiet's reply judge: neither the recipe nor an earlier step's wake_add_rule gives a judge rule of that name a debounceMs/);
  assert.throws(() => decisionTimer({ kind: 'advance', ms: 1, verdict: 'gone' }, { configuration, facts }), /rule gone's reply judge/);
  assert.throws(() => decisionTimer({ kind: 'advance', ms: 1, review: true }, { configuration, facts: { reviewMs: null } }), /can't tell which timer starts the suppression review: the host's facts give no review interval \(null\)/);
});

test('D16: a turn\'s speech ends at the first of its agent\'s publish, route failure or drafts held, or a delivery receipt, with the reason the host gives; another agent\'s publish, route failure or drafts held don\'t end it, and a receipt that comes while another agent\'s turn is alive can\'t be told apart, since a receipt\'s trace names no agent; a turn that started silent ends at once; and speech nothing ends hasn\'t ended', () => {
  const ev = (e) => ({ at: 0, e });
  const start = (agentName, extra = {}) => ev({ type: 'inference:started', agentName, ...extra });
  const speech = ev({ type: 'inference:speech', agentName: 'fixture', content: 'words' });
  const after = (...es) => speechEnd([start('fixture'), speech, ...es.map(ev)], 1);
  assert.deepEqual(after({ type: 'inference:published_complete', agentName: 'fixture', channelId: 'chat' }), { how: 'published' });
  assert.deepEqual(after({ type: 'mcpl:speech-route-failed', conversationId: 'fixture', reason: 'turn has no locus' }), { how: 'undelivered', reason: 'turn has no locus' });
  assert.deepEqual(after({ type: 'mcpl:speech-route-failed', conversationId: 'fixture' }), { how: 'undelivered', reason: null });
  assert.deepEqual(after({ type: 'prose:drafts-held', agentName: 'fixture', reason: 'no-destination' }), { how: 'held', reason: 'no-destination' });
  assert.deepEqual(after({ type: 'message:added', messageId: 'm9', source: 'delivery-receipt' }), { how: 'receipt' });
  assert.deepEqual(after({ type: 'prose:drafts-held', agentName: 'fixture', reason: 'bounced' }, { type: 'inference:published_complete', agentName: 'fixture' }), { how: 'held', reason: 'bounced' }, 'the first end');
  assert.equal(after({ type: 'inference:published_complete', agentName: 'helper' }, { type: 'mcpl:speech-route-failed', conversationId: 'helper' }, { type: 'prose:drafts-held', agentName: 'helper', reason: 'no-destination' }, { type: 'message:added', messageId: 'm1', source: 'trigger' }), null, 'another agent\'s ends, and a message that isn\'t a receipt');
  assert.equal(after(), null, 'speech nothing ends, such as whitespace alone');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'message:added', messageId: 'm2', source: 'delivery-receipt' }), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'a receipt while another agent\'s turn is alive could be that turn\'s');
  assert.deepEqual(speechEnd([start('helper'), start('fixture'), speech, ev({ type: 'message:added', messageId: 'm3', source: 'delivery-receipt' })], 2), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'one alive since before the speech');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'inference:completed', agentName: 'helper' }, { type: 'message:added', messageId: 'm4', source: 'delivery-receipt' }), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'one alive between them, though it ended before the receipt');
  assert.deepEqual(speechEnd([start('helper'), ev({ type: 'inference:aborted', agentName: 'helper' }), start('fixture'), speech, ev({ type: 'message:added', messageId: 'm5', source: 'delivery-receipt' })], 3), { how: 'receipt' }, 'one that ended before the speech');
  assert.deepEqual(speechEnd([start('helper'), start('fixture'), speech, ev({ type: 'inference:completed', agentName: 'helper' }), ev({ type: 'message:added', messageId: 'm8', source: 'delivery-receipt' })], 2), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'one alive at the speech that ends before the receipt');
  assert.deepEqual(speechEnd([start('helper'), ev({ type: 'inference:failed', agentName: 'helper' }), start('fixture'), speech, ev({ type: 'message:added', messageId: 'm9', source: 'delivery-receipt' })], 3), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'a failure before the speech ends no turn either');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'inference:exhausted', agentName: 'helper' }, { type: 'message:added', messageId: 'm6', source: 'delivery-receipt' }), { how: 'unsure', of: 'receipt', agents: ['helper'] });
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'inference:failed', agentName: 'helper' }, { type: 'message:added', messageId: 'm7', source: 'delivery-receipt' }), { how: 'unsure', of: 'receipt', agents: ['helper'] }, 'a failure agent-framework may retry ends no turn');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'inference:published_complete', agentName: 'fixture' }), { how: 'published' }, 'its own publish is its own, whoever else is alive');
  assert.deepEqual(speechEnd([start('fixture', { silent: true }), start('helper'), speech], 2), { how: 'silent' });
  assert.equal(speechEnd([start('fixture', { silent: true }), start('fixture'), speech], 2), null, 'only the turn\'s own start says');
});

test('D16b: a speech also ends at a bounce notice alone, as a private turn\'s bounced words write it, under a receipt\'s rule: only where no other agent\'s turn was alive from the speech to the notice, which names no agent either; where drafts are held before the notice, as a bounce at agent-framework\'s main that holds a draft holds it first, the drafts held are its end', () => {
  const ev = (e) => ({ at: 0, e });
  const speech = ev({ type: 'inference:speech', agentName: 'fixture', content: 'words' });
  const after = (...es) => speechEnd([ev({ type: 'inference:started', agentName: 'fixture' }), speech, ...es.map(ev)], 1);
  assert.deepEqual(after({ type: 'message:added', messageId: '', source: 'prose-bounce' }), { how: 'bounced' });
  assert.deepEqual(after({ type: 'prose:drafts-held', agentName: 'fixture', reason: 'bounced' }, { type: 'message:added', messageId: '', source: 'prose-bounce' }), { how: 'held', reason: 'bounced' });
  const bounce = { type: 'message:added', messageId: '', source: 'prose-bounce' };
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, bounce), { how: 'unsure', of: 'bounced', agents: ['helper'] }, 'a notice while another agent\'s turn is alive could be that turn\'s');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'inference:completed', agentName: 'helper' }, bounce), { how: 'unsure', of: 'bounced', agents: ['helper'] }, 'one alive between them, though it ended before the notice');
  assert.deepEqual(speechEnd([ev({ type: 'inference:started', agentName: 'helper' }), ev({ type: 'inference:started', agentName: 'fixture' }), speech, ev(bounce)], 2), { how: 'unsure', of: 'bounced', agents: ['helper'] }, 'one alive since before the speech');
  assert.deepEqual(speechEnd([ev({ type: 'inference:started', agentName: 'helper' }), ev({ type: 'inference:completed', agentName: 'helper' }), ev({ type: 'inference:started', agentName: 'fixture' }), speech, ev(bounce)], 3), { how: 'bounced' }, 'one that ended before the speech');
  assert.deepEqual(after({ type: 'inference:started', agentName: 'helper' }, { type: 'prose:drafts-held', agentName: 'fixture', reason: 'bounced' }, bounce), { how: 'held', reason: 'bounced' }, 'drafts it holds name its agent, whoever else is alive');
});

test('D18: a gate write to its config file is echoed, at its place among the step\'s events and naming the file it wrote, only once a workspace change or creation naming that file has been processed in the `_config` mount after the step\'s last such write; a write with no file, or an earlier or other change, isn\'t', () => {
  const added = (configPath = '/s/sessions/x/config/gate.json') => ({ type: 'gate:policy-added', policyName: 'p', configPath });
  const removed = { type: 'gate:policy-removed', policyName: 'p', configPath: '/s/sessions/x/config/gate.json' };
  const modified = (...paths) => ({ type: 'process:completed', processEvent: { type: 'workspace:modified', mount: '_config', paths } });
  assert.deepEqual(configWriteEcho([]), { wrote: false });
  assert.deepEqual(configWriteEcho([{ type: 'gate:policy-added', policyName: 'p' }, { type: 'tool:completed' }]), { wrote: false }, 'a policy held with no config file');
  assert.deepEqual(configWriteEcho([added(), { type: 'tool:completed' }]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false });
  assert.deepEqual(configWriteEcho([added(), modified('_config/gate.json')]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: true });
  assert.deepEqual(configWriteEcho([added(), { type: 'process:received', processEvent: { type: 'workspace:modified', mount: '_config', paths: ['_config/gate.json'] } }]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false }, 'an echo received but not yet processed');
  assert.deepEqual(configWriteEcho([modified('_config/gate.json'), removed]), { wrote: true, at: 1, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false }, 'an echo of an earlier write');
  assert.deepEqual(configWriteEcho([added(), modified('_config/gate.json'), removed]), { wrote: true, at: 2, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false }, 'two writes, echoed only between them');
  assert.deepEqual(configWriteEcho([added(), modified('_config/gate.json'), removed, modified('_config/gate.json')]), { wrote: true, at: 2, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: true });
  assert.deepEqual(configWriteEcho([added(), modified('_config/gate.recipe.json'), { type: 'process:completed', processEvent: { type: 'workspace:modified', mount: 'watched', paths: ['watched/gate.json'] } }]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false }, 'another file\'s change');
  assert.deepEqual(configWriteEcho([added(), { type: 'process:completed', processEvent: { type: 'workspace:created', mount: '_config', paths: ['_config/gate.json'] } }]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: true }, 'a write that made the file');
  assert.deepEqual(configWriteEcho([added(), { type: 'process:completed', processEvent: { type: 'workspace:deleted', mount: '_config', paths: ['_config/gate.json'] } }]), { wrote: true, at: 0, file: '/s/sessions/x/config/gate.json', path: '_config/gate.json', echoed: false }, 'a deletion');
  assert.deepEqual(configWriteEcho([added('/s/sessions/x/config/rules.json'), modified('_config/gate.json', '_config/rules.json')]), { wrote: true, at: 0, file: '/s/sessions/x/config/rules.json', path: '_config/rules.json', echoed: true }, 'the file the write names');
});

test('D19: whether the host watches its `_config` mount is read per arm from the mounts it builds for the run\'s recipe, beside agent-framework\'s workspace watcher: watched, not mounted or never watched, and couldn\'t tell, which throws naming why', () => {
  const host = mkdtempSync(join(tmpdir(), 'cv-config-watch-'));
  const put = (path, text = '') => { mkdirSync(join(host, path, '..'), { recursive: true }); writeFileSync(join(host, path), text); };
  const watched = (workspace) => configWatched({ hostDir: host, configuration: { ...configurations().H1, modules: { ...configurations().H1.modules, ...(workspace === undefined ? {} : { workspace }) } } });
  const mounts = (watch) => `export function buildWorkspaceMounts(workspace, storePath) {
  if (workspace === false) return null;
  const mounts = [{ name: 'input', path: '/i', mode: 'read-only', watch: 'never' }];
  if (typeof workspace === 'object' && workspace.configMount) mounts.push({ name: '_config', path: storePath + '/config', mode: 'read-write', watch: ${JSON.stringify(watch)}, include: ['gate.json', 'gate.js', 'gate.recipe.json'] });
  return mounts;
}
`;
  try {
    assert.throws(() => watched({ configMount: true }), /couldn't tell whether the host watches its _config mount: .*workspace-mounts\.ts/);
    put('src/workspace-mounts.ts', 'export const other = 1;\n');
    assert.throws(() => watched({ configMount: true }), /couldn't tell whether the host watches its _config mount: .*exports no function buildWorkspaceMounts/);
    put('src/workspace-mounts.ts', mounts('always'));
    assert.throws(() => watched({ configMount: true }), /couldn't tell whether the host watches its _config mount: .*agent-framework.*workspace watcher/);
    put('node_modules/@animalabs/agent-framework/src/modules/workspace/watcher.ts');
    assert.deepEqual(watched({ configMount: true }), { include: ['gate.json', 'gate.js', 'gate.recipe.json'] });
    assert.equal(watched({ mounts: [{ name: 'input', path: './input' }] }), null, 'no config mount');
    assert.equal(watched(undefined), null, 'no workspace module in the recipe');
    put('src/workspace-mounts.ts', mounts('always').replace(", include: ['gate.json', 'gate.js', 'gate.recipe.json']", ''));
    assert.throws(() => watched({ configMount: true }), /couldn't tell whether the host watches its _config mount: its _config mount gives no include list of names/);
    put('src/workspace-mounts.ts', mounts('never'));
    assert.equal(watched({ configMount: true }), null, 'a config mount never watched');
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('D20: every echo of a watched _config file is owed, by a traced gate write before it or by the first boot\'s start, as its creation or change, each write or boot file owing one, and any other, every deletion included, is named', () => {
  const added = { type: 'gate:policy-added', policyName: 'p', configPath: '/s/sessions/x/config/gate.json' };
  const echo = (type, ...paths) => ({ type: 'process:received', processEvent: { type, mount: '_config', paths } });
  assert.deepEqual(unowedConfigEchoes([]), []);
  assert.deepEqual(unowedConfigEchoes([added, echo('workspace:modified', '_config/gate.json')]), []);
  assert.deepEqual(unowedConfigEchoes([{ type: 'gate:policy-removed', policyName: 'p', configPath: '/s/sessions/x/config/gate.json' }, echo('workspace:modified', '_config/gate.json')]), [], 'a removal writes the file too');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:modified', '_config/gate.json'), added]), ['_config/gate.json (workspace:modified)'], 'an echo before the write that would owe it');
  assert.deepEqual(unowedConfigEchoes([added, echo('workspace:modified', '_config/gate.json', '_config/gate.js')]), ['_config/gate.js (workspace:modified)'], 'a file the write didn\'t name');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:deleted', '_config/gate.recipe.json')]), ['_config/gate.recipe.json (workspace:deleted)']);
  assert.deepEqual(unowedConfigEchoes([added, echo('workspace:deleted', '_config/gate.json')]), ['_config/gate.json (workspace:deleted)'], 'a write owes no deletion of its file');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:deleted', '_config/gate.json')], ['_config/gate.json']), ['_config/gate.json (workspace:deleted)'], 'nor does a first boot');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:created', '_config/gate.json', '_config/gate.recipe.json')], ['_config/gate.json', '_config/gate.recipe.json']), [], 'what the first boot owes');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:created', 'watched/note.txt')]), [], 'another mount\'s change is no echo of a config file');
  assert.deepEqual(unowedConfigEchoes([{ type: 'gate:policy-added', policyName: 'p' }, echo('workspace:modified', '_config/gate.json')]), ['_config/gate.json (workspace:modified)'], 'a policy held with no file owes nothing');
  assert.deepEqual(unowedConfigEchoes([added, echo('workspace:modified', '_config/gate.json'), echo('workspace:modified', '_config/gate.json')]), ['_config/gate.json (workspace:modified)'], 'a second echo of one write');
  assert.deepEqual(unowedConfigEchoes([echo('workspace:created', '_config/gate.json'), echo('workspace:modified', '_config/gate.json')], ['_config/gate.json']), ['_config/gate.json (workspace:modified)'], 'a second echo of one boot file');
  assert.deepEqual(unowedConfigEchoes([added, added, echo('workspace:modified', '_config/gate.json'), echo('workspace:modified', '_config/gate.json')]), [], 'two writes owe two');
  assert.deepEqual(unowedConfigEchoes([added, added, echo('workspace:modified', '_config/gate.json')]), [], 'and may be echoed once, as one settle of both');
});

test('D22: the windows a step\'s echoes are judged in run from where each host was last judged, the reads and fork reports between steps included, and the rest of the host it started on where it restarted one; a window read after the last step holds what came after it; and a host has moved the clock only by moves since it was last judged', () => {
  const echo = { type: 'process:received', processEvent: { type: 'workspace:modified', mount: '_config', paths: ['_config/gate.json'] } };
  const at = (n, extra = {}) => ({ events: Array.from({ length: n }, () => ({ at: 0, e: { type: 'ipc' } })), ...extra });
  const between = at(8, { judged: 3 });
  between.events[5] = { at: 0, e: echo };
  assert.deepEqual(echoWindows({ host: between, stepHost: between }), [{ host: between, from: 3 }]);
  assert.deepEqual(unowedConfigEchoes(between.events.slice(echoWindows({ host: between })[0].from).map(({ e }) => e)), ['_config/gate.json (workspace:modified)'], 'an echo between the last check and this step\'s start, as a read\'s');
  const old = at(6, { judged: 2 });
  const fresh = at(4, { judged: 4 });
  assert.deepEqual(echoWindows({ host: fresh, stepHost: old }), [{ host: old, from: 2 }, { host: fresh, from: 4 }], 'the old host\'s rest, then the new one\'s');
  assert.deepEqual(echoWindows({ host: null, stepHost: old }), [{ host: old, from: 2 }], 'a step that stopped its host');
  const last = at(12, { judged: 10 });
  last.events[11] = { at: 0, e: echo };
  assert.deepEqual(unowedConfigEchoes(last.events.slice(echoWindows({ host: last })[0].from).map(({ e }) => e)), ['_config/gate.json (workspace:modified)'], 'an echo after the last step\'s check, at the run\'s end');
  const never = at(3);
  assert.deepEqual(echoWindows({ host: never }), [{ host: never, from: 0 }], 'a host never judged, from its start');
  assert.equal(movedSinceJudged(at(20, { moves: 3, judgedMoves: 2 })), true, 'a move since the host was last judged, in whatever order its trace and the move reached the driver');
  assert.equal(movedSinceJudged(at(20, { moves: 2, judgedMoves: 2 })), false, 'moves before the window only');
  assert.equal(movedSinceJudged(at(3)), false, 'a host after a restart, which hasn\'t moved, though the one before it did');
  assert.equal(movedSinceJudged(at(3, { moves: 1 })), true, 'a host never judged that has moved');
});

test('D21: a first boot owes an echo for each file the start left in the _config mount\'s directory that its include names, however many, a gate write only for a file the include names, and an include the driver can\'t read as names is couldn\'t-tell at either', () => {
  const include = ['gate.json', 'gate.js', 'gate.recipe.json'];
  assert.deepEqual(bootEchoesOwed(['gate.recipe.json', 'gate.json', 'wake-onboarding.json'], include), ['_config/gate.json', '_config/gate.recipe.json']);
  assert.deepEqual(bootEchoesOwed(['gate.recipe.json'], include), ['_config/gate.recipe.json']);
  assert.deepEqual(bootEchoesOwed(['gate.js', 'gate.json', 'gate.recipe.json', 'suppression-review.json'], include), ['_config/gate.js', '_config/gate.json', '_config/gate.recipe.json']);
  assert.deepEqual(bootEchoesOwed([], include), []);
  assert.throws(() => bootEchoesOwed(['gate.json'], ['gate.*']), /couldn't tell which files the _config mount watches: its include names gate\.\*/);
  assert.throws(() => bootEchoesOwed(['gate.json'], ['rules/gate.json']), /its include names rules\/gate\.json/);
  assert.equal(echoOwed('/s/sessions/x/config/gate.json', include), true, 'a write to a file the include names');
  assert.equal(echoOwed('/s/sessions/x/config/rules.json', include), false, 'and to one it doesn\'t, which no echo follows');
  assert.throws(() => echoOwed('/s/sessions/x/config/gate.json', ['gate.*']), /couldn't tell which files the _config mount watches: its include names gate\.\*/, 'a pattern, at a write as at a first boot');
});

test('D17: each speech is waited for and logged once, however many waits read the events it is in, so one route failure logs one line; a wait that ends at a silent start logs it as kept; and an end that comes while the wait runs ends it', async () => {
  const events = [
    { at: 0, e: { type: 'inference:started', agentName: 'fixture' } },
    { at: 0, e: { type: 'inference:speech', agentName: 'fixture', content: 'words' } },
    { at: 0, e: { type: 'mcpl:speech-route-failed', conversationId: 'fixture', reason: 'turn has no locus' } },
    { at: 0, e: { type: 'inference:started', agentName: 'fixture', silent: true } },
    { at: 0, e: { type: 'inference:speech', agentName: 'fixture', content: 'quiet words' } },
  ];
  const lines = [];
  const until = async (check, ms, label) => check() || Promise.reject(new Error(`${label}: nothing after ${ms} ms`));
  const ends = speechWaits({ events: () => events, until, log: (kind, fields) => lines.push({ kind, ...fields }) });
  assert.equal(await ends(events[1], 'the decision\'s turns'), true);
  assert.equal(await ends(events[1], 'the step\'s trailing wait'), false, 'the second read waits for nothing');
  assert.equal(await ends(events[4], 'the tick'), true);
  assert.deepEqual(lines, [{ kind: 'undelivered', reason: 'turn has no locus' }, { kind: 'kept', why: 'its turn started silent' }]);
  const crossed = [events[0], { at: 0, e: { type: 'inference:started', agentName: 'helper' } }, events[1], { at: 0, e: { type: 'message:added', messageId: 'm1', source: 'delivery-receipt' } }];
  await assert.rejects(speechWaits({ events: () => crossed, until, log: () => {} })(crossed[2], 'turn t: its speech\'s end'), /^Error: turn t: its speech's end: a delivery receipt came while helper's turn was alive too, and a receipt's trace names no agent, so it can't be told whether the receipt is this speech's$/);
  const bounced = [events[0], { at: 0, e: { type: 'inference:started', agentName: 'helper' } }, events[1], { at: 0, e: { type: 'message:added', messageId: '', source: 'prose-bounce' } }];
  await assert.rejects(speechWaits({ events: () => bounced, until, log: () => {} })(bounced[2], 'turn t: its speech\'s end'), /^Error: turn t: its speech's end: a bounce notice came while helper's turn was alive too, and a bounce notice's trace names no agent, so it can't be told whether the notice is this speech's$/);
  const unended = speechWaits({ events: () => [events[0], events[1]], until, log: () => {} });
  await assert.rejects(unended(events[1], 'turn t: its speech\'s end'), /^Error: turn t: its speech's end \(published, refused a route, held as drafts, or told in its turn's delivery receipt or a bounce notice\): nothing after 120000 ms$/);
  const later = [events[0], events[1]];
  const polled = async (check, ms, label) => {
    for (let i = 0; i < 100; i++) { const found = check(); if (found) return found; await new Promise((r) => setImmediate(r)); }
    throw new Error(`${label}: nothing after ${ms} ms`);
  };
  const waiting = speechWaits({ events: () => later, until: polled, log: () => {} })(later[1], 'turn t: its speech\'s end');
  later.push({ at: 0, e: { type: 'inference:published_complete', agentName: 'fixture' } });
  assert.equal(await waiting, true, 'an end published after the wait began');
});

test('a reader step matches a persistent reader by its name and reader forks by their names\' prefix, waits for its reader\'s turn to start, and fails on its reader\'s turn ending in exhausted or aborted, or its resident\'s scripted wake turn doing so', async () => {
  const { readerTurn, readerStarts, readerEnds } = await import('./events.ts');
  const forked = { id: 'h1', reader: { prefix: 'reader/' }, replies: [{ text: 'noted' }] };
  const persistent = { id: 'h1', reader: { name: 'Subconscious' }, replies: [] };
  const ev = (agentName, type) => ({ agentName, type });
  assert.equal(readerStarts(forked)(ev('reader/fixture/1a2b3c4d/1', 'inference:started')), true);
  assert.equal(readerStarts(forked)(ev('fixture', 'inference:started')), false);
  assert.equal(readerStarts(persistent)(ev('Subconscious', 'inference:started')), true);
  assert.equal(readerEnds(forked, 'fixture')(ev('reader/fixture/1a2b3c4d/1', 'inference:aborted')), true);
  assert.equal(readerEnds(forked, 'fixture')(ev('fixture', 'inference:aborted')), true, 'the resident\'s scripted wake turn');
  assert.equal(readerEnds(forked, 'fixture')(ev('fixture', 'inference:exhausted')), true);
  assert.equal(readerEnds(forked, 'fixture')(ev('fixture', 'inference:completed')), false);
  assert.equal(readerEnds(persistent, 'fixture')(ev('fixture', 'inference:aborted')), false, 'a step that scripts the resident no turn');
  assert.equal(readerEnds(persistent, 'fixture')(ev('Subconscious', 'inference:exhausted')), true);
  const { readerFailureAllowed } = await import('./events.ts');
  const mayFail = { ...forked, mayFail: true, reader: { prefix: 'reader/fixture/' } };
  assert.equal(readerFailureAllowed(mayFail, ev('reader/fixture/1a2b3c4d/1', 'inference:aborted')), true, 'a reader turn a step may fail');
  assert.equal(readerFailureAllowed(mayFail, ev('fixture', 'inference:aborted')), false, 'its resident\'s wake turn isn\'t the reader\'s to fail');
  assert.equal(readerFailureAllowed(forked, ev('reader/fixture/1a2b3c4d/1', 'inference:aborted')), false);
  assert.equal(readerStarts(mayFail)(ev('reader/other/1a2b3c4d/1', 'inference:started')), false, 'another resident\'s fork');

  assert.equal(readerTurn({ name: 'Subconscious' }, 'Subconscious'), true);
  assert.equal(readerTurn({ name: 'Subconscious' }, 'reader/fixture/1a2b3c4d/1'), false);
  assert.equal(readerTurn({ prefix: 'reader/' }, 'reader/fixture/1a2b3c4d/1'), true);
  assert.equal(readerTurn({ prefix: 'reader/' }, 'fixture'), false);
  assert.equal(readerTurn({ prefix: 'reader/' }, undefined), false);
});

test('R12: a configuration whose model binds thinking boots its host with the start-up binding probe off; any other, without the setting', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  assert.equal(hostEnv({ ...base, configuration: { agent: { model: 'claude-opus-5-5' } } }).THINKING_BINDING_PROBE, 'off');
  assert.equal('THINKING_BINDING_PROBE' in hostEnv({ ...base, configuration: { agent: { model: 'claude-opus-4-6', strategy: { compressionModel: 'claude-opus-5-5' } } } }), false, 'the host probes the agent\'s model, not a compressor\'s');
  assert.equal(hostEnv({ ...base, configuration: {} }).ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  const env = hostEnv({ ...base, configuration: {} });
  assert.ok('AGENT_TIMEZONE' in env && env.AGENT_TIMEZONE === undefined, 'an inherited AGENT_TIMEZONE is overridden to nothing, so the host keeps TZ\'s UTC');
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'ANTHROPIC_OAUTH_AUTO_REFRESH']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the host keeps the fixture's API key`);
  for (const name of ['MODEL', 'COUNT_TOKENS_MODEL']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the recipe's model is the one sent`);
  for (const name of ['IDENTITY_HOME', 'IDENTITY_KEY_FILE', 'SLEEP_PRIVILEGED_FILE']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the host reads its default`);
  assert.equal(hostEnv({ ...base, configuration: {}, runDir: '/w/runs/X' }).FIXTURE_RUN_DIR, '/w/runs/X', 'the host\'s recorder masks the run\'s own directory');
});

test('every configuration boots its host with its update check off, so no run reads npm\'s registry', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  for (const [name, configuration] of Object.entries(configurations())) assert.equal(hostEnv({ ...base, configuration }).CONNECTOME_UPDATE_CHECK, '0', name);
});

test('a configuration on OpenAI\'s Responses API boots its host with the stand-in as its OpenAI base URL and a fixture key; any other, without either', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  const env = hostEnv({ ...base, configuration: { agent: { provider: 'openai-responses' } } });
  assert.deepEqual([env.OPENAI_BASE_URL, env.OPENAI_API_KEY], ['http://127.0.0.1:1/v1', 'sk-fixture']);
  const other = hostEnv({ ...base, configuration: {} });
  assert.equal('OPENAI_BASE_URL' in other || 'OPENAI_API_KEY' in other, false);
});

test('a configuration on the Codex backend boots its host with the stand-in\'s /codex as its Codex base URL and a fixture gate token, so the host runs no Codex CLI; any other, without either', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  const env = hostEnv({ ...base, configuration: { agent: { provider: 'openai-codex' } } });
  assert.deepEqual([env.CODEX_BASE_URL, env.CODEX_GATE_TOKEN], ['http://127.0.0.1:1/codex', 'gate-fixture']);
  for (const configuration of [{}, { agent: { provider: 'openai-responses' } }]) {
    const other = hostEnv({ ...base, configuration });
    assert.equal('CODEX_BASE_URL' in other || 'CODEX_GATE_TOKEN' in other, false);
  }
});

test('a configuration on OpenRouter boots its host with the stand-in\'s /api/v1 as its OpenRouter base URL, a fixture key, and the stand-in as its HTTPS proxy with no exceptions or other proxy, so a host that reads no base URL, and whose HTTPS client honours the proxy, sends nothing out; any other, without them', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  const env = hostEnv({ ...base, configuration: { agent: { provider: 'openrouter' } } });
  assert.deepEqual([env.OPENROUTER_BASE_URL, env.OPENROUTER_API_KEY, env.HTTPS_PROXY, env.https_proxy], ['http://127.0.0.1:1/api/v1', 'sk-or-fixture', 'http://127.0.0.1:1', 'http://127.0.0.1:1']);
  for (const name of ['NO_PROXY', 'no_proxy']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so no host is left outside the proxy`);
  for (const name of ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the stand-in's own requests go to it directly`);
  const set = ['OPENROUTER_BASE_URL', 'OPENROUTER_API_KEY', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const [name, configuration] of Object.entries(configurations()).filter(([, c]) => c.agent?.provider !== 'openrouter')) {
    assert.deepEqual(set.filter((key) => key in hostEnv({ ...base, configuration })), [], name);
  }
});

test('a step that waits after its turn fails is answered by the first event its awaits names, of the failed turn\'s agent and after the failure, never by one before it, of another agent, or of another type or kind', () => {
  const awaits = { events: [{ type: 'inference:started' }, { type: 'ops:alert', kind: 'history-kept' }], what: 'the outcome' };
  const ev = (type, more = {}) => ({ e: { type, agentName: 'fixture', ...more } });
  const started = ev('inference:started');
  const ended = ev('inference:exhausted');
  const kept = ev('ops:alert', { kind: 'history-kept' });
  assert.equal(awaitedAfter([started, ended], ended, awaits), undefined, 'the failed turn\'s own start, before its end, isn\'t its outcome');
  assert.equal(awaitedAfter([ended, ev('ops:alert', { kind: 'hard-down' }), ev('inference:failed'), ev('inference:started', { agentName: 'other' })], ended, awaits), undefined, 'an alert of another kind, another type, or another agent\'s start');
  const retry = ev('inference:started');
  assert.equal(awaitedAfter([started, ended, ev('ops:alert', { kind: 'hard-down' }), retry, kept], ended, awaits), retry, 'a retry\'s start');
  assert.equal(awaitedAfter([ended, kept, retry], ended, awaits), kept, 'or the alert, whichever comes first');
});

test('R17: what the host\'s installed agent-framework brings is read by the file each capability lives in, in its source or its build, or for the kept history by both literals it judges in the framework module; a file or literal that isn\'t there is absent, and an install that can\'t be read is couldn\'t-tell, never absent', () => {
  const host = mkdtempSync(join(tmpdir(), 'r17-'));
  const af = join(host, 'node_modules', '@animalabs', 'agent-framework');
  const put = (rel, text = '') => { mkdirSync(join(af, rel, '..'), { recursive: true }); writeFileSync(join(af, rel), text); };
  try {
    assert.throws(() => hostCapabilities(host), /couldn't tell what the installed agent-framework brings: .*package\.json/);
    put('package.json', '{"name":"@animalabs/agent-framework","version":"0.32.0"}');
    assert.throws(() => hostCapabilities(host), /couldn't tell what the installed agent-framework brings: .* holds neither src nor dist\/src/);
    put('src/index.ts');
    put('src/mcpl/conversation-router.ts');
    const unfound = hostCapabilities(host);
    assert.match(unfound['kept-history'].unreadable, /couldn't tell what the installed agent-framework brings: its framework module is in neither its src nor its dist\/src/);
    assert.deepEqual([unfound.suppression, unfound.onboarding, unfound.conversations], [false, false, true], 'a framework module that can\'t be found leaves the other capabilities readable');
    rmSync(join(af, 'src/mcpl'), { recursive: true });
    mkdirSync(join(af, 'src/framework.ts'));
    assert.match(hostCapabilities(host)['kept-history'].unreadable, /couldn't tell what the installed agent-framework brings: .*framework\.ts can't be read/, 'one that can\'t be read is couldn\'t-tell, never absent');
    rmSync(join(af, 'src/framework.ts'), { recursive: true });
    put('src/framework.ts', "this.opsAlert('hard-down', name, message);\n");
    assert.deepEqual(hostCapabilities(host), { suppression: false, onboarding: false, conversations: false, 'kept-history': false });
    put('src/gate/suppression-review.ts');
    assert.deepEqual(hostCapabilities(host), { suppression: true, onboarding: false, conversations: false, 'kept-history': false });
    put('dist/src/gate/wake-onboarding.js');
    assert.deepEqual(hostCapabilities(host), { suppression: true, onboarding: true, conversations: false, 'kept-history': false });
    put('src/mcpl/conversation-router.ts');
    assert.deepEqual(hostCapabilities(host), { suppression: true, onboarding: true, conversations: true, 'kept-history': false });
    put('src/framework.ts', "this.opsAlert('history-kept', name, message);\n");
    assert.equal(hostCapabilities(host)['kept-history'], false, 'the alert\'s kind without its key isn\'t enough');
    put('src/framework.ts', "const verdict = same ? 'fails-without-history' : 'could-not-tell';\n");
    assert.equal(hostCapabilities(host)['kept-history'], false, 'nor is its key without its kind');
    put('src/framework.ts', "const verdict = same ? 'fails-without-history' : 'could-not-tell';\nthis.opsAlert('history-kept', name, message, { key: verdict });\n");
    assert.equal(hostCapabilities(host)['kept-history'], true);
    rmSync(join(af, 'src'), { recursive: true });
    put('dist/src/framework.js', "const verdict = same ? 'fails-without-history' : 'could-not-tell';\nthis.opsAlert('history-kept', name, message, { key: verdict });\n");
    assert.equal(hostCapabilities(host)['kept-history'], true, 'a build with no source is read the same');
    put('package.json', '{"name":"@animalabs/other"}');
    assert.throws(() => hostCapabilities(host), /couldn't tell what the installed agent-framework brings: .*package\.json names @animalabs\/other/);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('R18: the recipe starts the fixture server with the channels it registers, its tag ontology where the configuration gives one and its send tool where the configuration asks for it, and each further server as its own peer with its own channels', () => {
  const plain = laneRecipe({ configuration: { name: 'H1' }, control: '/c.sock', channels: ['chat'], boot: 1 });
  assert.deepEqual(Object.keys(plain.mcpServers), ['fixture']);
  assert.equal(plain.mcpServers.fixture.env.FIXTURE_CHANNELS, 'chat');
  assert.ok(!('FIXTURE_ONTOLOGY' in plain.mcpServers.fixture.env) && !('FIXTURE_PEER' in plain.mcpServers.fixture.env));
  const ontology = { tags: { 'w12:ping': { suggestedTreatment: 'immediate' } } };
  const more = laneRecipe({ configuration: { name: 'H5', fixtureOntology: ontology }, control: '/c.sock', channels: ['chat'], boot: 2, servers: { quiet: ['w12-other'] } });
  assert.deepEqual(JSON.parse(more.mcpServers.fixture.env.FIXTURE_ONTOLOGY), ontology);
  assert.deepEqual(more.mcpServers.quiet.env, { FIXTURE_CONTROL: '/c.sock', FIXTURE_CHANNELS: 'w12-other', FIXTURE_BOOT: '2', FIXTURE_PEER: 'server:quiet' });
  assert.deepEqual(more.mcpServers.quiet.enabledFeatureSets, ['fixture']);
  assert.ok(!more.mcpServers.quiet.allowHostCommands, 'only the fixture server takes host commands');

  assert.ok(!('FIXTURE_SEND' in plain.mcpServers.fixture.env), 'no send tool unless the configuration asks for one');
  assert.equal(laneRecipe({ configuration: { name: 'H4', fixtureSend: true }, control: '/c.sock', channels: ['chat'], boot: 1 }).mcpServers.fixture.env.FIXTURE_SEND, '1');
});

test('R18e: the fixture server registers its configuration\'s channel kinds, each channel step\'s channel and the channels its held calls\' and held replies\' acts deliver on, and a deliver step\'s own, while each further server registers the channels its deliver steps name', () => {
  const steps = [
    { kind: 'channel', channel: 'chat', replies: [{ calls: [{ input: { canary: 'c1', hold: true }, during: [{ deliver: { channel: 'held-call' } }] }] }] },
    { kind: 'channel', channel: 'chat', replies: [{ hold: true, during: [{ deliver: { channel: 'held-reply' } }] }] },
    { kind: 'deliver', messages: [{ channel: 'delivered' }, { server: 'quiet', channel: 'w12-other' }] },
  ];
  assert.deepEqual(fixtureChannels(steps, { fixtureChannels: { kinds: { closed: true } } }), {
    channels: ['kinds', 'chat', 'held-call', 'held-reply', 'delivered'],
    servers: { quiet: ['w12-other'] },
  });
});

test('R18f: a channel only a summariser hold\'s acts deliver on is registered with the fixture server too', () => {
  const steps = [{ kind: 'channel', channel: 'chat', summariserHold: { level: 1, during: [{ budgetHeld: true }, { deliver: { channel: 'w8-side' } }, { advance: 61_000 }] } }];
  assert.deepEqual(fixtureChannels(steps, {}), { channels: ['chat', 'w8-side'], servers: {} });
});

test('R18g: a channel step\'s subagent\'s held call registers the channel its acts deliver on, as the step\'s own held calls do', () => {
  const steps = [{ kind: 'channel', channel: 'chat', subs: [{ replies: [{ calls: [{ input: { canary: 's1' }, during: [{ deliver: { channel: 'sub-held' } }] }] }] }] }];
  assert.deepEqual(fixtureChannels(steps, {}), { channels: ['chat', 'sub-held'], servers: {} });
});

test('D26: a hold\'s acts after `budgetHeld` run only where, since the step began, the host has held the run\'s agent\'s turn for budget; no hold, another agent\'s, one before the step and a refusal it didn\'t hold skip them', () => {
  const held = (agentName) => ({ e: { type: 'inference:held', agentName, errorType: 'over_budget' } });
  const failed = { e: { type: 'inference:failed', agentName: 'fixture' } };
  assert.equal(budgetHeld([failed, held('fixture')], 0, 'fixture'), true, 'the hold came first');
  assert.equal(budgetHeld([], 0, 'fixture'), false, 'no event, as on a host before budget holds');
  assert.equal(budgetHeld([failed], 0, 'fixture'), false, 'refused, and not held');
  assert.equal(budgetHeld([held('reader')], 0, 'fixture'), false, 'another agent\'s hold');
  assert.equal(budgetHeld([held('fixture'), failed], 1, 'fixture'), false, 'a hold before the step began');
});

test('D27: budgetHeldAt gives when the driver received the run\'s agent\'s budget hold since the step began, and a hold that came after the acts were skipped fails the run naming how much later it came', () => {
  const held = (agentName, at) => ({ at, e: { type: 'inference:held', agentName } });
  const failed = { at: 5, e: { type: 'inference:failed', agentName: 'fixture' } };
  assert.equal(budgetHeldAt([failed, held('fixture', 7.5)], 0, 'fixture'), 7.5);
  assert.equal(budgetHeldAt([held('reader', 7.5)], 0, 'fixture'), undefined, 'another agent\'s hold');
  assert.equal(budgetHeldAt([held('fixture', 7.5), failed], 1, 'fixture'), undefined, 'a hold before the step began');
  assert.equal(
    lateBudgetHold('5.10', 'fixture', 41.6),
    'step 5.10: the host held fixture\'s turn for budget only after the summariser request held for it, so the hold\'s acts were skipped; the driver received the hold 42 ms after it checked for it',
  );
});

test('R20: a configuration\'s tool presentation file, named relative to the run, goes into the recipe under the run\'s working directory, which connectome-host requires to be absolute; an absolute one and the catalogue path are left as given, and a recipe built with no working directory, as for the host\'s facts, leaves the path as the configuration names it', () => {
  const presentation = { path: 'tool-presentation.json', cataloguePath: 'products/tool-catalogue.md' };
  const built = (agent, work) => laneRecipe({ configuration: { name: 'H7', agent }, control: '/c.sock', channels: ['chat'], boot: 1, ...(work ? { work } : {}) }).agent.toolPresentation;
  assert.deepEqual(built({ toolPresentation: presentation }, '/runs/H7/work'), { path: '/runs/H7/work/tool-presentation.json', cataloguePath: 'products/tool-catalogue.md' });
  assert.deepEqual(built({ toolPresentation: { ...presentation, path: '/etc/p.json' } }, '/runs/H7/work'), { path: '/etc/p.json', cataloguePath: 'products/tool-catalogue.md' });
  assert.deepEqual(built({ toolPresentation: presentation }), presentation);
  assert.equal(built({}, '/runs/H7/work'), undefined);
});

test('R18b: the fixture server is given the channel kinds a configuration declares, and a server given none gets none', () => {
  const kinds = { chat: {}, side: { initiallyOpen: false }, feed: { direction: 'inbound', initiallyOpen: false } };
  const declared = laneRecipe({ configuration: { name: 'H1', fixtureChannels: kinds }, control: '/c.sock', channels: ['chat', 'side', 'feed'], boot: 1, servers: { quiet: ['w12-other'] } });
  assert.deepEqual(JSON.parse(declared.mcpServers.fixture.env.FIXTURE_CHANNEL_KINDS), kinds);
  assert.ok(!('FIXTURE_CHANNEL_KINDS' in declared.mcpServers.quiet.env), 'a further server is given no kinds');
  const plain = laneRecipe({ configuration: { name: 'H1' }, control: '/c.sock', channels: ['chat'], boot: 1 });
  assert.ok(!('FIXTURE_CHANNEL_KINDS' in plain.mcpServers.fixture.env));
});

test('R18d: a configuration with fixtureLifecycle false registers its fixture channels with no kinds, so the server directs no lifecycle, and refuses a kind it would lose', () => {
  const bare = laneRecipe({ configuration: { name: 'H5c', fixtureChannels: { 'w12-status': {} }, fixtureLifecycle: false }, control: '/c.sock', channels: ['chat', 'w12-status'], boot: 1 });
  assert.ok(!('FIXTURE_CHANNEL_KINDS' in bare.mcpServers.fixture.env));
  assert.equal(bare.mcpServers.fixture.env.FIXTURE_CHANNELS, 'chat,w12-status', 'the channel is still registered');
  const granted = laneRecipe({ configuration: { name: 'H5', fixtureChannels: { 'w12-status': {} } }, control: '/c.sock', channels: ['chat', 'w12-status'], boot: 1 });
  assert.deepEqual(JSON.parse(granted.mcpServers.fixture.env.FIXTURE_CHANNEL_KINDS), { 'w12-status': {} });
  assert.throws(() => laneRecipe({ configuration: { name: 'Hx', fixtureChannels: { side: { initiallyOpen: false }, feed: { direction: 'inbound' } }, fixtureLifecycle: false }, control: '/c.sock', channels: ['side', 'feed'], boot: 1 }), /Hx's fixtureLifecycle false gives the fixture server no channel kinds, so it can't keep side, feed's initiallyOpen and direction/);
});

test('R18c: the fixture server is told FIXTURE_PUSH where a configuration gives the push, and a server whose configuration doesn\'t isn\'t', () => {
  const pushing = laneRecipe({ configuration: { name: 'Hlatest', fixturePush: true }, control: '/c.sock', channels: ['chat'], boot: 1, servers: { quiet: ['w12-quiet'] } });
  assert.equal(pushing.mcpServers.fixture.env.FIXTURE_PUSH, '1');
  assert.ok(!('FIXTURE_PUSH' in pushing.mcpServers.quiet.env), 'a further server is told nothing');
  assert.ok(!('FIXTURE_PUSH' in laneRecipe({ configuration: { name: 'H1' }, control: '/c.sock', channels: ['chat'], boot: 1 }).mcpServers.fixture.env));
});

test('R16: a watched write\'s bound names the chokidar version found in the host\'s install, agent-framework\'s own copy before the top-level one, or says there is none or its version can\'t be read', () => {
  const host = mkdtempSync(join(tmpdir(), 'r15-'));
  const put = (dir, text) => { mkdirSync(join(host, 'node_modules', ...dir), { recursive: true }); writeFileSync(join(host, 'node_modules', ...dir, 'package.json'), text); };
  try {
    assert.equal(chokidarVersion(host), `no chokidar in ${join(host, 'node_modules')}`);
    put(['chokidar'], '{"name":"chokidar","version":"4.0.3"}');
    assert.equal(chokidarVersion(host), 'chokidar 4.0.3');
    put(['@animalabs', 'agent-framework', 'node_modules', 'chokidar'], '{"name":"chokidar","version":"5.0.0"}');
    assert.equal(chokidarVersion(host), 'chokidar 5.0.0');
    put(['@animalabs', 'agent-framework', 'node_modules', 'chokidar'], '{"version":');
    assert.match(chokidarVersion(host), /^chokidar of a version .*agent-framework\/node_modules\/chokidar\/package\.json doesn't give: /);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('R13: a host\'s shutdown fails the run when it doesn\'t exit in time or exits other than cleanly', () => {
  assert.equal(shutdownFailure({ boot: 2, timedOut: false, exited: { code: 0, signal: null }, seconds: 30 }), null);
  assert.match(shutdownFailure({ boot: 2, timedOut: false, exited: { code: 1, signal: null }, seconds: 30 }), /boot 2: the host exited \(1\) on its shutdown/);
  assert.match(shutdownFailure({ boot: 2, timedOut: false, exited: { code: null, signal: 'SIGSEGV' }, seconds: 30 }), /exited \(SIGSEGV\)/);
  assert.match(shutdownFailure({ boot: 3, timedOut: true, exited: { code: null, signal: 'SIGKILL' }, seconds: 30 }), /boot 3: the host didn't exit within 30 s/);
});

test('R14: the self-check\'s second arm boots the test module with recording off, and every other run with it on', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  assert.equal(hostEnv({ ...base, configuration: { recording: false } }).FIXTURE_RECORD, 'off');
  const on = hostEnv({ ...base, configuration: {} });
  assert.ok('FIXTURE_RECORD' in on && on.FIXTURE_RECORD === undefined, 'the recording arm sets it to nothing');
  assert.equal({ ...{ FIXTURE_RECORD: 'off' }, ...on }.FIXTURE_RECORD, undefined, 'so a runner\'s own FIXTURE_RECORD=off, which spawnHost spreads first, can\'t turn recording off');
});

test('a last take the module refuses at a host\'s shutdown fails the run, since the compiles since the last settle are lost, and logs the loss', async () => {
  const logged = [];
  const failed = [];
  const at = { boot: 2, step: '5.3', log: (kind, fields) => logged.push({ kind, ...fields }), fail: (f) => failed.push(f) };
  await lastTake({ ...at, take: async () => { throw new Error('the module stopped before flushing'); } });
  assert.deepEqual(logged, [{ kind: 'compiles', boot: 2, lost: 'the module stopped before flushing' }]);
  assert.deepEqual(failed, [{ step: '5.3', reason: 'boot 2\'s last take of the module\'s compiles failed: the module stopped before flushing' }], 'the run\'s own failure, as the shutdown passes the run\'s fail straight through');
  await lastTake({ ...at, take: async () => {} });
  assert.equal(failed.length, 1, 'a take that answers fails nothing');
});

test('a lost last take whose error is too long to show whole fails the run with its first 500 characters, and its whole message beside them', async () => {
  const failed = [];
  const message = `${'y'.repeat(600)}END`;
  await lastTake({ boot: 3, step: '5.3', log: () => {}, fail: (f) => failed.push(f), take: async () => { throw new Error(message); } });
  assert.deepEqual(failed, [{
    step: '5.3',
    reason: `boot 3's last take of the module's compiles failed: ${message.slice(0, 500)}`,
    full: `boot 3's last take of the module's compiles failed: ${message}`,
  }]);
});

test('R19: the suppression review\'s interval is what the installed agent-framework\'s own reviewSettings gives for the review options the host\'s gateOptionsFor builds, read from whichever of the files that count suppression present the install has; none when the host turns the review or the gate off, or the install has no review; and where either private name can\'t be called, the refusal names it', { timeout: 60_000 }, () => {
  const host = mkdtempSync(join(tmpdir(), 'r19-'));
  const put = (rel, text) => { mkdirSync(join(host, rel, '..'), { recursive: true }); writeFileSync(join(host, rel), text); };
  const gateOptions = 'export const gateOptionsFor = (wake) => (wake === false ? undefined : { configPath: "x", ...(wake?.hostReview !== undefined ? { suppressionReview: wake.hostReview } : {}) });\n';
  put('src/gate-options.ts', gateOptions);
  const review = 'node_modules/@animalabs/agent-framework/src/gate/suppression-review.ts';
  put(review, 'export const reviewSettings = (o = {}) => ({ intervalMs: o.intervalMs ?? 4_100_000 });\n');
  const interval = (wake) => reviewInterval({ hostDir: host, configuration: { ...configurations().H1, modules: { ...configurations().H1.modules, wake } } });
  try {
    assert.equal(interval(undefined), 4_100_000, 'the host sets no review options: agent-framework\'s own default');
    assert.equal(interval({ hostReview: { intervalMs: 5_400_000 } }), 5_400_000, 'the host\'s options, through agent-framework\'s settings');
    assert.equal(interval({ hostReview: false }), null);
    assert.equal(interval({ hostReview: { enabled: false } }), null);
    assert.equal(interval(false), null, 'no gate, no review');
    put(review, 'export const settingsOfReview = (o = {}) => ({ intervalMs: 1 });\n');
    assert.throws(() => interval(undefined), /agent-framework's unexported reviewSettings, which the harness reads the interval through, can't be called: gate\/suppression-review exports no function of that name$/);
    put(review, 'export const reviewSettings = () => ({ everyMs: 1 });\n');
    assert.throws(() => interval(undefined), /agent-framework's unexported reviewSettings, which the harness reads the interval through, can't be called: its settings give no intervalMs \(\{"everyMs":1\}\)$/);
    rmSync(join(host, review));
    assert.equal(interval(undefined), null, 'an install with no review');
    put('node_modules/@animalabs/agent-framework/package.json', '{"name":"@animalabs/agent-framework"}');
    put('node_modules/@animalabs/agent-framework/src/framework.ts', '');
    for (const [i, rel] of ['src/gate/suppression-review.js', 'dist/src/gate/suppression-review.ts', 'dist/src/gate/suppression-review.js'].entries()) {
      const at = `node_modules/@animalabs/agent-framework/${rel}`;
      put(at, `export const reviewSettings = (o = {}) => ({ intervalMs: o.intervalMs ?? ${4_200_000 + i} });\n`);
      assert.equal(hostCapabilities(host).suppression, true, `premise: ${rel} counts as suppression present`);
      assert.equal(interval(undefined), 4_200_000 + i, `the review's interval is read from ${rel}, where the capability is counted`);
      rmSync(join(host, at));
    }
    put('src/gate-options.ts', 'export const optionsForGate = () => ({});\n');
    assert.throws(() => interval(undefined), /connectome-host's private gateOptionsFor, which the harness reads the review's options through, can't be called: src\/gate-options.ts exports no function of that name$/);
    rmSync(join(host, 'src/gate-options.ts'));
    assert.throws(() => interval(undefined), /connectome-host's private gateOptionsFor, which the harness reads the review's options through, can't be called: .*gate-options/);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('R19a: the installed host\'s recipe facts reach neither the host\'s gateOptionsFor nor agent-framework\'s review, so a host without them still gives every other run its facts', { timeout: 30_000 }, () => {
  const host = mkdtempSync(join(tmpdir(), 'r19a-'));
  const put = (rel, text) => { mkdirSync(join(host, rel, '..'), { recursive: true }); writeFileSync(join(host, rel), text); };
  put('src/model-limits.ts', 'export const getDefaultModelLimits = () => ({ maxContextTokens: 1000 });\n');
  put('src/framework-agent-config.ts', 'export const buildFrameworkAgentConfig = () => ({ maxTokens: 7 });\n');
  put('node_modules/@animalabs/agent-framework/package.json', '{"name":"@animalabs/agent-framework"}');
  put('node_modules/@animalabs/agent-framework/src/gate/suppression-review.ts', 'export const settingsOfReview = () => ({});\n');
  try {
    const facts = hostFacts({ hostDir: host, configuration: configurations().H1 });
    assert.equal(facts.window, 1000);
    assert.equal(facts.maxTokens, 7);
    assert.equal('reviewMs' in facts, false);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('the rewrite-priced continuation\'s kv-unified block is what the installed host\'s own standardKvUnifiedConfig gives for the run\'s recipe and model, read with its recipe facts; where that private name can\'t be called the refusal names it, and a run that lays nothing over the block never reads it', { timeout: 60_000 }, () => {
  const host = mkdtempSync(join(tmpdir(), 'kvu-read-'));
  const put = (rel, text) => { mkdirSync(join(host, rel, '..'), { recursive: true }); writeFileSync(join(host, rel), text); };
  put('src/model-limits.ts', 'export const getDefaultModelLimits = () => ({ maxContextTokens: 1000 });\n');
  put('src/framework-agent-config.ts', 'export const buildFrameworkAgentConfig = () => ({ maxTokens: 7 });\n');
  put('src/framework-strategy.ts', 'export const standardKvUnifiedConfig = (recipe, model) => ({ policy: { cacheWritePrice: recipe.agent.provider === "anthropic" ? 2 : 1 }, model });\n');
  const priced = runOf('H1/continuation/rewrite-priced', configurations(), {}).configuration;
  const plain = runOf('H1/continuation', configurations(), {}).configuration;
  try {
    const facts = hostFacts({ hostDir: host, configuration: priced });
    assert.deepEqual(facts.kvUnified, { policy: { cacheWritePrice: 2 }, model: 'claude-opus-4-6' }, 'the block the host gives for the anthropic provider and the run\'s model');
    assert.equal(facts.maxTokens, 7, 'read beside the recipe facts');
    assert.equal('kvUnified' in hostFacts({ hostDir: host, configuration: plain }), false);
    put('src/framework-strategy.ts', 'export const kvUnifiedDefaults = () => ({});\n');
    assert.throws(() => hostFacts({ hostDir: host, configuration: priced }), /couldn't read the host's standard kv-unified block, which this run of H1 lays policy keys over: connectome-host's private standardKvUnifiedConfig, which the harness reads the block through, can't be called: src\/framework-strategy.ts exports no function of that name$/);
    assert.equal(hostFacts({ hostDir: host, configuration: plain }).maxTokens, 7, 'every other run still gets its facts');
    rmSync(join(host, 'src/framework-strategy.ts'));
    assert.throws(() => hostFacts({ hostDir: host, configuration: priced }), /couldn't read the host's standard kv-unified block, which this run of H1 lays policy keys over: connectome-host's private standardKvUnifiedConfig, which the harness reads the block through, can't be called: .*framework-strategy/);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('the rewrite-priced continuation sends the host\'s standard kv-unified block with rewriteLambda 500 laid over its policy, and differs from H1\'s continuation in that block alone; without the block read it refuses rather than send part of one', () => {
  const standard = { policy: { alpha: 0.7, cacheWritePrice: 2 }, tokenBucketSize: 50_000, hysteresisCertificate: true };
  const facts = { window: 1_000_000, kvUnified: standard };
  const recipeOf = (id) => laneRecipe({ configuration: asRun(runOf(id, configurations(), facts).configuration, facts), control: '', channels: [], boot: 0 });
  const priced = recipeOf('H1/continuation/rewrite-priced');
  const plain = recipeOf('H1/continuation');
  assert.deepEqual(priced.agent.strategy, { kvUnified: { policy: { alpha: 0.7, cacheWritePrice: 2, rewriteLambda: 500 }, tokenBucketSize: 50_000, hysteresisCertificate: true } });
  assert.deepEqual(standard, { policy: { alpha: 0.7, cacheWritePrice: 2 }, tokenBucketSize: 50_000, hysteresisCertificate: true }, 'the facts\' block is left as read');
  const { strategy, ...agent } = priced.agent;
  assert.deepEqual({ ...priced, agent }, plain, 'nothing else of the recipe differs');
  assert.equal(plain.agent.strategy, undefined, 'H1\'s continuation leaves the block to the host');
  assert.throws(() => asRun(runOf('H1/continuation/rewrite-priced', configurations(), {}).configuration, { window: 1_000_000 }), /this run of H1 lays policy keys over the host's standard kv-unified block, but its facts hold no block read from the host$/);
});

test('when bun can\'t read the installed host\'s recipe facts, the error shows the end of its output and keeps the whole beside it', () => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-bun-'));
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf START >&2; head -c 5000 /dev/zero | tr "\\0" x >&2; printf END >&2; exit 1\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  let error = null;
  try { hostFacts({ hostDir: bin, configuration: configurations().H1 }); } catch (e) { error = e; } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
  assert.ok(error, 'reading the facts fails');
  assert.ok(error.message.endsWith('END') && !error.message.includes('START'), 'the shown output is its end');
  assert.match(error.full, /\(bun exited 1\): STARTx{5000}END$/);
});

test('/undo, /redo and /branchto end on each host\'s own answer: a branch switch before connectome-host #485, the agent\'s window from it, and the failures of both', () => {
  // connectome-host's commands.ts at cebc11b (1118, 1148, 1339) and at 08efb40e (1188, 1207, 1523), and their failure
  // lines.
  assert.equal(commandEnds('undo', ['Undone. Switched to branch "undo-at-9-1700000000000".']), 'done');
  assert.equal(commandEnds('undo', ["Undone: fixture's last turn left its window (4 rows from its start: the turn's own, and any other, which its next turn shows again).", '  The record keeps it, and no branch moved: …']), 'done');
  for (const l of ['Nothing to undo.', 'Undo failed (branchAt): x', 'Undo failed: x', 'No agent context manager.', 'No agent.', '/undo refused: a turn is in flight (fixture: streaming).']) assert.equal(commandEnds('undo', [l]), 'failed', l);
  assert.equal(commandEnds('redo', ['Redone. Switched to branch "main".']), 'done');
  assert.equal(commandEnds('redo', ["Redone: fixture's undone turn is back in its window (4 rows)."]), 'done');
  for (const l of ['Nothing to redo.', 'Redo failed', 'Redo failed: x', 'No agent.', 'No agent context manager.', '/redo refused: a turn is in flight (fixture: streaming).']) assert.equal(commandEnds('redo', [l]), 'failed', l);
  assert.equal(commandEnds('branchto', ['Branching at [41] -> "rollback-at-41-1700000000000"...']), null, 'the move is still to come');
  assert.equal(commandEnds('branchto', ['Branching at [41] -> "rollback-at-41-1700000000000"...', 'Branched at [41] -> "rollback-at-41-1700000000000" and switched. Everything after [41] is dropped on this branch; old branch preserved.']), 'done');
  assert.equal(commandEnds('branchto', ['Branched at [41] -> "rollback-at-41-1" and switched. 3 messages after [41] are dropped on this branch; old branch preserved.', '  1 row after [41] stays in the record: …']), 'done');
  for (const l of ['branchto failed (switchBranch)', 'branchto failed: x', 'No message with id 41 on current branch.', 'No agent context manager.', 'Usage: /branchto <messageId>', '/branchto refused: a turn is in flight (fixture: streaming).']) assert.equal(commandEnds('branchto', [l]), 'failed', l);
  assert.equal(commandEnds('undo', ['Undoing…']), null);
});

test('/checkpoint and /restore end on connectome-host\'s answer: a saved checkpoint, a rollback to one or to its branch head, and each failure, a restore to where the record already is among them', () => {
  // connectome-host's commands.ts at 1526663c, handleCheckpoint and handleRestore.
  assert.equal(commandEnds('checkpoint', ['Checkpoint "w15" saved at branch main (head: 41).']), 'done');
  assert.equal(commandEnds('checkpoint', ['Checkpoint "w15" saved at branch main (head: 41).', '  Its last row [41] is out of fixture\'s window as undone: a /restore to "w15" puts it back once rows are stored after it.']), 'done');
  for (const l of ['Usage: /checkpoint <name>', 'No agent context manager.']) assert.equal(commandEnds('checkpoint', [l]), 'failed', l);
  assert.equal(commandEnds('restore', []), null, 'the rollback is still to come');
  assert.equal(commandEnds('restore', ['Restored to checkpoint "w15" (branch: restore-w15-1700000000000).']), 'done');
  assert.equal(commandEnds('restore', ['Restored to checkpoint "w15" (branch: main).', '  (note: exact checkpoint position unreachable from the current branch — restored to the branch head instead)']), 'done');
  for (const l of ['Checkpoint "w15" not found.', 'No checkpoints saved. Use /checkpoint <name> to create one.', 'Available checkpoints:', 'Already at checkpoint "w15".', 'No agent context manager.', 'Restore failed: x', '/restore refused: a turn is in flight (fixture: streaming).']) assert.equal(commandEnds('restore', [l]), 'failed', l);
});

test('agentEnd waits for a result its subagent stored since the step began: one of the same name from an earlier step doesn\'t answer it, and another name\'s or another kind of mail never does', () => {
  const mail = (from, kind = 'result') => ({ e: { type: 'dendrite:mail-delivered', kind, from, to: 'fixture' } });
  const earlier = [mail('spawn-w14-7-100'), { e: { type: 'message:added' } }];
  assert.equal(subagentResult(earlier, 'w14-7', earlier.length), undefined, 'an earlier step\'s result of the same name');
  const now = [...earlier, mail('spawn-w14-8-200'), mail('spawn-w14-7-300', 'message'), mail('spawn-w14-7-400')];
  assert.equal(subagentResult(now, 'w14-7', earlier.length)?.e.from, 'spawn-w14-7-400');
  assert.equal(subagentResult(now, 'w14', earlier.length), undefined, 'a name that only prefixes another\'s');
});

test('an inference:speech of "", which connectome-host#555 on sends for a round with no text, isn\'t speech; whitespace still is', async () => {
  const { spoke } = await import('./events.ts');
  assert.equal(spoke({ type: 'inference:speech', agentName: 'fixture', content: '' }), false);
  assert.equal(spoke({ type: 'inference:speech', agentName: 'fixture', content: ' ' }), true);
  assert.equal(spoke({ type: 'inference:speech', agentName: 'fixture', content: 'words' }), true);
  assert.equal(spoke({ type: 'inference:completed', agentName: 'fixture', content: 'words' }), false);
});

test('a gate\'s turns wait for the ends of the frames that spoke since the step began, never a "" frame\'s, which never comes', async () => {
  const { gateSpeeches } = await import('./events.ts');
  const events = [
    { e: { type: 'inference:speech', agentName: 'fixture', content: 'before the step' } },
    { e: { type: 'inference:started', agentName: 'fixture' } },
    { e: { type: 'inference:speech', agentName: 'fixture', content: '' } },
    { e: { type: 'inference:speech', agentName: 'fixture', content: 'words' } },
    { e: { type: 'inference:speech', agentName: 'fixture', content: ' ' } },
  ];
  assert.deepEqual(gateSpeeches(events, 1), [events[3], events[4]]);
});

test('a speaking step\'s wait passes over a "" frame, since a rewind\'s retry can still speak in the step; a contained step\'s takes any frame; an ending ends either', async () => {
  const { endsSpeechWait } = await import('./events.ts');
  const ending = /^inference:(failed|exhausted|aborted)$/;
  const say = { id: 'w16.refuse' };
  const contained = { id: 'w13.wrapper', ends: 'contained' };
  const frame = (content) => ({ type: 'inference:speech', agentName: 'fixture', content });
  assert.equal(endsSpeechWait(say, frame(''), ending), false);
  assert.equal(endsSpeechWait(say, frame('words'), ending), true);
  assert.equal(endsSpeechWait(say, frame(' '), ending), true);
  assert.equal(endsSpeechWait(contained, frame(''), ending), true);
  assert.equal(endsSpeechWait(say, { type: 'inference:failed', agentName: 'fixture' }, ending), true);
  assert.equal(endsSpeechWait(say, { type: 'inference:completed', agentName: 'fixture' }, ending), false);
});

test('agentEnd knows a task fork by the name the script forked it as, and a reader fork by its reader\'s prefix, the one created since the step began', () => {
  const mail = (from) => ({ e: { type: 'dendrite:mail-delivered', kind: 'result', from, to: 'fixture' } });
  const created = (agentName) => ({ e: { type: 'dendrite:agent-created', agentName } });
  assert.equal(subagentResult([mail('priv-fork-7-d1-500')], 'priv-fork-7', 0)?.e.from, 'priv-fork-7-d1-500');
  assert.equal(subagentResult([mail('priv-fork-7-d2-retry1-600')], 'priv-fork-7', 0)?.e.from, 'priv-fork-7-d2-retry1-600', 'a retry\'s');
  assert.equal(subagentResult([mail('priv-fork-7-d1-500')], 'priv-fork', 0), undefined, 'a name that only prefixes another\'s');
  const reader = { prefix: 'reader/fixture/' };
  const earlier = [created('reader/fixture/aaaa/1')];
  const now = [...earlier, created('reader/fixture/bbbb/1'), mail('reader/fixture/aaaa/1'), mail('fixture-other'), mail('reader/fixture/bbbb/1')];
  assert.equal(subagentResult(now, reader, earlier.length)?.e.from, 'reader/fixture/bbbb/1', 'an earlier step\'s reader fork, its result delivered in this step, doesn\'t answer it');
  assert.equal(subagentResult([created('reader/fixture/bbbb/1'), mail('reader/fixture/bbbb/2')], reader, 0), undefined, 'another reader fork\'s result');
  assert.equal(subagentResult([mail('reader/fixture/bbbb/1')], reader, 0), undefined, 'a result from no reader fork created since the step began');
  assert.equal(subagentResult([{ e: { type: 'dendrite:mail-delivered', kind: 'result', to: 'fixture' } }], reader, 0), undefined, 'a result naming no sender, with no reader fork created since the step began');
});

test('a reader fork\'s hold gives a reason instead of a result when its step creates more than one reader fork of that resident, since it can\'t tell which one it waits for', () => {
  const mail = (from) => ({ e: { type: 'dendrite:mail-delivered', kind: 'result', from, to: 'fixture' } });
  const created = (agentName) => ({ e: { type: 'dendrite:agent-created', agentName } });
  const reader = { prefix: 'reader/fixture/' };
  const two = [created('reader/fixture/aaaa/1'), mail('reader/fixture/aaaa/1'), created('reader/fixture/bbbb/1')];
  assert.equal(subagentResult(two, reader, 0), '2 reader forks (reader/fixture/aaaa/1, reader/fixture/bbbb/1) were created in the step, so its hold can\'t tell which one\'s result it waits for');
  assert.equal(subagentResult(two.slice(0, 2), reader, 0)?.e.from, 'reader/fixture/aaaa/1', 'before the second fork is created, the one there is answers');
  assert.equal(subagentResult([created('reader/other/cccc/1'), ...two.slice(0, 2)], reader, 0)?.e.from, 'reader/fixture/aaaa/1', 'another resident\'s reader fork doesn\'t count');
  assert.equal(subagentResult([created('priv-fork-7-d1-500'), mail('priv-fork-7-d1-500'), created('priv-fork-7-d1-600')], 'priv-fork-7', 0)?.e.from, 'priv-fork-7-d1-500', 'a task fork is held for by its name, which the count doesn\'t reach');
});

test('D23: a push a hold sends is the push a push step sends: its id names the event and its message, its channel every channel field, its participant the author, with its tags where it has any and its text as the payload, stamped at the driver\'s clock', async () => {
  const { pushEvent } = await import('./events.ts');
  const fields = { id: 'x.held', channel: 'w13-push', participant: 'Ash', tags: ['chat:ambient', 'chat:from-human'], text: '[[c:x.held.in]] words' };
  assert.deepEqual(pushEvent(fields, 90_000), {
    eventId: 'x.held',
    timestamp: new Date(90_000).toISOString(),
    origin: { source: 'fixture', mcplChannelId: 'w13-push', channelId: 'w13-push', channelName: 'w13-push', messageId: 'x.held', authorId: 'u-ash', authorName: 'Ash' },
    tags: ['chat:ambient', 'chat:from-human'],
    payload: { content: [{ type: 'text', text: '[[c:x.held.in]] words' }] },
  });
  assert.equal('tags' in pushEvent({ ...fields, tags: undefined }, 0), false, 'a push with no tags sends none');
});

test('D23: a hold\'s push ends once the host, since the act began, has admitted that push and then stored a row from the push lane; another push\'s admission, a row stored before the admission, another lane\'s row and events before the act don\'t end it', async () => {
  const { pushStored } = await import('./events.ts');
  const admitted = (messageId) => ({ e: { type: 'admission:decided', lane: 'push', messageId } });
  const added = (source) => ({ e: { type: 'message:added', source } });
  assert.equal(pushStored([admitted('x.p'), added('mcpl:push-event')], 0, 'x.p'), true);
  assert.equal(pushStored([added('mcpl:push-event'), admitted('x.p')], 0, 'x.p'), false, 'a row stored before the admission');
  assert.equal(pushStored([admitted('x.q'), added('mcpl:push-event')], 0, 'x.p'), false, 'another push\'s admission');
  assert.equal(pushStored([admitted('x.p'), added('mcpl:channel-incoming')], 0, 'x.p'), false, 'another lane\'s row');
  assert.equal(pushStored([admitted('x.p'), added('mcpl:push-event')], 2, 'x.p'), false, 'both before the act began');
  assert.equal(pushStored([admitted('x.p'), added('mcpl:push-event'), admitted('x.p'), added('mcpl:push-event')], 2, 'x.p'), true, 'its own, after earlier ones');
});

test('the host is told each held message\'s canary with the author the script sends it under, from a turn\'s own text or a delivery\'s messages', async () => {
  const { tunedOutAuthors } = await import('./events.ts');
  const steps = [
    { id: 'h1', kind: 'channel', participant: 'Wren', text: '[[c:x.h1.in]] held', tunedOut: ['[[c:x.h1.in]]'] },
    { id: 'h2', kind: 'deliver', messages: [{ participant: 'Tavy', text: '[[c:x.h2.in]] held' }], tunedOut: ['[[c:x.h2.in]]'] },
    { id: 'a', kind: 'channel', participant: 'Ash', text: '[[c:x.a.in]] not held' },
  ];
  assert.deepEqual(tunedOutAuthors(steps), [['[[c:x.h1.in]]', 'Wren'], ['[[c:x.h2.in]]', 'Tavy']]);
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5, configuration: {} };
  assert.deepEqual(JSON.parse(hostEnv({ ...base, tunedOut: tunedOutAuthors(steps) }).FIXTURE_TUNED_OUT), [['[[c:x.h1.in]]', 'Wren'], ['[[c:x.h2.in]]', 'Tavy']]);
});

test('a host that dies by a signal the harness didn\'t send is named as signalled, apart from a host that exits with a code of its own', async () => {
  const { runScript } = await import('./driver.ts');
  const { startStandin } = await import('../standin/standin.ts');
  const configuration = configurations().H1;
  for (const [body, signalled, said] of [
    ['kill -KILL $$', { boot: 1, signal: 'SIGKILL' }, /the host exited \(SIGKILL\)/],
    ['exit 3', null, /the host exited \(3\)/],
  ]) {
    const bin = mkdtempSync(join(tmpdir(), 'fake-bun-'));
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
    try {
      const run = await runScript({ steps: [], configuration, standin, hostDir: bin, facts: {}, work: join(bin, 'work'), storeDir: join(bin, 'store'), epoch: 0, logPath: join(bin, 'log.jsonl'), hostLogs: { dir: join(bin, 'logs'), at: 'logs' } });
      assert.equal(run.ok, false, body);
      assert.match(run.failure.reason, said, body);
      assert.deepEqual(run.signalled, signalled, body);
    } finally {
      process.env.PATH = path;
      await standin.close();
      rmSync(bin, { recursive: true, force: true });
    }
  }
});

test('a host that dies by a signal stays named as signalled, its exit the run\'s failure, when its log can\'t be written, the write\'s failure caught rather than thrown', async () => {
  const { runScript } = await import('./driver.ts');
  const { startStandin } = await import('../standin/standin.ts');
  const bin = mkdtempSync(join(tmpdir(), 'fake-bun-'));
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nkill -KILL $$\n');
  chmodSync(join(bin, 'bun'), 0o755);
  mkdirSync(join(bin, 'logs', 'host-1.log'), { recursive: true });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const run = await runScript({ steps: [], configuration: configurations().H1, standin, hostDir: bin, facts: {}, work: join(bin, 'work'), storeDir: join(bin, 'store'), epoch: 0, logPath: join(bin, 'log.jsonl'), hostLogs: { dir: join(bin, 'logs'), at: 'logs' } });
    assert.deepEqual(run.signalled, { boot: 1, signal: 'SIGKILL' });
    assert.equal(run.ok, false);
    assert.match(run.failure.reason, /^the host exited \(SIGKILL\)/);
    assert.ok(statSync(join(bin, 'logs', 'host-1.log')).isDirectory(), 'the log\'s place is a directory, so its write fails');
  } finally {
    process.env.PATH = path;
    await standin.close();
    rmSync(bin, { recursive: true, force: true });
  }
});
