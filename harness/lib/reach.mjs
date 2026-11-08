import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'reach-preload.cjs');

function freePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

function inspectorClient(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const scripts = new Map();
  const listeners = [];
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error(`couldn't attach to the inspector at ${url}`)));
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message ?? 'inspector error'}`));
      else res(m.result ?? {});
    } else if (m.method === 'Debugger.scriptParsed') {
      scripts.set(m.params.scriptId, { url: m.params.url ?? '', sourceMapURL: m.params.sourceMapURL ?? '' });
    } else if (m.method) {
      for (const listener of listeners) listener(m);
    }
  });
  ws.addEventListener('close', () => {
    for (const { rej } of pending.values()) rej(new Error('the inspector closed before it answered'));
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { opened, call, scripts, on: (listener) => listeners.push(listener), close: () => ws.close() };
}

const pathOf = (url) => (url.startsWith('file://') ? fileURLToPath(url) : url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_POINT = (() => {
  const path = realpathSync(PRELOAD);
  return { path, line: readFileSync(path, 'utf-8').split('\n').findIndex((l) => l.startsWith('function readPoint')) + 1 };
})();

/** What to add to a Bun command line, and its environment, to run it profiled. */
export async function reachLaunch({ logDir }) {
  const port = await freePort();
  const path = `reach${Math.random().toString(36).slice(2, 10)}`;
  const logPath = join(logDir, `reach-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  return { args: [`--inspect-wait=127.0.0.1:${port}/${path}`, '--preload', PRELOAD], env: { CONTEXT_VIEW_REACH_LOG: logPath }, url: `ws://127.0.0.1:${port}/${path}`, logPath };
}

/** Attaches to a host started with reachLaunch's additions. `atExit` is the read taken where it exits by process.exit,
 *  or unread if it exits any other way. While that read is taken `reading` is its promise, and `readMs()` is the time
 *  the reads there have taken. */
export function reachAttach({ launch, child, wanted = () => false }) {
  const { url, logPath } = launch;
  let client = null;
  let breakpointId = null;
  let reading = null;
  let readMs = 0;
  let settleExit;
  const atExit = new Promise((res) => { settleExit = res; });
  const spawnLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const exited = gone() ? Promise.resolve({ code: child.exitCode, signal: child.signalCode }) : new Promise((res) => child.once('exit', (code, signal) => res({ code, signal })));
  exited.then(({ code, signal }) => settleExit({ unread: `the host exited (${code ?? signal}) other than by process.exit, so its blocks weren't read`, spawned: spawnLog() }));

  async function readScripts(w) {
    const scripts = [];
    for (const [scriptId, s] of client.scripts) {
      const path = pathOf(s.url);
      if (!isAbsolute(path) || !w(path)) continue;
      try {
        const { scriptSource } = await client.call('Debugger.getScriptSource', { scriptId });
        const { basicBlocks } = await client.call('Runtime.getBasicBlocks', { sourceID: scriptId });
        scripts.push({ path, served: scriptSource, blocks: basicBlocks, inlineMap: s.sourceMapURL });
      } catch (e) { scripts.push({ path, unread: e.message }); }
    }
    return { scripts, spawned: spawnLog() };
  }

  const attached = (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      client = inspectorClient(url);
      try { await client.opened; break; } catch (e) {
        if (Date.now() > deadline || gone()) throw e;
        await sleep(50);
      }
    }
    client.on(async (m) => {
      if (m.method !== 'Debugger.paused') return;
      const hit = m.params.data?.breakpointId ?? null;
      if (breakpointId !== null && (hit === breakpointId || (m.params.hitBreakpoints ?? []).includes(breakpointId))) {
        reading = (async () => {
          const since = performance.now();
          try { return await readScripts(wanted); } catch (e) {
            return { unread: `the host's blocks couldn't be read where it exits: ${e.message}`, spawned: spawnLog() };
          } finally { readMs += performance.now() - since; }
        })();
        const got = await reading;
        reading = null;
        settleExit(got);
      }
      client.call('Debugger.resume').catch(() => {});
    });
    await client.call('Runtime.enableControlFlowProfiler');
    await client.call('Debugger.enable');
    await client.call('Debugger.setBreakpointsActive', { active: true });
    const escaped = READ_POINT.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ({ breakpointId } = await client.call('Debugger.setBreakpointByUrl', { urlRegex: `^(file://)?${escaped}$`, lineNumber: READ_POINT.line, columnNumber: 0 }));
    await client.call('Inspector.initialized');
  })();
  attached.catch(() => {});

  return {
    attached,
    atExit,
    get reading() { return reading; },
    readMs: () => readMs,
    spawnLog,
    async read(w = wanted) {
      try { await attached; } catch (e) { return { unread: `the inspector never attached to the host: ${e.message}`, spawned: spawnLog() }; }
      // The inspector answers a call only after the events it sent before it, so every script parsed so far is in.
      await client.call('Runtime.evaluate', { expression: '0' });
      return readScripts(w);
    },
    close() { client?.close(); },
  };
}

