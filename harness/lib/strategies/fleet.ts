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

// connectome-host's fleet module starts each child from its recipe with the parent's own runtime and entry, and the
// child's `env` over the parent's (fleet-module.ts launch). A recipe can't name a runtime's flags, so in a profiled
// drive a child's processes take reach's additions through BUN_OPTIONS.
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

// connectome-host's fleet module answers a relay to a child still starting otherwise than one to a child that's ready.
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

// connectome-host's fleet module starts a child's process again on fleet--restart and an autoRestart, with the child's
// own env (fleet-module.ts), so the new process waits at --inspect-wait on the same inspector address, running nothing,
// until someone attaches.
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

// A killed process group answers until its leader is reaped.
export async function endGroups(pids: number[], { boundMs = SHUTDOWN_MS, alive = groupAlive }: { boundMs?: number; alive?: (pid: number) => boolean } = {}) {
  const before = pids.filter((pid) => alive(pid));
  for (const pid of before) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const end = performance.now() + boundMs; before.some((pid) => alive(pid)) && performance.now() < end;) await sleep(20);
  return { before, after: before.filter((pid) => alive(pid)) };
}

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
