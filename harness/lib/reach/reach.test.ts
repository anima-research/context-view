import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtCodeOf, changedOf, closureOf, decodeMappings, digestOf, digestsOf, driveOf, innermostRan, inspectorClient, packRoots, profiledHost, profiledReads, reachAttach, reachJoined, reachLaunch, reachOf, reachPackOf, reachPart, scriptLines, segmentAt, splitBuilds, unreadDigest } from './reach.ts';
import type { ProfiledDrive, Read, Script, Spawned } from './reach.ts';
import type { ChangedLines, Reach } from '../shapes/interfaces.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'fixtures');
const HARNESS_SIDE = join(FIX, 'harness-side');
const HARNESS_LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_SRC = 'fixpkg/src/index.ts';

async function readIn(dir: string, entry: string, { until, env = {}, between }: { until?: RegExp; env?: Record<string, string | undefined>; between?: () => Promise<unknown> } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'reach-'));
  let host = null;
  try {
    host = profiledHost({ args: [join(dir, entry)], cwd: dir, logDir, env });
    await host.waitFor(/^ready$/m);
    const got = await host.read((path) => path.startsWith(`${realpathSync(dir)}/`));
    if (between) await between();
    if (until) await host.waitFor(until);
    const after = await host.stop();
    return { ...got, spawned: after?.spawned ?? got.spawned, spawnedAtRead: got.spawned, out: host.out.join('') };
  } finally {
    // A test that fails mid-read leaves no host behind to keep the test file's process alive.
    try { host?.child?.kill('SIGKILL'); } catch {}
    rmSync(logDir, { recursive: true, force: true });
  }
}
const read = (entry: string, options?: Parameters<typeof readIn>[2]) => readIn(FIX, entry, options);

const scratch = () => mkdtempSync(join(tmpdir(), 'reach-fix-'));
const changed = (lines: number[], deletions: Array<{ after: number }> = []) => ({ [PKG_SRC]: { lines, deletions } });
const reachIn = (reads: Read[], ch: ChangedLines, file = PKG_SRC, root = FIX) => reachOf({ root, built: ['fixpkg/dist'], changed: ch, reads, harnessDir: HARNESS_SIDE }).files[file];

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
  const r = reachIn([await read('host-bare.mjs')], { 'fixpkg/src/bare.ts': { lines: [2], deletions: [] } }, 'fixpkg/src/bare.ts');
  assert.equal(r.state, 'couldnt-tell');
  assert.deepEqual([r.couldntTell, r.unloaded], [[], [2]]);
  assert.match(r.reason!, /fixpkg\/dist\/bare\.js.*no source map/);
});

