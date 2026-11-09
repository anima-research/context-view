import type { PriceTable } from './prices.ts';
import type { Figure, Sums, Usage } from './shapes.ts';

export interface UsageRecord { id?: string; kind: string; agent?: string; step?: string; tokens?: Partial<Record<Figure, number>> | null; transformations?: Array<{ type: string }> }
export interface HistoryStep { id: string; segment?: string; kind?: string; copyStore?: boolean }
export interface HealthEntry { kind?: string; health?: { ok?: boolean; data?: { contextComposition?: Record<string, { calibration?: { multiplier?: unknown; provisional?: unknown; reset?: unknown } }> } } }

const FIGURES: Figure[] = ['input', 'cacheRead', 'cacheWrite', 'output'];

export const droppedIn = (record: UsageRecord) => (record.transformations ?? []).filter((t) => t.type === 'thinking_dropped').length;

export function historySteps(steps: HistoryStep[], segment: string) {
  const own = steps.filter((s) => s.segment === segment);
  const closing = own.at(-1)?.kind === 'checkpoint' && own.at(-1)!.copyStore ? own.at(-1) : null;
  return new Set(own.filter((s) => s !== closing).map((s) => s.id));
}

/** A run's usage. With `prices`, the run's price table, each kind also sums what its requests cost and counts those
 *  with no price, or, where the host couldn't price, the usage says why. */
export function usageOf(records: UsageRecord[], log: HealthEntry[], agent: string, built: Set<string | undefined> = new Set(), prices: PriceTable | null = null): Usage {
  const priced = prices && prices.unread === undefined ? new Map(prices.requests.map((r) => [r.id, r.price])) : null;
  const kinds = sums(records, priced);
  const last = records.filter((r) => r.tokens && r.kind === 'agent' && (r.agent ?? 'primary') === 'primary' && !built.has(r.step)).at(-1);
  return {
    kinds,
    ...(built.size ? { history: sums(records.filter((r) => built.has(r.step)), priced) } : {}),
    lastDropped: last ? droppedIn(last) : null,
    calibration: calibrationOf(log, agent),
    ...(prices?.unread !== undefined ? { priceUnread: prices.unread } : {}),
  };
}

function sums(records: UsageRecord[], priced: Map<string, { total: number } | null> | null) {
  const kinds: Record<string, Sums> = {};
  for (const r of records) {
    if (!r.tokens) continue;
    const k = (kinds[r.kind] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, dropped: 0, ...(priced ? { cost: 0, unpriced: 0 } : {}) });
    k.requests += 1;
    for (const f of FIGURES) k[f] += r.tokens[f] ?? 0;
    k.dropped += droppedIn(r);
    if (priced) {
      const price = r.id === undefined ? undefined : priced.get(r.id);
      if (price) k.cost! += price.total;
      else k.unpriced! += 1;
    }
  }
  return kinds;
}

function calibrationOf(log: HealthEntry[], agent: string) {
  const read = log.filter((e) => e.health).at(-1);
  const c = read?.health!.data?.contextComposition?.[agent]?.calibration;
  if (!c || typeof c.multiplier !== 'number') return null;
  return { multiplier: c.multiplier, provisional: c.provisional === true, reset: c.reset != null };
}
