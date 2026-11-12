import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKLOADS } from './workloads.ts';
import { msg, text, call, result, carrying, crossing } from '../testing/check-builders.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Call, Step } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Context, Run } from './workloads.ts';

test('W6 flags each membrane repair mark a request carries, counts context-manager\'s own marks beside without flagging them, and flags a step 2 whose held call never reached the fixture server or never timed out', () => {
  const timedOut = [{ kind: 'notice', step: '3.2', peer: 'server', notice: 'held', canary: '[[c:3.2.call1]]' }, { kind: 'ipc', step: '3.2', event: { type: 'tool:failed', error: 'The "fixture" server didn\'t answer within 2 seconds' } }] satisfies DeepPartial<LogEntry>[];
  const ran = (records: DeepPartial<RequestRecord>[], log: DeepPartial<LogEntry>[] = timedOut) => ({ log, records } satisfies DeepPartial<Run> as unknown as Run);
  const request = (id: string, ...repairs: string[]): DeepPartial<RequestRecord> => ({ id, kind: 'agent', step: '3.3', messages: [msg('user', { type: 'text', chars: 10, ...(repairs.length ? { repairs } : {}) })] });
  const check = (...args: Parameters<typeof ran>) => WORKLOADS.W6.check(ran(...args), { seed: 3 } satisfies DeepPartial<Context> as unknown as Context);
  const designed = check([request('r1'), request('r2', 'context-manager:omitted')]);
  assert.deepEqual([designed.length, designed.judged, designed.besides], [0, 3, '2 request(s), 0 membrane repair mark(s), 1 of context-manager\'s own, 0 result(s) judged by their reply\'s calls, and the held call\'s timeout']);
  const repaired = check([request('r1', 'membrane:orphan'), request('r2', 'membrane:pending', 'context-manager:stub')]);
  assert.deepEqual(repaired.map((f) => [f.request, f.message]), [
    ['r1', 'request r1 carries membrane\'s orphan repair mark, so context-manager handed it a call or result unpaired'],
    ['r2', 'request r2 carries membrane\'s pending repair mark, so context-manager handed it a call or result unpaired'],
  ]);
  assert.equal(repaired.besides, '2 request(s), 2 membrane repair mark(s), 1 of context-manager\'s own, 0 result(s) judged by their reply\'s calls, and the held call\'s timeout');
  assert.deepEqual(check([request('r1')], []).map((f) => [f.step, f.message]), [['3.2', 'the fixture server held no call at this step, so the call it should hold never reached it']]);
  assert.deepEqual(check([request('r1')], timedOut.slice(0, 1)).map((f) => [f.step, f.message]), [['3.2', 'the call the fixture server held never timed out at this step']]);
});

test('W6 suppresses turn 5\'s first result, so its call is left unanswered while the turn\'s second round reuses its id', () => {
  const steps: Step[] = WORKLOADS.W6.steps({ seed: 3 } satisfies DeepPartial<Context> as unknown as Context);
  const turns = Array.from({ length: 12 }, (_, i) => [`3.${i + 1}`, ...((i + 1) % 4 === 3 ? [`3.${i + 1}.suppress`] : []), ...(i + 1 === 5 ? ['3.5.unanswered'] : [])]).flat();
  assert.deepEqual(steps.map((s) => s.id), turns);
  const unanswered = steps.find((s) => s.id === '3.5.unanswered')!;
  assert.deepEqual([unanswered.kind, unanswered.messages], ['suppress', [{ canary: '[[c:3.5.call1]]' }]]);
  const reused = steps.find((s) => s.id === '3.5')!;
  assert.deepEqual(reused.replies!.slice(0, 2).map((r) => (r.calls as Call[]).map((c) => [c.id, c.input!.canary])), [[['t3_reuse_5', '[[c:3.5.call1]]']], [['t3_reuse_5', '[[c:3.5.call2]]']]]);
});

