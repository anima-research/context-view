// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unorderedUses } from './cache-guard.ts';
import { anthropic, anthropicCache } from './anthropic.ts';
import { bedrock } from './bedrock.ts';
import { responses } from './responses.ts';
import { chat } from './chat.ts';
import { prefixOf, promptCache } from './openai-cache.ts';

const FIVE = 300_000;
const HOUR = 3_600_000;
const req = (id, more = {}) => ({ id, kind: 'agent', agent: null, arrived: 0n, whole: 0n, began: 100n, carries: new Set(), gives: new Set(), ...more });
const mark = (at, ttl = FIVE) => ({ at, ttl });
const writes = (hash, ttl = FIVE, more = {}) => ({ cache: 1, seq: 0, read: null, writes: [hash], passed: [], marks: [mark(5, ttl)], ...more });
const reads = (hash, by, { lookback = false, ttl = FIVE, marks = null } = {}) => ({ cache: 1, seq: 1, read: { hash, by, at: 5 }, writes: [], passed: [], marks: marks ?? [lookback ? mark(9) : mark(5, ttl)] });
const passes = (hashes, more = {}) => ({ cache: 1, seq: 0, read: null, writes: [], passed: hashes, marks: [mark(9)], ...more });
const flags = (step, wrote = new Map(), oneManager = false, givers = undefined) => Object.fromEntries(unorderedUses(step, wrote, oneManager, givers));

test('a read of an entry another request of the step wrote, with nothing ordering the two, stops the run unless both are of one kind and mark the same elements with the same lifetimes up to and including that entry', () => {
  const w = req('w', { kind: 'summariser', use: writes('h') });
  assert.deepEqual(flags([w, req('r', { kind: 'agent', use: reads('h', 'w') })]), { r: [{ with: 'w', why: 'kinds' }] });
  assert.deepEqual(flags([req('w', { use: writes('h') }), req('r', { use: reads('h', 'w', { lookback: true }) })]), { r: [{ with: 'w', why: 'markers' }] });
  assert.deepEqual(flags([req('w', { use: writes('h', HOUR) }), req('r', { use: reads('h', 'w', { ttl: FIVE }) })]), { r: [{ with: 'w', why: 'markers' }] });
  assert.deepEqual(flags([req('w', { use: writes('h') }), req('r', { use: reads('h', 'w') })]), {}, 'one kind, both marking it with one lifetime: either order gives the same sums');
  const w2 = req('w', { use: { ...writes('h'), marks: [mark(2), mark(5)] } });
  assert.deepEqual(flags([w2, req('r', { use: reads('h', 'w') })]), { r: [{ with: 'w', why: 'markers' }] }, 'a lower marker only one of them sets');
  assert.deepEqual(flags([w2, req('r', { use: reads('h', 'w', { marks: [mark(2), mark(5), mark(9)] }) })]), {}, 'markers that differ only above the entry');
});

test('a witnessed edge orders a pair: the reader carries a token the writer\'s answer gives, and that answer began to be sent before the reader arrived whole', () => {
  const w = req('w', { kind: 'summariser', gives: new Set(['[[s:M11111111]]']), began: 50n, use: writes('h') });
  const r = (whole) => req('r', { carries: new Set(['[[s:M11111111]]']), whole, use: reads('h', 'w') });
  assert.deepEqual(flags([w, r(60n)]), {});
  assert.deepEqual(flags([w, r(40n)]), { r: [{ with: 'w', why: 'kinds' }] }, 'carried, but arrived whole before the answer began: no witness');
});

