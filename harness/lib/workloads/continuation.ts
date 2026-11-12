import { judgedBy } from '../strategies/checks.ts';
import { continuation, prefix, products } from '../strategies/script.ts';
import type { Product } from '../strategies/script.ts';
import type { ConfigurationPart, Workload } from './workloads.ts';

// v0.9.0 knows no window for the model, and its context-manager refuses the prefix's 90,000-character turn at its
// default budget, so the budget is the 160,000 of a resident who upgraded from it. It sends no binding control, so only
// an older account's binding rule lets it fold its history.
// agent-framework 0.28.0 to 0.31.x stored reasoning-loss notices, and 0.30.0 stores one when a compile leaves out stored
// thinking because the request's tools, system text or model changed (reasoning-loss.ts). v0.20.0's lockfile gives
// 0.30.0, so its prefix alone restarts under a prompt an operator changed, after its last turn that thinks, and its
// store keeps the notice an upgraded resident's store holds.
export const UPGRADES = ['from-0.9.0', 'from-0.20.0', 'from-0.23.0'];
const NOTICED = 'from-0.20.0';
const UPGRADED = { agent: { contextBudgetTokens: 160_000 }, account: 'older' } satisfies ConfigurationPart;
const PRICED = 'rewrite-priced';
// Any notice in the continuation's final store is the prefix's: no agent-framework from 0.32.0 on writes one. If a
// later release wrote reasoning-loss notices again, this would need the prefix's notice by identity.
const STORED_NOTICE: Product = { name: 'the reasoning-loss notice the older release stored, kept in the store', fromStore: (store) => store.messages.some((m) => m.reasoningLoss) };

export const PREFIX = {
  from: null,
  variants: UPGRADES,
  recipe: (variant): ConfigurationPart => (variant ? UPGRADED : {}),
  property: 'none: it writes the continuation\'s checkpoint and is no run of its own',
  steps: (ctx) => prefix(ctx.prefixTurns!, { promptChanged: ctx.variant === NOTICED }),
  check: () => [],
} satisfies Workload;

export const CONTINUATION = {
  from: 'prefix',
  variants: [...UPGRADES, 'fresh', PRICED],
  recipe: (variant): ConfigurationPart => (variant === PRICED ? { kvUnifiedPolicy: { rewriteLambda: 500 } } : variant ? UPGRADED : {}),
  fromVariant: (variant) => (UPGRADES.includes(variant as string) ? variant : null),
  buildsFresh: (variant) => variant === 'fresh',
  property: 'each segment produces what it exists to produce (check 2)',
  steps: (ctx) => continuation(ctx.configuration),
  check: () => judgedBy([], 2),
  products: (configuration, variant) => {
    const own = products(configuration);
    return variant === NOTICED ? { ...own, 'close-merge': [...own['close-merge'], STORED_NOTICE] } : own;
  },
} satisfies Workload;
