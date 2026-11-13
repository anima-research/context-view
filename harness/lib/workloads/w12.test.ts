import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../strategies/script.ts';
import { WORKLOADS, runOf } from './workloads.ts';
import { gateFates, w12Facts } from './w12.ts';
import { msg, text, call, result, carrying, asked, started, sent, under } from '../testing/check-builders.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { BlockRecord, Message } from '../standin/view.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Call, CallInput, Delivered } from '../strategies/script.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { W12Step } from './w12.ts';
import type { Context, Facts, Run } from './workloads.ts';
import type { Breaches } from './fates.ts';

type Asked = DeepPartial<RequestRecord>;
type Logged = DeepPartial<LogEntry>;
type Block = DeepPartial<BlockRecord>;
type Blocks = Block[];
type Rec = { id: string; step: string; seq?: number; agent?: string; messages?: ReturnType<typeof msg>[]; answer?: DeepPartial<RequestRecord['answer']> } & ({ kind?: 'agent'; batch?: undefined; flagged?: undefined; kept?: undefined } | { kind: 'judge' | 'naming'; batch: string[]; flagged?: undefined; kept?: undefined } | { kind: 'relevance'; batch: string[]; kept: string[]; flagged?: undefined } | { kind: 'review'; batch: string[]; flagged: string[]; kept?: undefined });

const w12Ctx = (setup = 'H5', seed = 7) => {
  const capabilities = { suppression: true, onboarding: true, conversations: true };
  return { seed, capabilities, configurationName: setup, configuration: runOf(`${setup}/W12`, configurations(), { budget: 100_000, maxTokens: 16_000, capabilities }).configuration } satisfies DeepPartial<Context> as unknown as Context;
};

const MODE_STEPS = (open: boolean) => [{ step: 'open', ok: open, detail: open ? 'channel_open' : 'This host isn\'t permitted to open or close the "fixture" server\'s channels' }, { step: 'gate-policy', ok: true, detail: 'set' }, { step: 'gc-pin', ok: true, detail: 'subscription-gc--pin_channel_idle_limit' }];

const MODE_WHOLE = { success: true, isError: false, data: { channelId: 'w12-mode', mode: 'debounced', debounceMs: 60000, steps: MODE_STEPS(true), message: 'Channel w12-mode set to debounced mode, with a 60000 ms quiet window.' } };

const MODE_PARTIAL = { success: false, isError: true, data: { channelId: 'w12-mode', mode: 'debounced', debounceMs: 60000, steps: MODE_STEPS(false), message: 'Channel w12-mode is only partly in debounced mode: its debounce rule is set and it is pinned open, and opening the channel failed (This host isn\'t permitted to open or close the "fixture" server\'s channels).' } };

const toolResult = (step: string, toolName: string, result: unknown): Logged => ({ kind: 'ipc', step, event: { type: 'process:received', processEvent: { type: 'tool-result', toolName, result } } });

const w12Log = (seed: number, { noteAt = 'ws.note', added = true, lifecycle = true, gcAt = lifecycle ? ['gc.1'] : [], gcChannel = 'w12-gc', orphanTo = ['fixture'], alerted = true, mode = lifecycle ? MODE_WHOLE : MODE_PARTIAL, look = lifecycle ? null : { open: true, desired: 'closed' } }: { noteAt?: string; added?: boolean; lifecycle?: boolean; gcAt?: string[]; gcChannel?: string; orphanTo?: string[] | null; alerted?: boolean; mode?: object | null; look?: object | null } = {}): Logged[] => [
  ...(mode ? [toolResult(`${seed}.mode.set`, 'channel-mode--set_channel_mode', mode)] : []),
  ...(look ? [toolResult(`${seed}.gc.look`, 'channel_list', { success: true, data: [{ id: 'chat', open: true, desired: 'open' }, { id: 'w12-gc', ...look }] })] : []),
  { kind: 'ipc', step: `${seed}.${noteAt}`, event: { type: 'process:received', processEvent: { type: 'workspace:created', mount: 'watched', paths: ['watched/w12-note.txt'] } } },
  ...(added ? [{ kind: 'ipc', step: `${seed}.${noteAt}`, event: { type: 'message:added', source: 'workspace:created', messageId: '612' } }] satisfies Logged[] : []),
  ...gcAt.map((at): Logged => ({ kind: 'ipc', step: `${seed}.${at}`, event: { type: 'ops:alert', kind: 'subscription-gc-close', data: { channelId: gcChannel } } })),
  ...(orphanTo ? [{ kind: 'ipc', step: `${seed}.orphan`, event: { type: 'dendrite:agent-orphaned', agentName: `spawn-w12-s2-${seed}-1767616438001`, formerParent: `spawn-w12-s1-${seed}-1767616438000`, reason: 'completed', candidates: orphanTo } }] satisfies Logged[] : []),
  ...(alerted ? [{ kind: 'ipc', step: `${seed}.instr.read`, event: { type: 'ops:alert', kind: 'instructions-unavailable' } }] satisfies Logged[] : []),
];