test('W6 flags a result that goes out after a reply\'s call carrying another reply\'s call output, and passes the reply\'s own results, a stub and an omission', () => {
  const timedOut = [{ kind: 'notice', step: '3.2', peer: 'server', notice: 'held', canary: '[[c:3.2.call1]]' }, { kind: 'ipc', step: '3.2', event: { type: 'tool:failed', error: 'The "fixture" server didn\'t answer within 2 seconds' } }] satisfies DeepPartial<LogEntry>[];
  const check = (records: DeepPartial<RequestRecord>[]) => WORKLOADS.W6.check({ log: timedOut, records } satisfies DeepPartial<Run> as unknown as Run, { seed: 3 } satisfies DeepPartial<Context> as unknown as Context);
  const said = (canary: string, ...calls: number[]) => msg('assistant', text([canary]), ...calls.map(() => call('t3_reuse_5')));
  const answer = (canaries: string[] | null, repairs?: string[] | null, id = 't3_reuse_5') => ({ type: 'tool_result', chars: 10, toolUseId: id, ...(canaries ? { canaries } : {}), ...(repairs ? { repairs } : {}) });
  const request = (id: string, ...messages: ReturnType<typeof msg>[]): DeepPartial<RequestRecord> => ({ id, kind: 'agent', step: '3.6', messages });
  const crossed = check([request('r1',
    said('[[c:3.5.r1]]', 1), msg('user', answer(['[[c:3.5.call2]]'])),
    said('[[c:3.5.r2]]', 1), msg('user', answer(null, ['context-manager:stub']), { type: 'text', chars: 10, repairs: ['context-manager:moved'] }),
  )]);
  assert.deepEqual(crossed.map((f) => [f.step, f.request, f.message]), [['3.6', 'r1', 'request r1: a result after the calls of reply [[c:3.5.r1]] carries [[c:3.5.call2]], which no call of that reply made']]);
  assert.deepEqual([crossed.judged, crossed.besides], [4, '1 request(s), 0 membrane repair mark(s), 2 of context-manager\'s own, 2 result(s) judged by their reply\'s calls, and the held call\'s timeout']);
  const paired = check([request('r2',
    said('[[c:3.5.r1]]', 1), msg('user', answer(null, ['context-manager:stub'])),
    said('[[c:3.5.r2]]', 1), msg('user', answer(['[[c:3.5.call2]]'])),
    said('[[c:3.9.r1]]', 1), msg('user', { type: 'text', chars: 10, repairs: ['context-manager:omitted'] }),
    said('[[c:3.9.r2]]', 1), msg('user', { type: 'text', chars: 10 }),
    msg('assistant', text(['[[c:3.4.r1]]']), call('a'), call('b')), msg('user', answer(['[[c:3.4.call1]]'], null, 'a'), answer(['[[c:3.4.call2]]'], null, 'b')),
  )]);
  assert.deepEqual([paired.length, paired.judged], [0, 6]);
  const afterLast = check([request('r3', said('[[c:3.5.r3]]'), msg('user', answer(['[[c:3.5.call1]]'])))]);
  assert.deepEqual(afterLast.map((f) => f.message), ['request r3: a result after the calls of reply [[c:3.5.r3]] carries [[c:3.5.call1]], which no call of that reply made'], 'a reply that made no call made none of a result after it');
});

test('W6 judges a result against the calls of every scripted reply its assistant message carries, so a message holding two replies after a dropped call passes, and a crossing one reply carries still flags', () => {
  const timedOut = [{ kind: 'notice', step: '3.2', peer: 'server', notice: 'held', canary: '[[c:3.2.call1]]' }, { kind: 'ipc', step: '3.2', event: { type: 'tool:failed', error: 'The "fixture" server didn\'t answer within 2 seconds' } }] satisfies DeepPartial<LogEntry>[];
  const check = (...messages: ReturnType<typeof msg>[]) => WORKLOADS.W6.check({ log: timedOut, records: [{ id: 'r1', kind: 'agent', step: '3.6', messages }] } satisfies DeepPartial<Run> as unknown as Run, { seed: 3 } satisfies DeepPartial<Context> as unknown as Context);
  const answer = (canaries: string[] | null, repairs?: string[]) => ({ type: 'tool_result', chars: 10, toolUseId: 't3_reuse_5', ...(canaries ? { canaries } : {}), ...(repairs ? { repairs } : {}) });
  const merged = check(msg('assistant', text(['[[c:3.5.r1]]']), text(['[[c:3.5.r2]]']), call('t3_reuse_5')), msg('user', answer(['[[c:3.5.call2]]'])));
  assert.deepEqual([merged.length, merged.besides], [0, '1 request(s), 0 membrane repair mark(s), 0 of context-manager\'s own, 1 result(s) judged by their reply\'s calls, and the held call\'s timeout']);
  const crossed = check(
    msg('assistant', text(['[[c:3.5.r1]]']), call('t3_reuse_5')), msg('user', answer(['[[c:3.5.call2]]'])),
    msg('assistant', text(['[[c:3.5.r2]]']), call('t3_reuse_5')), msg('user', answer(null, ['context-manager:stub']), { type: 'text', chars: 10, repairs: ['context-manager:moved'] }),
  );
  assert.deepEqual(crossed.map((f) => f.message), ['request r1: a result after the calls of reply [[c:3.5.r1]] carries [[c:3.5.call2]], which no call of that reply made']);
  const stubbed = check(
    msg('assistant', text(['[[c:3.5.r1]]']), call('t3_reuse_5')), msg('user', answer(null, ['context-manager:stub'])),
    msg('assistant', text(['[[c:3.5.r2]]']), call('t3_reuse_5')), msg('user', answer(['[[c:3.5.call2]]'])),
  );
  assert.deepEqual([stubbed.length, stubbed.judged], [0, 4]);
  const both = check(msg('assistant', text(['[[c:3.5.r1]]']), text(['[[c:3.9.r1]]']), call('t3_reuse_5')), msg('user', answer(['[[c:3.4.call1]]'])));
  assert.deepEqual(both.map((f) => f.message), ['request r1: a result after the calls of replies [[c:3.5.r1]] and [[c:3.9.r1]] carries [[c:3.4.call1]], which no call of those replies made']);
});
