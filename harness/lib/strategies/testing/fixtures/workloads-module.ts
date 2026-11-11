// @ts-nocheck
// The workloads module's guard (run.ts --workloads; harness/README.md, "A workloads module"): one tiny run using every
// step kind and field a replay's generator emits, and both stand-in setup options. A wake's deferred arrival rides a
// channel whose wake rule defers it, then the trigger wakes the agent, whose first reply calls the fixture's tool; an
// advance moves the clock between wakes, past the keepalive's refresh; a second wake is a trigger alone. The driver
// ignores a step field it doesn't know (driver.ts refuses only an unknown kind), so ../workloads-module.e2e.ts asserts
// each field's effect in the record or the report: a harness change that renames or drops one of them fails there. The
// stand-in options are held by name, since startStandin refuses one it doesn't take, and by their unit tests for their
// effects. Where the generator gains a field or an option, this module gains it in the same change.
const DEFER = 'replay-defer';
const TOOL = 'mcpl--fixture--result';

export const WORKLOADS = {
  Wmod: {
    from: null,
    compresses: false,
    // A replay's workload owns no check of its own: its property, that each wake runs as scripted, is check 1's, every turn
    // answered, so its check names that check for check 14's count.
    property: 'each wake runs as scripted, judged by check 1: every turn its steps start is answered',
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
};

// C9h is the view's frontdesk configuration, whose provenance header carries a delivered message's topic (and whose
// topic boundaries key on it): the one place `topic` reaches a request.
export const RUNS = ['H1/Wmod', 'C9h/Wmod'];
