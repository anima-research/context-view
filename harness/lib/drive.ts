import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './common.ts';
import { HarnessFailure } from './pool.ts';
import { pricesOf } from './prices.ts';
import { installCandidate } from './install.ts';
import { EPOCH, asRun, stackVersions } from './strategies/lane.ts';
import { runScript } from './strategies/driver.ts';
import { hostFacts } from './strategies/probes.ts';
import { seedOf, startStandin } from './standin/standin.ts';
import { judge, judgedAgent } from './strategies/judge.ts';
import { FIXTURE_AGENT } from './strategies/checks.ts';
import { buildRestsOnArrival, comparableFlags, namedReport, unmeasuredOfRun, workloadReport } from './strategies/report.ts';
import { CHECKPOINT_GAP_MS, runOf } from './workloads/workloads.ts';
import { workloadsModule } from './workloads/workloads-module.ts';
import { configurations } from './strategies/script.ts';
import { recordEpochNames } from './record.ts';
import { asWritten } from './strategies/control.ts';
import { cutError } from './cut/interfaces.ts';
import type { Seed, RequestRecord } from './standin/standin.ts';
import type { LogEntry } from './strategies/driver.ts';
import type { Facts } from './workloads/workloads.ts';
import type { Report } from './strategies/report.ts';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
const stack = JSON.parse(readFileSync(join(HARNESS, 'stack.json'), 'utf-8'));
const all = configurations();
const runOptions = { prefixTurns: stack.prefixTurns ?? {} };
const HELD_CLOSE_ON_WAIT = process.env.WHOLE_HOST_HELD_CLOSE_ON_WAIT === '1';

export class SignalDeath extends Error {
  declare boot: number;
  declare signal: NodeJS.Signals;
  constructor({ boot, signal }: { boot: number; signal: NodeJS.Signals }) {
    super(`the host (boot ${boot}) was ended by ${signal}`);
    this.boot = boot;
    this.signal = signal;
  }
}

export const npmCi = (cwd: string) => sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, timeout: 900_000 });

export function installRelease({ hostDir, dir, tag }: { hostDir: string; dir: string; tag: string }) {
  const repository = String(JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf-8')).repository?.url ?? '').replace(/^git\+/, '');
  if (!repository) throw new Error('package.json names no repository to clone the release from');
  return installReleaseFrom({ repository, dir, tag });
}

export function installReleaseFrom({ repository, dir, tag }: { repository: string; dir: string; tag: string }) {
  sh('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, '--', repository, dir], { timeout: 300_000 });
  npmCi(dir);
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir }) };
}

export const installCandidateIn = ({ root, packs, dir, leaveOut, forced }: Omit<Parameters<typeof installCandidate>[0], 'npmCi'>) => installCandidate({ root, packs, dir, leaveOut, npmCi, forced });

export const factsOf = ({ hostDir, configuration }: { hostDir: string; configuration: string }) => hostFacts({ hostDir, configuration: all[configuration] });

export const windowOf = ({ hostDir, from, facts }: { hostDir: string; from: string; facts: Facts }) => hostFacts({ hostDir, configuration: runOf(from, all, facts, runOptions).configuration }).window ?? null;

export const readJsonLines = (path: string): unknown[] => (existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l, asWritten)) : []);

const wantedIn = (realRoots: string[]) => (path: string) => {
  let at = path;
  try { at = realpathSync(path); } catch {}
  return realRoots.some((r) => at.startsWith(`${r}${sep}`) && !relative(r, at).split(sep).includes('node_modules'));
};

