// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { writer } from './turns.ts';

export const W18 = {
  from: 'checkpoint',
  property: 'removals: no request that arrives after a removal lands carries the removed message, raw or for a summariser to summarise',
  steps(ctx) {
    const w = writer(ctx, 'W18');
    const out = w.turn(2);
    Object.assign(out, { summariserHold: { level: 1, during: [{ remove: { messages: [{ fromHeld: 0 }] } }] }, badAnswers: ['empty'] });
    return [w.turn(1), out, w.turn(3)];
  },
  check(run, ctx) {
    return removalFates(run, this.steps(ctx));
  },
};

function removalFates(run, steps) {
  const byId = new Map(run.records.map((r) => [r.id, r]));
  const carried = (r) => (r.kind === 'summariser' ? r.sent?.canaries ?? [] : (r.messages ?? []).flatMap((m) => m.blocks).flatMap((b) => b.canaries ?? []));
  const out = [];
  let judged = 0;
  for (const s of steps.filter((x) => x.summariserHold)) {
    const landed = run.log.findIndex((e) => e.kind === 'remove' && e.step === s.id);
    const released = landed < 0 ? -1 : run.log.findIndex((e) => e.kind === 'send' && e.via === 'release' && e.request === run.log[landed].during);
    if (landed < 0 || released < landed) {
      out.push({ step: s.id, message: `couldn't judge: no removal landed while the step's summariser request was held` });
      continue;
    }
    const removals = run.log.filter((e) => e.kind === 'remove' && e.step === s.id).length;
    if (removals > 1) {
      out.push({ step: s.id, message: `couldn't judge: the step made ${removals} removals, and W18 judges a step's one removal` });
      continue;
    }
    const sent = run.log.slice(0, landed).findLastIndex((e) => e.kind === 'send' && e.via === 'module' && e.op === 'remove' && e.step === s.id);
    const inside = run.log.slice(sent + 1, landed).filter((e) => e.kind === 'request').map((e) => e.request.id);
    const unsure = sent < 0 || inside.length > 0;
    if (unsure) out.push({ step: s.id, message: `couldn't judge: ${sent < 0 ? 'the removal\'s send isn\'t in the log' : `request ${inside.join(', ')} arrived while the removal was being made, between the driver's remove and its answer, so whether it was built before the removal or after can't be told`}` });
    const removed = run.log[landed].canaries;
    const after = run.log.slice(landed + 1).filter((e) => e.kind === 'request').map((e) => byId.get(e.request.id)).filter(Boolean);
    if (!removed.length || !after.length) {
      if (!unsure) out.push({ step: s.id, message: `couldn't judge: ${!removed.length ? 'the removed message carried no canary' : 'no request came after the removal landed'}` });
      continue;
    }
    if (!unsure) judged++;
    for (const r of after) {
      const kept = removed.filter((c) => carried(r).includes(c));
      if (kept.length) out.push({ step: r.step, request: r.id, message: `request ${r.id}, which arrived after the removal at ${s.id} landed, carries ${kept.join(' ')}` });
    }
  }
  return withJudged(out, judged);
}
