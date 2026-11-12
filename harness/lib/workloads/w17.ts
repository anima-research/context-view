import { FIXTURE_AGENT, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL, TOOL } from '../strategies/script.ts';
import { SIZES, writer } from './turns.ts';
import { arrivalFates } from './fates.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { Act, Call, Reply, Step } from '../strategies/script.ts';
import type { Breach } from './fates.ts';
import type { Writer } from './turns.ts';
import type { Run, Workload } from './workloads.ts';

type W17Fields = { message?: string; notice?: string; result?: string };
export type W17Step = Step & { w17?: W17Fields };
type Built = W17Step & { replies: Reply[]; canaries: string[] };
type Options = { rounds?: Call[][]; ends?: boolean; addressed?: boolean; w17?: W17Fields };

const W17_CHANNELS = { chat: {}, other: {}, side: { initiallyOpen: false }, feed: { direction: 'inbound', initiallyOpen: false } };
const W17_VOICE = 'You read what the resident holds while it focuses, and tell it what matters.';

function w17Writer(w: Writer) {
  const said = (step: string, k: number) => `${w.c(step, `r${k}`)} ${prose(w.between(SIZES.reply), `${w.id(step)}:r${k}`)}`;
  const replies = (step: string, rounds: Call[][], ends: boolean): Reply[] => [...rounds.map((calls, k) => ({ text: said(step, k + 1), calls })), ...(ends ? [] : [{ text: said(step, rounds.length + 1) }])];
  const deliver = (step: string, channel: string, { rounds = [], ends = false, addressed = false, w17 = {} }: Options = {}): Built => ({
    id: w.id(step), segment: 'W17', kind: 'deliver', topic: 'W17',
    messages: [{ channel, id: w.id(step), participant: 'Tavy', text: `${w.c(step, 'in')} ${prose(w.between(SIZES.user), `${w.id(step)}:in`)}`, ...(addressed ? { tags: ['chat:addressed'] } : {}) }],
    canaries: [w.c(step, 'in')], namedAnywhere: true, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 },
  });
  const wake = (step: string, ms: number, after: string, w17?: W17Fields): Built => ({ id: w.id(step), segment: 'W17', kind: 'advance', ms, canaries: [w.c(after, 'in')], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said(step, 1) }], w17 });
  const text = (step: string, part: string) => `${w.c(step, part)} ${prose(w.between(SIZES.user), `${w.id(step)}:${part}`)}`;
  const turn = (step: string, channel: string, { rounds = [], ends = false, addressed = false, w17 = {} }: Options = {}): Built => ({
    id: w.id(step), segment: 'W17', kind: 'channel', channel, participant: 'Tavy', topic: 'W17', text: text(step, 'in'), ...(addressed ? { tags: ['chat:addressed'] } : {}),
    canaries: [w.c(step, 'in')], namedAnywhere: true, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 },
  });
  const typed = (step: string, rounds: Call[][], { ends = true, w17 = {} }: Pick<Options, 'ends' | 'w17'> = {}): Built => ({ id: w.id(step), segment: 'W17', kind: 'console', text: text(step, 'in'), canaries: [w.c(step, 'in')], namedAnywhere: true, addressed: false, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 } });
  const consoleAct = (step: string, part: string): Act => ({ console: { id: `${w.id(step)}.${part}`, text: text(step, `${part}.in`) } });
  const deliverAct = (step: string, part: string, channel: string, { addressed = false, participant = 'Ash' } = {}): Act => ({ deliver: { channel, id: `${w.id(step)}.${part}`, participant, text: text(step, `${part}.in`), ...(addressed ? { tags: ['chat:addressed'] } : {}) } });
  return { deliver, wake, turn, typed, consoleAct, deliverAct, said, c: w.c, id: w.id };
}

