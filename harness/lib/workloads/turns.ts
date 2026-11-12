import { png } from '../strategies/png.ts';
import { hash32, prose, seeded } from '../strategies/prose.ts';
import { CHANNEL, READER, TOOL } from '../strategies/script.ts';
import type { Act, CallInput, Reply, Setup, Step } from '../strategies/script.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Context, Facts, Run } from './workloads.ts';

type Name = string | number;
type Range = [number, number];
export type TurnOptions = { mark?: string; user?: string; size?: Range; calls?: number; rounds?: number; result?: (k: number, canary: string) => CallInput; arrival?: { after: number }; callId?: (k: number) => string; thinking?: number; attach?: boolean; more?: Partial<Step> };
export type Writer = ReturnType<typeof writer>;
type CapabilityRead = (boolean & { unreadable?: undefined }) | { unreadable: string };

export const SIZES = {
  user: [450, 1800],
  call: [1200, 4500],
  result: [3000, 13500],
  reading: [9000, 12000],
  reply: [900, 3600],
  large: [45000, 60000],
  largeReply: [28000, 34000],
  document: [240000, 270000],
} satisfies Record<string, Range>;

const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];

export const canary = (seed: number, step: Name, part: string) => `[[c:${seed}.${step}.${part}]]`;

function image(seed: number) {
  const r = seeded(seed);
  return png(16, 16, (m) => Math.floor(r() * m));
}

export function writer(ctx: Pick<Context, 'seed'>, workload: string) {
  const r = seeded(`${ctx.seed}:${workload}`);
  const between = ([lo, hi]: Range) => lo + Math.floor(r() * (hi - lo + 1));
  const c = (step: Name, part: string) => canary(ctx.seed, step, part);
  const id = (step: Name) => `${ctx.seed}.${step}`;
  const turn = (step: Name, o: TurnOptions = {}) => {
    const sid = id(step);
    const canaries = [c(step, 'in')];
    const text = `${c(step, 'in')} ${o.mark ? `${o.mark} ` : ''}${o.user ?? prose(between(o.size ?? SIZES.user), `${sid}:in`)}`;
    const calls = o.calls ?? 1;
    const rounds = calls === 0 ? 0 : (o.rounds ?? 1);
    const replies: Reply[] = [];
    let k = 0;
    let held: { name: string; during?: Act[] } | null = null;
    for (let i = 0; i < rounds; i++) {
      const roundCalls = [];
      for (let j = 0; j < calls; j++) {
        k++;
        const callCanary = c(step, `call${k}`);
        canaries.push(callCanary);
        const input = o.result ? o.result(k, callCanary) : { kind: 'prose', size: between(SIZES.result), canary: callCanary };
        const call = { name: TOOL, input: o.arrival?.after === k ? { ...input, hold: true } : input, ...(o.callId?.(k) ? { id: o.callId(k) } : {}) };
        if (o.arrival?.after === k) held = call;
        roundCalls.push(call);
      }
      replies.push({
        text: `${c(step, `r${i + 1}`)} ${prose(between(SIZES.call), `${sid}:r${i + 1}`)}`,
        ...(o.thinking && i === 0 ? { thinking: prose(o.thinking, `${sid}:think`) } : {}),
        calls: roundCalls,
      });
    }
    replies.push({ text: `${c(step, `r${rounds + 1}`)} ${prose(between(SIZES.reply), `${sid}:r${rounds + 1}`)}` });
    if (held) {
      held.during = [{ deliver: { id: `${sid}.arrival`, participant: 'Tavy', text: `${c(step, 'arr')} ${prose(between(SIZES.user), `${sid}:arr`)}` } }];
      canaries.push(c(step, 'arr'));
    }
    return {
      id: sid, segment: workload, kind: 'channel', channel: CHANNEL, participant: PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)], topic: workload,
      text, canaries, replies,
      ...(o.attach ? { images: [{ data: image(hash32(sid)), mimeType: 'image/png' }] } : {}),
      ...(o.more ?? {}),
    };
  };
  const other = (step: Name, kind: string, fields: Partial<Step>) => ({ id: id(step), segment: workload, kind, ...fields });
  return { turn, other, c, id, between, size: between, SIZES };
}

// context-manager's Knowledge strategy sorts a message by its tools' names, which in a host are the fixture server's one
// tool.
const PHASE_PLAN = [
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 0 }, { calls: 0 }, { calls: 0 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 2 },
  { calls: 1 },
  { calls: 0 },
  { calls: 1 }, { calls: 1 },
];
export const phaseTurn = (n: number) => PHASE_PLAN[(n - 1) % PHASE_PLAN.length];

export function guardTurn(w: Writer, step: Name) {
  const t = w.turn(step, { calls: 0 });
  const said = (k: number) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  return {
    ...t,
    replies: [
      { text: said(1), calls: [{ name: 'toolsets--open', input: { toolset: 'settings' } }] },
      { text: said(2), calls: [{ name: 'toolsets--act', input: { tool: 'agent_settings', args: { action: 'update', tool_result_guard: true } } }] },
      { text: said(3) },
    ],
    also: ['agent_settings', 'tool_result_guard'],
  };
}

