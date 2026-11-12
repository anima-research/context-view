import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { slug } from '../against.ts';
import { RUNS, WORKLOADS } from './workloads.ts';
import type { Workload } from './workloads.ts';

type Workloads = Record<string, Workload>;

export async function workloadsModule(path: string, digest: string | null = null): Promise<{ table: Workloads; runs: string[]; path: string; digest: string }> {
  const at = resolve(path);
  let bytes: Buffer;
  try { bytes = readFileSync(at); } catch (e) { throw new Error(`--workloads ${path} can't be imported: ${(e as Error).message}`); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (digest !== null && sha256 !== digest) throw new Error(`--workloads ${path} changed after this invocation read it: its bytes hash to ${sha256.slice(0, 12)}, not ${digest.slice(0, 12)}`);
  const runsFrom = digest !== null ? at : copyOf(bytes, sha256, esm(extname(at)));
  let module: { WORKLOADS?: unknown; RUNS?: unknown };
  try { module = await import(pathToFileURL(runsFrom).href); } catch (e) {
    const alone = (e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' ? 'a workloads module should be one self-contained file, since it runs from a copy, where an import relative to it or of a package beside it doesn\'t resolve: ' : '';
    throw new Error(`--workloads ${path} can't be imported: ${alone}${(e as Error).message}`);
  }
  const { WORKLOADS: own, RUNS: runs } = module;
  if (!own || typeof own !== 'object' || Array.isArray(own) || !Array.isArray(runs)) throw new Error(`--workloads ${path} doesn't export both WORKLOADS, an object of workloads, and RUNS, a list of run ids`);
  const malformed = runs.filter((id) => typeof id !== 'string' || !/^[^/,\s]+\/[^/,\s]+(\/[^/,\s]+)?$/.test(id));
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
  const dirs = (id: string) => [slug(id), `${slug(id)}.recording-off`];
  const taken = new Map<string, string>((RUNS as string[]).flatMap((id) => dirs(id).map((d) => [d, id] as const)));
  const meeting: string[] = [];
  for (const id of runs as string[]) {
    const other = dirs(id).map((d) => taken.get(d)).find((o) => o !== undefined);
    if (other !== undefined) meeting.push(`${id} and ${other}`);
    else for (const d of dirs(id)) taken.set(d, id);
  }
  if (meeting.length) throw new Error(`--workloads ${path} RUNS has runs whose evidence would share a directory: ${meeting.join('; ')}`);
  return { table: { ...WORKLOADS, ...own }, runs, path: runsFrom, digest: sha256 };
}

const copies = new Set<string>();
let hooked = false;

export function removeCopies() {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  copies.clear();
}

// Node takes a `.ts` or `.js` file's module format from the nearest package.json, which the copy doesn't share with the
// original. So the copy is named as an ES module outright, as the module is under the harness's own package.json, and a
// `.ts` module keeps its types stripped.
const esm = (extension: string) => ({ '.ts': '.mts', '.js': '.mjs', '': '.mjs' } as Record<string, string>)[extension] ?? extension;

function copyOf(bytes: Buffer, sha256: string, extension: string) {
  if (!hooked) { process.on('exit', removeCopies); hooked = true; }
  const dir = mkdtempSync(join(tmpdir(), 'harness-workloads-module-copy-'));
  copies.add(dir);
  const file = join(dir, `workloads-${sha256}${extension}`);
  writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return file;
}

export const moduleArgs = (module: { path: string; digest: string }) => ({ workloads: module.path, workloadsDigest: module.digest });
