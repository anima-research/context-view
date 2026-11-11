import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import type { Advanced } from './control.ts';

// Under Bun, an ES import of a builtin module gets its exports as they stood when the first module graph importing it
// statically began to run: a wrap made later doesn't reach them, even one by a module that graph runs first, nor does
// `syncBuiltinESMExports()`, and a plugin's `module()` refuses a builtin. So `fs` is wrapped through `require`, and
// `control.ts`, which imports `node:fs`, is loaded only after the wrap. Imported statically, it binds `fs` before the
// wrap, and chokidar's `import { stat } from 'fs'` calls the real `stat`, so no stat is ever reported: D13 fails so on
// Bun 1.4.4.
const fs = createRequire(import.meta.url)('node:fs');
const statExpected = new Set<string>();
let statSeen: (at: string) => void = () => {};
const realStat = fs.stat;
fs.stat = function stat(this: unknown, path: unknown, ...rest: unknown[]) {
  if (statExpected.size) {
    const at = resolve(String(path));
    if (statExpected.delete(at)) statSeen(at);
  }
  return realStat.call(this, path, ...rest);
};
const { lineReader } = await import('./control.ts');

// A process a host starts detached leads a process group of its own, which outlives the host, as a fleet parent's
// children outlive its crash, or its drive's kill. So in a run given FIXTURE_GROUPS, a fleet run, each one's pid is
// listed there, where the drive's end kills it (fleet.ts endGroups), and under a pool in WHOLE_HOST_HOST_GROUPS, where
// the pool kills a dead drive's hosts (pool.ts stopListedHosts). node:child_process's spawn goes through Bun.spawn. What
// such a process starts itself isn't listed, since it runs without this preload.
const groupFiles = process.env.FIXTURE_GROUPS ? [process.env.FIXTURE_GROUPS, process.env.WHOLE_HOST_HOST_GROUPS].filter(Boolean) : [];
if (groupFiles.length) {
  const bun = Bun!;
  const realSpawn = bun.spawn;
  bun.spawn = function spawn(this: unknown, ...args: unknown[]) {
    const proc = (realSpawn as (...a: unknown[]) => { pid?: number }).apply(this, args);
    const options = (Array.isArray(args[0]) ? args[1] : args[0]) as { detached?: unknown } | undefined;
    if (options?.detached === true && typeof proc?.pid === 'number') for (const file of groupFiles) fs.appendFileSync(file, `${proc.pid}\n`);
    return proc;
  } as typeof bun.spawn;
}

const RealDate = globalThis.Date;
const epoch = /^\d+$/.test(process.env.FIXTURE_EPOCH_MS ?? '') ? Number(process.env.FIXTURE_EPOCH_MS) : NaN;
if (!Number.isSafeInteger(epoch)) {
  throw new Error(`the strategy fixture's Date preload needs FIXTURE_EPOCH_MS, a time in milliseconds (got ${JSON.stringify(process.env.FIXTURE_EPOCH_MS)})`);
}
let now = epoch;

function VirtualDate(...args: unknown[]) {
  if (!new.target) return new RealDate(now).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [now] : args, new.target);
}
VirtualDate.prototype = RealDate.prototype;
VirtualDate.now = () => now;
VirtualDate.parse = RealDate.parse;
VirtualDate.UTC = RealDate.UTC;
Object.defineProperty(VirtualDate, 'name', { value: 'Date' });
Object.defineProperty(RealDate.prototype, 'constructor', { value: VirtualDate, writable: true, configurable: true, enumerable: false });
globalThis.Date = VirtualDate as unknown as DateConstructor;

let advanced = 0;
const realNow = performance.now.bind(performance);
const realBigint = process.hrtime.bigint;
const realNanoseconds = globalThis.Bun?.nanoseconds;
const hrtimeNow = () => realBigint.call(process) + BigInt(Math.round(advanced * 1e6));
performance.now = () => realNow() + advanced;
function hrtime(previous?: [number, number]): [number, number] {
  const ns = hrtimeNow() - (previous ? BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]) : 0n);
  return [Number(ns / 1_000_000_000n), Number(ns % 1_000_000_000n)];
}
hrtime.bigint = hrtimeNow;
process.hrtime = hrtime;
if (realNanoseconds) globalThis.Bun!.nanoseconds = () => realNanoseconds() + Math.round(advanced * 1e6);
function moveTo(at: number) {
  advanced += at - now;
  now = at;
}

const VIRTUAL_FROM_MS = 30_000;
const TIMEOUT_MAX_MS = 2 ** 31 - 1;
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate };
const due = new Set<VirtualTimeout>();
const byId = new Map<number, VirtualTimeout>();
let armed = 0;