export const W17 = {
  from: null,
  compresses: false,
  property: 'inputs: each step\'s first request carries its message, where it has one, and the notice it names by its opening tag, the closed-channel invitation, a [routing] notice or the [self-wake] line, in its last message; the request after the call a step names as its result carries that result in its last message; and each input a held request lets arrive, a message typed at the console or on a channel or a reader fork\'s summary, is first carried by the request its point gives',
  recipe: { fixtureChannels: W17_CHANNELS, subconscious: { enabled: true, reader: 'forks', model: 'claude-opus-4-6', voice: W17_VOICE } },
  steps(ctx): W17Step[] {
    const w = writer(ctx, 'W17');
    const s = w17Writer(w);
    const meet = s.turn('meet', CHANNEL);
    meet.replies = [{ ...meet.replies[0], hold: true, during: [s.consoleAct('meet', 'con'), s.deliverAct('meet', 'a', CHANNEL)] }, { text: s.said('meet', 2) }];
    meet.canaries.push(s.c('meet', 'con.in'), s.c('meet', 'a.in'));
    meet.arrivals = [{ canary: s.c('meet', 'con.in'), point: 'end', after: s.c('meet', 'r1'), console: true, message: `${s.id('meet')}.con` }, { canary: s.c('meet', 'a.in'), point: 'end', after: s.c('meet', 'r1'), message: `${s.id('meet')}.a` }];
    const priv = s.deliver('priv', CHANNEL, { w17: { result: 'channel_publish' } });
    const call1 = { name: TOOL, input: { kind: 'prose', size: 400, canary: s.c('priv', 'call1') } };
    priv.replies = [
      { text: s.said('priv', 1), calls: [call1], hold: true, during: [s.consoleAct('priv', 'con')] },
      { calls: [{ name: 'channel_publish', input: { content: `${s.c('priv', 'pub')} ${prose(300, `${s.id('priv')}:pub`)}` } }] },
      { text: s.said('priv', 3), calls: [{ name: 'skip_reply', input: {} }] },
      { text: s.said('priv', 4), calls: [{ name: 'skip_reply', input: {} }] },
    ];
    priv.canaries.push(s.c('priv', 'con.in'), s.c('priv', 'call1'));
    priv.arrivals = [{ canary: s.c('priv', 'con.in'), point: 'boundary', after: s.c('priv', 'call1'), console: true, message: `${s.id('priv')}.con` }];
    const nowhere = s.wake('close.wake', 121_000, 'close', { notice: 'routing' });
    nowhere.replies = [{ text: s.said('close.wake', 1), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: s.c('close.wake', 'call1') } }], hold: true, during: [s.deliverAct('close.wake', 'a', 'other', { addressed: true, participant: 'Wren' })] }, { text: s.said('close.wake', 2) }];
    nowhere.canaries = [...nowhere.canaries, s.c('close.wake', 'a.in'), s.c('close.wake', 'call1')];
    nowhere.spare = [{ text: `${s.c('close.wake', 'spare')} ${prose(200, `${s.id('close.wake')}:spare`)}` }];
    nowhere.arrivals = [{ canary: s.c('close.wake', 'a.in'), point: 'boundary', after: s.c('close.wake', 'call1'), routing: true, message: `${s.id('close.wake')}.a` }];
    const steps: W17Step[] = [
      meet,
      priv,
      s.deliver('side', 'side', { addressed: true, w17: { notice: 'Channel invitation' } }),
      s.deliver('feed.early', 'feed', { addressed: true, rounds: [[{ name: 'skip_reply', input: {} }]], ends: true, w17: { notice: 'Channel invitation' } }),
      s.deliver('feed.open', CHANNEL, { rounds: [[{ name: 'channel_open', input: { channelId: 'feed' } }], [{ name: 'skip_reply', input: {} }]], ends: true, w17: { result: 'channel_open' } }),
      s.deliver('close', CHANNEL, { rounds: [[{ name: 'channel_close', input: { channelId: CHANNEL } }], [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }]], ends: true, w17: { result: 'channel_close' } }),
      nowhere,
      s.deliver('feed.in', 'feed', { addressed: true, rounds: [[{ name: 'skip_reply', input: {} }]], ends: true, w17: { notice: 'routing' } }),
      s.typed('self', [[{ name: 'skip_reply', input: { wake_in_seconds: 120 } }]]),
      s.wake('self.wake', 121_000, 'self', { notice: 'self-wake' }),
      // Other sources of private input after a console message (agent-framework#190): a sleep's end and an operator's
      // nudge.
      s.typed('sleep', [[{ name: 'sleep', input: { seconds: 120 } }]]),
      s.wake('sleep.wake', 121_000, 'sleep'),
      s.typed('nudge.in', [[{ name: 'skip_reply', input: {} }]]),
      { id: s.id('nudge'), segment: 'W17', kind: 'host', host: { command: 'nudge' }, inputs: [], canaries: [s.c('nudge.in', 'in')], namedAnywhere: true, addressed: false, replies: [{ text: s.said('nudge', 1) }] },
      s.deliver('focus', 'other', { rounds: [[{ name: 'focus', input: { channelId: 'other', durationSeconds: 3600 } }]], w17: { result: 'focus' } }),
    ];
    // A tune-out's cancel after a message typed at the console, another of agent-framework#190's sources of private
    // input: agent-framework derives a reader fork inside the agent's tune_out call to look at the cancel, and the
    // fork's summary is mail to the resident, held as W12's priv.spawn holds its subagent's result. Its two steps are
    // written after the others, so every other step keeps the sizes it drew without them, and they run before focus,
    // whose focus on other comes after the tune-out of other has ended.
    const tune = s.typed('tune', [[{ name: 'tune_out', input: { channelId: 'other', durationSeconds: 3600 } }]], { ends: false });
    const reader = { prefix: `reader/${ctx.configuration?.agent?.name ?? FIXTURE_AGENT}/` };
    const cancel = s.typed('tune.cancel', [[{ name: 'tune_out', input: { mode: 'cancel', channelId: 'other' } }]], { ends: false });
    const read = s.c('tune.cancel', 'read');
    cancel.replies = [cancel.replies[0], { ...cancel.replies[1], hold: true, during: [{ agentEnd: reader }] }, { text: s.said('tune.cancel', 3) }];
    cancel.reader = reader;
    cancel.subs = [{ marker: W17_VOICE, canaries: [s.c('tune.cancel', 'in')], namedAnywhere: true, replies: [{ text: `${read} ${prose(200, `${s.id('tune.cancel')}:read`)}`, hold: true, during: [{ asked: 'primary', n: 2 }] }] }];
    cancel.arrivals = [{ canary: read, point: 'end', after: s.c('tune.cancel', 'r2'), agent: reader.prefix }];
    // Before agent-framework#998 the host takes both: the publish goes to the turn's channel and the skip ends the
    // turn. So the publish's round has no words, which that host would hold as drafts, and the skip's next reply is
    // spare and names no result.
    const pub = s.deliver('pub.num', 'other', { w17: { result: 'channel_publish' } });
    pub.replies = [
      { calls: [{ name: 'channel_publish', input: { channelId: 7, content: `${s.c('pub.num', 'pub')} ${prose(300, `${s.id('pub.num')}:pub`)}` } }] },
      { text: s.said('pub.num', 2), calls: [{ name: 'skip_reply', input: {} }] },
    ];
    const skip = s.deliver('skip.bool', 'other', { rounds: [[{ name: 'skip_reply', input: { reason: true } }]], ends: true });
    skip.spare = [{ text: `${s.c('skip.bool', 'spare')} ${prose(200, `${s.id('skip.bool')}:spare`)}` }];
    return [...steps.slice(0, -1), tune, cancel, steps.at(-1)!, skip, pub];
  },
  check(run, ctx) {
    const steps = this.steps(ctx);
    const [inputs, arrivals] = [inputFates(run, steps), arrivalFates(run, steps)];
    return withJudged([...inputs, ...arrivals], inputs.judged + arrivals.judged);
  },
} satisfies Workload;