test('under H5 alone, W12 batches an inbound-only channel\'s message with a notice, and console input with a channel message, holds a watched file\'s change, and its recipe caps a tool result kept inline at 10,000 characters', () => {
  const all = configurations();
  assert.equal(all.H5.recipe!.toolResultInlineMaxChars, 10_000, 'below the largest result W12 returns, the settings toolset\'s look');
  for (const setup of ['H5b', 'H5c']) assert.equal(all[setup].recipe?.toolResultInlineMaxChars, undefined, `${setup} keeps agent-framework's default`);
  assert.deepEqual(w12Ctx().configuration.fixtureChannels, { 'w12-pair-in': { direction: 'inbound' }, 'w12-status': {} }, 'H5/W12\'s fixture registers both H5\'s inbound-only channel and W12\'s own');
  for (const setup of ['H5b', 'H5c']) assert.deepEqual(w12Ctx(setup).configuration.fixtureChannels, { 'w12-status': {} }, `${setup}/W12's fixture registers W12's own alone`);
  const steps = WORKLOADS.W12.steps(w12Ctx());
  const step = (name: string) => steps.find((s) => s.id === `7.${name}`)!;
  const added = (name: string, k = 0) => (step(name).replies![k].calls as Call[]).map((c) => [c.input!.tool, c.input!.args]);
  assert.deepEqual(added('pair.rule'), [['wake_add_rule', { name: 'w12-pair', match: { channel: '*w12-pair*' }, debounceMs: 30_000 }]], 'a window the harness runs on the workload\'s clock');
  assert.deepEqual(['pair.a', 'pair.in', 'pair.note'].map((n) => [step(n).messages![0].channel, step(n).messages![0].tags]), [['w12-pair', ['chat:ambient']], ['w12-pair-in', ['chat:ambient']], ['w12-pair-note', ['chat:system']]]);
  assert.deepEqual(step('pair.fire').replies!.map((r) => r.error), [{ status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, with a stated wait', headers: { 'retry-after': '60' } }], 'the batch\'s turn meets an overload stating a 60 s wait, which agent-framework holds the turn for');
  assert.equal(step('pair.fire').retries, true);
  assert.deepEqual([step('pair.b').messages![0].channel, step('pair.b').messages![0].tags], ['w12-pair-b', ['chat:ambient']], 'a message the rule batches arrives during the hold');
  assert.ok(steps.indexOf(step('pair.held')) > steps.indexOf(step('pair.b')) && step('pair.held').ms === 60_000, 'the hold\'s end comes at a step that moves the clock 60 s past the step the hold began in');
  assert.deepEqual(step('pair.held').replies!.map((r) => r.calls ?? []), [[{ name: 'sleep', input: { seconds: 120 } }]], 'the held turn, started again, speaks and sleeps');
  assert.deepEqual([added('mix.rules'), added('mix.rules', 1), added('mix.rules', 2)], [[['wake_add_rule', { name: 'w12-mix', match: { filter: { type: 'text', pattern: '[[mix]]' } }, debounceMs: 60_000 }]], [['wake_add_rule', { name: 'w12-watch', match: { mount: 'watched', pathGlob: '*w12-mix*' }, debounceMs: 60_000 }]], [['wake_add_rule', { name: 'w12-quick', match: { channel: '*w12-quick' }, judge: { debounceMs: 30_000, instructions: 'Wake me when a message carries [[wake]]; let the rest go by.' } }]]]);
  assert.ok((step('quick.1').messages![0].text as string).includes('[[judge-holds]]'), 'the judge holds its answer on the first batch');
  assert.deepEqual([step('quick.fire').verdict, step('quick.fire').verdicts, step('quick.fire').judgeHold!.during.map((a) => Object.keys(a)[0])], ['w12-quick', 2, ['deliver', 'advance']], 'while the judge holds the first batch, a second arrives and its window passes, so the step waits for both verdicts');
  assert.ok(step('quick.fire').judgeHold!.during[0].deliver!.text.includes('[[wake]]'));
  assert.deepEqual(step('quick.held').replies!.map((r) => [r.hold, r.during!.map((a) => Object.keys(a)[0])]), [[true, ['deliver', 'advance']], [true, ['deliver', 'advance']]], 'two batches close while the turn holds its rounds');
  assert.equal(step('quick.held').verdictAfterTurn, 'w12-quick', 'the held batches\' verdict comes after the turn ends');
  assert.ok((step('mix.chan').messages![0].text as string).includes('[[mix]]') && step('mix.console').text!.includes('[[mix]]'), 'both the channel message and the console input carry the text rule\'s mark');
  assert.equal(step('mix.file').path, 'watched/w12-mix.txt');
  for (const setup of ['H5b', 'H5c']) assert.deepEqual(WORKLOADS.W12.steps(w12Ctx(setup)).filter((s) => /\.(ws\.(draft|disk|binary|backup|edit)|pair\.|mix\.|quick\.|relist$)/.test(s.id)).map((s) => s.id), [], `${setup} gets none of these steps`);
});

test('W12 judges each scripted event by the fate its rule gives it, a judged batch by one reply judge\'s request listing it and answered as its mark gives, and that the agent looked at what the settings toolset listed', () => {
  const ctx = w12Ctx();
  const steps = WORKLOADS.W12.steps(ctx);
  const step = (name: string) => steps.find((s) => s.id === `7.${name}`);
  const ins = (name: string) => step(name)!.gate?.canaries ?? [`[[c:7.${name}.in]]`];
  const ran = (edit = (x: Rec[]) => x) => {
    let n = 0;
    const lived = { type: 'text', chars: 10, notice: 'Agent lifecycle' };
    const req = (name: string, last: Blocks, more: Partial<Extract<Rec, { kind?: 'agent' }>> = {}): Rec => {
      const upTo = steps.slice(0, steps.indexOf(step(name)!) + 1).flatMap((s) => (s.gate?.expect === 'hidden' ? [] : s.gate?.canaries ?? []));
      const told = steps.indexOf(step(name)!) > steps.indexOf(step('orphan')!) ? [lived, lived] : [];
      return { id: `r${++n}`, seq: n, kind: 'agent', step: `7.${name}`, messages: [msg('user', text(upTo), ...told), msg('user', ...last)], ...more };
    };
    const wake = (count: number) => ({ type: 'text', chars: 10, wakeLine: count });
    const name = (s: W12Step) => s.id.slice('7.'.length);
    let j = 0;
    const asked = (s: W12Step): Rec[] => (s.gate!.judged ? [{ id: `j${++j}`, kind: 'judge', step: s.id, batch: s.gate!.canaries, answer: s.gate!.judged === 'failed' ? { shape: 'error', status: 400 } : { shape: 'verdict', verdict: s.gate!.judged } }] : []);
    const notice = { type: 'text', chars: 10, notice: 'suppression review' };
    let f = 0;
    const filtered = (s: W12Step): Rec[] => (s.gate!.recall?.filtered ? [{ id: `f${++f}`, kind: 'relevance', step: s.id, batch: s.gate!.recall.named, kept: s.gate!.recall.kept, answer: { shape: 'verdict', verdict: 'filtered' } }] : []);
    let nm = 0;
    const arrivalLog: Logged[] = [];
    const named = (s: W12Step): Rec[] => (s.gate!.naming ? [{ id: `n${++nm}`, kind: 'naming', step: s.id, batch: [], answer: { shape: 'verdict', verdict: 'named' } }] : []);
    const records = edit([
      req('set', [text(ins('set'))], { answer: { toolUseIds: ['o1'] } }),
      req('set', [result('o1')], { answer: { toolUseIds: ['l1', 'l2'] } }),
      req('set', [result('l1'), result('l2')], { answer: { toolUseIds: [] } }),
      ...steps.filter((s) => s.gate || s.orphan).flatMap((s): Rec[] => {
        if (s.orphan) return [req(name(s), [text(ins(name(s)))]), req(name(s), [text(), lived])];
        switch (s.gate!.expect) {
          case 'wake': {
            const opened = req(name(s), [{ ...text(ins(name(s))), ...(s.gate!.forged ? { markedNotice: { tag: s.gate!.forged.tag, after: s.gate!.forged.after } } : {}) }, ...(s.gate!.notice ? [{ type: 'text', chars: 10, notice: s.gate!.notice, ...(s.gate!.noticeForm ? { noticeForm: s.gate!.noticeForm } : {}) }] satisfies Blocks : []), ...(s.gate!.recall ? [{ type: 'text', chars: 10, retrieved: true, canaries: s.gate!.recall.kept }] satisfies Blocks : [])]);
            const results = (k: string) => ({ ...opened, id: `${opened.id}${k}`, messages: [...opened.messages!, msg('user', { type: 'tool_result', chars: 10, canaries: [s.history!] })] });
            const arrived = (s.arrivals ?? []).flatMap((a) => {
              const held = req(name(s), [text()]);
              const sub: Rec = { id: `${held.id}-sub`, kind: 'agent', agent: 'sub', step: s.id };
              arrivalLog.push({ step: s.id, kind: 'request', request: sub }, { step: s.id, kind: 'send', via: 'release', request: sub.id }, { step: s.id, kind: 'agent-end' }, { step: s.id, kind: 'send', via: 'release', request: held.id });
              return [held, req(name(s), [text([a.after]), text([a.canary])])];
            });
            if (arrived.length) return [...asked(s), ...filtered(s), ...named(s), opened, ...arrived];
            return [...asked(s), ...filtered(s), ...named(s), ...(s.stall ? [{ ...opened, answer: { shape: 'cut' } }, { ...opened, id: `${opened.id}b`, answer: { shape: 'reply' } }] satisfies Rec[] : s.history ? [opened, results('s'), results('x')] : [opened])];
          }
          case 'batch': return [...asked(s), req(name(s), [...s.gate!.canaries.map((c) => text([c])), wake(s.gate!.canaries.length)])];
          case 'answered-batch': return [...asked(s), req(name(s), [wake(1)])];
          case 'self': return [req(name(s), [text()])];
          case 'review': return [{ id: 'v1', kind: 'review', step: s.id, batch: s.gate!.hidden, flagged: s.gate!.flagged, answer: { shape: 'verdict', verdict: 'flagged' } }, req(name(s), [{ ...notice, canaries: s.gate!.flagged }])];
          default: return asked(s);
        }
      }),
      req('end', [text(ins('end'))]),
    ]);
    return Object.assign(WORKLOADS.W12.check({ log: [...w12Log(7), ...arrivalLog], records } satisfies DeepPartial<Run> as unknown as Run, ctx), { records });
  };
  const clean = ran();
  assert.deepEqual([clean.length, clean.judged], [0, steps.filter((s) => s.gate).length + steps.filter((s) => s.stall).length + steps.filter((s) => s.history).length + steps.filter((s) => s.orphan).length + steps.flatMap((s) => s.arrivals ?? []).length + 1 + 3]);
  const spawned = ran().records.filter((r) => r.step === '7.priv.spawn' && r.kind === 'agent');
  assert.equal(spawned.length, 3, 'the spawn\'s opening request, its held last request, and the wake its result starts');
  const early = ran((rs) => rs.map((r) => (r.id === spawned[1].id ? { ...r, messages: [...r.messages!, msg('user', text(['[[c:7.priv.spawn.s1]]']))] } : r)));
  assert.deepEqual(early.map((f) => [f.step, f.message]), [['7.priv.spawn', `[[c:7.priv.spawn.s1]] is first carried by request ${spawned[1].id}, where its point gives request ${spawned[2].id}, its wake turn's first request, the first after the turn's held final request`]], 'a subagent result stored while the turn\'s last request is held comes after the turn, not into it');
  const quiet = ran((rs) => rs.filter((r) => !(r.step === '7.judge.err2' && r.kind === 'agent')));
  assert.deepEqual(quiet.map((f) => f.message), [], 'a failed judge\'s batch the agent read and answered in the judge\'s channel may start no turn, as at agent-framework#972');
  const twiceErr2 = ran((rs) => rs.flatMap((r) => (r.step === '7.judge.err2' && r.kind === 'agent' ? [r, { ...r, id: `${r.id}b` }] : [r])));
  assert.deepEqual(twiceErr2.map((f) => [f.step, f.message]), [['7.judge.err2', 'the batch the agent had already answered started 2 requests, where it starts one turn at most']]);
  const mixFire = ran().records.find((r) => r.kind === 'agent' && r.step === '7.mix.fire')!.id;
  const mixUnread = ['7.mix.fire', 'the batch started 0 request(s) carrying the events the agent hadn\'t read, where it starts one'];
  assert.deepEqual(ran((rs) => rs.filter((r) => r.id !== mixFire)).map((f) => [f.step, f.message]), [mixUnread], 'the [[mix]] batch, whose console message the agent hadn\'t read, starts a turn');
  assert.deepEqual(ran((rs) => rs.map((r) => (r.id === mixFire ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', text(ins('mix.chan')), { type: 'text', chars: 10, wakeLine: 2 })] } : r))).map((f) => [f.step, f.message]), [mixUnread], 'and that turn\'s request carries the console message in its last message');
  const orphanIds = ran().records.filter((r) => r.step === '7.orphan').map((r) => r.id);
  const nextId = ran().records.find((r) => r.step === '7.subs.list')!.id;
  const untold = (id: string, keep: number) => ran((rs) => rs.map((r) => (r.id === id ? { ...r, messages: r.messages!.map((m) => ({ ...m, blocks: m.blocks!.filter((b) => b.notice !== 'Agent lifecycle' || keep-- > 0) })) } : r)));
  const earlier = ran((rs) => rs.map((r) => (r.id === orphanIds[1] ? { ...r, messages: [msg('user', ...r.messages!.at(-1)!.blocks!), msg('user', text())] } : r)));
  assert.deepEqual(earlier.map((f) => f.step), ['7.orphan'], 'the adoption offer belongs in the last message, where the first subagent\'s result lands');
  assert.deepEqual(untold(orphanIds[1], 0).map((f) => [f.step, f.message]), [['7.orphan', `request ${orphanIds[1]}, which answers the first subagent's result, carries no [Agent lifecycle] notice in its last message, where its end orphans the second and offers it to the resident`]]);
  assert.deepEqual(untold(nextId, 1).map((f) => [f.step, f.message]), [['7.orphan', `request ${nextId} carries 1 [Agent lifecycle] notice(s), where the adoption offer and the held result's notice make two`]], 'the held result\'s notice missing');
  assert.deepEqual(ran((rs) => rs.filter((r) => r.id !== orphanIds[1])).map((f) => f.message), ['couldn\'t judge the orphan\'s notices: no request answered the first subagent\'s result']);
  const orphan = step('orphan');
  assert.equal((orphan!.replies![0].calls as Call[])[0].input!.sync, true, 'the resident waits on the first subagent, so neither compiles while the other does');
  assert.deepEqual(orphan!.subs!.map((x) => x.as), ['w12-s2-7', 'w12-s1-7']);
  assert.deepEqual((orphan!.subs![1].replies![0].calls as Call[])[1].during, [{ asked: 'w12-s2-7' }]);
  assert.deepEqual(orphan!.subs![0].replies![0].during, [{ asked: 'primary', n: 2 }], 'the second is held until the agent\'s request answering the first has arrived');
  assert.deepEqual(orphan!.replies![1].during, [{ ended: 'w12-s2-7' }], 'and that request until the second\'s turn has ended, so no other turn is alive when the agent speaks');
  const sent = step('hist.read')!.history;
  assert.equal(sent, '[[c:7.hist.send.sent]]', 'the message the agent publishes is what it reads back');
  assert.ok(JSON.stringify(step('hist.send')!.replies![0]).includes(sent));
  const unread = (id: string) => ran((rs) => rs.map((r) => (r.id === id ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', { type: 'tool_result', chars: 10 })] } : r)));
  const readId = (k: number) => ran().records.filter((r) => r.step === '7.hist.read')[k].id;
  assert.deepEqual(unread(readId(1)).map((f) => [f.step, f.message]), [['7.hist.read', `request ${readId(1)} carries the history search's result without the sent message ${sent}`]]);
  assert.deepEqual(unread(readId(2)).map((f) => [f.step, f.message]), [['7.hist.read', `request ${readId(2)} carries the history extract's text without the sent message ${sent}`]]);
  assert.deepEqual(ran((rs) => rs.filter((r) => r.id !== readId(2))).map((f) => f.message), ['couldn\'t judge the history module\'s search and extract: 2 request(s) at the step, where its opening and one after each of its two calls make three']);
  const uncut = ran((rs) => rs.filter((r) => !(r.step === '7.stall' && r.answer?.shape === 'cut')));
  assert.deepEqual(uncut.map((f) => [f.step, f.message.split(' (')[0]]), [['7.stall', 'the held call wasn\'t cut and sent again once with the same messages']]);
  const unnoticed = ran((rs) => rs.map((r) => (r.step === '7.instr.notice' ? { ...r, messages: [r.messages![0], msg('user', text(ins('instr.notice')))] } : r)));
  const noticed = ran().records.find((r) => r.kind === 'agent' && r.step === '7.instr.notice')!.id;
  assert.deepEqual(unnoticed.map((f) => f.message), [`request ${noticed}, which its message started, carries no host-notice line in its last message, where the host owes one`]);
  const reformed = ran((rs) => rs.map((r) => (r.step === '7.instr.notice' ? { ...r, messages: [r.messages![0], msg('user', text(ins('instr.notice')), { type: 'text', chars: 10, notice: 'host-notice', noticeForm: 'status' })] } : r)));
  assert.deepEqual(reformed.map((f) => f.message), [`request ${noticed}'s host-notice line is in the form status, where its alert's tier gives the unanswered form`], 'the reply tier\'s notice says what the host posted while the agent couldn\'t respond');
  const asleep = ran((rs) => rs.filter((r) => r.step !== '7.sleep.end'));
  assert.deepEqual(asleep.map((f) => f.message), ['the sleep\'s end woke no turn at the step that moved the clock past it']);
  const woke = ran((rs) => [...rs.slice(0, 4), { ...rs[3], id: 'rx', step: '7.defer', messages: [msg('user', text(ins('defer')))] }, ...rs.slice(4)]);
  assert.deepEqual(woke.map((f) => f.message), ['the w12-defer rule\'s message started 1 request(s), where its rule starts none']);
  const fired = ran().records.find((r) => r.step === '7.debounce.fire')!.id;
  const unlined = ran((rs) => rs.map((r) => (r.step === '7.debounce.fire' ? { ...r, messages: [r.messages![0], msg('user', ...r.messages![1].blocks!.slice(0, 2))] } : r)));
  assert.deepEqual(unlined.map((f) => f.message), [], 'a batch whose events the framework stored at arrival may open its turn with no wake line, as at agent-framework#972');
  const relined = (count: number) => ran((rs) => rs.map((r) => (r.step === '7.debounce.fire' ? { ...r, messages: [r.messages![0], msg('user', ...r.messages![1].blocks!.slice(0, 2), { type: 'text', chars: 10, wakeLine: count })] } : r)));
  assert.deepEqual(relined(1).map((f) => f.message), [], 'a line counting fewer events than its batch holds, as for events not stored at arrival');
  assert.deepEqual(relined(3).map((f) => f.message), [`request ${fired} opens the batch's turn with a wake line counting 3 events, where its batch holds 2`]);
  const lacking = ran((rs) => rs.map((r) => (r.step === '7.debounce.fire' ? { ...r, messages: [r.messages![0], msg('user', ...r.messages![1].blocks!.slice(1))] } : r)));
  assert.deepEqual(lacking.map((f) => f.message), [`request ${fired} opens the batch's turn without all 2 of its events`], 'a turn missing one of its batch\'s events still flags, line or no line');
  const twice = ran((rs) => rs.flatMap((r) => (r.step === '7.answered.fire' ? [r, { ...r, id: 'ry' }] : [r])));
  assert.deepEqual(twice.map((f) => f.message), ['the batch the agent had already answered started 2 requests, where it starts one turn at most']);
  const unlooked = ran((rs) => rs.map((r) => (r.id === 'r2' ? { ...r, answer: { toolUseIds: [] } } : r)));
  assert.deepEqual(unlooked.map((f) => f.message), ['request r2 answered the settings toolset\'s listing with no look, so the listing named no tool']);
  assert.deepEqual(steps.filter((s) => s.gate?.judged).map((s) => [s.id.slice('7.'.length), s.gate!.judged, s.gate!.expect]), [['judge.yes', 'reply', 'batch'], ['judge.no', 'wait', 'none'], ['judge.err', 'failed', 'wake'], ['judge.err2', 'failed', 'answered-batch']], 'a batch whose judge call fails wakes the agent under the judge\'s default onError, at most once where the agent has read and answered it');
  const unasked = ran((rs) => rs.filter((r) => r.id !== 'j2'));
  assert.deepEqual(unasked.map((f) => f.message), ['the w12-judge rule\'s batch went to the reply judge in 0 request(s), where it goes in one']);
  const reversed = ran((rs) => rs.map((r) => (r.id === 'j1' ? { ...r, answer: { shape: 'verdict', verdict: 'wait' } } : r)));
  assert.deepEqual(reversed.map((f) => f.message), ['the reply judge\'s request j1 was answered wait, where the batch\'s mark gives reply']);
  const unfailed = ran((rs) => rs.map((r) => (r.id === 'j3' ? { ...r, answer: { shape: 'verdict', verdict: 'reply' } } : r)));
  assert.deepEqual(unfailed.map((f) => f.message), ['the reply judge\'s request j3 was answered reply, where the batch\'s mark gives an error'], 'the judge.err batch\'s request is the third the judge gets');
  const short = ran((rs) => rs.map((r) => (r.id === 'j2' ? { ...r, batch: r.batch!.slice(0, 1) } as Rec : r)));
  assert.deepEqual(short.map((f) => f.message), [`the reply judge's request j2 doesn't list every event of the batch (it lists ${ins('judge.no')[0]})`]);
  const waited = ran((rs) => { const at = rs.findIndex((r) => r.id === 'j2'); return [...rs.slice(0, at + 1), { id: 'rx', kind: 'agent', step: '7.judge.no', messages: [msg('user', text(ins('judge.no')))] }, ...rs.slice(at + 1)]; });
  assert.deepEqual(waited.map((f) => f.message), ['the w12-judge rule\'s message started 1 request(s), where its rule starts none']);
  const [, b2] = ins('judge.no');
  const after = steps.slice(steps.indexOf(step('judge.no')!) + 1).find((s) => (['wake', 'batch', 'self'] as (string | undefined)[]).includes(s.gate?.expect))!.id;
  const dropped = ran((rs) => rs.map((r) => (r.kind === 'agent' && r.step === after ? { ...r, messages: r.messages!.map((m) => ({ ...m, blocks: m.blocks!.map((b) => ({ ...b, canaries: (b.canaries ?? []).filter((c) => c !== b2) })) })) } : r)));
  const unborne = `request ${ran().records.find((r) => r.kind === 'agent' && r.step === after)!.id}, the next after the w12-judge rule's message, doesn't carry ${b2}`;
  assert.deepEqual(dropped.map((f) => [f.step, f.message]), [[step('judge.b2')!.id, unborne], [step('judge.no')!.id, unborne]], 'a batch the judge let go by is carried whole by the next request');
  const [m1, m2] = [ins('mute.1')[0], ins('mute.2')[0]];
  const leak = (c: string, at: string) => ran((rs) => rs.map((r) => (r.kind === 'agent' && r.step === at ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', ...r.messages!.at(-1)!.blocks!, text([c]))] } : r)));
  const said = (fs: Breaches) => fs.map((f) => [f.step, f.message]);
  const at = (step: string) => ran().records.find((r) => r.kind === 'agent' && r.step === step)!.id;
  assert.deepEqual(said(leak(m1, '7.end')), [['7.mute.1', `the w12-mute rule's suppressed message reached request ${at('7.end')}`]], 'an event the review finds fits its rule reaches no request at all');
  assert.deepEqual(said(leak(m2, '7.sleep.go')), [['7.mute.2', `the w12-mute rule's suppressed message reached request ${at('7.sleep.go')}, before the review that flags it`]]);
  assert.deepEqual(said(leak(m2, '7.end')), [], 'the flagged event may be carried once the review\'s notice has quoted it');
  assert.deepEqual(said(ran((rs) => rs.filter((r) => r.id !== 'v1'))), [['7.review', 'the review of what the w12-mute rule hid went to the reviewer in 0 request(s), where it goes in one']]);
  assert.deepEqual(said(ran((rs) => rs.map((r) => (r.id === 'v1' ? { ...r, batch: [m2] } as Rec : r)))), [['7.review', `the review's request v1 doesn't list every event the rule hid (it lists ${m2})`]]);
  assert.deepEqual(said(ran((rs) => rs.filter((r) => !(r.step === '7.review' && r.kind === 'agent')))), [['7.review', 'the review\'s notice started 0 request(s) carrying it, where its flag wakes one']]);
  assert.deepEqual(step('part.fire')!.gate!.read, ins('part.x1'), 'the batch the agent read part of names what it read');
  assert.deepEqual(step('judge.yes')!.gate!.read, ins('judge.yes'), 'the judged batch the agent read whole names every event');
  const lastBlocks = (step: string, keep: (b: Block) => boolean) => (rs: Rec[]) => rs.map((r) => (r.kind === 'agent' && r.step === step ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', ...r.messages!.at(-1)!.blocks!.filter(keep))] } : r));
  const [x1, x2] = ins('part.fire');
  const partId = at('7.part.fire');
  assert.deepEqual(said(ran(lastBlocks('7.part.fire', (b) => !(b.canaries ?? []).includes(x2)))), [['7.part.fire', 'the batch started 0 request(s) carrying the events the agent hadn\'t read, where it starts one']], 'the event left unread is what opens the turn');
  assert.deepEqual(said(ran(lastBlocks('7.part.fire', (b) => !(b.canaries ?? []).includes(x1)))), [], 'the event it read needn\'t be in the turn\'s last message');
  assert.deepEqual(said(ran(lastBlocks('7.part.fire', (b) => !b.wakeLine))), [], 'the partly answered batch may open its turn with no wake line, as at agent-framework#972');
  assert.deepEqual(said(ran(lastBlocks('7.judge.yes', (b) => !(b.canaries ?? []).length))), [], 'a judged batch the agent read whole opens its turn with the wake line alone');
  assert.deepEqual(said(ran(lastBlocks('7.judge.yes', (b) => !b.wakeLine))), [], 'the judged batch the agent read whole may open its turn with no wake line');
  assert.deepEqual(said(ran((rs) => rs.map((r) => (r.kind === 'agent' && r.step === '7.judge.yes' ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', { type: 'text', chars: 10, wakeLine: 3 })] } : r)))), [['7.judge.yes', `request ${at('7.judge.yes')} opens the batch's turn with a wake line counting 3 events, where its batch holds 2`]]);
  assert.deepEqual(said(ran((rs) => rs.filter((r) => !(r.kind === 'agent' && r.step === '7.judge.yes')))), [['7.judge.yes', 'the batch started 0 request(s), where it starts one']]);
  assert.deepEqual(said(ran((rs) => rs.map((r) => (r.step === '7.review' && r.kind === 'agent' ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', { type: 'text', chars: 10, notice: 'suppression review' })] } : r)))), [['7.review', `request ${at('7.review')} carries the review's notice without the event it flagged`]]);
  assert.deepEqual(said(leak(m1, '7.review')), [['7.mute.1', `the w12-mute rule's suppressed message reached request ${at('7.review')}`], ['7.review', `request ${at('7.review')} carries an event the review found fits its rule`]]);
  const lessons = step('recall.all')!.gate!.recall!.named;
  assert.deepEqual([step('recall.one')!.gate!.recall!.named, step('recall.one')!.gate!.recall!.kept, step('recall.all')!.gate!.recall!.kept], [lessons.slice(0, 1), lessons.slice(0, 1), lessons.slice(0, 3)], 'one names lesson a alone; the other names all four, and the relevance filter keeps all but the stale one');
  const injecting = (at: string, canaries: string[] | null) => (rs: Rec[]) => rs.map((r) => (r.kind === 'agent' && r.step === at ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', ...r.messages!.at(-1)!.blocks!.filter((b) => !b.retrieved), ...(canaries ? [{ type: 'text', chars: 10, retrieved: true, canaries }] satisfies Blocks : []))] } : r));
  assert.deepEqual(said(ran((rs) => [{ id: 'fx', kind: 'relevance', step: '7.recall.one', batch: lessons.slice(0, 1), kept: lessons.slice(0, 1) }, ...rs])), [['7.recall.one', 'the message naming 1 lesson(s) brought 1 relevance request(s), where the module injects so few candidates without one']], 'a threshold lowered below one candidate shows');
  assert.deepEqual(said(ran((rs) => injecting('7.recall.all', lessons)(rs.filter((r) => r.kind !== 'relevance')))), [['7.recall.all', 'the 4 candidate lessons the message names went to the relevance filter in 0 request(s), where they go in one'], ['7.recall.all', `request ${at('7.recall.all')}'s newest retrieved lessons are ${lessons.join(' ')}, where the message's candidates, less any the relevance filter drops, are ${lessons.slice(0, 3).join(' ')}`]], 'a threshold raised to four or more shows twice: no relevance request, and the stale lesson injected');
  assert.deepEqual(said(ran((rs) => rs.map((r) => (r.kind === 'relevance' ? { ...r, batch: lessons.slice(0, 3) } : r)))), [['7.recall.all', `the relevance request f1 lists ${lessons.slice(0, 3).join(' ')}, where the message names ${lessons.join(' ')}`]]);
  assert.deepEqual(said(ran(injecting('7.recall.one', null))), [['7.recall.one', `request ${at('7.recall.one')}, which the message started, carries no retrieved lessons, where it names ${lessons[0]}`]]);
  assert.deepEqual(said(ran(injecting('7.recall.all', lessons.slice(0, 2)))), [['7.recall.all', `request ${at('7.recall.all')}'s newest retrieved lessons are ${lessons.slice(0, 2).join(' ')}, where the message's candidates, less any the relevance filter drops, are ${lessons.slice(0, 3).join(' ')}`]]);
  const older = (rs: Rec[]) => rs.map((r) => (r.kind === 'agent' && r.step === '7.recall.all' ? { ...r, messages: [msg('user', { type: 'text', chars: 10, retrieved: true, canaries: lessons }), ...r.messages!] } : r));
  assert.deepEqual(said(ran(older)), [], 'an older stored injection earlier in the request isn\'t the one judged');
  const name = (s: W12Step) => s.id.slice('7.'.length);
  const unaddressed = steps.filter((s) => s.addressed === false);
  assert.deepEqual(unaddressed.map(name), ['priv.fork', 'judge.yes', 'judge.no', 'judge.err', 'judge.err2', 'sleep.end', 'skip.wake', 'mode.fire', 'ws.note', 'remind.fire', 'tick', 'review', 'console.1', 'console.2', 'console.3', 'tick.priv', 'priv.spawn', 'pair.fire', 'pair.held', 'pair.wake', 'mix.console', 'mix.fire', 'mix.wfire', 'quick.fire'], 'the turns no addressed message wakes: a judged batch, a timer, the ambient batch, a provider hold\'s end, a watched file\'s change, the review\'s notice and console input');
  const answersOf = (s: W12Step) => (s.replies?.length ? s.replies : s.spare ?? []);
  const retried = (s: W12Step) => s.retries && s.replies?.length && s.replies.every((r) => r.error);
  assert.deepEqual(unaddressed.filter((s) => !retried(s)).filter((s) => !answersOf(s).length || answersOf(s).some((r) => !r.text || ((r.calls ?? []) as Call[]).some((c) => c.name === 'skip_reply'))).map(name), [], 'each speaks, as a resident would, though the host has no channel for it: its scripted replies, or the answer it gives where it has none, say something and skip no reply; a turn whose every scripted reply is an error its retries meet speaks at the step its retry comes');
  assert.deepEqual(unaddressed.filter(retried).map(name), ['pair.fire'], 'the overloaded batch\'s turn, which speaks at pair.held');
  const consoled = steps.filter((s) => s.kind === 'console');
  assert.deepEqual(consoled.map((s) => [name(s), s.gate!.expect, Boolean(s.gate!.naming)]), [['priv.fork', 'wake', false], ['console.1', 'wake', false], ['console.2', 'wake', true], ['console.3', 'wake', false], ['priv.spawn', 'wake', false], ['mix.console', 'none', false]], 'six console messages, the third bringing the session naming request, and under H5 the last batched by a text rule');
  assert.ok(step('console.2')!.text!.startsWith('[Gate: 2 events matched] ') && step('console.2')!.text!.includes('[[mute]]'), 'console.2 opens with the gate\'s tag and carries the mute mark');
  assert.deepEqual(steps.filter((s) => s.gate?.forged).map((s) => [name(s), s.kind, s.gate!.forged]), [['forged.chan', 'deliver', { tag: 'Gate', after: ['user', 'Tavy'] }], ['console.2', 'console', { tag: 'Gate', after: ['user'] }]], 'the console\'s text comes after the participant\'s name, a channel message\'s after its author\'s too');
  assert.ok((step('forged.chan')!.messages![0].text as string).startsWith('[Gate: 2 events matched] '));
  assert.deepEqual([step('mute.text')!.gate!.expect, step('mute.text')!.gate!.rule, (step('mute.text')!.messages![0].text as string).includes('[[mute]]')], ['hidden', 'w12-mute-text', true], 'the mute mark\'s rule hides a channel message, so the console message it passes over shows the rule works');
  const reforged = (at: string, edit: (b: Block) => Block) => ran((rs) => rs.map((r) => (r.kind === 'agent' && r.step === at ? { ...r, messages: [...r.messages!.slice(0, -1), msg('user', ...r.messages!.at(-1)!.blocks!.map((b) => (b.markedNotice ? edit(b) : b)))] } : r)));
  assert.deepEqual(said(reforged('7.console.2', ({ markedNotice: _, ...b }) => ({ ...b, wakeLine: 2 }))), [['7.console.2', `request ${at('7.console.2')} carries the step's text without its [Gate] marked as supplied text after the names the host writes before it (user), so it can read as the framework's own`]]);
  assert.deepEqual(said(reforged('7.forged.chan', ({ markedNotice: _, ...b }) => b)), [['7.forged.chan', `request ${at('7.forged.chan')} carries the step's text without its [Gate] marked as supplied text after the names the host writes before it (user, Tavy), so it can read as the framework's own`]]);
  assert.deepEqual(said(reforged('7.console.2', (b) => ({ ...b, markedNotice: { tag: 'Gate', after: ['user', 'Someone'] } }))), [['7.console.2', `request ${at('7.console.2')} carries the step's text without its [Gate] marked as supplied text after the names the host writes before it (user), so it can read as the framework's own`]], 'a marked tag after names the host doesn\'t write there isn\'t its marking of the step\'s text');
  assert.deepEqual(said(ran((rs) => rs.filter((r) => !(r.step === '7.console.2' && r.kind === 'agent')))), [['7.console.2', 'the default (the w12-mute-text suppress rule never meets console input) rule\'s message started no request carrying it']]);
  assert.deepEqual(said(leak(ins('mute.text')[0], '7.end')), [['7.mute.text', `the w12-mute-text rule's suppressed message reached request ${at('7.end')}`]]);
  const n1 = ran().records.find((r) => r.kind === 'naming');
  assert.equal(n1!.step, '7.console.2', 'under H5 the fork\'s console message is the first');
  assert.deepEqual(said(ran((rs) => rs.filter((r) => r.kind !== 'naming'))), [['7.console.2', 'the third console message brought 0 session naming request(s), where it brings one']]);
  assert.deepEqual(said(ran((rs) => [...rs, { ...n1!, id: 'n2' }])), [['7.console.2', 'the third console message brought 2 session naming request(s), where it brings one']]);
  assert.deepEqual(said(ran((rs) => [...rs, { ...n1, id: 'n2', step: '7.console.1' }])), [['7.console.2', 'session naming request n2 came at step 7.console.1, where only the third console message brings one']]);
  const elsewhere = ran((rs) => {
    const i = rs.findIndex((r) => r.kind === 'agent' && r.step === '7.onboard.offer');
    const opened = { ...rs[i], messages: [...rs[i].messages!.slice(0, -1), msg('user', ...rs[i].messages!.at(-1)!.blocks!.filter((b) => !b.notice))] };
    return [...rs.slice(0, i), opened, { id: 'rz', kind: 'agent', step: '7.onboard.offer', messages: [msg('user', { type: 'text', chars: 10, notice: 'wake onboarding' })] }, ...rs.slice(i + 1)];
  });
  assert.deepEqual(said(elsewhere), [['7.onboard.offer', `request ${at('7.onboard.offer')}, which its message started, carries no wake onboarding line in its last message, where the host owes one`]], 'the notice is owed in the request the offer started, not in any request at its step');
});

test('W12 scripts, under H5b and H5c, the fate each value gives its step: the watched file\'s change at the next tool batch\'s scan or seen and left unwoken, a failed judge call skipped, the judge off making its batches debounces, a paused heartbeat with no tick, and the silent tier with no notice owed', () => {
  const steps = (setup: string) => WORKLOADS.W12.steps(w12Ctx(setup));
  const at = (setup: string, name: string) => steps(setup).find((s) => s.id === `7.${name}`);
  const names = (setup: string) => steps(setup).map((s) => s.id.slice('7.'.length));
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => at(x, 'ws.note')!.watched), [true, false, 'settles']);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => names(x).includes('ws.scan')), [false, true, false], 'on-agent-action looks at the mount after the agent\'s next tool batch, which ws.scan\'s listing is');
  assert.equal(names('H5b').indexOf('ws.scan'), names('H5b').indexOf('ws.note') + 1);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => [at(x, 'judge.err')!.gate!.judged ?? null, at(x, 'judge.err')!.gate!.expect]), [['failed', 'wake'], ['failed', 'none'], [null, 'wake']], 'onError wake by default, skip in H5b, and no judge to ask in H5c');
  assert.ok((at('H5', 'judge.c1')!.messages![0].text as string).includes('[[judge-fails]]'));
  assert.deepEqual(steps('H5c').filter((s) => s.gate?.judged), [], 'no batch goes to a judge that is off');
  assert.deepEqual(['judge.yes', 'judge.no'].map((n) => [at('H5c', n)!.gate!.expect, at('H5c', n)!.addressed]), [['batch', false], ['batch', false]], 'a judge rule wakes as a debounce, its batch addressed to no one');
  assert.deepEqual(['tick', 'tick.priv'].map((n) => [at('H5c', n)!.kind, at('H5c', n)!.replies ?? null, at('H5c', n)!.gate ?? null]), [['advance', null, null], ['advance', null, null]], 'a paused heartbeat ticks at neither, so a request there is one the stand-in can\'t place');
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => [at(x, 'instr.notice')!.gate!.notice ?? null, at(x, 'instr.notice')!.gate!.noticeForm ?? null]), [['host-notice', 'unanswered'], ['host-notice', 'status'], [null, null]]);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => w12Facts(w12Ctx(x).configuration).tier), ['reply', 'status', 'silent']);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => w12Facts(w12Ctx(x).configuration).announces), [true, false, true]);
});

test('H5c\'s fixture server directs no channel lifecycle, so W12 there looks at w12-gc after its close is refused, and the chat message after it is owed no note', () => {
  const names = (x: string) => WORKLOADS.W12.steps(w12Ctx(x)).map((s) => s.id.slice('7.'.length));
  const at = (x: string, n: string) => WORKLOADS.W12.steps(w12Ctx(x)).find((s) => s.id === `7.${n}`);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => w12Facts(w12Ctx(x).configuration).lifecycle), [true, true, false]);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => names(x).includes('gc.look')), [false, false, true]);
  assert.equal(names('H5c').indexOf('gc.look'), names('H5c').indexOf('gc.1') + 1, 'the look comes at the message that passed the limit, so a close decided later shows');
  assert.equal(names('H5c').indexOf('gc.after'), names('H5c').indexOf('gc.look') + 1);
  assert.deepEqual(at('H5c', 'gc.look')!.replies!.flatMap((r) => r.calls ?? []).map((c) => c.name), ['channel_list']);
  assert.deepEqual(['H5', 'H5b', 'H5c'].map((x) => at(x, 'gc.seen')!.gate!.notice ?? null), ['subscription-gc', 'subscription-gc', null]);
});

test('W12 judges set_channel_mode\'s answer by whether the fixture server directs its channels\' lifecycle, and where it doesn\'t, subscription-gc\'s refused close by channel_list\'s look, no alert and no note', () => {
  const flags = (setup: string, log: Logged[], records: Rec[] = []) => WORKLOADS.W12.check({ log, records } satisfies DeepPartial<Run> as unknown as Run, w12Ctx(setup)).map((f) => f.message);
  const about = (re: RegExp) => (fs: string[]) => fs.filter((m) => re.test(m));
  const mode = about(/^set_channel_mode answered|set_channel_mode's answer/);
  assert.deepEqual(mode(flags('H5', w12Log(7))), []);
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false }))), []);
  assert.deepEqual(mode(flags('H5', w12Log(7, { mode: MODE_PARTIAL }))), [`set_channel_mode answered that it failed (${MODE_PARTIAL.data.message}), where the fixture server directs its channels' lifecycle, so opening w12-mode and each step succeed`]);
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false, mode: MODE_WHOLE }))), ['set_channel_mode answered that every step succeeded, where on a fixture server that doesn\'t direct its channels\' lifecycle opening w12-mode fails and the channel is only partly in debounced mode']);
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false, mode: { ...MODE_PARTIAL, data: { ...MODE_PARTIAL.data, message: 'Channel w12-mode: the gate refused the rule.' } } }))), ['set_channel_mode answered "Channel w12-mode: the gate refused the rule." with its steps open failed, gate-policy ok, gc-pin ok, where on a fixture server that doesn\'t direct its channels\' lifecycle opening w12-mode fails and the channel is only partly in debounced mode'], 'words other than the partial answer\'s aren\'t it');
  assert.deepEqual(mode(flags('H5', w12Log(7, { mode: null }))), ['couldn\'t judge: set_channel_mode\'s answer reached the host\'s trace at no step']);
  const partial = (data: object) => ({ ...MODE_PARTIAL, data: { ...MODE_PARTIAL.data, ...data } });
  const why = 'where on a fixture server that doesn\'t direct its channels\' lifecycle opening w12-mode fails and the channel is only partly in debounced mode';
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false, mode: partial({ steps: [{ step: 'open', ok: true }, { step: 'gate-policy', ok: false }, { step: 'gc-pin', ok: true }] }) }))), [`set_channel_mode answered "${MODE_PARTIAL.data.message}" with its steps open ok, gate-policy failed, gc-pin ok, ${why}`], 'partial for another step\'s failure isn\'t the refused open');
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false, mode: partial({ steps: [{ step: 'open', ok: false }, { step: 'gate-policy', ok: false }, { step: 'gc-pin', ok: true }] }) }))), [`set_channel_mode answered "${MODE_PARTIAL.data.message}" with its steps open failed, gate-policy failed, gc-pin ok, ${why}`], 'the refused open is the one step that failed');
  assert.deepEqual(mode(flags('H5c', w12Log(7, { lifecycle: false, added: false, mode: partial({ channelId: 'w12-other' }) }))), [`set_channel_mode answered "${MODE_PARTIAL.data.message}" about w12-other, ${why}`], 'the answer is about w12-mode');
  const refused = about(/^channel_list|\[subscription-gc\] note|close alert/);
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false }))), []);
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false, look: { open: false, desired: 'closed' } }))), ['channel_list shows w12-gc open: false, desired: closed, where subscription-gc\'s close is decided and the server, directing no lifecycle, keeps the channel open']);
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false, look: { open: true, desired: 'open' } }))), ['channel_list shows w12-gc open: true, desired: open, where subscription-gc\'s close is decided and the server, directing no lifecycle, keeps the channel open'], 'positive evidence: the close was decided');
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false, look: null }))), [], 'no look is no list to judge');
  assert.ok(flags('H5c', w12Log(7, { lifecycle: false, added: false, look: null })).includes('couldn\'t judge: channel_list\'s answer at gc.look reached the host\'s trace at no step, or listed no channels'));
  const unlisted = w12Log(7, { lifecycle: false, added: false, look: null }).concat([{ kind: 'ipc', step: '7.gc.look', event: { type: 'process:received', processEvent: { type: 'tool-result', toolName: 'channel_list', result: { success: true, data: [{ id: 'chat', open: true, desired: 'open' }] } } } }]);
  const judgedOf = (log: Logged[]) => WORKLOADS.W12.check({ log, records: [] } satisfies DeepPartial<Run> as unknown as Run, w12Ctx('H5c')).judged;
  assert.equal(judgedOf(w12Log(7, { lifecycle: false, added: false })) - judgedOf(w12Log(7, { lifecycle: false, added: false, look: null })), 1, 'a look that never came isn\'t counted as judged');
  assert.deepEqual(refused(flags('H5c', unlisted)), ['channel_list names no w12-gc, where subscription-gc\'s close is decided and the server, directing no lifecycle, keeps the channel open'], 'a list without the channel is a list');
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false, gcAt: ['gc.1'] }))), ['subscription-gc raised its close alert 1 time(s), where on a server that doesn\'t direct its channels\' lifecycle no close goes through']);
  const noted: Rec = { id: 'rg', kind: 'agent', step: '7.gc.seen', messages: [msg('user', text(), { type: 'text', chars: 10, notice: 'subscription-gc' })] };
  assert.deepEqual(refused(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [noted])), ['request rg carries a [subscription-gc] note, where no close went through to note']);
  assert.deepEqual(refused(flags('H5', w12Log(7), [noted])), [], 'under the grant the note is owed, and judged by its step');
});