export type Job = ReturnType<typeof runOf>;
export type HostLogs = { dir: string; at: string };
export type Profiled = { logDir: string; realRoots: string[] };
async function drive(job: Job, side: { hostDir: string }, { window, storeDir, epoch, dir, scratch = dir, rawDir = null, hostLogs, profiled = null, seed = null }: { window?: number | null; storeDir: string; epoch: number; dir: string; scratch?: string; rawDir?: string | null; hostLogs: HostLogs; profiled?: Profiled | null; seed?: Seed | null }) {
  const own = hostFacts({ hostDir: side.hostDir, configuration: job.configuration });
  const facts = window === undefined ? own : { ...own, window };
  const configuration = asRun(job.configuration, facts);
  rmSync(dir, { recursive: true, force: true });
  if (rawDir) rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  const standin = await startStandin({ configuration, ...job.standin, ...(rawDir ? { rawDir } : {}), runDir: scratch, seed, heldCloseOnWait: HELD_CLOSE_ON_WAIT });
  const logPath = join(dir, 'log.jsonl');
  const steps = job.steps();
  let run;
  let records: RequestRecord[];
  try {
    run = await runScript({ steps, configuration, standin, hostDir: side.hostDir, facts, work: join(scratch, 'work'), storeDir, epoch, logPath, hostLogs, runDir: scratch, reach: profiled && { logDir: profiled.logDir, wanted: wantedIn(profiled.realRoots) } });
  } finally {
    records = await standin.close();
    const faults = standin.faults();
    if (faults !== null) writeFileSync(join(dir, 'faults.json'), JSON.stringify(faults));
  }
  if (run.signalled) throw new SignalDeath(run.signalled);
  writeFileSync(join(dir, 'records.json'), JSON.stringify(records));
  return { run, records, log: readJsonLines(logPath) as LogEntry[], steps, configuration, seed: standin.seed() };
}

export async function buildCheckpoint({ from, facts, side, window, dir, hostLogs }: { from: string; facts: Facts; side: { hostDir: string }; window?: number | null; dir: string; hostLogs: HostLogs }) {
  const job = runOf(from, all, facts, runOptions);
  const d = await drive(job, side, { window, storeDir: join(dir, 'store'), epoch: EPOCH, dir, rawDir: join(dir, 'raw'), hostLogs });
  mkdirSync(join(dir, 'answers'), { recursive: true });
  for (const f of readdirSync(join(dir, 'raw'))) if (/\.answer\.json$/.test(f)) renameSync(join(dir, 'raw', f), join(dir, 'answers', f));
  rmSync(join(dir, 'raw'), { recursive: true, force: true });
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(d.seed));
  return checkpointOutcome(d);
}

export const runUnmeasured = (report: Report, { completed, records, log }: { completed: boolean; records: RequestRecord[]; log: LogEntry[] }) => unmeasuredOfRun(report, { completed, records, log }).map(recordEpochNames(log, records));

export function checkpointOutcome({ run, records, log }: { run: Ran; records: RequestRecord[]; log: LogEntry[] }) {
  const rests = run.ok ? buildRestsOnArrival(records, log) : [];
  if (rests.length) return { ok: false, failure: { reason: `what its build leaves rests on arrival: ${rests.join('; ')}` }, clockEnd: run.clockEnd };
  return { ok: run.ok, failure: run.failure ?? null, clockEnd: run.clockEnd };
}

type Ran = Awaited<ReturnType<typeof runScript>>;
type Drive = Awaited<ReturnType<typeof drive>>;
export type CheckpointGiven = { from: string } & ({ failed: string; failedFull?: string; storeDir?: undefined; clockEnd?: undefined; seed?: undefined } | { failed?: undefined; failedFull?: undefined; storeDir: string; clockEnd: number; seed: string });
export type RunSpec = { id: string; recording?: boolean; candidate: { hostDir: string; installDir: string }; checkpoint?: CheckpointGiven | null; dir: string; rawDir?: string | null; scratch: string; out: string; profiled?: Profiled | null; workloads?: string | null; workloadsDigest?: string | null };
type Driven = { couldnt: string; couldntFull?: string; job?: undefined } | { couldnt?: undefined; couldntFull?: undefined; job: Job; d: Drive; scratch: string; storeDir: string };
async function driven({ id, recording = true, candidate, checkpoint, dir, rawDir = null, scratch, out, profiled = null, workloads = null, workloadsDigest = null }: RunSpec): Promise<Driven> {
  try {
    const table = workloads === null ? {} : { workloads: (await workloadsModule(workloads, workloadsDigest)).table };
    const job = runOf(id, all, hostFacts({ hostDir: candidate.hostDir, configuration: all[id.split('/')[0]] }), { ...runOptions, ...table });
    if (!recording) job.configuration = { ...job.configuration, recording: false };
    let epoch = EPOCH;
    let seed = null;
    const storeDir = join(scratch, 'store');
    if (job.from) {
      const cp: CheckpointGiven | { failed: string; failedFull?: undefined } = checkpoint?.from === job.from ? checkpoint : { failed: `the harness gave the run the checkpoint ${checkpoint?.from ?? 'none'}` };
      if (cp.failed !== undefined) return { couldnt: `its checkpoint ${job.from} failed: ${cp.failed}`, ...(cp.failedFull ? { couldntFull: `its checkpoint ${job.from} failed: ${cp.failedFull}` } : {}) };
      cpSync(cp.storeDir, storeDir, { recursive: true });
      epoch = cp.clockEnd + CHECKPOINT_GAP_MS;
      try { seed = seedOf(readFileSync(cp.seed, 'utf-8')); } catch (e) { throw new Error(`its checkpoint ${job.from}'s seed.json can't be read: ${(e as Error).message}`); }
    }
    return { job, d: await drive(job, candidate, { storeDir, epoch, dir, scratch, rawDir, hostLogs: { dir, at: relative(out, dir) }, profiled, seed }), scratch, storeDir };
  } catch (e) {
    if (e instanceof SignalDeath || e instanceof HarnessFailure) throw e;
    const c = cutError(e, 2000);
    return { couldnt: c.shown, ...(c.full ? { couldntFull: c.full } : {}) };
  }
}

