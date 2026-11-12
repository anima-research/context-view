import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, runOf } from './workloads.ts';
import { msg, text, call, result, asked } from '../testing/check-builders.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { BlockRecord } from '../standin/view.ts';
import type { Call } from '../strategies/script.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Breach } from './fates.ts';
import type { W17Step } from './w17.ts';
import type { Context, Run } from './workloads.ts';

type Block = DeepPartial<BlockRecord>;
type Blocks = Block[];
type Logged = DeepPartial<LogEntry>;
type Rec = { id: string; step: string; seq: number; kind: RequestRecord['kind']; messages: ReturnType<typeof msg>[]; answer?: DeepPartial<RequestRecord['answer']> };
type Ran = { records: Rec[]; log: Logged[] };

test('W17 declares its channels and a fork reader, and judges each step by its first request\'s message and notice, read by tag, the call it names as its result by that result in the next request, and each arrival, the console\'s included, by the request its point gives', () => {
  const run = runOf('H1/W17', configurations(), { budget: 100_000, maxTokens: 16_000 });
  assert.deepEqual(run.configuration.fixtureChannels, { chat: {}, other: {}, side: { initiallyOpen: false }, feed: { direction: 'inbound', initiallyOpen: false } });
  assert.equal(run.configuration.subconscious!.reader, 'forks');
  const ctx = { seed: 7 } satisfies DeepPartial<Context> as unknown as Context;
  const steps = WORKLOADS.W17.steps(ctx);
  const c = (part: string) => `[[c:7.${part}]]`;
  assert.deepEqual(steps.map((s) => [s.id.slice('7.'.length), s.w17]), [
    ['meet', { message: c('meet.in') }], ['priv', { message: c('priv.in'), result: 'channel_publish' }],
    ['side', { message: c('side.in'), notice: 'Channel invitation' }], ['feed.early', { message: c('feed.early.in'), notice: 'Channel invitation' }],
    ['feed.open', { message: c('feed.open.in'), result: 'channel_open' }], ['close', { message: c('close.in'), result: 'channel_close' }],
    ['close.wake', { notice: 'routing' }], ['feed.in', { message: c('feed.in.in'), notice: 'routing' }],
    ['self', { message: c('self.in') }], ['self.wake', { notice: 'self-wake' }],
    ['sleep', { message: c('sleep.in') }], ['sleep.wake', undefined], ['nudge.in', { message: c('nudge.in.in') }], ['nudge', undefined],
    ['tune', { message: c('tune.in') }], ['tune.cancel', { message: c('tune.cancel.in') }],
    ['focus', { message: c('focus.in'), result: 'focus' }],
    ['skip.bool', { message: c('skip.bool.in') }], ['pub.num', { message: c('pub.num.in'), result: 'channel_publish' }],
  ]);
  assert.ok(steps.filter((s) => s.w17).every((s) => s.w17!.message || s.w17!.notice || s.w17!.result), 'no step is counted as judged with nothing asked of it');
  assert.deepEqual(steps.flatMap((s) => (s.arrivals ?? []).map((a) => [s.id.slice('7.'.length), a.canary, a.point, Boolean(a.console)])), [
    ['meet', c('meet.con.in'), 'end', true], ['meet', c('meet.a.in'), 'end', false], ['priv', c('priv.con.in'), 'boundary', true], ['close.wake', c('close.wake.a.in'), 'boundary', false],
    ['tune.cancel', c('tune.cancel.read'), 'end', false],
  ]);
  const ran = (edit = (x: Ran) => x) => {
    let n = 0;
    const log: Logged[] = [];
    const records = steps.flatMap((s) => {
      const held = s.replies!.findIndex((r) => r.hold);
      return s.replies!.map((reply, k): Rec => {
        const id = `r${++n}`;
        const arriving = k === held + 1 && held >= 0 ? s.arrivals ?? [] : [];
        const ahead = arriving.length ? (arriving[0].point === 'end' ? [text([arriving[0].after])] : [{ ...result(`t-${s.id}-${k - 1}`), canaries: [arriving[0].after] }]) : [];
        const blocks: Blocks = k === 0
          ? [...(s.w17?.message ? [text([s.w17.message])] : []), ...(s.w17?.notice ? [{ type: 'text', chars: 10, notice: s.w17.notice }] : [])]
          : arriving.length ? [...ahead, ...arriving.flatMap((a) => [text([a.canary]), ...(a.routing ? [{ type: 'text', chars: 10, notice: 'routing' }] : [])])] : [result(`t-${s.id}-${k - 1}`)];
        if (k === held) {
          for (const a of s.arrivals ?? []) {
            if (a.agent) {
              const sub = `${id}-sub`;
              log.push({ step: s.id, kind: 'request', request: { id: sub, agent: 'sub' } }, { step: s.id, kind: 'send', via: 'release', request: sub }, { step: s.id, kind: 'agent-end' });
              continue;
            }
            log.push(a.console ? { step: s.id, kind: 'send', via: 'console', during: id, id: a.message } : { step: s.id, kind: 'send', via: 'channel', during: id, message: { messageId: a.message } });
            log.push({ step: s.id, kind: 'ipc', event: { type: 'message:added', source: a.console ? 'external-message' : 'mcpl:channel-incoming' } });
          }
          log.push({ step: s.id, kind: 'send', via: 'release', request: id });
        }
        return { id, seq: n, kind: 'agent', step: s.id, messages: [msg('user', ...blocks)], answer: { toolUseIds: ((reply.calls ?? []) as Call[]).map(() => `t-${s.id}-${k}`) } };
      });
    });
    const edited = edit({ records, log });
    return Object.assign(WORKLOADS.W17.check(edited satisfies DeepPartial<Run> as unknown as Run, ctx), { records: edited.records });
  };
  const clean = ran();
  assert.deepEqual([clean.length, clean.judged], [0, steps.filter((s) => s.w17).length + 5]);
  const at = (step: string, k = 0) => ran().records.filter((r) => r.step === `7.${step}`)[k].id;
  const said = (fs: Breach[]) => fs.map((f) => [f.step, f.message]);
  const records = (edit: (rs: Rec[]) => Rec[]) => ({ records, log }: Ran): Ran => ({ records: edit(records), log });
  const lastOf = (step: string, k: number, edit: (bs: Blocks) => Blocks) => records((rs) => rs.map((r) => (r.id === at(step, k) ? { ...r, messages: [msg('user', ...edit(r.messages.at(-1)!.blocks as Blocks))] } : r)));
  assert.deepEqual(said(ran(lastOf('side', 0, (bs) => bs.filter((b) => !b.notice)))), [['7.side', `request ${at('side')}, the step's first, carries no [Channel invitation] notice in its last message`]]);
  assert.deepEqual(said(ran(records((rs) => lastOf('close.wake', 0, (bs) => bs.filter((b) => !b.notice))({ records: rs, log: [] }).records.flatMap((r) => (r.id === at('close.wake') ? [r, { ...r, id: 'rx', messages: [msg('user', { type: 'text', chars: 10, notice: 'routing' })] }] : [r]))))), [['7.close.wake', `request ${at('close.wake')}, the step's first, carries no [routing] notice in its last message`]], 'the notice is owed in the step\'s first request, not in any of its requests');
  assert.deepEqual(said(ran(lastOf('self.wake', 0, (bs) => bs.filter((b) => !b.notice)))), [['7.self.wake', `request ${at('self.wake')}, the step's first, carries no [self-wake] notice in its last message`]]);
  assert.deepEqual(said(ran(lastOf('feed.in', 0, (bs) => bs.filter((b) => !b.canaries)))), [['7.feed.in', `request ${at('feed.in')}, the step's first, doesn't carry ${c('feed.in.in')} in its last message`]]);
  assert.deepEqual(said(ran(lastOf('feed.open', 1, () => [text()]))), [['7.feed.open', `request ${at('feed.open', 1)} doesn't carry the result of channel_open (t-7.feed.open-0) in its last message`]]);
  assert.deepEqual(said(ran(lastOf('priv', 2, () => [text()]))), [['7.priv', `request ${at('priv', 2)} doesn't carry the result of channel_publish (t-7.priv-1) in its last message`]], 'the publish round carries no text, and its result is still judged by the request after it');
  assert.deepEqual(said(ran(records((rs) => rs.filter((r) => r.id !== at('focus', 1))))), [['7.focus', 'couldn\'t judge: the step has no request after the one answered with its focus call']]);
  const none = ran(records((rs) => rs.filter((r) => r.step !== '7.close.wake')));
  assert.deepEqual(said(none), [['7.close.wake', 'couldn\'t judge: the step has no request'], ['7.close.wake', `couldn't judge ${c('close.wake.a.in')}: no request carries it`]]);
  const unstored = ran(({ records: rs, log }) => ({ records: rs, log: log.filter((e) => !(e.step === '7.priv' && e.kind === 'ipc')) }));
  assert.deepEqual(said(unstored), [['7.priv', `couldn't judge ${c('priv.con.in')}: it wasn't stored before its hold's release`]], 'a console arrival is judged only once the host stored it as console input before the release');
  const asChannel = ran(({ records: rs, log }) => ({ records: rs, log: log.map((e) => (e.step === '7.priv' && e.kind === 'ipc' ? { ...e, event: { ...e.event, source: 'mcpl:channel-incoming' } } : e)) }));
  assert.deepEqual(said(asChannel), [['7.priv', `couldn't judge ${c('priv.con.in')}: it wasn't stored before its hold's release`]], 'a channel message stored meanwhile isn\'t the console input');
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => [...bs.filter((b) => b.notice !== 'routing'), text([c('close.wake.r9')]), { type: 'text', chars: 10, notice: 'routing' }]))), [['7.close.wake', `request ${at('close.wake', 1)} carries ${c('close.wake.a.in')}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary`]], 'a [routing] notice after a later message\'s canary, as the bounce\'s is, isn\'t the arrival\'s');
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => bs.filter((b) => b.notice !== 'routing')))), [['7.close.wake', `request ${at('close.wake', 1)} carries ${c('close.wake.a.in')}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary`]], 'the message addressed from other is judged for its [routing] notice, as W14\'s is');
  const quoting = { type: 'text', chars: 10, notice: 'send-undeliverable', canaries: [c('close.wake.r1')] };
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => bs.flatMap((b) => (b.notice === 'routing' ? [quoting, b] : [b]))))), [], 'a notice that quotes the reply that went nowhere, ahead of the [routing] notice, isn\'t a later message');
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => [...bs.filter((b) => b.notice !== 'routing'), quoting, text([c('close.wake.r9')]), { type: 'text', chars: 10, notice: 'routing' }]))), [['7.close.wake', `request ${at('close.wake', 1)} carries ${c('close.wake.a.in')}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary`]], 'past a quoting notice, a later message\'s canary still ends the search');
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => bs.map((b) => (b.notice === 'routing' ? { ...b, canaries: [c('close.wake.r1')] } : b))))), [], 'a [routing] notice that quotes the reply is still the arrival\'s');
  assert.deepEqual(said(ran(lastOf('close.wake', 1, (bs) => bs.flatMap((b) => (b.notice === 'routing' ? [text(), b] : [b]))))), [], 'a block with no canary ends no search');
  const early = ran(lastOf('priv', 0, (bs) => [...bs, text([c('priv.con.in')])]));
  assert.deepEqual(said(early), [['7.priv', `${c('priv.con.in')} is first carried by request ${at('priv')}, where its point gives request ${at('priv', 1)}, the request after its boundary, the first to carry ${c('priv.call1')}`]]);
  const unread = ran(({ records: rs, log }) => ({ records: rs, log: log.filter((e) => !(e.step === '7.tune.cancel' && e.kind === 'agent-end')) }));
  assert.deepEqual(said(unread), [['7.tune.cancel', `couldn't judge ${c('tune.cancel.read')}: it wasn't stored before its hold's release`]], 'the reader fork\'s summary is judged only once its result was stored before the turn\'s hold was released');
  const before = ran(lastOf('tune.cancel', 2, (bs) => [...bs.filter((b) => !(b.canaries ?? []).includes(c('tune.cancel.r2'))), text([c('tune.cancel.r2')])]));
  assert.deepEqual(said(before), [['7.tune.cancel', `request ${at('tune.cancel', 2)} carries ${c('tune.cancel.read')} before ${c('tune.cancel.r2')}`]], 'the summary stored during the turn\'s last request comes after its closing words');
});

