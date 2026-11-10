import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Socket, connect as netConnect } from 'node:net';
import { cutThrow } from './strategies/cut.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sh(cmd: string, cmdArgs: string[], { cwd, env = {}, timeout = 600_000, allowFail = false }: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; allowFail?: boolean } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw cutThrow((cut: (value: unknown, n: number) => string) => `${cmd} ${cmdArgs.join(' ')} (cwd ${cwd}) exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}\n${cut((r.stdout + '\n' + r.stderr).trim(), -3000)}`);
  }
  return r;
}

export function ipcConnect(path: string, timeoutMs = 5000) {
  return new Promise<Socket>((res, rej) => {
    const s = netConnect(path);
    const t = setTimeout(() => { s.destroy(); rej(new Error(`ipc connect timeout ${path}`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
export const send = (sock: Socket, obj: unknown) => sock.write(JSON.stringify(obj) + '\n');

const hostGroups = new Set<number>();

export function stopHost(child: ChildProcess) {
  if (!(hostGroups as Set<number | undefined>).delete(child.pid)) return;
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* the group is already empty */ }
}

// Files listing process groups that the hosts started, each a pid on a line, which a stop kills with the hosts.
const listedFiles = new Set<string>();

/** The process groups `file` lists, each once: its complete lines that each hold a whole number of 2 or more. Each is
 *  killed as `-pid`, and `kill(-0)` is the killer's own group and `kill(-1)` every process it may signal, so a line of
 *  spaces, a cut-off write or a negative number is no group. A missing file lists none; any other read error throws. */
export function listedGroups(file: string): number[] {
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const complete = text.split('\n').slice(0, -1);
  return [...new Set(complete.filter((l) => /^[1-9]\d*$/.test(l)).map(Number).filter((n) => n >= 2 && Number.isSafeInteger(n)))];
}

/** A signal or exit that stops this process's hosts stops the groups `file` lists too, read as it stops, until the
 *  function this gives is called. */
export function stopListedToo(file: string) {
  listedFiles.add(file);
  return () => { listedFiles.delete(file); };
}

function stopAllHosts() {
  for (const pid of hostGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
  }
  hostGroups.clear();
  for (const file of listedFiles) {
    let listed: number[];
    try { listed = listedGroups(file); } catch { continue; }
    for (const pid of listed) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
    }
  }
}

let hostCleanupInstalled = false;
function installHostCleanup() {
  if (hostCleanupInstalled) return;
  hostCleanupInstalled = true;
  process.prependListener('exit', stopAllHosts);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as const) {
    process.on(signal, function onSignal() {
      stopAllHosts();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  }
}

export function spawnHost({ hostDir, recipePath, dataDir, cwd, sockPath, env = {}, preload = null, bunArgs = [] }: {
  hostDir: string; recipePath: string; dataDir: string; cwd: string; sockPath: string;
  env?: Record<string, string | undefined>; preload?: string | null; bunArgs?: string[];
}) {
  const out: string[] = [];
  const child = spawn('bun', [...bunArgs, ...(preload ? ['--preload', preload] : []), join(hostDir, 'src', 'index.ts'), recipePath, '--headless', '--socket-path', sockPath], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (typeof child.pid === 'number') {
    installHostCleanup();
    hostGroups.add(child.pid);
    if (process.env.WHOLE_HOST_HOST_GROUPS) appendFileSync(process.env.WHOLE_HOST_HOST_GROUPS, `${child.pid}\n`);
  } else {
    child.once('error', (e) => {
      out.push(`couldn't start the host: ${e.message}\n`);
      child.emit('exit', (e as NodeJS.ErrnoException).code ?? null, null);
    });
  }
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, out };
}

export function parseArgs(argv: string[]) {
  const opt = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  const flag = (name: string) => argv.includes(`--${name}`);
  const missing = (names: string[]) => names.filter((name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && (argv[i + 1] === undefined || argv[i + 1] === '' || argv[i + 1].startsWith('--'));
  });
  return { opt, flag, missing };
}