test('a token makes an edge only where one answer in the run gives it: a token an earlier step gave too, or two answers of the step give, orders nothing, since content can\'t show which giver the carrier took it from', () => {
  const tok = '[[c:a.r1]]';
  const w = req('w', { kind: 'summariser', gives: new Set([tok]), began: 50n, use: writes('h') });
  const r = req('r', { carries: new Set([tok]), whole: 60n, use: reads('h', 'w') });
  assert.deepEqual(flags([w, r]), {}, 'one giver in the run');
  assert.deepEqual(flags([w, r], new Map(), false, new Map([[tok, 1]])), {}, 'one giver in the run, counted run-wide');
  assert.deepEqual(flags([w, r], new Map(), false, new Map([[tok, 2]])), { r: [{ with: 'w', why: 'kinds' }] }, 'an earlier step gave it too');
  const w2 = req('w2', { kind: 'summariser', gives: new Set([tok]), began: 55n });
  assert.deepEqual(flags([w, w2, r]), { r: [{ with: 'w', why: 'kinds' }] }, 'two answers of the step give it');
});

test('one agent\'s chain orders its own requests, and order runs through other requests of the step', () => {
  const w = req('w', { kind: 'agent', agent: 'primary', arrived: 1n, use: writes('h') });
  const r = req('r', { kind: 'agent', agent: 'primary', arrived: 2n, use: reads('h', 'w', { lookback: true }) });
  assert.deepEqual(flags([w, r]), {});
  const x = req('x', { kind: 'agent', agent: 'scout', arrived: 1n, gives: new Set(['toolu_fx0000000000000001']), began: 10n });
  const r2 = req('r2', { kind: 'agent', agent: 'scout', arrived: 5n, use: reads('h', 'w2', { lookback: true }) });
  const w2 = req('w2', { kind: 'agent', agent: 'primary', arrived: 3n, carries: new Set(['toolu_fx0000000000000001']), whole: 20n, use: writes('h') });
  assert.deepEqual(flags([x, w2, r2]), { r2: [{ with: 'w2', why: 'markers' }] }, 'x before w2 and x before r2 order nothing between w2 and r2');
  const w3 = req('w3', { kind: 'agent', agent: 'primary', arrived: 3n, gives: new Set(['[[c:a.r1]]']), began: 30n, use: writes('h') });
  const y = req('y', { kind: 'agent', agent: 'scout', arrived: 4n, carries: new Set(['[[c:a.r1]]']), whole: 40n });
  const r3 = req('r3', { kind: 'agent', agent: 'scout', arrived: 5n, whole: 50n, use: reads('h', 'w3', { lookback: true }) });
  assert.deepEqual(flags([w3, y, r3]), {}, 'w3 before y by a witness, y before r3 by its chain');
});

test('a look-back that passed places two unordered requests wrote later trips with each of them', () => {
  const e = req('e', { use: passes(['h1', 'h2'], { seq: 0 }) });
  assert.deepEqual(flags([e, req('a', { use: writes('h1', FIVE, { seq: 1 }) }), req('b', { use: writes('h2', FIVE, { seq: 2 }) })]), { e: [{ with: 'a', why: 'passed' }, { with: 'b', why: 'passed' }] });
});

test('one agent\'s chain goes in the order its requests arrived whole, the order its count names them in, not the order their headers came', () => {
  const w = req('w', { kind: 'summariser', gives: new Set(['[[c:a.r1]]']), began: 10n, use: writes('h') });
  const b = req('b', { kind: 'agent', agent: 'scout', arrived: 2n, whole: 20n, carries: new Set(['[[c:a.r1]]']) });
  const a = req('a', { kind: 'agent', agent: 'scout', arrived: 1n, whole: 30n, use: reads('h', 'w', { lookback: true }) });
  assert.deepEqual(flags([w, a, b]), {}, 'w before b by a witness, and b before a by its chain, though a\'s headers came first');
});

