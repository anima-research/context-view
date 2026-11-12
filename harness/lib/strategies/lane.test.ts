import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentsOf, keptKey, keptWhole, laneVersion, releaseOf, sourceHash, stackVersions, upgradeVariant } from './lane.ts';

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fxl-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test('N1: the lane version moves with every file under lib but its test-side ones, with run.ts and with stack.json less its seconds, and with nothing else', { timeout: 30_000 }, () => {
  const stack = (prefixTurns: Record<string, number>, seconds: object) => JSON.stringify({ release: 'v1', prefixTurns, seconds }, null, 2);
  const root = tree({
    'lib/strategies/driver.ts': 'driver',
    'lib/strategies/script.ts': 'script',
    'lib/common.ts': 'common',
    'lib/record.ts': 'record',
    'run.ts': 'run',
    'stack.json': stack({ H1: 49 }, { runs: { 'H1/W1': 3 } }),
    'package.json': '{}',
    'README.md': 'readme',
    'unit/x.unit.mjs': 'test',
    'lib/strategies/lane.test.ts': 'test',
    'lib/testing/helper.ts': 'helper',
    'lib/reach/testing/fixtures/host.mjs': 'fixture',
    'lib/test/a.ts': 'a',
    'lib/tests/b.ts': 'b',
    'lib/__tests__/c.ts': 'c',
    'lib/d.spec.ts': 'd',
    'lib/e_spec.ts': 'e',
    'lib/latest.ts': 'latest',
    'lib/special.ts': 'special',
  });
  try {
    const v = laneVersion(root);
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(laneVersion(root), v, 'the same files give the same version');
    for (const [rel, text] of [['README.md', 'readme 2'], ['stack.json', stack({ H1: 49 }, { runs: { 'H1/W1': 4, 'H1/W2': 9 } })], ['package.json', '{"x":1}'], ['unit/x.unit.mjs', 'test 2'], ['unit/y.unit.mjs', 'new'], ['lib/strategies/lane.test.ts', 'test 2'], ['lib/x_test.ts', 'new'], ['lib/testing/helper.ts', 'helper 2'], ['lib/reach/testing/fixtures/host.mjs', 'fixture 2'], ['lib/strategies/testing.ts', 'new'], ['lib/test/a.ts', 'a 2'], ['lib/tests/b.ts', 'b 2'], ['lib/__tests__/c.ts', 'c 2'], ['lib/d.spec.ts', 'd 2'], ['lib/e_spec.ts', 'e 2']]) {
      writeFileSync(join(root, rel), text);
      assert.equal(laneVersion(root), v, `${rel} is outside the lane`);
    }
    const moves: Array<[string, () => void, () => void]> = [
      ['a byte of a strategies file', () => writeFileSync(join(root, 'lib/strategies/script.ts'), 'scripT'), () => writeFileSync(join(root, 'lib/strategies/script.ts'), 'script')],
      ['lib/common.ts', () => writeFileSync(join(root, 'lib/common.ts'), 'common 2'), () => writeFileSync(join(root, 'lib/common.ts'), 'common')],
      ['lib/record.ts', () => writeFileSync(join(root, 'lib/record.ts'), 'record 2'), () => writeFileSync(join(root, 'lib/record.ts'), 'record')],
      ['run.ts', () => writeFileSync(join(root, 'run.ts'), 'run 2'), () => writeFileSync(join(root, 'run.ts'), 'run')],
      ['lib/latest.ts, a name holding test but no test-side mark', () => writeFileSync(join(root, 'lib/latest.ts'), 'latest 2'), () => writeFileSync(join(root, 'lib/latest.ts'), 'latest')],
      ['lib/special.ts, a name holding spec but no test-side mark', () => writeFileSync(join(root, 'lib/special.ts'), 'special 2'), () => writeFileSync(join(root, 'lib/special.ts'), 'special')],
      ['stack.json\'s prefixTurns', () => writeFileSync(join(root, 'stack.json'), stack({ H1: 50 }, { runs: {} })), () => writeFileSync(join(root, 'stack.json'), stack({ H1: 49 }, { runs: {} }))],
      ['a field added to stack.json', () => writeFileSync(join(root, 'stack.json'), JSON.stringify({ release: 'v1', prefixTurns: { H1: 49 }, seconds: {}, more: 1 })), () => writeFileSync(join(root, 'stack.json'), stack({ H1: 49 }, {}))],
      ['a file added under lib/strategies', () => writeFileSync(join(root, 'lib/strategies/new.mjs'), ''), () => unlinkSync(join(root, 'lib/strategies/new.mjs'))],
      ['a file in a directory under lib/strategies', () => { mkdirSync(join(root, 'lib/strategies/sub')); writeFileSync(join(root, 'lib/strategies/sub/x.mjs'), 'x'); }, () => rmSync(join(root, 'lib/strategies/sub'), { recursive: true })],
      ['a file removed from lib/strategies', () => unlinkSync(join(root, 'lib/strategies/driver.ts')), () => writeFileSync(join(root, 'lib/strategies/driver.ts'), 'driver')],
      ['the same bytes under another name', () => { unlinkSync(join(root, 'lib/strategies/driver.ts')); writeFileSync(join(root, 'lib/strategies/driver2.mjs'), 'driver'); }, () => { unlinkSync(join(root, 'lib/strategies/driver2.mjs')); writeFileSync(join(root, 'lib/strategies/driver.ts'), 'driver'); }],
      ['bytes moved from one file to the next', () => { writeFileSync(join(root, 'lib/strategies/driver.ts'), 'drivers'); writeFileSync(join(root, 'lib/strategies/script.ts'), 'cript'); }, () => { writeFileSync(join(root, 'lib/strategies/driver.ts'), 'driver'); writeFileSync(join(root, 'lib/strategies/script.ts'), 'script'); }],
    ];
    for (const [what, change, undo] of moves) {
      change();
      assert.notEqual(laneVersion(root), v, what);
      undo();
      assert.equal(laneVersion(root), v, `${what}, undone`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const REGISTRY = 'https://registry.example.test/';
const fromRegistry = (name: string, version: string) => ({ version, resolved: `${REGISTRY}${name}/-/${name.split('/')[1]}-${version}.tgz`, integrity: `sha512-registry-${version}` });
function install(packages: Record<string, { version: string; locked?: object }>) {
  const files: Record<string, string> = {};
  const lock: { name: string; lockfileVersion: number; packages: Record<string, object> } = { name: 'strategies-stack', lockfileVersion: 3, packages: { '': { name: 'strategies-stack' } } };
  for (const [path, { version, locked }] of Object.entries(packages)) {
    files[`install/${path}/package.json`] = JSON.stringify({ name: 'x', version });
    if (locked) lock.packages[path] = locked;
  }
  files['install/package-lock.json'] = JSON.stringify(lock);
  const root = tree(files);
  return { root, installDir: join(root, 'install'), hostDir: join(root, 'install/node_modules/@animalabs/connectome-host') };
}
const released = (overrides = {}) => ({
  'node_modules/@animalabs/connectome-host': { version: '0.15.0', locked: fromRegistry('@animalabs/connectome-host', '0.15.0') },
  'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: fromRegistry('@animalabs/agent-framework', '0.28.0') },
  'node_modules/@animalabs/connectome-host/node_modules/@animalabs/context-manager': { version: '0.23.1', locked: fromRegistry('@animalabs/context-manager', '0.23.1') },
  'node_modules/@animalabs/context-manager': { version: '0.22.0', locked: fromRegistry('@animalabs/context-manager', '0.22.0') },
  'node_modules/@animalabs/chronicle': { version: '0.4.2', locked: fromRegistry('@animalabs/chronicle', '0.4.2') },
  ...overrides,
});
const bunVersion = () => spawnSync('bun', ['--version'], { encoding: 'utf-8' }).stdout.trim();

test('N2: the key names the stack as the host resolves it, upward from its directory, by version where npm installed it from the registry, and bun', { timeout: 30_000 }, () => {
  const s = install(released());
  try {
    const v = stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY });
    const bun = bunVersion();
    assert.ok(bun, 'bun answers --version here');
    assert.deepEqual(v, {
      '@animalabs/connectome-host': '0.15.0',
      '@animalabs/agent-framework': '0.28.0',
      '@animalabs/context-manager': '0.23.1',
      '@animalabs/membrane': null,
      '@animalabs/chronicle': '0.4.2',
      bun,
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package installed from a pack or a git spec is named by its version and its content, as the lockfile records it', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const pack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-one-changed-line' } } }));
  const otherPack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-another-change' } } }));
  const sha = 'a'.repeat(40);
  const git = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: `git+ssh://git@github.com/x/connectome-host.git#${sha}` } } }));
  const url = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'https://example.test/builds/connectome-host-0.15.0.tgz', integrity: 'sha512-from-a-url' } } }));
  try {
    const name = (s: { hostDir: string; installDir: string }) => stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY })['@animalabs/connectome-host'] as string;
    const one = name(pack);
    assert.notEqual(one, '0.15.0', 'a pack at the release\'s version is not named as the release');
    assert.ok(one.startsWith('0.15.0') && one.includes('sha512-one-changed-line'), one);
    assert.notEqual(name(otherPack), one, 'two packs with different content have different names');
    assert.equal(name(pack), one, 'the same pack names the same way twice');
    const g = name(git);
    assert.ok(g.startsWith('0.15.0') && g.includes(sha), g);
    const u = name(url);
    assert.ok(u.startsWith('0.15.0') && u.includes('sha512-from-a-url'), `a tarball from a URL outside the registry is named by its integrity: ${u}`);
    assert.equal(stackVersions(pack.hostDir, { installDir: pack.installDir, registry: REGISTRY })['@animalabs/agent-framework'], '0.28.0');
  } finally { for (const s of [pack, otherPack, git, url]) rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package the install can\'t name by its content refuses, naming it and what to pass instead', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const linked = install(released({ [host]: { version: '0.15.0', locked: { resolved: '../checkout/connectome-host', link: true } } }));
  const unlisted = install(released({ 'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: null } }));
  const unlocked = install(released());
  unlinkSync(join(unlocked.installDir, 'package-lock.json'));
  try {
    assert.throws(() => stackVersions(unlocked.hostDir, { installDir: unlocked.installDir, registry: REGISTRY }), (e: Error) => /no lockfile at/.test(e.message));
    assert.throws(() => stackVersions(linked.hostDir, { installDir: linked.installDir, registry: REGISTRY }), (e: Error) => /@animalabs\/connectome-host/.test(e.message) && /linked/.test(e.message) && /npm pack/.test(e.message));
    assert.throws(() => stackVersions(unlisted.hostDir, { installDir: unlisted.installDir, registry: REGISTRY }), (e: Error) => /@animalabs\/agent-framework/.test(e.message) && /lockfile/.test(e.message));
  } finally { for (const s of [linked, unlisted, unlocked]) rmSync(s.root, { recursive: true, force: true }); }
});

test('a host checkout is named by its package.json and src/, wherever it sits, and by nothing else', () => {
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'source-hash-'));
    for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }
    return dir;
  };
  const base = { 'package.json': '{"version":"1.0.0"}', 'src/a.ts': 'a', 'src/sub/b.ts': 'b' };
  const h = sourceHash(tree(base));
  assert.equal(sourceHash(tree(base)), h, 'the same files in another directory');
  assert.equal(sourceHash(tree({ ...base, 'README.md': 'x', 'test/t.ts': 't' })), h, 'files outside src/ and package.json');
  assert.notEqual(sourceHash(tree({ ...base, 'src/a.ts': 'a2' })), h, 'a source file changed');
  assert.notEqual(sourceHash(tree({ ...base, 'src/c.ts': 'c' })), h, 'a source file added');
  assert.notEqual(sourceHash(tree({ ...base, 'package.json': '{"version":"1.0.1"}' })), h, 'package.json changed');
});

