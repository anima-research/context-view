import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { slug } from '../against.ts';
import { RUNS, WORKLOADS } from './workloads.ts';

type Workloads = Record<string, unknown>;

/**
 * A workloads module (run.ts --workloads; harness/README.md, "Running it"): a file exporting WORKLOADS, workloads
 * in workloads.ts's shape, and RUNS, run ids over this harness's configurations. Its runs join the view's for one
 * invocation and nothing of the view's moves, so a workload name or run id the view has is refused, and so is a run of a
 * workload that isn't the module's. A module's workload declares `from: null`: checkpoints are built only from the view's
 * own workloads. Returns the joined table, the module's runs, its path and the sha256 of its bytes, or throws saying
 * what's wrong. Given `digest`, as a drive child is given the one its invocation read, it refuses a file whose bytes no
 * longer hash to it, so every drive of an invocation runs the module the invocation judged, and run.json records the
 * digest so that --against compares two arms of the same module. Its path is known only at run time, so the load is one
 * of the source rules' floors (AGENTS.md).
 */
export async function workloadsModule(path: string, digest: string | null = null): Promise<{ table: Workloads; runs: string[]; path: string; digest: string }> {
  const at = resolve(path);
  let bytes: Buffer;
  try { bytes = readFileSync(at); } catch (e) { throw new Error(`--workloads ${path} can't be imported: ${(e as Error).message}`); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (digest !== null && sha256 !== digest) throw new Error(`--workloads ${path} changed after this invocation read it: its bytes hash to ${sha256.slice(0, 12)}, not ${digest.slice(0, 12)}`);
  let module: { WORKLOADS?: unknown; RUNS?: unknown };
  try { module = await import(pathToFileURL(at).href); } catch (e) { throw new Error(`--workloads ${path} can't be imported: ${(e as Error).message}`); }
  const { WORKLOADS: own, RUNS: runs } = module;
  if (!own || typeof own !== 'object' || Array.isArray(own) || !Array.isArray(runs)) throw new Error(`--workloads ${path} doesn't export both WORKLOADS, an object of workloads, and RUNS, a list of run ids`);
  const malformed = runs.filter((id) => typeof id !== 'string' || !/^[^/]+\/[^/]+(\/[^/]+)?$/.test(id));
  if (malformed.length) throw new Error(`--workloads ${path} RUNS has ids that aren't CONFIGURATION/WORKLOAD or CONFIGURATION/WORKLOAD/VARIANT: ${malformed.map(String).join(', ')}`);
  const twice = [...new Set(runs.filter((id, i) => runs.indexOf(id) !== i))];
  if (twice.length) throw new Error(`--workloads ${path} RUNS names ${twice.join(', ')} more than once`);
  const names = Object.keys(own).filter((name) => Object.hasOwn(WORKLOADS, name));
  if (names.length) throw new Error(`--workloads ${path} names workloads the view already has: ${names.join(', ')}`);
  const ids = runs.filter((id) => (RUNS as unknown[]).includes(id));
  if (ids.length) throw new Error(`--workloads ${path} names runs the view already has: ${ids.join(', ')}`);
  const checkpointed = Object.entries(own).filter(([, w]) => (w as { from?: unknown } | null)?.from !== null).map(([name]) => name);
  if (checkpointed.length) throw new Error(`--workloads ${path}: a module's workload starts from no checkpoint, so it declares from: null, and ${checkpointed.join(', ')} doesn't`);
  const strangers = runs.filter((id) => !Object.hasOwn(own, String(id).split('/')[1]));
  if (strangers.length) throw new Error(`--workloads ${path} runs workloads not its own: ${strangers.join(', ')}`);
  // A run's evidence and scratch go under its slug (against.ts), so two runs whose slugs meet would share them.
  const slugs = new Map<string, string>((RUNS as string[]).map((id) => [slug(id), id]));
  const meeting: string[] = [];
  for (const id of runs as string[]) {
    const other = slugs.get(slug(id));
    if (other !== undefined) meeting.push(`${id} and ${other}`);
    else slugs.set(slug(id), id);
  }
  if (meeting.length) throw new Error(`--workloads ${path} RUNS has runs whose evidence would share a directory: ${meeting.join('; ')}`);
  return { table: { ...WORKLOADS, ...own }, runs, path: at, digest: sha256 };
}
