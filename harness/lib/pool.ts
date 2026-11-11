import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listedGroups } from './common.ts';
import { asWritten } from './strategies/control.ts';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'child.ts');

export const resultOf = (file: string) => JSON.parse(readFileSync(file, 'utf-8'), asWritten);

export class HarnessFailure extends Error {}

const before = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

export function slots(width: number) {
  let free = width;
  const waiting: Array<{ key: number[]; resolve: (release: () => void) => void }> = [];
  let scheduled = false;
  const next = () => {
    scheduled = false;
    while (free > 0 && waiting.length) {
      let at = 0;
      for (let i = 1; i < waiting.length; i++) if (before(waiting[i].key, waiting[at].key)) at = i;
      const [w] = waiting.splice(at, 1);
      free--;
      let freed = false;
      w.resolve(() => {
        if (freed) return;
        freed = true;
        free++;
        schedule();
      });
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; setImmediate(next); } };
  return { take: (key: number[]) => new Promise<() => void>((resolve) => { waiting.push({ key, resolve }); schedule(); }) };
}

export function stopListedHosts(file: string) {
  let listed: number[];
  try { listed = listedGroups(file); } catch { return; }
  for (const pid of listed) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

export function runChild<T = unknown>(spec: { result: string; [field: string]: unknown }, { label, live, onFailure = () => {} }: { label: string; live: Set<ChildProcess>; onFailure?: (e: HarnessFailure) => void }) {
  return new Promise<T>((resolve, reject) => {
    const hosts = `${spec.result}.hosts`;
    const failed = (why: string) => {
      stopListedHosts(hosts);
      const e = new HarnessFailure(`${label}: ${why}`);
      onFailure(e);
      reject(e);
    };
    const child = spawn(process.execPath, [CHILD, JSON.stringify(spec)], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, WHOLE_HOST_HOST_GROUPS: hosts } });
    live.add(child);
    child.once('error', (e) => { live.delete(child); failed(`its process couldn't start: ${e.message}`); });
    child.once('exit', (code, signal) => {
      live.delete(child);
      if (signal) { failed(`its process was ended by ${signal}`); return; }
      let result: { signalled?: { boot: unknown; signal: string }; failed?: string; threw?: { message: string; full?: string }; value?: T };
      try { result = resultOf(spec.result); } catch { failed(`its process exited ${code} without a result`); return; }
      if (result.signalled) { failed(`its host (boot ${result.signalled.boot}) was ended by ${result.signalled.signal}`); return; }
      if (result.failed !== undefined) { failed(result.failed); return; }
      if (result.threw) {
        const e = new Error(result.threw.message);
        if (result.threw.full) (e as Error & { full?: string }).full = result.threw.full;
        reject(e);
        return;
      }
      resolve(result.value as T);
    });
  });
}

const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
};

export async function stopChildren(live: Set<ChildProcess>, graceMs = 10_000) {
  const all = [...live].filter((c) => typeof c.pid === 'number');
  for (const c of all) kill(c, 'SIGTERM');
  const late = setTimeout(() => { for (const c of all) kill(c, 'SIGKILL'); }, graceMs);
  await Promise.all(all.map((c) => new Promise<void>((res) => {
    if (c.exitCode !== null || c.signalCode !== null) res();
    else c.once('exit', () => res());
  })));
  clearTimeout(late);
  for (const c of all) kill(c, 'SIGKILL');
}

export function forwardStops(live: Set<ChildProcess>, also: () => void = () => {}) {
  process.prependListener('exit', () => { for (const c of live) kill(c, 'SIGTERM'); also(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as const) {
    process.on(signal, function onSignal() {
      for (const c of live) kill(c, 'SIGTERM');
      also();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  }
}
