import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOrder } from './fates.ts';

test('stepOrder compares two steps by their place in the script, and a step with no place there is neither after nor before any step', () => {
  const { after, before } = stepOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual([after('c', 'a'), after('a', 'c'), after('b', 'b'), before('a', 'c'), before('c', 'a'), before('b', 'b')],
    [true, false, false, true, false, false]);
  for (const unplaced of [null, 'z']) {
    assert.deepEqual([after(unplaced, 'a'), after('a', unplaced), before(unplaced, 'c'), before('c', unplaced), after(unplaced, unplaced)],
      [false, false, false, false, false], `${unplaced}`);
  }
});
