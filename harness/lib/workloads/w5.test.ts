// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairing } from '../strategies/checks.ts';
import { toolBlocksLost } from './w5.ts';
import { msg, text, call, result, store, sent } from '../testing/check-builders.ts';

test('W5 judges bodies stored in parts that context-manager sent whole, and that the store holds both blocks of each of its own calls: a body without its tool blocks flags and one with them counts; one sent altered or missing a shard, and an ordinary message, count for nothing as bodies; a call missing a block flags; a failed read is couldn\'t-judge', () => {
  const run = (read, sources, ...blocks) => ({
    log: [
      { kind: 'read', op: 'messages', answer: read },
      { kind: 'compiles', step: 'w', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: sources.map((id) => ({ sources: [`r:${id}`], content: 'x' })) }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:w.in]] words' }] } } },
    ],
    records: [{ id: 'r1', kind: 'agent', step: 'w', arrived: '11', messages: [msg('user', ...blocks, text(['[[c:w.in]]']))] }],
  });
  const plain = [{ id: '1', blocks: [{ type: 'tool_use', id: 't1' }] }, { id: '2', blocks: [{ type: 'tool_result', toolUseId: 't1' }] }];
  const parts = [{ id: '3', bodyGroupId: 'g', blocks: [{ type: 'tool_result', toolUseId: 't2' }] }, { id: '4', bodyGroupId: 'g', blocks: [{ type: 'text' }] }];
  const ordinary = toolBlocksLost(run(plain, ['1', '2'], call('t1'), result('t1')));
  assert.deepEqual([ordinary.length, ordinary.judged], [0, 0], 'an unsharded message isn\'t what W5 judges');
  const kept = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3', '4'], call('t1'), result('t1'), result('t2')));
  assert.deepEqual([kept.length, kept.judged], [0, 1]);
  const lost = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3', '4'], call('t1'), result('t1')));
  assert.equal(lost.judged, 1);
  assert.match(lost[0].message, /g went out whole but without its tool blocks tool_result:t2/);
  const altered = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3!content', '4!content'], call('t1'), result('t1')));
  assert.deepEqual([altered.length, altered.judged], [0, 0], 'a body context-manager sent altered, as its pairing repair does when a call\'s result isn\'t sent, isn\'t judged: check 3 judges the pairs');
  const partial = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3!shards'], call('t1'), result('t1')));
  assert.deepEqual([partial.length, partial.judged], [0, 0], 'a body missing a shard isn\'t judged');
  const unread = toolBlocksLost({ log: [{ kind: 'read', op: 'messages', step: 'w', answer: { unreadable: 'the store is closed' } }], records: [] });
  assert.equal(unread.judged, 0);
  assert.match(unread[0].message, /couldn't judge: the store's messages couldn't be read \(the store is closed\)/);
  const calls = [...plain, { id: '5', blocks: [{ type: 'tool_use', id: 't2' }] }];
  const whole = toolBlocksLost(run([...calls, ...parts], ['1', '2', '5', '3', '4'], call('t1'), result('t1'), call('t2'), result('t2')), ['t1', 't2']);
  assert.deepEqual([whole.length, whole.judged], [0, 3], 'every call the workload made is stored with its call and its result');
  const textOnly = [{ id: '3', bodyGroupId: 'g', blocks: [{ type: 'text' }] }, { id: '4', bodyGroupId: 'g', blocks: [{ type: 'text' }] }];
  const stripped = toolBlocksLost(run([...calls, ...textOnly], ['1', '2', '5', '3', '4'], call('t1'), result('t1'), call('t2')), ['t1', 't2']);
  assert.deepEqual(stripped.map((f) => f.message), ['the store holds none of these blocks of the workload\'s calls: tool_result:t2'], 'a body stored in parts without its tool blocks, which nothing else counts');
});

test('W5 takes a body from every read, so one removed before the last read still flags where it went out whole without its tool blocks', () => {
  const parts = [{ id: '3', bodyGroupId: 'g', blocks: [{ type: 'tool_result', toolUseId: 't2' }] }, { id: '4', bodyGroupId: 'g', blocks: [{ type: 'text' }] }];
  const run = {
    log: [
      { kind: 'read', op: 'messages', step: 'w', answer: parts },
      { kind: 'compiles', step: 'w', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: ['3', '4'].map((id) => ({ sources: [`r:${id}`], content: 'x' })) }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:w.in]] words' }] } } },
      { kind: 'read', op: 'messages', step: 'z', answer: [] },
    ],
    records: [{ id: 'r1', kind: 'agent', step: 'w', arrived: '11', messages: [msg('user', text(['[[c:w.in]]']))] }],
  };
  const lost = toolBlocksLost(run);
  assert.equal(lost.judged, 1);
  assert.match(lost[0].message, /g went out whole but without its tool blocks tool_result:t2/);
});
