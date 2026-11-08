import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenForPeers } from '../lib/strategies/control.mjs';

const PRELOAD = fileURLToPath(new URL('../lib/strategies/virtual-date.mjs', import.meta.url));
const noBun = spawnSync('bun', ['--version']).status === 0 ? false : 'bun is not on PATH';
const EPOCH = Date.UTC(2026, 0, 5, 9, 30, 0);
const ANSWER_BOUND_MS = 10_000;
const children = new Set();
after(() => { for (const child of children) child.kill('SIGKILL'); });

const TARGET = `
import { statSync } from 'node:fs';
class Sub extends Date { tag() { return 'sub'; } }
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    buf = buf.slice(i + 1);
    try {
      const mtime = statSync(process.argv[1]).mtime;
      const made = new Date();
      const sub = new Sub();
      process.stdout.write(JSON.stringify({
        now: Date.now(), made: made.getTime(), called: Date(),
        fromParts: new Date(2020, 0, 2, 3, 4, 5).getTime(), fromMs: new Date(12345).getTime(),
        parse: Date.parse('2021-03-04T05:06:07Z'), utc: Date.UTC(2022, 1, 3),
        mtimeIsDate: mtime instanceof Date, mtimeCtor: mtime.constructor === Date,
        madeIsDate: made instanceof Date, madeCtor: made.constructor === Date,
        subTag: typeof sub.tag === 'function' ? sub.tag() : null, subIsDate: sub instanceof Date, subTime: sub.getTime(),
      }) + '\\n');
    } catch (e) { process.stdout.write(JSON.stringify({ error: String(e) }) + '\\n'); }
  }
});
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fxd-'));
  const target = join(dir, 'target.mjs');
  writeFileSync(target, TARGET);
  return { dir, target, sock: join(dir, 'c.sock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function startTarget(target, env) {
  const child = spawn('bun', ['--preload', PRELOAD, target], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const lines = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      waiters.shift()?.();
    }
  });
  const read = () => new Promise((resolve, reject) => {
    const want = lines.length + 1;
    const timer = setTimeout(() => reject(new Error(`the target answered no read within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiters.push(() => { if (lines.length >= want) { clearTimeout(timer); resolve(lines[want - 1]); } });
    child.stdin.write('read\n');
  });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  // `close` comes once the child's output streams have ended too, so what it wrote to stderr is all there.
  const closed = new Promise((r) => child.once('close', (code) => r(code)));
  return { child, read, exited, closed, stderr: () => stderr, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

test('D1, D3: the clock reads the epoch and stands still; dates from arguments, parse and UTC are unchanged; every date is a Date, the runtime\'s and a subclass\'s included', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTarget(s.target, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    const first = await t.read();
    assert.equal(first.now, EPOCH);
    assert.equal(first.made, EPOCH);
    assert.equal(first.called, new Date(EPOCH).toString());
    assert.equal(first.fromParts, new Date(2020, 0, 2, 3, 4, 5).getTime());
    assert.equal(first.fromMs, 12345);
    assert.equal(first.parse, Date.parse('2021-03-04T05:06:07Z'));
    assert.equal(first.utc, Date.UTC(2022, 1, 3));
    for (const k of ['mtimeIsDate', 'mtimeCtor', 'madeIsDate', 'madeCtor', 'subIsDate']) assert.equal(first[k], true, k);
    assert.equal(first.subTag, 'sub');
    assert.equal(first.subTime, EPOCH);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await t.read()).now, EPOCH, 'it stands still between advances');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D2: an advance resolves once the process reads the new time; an earlier time or a non-time is refused and the clock keeps its time; with no clock connected an advance rejects at once', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  await assert.rejects(ctl.advance(EPOCH + 1, { timeoutMs: 600_000 }), /no clock is connected/);
  const t = startTarget(s.target, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    const later = EPOCH + 4 * 60_000;
    await ctl.advance(later);
    const r = await t.read();
    assert.equal(r.now, later);
    assert.equal(r.made, later);
    await assert.rejects(ctl.advance(EPOCH), /doesn't go back/);
    await assert.rejects(ctl.advance('soon'), /time in milliseconds/);
    assert.equal((await t.read()).now, later, 'a refused advance leaves the clock where it was');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D4: with an empty or a non-numeric FIXTURE_EPOCH_MS the process does not start, and says why', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  try {
    for (const env of [{ FIXTURE_EPOCH_MS: '' }, { FIXTURE_EPOCH_MS: 'tomorrow' }]) {
      const t = startTarget(s.target, env);
      const code = await Promise.race([t.closed, new Promise((r) => setTimeout(() => r('still running'), 10_000))]);
      if (code === 'still running') await t.stop();
      assert.notEqual(code, 'still running', `${JSON.stringify(env)}: it started`);
      assert.notEqual(code, 0, JSON.stringify(env));
      assert.match(t.stderr(), /FIXTURE_EPOCH_MS/, JSON.stringify(env));
    }
  } finally { s.done(); }
});

