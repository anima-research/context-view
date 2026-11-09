import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shares } from '../lib/shares.ts';

test('shares balance runs by their seconds, paying for a checkpoint once a share, and cover every run once', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const table = { runs: { a: 100, b: 10, c: 60, d: 50, e: 10 }, checkpoints: { k: 40 } };
  const key = (id: string) => (['c', 'd'].includes(id) ? 'k' : null);
  const out = shares(ids, 2, table, key);
  assert.deepEqual(out.map((x) => x.ids), [['a', 'b', 'e'], ['c', 'd']], 'd joins c, whose checkpoint its share already pays for');
  assert.deepEqual(out.map((x) => x.seconds), [120, 150]);
  assert.deepEqual([...out.flatMap((x) => x.ids)].sort(), ids);
  assert.deepEqual(shares(ids, 2, table, key), out, 'the same inputs give the same shares');
});

test('shares count each run\'s seconds once for each drive the caller names and each checkpoint\'s once, so the share heavy in runs isn\'t left the slowest', () => {
  const ids = ['a', 'b', 'c'];
  const table = { runs: { a: 50, b: 50, c: 10 }, checkpoints: { k: 100 } };
  const key = (id: string) => (id === 'c' ? 'k' : null);
  assert.deepEqual(shares(ids, 2, table, key, 3), [{ seconds: 280, ids: ['a', 'c'] }, { seconds: 150, ids: ['b'] }]);
});

test('a run with no recorded seconds counts as the median of those recorded, and one share holds them all', () => {
  const out = shares(['x', 'y', 'z'], 1, { runs: { x: 5, y: 7 } });
  assert.deepEqual(out, [{ seconds: 19, ids: ['x', 'y', 'z'] }]);
});

test('a checkpoint with no recorded seconds counts as the median of the checkpoints recorded', () => {
  assert.deepEqual(shares(['a'], 1, { runs: { a: 10 }, checkpoints: { k: 40, m: 20 } }, () => 'q'), [{ seconds: 50, ids: ['a'] }]);
});

test('a run that starts from an older release\'s store shares its job with no run of another older release, and pays that release\'s install once there', () => {
  const ids = ['a', 'b', 'u9', 'u23', 'w9'];
  const table = { runs: { a: 50, b: 50, u9: 4, u23: 4, w9: 4 }, checkpoints: { p9: 7, p23: 7 }, installs: { 'v0.9.0': 30, 'v0.23.0': 20 } };
  const key = (id: string) => (({ u9: 'p9', w9: 'p9', u23: 'p23' } as Record<string, string>)[id] ?? null);
  const release = (id: string) => (({ u9: 'v0.9.0', w9: 'v0.9.0', u23: 'v0.23.0' } as Record<string, string>)[id] ?? null);
  const out = shares(ids, 2, table, key, 1, release);
  const holding = (tag: string) => out.filter((x) => x.ids.some((id) => release(id) === tag)).length;
  assert.equal(holding('v0.9.0'), 1, 'both v0.9.0 runs share one job');
  assert.equal(holding('v0.23.0'), 1);
  assert.ok(out.every((x) => new Set(x.ids.map(release).filter(Boolean)).size <= 1), 'no job holds two older releases');
  const nine = out.find((x) => x.ids.includes('u9'))!;
  assert.equal(nine.seconds, (nine.ids.includes('a') ? 50 : 0) + (nine.ids.includes('b') ? 50 : 0) + 4 + 4 + 7 + 30, 'its install and its checkpoint paid once');
  assert.deepEqual([...out.flatMap((x) => x.ids)].sort(), [...ids].sort());
  assert.deepEqual(shares(['u9', 'u23'], 1, table, key, 1, release), [{ seconds: 72, ids: ['u9', 'u23'] }], 'with one share, it holds both, since there is nowhere else');
});

test('with more older releases than shares, the runs of each release still share one job, and its install is paid once there', () => {
  const ids = ['a', 'c', 'b1', 'b2'];
  const table = { runs: { a: 100, c: 100, b1: 5, b2: 5 }, checkpoints: { pa: 1, pc: 1, pb: 7 }, installs: { A: 30, B: 30, C: 30 } };
  const key = (id: string) => ({ a: 'pa', c: 'pc', b1: 'pb', b2: 'pb' } as Record<string, string>)[id];
  const release = (id: string) => ({ a: 'A', c: 'C', b1: 'B', b2: 'B' } as Record<string, string>)[id];
  const out = shares(ids, 2, table, key, 1, release);
  assert.equal(out.filter((x) => x.ids.some((id) => release(id) === 'B')).length, 1, 'both B runs in one job');
  const b = out.find((x) => x.ids.includes('b1'))!;
  const other = b.ids.find((id) => id === 'a' || id === 'c');
  assert.equal(b.seconds, 100 + 1 + 30 + 5 + 5 + 7 + 30, "the job pays its first release's run, checkpoint and install, then B's install and checkpoint once");
  assert.ok(other, 'it holds one of the two other releases too, there being no job left without one');
  const one = shares(['b1', 'b2'], 1, table, key, 1, release);
  assert.deepEqual(one, [{ seconds: 5 + 5 + 7 + 30, ids: ['b1', 'b2'] }], 'one job pays one release\'s install once');
});

test('an older release with no recorded install seconds counts as the median of those recorded, or 1 with none recorded', () => {
  const key = () => null;
  const release = () => 'X';
  assert.deepEqual(shares(['a'], 1, { runs: { a: 10 }, installs: { Y: 40, Z: 20 } }, key, 1, release), [{ seconds: 50, ids: ['a'] }]);
  assert.deepEqual(shares(['a'], 1, { runs: { a: 10 } }, key, 1, release), [{ seconds: 11, ids: ['a'] }]);
});
