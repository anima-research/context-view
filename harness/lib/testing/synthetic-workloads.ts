import type { Step } from '../strategies/script.ts';
import type { ConfigurationPart, Workload } from '../workloads/workloads.ts';

const DEFER = 'replay-defer';
const TOOL = 'mcpl--fixture--result';

export const WORKLOADS = {
  Wmod: {
    from: null,
    compresses: false,
    property: 'each wake runs as scripted, judged by check 1: every turn its steps start is answered',
    recipe: (): ConfigurationPart => ({ agent: { cacheKeepalive: { enabled: true } }, modules: { wake: { policies: [{ name: DEFER, match: { channel: `*${DEFER}` }, behavior: 'defer' }], default: 'always' } } }),
    standin: () => ({ refreshes: true, summaryTokens: { 1: 300 } }),
    steps(ctx): Step[] {
      const c = (step: string, part: string) => `[[c:${ctx.seed}.${step}.${part}]]`;
      const id = (step: string) => `${ctx.seed}.${step}`;
      const text = (canary: string, words: number) => `${canary} ${Array.from({ length: words }, (_, i) => ['river', 'stone', 'lantern', 'harbor'][i % 4]).join(' ')}`;
      return [
        {
          id: id('w1'), segment: 'Wmod', kind: 'deliver', topic: 'Wmod',
          messages: [
            { channel: DEFER, id: id('w1.d1'), participant: 'Ash', text: text(c('w1', 'd1'), 40) },
            { channel: 'chat', id: id('w1.t'), participant: 'Tavy', text: text(c('w1', 'in'), 60) },
          ],
          canaries: [c('w1', 'd1'), c('w1', 'in'), c('w1', 'call1')],
          replies: [
            { thinking: text(c('w1', 'th1'), 30), text: `${c('w1', 'r1')} looking`, calls: [{ name: TOOL, input: { kind: 'prose', size: 2000, canary: c('w1', 'call1'), pad: text(c('w1', 'pad'), 30) } }] },
            { text: `${c('w1', 'r2')} done` },
          ],
        },
        { id: id('gap'), segment: 'Wmod', kind: 'advance', ms: 50 * 60_000 },
        {
          id: id('w2'), segment: 'Wmod', kind: 'deliver', topic: 'Wmod',
          messages: [{ channel: 'chat', id: id('w2.t'), participant: 'Tavy', text: text(c('w2', 'in'), 60) }],
          canaries: [c('w2', 'in')],
          replies: [{ text: `${c('w2', 'r1')} noted` }],
        },
      ];
    },
    check: () => Object.assign([], { judgedBy: 1 }),
  },
} satisfies Record<string, Workload>;

export const RUNS = ['H1/Wmod', 'C9h/Wmod'];
