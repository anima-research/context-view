import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, runOf } from './workloads.ts';
import { msg, text, call, result, asked, under } from '../testing/check-builders.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Call } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Context, Run } from './workloads.ts';

type Asked = DeepPartial<RequestRecord>;
type Logged = DeepPartial<LogEntry>;

test('W7 merges-refused: each refused merge raises one off-path alert at its step, a step where the counts differ is flagged, and a run where the stand-in refused no merge can\'t be judged, though an off-path refusal alert there still flags', () => {
  const refused = (step: string): Asked => ({ kind: 'summariser', step, answer: { shape: 'refusal' } });
  const merged = (step: string): Asked => ({ kind: 'summariser', step, answer: { shape: 'summary' } });
  const alert = (step?: string | null, kind = 'refusal-offpath'): Logged => ({ kind: 'ipc', step, event: { type: 'ops:alert', kind } });
  const check = (records: Asked[], log: Logged[]) => WORKLOADS.W7.check({ records, log } satisfies DeepPartial<Run> as unknown as Run, { variant: 'merges-refused' } satisfies DeepPartial<Context> as unknown as Context);
  const held = check([refused('7.3'), merged('7.3'), refused('7.5'), refused('7.5')], [alert('7.3'), alert('7.5'), alert('7.5'), alert('7.4', 'context-refusal')]);
  assert.deepEqual([held.length, held.judged], [0, 3]);
  const missing = check([refused('7.3'), refused('7.5')], [alert('7.3')]);
  assert.equal(missing.judged, 2);
  assert.deepEqual(missing.map((f) => [f.step, f.message]), [['7.5', '1 refused merge(s) at this step raised 0 off-path refusal alert(s), where each raises one and nothing else does']]);
  const extra = check([refused('7.3')], [alert('7.3'), alert('7.6')]);
  assert.deepEqual(extra.map((f) => [f.step, f.message]), [['7.6', '0 refused merge(s) at this step raised 1 off-path refusal alert(s), where each raises one and nothing else does']]);
  const none = check([merged('7.3')], [alert('7.3', 'context-refusal')]);
  assert.deepEqual([none.judged, none.map((f) => f.message)], [0, ['couldn\'t judge: the stand-in refused no merge']]);
  const stray = check([merged('7.3')], [alert('7.3')]);
  assert.deepEqual([stray.judged, stray.map((f) => [f.step, f.message])], [0, [
    [null, 'couldn\'t judge: the stand-in refused no merge'],
    ['7.3', '0 refused merge(s) at this step raised 1 off-path refusal alert(s), where each raises one and nothing else does'],
  ]]);
});

