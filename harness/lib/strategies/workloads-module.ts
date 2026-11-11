import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNS, WORKLOADS } from './workloads.ts';

type Workloads = Record<string, unknown>;

/**
 * A workloads module (run.ts --workloads; harness/README.md, "Running it"): a file exporting WORKLOADS, workloads
 * in workloads.ts's shape, and RUNS, run ids over this harness's configurations. Its runs join the view's for one
 * invocation and nothing of the view's moves, so a workload name or run id the view has is refused, and so is a run of a
 * workload that isn't the module's. A module's workload declares `from: null`: checkpoints are built only from the view's
 * own workloads. Returns the joined table, the module's runs, and its path, or throws saying what's wrong. Its path is
 * known only at run time, so the load is one of the source rules' floors (AGENTS.md).
 */
export async function workloadsModule(path: string): Promise<{ table: Workloads; runs: string[]; path: string }> {
  const at = resolve(path);
  let module: { WORKLOADS?: unknown; RUNS?: unknown };
  try { module = await import(pathToFileURL(at).href); } catch (e) { throw new Error(`--workloads ${path} can't be imported: ${(e as Error).message}`); }
  const { WORKLOADS: own, RUNS: runs } = module;
  if (!own || typeof own !== 'object' || Array.isArray(own) || !Array.isArray(runs)) throw new Error(`--workloads ${path} doesn't export both WORKLOADS, an object of workloads, and RUNS, a list of run ids`);
  const names = Object.keys(own).filter((name) => Object.hasOwn(WORKLOADS, name));
  if (names.length) throw new Error(`--workloads ${path} names workloads the view already has: ${names.join(', ')}`);
  const ids = runs.filter((id) => (RUNS as unknown[]).includes(id));
  if (ids.length) throw new Error(`--workloads ${path} names runs the view already has: ${ids.join(', ')}`);
  const checkpointed = Object.entries(own).filter(([, w]) => (w as { from?: unknown } | null)?.from !== null).map(([name]) => name);
  if (checkpointed.length) throw new Error(`--workloads ${path}: a module's workload starts from no checkpoint, so it declares from: null, and ${checkpointed.join(', ')} doesn't`);
  const strangers = runs.filter((id) => !Object.hasOwn(own, String(id).split('/')[1]));
  if (strangers.length) throw new Error(`--workloads ${path} runs workloads not its own: ${strangers.join(', ')}`);
  return { table: { ...WORKLOADS, ...own }, runs, path: at };
}
