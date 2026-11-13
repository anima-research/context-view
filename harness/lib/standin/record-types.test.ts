import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Answering, Claim, RequestRecord } from './standin.ts';

const reply = () => ({ content: [], stop: 'end_turn' });

test('a field that a record\'s kind or codec doesn\'t give it reads as undefined, a misspelt field fails a read or a write, and a claim gives fields where its kind has them and only there', () => {
  const uses = [
    (r: RequestRecord) => r.batch ?? [],
    (r: RequestRecord & { kind: 'judge' }) => r.batch.length,
    (r: RequestRecord) => r.transformations ?? [],
    (r: Extract<RequestRecord, { head: { api: 'messages' } }>) => r.transformations?.length,
    (r: RequestRecord & { kind: 'relevance' }) => r.kept.length,
    // @ts-expect-error
    (r: RequestRecord) => r.bacth,
    // @ts-expect-error
    (r: RequestRecord & { kind: 'judge' }) => r.kept?.length,
    // @ts-expect-error
    (r: Extract<RequestRecord, { head: { api: 'chat-completions' } }>) => r.transformations?.length,
    // @ts-expect-error
    (r: RequestRecord) => { r.apiChagned = true; },
    // @ts-expect-error
    (r: RequestRecord) => { r.closeUntaken = false; },
    () => ({ kind: 'judge', fields: () => ({ batch: [] }), answer: reply }) satisfies Claim<'judge'>,
    // @ts-expect-error
    () => ({ kind: 'judge', answer: reply }) satisfies Claim<'judge'>,
    // @ts-expect-error
    () => ({ kind: 'judge', answer: reply }) satisfies Answering,
    // @ts-expect-error
    () => ({ kind: 'agent', fields: () => ({ batch: [] }), answer: reply }) satisfies Claim,
  ];
  assert.equal(uses.length, 14);
});
