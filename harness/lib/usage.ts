import type { PriceTable } from './prices.ts';
import type { Step } from './strategies/script.ts';
import type { Context, Figure, Sums, Usage } from './shapes/interfaces.ts';

export interface UsageRecord { id?: string; kind: string; agent?: string; step?: string | null; tokens?: Partial<Record<Figure, number>> | null; transformations?: Array<{ type: string }>; seam?: number; apiChanged?: boolean; contextUnread?: string }
export type HistoryStep = Pick<Step, 'id' | 'segment' | 'kind' | 'copyStore'>;
export interface HealthEntry { kind?: string; health?: { ok?: unknown; data?: { contextComposition?: Record<string, { calibration?: { multiplier?: unknown; provisional?: unknown; reset?: unknown } | null } | null | undefined> | null } | null } }

const FIGURES: Figure[] = ['input', 'cacheRead', 'cacheWrite', 'output'];

export const droppedIn = (record: UsageRecord) => (record.transformations ?? []).filter((t) => t.type === 'thinking_dropped').length;

export function historySteps(steps: HistoryStep[], segment: string) {
  const own = steps.filter((s) => s.segment === segment);
  const closing = own.at(-1)?.kind === 'checkpoint' && own.at(-1)!.copyStore ? own.at(-1) : null;
  return new Set(own.filter((s) => s !== closing).map((s) => s.id));
}

export function usageOf(records: UsageRecord[], log: HealthEntry[], agent: string, built: Set<string | null | undefined> = new Set(), prices: PriceTable | null = null): Usage {
  const priced = prices && prices.unread === undefined ? new Map(prices.requests.map((r) => [r.id, r.price])) : null;
  const kinds = sums(records, priced);
  const last = records.filter((r) => r.tokens && r.kind === 'agent' && (r.agent ?? 'primary') === 'primary' && !built.has(r.step)).at(-1);
  const none = records.find((r) => r.contextUnread || r.apiChanged);
  return {
    kinds,
    ...(built.size ? { history: sums(records.filter((r) => built.has(r.step)), priced) } : {}),
    lastDropped: last ? droppedIn(last) : null,
    ...(none ? { contextNone: none.contextUnread ?? `request ${none.id} went through another API, or another dialect of one, than its agent's previous request` } : { context: contextOf(records) }),
    calibration: calibrationOf(log, agent),
    ...(prices?.unread !== undefined ? { priceUnread: prices.unread } : {}),
  };
}

function contextOf(records: UsageRecord[]): Context {
  const seams = records.filter((r) => r.tokens && (r.seam ?? 0) > 0).map((r) => r.seam!);
  const held = records.filter((r) => r.tokens && r.kind === 'agent').map((r) => (r.tokens!.input ?? 0) + (r.tokens!.cacheRead ?? 0) + (r.tokens!.cacheWrite ?? 0));
  return { seams: seams.length, out: seams.reduce((t, n) => t + n, 0), largest: Math.max(0, ...seams), peak: Math.max(0, ...held) };
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
