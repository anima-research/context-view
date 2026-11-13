import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRecord, deliveredOf, rowCanaries } from './view.ts';

test('a [delivered] receipt reads as where the turn\'s plain speech landed, and what it held, kept private or kept in the transcript', () => {
  assert.deepEqual(deliveredOf('plain speech → chat'), { to: ['chat'], held: 0, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → side · chat'), { to: ['side', 'chat'], held: 0, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → chat · 1 plain-speech segment(s) held as draft d-6ksspnh (not sent — drafts can resend them unchanged, or dismiss them)'), { to: ['chat'], held: 1, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → no channel — 2 plain-speech segment(s) kept in the transcript (proseRouting=disabled — post to a channel only with an explicit send tool)'), { to: [], held: 0, kept: 0, transcript: 2 });
  assert.deepEqual(deliveredOf('nothing — 2 plain-speech segment(s) held as drafts d-rbuwyrw, d-h3uf6hg (not sent — drafts can resend them unchanged, or dismiss them)'), { to: [], held: 2, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → side (draft d-x, by your resend) · 1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)'), { to: ['side'], held: 0, kept: 1, transcript: 0 });
  assert.deepEqual(blockRecord({ type: 'text', text: 'user: [delivered] plain speech → chat' }).delivered!.to, ['chat'], 'after the participant\'s name membrane writes before it');
  assert.equal(blockRecord({ type: 'text', text: 'user: Tavy: [delivered] plain speech → chat' }).delivered, undefined, 'a channel message, after its author\'s name too, is no receipt');
  assert.equal(blockRecord({ type: 'text', text: 'a reply that mentions [delivered] in passing' }).delivered, undefined);
});

test('agent-framework\'s rows of where speech goes and how a turn ends are recorded by their tags', () => {
  for (const tag of ['routing', 'prose-routing', 'continue', 'tool-boundary', 'send-undeliverable']) {
    assert.equal(blockRecord({ type: 'text', text: `user: [${tag}] words` }).notice, tag);
  }
  assert.equal(blockRecord({ type: 'text', text: 'user: Tavy: \\[routing] supplied' }).notice, undefined, 'a tag a person supplied, which agent-framework marks, is no notice');
  assert.equal(blockRecord({ type: 'text', text: 'user: [Agent lifecycle: a has ended (completed) while its task agent "b" was still running.]' }).notice, 'Agent lifecycle', 'agent-framework\'s lifecycle facts open with their tag and a colon');
  assert.equal(blockRecord({ type: 'text', text: 'user: Tavy: \\[Agent lifecycle: supplied]' }).notice, undefined);
});

test('a block records the canaries it shows the model: a text\'s, a result\'s texts, a call\'s input and thinking; a row\'s canaries are only a text\'s and a result\'s, as the store read takes a row', () => {
  const blocks = [
    { type: 'text', text: '[[c:w.8.in]] words' },
    { type: 'tool_use', id: 't1', name: 'send_message', input: { channelId: 'chat', content: '[[c:w.8.say1]] said' } },
    { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '[[c:w.8.call1]] read' }] },
    { type: 'thinking', thinking: '[[c:w.8.thought]] thought', signature: 's' },
    { type: 'tool_use', id: 't3', name: 'history--search', input: { query: '[[c:w.2.in]]' } },
  ];
  const records = blocks.map((b) => blockRecord(b));
  assert.deepEqual(records.map((r) => r.canaries), [['[[c:w.8.in]]'], ['[[c:w.8.say1]]'], ['[[c:w.8.call1]]'], ['[[c:w.8.thought]]'], ['[[c:w.2.in]]']]);
  assert.deepEqual(records.map(rowCanaries), [['[[c:w.8.in]]'], [], ['[[c:w.8.call1]]'], [], []]);
  assert.equal(blockRecord({ type: 'tool_use', id: 't4', name: 'skip_reply', input: {} }).canaries, undefined, 'a call whose input shows none records none');
});
