import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferenceEnd } from './driver.ts';
import type { HostEvent } from './driver.ts';
import type { Step } from './script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';

const ENDING = /^inference:(failed|exhausted|aborted)$/;
const SPEECH = (content: string) => ({ type: 'inference:speech', agentName: 'fixture', content });
const COMPLETED = { type: 'inference:completed', agentName: 'fixture' };

async function waitOn(ends: Step['ends'], events: HostEvent[]) {
  const did: string[] = [];
  const list = events.map((e, at) => ({ at, e }));
  const out = await inferenceEnd({
    step: { id: 's', ends } satisfies DeepPartial<Step> as unknown as Step, from: 0, events: () => list, ending: ENDING,
    until: async (check) => { const found = check(); if (!found) throw new Error('timed out'); return found; },
    settle: async () => { did.push('settle'); },
    speechEnds: async (speech) => { did.push(`speech ${speech.e.content}`); return true; },
  });
  return { out, did };
}

test('a turn that ends either way is waited on to its inference\'s end, and where it spoke, to its speech\'s end too, whichever came first', async () => {
  assert.deepEqual(await waitOn('either', [COMPLETED]), { out: {}, did: ['settle'] }, 'ended unspoken');
  assert.deepEqual(await waitOn('either', [SPEECH('hi'), COMPLETED]), { out: {}, did: ['settle', 'speech hi', 'settle'] }, 'spoke, then ended');
  assert.deepEqual(await waitOn('either', [COMPLETED, SPEECH('hi')]), { out: {}, did: ['settle', 'speech hi', 'settle'] }, 'its speech traced after the end');
  assert.deepEqual(await waitOn('either', [SPEECH(''), COMPLETED]), { out: {}, did: ['settle'] }, 'an empty speech frame isn\'t speech');
  await assert.rejects(waitOn('either', [SPEECH('hi')]), /timed out/, 'speech alone doesn\'t end the wait: the inference\'s end does');
});

test('a turn that ends unspoken fails where it spoke, and a turn of either kind ends in a failed inference as the driver reports it', async () => {
  const spoke = await waitOn('unspoken', [SPEECH('hi'), COMPLETED]);
  assert.equal(spoke.out.spoke!.e.content, 'hi');
  assert.deepEqual(spoke.did, ['settle']);
  assert.deepEqual(await waitOn('unspoken', [COMPLETED]), { out: {}, did: ['settle'] });
  for (const ends of ['unspoken', 'either'] satisfies Step['ends'][]) {
    const failed = await waitOn(ends, [{ type: 'inference:failed', agentName: 'fixture' }]);
    assert.deepEqual([failed.out.ended!.e.type, failed.did], ['inference:failed', []], ends);
  }
});
