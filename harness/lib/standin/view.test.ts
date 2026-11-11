// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRecord, deliveredOf } from './view.ts';

test('a [delivered] receipt reads as where the turn\'s plain speech landed, and what it held, kept private or kept in the transcript', () => {
  assert.deepEqual(deliveredOf('plain speech → chat'), { to: ['chat'], held: 0, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → side · chat'), { to: ['side', 'chat'], held: 0, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → chat · 1 plain-speech segment(s) held as draft d-6ksspnh (not sent — drafts can resend them unchanged, or dismiss them)'), { to: ['chat'], held: 1, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → no channel — 2 plain-speech segment(s) kept in the transcript (proseRouting=disabled — post to a channel only with an explicit send tool)'), { to: [], held: 0, kept: 0, transcript: 2 });
  assert.deepEqual(deliveredOf('nothing — 2 plain-speech segment(s) held as drafts d-rbuwyrw, d-h3uf6hg (not sent — drafts can resend them unchanged, or dismiss them)'), { to: [], held: 2, kept: 0, transcript: 0 });
  assert.deepEqual(deliveredOf('plain speech → side (draft d-x, by your resend) · 1 plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)'), { to: ['side'], held: 0, kept: 1, transcript: 0 });
  assert.deepEqual(blockRecord({ type: 'text', text: 'user: [delivered] plain speech → chat' }).delivered.to, ['chat'], 'after the participant\'s name membrane writes before it');
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
