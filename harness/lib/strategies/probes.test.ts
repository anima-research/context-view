// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configWatched, hostFacts, reviewInterval } from './driver.ts';
import { configurations } from './script.ts';
import { HarnessFailure } from '../pool.ts';
import { workloadRun } from '../drive.ts';

const H1 = configurations().H1;

const probes = [
  {
    name: 'hostFacts',
    what: 'recipe facts',
    host: (put, body) => {
      put('src/model-limits.ts', 'export const getDefaultModelLimits = () => ({ maxContextTokens: 1000 });\n');
      put('src/framework-agent-config.ts', `${body}\nexport const buildFrameworkAgentConfig = () => ({ maxTokens: 7 });\n`);
    },
    ask: (hostDir, timeoutMs) => hostFacts({ hostDir, configuration: H1, ...(timeoutMs ? { timeoutMs } : {}) }),
    answers: (a) => a.window === 1000 && a.maxTokens === 7,
    ownAnswer: "console.log(JSON.stringify({ window: 1, streamBound: null, budget: null, maxTokens: 1 })); process.exit(0);",
  },
  {
    name: 'reviewInterval',
    what: "suppression review's interval",
    host: (put, body) => {
      put('src/gate-options.ts', `${body}\nexport const gateOptionsFor = () => ({ configPath: 'x' });\n`);
      put('node_modules/@animalabs/agent-framework/src/gate/suppression-review.ts', 'export const reviewSettings = (o = {}) => ({ intervalMs: o.intervalMs ?? 4_100_000 });\n');
    },
    ask: (hostDir, timeoutMs) => reviewInterval({ hostDir, configuration: H1, ...(timeoutMs ? { timeoutMs } : {}) }),
    answers: (a) => a === 4_100_000,
    ownAnswer: "console.log(JSON.stringify({ reviewMs: 5 })); process.exit(0);",
  },
  {
    name: 'configWatched',
    what: '_config mount',
    host: (put, body) => {
      put('src/workspace-mounts.ts', `${body}\nexport function buildWorkspaceMounts(workspace, storePath) { return [{ name: '_config', path: storePath + '/config', watch: 'always', include: ['gate.json'] }]; }\n`);
      put('node_modules/@animalabs/agent-framework/src/modules/workspace/watcher.ts', '');
    },
    ask: (hostDir, timeoutMs) => configWatched({ hostDir, configuration: { ...H1, modules: { ...H1.modules, workspace: { configMount: true } } }, ...(timeoutMs ? { timeoutMs } : {}) }),
    answers: (a) => Array.isArray(a?.include) && a.include.join() === 'gate.json',
    ownAnswer: "console.log(JSON.stringify({ watched: null })); process.exit(0);",
  },
];

