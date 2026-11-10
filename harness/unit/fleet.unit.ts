// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachAttach, reachLaunch } from '../lib/reach.ts';
import { FLEET_SUBSCRIPTION, fleetChildren, fleetReady, laneRecipe } from '../lib/strategies/driver.ts';
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
