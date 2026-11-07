import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const { op, name, ms, via = 'global', repeat } = JSON.parse(line);
    const fired = () => say({ fired: name, now: Date.now() });
    if (op === 'set' && via === 'promises') promises.setTimeout(ms).then(fired);
    else if (op === 'set') {
      const api = via === 'timers' ? timers : globalThis;
      const h = repeat ? api.setInterval(fired, ms) : api.setTimeout(function (a, b) { say({ fired: name, now: Date.now(), args: [a, b], self: this === h }); }, ms, 'a', 'b');
      handles.set(name, h);
    } else if (op === 'clear') (repeat ? clearInterval : clearTimeout)(handles.get(name));
    else if (op === 'clear-number') clearTimeout(Number(handles.get(name)));
    else if (op === 'refresh') handles.get(name).refresh();
    else if (op === 'refs') { const h = handles.get(name); const a = h.hasRef(); h.unref(); const b = h.hasRef(); h.ref(); say({ refs: [a, b, h.hasRef()], chains: h.unref() === h && h.ref() === h }); }
    else if (op === 'throw') setTimeout(() => { throw new Error('thrown from a virtual timer'); }, ms);
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
