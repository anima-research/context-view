// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seamOf } from './seams.ts';

const part = (id, tokens = 10, more = {}) => ({ id, tokens, role: 'user', type: 'text', text: null, ...more });

test('a request compared with nothing is no seam', () => {
  assert.equal(seamOf(null, [part('a'), part('b')]), 0);
});

test('appending to what the previous request carried is no seam', () => {
  assert.equal(seamOf([part('sys', 5), part('a'), part('b')], [part('sys', 5), part('a'), part('b'), part('c'), part('d')]), 0);
});

test('a summary replacing messages is a seam the size of the messages it replaced', () => {
  const before = [part('sys', 5), part('a', 30), part('b', 40), part('c', 50), part('d', 7)];
  const after = [part('sys', 5), part('summary', 12), part('d', 7), part('e', 9)];
  assert.equal(seamOf(before, after), 120);
});

test('a front drop is a seam the size of the dropped parts alone, the tail it moves being carried', () => {
  const before = [part('sys', 5), part('a', 30), part('b', 40), part('c', 50)];
  assert.equal(seamOf(before, [part('sys', 5), part('b', 40), part('c', 50), part('d', 9)]), 30);
});

test('a part inserted before the end, with nothing taken out, is no seam', () => {
  assert.equal(seamOf([part('sys', 5), part('a'), part('b')], [part('sys', 5), part('a'), part('recall', 70), part('b'), part('c')]), 0);
});

test('a system prompt that changed is a seam the size of the old prompt', () => {
  assert.equal(seamOf([part('sys1', 179), part('a'), part('b')], [part('sys2', 39), part('a'), part('b'), part('c')]), 179);
});

test('a part carried twice must be there twice: each new part carries at most one', () => {
  assert.equal(seamOf([part('x', 8), part('x', 8), part('y', 3)], [part('x', 8), part('y', 3), part('z', 1)]), 8);
});

test("the previous request's last part grown at its end, as an API that joins a turn into its message sends it, is carried", () => {
  const before = [part('sys', 5), part('a', 10, { role: 'user', type: 'message', text: 'user: hello' })];
  const after = [part('sys', 5), part('a2', 16, { role: 'user', type: 'message', text: 'user: hello\nuser: and more' })];
  assert.equal(seamOf(before, after), 0);
});

test('only the last part may grow: an earlier part changed at its end is a seam', () => {
  const before = [part('a', 10, { type: 'message', text: 'user: hello' }), part('b', 4, { type: 'message', text: 'user: b' })];
  const after = [part('a2', 16, { type: 'message', text: 'user: hello and more' }), part('b', 4, { type: 'message', text: 'user: b' })];
  assert.equal(seamOf(before, after), 10);
});

test('a last part that grew counts as carried only by a part of its own role and type whose text begins with its text', () => {
  const last = part('a', 10, { role: 'user', type: 'message', text: 'user: hello' });
  assert.equal(seamOf([last], [part('a2', 16, { role: 'assistant', type: 'message', text: 'user: hello there' })]), 10, 'another role');
  assert.equal(seamOf([last], [part('a2', 16, { role: 'user', type: 'tool', text: 'user: hello there' })]), 10, 'another type');
  assert.equal(seamOf([last], [part('a2', 16, { role: 'user', type: 'message', text: 'user: goodbye' })]), 10, 'text that does not begin with it');
  assert.equal(seamOf([part('a', 10, { role: 'user', type: 'image', text: null })], [part('a2', 16, { role: 'user', type: 'image', text: null })]), 10, 'no text to grow');
});

test('a part already carried by identity is not used again to carry the last part by growth', () => {
  const before = [part('a', 10, { type: 'message', text: 'user: hi' }), part('b', 6, { type: 'message', text: 'user: hi' })];
  const after = [part('a', 10, { type: 'message', text: 'user: hi' })];
  assert.equal(seamOf(before, after), 6);
});
