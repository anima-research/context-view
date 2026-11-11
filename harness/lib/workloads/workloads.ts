// @ts-nocheck
import { hash32 } from '../strategies/prose.ts';
import { VIRTUAL_FROM_MS } from '../strategies/bounds.ts';
import { streamBoundFor } from '../strategies/judge.ts';
import { WEB_UI, capable } from './turns.ts';
import { CONTINUATION, PREFIX } from './continuation.ts';
import { W1 } from './w1.ts';
import { W2 } from './w2.ts';
import { W4 } from './w4.ts';
import { W5 } from './w5.ts';
import { W6 } from './w6.ts';
import { W7 } from './w7.ts';
import { W8 } from './w8.ts';
import { W9 } from './w9.ts';
import { W11 } from './w11.ts';
import { W12 } from './w12.ts';
import { W13 } from './w13.ts';
import { W14 } from './w14.ts';
import { W15 } from './w15.ts';
import { W16 } from './w16.ts';
import { W17 } from './w17.ts';
import { W18 } from './w18.ts';
import { W19 } from './w19.ts';
import { W20 } from './w20.ts';
import type { Setup } from '../strategies/script.ts';

export const WORKLOADS = {
  prefix: PREFIX,
  continuation: CONTINUATION,
  W1,
  W2,
  W4,
  W5,
  W6,
  W7,
  W8,
  W9,
  W11,
  W12,
  W14,
  W15,
  W16,
  W13,
  W17,
  W18,
  W20,
  W19,
};

export const RUNS = [
  'H1/continuation', 'H1/continuation/rewrite-priced', 'H3/continuation',
  'H1b/continuation/from-0.9.0', 'H1b/continuation/from-0.20.0', 'H1b/continuation/from-0.23.0', 'H1b/continuation/fresh',
  'H1/W1', 'H4/W1', 'H4b/W1',
  'C3h/W2', 'H1/W2', 'H1b/W2',
  'H3/W4',
  'C5h/W5',
  'C8h/W6',
  'C3h/W7/merges-refused', 'C3h/W7/fable-no-tools', 'C3h/W7/no-tools',
  'H1/W7/merges-refused', 'H1/W7/merges-rejected', 'H2/W7/merges-refused', 'H1/W7/chunk-refused',
  'C14h/W7/merges-refused', 'C15h/W7/chunk-refused', 'C16h/W7/chunk-refused', 'C17h/W7/merges-refused', 'C17h/W7/chunk-refused',
  'C3h/W8/unenforced', 'C6h/W8/enforced', 'H1/W8/enforced', 'H4/W8/unenforced',
  'H3/W9', 'C3h/W9', 'C6h/W9', 'H1/W9',
  'H1/W14', 'H1b/W14',
  'H4/W15', 'H4t/W15',
  'C6h/W11', 'H1/W11',
  'P1/continuation', 'P2/continuation',
  'P3/continuation', 'P4/continuation',
  'P5/continuation',
  'H5/W12', 'H5b/W12', 'H5c/W12',
  'H1r/W16',
  'Hoff/W13',
  'H1/W13', 'Hcont/W13', 'Hlatest/W13', 'Hconv/W13', 'Hexpl/W13', 'Hhyb/W13', 'Hdis/W13', 'Hlock/W13', 'Hpriv/W13', 'Hretry/W13', 'Hfold/W13',
  'H6/continuation', 'H7/continuation',
  'H1c/W2', 'H1d/W2',
  'C9h/continuation',
  'C11h/continuation',
  'C12h/continuation', 'C20h/continuation',
  'C18h/continuation', 'C13h/continuation', 'C19h/continuation',
  'C21h/continuation', 'C23h/continuation',
  'H1/W17',
  'H1/W18',
  'H6/W19',
  'Hfleet/W20',
];

export function seedOf(id) {
  return 100 + (hash32(id) % 900000);
}

const merge = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

export const CHECKPOINT_GAP_MS = 24 * 60 * 60_000;

type Block = { [field: string]: unknown };
export type Configuration = Omit<Setup, 'gated'> & {
  privileged?: string[];
  fixtureOntology?: Block;
  fixtureSend?: boolean;
  fixtureServer?: { requestTimeoutMs?: number };
  kvUnifiedPolicy?: Block;
  account?: string;
  recording?: boolean;
  streamBound?: number;
};

const holdAdvances = (v, out = []) => {
  if (Array.isArray(v)) for (const x of v) holdAdvances(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'during' && Array.isArray(x)) for (const a of x) if (typeof a?.advance === 'number') out.push(a.advance);
      holdAdvances(x, out);
    }
  }
  return out;
};

