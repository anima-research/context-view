import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { listedGroups, sleep } from '../common.ts';
import { reachAttach } from '../reach/interfaces.ts';
import type { ReachAttach, ReachLaunch } from '../reach/interfaces.ts';
import { EMPTY } from '../standin/standin.ts';
import { BOOT_MS, SHUTDOWN_MS } from './bounds.ts';
import { BASE_AGENT } from './recipe.ts';
import type { RecipeAgent } from './recipe.ts';
import type { FleetReadout } from './module.ts';
import type { Configuration } from '../workloads/workloads.ts';

type Launch = Awaited<ReturnType<ReachLaunch>>;
type Attach = ReturnType<ReachAttach>;
type Read = Awaited<Attach['atExit']>;
export type FleetChild = { name: string; dataDir: string; recipePath: string; recipe: { name: string; agent: RecipeAgent; maintenanceIntervalMs: number; modules: { [module: string]: boolean } }; env: { [name: string]: string } };
type Watcher = { launch: Launch; recipePath: string; stopped: boolean; closed: boolean; current: Attach | null; done: Promise<void> | null };

export const childRecipe = (work: string, name: string) => join(work, `fleet-${name}.json`);

// A fleet's children, each a host the parent's fleet module starts, autoStart, from the recipe written here: it spawns
// the parent's own runtime and entry with the child's `env` over the parent's (fleet-module.ts launch). A child's model
// is the stand-in's `/empty` route, which answers every request empty and records none, so the record holds the
// parent's requests alone, and a child's latest reply is an empty round, which is what fleet--relay refuses. In a
// profiled drive, `reachOf` gives a child reach's additions, which BUN_OPTIONS carries to every process of the child,
// since a recipe can't name a runtime's flags.
export function fleetChildren({ configuration, work, storeDir, standinUrl = null, reachOf = () => null }: { configuration: Configuration; work: string; storeDir: string; standinUrl?: string | null; reachOf?: (name: string) => Launch | null }): FleetChild[] {
  return (configuration.fleet ?? []).map((c) => ({
    name: c.name,
    dataDir: join(storeDir, 'fleet', c.name),
    recipePath: childRecipe(work, c.name),
    recipe: {
      name: `Fleet child ${c.name}`,
      agent: { ...BASE_AGENT, ...configuration.agent, name: c.name, systemPrompt: `You are the fleet fixture's child ${c.name}.` },
      maintenanceIntervalMs: 0,
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    },
    env: {
      ...(reachOf(c.name) ? { BUN_OPTIONS: reachOf(c.name)!.args.join(' '), ...reachOf(c.name)!.env } : {}),
      ...(standinUrl ? { ANTHROPIC_BASE_URL: `${standinUrl}${EMPTY}` } : {}),
    },
  }));
}

// A fleet parent's boot waits until its fleet module reads every child ready, a child of the boot's own start or one it
// adopted, asking the harness module's `fleet` op (`ask`) every `pollMs` up to `boundMs`, and gives the children as
// last read. It throws where their status can't be read (`moved`), as when connectome-host moves or renames the fleet
// module's getChildren(), rather than going on without waiting, since a relay to a child still starting answers
// otherwise than one to a child that's ready; and where a child isn't ready within the bound.
export async function fleetReady({ ask, names, boundMs = BOOT_MS, pollMs = 50 }: { ask: () => Promise<FleetReadout | null | undefined>; names: string[]; boundMs?: number; pollMs?: number }) {
  const t = performance.now();
  for (;;) {
    const answer = await ask();
    if (answer && typeof answer === 'object' && typeof answer.moved === 'string') throw new Error(`couldn't read whether the fleet's children are ready, which the harness reads through the parent's fleet module's getChildren(): ${answer.moved}`);
    if (!Array.isArray(answer?.children)) throw new Error(`couldn't read whether the fleet's children are ready: the harness module's answer isn't a list of children: ${JSON.stringify(answer)?.slice(0, 300)}`);
    if (names.every((n) => answer.children.some((c) => c.name === n && c.status === 'ready'))) return { children: answer.children, ms: Math.round(performance.now() - t) };
    if (performance.now() - t > boundMs) throw new Error(`the fleet's children weren't all ready within ${boundMs} ms: ${JSON.stringify(answer.children)}`);
    await sleep(pollMs);
  }
}