test('where one manager sent the step\'s summariser calls, two of them are ordered when the later arrived after the earlier\'s answer ended, whatever the stores show, and not when it arrived before that, its answer begun or not', () => {
  const w = req('summariser-M11111111', { kind: 'summariser', arrived: 10n, began: 20n, ended: 25n, use: writes('h') });
  const r = (arrived, kind = 'summariser') => req('summariser-M22222222', { kind, arrived, use: reads('h', 'summariser-M11111111', { lookback: true }) });
  const tripped = (why) => ({ 'summariser-M22222222': [{ with: 'summariser-M11111111', why }] });
  assert.deepEqual(flags([w, r(30n)], new Map(), true), {}, 'a call whose summary no store wrote, with one manager');
  assert.deepEqual(flags([w, r(15n)], new Map(), true), tripped('markers'), 'one manager, the later arrived before the earlier answer began');
  assert.deepEqual(flags([w, r(22n)], new Map(), true), tripped('markers'), 'one manager, the later arrived while the earlier answer was being sent');
  assert.deepEqual(flags([{ ...w, ended: undefined }, r(30n)], new Map(), true), tripped('markers'), 'an answer that never ended orders nothing');
  const bothWrote = new Map([['[[s:M11111111]]', 'fixture'], ['[[s:M22222222]]', 'fixture']]);
  assert.deepEqual([flags([w, r(30n)], bothWrote), flags([w, r(22n)], bothWrote)], [{}, tripped('markers')], 'one store wrote both summaries: the same rule');
  assert.deepEqual(flags([w, r(30n)], new Map(), false), tripped('markers'), 'two managers');
  assert.deepEqual(flags([w, r(30n, 'concepts')], new Map(), true), tripped('kinds'), 'one manager orders its own summariser calls only');
});

test('two summariser calls with no witnessed edge are ordered where one agent\'s store wrote the summaries of both and the later arrived after the earlier\'s answer ended, and not otherwise', () => {
  const w = req('summariser-M11111111', { kind: 'summariser', arrived: 10n, began: 20n, ended: 25n, use: writes('h') });
  const r = (arrived) => req('summariser-M22222222', { kind: 'summariser', arrived, use: reads('h', 'summariser-M11111111', { lookback: true }) });
  const one = new Map([['[[s:M11111111]]', 'fixture'], ['[[s:M22222222]]', 'fixture']]);
  assert.deepEqual(flags([w, r(30n)], one), {});
  assert.deepEqual(flags([w, r(15n)], one), { 'summariser-M22222222': [{ with: 'summariser-M11111111', why: 'markers' }] }, 'arrived before the earlier answer began');
  assert.deepEqual(flags([w, r(30n)], new Map([['[[s:M11111111]]', 'fixture'], ['[[s:M22222222]]', 'spawn-scout-1']])), { 'summariser-M22222222': [{ with: 'summariser-M11111111', why: 'markers' }] }, 'two stores');
  assert.deepEqual(flags([w, r(30n)], new Map([['[[s:M11111111]]', 'fixture']])), { 'summariser-M22222222': [{ with: 'summariser-M11111111', why: 'markers' }] }, 'a call whose summary no store wrote');
  const again = req('summariser-M11111111-2', { kind: 'summariser', arrived: 30n, use: reads('h', 'summariser-M11111111', { lookback: true }) });
  assert.deepEqual(flags([w, again], one), { 'summariser-M11111111-2': [{ with: 'summariser-M11111111', why: 'markers' }] }, 'two calls of one mark, whose summary the store wrote once: one call\'s summary no store wrote');
  const third = req('summariser-M22222222', { kind: 'summariser', arrived: 40n, use: reads('h', 'summariser-M11111111-2', { lookback: true }) });
  assert.deepEqual(flags([{ ...w, use: undefined }, { ...again, began: 30n, ended: 35n, use: writes('h') }, third], one), { 'summariser-M22222222': [{ with: 'summariser-M11111111-2', why: 'markers' }] }, 'nor is either of them ordered against another call');
});

test('an entry written outside the step, or by the reader itself, orders nothing here', () => {
  assert.deepEqual(flags([req('r', { kind: 'agent', use: reads('h', 'earlier', { lookback: true }) })]), {});
  assert.deepEqual(flags([req('r', { use: reads('h', 'r', { lookback: true }) })]), {});
  assert.deepEqual(flags([req('r', { use: reads('h', null, { lookback: true }) })]), {});
});

