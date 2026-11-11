// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostLines, settleGap } from './step-log.ts';

test('a settle\'s gap opens at a settle\'s end and at a step\'s end, and closes at the driver\'s next act of any kind, a clock move as it starts and a wait for a request the host starts by itself among them; what isn\'t an act leaves it as it is', () => {
  const g = settleGap();
  assert.equal(g.open, false);
  g.see('settle', { phase: 'pass' });
  assert.equal(g.open, false, 'a settle\'s pass');
  g.see('settle', { phase: 'end', settled: true });
  assert.equal(g.open, true);
  for (const kind of ['request', 'compiles', 'provider-held', 'read', 'order', 'host', 'notice']) {
    g.see(kind, {});
    assert.equal(g.open, true, kind);
  }
  for (const act of ['send', 'moving', 'advance', 'awaits', 'crash', 'boot', 'reload', 'remove', 'copy', 'checkpoint', 'suppress', 'panel', 'shutdown']) {
    g.see('settle', { phase: 'end' });
    g.see(act, {});
    assert.equal(g.open, false, act);
  }
  g.stepEnded();
  assert.equal(g.open, true);
});

const line = (seq, agent, more = {}) => ({ seq, agent, kind: 'request', outcome: 'compiled', ...more });

test('a step\'s host lines are its dry and refused compiles, each named by its boot and its line, placed before its agent\'s next compiled request by that compile\'s stamp, and needing the summaries\' marks its messages show, from blobs any earlier take sent', () => {
  const h = hostLines();
  h.see('compiles', { boot: 1, lines: [], blobs: { b1: { content: [{ type: 'text', text: 'note [[s:M11111111]] and [[s:M22222222]]' }] }, b2: 'plain' } });
  h.take();
  h.see('compiles', {
    boot: 1,
    lines: [
      line(1, 'fixture', { stamp: '100' }),
      line(2, 'fixture', { kind: 'dry', messages: [{ content: 'b1' }, { content: 'b2' }] }),
      line(3, 'spawn-scout-7', { kind: 'dry' }),
      line(4, 'fixture', { outcome: 'refused', error: { class: 'x' } }),
      line(5, 'fixture', { kind: 'other' }),
    ],
    blobs: {},
  });
  h.see('compiles', { boot: 1, lines: [line(6, 'fixture', { stamp: '300' })], blobs: {} });
  h.see('compiles', { boot: 2, lines: [line(1, 'spawn-scout-7', { stamp: '400' })], blobs: {} });
  const { lines, primary } = h.take();
  assert.equal(primary, 'fixture');
  assert.deepEqual(lines, [
    { ref: 'c1:2', agent: 'fixture', at: 300n, needs: ['[[s:M11111111]]', '[[s:M22222222]]'] },
    { ref: 'c1:3', agent: 'spawn-scout-7', at: null, needs: [] },
    { ref: 'c1:4', agent: 'fixture', at: 300n, needs: [] },
  ]);
  assert.deepEqual(h.take().lines, [], 'a take empties the step\'s lines');
});

test('a refused compile with its own stamp is placed by it, and the primary is a fork of `conversations` where it is the only agent that compiled a request, and the fixture agent otherwise', () => {
  const h = hostLines();
  h.see('compiles', { boot: 1, lines: [line(1, 'conversation-a', { outcome: 'refused', error: {}, stamp: '50' }), line(2, 'conversation-a', { stamp: '60' })], blobs: {} });
  assert.deepEqual(h.take(), { lines: [{ ref: 'c1:1', agent: 'conversation-a', at: 50n, needs: [] }], primary: 'conversation-a', wrote: new Map() });
  h.see('compiles', { boot: 1, lines: [line(3, 'fixture', { stamp: '70' })], blobs: {} });
  assert.equal(h.take().primary, 'fixture');
});

test('a take names the agent whose store wrote a summary since the last take by the summary\'s mark, the first its text shows, its blob sent before or with it', () => {
  const h = hostLines();
  const said = (t) => ({ participant: 'summary', content: t });
  h.see('compiles', { boot: 1, lines: [], blobs: { s1: said('[[s:M11111111]] Memory, carried [[s:M99999999]]') } });
  h.see('compiles', { boot: 1, lines: [], blobs: {}, store: { fixture: { summaries: [{ id: 'L1-1', content: 's1' }] } } });
  assert.deepEqual([...h.take().wrote], [['[[s:M11111111]]', 'fixture']]);
  h.see('compiles', { boot: 1, lines: [], blobs: { s2: said('[[s:M22222222]] Memory') }, store: { 'spawn-scout-1': { summaries: [{ id: 'S-1', content: 's2' }] }, fixture: { summaries: { unreadable: 'x' } } } });
  assert.deepEqual([...h.take().wrote], [['[[s:M22222222]]', 'spawn-scout-1']], 'a summary written before the last take names no one now');
});

test('a mark that a store held before this take, that two agents\' stores wrote since it, or that a store held at a boot, names no agent: a store\'s holding it doesn\'t show whose call made it', () => {
  const said = (t) => ({ participant: 'summary', content: t });
  const s1 = { s1: said('[[s:M11111111]] Memory') };
  const fixtureWrote = { fixture: { summaries: [{ id: 'L1-1', content: 's1' }] } };
  const inherited = hostLines();
  inherited.see('compiles', { boot: 1, lines: [], blobs: s1, store: fixtureWrote });
  inherited.take();
  inherited.see('compiles', { boot: 1, lines: [], blobs: {}, store: { 'spawn-scout-1': { summaries: [{ id: 'L1-1', content: 's1' }] } } });
  assert.deepEqual([...inherited.take().wrote], [], 'a fork whose store lists the summary it inherited');
  const unwritten = hostLines();
  unwritten.see('compiles', { boot: 1, lines: [], blobs: s1, store: fixtureWrote });
  unwritten.take();
  unwritten.see('compiles', { boot: 1, lines: [], blobs: {} });
  assert.deepEqual([...unwritten.take().wrote], [], 'a later call of that mark whose summary no store wrote');
  const both = hostLines();
  both.see('compiles', { boot: 1, lines: [], blobs: s1, store: { ...fixtureWrote, 'spawn-scout-1': { summaries: [{ id: 'S-1', content: 's1' }] } } });
  assert.deepEqual([...both.take().wrote], [], 'two stores in one take');
  const booted = hostLines();
  booted.see('compiles', { boot: 1, at: 'boot', lines: [], blobs: s1, store: fixtureWrote });
  assert.deepEqual([...booted.take().wrote], [], 'the store a boot loaded');
});
