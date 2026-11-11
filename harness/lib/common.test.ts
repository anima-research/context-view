import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnHost, parseArgs } from './common.ts';
import * as commonLib from './common.ts';

test('a host that can\'t be started exits, with why in its output, rather than throwing an error no one listens for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  try {
    const { child, out } = spawnHost({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: dir, cwd: dir, sockPath: join(dir, 'sock'), env: { PATH: join(dir, 'nothing-here') } });
    const [code] = await once(child, 'exit');
    assert.equal(code, 'ENOENT');
    assert.match(out.join(''), /couldn't start the host: spawn bun ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a command that fails shows the last 3,000 characters of its output, and keeps the whole output beside them', () => {
  const run = () => commonLib.sh('bash', ['-c', 'printf "START"; head -c 5000 /dev/zero | tr "\\0" x; printf "END"; exit 3']);
  let error: (Error & { full?: string }) | null = null;
  try { run(); } catch (e) { error = e as Error & { full?: string }; }
  assert.ok(error, 'the command fails');
  const shown = error.message.split('exited 3\n')[1];
  assert.equal(shown, `${'x'.repeat(2997)}END`, 'the shown output is its last 3,000 characters');
  assert.equal(error.full?.split('exited 3\n')[1], `START${'x'.repeat(5000)}END`, 'the whole output is kept beside it');
});

const OPTIONS = { valued: ['against', 'out', 'runs'], flags: ['pair', 'self-check'] };
const refusedOf = (...argv: string[]) => parseArgs(argv, OPTIONS).refused;

test('declared options are read by kind: a valued option\'s value, a flag\'s presence, and the default for one not given', () => {
  const { opt, flag, refused } = parseArgs(['--against', 'base', '--pair', '--out', 'o'], OPTIONS);
  assert.deepEqual(refused, []);
  assert.equal(opt('against'), 'base');
  assert.equal(opt('out'), 'o');
  assert.equal(opt('runs'), undefined);
  assert.equal(opt('runs', 'H1/W1'), 'H1/W1');
  assert.equal(flag('pair'), true);
  assert.equal(flag('self-check'), false);
  assert.deepEqual(parseArgs([], OPTIONS).refused, [], 'no arguments is nothing to refuse');
});

test('an argument the options don\'t declare is refused by name, with what the harness takes', () => {
  assert.deepEqual(refusedOf('--out', 'o', '--forced-package', 'x'), ['--forced-package isn\'t an option the harness takes; it takes --against, --out, --pair, --runs, --self-check', '"x" is no option\'s value, and an option is written --NAME']);
});

test('a one-dash option, a value given to a flag and a word that is no option\'s value are each refused', () => {
  assert.deepEqual(refusedOf('-runs', 'H1/W1'), ['"-runs" is no option\'s value, and an option is written --NAME', '"H1/W1" is no option\'s value, and an option is written --NAME']);
  assert.deepEqual(refusedOf('--self-check', 'yes'), ['--self-check takes no value, so "yes" is no option\'s value']);
  assert.deepEqual(refusedOf('base'), ['"base" is no option\'s value, and an option is written --NAME']);
});

test('a valued option given no value is refused: at the end, before another option, or given the empty string', () => {
  assert.deepEqual(refusedOf('--out', 'o', '--against'), ['--against needs a value']);
  assert.deepEqual(refusedOf('--against', '--runs', 'H1/W1'), ['--against needs a value'], 'a value that starts with -- is the next option, not the value');
  assert.equal(parseArgs(['--against', '--runs', 'H1/W1'], OPTIONS).opt('runs'), 'H1/W1', 'and that next option is read with its value');
  assert.deepEqual(refusedOf('--against', '', '--out', 'o'), ['--against needs a value']);
});

test('an option given twice is refused, a flag or a valued one', () => {
  assert.deepEqual(refusedOf('--runs', 'H1/W1', '--runs', 'H1/W2'), ['--runs is given twice']);
  assert.deepEqual(refusedOf('--pair', '--out', 'o', '--pair'), ['--pair is given twice']);
});

test('the --name=value form is refused, saying what to give instead for the name\'s kind', () => {
  assert.deepEqual(refusedOf('--out=o'), ['--out=o: the = form isn\'t taken, so give --out and its value as two arguments']);
  assert.deepEqual(refusedOf('--pair=true'), ['--pair=true: --pair takes no value']);
  assert.deepEqual(refusedOf('--shards=1/2'), ['--shards isn\'t an option the harness takes; it takes --against, --out, --pair, --runs, --self-check']);
});

test('opt reads only a declared valued option and flag only a declared flag, and each throws for any other name', () => {
  const { opt, flag } = parseArgs([], OPTIONS);
  assert.throws(() => opt('pair'), /options.json declares no valued option pair/);
  assert.throws(() => opt('width'), /options.json declares no valued option width/);
  assert.throws(() => flag('out'), /options.json declares no flag out/);
  assert.throws(() => flag('update-seconds'), /options.json declares no flag update-seconds/);
});

test('readOptions takes exactly {"valued": [names], "flags": [names]}, and refuses any other shape, naming what\'s wrong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'options-'));
  try {
    const file = join(dir, 'options.json');
    const read = (text: string) => { writeFileSync(file, text); return () => commonLib.readOptions(file); };
    const naming = (why: string) => (e: Error) => e.message.startsWith(`${file} `) && e.message.includes(why);
    assert.deepEqual(read(JSON.stringify(OPTIONS))(), OPTIONS);
    assert.throws(read('{'), naming('can\'t be read'));
    assert.throws(read('[]'), naming('it isn\'t an object'));
    assert.throws(read(JSON.stringify({ ...OPTIONS, version: 1 })), naming('it holds version'));
    assert.throws(read(JSON.stringify({ valued: OPTIONS.valued })), naming('flags isn\'t a list'));
    assert.throws(read(JSON.stringify({ valued: 'out', flags: [] })), naming('valued isn\'t a list'));
    assert.throws(read(JSON.stringify({ valued: ['out', 3], flags: [] })), naming('valued holds 3, which isn\'t a name'));
    assert.throws(read(JSON.stringify({ valued: [], flags: [''] })), naming('flags holds "", which isn\'t a name'));
    assert.throws(read(JSON.stringify({ valued: ['a=b'], flags: [] })), naming('valued holds "a=b", which isn\'t a name'));
    assert.throws(read(JSON.stringify({ valued: ['out', 'out'], flags: [] })), naming('valued names out twice'));
    assert.throws(read(JSON.stringify({ valued: ['out'], flags: ['out'] })), naming('out is in both lists'));
    const none = join(dir, 'none.json');
    assert.throws(() => commonLib.readOptions(none), (e: Error) => e.message.startsWith(`${none} can't be read`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