test('W17 cancels a tune-out from a console turn, holding its closing words until the reader fork that looks at the cancel has stored its summary for the resident', () => {
  const steps = WORKLOADS.W17.steps({ seed: 7 } satisfies DeepPartial<Context> as unknown as Context);
  const at = (n: string) => steps.find((s) => s.id === `7.${n}`)!;
  const calls = (s: W17Step) => s.replies!.map((r) => ((r.calls ?? []) as Call[]).map((c) => [c.name, c.input]));
  assert.deepEqual([at('tune').kind, calls(at('tune'))], ['console', [[['tune_out', { channelId: 'other', durationSeconds: 3600 }]], []]], 'a tune-out of other for the cancel to end, before focus calls focus on other');
  const s = at('tune.cancel');
  const reader = { prefix: 'reader/fixture/' };
  assert.deepEqual([s.kind, s.reader, calls(s)], ['console', reader, [[['tune_out', { mode: 'cancel', channelId: 'other' }]], [], []]]);
  const [, closing, after] = s.replies!;
  assert.match(closing.text!, /^\[\[c:7\.tune\.cancel\.r2\]\] /);
  assert.deepEqual([closing.hold, closing.during], [true, [{ agentEnd: reader }]], 'the turn\'s last request is held until the reader fork\'s summary is stored for the resident');
  assert.match(after.text!, /^\[\[c:7\.tune\.cancel\.r3\]\] /, 'the turn its summary wakes');
  assert.deepEqual(s.arrivals, [{ canary: '[[c:7.tune.cancel.read]]', point: 'end', after: '[[c:7.tune.cancel.r2]]', agent: 'reader/fixture/' }]);
  assert.equal(s.subs!.length, 1);
  const [sub] = s.subs!;
  assert.deepEqual([sub.marker, sub.canaries, sub.namedAnywhere], [WORKLOADS.W17.recipe.subconscious.voice, ['[[c:7.tune.cancel.in]]'], true], 'the reader fork is known by the voice block the recipe gives it');
  assert.deepEqual(sub.replies!.map((r) => [r.text!.startsWith('[[c:7.tune.cancel.read]] '), r.calls, r.hold, r.during]), [[true, undefined, true, [{ asked: 'primary', n: 2 }]]], 'a reader fork ends its look by ending its turn, once the turn\'s last request has arrived');
});

