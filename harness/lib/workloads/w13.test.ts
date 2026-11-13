import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { runOf } from './workloads.ts';
import { turnFates } from './w13.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { BlockRecord, Delivered } from '../standin/view.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Call, Reply, Setup, Step } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Fate, W13Step } from './w13.ts';
import type { Facts, Run } from './workloads.ts';

type Block = DeepPartial<BlockRecord>;
type Msg = { role: string; digest?: string; blocks: Block[] };
type Answer = DeepPartial<RequestRecord['answer']>;
type Rec = { id: string; step: string; kind: 'agent'; agent?: string; seq?: number; messages: Msg[]; answer?: Answer; head?: DeepPartial<RequestRecord['head']>; stream?: boolean };
type Logged = DeepPartial<LogEntry>;

const facts = (capabilities: Facts['capabilities']) => ({ budget: 100_000, maxTokens: 16_000, capabilities });

const compiles = (...agents: string[]): Logged => ({ kind: 'compiles', lines: agents.map((agent) => ({ kind: 'request', outcome: 'compiled', agent })) });

test('Hconv brings conversations where the arm has it, with every turn on one channel, and is W13 on two channels, saying so, where it doesn\'t', () => {
  const has = runOf('Hconv/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: true }));
  assert.ok(has.configuration.recipe!.conversations && has.configuration.judges === 'fork' && !('gated' in has.configuration));
  assert.ok(!has.steps().some((s) => s.kind === 'absent'));
  assert.ok(has.steps().every((s) => s.kind !== 'channel' || s.channel === 'chat'), 'under conversations every turn is in one channel');
  const lacks = runOf('Hconv/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: false }));
  assert.ok(!lacks.configuration.recipe?.conversations && lacks.configuration.judges === undefined);
  assert.deepEqual(lacks.steps()[0], { id: `${lacks.seed}.absent.conversations`, segment: 'W13', kind: 'absent', stretch: 'conversations', canaries: [] });
  assert.ok(lacks.steps().some((s) => s.channel === 'side'), 'without it, W13 is two channels again');
  assert.throws(() => runOf('Hconv/W13', configurations(), facts({ unreadable: 'no package.json' })), /no package\.json/);
  assert.ok(runOf('Hconv/W13', configurations(), {}).configuration.recipe!.conversations, 'before an arm is read, as brought');
});

test('W13 scripts, under each setup but Hconv, and Hoff, whose fates a test of its own reads, the fate its value gives one of its steps, and under H1 the ambient message before the self-wake and a last turn', () => {
  const steps = (setup: string) => runOf(`${setup}/W13`, configurations(), facts({ suppression: true, onboarding: true, conversations: true })).steps() as W13Step[];
  const fate = (setup: string, name: string) => steps(setup).find((s) => s.id.endsWith(`.${name}`))?.fate;
  assert.deepEqual(fate('H1', 'end'), { continues: false, receipt: { to: ['chat'] } });
  assert.deepEqual(fate('Hcont', 'end'), { continues: true, receipt: { to: ['chat'] } });
  assert.deepEqual(fate('Hhyb', 'routed')!.receipt, { to: ['side', 'chat'] });
  assert.deepEqual(fate('Hexpl', 'routed'), { continues: false, receipt: null, bounces: 2 });
  assert.deepEqual(fate('Hdis', 'end')!.receipt, { to: [], transcript: true });
  assert.deepEqual(fate('Hlock', 'end')!.receipt, { to: [], held: true });
  assert.deepEqual(fate('Hlock', 'locked')!.receipt, { to: ['chat'] }, 'after the move, the lock, whichever channel woke the turn');
  assert.equal(fate('Hpriv', 'think')!.receipt, null);
  assert.deepEqual(fate('Hlatest', 'skip.wake')!.receipt, { to: ['w13-quiet'] });
  assert.equal(fate('H1', 'skip.wake')!.undeliverable, true);
  assert.equal(fate('Hfold', 'wrapper')!.wrapper, 'contained');
  assert.equal(fate('Hfold', 'refuse')!.refused, 'replayed');
  assert.equal(fate('H1', 'refuse')!.refused, 'ended');
  assert.equal(fate('Hretry', 'overloaded')!.overloaded, true);
  assert.equal(fate('H1', 'overloaded'), undefined, 'the 529 under the default is H1/W11\'s');
  assert.equal(fate('H1', 'stall')!.stall, 'cut');
  assert.equal(fate('Hretry', 'stall')!.stall, 'cut');
  assert.equal(fate('Hfold', 'stall')!.stall, 'waited', 'the folded setup turns the inference bounds off');
  const stall = (setup: string) => steps(setup).find((s) => s.id.endsWith('.stall'));
  assert.deepEqual(stall('H1')!.replies![0], { hold: true, cut: true, during: [{ advance: 60_000, cut: true }] }, 'the held reply the bound cuts is never sent');
  assert.equal(stall('H1')!.replies!.length, 2);
  assert.equal(stall('H1')!.retries, true);
  assert.deepEqual(stall('Hfold')!.replies!.map((r) => [r.hold, r.during]), [[true, [{ advance: 60_000 }]]], 'with no bounds, the advance cuts nothing and the held reply is sent');
  const order = steps('H1').map((s) => s.id.split('.').slice(1).join('.'));
  assert.ok(order.indexOf('skip') < order.indexOf('ambient') && order.indexOf('ambient') < order.indexOf('skip.wake'), 'the ambient message is the latest inbound when the self-wake comes');
  assert.equal(order.at(-1), 'last');
});

test('Hlatest pushes from a closed channel and re-pins to an inbound-only one, and explicit and hybrid bounce a console turn, each with the fate main gives it; no other setup gets these steps or the push, and none but H5 declares channel kinds', () => {
  const all = configurations();
  const job = (setup: string) => runOf(`${setup}/W13`, all, facts({ suppression: true, onboarding: true, conversations: true }));
  const step = (setup: string, name: string) => (job(setup).steps() as W13Step[]).find((s) => s.id.endsWith(`.${name}`));
  assert.equal(all.Hlatest.fixturePush, true);
  assert.deepEqual(all.Hlatest.fixtureChannels, { 'w13-push': { initiallyOpen: false }, 'w13-feed': { direction: 'inbound' } });
  assert.deepEqual(all.H5.fixtureChannels, { 'w12-pair-in': { direction: 'inbound' } }, 'H5 declares the inbound-only channel W12 uses there');
  for (const [name, c] of Object.entries(all)) if (name !== 'Hlatest') assert.ok(!c.fixturePush && (name === 'H5' || !c.fixtureChannels), `${name} gives no push and declares no channel kinds`);
  const push = step('Hlatest', 'push');
  assert.deepEqual([push!.kind, push!.channel, push!.tags], ['push', 'w13-push', ['chat:addressed']]);
  assert.match(push!.text!, /^\[\[c:\d+\.push\.in\]\] /);
  assert.deepEqual(push!.replies, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }]);
  assert.deepEqual(push!.fate, { continues: false, receipt: null });
  const woke = step('Hlatest', 'push.wake');
  assert.deepEqual([woke!.kind, woke!.ms, woke!.fate!.receipt], ['advance', 121_000, { to: ['w13-quiet'] }], 'the latest delivered channel message is the ambient one, since main counts no push');
  const repin = step('Hlatest', 'repin');
  assert.equal(repin!.channel, 'chat');
  assert.equal(repin!.replies![0].hold, true);
  assert.deepEqual(repin!.replies![0].during!.map((a) => [a.deliver!.channel, a.deliver!.tags]), [['w13-feed', ['chat:addressed']]]);
  assert.match(repin!.replies![1].text!, /^\[\[c:\d+\.repin\.r2\]\] /, 'the turn speaks after the re-pin');
  assert.deepEqual(repin!.spare, [{ calls: [{ name: 'skip_reply', input: {} }] }], 'the feed message\'s own wake');
  assert.equal(repin!.failsPublish, true);
  assert.deepEqual(repin!.fate, { continues: false, receipt: { to: ['chat'] }, sendFailed: true });
  const order = job('Hlatest').steps().map((s) => s.id.split('.').slice(1).join('.'));
  assert.ok(order.indexOf('skip.wake') < order.indexOf('push') && order.indexOf('push') + 1 === order.indexOf('push.wake') && order.indexOf('push.wake') < order.indexOf('repin') && order.at(-1) === 'last');
  const con = (setup: string) => step(setup, 'con');
  assert.equal(con('Hexpl')!.kind, 'console');
  assert.match(con('Hexpl')!.replies![0].text!, /^\[\[c:\d+\.con\.r1\]\] /, 'no prefix under explicit');
  assert.match(con('Hhyb')!.replies![0].text!, /^>>>#w13-nowhere \[\[c:\d+\.con\.r1\]\] /, 'an envelope naming no channel under hybrid');
  assert.deepEqual(con('Hexpl')!.fate, { continues: false, receipt: null, bounces: 1 });
  assert.deepEqual(con('Hhyb')!.fate, { continues: false, receipt: { to: [], held: true }, bounces: 1 });
  for (const setup of ['Hexpl', 'Hhyb']) {
    assert.equal(con(setup)!.drafts, 'bounced');
    assert.deepEqual(con(setup)!.spare, [{ calls: [{ name: 'skip_reply', input: {} }] }], 'a bounce-wake\'s turn');
  }
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hexpl', 'Hhyb', 'Hoff']) {
    assert.ok(!job(setup).steps().some((s) => /\.(push|push\.wake|repin)$/.test(s.id)), `${setup} has no push or re-pin`);
  }
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hlatest', 'Hoff']) {
    assert.ok(!job(setup).steps().some((s) => /\.con$/.test(s.id)), `${setup} has no bounced console turn`);
  }
});

