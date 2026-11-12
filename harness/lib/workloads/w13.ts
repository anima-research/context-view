import { FORK_PREFIX, primaryAgent, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL, TOOL } from '../strategies/script.ts';
import { BEFORE_CONTENT_MS, CANARY_MARK, SEND_FAILED_NOTICE, writer } from './turns.ts';
import { arrivalFates, cutByBound, stallFlag, stalled, stepOrder } from './fates.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { BlockRecord } from '../standin/view.ts';
import type { Reply, Step } from '../strategies/script.ts';
import type { Breach } from './fates.ts';
import type { ConfigurationPart, Run, Workload } from './workloads.ts';

type Receipt = { to: string[]; held?: boolean; kept?: boolean; transcript?: boolean } | null;
export type Fate = {
  receipt?: Receipt;
  replayedReceipt?: Receipt;
  continues?: boolean;
  none?: string;
  undeliverable?: boolean;
  bounces?: number;
  sendFailed?: boolean;
  wrapper?: 'contained' | 'kept';
  refused?: 'ended' | 'replayed' | 'either';
  stall?: 'cut' | 'failed' | 'waited';
  wakeRefused?: boolean;
  overloaded?: boolean;
};
export type W13Step = Step & { fate?: Fate };
type Built = W13Step & { replies: Reply[]; canaries: string[] };