test('W7 chunk-refused: every summariser request that carried the refused content is judged, a step whose L1 requests carried it ahead of their slice or whose merges carried it is flagged, as is a step whose refused requests and off-path refusal alerts differ in number, and a run where none carried it, or where an L1 request carried it in its messages with no single notice opening a slice, can\'t be judged, though an off-path refusal alert there still flags', () => {
  const call = (step: string, carried?: string): Asked => ({ kind: 'summariser', step, ...(carried ? { carried } : {}), answer: { shape: carried ? 'refusal' : 'summary' } });
  const alert = (step?: string | null, kind = 'refusal-offpath'): Logged => ({ kind: 'ipc', step, event: { type: 'ops:alert', kind } });
  const alertsFor = (records: Asked[]) => records.filter((r) => r.answer!.shape === 'refusal').map((r) => alert(r.step));
  const check = (records: Asked[], log = alertsFor(records)) => WORKLOADS.W7.check({ records, log } satisfies DeepPartial<Run> as unknown as Run, { variant: 'chunk-refused' } satisfies DeepPartial<Context> as unknown as Context);
  const held = check([call('7.13', 'slice'), call('7.13', 'slice'), call('7.14'), call('7.16')]);
  assert.deepEqual([held.length, held.judged], [0, 2]);
  const cascade = check([call('7.13', 'slice'), call('7.14', 'ahead'), call('7.14', 'ahead'), call('7.17', 'merge'), call('7.17', 'ahead'), call('7.18')]);
  assert.equal(cascade.judged, 5);
  assert.deepEqual(cascade.map((f) => [f.step, f.message]), [
    ['7.14', '2 L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember'],
    ['7.17', '1 L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember, and 1 merge request(s) carried it'],
  ]);
  const aheadOnly = check([call('7.14', 'ahead'), call('7.15')]);
  assert.deepEqual([aheadOnly.judged, aheadOnly.map((f) => [f.step, f.message])], [1, [['7.14', '1 L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember']]]);
  const never = check([call('7.15')]);
  assert.deepEqual([never.judged, never.map((f) => f.message)], [0, ['couldn\'t judge: no summariser request carried the refused content']]);
  const stray = check([call('7.15')], [alert('7.15')]);
  assert.deepEqual([stray.judged, stray.map((f) => [f.step, f.message])], [0, [
    [null, 'couldn\'t judge: no summariser request carried the refused content'],
    ['7.15', '0 refused summariser request(s) at this step raised 1 off-path refusal alert(s), where each raises one and nothing else does'],
  ]]);
  const refusedFirst = check([call('7.13', 'slice'), { kind: 'summariser', step: '7.14', carried: 'ahead', refused: 'max_tokens', answer: { shape: 'refused' } }]);
  assert.deepEqual([refusedFirst.judged, refusedFirst.map((f) => [f.step, f.message])], [2, [['7.14', '1 L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember']]], 'a carrier refused for something else is judged, and raises no refusal alert');
  const unplacedStray = check([call('7.14', 'unplaced')], [alert('7.14'), alert('7.15')]);
  assert.deepEqual([unplacedStray.judged, unplacedStray.map((f) => f.step)], [0, ['7.14', '7.15']], 'an unplaced run still holds each step to its alerts');
  const unplaced = check([call('7.13', 'slice'), call('7.14', 'unplaced'), call('7.14', 'unplaced')]);
  assert.deepEqual([unplaced.judged, unplaced.map((f) => [f.step, f.message])], [0, [['7.14', 'couldn\'t judge: 2 L1 request(s) carried the refused content with no single notice opening the slice they asked the summariser to remember, so where it sat can\'t be read']]]);
  const slice = [call('7.13', 'slice'), call('7.13', 'slice')];
  const missing = check(slice, [alert('7.13'), alert('7.13', 'compression-quarantine')]);
  assert.equal(missing.judged, 2);
  assert.deepEqual(missing.map((f) => [f.step, f.message]), [['7.13', '2 refused summariser request(s) at this step raised 1 off-path refusal alert(s), where each raises one and nothing else does']]);
  const extra = check(slice, [alert('7.13'), alert('7.13'), alert('7.15')]);
  assert.deepEqual(extra.map((f) => [f.step, f.message]), [['7.15', '0 refused summariser request(s) at this step raised 1 off-path refusal alert(s), where each raises one and nothing else does']]);
  assert.deepEqual(WORKLOADS.W7.owns('chunk-refused'), [{ check: 1, what: 'refusal-offpath' }]);
});