test('a host that is the checkout itself is named by its version and its source, so two checkouts of one version name different stacks', { timeout: 30_000 }, () => {
  const checkout = (source: string) => {
    const root = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host', version: '0.21.0' }), 'src/a.ts': source, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }) });
    return { root, host: stackVersions(root, { installDir: root, registry: REGISTRY })['@animalabs/connectome-host'] as string };
  };
  const a = checkout('a');
  const b = checkout('b');
  try {
    assert.match(a.host, /^0\.21\.0 \(source [0-9a-f]{12}\)$/);
    assert.notEqual(a.host, b.host);
    assert.equal(checkout('a').host, a.host, 'the same source names the same host');
  } finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});

test('a kept checkpoint is used only whole, with its record, its store, the answers its transcripts read and its seed', () => {
  const root = mkdtempSync(join(tmpdir(), 'kept-'));
  const make = (name: string, { record = sealed(), store = true, answers = true, dirs: made = ['store', 'answers'] }: { record?: string | null | ((dir: string) => string); store?: boolean; answers?: boolean; dirs?: string[] } = {}) => {
    const dir = join(root, `H1_W2-${name}`, 'H1_W2-k1');
    mkdirSync(dir, { recursive: true });
    for (const d of made) mkdirSync(join(dir, d), { recursive: true });
    if (store && made.includes('store')) writeFileSync(join(dir, 'store', 'x'), '');
    if (answers && made.includes('answers')) writeFileSync(join(dir, 'answers', 'r1.answer.json'), '[]');
    writeFileSync(join(dir, 'seed.json'), '{"primary":{"codec":0,"parts":[]}}');
    if (record !== null) writeFileSync(join(dir, 'checkpoint.json'), typeof record === 'function' ? record(dir) : record);
    return dir;
  };
  const sealed = (more = {}) => (dir: string) => JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1, ...(dirs(dir) ? { contents: contentsOf(dir, 1) } : {}), ...more });
  const dirs = (dir: string) => ['answers', 'store'].every((d) => { try { return readdirSync(join(dir, d)).length > 0; } catch { return false; } });
  try {
    assert.equal(keptWhole(make('whole')), true);
    assert.equal(keptWhole(make('no-answers', { answers: false })), false, 'one kept before its answers were, or that lost them, is written again');
    assert.equal(keptWhole(make('empty-store', { store: false })), false, 'a store that lost its contents');
    assert.equal(keptWhole(make('no-record', { record: null })), false);
    assert.equal(keptWhole(make('broken-record', { record: '{"from":' })), false, 'a record that doesn\'t parse');
    assert.equal(keptWhole(make('other-key', { record: sealed({ key: 'k2' }) })), false, 'a record whose key isn\'t its directory\'s');
    assert.equal(keptWhole(make('no-clock', { record: sealed({ clockEnd: undefined }) })), false, 'a record with no clockEnd, which would start the continuation at NaN');
    assert.equal(keptWhole(make('no-from', { record: sealed({ from: undefined }) })), false);
    assert.equal(keptWhole(make('no-answers-dir', { dirs: ['store'] })), false, 'no answers directory at all');
    assert.equal(keptWhole(make('no-store-dir', { dirs: ['answers'] })), false, 'no store directory at all');
    const unreadable = make('unreadable-store');
    rmSync(join(unreadable, 'store'), { recursive: true });
    writeFileSync(join(unreadable, 'store'), 'a file where the directory was');
    assert.equal(keptWhole(unreadable), false, 'a store that isn\'t a directory reads as not whole rather than throwing');
    const lost = make('lost-file');
    writeFileSync(join(lost, 'store', 'sessions.json'), '{}');
    assert.equal(keptWhole(lost), false, 'a file the sealed listing doesn\'t name, or a lost one, makes it not whole');
    const unseeded = make('no-seed');
    rmSync(join(unseeded, 'seed.json'));
    assert.equal(keptWhole(unseeded), false, 'one kept by a harness before seeds, or that lost its seed, is built again');
    const reseeded = make('other-seed');
    writeFileSync(join(reseeded, 'seed.json'), '{"primary":{"codec":1,"parts":[]}}');
    assert.equal(keptWhole(reseeded), false, 'nor does one whose seed changed since it was kept');
    const shrunk = make('shrunk');
    writeFileSync(join(shrunk, 'answers', 'r1.answer.json'), '');
    assert.equal(keptWhole(shrunk), false, 'nor does a file whose size changed');
    const sealOf = (dir: string) => JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1, contents: contentsOf(dir, 1) });
    const two = make('two-files', { record: null });
    writeFileSync(join(two, 'store', 'sessions.json'), '{"a":1}');
    writeFileSync(join(two, 'checkpoint.json'), sealOf(two));
    assert.equal(keptWhole(two), true, 'a checkpoint sealed with two store files is whole');
    rmSync(join(two, 'store', 'sessions.json'));
    assert.equal(keptWhole(two), false, 'and not once one of them is gone');
    const swapped = make('swapped', { record: null });
    writeFileSync(join(swapped, 'answers', 'r1.answer.json'), '["alpha"]');
    writeFileSync(join(swapped, 'checkpoint.json'), sealOf(swapped));
    writeFileSync(join(swapped, 'answers', 'r1.answer.json'), '["bravo"]');
    assert.equal(keptWhole(swapped), false, 'nor once a file changes at the same size');
    assert.equal(keptWhole(make('unsealed', { record: JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1 }) })), false, 'a record with no contents, as one kept before this, is rebuilt');
    assert.equal(keptWhole(make('moved-clock', { record: sealed({ clockEnd: 2 }) })), false, 'nor one whose clockEnd isn\'t the one it was sealed with, which would start the run from it at another instant');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a checkpoint\'s key holds the window its build takes from the base arm\'s candidate, where it takes one', () => {
  const parts = { lane: 'l', release: { '@animalabs/connectome-host': '0.9.0' }, from: 'H1b/prefix/from-0.9.0', configuration: { agent: { model: 'claude-opus-5-5' } }, steps: [{ id: '1.p0' }] };
  assert.equal(keptKey({ ...parts, window: 1_000_000 }), keptKey({ ...parts, window: 1_000_000 }));
  assert.notEqual(keptKey({ ...parts, window: 1_000_000 }), keptKey({ ...parts, window: 200_000 }), 'one built with another candidate\'s window isn\'t read');
  assert.notEqual(keptKey({ ...parts, window: 1_000_000 }), keptKey(parts), 'nor is one whose build took no window from a candidate');
});