export function refusal(step) {
  const subs = step.subs ?? [];
  const labels = subs.map((s) => s.as);
  if (subs.length > 1 && (labels.includes(undefined) || new Set(labels).size < labels.length)) return `it starts ${subs.length} subagents, and the stand-in tells two apart only by a label each (${labels.map((l) => l ?? 'none').join(', ')})`;
  const scripted = [step, ...subs].some((s) => s.replies?.length || s.spare?.length);
  const waits = step.kind === 'advance' && step.ms < VIRTUAL_FROM_MS && (scripted || step.verdict || step.review || step.gate);
  if (waits) return `it moves the clock ${step.ms} ms and waits on what that starts, and only a host timer of ${VIRTUAL_FROM_MS} ms or more runs on the run's clock`;
  const short = holdAdvances(step).filter((ms) => ms < VIRTUAL_FROM_MS);
  if (short.length) return `a hold in it moves the clock ${short.join(', ')} ms, and only a host timer of ${VIRTUAL_FROM_MS} ms or more runs on the run's clock`;
  return null;
}

const buildable = (steps) => {
  for (const step of steps) {
    const why = refusal(step);
    if (why) throw new Error(`step ${step.id} can't be run: ${why}`);
  }
  return steps;
};

export function runOf(id, configurations, facts, { prefixTurns = {}, workloads = WORKLOADS } = {}) {
  const [configName, workloadName, variant = null] = id.split('/');
  const base = configurations[configName];
  const workload = workloads[workloadName];
  if (!base || !workload || (variant !== null && !(workload.variants ?? []).includes(variant))) throw new Error(`no run ${id}: no such configuration, workload or variant`);
  const recipe = typeof workload.recipe === 'function' ? workload.recipe(variant, facts.capabilities, configName) : workload.recipe ?? {};
  const gated = Object.entries(base?.gated ?? {});
  const lacking = facts.capabilities === undefined || !gated.length ? [] : gated.map(([name]) => name).filter((name) => !capable(facts.capabilities)(name));
  const brought = gated.filter(([name]) => !lacking.includes(name)).reduce((c, [, part]) => merge(c, part), {});
  const modules = {
    ...(workload.needs?.webui ? { webui: WEB_UI } : {}),
    ...(workload.needs?.subagents ? { subagents: true } : {}),
  };
  const configuration = merge(merge(merge(base, brought), Object.keys(modules).length ? { modules } : {}), recipe);
  delete configuration.gated;
  for (const [name, on] of Object.entries(base.modules ?? {})) if (on === false) configuration.modules[name] = false;
  const strategy = configuration.agent?.strategy ?? {};
  const adaptive = strategy.type !== 'passthrough' && strategy.adaptiveResolution !== false;
  const seed = seedOf(id);
  const ctx = {
    seed,
    variant,
    configuration,
    configurationName: configName,
    budget: facts.budget,
    reserve: facts.maxTokens,
    streamBound: streamBoundFor({ ...configuration, ...(typeof facts.streamBound === 'number' ? { streamBound: facts.streamBound } : {}) }),
    adaptive,
    folding: adaptive ? strategy.foldingStrategy ?? 'kv-unified' : null,
    native: configuration.agent?.formatter !== 'anthropic-xml',
    prefixTurns: prefixTurns[configName],
    capabilities: facts.capabilities,
  };
  const fromEmpty = workload.from === null || workload.fromEmpty?.(variant, configName) || configName === 'H2';
  const history = typeof workload.from === 'string' && Object.hasOwn(WORKLOADS, workload.from) ? WORKLOADS[workload.from] : null;
  const builds = history !== null && (base.buildsHistory === true || workload.buildsFresh?.(variant) === true);
  const built = () => {
    const steps = history.steps(ctx);
    return [...steps.slice(0, -1), { ...steps.at(-1), gapMs: CHECKPOINT_GAP_MS }];
  };
  return {
    id,
    workload: workloadName,
    variant,
    seed,
    configuration,
    standin: typeof workload.standin === 'function' ? workload.standin(variant) : {},
    from: history ? (builds ? null : `${configName}/${workload.from}${workload.fromVariant?.(variant) ? `/${workload.fromVariant(variant)}` : ''}`) : fromEmpty ? null : `${configName}/${base.summarises === false ? 'W1' : 'W2'}`,
    steps: () => buildable([...lacking.map((name) => ({ id: `${seed}.absent.${name}`, segment: workloadName, kind: 'absent', stretch: name, canaries: [] })), ...(builds ? [...built(), ...workload.steps(ctx)] : workload.steps(ctx))]),
    check: (run) => workload.check(run, ctx),
    owns: typeof workload.owns === 'function' ? workload.owns(variant) : workload.owns ?? [],
    products: workload.products ? workload.products(configuration, variant) : [],
    compresses: typeof workload.compresses === 'function' ? workload.compresses(variant, configName) : workload.compresses !== false,
  };
}