function inputFates(run: Run, steps: W17Step[]) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const last = (r: RequestRecord) => r.messages?.at(-1)?.blocks ?? [];
  const out: Breach[] = [];
  let judged = 0;
  for (const s of steps.filter((x) => x.w17) as Array<W17Step & { w17: W17Fields }>) {
    const mine = agent.filter((r) => r.step === s.id);
    if (!mine.length) { out.push({ step: s.id, message: 'couldn\'t judge: the step has no request' }); continue; }
    judged++;
    const [first] = mine;
    if (s.w17.message && !last(first).some((b) => (b.canaries ?? []).includes(s.w17.message!))) out.push({ step: s.id, message: `request ${first.id}, the step's first, doesn't carry ${s.w17.message} in its last message` });
    if (s.w17.notice && !last(first).some((b) => b.notice === s.w17.notice)) out.push({ step: s.id, message: `request ${first.id}, the step's first, carries no [${s.w17.notice}] notice in its last message` });
    if (s.w17.result) {
      const round = s.replies!.findIndex((reply) => ((reply.calls ?? []) as Call[]).some((call) => call.name === s.w17.result));
      const id = mine[round]?.answer?.toolUseIds?.[0];
      const next = mine[round + 1];
      if (!id || !next) out.push({ step: s.id, message: `couldn't judge: the step has no request ${!id ? `answered with its ${s.w17.result} call` : `after the one answered with its ${s.w17.result} call`}` });
      else if (!last(next).some((b) => b.type === 'tool_result' && b.toolUseId === id)) out.push({ step: s.id, message: `request ${next.id} doesn't carry the result of ${s.w17.result} (${id}) in its last message` });
    }
  }
  return withJudged(out, judged);
}
