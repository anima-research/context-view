import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtCodeOf, changedOf, closureOf, digestOf, driveOf, profiledHost, profiledReads, reachJoined, reachOf, reachPart, scriptLines, unreadDigest } from '../lib/reach.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reach');
const HARNESS_SIDE = join(FIX, 'harness-side');
const PKG_SRC = 'fixpkg/src/index.ts';

async function readIn(dir, entry, { until } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'reach-'));
  try {
    const host = profiledHost({ args: [join(dir, entry)], cwd: dir, logDir });
    await host.waitFor(/^ready$/m);
    const got = await host.read((path) => path.startsWith(`${realpathSync(dir)}/`));
    if (until) await host.waitFor(until);
    const after = await host.stop();
    return { ...got, spawned: after?.spawned ?? got.spawned };
  } finally { rmSync(logDir, { recursive: true, force: true }); }
}
const read = (entry, options) => readIn(FIX, entry, options);

const scratch = () => mkdtempSync(join(tmpdir(), 'reach-fix-'));
const changed = (lines, deletions = []) => ({ [PKG_SRC]: { lines, deletions } });
const reachIn = (reads, ch, file = PKG_SRC, root = FIX) => reachOf({ root, built: ['fixpkg/dist'], changed: ch, reads, harnessDir: HARNESS_SIDE }).files[file];

test('a planted function no caller calls reads "ran in no profiled host", the branch its caller takes reads "ran", and a comment holds no code', async () => {
  const r = reachIn([await read('host.mjs')], changed([3, 5, 8, 10, 11]));
  assert.equal(r.state, 'read');
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, [5, 10, 11]);
  assert.deepEqual(r.noCode, [8]);
});

test('a source file a host loaded that holds no code reads as read, its lines mapping to no code, whether run directly or built', async () => {
  const direct = reachOf({ root: FIX, changed: { 'typed/types-only.ts': { lines: [1, 2, 3, 4], deletions: [] } }, reads: [await read('host-typed.ts')], harnessDir: HARNESS_SIDE }).files['typed/types-only.ts'];
  assert.deepEqual([direct.state, direct.noCode, direct.unloaded], ['read', [1, 2, 3, 4], []]);
  const built = reachIn([await read('host-types.mjs')], { 'fixpkg/src/types-only.ts': { lines: [1, 2, 3, 4], deletions: [] } }, 'fixpkg/src/types-only.ts');
  assert.deepEqual([built.state, built.noCode, built.unloaded], ['read', [1, 2, 3, 4], []]);
});

test('a deletion with no code line on either side of it on the head is no-code, never not-reached, even beside a note', async () => {
  const got = await read('host-typed.ts');
  const ch = { 'typed/types-only.ts': { lines: [], deletions: [{ after: 2 }] } };
  const plain = reachOf({ root: FIX, changed: ch, reads: [got], harnessDir: HARNESS_SIDE }).files['typed/types-only.ts'];
  assert.deepEqual(plain.deletions, [{ after: 2, state: 'no-code', by: null }]);
  const noted = reachOf({ root: FIX, changed: ch, reads: [got, { unread: 'a host exited before its blocks were read' }], harnessDir: HARNESS_SIDE }).files['typed/types-only.ts'];
  assert.deepEqual(noted.deletions, [{ after: 2, state: 'no-code', by: null }]);
});

test('a changed file no host loaded and no map names puts its lines in a list of their own, as neither code nor no code', async () => {
  const r = reachIn([await read('app.ts')], { 'fixpkg/src/bare.ts': { lines: [1, 2], deletions: [] } }, 'fixpkg/src/bare.ts');
  assert.equal(r.state, 'not-loaded');
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.noCode, []);
  assert.deepEqual(r.unloaded, [1, 2]);
});

test('a changed file no host loaded reads its code lines from the built map on disk: code "ran in no profiled host", a comment no code', async () => {
  const r = reachIn([await read('app.ts')], changed([8, 9]));
  assert.equal(r.state, 'not-loaded');
  assert.deepEqual(r.notRan, [9]);
  assert.deepEqual(r.noCode, [8]);
  assert.deepEqual(r.unloaded, []);
});

