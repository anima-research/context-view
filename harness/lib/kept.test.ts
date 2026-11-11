import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptReleases } from './kept.ts';
import type { Versions } from './shapes/interfaces.ts';

const LANE = 'a'.repeat(64);
const A = { '@animalabs/context-manager': '0.25.0' };
const B = { '@animalabs/context-manager': '0.25.1' };
const invocation = (dir: string | null, versions: Versions, installs: string[] = []) => keptReleases({ dir, lane: LANE, install: (tag) => { installs.push(tag); return { versions, hostDir: `/${tag}` }; } });
const factsOf = (name: string) => () => ({ window: name });

test('two invocations of one release share its kept facts: the second installs nothing for a setup the first kept, and adds its own setups beside the first\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    const one = invocation(dir, A);
    const reported = await one.versions('v1');
    assert.deepEqual(await one.facts('v1', 'H1', factsOf('h1'), reported), { versions: A, facts: { window: 'h1' } });
    const installs: string[] = [];
    const two = invocation(dir, A, installs);
    assert.deepEqual(await two.facts('v1', 'H1', factsOf('other'), await two.versions('v1')), { versions: A, facts: { window: 'h1' } });
    assert.deepEqual(installs, [], 'its versions and H1\'s facts were kept');
    await two.facts('v1', 'H3', factsOf('h3'), A);
    const [file] = readdirSync(join(dir, 'releases'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', file), 'utf-8')).facts, { H1: { window: 'h1' }, H3: { window: 'h3' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an invocation whose release\'s tag moved between its install and another\'s fails naming the kept facts, rather than key or build a checkpoint on the other\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    const one = invocation(dir, A);
    const reported = await one.versions('v1');
    const two = invocation(dir, B);
    assert.deepEqual(await two.versions('v1'), A, 'a later invocation reports the kept versions, installing nothing');
    await assert.rejects(two.facts('v1', 'H3', factsOf('from B'), A), /v1's kept facts \(.*releases\/v1-a{16}\.json\) name context-manager@0\.25\.0, where this invocation's v1 is context-manager@0\.25\.1: the tag's contents changed between two installs/,
      'once it has to install, the install it gets differs from the kept versions it reported');
    const [file] = readdirSync(join(dir, 'releases'));
    writeFileSync(join(dir, 'releases', file), JSON.stringify({ versions: B, facts: { H1: { window: 'from B' } } }));
    for (const config of ['H1', 'H3']) {
      await assert.rejects(one.facts('v1', config, factsOf('from A'), reported), /v1's kept facts \(.*\) name context-manager@0\.25\.1, where this invocation's v1 is context-manager@0\.25\.0/,
        `with another install's write landed last, the first invocation's ${config} checkpoint isn't keyed on, or given, facts from B`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an install made for a checkpoint is held to the versions the invocation reported, even where the kept facts went missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    const one = invocation(dir, A);
    const reported = await one.versions('v1');
    await one.facts('v1', 'H1', factsOf('h1'), reported);
    const two = invocation(dir, B);
    const theirs = await two.versions('v1');
    assert.deepEqual((await two.facts('v1', 'H1', factsOf('other'), theirs)).facts, { window: 'h1' });
    rmSync(join(dir, 'releases'), { recursive: true, force: true });
    await assert.rejects(two.installed('v1', theirs), /v1's kept facts \(.*\) name context-manager@0\.25\.0, where this invocation's v1 is context-manager@0\.25\.1/,
      'its checkpoint would be built from B under the key of the A it reported');
    assert.equal(existsSync(join(dir, 'releases')), false, 'and it writes nothing for B');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a release whose install failed fails the same way for every later checkpoint, installing once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    let tries = 0;
    const one = keptReleases({ dir, lane: LANE, install: () => { tries++; throw new Error('npm ci failed'); } });
    for (let i = 0; i < 2; i++) await assert.rejects(one.installed('v1'), /^Error: installing v1 failed: npm ci failed$/);
    assert.equal(tries, 1);
    await invocation(dir, A).versions('v1');
    const two = invocation(dir, B);
    for (let i = 0; i < 2; i++) await assert.rejects(two.installed('v1', A), /where this invocation's v1 is context-manager@0\.25\.1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a throw of any value while installing a release fails it, a falsy one included, rather than resolving with no release', async () => {
  const one = keptReleases({ dir: null, lane: LANE, install: (tag) => ({ versions: A, hostDir: `/${tag}` }), log: () => { throw undefined; } });
  await assert.rejects(one.installed('v1'), (e) => e === undefined);
});

test('reads of one setup\'s facts asked at once share one read, kept directory or none, since checkpoints of a setup start together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    for (const kept of [dir, null]) {
      let reads = 0;
      const one = invocation(kept, A);
      const reported = await one.versions('v1');
      const slow = async () => { reads++; await new Promise((r) => setTimeout(r, 20)); return { window: 'h1' }; };
      const got = await Promise.all([one.facts('v1', 'H1', slow, reported), one.facts('v1', 'H1', slow, reported)]);
      assert.deepEqual(got, [{ versions: A, facts: { window: 'h1' } }, { versions: A, facts: { window: 'h1' } }]);
      await one.facts('v1', 'H1', slow, reported);
      assert.equal(reads, 1, `with ${kept ? 'a kept directory' : 'no kept directory'}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
