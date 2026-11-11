// @ts-nocheck
// The workloads module's guard (run.ts --workloads; harness/README.md, "A workloads module"): one tiny run using every
// step kind and field a replay's generator emits, and both stand-in setup options. A wake's deferred arrival rides a
// channel whose wake rule defers it, then the trigger wakes the agent, whose first reply calls the fixture's tool; an
// advance moves the clock between wakes, past the keepalive's refresh; a second wake is a trigger alone. The driver
// ignores a step field it doesn't know (driver.ts refuses only an unknown kind), so e2e/workloads-module.e2e.ts asserts
// each one's effect in the record: a harness change that renames or drops one of them fails there. Where the generator
// gains a field, this module gains it in the same change.
const DEFER = 'replay-defer';
const TOOL = 'mcpl--fixture--result';

export const WORKLOADS = {
  Wmod: {
    from: null,
    compresses: false,
    property: 'a workloads module\'s run: deferred arrivals reach the next woken request, replies call the fixture\'s tool, an advance moves the clock and the keepalive refreshes',
    recipe: () => ({ agent: { cacheKeepalive: { enabled: true } }, modules: { wake: { policies: [{ name: DEFER, match: { channel: `*${DEFER}` }, behavior: 'defer' }], default: 'always' } } }),
    standin: () => ({ refreshes: true, summaryTokens: { 1: 300 } }),
    steps(ctx) {
      const c = (step, part) => `[[c:${ctx.seed}.${step}.${part}]]`;
      const id = (step) => `${ctx.seed}.${step}`;
      const text = (canary, words) => `${canary} ${Array.from({ length: words }, (_, i) => ['river', 'stone', 'lantern', 'harbor'][i % 4]).join(' ')}`;
      return [
        {
          id: id('w1'), segment: 'Wmod', kind: 'deliver', topic: 'Wmod',
          messages: [
            { channel: DEFER, id: id('w1.d1'), participant: 'Ash', text: text(c('w1', 'd1'), 40) },
            { channel: 'chat', id: id('w1.t'), participant: 'Tavy', text: text(c('w1', 'in'), 60) },
          ],
          canaries: [c('w1', 'd1'), c('w1', 'in'), c('w1', 'call1')],
          replies: [
            { text: `${c('w1', 'r1')} looking`, calls: [{ name: TOOL, input: { kind: 'prose', size: 2000, canary: c('w1', 'call1') } }] },
            { text: `${c('w1', 'r2')} done` },
          ],
        },
        { id: id('gap'), segment: 'Wmod', kind: 'advance', ms: 50 * 60_000, canaries: [], inputs: [], addressed: false, replies: [] },
        {
          id: id('w2'), segment: 'Wmod', kind: 'deliver', topic: 'Wmod',
          messages: [{ channel: 'chat', id: id('w2.t'), participant: 'Tavy', text: text(c('w2', 'in'), 60) }],
          canaries: [c('w2', 'in')],
          replies: [{ text: `${c('w2', 'r1')} noted` }],
        },
      ];
    },
    check: () => [],
  },
};

export const RUNS = ['H1/Wmod'];