export function turnFates(run: Run, steps: W13Step[], { forks, unrouted = false }: { forks: boolean; unrouted?: boolean }) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const { after } = stepOrder(steps);
  const out: Breach[] = [];
  let judged = 0;
  // A row connectome-host adds after a user message, with no reply between, joins that message on the wire, and the
  // host's cache marker moves to the newest message, so the earlier request's last message is compared by its blocks.
  const shape = (b: BlockRecord) => JSON.stringify([b.type, b.chars, b.canaries ?? null, b.notice ?? null, b.toolUseId ?? null]);
  const added = (r: RequestRecord) => {
    const i = agent.indexOf(r);
    const before = i > 0 ? agent[i - 1].messages ?? [] : [];
    const now = r.messages ?? [];
    if (!before.length) return now.flatMap((m) => (m.blocks ?? []).map((b) => ({ role: m.role, b })));
    const last = before.length - 1;
    if (before.slice(0, last).some((m, k) => now[k]?.digest !== m.digest)) return null;
    const was = before[last].blocks ?? [];
    const is = now[last]?.role === before[last].role ? now[last].blocks ?? [] : null;
    if (!is || was.some((b, k) => !is[k] || shape(is[k]) !== shape(b))) return null;
    return [...is.slice(was.length).map((b) => ({ role: now[last].role, b })), ...now.slice(before.length).flatMap((m) => (m.blocks ?? []).map((b) => ({ role: m.role, b })))];
  };
  for (const s of steps) {
    const mine = agent.filter((r) => r.step === s.id);
    const fate = s.fate?.refused === 'either' ? settled(s.fate, mine) : s.fate;
    if (!fate) continue;
    if (fate.none) {
      judged++;
      if (mine.length) out.push({ step: s.id, message: `request ${mine[0].id} came at this step, where ${fate.none}` });
      continue;
    }
    const next = agent.find((r) => after(r.step, s.id));
    const later = [...mine.slice(1), ...(next ? [next] : [])].map((r) => ({ r, blocks: added(r) }));
    const unreadable = later.find((x) => x.blocks === null);
    const rows = later.flatMap((x) => x.blocks ?? []);
    const couldnt = (what: string) => out.push({ step: s.id, message: `couldn't judge ${what}: ${!mine.length ? 'no request at this step' : `request ${unreadable!.r.id} doesn't carry the window of the request before it unchanged`}` });
    if (!mine.length || unreadable) { couldnt('its turn\'s fate'); continue; }
    if (!later.length && ['receipt', 'undeliverable', 'bounces', 'continues', 'wrapper'].some((k) => k in fate)) { out.push({ step: s.id, message: 'couldn\'t judge its turn\'s fate: no request follows it' }); continue; }
    const notices = (tag: string) => rows.filter(({ b }) => b.notice === tag).length;
    if ('receipt' in fate) {
      judged++;
      const receipt = rows.find(({ b }) => b.delivered)?.b.delivered;
      const want = fate.receipt;
      if (want === null && receipt) out.push({ step: s.id, message: `its turn wrote a [delivered] receipt (to ${receipt.to.join(', ') || 'no channel'}), where its setup writes none` });
      else if (want && !receipt) out.push({ step: s.id, message: `no [delivered] receipt follows its turn${next ? `, up to request ${next.id}` : ''}, where its setup writes one` });
      else if (want && receipt) {
        if (receipt.to.join(' · ') !== want.to.join(' · ')) out.push({ step: s.id, message: `its turn's receipt says its plain speech landed in ${receipt.to.join(' · ') || 'no channel'}, where its setup lands it in ${want.to.join(' · ') || 'no channel'}` });
        if (Boolean(want.held) !== receipt.held > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.held} draft(s) held, where its setup holds ${want.held ? 'some' : 'none'}` });
        if (Boolean(want.kept) !== receipt.kept > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.kept} segment(s) kept private, where its setup keeps ${want.kept ? 'some' : 'none'} private` });
        if (Boolean(want.transcript) !== receipt.transcript > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.transcript} segment(s) kept in the transcript, where its setup keeps ${want.transcript ? 'its words there' : 'none there'}` });
      }
    }
    if (fate.undeliverable) {
      judged++;
      if (!notices('send-undeliverable')) out.push({ step: s.id, message: 'no [send-undeliverable] row follows its turn, though its reply had no channel to go to' });
    }
    if (fate.bounces !== undefined) {
      judged++;
      if (notices('prose-routing') !== fate.bounces) out.push({ step: s.id, message: `${notices('prose-routing')} [prose-routing] bounce(s) follow its turn, where its setup bounces ${fate.bounces}` });
    }
    if (fate.sendFailed) {
      judged++;
      if (notices(SEND_FAILED_NOTICE) !== 1) out.push({ step: s.id, message: `${notices(SEND_FAILED_NOTICE)} [${SEND_FAILED_NOTICE}] row(s) follow its turn, where its setup refuses its speech once` });
    }
    if (fate.continues !== undefined) {
      judged++;
      const continued = notices('continue');
      if (continued !== (fate.continues ? 1 : 0)) out.push({ step: s.id, message: `${continued} continuation(s) followed its turn, where ${fate.continues ? 'autoContinue continues a turn the model ends itself once, its continuation ending in skip_reply' : 'none does'}` });
    }
    if (fate.wrapper) {
      judged++;
      const [reply] = s.replies![0].text!.match(CANARY_MARK)!;
      const carried = agent.filter((r) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => (b.canaries ?? []).includes(reply))));
      if (fate.wrapper === 'contained') {
        if (carried.length) out.push({ step: s.id, message: `request ${carried[0].id} carries the wrapper the guard contains, ${reply}` });
        if (!notices('tool-boundary')) out.push({ step: s.id, message: 'no [tool-boundary] row follows the contained wrapper' });
      } else if (!rows.some(({ role, b }) => role === 'assistant' && (b.canaries ?? []).includes(reply))) out.push({ step: s.id, message: `the wrapper ${reply} isn't in the history after its turn, where without the guard it's ordinary prose` });
    }
    if (fate.refused) {
      judged++;
      const refusedAt = mine.filter((r) => r.answer?.stop === 'refusal');
      if (refusedAt.length !== 1 || mine[0].answer?.stop !== 'refusal') out.push({ step: s.id, message: `${refusedAt.length} of the step's ${mine.length} request(s) were refused, where the stand-in refuses its first, once` });
      else if (fate.refused === 'ended' && mine.length !== 1) out.push({ step: s.id, message: `the refused request was followed by ${mine.length - 1} more at its step, where nothing retries a refusal with no retries and no rewind` });
      else if (fate.refused === 'replayed' && (mine.length !== 2 || (mine[1].messages ?? []).map((m) => m.digest).join() !== (mine[0].messages ?? []).map((m) => m.digest).join() || JSON.stringify(mine[1].head) !== JSON.stringify(mine[0].head) || mine[1].stream !== mine[0].stream)) out.push({ step: s.id, message: `the refused request wasn't replayed once whole (${mine.length} request(s) at its step), where refusalHandling's retries replay the same request` });
    }
    if (fate.stall) {
      judged++;
      const flag = stallFlag(mine, fate.stall);
      if (flag) out.push({ step: s.id, message: flag });
    }
    if (fate.stall === 'failed') {
      judged++;
      const note = rows.find(({ b }) => b.inferenceFailed)?.b.inferenceFailed;
      if (!next) out.push({ step: s.id, message: 'couldn\'t judge its turn\'s fate: no request follows it' });
      else if (!note) out.push({ step: s.id, message: `no [inference-failed] note follows its turn${next ? `, up to request ${next.id}` : ''}, where the bound cut its call and the fresh call` });
      else if (note.setting !== BEFORE_CONTENT_SETTING) out.push({ step: s.id, message: `its turn's [inference-failed] note names ${note.setting ?? 'no host setting'} as its reason, where the bound that cut it is ${BEFORE_CONTENT_SETTING}` });
    }
    if (fate.wakeRefused) {
      judged++;
      const refusedWake = run.log.some((e) => e.kind === 'ipc' && e.step === s.id && e.event?.type === 'tool:failed' && e.event.tool === 'skip_reply' && /can't take wake_in_seconds/.test((e.event.error ?? '') as string));
      if (!refusedWake || mine.length !== 2) out.push({ step: s.id, message: `${refusedWake ? 'skip_reply was refused' : 'no skip_reply call was refused'} and ${mine.length} request(s) came at its step, where with no gate skip_reply's wake_in_seconds is refused, the turn goes on, and its next call ends it` });
    }
    if (fate.overloaded) {
      judged++;
      const input = w13Input(s);
      if (mine.length !== 2 || mine[0].answer?.shape !== 'error' || !(mine[1].messages?.at(-1)?.blocks ?? []).some((b) => (b.canaries ?? []).includes(input))) out.push({ step: s.id, message: `the 529 wasn't followed by one request carrying its turn's message (${mine.length} request(s) at its step), where the retry setup sends it again` });
    }
  }
  // agent-framework's disabled routing injects no primer and announces no locus (its docs/disabled-prose-routing.md),
  // so none of the run's requests carries a `[routing]` row, the first turn's own announcement, which no step's later
  // rows hold, included.
  if (unrouted) {
    judged++;
    const routed = agent.find((r) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => b.notice === 'routing')));
    if (routed) out.push({ step: routed.step, message: `request ${routed.id} carries a [routing] row, where disabled routing writes none` });
  }
  if (forks) {
    judged++;
    const by = primaryAgent(run.log);
    if (!by.startsWith(FORK_PREFIX)) out.push({ step: 'the run', message: `the requests were made by ${by}, not by one fork of conversations` });
  }
  return withJudged(out, judged);
}

