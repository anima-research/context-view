import { FIXTURE_AGENT, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL, READER } from '../strategies/script.ts';
import { phaseTurn, readsOf, summarises, tunedOut, writer } from './turns.ts';
import type { Workload } from './workloads.ts';
import type { Unreadable } from '../strategies/invariants.ts';
import type { Configuration } from './workloads.ts';
import type { Writer } from './turns.ts';

// agent-framework's coordinator ends a tune-out past its wake budget, and a reader's plain prose has no destination
// (the host asks it again), so the reader reports with `deliver_summary` and ends with `skip_reply`.
// A persistent reader is the agent `Subconscious`; reader forks are named `reader/<resident>/<epoch>/<n>`
// (agent-framework 0.33.0's tune-out coordinator), so a reader turn is matched by that prefix.
const readerOf = (configuration: Configuration) => (configuration.subconscious?.reader === 'forks' ? { prefix: `reader/${configuration.agent?.name ?? FIXTURE_AGENT}/` } : { name: 'Subconscious' });

const W1_KEEP = 'w1-keep';
const W1_SIDE = 'w1-side';

function allExcept(w: Writer) {
  const said = (step: string, k: number) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  const focus = w.turn('focus', { calls: 0, more: { channel: W1_KEEP, namedAnywhere: true } });
  focus.replies = [
    { text: said('focus', 1), calls: [{ name: 'tune_out', input: { channelId: W1_KEEP, scope: 'all-except', durationSeconds: 150, cadenceSeconds: 60 } }] },
    { text: said('focus', 2) },
  ];
  const [side, chat] = [w.c('held', 'side'), w.c('held', 'chat')];
  const held = {
    id: w.id('held'), segment: 'W1', kind: 'deliver', topic: 'W1', canaries: [side, chat], tunedOut: [side, chat],
    messages: [
      { channel: W1_SIDE, id: `${w.id('held')}.side`, participant: 'Wren', text: `${side} ${prose(600, `${w.id('held')}:side`)}`, held: true },
      { channel: CHANNEL, id: `${w.id('held')}.chat`, participant: 'Tavy', text: `${chat} ${prose(600, `${w.id('held')}:chat`)}`, held: true },
    ],
  };
  const summary = w.c('look', 'sum');
  const look = {
    id: w.id('look'), segment: 'W1', kind: 'advance', ms: 61_000, canaries: [], inputs: [], addressed: false, reader: { name: 'Subconscious' }, replies: [],
    subs: [{ marker: READER, canaries: [side], namedAnywhere: true, replies: [
      { calls: [{ name: 'deliver_summary', input: { text: `${summary} ${prose(300, `${w.id('look')}:sum`)}`, channelId: W1_SIDE } }] },
      { calls: [{ name: 'skip_reply', input: {} }] },
    ] }],
  };
  const release = {
    id: w.id('release'), segment: 'W1', kind: 'advance', ms: 90_000, canaries: [side, summary], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said('release', 1), calls: [{ name: 'skip_reply', input: {} }] }],
    subs: [{ marker: READER, canaries: [side], namedAnywhere: true, replies: [{ calls: [{ name: 'skip_reply', input: {} }] }] }],
  };
  return [focus, held, look, release];
}

export const W1 = {
  from: null,
  turns: 70,
  property: 'grows: L1, L2 and L3 summaries form as the store grows (configurations that summarise)',
  steps(ctx) {
    const w = writer(ctx, 'W1');
    const steps = [];
    for (let n = 1; n <= this.turns; n++) steps.push(w.turn(n, { ...phaseTurn(n), ...(n === this.turns ? { more: { reads: ['state'] } } : {}) }));
    if (['H4', 'H4b'].includes(ctx.configurationName)) tunedOut(w, steps, 6, { before: { 4: [w.other('undo', 'command', { command: '/undo' })] }, reader: readerOf(ctx.configuration), ...(ctx.configurationName === 'H4b' ? { attach: (k) => k === 6 } : {}) });
    if (ctx.configurationName === 'H4') steps.push(...allExcept(w));
    return steps;
  },
  check(run, ctx) {
    if (!summarises(ctx.configuration)) return withJudged([{ step: null, message: 'couldn\'t judge: the property needs a configuration that summarises, and this one doesn\'t' }], 0);
    const last = readsOf(run, 'state').at(-1);
    if (!last) return withJudged([{ step: null, message: 'couldn\'t judge: the run logged no state read' }], 0);
    const got = (last.answer as { maxLevel?: number | Unreadable } | undefined)?.maxLevel;
    if (typeof got !== 'number') return withJudged([{ step: last.step ?? null, message: `couldn't judge: the state read gave no level for the store${typeof got?.unreadable === 'string' ? ` (unreadable: ${got.unreadable})` : ''}` }], 0);
    return withJudged(got >= 3 ? [] : [{ step: last.step ?? null, message: `the store reached L${got} in ${this.turns} turns, short of L3` }], 1);
  },
} satisfies Workload & { turns: number };