export async function drivenOff(spec: RunSpec) {
  const off = await driven({ ...spec, recording: false });
  if (off.couldnt !== undefined) return { couldnt: off.couldnt, ...(off.couldntFull ? { couldntFull: off.couldntFull } : {}) };
  return { d: { run: off.d.run, log: off.d.log }, scratch: off.scratch };
}

export async function workloadRun(spec: RunSpec) {
  const { id, dir, candidate } = spec;
  const run = await driven(spec);
  if (run.couldnt !== undefined) return { outcome: 'couldnt-run', reason: run.couldnt, ...(run.couldntFull ? { reasonFull: run.couldntFull } : {}) };
  const { job, d, scratch, storeDir } = run;
  const copy = join(scratch, 'judged-store');
  cpSync(storeDir, copy, { recursive: true });
  const sessions = existsSync(join(copy, 'sessions')) ? readdirSync(join(copy, 'sessions')).map((s) => join(copy, 'sessions', s)) : [];
  let judged;
  try {
    judged = await judge({ records: d.records, log: d.log, script: d.steps, storeCopy: sessions[0] ?? null, configuration: d.configuration, installDir: candidate.installDir, run: d.run, declared: job.products, compresses: job.compresses });
  } catch (e) { const c = cutError(e, 2000); return { outcome: 'couldnt-run', reason: `the run couldn't be judged: ${c.shown}`, ...(c.full ? { reasonFull: `the run couldn't be judged: ${c.full}` } : {}) }; }
  const breaches = d.run.ok ? job.check({ log: d.log, records: d.records }) : [];
  const report = namedReport(workloadReport({ id, workload: job.workload, owns: job.owns, judged, breaches, completed: d.run.ok, contextUnread: (d.records.find((r) => r.contextUnread)?.contextUnread as string | undefined) ?? null }), d.log, recordEpochNames(d.log, d.records));
  try { writeFileSync(join(dir, 'report.txt'), `${report.lines.join('\n')}\n`); } catch (e) { throw new HarnessFailure(`${id}'s report.txt couldn't be written: ${(e as Error).message}`); }
  const prices = pricesOf({ hostDir: candidate.hostDir, records: d.records, dir: scratch });
  try { writeFileSync(join(dir, 'prices.json'), `${JSON.stringify(prices)}\n`); } catch (e) { throw new HarnessFailure(`${id}'s prices.json couldn't be written: ${(e as Error).message}`); }
  return {
    reported: true,
    outcome: report.verdict === 'pass' ? 'pass' : report.verdict,
    failures: report.flags,
    flagged: comparableFlags(report),
    unmeasured: runUnmeasured(report, { completed: d.run.ok, records: d.records, log: d.log }),
    lines: report.lines,
    judged: report.judged,
    log: d.log,
    records: d.records,
    prices,
    end: { ok: d.run.ok, reason: d.run.failure?.reason === undefined ? undefined : recordEpochNames(d.log, d.records)(d.run.failure.reason) },
    from: job.from ?? 'empty',
    steps: d.steps,
    agent: (() => { try { return judgedAgent(d.configuration, d.log).agent; } catch { return d.configuration.agent?.name ?? FIXTURE_AGENT; } })(),
  };
}