test('W12 judges where the watched file\'s change reaches the workspace by its setup\'s watch, the message it adds by its wakeOnChange, one subscription-gc close at the message passing w12-gc\'s own limit, no orphan notice where announceOrphans is off, and no host notice under the silent tier', () => {
  const flags = (setup: string, log: Logged[], records: Rec[] = []) => WORKLOADS.W12.check({ log, records } satisfies DeepPartial<Run> as unknown as Run, w12Ctx(setup)).map((f) => f.message);
  const about = (re: RegExp) => (fs: string[]) => fs.filter((m) => re.test(m));
  const note = about(/w12-note\.txt|added a message for the resident/);
  assert.deepEqual(note(flags('H5', w12Log(7))), []);
  assert.deepEqual(note(flags('H5', w12Log(7, { noteAt: 'ws.config' }))), ['watched/w12-note.txt\'s change reached the workspace at step 7.ws.config, where its mount\'s watch, always, brings it at 7.ws.note']);
  assert.deepEqual(note(flags('H5', w12Log(7, { added: false }))), ['watched/w12-note.txt\'s change added no message for the resident at its step, where wakeOnChange takes a created file']);
  assert.deepEqual(note(flags('H5b', w12Log(7, { noteAt: 'ws.scan' }))), []);
  assert.deepEqual(note(flags('H5b', w12Log(7))), ['watched/w12-note.txt\'s change reached the workspace at step 7.ws.note, where its mount\'s watch, on-agent-action, brings it at 7.ws.scan']);
  assert.deepEqual(note(flags('H5c', w12Log(7, { lifecycle: false, added: false }))), []);
  assert.deepEqual(note(flags('H5c', w12Log(7, { lifecycle: false }))), ['the workspace added a message for the resident at step 7.ws.note, where wakeOnChange (["deleted"]) takes no created file']);
  assert.deepEqual(note(flags('H5', [])), ['couldn\'t judge: watched/w12-note.txt\'s change reached the workspace at no step']);
  const gc = about(/subscription-gc closed/);
  assert.deepEqual(gc(flags('H5', w12Log(7))), []);
  assert.deepEqual(gc(flags('H5', w12Log(7, { gcAt: ['gc.1', 'gc.after'] }))), ['subscription-gc closed a channel 2 time(s), w12-gc at 7.gc.1, w12-gc at 7.gc.after, where the message passing w12-gc\'s own limit closes w12-gc once, at its step']);
  assert.deepEqual(gc(flags('H5', w12Log(7, { gcAt: [] }))), ['subscription-gc closed a channel 0 time(s), where the message passing w12-gc\'s own limit closes w12-gc once, at its step']);
  assert.deepEqual(gc(flags('H5', w12Log(7, { gcChannel: 'chat' }))), ['subscription-gc closed a channel 1 time(s), chat at 7.gc.1, where the message passing w12-gc\'s own limit closes w12-gc once, at its step'], 'the close at the step is w12-gc\'s');
  const judging = about(/where with the judge off/);
  assert.deepEqual(judging(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [{ id: 'jx', kind: 'judge', step: '7.judge.yes', batch: [], answer: { shape: 'verdict', verdict: 'reply' } }])), ['jx went to the reply judge, where with the judge off no batch goes to it']);
  assert.deepEqual(judging(flags('H5', w12Log(7), [{ id: 'jx', kind: 'judge', step: '7.judge.yes', batch: [], answer: { shape: 'verdict', verdict: 'reply' } }])), [], 'with the judge on, its requests are judged by their steps');
  const told = (n: number): Rec => ({ id: 'rn', kind: 'agent', step: '7.instr.notice', messages: [msg('user', text(), ...Array.from({ length: n }, () => ({ type: 'text', chars: 10, notice: 'host-notice' })))] });
  const silent = about(/silent tier/);
  assert.deepEqual(silent(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [told(1)])), ['request rn carries a [host-notice] line, where the silent tier for instructions-unavailable tells the agent nothing']);
  assert.deepEqual(silent(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [told(0)])), []);
  assert.deepEqual(silent(flags('H5', w12Log(7), [told(1)])), [], 'the reply tier owes the line');
  assert.deepEqual(silent(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [{ ...told(1), id: 'rs', agent: 'w12-s1-7' }])), ['request rs carries a [host-notice] line, where the silent tier for instructions-unavailable tells the agent nothing'], 'a subagent\'s request is held to it too');
  const unalerted = about(/no instructions-unavailable alert/);
  assert.deepEqual(unalerted(flags('H5c', w12Log(7, { lifecycle: false, added: false, alerted: false }), [told(0)])), ['the host raised no instructions-unavailable alert between the instructions\' removal and their return, so the silent tier had no notice to keep from the resident'], 'with no alert, no notice proves nothing');
  assert.deepEqual(unalerted(flags('H5c', w12Log(7, { lifecycle: false, added: false }), [told(0)])), []);
  const lived = { type: 'text', chars: 10, notice: 'Agent lifecycle' };
  const orphaned = (n: number): Rec[] => [
    { id: 'o1', kind: 'agent', step: '7.orphan', messages: [msg('user', text(['[[c:7.orphan.in]]']))] },
    { id: 'o2', kind: 'agent', step: '7.orphan', messages: [msg('user', text(), ...Array.from({ length: n }, () => lived))] },
    { id: 'o3', kind: 'agent', step: '7.subs.list', messages: [msg('user', text(['[[c:7.subs.list.in]]']))] },
  ];
  const orphan = about(/Agent lifecycle/);
  assert.deepEqual(orphan(flags('H5b', w12Log(7, { noteAt: 'ws.scan' }), orphaned(0))), []);
  const unorphaned = about(/orphan/);
  assert.deepEqual(unorphaned(flags('H5b', w12Log(7, { noteAt: 'ws.scan', orphanTo: null }), orphaned(0))), ['agent-framework traced no orphaning of w12-s2-7 at the step, where its end orphans it with fixture first to adopt it, so dendrite.announceOrphans false has a notice to keep back'], 'a second subagent stopped rather than orphaned leaves no notice to keep back either');
  const later: Rec[] = [...orphaned(0), { id: 'o4', kind: 'agent', step: '7.stall', messages: [msg('user', text(['[[c:7.stall.in]]']), lived)] }];
  assert.deepEqual(orphan(flags('H5b', w12Log(7, { noteAt: 'ws.scan' }), later)), ['request o4 carries 1 [Agent lifecycle] notice(s), where dendrite.announceOrphans false tells the agent of no orphan'], 'any of the agent\'s requests, not just the two after the orphan');
  assert.deepEqual(unorphaned(flags('H5b', w12Log(7, { noteAt: 'ws.scan', orphanTo: ['someone'] }), orphaned(0))), ['agent-framework offered w12-s2-7\'s orphaned work first to someone at the step, where its end orphans it with fixture first to adopt it, so dendrite.announceOrphans false has a notice to keep back']);
  assert.deepEqual(orphan(flags('H5b', w12Log(7, { noteAt: 'ws.scan' }), orphaned(1))), ['request o2 carries 1 [Agent lifecycle] notice(s), where dendrite.announceOrphans false tells the agent of no orphan']);
  assert.equal(orphan(flags('H5', w12Log(7), orphaned(0))).length, 1, 'where it\'s on, the offer is owed');
});