const TIMER_TARGET = `
import * as timers from 'node:timers';
import * as promises from 'node:timers/promises';
import { promisify } from 'node:util';
const handles = new Map();
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const { op, name, ms, via = 'global', repeat, at, then } = JSON.parse(line);
    const fired = () => say({ fired: name, now: Date.now() });
    if (op === 'set' && via === 'promises') promises.setTimeout(ms).then(fired);
    else if (op === 'set' && via === 'promisify') promisify(setTimeout)(ms, name).then((value) => say({ fired: name, now: Date.now(), value }), (e) => say({ failed: name, error: String(e) }));
    else if (op === 'set') {
      const api = via === 'timers' ? timers : globalThis;
      const h = repeat ? api.setInterval(fired, ms) : api.setTimeout(function (a, b) { say({ fired: name, now: Date.now(), args: [a, b], self: this === h }); }, ms, 'a', 'b');
      handles.set(name, h);
    } else if (op === 'clear') (repeat ? clearInterval : clearTimeout)(handles.get(name));
    else if (op === 'clear-number') clearTimeout(Number(handles.get(name)));
    else if (op === 'refresh') handles.get(name).refresh();
    else if (op === 'refs') { const h = handles.get(name); const a = h.hasRef(); h.unref(); const b = h.hasRef(); h.ref(); say({ refs: [a, b, h.hasRef()], chains: h.unref() === h && h.ref() === h }); }
    else if (op === 'throw') setTimeout(() => { throw new Error('thrown from a virtual timer'); }, ms);
    else if (op === 'watch') {
      // Real timers of 0 ms run in the order they were set, so one this chain set before an advance picked a virtual
      // timer runs before that timer's callback can.
      const poll = () => {
        if (Date.now() < at) { setTimeout(poll, 0); return; }
        const h = handles.get(name);
        if (then === 'clear') clearTimeout(h); else h.refresh();
        say({ gap: name, then, now: Date.now() });
      };
      setTimeout(poll, 0);
    }
    say({ done: op, name });
  }
});
`;

