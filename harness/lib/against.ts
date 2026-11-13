import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readsFailed } from './strategies/ledger.ts';
import type { Flag, Flags, Release, RunJson, RunResult, Runtime, Versions } from './shapes/interfaces.ts';
import type { LogEntry as DriverLogEntry } from './strategies/driver.ts';

export interface Against { dir: string; release?: Release; upgrades?: Release[]; result: (id: string) => RunResult | undefined }
interface LogEntry { kind?: string; stretch?: string; [field: string]: unknown }

export const slug = (id: string) => id.replaceAll('/', '_');
export const recordPath = (dir: string, id: string) => join(dir, slug(id), `${slug(id)}.record`);

const under = (r: Partial<Runtime> | null | undefined) => `Node ${r?.node ?? '?'} on ${r?.platform ?? '?'} ${r?.arch ?? '?'}`;

export function readAgainst(dir: string, { lane, runs, names, runtime, workloads = null }: { lane: string; runs: string[]; names: string[]; runtime: Runtime; workloads?: string | null }): Against {
  const file = join(dir, 'run.json');
  if (!existsSync(file)) throw new Error(`--against ${dir} holds no run.json: it isn't the --out of a base arm that finished`);
  let base: Partial<RunJson>;
  try { base = JSON.parse(readFileSync(file, 'utf-8')); } catch (e) { throw new Error(`--against ${file} couldn't be read: ${(e as Error).message}`); }
  if (base.lane !== lane) throw new Error(`--against ${dir} was written by the harness at lane ${String(base.lane).slice(0, 12)}, and this one is ${lane.slice(0, 12)}, so their records can't be compared`);
  if (under(base.runtime) !== under(runtime)) throw new Error(`--against ${dir} ran under ${under(base.runtime)}, and this invocation under ${under(runtime)}, so their records can't be compared`);
  const theirModule = base.workloads?.sha256 ?? null;
  if (theirModule !== workloads) throw new Error(`--against ${dir} ran ${theirModule ? `the workloads module ${theirModule.slice(0, 12)}` : 'no workloads module'}, and this invocation ${workloads ? `the workloads module ${workloads.slice(0, 12)}` : 'none'}, so their records can't be compared`);
  const theirs = Array.isArray(base.runs) ? base.runs : [];
  if (theirs.join(',') !== runs.join(',')) throw new Error(`--against ${dir} drew its shares from ${theirs.join(', ') || 'no runs'}, and this invocation from ${runs.join(', ')}: give both arms the same --runs`);
  const results = Array.isArray(base.results) ? base.results : [];
  const ran = results.map((r) => r.run);
  if (ran.length !== names.length || names.some((n) => !ran.includes(n))) throw new Error(`--against ${dir} ran ${ran.join(', ') || 'no runs'}, and this share runs ${names.join(', ')}: give both arms the same --shard and --drives`);
  const lost = results.filter((r) => r.record != null && !existsSync(recordPath(dir, r.run)));
  if (lost.length) throw new Error(`--against ${dir}'s run.json says ${lost.map((r) => r.run).join(', ')} wrote a record, and ${lost.map((r) => relative(dir, recordPath(dir, r.run))).join(', ')} isn't there`);
  const byRun = new Map(results.map((r) => [r.run, r] as const));
  return { dir, release: base.release, upgrades: Array.isArray(base.upgrades) ? base.upgrades : [], result: (id) => byRun.get(id) };
}

const named = (versions: Versions | null | undefined) => Object.entries(versions ?? {}).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

export function releaseDiffers(against: Against, release: Release) {
  if (JSON.stringify(against.release) === JSON.stringify(release)) return null;
  return `--against ${against.dir} made its checkpoints with ${against.release?.tag ?? 'no release'} (${named(against.release?.versions)}), and this invocation with ${release.tag} (${named(release.versions)}), so the two arms' runs wouldn't start from the same stores`;
}

const byTag = (list: Release[]) => [...list].sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));

export function upgradesDiffer(against: Against, upgrades: Release[]) {
  const theirs = byTag(against.upgrades ?? []);
  const ours = byTag(upgrades);
  if (JSON.stringify(theirs) === JSON.stringify(ours)) return null;
  const said = (list: Release[]) => (list.length ? list.map((u) => `${u.tag} (${named(u.versions)})`).join(', ') : 'none');
  return `--against ${against.dir} made its older releases' checkpoints with ${said(theirs)}, and this invocation with ${said(ours)}, so the two arms' runs wouldn't start from the same stores`;
}

const flagKey = (f: Flag) => JSON.stringify([f.check, f.step, f.what ?? null, f.detail, f.whole ?? null]);

export function flagsAgainst(against: Against | null | undefined, id: string, own: Flag[]): Flags | null {
  if (!against) return { new: own, gone: [], kept: [] };
  const base = against.result(id);
  if (base?.record == null) return null;
  const theirs = [...(base.flags?.new ?? []), ...(base.flags?.kept ?? [])];
  const keys = theirs.map(flagKey);
  const taken = new Set<number>();
  const out: Flags = { new: [], gone: [], kept: [] };
  for (const f of own) {
    const k = flagKey(f);
    const at = keys.findIndex((t, i) => !taken.has(i) && t === k);
    if (at < 0) out.new.push(f);
    else { taken.add(at); out.kept.push(f); }
  }
  out.gone = theirs.filter((_, i) => !taken.has(i));
  return out;
}

const absentOf = (log: Array<LogEntry | null | undefined>) => {
  const stretches = log.filter((e): e is LogEntry & { stretch: string } => e?.kind === 'absent').map((e) => e.stretch);
  return stretches.length ? { absent: stretches } : {};
};

const pausedOf = (log: Array<LogEntry | null | undefined>) => {
  const first = log.find((e): e is LogEntry & { step: string | null; ms: number } => e?.kind === 'compression-paused');
  return first ? { paused: { step: first.step, ms: first.ms } } : {};
};

export function measuredOf(r: Pick<RunResult, 'outcome' | 'unmeasured'>, { against, base, log }: { against: boolean; base: Pick<RunResult, 'outcome' | 'reason' | 'unmeasured' | 'readsFailed' | 'absent' | 'paused'> | null | undefined; log: Array<LogEntry | null | undefined> }): Partial<RunResult> {
  if (r.outcome === 'couldnt-run') return {};
  return {
    unmeasured: r.unmeasured ?? [], ...(against ? { baseUnmeasured: base?.unmeasured ?? [] } : {}),
    readsFailed: readsFailed(log as DriverLogEntry[]), ...(against ? { baseReadsFailed: base?.readsFailed ?? [] } : {}),
    ...(base?.outcome === 'couldnt-run' ? { baseReason: base.reason ?? '' } : {}),
    ...absentOf(log),
    ...(against && base?.absent?.length ? { baseAbsent: base.absent } : {}),
    ...pausedOf(log),
    ...(against && base?.paused ? { basePaused: base.paused } : {}),
  };
}

export function recordAgainst(against: Against | null | undefined, id: string, text: string): { record: 'written' | 'missing'; base: null } | { record: 'same' | 'differs'; base: string } {
  if (!against) return { record: 'written', base: null };
  if (against.result(id)?.record == null) return { record: 'missing', base: null };
  const base = readFileSync(recordPath(against.dir, id), 'utf-8');
  return { record: base === text ? 'same' : 'differs', base };
}