test('W13\'s recipe, under every setup but Hoff, whose gate is off, debounces 30 s after its w13-quiet rule the push events whose text holds [[held-push]], which only Hlatest\'s held pushes carry', () => {
  const all = configurations();
  const held = { name: 'w13-held-push', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: '[[held-push]]' } }, behavior: { debounce: 30_000 } };
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hexpl', 'Hhyb', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hlatest', 'Hoff']) {
    const run = runOf(`${setup}/W13`, all, facts({ suppression: true, onboarding: true, conversations: true }));
    if (setup === 'Hoff') assert.equal(run.configuration.modules!.wake, false, 'with the gate off, no rule applies');
    else assert.deepEqual((run.configuration.modules!.wake as { policies: unknown[] }).policies, [{ name: 'w13-quiet', match: { channel: '*w13-quiet' }, behavior: 'defer' }, held], setup);
    for (const s of run.steps()) {
      const name = s.id.slice(s.id.indexOf('.') + 1);
      assert.equal(JSON.stringify(s).includes('[[held-push]]'), setup === 'Hlatest' && (name === 'held' || name === 'held.wake'), `${setup}'s ${s.id}`);
    }
  }
});

test('Hlatest pushes on w13-push, as an unopened channel\'s ambient message, what its held-push rule holds: the first batch\'s turn holds its call while a second such push arrives, and reads it, and the step past the second push\'s window leaves its turn to the host; no other setup gets these steps', () => {
  const all = configurations();
  const job = (setup: string) => runOf(`${setup}/W13`, all, facts({ suppression: true, onboarding: true, conversations: true }));
  const steps = job('Hlatest').steps() as W13Step[];
  const step = (name: string) => steps.find((s) => s.id.slice(s.id.indexOf('.') + 1) === name);
  const ambient = ['chat:ambient', 'chat:from-human'];
  const skip = [{ calls: [{ name: 'skip_reply', input: {} }] }];
  const held = step('held');
  assert.deepEqual([held!.kind, held!.channel, held!.tags], ['push', 'w13-push', ambient]);
  assert.match(held!.text!, /^\[\[c:\d+\.held\.in\]\] \[\[held-push\]\] \S/);
  assert.equal(held!.replies, undefined, 'the rule holds it, so no turn comes at its step');
  assert.deepEqual(held!.spare, skip, 'a turn the rule failed to hold is answered, and flagged by its fate');
  assert.match(held!.fate!.none!, /held-push rule holds it/);
  assert.deepEqual(Object.keys(held!.fate!), ['none']);
  const wake = step('held.wake');
  const window = (job('Hlatest').configuration.modules!.wake as { policies: Array<{ name: string; behavior: { debounce?: number } }> }).policies.find((p) => p.name === 'w13-held-push')!.behavior.debounce;
  assert.deepEqual([wake!.kind, wake!.addressed, wake!.namedAnywhere], ['advance', false, true]);
  assert.ok(wake!.ms! > window!, 'the clock passes the first push\'s window');
  assert.equal(wake!.replies!.length, 2);
  const [first, second] = wake!.replies!;
  assert.equal(first.hold, true);
  assert.deepEqual((first.calls as Call[]).map((c) => c.name), ['mcpl--fixture--result']);
  const call = (first.calls as Call[])[0].input!.canary;
  assert.match(call!, /^\[\[c:\d+\.held\.wake\.call1\]\]$/);
  assert.equal(first.during!.length, 1, 'one act, and no clock move inside the hold');
  const { push } = first.during![0];
  assert.deepEqual([push!.channel, push!.tags], ['w13-push', ambient]);
  assert.match(push!.text, /^\[\[c:\d+\.held\.wake\.push\.in\]\] \[\[held-push\]\] \S/);
  assert.equal(typeof push!.id, 'string');
  assert.notEqual(push!.id, held!.id);
  const again = push!.text.split(' ')[0];
  assert.deepEqual(second, skip[0], 'the round that reads the second push ends the turn unspoken');
  assert.deepEqual(wake!.fate, { continues: false, receipt: null });
  assert.deepEqual([...wake!.canaries!].sort(), [held!.text!.split(' ')[0], again, call].sort());
  assert.deepEqual(wake!.arrivals, [{ canary: again, point: 'boundary', after: call, push: true, message: push!.id }], 'the second push is first carried by the request after the held reply\'s call');
  const last = step('held.again');
  assert.deepEqual([last!.kind, last!.addressed, last!.namedAnywhere, last!.canaries], ['advance', false, true, [again]]);
  assert.ok(last!.ms! > window!, 'the clock passes the second push\'s window');
  assert.equal(last!.replies, undefined);
  assert.deepEqual(last!.spare, skip, 'a turn at #972\'s base, none after it');
  assert.equal(last!.fate, undefined);
  const order = steps.map((s) => s.id.split('.').slice(1).join('.'));
  const at = order.indexOf('held');
  assert.ok(order.indexOf('repin') >= 0 && order.indexOf('repin') < at && order[at + 1] === 'held.wake' && order[at + 2] === 'held.again' && order[at + 3] === 'last', order.join(' '));
  assert.ok(!step('push')!.text!.includes('[[held-push]]'), 'the addressed push keeps its fate');
  for (const setup of ['H1', 'Hcont', 'Hconv', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hexpl', 'Hhyb', 'Hoff']) {
    assert.ok(!job(setup).steps().some((s) => /\.held(\.wake|\.again)?$/.test(s.id)), `${setup} has no held push`);
  }
});

test('W13\'s check judges the held push\'s arrival: the push the hold sent and the host stored before the release is first carried by the request after the held reply\'s call, after the call\'s result; one carried later, or stored on another lane, is flagged', () => {
  const job = runOf('Hlatest/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: true }));
  const steps = job.steps();
  const wake = steps.find((s) => s.id.endsWith('.held.wake'));
  const again = steps.find((s) => s.id.endsWith('.held.again'));
  const [{ canary, after, message }] = wake!.arrivals!;
  const first = wake!.canaries!.find((c) => c.endsWith('.held.in]]'));
  const block = (c: string): Block => ({ type: 'text', chars: 10, canaries: [c] });
  const agent = (id: string, step: Step, ...messages: Msg[]): Rec => ({ id, seq: Number(id.slice(1)), kind: 'agent', agent: 'primary', step: step.id, messages });
  const r1 = agent('r1', wake!, { role: 'user', blocks: [block(first!)] });
  const carried = agent('r2', wake!, { role: 'user', blocks: [block(first!)] }, { role: 'assistant', blocks: [block(after)] }, { role: 'user', blocks: [block(after), block(canary)] });
  const bare = agent('r2', wake!, { role: 'user', blocks: [block(first!)] }, { role: 'assistant', blocks: [block(after)] }, { role: 'user', blocks: [block(after)] });
  const late = agent('r3', again!, ...bare.messages, { role: 'user', blocks: [block(canary)] });
  const log = (source: string): Logged[] => [
    { kind: 'send', via: 'push', during: 'r1', eventId: message, step: wake!.id },
    { kind: 'ipc', step: wake!.id, event: { type: 'message:added', source } },
    { kind: 'send', via: 'release', request: 'r1', step: wake!.id },
  ];
  const said = (records: Rec[], source = 'mcpl:push-event') => job.check({ records, log: log(source) } satisfies DeepPartial<Run> as unknown as Run).filter((f) => f.step === wake!.id && f.message.includes(canary)).map((f) => f.message);
  assert.deepEqual(said([r1, carried]), []);
  assert.deepEqual(said([r1, bare, late]), [`${canary} is first carried by request r3, where its point gives request r2, the request after its boundary, the first to carry ${after}`]);
  assert.deepEqual(said([r1, carried], 'mcpl:channel-incoming'), [`couldn't judge ${canary}: it wasn't stored before its hold's release`]);
});

const request = (id: string, step: string, messages: Msg[], answer: Answer = { stop: 'end_turn' }): Rec => ({ id, step, kind: 'agent', agent: 'primary', messages, answer });

const m = (role: string, digest: string, ...blocks: Block[]): Msg => ({ role, digest, blocks });

const text = (more: Block = {}): Block => ({ type: 'text', chars: 10, ...more });

test('W13\'s property reads a turn\'s receipt from what the requests after it add, and fails it where it lands elsewhere', () => {
  const steps = [{ id: 'a', canaries: ['[[c:a.in]]'], replies: [{ text: '[[c:a.r1]]' }], fate: { continues: false, receipt: { to: ['chat'] } } }, { id: 'b', canaries: ['[[c:b.in]]'], replies: [{ text: '[[c:b.r1]]' }] }];
  const first = request('r1', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'], cache: '1h' }))]);
  const landed = (to: string[]) => request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] })), m('assistant', 'a1', text({ canaries: ['[[c:a.r1]]'] })), m('user', 'u2', text({ delivered: { to, held: 0, kept: 0, transcript: 0 } }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [first, landed(['chat'])], log: [] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false }), []);
  assert.equal(turnFates({ records: [first, landed(['chat'])], log: [] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false }).judged, 2);
  assert.match(turnFates({ records: [first, landed(['side'])], log: [] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false })[0].message, /landed in side, where its setup lands it in chat/);
  const rewritten = request('r2', 'b', [m('user', 'other', text()), m('assistant', 'a1', text())]);
  assert.match(turnFates({ records: [first, rewritten], log: [] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false })[0].message, /couldn't judge its turn's fate: request r2 doesn't carry the window/);
});