// In a profiled drive, each fleet child is read where each of its processes exits, on an inspector address of the
// child's own for the drive (`watch`), each read pushed to `reads` with the child's name. Its watcher attaches, takes the
// read, and attaches again: adoption keeps a child's one process, but a process the parent starts for it again, as
// fleet--restart and an autoRestart do with the child's own env (fleet-module.ts), waits at --inspect-wait on the same
// address, running nothing, until someone attaches or the drive's bounds end it. At the drive's end (`stop`), each
// watcher stops once its process has been read; one whose process still runs `boundMs` on, as after a failed drive,
// closes its attach, and its read is unread, so no read comes after the drive's reads are taken.
export function childWatchers({ wanted, reads, boundMs = SHUTDOWN_MS }: { wanted: (path: string) => boolean; reads: Array<Read & { readMs?: number }>; boundMs?: number }) {
  const watchers = new Map<string, Watcher>();
  function watch(name: string, launch: Launch, recipePath: string) {
    const w: Watcher = { launch, recipePath, stopped: false, closed: false, current: null, done: null };
    w.done = (async () => {
      while (!w.stopped) {
        const a = reachAttach({ launch, wanted, stopped: () => w.stopped });
        w.current = a;
        try { await a.attached; } catch { a.close(); w.current = null; if (w.stopped) break; await sleep(50); continue; }
        const read = await a.atExit;
        if (!w.closed) reads.push({ fleet: { child: name, recipePath }, readMs: Math.round(a.readMs()), ...read });
        // Read, so the drive's end has nothing of this process to read as unread. It resumes from its read and exits,
        // and its inspector closes, before the next process is waited for.
        w.current = null;
        await Promise.race([a.ended, sleep(boundMs)]);
        a.close();
      }
    })();
    watchers.set(name, w);
  }
  async function stop() {
    for (const w of watchers.values()) w.stopped = true;
    const all = Promise.all([...watchers.values()].map((w) => w.done)).then(() => true);
    if (await Promise.race([all, sleep(boundMs).then(() => false)])) return;
    for (const [name, w] of watchers) {
      if (!w.current) continue;
      w.closed = true;
      w.current.close();
      reads.push({ fleet: { child: name, recipePath: w.recipePath }, unread: `the drive ended with it still running ${boundMs} ms after the host's shutdown, so what it ran couldn't be read` });
    }
  }
  return { watch, stop, has: (name: string) => watchers.has(name), launchOf: (name: string) => watchers.get(name)?.launch ?? null, ended: (name: string) => watchers.get(name)?.done ?? null, get size() { return watchers.size; } };
}

export const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

// Kills each group of `pids` still alive, and waits, up to `boundMs`, until each has gone: a killed group answers until
// its leader is reaped. It gives the groups it found alive (`before`) and those still alive at the bound (`after`).
export async function endGroups(pids: number[], { boundMs = SHUTDOWN_MS, alive = groupAlive }: { boundMs?: number; alive?: (pid: number) => boolean } = {}) {
  const before = pids.filter((pid) => alive(pid));
  for (const pid of before) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const end = performance.now() + boundMs; before.some((pid) => alive(pid)) && performance.now() < end;) await sleep(20);
  return { before, after: before.filter((pid) => alive(pid)) };
}

// The drive's end of a fleet run: kills each group the groups `file` lists, unlists the file from the signal stop,
// logs what it found, and fails the run where it couldn't read the file or a group outlived the kill.
export async function endFleetGroups({ file, fail, log, unlist }: { file: string; fail: (failure: { step: null; reason: string }) => void; log: (kind: string, fields: { [field: string]: unknown }) => void; unlist: () => void }) {
  let listed: number[] = [];
  try { listed = listedGroups(file); } catch (e) {
    fail({ step: null, reason: `the fleet's groups file couldn't be read, so the groups it lists weren't killed: ${(e as Error).message}` });
  }
  const groups = await endGroups(listed);
  unlist();
  log('fleet-groups', { listed, ...groups });
  if (groups.after.length) fail({ step: null, reason: `the fleet's process group${groups.after.length > 1 ? 's' : ''} ${groups.after.join(', ')} ${groups.after.length > 1 ? 'were' : 'was'} still alive ${SHUTDOWN_MS} ms after the drive's end killed ${groups.after.length > 1 ? 'them' : 'it'}` });
}
