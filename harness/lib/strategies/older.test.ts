import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRecords, borrowedWindow, modelLimitsLine, primaryAgentName } from './older.ts';

const src = (f: string) => JSON.stringify(`/host/src/${f}`);

test('an older host with no src/model-limits.ts gives no window, and one with it is read as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fxo-'));
  try {
    mkdirSync(join(dir, 'src'));
    assert.equal(modelLimitsLine(dir, src), 'const getDefaultModelLimits = () => null;');
    writeFileSync(join(dir, 'src', 'model-limits.ts'), 'export {};\n');
    assert.equal(modelLimitsLine(dir, src), `const { getDefaultModelLimits } = await import(${src('model-limits.ts')});`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a release\'s own window stands, and so does a configuration\'s; only where neither names one is the candidate read for it', async () => {
  let read = 0;
  const candidate = () => { read++; return 1_000_000; };
  assert.equal(await borrowedWindow({ window: 200_000 }, {}, candidate), undefined);
  assert.equal(await borrowedWindow({ window: null }, { windowTokens: 872_000 }, candidate), undefined);
  assert.equal(read, 0, 'the candidate isn\'t read where the release or the configuration names the window');
  assert.equal(await borrowedWindow({ window: null }, {}, candidate), 1_000_000);
  assert.equal(await borrowedWindow({ window: null }, {}, async () => null), null, 'a candidate that knows none gives none');
  assert.equal(await borrowedWindow({ window: null }, { windowTokens: null }, candidate), 1_000_000, 'a configuration whose windowTokens is null names none, as asRun reads it');
});

test('a framework with listAgents and getPrimaryAgentName is read through them unchanged, and an older one through its agents map', () => {
  const records = [{ name: 'fixture', kind: 'primary' }];
  const current = { listAgents: (opts?: { includeEnded?: boolean }) => (opts?.includeEnded ? [...records, { name: 'gone' }] : records), getPrimaryAgentName: () => 'fixture' };
  assert.equal(agentRecords(current), records, 'the method\'s own answer, as it gave it');
  assert.deepEqual(agentRecords(current, { includeEnded: true }).map((r) => r.name), ['fixture', 'gone'], 'with its options');
  assert.equal(primaryAgentName(current), 'fixture');
  const older = { agents: new Map([['fixture', {}]]) };
  assert.deepEqual(agentRecords(older), [{ name: 'fixture' }]);
  assert.equal(primaryAgentName(older), 'fixture', 'the one agent an older framework runs is its primary');
  assert.equal(primaryAgentName({ agents: new Map([['a', {}], ['b', {}]]) }), null, 'two agents and no method name no primary');
});