export function profiledHost({ args, cwd, logDir, env = {}, preloads = [], wanted }) {
  const out = [];
  let child = null;
  let reach = null;
  const ready = (async () => {
    const launch = await reachLaunch({ logDir });
    child = spawn('bun', [...launch.args, ...preloads.flatMap((p) => ['--preload', p]), ...args], {
      cwd, env: { ...process.env, ...env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    child.stdout.on('data', (d) => out.push(d.toString()));
    child.stderr.on('data', (d) => out.push(d.toString()));
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
    async waitFor(pattern, ms = 15_000) {
      await ready;
      const deadline = Date.now() + ms;
      while (!pattern.test(text())) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the host never printed ${pattern}: ${text().slice(-2000)}`);
        await sleep(25);
      }
    },
    async read(w) {
      try { await ready; } catch (e) { return { unread: `the inspector never attached to the host: ${e.message}`, spawned: spawned() }; }
      return reach.read(w);
    },
    async atExit() {
      try { await ready; } catch (e) { return { unread: `the inspector never attached to the host: ${e.message}`, spawned: spawned() }; }
      return reach.atExit;
    },
    async stop() {
      try { await ready; } catch {}
      reach?.close();
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      return { spawned: spawned() };
    },
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = Object.fromEntries([...B64].map((c, i) => [c, i]));

export function decodeMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let genCol = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const fields = [];
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
      }
    }
    lines.push(segments);
  }
  return lines;
}

function mapFromUrl(url, baseDir) {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    return { map: JSON.parse(meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf-8') : decodeURIComponent(body)), dir: baseDir };
  }
  const file = resolve(baseDir, url);
  return { map: JSON.parse(readFileSync(file, 'utf-8')), dir: dirname(file) };
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function sourcesIn({ map, dir }) {
  const root = map.sourceRoot ?? '';
  return (map.sources ?? []).map((s) => {
    const joined = root && !URL_SCHEME.test(s) && !isAbsolute(s) ? `${root.replace(/\/$/, '')}/${s}` : s;
    if (joined.startsWith('file://')) return fileURLToPath(joined);
    if (URL_SCHEME.test(joined)) return joined;
    return resolve(dir, joined);
  });
}

function mapCommentOf(text) {
  const all = [...text.matchAll(/\/\/[#@] sourceMappingURL=(\S+)\s*$/gm)];
  return all.length ? all.at(-1)[1] : null;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function innermostRan(blocks) {
  return (offset) => {
    let best = null;
    for (const b of blocks) {
      if (b.startOffset <= offset && offset < b.endOffset && (best === null || b.endOffset - b.startOffset < best.endOffset - best.startOffset)) best = b;
    }
    return best ? best.hasExecuted : false;
  };
}

function segmentAt(lineSegments, col) {
  let found = null;
  for (const s of lineSegments) { if (s[0] <= col) found = s; else break; }
  return found;
}

export function scriptLines(script) {
  if (script.unread) return { unread: `${script.path}: ${script.unread}` };
  if (!script.inlineMap) return { unread: `${script.path}: Bun gave no map of the code it ran to the file` };
  const served = mapFromUrl(script.inlineMap, dirname(script.path));
  if ((served.map.sources ?? []).length !== 1) return { unread: `${script.path}: Bun's map names ${served.map.sources?.length ?? 0} sources, not the one file` };
  const disk = readFileSync(script.path, 'utf-8');
  const own = mapCommentOf(disk);
  let chain = null;
  if (own) {
    try {
      const m = mapFromUrl(own, dirname(script.path));
      chain = { lines: decodeMappings(m.map.mappings ?? ''), sources: sourcesIn(m) };
    } catch (e) { return { unread: `${script.path}: its source map couldn't be read: ${e.message}` }; }
  }
  const starts = lineStarts(script.served);
  const ran = innermostRan(script.blocks);
  const files = new Map();
  const at = (file) => { if (!files.has(file)) files.set(file, { code: new Set(), ran: new Set() }); return files.get(file); };
  for (const file of chain ? chain.sources : [script.path]) at(file);
  let previous = null;
  decodeMappings(served.map.mappings ?? '').forEach((segments, genLine) => {
    segments.forEach(([genCol, , diskLine, diskCol], i) => {
      const same = previous !== null && previous[0] === diskLine && previous[1] === diskCol;
      previous = [diskLine, diskCol];
      // Bun's map starts each line it prints with a segment at the position the line before ended on, which
      // names no code of its own.
      if (i === 0 && same) return;
      const executed = ran(starts[genLine] + genCol);
      let file = script.path;
      let line = diskLine;
      if (chain) {
        const s = segmentAt(chain.lines[diskLine] ?? [], diskCol);
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

const IMPORTS = /(?:^|[;\s])(?:import|export)\s[^'"`;]*?from\s*(['"])([^'"]+)\1|(?:^|[;\s])import\s*(['"])([^'"]+)\3|import\(\s*(['"])([^'"]+)\5\s*\)|import\(\s*([^'"\s)][^)]*)\)/g;
const callsOf = (name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*(?:(['"])([^'"]+)\\1\\s*\\)|([^'"\\s)][^)]*)\\))`, 'g');
const REQUIRES = /(?<![\w$.])(?:module\.)?require\(\s*(?:(['"])([^'"]+)\1\s*\)|([^'"\s)][^)]*)\))/g;
const CREATE_REQUIRE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?createRequire\(/g;
const STARTS_WORKER = /\bnew\s+Worker\s*\(/;
const STARTS_CHILD = /\bBun\.spawn(?:Sync)?\s*\(/;
const CHILD_PROCESS = /['"](?:node:)?child_process['"]/;
const CHILD_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.ts')]) if (isFile(p)) return p;
  return null;
}

const isBuiltin = (spec) => spec.startsWith('node:') || spec.startsWith('bun:') || spec === 'bun' || builtinModules.includes(spec);

export function closureOf(entry, { resolveDynamic = () => null } = {}) {
  const files = new Set();
  const unknown = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch (e) { unknown.push(`${file} couldn't be read: ${e.message}`); continue; }
    if (STARTS_WORKER.test(text)) unknown.push(`${file} starts a worker, which the scan doesn't follow`);
    if (STARTS_CHILD.test(text) || (CHILD_PROCESS.test(text) && CHILD_CALL.test(text))) unknown.push(`${file} starts a child process, which the scan doesn't follow`);
    const loads = [...text.matchAll(IMPORTS)].map((m) => ({ spec: m[2] ?? m[4] ?? m[6], expr: m[7] }));
    for (const m of text.matchAll(REQUIRES)) loads.push({ spec: m[2], expr: m[3] });
    const made = [...text.matchAll(CREATE_REQUIRE)].map((m) => m[1]);
    if (/\bcreateRequire\(/.test(text) && made.length === 0) unknown.push(`${file} calls createRequire in a way the scan doesn't follow`);
    for (const name of made.filter((n) => n !== 'require')) for (const m of text.matchAll(callsOf(name))) loads.push({ spec: m[2], expr: m[3] });
    for (const { spec, expr } of loads) {
      if (spec === undefined) {
        const named = resolveDynamic(file, expr.trim());
        if (named === null) unknown.push(`${file} loads \`${expr.trim()}\`, a path only known as it runs`);
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

const under = (path, dir) => path === dir || path.startsWith(`${dir}${sep}`);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

function sourcesOf(file) {
  let own;
  try { own = mapCommentOf(readFileSync(file, 'utf-8')); } catch { return [file]; }
  if (!own) return [file];
  try { return [file, ...sourcesIn(mapFromUrl(own, dirname(file)))]; } catch { return [file]; }
}

function holdsCode(lines, line, col) {
  const rest = (lines[line] ?? '').slice(col).trimStart();
  return rest !== '' && !rest.startsWith('//') && !rest.startsWith('/*');
}

function codeOnDisk(builtDirs, placed) {
  const code = new Map();
  const texts = new Map();
  for (const dir of builtDirs) {
    let entries;
    try { entries = readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const name of entries) {
      if (!String(name).endsWith('.map')) continue;
      let m;
      try { m = mapFromUrl(join(dir, String(name)), dir); } catch { continue; }
      const paths = sourcesIn(m);
      const sources = paths.map(placed);
      decodeMappings(m.map.mappings ?? '').forEach((segments) => {
        for (const [, idx, line, col] of segments) {
          const rel = sources[idx];
          if (rel === null) continue;
          if (!texts.has(rel)) texts.set(rel, readFileSync(paths[idx], 'utf-8').split('\n'));
          if (!holdsCode(texts.get(rel), line, col)) continue;
          if (!code.has(rel)) code.set(rel, new Set());
          code.get(rel).add(line + 1);
        }
      });
    }
  }
  return code;
}

const scriptOf = (argv) => (/^(bun|node)(\.exe)?$/.test(basename(argv[0] ?? '')) ? argv[1] : argv[0]);

function treeOf({ root, roots, built = [] }) {
  const realRoots = (roots ?? [root]).map((r) => real(resolve(r)));
  const rootOf = (p) => (isAbsolute(p) ? realRoots.find((r) => under(real(p), r)) ?? null : null);
  const rel = (p) => { const r = rootOf(p); return r ? relative(r, real(p)) : p; };
  const placed = (p) => (isAbsolute(p) && existsSync(p) && rootOf(p) ? rel(p) : null);
  return { rootOf, rel, placed, builtDirs: realRoots.flatMap((r) => built.map((d) => resolve(r, d))) };
}

/** What one host's read says, by the tree's paths, small enough to keep for every boot of every run: with `only`,
 *  of those files alone. */
export function digestOf(read, { root, roots, built = [], harnessDir, resolveDynamic, only = null }) {
  if (read.unread) return unreadDigest(read.unread);
  const { rootOf, rel, placed: inTree, builtDirs } = treeOf({ root, roots, built });
  const kept = only && new Set(only);
  const placed = (p) => { const at = inTree(p); return at !== null && kept && !kept.has(at) ? false : at; };
  const realHarness = harnessDir ? real(harnessDir) : null;
  const named = {};
  const notes = [];
  const fallbacks = [];
  const maplessBuilt = [];
  const unprofiled = {};
  for (const script of read.scripts) {
    if (!script.unread && builtDirs.some((d) => under(script.path, d)) && !mapCommentOf(readFileSync(script.path, 'utf-8'))) {
      maplessBuilt.push(rel(script.path));
      continue;
    }
    const lines = scriptLines(script);
    if (lines.unread) { notes.push(lines.unread); continue; }
    for (const [file, got] of lines.files) {
      const at = placed(file);
      if (at === false) continue;
      if (at === null) {
        if (!rootOf(script.path)) continue;
        notes.push(`${rel(script.path)}'s map names ${file}, ${isAbsolute(file) && existsSync(file) ? 'outside the tree' : 'which isn\'t a file on disk'}, so which changed file it ran can't be told`);
        continue;
      }
      named[at] ??= { code: [], ran: [] };
      named[at].code.push(...got.code);
      named[at].ran.push(...got.ran);
    }
  }
  for (const s of read.spawned ?? []) {
    if (s.kind === 'child') {
      const script = scriptOf(s.argv);
      if (realHarness && script && isAbsolute(script) && under(real(script), realHarness)) continue;
      fallbacks.push(`a child process the host started, \`${s.argv.join(' ')}\`, ran unprofiled`);
    } else if (s.kind === 'worker') {
      if (s.eval) { fallbacks.push('a worker the host started ran code given as text, unprofiled'); continue; }
      const entry = pathOf(s.entry);
      if (!isAbsolute(entry)) { fallbacks.push(`a worker the host started from \`${s.entry}\`, an entry the harness can't place, ran unprofiled`); continue; }
      const c = closureOf(entry, { resolveDynamic });
      for (const u of c.unknown) fallbacks.push(`a worker the host started (${rel(entry)}): ${u}`);
      for (const f of c.files) {
        for (const source of sourcesOf(f)) {
          const at = placed(source);
          if (at !== null && at !== false) unprofiled[at] = `it can run in a worker the host started (${rel(entry)}), which isn't profiled`;
        }
      }
    }
  }
  return { named, notes, fallbacks, maplessBuilt, unprofiled };
}

/** Each changed file's lines, by what the reads, or the digests of reads, say ran. A file no read named takes its code
 *  lines from `onDisk` (as builtCodeOf gives them) or else from the tree's built maps. */
export function reachOf({ root, roots, built = [], changed, reads = [], digests = [], onDisk = null, harnessDir, resolveDynamic }) {
  const named = new Map();
  const notes = [];
  const fallbacks = [];
  const maplessBuilt = [];
  const unprofiledFiles = new Map();
  for (const d of [...reads.map((r) => digestOf(r, { root, roots, built, harnessDir, resolveDynamic })), ...digests]) {
    for (const [file, got] of Object.entries(d.named)) {
      if (!named.has(file)) named.set(file, { code: new Set(), ran: new Set() });
      for (const l of got.code) named.get(file).code.add(l);
      for (const l of got.ran) named.get(file).ran.add(l);
    }
    notes.push(...d.notes, ...d.fallbacks);
    fallbacks.push(...d.fallbacks);
    maplessBuilt.push(...d.maplessBuilt);
    for (const [file, why] of Object.entries(d.unprofiled)) unprofiledFiles.set(file, why);
  }
  const mapless = [...new Set(maplessBuilt)];
  let disk = onDisk && new Map(Object.entries(onDisk).map(([file, lines]) => [file, new Set(lines)]));
  const files = {};
  for (const [file, { lines, deletions = [] }] of Object.entries(changed)) {
    const got = named.get(file);
    const why = [...new Set([...notes, ...(unprofiledFiles.has(file) ? [unprofiledFiles.get(file)] : [])])];
    const entry = { state: got ? 'read' : 'not-loaded', ran: [], notRan: [], noCode: [], couldntTell: [], unloaded: [], deletions: [] };
    if (!got && mapless.length) why.unshift(`${mapless.join(', ')} ran with no source map, so it may be built from this file`);
    if (!got && why.length) entry.state = 'couldnt-tell';
    if (!got && !disk) { const t = treeOf({ root, roots, built }); disk = codeOnDisk(t.builtDirs, t.placed); }
    const code = got ? got.code : disk.get(file) ?? null;
    const ran = got ? got.ran : new Set();
    for (const l of [...lines].sort((a, b) => a - b)) {
      if (code === null) entry.unloaded.push(l);
      else if (!code.has(l)) entry.noCode.push(l);
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
      const state = by === null ? 'no-code' : ran.has(by) ? 'reached' : why.length ? 'couldnt-tell' : 'not-reached';
      entry.deletions.push({ after: d.after, state, by });
      if (state === 'couldnt-tell') entry.reason = why.join('; ');
    }
    files[file] = entry;
  }
  return { files, notes: [...new Set(notes)], fallbacks: { fired: fallbacks.length, notes: [...new Set(fallbacks)] } };
}

export const unreadDigest = (why) => ({ named: {}, notes: [why], fallbacks: [], maplessBuilt: [], unprofiled: {} });

/** reach.json from one or more shares' reach-digests.json, each `{change, changed, onDisk, drives, digests}`, or
 *  `{missing: why}` for a share that brought none, which makes every unseen line couldn't tell. */
export function reachJoined(parts) {
  const got = parts.filter((p) => !p.missing);
  if (!got.length) return { couldnt: parts.map((p) => p.missing).join('; ') };
  const { change, changed, onDisk } = got[0];
  const digests = parts.flatMap((p) => (p.missing ? [unreadDigest(p.missing)] : p.digests));
  const { files, notes, fallbacks } = reachOf({ changed, onDisk, digests });
  return { change, files, notes, fallbacks, drives: Object.assign({}, ...got.map((p) => p.drives)), code: { wrote: [...new Set(got.map((p) => p.writer))], joined: REACH_CODE } };
}

/** The sha256 of the code that reads hosts, shapes a share's digests and joins them, this file and the preload, each
 *  by its length and bytes, so a join by another version shows. */
const REACH_CODE = (() => {
  const h = createHash('sha256');
  for (const path of [fileURLToPath(import.meta.url), PRELOAD]) {
    const bytes = readFileSync(path);
    h.update(`${bytes.length}\n`).update(bytes);
  }
  return h.digest('hex');
})();

/** Each boot of a profiled drive, as reach.json's drives give it: read, or not. */
export const driveOf = (reads) => reads.map((x) => ({ boot: x.boot ?? null, read: !x.unread }));

/** What one invocation keeps for a join: its digests, with the changed lines and their built code lines. */
export function reachPart({ root, roots, built = [], change, changed, drives, digests }) {
  return { change, writer: REACH_CODE, changed, onDisk: builtCodeOf({ root, roots, built, changed }), drives, digests };
}

/** The code lines the tree's built maps give each changed file, for a join of digests where the tree isn't. */
export function builtCodeOf({ root, roots, built = [], changed }) {
  const { builtDirs, placed } = treeOf({ root, roots, built });
  const code = codeOnDisk(builtDirs, placed);
  return Object.fromEntries(Object.keys(changed).filter((f) => code.has(f)).map((f) => [f, [...code.get(f)].sort((a, b) => a - b)]));
}

/** The reads a self-check's profiled drive leaves: each boot's as taken, and an unread one for what it didn't run. */
export function profiledReads(off) {
  if (off.couldnt) return [{ unread: `its profiled drive couldn't run: ${off.couldnt}` }];
  const { failure, reads } = off.d.run;
  return [
    ...reads,
    ...(failure ? [{ unread: `its profiled drive failed${failure.step != null ? ` at step ${failure.step}` : ''}: ${failure.reason}, so what it would have run after that can't be told` }] : []),
    ...(reads.length ? [] : [{ unread: 'its profiled drive started no host' }]),
  ];
}

/** The changed lines of `git diff -U0` output, by the head's path: each added line, and each hunk that only deletes
 *  as the head line it follows. A deleted file has no head lines, so it isn't listed. */
export function changedOf(diff) {
  const changed = {};
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; continue; }
    if (line.startsWith('+++ ')) {
      const to = line.slice(4).trim();
      file = to === '/dev/null' ? null : to.replace(/^b\//, '');
      if (file !== null) changed[file] ??= { lines: [], deletions: [] };
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || file === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) changed[file].deletions.push({ after: start });
    for (let l = start; l < start + count; l++) changed[file].lines.push(l);
  }
  return changed;
}

export const reachPreload = PRELOAD;
