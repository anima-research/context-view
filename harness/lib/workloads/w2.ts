import { SIZES, writer } from './turns.ts';
import { W1 } from './w1.ts';
import type { Workload } from './workloads.ts';

const READING_PLAN = [
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1 }, { calls: 1 }, { calls: 0 },
  { calls: 1, rounds: 2 }, { calls: 1 },
  { calls: 0, paste: true },
  { calls: 0 },
];
const readingTurn = (n: number) => READING_PLAN[(n - 1) % READING_PLAN.length];

export const W2 = {
  from: null,
  turns: 70,
  property: 'reads: a store of reading-sized tool results, attachments and a paste reaches L3 by its end (the store is ready after each turn, or its compression lane paused until an instant of the clock, as the driver\'s settle requires)',
  steps(ctx) {
    const w = writer(ctx, 'W2');
    const steps = [];
    for (let n = 1; n <= this.turns; n++) {
      const plan = readingTurn(n);
      steps.push(w.turn(n, {
        calls: plan.calls,
        rounds: plan.rounds,
        ...(plan.paste ? { size: SIZES.document } : {}),
        attach: n % 7 === 0,
        result: (k, canaryText) => ({ kind: 'prose', size: w.between(SIZES.reading), canary: canaryText }),
        ...(n === this.turns ? { more: { reads: ['state'] } } : {}),
      }));
    }
    return steps;
  },
  check(run, ctx) {
    return W1.check.call(this, run, ctx);
  },
} satisfies Workload & { turns: number };
