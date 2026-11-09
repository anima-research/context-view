// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCandidate, readPacks } from '../lib/install.ts';
import { sourceHash } from '../lib/strategies/lane.ts';

const npm = (cwd, ...args) => {
  const r = spawnSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const pack = (at, name, version, dependencies = {}, peerDependencies = {}) => {
  const dir = join(at, `src-${name.replace(/\W/g, '-')}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies, peerDependencies }));
  return join(at, npm(dir, 'pack', '--pack-destination', at).trim().split('\n').at(-1));
};

test('R9: an overlay is laid over a copy of the checkout and named by what was installed, a work directory inside the checkout is left out, and a pack of the host or of another package is refused', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const root = join(at, 'host');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1' }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    npm(root, 'install');
    mkdirSync(join(root, 'work'));
    writeFileSync(join(root, 'work', 'big'), 'scratch');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    const dir = join(root, 'work', 'candidate');
    const installed = installCandidate({ root, packs, dir, leaveOut: [join(root, 'work')], npmCi: (cwd) => npm(cwd, 'ci') });
    assert.equal(installed.installDir, dir);
    assert.equal(JSON.parse(readFileSync(join(dir, 'node_modules', '@animalabs', 'context-manager', 'package.json'), 'utf-8')).version, '9.9.9');
    assert.equal(installed.versions['@animalabs/context-manager'].startsWith('9.9.9'), true);
    assert.equal(existsSync(join(dir, 'work')), false, 'a work directory inside the checkout is left out of the copy');
    assert.equal(readFileSync(join(dir, 'src', 'index.ts'), 'utf-8'), 'export {};\n', 'and its source is copied');
    assert.throws(() => readPacks([pack(at, '@animalabs/connectome-host', '9.9.9')]), /is connectome-host, which --host is: give --host the host change's checkout/);
    assert.throws(() => readPacks([pack(at, 'left-pad', '1.0.0')]), /is left-pad; overlay one of/);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('an overlay candidate names the host\'s source as the checkout\'s own, wherever it\'s installed, though npm writes the pack\'s path into the copy\'s package.json', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1' }));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    npm(root, 'install');
    const packs = readPacks([pack(join(at, 'packs'), '@animalabs/context-manager', '9.9.9')]);
    const named = [join(at, 'candidate'), join(at, 'a', 'b', 'candidate')].map((dir) => installCandidate({ root, packs, dir, npmCi: (cwd) => npm(cwd, 'ci') }).versions['@animalabs/connectome-host']);
    assert.deepEqual(named, [`0.0.1 (source ${sourceHash(root).slice(0, 12)})`, `0.0.1 (source ${sourceHash(root).slice(0, 12)})`]);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('R9: an overlay that leaves another copy of its package in the install is refused, naming the copy', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const old = pack(at, '@animalabs/context-manager', '1.0.0');
    const holder = pack(at, 'holds-old', '1.0.0', { '@animalabs/context-manager': `file:${old}` });
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1', dependencies: { '@animalabs/context-manager': `file:${old}`, 'holds-old': `file:${holder}` } }));
    npm(root, 'install');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    assert.throws(() => installCandidate({ root, packs, dir: join(at, 'candidate'), npmCi: (cwd) => npm(cwd, 'ci') }), /didn't replace every copy of @animalabs\/context-manager: .*node_modules\/holds-old\/node_modules\/@animalabs\/context-manager/);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('a forced package\'s pack replaces every copy, where a dependency\'s range and a peer range in the host\'s tree refuse it, through npm\'s overrides, with no registry; one the host doesn\'t depend on is refused', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  const registry = process.env.npm_config_registry;
  process.env.npm_config_registry = 'http://127.0.0.1:9/';
  try {
    const old = pack(at, '@animalabs/context-manager', '1.0.0');
    const ranged = pack(at, 'holds-range', '1.0.0', { '@animalabs/context-manager': '^1.0.0' });
    const peer = pack(at, 'holds-peer', '1.0.0', {}, { '@animalabs/context-manager': '^1.0.0' });
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1',
      dependencies: { '@animalabs/context-manager': `file:${old}`, 'holds-range': `file:${ranged}`, 'holds-peer': `file:${peer}` } }));
    npm(root, 'install');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    const dir = join(at, 'candidate');
    installCandidate({ root, packs, dir, npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/context-manager'] });
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages;
    const copies = Object.keys(lock).filter((k) => k.endsWith('node_modules/@animalabs/context-manager'));
    assert.deepEqual(copies, ['node_modules/@animalabs/context-manager']);
    assert.equal(lock[copies[0]].integrity, packs[0].integrity);
    const membrane = readPacks([pack(at, '@animalabs/membrane', '9.9.9')]);
    assert.throws(() => installCandidate({ root, packs: membrane, dir: join(at, 'other'), npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/membrane'] }),
      /forced package @animalabs\/membrane isn't among the dependencies of the host's package\.json/);
    assert.throws(() => installCandidate({ root, packs, dir: join(at, 'third'), npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/chronicle'] }),
      /forced package @animalabs\/chronicle has no pack among the overlays/);
    assert.throws(() => installCandidate({ root, packs: [], dir: join(at, 'fourth'), npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/context-manager'] }),
      /forced package @animalabs\/context-manager has no pack to lay over the host/);
  } finally {
    if (registry === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = registry;
    rmSync(at, { recursive: true, force: true });
  }
});

test('forcing a package keeps the rules of a nested override the host already gives it, setting only its own version to the pack', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const old = pack(at, '@animalabs/context-manager', '1.0.0');
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1',
      dependencies: { '@animalabs/context-manager': `file:${old}` }, overrides: { '@animalabs/context-manager': { '.': `file:${old}`, 'left-pad': '1.3.0' } } }));
    npm(root, 'install');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    const dir = join(at, 'candidate');
    installCandidate({ root, packs, dir, npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/context-manager'] });
    const given = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    assert.deepEqual(given.overrides, { '@animalabs/context-manager': { '.': '$@animalabs/context-manager', 'left-pad': '1.3.0' } });
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages;
    assert.equal(lock['node_modules/@animalabs/context-manager'].integrity, packs[0].integrity);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('where the host\'s ranges already admit the pack, forcing it installs the same tree as laying it over plainly', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const old = pack(at, '@animalabs/context-manager', '1.0.0');
    const holder = pack(at, 'holds-any', '1.0.0', { '@animalabs/context-manager': '*' });
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1', dependencies: { '@animalabs/context-manager': `file:${old}`, 'holds-any': `file:${holder}` } }));
    npm(root, 'install');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    const lockOf = (dir) => { const p = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages; delete p['']; return p; };
    installCandidate({ root, packs, dir: join(at, 'plain'), npmCi: (cwd) => npm(cwd, 'ci') });
    installCandidate({ root, packs, dir: join(at, 'forced'), npmCi: (cwd) => npm(cwd, 'ci'), forced: ['@animalabs/context-manager'] });
    assert.deepEqual(lockOf(join(at, 'forced')), lockOf(join(at, 'plain')));
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('a checkout file the copy can\'t read refuses the overlay run, rather than installing over an incomplete copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const dir = mkdtempSync(join(tmpdir(), 'copy-'));
  const unreadable = join(root, 'unreadable.txt');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(unreadable, 'x');
  chmodSync(unreadable, 0);
  try {
    assert.throws(() => accessSync(unreadable, constants.R_OK), 'this test needs a file its user can\'t read');
    const pack = { path: join(root, 'p.tgz'), name: '@animalabs/context-manager', integrity: 'sha512-x' };
    assert.throws(() => installCandidate({ root, packs: [pack], dir, npmCi: () => { throw new Error('the copy went through'); } }), (e) => /tar/.test(e.message) && !/the copy went through/.test(e.message));
  } finally {
    chmodSync(unreadable, 0o644);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
