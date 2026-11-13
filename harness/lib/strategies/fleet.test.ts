import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestsOf, driveOf, reachAttach, reachLaunch } from '../reach/interfaces.ts';
import { createServer } from 'node:net';
import * as driver from './driver.ts';
import { childWatchers, endFleetGroups, endGroups, fleetChildren, fleetReady, groupAlive } from './fleet.ts';
import { FLEET_SUBSCRIPTION, laneRecipe } from './recipe.ts';
import { startStandin } from '../standin/standin.ts';
import { HarnessModule } from './module.ts';
import { configurations } from './script.ts';
import { RUNS, runOf } from '../workloads/workloads.ts';
import { listedGroups } from '../common.ts';
import { stopListedHosts } from '../pool.ts';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { RequestRecord } from '../standin/standin.ts';
import type { AddressInfo } from 'node:net';
import type { DigestsOf, DriveOf, ReachAttach, ReachLaunch } from '../reach/interfaces.ts';
import type { FleetReadout } from './module.ts';
import type { LogEntry } from './driver.ts';
import type { Run } from '../workloads/workloads.ts';
import type { W20Step } from '../workloads/w20.ts';
import type { Breaches } from '../workloads/fates.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
type Framework = NonNullable<HarnessModule['framework']>;
type Launch = Awaited<ReturnType<ReachLaunch>>;
type Read = Parameters<DriveOf>[0][number];