export function tuneOut(w: Writer) {
  const t = w.turn('tune', { calls: 0 });
  return {
    ...t,
    replies: [
      { text: `${w.c('tune', 'r1')} ${prose(200, `${w.id('tune')}:r1`)}`, calls: [{ name: 'tune_out', input: { channelId: CHANNEL, cadenceSeconds: 86400, maxWakes: 64 } }] },
      { text: `${w.c('tune', 'r2')} ${prose(200, `${w.id('tune')}:r2`)}` },
    ],
    namedAnywhere: true,
  };
}

// agent-framework 0.33.0's reader forks may call only the reader's tools (`readerMayCall`: deliver_summary,
// cancel_tuneout, note_disposition), so a fork ends its look by ending its turn, and its summary is mail that wakes
// the resident, which answers with skip_reply. It withdraws the maintenance calls out on an ended fork's context
// manager, so the fork's last reply waits for compression to go idle, or a summary the fork started could go unwritten.
export function readerRead(w: Writer, k: number, more: Partial<Step> = {}, reader: NonNullable<Step['reader']> = { name: 'Subconscious' }, { attach = false } = {}) {
  const held = w.turn(`h${k}`, { calls: 0, attach });
  const forks = reader.prefix !== undefined;
  const summary = w.c(`h${k}`, forks ? 'sum.in' : 'read');
  return {
    ...held,
    tags: ['chat:addressed'],
    reader,
    tunedOut: [w.c(`h${k}`, 'in')],
    ...more,
    ...(forks ? { canaries: [...held.canaries, summary], inputs: [summary], replies: [{ text: `${w.c(`h${k}`, 'r1')} noted`, calls: [{ name: 'skip_reply', input: {} }] }] } : { replies: [] }),
    subs: [{
      marker: READER,
      canaries: [w.c(`h${k}`, 'in')],
      namedAnywhere: true,
      also: ['addressed message'],
      replies: [
        { calls: [{ name: 'deliver_summary', input: { text: `${summary} ${prose(w.between(SIZES.reply), `${w.id(`h${k}`)}:read`)}`, channelId: CHANNEL } }] },
        forks ? { text: `${w.c(`h${k}`, 'end')} read`, settle: true } : { calls: [{ name: 'skip_reply', input: {} }] },
      ],
    }],
  };
}

// agent-framework's /undo takes the resident's last turn out of its window, so the script says whose words an /undo
// takes out: under reader forks the note answering the last fork's summary, and under a persistent reader, which wakes
// no resident turn, the turn that tuned the channel out.
const undoing = (step: Step, steps: Step[]) => (step.command === '/undo' ? { ...step, undoes: (steps.findLast((s) => s.replies?.length)?.replies ?? []).flatMap((r) => (typeof r.text === 'string' ? r.text.match(/\[\[c:[^\]\s]+\]\]/g) ?? [] : [])) } : step);

export function tunedOut(w: Writer, steps: Step[], count: number, o: { before?: Record<number, Step[]>; mayFail?: (k: number) => boolean; reader?: NonNullable<Step['reader']>; attach?: (k: number) => boolean } = {}) {
  steps.push(tuneOut(w));
  for (let k = 1; k <= count; k++) {
    for (const step of o.before?.[k] ?? []) steps.push(undoing(step, steps));
    steps.push(readerRead(w, k, o.mayFail?.(k) ? { mayFail: true } : {}, o.reader, { attach: o.attach?.(k) === true }));
  }
}

export function capable(capabilities: Facts['capabilities']) {
  return (name: string) => {
    if (capabilities?.unreadable !== undefined) throw new Error(capabilities.unreadable as string);
    const has = (capabilities as Partial<Record<string, CapabilityRead>> | undefined)?.[name];
    if (has?.unreadable !== undefined) throw new Error(has.unreadable);
    if (typeof has !== 'boolean') throw new Error(`couldn't tell whether the installed agent-framework brings ${name}: the host's facts don't say`);
    return has;
  };
}

export const CANARY_MARK = /\[\[c:[^\]\s]+\]\]/;

export const entries = <K extends LogEntry['kind']>(run: Run, kind: K) => run.log.filter((e): e is LogEntry & { kind: K } => e.kind === kind);
export const readsOf = (run: Run, op: string) => entries(run, 'read').filter((e) => e.op === op);

export const summarises = (configuration: Pick<Setup, 'summarises'>) => configuration.summarises !== false;

// membrane classifies a 400 as `invalid_request`, not retryable, unless its text reads as an account refusal or a
// context overflow (types/errors.ts classifyByStatus, 0.8.0), and agent-framework's breaker sheds on three such
// failures in a row (framework.ts noteInferenceExhausted, inferenceFailureEscalationThreshold, shedMayHelp).
export const INVALID = { status: 400, type: 'invalid_request_error', message: 'stand-in: an invalid request, scripted to fail' };

export const FAIL_PUBLISH = '[[fail-publish]]';
// agent-framework tells the resident of a publish the channel refused in its next request (framework.ts onRouteFailure,
// NOTICE_TAG.discordSendFailed).
export const SEND_FAILED_NOTICE = 'discord-send-failed';

// membrane 0.8.0 cuts a streamed call that has sent no content 60 s after its send (src/progress-bounds.ts PROGRESS_BOUNDS, which Bun loads).
export const BEFORE_CONTENT_MS = 60_000;

export const WEB_UI = { host: '127.0.0.1', port: 0 };