function hostWith(probe, body) {
  const dir = mkdtempSync(join(tmpdir(), `cv-probe-host-${probe.name}-`));
  const put = (rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
  probe.host(put, body);
  return dir;
}

test('each probe takes the host\'s answer only from the harness\'s own file: a host that prints an answer of its own and ends gives none, and one that writes to stdout with no line break still answers', () => {
  for (const probe of probes) {
    const printing = hostWith(probe, probe.ownAnswer);
    try {
      assert.throws(() => probe.ask(printing), /bun exited 0/, `${probe.name}: what the host printed isn't the answer`);
    } finally { rmSync(printing, { recursive: true, force: true }); }
    const noisy = hostWith(probe, "process.stdout.write('loaded');");
    try {
      assert.ok(probe.answers(probe.ask(noisy)), `${probe.name}: the host's own output doesn't break the answer`);
    } finally { rmSync(noisy, { recursive: true, force: true }); }
  }
});

test('a probe whose host ignores SIGTERM and hangs is killed at the bound, and the probe says so', () => {
  for (const probe of probes) {
    const mark = join(tmpdir(), `cv-probe-hanging-${probe.name}-${process.pid}`);
    const survived = `${mark}-survived`;
    const dir = hostWith(probe, `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(mark)}, ''); const until = Date.now() + 30_000; while (Date.now() < until) {} writeFileSync(${JSON.stringify(survived)}, ''); process.exit(3);`);
    try {
      let shown = false;
      for (const timeoutMs of [500, 10_000]) {
        rmSync(mark, { force: true });
        assert.throws(() => probe.ask(dir, timeoutMs), new RegExp(`bun was killed at the bound of ${timeoutMs} ms`), probe.name);
        assert.ok(!existsSync(survived), `${probe.name}: bun outlived the kill at the bound`);
        if (existsSync(mark)) { shown = true; break; }
      }
      assert.ok(shown, `${probe.name}: bun never reached the host's module, so the kill shows nothing about a handler in place`);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(mark, { force: true }); rmSync(survived, { force: true }); }
  }
});

test('an answer bun wrote before it was killed, at the bound or for its output, is still the answer', () => {
  for (const probe of probes) {
    const mark = join(tmpdir(), `cv-probe-answered-${probe.name}-${process.pid}`);
    const held = hostWith(probe, `import { writeFileSync } from 'node:fs'; process.on('exit', () => { writeFileSync(${JSON.stringify(mark)}, ''); const until = Date.now() + 30_000; while (Date.now() < until) {} });`);
    try {
      let shown = false;
      for (const timeoutMs of [500, 10_000]) {
        rmSync(mark, { force: true });
        let answer;
        try { answer = probe.ask(held, timeoutMs); } catch (e) {
          assert.ok(!existsSync(mark) && new RegExp(`bun was killed at the bound of ${timeoutMs} ms`).test(e.message), `${probe.name}: ${e.message}`);
          continue;
        }
        assert.ok(existsSync(mark) && probe.answers(answer), `${probe.name}: answered before the kill at ${timeoutMs} ms`);
        shown = true;
        break;
      }
      assert.ok(shown, `${probe.name}: bun never answered before the bound`);
    } finally { rmSync(held, { recursive: true, force: true }); rmSync(mark, { force: true }); }
    const flooding = hostWith(probe, "import { writeSync } from 'node:fs'; process.on('exit', () => { writeSync(1, 'x'.repeat(2 * 1024 * 1024)); const until = Date.now() + 30_000; while (Date.now() < until) {} });");
    try {
      assert.ok(probe.answers(probe.ask(flooding, 10_000)), `${probe.name}: answered before printing past the output kept`);
    } finally { rmSync(flooding, { recursive: true, force: true }); }
  }
});

test('a probe whose host prints more than the output kept has its bun killed, and the probe says so rather than failing the invocation', () => {
  for (const probe of probes) {
    const dir = hostWith(probe, "import { writeSync } from 'node:fs'; writeSync(1, 'x'.repeat(2 * 1024 * 1024)); for (;;) {}");
    try {
      assert.throws(() => probe.ask(dir), (e) => !(e instanceof HarnessFailure) && /bun was killed for printing more than the 1048576 bytes kept of its output/.test(e.message), probe.name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a probe\'s bun ended by a signal the harness didn\'t send fails the invocation, as any of its child processes would', () => {
  for (const probe of probes) {
    const dir = hostWith(probe, "process.kill(process.pid, 'SIGKILL');");
    try {
      assert.throws(() => probe.ask(dir), (e) => e instanceof HarnessFailure && e.message === `the host's ${probe.what} (bun) was ended by SIGKILL`, probe.name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a run whose host\'s facts bun was ended by a signal the harness didn\'t send fails the invocation, not just the run', async () => {
  const dir = hostWith(probes[0], "process.kill(process.pid, 'SIGKILL');");
  try {
    await assert.rejects(workloadRun({ id: 'H1/W1', candidate: { hostDir: dir }, dir: join(dir, 'out'), scratch: join(dir, 'scratch'), out: dir }), (e) => e instanceof HarnessFailure && /recipe facts \(bun\) was ended by SIGKILL/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
