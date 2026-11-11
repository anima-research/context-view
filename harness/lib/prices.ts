import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessFailure } from './pool.ts';
import type { Figure } from './shapes/interfaces.ts';

export interface PriceCall {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite30mTokens: number;
  cacheWrite12hTokens: number;
  unclassifiedCacheWriteTokens: number;
  serviceTier?: string;
}

export interface CallPrice { total: number; [part: string]: unknown }

export interface PricedRecord {
  id: string;
  step?: string | null;
  kind: string;
  agent?: string;
  head?: { api?: string; dialect?: string; model?: string; serviceTier?: string | null } | null;
  usage?: unknown;
  tokens?: Partial<Record<Figure, number>> | null;
}

export interface PriceRow { id: string; step: string | null; kind: string; agent?: string; api: string | null; dialect?: string; call: PriceCall; price: CallPrice | null }

export interface PriceTable { unread?: string; requests: PriceRow[] }

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
const field = (o: unknown, ...path: string[]) => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

export function callOf(record: PricedRecord): PriceCall | null {
  if (!record.tokens) return null;
  const t = record.tokens;
  const written = count(t.cacheWrite);
  const call: PriceCall = {
    provider: '',
    model: record.head?.model ?? '',
    inputTokens: count(t.input),
    outputTokens: count(t.output),
    cacheReadTokens: count(t.cacheRead),
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWrite30mTokens: 0,
    cacheWrite12hTokens: 0,
    unclassifiedCacheWriteTokens: written,
  };
  const api = record.head?.api;
  const dialect = record.head?.dialect;
  const tier = record.head?.serviceTier;
  if (typeof tier === 'string') call.serviceTier = tier;
  if (api === 'messages') {
    const five = count(field(record.usage, 'cache_creation', 'ephemeral_5m_input_tokens'));
    const hour = count(field(record.usage, 'cache_creation', 'ephemeral_1h_input_tokens'));
    return { ...call, provider: dialect === 'bedrock' ? 'bedrock' : 'anthropic', cacheWrite5mTokens: five, cacheWrite1hTokens: hour, unclassifiedCacheWriteTokens: Math.max(0, written - five - hour) };
  }
  if (api === 'responses') {
    const lifetimes = field(record.usage, 'input_tokens_details', 'cache_write_tokens_details');
    const half = count(field(lifetimes, 'ttl_30m_tokens'));
    const twelve = count(field(lifetimes, 'ttl_12h_tokens'));
    return { ...call, provider: 'openai-responses', cacheWrite30mTokens: half, cacheWrite12hTokens: twelve, unclassifiedCacheWriteTokens: Math.max(0, written - half - twelve) };
  }
  const provider = api === 'codex' ? 'openai-codex'
    : api === 'chat-completions' ? (dialect === 'openrouter' ? 'openrouter' : 'openai-compatible')
    : String(api ?? 'unknown');
  return { ...call, provider };
}

const PRICING_BOUND_MS = 10_000;

const OUTPUT_KEPT_BYTES = 1024 * 1024;

export function hostPrices({ hostDir, calls, dir, timeoutMs = PRICING_BOUND_MS }: { hostDir: string; calls: PriceCall[]; dir: string; timeoutMs?: number }): { prices: Array<CallPrice | null> } | { unread: string } {
  const input = join(dir, 'prices.in.json');
  const output = join(dir, 'prices.out.json');
  const status = join(dir, 'prices.status.json');
  try { rmSync(status, { force: true }); writeFileSync(input, JSON.stringify(calls)); } catch (e) { return { unread: `the calls couldn't be written for the host to price: ${(e as Error).message}` }; }
  const code = [
    "const { readFileSync, writeFileSync } = await import('node:fs');",
    `const say = (o) => { writeFileSync(${JSON.stringify(status)}, JSON.stringify(o)); process.exit(0); };`,
    `const m = await import(${JSON.stringify(join(hostDir, 'src', 'call-pricing.ts'))}).catch((e) => say({ unread: "its src/call-pricing.ts couldn't be loaded: " + String(e?.message ?? e) }));`,
    "if (typeof m.priceCall !== 'function') say({ unread: 'its src/call-pricing.ts exports no priceCall' });",
    `const calls = JSON.parse(readFileSync(${JSON.stringify(input)}, 'utf-8'));`,
    `writeFileSync(${JSON.stringify(output)}, JSON.stringify(calls.map((c) => m.priceCall(c) ?? null)));`,
    'say({ priced: calls.length });',
  ].join('\n');
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: OUTPUT_KEPT_BYTES, env: { ...process.env, NO_COLOR: '1' } });
  const failed = (r.error as NodeJS.ErrnoException | undefined)?.code;
  // spawnSync's own kills, at the bound or past the output it keeps, leave the run's prices unread; any other signal
  // is one the harness didn't send.
  if (r.signal && failed !== 'ETIMEDOUT' && failed !== 'ENOBUFS') throw new HarnessFailure(`the host's pricing (bun) was ended by ${r.signal}`);
  const cut = (s: string) => (s.length > 1000 ? `…${s.slice(-1000)}` : s);
  const why = () => (failed === 'ETIMEDOUT' ? `bun was killed at the bound of ${timeoutMs} ms`
    : failed === 'ENOBUFS' ? `bun was killed for printing more than the ${OUTPUT_KEPT_BYTES} bytes kept of its output`
    : r.error ? r.error.message : `bun exited ${r.status}: ${cut((r.stderr || r.stdout || '').trim())}`);
  let said: unknown;
  try { said = JSON.parse(readFileSync(status, 'utf-8')); } catch { return { unread: `the host couldn't price its calls (${why()})` }; }
  if (!said || typeof said !== 'object') return { unread: `the host couldn't price its calls (${why()})` };
  if (typeof (said as { unread?: unknown }).unread === 'string') return { unread: (said as { unread: string }).unread };
  let prices: unknown;
  try { prices = JSON.parse(readFileSync(output, 'utf-8')); } catch (e) { return { unread: `the host's prices couldn't be read back: ${(e as Error).message}` }; }
  const priced = (p: unknown): p is CallPrice | null => p === null || (typeof p === 'object' && typeof (p as CallPrice).total === 'number' && Number.isFinite((p as CallPrice).total) && (p as CallPrice).total >= 0);
  if (!Array.isArray(prices) || prices.length !== calls.length) return { unread: `the host's prices came back as ${Array.isArray(prices) ? `${prices.length} for ${calls.length} calls` : 'something other than a list'}` };
  const bad = prices.findIndex((p) => !priced(p));
  if (bad !== -1) return { unread: `the host's priceCall answered call ${bad + 1} of ${calls.length} with neither a price whose total is a number of 0 or more nor none` };
  return { prices: prices as Array<CallPrice | null> };
}

export function pricesOf({ hostDir, records, dir, timeoutMs }: { hostDir: string; records: PricedRecord[]; dir: string; timeoutMs?: number }): PriceTable {
  const rows = records.flatMap((r) => {
    const call = callOf(r);
    if (!call) return [];
    return [{ id: r.id, step: r.step ?? null, kind: r.kind, ...(r.agent ? { agent: r.agent } : {}), api: r.head?.api ?? null, ...(r.head?.dialect ? { dialect: r.head.dialect } : {}), call }];
  });
  if (!rows.length) return { requests: [] };
  const priced = hostPrices({ hostDir, calls: rows.map((r) => r.call), dir, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if ('unread' in priced) return { unread: priced.unread, requests: rows.map((r) => ({ ...r, price: null })) };
  return { requests: rows.map((r, i) => ({ ...r, price: priced.prices[i]! })) };
}