const w13Input = (s: Step) => s.canaries![0];

const EXTRACTION = 'refuse.reasoning-extraction';
const settled = (fate: Fate, mine: RequestRecord[]): Fate => {
  const { replayedReceipt, ...rest } = fate;
  return mine.length > 1 ? { ...rest, refused: 'replayed', receipt: replayedReceipt } : { ...rest, refused: 'ended', receipt: null };
};

export const W13 = {
  from: null,
  compresses: false,
  property: 'turn endings: each turn\'s speech meets the fate its setup documents: its `[delivered]` receipt, in the next request, names where it landed (its channel, the hybrid envelope\'s channel beside it, the lock once the agent moves it, the latest inbound channel for a self-wake under latest-inbound), or says it stayed in the transcript (disabled) or was held as drafts (locked, before a move), and explicit mode writes none; disabled routing writes no `[routing]` row; a self-wake with no locus is told its reply had no channel; explicit mode bounces unprefixed prose and an unknown target with a notice each, and hybrid an envelope naming no channel; a turn whose speech moves to an inbound-only channel has its post there refused once; the text beside a private think() writes no receipt; under autoContinue a turn the model ends itself is followed by one continuation and a turn ended by skip_reply or a refusal by none; the guard contains a whole-response tool wrapper, which no later request carries and whose place a tool-boundary row takes, and without it the wrapper is ordinary history; a refusal is replayed whole once where retries allow and otherwise ends its turn with no other request; a held call the inference bound cuts is sent again once with the same messages, and with no bounds its own reply answers it; under H1, where the fresh call is held too, both are cut with the same messages and the next request carries the turn\'s [inference-failed] note naming the host\'s setting for that bound; a 529 under the retry setup is sent again; and under conversations one fork makes every request; and with no gate, skip_reply\'s wake_in_seconds is refused, its turn going on to its next call, and no request comes where the self-wake would have; and under latest-inbound no request comes at the first held push, and the push a batch turn\'s held reply lets arrive is first carried by the request after that reply\'s call, after the call\'s result',
  recipe: (): ConfigurationPart => ({ modules: { wake: { policies: [W13_QUIET_RULE, W13_HELD_PUSH_RULE], default: 'always' } } }),
  steps(ctx): W13Step[] {
    const w = writer(ctx, 'W13');
    const agent = ctx.configuration.agent ?? {};
    const mode = agent.proseRouting ?? 'locus';
    const explicit = mode === 'explicit';
    const continues = agent.autoContinue === true || (typeof agent.autoContinue === 'object' && agent.autoContinue !== null);
    const forks = Boolean(ctx.configuration.recipe?.conversations);
    const latest = (ctx.configuration.recipe?.speech as { locus?: string } | undefined)?.locus === 'latest-inbound';
    const guarded = agent.toolWrapperProseGuard === true;
    const replayed = (agent.refusalHandling?.retries ?? 0) > 0;
    const bounded = ctx.configuration.recipe?.inferenceBounds !== false;
    const gated = ctx.configuration.modules?.wake !== false;
    const side = forks ? CHANNEL : W13_SIDE;
    // Under `locked` with no `proseLock`, plain speech is held as drafts until the agent's `prose_locus` moves it, and
    // then goes where it points, whichever channel woke the turn (agent-framework docs/locked-prose-routing.md).
    let locked = mode === 'locked' && agent.proseLock === undefined;
    let lockedTo: string | null = null;
    const said = (step: string, k: number, size = 300) => `${w.c(step, `r${k}`)} ${prose(size, `${w.id(step)}:r${k}`)}`;
    // agent-framework's explicit mode delivers only prose a `>>` target opens (its docs/explicit-prose-routing.md), as a
    // resident there writes it.
    const to = (channel: string, text: string) => (explicit ? `>>#${channel} ${text}` : text);
    const held = (): Pick<Step, 'drafts'> => (locked ? { drafts: 'no-destination' } : {});
    // Where a turn's plain speech lands, as its `[delivered]` receipt says (agent-framework's framework.ts,
    // appendProseDeliveryReceipt): explicit mode's envelopes acknowledge themselves and write no receipt, disabled mode
    // keeps the words in the transcript, and a lock to drafts holds them.
    const lands = (...channels: string[]): Fate => (explicit ? { receipt: null }
      : mode === 'disabled' ? { receipt: { to: [], transcript: true } }
        : locked ? { receipt: { to: [], held: true } }
          : { receipt: { to: lockedTo ? [lockedTo] : channels } });
    // A turn the model ends itself continues under agent-framework's autoContinue, whose `[continue]` row the stand-in
    // answers with skip_reply (its docs/auto-continue.md).
    const closing = (t: W13Step & { replies: Reply[] }): W13Step => (continues ? { ...t, also: [...(t.also ?? []), CONTINUE_ROW], replies: [...t.replies, { calls: [{ name: 'skip_reply', input: {} }] }], fate: { ...t.fate, continues: true } } : t);
    const turn = (step: string, channel: string, replies: Reply[], fate: Fate, more: Partial<W13Step> = {}): Built => ({ ...w.turn(step, { calls: 0, more: { channel, ...held(), ...more } }), replies, fate: { continues: false, ...fate } });
    const steps: W13Step[] = [];
    steps.push(closing(turn('end', CHANNEL, [{ text: to(CHANNEL, said('end', 1)) }], lands(CHANNEL))));
    // A send to the turn's own channel holds the round's words and the closing words after it as drafts, and the
    // continuation's row then says closing words were held (agent-framework's framework.ts sendHoldAt and
    // auto-continue.ts).
    if (continues) {
      steps.push(closing(turn('sent', CHANNEL, [
        { text: said('sent', 1), calls: [{ name: 'channel_publish', input: { channelId: CHANNEL, content: `${w.c('sent', 'pub')} ${prose(200, `${w.id('sent')}:pub`)}` } }] },
        { text: said('sent', 2) },
      ], { receipt: { to: [], held: true } }, { namedAnywhere: true, drafts: 'explicit-send' })));
    }
    if (agent.retry) {
      const busy = turn('overloaded', side, [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, { text: to(side, said('overloaded', 1)) }], { ...lands(side), overloaded: true }, { retries: true });
      steps.push(closing(busy));
    }
    const wrapper = `<${TOOL}>${said('wrapper', 1)}</${TOOL}>`;
    steps.push(guarded
      ? turn('wrapper', CHANNEL, [{ text: wrapper }], { wrapper: 'contained' }, { ends: 'contained' })
      : closing(turn('wrapper', CHANNEL, [{ text: to(CHANNEL, wrapper) }], { ...lands(CHANNEL), wrapper: 'kept' })));
    // agent-framework's explicit mode reads the `>>>#chat` line as the target `>#chat`, which names no channel.
    const lines = [said('routed', 1), `>>#${CHANNEL} ${prose(200, `${w.id('routed')}:explicit`)}`, `>>>#${CHANNEL} ${prose(200, `${w.id('routed')}:hybrid`)}`].join('\n\n');
    const routedFate = explicit ? { receipt: null, bounces: 2 } : mode === 'hybrid' && !forks ? lands(side, CHANNEL) : lands(side);
    const routed = turn('routed', side, [{ text: lines }], routedFate, explicit ? { drafts: 'bounced', also: [BOUNCE_NOTICE] } : {});
    if (explicit) routed.replies = [...routed.replies, { text: `>>#${side} {{unsent}}` }];
    steps.push(closing(routed));
    steps.push(turn('think', CHANNEL, [
      { text: to(CHANNEL, said('think', 1)), calls: [{ name: 'think', input: { content: prose(200, `${w.id('think')}:thought`) } }] },
      { calls: [{ name: 'skip_reply', input: {} }] },
    ], agent.sameRoundThinkTextPolicy === 'private' ? { receipt: null } : lands(CHANNEL), { namedAnywhere: true, ends: 'unspoken' }));
    const stall = bounded
      ? stalled(turn('stall', CHANNEL, [{ text: to(CHANNEL, said('stall', 1)) }], { ...lands(CHANNEL), stall: 'cut' }))
      : turn('stall', CHANNEL, [{ text: to(CHANNEL, said('stall', 1)), hold: true, during: [{ advance: BEFORE_CONTENT_MS }] }], { ...lands(CHANNEL), stall: 'waited' });
    steps.push(closing(stall));
    if (bounded && ctx.configurationName === 'H1') steps.push(turn('stall.failed', CHANNEL, [cutByBound(), cutByBound('ends')], { stall: 'failed', receipt: null }, { mayFail: true, retries: true }));
    // In agent-framework a refusal nothing replays ends its turn with nothing sent and nothing stored.
    const refused = turn('refuse', side, [{ stop: 'refusal' }], replayed ? { refused: 'replayed', ...lands(side) } : { refused: 'ended', receipt: null }, replayed ? {} : { ends: 'unspoken' });
    if (replayed) refused.replies = [...refused.replies, { text: to(side, said('refuse', 1)) }];
    else refused.spare = [{ text: said('refuse', 1) }];
    // A refused turn doesn't continue (agent-framework's docs/auto-continue.md), so only its replay's turn would.
    steps.push(replayed ? closing(refused) : refused);
    // membrane 0.8.2 and 0.10.3 don't re-issue a refusal named reasoning_extraction (UNRETRIED_REFUSAL_CATEGORIES).
    if (replayed && !continues) {
      const named = turn(EXTRACTION, side, [{ stop: 'refusal', category: 'reasoning_extraction' }], { refused: 'either', replayedReceipt: lands(side).receipt }, { ends: 'either' });
      named.spare = [{ text: to(side, said(EXTRACTION, 1)) }];
      steps.push(named);
    }
    if (mode === 'locked') {
      // What the agent writes in the round that moves the lock goes where speech went before it (agent-framework's
      // docs/locked-prose-routing.md, `prose_locus`), so the receipt names the lock and the draft beside it.
      steps.push(turn('lock', CHANNEL, [
        { text: said('lock', 1), calls: [{ name: 'prose_locus', input: { to: `#${CHANNEL}` } }] },
        { text: said('lock', 2) },
      ], { receipt: { to: [CHANNEL], held: true } }, { namedAnywhere: true }));
      locked = false;
      lockedTo = CHANNEL;
      steps.push(turn('locked', side, [{ text: said('locked', 1) }], lands(side)));
    }
    if (!forks && !gated) {
      steps.push(turn('skip', CHANNEL, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }, { calls: [{ name: 'skip_reply', input: {} }] }], { receipt: null, wakeRefused: true }, { ends: 'unspoken', namedAnywhere: true }));
      steps.push({ id: w.id('ambient'), segment: 'W13', kind: 'deliver', topic: 'W13', messages: [{ channel: W13_QUIET, id: w.id('ambient'), participant: 'Ash', text: `${w.c('ambient', 'in')} ${prose(300, `${w.id('ambient')}:in`)}` }], canaries: [w.c('ambient', 'in')], replies: [{ text: said('ambient', 1) }], fate: { continues: false, ...lands(W13_QUIET) } });
      steps.push({ id: w.id('skip.wake'), segment: 'W13', kind: 'advance', ms: 121_000, fate: { none: 'with no gate no self-wake was set to wake the agent' } });
    }
    if (!forks && gated) {
      steps.push(turn('skip', CHANNEL, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }], { receipt: null }, { ends: 'unspoken' }));
      steps.push({ id: w.id('ambient'), segment: 'W13', kind: 'deliver', topic: 'W13', messages: [{ channel: W13_QUIET, id: w.id('ambient'), participant: 'Ash', text: `${w.c('ambient', 'in')} ${prose(300, `${w.id('ambient')}:in`)}` }], canaries: [w.c('ambient', 'in')], spare: [{ text: said('ambient', 1) }] });
      // In agent-framework's routing a self-wake has no channel of its own: under `delivery` locus and hybrid modes its
      // reply has none to go to, and under `latest-inbound` it lands where the latest message came from.
      const wakeFate = latest ? lands(W13_QUIET) : (mode === 'locus' || mode === 'hybrid') ? { undeliverable: true } : lands(CHANNEL);
      steps.push(closing({ id: w.id('skip.wake'), segment: 'W13', kind: 'advance', ms: 121_000, canaries: [w.c('skip', 'in')], namedAnywhere: true, inputs: [], addressed: false, ...held(), replies: [{ text: to(CHANNEL, said('skip.wake', 1)) }], fate: { continues: false, ...wakeFate } }));
    }
    if (latest && !forks) {
      steps.push({ id: w.id('push'), segment: 'W13', kind: 'push', channel: W13_PUSH, participant: 'Wren', tags: ['chat:addressed'], text: `${w.c('push', 'in')} ${prose(300, `${w.id('push')}:in`)}`, canaries: [w.c('push', 'in')], namedAnywhere: true, replies: [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }], fate: { continues: false, receipt: null } });
      steps.push(closing({ id: w.id('push.wake'), segment: 'W13', kind: 'advance', ms: 121_000, canaries: [w.c('push', 'in')], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said('push.wake', 1) }], fate: { continues: false, ...lands(W13_QUIET) } }));
      const repin = turn('repin', CHANNEL, [
        { text: said('repin', 1), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c('repin', 'call1') } }], hold: true, during: [{ deliver: { channel: W13_FEED, id: `${w.id('repin')}.feed`, participant: 'Ash', text: `${w.c('repin', 'feed.in')} ${prose(300, `${w.id('repin')}:feed.in`)}`, tags: ['chat:addressed'] } }] },
        { text: said('repin', 2) },
      ], { ...lands(CHANNEL), sendFailed: true }, { namedAnywhere: true, failsPublish: true });
      repin.spare = [{ calls: [{ name: 'skip_reply', input: {} }] }];
      repin.canaries.push(w.c('repin', 'feed.in'), w.c('repin', 'call1'));
      steps.push(closing(repin));
      const pushed = (step: string, part: string) => `${w.c(step, part)} ${HELD_PUSH} ${prose(300, `${w.id(step)}:${part}`)}`;
      const skip = [{ calls: [{ name: 'skip_reply', input: {} }] }];
      const again = { channel: W13_PUSH, id: `${w.id('held.wake')}.push`, participant: 'Ash', tags: UNOPENED_AMBIENT, text: pushed('held.wake', 'push.in') };
      steps.push({ id: w.id('held'), segment: 'W13', kind: 'push', channel: W13_PUSH, participant: 'Ash', tags: UNOPENED_AMBIENT, text: pushed('held', 'in'), canaries: [w.c('held', 'in')], spare: skip, fate: { none: 'the held-push rule holds it until its window ends' } });
      steps.push({
        id: w.id('held.wake'), segment: 'W13', kind: 'advance', ms: 31_000, canaries: [w.c('held', 'in'), w.c('held.wake', 'push.in'), w.c('held.wake', 'call1')], namedAnywhere: true, inputs: [w.c('held', 'in')], addressed: false,
        replies: [{ calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c('held.wake', 'call1') } }], hold: true, during: [{ push: again }] }, ...skip],
        fate: { continues: false, receipt: null },
        arrivals: [{ canary: w.c('held.wake', 'push.in'), point: 'boundary', after: w.c('held.wake', 'call1'), push: true, message: again.id }],
      });
      steps.push({ id: w.id('held.again'), segment: 'W13', kind: 'advance', ms: 31_000, canaries: [w.c('held.wake', 'push.in')], namedAnywhere: true, inputs: [], addressed: false, spare: skip });
    }
    if ((explicit || mode === 'hybrid') && !forks) {
      const words = said('con', 1);
      steps.push({
        id: w.id('con'), segment: 'W13', kind: 'console', text: `${w.c('con', 'in')} ${prose(300, `${w.id('con')}:in`)}`, canaries: [w.c('con', 'in')], namedAnywhere: true, addressed: false, drafts: 'bounced',
        replies: [{ text: explicit ? words : `>>>#${W13_NOWHERE} ${words}` }], spare: [{ calls: [{ name: 'skip_reply', input: {} }] }],
        fate: { continues: false, ...(explicit ? { receipt: null } : { receipt: { to: [], held: true } }), bounces: 1 },
      });
    }
    const last = turn('last', CHANNEL, [{ text: to(CHANNEL, said('last', 1)) }], {});
    delete last.fate;
    steps.push(closing(last));
    return steps;
  },
  check(run, ctx) {
    const steps = this.steps(ctx);
    const [fates, arrivals] = [turnFates(run, steps, { forks: Boolean(ctx.configuration.recipe?.conversations), unrouted: ctx.configuration.agent?.proseRouting === 'disabled' }), arrivalFates(run, steps)];
    return withJudged([...fates, ...arrivals], fates.judged + arrivals.judged);
  },
} satisfies Workload;

const W13_SIDE = 'side';
const W13_QUIET = 'w13-quiet';
const W13_PUSH = 'w13-push';
const W13_FEED = 'w13-feed';
const W13_NOWHERE = 'w13-nowhere';
const W13_QUIET_RULE = { name: 'w13-quiet', match: { channel: `*${W13_QUIET}` }, behavior: 'defer' };
const HELD_PUSH = '[[held-push]]';
const W13_HELD_PUSH_RULE = { name: 'w13-held-push', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: HELD_PUSH } }, behavior: { debounce: 30_000 } };
// discord-mcpl tags a message on a channel the agent hasn't opened, that doesn't mention it, so (server.ts addressTags).
const UNOPENED_AMBIENT = ['chat:ambient', 'chat:from-human'];
// agent-framework's continuation row (auto-continue.ts) and explicit mode's bounce notice open so.
const CONTINUE_ROW = '[continue] ';
const BOUNCE_NOTICE = '[prose-routing] ';
// agent-framework names the host's setting for that bound in a cut's reason (inference-bounds.ts `withHostSetting`).
const BEFORE_CONTENT_SETTING = 'inferenceBounds.progressBounds.beforeContentMs';
