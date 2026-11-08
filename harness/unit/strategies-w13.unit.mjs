import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRecord, deliveredOf } from '../lib/standin/view.mjs';
import { configurations } from '../lib/strategies/script.mjs';
import { runOf, turnFates } from '../lib/strategies/workloads.mjs';

const facts = (capabilities) => ({ budget: 100_000, maxTokens: 16_000, capabilities });
const compiles = (...agents) => ({ kind: 'compiles', lines: agents.map((agent) => ({ kind: 'request', outcome: 'compiled', agent })) });

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
});

test('Hconv brings conversations where the arm has it, with every turn on one channel, and is W13 on two channels, saying so, where it doesn\'t', () => {
  const has = runOf('Hconv/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: true }));
  assert.ok(has.configuration.recipe.conversations && has.configuration.judges === 'fork' && !('gated' in has.configuration));
  assert.ok(!has.steps().some((s) => s.kind === 'absent'));
  assert.ok(has.steps().every((s) => s.kind !== 'channel' || s.channel === 'chat'), 'under conversations every turn is in one channel');
  const lacks = runOf('Hconv/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: false }));
  assert.ok(!lacks.configuration.recipe?.conversations && lacks.configuration.judges === undefined);
  assert.deepEqual(lacks.steps()[0], { id: `${lacks.seed}.absent.conversations`, segment: 'W13', kind: 'absent', stretch: 'conversations', canaries: [] });
  assert.ok(lacks.steps().some((s) => s.channel === 'side'), 'without it, W13 is two channels again');
  assert.throws(() => runOf('Hconv/W13', configurations(), facts({ unreadable: 'no package.json' })), /no package\.json/);
  assert.ok(runOf('Hconv/W13', configurations(), {}).configuration.recipe.conversations, 'before an arm is read, as brought');
});

test('each W13 setup scripts the fates its documentation gives', () => {
  const steps = (setup) => runOf(`${setup}/W13`, configurations(), facts({ suppression: true, onboarding: true, conversations: true })).steps();
  const fate = (setup, name) => steps(setup).find((s) => s.id.endsWith(`.${name}`))?.fate;
  assert.deepEqual(fate('H1', 'end'), { continues: false, receipt: { to: ['chat'] } });
  assert.deepEqual(fate('Hcont', 'end'), { continues: true, receipt: { to: ['chat'] } });
  assert.deepEqual(fate('Hhyb', 'routed').receipt, { to: ['side', 'chat'] });
  assert.deepEqual(fate('Hexpl', 'routed'), { continues: false, receipt: null, bounces: 2 });
  assert.deepEqual(fate('Hdis', 'end').receipt, { to: [], transcript: true });
  assert.deepEqual(fate('Hlock', 'end').receipt, { to: [], held: true });
  assert.deepEqual(fate('Hlock', 'locked').receipt, { to: ['chat'] }, 'after the move, the lock, whichever channel woke the turn');
  assert.equal(fate('Hpriv', 'think').receipt, null);
  assert.deepEqual(fate('Hlatest', 'skip.wake').receipt, { to: ['w13-quiet'] });
  assert.equal(fate('H1', 'skip.wake').undeliverable, true);
  assert.equal(fate('Hfold', 'wrapper').wrapper, 'contained');
  assert.equal(fate('Hfold', 'refuse').refused, 'replayed');
  assert.equal(fate('H1', 'refuse').refused, 'ended');
  assert.equal(fate('Hretry', 'overloaded').overloaded, true);
  assert.equal(fate('H1', 'overloaded'), undefined, 'the 529 under the default is H1/W11\'s');
  const order = steps('H1').map((s) => s.id.split('.').slice(1).join('.'));
  assert.ok(order.indexOf('skip') < order.indexOf('ambient') && order.indexOf('ambient') < order.indexOf('skip.wake'), 'the ambient message is the latest inbound when the self-wake comes');
  assert.equal(order.at(-1), 'last');
});

const request = (id, step, messages, answer = { stop: 'end_turn' }) => ({ id, step, kind: 'agent', agent: 'primary', messages, answer });
const m = (role, digest, ...blocks) => ({ role, digest, blocks });
const text = (more = {}) => ({ type: 'text', chars: 10, ...more });

test('W13\'s property reads a turn\'s receipt from what the requests after it add, and fails it where it lands elsewhere', () => {
  const steps = [{ id: 'a', canaries: ['[[c:a.in]]'], replies: [{ text: '[[c:a.r1]]' }], fate: { continues: false, receipt: { to: ['chat'] } } }, { id: 'b', canaries: ['[[c:b.in]]'], replies: [{ text: '[[c:b.r1]]' }] }];
  const first = request('r1', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'], cache: '1h' }))]);
  const landed = (to) => request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] })), m('assistant', 'a1', text({ canaries: ['[[c:a.r1]]'] })), m('user', 'u2', text({ delivered: { to, held: 0, kept: 0, transcript: 0 } }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [first, landed(['chat'])], log: [] }, steps, { forks: false }), []);
  assert.equal(turnFates({ records: [first, landed(['chat'])], log: [] }, steps, { forks: false }).judged, 2);
  assert.match(turnFates({ records: [first, landed(['side'])], log: [] }, steps, { forks: false })[0].message, /landed in side, where its setup lands it in chat/);
  const rewritten = request('r2', 'b', [m('user', 'other', text()), m('assistant', 'a1', text())]);
  assert.match(turnFates({ records: [first, rewritten], log: [] }, steps, { forks: false })[0].message, /couldn't judge its turn's fate: request r2 doesn't carry the window/);
});

