import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangedLines, Digest, ReachDrive, ReachFile, ReachJson, ReachPart, ReachPartRead } from '../shapes/interfaces.ts';
import { errorText } from '../cut/interfaces.ts';

interface Block { startOffset: number; endOffset: number; hasExecuted: boolean }
export type Spawned =
  | { kind: 'child'; pid?: number; argv: string[] }
  | { kind: 'worker'; pid?: number; entry: string; eval: boolean }
  | { kind: 'unread'; why: string }
  | { kind: 'unlogged'; count: number | null };
export type Script = { path: string; served: string; blocks: Block[]; inlineMap: string; unread?: undefined } | { path: string; unread: string; served?: undefined; blocks?: undefined; inlineMap?: undefined };
export type Read = ({ scripts: Script[]; unread?: undefined } | { unread: string; scripts?: undefined }) & { spawned?: Spawned[]; boot?: number; fleet?: { child: string; recipePath: string } };
interface ScriptParsed { scriptId: string; url?: string; sourceMapURL?: string }
interface Paused { callFrames: Array<{ functionName: string; location: { scriptId: string } }> }
interface InspectorMessage { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }
interface SourceMap { sources?: string[]; sourceRoot?: string; mappings?: string }
type Segment = [number] | [number, number, number, number];
type Roots = { root: string; roots?: string[] } | { root?: string; roots: string[] };
interface TreeOptions { built?: string[]; harnessDir?: string; resolveDynamic?: (file: string, expr: string) => string | null | false; only?: string[] | null; home?: string | null }
export type Tree = Roots & TreeOptions;

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'reach-preload.cts');

function freePort() {
  return new Promise<number>((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => res(port));
    });
  });
}

