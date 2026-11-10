// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestsOf, driveOf, reachAttach, reachLaunch } from '../lib/reach.ts';
import { createServer } from 'node:net';
import { FLEET_SUBSCRIPTION, childWatchers, fleetChildren, fleetReady, laneRecipe } from '../lib/strategies/driver.ts';
import { HarnessModule } from '../lib/strategies/module.ts';
import { configurations } from '../lib/strategies/script.ts';

test('a fleet run\'s parent recipe starts each child of its configuration, autoStart, from a recipe of its own, its data under the run\'s store and its model on the stand-in\'s /empty route', () => {
  const configuration = configurations().Hfleet;
  assert.deepEqual(configuration.fleet.map((c) => c.name), ['src', 'dst']);
  const fleet = fleetChildren({ configuration, work: '/w', storeDir: '/s', standinUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(fleet.map((f) => [f.name, f.recipePath, f.dataDir, f.env]), [
    ['src', '/w/fleet-src.json', '/s/fleet/src', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
    ['dst', '/w/fleet-dst.json', '/s/fleet/dst', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
  ]);
  assert.equal(fleet[0].recipe.agent.name, 'src');
  assert.equal(fleet[0].recipe.extensions, undefined, 'a child loads no harness module');
  const recipe = laneRecipe({ configuration, control: '/c.sock', channels: ['chat'], boot: 1, fleet });
  assert.deepEqual(recipe.modules.fleet, { children: fleet.map((f) => ({ name: f.name, recipe: f.recipePath, dataDir: f.dataDir, autoStart: true, subscription: FLEET_SUBSCRIPTION, env: f.env })) });
  assert.equal(laneRecipe({ configuration: configurations().H1, control: '/c.sock', channels: ['chat'], boot: 1 }).modules.fleet, undefined, 'a run with no children names no fleet module');
});

const moduleOn = (framework) => { const m = new HarnessModule(null); m.framework = framework; return m; };

test('the harness module\'s fleet op answers each child the parent\'s fleet module holds, by name, status and pid, and says why where it can\'t read them', async () => {
  const children = new Map([['src', { name: 'src', status: 'ready', pid: 41 }], ['dst', { name: 'dst', status: 'starting', pid: null }]]);
  const fleet = { getChildren: () => children };
  assert.deepEqual(await moduleOn({ getModule: (n) => (n === 'fleet' ? fleet : undefined) }).answer({ op: 'fleet' }), { children: [{ name: 'src', status: 'ready', pid: 41 }, { name: 'dst', status: 'starting', pid: null }] });
  assert.deepEqual(await moduleOn({ getModule: () => ({}) }).answer({ op: 'fleet' }), { moved: 'the fleet module gives no getChildren()' });
  assert.deepEqual(await moduleOn({ getModule: () => undefined }).answer({ op: 'fleet' }), { moved: 'the host has no fleet module' });
  assert.deepEqual(await moduleOn({}).answer({ op: 'fleet' }), { moved: 'the host\'s agent-framework gives no getModule()' });
});

test('a boot\'s wait for the fleet\'s children asks until every child it starts reads ready, and throws where their status can\'t be read or a child isn\'t ready within its bound', async () => {
  const kids = (...statuses) => ({ children: statuses.map(([name, status]) => ({ name, status, pid: 7 })) });
  const asking = (...answers) => { let n = 0; return { ask: async () => answers[Math.min(n++, answers.length - 1)], asked: () => n }; };
  const slow = asking(kids(['src', 'starting']), kids(['src', 'ready']), kids(['src', 'ready'], ['dst', 'starting']), kids(['src', 'ready'], ['dst', 'ready']));
  const got = await fleetReady({ ask: slow.ask, names: ['src', 'dst'], pollMs: 1 });
  assert.deepEqual(got.children, kids(['src', 'ready'], ['dst', 'ready']).children);
  assert.equal(slow.asked(), 4, 'a child the module doesn\'t hold yet isn\'t ready');
  const moved = asking({ moved: 'the host has no fleet module' });
  await assert.rejects(fleetReady({ ask: moved.ask, names: ['src'], pollMs: 1 }), /couldn't read whether the fleet's children are ready, which the harness reads through the parent's fleet module's getChildren\(\): the host has no fleet module/);
  assert.equal(moved.asked(), 1, 'a moved answer ends the wait at once, never going on without it');
  await assert.rejects(fleetReady({ ask: async () => null, names: ['src'], pollMs: 1 }), /the harness module's answer isn't a list of children: null/);
  await assert.rejects(fleetReady({ ask: async () => kids(['src', 'starting']), names: ['src'], boundMs: 30, pollMs: 5 }), /the fleet's children weren't all ready within 30 ms: \[\{"name":"src","status":"starting","pid":7\}\]/);
});

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'strategies', 'module.ts');

test('the harness module\'s crash ends its host at once with exit code 137, its exit listeners unrun, and under reach the host is still read where it exits', { timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-crash-')));
  const logDir = mkdtempSync(join(tmpdir(), 'fleet-crash-reach-'));
  let child = null;
  try {
    writeFileSync(join(dir, 'crash.ts'), `import { HarnessModule } from ${JSON.stringify(MODULE)};\nprocess.on('exit', () => console.log('exit listener ran'));\nconsole.log(JSON.stringify(await new HarnessModule(null).answer({ op: 'crash' })));\nsetInterval(() => {}, 1000);\n`);
    const launch = await reachLaunch({ logDir });
    const out = [];
    child = spawn('bun', [...launch.args, join(dir, 'crash.ts')], { cwd: dir, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    const closed = new Promise((res) => child.once('close', (code, signal) => res({ code, signal })));
    const reach = reachAttach({ launch, child, wanted: (path) => path.startsWith(`${dir}/`) });
    await reach.attached;
    const read = await reach.atExit;
    const ended = await closed;
    reach.close();
    assert.equal(ended.code, 137, out.join(''));
    assert.match(out.join(''), /"ending":\d+/);
    assert.doesNotMatch(out.join(''), /exit listener ran/);
    assert.equal(read.unread, undefined, `read where it exits: ${read.unread}`);
    assert.ok(read.scripts.some((x) => x.path === join(dir, 'crash.ts')), 'the host\'s own script is among those read');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// A Bun process started as the fleet module starts a child: reach's additions reach it through BUN_OPTIONS alone, and
// the harness holds no handle on it.
async function unheld(script, { prepare = () => {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-reach-')));
  const logDir = mkdtempSync(join(tmpdir(), 'fleet-reach-log-'));
  writeFileSync(join(dir, 'child.ts'), script);
  const launch = await reachLaunch({ logDir });
  prepare(launch);
  const proc = spawn('bun', [join(dir, 'child.ts')], { cwd: dir, env: { ...process.env, BUN_OPTIONS: launch.args.join(' '), ...launch.env }, stdio: 'ignore', detached: true });
  let a = null;
  const done = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} a?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); };
  try { a = reachAttach({ launch, wanted: (path) => path.startsWith(`${dir}/`) }); } catch (e) { done(); throw e; }
  return { dir, launch, proc, a, done };
}

test('a process the harness didn\'t start, under reach\'s additions through BUN_OPTIONS, is attached as it waits, read where it exits, gives its pid, and keeps only its own lines of the spawn log its child\'s processes share', { timeout: 30_000 }, async () => {
  const u = await unheld("Bun.spawnSync(['true']);\nprocess.exit(0);\n", { prepare: (launch) => appendFileSync(launch.logPath, `${JSON.stringify({ pid: 1, kind: 'child', argv: ['an', 'earlier', 'process'] })}\n`) });
  try {
    await u.a.attached;
    const read = await u.a.atExit;
    await u.a.ended;
    assert.equal(read.unread, undefined, read.unread);
    assert.equal(u.a.pid(), u.proc.pid);
    assert.ok(read.scripts.some((x) => x.path === join(u.dir, 'child.ts')));
    assert.deepEqual(read.spawned, [{ pid: u.proc.pid, kind: 'child', argv: ['true'] }], 'the earlier process\'s line isn\'t its own');
  } finally { u.done(); }
});

test('a process the harness didn\'t start that a signal ends, not process.exit or process.reallyExit, reads unread, its reason that its inspector closed before it stopped where reach reads', { timeout: 30_000 }, async () => {
  const u = await unheld("console.log('up');\nsetInterval(() => {}, 1000);\n");
  try {
    await u.a.attached;
    process.kill(u.proc.pid, 'SIGKILL');
    const read = await u.a.atExit;
    assert.match(read.unread, /^its inspector closed before it stopped where reach reads what it ran, since it didn't exit by process\.exit or process\.reallyExit, or its Bun didn't pause there/);
  } finally { u.done(); }
});

test('an attach to a process that never comes keeps trying until it\'s told to stop, and then gives up', { timeout: 10_000 }, async () => {
  const server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  let opens = 0;
  server.on('connection', (c) => { opens++; c.destroy(); });
  let stopped = false;
  const a = reachAttach({ launch: { url: `ws://127.0.0.1:${server.address().port}/none`, logPath: '/nonexistent' }, stopped: () => stopped });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(opens >= 2, `it tried again: ${opens} open(s)`);
    const at = performance.now();
    stopped = true;
    await assert.rejects(a.attached);
    assert.ok(performance.now() >= at, 'it gave up only once told to stop');
  } finally { a.close(); server.close(); }
});

test('a fleet child\'s read is a drive of its own, named by the child, and each start of the child\'s recipe the host logged is followed by one read of the child, a start left over having run unprofiled', () => {
  const recipe = '/w/fleet-src.json';
  const parent = { boot: 1, scripts: [], spawned: [{ pid: 9, kind: 'child', argv: ['/bun', '/host/src/index.ts', recipe, '--headless'] }, { pid: 9, kind: 'child', argv: ['/bun', '/host/src/index.ts', recipe, '--headless'] }] };
  const child = { fleet: { child: 'src', recipePath: recipe }, scripts: [] };
  assert.deepEqual(driveOf([parent, child]), [{ boot: 1, read: true }, { boot: null, read: true, child: 'src' }]);
  const tree = { root: '/nowhere', harnessDir: '/harness' };
  const [once] = digestsOf([parent, child], 'Hfleet/W20', tree);
  assert.deepEqual(once.fallbacks, [`a child process the host started, \`/bun /host/src/index.ts ${recipe} --headless\`, ran unprofiled`], 'one start is followed and the other isn\'t');
  const [both] = digestsOf([parent, child, child], 'Hfleet/W20', tree);
  assert.deepEqual(both.fallbacks, []);
});

test('at a drive\'s end, a child\'s watcher whose process still runs past its bound closes its attach and reads unread, so no read comes after the drive\'s reads are taken', { timeout: 30_000 }, async () => {
  const u = await unheld("console.log('up');\nsetInterval(() => {}, 1000);\n");
  const reads = [];
  try {
    const w = childWatchers({ wanted: () => false, reads, boundMs: 300 });
    w.watch('src', u.launch, '/w/fleet-src.json');
    await new Promise((r) => setTimeout(r, 600));
    const at = performance.now();
    await w.stop();
    assert.ok(performance.now() - at < 2000, 'it stops within its bound');
    assert.deepEqual(reads, [{ fleet: { child: 'src', recipePath: '/w/fleet-src.json' }, unread: 'the drive ended with it still running 300 ms after the host\'s shutdown, so what it ran couldn\'t be read' }]);
    process.kill(u.proc.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reads.length, 1, 'nothing comes after');
  } finally { u.done(); }
});

test('a process the harness didn\'t start whose pid can\'t be read reads unread, naming why, rather than as every process\'s lines of the spawn log', { timeout: 20_000 }, async () => {
  // An inspector that answers every call but the pid's.
  const dir = mkdtempSync(join(tmpdir(), 'fleet-pid-'));
  writeFileSync(join(dir, 'inspector.ts'), "const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no'); }, websocket: { message(ws, m) { const { id, method } = JSON.parse(String(m)); ws.send(JSON.stringify(method === 'Runtime.evaluate' ? { id, error: { code: -32000, message: 'no pid here' } } : { id, result: {} })); } } });\nconsole.log(s.port);\n");
  const fake = spawn('bun', [join(dir, 'inspector.ts')], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res) => fake.stdout.once('data', (d) => res(Number(String(d).trim()))));
    const a = reachAttach({ launch: { url: `ws://127.0.0.1:${port}/x`, logPath: join(dir, 'log.jsonl') } });
    await a.attached;
    const read = await a.atExit;
    a.close();
    assert.equal(read.unread, 'its pid couldn\'t be read, so which lines of its spawn log are its own can\'t be told (the inspector answered Runtime.evaluate with error -32000: no pid here)');
    assert.equal(a.pid(), null);
  } finally { fake.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