test('W13\'s property counts a turn\'s continuations, and a contained wrapper\'s row in place of its reply', () => {
  const wrap = { id: 'w', canaries: ['[[c:w.in]]'], replies: [{ text: '<t>[[c:w.r1]]</t>' }], ends: 'contained', fate: { continues: false, wrapper: 'contained' } };
  const next = { id: 'n', canaries: ['[[c:n.in]]'], replies: [{ text: '[[c:n.r1]]' }] };
  const r1 = request('r1', 'w', [m('user', 'u1', text({ canaries: ['[[c:w.in]]'], cache: '1h' }))]);
  const joined = request('r2', 'n', [m('user', 'u1x', text({ canaries: ['[[c:w.in]]'] }), text({ notice: 'tool-boundary' }), text({ canaries: ['[[c:n.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [r1, joined], log: [] } satisfies DeepPartial<Run> as unknown as Run, [wrap, next], { forks: false }), [], 'the row joins the user message before it');
  const kept = request('r2', 'n', [m('user', 'u1x', text({ canaries: ['[[c:w.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:w.r1]]'] })), m('user', 'u2', text({ canaries: ['[[c:n.in]]'] }))]);
  assert.deepEqual(turnFates({ records: [r1, kept], log: [] } satisfies DeepPartial<Run> as unknown as Run, [wrap, next], { forks: false }).map((f) => f.message), ['request r2 carries the wrapper the guard contains, [[c:w.r1]]', 'no [tool-boundary] row follows the contained wrapper']);
  const cont = { id: 'c', canaries: ['[[c:c.in]]'], replies: [{ text: '[[c:c.r1]]' }, { calls: [] }], fate: { continues: true } };
  const c1 = request('r1', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] }))]);
  const c2 = request('r2', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:c.r1]]'] })), m('user', 'u2', text({ notice: 'continue' }))]);
  assert.deepEqual(turnFates({ records: [c1, c2], log: [] } satisfies DeepPartial<Run> as unknown as Run, [cont], { forks: false }), []);
  const c2none = request('r2', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:c.r1]]'] }))]);
  assert.match(turnFates({ records: [c1, c2none], log: [] } satisfies DeepPartial<Run> as unknown as Run, [cont], { forks: false })[0].message, /0 continuation\(s\) followed its turn/);
  const routedFirst = request('r1', 'c', [m('user', 'u1', text({ canaries: ['[[c:c.in]]'] }), text({ notice: 'routing' }))]);
  assert.deepEqual(turnFates({ records: [routedFirst, c2], log: [] } satisfies DeepPartial<Run> as unknown as Run, [], { forks: false, unrouted: true }).map((f) => f.message), ['request r1 carries a [routing] row, where disabled routing writes none'], 'the run\'s first request too, which no step\'s later rows hold');
  assert.deepEqual(turnFates({ records: [c1, c2], log: [] } satisfies DeepPartial<Run> as unknown as Run, [], { forks: false, unrouted: true }), []);
  assert.equal(turnFates({ records: [c1, c2], log: [] } satisfies DeepPartial<Run> as unknown as Run, [], { forks: false, unrouted: true }).judged, 1);
  assert.match(turnFates({ records: [], log: [compiles('fixture')] } satisfies DeepPartial<Run> as unknown as Run, [], { forks: true })[0].message, /made by fixture, not by one fork of conversations/);
});