test('W17 reaches two other sources of private input after its self-wake: a sleep\'s end and an operator\'s nudge', () => {
  const steps = WORKLOADS.W17.steps({ seed: 7 } satisfies DeepPartial<Context> as unknown as Context);
  const at = (n: string) => steps.find((s) => s.id === `7.${n}`)!;
  const names = steps.map((s) => s.id.slice('7.'.length));
  const i = names.indexOf('self.wake');
  assert.deepEqual(names.slice(i, i + 8), ['self.wake', 'sleep', 'sleep.wake', 'nudge.in', 'nudge', 'tune', 'tune.cancel', 'focus']);
  const calls = (s: W17Step) => s.replies!.map((r) => ((r.calls ?? []) as Call[]).map((c) => [c.name, c.input]));
  assert.deepEqual([at('sleep').kind, calls(at('sleep'))], ['console', [[['sleep', { seconds: 120 }]]]], 'the sleep\'s call ends the turn until it wakes');
  assert.deepEqual([at('sleep.wake').kind, at('sleep.wake').ms, at('sleep.wake').canaries, at('sleep.wake').addressed, at('sleep.wake').replies!.length], ['advance', 121_000, ['[[c:7.sleep.in]]'], false, 1]);
  assert.deepEqual([at('nudge.in').kind, calls(at('nudge.in'))], ['console', [[['skip_reply', {}]]]]);
  const nudge = at('nudge');
  assert.deepEqual([nudge.kind, nudge.host, nudge.canaries, nudge.addressed, nudge.namedAnywhere, nudge.replies!.length], ['host', { command: 'nudge' }, ['[[c:7.nudge.in.in]]'], false, true, 1], 'the nudged turn is known by the console message before it');
});

