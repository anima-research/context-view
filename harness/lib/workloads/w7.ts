// @ts-nocheck
import { judgedBy, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { TOOL } from '../strategies/script.ts';
import { REFUSED_CONTENT } from '../standin/summariser.ts';
import { SIZES, WEB_UI, phaseTurn, writer } from './turns.ts';

const REFUSED_TURN = 3;

function subagentTurn(w, ctx, step, rounds) {
  const marker = `[[knowledge:${ctx.seed}]]`;
  const sid = w.id(step);
  const subCanaries = [w.c(step, 'task')];
  const subReplies = rounds.map((round, i) => {
    const calls = round.calls.map((input, j) => {
      const callCanary = w.c(step, `s${i + 1}call${j + 1}`);
      subCanaries.push(callCanary);
      return { name: TOOL, input: { ...input, canary: callCanary } };
    });
    return { text: `${w.c(step, `s${i + 1}`)} ${prose(w.between(SIZES.call), `${sid}:s${i + 1}`)}`, calls, settle: true };
  });
  const report = w.c(step, 'report');
  subReplies.push({ text: `${report} ${prose(w.between(SIZES.reply), `${sid}:report`)}`, settle: true });
  const t = w.turn(step, { calls: 0 });
  return {
    ...t,
    canaries: [...t.canaries, report],
    replies: [
      { text: `${w.c(step, 'r1')} ${prose(200, `${sid}:r1`)}`, calls: [{ name: 'subagent--spawn', input: { name: `knowledge-${ctx.seed}`, systemPrompt: `${marker} You are the fixture's knowledge subagent.`, task: `${w.c(step, 'task')} ${prose(w.between(SIZES.user), `${sid}:task`)}`, sync: true } }] },
      { text: `${w.c(step, 'r2')} ${prose(w.between(SIZES.reply), `${sid}:r2`)}` },
    ],
    subs: [{ marker, canaries: subCanaries, replies: subReplies }],
  };
}

// A refused chunk's two variants: the unnamed refusal after output began, and the refusal before any output that the
// Messages API names reasoning_extraction, the one category a host decides on.
const EXTRACTION = 'chunk-refused-reasoning-extraction';
const chunked = (variant) => variant === 'chunk-refused' || variant === EXTRACTION;

export const W7 = {
  from: 'checkpoint',
  turns: 21,
  property: 'failures: at each step, the summariser requests the stand-in refuses, its merges or those carrying the content it refuses, raise one off-path refusal alert each, and nothing else raises one; content the summariser refuses reaches it only in the slice it is asked to remember; and in chunk-refused no summariser request carries a membrane repair mark, which under H1 two turns that each reuse their own call id over their rounds test, an operator having suppressed the first one\'s first result and the second one\'s first call',
  variants: ['merges-refused', 'merges-rejected', 'fable-no-tools', 'no-tools', 'chunk-refused', EXTRACTION],
  owns: (variant) => (variant === 'merges-refused' || chunked(variant) ? [{ check: 1, what: 'refusal-offpath' }] : []),
  fromEmpty: (variant) => variant === 'fable-no-tools' || variant === 'no-tools',
  standin: (variant) => ({ refuseMerges: variant === 'merges-refused', rejectMerges: variant === 'merges-rejected', refuseContent: chunked(variant), ...(variant === EXTRACTION ? { refusalCategory: 'reasoning_extraction' } : {}) }),
  recipe: (variant, capabilities, setup) => ({
    ...(chunked(variant) && setup === 'H1' ? { modules: { webui: WEB_UI } } : {}),
    ...(variant === 'fable-no-tools' || variant === 'no-tools' ? { agent: { allowedTools: [] } } : {}),
    ...(variant === 'fable-no-tools' ? { agent: { allowedTools: [], strategy: { compressionModel: 'claude-fable-5-1' } } } : {}),
  }),
  steps(ctx) {
    const w = writer(ctx, 'W7');
    const noTools = ['fable-no-tools', 'no-tools'].includes(ctx.variant);
    const turns = noTools ? 32 : this.turns;
    if (ctx.configurationName === 'H2') {
      const rounds = [];
      for (let n = 1; n <= turns; n++) {
        const plan = phaseTurn(n);
        for (let k = 0; plan.calls && k < (plan.rounds ?? 1); k++) rounds.push({ calls: Array.from({ length: plan.calls }, () => ({ kind: 'prose', size: w.between(SIZES.result) })) });
      }
      return [subagentTurn(w, ctx, 1, rounds)];
    }
    const steps = [];
    for (let n = 1; n <= turns; n++) {
      if (noTools) steps.push(w.turn(n, { calls: 0, size: SIZES.reading }));
      else if (chunked(ctx.variant)) {
        const reused = ctx.configurationName === 'H1' && n <= 2;
        steps.push(w.turn(n, { ...phaseTurn(n), ...(n === REFUSED_TURN ? { mark: REFUSED_CONTENT } : {}), ...(reused ? { callId: () => `t${ctx.seed}_reuse_${n}` } : {}) }));
        if (reused && n === 1) steps.push(w.other(`${n}.unanswered`, 'suppress', { messages: [{ canary: w.c(n, 'call1') }] }));
        if (reused && n === 2) steps.push(w.other(`${n}.orphaned`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
      }
      else steps.push(w.turn(n, ctx.variant === 'merges-refused' ? phaseTurn(n) : {}));
    }
    return steps;
  },
  check(run, ctx) {
    const out = [];
    const calls = run.records.filter((r) => r.kind === 'summariser');
    if (ctx.variant === 'merges-refused') {
      const refused = calls.filter((r) => r.answer?.shape === 'refusal');
      const alerts = refusalAlerts(run, refused, 'merge(s)');
      if (!refused.length) return withJudged([{ step: null, message: 'couldn\'t judge: the stand-in refused no merge' }, ...alerts], 0);
      return withJudged(alerts, refused.length);
    }
    if (chunked(ctx.variant)) {
      const carrying = calls.filter((r) => r.carried);
      const alerts = refusalAlerts(run, calls.filter((r) => r.answer?.shape === 'refusal'), 'summariser request(s)');
      const marked = calls.flatMap((r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => (b.repairs ?? []).filter((mark) => mark.startsWith('membrane:')).map((mark) => ({ step: r.step, request: r.id, message: `summariser request ${r.id} carries membrane's ${mark.slice('membrane:'.length)} repair mark, so context-manager handed it a call or result unpaired` })))));
      const judgedMarks = `${calls.length} summariser request(s) judged for membrane repair marks`;
      if (!carrying.length) return withJudged([{ step: null, message: 'couldn\'t judge: no summariser request carried the refused content' }, ...alerts, ...marked], 0, judgedMarks);
      const unplaced = carrying.filter((r) => r.carried === 'unplaced');
      if (unplaced.length) return withJudged([{ step: unplaced[0].step, message: `couldn't judge: ${unplaced.length} L1 request(s) carried the refused content with no single notice opening the slice they asked the summariser to remember, so where it sat can't be read` }, ...alerts, ...marked], 0, judgedMarks);
      const byStep = new Map();
      for (const r of carrying.filter((x) => x.carried !== 'slice')) {
        const at = byStep.get(r.step) ?? { ahead: 0, merge: 0 };
        at[r.carried]++;
        byStep.set(r.step, at);
      }
      for (const [step, { ahead, merge }] of byStep) {
        out.push({ step, message: [
          ahead ? `${ahead} L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember` : null,
          merge ? `${merge} merge request(s) carried it` : null,
        ].filter(Boolean).join(', and ') });
      }
      out.push(...alerts, ...marked);
      return withJudged(out, carrying.length, judgedMarks);
    }
    return judgedBy(out, 1);
  },
};

function refusalAlerts(run, refused, noun) {
  const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'refusal-offpath');
  const count = (list) => list.reduce((m, x) => m.set(x.step, (m.get(x.step) ?? 0) + 1), new Map());
  const byStep = count(refused);
  const alertsBy = count(alerts);
  const out = [];
  for (const step of new Set([...byStep.keys(), ...alertsBy.keys()])) {
    const n = byStep.get(step) ?? 0;
    const a = alertsBy.get(step) ?? 0;
    if (n !== a) out.push({ step, message: `${n} refused ${noun} at this step raised ${a} off-path refusal alert(s), where each raises one and nothing else does` });
  }
  return out;
}