test('a changed file no host loaded that reads "couldn\'t tell" still reads a comment as no code, through the built map', async () => {
  const r = reachIn([await read('app.ts'), { unread: 'a host exited before its blocks were read' }], changed([8, 9]));
  assert.equal(r.state, 'couldnt-tell');
  assert.deepEqual(r.noCode, [8]);
  assert.deepEqual(r.couldntTell, [9]);
});

test('a changed file a built script without a source map could have come from reads "couldn\'t tell", naming the script, its lines unloaded since no map gives them as code', async () => {
  const r = reachIn([await read('host.mjs')], { 'fixpkg/src/bare.ts': { lines: [2], deletions: [] } }, 'fixpkg/src/bare.ts');
  assert.equal(r.state, 'couldnt-tell');
  assert.deepEqual([r.couldntTell, r.unloaded], [[], [2]]);
  assert.match(r.reason, /fixpkg\/dist\/bare\.js.*no source map/);
});

test('a line run only in a child process the host started reads "couldn\'t tell", naming the child, never "ran in no profiled host"', async () => {
  const r = reachIn([await read('host-child.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason, /child\.mjs/);
});

test('a child running one of the harness\'s own files changes nothing', async () => {
  const r = reachIn([await read('host-harness-child.mjs')], changed([3, 10]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, [10]);
});

test('a child whose script isn\'t the harness\'s reads "couldn\'t tell" though a harness file is among its arguments', async () => {
  const r = reachIn([await read('host-child-harg.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason, /child\.mjs/);
});

test('a child counts as the harness\'s own only by its script, the argument after bun or node, so a flag there isn\'t skipped', () => {
  const server = join(HARNESS_SIDE, 'server.mjs');
  const child = join(FIX, 'child.mjs');
  const picked = (argv) => reachIn([{ scripts: [], spawned: [{ kind: 'child', argv }] }], changed([10]));
  const flagFirst = picked(['bun', '--preload', server, child]);
  assert.equal(flagFirst.state, 'couldnt-tell');
  assert.match(flagFirst.reason, /--preload/);
  const own = picked(['/usr/local/bin/bun', server]);
  assert.equal(own.state, 'not-loaded');
  assert.deepEqual(own.notRan, [10]);
});

test('a child the host starts after its blocks were read still counts, from the log read again at the stop', async () => {
  const r = reachIn([await read('host-late-child.mjs', { until: /^late$/m })], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
});

test('a .ts run directly: a function no caller calls reads "ran in no profiled host", and the lines its caller runs read "ran"', async () => {
  const r = reachIn([await read('app.ts')], { 'app.ts': { lines: [3, 5, 9, 10], deletions: [] } }, 'app.ts');
  assert.equal(r.state, 'read');
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, [5, 9, 10]);
});

test('a hunk that only deletes lines reads as reached when a code line next to it ran, and says it was judged by that neighbour', async () => {
  const r = reachIn([await read('host.mjs')], changed([], [{ after: 3 }, { after: 10 }]));
  assert.deepEqual(r.deletions, [{ after: 3, state: 'reached', by: 3 }, { after: 10, state: 'not-reached', by: 10 }]);
});

test('a deletion whose neighbour wasn\'t seen to run reads "couldn\'t tell" where an unprofiled process ran', async () => {
  const r = reachIn([await read('host-child.mjs')], changed([], [{ after: 3 }, { after: 10 }]));
  assert.deepEqual(r.deletions, [{ after: 3, state: 'reached', by: 3 }, { after: 10, state: 'couldnt-tell', by: 10 }]);
});

test('a file that reads "couldn\'t tell" or that no host loaded keeps its deletions', async () => {
  const mapless = reachIn([await read('host.mjs')], { 'fixpkg/src/bare.ts': { lines: [], deletions: [{ after: 1 }] } }, 'fixpkg/src/bare.ts');
  assert.deepEqual(mapless.deletions, [{ after: 1, state: 'unloaded', by: null }]);
  const app = await read('app.ts');
  assert.deepEqual(reachIn([app], changed([], [{ after: 10 }])).deletions, [{ after: 10, state: 'not-reached', by: 10 }]);
  assert.deepEqual(reachIn([app], { 'fixpkg/src/bare.ts': { lines: [], deletions: [{ after: 1 }] } }, 'fixpkg/src/bare.ts').deletions, [{ after: 1, state: 'unloaded', by: null }]);
});

test('a host whose blocks couldn\'t be read makes every changed line no read host ran "couldn\'t tell", naming it', async () => {
  const got = await read('host.mjs');
  const r = reachIn([got, { unread: 'the host exited before its blocks were read' }], changed([3, 10]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.couldntTell, [10]);
  assert.match(r.reason, /exited before its blocks were read/);
});

test('a host that exits by process.exit is read where it exits, so code its exit listeners run reads "ran"', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host-exit.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    const r = reachIn([await host.atExit()], changed([3, 5, 10]));
    if (host.child.exitCode === null) await new Promise((res) => host.child.once('exit', res));
    assert.equal(host.child.exitCode, 0);
    await host.stop();
    assert.equal(r.state, 'read');
    assert.deepEqual(r.ran, [3, 10]);
    assert.deepEqual(r.notRan, [5]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a host that exits other than by process.exit reads as unread where it exits, so its unseen lines read "couldn\'t tell"', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    await host.waitFor(/^ready$/m);
    await host.stop();
    const got = await host.atExit();
    assert.match(got.unread, /other than by process\.exit/);
    assert.deepEqual(reachIn([got], changed([3])).couldntTell, [3]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a debugger statement in the host\'s code doesn\'t pause it', { timeout: 30_000 }, async () => {
  const got = await read('host-debugger.mjs');
  assert.deepEqual(reachIn([got], changed([3])).ran, [3]);
});

test('a profiled drive that failed reads what its boots didn\'t run "couldn\'t tell", naming the failure, since its later steps never ran', async () => {
  const got = { boot: 1, ...await read('host.mjs') };
  const failed = reachIn(profiledReads({ d: { run: { ok: false, failure: { step: '2', reason: 'a step failed' }, reads: [got] } } }), changed([3, 10]));
  assert.deepEqual(failed.ran, [3]);
  assert.deepEqual(failed.notRan, []);
  assert.deepEqual(failed.couldntTell, [10]);
  assert.match(failed.reason, /its profiled drive failed at step 2: a step failed/);
  const whole = reachIn(profiledReads({ d: { run: { ok: true, failure: null, reads: [got] } } }), changed([3, 10]));
  assert.deepEqual(whole.notRan, [10]);
});

test('a profiled drive that couldn\'t run, or started no host, leaves one unread read saying so, and its drives say which boots were read', () => {
  assert.deepEqual(profiledReads({ couldnt: 'its store was gone' }), [{ unread: 'its profiled drive couldn\'t run: its store was gone' }]);
  assert.deepEqual(profiledReads({ d: { run: { ok: true, failure: null, reads: [] } } }), [{ unread: 'its profiled drive started no host' }]);
  const failed = profiledReads({ d: { run: { ok: false, failure: { step: '2', reason: 'x' }, reads: [{ boot: 1, scripts: [] }] } } });
  assert.deepEqual(driveOf(failed), [{ boot: 1, read: true }, { boot: null, read: false }]);
});

test('a host the inspector never attached to reads as unread rather than throwing', async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: ['--version'], cwd: FIX, logDir });
    const got = await host.read(() => true);
    await host.stop();
    assert.match(got.unread, /inspector/);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a changed line a worker the host started can run, and the host didn\'t, reads "couldn\'t tell", naming the worker', async () => {
  const r = reachIn([await read('host-worker.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason, /a worker the host started \(fixpkg\/dist\/worker\.js\)/);
});

test('a worker that loads the candidate by require() reads "couldn\'t tell", naming the worker', async () => {
  const r = reachIn([await read('host-req-worker.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason, /fixpkg\/dist\/req-worker\.js/);
});

test('a worker\'s import of a path known only as it runs makes unseen lines "couldn\'t tell", unless the harness names its target', async () => {
  const got = await read('host-script-worker.mjs');
  const unnamed = reachIn([got], changed([10]));
  assert.deepEqual(unnamed.couldntTell, [10]);
  assert.match(unnamed.reason, /only known as it runs/);
  const named = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([10]), reads: [got], harnessDir: HARNESS_SIDE, resolveDynamic: () => false }).files[PKG_SRC];
  assert.deepEqual(named.notRan, [10]);
});

test('each worker or child the host started whose code the read can\'t follow counts as a firing of the fallback, beside its distinct notes', () => {
  const spawned = [{ kind: 'worker', entry: './w.js', eval: false }, { kind: 'child', argv: ['bun', '/elsewhere/tool.mjs'] }];
  const { fallbacks, notes } = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([10]), reads: [{ scripts: [], spawned }, { scripts: [], spawned }], harnessDir: HARNESS_SIDE });
  assert.equal(fallbacks.fired, 4);
  assert.equal(fallbacks.notes.length, 2);
  assert.match(fallbacks.notes[0], /\.\/w\.js.*can't place/);
  assert.match(fallbacks.notes[1], /\/elsewhere\/tool\.mjs.*unprofiled/);
  assert.deepEqual(notes, fallbacks.notes);
});

test('a worker whose entry the harness can\'t place reads "couldn\'t tell", saying so', () => {
  const r = reachIn([{ scripts: [], spawned: [{ kind: 'worker', entry: './w.js', eval: false }] }], changed([10]));
  assert.equal(r.state, 'couldnt-tell');
  assert.match(r.reason, /\.\/w\.js.*can't place/);
});

test('a script whose map names a source outside the tree reads "couldn\'t tell", naming the script, and never "loaded by no profiled host"', async () => {
  for (const source of ['/home/runner/work/fixpkg/src/index.ts', 'webpack://fixpkg/src/index.ts', 'file:///home/runner/work/fixpkg/src/index.ts']) {
    const dir = scratch();
    try {
      cpSync(join(FIX, 'fixpkg'), join(dir, 'fixpkg'), { recursive: true });
      cpSync(join(FIX, 'host-index.mjs'), join(dir, 'host-index.mjs'));
      const mapFile = join(dir, 'fixpkg', 'dist', 'index.js.map');
      writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(readFileSync(mapFile, 'utf-8')), sources: [source] }));
      const r = reachIn([await readIn(dir, 'host-index.mjs')], changed([3, 5, 10]), PKG_SRC, dir);
      assert.equal(r.state, 'couldnt-tell', source);
      assert.deepEqual([r.couldntTell, r.unloaded], [[], [3, 5, 10]], source);
      assert.match(r.reason, /fixpkg\/dist\/index\.js/, source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a map naming its source by a file URL inside the tree, or a tree reached through a symlink, reads as the file it is', async () => {
  const dir = scratch();
  try {
    const real = join(dir, 'real');
    mkdirSync(real);
    cpSync(join(FIX, 'fixpkg'), join(real, 'fixpkg'), { recursive: true });
    cpSync(join(FIX, 'host-index.mjs'), join(real, 'host-index.mjs'));
    symlinkSync(real, join(dir, 'link'));
    const viaLink = reachIn([await readIn(join(dir, 'link'), 'host-index.mjs')], changed([3, 5]), PKG_SRC, join(dir, 'link'));
    assert.equal(viaLink.state, 'read');
    assert.deepEqual(viaLink.ran, [3]);
    assert.deepEqual(viaLink.notRan, [5]);
    const mapFile = join(real, 'fixpkg', 'dist', 'index.js.map');
    writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(readFileSync(mapFile, 'utf-8')), sources: [`file://${join(real, 'fixpkg', 'src', 'index.ts')}`] }));
    const byUrl = reachIn([await readIn(real, 'host-index.mjs')], changed([3, 5]), PKG_SRC, real);
    assert.equal(byUrl.state, 'read');
    assert.deepEqual(byUrl.ran, [3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const dataMap = (map) => `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;

test('a segment repeating the position before it counts when it falls mid-line, and is skipped only as a printed line\'s first', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'x.js');
    writeFileSync(path, 'ab\n');
    const midLine = scriptLines({ path, served: 'abcdefghij\n', blocks: [{ startOffset: 0, endOffset: 11, hasExecuted: false }, { startOffset: 5, endOffset: 10, hasExecuted: true }], inlineMap: dataMap({ version: 3, sources: ['x.js'], mappings: 'AAAA,KAAA' }) });
    assert.deepEqual([...midLine.files.get(path).ran], [1]);
    const lineStart = scriptLines({ path, served: 'abcde\nfghij\n', blocks: [{ startOffset: 0, endOffset: 12, hasExecuted: false }, { startOffset: 6, endOffset: 11, hasExecuted: true }], inlineMap: dataMap({ version: 3, sources: ['x.js'], mappings: 'AAAA;AAAA' }) });
    assert.deepEqual([...lineStart.files.get(path).ran], []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the closure scan follows require(), createRequire\'s function, module.require and a directory\'s index.js, and knows every builtin', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'lib'));
    for (const f of ['b.js', 'c.js', 'd.js', 'lib/index.js']) writeFileSync(join(dir, f), '');
    writeFileSync(join(dir, 'a.js'), [
      "import { createRequire } from 'node:module';",
      "import readline from 'readline';",
      "import { Database } from 'bun:sqlite';",
      "import { performance } from 'perf_hooks';",
      "import './lib';",
      'const load = createRequire(import.meta.url);',
      "load('./b.js');",
      "module.require('./c.js');",
      "require('./d.js');",
      '/ab/.exec(String(readline, Database, performance));',
    ].join('\n'));
    const c = closureOf(join(dir, 'a.js'));
    assert.deepEqual([...c.files].sort(), ['a.js', 'b.js', 'c.js', 'd.js', 'lib/index.js'].map((f) => join(dir, f)).sort());
    assert.deepEqual(c.unknown, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the closure scan reads a require() of a path known only as it runs, or a worker or child the code starts, as unknown', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'dyn.js'), 'const name = process.env.X;\nrequire(name);\n');
    writeFileSync(join(dir, 'w.js'), "import { Worker } from 'node:worker_threads';\nnew Worker(new URL('./x.js', import.meta.url));\n");
    writeFileSync(join(dir, 'p.js'), "import { spawn } from 'node:child_process';\nspawn('ls');\n");
    writeFileSync(join(dir, 'b.js'), "Bun.spawn(['ls']);\n");
    assert.match(closureOf(join(dir, 'dyn.js')).unknown.join('\n'), /only known as it runs/);
    assert.match(closureOf(join(dir, 'w.js')).unknown.join('\n'), /starts a worker/);
    assert.match(closureOf(join(dir, 'p.js')).unknown.join('\n'), /starts a child process/);
    assert.match(closureOf(join(dir, 'b.js')).unknown.join('\n'), /starts a child process/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a diff\'s changed lines are its added lines by the head\'s path, a deletion-only hunk the head line it follows, and a deleted file none', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@ export function f() {',
    '+  one();',
    '+  two();',
    '@@ -10 +12 @@',
    '-  old();',
    '+  next();',
    '@@ -20,3 +23,0 @@',
    '-  gone();',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,2 @@',
    '+export const b = 1;',
    '+export const c = 2;',
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-export const old = 1;',
    '',
  ].join('\n');
  assert.deepEqual(changedOf(diff), {
    'src/a.ts': { lines: [4, 5, 12], deletions: [{ after: 23 }] },
    'src/b.ts': { lines: [1, 2], deletions: [] },
  });
});

test('a digest keeps only the changed files, so a run\'s digests hold no file the change didn\'t touch', async () => {
  const got = await read('host.mjs');
  const tree = { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE };
  assert.ok(Object.keys(digestOf(got, tree).named).length > 1);
  assert.deepEqual(Object.keys(digestOf(got, { ...tree, only: [PKG_SRC] }).named), [PKG_SRC]);
});

test('shares\' digests and the built maps\' code lines, joined with no tree, read as the reads themselves do', async () => {
  const tree = { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE };
  const ch = { ...changed([3, 8, 9, 10]), 'fixpkg/src/bare.ts': { lines: [1, 2], deletions: [] } };
  const onDisk = builtCodeOf({ ...tree, changed: ch });
  const host = await read('host.mjs'), app = await read('app.ts');
  for (const reads of [[host, app], [app]]) {
    const joined = reachOf({ changed: ch, onDisk: JSON.parse(JSON.stringify(onDisk)), digests: reads.map((r) => JSON.parse(JSON.stringify(digestOf(r, { ...tree, only: Object.keys(ch) })))) });
    assert.deepEqual(joined, reachOf({ ...tree, changed: ch, reads }));
  }
  const missing = reachOf({ changed: ch, onDisk, digests: [digestOf(app, { ...tree, only: Object.keys(ch) }), unreadDigest('share 4 brought no reach home')] }).files[PKG_SRC];
  assert.deepEqual([missing.notRan, missing.couldntTell, missing.noCode], [[], [3, 9, 10], [8]]);
  assert.match(missing.reason, /share 4 brought no reach home/);
});

test('a view\'s reach.json joins its shares\' drives, and a share that brought none makes unseen lines couldn\'t tell; with none at all it couldn\'t be read', async () => {
  const tree = { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE };
  const ch = changed([3, 10]);
  const got = await read('host.mjs');
  const part = (run) => ({ change: 'fixpkg', changed: ch, onDisk: builtCodeOf({ ...tree, changed: ch }), drives: { [run]: [{ boot: 1, read: true }] }, digests: [digestOf(got, { ...tree, only: Object.keys(ch) })] });
  const both = reachJoined([part('H1/W1'), part('H1/W2')]);
  assert.deepEqual(Object.keys(both.drives), ['H1/W1', 'H1/W2']);
  assert.deepEqual([both.files[PKG_SRC].ran, both.files[PKG_SRC].notRan], [[3], [10]]);
  const short = reachJoined([part('H1/W1'), { missing: 'share 2 brought no reach home' }]);
  assert.deepEqual([short.files[PKG_SRC].ran, short.files[PKG_SRC].couldntTell], [[3], [10]]);
  assert.deepEqual(short.notes, ['share 2 brought no reach home']);
  assert.deepEqual(reachJoined([{ missing: 'share 1 brought no reach home' }, { missing: 'share 2 brought no reach home' }]), { couldnt: 'share 1 brought no reach home; share 2 brought no reach home' });
});

test('reach.json names the reach code that wrote each share\'s digests beside the code that joined them, so a join across two versions shows', () => {
  const h = createHash('sha256');
  for (const f of ['reach.mjs', 'reach-preload.cjs']) {
    const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', f));
    h.update(`${bytes.length}\n`).update(bytes);
  }
  const own = h.digest('hex');
  const part = reachPart({ root: FIX, built: ['fixpkg/dist'], change: 'fixpkg', changed: changed([3]), drives: {}, digests: [] });
  assert.equal(part.writer, own);
  assert.deepEqual(reachJoined([part, { ...part, writer: 'an older reach code' }]).code, { wrote: [own, 'an older reach code'], joined: own });
  assert.deepEqual(reachJoined([part, part]).code, { wrote: [own], joined: own });
});

test('a package installed more than once reads as one: a line that ran in any copy ran', async () => {
  const dir = scratch();
  try {
    for (const copy of ['a', 'b']) {
      mkdirSync(join(dir, copy));
      cpSync(join(FIX, 'fixpkg'), join(dir, copy, 'fixpkg'), { recursive: true });
    }
    writeFileSync(join(dir, 'host.mjs'), "import { sign } from './a/fixpkg/dist/index.js';\nimport { inChild } from './b/fixpkg/dist/index.js';\nconsole.log(sign(1), inChild(2));\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n");
    const got = await readIn(dir, 'host.mjs');
    const r = reachOf({ roots: [join(dir, 'a'), join(dir, 'b')], built: ['fixpkg/dist'], changed: changed([3, 10, 15]), reads: [got], harnessDir: HARNESS_SIDE }).files[PKG_SRC];
    assert.equal(r.state, 'read');
    assert.deepEqual(r.ran, [3, 15]);
    assert.deepEqual(r.notRan, [10]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
