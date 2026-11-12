import { withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL, TOOL } from '../strategies/script.ts';
import { FAIL_PUBLISH, INVALID, SEND_FAILED_NOTICE, SIZES, canary, capable, writer } from './turns.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { Reply, Step } from '../strategies/script.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Breach } from './fates.ts';
import type { Workload } from './workloads.ts';

// agent-framework's breaker, before its first shed of a streak, sends the failed request with its messages replaced by
// one, and sheds only if that probe is answered; one that fails as the request did keeps the history and raises this
// alert, keyed by that verdict (framework.ts probeBeforeShed).
const HISTORY_KEPT = { kind: 'history-kept', verdict: 'fails-without-history' };
// agent-framework's breaker sends its probe as the failed turn ends, and the host's settle, agent-framework's
// getHostModeStatus, doesn't count it, so a step whose turn it follows waits for what the breaker does with its answer:
// a retry, or the history kept. A breaker that does neither is waited for up to a turn's bound and then judged.
const PROBED = { events: [{ type: 'inference:started' }, { type: 'ops:alert', kind: HISTORY_KEPT.kind }], what: 'what the breaker does after the failed turn, a retry\'s start or a history-kept alert' };

export const W16 = {
  from: null,
  compresses: false,
  owns: [{ check: 1, what: 'hard-down' }, { check: 1, what: HISTORY_KEPT.kind }],
  property: 'rewind: a turn whose request carrying its call\'s result the model refuses, the third of three turns the model API refuses as invalid, and an unstick whose turn the model refuses each shed the newest exchange and retry, not replay: each failed request is followed, at the same step, by a request that carries one more rewind marker and the shed message nowhere, the refused call\'s turn keeping its own message, and no turn before the third invalid one is retried, nor raises the breaker\'s hard-down alert, which the third raises; a turn whose answer the channel refuses to post is followed by a request telling the resident so; and where the breaker probes before it sheds, three more invalid turns trip it again and its probe, failing as the request did, keeps the history: the breaker sends the probe, queues no retry, raises one history-kept alert keyed fails-without-history and a hard-down alert at that third failure, and the next turn\'s request carries all three turns\' messages and as many rewind markers as the failed request',
  steps(ctx): Step[] {
    const w = writer(ctx, 'W16');
    // agent-framework's rewind takes the newest exchange the refused request carried out of the agent's window and
    // stores its marker, `[refusal-rewind] The N most recent turn(s) were set aside …` or, under its later tag,
    // `[turns-set-aside] The …` (framework.ts shedNewestTurn, updateRewindMarker). The stand-in refuses the request
    // carrying `refuse`'s call result, and the rewind sheds that result with the call's turn, keeping the message.
    // The stand-in knows the retry by the marker.
    const refusing = (id: string, refusal: Reply) => {
      const t = w.turn(id, { calls: 0, more: { also: REWIND_MARKS, namedAnywhere: true } });
      const [round, call] = [w.c(id, 'r0'), w.c(id, 'call1')];
      t.canaries = [...t.canaries, call];
      t.replies = [{ text: `${round} ${prose(1200, `${w.id(id)}:r0`)}`, calls: [{ name: TOOL, input: { kind: 'prose', size: 3000, canary: call } }] }, refusal, ...t.replies];
      t.sheds = [round];
      return t;
    };
    const refused = refusing('refuse', { stop: 'refusal' });
    // Before agent-framework 0.34.0 the rewind marker gives a refusal's category ("content filter: …",
    // updateRewindMarker), and until a turn ends without a refusal (endRefusalEpisode) a later rewind edits that marker
    // rather than storing its own.
    const named = refusing(EXTRACTION, { stop: 'refusal', category: 'reasoning_extraction' });
    const breaker = BREAKER_STEPS.map((id, i) => {
      const last = i === BREAKER_STEPS.length - 1;
      const t = w.turn(id, { calls: 0, more: { mayFail: true, also: REWIND_MARKS, namedAnywhere: true, ...(last ? { sheds: [w.c(id, 'in')] } : {}) } });
      const [reply] = t.replies;
      t.replies = [{ error: INVALID }, ...(last ? [reply] : [])];
      if (!last) t.spare = [reply];
      if (last) Object.assign(t, { probe: { text: 'Word.' }, awaits: PROBED });
      return t;
    });
    const keeps = capable(ctx.capabilities)('kept-history') ? [...KEEP_STEPS.map((id, i) => {
      const t = w.turn(id, { calls: 0, more: { mayFail: true, also: REWIND_MARKS, namedAnywhere: true } });
      t.spare = t.replies;
      t.replies = [{ error: INVALID }];
      if (i === KEEP_STEPS.length - 1) Object.assign(t, { probe: { error: INVALID }, awaits: PROBED });
      return t;
    }), w.turn('kept', { calls: 0 })] : [{ id: w.id('absent.kept-history'), segment: 'W16', kind: 'absent', stretch: 'kept-history', canaries: [] }];
    // agent-framework's `unstick` host command queues a turn on the agent's context as it stands, with no message of
    // its own, and sheds only when the model refuses that turn (framework.ts handleHostCommand, the refusal's
    // `forced` rewind). The stand-in knows the turn by a rewind marker an earlier step left, and refuses it once.
    const unstick = w.other('unstick', 'host', {
      host: { command: 'unstick', channelId: CHANNEL }, inputs: [], canaries: [], also: REWIND_MARKS, namedAnywhere: true, sheds: [w.c(BREAKER_STEPS.at(-1)!, 'r1')],
      replies: [{ stop: 'refusal' }, { text: `${w.c('unstick', 'r1')} ${prose(w.between(SIZES.reply), `${w.id('unstick')}:r1`)}` }],
    });
    const failed = w.turn('failpub', { calls: 0, more: { failsPublish: true } });
    failed.replies = [{ ...failed.replies[0], text: `${failed.replies[0].text} ${FAIL_PUBLISH}` }];
    // Console input before the refused turn, so the turns after it, the unstick's among them, follow private input
    // (agent-framework#190's operator turns).
    const con = { id: w.id('pre.con'), segment: 'W16', kind: 'console', text: `${w.c('pre.con', 'in')} ${prose(w.between(SIZES.user), `${w.id('pre.con')}:in`)}`, canaries: [w.c('pre.con', 'in')], addressed: false, namedAnywhere: true, replies: [{ text: `${w.c('pre.con', 'r1')} ${prose(200, `${w.id('pre.con')}:r1`)}`, calls: [{ name: 'skip_reply', input: {} }] }] };
    return [w.turn(1, { calls: 0 }), con, refused, w.turn('after', { calls: 0 }), named, w.turn('after.named', { calls: 0 }), ...breaker, unstick, failed, w.turn('told', { calls: 0 }), ...keeps];
  },
  check(run, ctx) {
    const out: Breach[] = [];
    let judged = 0;
    const at = (id: string) => run.records.filter((r) => r.step === `${ctx.seed}.${id}` && (r.kind === 'unclassified' || (r.kind === 'agent' && (r.agent ?? 'primary') === 'primary')));
    const markers = (r: RequestRecord) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => (REWIND_NOTICES as (string | undefined)[]).includes(b.notice)).length;
    const carries = (r: RequestRecord, c: string) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => (b.canaries ?? []).includes(c)));
    const rewound = (id: string, failed: string, last: RequestRecord, { shed = [canary(ctx.seed, id, 'in')], what = 'the shed turn\'s message', kept = null }: { shed?: string[]; what?: string; kept?: string | null } = {}) => {
      const step = `${ctx.seed}.${id}`;
      const retry = at(id).find((r) => r.seq > last.seq);
      if (!retry) return out.push({ step, message: `couldn't judge: no request at this step followed the ${failed} ${last.id}` });
      judged++;
      const lacks = shed.filter((c) => !carries(last, c));
      if (lacks.length) return out.push({ step, message: `request ${last.id}, the one ${failed} at this step, lacks ${lacks.join(' ')}, which its rewind is to shed, so its retry isn't judged` });
      if (markers(retry) !== markers(last) + 1) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, carries ${markers(retry)} rewind marker(s) where ${last.id} carried ${markers(last)}, and the rewind adds one` });
      const still = shed.filter((c) => carries(retry, c));
      if (still.length) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, still carries ${what} ${still.join(' ')}: it was replayed, not shed` });
      if (kept && !carries(retry, kept)) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, no longer carries the turn's message ${kept}, which a rewind that sheds the turn's call and its result keeps` });
    };
    const refusals = at('refuse').filter((r) => r.answer?.stop === 'refusal');
    if (!refusals.length) out.push({ step: `${ctx.seed}.refuse`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
    else {
      if (refusals.length > 1) out.push({ step: `${ctx.seed}.refuse`, message: `${refusals.length} requests at this step were answered with a refusal, where the stand-in refuses once: the refusal was replayed` });
      rewound('refuse', 'refused', refusals.at(-1)!, { shed: [canary(ctx.seed, 'refuse', 'r0'), canary(ctx.seed, 'refuse', 'call1')], what: 'the shed call\'s round', kept: canary(ctx.seed, 'refuse', 'in') });
    }
    const namedRefusals = at(EXTRACTION).filter((r) => r.answer?.stop === 'refusal');
    if (!namedRefusals.length) out.push({ step: `${ctx.seed}.${EXTRACTION}`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
    else {
      if (namedRefusals.length > 1) out.push({ step: `${ctx.seed}.${EXTRACTION}`, message: `${namedRefusals.length} requests at this step were answered with a refusal, where the stand-in refuses once: the refusal was replayed` });
      rewound(EXTRACTION, 'refused', namedRefusals.at(-1)!, { shed: [canary(ctx.seed, EXTRACTION, 'r0'), canary(ctx.seed, EXTRACTION, 'call1')], what: 'the shed call\'s round', kept: canary(ctx.seed, EXTRACTION, 'in') });
    }
    const keeps = capable(ctx.capabilities)('kept-history');
    const keptAt = `${ctx.seed}.${KEEP_STEPS.at(-1)}`;
    const keptAlerts = run.log.filter((e): e is LogEntry & { kind: 'ipc' } => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === HISTORY_KEPT.kind);
    for (const e of keptAlerts) {
      if (!keeps || e.step !== keptAt || (e.event.data as { probe?: unknown } | undefined)?.probe !== HISTORY_KEPT.verdict) out.push({ step: e.step, message: `a ${HISTORY_KEPT.kind} alert keyed ${(e.event.data as { probe?: unknown } | undefined)?.probe ?? 'by nothing'} at this step, other than the one a probe failing as the request did raises at the third failure of the kept-history turns: ${e.event.message ?? ''}`.trim() });
    }
    const probed = (step: string, failed: RequestRecord) => run.records.find((r) => r.step === step && r.kind === 'probe' && r.seq > failed.seq);
    const kept = (id: string, failed: RequestRecord) => {
      const step = `${ctx.seed}.${id}`;
      if (!probed(step, failed)) out.push({ step, message: `no probe reached the stand-in at this step after the failed ${failed.id}, where a breaker that raises ${HISTORY_KEPT.kind} sends the failed request without its history before it sheds` });
      judged++;
      const next = at(id).find((r) => r.seq > failed.seq);
      if (next) out.push({ step, message: `request ${next.id} followed the failed ${failed.id} at this step, where a probe that fails as the request did keeps the history and queues no retry` });
      const n = keptAlerts.filter((e) => e.step === step && (e.event.data as { probe?: unknown } | undefined)?.probe === HISTORY_KEPT.verdict).length;
      if (n !== 1) out.push({ step, message: `${n} ${HISTORY_KEPT.kind} alert(s) keyed ${HISTORY_KEPT.verdict} at this step, where a probe that fails as the request did raises one` });
      const turn = at('kept')[0];
      if (!turn) return out.push({ step: `${ctx.seed}.kept`, message: `couldn't judge: no request at this step, after the third failure in a row at ${step}` });
      const lost = KEEP_STEPS.map((k) => canary(ctx.seed, k, 'in')).filter((c) => !carries(turn, c));
      if (lost.length) out.push({ step: turn.step, message: `request ${turn.id}, the first after the third failure in a row at ${step}, lacks ${lost.join(' ')}, which a kept history still holds` });
      if (markers(turn) !== markers(failed)) out.push({ step: turn.step, message: `request ${turn.id}, the first after the third failure in a row at ${step}, carries ${markers(turn)} rewind marker(s) where ${failed.id} carried ${markers(failed)}, and a kept history adds none` });
    };
    const streaks = [BREAKER_STEPS, ...(keeps ? [KEEP_STEPS] : [])];
    for (const steps of streaks) {
      steps.forEach((id, i) => {
        const step = `${ctx.seed}.${id}`;
        const mine = at(id);
        const failed = mine.find((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status);
        if (!failed) return out.push({ step, message: `couldn't judge: no request at this step was answered with the stand-in's ${INVALID.status}` });
        if (i === steps.length - 1 && steps === KEEP_STEPS) return kept(id, failed);
        if (i === steps.length - 1) {
          rewound(id, 'failed', failed);
          if (!keeps) return;
          judged++;
          const probe = probed(step, failed);
          const retry = mine.find((r) => r.seq > failed.seq);
          if (!probe) out.push({ step, message: `no probe reached the stand-in at this step after the failed ${failed.id}, where a breaker that raises ${HISTORY_KEPT.kind} sends the failed request without its history before it sheds` });
          else if (retry && retry.seq < probe.seq) out.push({ step, message: `request ${retry.id} came after the failed ${failed.id} and before its probe, where a breaker that raises ${HISTORY_KEPT.kind} sheds and retries only once its probe is answered` });
          return;
        }
        judged++;
        const next = mine.find((r) => r.seq > failed.seq);
        if (next) out.push({ step, message: `request ${next.id} followed the failed ${failed.id} at this step, where the breaker waits for the third failure in a row` });
      });
    }
    const trips = streaks.map((steps) => `${ctx.seed}.${steps.at(-1)}`);
    const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'hard-down')
      .reduce((m, e) => m.set(e.step, (m.get(e.step) ?? 0) + 1), new Map());
    const tripped = streaks.filter((steps) => at(steps.at(-1)!).some((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status)).map((steps) => `${ctx.seed}.${steps.at(-1)}`);
    judged += tripped.length;
    for (const step of new Set([...alerts.keys(), ...tripped])) {
      const n = alerts.get(step) ?? 0;
      if (trips.includes(step) && n !== 1) out.push({ step, message: `${n} hard-down alert(s) at this step, where the breaker's trip at the third failure in a row raises one` });
      if (!trips.includes(step)) out.push({ step, message: `${n} hard-down alert(s) at this step, where no streak of failures reaches its third` });
    }
    const unstuck = at('unstick').filter((r) => r.answer?.stop === 'refusal');
    if (!unstuck.length) out.push({ step: `${ctx.seed}.unstick`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
    else rewound('unstick', 'refused', unstuck.at(-1)!, { shed: [canary(ctx.seed, BREAKER_STEPS.at(-1)!, 'r1')] });
    const failpub = `${ctx.seed}.failpub`;
    const published = at('failpub').at(-1);
    const refusedThere = run.log.some((e) => e.kind === 'undelivered' && e.step === failpub && !/\bno locus\b/.test((e.reason ?? '') as string));
    const told = published && run.records.find((r) => r.seq > published.seq && r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
    const notices = (r: RequestRecord) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => b.notice === SEND_FAILED_NOTICE).length;
    if (!published) out.push({ step: failpub, message: 'couldn\'t judge: no request at this step' });
    else if (!refusedThere) out.push({ step: failpub, message: 'couldn\'t judge: the driver heard no route failure at this step other than one with no locus, so nothing for a later request to tell of' });
    else if (!told) out.push({ step: failpub, message: `couldn't judge: no request followed ${published.id}, at whose step the driver heard a route failure other than one with no locus` });
    else {
      judged++;
      if (notices(told) !== notices(published) + 1) out.push({ step: told.step, message: `request ${told.id}, the next after ${published.id}, at whose step the driver heard a route failure other than one with no locus, carries ${notices(told)} [${SEND_FAILED_NOTICE}] notice(s) where ${published.id} carried ${notices(published)}, and agent-framework adds one for such a failure of a reply routed by its turn` });
    }
    return withJudged(out, judged);
  },
} satisfies Workload;

// agent-framework's rewind marker opens with its tag (notice-tags.ts NOTICE_TAG.refusalRewind) and the count of turns
// set aside (framework.ts updateRewindMarker). The tag is `refusal-rewind` at 0.33.0, and agent-framework#1000 renames
// it `turns-set-aside`, so a base and its head can each write either.
const REWIND_NOTICES = ['refusal-rewind', 'turns-set-aside'];
const REWIND_MARKS = REWIND_NOTICES.map((tag) => `[${tag}] The `);

const BREAKER_STEPS = ['break.1', 'break.2', 'break.3'];
const EXTRACTION = 'refuse.reasoning-extraction';
const KEEP_STEPS = ['keep.1', 'keep.2', 'keep.3'];