test('W13\'s property counts a turn\'s continuations, and a contained wrapper\'s row in place of its reply', () => {
  const wrap = { id: 'w', canaries: ['[[c:w.in]]'], replies: [{ text: '<t>[[c:w.r1]]</t>' }], ends: 'contained', fate: { continues: false, wrapper: 'contained' } };
  const next = { id: 'n', canaries: ['[[c:n.in]]'], replies: [{ text: '[[c:n.r1]]' }] };
  const r1 = request('r1', 'w', [m('user', 'u1', text({ canaries: ['[[c:w.in]]'], cache: '1h' }))]);
  const joined = request('r2', 'n', [m('user', 'u1x', text({ canaries: ['[[c:w.in]]'] }), text({ notice: 'tool-boundary' }), text({ canaries: ['[[c:n.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [r1, joined], log: [] }, [wrap, next], { forks: false }), [], 'the row joins the user message before it');
  const kept = request('r2', 'n', [m('user', 'u1x', text({ canaries: ['[[c:w.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:w.r1]]'] })), m('user', 'u2', text({ canaries: ['[[c:n.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [r1, kept], log: [] }, [wrap, next], { forks: false }).map((f) => f.message), ['request r2 carries the wrapper the guard contains, [[c:w.r1]]', 'no [tool-boundary] row follows the contained wrapper']);
  const cont = { id: 'c', canaries: ['[[c:c.in]]'], replies: [{ text: '[[c:c.r1]]' }, { calls: [] }], fate: { continues: true } };
  const c1 = request('r1', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] }))]);
  const c2 = request('r2', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:c.r1]]'] })), m('user', 'u2', text({ notice: 'continue' }))]);
  assert.deepEqual(turnFates({ records: [c1, c2], log: [] }, [cont], { forks: false }), []);
  assert.match(turnFates({ records: [c1], log: [] }, [cont], { forks: false })[0].message, /0 continuation\(s\) followed its turn/);
  const routedFirst = request('r1', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] }), text({ notice: 'routing' }))]);
  assert.deepEqual(turnFates({ records: [routedFirst, c2], log: [] }, [], { forks: false, unrouted: true }).map((f) => f.message), ['request r1 carries a [routing] row, where disabled routing writes none'], 'the run\'s first request too, which no step\'s later rows hold');
  assert.deepEqual(turnFates({ records: [c1, c2], log: [] }, [], { forks: false, unrouted: true }), []);
  assert.equal(turnFates({ records: [c1, c2], log: [] }, [], { forks: false, unrouted: true }).judged, 1);
  assert.match(turnFates({ records: [], log: [compiles('fixture')] }, [], { forks: true })[0].message, /made by fixture, not by one fork of conversations/);
});
