import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptReleases } from '../lib/kept.mjs';

const LANE = 'a'.repeat(64);
const A = { '@animalabs/context-manager': '0.25.0' };
const B = { '@animalabs/context-manager': '0.25.1' };
const invocation = (dir, versions, installs = []) => keptReleases({ dir, lane: LANE, install: (tag) => { installs.push(tag); return { versions, hostDir: `/${tag}` }; } });
const factsOf = (name) => () => ({ window: name });

test('two invocations of one release share its kept facts: the second installs nothing for a setup the first kept, and adds its own setups beside the first\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    const one = invocation(dir, A);
    const reported = one.versions('v1');
    assert.deepEqual(one.facts('v1', 'H1', factsOf('h1'), reported), { versions: A, facts: { window: 'h1' } });
    const installs = [];
    const two = invocation(dir, A, installs);
    assert.deepEqual(two.facts('v1', 'H1', factsOf('other'), two.versions('v1')), { versions: A, facts: { window: 'h1' } });
    assert.deepEqual(installs, [], 'its versions and H1\'s facts were kept');
    two.facts('v1', 'H3', factsOf('h3'), A);
    const [file] = readdirSync(join(dir, 'releases'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', file), 'utf-8')).facts, { H1: { window: 'h1' }, H3: { window: 'h3' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an invocation whose release\'s tag moved between its install and another\'s fails naming the kept facts, rather than key or build a checkpoint on the other\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    const one = invocation(dir, A);
    const reported = one.versions('v1');
    const two = invocation(dir, B);
    assert.deepEqual(two.versions('v1'), A, 'a later invocation reports the kept versions, installing nothing');
    assert.throws(() => two.facts('v1', 'H3', factsOf('from B'), A), /v1's kept facts \(.*releases\/v1-a{16}\.json\) name context-manager@0\.25\.0, where this invocation's v1 is context-manager@0\.25\.1: the tag's contents changed between two installs/,
      'once it has to install, the install it gets differs from the kept versions it reported');
    const [file] = readdirSync(join(dir, 'releases'));
    writeFileSync(join(dir, 'releases', file), JSON.stringify({ versions: B, facts: { H1: { window: 'from B' } } }));
    for (const config of ['H1', 'H3']) {
      assert.throws(() => one.facts('v1', config, factsOf('from A'), reported), /v1's kept facts \(.*\) name context-manager@0\.25\.1, where this invocation's v1 is context-manager@0\.25\.0/,
        `with another install's write landed last, the first invocation's ${config} checkpoint isn't keyed on, or given, facts from B`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
