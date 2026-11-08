import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySteps, usageOf } from '../lib/usage.mjs';

const tokens = (input, cacheRead, cacheWrite, output) => ({ input, cacheRead, cacheWrite, output });
const dropped = (n) => Array.from({ length: n }, (_, j) => ({ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: `messages.1.content.${j}` }));
const allowed = [{ type: 'thinking_mismatch_allowed', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }];

test('a run\'s usage sums each request kind\'s tokens and dropped thinking, counts the last primary agent request\'s drops, and leaves out a request the stand-in refused', () => {
  const records = [
    { kind: 'agent', agent: 'primary', tokens: tokens(100, 0, 50, 10), transformations: dropped(2) },
    { kind: 'summariser', tokens: tokens(30, 0, 0, 5) },
    { kind: 'agent', agent: 'primary', tokens: tokens(20, 130, 0, 7), transformations: allowed },
    { kind: 'agent', agent: 'sub', tokens: tokens(5, 0, 0, 1), transformations: dropped(1) },
    { kind: 'unclassified', reason: 'refused' },
  ];
  const u = usageOf(records, [], 'fixture');
  assert.deepEqual(u.kinds, {
    agent: { requests: 3, input: 125, cacheRead: 130, cacheWrite: 50, output: 18, dropped: 3 },
    summariser: { requests: 1, input: 30, cacheRead: 0, cacheWrite: 0, output: 5, dropped: 0 },
  });
  assert.equal(u.lastDropped, 0, 'the last primary request\'s block was shown, not dropped, and the reader\'s drops aren\'t the primary\'s');
  assert.equal(usageOf(records.slice(0, 2), [], 'fixture').lastDropped, 2);
  assert.equal(usageOf([], [], 'fixture').lastDropped, null, 'no agent request, no count');
  assert.equal('history' in usageOf(records, [], 'fixture'), false, 'a run that builds no history gives none');
  const refused = [...records, { kind: 'agent', agent: 'primary', refused: 'thinking' }];
  assert.deepEqual(usageOf(refused, [], 'fixture').kinds, u.kinds, 'an agent request the stand-in classified and then refused counts nothing');
  assert.equal(usageOf(refused, [], 'fixture').lastDropped, 0, 'and isn\'t the last request answered');
});

test('an agent request with no agent marker is the primary\'s, as the checks read it', () => {
  const records = [
    { kind: 'agent', agent: 'primary', tokens: tokens(100, 0, 50, 10), transformations: dropped(2) },
    { kind: 'agent', tokens: tokens(20, 130, 0, 7), transformations: dropped(1) },
  ];
  assert.equal(usageOf(records, [], 'fixture').lastDropped, 1);
});

test('a run that writes its own history gives that history\'s sums apart, from the steps it names, and its whole sums still count them', () => {
  const records = [
    { kind: 'agent', agent: 'primary', step: 'p.1', tokens: tokens(100, 0, 50, 10) },
    { kind: 'summariser', step: 'p.2', tokens: tokens(30, 0, 0, 5) },
    { kind: 'agent', agent: 'primary', step: 'c.cm.1', tokens: tokens(20, 130, 0, 7), transformations: dropped(1) },
  ];
  const u = usageOf(records, [], 'fixture', new Set(['p.1', 'p.2']));
  assert.deepEqual(u.history, {
    agent: { requests: 1, input: 100, cacheRead: 0, cacheWrite: 50, output: 10, dropped: 0 },
    summariser: { requests: 1, input: 30, cacheRead: 0, cacheWrite: 0, output: 5, dropped: 0 },
  });
  assert.deepEqual(u.kinds.agent, { requests: 2, input: 120, cacheRead: 130, cacheWrite: 50, output: 17, dropped: 1 });
});

test('a run\'s calibration is the judged agent\'s at the last health read, a checkpoint\'s or the end\'s, or null where none gives one', () => {
  const read = (kind, calibration, agent = 'fixture') => ({ kind, health: { data: { contextComposition: { [agent]: { calibration } } } } });
  const log = [
    read('checkpoint', { multiplier: 1.29, pricingEpoch: 6, ceiling: 1.8 }),
    { kind: 'health', name: 'end', skipped: 'the run\'s last step stopped its host' },
  ];
  assert.deepEqual(usageOf([], log, 'fixture').calibration, { multiplier: 1.29, provisional: false, reset: false }, 'a skipped end read gives nothing, so the checkpoint\'s stands');
  const reset = [...log, read('health', { multiplier: 1, pricingEpoch: 6, provisional: true, reset: { discardedMultiplier: 1.8, fromEpoch: null, at: 1 }, ceiling: 1.8 })];
  assert.deepEqual(usageOf([], reset, 'fixture').calibration, { multiplier: 1, provisional: true, reset: true });
  assert.equal(usageOf([], [read('checkpoint', { multiplier: 1.1 }, 'other')], 'fixture').calibration, null, 'another agent\'s');
  assert.equal(usageOf([], [read('checkpoint', undefined)], 'fixture').calibration, null, 'a strategy that keeps none');
});

test('a built history ends before its closing checkpoint, whose reboot is the continuation\'s, as an upgraded run\'s boot is', () => {
  const steps = [
    { id: 'p.1', segment: 'prefix', kind: 'channel' },
    { id: 'p.mid', segment: 'prefix', kind: 'checkpoint' },
    { id: 'p.2', segment: 'prefix', kind: 'channel' },
    { id: 'p.end', segment: 'prefix', kind: 'checkpoint', copyStore: true },
    { id: 'c.1', segment: 'continuation', kind: 'channel' },
  ];
  assert.deepEqual([...historySteps(steps, 'prefix')], ['p.1', 'p.mid', 'p.2']);
  assert.deepEqual([...historySteps(steps.slice(0, 3), 'prefix')], ['p.1', 'p.mid', 'p.2'], 'a history that ends on a turn is all its steps');
  assert.deepEqual([...historySteps(steps, 'other')], []);
  const records = [
    { kind: 'agent', agent: 'primary', step: 'p.1', tokens: tokens(100, 0, 50, 10) },
    { kind: 'summariser', step: 'p.end', tokens: tokens(30, 0, 0, 5) },
    { kind: 'agent', agent: 'primary', step: 'c.1', tokens: tokens(20, 0, 0, 7) },
  ];
  assert.deepEqual(usageOf(records, [], 'fixture', historySteps(steps, 'prefix')).history, {
    agent: { requests: 1, input: 100, cacheRead: 0, cacheWrite: 50, output: 10, dropped: 0 },
  }, 'the request the reboot answered is the continuation\'s');
});