test('a line run only in a child process the host started reads "couldn\'t tell", naming the child, never "ran in no profiled host"', async () => {
  const r = reachIn([await read('host-child.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason!, /child\.mjs/);
});

test('a child started through node:child_process is logged as one started through Bun.spawn is', { timeout: 30_000 }, async () => {
  const r = reachIn([await read('host-child-cp.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason!, /child\.mjs/);
});

test('a spawn-log line that can\'t be read makes unseen lines couldn\'t tell, saying so, rather than stopping the read', { timeout: 30_000 }, async () => {
  const r = reachIn([await read('host-badlog.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason!, /a line of the spawn log couldn't be read/);
});

test('a source line with text past ASCII before it, or on lines above, which Bun serves escaped, reads as the code it is', { timeout: 30_000 }, async () => {
  const r = reachIn([await read('host-unicode.ts')], { 'host-unicode.ts': { lines: [3, 6], deletions: [] } }, 'host-unicode.ts');
  assert.deepEqual([r.ran, r.notRan], [[6], [3]]);
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
  assert.match(r.reason!, /child\.mjs/);
});

test('a child counts as the harness\'s own only by its script, the argument after bun or node, so a flag there isn\'t skipped', () => {
  const server = join(HARNESS_SIDE, 'server.mjs');
  const child = join(FIX, 'child.mjs');
  const picked = (argv: string[]) => reachIn([{ scripts: [], spawned: [{ kind: 'child', argv }] }], changed([10]));
  const flagFirst = picked(['bun', '--preload', server, child]);
  assert.equal(flagFirst.state, 'couldnt-tell');
  assert.match(flagFirst.reason!, /--preload/);
  const own = picked(['/usr/local/bin/bun', server]);
  assert.equal(own.state, 'not-loaded');
  assert.deepEqual(own.notRan, [10]);
});

test('a child the host starts after its blocks were read still counts, from the log read again at the stop', { timeout: 30_000 }, async () => {
  const dir = scratch();
  const trigger = join(dir, 'go');
  let readFirst = null;
  try {
    const got = await read('host-late-child.mjs', { until: /^late$/m, env: { REACH_LATE_TRIGGER: trigger }, between: async () => { writeFileSync(trigger, ''); } });
    readFirst = got;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(readFirst.spawnedAtRead, [], 'the child started after the read');
  assert.equal(readFirst.spawned.filter((x) => x.kind === 'child').length, 1);
  const r = reachIn([readFirst], changed([3, 10, 15]));
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

test('a map-less built script a host loaded makes every unseen line couldn\'t tell, a loaded file\'s included, since it may hold a copy of any line\'s code', async () => {
  const r = reachIn([await read('host-bare.mjs')], changed([3, 5, 10]));
  assert.deepEqual([r.state, r.ran, r.notRan, r.couldntTell], ['read', [3], [], [5, 10]]);
  assert.match(r.reason!, /^fixpkg\/dist\/bare\.js ran with no source map, so it may hold a copy of any changed file's code$/);
  assert.deepEqual(reachIn([await read('host.mjs')], changed([3, 5, 10])).notRan, [5, 10]);
});

test('a file that reads "couldn\'t tell" or that no host loaded keeps its deletions', async () => {
  const mapless = reachIn([await read('host-bare.mjs')], { 'fixpkg/src/bare.ts': { lines: [], deletions: [{ after: 1 }] } }, 'fixpkg/src/bare.ts');
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
  assert.match(r.reason!, /exited before its blocks were read/);
});

test('a host that exits by process.exit is read where it exits, so code its exit listeners run reads "ran"', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host-exit.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    const r = reachIn([await host.atExit()], changed([3, 5, 10]));
    if (host.child!.exitCode === null) await new Promise((res) => host.child!.once('exit', res));
    assert.equal(host.child!.exitCode, 0);
    await host.stop();
    assert.equal(r.state, 'read');
    assert.deepEqual(r.ran, [3, 10]);
    assert.deepEqual(r.notRan, [5]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a debugger statement the host runs before it exits isn\'t read as its exit: the read is still taken where it exits', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host-debugger-exit.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    const r = reachIn([await host.atExit()], changed([3, 5, 10]));
    if (host.child!.exitCode === null) await new Promise((res) => host.child!.once('exit', res));
    assert.equal(host.child!.exitCode, 0);
    await host.stop();
    assert.equal(r.state, 'read');
    assert.deepEqual(r.ran, [3, 10]);
    assert.deepEqual(r.notRan, [5]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a host that ends other than by process.exit or process.reallyExit, as by a signal, reads as unread where it exits, so its unseen lines read "couldn\'t tell"', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    await host.waitFor(/^ready$/m);
    await host.stop();
    const got = await host.atExit();
    assert.match(got.unread!, /didn't exit by process\.exit or process\.reallyExit, or its Bun didn't pause there, so what it ran couldn't be read$/);
    assert.deepEqual(reachIn([got], changed([3])).couldntTell, [3]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a debugger statement in the host\'s code doesn\'t hold it: the host runs on past it', { timeout: 30_000 }, async () => {
  const got = await read('host-debugger.mjs');
  assert.deepEqual(reachIn([got], changed([3])).ran, [3]);
});

test('a profiled drive that failed reads what its boots didn\'t run "couldn\'t tell", naming the failure, since its later steps never ran', async () => {
  const got = { boot: 1, ...await read('host.mjs') };
  const failed = reachIn(profiledReads({ d: { run: { ok: false, failure: { step: '2', reason: 'a step failed' }, reads: [got] } } } as ProfiledDrive), changed([3, 10]));
  assert.deepEqual(failed.ran, [3]);
  assert.deepEqual(failed.notRan, []);
  assert.deepEqual(failed.couldntTell, [10]);
  assert.match(failed.reason!, /its profiled drive failed at step 2: a step failed/);
  const whole = reachIn(profiledReads({ d: { run: { ok: true, failure: null, reads: [got] } } } as ProfiledDrive), changed([3, 10]));
  assert.deepEqual(whole.notRan, [10]);
});

test('a profiled drive that couldn\'t run, or started no host, leaves one unread read saying so, and its drives say which boots were read', () => {
  assert.deepEqual(profiledReads({ couldnt: 'its store was gone' }), [{ unread: 'its profiled drive couldn\'t run: its store was gone' }]);
  assert.deepEqual(profiledReads({ d: { run: { ok: true, failure: null, reads: [] } } } as ProfiledDrive), [{ unread: 'its profiled drive started no host' }]);
  const failed = profiledReads({ d: { run: { ok: false, failure: { step: '2', reason: 'x' }, reads: [{ boot: 1, scripts: [] }] } } } as ProfiledDrive);
  assert.deepEqual(driveOf(failed), [{ boot: 1, read: true }, { boot: null, read: false }]);
});

test('a reason that is empty is still a reason: a drive that couldn\'t run, a read and a script that are unread, each by its presence', () => {
  assert.deepEqual(profiledReads({ couldnt: '' }), [{ unread: 'its profiled drive couldn\'t run: ' }]);
  assert.deepEqual(driveOf([{ boot: 1, unread: '' }]), [{ boot: 1, read: false }]);
  assert.deepEqual(scriptLines({ path: '/x.js', unread: '' }), { unread: '/x.js: ' });
  const tree = { root: FIX, built: ['fixpkg/dist'], only: [PKG_SRC] };
  assert.deepEqual(digestOf({ unread: '', spawned: [] }, tree).notes, ['']);
  assert.deepEqual(digestsOf([{ boot: 2, unread: '', spawned: [] }], 'H1/W1', tree).map((d) => d.notes), [['H1/W1, boot 2: ']]);
});

test('a host the inspector never attached to reads as unread rather than throwing', async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: ['--version'], cwd: FIX, logDir });
    const got = await host.read(() => true);
    await host.stop();
    assert.equal(got.unread, 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read');
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a changed line a worker the host started can run, and the host didn\'t, reads "couldn\'t tell", naming the worker', async () => {
  const r = reachIn([await read('host-worker.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason!, /a worker the host started \(fixpkg\/dist\/worker\.js\)/);
});

test('a worker that loads the candidate by require() reads "couldn\'t tell", naming the worker', async () => {
  const r = reachIn([await read('host-req-worker.mjs')], changed([3, 10, 15]));
  assert.deepEqual(r.ran, [3]);
  assert.deepEqual(r.notRan, []);
  assert.deepEqual(r.couldntTell, [10, 15]);
  assert.match(r.reason!, /fixpkg\/dist\/req-worker\.js/);
});

test('a worker\'s import of a path known only as it runs makes unseen lines "couldn\'t tell", unless the harness names its target', async () => {
  const got = await read('host-script-worker.mjs');
  const unnamed = reachIn([got], changed([10]));
  assert.deepEqual(unnamed.couldntTell, [10]);
  assert.match(unnamed.reason!, /only known as it runs/);
  const named = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([10]), reads: [got], harnessDir: HARNESS_SIDE, resolveDynamic: () => false }).files[PKG_SRC];
  assert.deepEqual(named.notRan, [10]);
});

test('each worker or child the host started whose code the read can\'t follow counts as a firing of the fallback, beside its distinct notes', () => {
  const spawned: Spawned[] = [{ kind: 'worker', entry: './w.js', eval: false }, { kind: 'child', argv: ['bun', '/elsewhere/tool.mjs'] }];
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
  assert.match(r.reason!, /\.\/w\.js.*can't place/);
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
      assert.match(r.reason!, /fixpkg\/dist\/index\.js/, source);
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

const dataMap = (map: object) => `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;

test('a segment repeating the position before it counts when it falls mid-line, and is skipped only as a printed line\'s first', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'x.js');
    writeFileSync(path, 'ab\n');
    const midLine = scriptLines({ path, served: 'abcdefghij\n', blocks: [{ startOffset: 0, endOffset: 11, hasExecuted: false }, { startOffset: 5, endOffset: 10, hasExecuted: true }], inlineMap: dataMap({ version: 3, sources: ['x.js'], mappings: 'AAAA,KAAA' }) });
    assert.deepEqual([...midLine.files!.get(path)!.ran], [1]);
    const lineStart = scriptLines({ path, served: 'abcde\nfghij\n', blocks: [{ startOffset: 0, endOffset: 12, hasExecuted: false }, { startOffset: 6, endOffset: 11, hasExecuted: true }], inlineMap: dataMap({ version: 3, sources: ['x.js'], mappings: 'AAAA;AAAA' }) });
    assert.deepEqual([...lineStart.files!.get(path)!.ran], []);
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
    assert.match(closureOf(join(dir, 'w.js')).unknown.join("\n"), /may start a worker/);
    assert.match(closureOf(join(dir, 'p.js')).unknown.join('\n'), /starts a child process/);
    assert.match(closureOf(join(dir, 'b.js')).unknown.join('\n'), /starts a child process/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the closure scan follows a load written with a space before its parenthesis, and reads any mention of Worker as starting one', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'spaced.js'), "require ('./a.js');\nimport ('./b.js');\n");
    writeFileSync(join(dir, 'a.js'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'b.js'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'cjs.js'), "const worker_threads_1 = require('node:worker_threads');\nnew worker_threads_1.Worker('./x.js');\n");
    writeFileSync(join(dir, 'alias.js'), "const W = globalThis.Worker;\nnew W('./x.js');\n");
    const spaced = closureOf(join(dir, 'spaced.js'));
    assert.deepEqual([[...spaced.files].map((f) => f.split('/').pop()).sort(), spaced.unknown], [['a.js', 'b.js', 'spaced.js'], []]);
    assert.match(closureOf(join(dir, 'cjs.js')).unknown.join("\n"), /may start a worker/);
    assert.match(closureOf(join(dir, 'alias.js')).unknown.join("\n"), /may start a worker/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a worker whose closure the scan can\'t follow at several loads is one firing, naming each', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'w.js'), 'require(process.env.A);\nrequire(process.env.B);\n');
    const { fallbacks, notes } = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([10]), reads: [{ scripts: [], spawned: [{ kind: 'worker', entry: join(dir, 'w.js'), eval: false }] }], harnessDir: HARNESS_SIDE });
    assert.equal(fallbacks.fired, 1);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /process\.env\.A.*process\.env\.B/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a host that wasn\'t read still counts the workers and children it started as firings', () => {
  const spawned: Spawned[] = [{ kind: 'child', argv: ['bun', '/elsewhere/tool.mjs'] }];
  const { fallbacks, notes } = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([10]), reads: [{ unread: 'the host exited (9) other than by process.exit', spawned }], harnessDir: HARNESS_SIDE });
  assert.equal(fallbacks.fired, 1);
  assert.ok(notes.some((n) => /tool\.mjs/.test(n)));
});

test('a map\'s one-field segment ends the mapping before it, so code it marks unmapped maps to no source line', () => {
  const line = decodeMappings('AAAA,E,EAAE')[0];
  assert.equal(segmentAt(line, 1)?.[2], 0);
  assert.equal(segmentAt(line, 3), null);
  assert.equal(segmentAt(line, 5)?.[3], 2);
});

test('a script under a built directory reached through a symlink, with no map, is a map-less build', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'pkg', 'real-dist'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'real-dist', 'x.js'), 'export const x = 1;\n');
    symlinkSync(join(dir, 'pkg', 'real-dist'), join(dir, 'pkg', 'dist'));
    const d = digestOf({ scripts: [{ path: realpathSync(join(dir, 'pkg', 'real-dist', 'x.js')), served: '', blocks: [] } as unknown as Script], spawned: [] }, { root: join(dir, 'pkg'), built: ['dist'], only: ['src/x.ts'] });
    assert.deepEqual(d.maplessBuilt, ['real-dist/x.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a changed file built into more than one script is named, since reach reads each changed file\'s code from one', () => {
  const dir = scratch();
  try {
    cpSync(join(FIX, 'fixpkg'), join(dir, 'fixpkg'), { recursive: true });
    const dist = join(dir, 'fixpkg', 'dist');
    writeFileSync(join(dist, 'index.d.ts.map'), readFileSync(join(dist, 'index.js.map'), 'utf-8').replace('"file":"index.js"', '"file":"index.d.ts"'));
    writeFileSync(join(dist, 'index.d.ts'), 'export declare function sign(n: number): number;\n//# sourceMappingURL=index.d.ts.map\n');
    assert.deepEqual(splitBuilds({ root: dir, built: ['fixpkg/dist'], changed: changed([3]) }), {});
    writeFileSync(join(dist, 'index2.js'), readFileSync(join(dist, 'index.js'), 'utf-8').replace('index.js.map', 'index2.js.map'));
    writeFileSync(join(dist, 'index2.js.map'), readFileSync(join(dist, 'index.js.map'), 'utf-8').replace('"file":"index.js"', '"file":"index2.js"'));
    assert.deepEqual(splitBuilds({ root: dir, built: ['fixpkg/dist'], changed: changed([3]) }),
      { [PKG_SRC]: `${PKG_SRC} is built into more than one script (fixpkg/dist/index.js, fixpkg/dist/index2.js), and reach reads a changed file's code from the one a host loaded` });
    writeFileSync(join(dist, 'index3.js'), 'export const x = 1;\n//# sourceMappingURL=file://' + join(dist, 'index3.js.map') + '\n');
    writeFileSync(join(dist, 'index3.js.map'), readFileSync(join(dist, 'index.js.map'), 'utf-8').replace('"file":"index.js"', '"file":"index3.js"'));
    assert.match(splitBuilds({ root: dir, built: ['fixpkg/dist'], changed: changed([3]) })[PKG_SRC], /\(fixpkg\/dist\/index\.js, fixpkg\/dist\/index2\.js, fixpkg\/dist\/index3\.js\)/);
    writeFileSync(join(dist, 'broken.js'), 'export const y = 1;\n//# sourceMappingURL=broken.js.map\n');
    writeFileSync(join(dist, 'broken.js.map'), '{ not json');
    const other = { ...changed([3]), 'fixpkg/src/bare.ts': { lines: [1], deletions: [] } };
    const both = splitBuilds({ root: dir, built: ['fixpkg/dist'], changed: other });
    assert.match(both['fixpkg/src/bare.ts'], /^fixpkg\/dist\/broken\.js's source map couldn't be read, so a changed file built into it can't be told$/);
    assert.match(both[PKG_SRC], /built into more than one script/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the join refuses shares that don\'t agree on the change, or one with fewer digests than boots', () => {
  const part = (o = {}) => ({ change: 'c', writer: 'w', changed: { 'src/a.ts': { lines: [1], deletions: [] } }, onDisk: {},
    drives: { 'H1/W1': [{ boot: 1, read: true }] }, digests: [{ named: { 'src/a.ts': { code: [1], ran: [1] } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }], ...o });
  assert.doesNotThrow(() => reachJoined([part(), part({ drives: { 'H1/W2': [{ boot: 1, read: true }] } })]));
  assert.throws(() => reachJoined([part(), part({ changed: { 'src/b.ts': { lines: [1], deletions: [] } } })]), /the shares don't agree on the change's lines/);
  assert.throws(() => reachJoined([part(), part({ onDisk: { 'src/a.ts': [2] } })]), /the shares don't agree on the built maps' code lines/);
  assert.throws(() => reachJoined([part(), part({ change: 'd' })]), /the shares don't agree on what changed/);
  assert.throws(() => reachJoined([part({ digests: [] })]), /a share read 1 boot but brought 0 digests/);
});

test('an added line that begins "++ " is a line of its hunk, not a new file\'s header', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,0 +2,2 @@', '+++ x', '+y', ''].join('\n');
  assert.deepEqual(changedOf(diff), { 'src/a.ts': { lines: [2, 3], deletions: [] } });
});

test('an inspector that can\'t attach is named in the read, and the host waiting for it is stopped, marked as the harness\'s own kill before it dies', { timeout: 30_000 }, async () => {
  const dir = scratch();
  const child = spawn('sleep', ['60']);
  let marked = false;
  let markedAtExit = null;
  child.once('exit', () => { markedAtExit = marked; });
  try {
    const reach = reachAttach({ launch: { url: 'ws://127.0.0.1:9/none', logPath: join(dir, 'log.jsonl') }, child, wanted: () => true, killing: () => { marked = true; } });
    const got = await reach.atExit;
    assert.equal(got.unread, 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read');
    await new Promise<number | null | void>((res) => (child.exitCode !== null || child.signalCode !== null ? res() : child.once('exit', res)));
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(markedAtExit, true, 'the kill is marked before the host\'s exit is seen, so the driver doesn\'t name it signalled');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('a spawn the preload can\'t log still starts, and is a firing, so the lines it could run are couldn\'t tell', { timeout: 30_000 }, async () => {
  const got = await read('host-unlogged.mjs');
  assert.match(got.out, /^child exited 0$/m);
  assert.deepEqual(got.spawned, [{ kind: 'unlogged', count: 1 }]);
  const all = reachOf({ root: FIX, built: ['fixpkg/dist'], changed: changed([3, 10, 15]), reads: [got], harnessDir: HARNESS_SIDE });
  assert.equal(all.fallbacks.fired, 1);
  assert.deepEqual([all.files[PKG_SRC].ran, all.files[PKG_SRC].couldntTell], [[3], [10, 15]]);
  assert.match(all.files[PKG_SRC].reason!, /the preload couldn't log a worker or child the host started/);
});

test('a host read where it exits carries its count of spawns the preload couldn\'t log', { timeout: 30_000 }, async () => {
  const logDir = scratch();
  try {
    const host = profiledHost({ args: [join(FIX, 'host-unlogged-exit.mjs')], cwd: FIX, logDir, wanted: (path) => path.startsWith(`${FIX}/`) });
    const got = await host.atExit();
    await host.stop();
    assert.equal(got.unread, undefined);
    assert.match(host.out.join(''), /^child exited 0$/m);
    assert.deepEqual(got.spawned, [{ kind: 'unlogged', count: 1 }]);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a read that can\'t be digested becomes an unread digest naming why, so its run keeps its comparison', () => {
  const ds = digestsOf([{ scripts: null, spawned: [] } as unknown as Read], 'H1/W1', { root: FIX, built: ['fixpkg/dist'], only: [PKG_SRC] });
  assert.equal(ds.length, 1);
  assert.match(ds[0].notes[0], /^H1\/W1: its read couldn't be digested: /);
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

test('the block an offset is read by is the one a scan of every block chooses, the shortest and the first of equal ones, offsets asked in order or not', () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  for (let round = 0; round < 60; round++) {
    const blocks = Array.from({ length: 40 }, () => { const s = rnd(200); return { startOffset: s, endOffset: s + 1 + rnd(30), hasExecuted: rnd(2) === 1 }; });
    const scan = (o: number) => {
      let best = null;
      for (const b of blocks) if (b.startOffset <= o && o < b.endOffset && (best === null || b.endOffset - b.startOffset < best.endOffset - best.startOffset)) best = b;
      return best ? best.hasExecuted : false;
    };
    const ran = innermostRan(blocks);
    const asked = Array.from({ length: 150 }, () => rnd(240)).sort((a, b) => a - b);
    const back = [rnd(120), rnd(120), rnd(120)];
    for (const o of [...asked, ...back]) assert.equal(ran(o), scan(o), `round ${round}, offset ${o}`);
  }
});

test('a script\'s maps are decoded again once the file or its map changes, though decoded once for the boots that read the same', { timeout: 30_000 }, async () => {
  const dir = scratch();
  try {
    cpSync(FIX, join(dir, 'fix'), { recursive: true });
    const got = await readIn(join(dir, 'fix'), 'host.mjs');
    const script = got.scripts!.find((s) => s.path.endsWith('fixpkg/dist/index.js'))!;
    const before = scriptLines(script);
    assert.deepEqual(scriptLines(script), before);
    const mapPath = join(dir, 'fix', 'fixpkg', 'dist', 'index.js.map');
    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    writeFileSync(mapPath, JSON.stringify({ ...map, sources: ['../src/renamed.ts'] }));
    const after = scriptLines(script);
    assert.deepEqual([...after.files!.keys()].map((f) => f.split('/').pop()), ['renamed.ts']);
    assert.deepEqual([...before.files!.keys()].map((f) => f.split('/').pop()), ['index.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file built into more than one script reads couldn\'t tell where the loaded script holds no code, and its reason says why', () => {
  const split = { [PKG_SRC]: 'it is built into two scripts' };
  const digests = [{ named: { [PKG_SRC]: { code: [3, 10], ran: [3] }, 'fixpkg/src/bare.ts': { code: [1], ran: [] } }, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }];
  const ch = { [PKG_SRC]: { lines: [3, 5, 10], deletions: [{ after: 20 }] }, 'fixpkg/src/bare.ts': { lines: [1, 2], deletions: [] } };
  const r = reachOf({ changed: ch, onDisk: {}, split, digests });
  assert.deepEqual(r.files[PKG_SRC], { state: 'read', ran: [3], notRan: [], noCode: [], couldntTell: [5, 10], unloaded: [], deletions: [{ after: 20, state: 'couldnt-tell', by: 10 }], reason: 'it is built into two scripts' });
  assert.deepEqual(r.files['fixpkg/src/bare.ts'], { state: 'read', ran: [], notRan: [1], noCode: [2], couldntTell: [], unloaded: [], deletions: [] });
  const none = reachOf({ changed: { [PKG_SRC]: { lines: [5], deletions: [{ after: 5 }] } }, onDisk: {}, split, digests: [{ ...digests[0], named: { [PKG_SRC]: { code: [], ran: [] } } }] });
  assert.deepEqual(none.files[PKG_SRC].deletions, [{ after: 5, state: 'couldnt-tell', by: null }]);
});

test('a module of types alone that no host loaded reads as no code, from the map that names it, and a declaration map gives no code', () => {
  const dir = scratch();
  try {
    cpSync(join(FIX, 'fixpkg'), join(dir, 'fixpkg'), { recursive: true });
    const dist = join(dir, 'fixpkg', 'dist');
    writeFileSync(join(dist, 'index.d.ts.map'), readFileSync(join(dist, 'index.js.map'), 'utf-8').replace('"file":"index.js"', '"file":"index.d.ts"'));
    const ch = { 'fixpkg/src/types-only.ts': { lines: [1, 2], deletions: [{ after: 1 }] }, [PKG_SRC]: { lines: [2], deletions: [] } };
    const r = reachOf({ root: dir, built: ['fixpkg/dist'], changed: ch, reads: [], harnessDir: HARNESS_SIDE });
    assert.deepEqual(r.files['fixpkg/src/types-only.ts'], { state: 'not-loaded', ran: [], notRan: [], noCode: [1, 2], couldntTell: [], unloaded: [], deletions: [{ after: 1, state: 'no-code', by: null }] });
    assert.deepEqual(builtCodeOf({ root: dir, built: ['fixpkg/dist'], changed: ch }), builtCodeOf({ root: FIX, built: ['fixpkg/dist'], changed: ch }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reason names files by the repository\'s paths, with the runner\'s install and work directories taken out', () => {
  const home = join(tmpdir(), 'whole-host-abc');
  const d = digestOf({ scripts: [{ path: join(FIX, 'fixpkg', 'dist', 'index.js'), unread: 'boom' }], spawned: [{ kind: 'child', argv: ['bun', join(home, 'tool.mjs')] }] },
    { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE, home });
  assert.deepEqual(d.notes, ['fixpkg/dist/index.js: boom']);
  assert.deepEqual(d.fallbacks, ['a child process the host started, `bun tool.mjs`, ran unprofiled']);
});

test('a built script with no map is noted as such even where the inspector couldn\'t read it, and isn\'t skipped as holding no changed file', () => {
  const d = digestOf({ scripts: [{ path: join(FIX, 'fixpkg', 'dist', 'bare.js'), unread: 'its blocks couldn\'t be read' }], spawned: [] },
    { root: FIX, built: ['fixpkg/dist'], only: ['fixpkg/src/bare.ts'] });
  assert.deepEqual(d.maplessBuilt, ['fixpkg/dist/bare.js']);
});

test('a worker that can run a built file whose map can\'t be read is a firing, naming the file', () => {
  const dir = scratch();
  try {
    cpSync(join(FIX, 'fixpkg'), join(dir, 'fixpkg'), { recursive: true });
    writeFileSync(join(dir, 'fixpkg', 'dist', 'worker.js.map'), '{ not json');
    const { fallbacks } = reachOf({ root: dir, built: ['fixpkg/dist'], changed: changed([10]), reads: [{ scripts: [], spawned: [{ kind: 'worker', entry: join(dir, 'fixpkg', 'dist', 'worker.js'), eval: false }] }], harnessDir: HARNESS_SIDE });
    assert.equal(fallbacks.fired, 1);
    assert.match(fallbacks.notes[0], /can run fixpkg\/dist\/worker\.js, whose source map couldn't be read$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the closure scan follows an import with no space before its braces, and createRequire and its loader with one before their parenthesis, and reads an alias of require as unknown', () => {
  const dir = scratch();
  try {
    for (const n of ['a', 'b', 'c']) writeFileSync(join(dir, `${n}.js`), 'export const v = 1;\n');
    writeFileSync(join(dir, 'tight.js'), "import{v}from'./a.js';\nconsole.log(v);\n");
    writeFileSync(join(dir, 'made.js'), "import { createRequire } from 'node:module';\nconst load = createRequire (import.meta.url);\nload ('./b.js');\n");
    writeFileSync(join(dir, 'own.js'), "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./c.js');\n");
    writeFileSync(join(dir, 'alias.js'), "const load = require;\nload('./a.js');\n");
    const names = (c: ReturnType<typeof closureOf>) => [...c.files].map((f) => f.split('/').pop()).sort();
    assert.deepEqual([names(closureOf(join(dir, 'tight.js'))), closureOf(join(dir, 'tight.js')).unknown], [['a.js', 'tight.js'], []]);
    assert.deepEqual([names(closureOf(join(dir, 'made.js'))), closureOf(join(dir, 'made.js')).unknown], [['b.js', 'made.js'], []]);
    assert.deepEqual([names(closureOf(join(dir, 'own.js'))), closureOf(join(dir, 'own.js')).unknown], [['c.js', 'own.js'], []]);
    assert.match(closureOf(join(dir, 'alias.js')).unknown.join('\n'), /uses require other than by calling it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the join counts only the digests that stand for boots against a share\'s boots', () => {
  const part = { change: 'c', writer: 'w', changed: { 'src/a.ts': { lines: [1], deletions: [] } }, onDisk: {}, split: {},
    drives: { 'H1/W1': [{ boot: 1, read: true }, { boot: 2, read: true }] },
    digests: [{ named: {}, notes: [], fallbacks: [], maplessBuilt: [], unprofiled: {} }, { ...unreadDigest('H1/W2 had no profiled drive, since it couldn\'t run'), noDrive: true as const }] };
  assert.throws(() => reachJoined([part]), /a share read 2 boots but brought 1 digests of them/);
});

test('a child started through Bun\'s shell is logged, so it\'s a firing', { timeout: 30_000 }, async () => {
  const got = await read('host-shell.mjs');
  assert.deepEqual(got.spawned, [{ pid: (got.spawned[0] as Extract<Spawned, { kind: 'child' }> | undefined)?.pid, kind: 'child', argv: ['$', '/bin/echo shell'] }]);
  const r = reachIn([got], changed([3, 10]));
  assert.deepEqual([r.ran, r.couldntTell], [[3], [10]]);
});

test('a loaded file\'s lines its script holds no code for read couldn\'t tell beside a loaded map-less build, which may hold them', () => {
  const digests = [{ named: { [PKG_SRC]: { code: [3], ran: [3] } }, notes: [], fallbacks: [], maplessBuilt: ['fixpkg/dist/bare.js'], unprofiled: {} }];
  const r = reachOf({ changed: { [PKG_SRC]: { lines: [3, 4], deletions: [{ after: 9 }] } }, onDisk: {}, digests }).files[PKG_SRC];
  assert.deepEqual([r.ran, r.noCode, r.couldntTell, r.deletions], [[3], [], [4], [{ after: 9, state: 'reached', by: 3 }]]);
  assert.match(r.reason!, /^fixpkg\/dist\/bare\.js ran with no source map, so it may hold a copy of any changed file's code$/);
  const none = reachOf({ changed: { [PKG_SRC]: { lines: [4], deletions: [{ after: 9 }] } }, onDisk: {}, digests: [{ ...digests[0], named: { [PKG_SRC]: { code: [], ran: [] } } }] }).files[PKG_SRC];
  assert.deepEqual([none.couldntTell, none.deletions], [[4], [{ after: 9, state: 'couldnt-tell', by: null }]]);
});

test('a package the candidate\'s lockfile holds no install of is refused, rather than read as loaded by no host', () => {
  const lock = { '': {}, 'node_modules/@animalabs/membrane': {}, 'node_modules/x/node_modules/@animalabs/membrane': {} };
  assert.deepEqual(packRoots(lock, '/i', '@animalabs/membrane'), ['/i/node_modules/@animalabs/membrane', '/i/node_modules/x/node_modules/@animalabs/membrane']);
  assert.throws(() => packRoots(lock, '/i', '@animalabs/agent-framework'), /the install holds no @animalabs\/agent-framework/);
});

test('every way Bun\'s shell runs a command is logged: $, a configured $, and a shell made with new $.Shell()', { timeout: 30_000 }, async () => {
  const got = await read('host-shells.mjs');
  assert.deepEqual(got.spawned.map((x) => (x as Extract<Spawned, { kind: 'child' }>).argv), [['$', '/bin/echo one'], ['$', '/bin/echo two'], ['$', '/bin/echo three'], ['$', '/bin/echo four']]);
});

test('the closure scan reads any load of \'bun\', or Bun.$, as starting a child, since Bun\'s shell starts children', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'imported.js'), "import { $ } from 'bun';\nawait $`ls`;\n");
    writeFileSync(join(dir, 'global.js'), 'await Bun.$`ls`;\n');
    writeFileSync(join(dir, 'required.js'), "const { $ } = require('bun');\n");
    writeFileSync(join(dir, 'dynamic.js'), "const bun = await import('bun');\n");
    writeFileSync(join(dir, 'star.js'), "import * as bun from 'bun';\nawait bun.$`ls`;\n");
    writeFileSync(join(dir, 'default.js'), "import bun from \"bun\";\nawait bun.$`ls`;\n");
    for (const f of ['imported.js', 'global.js', 'required.js', 'dynamic.js', 'star.js', 'default.js']) {
      assert.match(closureOf(join(dir, f)).unknown.join('\n'), /starts a child process/, f);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a changed file that isn\'t script source, a binary one included, reads couldn\'t tell with its own reason', () => {
  const diff = ['diff --git a/src/q.wasm b/src/q.wasm', 'index 1..2 100644', 'Binary files a/src/q.wasm and b/src/q.wasm differ',
    'diff --git "a/src/n\\303\\251.wasm" "b/src/n\\303\\251.wasm"', 'new file mode 100644', 'index 0..2', 'Binary files /dev/null and "b/src/n\\303\\251.wasm" differ',
    'diff --git a/src/gone.wasm b/src/gone.wasm', 'deleted file mode 100644', 'Binary files a/src/gone.wasm and /dev/null differ',
    'diff --git a/src/q.wasm.LICENSES b/src/q.wasm.LICENSES', '+++ b/src/q.wasm.LICENSES', '@@ -1,0 +2,2 @@', '+x', '+y', '@@ -9 +10,0 @@', ''].join('\n');
  const ch = changedOf(diff);
  assert.deepEqual(ch, { 'src/q.wasm': { lines: [], deletions: [], binary: true }, 'src/né.wasm': { lines: [], deletions: [], binary: true },
    'src/q.wasm.LICENSES': { lines: [2, 3], deletions: [{ after: 10 }] } });
  const r = reachOf({ changed: ch, onDisk: {}, digests: [{ named: {}, notes: ['n1'], fallbacks: [], maplessBuilt: [], unprofiled: {} }] });
  assert.deepEqual(r.files['src/q.wasm'], { state: 'couldnt-tell', ran: [], notRan: [], noCode: [], couldntTell: [], unloaded: [], deletions: [], binary: true,
    reason: "n1; src/q.wasm isn't script source, so whether its change ran can't be read" });
  assert.deepEqual(r.files['src/q.wasm.LICENSES'], { state: 'couldnt-tell', ran: [], notRan: [], noCode: [], couldntTell: [], unloaded: [2, 3],
    deletions: [{ after: 10, state: 'unloaded', by: null }], reason: "n1; src/q.wasm.LICENSES isn't script source, so whether its change ran can't be read" });
});

test('a map-less build\'s reason is a note, since it covers every line not seen to run', () => {
  const digests = [{ named: { [PKG_SRC]: { code: [3], ran: [] } }, notes: ['n1'], fallbacks: [], maplessBuilt: ['fixpkg/dist/bare.js'], unprofiled: {} }];
  const r = reachOf({ changed: changed([3]), onDisk: {}, digests });
  assert.deepEqual(r.notes, ['fixpkg/dist/bare.js ran with no source map, so it may hold a copy of any changed file\'s code', 'n1']);
  assert.equal(r.files[PKG_SRC].reason, r.notes.join('; '));
});

test('Git\'s quoted paths in a diff read as the paths they name', () => {
  const diff = [
    'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
    '--- "a/src/caf\\303\\251.ts"',
    '+++ "b/src/caf\\303\\251.ts"',
    '@@ -1 +1 @@',
    '+export const café = 1;',
    'diff --git "a/src/tab\\there.ts" "b/src/tab\\there.ts"',
    '--- "a/src/tab\\there.ts"',
    '+++ "b/src/tab\\there.ts"',
    '@@ -0,0 +3 @@',
    '+x',
    'diff --git "a/src/q\\"b\\\\.ts" "b/src/q\\"b\\\\.ts"',
    '+++ "b/src/q\\"b\\\\.ts"',
    '@@ -4,0 +5,2 @@',
    '+y',
    '+z',
    'diff --git "a/src/😀\\"x.ts" "b/src/😀\\"x.ts"',
    '+++ "b/src/😀\\"x.ts"',
    '@@ -0,0 +1 @@',
    '+w',
    'diff --git a/src/a b.ts b/src/a b.ts',
    '+++ b/src/a b.ts\t',
    '@@ -0,0 +2 @@',
    '+v',
    'diff --git a/src/end.ts  b/src/end.ts ',
    '+++ b/src/end.ts \t',
    '@@ -0,0 +4 @@',
    '+u',
    '',
  ].join('\n');
  assert.deepEqual(changedOf(diff), {
    'src/café.ts': { lines: [1], deletions: [] },
    'src/tab\there.ts': { lines: [3], deletions: [] },
    'src/q"b\\.ts': { lines: [5, 6], deletions: [] },
    'src/😀"x.ts': { lines: [1], deletions: [] },
    'src/a b.ts': { lines: [2], deletions: [] },
    'src/end.ts ': { lines: [4], deletions: [] },
  });
});

test('a digest reads only the scripts that can hold a changed file\'s code: a script whose map names none adds nothing, even unread', async () => {
  const got = await read('host-types.mjs');
  const tree = { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE, only: [PKG_SRC] };
  const whole = digestOf(got, tree);
  assert.deepEqual(Object.keys(whole.named), [PKG_SRC]);
  const types = got.scripts!.findIndex((s) => s.path.endsWith('types-only.js'));
  assert.ok(types >= 0, 'the host loaded types-only.js');
  const broken = { ...got, scripts: got.scripts!.map((s, i) => (i === types ? { path: s.path, unread: 'its blocks couldn\'t be read' } : s)) } as Read;
  assert.deepEqual(digestOf(broken, tree), whole);
  const relevant = got.scripts!.findIndex((s) => s.path.endsWith('dist/index.js'));
  const lost = { ...got, scripts: got.scripts!.map((s, i) => (i === relevant ? { path: s.path, unread: 'its blocks couldn\'t be read' } : s)) } as Read;
  const notes = digestOf(lost, tree).notes;
  assert.equal(notes.length, 1);
  assert.match(notes[0], /fixpkg\/dist\/index\.js: its blocks couldn't be read$/);
});

test('reach reads the overlay the diff is of: the one overlay, or the one --reach-package names among several', () => {
  const a = { name: '@animalabs/agent-framework' }, m = { name: '@animalabs/membrane' };
  assert.equal(reachPackOf([a], null), a);
  assert.equal(reachPackOf([m, a], '@animalabs/agent-framework'), a);
  assert.throws(() => reachPackOf([m, a], null), /--reach with 2 overlays needs --reach-package, naming the overlay the diff is of/);
  assert.throws(() => reachPackOf([m, a], '@animalabs/chronicle'), /--reach-package @animalabs\/chronicle names none of the overlays: @animalabs\/membrane, @animalabs\/agent-framework/);
  assert.throws(() => reachPackOf([], '@animalabs/chronicle'), /--reach-package @animalabs\/chronicle names an overlay, and none was given/);
  assert.equal(reachPackOf([], null), null);
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
  const host = await read('host-bare.mjs'), app = await read('app.ts');
  for (const reads of [[host, app], [app]]) {
    const joined = reachOf({ changed: ch, onDisk: JSON.parse(JSON.stringify(onDisk)), digests: reads.map((r) => JSON.parse(JSON.stringify(digestOf(r, { ...tree, only: Object.keys(ch) })))) });
    assert.deepEqual(joined, reachOf({ ...tree, changed: ch, reads }));
  }
  const missing = reachOf({ changed: ch, onDisk, digests: [digestOf(app, { ...tree, only: Object.keys(ch) }), unreadDigest('share 4 brought no reach home')] }).files[PKG_SRC];
  assert.deepEqual([missing.notRan, missing.couldntTell, missing.noCode], [[], [3, 9, 10], [8]]);
  assert.match(missing.reason!, /share 4 brought no reach home/);
});

test('a view\'s reach.json joins its shares\' drives, and a share that brought none makes unseen lines couldn\'t tell; with none at all it couldn\'t be read', async () => {
  const tree = { root: FIX, built: ['fixpkg/dist'], harnessDir: HARNESS_SIDE };
  const ch = changed([3, 10]);
  const got = await read('host.mjs');
  const part = (run: string) => ({ change: 'fixpkg', changed: ch, onDisk: builtCodeOf({ ...tree, changed: ch }), drives: { [run]: [{ boot: 1, read: true }] }, digests: [digestOf(got, { ...tree, only: Object.keys(ch) })] });
  const both = reachJoined([part('H1/W1'), part('H1/W2')]) as Reach;
  assert.deepEqual(Object.keys(both.drives), ['H1/W1', 'H1/W2']);
  assert.deepEqual([both.files[PKG_SRC].ran, both.files[PKG_SRC].notRan], [[3], [10]]);
  const short = reachJoined([part('H1/W1'), { missing: 'share 2 brought no reach home' }]) as Reach;
  assert.deepEqual([short.files[PKG_SRC].ran, short.files[PKG_SRC].couldntTell], [[3], [10]]);
  assert.deepEqual(short.notes, ['share 2 brought no reach home']);
  assert.deepEqual(reachJoined([{ missing: 'share 1 brought no reach home' }, { missing: 'share 2 brought no reach home' }]), { couldnt: 'share 1 brought no reach home; share 2 brought no reach home' });
});

test('reach.json names the reach code that wrote each share\'s digests beside the code that joined them, so a join across two versions shows', () => {
  const h = createHash('sha256');
  for (const f of ['reach/reach.ts', 'reach/reach-preload.cts', 'cut/cut.ts']) {
    const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f));
    h.update(`${bytes.length}\n`).update(bytes);
  }
  const own = h.digest('hex');
  const part = reachPart({ root: FIX, built: ['fixpkg/dist'], change: 'fixpkg', changed: changed([3]), drives: {}, digests: [] });
  assert.equal(part.writer, own);
  assert.deepEqual((reachJoined([part, { ...part, writer: 'an older reach code' }]) as Reach).code, { wrote: [own, 'an older reach code'], joined: own });
  assert.deepEqual((reachJoined([part, part]) as Reach).code, { wrote: [own], joined: own });
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

async function withInspectedBun(use: (client: ReturnType<typeof inspectorClient>, kill: () => void) => Promise<void>) {
  const logDir = mkdtempSync(join(tmpdir(), 'reach-'));
  const launch = await reachLaunch({ logDir });
  const child = spawn('bun', [...launch.args, '-e', 'setTimeout(() => {}, 30000)'], { env: { ...process.env, ...launch.env }, stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
  let client: ReturnType<typeof inspectorClient> | null = null;
  try {
    for (const deadline = Date.now() + 10_000; ;) {
      client = inspectorClient(launch.url);
      try { await client.opened; break; } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await use(client, kill);
  } finally {
    client?.close();
    kill();
    rmSync(logDir, { recursive: true, force: true });
  }
}

test('a call the inspector answers with an error rejects naming the method it called, with the error\'s code and message, so a failure says which call failed', () => withInspectedBun(async (client) => {
  await assert.rejects(client.call('Nonexistent.method'), (e: Error) => /^the inspector answered Nonexistent\.method with error -32601: \S/.test(e.message));
}));

test('a call the inspector closes before answering rejects naming the method it called', () => withInspectedBun(async (client, kill) => {
  const never = client.call('Runtime.evaluate', { expression: 'for (;;) {}' });
  kill();
  await assert.rejects(never, (e: Error) => e.message === 'the inspector closed before it answered Runtime.evaluate');
}));
