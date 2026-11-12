import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessagesBody } from './anthropic.ts';
import type { ChatBody } from './chat.ts';
import type { ResponsesBody } from './responses.ts';

test('a use that needs a kind compiles only on a field whose row gives that kind, and a comparison or a check for presence compiles on any field', () => {
  const messages = { model: 'm' } as MessagesBody;
  const chat = { model: 'm' } as ChatBody;
  const responses = { model: 'm' } as ResponsesBody;
  const uses = [
    () => messages.model!.toUpperCase(),
    () => chat.reasoning_effort!.length,
    () => responses.instructions!.trim(),
    // @ts-expect-error
    () => messages.max_tokens! + 1,
    // @ts-expect-error
    () => chat.max_completion_tokens!.toFixed(),
    // @ts-expect-error
    () => responses.service_tier!.length,
    // @ts-expect-error
    () => messages.tool_choice!.toUpperCase(),
    // @ts-expect-error
    () => responses.metadata!.length,
    () => responses.truncation === 'auto',
    () => messages.stream != null,
  ];
  assert.equal(uses.length, 10);
});