const fated = (fate: Fate, more: Partial<W13Step> = {}): W13Step[] => [{ id: 'a', canaries: ['[[c:a.in]]'], replies: [{ text: '[[c:a.r1]]' }], fate, ...more }, { id: 'b', canaries: ['[[c:b.in]]'], replies: [{ text: '[[c:b.r1]]' }] }];

const opening = request('r1', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'], cache: '1h' }))]);

const after = (...rows: Block[]) => request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] })), m('assistant', 'a1', text({ canaries: ['[[c:a.r1]]'] })), m('user', 'u2', ...rows, text({ canaries: ['[[c:b.in]]'] }))]);

const receipt = (to: string[], more: Partial<Delivered> = {}) => text({ delivered: { to, held: 0, kept: 0, transcript: 0, ...more } });

const fatesOf = (steps: W13Step[], ...records: Rec[]) => turnFates({ records, log: [] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false }).map((f) => f.message);

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
  const wrapper = (fate: Fate) => fated(fate, { replies: [{ text: '<t>[[c:a.r1]]</t>' }] });
  assert.deepEqual(fatesOf(wrapper({ wrapper: 'kept' }), opening, after()), []);
  const dropped = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.match(fatesOf(wrapper({ wrapper: 'kept' }), opening, dropped)[0], /the wrapper \[\[c:a\.r1\]\] isn't in the history after its turn/);
});

