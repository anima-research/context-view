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

test('W13 scripts, under each setup but Hconv, the fate its value gives one of its steps, with the ambient message before the self-wake and a last turn', () => {
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

test('Hlatest pushes from a closed channel and re-pins to an inbound-only one, and explicit and hybrid bounce a console turn, each with the fate main gives it; no other setup gets these steps, the push or channel kinds', () => {
  const all = configurations();
  const job = (setup) => runOf(`${setup}/W13`, all, facts({ suppression: true, onboarding: true, conversations: true }));
  const step = (setup, name) => job(setup).steps().find((s) => s.id.endsWith(`.${name}`));
  assert.equal(all.Hlatest.fixturePush, true);
  assert.deepEqual(all.Hlatest.fixtureChannels, { 'w13-push': { initiallyOpen: false }, 'w13-feed': { direction: 'inbound' } });
  for (const [name, c] of Object.entries(all)) if (name !== 'Hlatest') assert.ok(!c.fixturePush && !c.fixtureChannels, `${name} gives no push and declares no channel kinds`);
  const push = step('Hlatest', 'push');
  assert.deepEqual([push.kind, push.channel, push.tags], ['push', 'w13-push', ['chat:addressed']]);
  assert.match(push.text, /^\[\[c:\d+\.push\.in\]\] /);
  assert.deepEqual(push.replies, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }]);
  assert.deepEqual(push.fate, { continues: false, receipt: null });
  const woke = step('Hlatest', 'push.wake');
  assert.deepEqual([woke.kind, woke.ms, woke.fate.receipt], ['advance', 121_000, { to: ['w13-quiet'] }], 'the latest delivered channel message is the ambient one, since main counts no push');
  const repin = step('Hlatest', 'repin');
  assert.equal(repin.channel, 'chat');
  assert.equal(repin.replies[0].hold, true);
  assert.deepEqual(repin.replies[0].during.map((a) => [a.deliver.channel, a.deliver.tags]), [['w13-feed', ['chat:addressed']]]);
  assert.match(repin.replies[1].text, /^\[\[c:\d+\.repin\.r2\]\] /, 'the turn speaks after the re-pin');
  assert.deepEqual(repin.spare, [{ calls: [{ name: 'skip_reply', input: {} }] }], 'the feed message\'s own wake');
  assert.equal(repin.failsPublish, true);
  assert.deepEqual(repin.fate, { continues: false, receipt: { to: ['chat'] }, sendFailed: true });
  const order = job('Hlatest').steps().map((s) => s.id.split('.').slice(1).join('.'));
  assert.ok(order.indexOf('skip.wake') < order.indexOf('push') && order.indexOf('push') + 1 === order.indexOf('push.wake') && order.indexOf('push.wake') < order.indexOf('repin') && order.at(-1) === 'last');
  const con = (setup) => step(setup, 'con');
  assert.equal(con('Hexpl').kind, 'console');
  assert.match(con('Hexpl').replies[0].text, /^\[\[c:\d+\.con\.r1\]\] /, 'no prefix under explicit');
  assert.match(con('Hhyb').replies[0].text, /^>>>#w13-nowhere \[\[c:\d+\.con\.r1\]\] /, 'an envelope naming no channel under hybrid');
  assert.deepEqual(con('Hexpl').fate, { continues: false, receipt: null, bounces: 1 });
  assert.deepEqual(con('Hhyb').fate, { continues: false, receipt: { to: [], held: true }, bounces: 1 });
  for (const setup of ['Hexpl', 'Hhyb']) {
    assert.equal(con(setup).drafts, 'bounced');
    assert.deepEqual(con(setup).spare, [{ calls: [{ name: 'skip_reply', input: {} }] }], 'a bounce-wake\'s turn');
  }
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hexpl', 'Hhyb']) {
    assert.ok(!job(setup).steps().some((s) => /\.(push|push\.wake|repin)$/.test(s.id)), `${setup} has no push or re-pin`);
  }
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hlatest']) {
    assert.ok(!job(setup).steps().some((s) => /\.con$/.test(s.id)), `${setup} has no bounced console turn`);
  }
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
  const c2none = request('r2', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:c.r1]]'] }))]);
  assert.match(turnFates({ records: [c1, c2none], log: [] }, [cont], { forks: false })[0].message, /0 continuation\(s\) followed its turn/);
  const routedFirst = request('r1', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] }), text({ notice: 'routing' }))]);
  assert.deepEqual(turnFates({ records: [routedFirst, c2], log: [] }, [], { forks: false, unrouted: true }).map((f) => f.message), ['request r1 carries a [routing] row, where disabled routing writes none'], 'the run\'s first request too, which no step\'s later rows hold');
  assert.deepEqual(turnFates({ records: [c1, c2], log: [] }, [], { forks: false, unrouted: true }), []);
  assert.equal(turnFates({ records: [c1, c2], log: [] }, [], { forks: false, unrouted: true }).judged, 1);
  assert.match(turnFates({ records: [], log: [compiles('fixture')] }, [], { forks: true })[0].message, /made by fixture, not by one fork of conversations/);
});