function startTimers(s, env) {
  const target = join(s.dir, 'timers.mjs');
  writeFileSync(target, TIMER_TARGET);
  const child = spawn('bun', ['--preload', PRELOAD, target], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const exited = new Promise((r) => child.once('exit', (code) => { children.delete(child); r(code); }));
  const lines = [];
  const waiters = new Set();
  let buf = '';
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      for (const w of [...waiters]) w();
    }
  });
  const until = (test, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${what} within ${ANSWER_BOUND_MS} ms; it wrote ${JSON.stringify(lines)}`)); }, ANSWER_BOUND_MS);
    const check = () => { const found = lines.find(test); if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); } };
    waiters.add(check);
    check();
  });
  const send = async (cmd) => { child.stdin.write(`${JSON.stringify(cmd)}\n`); await until((l) => l.done === cmd.op && l.name === cmd.name && !l.seen && (l.seen = true), `answer to ${cmd.op} ${cmd.name}`); };
  const fires = () => lines.filter((l) => l.fired).map((l) => l.fired);
  return { send, until, fires, lines, exited, stderr: () => stderr, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

test('D5: a timer of 30 s or more never fires in real time, and fires at the advance that passes its due time, with the clock at that time, its arguments and itself as this; one of less runs in real time, and no advance fires it', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'long', ms: 30_000 });
    await t.send({ op: 'set', name: 'edge', ms: 29_999 });
    await t.send({ op: 'set', name: 'short', ms: 50 });
    await t.until((l) => l.fired === 'short', 'real-time fire of the 50 ms timer');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(t.fires(), ['short'], 'the 30 s timer waits for the clock');
    assert.deepEqual(await ctl.advance(EPOCH + 29_999), { at: EPOCH + 29_999, fired: null });
    assert.deepEqual(t.fires(), ['short']);
    assert.deepEqual(await ctl.advance(EPOCH + 60_000), { at: EPOCH + 30_000, fired: { delay: 30_000, repeat: false } }, 'the clock stops at the timer it fired');
    const long = await t.until((l) => l.fired === 'long', 'the 30 s timer\'s fire');
    assert.equal(long.now, EPOCH + 30_000);
    assert.deepEqual(long.args, ['a', 'b']);
    assert.equal(long.self, true);
    assert.deepEqual(await ctl.advance(EPOCH + 60_000), { at: EPOCH + 60_000, fired: null }, 'a timeout fires once, and the 29,999 ms one is real, so no advance fires it');
    assert.deepEqual(t.fires(), ['short', 'long']);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D6: timers past their due time fire one per advance answer, earliest first and in the order they were set at one time, and an interval fires again each period', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'b90', ms: 90_000 });
    await t.send({ op: 'set', name: 'a60', ms: 60_000 });
    await t.send({ op: 'set', name: 'c90', ms: 90_000 });
    await t.send({ op: 'set', name: 'every40', ms: 40_000, repeat: true });
    const answers = [];
    for (let i = 0; i < 10; i++) {
      const a = await ctl.advance(EPOCH + 130_000);
      answers.push(a.at - EPOCH);
      if (!a.fired) break;
    }
    assert.deepEqual(answers, [40_000, 60_000, 80_000, 90_000, 90_000, 120_000, 130_000]);
    await t.until((l) => l.fired === 'every40' && l.now === EPOCH + 120_000, 'the interval\'s third fire');
    assert.deepEqual(t.fires(), ['every40', 'a60', 'every40', 'b90', 'c90', 'every40']);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D7: a cleared timer never fires, by its handle or its number; refresh sets it again from the clock\'s time; ref, unref and hasRef answer as a timer\'s do', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'cleared', ms: 30_000 });
    await t.send({ op: 'set', name: 'numbered', ms: 30_000 });
    await t.send({ op: 'set', name: 'interval', ms: 30_000, repeat: true });
    await t.send({ op: 'set', name: 'refreshed', ms: 50_000 });
    await t.send({ op: 'clear', name: 'cleared' });
    await t.send({ op: 'clear-number', name: 'numbered' });
    await t.send({ op: 'clear', name: 'interval', repeat: true });
    await t.send({ op: 'refs', name: 'refreshed' });
    assert.deepEqual(t.lines.find((l) => l.refs), { refs: [true, false, true], chains: true });
    assert.deepEqual(await ctl.advance(EPOCH + 40_000), { at: EPOCH + 40_000, fired: null });
    await t.send({ op: 'refresh', name: 'refreshed' });
    assert.deepEqual(await ctl.advance(EPOCH + 89_999), { at: EPOCH + 89_999, fired: null }, 'refreshed at 40 s, it is due at 90 s');
    assert.deepEqual((await ctl.advance(EPOCH + 90_000)).fired, { delay: 50_000, repeat: false });
    await t.until((l) => l.fired === 'refreshed', 'the refreshed timer\'s fire');
    assert.deepEqual(t.fires(), ['refreshed']);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D7a: a clear or refresh that comes after an advance picks a timer, before its callback runs, stops that run, and the advance goes on as if the timer hadn\'t been due; a refreshed one fires once, at its new time', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'gone', ms: 60_000 });
    await t.send({ op: 'watch', name: 'gone', at: EPOCH + 60_000, then: 'clear' });
    assert.deepEqual(await ctl.advance(EPOCH + 90_000), { at: EPOCH + 90_000, fired: null }, 'cleared in the gap, it never fires');
    assert.deepEqual(await t.until((l) => l.gap === 'gone', 'the clear in the gap'), { gap: 'gone', then: 'clear', now: EPOCH + 60_000 }, 'premise: the clear came with the clock at the timer\'s due time');
    await t.send({ op: 'set', name: 'again', ms: 60_000 });
    await t.send({ op: 'watch', name: 'again', at: EPOCH + 150_000, then: 'refresh' });
    assert.deepEqual(await ctl.advance(EPOCH + 200_000), { at: EPOCH + 200_000, fired: null }, 'refreshed in the gap at 150 s, it is due at 210 s');
    assert.deepEqual(await ctl.advance(EPOCH + 300_000), { at: EPOCH + 210_000, fired: { delay: 60_000, repeat: false } });
    await t.until((l) => l.fired === 'again', 'the refreshed timer\'s fire');
    assert.deepEqual(await ctl.advance(EPOCH + 300_000), { at: EPOCH + 300_000, fired: null });
    assert.deepEqual(t.fires(), ['again'], 'each fires at most once, and the cleared one never');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D8: node:timers\' setTimeout and setInterval, and node:timers/promises\' setTimeout, run on the clock too', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'timers', ms: 30_000, via: 'timers' });
    await t.send({ op: 'set', name: 'timers-interval', ms: 45_000, via: 'timers', repeat: true });
    await t.send({ op: 'set', name: 'promises', ms: 60_000, via: 'promises' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(t.fires(), []);
    for (let i = 0; i < 5 && (await ctl.advance(EPOCH + 60_000)).fired; i++);
    await t.until((l) => l.fired === 'promises', 'the promise\'s timer');
    assert.deepEqual(t.fires(), ['timers', 'timers-interval', 'promises']);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D8a: util.promisify(setTimeout) runs on the clock too, as a runtime\'s does: under 30 s in real time, and 30 s or more at the advance that passes it, each resolving with its value', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'set', name: 'short', ms: 50, via: 'promisify' });
    await t.send({ op: 'set', name: 'long', ms: 60_000, via: 'promisify' });
    const short = await t.until((l) => l.fired === 'short' || l.failed === 'short', 'the 50 ms promise');
    assert.deepEqual(short, { fired: 'short', now: EPOCH, value: 'short' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(t.fires(), ['short'], 'the 60 s promise waits for the clock');
    await ctl.advance(EPOCH + 60_000);
    const long = await t.until((l) => l.fired === 'long' || l.failed === 'long', 'the 60 s promise');
    assert.deepEqual(long, { fired: 'long', now: EPOCH + 60_000, value: 'long' });
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D9: a virtual timer\'s callback that throws is uncaught, as a real timer\'s is, and the process exits', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTimers(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.send({ op: 'throw', ms: 30_000 });
    await ctl.advance(EPOCH + 30_000).catch(() => {});
    const code = await Promise.race([t.exited, new Promise((r) => setTimeout(() => r('still running'), 10_000))]);
    assert.notEqual(code, 'still running');
    assert.notEqual(code, 0);
    assert.match(t.stderr(), /thrown from a virtual timer/);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

const MONOTONIC_TARGET = `
const say = (o) => process.stdout.write(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\\n');
let bound = null;
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const { op, ms } = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (op === 'read') {
      const [s, ns] = process.hrtime();
      say({ read: true, perf: performance.now(), origin: performance.timeOrigin, date: Date.now(), hr: s * 1e3 + ns / 1e6, big: process.hrtime.bigint(), bun: Bun.nanoseconds(), diff: process.hrtime([0, 0]) });
    } else if (op === 'bound') {
      const at = performance.now() + ms;
      const check = () => { if (performance.now() >= at) say({ cut: true, date: Date.now() }); else bound = setTimeout(check, at - performance.now()); };
      bound = setTimeout(check, at - performance.now());
      say({ armed: true });
    }
  }
});
`;

function startMonotonic(s, env, { source = MONOTONIC_TARGET, name = 'monotonic.mjs' } = {}) {
  const target = join(s.dir, name);
  writeFileSync(target, source);
  const child = spawn('bun', ['--preload', PRELOAD, target], { cwd: s.dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const exited = new Promise((r) => child.once('exit', (code) => { children.delete(child); r(code); }));
  const lines = [];
  const waiters = new Set();
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      for (const w of [...waiters]) w();
    }
  });
  const next = (test, what) => new Promise((resolve, reject) => {
    const from = lines.length;
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${what} within ${ANSWER_BOUND_MS} ms`)); }, ANSWER_BOUND_MS);
    const check = () => { const found = lines.slice(from).find(test); if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); } };
    waiters.add(check);
  });
  const read = async () => { const p = next((l) => l.read, 'read'); child.stdin.write('{"op":"read"}\n'); return p; };
  const ask = async (cmd, test, what) => { const p = next(test, what); child.stdin.write(`${JSON.stringify(cmd)}\n`); return p; };
  return { read, ask, lines, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

test('D10: performance.now(), process.hrtime and its bigint, and Bun.nanoseconds move by what an advance adds, together, and only forward; across an advance, timeOrigin plus performance.now() less Date.now() moves only by the real time the advance took', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startMonotonic(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    // Each of the target's readings comes after this process asks for it and before this process has it, so the real
    // time between two of them is at most the time from asking for the first to having the second, on the same
    // monotonic clock; a millisecond more covers the readings' rounding.
    const t0 = performance.now();
    const a = await t.read();
    await ctl.advance(EPOCH + 4 * 60_000);
    const t1 = performance.now();
    const b = await t.read();
    const real = performance.now() - t0 + 1;
    const moved = { perf: b.perf - a.perf, hr: b.hr - a.hr, big: Number(BigInt(b.big) - BigInt(a.big)) / 1e6, bun: (b.bun - a.bun) / 1e6 };
    for (const [clock, ms] of Object.entries(moved)) {
      assert.ok(ms >= 4 * 60_000 && ms <= 4 * 60_000 + real, `${clock} moved ${ms} ms across an advance of 240000 ms that took under ${real} ms`);
    }
    const drift = (b.origin + b.perf - b.date) - (a.origin + a.perf - a.date);
    assert.ok(drift >= 0 && drift <= real, `timeOrigin + performance.now() less Date.now() moved ${drift} ms`);
    assert.ok(b.diff[0] * 1e3 + b.diff[1] / 1e6 >= 4 * 60_000, 'process.hrtime(previous) counts the advance');
    await ctl.advance(EPOCH + 4 * 60_000);
    const c = await t.read();
    const since = performance.now() - t1 + 1;
    assert.ok(c.perf >= b.perf && c.perf - b.perf <= since, `an advance to the time it reads moves nothing (performance.now() moved ${c.perf - b.perf} ms in under ${since} ms)`);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D11: a bound armed 60 s out on performance.now() is cut at the advance past it, and by nothing short of one', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startMonotonic(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await t.ask({ op: 'bound', ms: 60_000 }, (l) => l.armed, 'the bound armed');
    for (let i = 0; i < 5 && (await ctl.advance(EPOCH + 59_000)).fired; i++);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.lines.some((l) => l.cut), false, 'no cut before 60 s of the clock');
    for (let i = 0; i < 5 && (await ctl.advance(EPOCH + 61_000)).fired; i++);
    const cut = t.lines.find((l) => l.cut) ?? await t.ask({ op: 'noop' }, (l) => l.cut, 'the cut');
    assert.ok(cut.date >= EPOCH + 59_000 && cut.date <= EPOCH + 61_000, `cut at ${cut.date - EPOCH} ms of the clock`);
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

const STAT_TARGET = `
import { stat } from 'fs';
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const { path } = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    stat(path, (err, st) => process.stdout.write(JSON.stringify({ statted: path, err: err ? err.code : null, size: st ? st.size : null, file: st ? st.isFile() : null }) + '\\n'));
  }
});
`;

test('D13: a callback fs.stat, imported by an ES module from fs, of a path the clock was asked to report sends one notice, at that path\'s first stat, whether the stat names it whole or from the working directory; a path not asked for sends none; every stat answers as fs.stat does', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const notices = [];
  ctl.onNotice((n) => notices.push(n));
  const dir = realpathSync(s.dir);
  const a = join(dir, 'a.txt');
  writeFileSync(a, 'five!');
  writeFileSync(join(dir, 'b.txt'), 'six!!!');
  const t = startMonotonic(s, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) }, { source: STAT_TARGET, name: 'stat.mjs' });
  const statOf = (path) => t.ask({ path }, (l) => l.statted === path, `the stat of ${path}`);
  const noticesNow = async () => { await ctl.advance(EPOCH); return notices.filter((n) => n.notice === 'stat'); };
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    await assert.rejects(ctl.expectStat(''), /path must be a file's path/);
    await ctl.expectStat(a);
    assert.deepEqual(await statOf(join(dir, 'b.txt')), { statted: join(dir, 'b.txt'), err: null, size: 6, file: true });
    assert.deepEqual(await noticesNow(), [], 'a path not asked for sends no notice');
    assert.deepEqual(await statOf('a.txt'), { statted: 'a.txt', err: null, size: 5, file: true });
    assert.deepEqual(await noticesNow(), [{ peer: 'clock', notice: 'stat', path: a }]);
    assert.deepEqual(await statOf(a), { statted: a, err: null, size: 5, file: true });
    assert.equal((await noticesNow()).length, 1, 'only the first stat of a path asked for sends a notice');
    const gone = join(dir, 'gone.txt');
    await ctl.expectStat(gone);
    assert.deepEqual(await statOf(gone), { statted: gone, err: 'ENOENT', size: null, file: null });
    assert.deepEqual((await noticesNow()).map((n) => n.path), [a, gone], 'a stat that fails still sends its notice');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});
