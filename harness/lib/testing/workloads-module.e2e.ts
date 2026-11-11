// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReleaseFrom } from '../drive.ts';
import { driveScratch } from '../strategies/compare.ts';
import { WORKLOADS } from './synthetic-workloads.ts';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPOSITORY = 'https://github.com/anima-research/connectome-host.git';
const { release } = JSON.parse(readFileSync(join(HARNESS, 'stack.json'), 'utf-8'));
const requestBodies = (dir) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, String(f)), 'utf-8'))).filter((b) => Array.isArray(b?.messages));

// The test's work is synchronous, so node:test's own timeout couldn't interrupt it; its subprocesses bound it instead,
// each ended by SIGTERM at its own limit: the clone's 300 s and `npm ci`'s 900 s (drive.ts), and the drive's 300 s,
// whose run.ts takes its own children down on SIGTERM.
test(`a workloads module's run, on connectome-host ${release}, takes each step kind and field a replay's generator emits to its effect in the record`, () => {
  const t = mkdtempSync(join(tmpdir(), 'workloads-module-'));
  try {
    const host = installReleaseFrom({ repository: REPOSITORY, dir: join(t, 'host'), tag: release });
    const out = join(t, 'out');
    const own = join(t, 'tmp');
    mkdirSync(own);
    const ran = spawnSync(process.execPath, [join(HARNESS, 'run.ts'), '--host', host.hostDir, '--workloads', join(HARNESS, 'lib', 'testing', 'synthetic-workloads.ts'), '--workdir', join(t, 'work'), '--out', out], { encoding: 'utf-8', timeout: 300_000, env: { ...process.env, TMPDIR: own } });
    assert.equal(ran.status, 0, `run.ts exited ${ran.status}:\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-3000)}`);
    assert.deepEqual(readdirSync(own).filter((f) => f.startsWith('harness-workloads-module-copy-')), [], 'no copy of the module outlives the invocation');
    const record = readFileSync(join(out, 'H1_Wmod', 'H1_Wmod.record'), 'utf-8');
    const step = (name) => {
      const at = record.search(new RegExp(`^step \\d+\\.${name}$`, 'm'));
      assert.ok(at >= 0, `the record has step ${name}:\n${record}`);
      const rest = record.slice(at).split('\n');
      return rest.slice(1, rest.slice(1).findIndex((l) => !l.startsWith('  ')) + 1);
    };
    const [w1, gap, w2] = [step('w1'), step('gap'), step('w2')];
    const compiles = w1.filter((l) => l.startsWith('  compile '));
    assert.equal(compiles.length, 1, `one request starts wake 1:\n${w1.join('\n')}`);
    assert.match(compiles[0], /\d+\.w1\.d1-\d+\.w1\.in/, 'the deferred arrival rides the request its trigger starts');
    assert.ok(w1.some((l) => /^ {2}round \+ \d+\.w1\.r1 \d+\.w1\.call1,/.test(l)), `the call's round:\n${w1.join('\n')}`);
    assert.ok(w1.some((l) => /^ {2}speech \d+\.w1\.r2$/.test(l)), 'the closing reply\'s speech');
    const bodies = requestBodies(join(driveScratch(join(t, 'work'), 'H1/Wmod', true), 'raw'));
    const carrying = bodies.find((b) => b.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result' && JSON.stringify(x).includes('.w1.call1]]'))));
    assert.ok(carrying, `a request carries the call's result, among ${bodies.length} request bodies`);
    const answered = carrying.messages.filter((m) => m.role === 'assistant').flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const seed = /^step (\d+)\.w1$/m.exec(record)[1];
    const [first] = WORKLOADS.Wmod.steps({ seed })[0].replies;
    assert.ok(answered.some((x) => x.type === 'thinking' && x.thinking === first.thinking), `the call's reply carries its thinking whole, as scripted:\n${JSON.stringify(answered).slice(0, 2000)}`);
    const scripted = first.calls[0].input;
    const call = answered.find((x) => x.type === 'tool_use' && JSON.stringify(x.input).includes('.w1.call1]]'));
    assert.deepEqual(call?.input, scripted, `the call carries its whole input, pad included, as scripted:\n${JSON.stringify(answered).slice(0, 2000)}`);
    const texts = bodies.flatMap((b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]))).filter((x) => x.type === 'text').map((x) => String(x.text));
    for (const [who, part] of [['Ash', 'd1'], ['Tavy', 'in']]) assert.ok(texts.some((s) => new RegExp(`(^|\\n)user: ${who}: \\[\\[c:${seed}\\.w1\\.${part}\\]\\]`).test(s)), `${who}'s message reaches the agent under that name:\n${texts.filter((s) => s.includes('.w1.')).map((s) => s.slice(0, 120)).join('\n')}`);
    assert.ok(gap.some((l) => /^ {2}ask \[keepalive\] .+ -> refresh,/.test(l)), `a keepalive refresh during the advance, answered as one:\n${gap.join('\n')}`);
    const clock = (lines) => /\(\d{4},\d\d,\d\d,(\d\d),(\d\d)\)|\((\d\d),(\d\d)\)/.exec(lines.find((l) => l.startsWith('  compile ')) ?? '');
    const minutes = (m) => (m[1] ? +m[1] * 60 + +m[2] : +m[3] * 60 + +m[4]);
    assert.equal(minutes(clock(w2)) - minutes(clock(w1)), 50, `wake 2 starts 50 minutes after wake 1:\n${w1[0]}\n${w2[0]}`);
    assert.ok(w2.some((l) => /^ {2}speech \d+\.w2\.r1$/.test(l)), 'wake 2\'s reply');
    assert.match(record, /^end ok$/m);
    const report = readFileSync(join(out, 'H1_Wmod', 'report.txt'), 'utf-8');
    assert.match(report, /^- budget headroom, each segment's least: Wmod \d+ of \d+ /m, `the report's headroom names the steps' segment:\n${report}`);
    const frontdesk = readFileSync(join(out, 'C9h_Wmod', 'C9h_Wmod.record'), 'utf-8');
    assert.match(frontdesk, /topic "Wmod"/, `the frontdesk run's headers name the delivered messages' topic:\n${frontdesk.slice(0, 3000)}`);
    assert.match(frontdesk, /^end ok$/m);
  } finally { rmSync(t, { recursive: true, force: true }); }
});