const fated = (fate, more = {}) => [{ id: 'a', canaries: ['[[c:a.in]]'], replies: [{ text: '[[c:a.r1]]' }], fate, ...more }, { id: 'b', canaries: ['[[c:b.in]]'], replies: [{ text: '[[c:b.r1]]' }] }];
const opening = request('r1', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'], cache: '1h' }))]);
const after = (...rows) => request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] })), m('assistant', 'a1', text({ canaries: ['[[c:a.r1]]'] })), m('user', 'u2', ...rows, text({ canaries: ['[[c:b.in]]'] }))]);
const receipt = (to, more = {}) => text({ delivered: { to, held: 0, kept: 0, transcript: 0, ...more } });
const fatesOf = (steps, ...records) => turnFates({ records, log: [] }, steps, { forks: false }).map((f) => f.message);

test('W13\'s property holds a receipt to what its setup held, kept private and kept in the transcript, and to there being one at all', () => {
  assert.deepEqual(fatesOf(fated({ receipt: { to: ['chat'] } }), opening, after(receipt(['chat']))), []);
  assert.match(fatesOf(fated({ receipt: { to: ['chat'] } }), opening, after(receipt(['chat'], { held: 1 })))[0], /names 1 draft\(s\) held, where its setup holds none/);
  assert.match(fatesOf(fated({ receipt: { to: ['chat'] } }), opening, after(receipt(['chat'], { kept: 1 })))[0], /names 1 segment\(s\) kept private, where its setup keeps none private/);
  assert.match(fatesOf(fated({ receipt: { to: ['chat'], kept: true } }), opening, after(receipt(['chat'])))[0], /names 0 segment\(s\) kept private, where its setup keeps some private/);
  assert.match(fatesOf(fated({ receipt: { to: ['chat'] } }), opening, after(receipt(['chat'], { transcript: 1 })))[0], /names 1 segment\(s\) kept in the transcript, where its setup keeps none there/);
  assert.match(fatesOf(fated({ receipt: { to: [], transcript: true } }), opening, after(receipt([])))[0], /names 0 segment\(s\) kept in the transcript, where its setup keeps its words there/);
  assert.match(fatesOf(fated({ receipt: { to: [], held: true } }), opening, after(receipt([])))[0], /names 0 draft\(s\) held, where its setup holds some/);
  assert.match(fatesOf(fated({ receipt: null }), opening, after(receipt(['chat'])))[0], /wrote a \[delivered\] receipt \(to chat\), where its setup writes none/);
  assert.match(fatesOf(fated({ receipt: { to: ['chat'] } }), opening, after())[0], /no \[delivered\] receipt follows its turn, up to request r2, where its setup writes one/);
  assert.deepEqual(fatesOf(fated({ receipt: { to: ['chat'] } }), opening), ['couldn\'t judge its turn\'s fate: no request follows it'], 'a turn with no request after it shows no aftermath to judge');
});

test('W13\'s property asks for the no-channel notice, explicit mode\'s bounces and autoContinue\'s continuations by count', () => {
  assert.deepEqual(fatesOf(fated({ undeliverable: true }), opening, after(text({ notice: 'send-undeliverable' }))), []);
  assert.match(fatesOf(fated({ undeliverable: true }), opening, after())[0], /no \[send-undeliverable\] row follows its turn/);
  assert.deepEqual(fatesOf(fated({ bounces: 2 }), opening, after(text({ notice: 'prose-routing' }), text({ notice: 'prose-routing' }))), []);
  assert.match(fatesOf(fated({ bounces: 2 }), opening, after(text({ notice: 'prose-routing' })))[0], /^1 \[prose-routing\] bounce\(s\) follow its turn, where its setup bounces 2/);
  assert.match(fatesOf(fated({ continues: false }), opening, after(text({ notice: 'continue' })))[0], /^1 continuation\(s\) followed its turn, where none does/, 'a continuation where none may come, in the next step\'s request');
  assert.match(fatesOf(fated({ continues: true }), opening, after(text({ notice: 'continue' }), text({ notice: 'continue' })))[0], /^2 continuation\(s\) followed its turn/, 'counted by row, two in one request');
});