class VirtualTimeout {
  declare callback: Function;
  declare delay: number;
  declare args: unknown[];
  declare repeat: boolean;
  declare refed: boolean;
  declare cleared: boolean;
  declare id: number;
  declare at: number;
  declare order: number;
  declare firing?: object | null;
  constructor(callback: Function, delay: number, args: unknown[], repeat: boolean) {
    Object.assign(this, { callback, delay, args, repeat, refed: true, cleared: false, id: 2 ** 40 + armed });
    byId.set(this.id, this);
    this.arm();
  }
  arm() { this.at = now + this.delay; this.order = ++armed; due.add(this); }
  ref() { this.refed = true; return this; }
  unref() { this.refed = false; return this; }
  hasRef() { return this.refed; }
  refresh() { if (!this.cleared) { this.firing = null; this.arm(); } return this; }
  close() { clear(this); return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

function clear(timer: VirtualTimeout) {
  timer.cleared = true;
  timer.firing = null;
  due.delete(timer);
  byId.delete(timer.id);
}

const virtualOf = (handle: unknown) => (handle instanceof VirtualTimeout ? handle : typeof handle === 'number' || typeof handle === 'string' ? byId.get(Number(handle)) : undefined);
const setter = (realSet: Function, repeat: boolean) => function (this: unknown, callback: unknown, ms: unknown, ...args: unknown[]) {
  const delay = Number(ms);
  if (typeof callback !== 'function' || !(delay >= VIRTUAL_FROM_MS && delay <= TIMEOUT_MAX_MS)) return realSet.call(this, callback, ms, ...args);
  return new VirtualTimeout(callback, delay, args, repeat);
};
const clearer = (realClear: Function) => function (this: unknown, handle: unknown) {
  const timer = virtualOf(handle);
  if (timer) clear(timer);
  else realClear.call(this, handle);
};
globalThis.setTimeout = setter(real.setTimeout, false) as typeof setTimeout;
globalThis.setInterval = setter(real.setInterval, true) as typeof setInterval;
globalThis.clearTimeout = clearer(real.clearTimeout);
globalThis.clearInterval = clearer(real.clearInterval);
// A runtime's setTimeout promisifies as node:timers/promises' setTimeout (util.promisify.custom); without it a plain
// function is promisified with its callback last, which a timer refuses. node:timers/promises is loaded only once the
// globals above are replaced: loaded before them, its timers don't fire at the clock's advance.
Object.defineProperty(globalThis.setTimeout, Symbol.for('nodejs.util.promisify.custom'), {
  value: createRequire(import.meta.url)('node:timers/promises').setTimeout,
});

function nextDue(limit: number) {
  let next: VirtualTimeout | null = null;
  for (const t of due) if (t.at <= limit && (!next || t.at < next.at || (t.at === next.at && t.order < next.order))) next = t;
  return next;
}

// A clear or refresh that comes after an advance picks a timer, before its callback runs, stops that run, as it does a
// real timer's whose time has come; the advance then goes on as if the timer hadn't been due (`passed`).
function fire(timer: VirtualTimeout, answer: (result: Advanced) => void, passed: () => void) {
  due.delete(timer);
  if (timer.repeat) timer.arm();
  const shot = {};
  timer.firing = shot;
  real.setTimeout(() => {
    if (timer.firing !== shot) { passed(); return; }
    timer.firing = null;
    const fired = { delay: timer.delay, repeat: timer.repeat };
    try {
      timer.callback.apply(timer, timer.args);
    } finally {
      real.setImmediate(() => answer({ at: now, fired }));
    }
  }, 0);
}

const path = process.env.FIXTURE_CONTROL;
if (path) {
  const sock = connect(path, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'clock', pid: process.pid })}\n`));
  sock.unref();
  sock.on('error', (e) => console.error(`[fixture-clock] control socket ${path}: ${e.message}`));
  statSeen = (at) => sock.write(`${JSON.stringify({ type: 'notice', notice: 'stat', path: at })}\n`);
  lineReader(sock, (msg: { id: unknown; op: string; at?: unknown; path?: unknown }) => {
    const reply = (r: object) => sock.write(`${JSON.stringify({ id: msg.id, ...r })}\n`);
    if (msg.op === 'expect-stat') {
      if (typeof msg.path !== 'string' || !msg.path) return reply({ error: { code: -32602, message: `path must be a file's path (got ${JSON.stringify(msg.path)})` } });
      statExpected.add(resolve(msg.path));
      return reply({ result: { path: resolve(msg.path) } });
    }
    if (msg.op === 'due') {
      if (!Number.isFinite(msg.at)) return reply({ error: { code: -32602, message: `at must be a time in milliseconds (got ${JSON.stringify(msg.at)})` } });
      return reply({ result: { due: [...due].some((t) => t.at === msg.at) } });
    }
    if (msg.op !== 'advance') return;
    if (!Number.isFinite(msg.at)) return reply({ error: { code: -32602, message: `at must be a time in milliseconds (got ${JSON.stringify(msg.at)})` } });
    if ((msg.at as number) < now) return reply({ error: { code: -32602, message: `the clock doesn't go back: asked for ${msg.at}, and it reads ${now}` } });
    const go = () => {
      const next = nextDue(msg.at as number);
      if (!next) {
        moveTo(msg.at as number);
        return reply({ result: { at: now, fired: null } satisfies Advanced });
      }
      moveTo(next.at);
      fire(next, (result) => reply({ result }), go);
    };
    go();
  });
}
