import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOptions } from './common.ts';

const HARNESS = join(import.meta.dirname, '..');

const refusedRun = (runTs: string, ...args: string[]) => {
  const at = mkdtempSync(join(tmpdir(), 'refused-'));
  const host = join(at, 'host');
  const workdir = join(at, 'work');
  try {
    mkdirSync(host);
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host' }));
    const r = spawnSync(process.execPath, [runTs, '--host', host, ...args, '--workdir', workdir], { encoding: 'utf-8', timeout: 30_000 });
    return { ...r, workdirMade: existsSync(workdir) };
  } finally { rmSync(at, { recursive: true, force: true }); }
};

test('run.ts refuses an argument it doesn\'t take, naming it, before it makes its work directory or clones or installs anything', () => {
  const r = refusedRun(join(HARNESS, 'run.ts'), '--runs', 'H1/W1', '--shards', '1/2');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--shards isn't an option the harness takes; it takes .*--shard,/);
  assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
  assert.equal(r.workdirMade, false);
});

test('a harness whose options.json isn\'t {"valued": [names], "flags": [names]} refuses to run, naming the file and what\'s wrong, before it makes its work directory', () => {
  const copy = mkdtempSync(join(tmpdir(), 'harness-options-'));
  try {
    cpSync(HARNESS, copy, { recursive: true, filter: (path) => !path.includes('node_modules') });
    writeFileSync(join(copy, 'options.json'), JSON.stringify({ valued: ['host', 'workdir', 'runs'], flags: [], version: 1 }));
    const r = refusedRun(join(copy, 'run.ts'), '--runs', 'H1/W1');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /options\.json isn't \{"valued": \[names\], "flags": \[names\]\}: it holds version/);
    assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
    assert.equal(r.workdirMade, false);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test('options.json declares exactly the options main.ts reads, each as the kind main.ts reads it', () => {
  const source = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf-8');
  const bare = source.split('\n').filter((line) => /(?<![\w.$'])(opt|flag)\b(?!\()/.test(line));
  assert.deepEqual(bare, [source.split('\n').find((line) => /^\s*const \{ opt, flag, refused \} = parseArgs\(/.test(line))], 'main.ts names opt and flag only to call them, but where it takes them from parseArgs');
  const calls = [...source.matchAll(/(?<![\w.$])(opt|flag)\(([^,)]*)/g)];
  const unnamed = calls.filter(([, , arg]) => !/^'[a-z][a-z0-9-]*'$/.test(arg.trim())).map(([call]) => call);
  assert.deepEqual(unnamed, [], 'main.ts reads every option by a literal name');
  const read = { valued: new Set<string>(), flags: new Set<string>() };
  for (const [, kind, arg] of calls) read[kind === 'opt' ? 'valued' : 'flags'].add(arg.trim().slice(1, -1));
  const declared = readOptions(join(HARNESS, 'options.json'));
  const strays: string[] = [];
  for (const kind of ['valued', 'flags'] as const) {
    for (const name of declared[kind]) if (!read[kind].has(name)) strays.push(`--${name}: options.json declares it as ${kind}, and main.ts never reads it with ${kind === 'valued' ? 'opt' : 'flag'}`);
    for (const name of read[kind]) if (!declared[kind].includes(name)) strays.push(`--${name}: main.ts reads it with ${kind === 'valued' ? 'opt' : 'flag'}, and options.json doesn't declare it as ${kind}`);
  }
  assert.deepEqual(strays, []);
});