test('W13\'s property finds an unguarded wrapper in the history after its turn', () => {
  const wrapper = (fate) => fated(fate, { replies: [{ text: '<t>[[c:a.r1]]</t>' }] });
  assert.deepEqual(fatesOf(wrapper({ wrapper: 'kept' }), opening, after()), []);
  const dropped = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.match(fatesOf(wrapper({ wrapper: 'kept' }), opening, dropped)[0], /the wrapper \[\[c:a\.r1\]\] isn't in the history after its turn/);
});

test('W13\'s property holds a refusal to ending its turn, or to one whole replay, and an overloaded error to one more request with its turn\'s message', () => {
  const refusal = request('r1', 'a', opening.messages, { stop: 'refusal' });
  const again = (messages) => request('r1b', 'a', messages);
  const next = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(fatesOf(fated({ refused: 'ended', receipt: null }), refusal, next), []);
  assert.match(fatesOf(fated({ refused: 'ended', receipt: null }), refusal, again(opening.messages), next)[0], /followed by 1 more at its step, where nothing retries/);
  assert.match(fatesOf(fated({ refused: 'ended', receipt: null }), opening, next)[0], /^0 of the step's 1 request\(s\) were refused/);
  assert.deepEqual(fatesOf(fated({ refused: 'replayed' }), refusal, again(opening.messages), next), []);
  const unlike = [m('user', 'u1y', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }))];
  const nextUnlike = request('r2', 'b', [m('user', 'u1z', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.match(fatesOf(fated({ refused: 'replayed' }), refusal, again(unlike), nextUnlike)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/);
  assert.match(fatesOf(fated({ refused: 'replayed' }), refusal, again(opening.messages), request('r1c', 'a', opening.messages), next)[0], /wasn't replayed once whole \(3 request\(s\) at its step\)/, 'two replays alike');
  const headed = (r, system) => ({ ...r, head: { model: 'claude-opus-4-6', system: [{ text: system, cache: null }] } });
  assert.deepEqual(fatesOf(fated({ refused: 'replayed' }), headed(refusal, 'S'), headed(again(opening.messages), 'S'), next), []);
  assert.match(fatesOf(fated({ refused: 'replayed' }), headed(refusal, 'S'), headed(again(opening.messages), 'S2'), next)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/, 'the same messages under another system prompt');
  assert.match(fatesOf(fated({ refused: 'replayed' }), { ...headed(refusal, 'S'), stream: true }, { ...headed(again(opening.messages), 'S'), stream: false }, next)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/, 'the same request, not streamed');
  const busy = request('r1', 'a', opening.messages, { shape: 'error' });
  assert.deepEqual(fatesOf(fated({ overloaded: true }), busy, again(opening.messages), next), []);
  assert.match(fatesOf(fated({ overloaded: true }), busy, next)[0], /the 529 wasn't followed by one request carrying its turn's message \(1 request\(s\) at its step\)/);
  assert.match(fatesOf(fated({ overloaded: true }), request('r1', 'a', opening.messages), again(opening.messages), next)[0], /the 529 wasn't followed by one request carrying its turn's message \(2 request\(s\) at its step\)/, 'a first answer that was no error');
  assert.match(fatesOf(fated({ overloaded: true }), busy, again([...opening.messages, m('assistant', 'a0', text()), m('user', 'u9', text({ canaries: ['[[c:x]]'] }))]))[0], /the 529 wasn't followed by one request carrying its turn's message \(2 request\(s\) at its step\)/, 'a second request without the turn\'s message');
});

test('W13\'s property counts the failed-post rows after a turn whose fate is a refused publish, and names the bounces its setup gives in either mode', () => {
  const refused = { id: 'f', canaries: ['[[c:f.in]]'], replies: [{ text: '[[c:f.r1]]' }], fate: { continues: false, receipt: { to: ['chat'] }, sendFailed: true } };
  const r1 = request('r1', 'f', [m('user', 'u1', text({ canaries: ['[[c:f.in]]'] }))]);
  const after = (...notices) => request('r2', 'f', [m('user', 'u1', text({ canaries: ['[[c:f.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:f.r1]]'] })), m('user', 'u2', text({ delivered: { to: ['chat'], held: 0, kept: 0, transcript: 0 } }), ...notices.map((notice) => text({ notice })))]);
  assert.deepEqual(turnFates({ records: [r1, after('discord-send-failed')], log: [] }, [refused], { forks: false }), []);
  assert.equal(turnFates({ records: [r1, after('discord-send-failed')], log: [] }, [refused], { forks: false }).judged, 3, 'its receipt, its continuations and its failed post');
  assert.deepEqual(turnFates({ records: [r1, after()], log: [] }, [refused], { forks: false }).map((f) => f.message), ['0 [discord-send-failed] row(s) follow its turn, where its setup refuses its speech once']);
  assert.deepEqual(turnFates({ records: [r1, after('discord-send-failed', 'discord-send-failed')], log: [] }, [refused], { forks: false }).map((f) => f.message), ['2 [discord-send-failed] row(s) follow its turn, where its setup refuses its speech once']);
  const bounced = { ...refused, fate: { continues: false, receipt: { to: ['chat'] }, bounces: 1 } };
  assert.deepEqual(turnFates({ records: [r1, after()], log: [] }, [bounced], { forks: false }).map((f) => f.message), ['0 [prose-routing] bounce(s) follow its turn, where its setup bounces 1']);
});
