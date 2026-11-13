import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostLines, stepWatch } from './step-log.ts';
import type { CompileLine } from './module.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';

test('a settle\'s gap opens at a settle\'s end and at a step\'s end, stays open across a `checkpoint` line, which the driver writes after a health read and starts nothing, and closes at the driver\'s next act of any kind, a clock move as it starts, a wait for a request the host starts by itself and the shutdown command as it\'s sent among them; what isn\'t an act leaves it as it is', () => {
  const g = stepWatch();
  assert.equal(g.open, false);
  g.logged('settle', { phase: 'pass' });
  assert.equal(g.open, false, 'a settle\'s pass');
  g.logged('settle', { phase: 'end', settled: true });
  assert.equal(g.open, true);
  for (const kind of ['request', 'compiles', 'provider-held', 'read', 'order', 'host', 'notice', 'checkpoint']) {
    g.logged(kind, {});
    assert.equal(g.open, true, kind);
  }
  for (const act of ['send', 'moving', 'advance', 'awaits', 'crash', 'boot', 'reload', 'remove', 'copy', 'suppress', 'panel', 'stopping', 'shutdown']) {
    g.logged('settle', { phase: 'end' });
    g.logged(act, {});
    assert.equal(g.open, false, act);
  }
  g.stepEnded();
  assert.equal(g.open, true);
});

test('a request in the gap fails the run, naming the request and its step, and one outside it doesn\'t', () => {
  const g = stepWatch();
  g.stepStarted();
  assert.equal(g.request({ id: 's.primary.1', kind: 'agent' }, 's'), null);
  g.logged('settle', { phase: 'end' });
  assert.match(g.request({ id: 's.probe.1', kind: 'probe' }, 's')!, /^request s\.probe\.1 \(probe\) arrived after a settle or a step ended and before the driver's next act/);
  g.logged('send', { via: 'ipc' });
  assert.equal(g.request({ id: 's.primary.2', kind: 'agent' }, 's'), null);
  g.stepEnded();
  assert.match(g.request({ id: 'x', kind: 'summariser' }, null)!, /^request x \(summariser\) arrived/);
});

test('a driver\'s line written after a request in its step fails the run, naming the line and the step; the same line before any request, or after a new step starts, doesn\'t, and nothing else the driver logs does', () => {
  const g = stepWatch();
  g.stepStarted();
  assert.equal(g.logged('send', { via: 'ipc' }, 's'), null, 'an action before any request');
  g.request({ id: 's.primary.1', kind: 'agent' }, 's');
  for (const [kind, fields] of [['send', { via: 'relist' }], ['moving', {}], ['settle', { phase: 'end' }], ['read', {}], ['provider-held', {}]] satisfies Array<[string, Record<string, unknown>]>) assert.equal(g.logged(kind, fields, 's'), null, kind);
  assert.match(g.logged('send', { via: 'fixture' }, 's')!, /^the driver wrote its action line after a request in step s, and the record puts a driver's line first in its step/);
  assert.match(g.logged('checkpoint', {}, 's')!, /its checkpoint line after a request in step s/);
  assert.match(g.logged('absent', {}, 's')!, /its absent line after a request in step s/);
  g.stepStarted();
  assert.equal(g.logged('checkpoint', {}, 't'), null, 'a new step');
});

const line = (seq: number, agent: string, more: DeepPartial<CompileLine> = {}) => ({ seq, agent, kind: 'request', outcome: 'compiled', ...more });

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
  assert.deepEqual(h.take(), { lines: [{ ref: 'c1:1', agent: 'conversation-a', at: 50n, needs: [] }], primary: 'conversation-a', wrote: new Map(), managers: new Set(['conversation-a']) });
  h.see('compiles', { boot: 1, lines: [line(3, 'fixture', { stamp: '70' })], blobs: {} });
  assert.equal(h.take().primary, 'fixture');
});

test('a take names as managers every agent that compiled anything, and every agent the host created, from the run\'s start', () => {
  const h = hostLines();
  h.see('ipc', { event: { type: 'dendrite:agent-created', agentName: 'fixture' } });
  assert.deepEqual(h.take().managers, new Set(['fixture']), 'created at the boot, before the first step');
  h.see('compiles', { boot: 1, lines: [line(1, 'fixture', { kind: 'dry' }), line(2, 'spawn-scout-1', { outcome: 'refused', error: {} })], blobs: {} });
  assert.deepEqual(h.take().managers, new Set(['fixture', 'spawn-scout-1']));
  h.see('ipc', { event: { type: 'dendrite:agent-created', agentName: 'fork-1' } });
  h.see('ipc', { event: { type: 'dendrite:agent-ended', agentName: 'fork-0' } });
  assert.deepEqual(h.take().managers, new Set(['fixture', 'spawn-scout-1', 'fork-1']));
  assert.deepEqual(h.take().managers, new Set(['fixture', 'spawn-scout-1', 'fork-1']), 'a creation counts for the rest of the run, as a compile does, though the agent never compiles');
});

test('a take names the agent whose store wrote a summary since the last take by the summary\'s mark, the first its text shows, its blob sent before or with it', () => {
  const h = hostLines();
  const said = (t: string) => ({ participant: 'summary', content: t });
  h.see('compiles', { boot: 1, lines: [], blobs: { s1: said('[[s:M11111111]] Memory, carried [[s:M99999999]]') } });
  h.see('compiles', { boot: 1, lines: [], blobs: {}, store: { fixture: { summaries: [{ id: 'L1-1', content: 's1' }] } } });
  assert.deepEqual([...h.take().wrote], [['[[s:M11111111]]', 'fixture']]);
  h.see('compiles', { boot: 1, lines: [], blobs: { s2: said('[[s:M22222222]] Memory') }, store: { 'spawn-scout-1': { summaries: [{ id: 'S-1', content: 's2' }] }, fixture: { summaries: { unreadable: 'x' } } } });
  assert.deepEqual([...h.take().wrote], [['[[s:M22222222]]', 'spawn-scout-1']], 'a summary written before the last take names no one now');
});

test('a mark that a store held before this take, that two agents\' stores wrote since it, or that a store held at a boot, names no agent: a store\'s holding it doesn\'t show whose call made it', () => {
  const said = (t: string) => ({ participant: 'summary', content: t });
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
