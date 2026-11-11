// @ts-nocheck
// run.ts --workloads: a module's runs join the view's for one invocation, and nothing of the view's moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurations } from './script.ts';
import { runOf } from './workloads.ts';
import { workloadsModule } from './workloads-module.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, '..', '..', 'run.ts');
const SYNTHETIC = join(HERE, '..', 'testing', 'synthetic-workloads.ts');
const dirs = [];
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const moduleFile = (text) => { const f = join(temp('module-'), 'module.ts'); writeFileSync(f, text); return f; };
const host = () => { const h = temp('host-'); writeFileSync(join(h, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host' })); return h; };
const runTs = (args) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf-8', timeout: 30_000 });
const W = '{ from: null, steps: () => [], check: () => [] }';

test('a workloads module is refused, saying why, where it lacks an export, names a run or workload the view has, has a workload that doesn\'t start from no checkpoint, or runs a workload not its own', async () => {
  for (const [text, said] of [
    ['export const WORKLOADS = {};', /doesn't export both WORKLOADS, an object of workloads, and RUNS, a list of run ids/],
    [`export const WORKLOADS = { W1: ${W} }; export const RUNS = [];`, /names workloads the view already has: W1/],
    [`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx', 'H1/W1'];`, /names runs the view already has: H1\/W1/],
    ['export const WORKLOADS = { Wx: { steps: () => [], check: () => [] } }; export const RUNS = [\'H1/Wx\'];', /a module's workload starts from no checkpoint, so it declares from: null, and Wx doesn't/],
    [`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx', 'H3/W1'];`, /runs workloads not its own: H3\/W1/],
  ]) await assert.rejects(workloadsModule(moduleFile(text)), said, text);
  await assert.rejects(workloadsModule(join(temp('none-'), 'missing.ts')), /--workloads .*missing\.ts can't be imported/);
});

test('a module\'s workloads join the view\'s for runOf: its run starts from no checkpoint with the stand-in setup it gives, and every view run is as without it', async () => {
  const { table, runs } = await workloadsModule(SYNTHETIC);
  assert.deepEqual(runs, ['H1/Wmod', 'C9h/Wmod']);
  const all = configurations();
  const job = runOf('H1/Wmod', all, {}, { workloads: table });
  assert.equal(job.from, null);
  assert.deepEqual(job.standin, { refreshes: true, summaryTokens: { 1: 300 } });
  assert.equal(job.configuration.agent.cacheKeepalive.enabled, true, 'its recipe over H1\'s');
  assert.deepEqual(job.steps().map((s) => s.kind), ['deliver', 'advance', 'deliver']);
  assert.throws(() => runOf('H1/Wmod', all, {}), /no run H1\/Wmod/, 'without its table the view knows no such run');
  for (const id of ['H1/W1', 'H1/continuation', 'H1/W7/merges-refused']) {
    const [mod, own] = [runOf(id, all, {}, { workloads: table }), runOf(id, all, {})];
    assert.deepEqual([mod.from, mod.standin, mod.steps()], [own.from, own.standin, own.steps()], id);
  }
});

test('run.ts --workloads: a module it refuses ends it before anything runs; with no --runs only the module\'s runs run; --runs takes its runs beside the view\'s; without the flag its runs are unknown', () => {
  const refused = runTs(['--workloads', moduleFile(`export const WORKLOADS = { W1: ${W} }; export const RUNS = [];`)]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /names workloads the view already has: W1/);
  const two = moduleFile(`export const WORKLOADS = { Wa: ${W}, Wb: ${W} }; export const RUNS = ['H1/Wa', 'H1/Wb'];`);
  const h = host();
  const share = (args) => /shard 1\/2: (\d+) of (\d+) runs/m.exec(runTs(['--host', h, '--shard', '1/2', '--workdir', join(temp('work-'), 'w'), ...args]).stdout);
  assert.deepEqual(share(['--workloads', two])?.slice(1), ['1', '2'], 'the module\'s two runs, not the view\'s');
  assert.deepEqual(share(['--workloads', two, '--runs', 'H1/Wa,H1/W1'])?.slice(1), ['1', '2'], 'a module run beside a view run');
  const unknown = runTs(['--host', h, '--runs', 'H1/Wa']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no run H1\/Wa;/);
  assert.equal(runTs(['--workloads']).status, 2, '--workloads needs a value');
});

test('a module\'s RUNS is refused, naming RUNS, where an id isn\'t CONFIGURATION/WORKLOAD[/VARIANT], where it names a run twice, and where two runs\' evidence would share a directory', async () => {
  for (const [text, said] of [
    [`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx/v/typo'];`, /RUNS has ids that aren't CONFIGURATION\/WORKLOAD or CONFIGURATION\/WORKLOAD\/VARIANT: H1\/Wx\/v\/typo/],
    [`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['Wx'];`, /RUNS has ids that aren't .*: Wx$/],
    [`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx', 'H1/Wx'];`, /RUNS names H1\/Wx more than once/],
    [`export const WORKLOADS = { W7_merges: ${W}, 'W7_merges-refused': ${W} }; export const RUNS = ['H1/W7_merges-refused'];`, /evidence would share a directory: H1\/W7_merges-refused and H1\/W7\/merges-refused/],
    [`export const WORKLOADS = { Wa_b: ${W}, Wa: ${W} }; export const RUNS = ['H1/Wa_b', 'H1/Wa/b'];`, /evidence would share a directory: H1\/Wa\/b and H1\/Wa_b/],
  ]) await assert.rejects(workloadsModule(moduleFile(text)), said, text);
  const refused = runTs(['--workloads', moduleFile(`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx', 'H1/Wx'];`)]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /RUNS names H1\/Wx more than once/, 'the module\'s RUNS, not --runs, which wasn\'t given');
});

test('a module is read by its bytes\' digest: a child given the digest its invocation read refuses a file changed since; run.ts refuses --update-seconds beside --workloads', async () => {
  const f = moduleFile(`export const WORKLOADS = { Wx: ${W} }; export const RUNS = ['H1/Wx'];`);
  const { digest } = await workloadsModule(f);
  assert.equal(digest, createHash('sha256').update(readFileSync(f)).digest('hex'));
  assert.ok(await workloadsModule(f, digest), 'the same bytes');
  writeFileSync(f, `${readFileSync(f, 'utf-8')}\n// changed\n`);
  await assert.rejects(workloadsModule(f, digest), new RegExp(`changed after this invocation read it: its bytes hash to [0-9a-f]{12}, not ${digest.slice(0, 12)}`));
  const timed = runTs(['--host', host(), '--workloads', f, '--update-seconds']);
  assert.equal(timed.status, 2);
  assert.match(timed.stderr, /--update-seconds writes the view's own timings to stack\.json, and a workloads module's runs aren't the view's/);
});

test('a module workload named null is no one\'s history: a run whose workload starts from no checkpoint has none', async () => {
  const { table } = await workloadsModule(moduleFile(`export const WORKLOADS = { null: { from: null, steps: () => [{ id: 'n', kind: 'advance', ms: 1000 }], check: () => [] }, Wx: { from: null, steps: () => [], check: () => [] } }; export const RUNS = ['H1/Wx'];`));
  const all = configurations();
  const job = runOf('H1/Wx', all, {}, { workloads: table });
  assert.equal(job.from, null);
  assert.deepEqual(job.steps(), [], 'Wx\'s own steps, with no history built before them');
  for (const id of ['H1/W1', 'H1/continuation']) assert.deepEqual(runOf(id, all, {}, { workloads: table }).steps(), runOf(id, all, {}).steps(), id);
});
