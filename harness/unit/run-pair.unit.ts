import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN = join(import.meta.dirname, '..', 'run.ts');
const WITNESS = join(import.meta.dirname, 'fixtures', 'poll-witness.ts');
const stack = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'stack.json'), 'utf-8'));

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pair-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const host = (extra: object = {}) => tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host', ...extra }) });
const installedHost = () => {
  const h = host();
  mkdirSync(join(h, 'node_modules'));
  mkdirSync(join(h, 'src'));
  writeFileSync(join(h, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(h, 'package-lock.json'), JSON.stringify({ name: '@animalabs/connectome-host', lockfileVersion: 3, packages: { '': { name: '@animalabs/connectome-host' } } }));
  return h;
};
const runMjs = (args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf-8', timeout: 30_000, ...opts });

test('run.ts refuses a --width that isn\'t a whole number of at least 1, before it clones or installs anything', () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'width-'));
  const workdir = join(parent, 'never-made');
  try {
    for (const [args, said] of [
      [['--width'], /--width needs a value/],
      [['--width', '0'], /--width takes a whole number of at least 1, not 0/],
      [['--width', '-3'], /--width takes a whole number of at least 1, not -3/],
      [['--width', '1.5'], /--width takes a whole number of at least 1, not 1\.5/],
      [['--width', 'four'], /--width takes a whole number of at least 1, not four/],
    ] satisfies Array<[string[], RegExp]>) {
      const r = runMjs(['--host', h, ...args, '--workdir', workdir]);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said);
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
      assert.equal(existsSync(workdir), false, 'it made no work directory');
    }
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses a --seconds file it can\'t read, or that isn\'t runs\' and checkpoints\' seconds, before it clones or installs anything', () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'seconds-'));
  const workdir = join(parent, 'never-made');
  const file = (name: string, text: string) => { const p = join(parent, name); writeFileSync(p, text); return p; };
  try {
    const shape = /--seconds \S+ isn't \{"runs": \{RUN: SECONDS\}, "checkpoints": \{CHECKPOINT: SECONDS\}\}, each SECONDS a number of at least 0: /;
    for (const [args, said] of [
      [['--seconds'], /--seconds needs a value/],
      [['--seconds', join(parent, 'absent.json')], /--seconds \S+absent\.json can't be read: ENOENT/],
      [['--seconds', file('text.json', 'not json')], /--seconds \S+text\.json isn't JSON: /],
      [['--seconds', file('list.json', '[]')], shape],
      [['--seconds', file('key.json', '{"run": {}}')], shape],
      [['--seconds', file('runs.json', '{"runs": []}')], shape],
      [['--seconds', file('negative.json', '{"runs": {"H1/W1": -1}}')], shape],
      [['--seconds', file('string.json', '{"checkpoints": {"H1/prefix": "6"}}')], shape],
      [['--seconds', file('null.json', '{"runs": {"H1/W1": null}}')], shape],
    ] satisfies Array<[string[], RegExp]>) {
      const r = runMjs(['--host', h, ...args, '--workdir', workdir]);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said, args.join(' '));
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
      assert.equal(existsSync(workdir), false, 'it made no work directory');
    }
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('--seconds sets a run\'s and a checkpoint\'s seconds for the share\'s plan, and stack.json\'s count for the rest', () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'seconds-'));
  const file = join(parent, 'seconds.json');
  const about = (args: string[]) => {
    const r = runMjs(['--host', h, ...args, '--workdir', join(parent, String(Math.random()).slice(2))]);
    return /shard 1\/2: 1 of 2 runs, about (\d+) s by (.*)$/m.exec(r.stdout);
  };
  try {
    writeFileSync(file, JSON.stringify({ runs: { 'H1/W1': 1000 } }));
    const given = about(['--runs', 'H1/W1,H1/W2', '--shard', '1/2', '--seconds', file]);
    assert.ok(given, 'the invocation named its share');
    assert.equal(+given[1], 1000, 'the share holding H1/W1 weighs it by the file');
    assert.equal(given[2], `${file}'s seconds over stack.json's`);
    const own = about(['--runs', 'H1/W1,H1/W2', '--shard', '1/2']);
    assert.equal(+own![1], Math.round(Math.max(stack.seconds.runs['H1/W1'], stack.seconds.runs['H1/W2'])), 'without the file, stack.json\'s');
    assert.equal(own![2], 'stack.json\'s seconds');
    writeFileSync(file, JSON.stringify({ runs: { 'H1/continuation': 100 }, checkpoints: { 'H1/prefix': 500 } }));
    const checkpoint = about(['--runs', 'H1/continuation,H1/W1', '--shard', '1/2', '--seconds', file]);
    assert.equal(+checkpoint![1], 600, 'H1/continuation\'s 100 s and its checkpoint\'s 500 s, both from the file');
    writeFileSync(file, JSON.stringify({ checkpoints: { 'H1/prefix': 500 } }));
    const mixed = about(['--runs', 'H1/continuation,H1/W1', '--shard', '1/2', '--seconds', file]);
    assert.equal(+mixed![1], Math.round(500 + stack.seconds.runs['H1/continuation']), 'the checkpoint from the file, the run from stack.json');
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('run.ts refuses what --pair can\'t take, and what only --pair takes, before it clones or installs anything', () => {
  const h = host();
  const other = tree({ 'package.json': JSON.stringify({ name: '@animalabs/agent-framework' }) });
  const parent = mkdtempSync(join(tmpdir(), 'pair-args-'));
  const workdir = join(parent, 'never-made');
  try {
    for (const [args, said] of [
      [['--pair', '--against', parent], /--pair compares its two arms in one invocation, so it takes no --against/],
      [['--pair', '--overlay', join(parent, 'x.tgz')], /--pair reads each arm's packs from --ready, so it takes no --overlay/],
      [['--pair', '--update-seconds'], /--update-seconds writes one arm's seconds, so it needs an invocation without --pair/],
      [['--ready', parent], /--ready says when each of --pair's arms is ready, so it needs --pair/],
      [['--host-head', h], /--host-head names --pair's head arm, so it needs --pair/],
      [['--pair', '--ready'], /--ready needs a value/],
      [['--pair', '--host-head'], /--host-head needs a value/],
    ] satisfies Array<[string[], RegExp]>) {
      const r = runMjs(['--host', h, ...args, '--workdir', workdir]);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, said, args.join(' '));
      assert.doesNotMatch(r.stdout + r.stderr, /lane |release /);
      assert.equal(existsSync(workdir), false, 'it made no work directory');
    }
  } finally { for (const d of [h, other, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('a pair that fails as a harness writes why to OUT/failed.json and no run.json, and exits 2', () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'pair-failed-'));
  const out = join(parent, 'out');
  try {
    const r = runMjs(['--pair', '--host', h, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out]);
    assert.equal(r.status, 2);
    const failed = JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8'));
    assert.match(failed.why, /^installing the base arm's candidate failed: there's no install at /);
    assert.match(r.stderr, /installing the base arm's candidate failed: there's no install at /);
    assert.equal(existsSync(join(out, 'before', 'run.json')), false);
    assert.equal(existsSync(join(out, 'after', 'run.json')), false);
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

const twoPollsAfter = (re: RegExp) => new RegExp(`${re.source}(?:.*\\n)*?poll-witness: absent .*\\n(?:.*\\n)*?poll-witness: absent .*\\n`);

function started(args: string[], witnessed: string) {
  const child = spawn(process.execPath, ['--import', WITNESS, RUN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, POLL_WITNESS: witnessed } });
  let stdout = '';
  let stderr = '';
  const waiters: Array<() => void> = [];
  child.stdout.on('data', (d) => { stdout += d; for (const w of [...waiters]) w(); });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
  const line = (re: RegExp) => new Promise<void>((res, rej) => {
    const check = () => { if (re.test(stdout)) { waiters.splice(waiters.indexOf(check), 1); res(); } };
    waiters.push(check);
    exited.then(() => rej(new Error(`it exited before printing ${re}: ${stdout}${stderr}`)));
    check();
  });
  return { child, line, exited, output: () => ({ stdout, stderr }) };
}

test('--ready: an arm\'s candidate is installed only once its file is there, written by rename', { timeout: 60_000 }, async () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'pair-ready-'));
  const ready = join(parent, 'ready');
  mkdirSync(ready);
  const out = join(parent, 'out');
  const p = started(['--pair', '--ready', ready, '--host', h, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], join(ready, 'base'));
  try {
    await p.line(twoPollsAfter(/waiting for the base arm's candidate: \S+\/ready\/base\n/));
    assert.equal(existsSync(join(out, 'failed.json')), false, 'nothing has failed while it waits, though the base host has no install to take');
    assert.equal(p.child.exitCode, null, 'it is still waiting');
    writeFileSync(join(ready, 'base.writing'), '');
    renameSync(join(ready, 'base.writing'), join(ready, 'base'));
    assert.equal(await p.exited, 2, 'the base arm\'s candidate, once ready, has no install');
    assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^installing the base arm's candidate failed: there's no install at /);
  } finally {
    p.child.kill('SIGKILL');
    for (const d of [h, parent]) rmSync(d, { recursive: true, force: true });
  }
});

test('--ready holds back no release install: a release that can\'t be installed fails the pair with neither arm ready', () => {
  const h = host({ repository: { url: `git+${join(tmpdir(), 'no-such-whole-host-release')}` } });
  const parent = mkdtempSync(join(tmpdir(), 'pair-release-'));
  const ready = join(parent, 'ready');
  mkdirSync(ready);
  const out = join(parent, 'out');
  try {
    const r = runMjs(['--pair', '--ready', ready, '--host', h, '--runs', 'H1/continuation', '--workdir', join(parent, 'work'), '--out', out]);
    assert.equal(r.status, 2);
    assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^installing v[\d.]+ failed: git clone /);
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('a run that couldn\'t run leaves no seconds in run.json, so the next plan falls back to stack.json\'s for it', { timeout: 60_000 }, () => {
  const h = installedHost();
  const parent = mkdtempSync(join(tmpdir(), 'seconds-couldnt-'));
  const out = join(parent, 'out');
  try {
    const r = runMjs(['--host', h, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], { timeout: 60_000 });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    const written = JSON.parse(readFileSync(join(out, 'run.json'), 'utf-8'));
    assert.equal(written.results[0].outcome, 'couldnt-run', 'the fixture\'s host has no recipe facts to read, so its run can\'t run');
    assert.deepEqual(written.seconds.runs, {});
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('--host-head is read once the head arm is ready: a checkout that isn\'t there at the start is waited for, as the setup clones it', { timeout: 60_000 }, async () => {
  const base = installedHost();
  const parent = mkdtempSync(join(tmpdir(), 'pair-head-'));
  const ready = join(parent, 'ready');
  mkdirSync(ready);
  const head = join(parent, 'head-not-yet');
  const out = join(parent, 'out');
  writeFileSync(join(ready, 'base'), '');
  const p = started(['--pair', '--ready', ready, '--host', base, '--host-head', head, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], join(ready, 'head'));
  try {
    await p.line(twoPollsAfter(/waiting for the head arm's candidate: \S+\/ready\/head\n/));
    assert.equal(existsSync(join(out, 'failed.json')), false, 'the head checkout isn\'t read while it waits');
    assert.equal(p.child.exitCode, null, 'it is still waiting');
    mkdirSync(head);
    writeFileSync(join(head, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host' }));
    writeFileSync(join(ready, 'head.writing'), '');
    renameSync(join(ready, 'head.writing'), join(ready, 'head'));
    assert.equal(await p.exited, 2, 'the head checkout, once ready, has no install');
    assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^installing the head arm's candidate failed: there's no install at \S+head-not-yet/);
  } finally {
    p.child.kill('SIGKILL');
    for (const d of [base, parent]) rmSync(d, { recursive: true, force: true });
  }
});

test('a --host-head that isn\'t connectome-host fails the pair once the head arm is ready, naming it in failed.json', { timeout: 60_000 }, () => {
  const base = installedHost();
  const other = tree({ 'package.json': JSON.stringify({ name: '@animalabs/agent-framework' }) });
  const parent = mkdtempSync(join(tmpdir(), 'pair-head-'));
  const out = join(parent, 'out');
  try {
    const r = runMjs(['--pair', '--host', base, '--host-head', other, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], { timeout: 60_000 });
    assert.equal(r.status, 2);
    assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^--host-head \S+ is @animalabs\/agent-framework, not connectome-host$/);
  } finally { for (const d of [base, other, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('a pair\'s two arms work in directories whose paths are the same length, since a request carries its run\'s directory and its size counts', { timeout: 60_000 }, () => {
  const base = installedHost();
  const parent = mkdtempSync(join(tmpdir(), 'pair-arms-'));
  const work = join(parent, 'work');
  try {
    runMjs(['--pair', '--host', base, '--runs', 'H1/W1', '--workdir', work, '--out', join(parent, 'out')], { timeout: 60_000 });
    const arms = readdirSync(work, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'children').map((d) => join(work, d.name));
    assert.equal(arms.length, 2, `one directory for each arm beside the children's: ${arms.join(', ')}`);
    assert.equal(arms[0].length, arms[1].length, arms.join(' and '));
  } finally { for (const d of [base, parent]) rmSync(d, { recursive: true, force: true }); }
});

const reachCase = (setup: (diff: string) => void, args: string[] = []) => {
  const base = installedHost();
  const parent = mkdtempSync(join(tmpdir(), 'pair-reach-'));
  const diff = join(parent, 'reach.diff');
  setup(diff);
  const out = join(parent, 'out');
  const r = runMjs([...args, '--host', base, '--runs', 'H1/W1', '--self-check', '--reach', diff, '--workdir', join(parent, 'work'), '--out', out], { timeout: 60_000 });
  return { r, out, done: () => { for (const d of [base, parent]) rmSync(d, { recursive: true, force: true }); } };
};
const HEAD_ARM = (out: string, pair: boolean) => (pair ? join(out, 'after') : out);

for (const pair of [true, false]) {
  const how = pair ? 'a pair\'s head arm' : 'a single arm';
  test(`--reach, ${how}: with the diff there, the arm takes it up and writes its reach files`, { timeout: 60_000 }, () => {
    const c = reachCase((d) => writeFileSync(d, 'diff --git a/src/index.ts b/src/index.ts\n+++ b/src/index.ts\n@@ -0,0 +1 @@\n+x\n'), pair ? ['--pair'] : []);
    try {
      assert.equal(existsSync(join(c.out, 'failed.json')), false, `${c.r.stdout}${c.r.stderr}`);
      assert.equal(existsSync(join(HEAD_ARM(c.out, pair), 'reach.json')), true);
      assert.equal(existsSync(join(HEAD_ARM(c.out, pair), 'reach-digests.json')), true);
    } finally { c.done(); }
  });
  test(`--reach, ${how}: with only FILE.err there, the arm goes on without reach, saying git's words, and writes no reach files`, { timeout: 60_000 }, () => {
    const c = reachCase((d) => writeFileSync(`${d}.err`, 'fatal: bad revision \'0123abc\'\n'), pair ? ['--pair'] : []);
    try {
      assert.equal(existsSync(join(c.out, 'failed.json')), false, `${c.r.stdout}${c.r.stderr}`);
      assert.equal(existsSync(join(HEAD_ARM(c.out, pair), 'run.json')), true);
      for (const f of ['reach.json', 'reach-digests.json']) assert.equal(existsSync(join(HEAD_ARM(c.out, pair), f)), false, f);
      assert.match(c.r.stdout, /no reach, since the change's diff couldn't be made: fatal: bad revision '0123abc'/);
    } finally { c.done(); }
  });
}

test('--reach, a pair\'s head arm: neither the diff nor its .err by the time the head is ready fails the pair, with failed.json', { timeout: 60_000 }, () => {
  const c = reachCase(() => {}, ['--pair']);
  try {
    assert.equal(c.r.status, 2);
    assert.match(JSON.parse(readFileSync(join(c.out, 'failed.json'), 'utf-8')).why, /^--reach \S+reach\.diff can't be read: .*, and there's no \S+reach\.diff\.err saying why it wasn't made/);
    assert.equal(existsSync(join(c.out, 'after', 'run.json')), false);
  } finally { c.done(); }
});

for (const pair of [false, true]) {
  test(`${pair ? 'a pair' : 'one arm'}: a write the invocation owes at its end that fails is a harness failure, with failed.json and no run.json for any arm`, { timeout: 60_000 }, () => {
    const h = installedHost();
    const parent = mkdtempSync(join(tmpdir(), 'end-writes-'));
    const summary = join(parent, 'step-summary');
    mkdirSync(summary);
    const out = join(parent, 'out');
    try {
      const r = runMjs([...(pair ? ['--pair'] : []), '--host', h, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], { timeout: 60_000, env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
      assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^writing the invocation's output failed: .*EISDIR/);
      for (const at of pair ? [join(out, 'before'), join(out, 'after')] : [out]) assert.equal(existsSync(join(at, 'run.json')), false, at);
    } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
  });
}

test('a pair stops at a head arm that fails while the base arm\'s ready file is still awaited, rather than wait for the base first', { timeout: 60_000 }, () => {
  const base = installedHost();
  const other = tree({ 'package.json': JSON.stringify({ name: '@animalabs/agent-framework' }) });
  const parent = mkdtempSync(join(tmpdir(), 'pair-early-'));
  const ready = join(parent, 'ready');
  mkdirSync(ready);
  writeFileSync(join(ready, 'head'), '');
  const out = join(parent, 'out');
  try {
    const r = runMjs(['--pair', '--ready', ready, '--host', base, '--host-head', other, '--runs', 'H1/W1', '--workdir', join(parent, 'work'), '--out', out], { timeout: 20_000 });
    assert.equal(r.status, 2, `${r.signal ?? ''}${r.stdout}${r.stderr}`);
    assert.match(JSON.parse(readFileSync(join(out, 'failed.json'), 'utf-8')).why, /^--host-head \S+ is @animalabs\/agent-framework, not connectome-host$/);
  } finally { for (const d of [base, other, parent]) rmSync(d, { recursive: true, force: true }); }
});

test('an --out inside --workdir is refused before anything is installed, since the work directory holds the drives\' scratch', () => {
  const h = host();
  const parent = mkdtempSync(join(tmpdir(), 'out-inside-'));
  try {
    for (const args of [[], ['--pair']]) {
      const r = runMjs([...args, '--host', h, '--runs', 'H1/W1', '--workdir', join(parent, 'w'), '--out', join(parent, 'w', 'head', 'runs', 'H1_W1', 'raw')]);
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--out \S+ is inside --workdir \S+, which holds the drives' scratch/);
      assert.equal(existsSync(join(parent, 'w', 'releases')), false);
    }
  } finally { for (const d of [h, parent]) rmSync(d, { recursive: true, force: true }); }
});