test('run.ts refuses a run name it doesn\'t know, naming it, before it clones or installs anything', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--runs', 'H9/W99', '--workdir', join(tmpdir(), 'never-made-whole-host')], { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run H9\/W99; there are [^\n]*\bH1\/W1\b/);
  assert.doesNotMatch(r.stdout + r.stderr, /lane |release /, 'it stopped before naming the lane or cloning the release');
});

const runMjs = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), ...args, '--workdir', join(tmpdir(), 'never-made-whole-host')], { encoding: 'utf-8', timeout: 30_000 });

test('run.ts refuses to run without a --host that is connectome-host, before it clones or installs anything', () => {
  const none = runMjs();
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--host DIR names the connectome-host checkout to drive/);
  assert.doesNotMatch(none.stdout + none.stderr, /lane |release /, 'it stopped before naming the lane or cloning the release');
  const other = tree({ 'package.json': JSON.stringify({ name: '@animalabs/agent-framework' }) });
  try {
    const r = runMjs('--host', other);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--host \S+ is @animalabs\/agent-framework, not connectome-host/);
    assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('run.ts refuses a --drives that isn\'t a whole number of at least 1, before it clones or installs anything', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const parent = mkdtempSync(join(tmpdir(), 'drives-'));
  const workdir = join(parent, 'never-made');
  try {
    for (const [args, said] of [
      [['--drives'], /--drives needs a value/],
      [['--drives', '0'], /--drives takes a whole number of at least 1, not 0/],
      [['--drives', '-2'], /--drives takes a whole number of at least 1, not -2/],
      [['--drives', '2.5'], /--drives takes a whole number of at least 1, not 2\.5/],
      [['--drives', 'three'], /--drives takes a whole number of at least 1, not three/],
    ] satisfies Array<[string[], RegExp]>) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, ...args, '--workdir', workdir], { encoding: 'utf-8', timeout: 30_000 });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said);
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
      assert.equal(existsSync(workdir), false, 'it made no work directory');
    }
  } finally { for (const d of [host, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses what --reach, --overlay and --forced-package name before it clones or installs anything, an empty shard included', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const parent = mkdtempSync(join(tmpdir(), 'reach-'));
  const workdir = join(parent, 'never-made');
  mkdirSync(join(parent, 'package'));
  writeFileSync(join(parent, 'package', 'package.json'), JSON.stringify({ name: '@animalabs/membrane' }));
  const pack = join(parent, 'membrane.tgz');
  spawnSync('tar', ['-czf', pack, '-C', parent, 'package']);
  const diff = join(parent, 'r.diff');
  writeFileSync(diff, 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+x\n');
  const bad = join(parent, 'bad.diff');
  writeFileSync(bad, 'diff --git "a/src/\\q.ts" "b/src/\\q.ts"\n+++ "b/src/\\q.ts"\n@@ -0,0 +1 @@\n+x\n');
  try {
    for (const [args, said] of [
      [['--self-check', '--reach', 'r.diff', '--overlay', 'a.tgz,b.tgz'], /--reach with 2 overlays needs --reach-package, naming the overlay the diff is of/],
      [['--self-check', '--reach', 'r.diff', '--reach-package'], /--reach-package needs a value/],
      [['--reach-package', '@animalabs/agent-framework', '--overlay', 'a.tgz'], /--reach-package names the overlay --reach reads, so it needs --reach/],
      [['--self-check', '--reach', join(parent, 'no.diff'), '--overlay', pack], /--reach .*no\.diff can't be read/],
      [['--self-check', '--reach', diff, '--overlay', pack, '--reach-package', '@animalabs/agent-framework'], /--reach-package @animalabs\/agent-framework names none of the overlays: @animalabs\/membrane/],
      [['--self-check', '--reach', diff, '--overlay', pack, '--reach-package', '@animalabs/chronicle', '--shard', '500/500'], /--reach-package @animalabs\/chronicle names none of the overlays/],
      [['--self-check', '--reach', bad, '--overlay', pack], /isn't a diff the harness reads: a diff header names/],
      [['--forced-package'], /--forced-package needs a value/],
      [['--forced-package', ',', '--overlay', pack], /--forced-package names no package/],
      [['--forced-package', '@animalabs/connectome-host', '--overlay', pack], /--forced-package takes one of @animalabs\/agent-framework, @animalabs\/context-manager, @animalabs\/membrane, @animalabs\/chronicle, not @animalabs\/connectome-host/],
      [['--forced-package', 'left-pad', '--overlay', pack], /--forced-package takes one of .*, not left-pad/],
    ] satisfies Array<[string[], RegExp]>) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, ...args, '--workdir', workdir], { encoding: 'utf-8', timeout: 30_000 });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said);
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
      assert.equal(existsSync(workdir), false, 'it made no work directory');
    }
  } finally { for (const d of [host, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts balances its share by --drives, counting each run\'s seconds once for each drive', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const parent = mkdtempSync(join(tmpdir(), 'drives-'));
  const seconds = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'stack.json'), 'utf-8')).seconds.runs['H1/W1'];
  const about = (drives: string) => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, '--runs', 'H1/W1', '--shard', '1/2', '--drives', drives, '--workdir', join(parent, drives)], { encoding: 'utf-8', timeout: 30_000 });
    return /shard 1\/2: 1 of 1 runs, about (\d+) s by stack\.json's seconds(.*)$/m.exec(r.stdout);
  };
  try {
    const once = about('1'), thrice = about('3');
    assert.ok(once && thrice, 'both invocations named their share');
    assert.equal(once[2], '');
    assert.equal(thrice[2], ' for a job that drives each run 3 times');
    assert.ok(Math.abs(+thrice[1] - +once[1] - 2 * seconds) <= 1, `${thrice[1]} s is ${once[1]} s and two more drives of H1/W1's ${seconds} s`);
  } finally { for (const d of [host, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses an --against whose base arm wrote no run.json, before it clones or installs anything', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const against = mkdtempSync(join(tmpdir(), 'against-'));
  try {
    const r = runMjs('--host', host, '--against', against);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--against \S+ holds no run\.json: it isn't the --out of a base arm that finished/);
    assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
  } finally { for (const d of [host, against]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts ends a failure whose cause runs to many lines with the cause\'s own line, so a log\'s last line names it', () => {
  const host = tree({
    'package.json': JSON.stringify({ name: '@animalabs/connectome-host', repository: { url: `git+${join(tmpdir(), 'no-such-whole-host-release')}` } }),
    'package-lock.json': JSON.stringify({ name: '@animalabs/connectome-host', lockfileVersion: 3, packages: { '': { name: '@animalabs/connectome-host' } } }),
    'node_modules/.package-lock.json': '{}',
    'src/index.ts': 'export {};\n',
  });
  const work = mkdtempSync(join(tmpdir(), 'whole-host-work-'));
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, '--runs', 'H1/W9', '--workdir', work], { encoding: 'utf-8', timeout: 30_000 });
    assert.equal(r.status, 2);
    const lines = r.stderr.trim().split('\n');
    assert.ok(lines.length > 1, 'git\'s own output follows the cause');
    assert.match(lines[0], /installing v[\d.]+ failed: git clone .* exited 128$/);
    assert.equal(lines.at(-1), lines[0]);
  } finally { for (const d of [host, work]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses a value option given no value, before it clones or installs anything', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  try {
    const last = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--workdir', join(tmpdir(), 'never-made-whole-host'), ...args], { encoding: 'utf-8', timeout: 30_000 });
    for (const args of [['--against'], ['--against', '--runs', 'H1/W1'], ['--against', '']]) {
      const r = args.length === 1 ? last('--host', host, ...args) : runMjs('--host', host, ...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /--against needs a value/);
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
    }
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('run.ts refuses an --out or --workdir it can\'t list, a --runs naming a run twice, and a non-empty --out even for an empty share, before it clones or installs anything', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const file = join(host, 'package.json');
  const out = tree({ 'run.json': '{}' });
  try {
    for (const [args, said] of [
      [['--out', file], /--out \S+ can't be listed: ENOTDIR/],
      [['--runs', 'H1/W1,H1/W2,H1/W1'], /--runs names H1\/W1 more than once/],
      [['--runs', 'H1/W1', '--shard', '2/2', '--out', out], /--out \S+ isn't empty/],
    ] satisfies Array<[string[], RegExp]>) {
      const r = runMjs('--host', host, ...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said);
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
    }
    const w = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, '--workdir', file], { encoding: 'utf-8', timeout: 30_000 });
    assert.equal(w.status, 2);
    assert.match(w.stderr, /--workdir \S+ can't be listed: ENOTDIR/);
  } finally { for (const d of [host, out]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts leaves nothing behind for an empty share, making its temporary work directory only once it has runs to drive', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const tmp = mkdtempSync(join(tmpdir(), 'whole-host-tmp-'));
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'run.ts'), '--host', host, '--runs', 'H1/W1', '--shard', '2/2'], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, TMPDIR: tmp } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /shard 2\/2 holds none of H1\/W1/);
    assert.deepEqual(readdirSync(tmp), []);
  } finally { for (const d of [host, tmp]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses an --out that isn\'t empty, since an --out holds one invocation\'s evidence, before it clones or installs anything', () => {
  const host = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host' }) });
  const out = tree({ 'run.json': '{}' });
  try {
    const r = runMjs('--host', host, '--out', out);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--out \S+ isn't empty: an --out holds one invocation's evidence, so give it an empty or new directory/);
    assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
  } finally { for (const d of [host, out]) rmSync(d, { recursive: true, force: true }); }
});

test('a checkpoint\'s release is stack.json\'s, or the older release its upgrade variant names, which stack.json must list', () => {
  const stack = { release: 'v0.21.0', upgrades: ['v0.9.0', 'v0.23.0'] };
  assert.equal(releaseOf('H1/W2', stack), 'v0.21.0');
  assert.equal(releaseOf('H1b/prefix/from-0.9.0', stack), 'v0.9.0');
  assert.equal(releaseOf('H1b/prefix/from-0.23.0', stack), 'v0.23.0');
  assert.equal(upgradeVariant('v0.9.0'), 'from-0.9.0');
  assert.throws(() => releaseOf('H1b/prefix/from-0.8.1', stack), /v0\.8\.1.*stack\.json/);
});
