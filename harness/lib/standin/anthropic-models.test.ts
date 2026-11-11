import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from './anthropic.ts';

test('a front\'s model id takes the binding of the Messages API model it serves: an edited thinking block in an earlier assistant message is refused where that model binds, and not where it doesn\'t', () => {
  const codec = anthropic({ configuration: { windowTokens: 1_000_000 }, clock: () => 0, models: { 'front-binding': 'claude-opus-5-5', 'front-plain': 'claude-opus-4-6' } });
  const body = (model: string) => ({ model, max_tokens: 1024, messages: [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'edited', signature: 'fx1.not-its-own' }, { type: 'text', text: 'a' }] },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: 'three' },
  ] });
  assert.equal(codec.refusal(body('front-binding'))?.refused, 'thinking-modified');
  assert.equal(codec.refusal(body('front-plain')), null);
});