export function inspectorClient(url: string) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map<number, { method: string; res: (result: unknown) => void; rej: (e: Error) => void }>();
  const scripts = new Map<string, { url: string; sourceMapURL: string }>();
  const listeners: Array<(m: InspectorMessage) => void> = [];
  const opened = new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error(`couldn't attach to the inspector at ${url}`)));
  });
  ws.addEventListener('message', (e) => {
    const m: InspectorMessage = JSON.parse(String(e.data));
    if (m.id !== undefined && pending.has(m.id)) {
      const { method, res, rej } = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) rej(new Error(`the inspector answered ${method} with error ${m.error.code}: ${m.error.message}`));
      else res(m.result ?? {});
    } else if (m.method === 'Debugger.scriptParsed') {
      scripts.set((m.params as ScriptParsed).scriptId, { url: (m.params as ScriptParsed).url ?? '', sourceMapURL: (m.params as ScriptParsed).sourceMapURL ?? '' });
    } else if (m.method) {
      for (const listener of listeners) listener(m);
    }
  });
  let closedNow: () => void = () => {};
  const closed = new Promise<void>((res) => { closedNow = res; });
  ws.addEventListener('close', () => {
    for (const { method, rej } of pending.values()) rej(new Error(`the inspector closed before it answered ${method}`));
    pending.clear();
    closedNow();
  });
  const call = <T = unknown>(method: string, params: object = {}) => new Promise<T>((res, rej) => {
    const i = ++id;
    pending.set(i, { method, res: res as (result: unknown) => void, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { opened, closed, call, scripts, on: (listener: (m: InspectorMessage) => void) => listeners.push(listener), close: () => ws.close() };
}

const pathOf = (url: string) => (url.startsWith('file://') ? fileURLToPath(url) : url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const READ_POINT = { path: realpathSync(PRELOAD), name: 'readPoint' };

export async function reachLaunch({ logDir }: { logDir: string }) {
  const port = await freePort();
  const path = `reach${Math.random().toString(36).slice(2, 10)}`;
  const logPath = join(logDir, `reach-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  return { args: [`--inspect-wait=127.0.0.1:${port}/${path}`, '--preload', PRELOAD], env: { CONTEXT_VIEW_REACH_LOG: logPath }, url: `ws://127.0.0.1:${port}/${path}`, logPath };
}

export function reachAttach({ launch, child = null, wanted = () => false, killing = () => {}, stopped = () => false }: {
  launch: { url: string; logPath: string };
  child?: ChildProcess | null;
  wanted?: (path: string) => boolean;
  killing?: () => void;
  stopped?: () => boolean;
}) {
  const { url, logPath } = launch;
  let client: ReturnType<typeof inspectorClient> | null = null;
  let reading: Promise<Read> | null = null;
  let readMs = 0;
  let settleExit: (read: Read) => void = () => {};
  const atExit = new Promise<Read>((res) => { settleExit = res; });
  const spawnLog = (): Spawned[] => {
    let text;
    try { text = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : ''; } catch (e) { return [{ kind: 'unread', why: `the spawn log couldn't be read: ${(e as Error).message}` }]; }
    return text.trim().split('\n').filter(Boolean).map((l): Spawned => {
      try { return JSON.parse(l); } catch { return { kind: 'unread', why: `a line of the spawn log couldn't be read (${l.slice(0, 200)})` }; }
    }).filter((x) => child || !('pid' in x) || x.pid === pid);
  };
  const unlogged = async () => {
    try {
      const { result } = await client!.call<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: "globalThis[Symbol.for('context-view.reach.unlogged')] ?? 0", returnByValue: true });
      return typeof result?.value === 'number' ? result.value : null;
    } catch { return null; }
  };
  const spawnedNow = async (): Promise<Spawned[]> => {
    if (gone()) return spawnLog();
    const missed = await unlogged();
    return [...spawnLog(), ...(missed === 0 ? [] : [{ kind: 'unlogged' as const, count: missed }])];
  };
  let pid: number | null = null;
  let inspectorGone = false;
  let endedByInspector: () => void = () => {};
  const gone = () => (child ? child.exitCode !== null || child.signalCode !== null : inspectorGone);
  const exited = child
    ? (gone() ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.once('exit', (code, signal) => res({ code, signal }))))
    : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => { endedByInspector = () => res({ code: null, signal: null }); });
  const why = 'since it didn\'t exit by process.exit or process.reallyExit, or its Bun didn\'t pause there, so what it ran couldn\'t be read';
  exited.then(({ code, signal }) => settleExit({ unread: child ? `the host ended (${code ?? signal}) without stopping where reach reads what it ran, ${why}` : `its inspector closed before it stopped where reach reads what it ran, ${why}`, spawned: spawnLog() }));

  async function readScripts(w: (path: string) => boolean): Promise<Read> {
    const scripts: Script[] = [];
    for (const [scriptId, s] of client!.scripts) {
      const path = pathOf(s.url);
      if (!isAbsolute(path) || !w(path)) continue;
      try {
        const { scriptSource } = await client!.call<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId });
        const { basicBlocks } = await client!.call<{ basicBlocks: Block[] }>('Runtime.getBasicBlocks', { sourceID: scriptId });
        scripts.push({ path, served: scriptSource, blocks: basicBlocks, inlineMap: s.sourceMapURL });
      } catch (e) { scripts.push({ path, unread: errorText(e) }); }
    }
    return { scripts, spawned: await spawnedNow() };
  }

  const attached = (async () => {
    const deadline = child ? performance.now() + 10_000 : Infinity;
    for (;;) {
      client = inspectorClient(url);
      try { await client.opened; break; } catch (e) {
        if (performance.now() > deadline || gone() || stopped()) throw e;
        await sleep(50);
      }
    }
    if (!child) client.closed.then(() => { inspectorGone = true; endedByInspector(); });
    client.on(async (m) => {
      if (m.method !== 'Debugger.paused') return;
      const top = (m.params as Paused).callFrames?.[0];
      const script = top && client!.scripts.get(top.location?.scriptId);
      if (top?.functionName === READ_POINT.name && script && real(pathOf(script.url)) === READ_POINT.path) {
        reading = (async () => {
          const since = performance.now();
          try { return await readScripts(wanted); } catch (e) {
            return { unread: `what the host ran couldn't be read where it exits: ${(e as Error).message}`, spawned: spawnLog() };
          } finally { readMs += performance.now() - since; }
        })();
        const got = await reading;
        reading = null;
        settleExit(got);
      }
      client!.call('Debugger.resume').catch(() => {});
    });
    await client.call('Runtime.enableControlFlowProfiler');
    await client.call('Debugger.enable');
    await client.call('Debugger.setBreakpointsActive', { active: true });
    await client.call('Debugger.setPauseOnDebuggerStatements', { enabled: true });
    if (!child) {
      const asked = await client.call<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'process.pid', returnByValue: true }).catch((e) => ({ failed: errorText(e) }));
      const value = 'failed' in asked ? null : asked.result?.value;
      if (typeof value === 'number') pid = value;
      else settleExit({ unread: `its pid couldn't be read, so which lines of its spawn log are its own can't be told (${'failed' in asked ? asked.failed : `it gave ${JSON.stringify(value)}`})`, spawned: [] });
    }
    await client.call('Inspector.initialized');
  })();
  attached.catch((e) => {
    settleExit({ unread: 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read', spawned: spawnLog() });
    killing();
    try { child?.kill('SIGKILL'); } catch {}
  });

  return {
    attached,
    atExit,
    ended: exited,
    pid: () => pid,
    get reading() { return reading; },
    readMs: () => readMs,
    spawnLog,
    spawnedNow,
    async read(w = wanted): Promise<Read> {
      try { await attached; } catch (e) { return { unread: 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read', spawned: spawnLog() }; }
      // Bun's inspector answers a call only after the events it sent before it, so every script parsed so far is in.
      await client!.call('Runtime.evaluate', { expression: '0' });
      return readScripts(w);
    },
    close() { client?.close(); },
  };
}

export function profiledHost({ args, cwd, logDir, env = {}, preloads = [], wanted }: {
  args: string[]; cwd: string; logDir: string; env?: Record<string, string | undefined>; preloads?: string[]; wanted?: (path: string) => boolean;
}) {
  const out: string[] = [];
  let child: ChildProcess | null = null;
  let reach: ReturnType<typeof reachAttach> | null = null;
  const ready = (async () => {
    const launch = await reachLaunch({ logDir });
    child = spawn('bun', [...launch.args, ...preloads.flatMap((p) => ['--preload', p]), ...args], {
      cwd, env: { ...process.env, ...env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    child.stdout!.on('data', (d) => out.push(d.toString()));
    child.stderr!.on('data', (d) => out.push(d.toString()));
    reach = reachAttach({ launch, child, wanted });
    await reach.attached;
  })();
  ready.catch(() => {});
  const text = () => out.join('');
  const spawned = () => (reach ? reach.spawnLog() : []);
  return {
    get child() { return child; },
    out,
    attached: ready,
    async waitFor(pattern: RegExp, ms = 15_000) {
      await ready;
      const deadline = Date.now() + ms;
      while (!pattern.test(text())) {
        if (Date.now() > deadline || child!.exitCode !== null) throw new Error(`the host never printed ${pattern}: ${text().slice(-2000)}`);
        await sleep(25);
      }
    },
    async read(w?: (path: string) => boolean): Promise<Read> {
      try { await ready; } catch (e) { return { unread: 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read', spawned: spawned() }; }
      return reach!.read(w);
    },
    async atExit(): Promise<Read> {
      try { await ready; } catch (e) { return { unread: 'the profiler couldn\'t attach to the host, so what it ran couldn\'t be read', spawned: spawned() }; }
      return reach!.atExit;
    },
    async stop() {
      let attached = true;
      try { await ready; } catch { attached = false; }
      const all = attached ? await reach!.spawnedNow() : spawned();
      reach?.close();
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      return { spawned: all };
    },
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

export function decodeMappings(mappings: string) {
  const lines: Segment[][] = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const line of mappings.split(';')) {
    const segments: Segment[] = [];
    let genCol = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const c of seg) {
        const digit = B64_VALUE[c];
        if (digit === undefined) throw new Error(`a source map's mappings hold ${JSON.stringify(c)}, which isn't base64`);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      genCol += fields[0];
      if (fields.length >= 4) {
        srcIdx += fields[1];
        srcLine += fields[2];
        srcCol += fields[3];
        segments.push([genCol, srcIdx, srcLine, srcCol]);
      } else segments.push([genCol]);
    }
    lines.push(segments);
  }
  return lines;
}

function mapFromUrl(url: string, baseDir: string): { map: SourceMap; dir: string } {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    return { map: JSON.parse(meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf-8') : decodeURIComponent(body)), dir: baseDir };
  }
  const file = mapPathOf(url, baseDir);
  return { map: JSON.parse(readFileSync(file, 'utf-8')), dir: dirname(file) };
}

const mapPathOf = (url: string, baseDir: string) => (url.startsWith('file:') ? fileURLToPath(url) : resolve(baseDir, url));

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function sourcesIn({ map, dir }: { map: SourceMap; dir: string }) {
  const root = map.sourceRoot ?? '';
  return (map.sources ?? []).map((s) => {
    const joined = root && !URL_SCHEME.test(s) && !isAbsolute(s) ? `${root.replace(/\/$/, '')}/${s}` : s;
    if (joined.startsWith('file://')) return fileURLToPath(joined);
    if (URL_SCHEME.test(joined)) return joined;
    return resolve(dir, joined);
  });
}

function mapCommentOf(text: string) {
  const all = [...text.matchAll(/\/\/[#@] sourceMappingURL=(\S+)\s*$/gm)];
  return all.length ? all.at(-1)![1] : null;
}

function lineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function innermostRan(blocks: Block[]) {
  type Entry = [Block, number];
  const less = (a: Entry, b: Entry) => (a[0].endOffset - a[0].startOffset) - (b[0].endOffset - b[0].startOffset) || a[1] - b[1];
  const byStart = blocks.map((b, i): Entry => [b, i]).sort((x, y) => x[0].startOffset - y[0].startOffset);
  const heap: Entry[] = [];
  const swap = (i: number, j: number) => { [heap[i], heap[j]] = [heap[j], heap[i]]; };
  const push = (x: Entry) => {
    heap.push(x);
    for (let k = heap.length - 1; k > 0;) { const p = (k - 1) >> 1; if (less(heap[k], heap[p]) >= 0) break; swap(k, p); k = p; }
  };
  const pop = () => {
    const last = heap.pop();
    if (!heap.length) return;
    heap[0] = last!;
    for (let k = 0; ;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < heap.length && less(heap[l], heap[m]) < 0) m = l;
      if (r < heap.length && less(heap[r], heap[m]) < 0) m = r;
      if (m === k) break;
      swap(k, m);
      k = m;
    }
  };
  const scan = (offset: number) => {
    let best: Block | null = null;
    for (const b of blocks) {
      if (b.startOffset <= offset && offset < b.endOffset && (best === null || b.endOffset - b.startOffset < best.endOffset - best.startOffset)) best = b;
    }
    return best ? best.hasExecuted : false;
  };
  let next = 0;
  let last = -Infinity;
  return (offset: number) => {
    if (offset < last) return scan(offset);
    last = offset;
    while (next < byStart.length && byStart[next][0].startOffset <= offset) push(byStart[next++]);
    while (heap.length && heap[0][0].endOffset <= offset) pop();
    return heap.length ? heap[0][0].hasExecuted : false;
  };
}

export function segmentAt(lineSegments: Segment[], col: number) {
  let found: Segment | null = null;
  for (const s of lineSegments) { if (s[0] <= col) found = s; else break; }
  return found && found.length >= 4 ? (found as [number, number, number, number]) : null;
}

interface Maps { servedLines: Segment[][]; chain: { lines: Segment[][]; sources: string[] } | null; unread?: undefined }
const decodedMaps = new Map<string, { inlineMap: string; disk: string; ownText: string | null; maps: Maps }>();

function mapsOf(script: Extract<Script, { served: string }>): Maps | { unread: string } {
  const disk = readFileSync(script.path, 'utf-8');
  const own = mapCommentOf(disk);
  let ownText: string | null = null;
  if (own && !own.startsWith('data:')) {
    try { ownText = readFileSync(mapPathOf(own, dirname(script.path)), 'utf-8'); } catch (e) { return { unread: `${script.path}: its source map couldn't be read: ${(e as Error).message}` }; }
  }
  const kept = decodedMaps.get(script.path);
  if (kept && kept.inlineMap === script.inlineMap && kept.disk === disk && kept.ownText === ownText) return kept.maps;
  const served = mapFromUrl(script.inlineMap, dirname(script.path));
  if ((served.map.sources ?? []).length !== 1) return { unread: `${script.path}: Bun's map names ${served.map.sources?.length ?? 0} sources, not the one file` };
  let chain: Maps['chain'] = null;
  if (own) {
    try {
      const m = mapFromUrl(own, dirname(script.path));
      chain = { lines: decodeMappings(m.map.mappings ?? ''), sources: sourcesIn(m) };
    } catch (e) { return { unread: `${script.path}: its source map couldn't be read: ${(e as Error).message}` }; }
  }
  const maps: Maps = { servedLines: decodeMappings(served.map.mappings ?? ''), chain };
  decodedMaps.set(script.path, { inlineMap: script.inlineMap, disk, ownText, maps });
  return maps;
}

type ScriptFiles = Map<string, { code: Set<number>; ran: Set<number> }>;

export function scriptLines(script: Script): { files: ScriptFiles; unread?: undefined } | { unread: string; files?: undefined } {
  if (script.unread !== undefined) return { unread: `${script.path}: ${script.unread}` };
  if (!script.inlineMap) return { unread: `${script.path}: Bun gave no map of the code it ran to the file` };
  const maps = mapsOf(script);
  if (maps.unread !== undefined) return maps;
  const { servedLines, chain } = maps;
  const starts = lineStarts(script.served);
  const ran = innermostRan(script.blocks);
  const files = new Map<string, { code: Set<number>; ran: Set<number> }>();
  const at = (file: string) => { if (!files.has(file)) files.set(file, { code: new Set(), ran: new Set() }); return files.get(file)!; };
  for (const file of chain ? chain.sources : [script.path]) at(file);
  let previous: [number, number] | null = null;
  servedLines.forEach((segments, genLine) => {
    segments.forEach(([genCol, , diskLine, diskCol], i) => {
      if (diskLine === undefined) { previous = null; return; }
      const same = previous !== null && previous[0] === diskLine && previous[1] === diskCol;
      previous = [diskLine, diskCol!];
      // Bun's map starts each line it prints with a segment at the position the line before ended on, which
      // names no code of its own.
      if (i === 0 && same) return;
      const executed = ran(starts[genLine] + genCol);
      let file = script.path;
      let line = diskLine;
      if (chain) {
        const s = segmentAt(chain.lines[diskLine] ?? [], diskCol!);
        if (!s) return;
        file = chain.sources[s[1]];
        line = s[2];
      }
      const f = at(file);
      f.code.add(line + 1);
      if (executed) f.ran.add(line + 1);
    });
  });
  return { files };
}

const IMPORTS = /(?:^|[;\s])(?:import|export)(?=[\s{*])[^'"`;]*?from\s*(['"])([^'"]+)\1|(?:^|[;\s])import\s*(['"])([^'"]+)\3|import\s*\(\s*(['"])([^'"]+)\5\s*\)|import\s*\(\s*([^'"\s)][^)]*)\)/g;
const callsOf = (name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(\\s*(?:(['"])([^'"]+)\\1\\s*\\)|([^'"\\s)][^)]*)\\))`, 'g');
const REQUIRES = /(?<![\w$.])(?:module\.)?require\s*\(\s*(?:(['"])([^'"]+)\1\s*\)|([^'"\s)][^)]*)\))/g;
const CREATE_REQUIRE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?createRequire\s*\(/g;
const REQUIRE_OTHERWISE = /(?<![\w$.])(?<!(?:const|let|var)\s+)require\b(?!\s*\()/;
const STARTS_WORKER = /\bWorker\b/;
const STARTS_CHILD = /\bBun\.(?:spawn(?:Sync)?\s*\(|\$)|['"]bun['"]/;
const CHILD_PROCESS = /['"](?:node:)?child_process['"]/;
const CHILD_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

const SCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

function resolveRelative(from: string, spec: string) {
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.ts')]) if (isFile(p)) return p;
  return null;
}

const isBuiltin = (spec: string) => spec.startsWith('node:') || spec.startsWith('bun:') || spec === 'bun' || builtinModules.includes(spec);

export function closureOf(entry: string, { resolveDynamic = () => null }: { resolveDynamic?: Tree['resolveDynamic'] } = {}) {
  const files = new Set<string>();
  const unknown: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch (e) { unknown.push(`${file} couldn't be read: ${(e as Error).message}`); continue; }
    if (STARTS_WORKER.test(text)) unknown.push(`${file} mentions Worker, so it may start a worker, which the scan doesn't follow`);
    if (STARTS_CHILD.test(text) || (CHILD_PROCESS.test(text) && CHILD_CALL.test(text))) unknown.push(`${file} starts a child process, which the scan doesn't follow`);
    const loads: Array<{ spec: string | undefined; expr: string | undefined }> = [...text.matchAll(IMPORTS)].map((m) => ({ spec: m[2] ?? m[4] ?? m[6], expr: m[7] }));
    for (const m of text.matchAll(REQUIRES)) loads.push({ spec: m[2], expr: m[3] });
    const made = [...text.matchAll(CREATE_REQUIRE)].map((m) => m[1]);
    if (/\bcreateRequire\s*\(/.test(text) && made.length === 0) unknown.push(`${file} calls createRequire in a way the scan doesn't follow`);
    if (REQUIRE_OTHERWISE.test(text)) unknown.push(`${file} uses require other than by calling it, which the scan doesn't follow`);
    for (const name of made.filter((n) => n !== 'require')) for (const m of text.matchAll(callsOf(name))) loads.push({ spec: m[2], expr: m[3] });
    for (const { spec, expr } of loads) {
      if (spec === undefined) {
        const named = resolveDynamic(file, expr!.trim());
        if (named === null) unknown.push(`${file} loads \`${expr!.trim()}\`, a path only known as it runs`);
        else if (named !== false) queue.push(named);
        continue;
      }
      if (!/^[./]/.test(spec)) {
        if (!isBuiltin(spec)) unknown.push(`${file} loads ${spec}, which the scan doesn't follow`);
        continue;
      }
      const target = resolveRelative(file, spec);
      if (target) queue.push(target);
      else unknown.push(`${file} loads ${spec}, which doesn't resolve to a file`);
    }
  }
  return { files, unknown };
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

function sourcesOf(file: string) {
  let own;
  try { own = mapCommentOf(readFileSync(file, 'utf-8')); } catch { return [file]; }
  if (!own) return [file];
  try { return [file, ...sourcesIn(mapFromUrl(own, dirname(file)))]; } catch { return null; }
}

function holdsCode(lines: string[], line: number, col: number) {
  const rest = (lines[line] ?? '').slice(col).trimStart();
  return rest !== '' && !rest.startsWith('//') && !rest.startsWith('/*');
}

function codeOnDisk(builtDirs: string[], placed: (p: string) => string | null) {
  const code = new Map<string, Set<number>>();
  const texts = new Map<string, string[]>();
  for (const dir of builtDirs) {
    let entries;
    try { entries = readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const name of entries) {
      if (!String(name).endsWith('.map') || /\.d\.[cm]?ts\.map$/.test(String(name))) continue;
      let m;
      try { m = mapFromUrl(join(dir, String(name)), dir); } catch { continue; }
      const paths = sourcesIn(m);
      const sources = paths.map(placed);
      for (const rel of sources) if (rel !== null && !code.has(rel)) code.set(rel, new Set());
      decodeMappings(m.map.mappings ?? '').forEach((segments) => {
        for (const [, idx, line, col] of segments) {
          if (idx === undefined) continue;
          const rel = sources[idx];
          if (rel === null) continue;
          if (!texts.has(rel)) texts.set(rel, readFileSync(paths[idx], 'utf-8').split('\n'));
          if (!holdsCode(texts.get(rel)!, line!, col!)) continue;
          if (!code.has(rel)) code.set(rel, new Set());
          code.get(rel)!.add(line! + 1);
        }
      });
    }
  }
  return code;
}

const scriptOf = (argv: string[]) => (/^(bun|node)(\.exe)?$/.test(basename(argv[0] ?? '')) ? argv[1] : argv[0]);

const readSources = new Map<string, { disk: string; ownText: string | null; sources: string[] }>();

function readSourcesOf(path: string) {
  try {
    const disk = readFileSync(path, 'utf-8');
    const own = mapCommentOf(disk);
    if (!own) return [path];
    const ownText = own.startsWith('data:') ? null : readFileSync(mapPathOf(own, dirname(path)), 'utf-8');
    const kept = readSources.get(path);
    if (kept && kept.disk === disk && kept.ownText === ownText) return kept.sources;
    const sources = sourcesIn(mapFromUrl(own, dirname(path)));
    readSources.set(path, { disk, ownText, sources });
    return sources;
  } catch { return null; }
}

function treeOf({ root, roots, built = [] }: Partial<Roots> & Pick<TreeOptions, 'built'>) {
  const realRoots = (roots ?? [root!]).map((r) => real(resolve(r)));
  const rootOf = (p: string) => (isAbsolute(p) ? realRoots.find((r) => under(real(p), r)) ?? null : null);
  const rel = (p: string) => { const r = rootOf(p); return r ? relative(r, real(p)) : p; };
  const placed = (p: string) => (isAbsolute(p) && existsSync(p) && rootOf(p) ? rel(p) : null);
  return { rootOf, rel, placed, realRoots, builtDirs: realRoots.flatMap((r) => built.map((d) => real(resolve(r, d)))) };
}

function quietOf(roots: string[], home: string | null | undefined) {
  const prefixes = [...new Set([...roots.flatMap((r) => [r, real(r)]), ...(home ? [home, real(home)] : [])])].sort((a, b) => b.length - a.length);
  return (text: string) => prefixes.reduce((t, p) => t.split(`${p}${sep}`).join(''), text);
}

export function digestOf(read: Read, { root, roots, built = [], harnessDir, resolveDynamic, only = null, home = null }: Tree): Digest {
  const { rootOf, rel, placed: inTree, builtDirs, realRoots } = treeOf({ root, roots, built });
  const quiet = quietOf([...(roots ?? [root!]).map((r) => resolve(r)), ...realRoots], home);
  const kept = only && new Set(only);
  const placed = (p: string) => { const at = inTree(p); return at !== null && kept && !kept.has(at) ? false : at; };
  const realHarness = harnessDir ? real(harnessDir) : null;
  const named: Digest['named'] = {};
  const notes: string[] = [];
  const fallbacks: string[] = [];
  const maplessBuilt: string[] = [];
  const unprofiled: Record<string, string> = {};
  for (const script of read.unread !== undefined ? [] : read.scripts) {
    if (builtDirs.some((d) => under(script.path, d)) && !mapCommentOf(readFileSync(script.path, 'utf-8'))) {
      maplessBuilt.push(rel(script.path));
      continue;
    }
    const from = kept ? readSourcesOf(script.path) : null;
    if (from && !from.some((f) => { const at = placed(f); return at !== false && !(at === null && !rootOf(script.path)); })) continue;
    const lines = scriptLines(script);
    if (lines.unread !== undefined) { notes.push(lines.unread); continue; }
    for (const [file, got] of lines.files) {
      const at = placed(file);
      if (at === false) continue;
      if (at === null) {
        if (!rootOf(script.path)) continue;
        notes.push(`${rel(script.path)}'s map names ${file}, ${isAbsolute(file) && existsSync(file) ? 'outside the tree' : 'which isn\'t a file on disk'}, so which changed file it ran can't be told`);
        continue;
      }
      named[at] ??= { code: [], ran: [] };
      for (const l of got.code) named[at].code.push(l);
      for (const l of got.ran) named[at].ran.push(l);
    }
  }
  for (const s of read.spawned ?? []) {
    if (s.kind === 'child') {
      const script = scriptOf(s.argv);
      if (realHarness && script && isAbsolute(script) && under(real(script), realHarness)) continue;
      fallbacks.push(`a child process the host started, \`${s.argv.join(' ')}\`, ran unprofiled`);
    } else if (s.kind === 'unread') {
      fallbacks.push(`${s.why}, so a worker or child the host started may have gone unlogged`);
    } else if (s.kind === 'unlogged') {
      if (s.count === null) fallbacks.push('whether the preload logged every worker and child the host started couldn\'t be read');
      for (let i = 0; i < (s.count ?? 0); i++) fallbacks.push('the preload couldn\'t log a worker or child the host started, so reach can\'t follow its code');
    } else if (s.kind === 'worker') {
      if (s.eval) { fallbacks.push('a worker the host started ran code given as text, unprofiled'); continue; }
      const entry = pathOf(s.entry);
      if (!isAbsolute(entry)) { fallbacks.push(`a worker the host started from \`${s.entry}\`, an entry the harness can't place, ran unprofiled`); continue; }
      const c = closureOf(entry, { resolveDynamic });
      if (c.unknown.length) fallbacks.push(`a worker the host started (${rel(entry)}): ${c.unknown.join('; ')}`);
      for (const f of c.files) {
        const sources = sourcesOf(f);
        if (sources === null) { fallbacks.push(`a worker the host started (${rel(entry)}) can run ${rel(f)}, whose source map couldn't be read`); continue; }
        for (const source of sources) {
          const at = placed(source);
          if (at !== null && at !== false) unprofiled[at] = `it can run in a worker the host started (${rel(entry)}), which isn't profiled`;
        }
      }
    }
  }
  const quieted = (list: string[]) => list.map(quiet);
  if (read.unread !== undefined) return { ...unreadDigest(quiet(read.unread)), fallbacks: quieted(fallbacks), unprofiled };
  return { named, notes: quieted(notes), fallbacks: quieted(fallbacks), maplessBuilt, unprofiled: Object.fromEntries(Object.entries(unprofiled).map(([f, why]) => [f, quiet(why)])) };
}

type ReachInput = { changed: ChangedLines; digests?: Digest[]; split?: Record<string, string> };

export function reachOf({ root, roots, built = [], changed, reads = [], digests = [], onDisk = null, split = {}, harnessDir, resolveDynamic }:
  | (Tree & ReachInput & { reads?: Read[]; onDisk?: Record<string, number[]> | null })
  | (Partial<Roots> & TreeOptions & ReachInput & { reads?: []; onDisk: Record<string, number[]> })) {
  const named = new Map<string, { code: Set<number>; ran: Set<number> }>();
  const notes: string[] = [];
  const fallbacks: string[] = [];
  const maplessBuilt: string[] = [];
  const unprofiledFiles = new Map<string, string>();
  for (const d of [...reads.map((r) => digestOf(r, { root, roots, built, harnessDir, resolveDynamic } as Tree)), ...digests]) {
    for (const [file, got] of Object.entries(d.named)) {
      if (!named.has(file)) named.set(file, { code: new Set(), ran: new Set() });
      for (const l of got.code) named.get(file)!.code.add(l);
      for (const l of got.ran) named.get(file)!.ran.add(l);
    }
    notes.push(...d.notes, ...d.fallbacks);
    fallbacks.push(...d.fallbacks);
    maplessBuilt.push(...d.maplessBuilt);
    for (const [file, why] of Object.entries(d.unprofiled)) unprofiledFiles.set(file, why);
  }
  const mapless = [...new Set(maplessBuilt)];
  if (mapless.length) notes.unshift(`${mapless.join(', ')} ran with no source map, so it may hold a copy of any changed file's code`);
  let disk = onDisk && new Map(Object.entries(onDisk).map(([file, lines]) => [file, new Set(lines)]));
  const files: Record<string, ReachFile> = {};
  for (const [file, { lines, deletions = [], binary = false }] of Object.entries(changed)) {
    if (binary || !SCRIPT_SOURCE.test(file)) {
      const why = [...new Set([...notes, `${file} isn't script source, so whether its change ran can't be read`])];
      files[file] = { state: 'couldnt-tell', ran: [], notRan: [], noCode: [], couldntTell: [], unloaded: [...lines].sort((a, b) => a - b),
        deletions: deletions.map((d) => ({ after: d.after, state: 'unloaded', by: null })), ...(binary ? { binary: true } : {}), reason: why.join('; ') };
      continue;
    }
    const got = named.get(file);
    const why = [...new Set([...notes, ...(unprofiledFiles.has(file) ? [unprofiledFiles.get(file)] : []), ...(split[file] ? [split[file]] : [])])];
    const entry: ReachFile = { state: got ? 'read' : 'not-loaded', ran: [], notRan: [], noCode: [], couldntTell: [], unloaded: [], deletions: [] };
    if (!got && why.length) entry.state = 'couldnt-tell';
    if (!got && !disk) { const t = treeOf({ root, roots, built }); disk = codeOnDisk(t.builtDirs, t.placed); }
    const code = got ? got.code : disk!.get(file) ?? null;
    const ran = got ? got.ran : new Set<number>();
    for (const l of [...lines].sort((a, b) => a - b)) {
      if (code === null) entry.unloaded.push(l);
      else if (!code.has(l)) (got && (split[file] || mapless.length) ? entry.couldntTell : entry.noCode).push(l);
      else if (ran.has(l)) entry.ran.push(l);
      else if (why.length) entry.couldntTell.push(l);
      else entry.notRan.push(l);
    }
    if (entry.couldntTell.length || (entry.state === 'couldnt-tell')) entry.reason = why.join('; ');
    for (const d of deletions) {
      if (code === null) { entry.deletions.push({ after: d.after, state: 'unloaded', by: null }); continue; }
      const before = [...code].filter((l) => l <= d.after).sort((a, b) => b - a)[0];
      const after = [...code].filter((l) => l > d.after).sort((a, b) => a - b)[0];
      const by = [before, after].find((l) => l !== undefined && ran.has(l)) ?? before ?? after ?? null;
      const state = by === null ? (got && (split[file] || mapless.length) ? 'couldnt-tell' : 'no-code') : ran.has(by) ? 'reached' : why.length ? 'couldnt-tell' : 'not-reached';
      entry.deletions.push({ after: d.after, state, by });
      if (state === 'couldnt-tell') entry.reason = why.join('; ');
    }
    files[file] = entry;
  }
  return { files, notes: [...new Set(notes)], fallbacks: { fired: fallbacks.length, notes: [...new Set(fallbacks)] } };
}

export function packRoots(lock: Record<string, unknown>, installDir: string, name: string) {
  const roots = Object.keys(lock).filter((at) => at.endsWith(`node_modules/${name}`)).map((at) => join(installDir, at));
  if (!roots.length) throw new Error(`the install holds no ${name}`);
  return roots;
}

export function reachPackOf<P extends { name: string }>(packs: P[], named: string | null | undefined): P | null {
  if (named === null || named === undefined) {
    if (packs.length > 1) throw new Error(`--reach with ${packs.length} overlays needs --reach-package, naming the overlay the diff is of`);
    return packs[0] ?? null;
  }
  if (!packs.length) throw new Error(`--reach-package ${named} names an overlay, and none was given`);
  const pack = packs.find((p) => p.name === named);
  if (!pack) throw new Error(`--reach-package ${named} names none of the overlays: ${packs.map((p) => p.name).join(', ')}`);
  return pack;
}

export function digestsOf(reads: Read[], id: string, tree: Tree) {
  const at = (x: Read) => `${id}${x.fleet ? `, fleet child ${x.fleet.child}` : ''}${x.boot ? `, boot ${x.boot}` : ''}`;
  const left = new Map<string, number>();
  for (const x of reads) if (x.fleet) left.set(x.fleet.recipePath, (left.get(x.fleet.recipePath) ?? 0) + 1);
  const followed = (s: Spawned) => {
    if (s.kind !== 'child') return false;
    const recipe = [...left.keys()].find((p) => s.argv.includes(p) && left.get(p)! > 0);
    if (!recipe) return false;
    left.set(recipe, left.get(recipe)! - 1);
    return true;
  };
  reads = reads.map((x) => (x.fleet || !x.spawned ? x : { ...x, spawned: x.spawned.filter((s) => !followed(s)) }));
  return reads.map((x) => {
    try { return digestOf(x.unread !== undefined ? { ...x, unread: `${at(x)}: ${x.unread}` } : x, tree); } catch (e) {
      return unreadDigest(quietOf([...(tree.roots ?? [tree.root!]).map((r) => resolve(r))], tree.home)(`${at(x)}: its read couldn't be digested: ${(e as Error).message}`));
    }
  });
}

export function splitBuilds({ root, roots, built = [], changed }: Tree & { changed: ChangedLines }) {
  const { rel, placed, builtDirs } = treeOf({ root, roots, built });
  const by = new Map<string, Set<string>>();
  const unread: string[] = [];
  for (const dir of builtDirs) {
    let entries;
    try { entries = readdirSync(dir, { recursive: true }); } catch (e) { unread.push(`${rel(dir)} couldn't be listed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); continue; }
    for (const name of entries) {
      if (!/\.[cm]?js$/.test(String(name))) continue;
      const script = join(dir, String(name));
      const sources = readSourcesOf(script);
      if (sources === null) { unread.push(`${rel(script)}'s source map couldn't be read`); continue; }
      for (const at of new Set<string | null | false>(sources.map(placed))) {
        if (at === null || at === false || !(at in changed)) continue;
        if (!by.has(at)) by.set(at, new Set());
        by.get(at)!.add(rel(script));
      }
    }
  }
  const split: Record<string, string> = {};
  for (const [file, scripts] of by) {
    if (scripts.size > 1) split[file] = `${file} is built into more than one script (${[...scripts].sort().join(', ')}), and reach reads a changed file's code from the one a host loaded`;
  }
  if (unread.length) for (const file of Object.keys(changed)) split[file] ??= `${unread.join('; ')}, so a changed file built into it can't be told`;
  return split;
}

export const unreadDigest = (why: string): Digest => ({ named: {}, notes: [why], fallbacks: [], maplessBuilt: [], unprofiled: {} });

export function reachJoined(parts: Array<ReachPartRead | { missing: string }>): ReachJson {
  const got = parts.filter((p): p is ReachPartRead => !(p as { missing?: string }).missing);
  if (!got.length) return { couldnt: parts.map((p) => (p as { missing: string }).missing).join('; ') };
  const { change, changed, onDisk } = got[0];
  for (const [key, what] of [['change', 'what changed'], ['changed', 'the change\'s lines'], ['onDisk', 'the built maps\' code lines'], ['split', 'which changed files are built into more than one script']] as Array<[keyof ReachPartRead, string]>) {
    if (got.some((p) => JSON.stringify(p[key]) !== JSON.stringify(got[0][key]))) throw new Error(`the shares don't agree on ${what}`);
  }
  for (const p of got) {
    const boots = Object.values(p.drives ?? {}).reduce((n, d) => n + d.length, 0);
    const read = (p.digests ?? []).filter((d) => !d.noDrive).length;
    if (read < boots) throw new Error(`a share read ${boots} boot${boots === 1 ? '' : 's'} but brought ${read} digests of them`);
  }
  const digests = parts.flatMap((p) => ((p as { missing?: string }).missing ? [unreadDigest((p as { missing: string }).missing)] : (p as ReachPartRead).digests));
  const { files, notes, fallbacks } = reachOf({ changed, onDisk, split: got[0].split ?? {}, digests });
  return { change, files, notes, fallbacks, drives: Object.assign({}, ...got.map((p) => p.drives)), code: { wrote: [...new Set(got.map((p) => p.writer))], joined: REACH_CODE } };
}

const REACH_CODE = (() => {
  const h = createHash('sha256');
  for (const path of [fileURLToPath(import.meta.url), PRELOAD, ...['./interfaces.ts', '../cut/cut.ts', '../cut/interfaces.ts'].map((p) => fileURLToPath(new URL(p, import.meta.url)))]) {
    const bytes = readFileSync(path);
    h.update(`${bytes.length}\n`).update(bytes);
  }
  return h.digest('hex');
})();

export const driveOf = (reads: Read[]): ReachDrive[] => reads.map((x) => ({ boot: x.boot ?? null, read: x.unread === undefined, ...(x.fleet ? { child: x.fleet.child } : {}) }));

export function reachPart({ root, roots, built = [], change, changed, drives, digests, split = {} }: Tree & Pick<ReachPart, 'change' | 'changed' | 'drives' | 'digests'> & { split?: Record<string, string> }): ReachPart {
  return { change, writer: REACH_CODE, changed, onDisk: builtCodeOf({ root, roots, built, changed } as Tree & { changed: ChangedLines }), split, drives, digests };
}

export function builtCodeOf({ root, roots, built = [], changed }: Tree & { changed: ChangedLines }) {
  const { builtDirs, placed } = treeOf({ root, roots, built });
  const code = codeOnDisk(builtDirs, placed);
  return Object.fromEntries(Object.keys(changed).filter((f) => code.has(f)).map((f) => [f, [...code.get(f)!].sort((a, b) => a - b)]));
}

export type ProfiledDrive = { couldnt: string; d?: undefined } | { couldnt?: undefined; d: { run: { failure?: { step?: unknown; reason: string } | null; reads: Read[] } } };

export function profiledReads(off: ProfiledDrive): Read[] {
  if (off.couldnt !== undefined) return [{ unread: `its profiled drive couldn't run: ${off.couldnt}` }];
  const { failure, reads } = off.d.run;
  return [
    ...reads,
    ...(failure ? [{ unread: `its profiled drive failed${failure.step != null ? ` at step ${failure.step}` : ''}: ${failure.reason}, so what it would have run after that can't be told` }] : []),
    ...(reads.length ? [] : [{ unread: 'its profiled drive started no host' }]),
  ];
}

/** A path as Git writes it in a diff's header: as it is, or, where it holds a character Git quotes (anything outside
 *  printable ASCII, a double quote or a backslash), in double quotes with C's escapes and each byte past ASCII in octal. */
export function unquoted(path: string) {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      const whole = String.fromCodePoint(body.codePointAt(i)!);
      bytes.push(...Buffer.from(whole, 'utf-8'));
      i += whole.length - 1;
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? '')) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    if (!(next in named)) throw new Error(`a diff header names ${path}, with an escape Git doesn't write`);
    bytes.push(named[next]);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf-8');
}

export function changedOf(diff: string) {
  const changed: ChangedLines = {};
  let file: string | null = null;
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; header = true; continue; }
    // A binary file's change has no lines: Git says only that it differs.
    const binary = header ? /^Binary files .+? and ((?:"b\/|b\/).*) differ$/.exec(line) : null;
    if (binary) { changed[unquoted(binary[1]).replace(/^b\//, '')] = { lines: [], deletions: [], binary: true }; continue; }
    if (header && line.startsWith('+++ ')) {
      // Git ends a header naming a path with whitespace in it with a tab; the path's own spaces are kept.
      const to = unquoted(line.slice(4).replace(/\t$/, ''));
      file = to === '/dev/null' ? null : to.replace(/^b\//, '');
      if (file !== null) changed[file] ??= { lines: [], deletions: [] };
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) header = false;
    if (!hunk || file === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) changed[file].deletions.push({ after: start });
    for (let l = start; l < start + count; l++) changed[file].lines.push(l);
  }
  return changed;
}

export const reachPreload = PRELOAD;
