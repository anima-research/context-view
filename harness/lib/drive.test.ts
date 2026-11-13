import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as drive from './drive.ts';
import type { DeepPartial, PartialArgs } from './testing/deep-partial.ts';
import type { RequestRecord } from './standin/standin.ts';
import type { LogEntry } from './strategies/driver.ts';

const { checkpointOutcome, runUnmeasured } = drive as unknown as { [K in 'checkpointOutcome' | 'runUnmeasured']: PartialArgs<typeof drive[K]> };
const NOWHERE = join(tmpdir(), 'whole-host-no-such-host');
type Ran = Parameters<typeof drive.checkpointOutcome>[0]['run'];

test('a checkpoint build whose own record ties two requests by arrival or rests a cache figure on it fails, naming what; a clean one, or one that failed, keeps its outcome', () => {
  const run = { ok: true, clockEnd: 42 } satisfies DeepPartial<Ran>;
  const tied = [{ id: 'j.0123456789ab', tied: ['j.0123456789ab-2'] }, { id: 'j.0123456789ab-2', tied: ['j.0123456789ab'] }] satisfies DeepPartial<RequestRecord>[];
  const log = [{ kind: 'order', step: 'q', order: ['j.0123456789ab', 'j.0123456789ab-2'], ended: true }] satisfies DeepPartial<LogEntry>[];
  assert.deepEqual(checkpointOutcome({ run, records: tied, log }), { ok: false, failure: { reason: 'what its build leaves rests on arrival: a record\'s numbering rests on arrival: requests j.0123456789ab#1 and j.0123456789ab#2 share a name, their bodies differ, and nothing but their arrival orders them' }, clockEnd: 42 });
  assert.deepEqual(checkpointOutcome({ run, records: [{ id: 'a' }], log }), { ok: true, failure: null, clockEnd: 42 });
  const shared = [{ id: 'r1' }, { id: 'r2', unordered: [{ with: 'r1', why: 'markers' }] }] satisfies DeepPartial<RequestRecord>[];
  assert.deepEqual(checkpointOutcome({ run, records: shared, log: [{ kind: 'order', step: 'q', order: ['r1', 'r2'], ended: true }] }), { ok: false, failure: { reason: 'what its build leaves rests on arrival: a cache figure rests on arrival: requests r1 and r2 meet in one cache, nothing orders the two, and their order can move what one of them reads' }, clockEnd: 42 });
  const failed = { ok: false, failure: { reason: 'the host exited (1)' }, clockEnd: 7 } satisfies DeepPartial<Ran>;
  assert.deepEqual(checkpointOutcome({ run: failed, records: tied, log }), { ok: false, failure: { reason: 'the host exited (1)' }, clockEnd: 7 }, 'a build that failed fails for its own reason');
});

test('a run\'s unmeasured notes name a reader fork by its epoch\'s name in the record', () => {
  const log = [{ kind: 'compiles', step: 'h.1', boot: 1, lines: [{ seq: 2, agent: 'reader/fixture/aaaaaaaa/1', kind: 'dry', alive: true }] }] satisfies DeepPartial<LogEntry>[];
  assert.deepEqual(runUnmeasured({ invalid: [], flags: [], judged: [] }, { completed: true, records: [], log }), ['a dry compile rests on timing: something other than reader/fixture/E1/1\'s own turn compiled its context while that turn was alive (boot 1, compile line 2)']);
});

test('a facts child given a configuration only Object.prototype holds refuses it by name, as an unknown one, before it asks the host', () => {
  for (const configuration of ['toString', 'constructor', 'nope']) {
    assert.throws(() => drive.factsOf({ hostDir: NOWHERE, configuration }), { message: `the harness has no configuration ${JSON.stringify(configuration)}` }, configuration);
  }
});

test('a drive child given a run id whose configuration only Object.prototype holds can\'t run it, with runOf\'s words for an unknown run, before it asks the host', async () => {
  for (const id of ['toString/W1', 'constructor/W1', 'nope/W1']) {
    const run = await drive.workloadRun({ id, candidate: { hostDir: NOWHERE, installDir: NOWHERE }, dir: join(NOWHERE, 'dir'), scratch: join(NOWHERE, 'scratch'), out: NOWHERE });
    assert.deepEqual(run, { outcome: 'couldnt-run', reason: `no run ${id}: no such configuration, workload or variant` }, id);
  }
});