test('W12 leaves out the suppression stretch, its rule and its review where the host\'s agent-framework brings no suppression, with a step naming it absent, and refuses to run where that couldn\'t be told', () => {
  const of = (capabilities: Facts['capabilities']) => runOf('H5/W12', configurations(), { budget: 100_000, maxTokens: 16_000, capabilities });
  const rules = (job: ReturnType<typeof of>) => (job.configuration.modules!.wake as { policies: Array<{ name: string }> }).policies.map((r) => r.name);
  const present = of({ suppression: true, onboarding: true });
  assert.ok(rules(present).includes('w12-mute') && rules(present).includes('w12-mute-text'), 'the channel rule the review reads, and the text rule console input passes over');
  assert.deepEqual(present.steps().filter((s) => /\.(mute\.\d|review)$/.test(s.id)).map((s) => s.kind), ['deliver', 'deliver', 'advance']);
  const absent = of({ suppression: false, onboarding: true });
  assert.ok(!rules(absent).includes('w12-mute'));
  const steps = absent.steps();
  assert.deepEqual(steps.filter((s) => /\.(mute\.\d|review)$/.test(s.id)), []);
  assert.deepEqual(steps.filter((s) => s.kind === 'absent').map((s) => s.stretch), ['suppression']);
  assert.ok(!JSON.stringify(steps).includes('w12-mute'), 'not even gate.json\'s rewrite names the rule');
  assert.ok(!JSON.stringify(steps).includes('[[mute]]'), 'and no message carries the mute mark, console.2 included');
  assert.ok(rules(present).includes('w12-quiet') && present.configuration.fixtureOntology, 'with onboarding, the rule that lets a server\'s events by undecided, and the fixture server\'s tag ontology');
  const offered = (present.steps() as W12Step[]).filter((s) => /\.(onboard|decline)\.\w+$/.test(s.id));
  assert.deepEqual(offered.map((s) => [s.id.slice(s.id.indexOf('.') + 1), s.messages![0].server ?? 'fixture', s.gate!.expect]), [['onboard.offer', 'fixture', 'wake'], ['onboard.after', 'fixture', 'wake'], ['decline.offer', 'quiet', 'wake'], ['decline.after', 'quiet', 'none']]);
  assert.deepEqual((present.steps() as W12Step[]).filter((s) => s.gate?.notice).map((s) => [s.id.slice(s.id.indexOf('.') + 1), s.gate!.notice]), [['onboard.offer', 'wake onboarding'], ['decline.offer', 'wake onboarding'], ['gc.seen', 'subscription-gc'], ['instr.notice', 'host-notice']], 'each onboarding offer owes the onboarding notice in the request it starts, subscription-gc\'s close its note, and the instructions\' return the host\'s notice');
  const unonboarded = of({ suppression: true, onboarding: false });
  assert.ok(!rules(unonboarded).includes('w12-quiet') && !unonboarded.configuration.fixtureOntology);
  assert.deepEqual(unonboarded.steps().filter((s) => s.kind === 'absent').map((s) => s.stretch), ['onboarding']);
  assert.ok(!unonboarded.steps().some((s) => (s.messages ?? []).some((m) => m.server)), 'and no message goes to a second server');
  assert.throws(() => of({ unreadable: 'couldn\'t tell what the installed agent-framework brings: x' }), /couldn't tell what the installed agent-framework brings: x/);
  assert.throws(() => of({}).steps(), /couldn't tell whether the installed agent-framework brings suppression/);
});

test('H5/W12\'s heartbeat\'s next tick follows console.3, the console\'s fourth message there after priv.fork\'s, before the history stretch, and its first round holds its call while console input arrives, judged as a tick', () => {
  const job = runOf('H5/W12', configurations(), { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true } });
  const steps = job.steps();
  const at = steps.findIndex((s) => s.id === `${job.seed}.tick.priv`);
  assert.equal(steps[at - 1].id, `${job.seed}.console.3`);
  assert.equal(steps[at + 1].id, `${job.seed}.hist.send`);
  const tick = steps[at];
  assert.deepEqual([tick.kind, tick.ms, tick.gate], ['advance', 5_400_000, { expect: 'self', rule: 'the heartbeat\'s tick', canaries: [] }]);
  const [held, last] = tick.replies!;
  assert.equal(held.hold, true);
  assert.deepEqual((held.calls as Call[]).map((c) => [c.name, c.input!.canary]), [['mcpl--fixture--result', `[[c:${job.seed}.tick.priv.call1]]`]]);
  assert.deepEqual(held.during!.map((a) => a.console!.id), [`${job.seed}.tick.priv.con`]);
  assert.match(held.during![0].console!.text, new RegExp(`^\\[\\[c:${job.seed}\\.tick\\.priv\\.con\\.in\\]\\] `));
  assert.match(held.text!, new RegExp(`^\\[\\[c:${job.seed}\\.tick\\.priv\\.r1\\]\\] `));
  assert.match(last.text!, new RegExp(`^\\[\\[c:${job.seed}\\.tick\\.priv\\.r2\\]\\] `));
  assert.deepEqual(tick.spare, [{ calls: [{ name: 'skip_reply', input: {} }] }], 'the console input\'s own wake');
});

test('W12\'s history stretch, under H5, also publishes words the fixture refuses to post, then finds them in the history and reads them back in text form, judged as the first send is', () => {
  for (const setup of ['H5b', 'H5c']) assert.ok(!WORKLOADS.W12.steps(w12Ctx(setup)).some((s) => /\.hist\.(fail|read2)$/.test(s.id)), `${setup} compresses with them, at a budget the host fits to the model's window, or would only cost`);
  for (const setup of ['H5']) {
    const steps = WORKLOADS.W12.steps(w12Ctx(setup));
    const names = steps.map((s) => s.id.slice('7.'.length));
    const at = names.indexOf('hist.read');
    assert.deepEqual(names.slice(at, at + 3), ['hist.read', 'hist.fail', 'hist.read2'], setup);
    const [fail, read2] = [steps[at + 1], steps[at + 2]];
    const [publish, skip] = fail.replies!;
    assert.equal(fail.replies!.length, 2);
    assert.deepEqual((publish.calls as Call[]).map((c) => [c.name, c.input!.channelId]), [['channel_publish', 'chat']]);
    assert.match((publish.calls as Call[])[0].input!.content as string, /^\[\[c:7\.hist\.fail\.sent\]\] .* \[\[fail-publish\]\]$/, 'the fixture server answers a publish carrying the mark as not delivered');
    assert.deepEqual(skip.calls, [{ name: 'skip_reply', input: {} }]);
    assert.ok(fail.namedAnywhere && read2.namedAnywhere);
    assert.equal(read2.history, '[[c:7.hist.fail.sent]]', 'judged as hist.read is: the search\'s result and the extract\'s text each carry the sent words');
    assert.deepEqual(read2.replies![0].calls, [{ name: 'history--search', input: { query: '[[c:7.hist.fail.sent]]', limit: 1 } }]);
    const found: Message[] = [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: '{"matches":[{"id": "1006"}]}' }] }] }];
    assert.deepEqual((read2.replies![1].calls as (messages: Message[]) => Call[])(found), [{ name: 'history--extract', input: { aroundId: '1006', before: 0, after: 0, format: 'text' } }]);
  }
});

