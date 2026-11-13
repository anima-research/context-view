import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Socket, connect as netConnect } from 'node:net';
import { cutThrow } from './cut/interfaces.ts';

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
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { }
}

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

export function stopListedToo(file: string) {
  listedFiles.add(file);
  return () => { listedFiles.delete(file); };
}

function stopAllHosts() {
  for (const pid of hostGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { }
  }
  hostGroups.clear();
  for (const file of listedFiles) {
    let listed: number[];
    try { listed = listedGroups(file); } catch { continue; }
    for (const pid of listed) {
      try { process.kill(-pid, 'SIGKILL'); } catch { }
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

export type Options = { valued: string[]; flags: string[] };

export function readOptions(file: string): Options {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf-8')); } catch (e) { throw new Error(`${file} can't be read: ${(e as Error).message}`); }
  const bad = (why: string) => new Error(`${file} isn't {"valued": [names], "flags": [names]}: ${why}`);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('it isn\'t an object');
  const lists = parsed as Record<string, unknown>;
  const other = Object.keys(lists).filter((key) => key !== 'valued' && key !== 'flags');
  if (other.length) throw bad(`it holds ${other.join(', ')}`);
  for (const kind of ['valued', 'flags']) {
    const list = lists[kind];
    if (!Array.isArray(list)) throw bad(`${kind} isn't a list`);
    const odd = list.find((name) => typeof name !== 'string' || name === '' || name.includes('='));
    if (odd !== undefined) throw bad(`${kind} holds ${JSON.stringify(odd)}, which isn't a name`);
    const twice = [...new Set(list.filter((name, i) => list.indexOf(name) !== i))];
    if (twice.length) throw bad(`${kind} names ${twice.join(', ')} twice`);
  }
  const valued = lists.valued as string[];
  const flags = lists.flags as string[];
  const both = valued.filter((name) => flags.includes(name));
  if (both.length) throw bad(`${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} in both lists`);
  return { valued: [...valued], flags: [...flags] };
}

export function parseArgs(argv: string[], options: Options) {
  const values = new Map<string, string>();
  const given = new Set<string>();
  const refused: string[] = [];
  const takes = [...options.valued, ...options.flags].sort().map((name) => `--${name}`).join(', ');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      const before = argv[i - 1]?.startsWith('--') ? argv[i - 1].slice(2) : null;
      refused.push(before !== null && options.flags.includes(before) ? `--${before} takes no value, so ${JSON.stringify(arg)} is no option's value` : `${JSON.stringify(arg)} is no option's value, and an option is written --NAME`);
      continue;
    }
    const name = arg.slice(2);
    if (name.includes('=')) {
      const own = name.slice(0, name.indexOf('='));
      refused.push(options.valued.includes(own) ? `${arg}: the = form isn't taken, so give --${own} and its value as two arguments` : options.flags.includes(own) ? `${arg}: --${own} takes no value` : `--${own} isn't an option the harness takes; it takes ${takes}`);
      continue;
    }
    if (given.has(name)) { refused.push(`--${name} is given twice`); if (options.valued.includes(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++; continue; }
    if (options.valued.includes(name)) {
      given.add(name);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) { refused.push(`--${name} needs a value`); continue; }
      i++;
      if (value === '') { refused.push(`--${name} needs a value`); continue; }
      values.set(name, value);
    } else if (options.flags.includes(name)) {
      given.add(name);
    } else {
      refused.push(`--${name} isn't an option the harness takes; it takes ${takes}`);
    }
  }
  const opt = <D extends string | undefined = undefined>(name: string, def?: D): string | NoInfer<D> => {
    if (!options.valued.includes(name)) throw new Error(`opt('${name}'): options.json declares no valued option ${name}`);
    return values.has(name) ? values.get(name)! : def as D;
  };
  const flag = (name: string) => {
    if (!options.flags.includes(name)) throw new Error(`flag('${name}'): options.json declares no flag ${name}`);
    return given.has(name);
  };
  return { opt, flag, refused };
}
