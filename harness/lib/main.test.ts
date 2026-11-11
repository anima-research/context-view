import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HARNESS = join(import.meta.dirname, '..');
const run = (runTs: string, ...args: string[]) => spawnSync(process.execPath, [runTs, ...args, '--workdir', join(tmpdir(), 'never-made-whole-host')], { encoding: 'utf-8', timeout: 30_000 });

test('run.ts refuses an argument it doesn\'t take, naming it, before it clones or installs anything', () => {
  const r = run(join(HARNESS, 'run.ts'), '--host', tmpdir(), '--runs', 'H1/W1', '--shards', '1/2');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--shards isn't an option the harness takes; it takes .*--shard,/);
  assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
});

test('a harness whose options.json isn\'t {"valued": [names], "flags": [names]} refuses to run, naming the file and what\'s wrong', () => {
  const copy = mkdtempSync(join(tmpdir(), 'harness-options-'));
  try {
    cpSync(HARNESS, copy, { recursive: true, filter: (path) => !path.includes('node_modules') });
    writeFileSync(join(copy, 'options.json'), JSON.stringify({ valued: ['host'], flags: [], version: 1 }));
    const r = run(join(copy, 'run.ts'), '--host', tmpdir());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /options\.json isn't \{"valued": \[names\], "flags": \[names\]\}: it holds version/);
    assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
