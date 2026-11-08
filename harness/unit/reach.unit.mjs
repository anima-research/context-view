import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf, profiledHost, reachOf, scriptLines } from '../lib/reach.mjs';

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

test('a planted function no caller calls reads "ran in no run", the branch its caller takes reads "ran", and a comment holds no code', async () => {
  const r = reachIn([await read('host.mjs')], changed([3, 5, 8, 10, 11]));
  assert.equal(r.state, 'read');
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, [5, 10, 11]);
  assert.deepEqual(r.noCode, [8]);
});

test('a changed file no host loaded and no map names puts its lines in a list of their own, as neither code nor no code', async () => {
  const r = reachIn([await read('app.ts')], { 'fixpkg/src/bare.ts': { lines: [1, 2], deletions: [] } }, 'fixpkg/src/bare.ts');
  assert.equal(r.state, 'not-loaded');
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.noCode, []);
  assert.deepEqual(r.unloaded, [1, 2]);
});

test('a changed file no host loaded reads its code lines from the built map on disk: code "ran in no run", a comment no code', async () => {
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

test('a changed file a built script without a source map could have come from reads "couldn\'t tell", naming the script', async () => {
  const r = reachIn([await read('host.mjs')], { 'fixpkg/src/bare.ts': { lines: [2], deletions: [] } }, 'fixpkg/src/bare.ts');
  assert.equal(r.state, 'couldnt-tell');
  assert.match(r.reason, /fixpkg\/dist\/bare\.js.*no source map/);
});

test('a line run only in a child process the host started reads "couldn\'t tell", naming the child, never "ran in no run"', async () => {
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

test('a .ts run directly: a function no caller calls reads "ran in no run", and the lines its caller runs read "ran"', async () => {
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
  assert.deepEqual(mapless.deletions, [{ after: 1, state: 'couldnt-tell', by: null }]);
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

test('a worker whose entry the harness can\'t place reads "couldn\'t tell", saying so', () => {
  const r = reachIn([{ scripts: [], spawned: [{ kind: 'worker', entry: './w.js', eval: false }] }], changed([10]));
  assert.equal(r.state, 'couldnt-tell');
  assert.match(r.reason, /\.\/w\.js.*can't place/);
});

test('a script whose map names a source outside the tree reads "couldn\'t tell", naming the script, and never "loaded by no run"', async () => {
  for (const source of ['/home/runner/work/fixpkg/src/index.ts', 'webpack://fixpkg/src/index.ts', 'file:///home/runner/work/fixpkg/src/index.ts']) {
    const dir = scratch();
    try {
      cpSync(join(FIX, 'fixpkg'), join(dir, 'fixpkg'), { recursive: true });
      cpSync(join(FIX, 'host-index.mjs'), join(dir, 'host-index.mjs'));
      const mapFile = join(dir, 'fixpkg', 'dist', 'index.js.map');
      writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(readFileSync(mapFile, 'utf-8')), sources: [source] }));
      const r = reachIn([await readIn(dir, 'host-index.mjs')], changed([3, 5, 10]), PKG_SRC, dir);
      assert.equal(r.state, 'couldnt-tell', source);
      assert.deepEqual(r.couldntTell, [3, 5, 10], source);
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
