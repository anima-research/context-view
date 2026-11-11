import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointOutcome } from './drive.ts';

test('a checkpoint build whose own record ties two requests by arrival or rests a cache figure on it fails, naming what; a clean one, or one that failed, keeps its outcome', () => {
  const run = { ok: true, clockEnd: 42 };
  const tied = [{ id: 'j.0123456789ab', tied: ['j.0123456789ab-2'] }, { id: 'j.0123456789ab-2', tied: ['j.0123456789ab'] }];
  const log = [{ kind: 'order', step: 'q', order: ['j.0123456789ab', 'j.0123456789ab-2'], ended: true }];
  assert.deepEqual(checkpointOutcome({ run, records: tied, log }), { ok: false, failure: { reason: 'what its build leaves rests on arrival: a record\'s numbering rests on arrival: requests j.0123456789ab#1 and j.0123456789ab#2 share a name, their bodies differ, and nothing but their arrival orders them' }, clockEnd: 42 });
  assert.deepEqual(checkpointOutcome({ run, records: [{ id: 'a' }], log }), { ok: true, failure: null, clockEnd: 42 });
  const failed = { ok: false, failure: { reason: 'the host exited (1)' }, clockEnd: 7 };
  assert.deepEqual(checkpointOutcome({ run: failed, records: tied, log }), { ok: false, failure: { reason: 'the host exited (1)' }, clockEnd: 7 }, 'a build that failed fails for its own reason');
});
