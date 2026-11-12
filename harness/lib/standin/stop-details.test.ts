// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE, agentBody, post, startStandin, step, summariserBody, withStandin } from '../testing/standin.ts';

// The Messages API's `stop_details`: null on every answer but a refusal; on a refusal, its category and an
// explanation, both null where the refusal maps to no named category; in a stream, on `message_delta`
// (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback, "What a refusal looks like").
const SENTENCE = 'The stand-in refused this request as reasoning_extraction.';

test('a Messages answer that isn\'t a refusal carries stop_details null, in a body and on a stream\'s message_start and message_delta', () => withStandin({}, async (s) => {
  s.setStep(step('n', [{ text: '[[c:n.r1]] one' }, { text: '[[c:n.r2]] two' }]));
  const body = await post(s.url, agentBody({ canary: '[[c:n.in]]', stream: false }));
  assert.equal(body.json.stop_reason, 'end_turn');
  assert.ok(Object.hasOwn(body.json, 'stop_details'), 'the field is there');
  assert.equal(body.json.stop_details, null);
  const streamed = await post(s.url, agentBody({ canary: '[[c:n.in]]' }));
  assert.ok(Object.hasOwn(streamed.opening, 'stop_details'), 'message_start\'s message has the field');
  assert.equal(streamed.opening.stop_details, null);
  assert.ok(Object.hasOwn(streamed.json, 'stop_details') && streamed.json.stop_details === null, 'message_delta carries it, null');
}));

test('a scripted refusal names its category in stop_details with the stand-in\'s sentence, and one that names none answers the API\'s unnamed refusal, in a body and a stream', () => withStandin({}, async (s) => {
  s.setStep(step('r', [
    { stop: 'refusal', category: 'reasoning_extraction' },
    { stop: 'refusal', category: 'reasoning_extraction' },
    { stop: 'refusal' },
    { stop: 'refusal' },
  ]));
  const named = { type: 'refusal', category: 'reasoning_extraction', explanation: SENTENCE };
  const unnamed = { type: 'refusal', category: null, explanation: null };
  const body = await post(s.url, agentBody({ canary: '[[c:r.in]]', stream: false }));
  assert.deepEqual([body.json.stop_reason, body.json.stop_details], ['refusal', named]);
  const streamed = await post(s.url, agentBody({ canary: '[[c:r.in]]' }));
  assert.deepEqual([streamed.json.stop_reason, streamed.json.stop_details, streamed.opening.stop_details], ['refusal', named, null]);
  const plain = await post(s.url, agentBody({ canary: '[[c:r.in]]', stream: false }));
  assert.deepEqual([plain.json.stop_reason, plain.json.stop_details], ['refusal', unnamed]);
  const plainStream = await post(s.url, agentBody({ canary: '[[c:r.in]]' }));
  assert.deepEqual(plainStream.json.stop_details, unnamed);
}));

test('with refusalCategory the summariser\'s refusals name it and have no content, the API\'s refusal before any output; without it, a refusal keeps its text and names none', async () => {
  for (const [opts, want, content] of [
    [{ refuseMerges: true, refusalCategory: 'reasoning_extraction' }, { type: 'refusal', category: 'reasoning_extraction', explanation: SENTENCE }, []],
    [{ refuseMerges: true }, { type: 'refusal', category: null, explanation: null }, [{ type: 'text', text: 'I can\'t help with that.' }]],
  ]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...opts });
    try {
      s.setStep(step('m', []));
      const merge = await post(s.url, summariserBody({ instruction: MERGE }));
      assert.deepEqual([merge.json.stop_reason, merge.json.stop_details, merge.json.content], ['refusal', want, content], JSON.stringify(opts));
      const l1 = await post(s.url, summariserBody({}));
      assert.deepEqual([l1.json.stop_reason, l1.json.stop_details], ['end_turn', null], 'an answered L1 names none');
    } finally { await s.close(); }
  }
});

test('the stand-in takes refusalCategory as a setup option', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, refusalCategory: 'reasoning_extraction' });
  await s.close();
});
