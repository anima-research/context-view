import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { result, panel } from '../testing/check-builders.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Context, Run } from './workloads.ts';
import type { LogEntry } from '../strategies/driver.ts';

test('W11 flags a pin or mark lost as later ones are added, a first pin the panel never lists, and one placed by step 8 that the panel no longer lists, or lists over another range or level, after the cut or after the restore', () => {
  const ADDS = ['2.level0', '2.max0', '3.result', '4.max2', '4.level1', '8.document', '8.level1'];
  const pins = [{ id: 'p1', kind: 'pin', level: 0, firstMessageId: 'm1', lastMessageId: 'm1' }, { id: 'p2', kind: 'pin', maxLevel: 0, firstMessageId: 'm2', lastMessageId: 'm2' },
    { id: 'p3', kind: 'pin', firstMessageId: 'm3', lastMessageId: 'm3' }, { id: 'p4', kind: 'pin', maxLevel: 2, firstMessageId: 'm4', lastMessageId: 'm4' },
    { id: 'p5', kind: 'pin', level: 1, firstMessageId: 'm5', lastMessageId: 'm5' }, { id: 'd1', kind: 'document', maxLevel: 1, firstMessageId: 'm6', lastMessageId: 'm6' },
    { id: 'p6', kind: 'pin', level: 1, firstMessageId: 'm7', lastMessageId: 'm8' }];
  const snapshot = (step: string, list: object[]): DeepPartial<LogEntry> => ({ kind: 'panel', step: `9.${step}`, op: step.endsWith('pins') ? 'pins' : 'pin-add', response: { ok: true, data: { pins: list } } });
  const adds = (list = (k: number): object[] => pins.slice(0, k + 1)) => ADDS.map((step, k) => snapshot(step, list(k)));
  const check = (...log: DeepPartial<LogEntry>[]) => WORKLOADS.W11.check({ log, records: [] } satisfies DeepPartial<Run> as unknown as Run, { seed: 9 } satisfies DeepPartial<Context> as unknown as Context);
  const held = check(...adds(), snapshot('12.pins', pins), snapshot('14.pins', pins));
  assert.deepEqual([held.length, held.judged], [0, 7 + 7 * 2]);
  const firstMissing = check(...adds((k) => pins.slice(1, k + 1)), snapshot('12.pins', pins.slice(1)), snapshot('14.pins', pins.slice(1)));
  assert.deepEqual(firstMissing.map((f) => [f.step, f.message]), [['9.2.level0', 'adding this pin listed 0 new pin(s) or mark(s), and 0 listed before it are gone']]);
  const early = check(...adds((k) => (k >= 3 ? pins.slice(1, k + 1) : pins.slice(0, k + 1))), snapshot('12.pins', pins.slice(1)), snapshot('14.pins', pins.slice(1)));
  assert.deepEqual(early.map((f) => [f.step, f.message]), [['9.4.max2', 'adding this pin listed 1 new pin(s) or mark(s), and 1 listed before it are gone: pin at L0']]);
  const cut = check(...adds(), snapshot('12.pins', pins.slice(0, 5)), snapshot('14.pins', pins));
  assert.equal(cut.judged, 21);
  assert.deepEqual(cut.map((f) => [f.step, f.message]), [['9.12.pins', '2 of the 7 pins and marks placed by step 8 are gone: document to L1, pin at L1']]);
  const restored = check(...adds(), snapshot('12.pins', pins), snapshot('14.pins', pins.slice(1)));
  assert.deepEqual(restored.map((f) => f.step), ['9.14.pins'], 'a pin lost after the restore');
  const moved = check(...adds(), snapshot('12.pins', pins.map((p) => (p.id === 'p5' ? { ...p, level: 2 } : p.id === 'p6' ? { ...p, lastMessageId: 'm9' } : p))), snapshot('14.pins', pins));
  assert.deepEqual(moved.map((f) => [f.step, f.message]), [['9.12.pins', '2 of the 7 pins and marks placed by step 8 no longer protect what they did: pin at L1 is now pin at L2, pin at L1 is now pin at L1 over another range']]);
  const movedAfter = check(...adds(), snapshot('12.pins', pins), snapshot('14.pins', pins.map((p) => (p.id === 'p5' ? { ...p, level: 2 } : p))));
  assert.deepEqual(movedAfter.map((f) => [f.step, f.message]), [['9.14.pins', '1 of the 7 pins and marks placed by step 8 no longer protect what they did: pin at L1 is now pin at L2']]);
  const unread = check(...adds(), snapshot('12.pins', pins), { kind: 'panel', step: '9.14.pins', op: 'pins', response: { ok: true, data: {} } });
  assert.deepEqual([unread.judged, unread.map((f) => [f.step, f.message])], [7 + 7, [['9.14.pins', 'couldn\'t judge: the panel\'s pins answer holds no list']]]);
  const unplaced = check(snapshot('12.pins', pins));
  assert.deepEqual([unplaced.judged, unplaced[0].message], [0, 'couldn\'t judge: the panel listed no pin once the last was added']);
});
