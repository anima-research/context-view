import { connect } from 'node:net';
import { lineReader } from './control.mjs';

const RealDate = globalThis.Date;
const epoch = /^\d+$/.test(process.env.FIXTURE_EPOCH_MS ?? '') ? Number(process.env.FIXTURE_EPOCH_MS) : NaN;
if (!Number.isSafeInteger(epoch)) {
  throw new Error(`the strategy fixture's Date preload needs FIXTURE_EPOCH_MS, a time in milliseconds (got ${JSON.stringify(process.env.FIXTURE_EPOCH_MS)})`);
}
let now = epoch;

function VirtualDate(...args) {
  if (!new.target) return new RealDate(now).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [now] : args, new.target);
}
VirtualDate.prototype = RealDate.prototype;
VirtualDate.now = () => now;
VirtualDate.parse = RealDate.parse;
VirtualDate.UTC = RealDate.UTC;
Object.defineProperty(VirtualDate, 'name', { value: 'Date' });
Object.defineProperty(RealDate.prototype, 'constructor', { value: VirtualDate, writable: true, configurable: true, enumerable: false });
globalThis.Date = VirtualDate;

let advanced = 0;
const realNow = performance.now.bind(performance);
const realBigint = process.hrtime.bigint;
const realNanoseconds = globalThis.Bun?.nanoseconds;
const hrtimeNow = () => realBigint.call(process) + BigInt(Math.round(advanced * 1e6));
performance.now = () => realNow() + advanced;
function hrtime(previous) {
  const ns = hrtimeNow() - (previous ? BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]) : 0n);
  return [Number(ns / 1_000_000_000n), Number(ns % 1_000_000_000n)];
}
hrtime.bigint = hrtimeNow;
process.hrtime = hrtime;
if (realNanoseconds) globalThis.Bun.nanoseconds = () => realNanoseconds() + Math.round(advanced * 1e6);
function moveTo(at) {
  advanced += at - now;
  now = at;
}

const VIRTUAL_FROM_MS = 30_000;
const TIMEOUT_MAX_MS = 2 ** 31 - 1;
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate };
const due = new Set();
const byId = new Map();
let armed = 0;

class VirtualTimeout {
  constructor(callback, delay, args, repeat) {
    Object.assign(this, { callback, delay, args, repeat, refed: true, cleared: false, id: 2 ** 40 + armed });
    byId.set(this.id, this);
    this.arm();
  }
  arm() { this.at = now + this.delay; this.order = ++armed; due.add(this); }
  ref() { this.refed = true; return this; }
  unref() { this.refed = false; return this; }
  hasRef() { return this.refed; }
  refresh() { if (!this.cleared) this.arm(); return this; }
  close() { clear(this); return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

function clear(timer) {
  timer.cleared = true;
  due.delete(timer);
  byId.delete(timer.id);
}

const virtualOf = (handle) => (handle instanceof VirtualTimeout ? handle : typeof handle === 'number' || typeof handle === 'string' ? byId.get(Number(handle)) : undefined);
const setter = (realSet, repeat) => function (callback, ms, ...args) {
  const delay = Number(ms);
  if (typeof callback !== 'function' || !(delay >= VIRTUAL_FROM_MS && delay <= TIMEOUT_MAX_MS)) return realSet.call(this, callback, ms, ...args);
  return new VirtualTimeout(callback, delay, args, repeat);
};
const clearer = (realClear) => function (handle) {
  const timer = virtualOf(handle);
  if (timer) clear(timer);
  else realClear.call(this, handle);
};
globalThis.setTimeout = setter(real.setTimeout, false);
globalThis.setInterval = setter(real.setInterval, true);
globalThis.clearTimeout = clearer(real.clearTimeout);
globalThis.clearInterval = clearer(real.clearInterval);

function nextDue(limit) {
  let next = null;
  for (const t of due) if (t.at <= limit && (!next || t.at < next.at || (t.at === next.at && t.order < next.order))) next = t;
  return next;
}

function fire(timer, answer) {
  due.delete(timer);
  if (timer.repeat) timer.arm();
  real.setTimeout(() => {
    try {
      timer.callback.apply(timer, timer.args);
    } finally {
      real.setImmediate(() => answer({ at: now, fired: { delay: timer.delay, repeat: timer.repeat } }));
    }
  }, 0);
}

const path = process.env.FIXTURE_CONTROL;
if (path) {
  const sock = connect(path, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'clock', pid: process.pid })}\n`));
  sock.unref();
  sock.on('error', (e) => console.error(`[fixture-clock] control socket ${path}: ${e.message}`));
  lineReader(sock, (msg) => {
    if (msg.op !== 'advance') return;
    const reply = (r) => sock.write(`${JSON.stringify({ id: msg.id, ...r })}\n`);
    if (!Number.isFinite(msg.at)) return reply({ error: { code: -32602, message: `at must be a time in milliseconds (got ${JSON.stringify(msg.at)})` } });
    if (msg.at < now) return reply({ error: { code: -32602, message: `the clock doesn't go back: asked for ${msg.at}, and it reads ${now}` } });
    const next = nextDue(msg.at);
    if (!next) {
      moveTo(msg.at);
      return reply({ result: { at: now, fired: null } });
    }
    moveTo(next.at);
    fire(next, (result) => reply({ result }));
  });
}
