// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurations } from './script.ts';

const FAKE_HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-host.ts');
const PAUSED = '1 chunks pending; compression paused until 1970-01-01T00:00:05.000Z (backoff, failure 1; latest: the chunk of 5 message(s) from 9 failed (server:500))';
const progress = { totalChunks: 4, chunksCompressed: 3, l1QueueLength: 1, mergeQueueLength: 0, summaryCounts: { l1: 3, l2: 0, l3: 0 }, pending: false };
const drained = { drained: true, deferredWrites: 0, gatedRequests: 0, activeTurnAgents: [], parkedAdmissions: 0 };

async function drive(script, steps = []) {
  const { runScript } = await import('./driver.ts');
  const { startStandin } = await import('../standin/standin.ts');
  const bin = mkdtempSync(join(tmpdir(), 'fake-host-'));
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec node ${JSON.stringify(FAKE_HOST)} "$@"\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  process.env.FAKE_HOST_SCRIPT = JSON.stringify(script);
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const run = await runScript({ steps, configuration: configurations().H1, standin, hostDir: bin, facts: {}, work: join(bin, 'work'), storeDir: join(bin, 'store'), epoch: 0, logPath: join(bin, 'log.jsonl'), hostLogs: { dir: join(bin, 'logs'), at: 'logs' } });
    const log = readFileSync(join(bin, 'log.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    return { run, log };
  } finally {
    process.env.PATH = path;
    delete process.env.FAKE_HOST_SCRIPT;
    await standin.close();
    rmSync(bin, { recursive: true, force: true });
  }
}

const notes = (log, kind) => log.filter((e) => e.kind === kind).map(({ step, agent, until, ms }) => ({ step, agent, until, ms }));

test('a settle that ends with every agent ready or at rest in a pause writes the pause once, at the step where it ended', { timeout: 30_000 }, async () => {
  const { run, log } = await drive({ before: { agents: [{ agentName: 'fixture', ready: false, pending: PAUSED, progress }], hostMode: drained } });
  assert.equal(run.ok, true, run.failure?.reason);
  assert.deepEqual(notes(log, 'compression-paused'), [{ step: null, agent: 'fixture', until: 5_000, ms: 5_000 }], 'the run\'s end health settle, which no step holds');
});

test('a settle that ends with a turn held by its provider and an agent at rest in a pause writes both, each once', { timeout: 30_000 }, async () => {
  const held = { agents: [{ name: 'fixture', status: 'idle', primaryActive: false, auxiliaryInFlight: 0, heldRequests: 1, cooldownUntil: 60_000, budgetHold: null }], pendingRequests: 0, activeStreams: [] };
  const { run, log } = await drive({
    before: { agents: [{ agentName: 'fixture', ready: false, pending: PAUSED, progress }], hostMode: { ...drained, drained: false, activeTurnAgents: ['fixture'] }, held },
    after: { agents: [{ agentName: 'fixture', ready: true, progress: { ...progress, l1QueueLength: 0, chunksCompressed: 4 } }], hostMode: drained },
  }, [{ id: 'x.1', segment: 'X', kind: 'advance', ms: 61_000 }]);
  assert.equal(run.ok, true, run.failure?.reason);
  assert.deepEqual(notes(log, 'provider-held'), [{ step: 'x.1', agent: 'fixture', until: 60_000, ms: 60_000 }]);
  assert.deepEqual(notes(log, 'compression-paused'), [{ step: 'x.1', agent: 'fixture', until: 5_000, ms: 5_000 }]);
});
