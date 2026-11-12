import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { text, under } from '../testing/check-builders.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Step } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Context, Run } from './workloads.ts';

test('W8 judges the restore: steps 15 and 16 compile again once 1 to 4 did, a later one that doesn\'t flags, and one before the cut that didn\'t compile is couldn\'t-judge', () => {
  const ran = (outcomes: Record<string, 'compiled' | 'refused'>) => ({
    log: Object.entries(outcomes).map(([n, outcome], i): DeepPartial<LogEntry> => ({ kind: 'compiles', step: `5.${n}`, boot: 1, lines: [{ seq: i + 1, agent: 'fixture', kind: 'request', assembly: i + 1, outcome }] })),
    records: [],
  }) satisfies DeepPartial<Run> as unknown as Run;
  const all = Object.fromEntries([1, 2, 3, 4, 10, 15, 16].map((n) => [n, n === 10 ? 'refused' : 'compiled'] as const));
  const restored = WORKLOADS.W8.check(ran(all), { seed: 5, configurationName: 'C6h' } satisfies DeepPartial<Context> as unknown as Context);
  assert.deepEqual([restored.length, restored.judged], [0, 2], 'a refusal under the cut is the budget\'s');
  const late = WORKLOADS.W8.check(ran({ ...all, 15: 'refused' }), { seed: 5, configurationName: 'C6h' } satisfies DeepPartial<Context> as unknown as Context);
  assert.deepEqual(late.map((f) => f.message), ['step 15: refused 2 turn(s) after the budget was restored']);
  const { 16: _, ...without16 } = all;
  assert.deepEqual(WORKLOADS.W8.check(ran(without16), { seed: 5, configurationName: 'C6h' } satisfies DeepPartial<Context> as unknown as Context).map((f) => f.message), ['step 16: no request 3 turn(s) after the budget was restored']);
  const early = WORKLOADS.W8.check(ran({ ...all, 2: 'refused' }), { seed: 5, configurationName: 'C6h' } satisfies DeepPartial<Context> as unknown as Context);
  assert.deepEqual([early.judged, early[0].message], [0, 'couldn\'t judge the restore: step 2 refused, before the budget was lowered']);
});

test('W8 on H1 holds turn 10\'s first L1 summariser request, and while it is held, once the host has held the turn for budget, a message arrives on the turn\'s channel, an addressed one from another channel, and the clock moves 61 s; no other step, and no other setup\'s W8, changes', () => {
  const steps = (ctx: DeepPartial<Context>) => WORKLOADS.W8.steps({ seed: 5, budget: 100_000, reserve: 4_000, configuration: {}, ...ctx } satisfies DeepPartial<Context> as unknown as Context);
  const h1 = steps({ configurationName: 'H1' });
  const ten = h1.find((s) => s.id === '5.10')!;
  const { level, during } = ten.summariserHold!;
  assert.equal(level, 1);
  assert.deepEqual(during.map((a) => Object.keys(a)[0]), ['budgetHeld', 'deliver', 'deliver', 'advance']);
  assert.equal(during[0].budgetHeld, true);
  const [arrival, side] = [during[1].deliver!, during[2].deliver!];
  assert.deepEqual({ id: arrival.id, participant: arrival.participant, channel: arrival.channel, tags: arrival.tags }, { id: '5.10.arrival', participant: 'Tavy', channel: undefined, tags: undefined });
  assert.deepEqual({ id: side.id, participant: side.participant, channel: side.channel, tags: side.tags }, { id: '5.10.side', participant: 'Wren', channel: 'w8-side', tags: ['chat:addressed'] });
  assert.ok(arrival.text.startsWith('[[c:5.10.arrival.in]] ') && side.text.startsWith('[[c:5.10.side.in]] '));
  assert.equal(during[3].advance, 61_000, 'past a minute, so the hold\'s note gives minutes');
  assert.ok(['[[c:5.10.arrival.in]]', '[[c:5.10.side.in]]'].every((c) => ten.canaries!.includes(c)), 'the start after the hold carries them');
  assert.deepEqual(h1.filter((s) => s.summariserHold).map((s) => s.id), [ten.id], 'turn 10 is the only step of H1\'s W8 with a summariser hold');
  const plain = (list: Step[]) => JSON.stringify(list.map((s) => (s.id === ten.id ? (({ summariserHold, ...rest }) => ({ ...rest, ...(rest.canaries ? { canaries: rest.canaries.filter((c) => !/^\[\[c:5\.10\.(arrival|side)\.in\]\]$/.test(c)) } : {}) }))(s) : s)));
  assert.equal(plain(h1), plain(steps({ configurationName: 'C6h' })), 'the rest of H1\'s W8 is C6h\'s');
  assert.ok(steps({ configurationName: 'C6h' }).every((s) => !s.summariserHold) && steps({ configurationName: 'H4' }).every((s) => !s.summariserHold));
});
