import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderStep, type OrderLine } from './order.ts';

const req = (ref: string, agent: string | null, carries: string[] = [], gives: string[] = [], more: Partial<OrderLine> = {}): OrderLine => ({ ref, agent, request: true, carries: new Set(carries), gives: new Set(gives), ...more });
const host = (ref: string, agent: string | null, needs: string[] = []): OrderLine => ({ ref, agent, request: false, carries: new Set(), gives: new Set(), needs });
const order = (lines: OrderLine[]) => orderStep(lines);

function interleavings(lines: OrderLine[]): OrderLine[][] {
  const chains = new Map<string, OrderLine[]>();
  for (const l of lines) chains.set(l.agent ?? `none ${l.ref}`, [...(chains.get(l.agent ?? `none ${l.ref}`) ?? []), l]);
  const out: OrderLine[][] = [];
  const walk = (left: Map<string, OrderLine[]>, acc: OrderLine[]): void => {
    if ([...left.values()].every((c) => c.length === 0)) { out.push(acc); return; }
    for (const [k, c] of left) if (c.length) walk(new Map([...left, [k, c.slice(1)]]), [...acc, c[0]]);
  };
  walk(chains, []);
  return out;
}

test('a request that carries a token another request\'s answer gives is written after that request, though the convention would put it first', () => {
  const lines = [req('p1', 'primary', ['toolu_fxaaaaaaaaaaaaaaaa']), req('s1', 'scout', [], ['toolu_fxaaaaaaaaaaaaaaaa'])];
  assert.deepEqual(order(lines), ['s1', 'p1']);
});

test('one agent\'s lines keep their chain\'s order, host lines without a request among them', () => {
  assert.deepEqual(order([req('p1', 'primary'), host('d1', 'primary'), req('p2', 'primary'), host('h1', 'primary')]), ['p1', 'd1', 'p2', 'h1']);
});

test('where cause and chain fix nothing, the agent just written goes on while its next line may come; otherwise the primary, then other agents by label', () => {
  const t = '[[c:b.r1]]';
  assert.deepEqual(order([req('b1', 'b'), req('a1', 'a'), req('p1', 'primary'), req('p2', 'primary')]), ['p1', 'p2', 'a1', 'b1']);
  assert.deepEqual(order([req('b1', 'b', [], [t]), req('a1', 'a'), req('p1', 'primary'), req('p2', 'primary', [t])]), ['p1', 'a1', 'b1', 'p2']);
  assert.deepEqual(order([req('a1', 'a', [], [t]), req('a2', 'a'), req('p1', 'primary', [t]), req('p2', 'primary')]), ['a1', 'a2', 'p1', 'p2'], 'the agent just written goes on, though the primary may come now');
});

test('the order is the same whichever order the lines are given in, but for each agent\'s own', () => {
  const m = '[[s:M11111111]]';
  const id = 'toolu_fxbbbbbbbbbbbbbbbb';
  const lines = [
    req('p1', 'primary', [], [id]), host('d1', 'primary', [m]), req('p2', 'primary', [m]),
    req('summariser-M11111111', null, [id], [m]), req('x1', 'scout', [id]), req('judge-aaaa', null, ['[[c:x.1]]']),
  ];
  const all = interleavings(lines).map((ls) => order(ls).join(' '));
  assert.ok(all.length > 20);
  assert.deepEqual([...new Set(all)], [all[0]]);
});

test('a request with no agent is written directly before the first line that needs it, a host line showing what its answer gives among them, and one that nothing needs after the step\'s last agent line', () => {
  const m = '[[s:M22222222]]';
  assert.deepEqual(order([req('p1', 'primary'), req('p2', 'primary', [m]), req('S', null, [], [m])]), ['p1', 'S', 'p2']);
  assert.deepEqual(order([req('p1', 'primary'), host('d1', 'primary', [m]), req('p2', 'primary', [m]), req('S', null, [], [m])]), ['p1', 'S', 'd1', 'p2']);
  assert.deepEqual(order([req('S', null, [], [m]), req('p1', 'primary'), req('x1', 'scout')]), ['p1', 'x1', 'S']);
});

test('a request with no agent that another such request needs is placed with it, before it', () => {
  const [m1, m2] = ['[[s:M33333333]]', '[[s:M44444444]]'];
  assert.deepEqual(order([req('S2', null, [m1], [m2]), req('p1', 'primary'), req('p2', 'primary', [m2]), req('S1', null, [], [m1])]), ['p1', 'S1', 'S2', 'p2']);
});

test('requests with no agent that share a place go by cause, then by the canaries each carries in canary order, then by name', () => {
  const lines = [
    req('judge-b', null, ['[[c:x.10]]']), req('judge-a', null, ['[[c:x.10]]']), req('judge-c', null, ['[[c:x.9]]']), req('p1', 'primary'),
  ];
  assert.deepEqual(order(lines), ['p1', 'judge-c', 'judge-a', 'judge-b']);
});

test('where several requests of one name gave one answer, its carrier is written after all of them, but for one that follows the carrier by cause', () => {
  const m = '[[s:M55555555]]';
  const id = 'toolu_fxcccccccccccccccc';
  const lines = [
    req('summariser-M55555555', null, [], [m], { base: 'summariser-M55555555', text: 'a' }),
    req('summariser-M55555555-2', null, [], [m], { base: 'summariser-M55555555', text: 'b' }),
    req('p1', 'primary', [m], [id]),
    req('summariser-M55555555-3', null, [id], [m], { base: 'summariser-M55555555', text: 'c' }),
  ];
  assert.deepEqual(order(lines), ['summariser-M55555555', 'summariser-M55555555-2', 'p1', 'summariser-M55555555-3']);
});

test('requests of one name that share a place go by their text, not by the count their arrival gave them', () => {
  const lines = [req('p1', 'primary'), req('j-2', null, [], [], { base: 'j', text: 'a' }), req('j', null, [], [], { base: 'j', text: 'b' })];
  assert.deepEqual(order(lines), ['p1', 'j-2', 'j']);
});

test('requests of one name that share a place and tie in all the order reads are told by their arrival, and each such pair is reported', () => {
  const ties: Array<[string, string]> = [];
  const lines = [req('p1', 'primary'), req('j-2', null, [], [], { base: 'j', text: 'a' }), req('j', null, [], [], { base: 'j', text: 'a' }), req('k', null, [], [], { base: 'k', text: 'a' }), req('j-3', null, [], [], { base: 'j', text: 'b' })];
  assert.deepEqual(orderStep(lines, undefined, (a, b) => ties.push([a, b])), ['p1', 'j', 'j-2', 'j-3', 'k']);
  assert.deepEqual(ties, [['j', 'j-2']]);
});

test('a request the stand-in answers as a re-send is written after the request it re-sends', () => {
  assert.deepEqual(order([req('S-2', null, [], [], { base: 'S', text: 'a', resends: 'S' }), req('S', null, [], [], { base: 'S', text: 'b' }), req('p1', 'primary')]), ['p1', 'S', 'S-2']);
});

test('lines whose tokens make a cycle are each written once', () => {
  const [a, b] = ['[[c:a.1]]', '[[c:b.1]]'];
  assert.deepEqual([...order([req('p1', 'primary', [b], [a]), req('x1', 'scout', [a], [b]), req('S', null, [a], [b])])].sort(), ['S', 'p1', 'x1']);
  assert.deepEqual([...order([req('p1', 'primary', [b], [a]), req('x1', 'scout', [a], [b])])].sort(), ['p1', 'x1']);
});
