import { FIXTURE_AGENT, assemblies, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { tunedOut, writer } from './turns.ts';
import type { Delivered, Step } from '../strategies/script.ts';
import type { Context, Run, Workload } from './workloads.ts';

const W8_SIDE = 'w8-side';
// agent-framework's preflight refuses a budget no store fits and names its floor; the panel refuses one at or below
// the response reserve.
const edge = (ctx: Context) => (ctx.reserve as number) + 1000;

export const W8 = {
  from: 'checkpoint',
  turns: 16,
  property: 'tight: with the budget lowered to the edge and restored, a configuration that compiled every turn before the lowering does so again within two steps of the restore',
  variants: ['enforced', 'unenforced'],
  recipe: (variant: string | null) => ({ agent: { strategy: { enforceBudget: variant === 'enforced' } } }),
  steps(ctx): Step[] {
    const w = writer(ctx, 'W8');
    const underCut = (n: number) => n >= 5 && n <= 14;
    const budget = ctx.budget;
    const cut = (step: string | number, tokens: number) => w.other(`${step}.budget`, 'panel', { op: 'settings-update', params: { contextBudgetTokens: tokens, immediate: true }, edge: { reserve: ctx.reserve } });
    if (ctx.configurationName === 'H4') {
      const forReader = (step: string, tokens: number) => { const c = cut(step, tokens); return { ...c, params: { ...c.params, agent: 'Subconscious' } }; };
      const steps: Step[] = [];
      tunedOut(w, steps, this.turns, { mayFail: underCut, before: { 5: [forReader('h5', Math.round((budget as number) * 0.6))], 9: [forReader('h9', edge(ctx))], 13: [forReader('h13', budget as number)] } });
      return steps;
    }
    const steps: Step[] = [];
    for (let n = 1; n <= this.turns; n++) {
      if (n === 5) steps.push(cut(n, Math.round((budget as number) * 0.6)));
      if (n === 9) steps.push(cut(n, edge(ctx)));
      if (n === 13) steps.push(cut(n, budget as number));
      const t = w.turn(n, underCut(n) ? { more: { mayFail: true } } : {});
      if (n === 10 && ctx.configurationName === 'H1') {
        const arrival = (part: string, more: Partial<Delivered> = {}) => ({ id: `${w.id(n)}.${part}`, text: `${w.c(n, `${part}.in`)} ${prose(300, `${w.id(n)}:${part}`)}`, ...more }) as Delivered;
        t.summariserHold = { level: 1, during: [{ budgetHeld: true }, { deliver: arrival('arrival', { participant: 'Tavy' }) }, { deliver: arrival('side', { participant: 'Wren', channel: W8_SIDE, tags: ['chat:addressed'] }) }, { advance: 61_000 }] };
        t.canaries.push(w.c(n, 'arrival.in'), w.c(n, 'side.in'));
      }
      steps.push(t);
    }
    return steps;
  },
  check(run, ctx) {
    if (ctx.configurationName === 'H4') return restoredWithin(run, 'Subconscious', (k) => `${ctx.seed}.h${k}`, 'the reader\'s turn');
    return restoredWithin(run, FIXTURE_AGENT, (n) => `${ctx.seed}.${n}`, 'step');
  },
} satisfies Workload & { turns: number };

function restoredWithin(run: Run, agent: string, stepOf: (n: number) => string, noun: string) {
  const firstByStep = new Map<string | null, ReturnType<typeof assemblies>[number]>();
  for (const a of assemblies(run.log, agent)) if (!firstByStep.has(a.step)) firstByStep.set(a.step, a);
  const outcome = (n: number) => firstByStep.get(stepOf(n))?.outcome ?? 'no request';
  const before = [1, 2, 3, 4].filter((n) => outcome(n) !== 'compiled');
  if (before.length) return withJudged([{ step: stepOf(before[0]), message: `couldn't judge the restore: ${before.map((n) => `${noun} ${n} ${outcome(n)}`).join(', ')}, before the budget was lowered` }], 0);
  return withJudged([15, 16].filter((n) => outcome(n) !== 'compiled').map((n) => ({ step: stepOf(n), message: `${noun} ${n}: ${outcome(n)} ${n - 13} turn(s) after the budget was restored` })), 2);
}