test('W17 ends with two turns on other that give channel tools arguments of the wrong type, a number for channel_publish\'s channelId and a boolean for skip_reply\'s reason, scripted so a host that takes them ends each turn cleanly', () => {
  const steps = WORKLOADS.W17.steps({ seed: 7 } satisfies DeepPartial<Context> as unknown as Context);
  const names = steps.map((s) => s.id.slice('7.'.length));
  assert.deepEqual(names.slice(-3), ['focus', 'skip.bool', 'pub.num'], 'the skip\'s turn comes first, so the publish\'s first request carries what became of its words');
  const [skip, pub] = steps.slice(-2);
  const calls = (s: W17Step, which: 'replies' | 'spare' = 'replies') => s[which]!.map((r) => ((r.calls ?? []) as Call[]).map((c) => [c.name, c.input]));
  assert.deepEqual([pub.kind, pub.messages!.map((m) => m.channel), skip.kind, skip.messages!.map((m) => m.channel)], ['deliver', ['other'], 'deliver', ['other']]);
  const content = (pub.replies![0].calls as Call[])[0].input!.content as string;
  assert.ok(content.startsWith('[[c:7.pub.num.pub]] '), 'the publish names its words by its own canary');
  assert.deepEqual(calls(pub), [[['channel_publish', { channelId: 7, content }]], [['skip_reply', {}]]]);
  assert.equal(pub.replies![0].text, undefined, 'the publish\'s round has no words, which a host that publishes would hold as drafts');
  assert.ok(pub.replies![1].text!.startsWith('[[c:7.pub.num.r2]] '));
  assert.equal(pub.spare, undefined);
  assert.deepEqual(calls(skip), [[['skip_reply', { reason: true }]]]);
  assert.deepEqual(skip.spare!.map((r) => [r.text!.slice(0, '[[c:7.skip.bool.spare]] '.length), r.calls]), [['[[c:7.skip.bool.spare]] ', undefined]], 'the turn the refusal keeps going ends with a spare reply, unused where the host takes the reason');
  assert.equal(skip.w17!.result, undefined, 'a host that takes the reason ends the turn, leaving no request after the call to judge');
});