test('a request whose look-back passed an element with no entry there, where a later request of the step wrote that element and nothing orders the two, stops the run: in the other order it reads by look-back', () => {
  const e = req('e', { use: passes(['h'], { seq: 1 }) });
  const l = req('l', { use: writes('h', FIVE, { seq: 2 }) });
  assert.deepEqual(flags([e, l]), { e: [{ with: 'l', why: 'passed' }] });
  assert.deepEqual(flags([{ ...e, kind: 'agent', agent: 'primary', arrived: 1n }, { ...l, kind: 'agent', agent: 'primary', arrived: 2n }]), {}, 'ordered by a chain');
  assert.deepEqual(flags([e, { ...l, use: writes('h', FIVE, { seq: 2, cache: 2 }) }]), {}, 'another cache\'s entry');
  assert.deepEqual(flags([{ ...e, use: passes(['h'], { seq: 2 }) }, { ...l, use: writes('h', FIVE, { seq: 1 }) }]), {}, 'an entry written before the look-back, and gone by then, is gone in either order');
});

const both = (drive, a, b) => [drive([a, b]), drive([b, a])].map(({ step, uses }) => flags(step.map((r) => ({ ...r, use: uses.get(r.id) }))));
const guarded = (ids) => ids.map((id, i) => req(id, { arrived: BigInt(i) }));

test('the stand-in\'s Messages cache gives one verdict for both arrival orders of two unordered requests whose figures their order moves', () => {
  const t = (s, mark) => ({ type: 'text', text: s, ...(mark ? { cache_control: { type: 'ephemeral' } } : {}) });
  const bodies = {
    w: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [t('one '.repeat(50)), t('two '.repeat(50), true)] }] },
    r: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [t('one '.repeat(50)), t('two '.repeat(50)), t('three '.repeat(50)), t('four '.repeat(50), true)] }] },
  };
  const drive = (order) => {
    const uses = new Map();
    const usage = anthropicCache({ clock: () => 0, minimums: { m: 0 }, uses });
    for (const id of order) usage(structuredClone(bodies[id]), 1, id);
    return { step: guarded(order), uses };
  };
  const [wFirst, rFirst] = both(drive, 'w', 'r');
  assert.deepEqual(wFirst, { r: [{ with: 'w', why: 'markers' }] });
  assert.deepEqual(rFirst, { r: [{ with: 'w', why: 'passed' }] });
});

test('the stand-in\'s OpenAI cache, written at a request\'s last eligible element, gives one verdict for both arrival orders of such a pair', () => {
  const els = (n) => {
    const p = prefixOf('m');
    for (let i = 0; i < n; i++) p.push({ i }, 2000, true);
    return p.elements;
  };
  const drive = (order) => {
    const uses = new Map();
    const use = promptCache({ clock: () => 0, uses });
    for (const id of order) use(els(id === 'w' ? 2 : 4), id);
    return { step: guarded(order), uses };
  };
  const [wFirst, rFirst] = both(drive, 'w', 'r');
  assert.deepEqual(wFirst, { r: [{ with: 'w', why: 'markers' }] });
  assert.deepEqual(rFirst, { r: [{ with: 'w', why: 'passed' }] });
});

test('the stand-in\'s DeepSeek cache, whose units end a request\'s input and its answer, gives one verdict for both arrival orders of such a pair', () => {
  const bodies = {
    w: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'one' }] },
    r: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'other' }, { role: 'user', content: 'two' }] },
  };
  const drive = (order) => {
    const uses = new Map();
    const c = chat({ configuration: { windowTokens: 922_000 }, clock: () => 0, dialect: 'deepseek', uses });
    for (const id of order) c.usage(structuredClone(bodies[id]), 1, [{ type: 'text', text: 'ok' }], id);
    return { step: guarded(order), uses };
  };
  const [wFirst, rFirst] = both(drive, 'w', 'r');
  assert.deepEqual(wFirst, { r: [{ with: 'w', why: 'markers' }] });
  assert.deepEqual(rFirst, { r: [{ with: 'w', why: 'passed' }] });
});

