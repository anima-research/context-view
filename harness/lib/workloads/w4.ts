// @ts-nocheck
import { withJudged } from '../strategies/checks.ts';
import { SIZES, writer } from './turns.ts';

export const W4 = {
  from: 'checkpoint',
  turns: 4,
  property: 'thinking: no call this workload makes goes out parted from the thinking that led to it, which comes ahead of it in its message',
  steps(ctx) {
    const w = writer(ctx, 'W4');
    return Array.from({ length: this.turns }, (_, i) => w.turn(i + 1, { thinking: w.between(SIZES.call), callId: () => `t${ctx.seed}_${i + 1}` }));
  },
  check(run, ctx) {
    const own = new RegExp(`^t${ctx.seed}_\\d+$`);
    const out = [];
    let judged = 0;
    for (const r of run.records.filter((x) => x.kind === 'agent')) {
      for (const m of r.messages ?? []) {
        let since = 0;
        const parted = [];
        m.blocks.forEach((b, k) => {
          if (b.type !== 'tool_use') return;
          if (own.test(String(b.toolUseId))) {
            judged++;
            if (!m.blocks.slice(since, k).some((x) => x.type === 'thinking' || x.type === 'redacted_thinking')) parted.push(b.toolUseId);
          }
          since = k + 1;
        });
        if (parted.length) out.push({ step: r.step, message: `request ${r.id}: a call went out without its thinking (${parted.join(', ')})` });
      }
    }
    return withJudged(out, judged);
  },
};