test('W7 chunk-refused flags each membrane repair mark a summariser request carries, under any setup, and says how many requests it judged for them', () => {
  const summariser = (id: string, step: string, carried: string | null, ...repairs: string[]): Asked => ({ id, kind: 'summariser', step, ...(carried ? { carried } : {}), answer: { shape: carried === 'slice' ? 'refusal' : 'summary' }, messages: [msg('user', { type: 'text', chars: 10, ...(repairs.length ? { repairs } : {}) })] });
  const alerts: Logged[] = [{ kind: 'ipc', step: '7.13', event: { type: 'ops:alert', kind: 'refusal-offpath' } }];
  const check = (records: Asked[], log = alerts) => WORKLOADS.W7.check({ records, log } satisfies DeepPartial<Run> as unknown as Run, { variant: 'chunk-refused' } satisfies DeepPartial<Context> as unknown as Context);
  const duplicated = check([summariser('s1', '7.12', null, 'membrane:duplicate', 'context-manager:stub'), summariser('s2', '7.13', 'slice')]);
  assert.deepEqual(duplicated.map((f) => [f.step, f.request, f.message]), [['7.12', 's1', 'summariser request s1 carries membrane\'s duplicate repair mark, so context-manager handed it a call or result unpaired']]);
  assert.deepEqual([duplicated.judged, duplicated.besides], [1, '2 summariser request(s) judged for membrane repair marks']);
  const stubbed = { ...summariser('s1', '7.12', null), messages: [msg('user', { type: 'tool_result', chars: 10, toolUseId: 't1', repairs: ['context-manager:stub'] })] };
  const clean = check([stubbed, summariser('s2', '7.13', 'slice')]);
  assert.deepEqual([clean.length, clean.besides], [0, '2 summariser request(s) judged for membrane repair marks']);
  const never = check([summariser('s3', '7.12', null, 'membrane:orphan')], []);
  assert.deepEqual(never.map((f) => f.message), ['couldn\'t judge: no summariser request carried the refused content', 'summariser request s3 carries membrane\'s orphan repair mark, so context-manager handed it a call or result unpaired']);
  assert.equal(never.besides, '1 summariser request(s) judged for membrane repair marks');
  const unplaced = check([summariser('s4', '7.14', 'unplaced', 'membrane:duplicate')], []);
  assert.deepEqual([unplaced.map((f) => f.message), unplaced.besides], [[
    'couldn\'t judge: 1 L1 request(s) carried the refused content with no single notice opening the slice they asked the summariser to remember, so where it sat can\'t be read',
    'summariser request s4 carries membrane\'s duplicate repair mark, so context-manager handed it a call or result unpaired',
  ], '1 summariser request(s) judged for membrane repair marks']);
});

test('under H1 alone, W7 chunk-refused has each of turns 1 and 2 reuse its own call id over its three rounds, suppresses turn 1\'s first result and turn 2\'s first call, and opens the web UI for it', () => {
  const facts = { budget: 100_000, maxTokens: 16_000 };
  const h1 = runOf('H1/W7/chunk-refused', configurations(), facts);
  const s = h1.seed;
  const steps = h1.steps();
  const at = (id: string) => steps.findIndex((x) => x.id === `${s}.${id}`);
  assert.deepEqual([at('1.unanswered'), at('2.orphaned')], [at('1') + 1, at('2') + 1]);
  assert.deepEqual(['1.unanswered', '2.orphaned'].map((id) => [steps[at(id)].kind, steps[at(id)].messages]), [['suppress', [{ canary: `[[c:${s}.1.call1]]` }]], ['suppress', [{ canary: `[[c:${s}.2.r1]]` }]]]);
  for (const n of [1, 2]) assert.deepEqual(steps[at(String(n))].replies!.filter((r) => r.calls?.length).map((r) => (r.calls as Call[]).length), [1, 1, 1], `turn ${n}'s three rounds, one call each`);
  for (const n of [1, 2]) assert.deepEqual([...new Set(steps[at(String(n))].replies!.flatMap((r) => ((r.calls ?? []) as Call[]).map((c) => c.id)))], [`t${s}_reuse_${n}`]);
  assert.deepEqual(steps.filter((x) => (x.replies ?? []).some((r) => ((r.calls ?? []) as Call[]).some((c) => c.id !== undefined))).map((x) => x.id), [`${s}.1`, `${s}.2`]);
  assert.ok(h1.configuration.modules!.webui, 'H1\'s chunk-refused opens the web UI its suppressions go through');
  for (const id of ['C15h/W7/chunk-refused', 'C16h/W7/chunk-refused', 'C17h/W7/chunk-refused', 'H1/W7/merges-refused']) {
    const other = runOf(id, configurations(), facts);
    assert.deepEqual(other.steps().filter((x) => /\.(unanswered|orphaned)$/.test(x.id) || (x.replies ?? []).some((r) => ((r.calls ?? []) as Call[]).some((c) => c.id !== undefined))).map((x) => x.id), [], id);
    assert.equal(other.configuration.modules?.webui, undefined, id);
  }
});