test('the stand-in\'s Messages cache trips in both arrival orders where two unordered requests of one kind mark one entry but a lower marker only one sets, so an older entry reaches one\'s read in one order alone', () => {
  const blocks = (n, marks) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `block ${i} ${'word '.repeat(40)}`, ...(marks.includes(i) ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const bodies = { o: blocks(6, [5]), a: blocks(31, [22, 30]), b: blocks(31, [30]) };
  const drive = (order) => {
    const uses = new Map();
    const usage = anthropicCache({ clock: () => 0, minimums: { m: 0 }, uses });
    for (const id of ['o', ...order]) usage({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: structuredClone(bodies[id]) }] }, 1, id);
    return { step: guarded(order), uses };
  };
  const [aFirst, bFirst] = both(drive, 'a', 'b');
  assert.deepEqual(aFirst, { b: [{ with: 'a', why: 'markers' }] });
  assert.deepEqual(bFirst, { a: [{ with: 'b', why: 'markers' }] });
});

test('each codec records the cache use of a request it prices under the request\'s name', () => {
  const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
  const uses = new Map();
  const o = { configuration: { windowTokens: 922_000 }, clock: () => 0, uses };
  const front = bedrock(o);
  const cases = [
    ['messages', anthropic(o), { model: 'claude-opus-4-6', max_tokens: 100, messages: [user('user: hi')] }],
    ['responses', responses(o), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }] }],
    ['codex', responses({ ...o, backend: 'codex' }), { model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'user: hi' }] }],
    ['openai', chat({ ...o, dialect: 'openai' }), { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'user: hi' }] }],
    ['deepseek', chat({ ...o, dialect: 'deepseek' }), { model: 'deepseek-flash', messages: [{ role: 'user', content: 'user: hi' }] }],
    ['openrouter', chat({ ...o, dialect: 'openrouter' }), { model: 'anthropic/claude-opus-4.6', messages: [{ role: 'user', content: 'user: hi' }] }],
    ['bedrock', front, front.read({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [user('user: hi')] }, '/model/us.anthropic.claude-opus-4-6-v1/invoke').body],
  ];
  for (const [name, codec, body] of cases) codec.usage(body, 1, [], name);
  assert.deepEqual([...uses.keys()], cases.map(([name]) => name));
  assert.deepEqual([...uses.values()].map((u) => u.seq), cases.map((_, i) => i), 'in the order the stand-in priced them');
});

test('a position the Messages cache\'s look-back passed below its read, which a later request writes, moves nothing in either order and trips nothing', () => {
  const blocks = (n, marks) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `block ${i} ${'word '.repeat(40)}`, ...(marks.includes(i) ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const bodies = { o: blocks(11, [10]), e: blocks(16, [15]), l: blocks(6, [5]) };
  const drive = (order) => {
    const uses = new Map();
    const usage = anthropicCache({ clock: () => 0, minimums: { m: 0 }, uses });
    for (const id of ['o', ...order]) usage({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: structuredClone(bodies[id]) }] }, 1, id);
    return { step: guarded(order), uses };
  };
  const [el, le] = [drive(['e', 'l']).uses, drive(['l', 'e']).uses];
  assert.equal(el.get('e').read?.by, 'o', 'e reads the entry o wrote');
  assert.ok(el.get('l').writes.length > 0, 'l writes an entry, below e\'s read');
  assert.deepEqual([le.get('e').read, el.get('e').read].map((r) => r && { by: r.by, hash: r.hash }), [{ by: 'o', hash: el.get('e').read.hash }, { by: 'o', hash: el.get('e').read.hash }], 'and reads the same in either order');
  assert.deepEqual(both(drive, 'e', 'l'), [{}, {}]);
});
