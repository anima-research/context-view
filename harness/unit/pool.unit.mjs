import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessFailure, runChild, slots } from '../lib/pool.mjs';
import { orderOf } from '../lib/shares.mjs';

const settled = () => new Promise((r) => setImmediate(r));

test('a pool never holds more slots at once than its width', async () => {
  const pool = slots(2);
  const held = [];
  const taken = [0, 1, 2, 3].map((i) => pool.take([i]).then((release) => { held.push(i); return release; }));
  await settled();
  assert.deepEqual(held, [0, 1], 'two of four hold a slot');
  (await taken[0])();
  await settled();
  assert.deepEqual(held, [0, 1, 2], 'a third takes the slot the first gave back');
  (await taken[1])();
  (await taken[2])();
  await settled();
  assert.deepEqual(held, [0, 1, 2, 3]);
});

test('a pool gives a freed slot to the waiting task with the smallest key, compared element by element, whatever order they asked in', async () => {
  const pool = slots(1);
  const first = await pool.take([0]);
  const served = [];
  const keys = [[-5, 1], [-9, 2], [-1, 0], [-9, 0], [-5, 0, 2], [-5, 0, 1]];
  const waits = keys.map((k) => pool.take(k).then((release) => { served.push(k); return release; }));
  await settled();
  assert.deepEqual(served, [], 'no slot is free while the first holds it');
  first();
  for (let i = 0; i < keys.length; i++) {
    await settled();
    assert.equal(served.length, i + 1, 'one slot, so one task at a time');
    (await waits[keys.indexOf(served[i])])();
  }
  assert.deepEqual(served, [[-9, 0], [-9, 2], [-5, 0, 1], [-5, 0, 2], [-5, 1], [-1, 0]]);
});

test('a pool weighs every task that asks in one turn, so a free slot goes to the smallest key rather than the first to ask', async () => {
  const pool = slots(2);
  const served = [];
  for (const k of [[3], [1], [2], [0]]) pool.take(k).then(() => served.push(k[0]));
  await settled();
  await settled();
  assert.deepEqual(served.sort(), [0, 1]);
});

test('runs start longest first: a checkpoint ranks by its own seconds and the longest run that starts from it, a run by its own, and ties keep the share\'s order', () => {
  const table = { runs: { A: 10, B: 12, C: 3, D: 12 }, checkpoints: { X: 5 } };
  const from = { A: 'X', C: 'X', B: null, D: null };
  const order = orderOf(['A', 'B', 'C', 'D'], table, (id) => from[id]);
  const keyed = [
    ['checkpoint X', order.checkpoint('X')],
    ['A', order.run('A')],
    ['B', order.run('B')],
    ['C', order.run('C')],
    ['D', order.run('D')],
  ].sort(([, a], [, b]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  }).map(([name]) => name);
  assert.deepEqual(keyed, ['checkpoint X', 'B', 'D', 'A', 'C'], 'X carries 5 s and A\'s 10 s (15); B and D tie at 12 in the share\'s order; then A and C');
});

test('a run with no seconds in the table ranks by the median of the runs that have them, as shares() weighs it', () => {
  const order = orderOf(['A', 'B', 'C', 'E'], { runs: { A: 10, B: 12, C: 3 }, checkpoints: {} }, () => null);
  assert.deepEqual(order.run('E').slice(0, 1), order.run('A').slice(0, 1), 'E ranks at the median, 10 s');
});

test('a child that dies by a signal fails with a harness failure naming what it was doing and the signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  const live = new Set();
  try {
    const running = runChild({ kind: 'facts', hostDir: dir, configuration: 'H1', result: join(dir, 'result.json') }, { label: 'the head arm\'s self-check drive of H1/W7', live });
    assert.equal(live.size, 1, 'the child is live as soon as it starts');
    for (const c of live) process.kill(-c.pid, 'SIGKILL');
    await assert.rejects(running, (e) => e instanceof HarnessFailure && /^the head arm's self-check drive of H1\/W7: /.test(e.message) && /SIGKILL/.test(e.message));
    assert.equal(live.size, 0, 'a child that has ended is no longer live');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a child that ends without writing its result fails with a harness failure naming its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  try {
    const running = runChild({ kind: 'facts', hostDir: dir, configuration: 'H1', result: join(dir, 'no-such-dir', 'result.json') }, { label: 'the checkpoint H1/prefix\'s build', live: new Set() });
    await assert.rejects(running, (e) => e instanceof HarnessFailure && /^the checkpoint H1\/prefix's build: /.test(e.message) && /exited 1 without a result/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an error the child\'s work throws comes back as that error, not as a harness failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  try {
    const running = runChild({ kind: 'no-such-kind', result: join(dir, 'result.json') }, { label: 'a child', live: new Set() });
    await assert.rejects(running, (e) => !(e instanceof HarnessFailure) && /no-such-kind/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
