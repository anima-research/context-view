// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurations } from './script.ts';

const FAKE_HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-host.ts');
const EPOCH = Date.parse('2026-01-06T09:00:00.000Z');
const PAUSED = `1 chunks pending; compression paused until ${new Date(EPOCH + 5_000).toISOString()} (backoff, failure 1; latest: the chunk of 5 message(s) from 9 failed (server:500))`;
const progress = { totalChunks: 4, chunksCompressed: 3, l1QueueLength: 1, mergeQueueLength: 0, summaryCounts: { l1: 3, l2: 0, l3: 0 }, pending: false };
const drained = { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 };

async function drive(script, steps = []) {
  const { runScript } = await import('./driver.ts');
  const { startStandin } = await import('../standin/standin.ts');
  const bin = mkdtempSync(join(tmpdir(), 'fake-host-'));
  const saved = { PATH: process.env.PATH, FAKE_HOST_SCRIPT: process.env.FAKE_HOST_SCRIPT };
  let standin = null;
  try {
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec node ${JSON.stringify(FAKE_HOST)} "$@"\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.FAKE_HOST_SCRIPT = JSON.stringify(script);
    standin = await startStandin({ configuration: { windowTokens: 50_000 } });
    const run = await runScript({ steps, configuration: configurations().H1, standin, hostDir: bin, facts: {}, work: join(bin, 'work'), storeDir: join(bin, 'store'), epoch: EPOCH, logPath: join(bin, 'log.jsonl'), hostLogs: { dir: join(bin, 'logs'), at: 'logs' } });
    const log = readFileSync(join(bin, 'log.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    return { run, log };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await standin?.close();
    rmSync(bin, { recursive: true, force: true });
  }
}

const notes = (log, kind) => log.filter((e) => e.kind === kind).map(({ step, agent, until, ms }) => ({ step, agent, until, ms }));

test('a settle that ends with every agent ready or at rest in a pause writes the pause once, at the step where it ended', { timeout: 30_000 }, async () => {
  const { run, log } = await drive({ before: { agents: [{ agentName: 'fixture', ready: false, pending: PAUSED, progress }], hostMode: drained } });
  assert.equal(run.ok, true, run.failure?.reason);
  assert.deepEqual(notes(log, 'compression-paused'), [{ step: null, agent: 'fixture', until: EPOCH + 5_000, ms: 5_000 }], 'the run\'s end health settle, which no step holds; the instant is the host\'s absolute one, and the milliseconds are counted from the driver\'s clock');
});

test('a settle that ends with a turn held by its provider and an agent at rest in a pause writes both, each once', { timeout: 30_000 }, async () => {
  const held = { agents: [{ name: 'fixture', status: 'idle', primaryActive: false, auxiliaryInFlight: 0, heldRequests: 1, cooldownUntil: EPOCH + 60_000, budgetHold: null }], pendingRequests: 0, activeStreams: [] };
  const { run, log } = await drive({
    before: { agents: [{ agentName: 'fixture', ready: false, pending: PAUSED, progress }], hostMode: { ...drained, drained: false, activeTurnAgents: ['fixture'] }, held },
    after: { agents: [{ agentName: 'fixture', ready: true, progress: { ...progress, l1QueueLength: 0, chunksCompressed: 4 } }], hostMode: drained },
  }, [{ id: 'x.1', segment: 'X', kind: 'advance', ms: 61_000 }]);
  assert.equal(run.ok, true, run.failure?.reason);
  assert.deepEqual(notes(log, 'provider-held'), [{ step: 'x.1', agent: 'fixture', until: EPOCH + 60_000, ms: 60_000 }]);
  assert.deepEqual(notes(log, 'compression-paused'), [{ step: 'x.1', agent: 'fixture', until: EPOCH + 5_000, ms: 5_000 }]);
});

test('a turn held by its provider until an instant with a fraction of a millisecond is written with the time the hold\'s timer runs, cut to whole milliseconds as the clock cuts it', { timeout: 30_000 }, async () => {
  const held = { agents: [{ name: 'fixture', status: 'idle', primaryActive: false, auxiliaryInFlight: 0, heldRequests: 1, cooldownUntil: EPOCH + 60_000.5, budgetHold: null }], pendingRequests: 0, activeStreams: [] };
  const { run, log } = await drive({
    before: { agents: [{ agentName: 'fixture', ready: true, progress }], hostMode: { ...drained, drained: false, activeTurnAgents: ['fixture'] }, held },
    after: { agents: [{ agentName: 'fixture', ready: true, progress }], hostMode: drained },
  }, [{ id: 'x.1', segment: 'X', kind: 'advance', ms: 61_000 }]);
  assert.equal(run.ok, true, run.failure?.reason);
  assert.deepEqual(notes(log, 'provider-held'), [{ step: 'x.1', agent: 'fixture', until: EPOCH + 60_000.5, ms: 60_000 }]);
});

test('a step of a kind the driver runs no function for fails the run as such, a name its table of kinds inherits included', { timeout: 30_000 }, async () => {
  const ready = { before: { agents: [{ agentName: 'fixture', ready: true, progress: { ...progress, l1QueueLength: 0, chunksCompressed: 4 } }], hostMode: drained } };
  for (const kind of ['nope', 'toString']) {
    const { run } = await drive(ready, [{ id: 'x.1', segment: 'X', kind }]);
    assert.equal(run.ok, false, kind);
    assert.equal(run.failure.reason, `the driver has no step kind ${JSON.stringify(kind)}`, kind);
  }
});

test('a command step whose name the commands\' table only inherits fails the run as one the driver doesn\'t know the end of', { timeout: 30_000 }, async () => {
  const ready = { before: { agents: [{ agentName: 'fixture', ready: true, progress: { ...progress, l1QueueLength: 0, chunksCompressed: 4 } }], hostMode: drained } };
  for (const command of ['/nope', '/toString', '/constructor', '/hasOwnProperty']) {
    const { run } = await drive(ready, [{ id: 'x.1', segment: 'X', kind: 'command', command }]);
    assert.equal(run.ok, false, command);
    assert.equal(run.failure.reason, `the driver doesn't know when ${JSON.stringify(command)} ends`, command);
  }
});

test('a step that reads the stored messages fails the run with the harness module\'s reason when the module can\'t read them, its whole reason too where the module cut it', { timeout: 30_000 }, async () => {
  const ready = { agents: [{ agentName: 'fixture', ready: true, progress: { ...progress, l1QueueLength: 0, chunksCompressed: 4 } }], hostMode: drained };
  for (const [answer, full] of [
    [{ unreadable: 'stored message 2 has no content list' }, undefined],
    [{ unreadable: 'stored message 2 has no con…', full: 'stored message 2 has no content list' }, 'couldn\'t read fixture\'s stored messages: stored message 2 has no content list'],
  ]) {
    const { run } = await drive({ before: ready, messages: answer }, [{ id: 'x.1', segment: 'X', kind: 'command', command: '/undo [[c:x.1.in]]' }]);
    assert.equal(run.ok, false);
    assert.equal(run.failure.reason, `couldn't read fixture's stored messages: ${answer.unreadable}`);
    assert.equal(run.failure.full, full);
  }
});