test('W13\'s property holds a refusal to ending its turn, or to one whole replay, and an overloaded error to one more request with its turn\'s message', () => {
  const refusal = request('r1', 'a', opening.messages, { stop: 'refusal' });
  const again = (messages: Msg[]) => request('r1b', 'a', messages);
  const next = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(fatesOf(fated({ refused: 'ended', receipt: null }), refusal, next), []);
  assert.match(fatesOf(fated({ refused: 'ended', receipt: null }), refusal, again(opening.messages), next)[0], /followed by 1 more at its step, where nothing retries/);
  assert.match(fatesOf(fated({ refused: 'ended', receipt: null }), opening, next)[0], /^0 of the step's 1 request\(s\) were refused/);
  assert.deepEqual(fatesOf(fated({ refused: 'replayed' }), refusal, again(opening.messages), next), []);
  const unlike = [m('user', 'u1y', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }))];
  const nextUnlike = request('r2', 'b', [m('user', 'u1z', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.match(fatesOf(fated({ refused: 'replayed' }), refusal, again(unlike), nextUnlike)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/);
  assert.match(fatesOf(fated({ refused: 'replayed' }), refusal, again(opening.messages), request('r1c', 'a', opening.messages), next)[0], /wasn't replayed once whole \(3 request\(s\) at its step\)/, 'two replays alike');
  const headed = (r: Rec, system: string): Rec => ({ ...r, head: { model: 'claude-opus-4-6', system: [{ text: system, cache: null }] } });
  assert.deepEqual(fatesOf(fated({ refused: 'replayed' }), headed(refusal, 'S'), headed(again(opening.messages), 'S'), next), []);
  assert.match(fatesOf(fated({ refused: 'replayed' }), headed(refusal, 'S'), headed(again(opening.messages), 'S2'), next)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/, 'the same messages under another system prompt');
  assert.match(fatesOf(fated({ refused: 'replayed' }), { ...headed(refusal, 'S'), stream: true }, { ...headed(again(opening.messages), 'S'), stream: false }, next)[0], /wasn't replayed once whole \(2 request\(s\) at its step\)/, 'the same request, not streamed');
  const busy = request('r1', 'a', opening.messages, { shape: 'error' });
  assert.deepEqual(fatesOf(fated({ overloaded: true }), busy, again(opening.messages), next), []);
  assert.match(fatesOf(fated({ overloaded: true }), busy, next)[0], /the 529 wasn't followed by one request carrying its turn's message \(1 request\(s\) at its step\)/);
  assert.match(fatesOf(fated({ overloaded: true }), request('r1', 'a', opening.messages), again(opening.messages), next)[0], /the 529 wasn't followed by one request carrying its turn's message \(2 request\(s\) at its step\)/, 'a first answer that was no error');
  assert.match(fatesOf(fated({ overloaded: true }), busy, again([...opening.messages, m('assistant', 'a0', text()), m('user', 'u9', text({ canaries: ['[[c:x]]'] }))]))[0], /the 529 wasn't followed by one request carrying its turn's message \(2 request\(s\) at its step\)/, 'a second request without the turn\'s message');
});

test('W13\'s property holds a refusal that meets either fate to the one its run shows: ended with no receipt, or replayed once whole with its receipt', () => {
  const refusal = request('r1', 'a', opening.messages, { stop: 'refusal' });
  const again = (messages: Msg[]) => request('r1b', 'a', messages);
  const either = fated({ refused: 'either', replayedReceipt: { to: ['side'] } });
  const delivered = text({ delivered: { to: ['side'], held: 0, kept: 0, transcript: 0 } });
  const next = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(fatesOf(either, refusal, next), [], 'ended, with no receipt');
  assert.match(fatesOf(either, refusal, after(delivered))[0], /its turn wrote a \[delivered\] receipt \(to side\), where its setup writes none/, 'ended, with a receipt');
  assert.deepEqual(fatesOf(either, refusal, again(opening.messages), after(delivered)), [], 'replayed whole, with its receipt');
  assert.match(fatesOf(either, refusal, again(opening.messages), after())[0], /no \[delivered\] receipt follows its turn/, 'replayed, with no receipt');
  assert.match(fatesOf(either, refusal, again(opening.messages), request('r1c', 'a', opening.messages), after(delivered))[0], /wasn't replayed once whole \(3 request\(s\) at its step\)/);
  assert.match(fatesOf(either, opening, next)[0], /^0 of the step's 1 request\(s\) were refused/);
});

test('W13\'s property counts the failed-post rows after a turn whose fate is a refused publish, and names the bounces its setup gives in either mode', () => {
  const refused = { id: 'f', canaries: ['[[c:f.in]]'], replies: [{ text: '[[c:f.r1]]' }], fate: { continues: false, receipt: { to: ['chat'] }, sendFailed: true } };
  const r1 = request('r1', 'f', [m('user', 'u1', text({ canaries: ['[[c:f.in]]'] }))]);
  const after = (...notices: string[]) => request('r2', 'f', [m('user', 'u1', text({ canaries: ['[[c:f.in]]'] })), m('assistant', 'a', text({ canaries: ['[[c:f.r1]]'] })), m('user', 'u2', text({ delivered: { to: ['chat'], held: 0, kept: 0, transcript: 0 } }), ...notices.map((notice) => text({ notice })))]);
  assert.deepEqual(turnFates({ records: [r1, after('discord-send-failed')], log: [] } satisfies DeepPartial<Run> as unknown as Run, [refused], { forks: false }), []);
  assert.equal(turnFates({ records: [r1, after('discord-send-failed')], log: [] } satisfies DeepPartial<Run> as unknown as Run, [refused], { forks: false }).judged, 3, 'its receipt, its continuations and its failed post');
  assert.deepEqual(turnFates({ records: [r1, after()], log: [] } satisfies DeepPartial<Run> as unknown as Run, [refused], { forks: false }).map((f) => f.message), ['0 [discord-send-failed] row(s) follow its turn, where its setup refuses its speech once']);
  assert.deepEqual(turnFates({ records: [r1, after('discord-send-failed', 'discord-send-failed')], log: [] } satisfies DeepPartial<Run> as unknown as Run, [refused], { forks: false }).map((f) => f.message), ['2 [discord-send-failed] row(s) follow its turn, where its setup refuses its speech once']);
  const bounced = { ...refused, fate: { continues: false, receipt: { to: ['chat'] }, bounces: 1 } };
  assert.deepEqual(turnFates({ records: [r1, after()], log: [] } satisfies DeepPartial<Run> as unknown as Run, [bounced], { forks: false }).map((f) => f.message), ['0 [prose-routing] bounce(s) follow its turn, where its setup bounces 1']);
});

test('under H1 alone, W13\'s stall.failed follows its stall: two held replies the bound cuts, a step that may fail, whose fate is a failed stall with no receipt', () => {
  const steps = (setup: string) => runOf(`${setup}/W13`, configurations(), facts({ suppression: true, onboarding: true, conversations: true })).steps() as W13Step[];
  const names = (setup: string) => steps(setup).map((s) => s.id.split('.').slice(1).join('.'));
  const failed = steps('H1').find((s) => s.id.endsWith('.stall.failed'));
  assert.equal(names('H1').indexOf('stall.failed'), names('H1').indexOf('stall') + 1);
  const cutByBound = (cut?: true | 'ends'): Reply => ({ hold: true, cut: true, during: [{ advance: 60_000, cut }] });
  assert.deepEqual(failed!.replies, [cutByBound(true), cutByBound('ends')], 'the call and its fresh call, each held until the bound cuts it, the second cut ending the turn');
  assert.deepEqual([failed!.mayFail, failed!.retries, failed!.channel], [true, true, 'chat']);
  assert.deepEqual(failed!.fate, { continues: false, stall: 'failed', receipt: null });
  for (const setup of ['Hoff', 'Hcont', 'Hlatest', 'Hconv', 'Hexpl', 'Hhyb', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold']) assert.ok(!names(setup).includes('stall.failed'), setup);
});

test('W13\'s property holds a failed stall to two cut calls with the same messages, and the request after it to an [inference-failed] note naming the bound\'s host setting', () => {
  const cut = (id: string, messages: Msg[]) => request(id, 'a', messages, { shape: 'cut' });
  const noted = (setting: string | null) => request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ inferenceFailed: { setting } }), text({ canaries: ['[[c:b.in]]'] }))]);
  const bound = 'inferenceBounds.progressBounds.beforeContentMs';
  const failedFate = fated({ stall: 'failed', receipt: null }, { mayFail: true });
  assert.deepEqual(fatesOf(failedFate, cut('r1', opening.messages), cut('r1b', opening.messages), noted(bound)), []);
  assert.match(fatesOf(failedFate, cut('r1', opening.messages), noted(bound))[0], /weren't both cut with the same messages \(1 of the step's 1 request\(s\) cut\)/, 'no fresh call');
  assert.match(fatesOf(failedFate, cut('r1', opening.messages), request('r1b', 'a', opening.messages, { shape: 'reply' }), noted(bound))[0], /\(1 of the step's 2 request\(s\) cut\)/, 'the fresh call answered');
  const other = [m('user', 'u1y', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }))];
  const notedAfterOther = request('r2', 'b', [m('user', 'u1z', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }), text({ inferenceFailed: { setting: bound } }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.match(fatesOf(failedFate, cut('r1', opening.messages), cut('r1b', other), notedAfterOther)[0], /weren't both cut with the same messages \(2 of the step's 2 request\(s\) cut\)/, 'a fresh call with other messages');
  const plain = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(fatesOf(failedFate, cut('r1', opening.messages), cut('r1b', opening.messages), plain), ['no [inference-failed] note follows its turn, up to request r2, where the bound cut its call and the fresh call']);
  assert.deepEqual(fatesOf(failedFate, cut('r1', opening.messages), cut('r1b', opening.messages), noted(null)), [`its turn's [inference-failed] note names no host setting as its reason, where the bound that cut it is ${bound}`]);
  assert.deepEqual(fatesOf(failedFate, cut('r1', opening.messages), cut('r1b', opening.messages)), ['couldn\'t judge its turn\'s fate: no request follows it']);
});

test('W13\'s property holds a stall to one cut call sent again with the same messages, or, with no bounds, to its own reply', () => {
  const cut = request('r1', 'a', opening.messages, { shape: 'cut' });
  const fresh = (messages: Msg[]) => request('r1b', 'a', messages, { shape: 'reply' });
  const next = request('r2', 'b', [m('user', 'u1x', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:b.in]]'] }))]);
  assert.deepEqual(fatesOf(fated({ stall: 'cut' }), cut, fresh(opening.messages), next), []);
  assert.deepEqual(fatesOf(fated({ stall: 'cut' }), cut, fresh(opening.messages), request('r1c', 'a', opening.messages, { shape: 'reply' }), next), [], 'a continuation after the fresh call is the continuation\'s to judge');
  assert.match(fatesOf(fated({ stall: 'cut' }), cut, next)[0], /wasn't cut and sent again once with the same messages \(1 of the step's 1 request\(s\) cut, the first cut\)/, 'no fresh call');
  assert.match(fatesOf(fated({ stall: 'cut' }), fresh(opening.messages), next)[0], /\(0 of the step's 1 request\(s\) cut, the first reply\)/, 'nothing cut');
  assert.match(fatesOf(fated({ stall: 'cut' }), cut, request('r1b', 'a', opening.messages, { shape: 'cut' }), fresh(opening.messages), next)[0], /\(2 of the step's 3 request\(s\) cut, the first cut\)/, 'cut twice');
  const other = [m('user', 'u1y', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }))];
  assert.match(fatesOf(fated({ stall: 'cut' }), cut, fresh(other), request('r2', 'b', [m('user', 'u1z', text({ canaries: ['[[c:a.in]]'] }), text({ canaries: ['[[c:x]]'] }), text({ canaries: ['[[c:b.in]]'] }))]))[0], /wasn't cut and sent again once with the same messages/, 'a fresh call with other messages');
  assert.match(fatesOf(fated({ stall: 'cut' }), fresh(opening.messages), cut, next)[0], /\(1 of the step's 2 request\(s\) cut, the first reply\)/, 'a cut that isn\'t the first');
  assert.deepEqual(fatesOf(fated({ stall: 'waited' }), fresh(opening.messages), next), []);
  assert.match(fatesOf(fated({ stall: 'waited' }), fresh(opening.messages), cut, next)[0], /^1 of the step's 2 request\(s\) were cut, the first reply/, 'a later cut');
  assert.match(fatesOf(fated({ stall: 'waited' }), request('r1', 'a', opening.messages, { shape: 'error' }), next)[0], /^0 of the step's 1 request\(s\) were cut, the first error/, 'a first answer that wasn\'t its reply');
  assert.match(fatesOf(fated({ stall: 'waited' }), cut, fresh(opening.messages), next)[0], /^1 of the step's 2 request\(s\) were cut, the first cut, where with no inference bounds nothing cuts/);
});

test('a module a setup turns off stays off whatever its workload\'s recipe brings, so Hoff runs W13 with no wake gate, workspace, channel mode or subscription-gc', () => {
  const run = runOf('Hoff/W13', configurations(), facts({ suppression: true, onboarding: true, conversations: true }));
  assert.deepEqual(['wake', 'workspace', 'channelMode', 'subscriptionGc'].map((k) => run.configuration.modules![k]), [false, false, false, false]);
  const own = runOf('X/W13', { X: { name: 'X', agent: { model: 'claude-opus-4-6' }, modules: { wake: false, lessons: true } } } satisfies Record<string, DeepPartial<Setup>> as unknown as Record<string, Setup>, facts({}));
  assert.deepEqual([own.configuration.modules!.wake, own.configuration.modules!.lessons], [false, true], 'W13\'s recipe names wake rules, and the setup\'s false wins; a module it leaves on is left as the setup says');
  assert.notEqual(runOf('H1/W13', configurations(), facts({ conversations: true })).configuration.modules!.wake, false);
});

test('W13 under Hoff scripts the fates no gate gives: skip_reply\'s wake_in_seconds refused and the turn ended by its next call, the ambient message waking the agent, and no self-wake', () => {
  const steps = (setup: string) => runOf(`${setup}/W13`, configurations(), facts({ suppression: true, onboarding: true, conversations: true })).steps() as W13Step[];
  const at = (setup: string, name: string) => steps(setup).find((s) => s.id.endsWith(`.${name}`));
  assert.deepEqual(at('Hoff', 'skip')!.fate, { continues: false, receipt: null, wakeRefused: true });
  assert.deepEqual(at('Hoff', 'skip')!.replies!.map((r) => (r.calls as Call[])[0].input), [{ wake_in_seconds: 120 }, {}]);
  assert.deepEqual(at('Hoff', 'ambient')!.fate, { continues: false, receipt: { to: ['w13-quiet'] } });
  assert.match(at('Hoff', 'skip.wake')!.fate!.none!, /no self-wake/);
  assert.equal(at('Hoff', 'skip.wake')!.replies, undefined);
  assert.deepEqual(at('H1', 'skip')!.fate, { continues: false, receipt: null }, 'under a gate the wake is set and the turn ends at once');
  assert.equal(at('H1', 'ambient')!.fate, undefined);
  assert.equal(at('H1', 'skip.wake')!.fate!.undeliverable, true);
});

test('W13\'s property holds a step whose fate is no turn to no request at it, and a refused wake to skip_reply\'s refusal at its step and one more request there', () => {
  const steps = [{ id: 'a', canaries: ['[[c:a.in]]'], fate: { receipt: null, wakeRefused: true } }, { id: 'n', canaries: [], fate: { none: 'nothing wakes it' } }, { id: 'b', canaries: ['[[c:b.in]]'] }];
  const first = request('r1', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'] }))]);
  const second = request('r2', 'a', [m('user', 'u1', text({ canaries: ['[[c:a.in]]'] })), m('assistant', 'a1', text()), m('user', 'u2', { type: 'tool_result', chars: 10 })]);
  const next = request('r3', 'b', [...second.messages, m('assistant', 'a2', text()), m('user', 'u3', text({ canaries: ['[[c:b.in]]'] }))]);
  const refused = { kind: 'ipc', step: 'a', event: { type: 'tool:failed', tool: 'skip_reply', error: 'Your turn didn\'t end, and no wake was set: this host can\'t wake you on a timer, so skip_reply can\'t take wake_in_seconds here.' } } satisfies Logged;
  const of = (log: Logged[], ...records: Rec[]) => turnFates({ records, log } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false }).map((f) => f.message);
  assert.deepEqual(of([refused], first, second, next), []);
  assert.deepEqual(of([], first, second, next), ['no skip_reply call was refused and 2 request(s) came at its step, where with no gate skip_reply\'s wake_in_seconds is refused, the turn goes on, and its next call ends it']);
  assert.deepEqual(of([{ ...refused, event: { ...refused.event, error: 'skip_reply failed: the store is read-only' } }], first, second, next), ['no skip_reply call was refused and 2 request(s) came at its step, where with no gate skip_reply\'s wake_in_seconds is refused, the turn goes on, and its next call ends it'], 'another failure of skip_reply isn\'t the refusal of its wake');
  assert.deepEqual(of([refused], first, next), ['skip_reply was refused and 1 request(s) came at its step, where with no gate skip_reply\'s wake_in_seconds is refused, the turn goes on, and its next call ends it']);
  assert.deepEqual(of([refused], first, second, request('rx', 'n', next.messages), next), ['request rx came at this step, where nothing wakes it']);
  assert.equal(turnFates({ records: [first, second, next], log: [refused] } satisfies DeepPartial<Run> as unknown as Run, steps, { forks: false }).judged, 2 + 1, 'the receipt, the refused wake and the step with no turn');
});

test('under autoContinue, W13 sends to its turn\'s own channel and then speaks, so the closing words are held for the send and the continuation\'s row is the held form; no other setup has the step', () => {
  const steps = (setup: string) => runOf(`${setup}/W13`, configurations(), facts({ suppression: true, onboarding: true, conversations: true })).steps() as W13Step[];
  const names = (setup: string) => steps(setup).map((s) => s.id.split('.').slice(1).join('.'));
  assert.equal(names('Hcont')[names('Hcont').indexOf('end') + 1], 'sent');
  for (const setup of ['H1', 'Hlatest', 'Hconv', 'Hexpl', 'Hhyb', 'Hdis', 'Hlock', 'Hpriv', 'Hretry', 'Hfold', 'Hoff']) assert.ok(!names(setup).includes('sent'), setup);
  const sent = steps('Hcont').find((s) => s.id.endsWith('.sent'));
  assert.deepEqual([sent!.channel, sent!.drafts, sent!.namedAnywhere], ['chat', 'explicit-send', true], 'the hold is for the turn\'s explicit send, which check 1 then doesn\'t flag');
  assert.deepEqual(sent!.fate, { continues: true, receipt: { to: [], held: true } });
  assert.equal(sent!.replies!.length, 3);
  const [send, closing, continued] = sent!.replies!;
  assert.match(send.text!, /^\[\[c:\d+\.sent\.r1\]\] /);
  assert.deepEqual((send.calls as Call[]).map((c) => [c.name, c.input!.channelId]), [['channel_publish', 'chat']]);
  assert.match((send.calls as Call[])[0].input!.content as string, /^\[\[c:\d+\.sent\.pub\]\] /);
  assert.match(closing.text!, /^\[\[c:\d+\.sent\.r2\]\] /);
  assert.equal(closing.calls, undefined);
  assert.deepEqual(continued, { calls: [{ name: 'skip_reply', input: {} }] });
});