test('a partly answered batch opens its turn with every event the agent hadn\'t read, however many there are', () => {
  const steps = [{ id: 'x.fire', gate: { expect: 'batch', canaries: ['[[c:a]]', '[[c:b]]', '[[c:c]]'], read: ['[[c:a]]'] } }] satisfies DeepPartial<W12Step>[] as unknown as W12Step[];
  const ran = (...carried: string[]) => gateFates({ records: [{ id: 'r1', kind: 'agent', step: 'x.fire', messages: [msg('user', text(['[[c:a]]'])), msg('user', ...carried.map((c) => text([c])))] }] } satisfies DeepPartial<Run> as unknown as Run, steps).map((f) => f.message);
  assert.deepEqual(ran('[[c:b]]', '[[c:c]]'), []);
  assert.deepEqual(ran('[[c:b]]'), ['request r1 opens the batch\'s turn without all 2 of the events the agent hadn\'t read']);
  assert.deepEqual(ran('[[c:b]]', '[[c:c]]', '[[c:a]]'), [], 'the event it read may come too');
});

test('W12, where the judge wakes on an error, also fails it on a batch the agent has read and answered in the judge\'s channel, judged as an answered batch: its judge request fails, and it starts one turn at most, its reply a spare', () => {
  const names = (setup: string) => WORKLOADS.W12.steps(w12Ctx(setup)).map((s) => s.id.slice('7.'.length));
  const at = (setup: string, n: string) => WORKLOADS.W12.steps(w12Ctx(setup)).find((s) => s.id === `7.${n}`);
  const i = names('H5').indexOf('judge.err');
  assert.deepEqual(names('H5').slice(i, i + 4), ['judge.err', 'judge.c2', 'judge.read2', 'judge.err2']);
  assert.deepEqual([at('H5', 'judge.c1')!.messages![0].tags, at('H5', 'judge.err')!.gate!.expect], [undefined, 'wake'], 'the unread failed batch still wakes the agent carrying it');
  for (const setup of ['H5b', 'H5c']) assert.ok(!['judge.c2', 'judge.read2', 'judge.err2'].some((n) => names(setup).includes(n)), `${setup}: a judge that skips on an error, or none, wakes nothing either way`);
  const c2 = at('H5', 'judge.c2');
  assert.deepEqual([c2!.messages![0].channel, c2!.messages![0].tags, c2!.gate!.expect], ['w12-judge', ['chat:addressed'], 'none']);
  assert.ok((c2!.messages![0].text as string).includes('[[judge-fails]]'));
  const read = at('H5', 'judge.read2');
  assert.deepEqual([read!.messages![0].channel, read!.gate!.expect, read!.namedAnywhere], ['w12-always', 'wake', true]);
  assert.deepEqual(read!.replies!.map((r) => ((r.calls ?? []) as Call[]).map((c) => [c.name, c.input!.channelId ?? null])), [[['channel_publish', 'w12-judge']], [['skip_reply', null]]], 'it answers in the channel a reply was owed in, with no words of its own');
  assert.doesNotMatch((read!.replies![0].calls as Call[])[0].input!.content as string, /\[\[c:/, 'no canary in a call\'s input, which a record doesn\'t name, so check 13 can pair the judge\'s wake by its newest canary');
  const err = at('H5', 'judge.err2');
  assert.deepEqual([err!.kind, err!.ms, err!.verdict, err!.addressed], ['advance', 61_000, 'w12-judge', false]);
  assert.deepEqual(err!.gate, { expect: 'answered-batch', rule: 'w12-judge', judged: 'failed', canaries: ['[[c:7.judge.c2.in]]'], read: ['[[c:7.judge.c2.in]]'] });
  assert.deepEqual([err!.replies, err!.spare?.length, err!.also, err!.namedAnywhere], [undefined, 1, undefined, true], 'its spare answers a wake the batch\'s read canary names anywhere, with a gate line or without');
});

test('W12 under H5 spawns a subagent from a console turn after the history stretch, without waiting, its turn\'s last request held until the subagent\'s result is stored, so the result wakes a turn of its own', () => {
  const steps = (setup: string) => WORKLOADS.W12.steps(w12Ctx(setup));
  const names = (setup: string) => steps(setup).map((s) => s.id.slice('7.'.length));
  const h = names('H5').indexOf('hist.read2');
  assert.deepEqual(names('H5').slice(h + 1, h + 3), ['priv.spawn', 'orphan']);
  for (const setup of ['H5b', 'H5c']) assert.ok(!names(setup).includes('priv.spawn'), setup);
  const naming = (setup: string) => steps(setup).filter((s) => s.gate?.naming).map((s) => s.id.slice('7.'.length));
  assert.deepEqual(['H5', 'H5b', 'H5c'].map(naming), [['console.2'], ['console.3'], ['console.3']], 'the spawn\'s console message comes after the third, which brings the naming request: under H5 the fork\'s is the first');
  const s = steps('H5').find((x) => x.id === '7.priv.spawn');
  assert.deepEqual([s!.kind, s!.addressed, s!.namedAnywhere, s!.gate], ['console', false, true, { expect: 'wake', rule: 'default', canaries: ['[[c:7.priv.spawn.in]]'] }]);
  assert.equal(s!.replies!.length, 3);
  const [call, closing, after] = s!.replies!;
  assert.deepEqual((call.calls as Call[]).map((c) => c.name), ['subagent--spawn']);
  assert.equal((call.calls as Call[])[0].input!.sync, undefined, 'async, so its result comes back as private work\'s input of its own');
  assert.ok(((call.calls as Call[])[0].input!.systemPrompt as string).startsWith(`${s!.subs![0].marker} `));
  assert.ok(((call.calls as Call[])[0].input!.task as string).startsWith('[[c:7.priv.spawn.task]] '));
  assert.match(closing.text!, /^\[\[c:7\.priv\.spawn\.r2\]\] /, 'it speaks, as a resident would, though the host has no channel for it');
  assert.equal(closing.calls, undefined);
  assert.deepEqual([closing.hold, closing.during], [true, [{ agentEnd: 'priv-spawn-7' }]], 'the turn\'s last request is held until the subagent\'s result is stored for the resident, as W14\'s turn end holds its arrival');
  assert.deepEqual(s!.arrivals, [{ canary: '[[c:7.priv.spawn.s1]]', point: 'end', after: '[[c:7.priv.spawn.r2]]', agent: 'priv-spawn-7' }], 'so the result is first carried by the turn its wake starts, after the closing words');
  assert.match(after.text!, /^\[\[c:7\.priv\.spawn\.r3\]\] /, 'the turn its result wakes');
  assert.deepEqual(s!.subs!.map((x) => [x.canaries, x.replies!.length, x.replies![0].hold, x.replies![0].during, x.replies![0].settle]), [[['[[c:7.priv.spawn.task]]'], 1, true, [{ asked: 'primary', n: 2 }], undefined]], 'the subagent answers once the turn\'s last request has arrived, so its result is always stored while that request is held, as orphanTurn holds its second subagent');
});

test('W12 under H5 forks from a console turn right after the settings turn, without waiting, held as the spawn is, so the fork\'s result wakes a turn of its own', () => {
  const steps = (setup: string) => WORKLOADS.W12.steps(w12Ctx(setup));
  const names = (setup: string) => steps(setup).map((s) => s.id.slice('7.'.length));
  assert.deepEqual(names('H5').slice(0, 3), ['set', 'priv.fork', 'always'], 'early, while the fork\'s inherited context is under its budget');
  for (const setup of ['H5b', 'H5c']) assert.ok(!names(setup).includes('priv.fork'), setup);
  const s = steps('H5').find((x) => x.id === '7.priv.fork');
  assert.deepEqual([s!.kind, s!.addressed, s!.namedAnywhere, s!.gate], ['console', false, true, { expect: 'wake', rule: 'default', canaries: ['[[c:7.priv.fork.in]]'] }]);
  const [call, closing, after] = s!.replies!;
  assert.equal(s!.replies!.length, 3);
  assert.deepEqual((call.calls as Call[]).map((c) => [c.name, c.input!.name, c.input!.sync]), [['subagent--fork', 'priv-fork-7', undefined]], 'async, so its result comes back as private work\'s input of its own');
  assert.ok(((call.calls as Call[])[0].input!.systemPrompt as string).startsWith(`${s!.subs![0].marker} `));
  assert.ok(((call.calls as Call[])[0].input!.task as string).startsWith('[[c:7.priv.fork.task]] '));
  assert.match(closing.text!, /^\[\[c:7\.priv\.fork\.r2\]\] /);
  assert.deepEqual([closing.hold, closing.during], [true, [{ agentEnd: 'priv-fork-7' }]], 'the turn\'s last request is held until the fork\'s result is stored for the resident');
  assert.deepEqual(s!.arrivals, [{ canary: '[[c:7.priv.fork.s1]]', point: 'end', after: '[[c:7.priv.fork.r2]]', agent: 'priv-fork-7' }]);
  assert.match(after.text!, /^\[\[c:7\.priv\.fork\.r3\]\] /, 'the turn its result wakes');
  assert.deepEqual(s!.subs!.map((x) => [x.canaries, x.replies!.length, x.replies![0].hold, x.replies![0].during, x.replies![0].settle]), [[['[[c:7.priv.fork.task]]'], 1, true, [{ asked: 'primary', n: 2 }], undefined]], 'the fork answers once the turn\'s last request has arrived, so its result is always stored while that request is held');
});
