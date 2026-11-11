import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Cut, cutError, cutMessage, cutText, cutThrow, errorText } from './interfaces.ts';

test('a cut text is shown as it was, and its whole is kept only where the cut removed something', () => {
  assert.deepEqual(cutText((cut) => `x: ${cut('abc', 5)}`), { shown: 'x: abc' });
  assert.deepEqual(cutText((cut) => `x: ${cut('abcdefgh', 5)}`), { shown: 'x: abcde', full: 'x: abcdefgh' });
});

test('a cut list shows its first names, and its whole is every name with no mark that names were left out', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const write = (cut: Cut, whole: boolean) => `${names.length} missing: ${cut(names, 5, ' ')}${!whole && names.length > 5 ? ' …' : ''}`;
  assert.deepEqual(cutText(write), { shown: '7 missing: a b c d e …', full: '7 missing: a b c d e f g' });
  assert.deepEqual(cutText((cut) => cut(['a', 'b'], 5)), { shown: 'a, b' });
});

test('an error\'s message is cut to its bound, with the whole message kept beside it', () => {
  const long = new Error(`${'x'.repeat(250)}END`);
  const { shown, full } = cutError(long, 200);
  assert.equal(shown.length, 200);
  assert.ok(full!.endsWith('END'));
  assert.deepEqual(cutError(new Error('short'), 200), { shown: 'short' });
});

test('an error with an empty message is shown by its constructor\'s name and "with no message", cut or uncut, so a reason made from it is never empty', () => {
  class Failure extends Error {}
  assert.deepEqual(cutError(new Error(''), 200), { shown: 'Error with no message' });
  assert.deepEqual(cutError(new TypeError(''), 200), { shown: 'TypeError with no message' });
  assert.deepEqual(cutError(new Failure(''), 200), { shown: 'Failure with no message' });
  assert.deepEqual(cutError('', 200), { shown: 'String with no message' });
  assert.equal(errorText(new Error('')), 'Error with no message');
  assert.equal(errorText(new Error('x'.repeat(3000))), 'x'.repeat(3000), 'uncut');
});

test('a thrown value that says nothing is shown by what it is: undefined, null, or an object\'s constructor, and an array as its text, cut by characters', () => {
  assert.deepEqual(cutError(undefined, 200), { shown: 'undefined with no message' });
  assert.deepEqual(cutError(null, 200), { shown: 'null with no message' });
  assert.deepEqual(cutError({}, 200), { shown: 'Object with no message' });
  assert.deepEqual(cutError({ message: {} }, 200), { shown: 'Object with no message' });
  assert.equal(errorText(['a', 'b']), 'a,b');
  assert.deepEqual(cutError(['a', 'b'], 200), { shown: 'a,b' });
  assert.deepEqual(cutError(['x'.repeat(300)], 200), { shown: 'x'.repeat(200), full: 'x'.repeat(300) });
});

test('a flag\'s message is the shown text, with the whole as full only where they differ', () => {
  assert.deepEqual(cutMessage((cut) => cut('abcdef', 3)), { message: 'abc', full: 'abcdef' });
  assert.deepEqual(cutMessage((cut) => cut('ab', 3)), { message: 'ab' });
});

test('a tail cut keeps a text\'s end or a list\'s last items, with the whole beside them', () => {
  assert.deepEqual(cutText((cut) => cut('abcdefgh', -3)), { shown: 'fgh', full: 'abcdefgh' });
  assert.deepEqual(cutText((cut) => cut(['1', '2', '3', '4'], -2, '\n')), { shown: '3\n4', full: '1\n2\n3\n4' });
  assert.deepEqual(cutText((cut) => cut('abc', -3)), { shown: 'abc' });
});

test('an error thrown with a cut message carries its whole, and cutting it again keeps that whole', () => {
  const e = cutThrow((cut) => `failed: ${cut('abcdefgh', -3)}`);
  assert.equal(e.message, 'failed: fgh');
  assert.equal(e.full, 'failed: abcdefgh');
  assert.deepEqual(cutError(e, 200), { shown: 'failed: fgh', full: 'failed: abcdefgh' });
  assert.deepEqual(cutError(e, 5), { shown: 'faile', full: 'failed: abcdefgh' });
  assert.equal(cutThrow((cut) => cut('ab', 5)).full, undefined);
});