test('a fleet run\'s parent recipe starts each child of its configuration, autoStart, from a recipe of its own, its data under the run\'s store and its model on the stand-in\'s /empty route', () => {
  const configuration = configurations().Hfleet;
  assert.deepEqual(configuration.fleet!.map((c) => c.name), ['src', 'dst']);
  const fleet = fleetChildren({ configuration, work: '/w', storeDir: '/s', standinUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(fleet.map((f) => [f.name, f.recipePath, f.dataDir, f.env]), [
    ['src', '/w/fleet-src.json', '/s/fleet/src', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
    ['dst', '/w/fleet-dst.json', '/s/fleet/dst', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/empty' }],
  ]);
  assert.equal(fleet[0].recipe.agent.name, 'src');
  assert.equal((fleet[0].recipe as { extensions?: unknown }).extensions, undefined, 'a child loads no harness module');
  const recipe = laneRecipe({ configuration, control: '/c.sock', channels: ['chat'], boot: 1, fleet });
  assert.deepEqual(recipe.modules.fleet, { children: fleet.map((f) => ({ name: f.name, recipe: f.recipePath, dataDir: f.dataDir, autoStart: true, subscription: FLEET_SUBSCRIPTION, env: f.env })) });
  assert.equal(laneRecipe({ configuration: configurations().H1, control: '/c.sock', channels: ['chat'], boot: 1 }).modules.fleet, undefined, 'a run with no children names no fleet module');
});

const moduleOn = (framework: DeepPartial<Framework>) => { const m = new HarnessModule(null); m.framework = framework as Framework; return m; };

test('the harness module\'s fleet op answers each child the parent\'s fleet module holds, by name, status and pid, and says why where it can\'t read them', async () => {
  const children = new Map([['src', { name: 'src', status: 'ready', pid: 41 }], ['dst', { name: 'dst', status: 'starting', pid: null }]]);
  const fleet = { getChildren: () => children } satisfies NonNullable<ReturnType<NonNullable<Framework['getModule']>>>;
  assert.deepEqual(await moduleOn({ getModule: (n) => (n === 'fleet' ? fleet : undefined) }).answer({ op: 'fleet' }), { children: [{ name: 'src', status: 'ready', pid: 41 }, { name: 'dst', status: 'starting', pid: null }] });
  assert.deepEqual(await moduleOn({ getModule: () => ({}) }).answer({ op: 'fleet' }), { moved: 'the fleet module gives no getChildren()' });
  assert.deepEqual(await moduleOn({ getModule: () => undefined }).answer({ op: 'fleet' }), { moved: 'the host has no fleet module' });
  assert.deepEqual(await moduleOn({}).answer({ op: 'fleet' }), { moved: 'the host\'s agent-framework gives no getModule()' });
});

test('a boot\'s wait for the fleet\'s children asks until every child it starts reads ready, and throws where their status can\'t be read or a child isn\'t ready within its bound', async () => {
  const kids = (...statuses: Array<[string, string]>) => ({ children: statuses.map(([name, status]) => ({ name, status, pid: 7 })) }) satisfies FleetReadout;
  const asking = (...answers: FleetReadout[]) => { let n = 0; return { ask: async () => answers[Math.min(n++, answers.length - 1)], asked: () => n }; };
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

const MODULE = join(dirname(fileURLToPath(import.meta.url)), 'module.ts');

test('the harness module\'s crash ends its host at once with exit code 137, its exit listeners unrun, and under reach the host is still read where it exits', { timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-crash-')));
  const logDir = mkdtempSync(join(tmpdir(), 'fleet-crash-reach-'));
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  try {
    writeFileSync(join(dir, 'crash.ts'), `import { HarnessModule } from ${JSON.stringify(MODULE)};\nprocess.on('exit', () => console.log('exit listener ran'));\nconsole.log(JSON.stringify(await new HarnessModule(null).answer({ op: 'crash' })));\nsetInterval(() => {}, 1000);\n`);
    const launch = await reachLaunch({ logDir });
    const out: string[] = [];
    child = spawn('bun', [...launch.args, join(dir, 'crash.ts')], { cwd: dir, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child!.once('close', (code, signal) => res({ code, signal })));
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
    try { process.kill(-child!.pid!, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

async function until(holds: () => boolean, ms: number, what: string) {
  for (const end = performance.now() + ms; !holds();) {
    if (performance.now() > end) throw new Error(`${what} didn't come within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function unheld(script: string, { prepare = () => {}, attach = true }: { prepare?: (launch: Launch) => void; attach?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-reach-')));
  const logDir = mkdtempSync(join(tmpdir(), 'fleet-reach-log-'));
  writeFileSync(join(dir, 'child.ts'), script);
  const launch = await reachLaunch({ logDir });
  prepare(launch);
  const proc = spawn('bun', [join(dir, 'child.ts')], { cwd: dir, env: { ...process.env, BUN_OPTIONS: launch.args.join(' '), ...launch.env }, stdio: 'ignore', detached: true });
  let a: ReturnType<ReachAttach> | null = null;
  const done = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch {} a?.close(); rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }); };
  try { if (attach) a = reachAttach({ launch, wanted: (path) => path.startsWith(`${dir}/`) }); } catch (e) { done(); throw e; }
  return { dir, launch, proc, a, done };
}

test('a process the harness didn\'t start, under reach\'s additions through BUN_OPTIONS, is attached as it waits, read where it exits, gives its pid, and keeps only its own lines of the spawn log its child\'s processes share', { timeout: 30_000 }, async () => {
  const u = await unheld("Bun.spawnSync(['true']);\nprocess.exit(0);\n", { prepare: (launch) => appendFileSync(launch.logPath, `${JSON.stringify({ pid: 1, kind: 'child', argv: ['an', 'earlier', 'process'] })}\n`) });
  try {
    await u.a!.attached;
    const read = await u.a!.atExit;
    await u.a!.ended;
    assert.equal(read.unread, undefined, read.unread);
    assert.equal(u.a!.pid(), u.proc.pid);
    assert.ok(read.scripts.some((x) => x.path === join(u.dir, 'child.ts')));
    assert.deepEqual(read.spawned, [{ pid: u.proc.pid, kind: 'child', argv: ['true'] }], 'the earlier process\'s line isn\'t its own');
  } finally { u.done(); }
});

test('a process the harness didn\'t start that a signal ends, not process.exit or process.reallyExit, reads unread, its reason that its inspector closed before it stopped where reach reads', { timeout: 30_000 }, async () => {
  const u = await unheld("console.log('up');\nsetInterval(() => {}, 1000);\n");
  try {
    await u.a!.attached;
    process.kill(u.proc.pid!, 'SIGKILL');
    const read = await u.a!.atExit;
    assert.match(read.unread!, /^its inspector closed before it stopped where reach reads what it ran, since it didn't exit by process\.exit or process\.reallyExit, or its Bun didn't pause there/);
  } finally { u.done(); }
});

test('an attach to a process that never comes tries again after a failed open rather than giving up, and gives up once told to stop', { timeout: 10_000 }, async () => {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  let opens = 0;
  server.on('connection', (c) => { opens++; c.destroy(); });
  let stopped = false;
  const a = reachAttach({ launch: { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/none`, logPath: '/nonexistent' }, stopped: () => stopped });
  try {
    await until(() => opens >= 2, 5000, 'a second open');
    const state = await Promise.race([a.attached.then(() => 'attached', () => 'gave up'), new Promise((r) => setTimeout(() => r('pending'), 0))]);
    assert.equal(state, 'pending', `it keeps trying after ${opens} opens until told to stop`);
    stopped = true;
    await assert.rejects(a.attached);
  } finally { a.close(); server.close(); }
});

test('a fleet child\'s read is a drive of its own, named by the child, and each start of the child\'s recipe the host logged is followed by one read of the child, a start left over having run unprofiled', () => {
  const recipe = '/w/fleet-src.json';
  const parent = { boot: 1, scripts: [], spawned: [{ pid: 9, kind: 'child', argv: ['/bun', '/host/src/index.ts', recipe, '--headless'] }, { pid: 9, kind: 'child', argv: ['/bun', '/host/src/index.ts', recipe, '--headless'] }] } satisfies Read;
  const child = { fleet: { child: 'src', recipePath: recipe }, scripts: [] } satisfies Read;
  assert.deepEqual(driveOf([parent, child]), [{ boot: 1, read: true }, { boot: null, read: true, child: 'src' }]);
  const tree = { root: '/nowhere', harnessDir: '/harness' } satisfies Parameters<DigestsOf>[2];
  const [once] = digestsOf([parent, child], 'Hfleet/W20', tree);
  assert.deepEqual(once.fallbacks, [`a child process the host started, \`/bun /host/src/index.ts ${recipe} --headless\`, ran unprofiled`], 'one start is followed and the other isn\'t');
  const [both] = digestsOf([parent, child, child], 'Hfleet/W20', tree);
  assert.deepEqual(both.fallbacks, []);
});

test('at a drive\'s end, a child\'s watcher whose process still runs past its bound closes its attach and reads unread, so no read comes after the drive\'s reads are taken', { timeout: 30_000 }, async () => {
  const markDir = mkdtempSync(join(tmpdir(), 'fleet-mark-'));
  const mark = join(markDir, 'up');
  const u = await unheld(`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, 'up');\nsetInterval(() => {}, 1000);\n`, { attach: false });
  const reads: Parameters<typeof childWatchers>[0]['reads'] = [];
  try {
    const w = childWatchers({ wanted: () => false, reads, boundMs: 300 });
    w.watch('src', u.launch, '/w/fleet-src.json');
    await until(() => existsSync(mark), 10_000, 'the child running once its watcher attached');
    const at = performance.now();
    await w.stop();
    assert.ok(performance.now() - at < 2000, 'it stops within its bound');
    assert.deepEqual(reads, [{ fleet: { child: 'src', recipePath: '/w/fleet-src.json' }, unread: 'the drive ended with it still running 300 ms after the host\'s shutdown, so what it ran couldn\'t be read' }]);
    process.kill(u.proc.pid!, 'SIGKILL');
    await w.ended('src');
    assert.equal(reads.length, 1, 'nothing comes after');
  } finally { u.done(); rmSync(markDir, { recursive: true, force: true }); }
});

test('a child\'s watcher that has read its process pushes no unread for it at the drive\'s end, though the process\'s inspector stays open past the bound', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-late-'));
  const preload = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reach', 'reach-preload.cts'));
  writeFileSync(join(dir, 'inspector.ts'), `const at = ${JSON.stringify(pathToFileURL(preload).href)};
let attached = null;
process.stdin.on('data', () => {
  attached.send(JSON.stringify({ method: 'Debugger.scriptParsed', params: { scriptId: '1', url: at } }));
  attached.send(JSON.stringify({ method: 'Debugger.paused', params: { callFrames: [{ functionName: 'readPoint', location: { scriptId: '1' } }] } }));
});
const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no'); }, websocket: { message(ws, m) {
  const { id, method, params } = JSON.parse(String(m));
  const value = method === 'Runtime.evaluate' ? (String(params?.expression).includes('process.pid') ? 4242 : 0) : undefined;
  ws.send(JSON.stringify({ id, result: value === undefined ? {} : { result: { value } } }));
  if (method === 'Inspector.initialized') { attached = ws; console.log('attached'); }
} } });
console.log(s.port);
`);
  const fake = spawn('bun', [join(dir, 'inspector.ts')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines: string[] = [];
  fake.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const reads: Parameters<typeof childWatchers>[0]['reads'] = [];
  try {
    await until(() => lines.length >= 1, 10_000, 'the fake inspector\'s port');
    const w = childWatchers({ wanted: () => false, reads, boundMs: 2000 });
    w.watch('src', { url: `ws://127.0.0.1:${Number(lines[0])}/x`, logPath: join(dir, 'log.jsonl') } satisfies DeepPartial<Launch> as unknown as Launch, '/w/fleet-src.json');
    await until(() => lines.includes('attached'), 10_000, 'the attach');
    const stopping = w.stop();
    fake.stdin.write('read\n');
    await stopping;
    assert.deepEqual(reads.map((r) => ('unread' in r ? `unread: ${r.unread}` : 'read')), ['read']);
  } finally { fake.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('a process the harness didn\'t start whose pid can\'t be read reads unread, naming why, rather than as every process\'s lines of the spawn log', { timeout: 20_000 }, async () => {
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

const DATE_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'virtual-date.ts');

test('a host under the harness\'s Date preload, given FIXTURE_GROUPS, lists each detached process it starts, by Bun.spawn or node:child_process, there and in WHOLE_HOST_HOST_GROUPS, and no process it starts in its own group', { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-groups-'));
  try {
    writeFileSync(join(dir, 'host.ts'), [
      "import { spawn } from 'node:child_process';",
      "const a = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });",
      "const b = Bun.spawn(['sleep', '30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });",
      "const c = spawn('sleep', ['30'], { stdio: 'ignore' });",
      "console.log(JSON.stringify({ a: a.pid, b: b.pid, c: c.pid }));",
      "for (const p of [a.pid, b.pid, c.pid]) try { process.kill(p, 'SIGKILL'); } catch {}",
    ].join('\n'));
    const groups = join(dir, 'fleet.groups');
    const pooled = join(dir, 'pool.hosts');
    const r = spawnSyncBun(['--preload', DATE_PRELOAD, join(dir, 'host.ts')], { FIXTURE_EPOCH_MS: '1767603600000', FIXTURE_GROUPS: groups, WHOLE_HOST_HOST_GROUPS: pooled });
    const pids = JSON.parse(r.stdout);
    const listed = (f: string) => readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(Number);
    assert.deepEqual(listed(groups), [pids.a, pids.b]);
    assert.deepEqual(listed(pooled), [pids.a, pids.b]);
    const bare = join(dir, 'bare.hosts');
    const r2 = spawnSyncBun(['--preload', DATE_PRELOAD, join(dir, 'host.ts')], { FIXTURE_EPOCH_MS: '1767603600000', WHOLE_HOST_HOST_GROUPS: bare });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(existsSync(bare), false, 'a host given no FIXTURE_GROUPS, as in a run with no fleet, lists nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function spawnSyncBun(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync('bun', args, { encoding: 'utf-8', env: { ...process.env, FIXTURE_GROUPS: undefined, WHOLE_HOST_HOST_GROUPS: undefined, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('the drive\'s end kills each listed group still alive and waits, within its bound, for each to go, naming one that outlives it', async () => {
  const killed: Array<[number, string | number | undefined]> = [];
  const alive = new Set([11, 12]);
  const realKill = process.kill;
  process.kill = (pid, sig) => { if (pid < 0) { killed.push([-pid, sig]); if (-pid === 11) alive.delete(11); return true; } return realKill.call(process, pid, sig); };
  try {
    const at = performance.now();
    const got = await endGroups([11, 12, 13], { boundMs: 200, alive: (pid) => alive.has(pid) });
    assert.ok(performance.now() - at < 1000, 'within its bound');
    assert.deepEqual(killed, [[11, 'SIGKILL'], [12, 'SIGKILL']], 'a group already gone isn\'t signalled');
    assert.deepEqual(got, { before: [11, 12], after: [12] });
  } finally { process.kill = realKill; }
});

test('a groups file lists only its complete lines that each hold a whole number of 2 or more, for the drive\'s end and the pool\'s kill alike, so no line becomes a kill of the cleaner\'s own group or of every process it may signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-groups-'));
  const file = join(dir, 'groups');
  writeFileSync(file, '123\n   \n-5\n1\n0\n007\n456');
  const sent: Array<[number, string | number | undefined]> = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { sent.push([pid, sig]); return true; };
  let listed;
  try {
    listed = listedGroups(file);
    stopListedHosts(file);
  } finally { process.kill = realKill; }
  try {
    assert.deepEqual({ listed, sent }, { listed: [123], sent: [[-123, 'SIGKILL']] });
    assert.deepEqual(listedGroups(join(dir, 'none')), [], 'a missing file lists none');
    assert.throws(() => listedGroups(dir), /EISDIR/, 'a file that can\'t be read throws');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the drive\'s end fails the run where it can\'t read the fleet\'s groups file, naming why, so a leak can\'t go unseen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-groups-'));
  const file = join(dir, 'fleet.groups');
  mkdirSync(file);
  const failed: Array<{ step: null; reason: string }> = [];
  const logged: Array<[LogEntry['kind'], unknown]> = [];
  let unlisted = 0;
  try {
    await endFleetGroups({ file, fail: (f) => failed.push(f), log: (kind, e) => logged.push([kind, e]), unlist: () => { unlisted++; } });
    assert.equal(failed.length, 1);
    assert.match(failed[0].reason, /^the fleet's groups file couldn't be read, so the groups it lists weren't killed: EISDIR/);
    assert.deepEqual(logged, [['fleet-groups', { listed: [], before: [], after: [] }]]);
    assert.equal(unlisted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a drive stopped by a signal kills the groups listed in a file it was given, as it kills the hosts it started', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-signal-'));
  try {
    const groups = join(dir, 'fleet.groups');
    writeFileSync(join(dir, 'drive.ts'), [
      `import { spawn } from 'node:child_process';`,
      `import { appendFileSync } from 'node:fs';`,
      `import { spawnHost, stopListedToo } from ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), '..', 'common.ts'))};`,
      `const kid = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });`,
      `appendFileSync(${JSON.stringify(groups)}, kid.pid + '\\n');`,
      `stopListedToo(${JSON.stringify(groups)});`,
      `spawnHost({ hostDir: '/nonexistent', recipePath: '/r', dataDir: ${JSON.stringify(dir)}, cwd: ${JSON.stringify(dir)}, sockPath: '/s' });`,
      `console.log(kid.pid);`,
      `setTimeout(() => process.kill(process.pid, 'SIGTERM'), 200);`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'));
    const r = spawnSync('bun', [join(dir, 'drive.ts')], { encoding: 'utf-8', timeout: 15_000 });
    const kid = Number(r.stdout.trim().split('\n')[0]);
    assert.ok(kid > 0, r.stderr);
    assert.deepEqual([r.signal, (r.error as NodeJS.ErrnoException | undefined)?.code ?? null], ['SIGTERM', null], 'the drive ended by its SIGTERM, not by exiting or the timeout');
    // A killed process answers until it's reaped, which an orphan's new parent does in its own time.
    let gone = false;
    for (const end = Date.now() + 5000; !gone && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      try { process.kill(kid, 0); } catch { gone = true; }
    }
    if (!gone) try { process.kill(-kid, 'SIGKILL'); } catch {}
    assert.ok(gone, 'the listed group is gone once the drive has ended');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fleet run\'s end kills each group its host listed, though the run failed before its first step', { timeout: 30_000 }, async () => {
  // A `bun` that starts a process in a group of its own, lists it as the Date preload lists a fleet child, and exits
  // at once, stands in for the host. It lists the process once its group exists, as Bun.spawn's detached child leads
  // its group by the time the preload lists it.
  const bin = mkdtempSync(join(tmpdir(), 'fleet-end-'));
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nsetsid sleep 30 </dev/null >/dev/null 2>&1 &\nkid=$!\nfor i in $(seq 300); do kill -0 -$kid 2>/dev/null && break; sleep 0.01; done\necho $kid >> "$FIXTURE_GROUPS"\nexit 3\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const run = await driver.runScript({ steps: [], configuration: configurations().Hfleet, standin, hostDir: bin, facts: {}, work: join(bin, 'work'), storeDir: join(bin, 'store'), epoch: 0, logPath: join(bin, 'log.jsonl'), hostLogs: { dir: join(bin, 'logs'), at: 'logs' } });
    assert.equal(run.ok, false);
    const listed = readFileSync(join(bin, 'work', 'fleet.groups'), 'utf-8').split('\n').filter(Boolean).map(Number);
    assert.equal(listed.length, 1);
    const ended = readFileSync(join(bin, 'log.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === 'fleet-groups');
    assert.deepEqual([ended.listed, ended.before, ended.after], [listed, listed, []]);
    assert.equal(groupAlive(listed[0]), false, 'its group is gone');
  } finally {
    process.env.PATH = path;
    await standin.close();
    for (const pid of existsSync(join(bin, 'work', 'fleet.groups')) ? readFileSync(join(bin, 'work', 'fleet.groups'), 'utf-8').split('\n').filter(Boolean).map(Number) : []) try { process.kill(-pid, 'SIGKILL'); } catch {}
    rmSync(bin, { recursive: true, force: true });
  }
});

function w20Run({ relayResult = () => true, callError = () => false, pids = [{ src: 41, dst: 42 }, { src: 41, dst: 42 }] }: { relayResult?: (id: string) => boolean; callError?: (id: string) => boolean; pids?: Array<{ src: number | null; dst: number | null }> } = {}) {
  const w20 = runOf('Hfleet/W20', configurations(), {});
  const steps = w20.steps() as W20Step[];
  const relays = steps.flatMap((s) => (s.w20?.relays ?? []).map((id) => ({ step: s.id, id })));
  const calls = steps.filter((s) => s.w20).flatMap((s) => s.replies!.flatMap((r) => r.calls ?? []).map((c) => ({ step: s.id, id: c.id! })));
  const isError = (id: string) => (relays.some((r) => r.id === id) ? relayResult(id) : callError(id));
  const records = calls.map(({ step, id }, i) => ({ id: `r${i + 2}`, seq: i + 2, kind: 'agent', step, messages: [{ role: 'user', blocks: [{ type: 'tool_result', toolUseId: id, ...(isError(id) ? { isError: true } : {}) }] }] }) satisfies DeepPartial<RequestRecord>);
  const crash = steps.find((s) => s.kind === 'crash');
  const log = [
    { kind: 'fleet', boot: 1, children: Object.entries(pids[0]).map(([name, pid]) => ({ name, status: 'ready', pid })) },
    { kind: 'crash', step: crash!.id, boot: 1 },
    { kind: 'fleet', boot: 2, children: Object.entries(pids[1]).map(([name, pid]) => ({ name, status: 'ready', pid })) },
  ] satisfies DeepPartial<LogEntry>[];
  return { w20, run: { records, log } satisfies DeepPartial<Run> as unknown as Run, relays, crash };
}

test('W20 drives its parent through a refused round and its retry, four relays with nothing to pass on, a crash and a kill, and is a run', () => {
  assert.ok(RUNS.includes('Hfleet/W20'));
  const { w20, relays, crash } = w20Run();
  const steps = w20.steps();
  assert.deepEqual(steps.map((s) => s.id.split('.').slice(1).join('.')), ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(relays.map((r) => r.step.split('.')[1]), ['f1', 'f2', 'f4', 'f5']);
  assert.equal(crash!.id.split('.')[1], 'f3');
  assert.equal(steps[0].replies![0].stop, 'refusal');
  assert.ok(steps[0].replies![0].thinking && steps[0].replies![0].text, 'the refused round has thinking and text');
  assert.deepEqual(steps.find((s) => s.id.endsWith('.f4'))!.replies!.at(-1), {}, 'a turn whose last round is empty, after a tool round');
});

test('W20\'s property: each relay with nothing to pass on answers as an error, and the parent\'s boot after its crash adopts both children', () => {
  const ok = w20Run();
  const flags = ok.w20.check(ok.run);
  assert.deepEqual(flags, []);
  assert.equal((flags as Breaches).judged, 5);
  const relayed = w20Run({ relayResult: (id) => !id.includes('f2') });
  const got = relayed.w20.check(relayed.run);
  assert.equal(got.length, 1);
  assert.match(got[0].message, /^the relay toolu_w20f2\w+ answered as a success, where src's latest round had nothing to pass on/);
  const anew = w20Run({ pids: [{ src: 41, dst: 42 }, { src: 51, dst: 42 }] });
  assert.deepEqual(anew.w20.check(anew.run).map((f) => f.message), ['boot 2, after the parent\'s crash, started src anew (pid 41, then 51) rather than adopting it']);
  const unread = w20Run({ pids: [{ src: null, dst: 42 }, { src: null, dst: 42 }] });
  assert.match(unread.w20.check(unread.run)[0].message, /^couldn't judge the boot after the crash: src's pid wasn't read at both boots/);
  const missing = w20Run();
  missing.run.records = missing.run.records.slice(1);
  assert.match(missing.w20.check(missing.run)[0].message, /^couldn't judge: no request carried the result of the relay toolu_w20f1/);
  for (const [call, relay, tool] of [['toolu_w20f22', 'toolu_w20f23', 'await'], ['toolu_w20f51', 'toolu_w20f52', 'kill']]) {
    const unreached = w20Run({ callError: (id) => id === call });
    const flagged = unreached.w20.check(unreached.run);
    assert.deepEqual(flagged.map((f) => f.message), [`couldn't judge the relay ${relay}: its case wasn't reached, since fleet--${tool} ${call} before it answered as an error`]);
    assert.equal(flagged.judged, 4);
  }
});
