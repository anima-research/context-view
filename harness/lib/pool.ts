// @ts-nocheck
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'child.ts');

/** A failure of the harness, not of a run: the share stops, and writes no run.json. */
export class HarnessFailure extends Error {}

const before = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

/** `width` slots. `take(key)` waits for one and gives the function that frees it. Slots are given out a turn of the
 *  event loop after they're asked for or freed, so every task that asks in one turn is weighed: a slot goes to the
 *  waiting task with the smallest key, compared element by element, and among equal keys to the one that asked first. */
export function slots(width) {
  let free = width;
  const waiting = [];
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
  return { take: (key) => new Promise((resolve) => { waiting.push({ key, resolve }); schedule(); }) };
}

/** Kills each host group a child listed in `file`, as hosts are in groups of their own that a child killed by a
 *  signal can't stop. */
export function stopListedHosts(file) {
  let listed;
  try { listed = readFileSync(file, 'utf-8'); } catch { return; }
  for (const pid of listed.split('\n').filter(Boolean).map(Number)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

/** Runs `spec` in a child process (`child.ts`) in a process group of its own, which is in `live` while it runs. Its
 *  result comes back as what its work returned, or as the error its work threw. A child that dies by a signal, that
 *  ends without its result, or whose host died by a signal the harness didn't send, is a harness failure, given to
 *  `onFailure` as well as thrown, and the hosts it started are killed. */
export function runChild(spec, { label, live, onFailure = () => {} }) {
  return new Promise((resolve, reject) => {
    const hosts = `${spec.result}.hosts`;
    const failed = (why) => {
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
      let result;
      try { result = JSON.parse(readFileSync(spec.result, 'utf-8')); } catch { failed(`its process exited ${code} without a result`); return; }
      if (result.signalled) { failed(`its host (boot ${result.signalled.boot}) was ended by ${result.signalled.signal}`); return; }
      if (result.failed) { failed(result.failed); return; }
      if (result.threw) {
        const e = new Error(result.threw.message);
        if (result.threw.full) e.full = result.threw.full;
        reject(e);
        return;
      }
      resolve(result.value);
    });
  });
}

const kill = (child, signal) => {
  try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
};

/** Stops every live child's process group and waits for each child to end, killing a group that outlasts `graceMs`
 *  after its stop, and whatever of each group outlives its child. A child that never started has no group. */
export async function stopChildren(live, graceMs = 10_000) {
  const all = [...live].filter((c) => typeof c.pid === 'number');
  for (const c of all) kill(c, 'SIGTERM');
  const late = setTimeout(() => { for (const c of all) kill(c, 'SIGKILL'); }, graceMs);
  await Promise.all(all.map((c) => new Promise((res) => {
    if (c.exitCode !== null || c.signalCode !== null) res();
    else c.once('exit', () => res());
  })));
  clearTimeout(late);
  for (const c of all) kill(c, 'SIGKILL');
}

/** A signal that stops this process stops its children's groups first, and an exit does too. */
export function forwardStops(live) {
  process.prependListener('exit', () => { for (const c of live) kill(c, 'SIGTERM'); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP']) {
    process.on(signal, function onSignal() {
      for (const c of live) kill(c, 'SIGTERM');
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  }
}
