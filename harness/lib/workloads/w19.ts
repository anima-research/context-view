// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { INVALID, writer } from './turns.ts';

export const W19 = {
  from: null,
  compresses: false,
  property: 'an XML round\'s words when its stream ends past the round: after a round of words and a call whose continuation fails, with a 400 or a 529 retried, at a channel message or at the console, the first request after the failure carries a [speech-not-posted] notice after the round\'s call, read by its tag, and no post carries the round\'s words',
  steps(ctx) {
    const w = writer(ctx, 'W19');
    // agent-framework posts an XML round's words only when its stream completes, since membrane gives such a round
    // no native content (framework.ts pendingRoundSent, :28641), and otherwise names them in a [speech-not-posted]
    // notice it stores where the turn ends or a retry starts (nameUnpostedSpeech). A 400 isn't retried (membrane
    // 0.8.0 classifies it invalid_request); a 529 is, by the turn's error policy, with its default backoff, since a
    // retry-after hint makes the framework hold a resident for it instead (nonOwningProviderWait).
    const failing = (t, error, after = []) => ({ ...t, replies: [t.replies[0], { error }, ...after], w19: { call: w.c(t.id.slice(t.id.indexOf('.') + 1), 'call1'), round: w.c(t.id.slice(t.id.indexOf('.') + 1), 'r1') } });
    const said = (step) => w.turn(step, { calls: 0, more: { namedAnywhere: true } });
    const fail = failing(w.turn('fail', { more: { mayFail: true, namedAnywhere: true } }), INVALID);
    const retried = w.turn('retry', { more: { retries: true, namedAnywhere: true } });
    const retry = failing(retried, OVERLOADED_ONCE, [retried.replies[1]]);
    // In agent-framework a console message's turn is an operator's: its speech goes to no channel, and its failure is
    // the private one.
    const typed = w.turn('private', { more: { namedAnywhere: true } });
    const priv = failing({ id: typed.id, segment: 'W19', kind: 'console', text: typed.text, canaries: typed.canaries, namedAnywhere: true, addressed: false, mayFail: true, replies: typed.replies }, INVALID);
    return [said(1), fail, said('told'), retry, said('after'), priv, said('last')];
  },
  check(run, ctx) {
    const out = [];
    let judged = 0;
    const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary').sort((a, b) => a.seq - b.seq);
    const marksOf = (r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.xmlMarks ?? b.canaries ?? []));
    for (const s of this.steps(ctx).filter((x) => x.w19)) {
      for (const e of run.log) {
        const posted = e.kind === 'ipc' && /^(inference:published|mcpl:speech-routed)$/.test(e.event?.type ?? '') && String(e.event.text ?? '').includes(s.w19.round);
        if (posted) out.push({ step: s.id, message: `the round's words ${s.w19.round} were posted: ${e.event.type}` });
      }
      const failed = primary.find((r) => r.step === s.id && r.answer?.shape === 'error');
      if (!failed) { out.push({ step: s.id, message: 'couldn\'t judge: no request at this step was answered with an error' }); continue; }
      const next = primary.find((r) => r.seq > failed.seq);
      if (!next) { out.push({ step: s.id, message: `couldn't judge: no request followed the failed ${failed.id}` }); continue; }
      judged++;
      const marks = marksOf(next);
      const at = marks.lastIndexOf(s.w19.call);
      if (at < 0 || !marks.slice(at + 1).includes(SPEECH_NOT_POSTED)) out.push({ step: s.id, request: next.id, message: `request ${next.id}, the first after the failed round at ${s.id}, carries no ${SPEECH_NOT_POSTED} notice after ${s.w19.call}` });
    }
    return withJudged(out, judged);
  },
};

const OVERLOADED_ONCE = { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' };
const SPEECH_NOT_POSTED = '[speech-not-posted]';
