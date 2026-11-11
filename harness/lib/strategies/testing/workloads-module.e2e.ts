// @ts-nocheck
// The workloads module's guard (README, "Running it", --workloads): it drives testing/fixtures/workloads-module.ts,
// which uses every step kind and field a replay's generator emits, against stack.json's release, and asserts each
// field's effect in the record, the report, or a request body the stand-in kept. The driver ignores a step field it
// doesn't know, so a renamed or dropped field fails here, not silently in a replay. The module's stand-in options are
// held by name: startStandin refuses one it doesn't take, failing the drive, and their tests in
// lib/standin/standin.test.ts hold their effects. It installs the release itself, so it needs no host given, and fails
// where the release can't be installed. scripts/test.sh runs it as its `module` part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReleaseFrom } from '../../drive.ts';
import { driveScratch } from '../compare.ts';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPOSITORY = 'https://github.com/anima-research/connectome-host.git';
const { release } = JSON.parse(readFileSync(join(HARNESS, 'stack.json'), 'utf-8'));
// Every request body a drive sent, as the stand-in kept it: what a request carried that no record line shows.
const requestBodies = (dir) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, String(f)), 'utf-8'))).filter((b) => Array.isArray(b?.messages));

test(`a workloads module's run, on connectome-host ${release}, takes each step kind and field a replay's generator emits to its effect in the record`, { timeout: 600_000 }, () => {
  const t = mkdtempSync(join(tmpdir(), 'workloads-module-'));
  try {
    const host = installReleaseFrom({ repository: REPOSITORY, dir: join(t, 'host'), tag: release });
    const out = join(t, 'out');
    const ran = spawnSync(process.execPath, [join(HARNESS, 'run.ts'), '--host', host.hostDir, '--workloads', join(HARNESS, 'lib', 'strategies', 'testing', 'fixtures', 'workloads-module.ts'), '--workdir', join(t, 'work'), '--out', out], { encoding: 'utf-8', timeout: 300_000 });
    // run.ts writes a run's flags to stdout and the invocation's failures to stderr.
    assert.equal(ran.status, 0, `run.ts exited ${ran.status}:\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-3000)}`);
    const record = readFileSync(join(out, 'H1_Wmod', 'H1_Wmod.record'), 'utf-8');
    const step = (name) => {
      const at = record.search(new RegExp(`^step \\d+\\.${name}$`, 'm'));
      assert.ok(at >= 0, `the record has step ${name}:\n${record}`);
      const rest = record.slice(at).split('\n');
      return rest.slice(1, rest.slice(1).findIndex((l) => !l.startsWith('  ')) + 1);
    };
    const [w1, gap, w2] = [step('w1'), step('gap'), step('w2')];
    // deliver: messages on a channel whose wake rule defers them start no request; the next message's wake carries them.
    const compiles = w1.filter((l) => l.startsWith('  compile '));
    assert.equal(compiles.length, 1, `one request starts wake 1:\n${w1.join('\n')}`);
    assert.match(compiles[0], /\d+\.w1\.d1-\d+\.w1\.in/, 'the deferred arrival rides the request its trigger starts');
    // replies, with calls: the first reply's call to the fixture's tool comes back as a round, and the second is spoken.
    assert.ok(w1.some((l) => /^ {2}round \+ \d+\.w1\.r1 \d+\.w1\.call1,/.test(l)), `the call's round:\n${w1.join('\n')}`);
    assert.ok(w1.some((l) => /^ {2}speech \d+\.w1\.r2$/.test(l)), 'the closing reply\'s speech');
    // a reply's thinking, and the size a call's input carries (`pad`, which the fixture's tool doesn't read): no record line
    // shows either, so the request carrying the call's result, as the stand-in kept its body, holds both.
    const bodies = requestBodies(join(driveScratch(join(t, 'work'), 'H1/Wmod', true), 'raw'));
    const carrying = bodies.find((b) => b.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result' && JSON.stringify(x).includes('.w1.call1]]'))));
    assert.ok(carrying, `a request carries the call's result, among ${bodies.length} request bodies`);
    const answered = carrying.messages.filter((m) => m.role === 'assistant').flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    assert.ok(answered.some((x) => x.type === 'thinking' && String(x.thinking).includes('.w1.th1]]')), `the call's reply carries its thinking:\n${JSON.stringify(answered).slice(0, 2000)}`);
    assert.ok(answered.some((x) => x.type === 'tool_use' && JSON.stringify(x.input).includes('.w1.pad]]')), `the call carries its whole input:\n${JSON.stringify(answered).slice(0, 2000)}`);
    // advance: the clock moves by its ms (50 minutes), past the keepalive's refresh, which `refreshes` answers.
    assert.ok(gap.some((l) => /^ {2}ask \[keepalive\] /.test(l)), `a keepalive refresh during the advance:\n${gap.join('\n')}`);
    const clock = (lines) => /\(\d{4},\d\d,\d\d,(\d\d),(\d\d)\)|\((\d\d),(\d\d)\)/.exec(lines.find((l) => l.startsWith('  compile ')) ?? '');
    const minutes = (m) => (m[1] ? +m[1] * 60 + +m[2] : +m[3] * 60 + +m[4]);
    assert.equal(minutes(clock(w2)) - minutes(clock(w1)), 50, `wake 2 starts 50 minutes after wake 1:\n${w1[0]}\n${w2[0]}`);
    assert.ok(w2.some((l) => /^ {2}speech \d+\.w2\.r1$/.test(l)), 'wake 2\'s reply');
    assert.match(record, /^end ok$/m);
    // segment: check 3 names the segment of each kind's least budget headroom in the run's report, which its checks read.
    const report = readFileSync(join(out, 'H1_Wmod', 'report.txt'), 'utf-8');
    assert.match(report, /^- budget headroom, each segment's least: Wmod \d+ of \d+ /m, `the report's headroom names the steps' segment:\n${report}`);
    // topic: under frontdesk (C9h) each delivered message's provenance header names its topic.
    const frontdesk = readFileSync(join(out, 'C9h_Wmod', 'C9h_Wmod.record'), 'utf-8');
    assert.match(frontdesk, /topic "Wmod"/, `the frontdesk run's headers name the delivered messages' topic:\n${frontdesk.slice(0, 3000)}`);
    assert.match(frontdesk, /^end ok$/m);
  } finally { rmSync(t, { recursive: true, force: true }); }
});
