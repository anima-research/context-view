import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callOf, pricesOf } from './prices.ts';
import { HarnessFailure } from './pool.ts';

const tokens = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output });
const none = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheWrite30mTokens: 0, cacheWrite12hTokens: 0 };

test('an Anthropic record is priced as anthropic, its writes split by lifetime from its usage and the rest unclassified', () => {
  const call = callOf({
    id: 'r1', kind: 'agent', head: { api: 'messages', model: 'claude-opus-5-5' }, tokens: tokens(10, 20, 30, 5),
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 }, output_tokens: 5 },
  });
  assert.deepEqual(call, { ...none, provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWrite5mTokens: 12, cacheWrite1hTokens: 8, unclassifiedCacheWriteTokens: 10 });
});

test('a Bedrock record, whose API is messages, is priced as bedrock, never as anthropic, its writes split by lifetime from its usage as Anthropic\'s are', () => {
  const call = callOf({
    id: 'r1', kind: 'agent', head: { api: 'messages', dialect: 'bedrock', model: 'anthropic.claude-opus-5-5' }, tokens: tokens(10, 0, 100, 5),
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 5 },
  });
  assert.deepEqual(call, { ...none, provider: 'bedrock', model: 'anthropic.claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 100, unclassifiedCacheWriteTokens: 0 });
});

test('a Responses record is priced as openai-responses at the tier it asked for, its writes split by lifetime and the rest unclassified', () => {
  const record = {
    id: 'r1', kind: 'agent', head: { api: 'responses', model: 'gpt-6.1-sol', serviceTier: 'priority' }, tokens: tokens(100, 50, 40, 7),
    usage: { input_tokens: 190, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 40, cache_write_tokens_details: { ttl_30m_tokens: 30, ttl_12h_tokens: 0 } }, output_tokens: 7 },
  };
  assert.deepEqual(callOf(record), { ...none, provider: 'openai-responses', model: 'gpt-6.1-sol', inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, cacheWrite30mTokens: 30, unclassifiedCacheWriteTokens: 10, serviceTier: 'priority' });
  assert.equal('serviceTier' in callOf({ ...record, head: { api: 'responses', model: 'gpt-6.1-sol', serviceTier: null } })!, false, 'a request that asked for no tier names none');
});

test('Codex, OpenRouter and the other Chat Completions dialects go as their own providers, every write unclassified', () => {
  const as = (api: string, dialect?: string) => callOf({ id: 'r1', kind: 'agent', head: { api, ...(dialect ? { dialect } : {}), model: 'm' }, tokens: tokens(1, 2, 3, 4) });
  assert.equal(as('codex')?.provider, 'openai-codex');
  assert.equal(as('chat-completions', 'openrouter')?.provider, 'openrouter');
  assert.equal(as('chat-completions', 'openai')?.provider, 'openai-compatible');
  assert.equal(as('chat-completions', 'deepseek')?.provider, 'openai-compatible');
  for (const [api, dialect] of [['codex'], ['chat-completions', 'openrouter'], ['chat-completions', 'openai'], ['chat-completions', 'deepseek']] as const) {
    assert.equal(as(api, dialect)?.unclassifiedCacheWriteTokens, 3, `${api} ${dialect ?? ''}`);
  }
});

test('a Codex record carries the tier it asked for, as a Responses record does', () => {
  const call = callOf({ id: 'r1', kind: 'agent', head: { api: 'codex', model: 'gpt-6.1-sol', serviceTier: 'priority' }, tokens: tokens(1, 2, 3, 4) });
  assert.equal(call?.serviceTier, 'priority');
  assert.equal('serviceTier' in callOf({ id: 'r1', kind: 'agent', head: { api: 'codex', model: 'gpt-6.1-sol', serviceTier: null }, tokens: tokens(1, 2, 3, 4) })!, false);
});

test('a record the stand-in answered with no usage gets no call', () => {
  assert.equal(callOf({ id: 'r1', kind: 'unclassified', head: { api: 'messages' }, tokens: null }), null);
  assert.equal(callOf({ id: 'r1', kind: 'agent' }), null);
});

function host(source: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'prices-host-'));
  mkdirSync(join(dir, 'src'));
  if (source !== null) writeFileSync(join(dir, 'src', 'call-pricing.ts'), source);
  return dir;
}

const records = [
  { id: 'r1', step: 's1', kind: 'agent', agent: 'primary', head: { api: 'messages', model: 'claude-opus-5-5' }, tokens: tokens(1_000, 0, 0, 10), usage: {} },
  { id: 'r2', step: 's1', kind: 'unclassified', head: { api: 'messages' }, tokens: null },
  { id: 'r3', step: 's2', kind: 'summariser', head: { api: 'messages', dialect: 'bedrock', model: 'm' }, tokens: tokens(5, 0, 0, 1), usage: {} },
];

test('the arm\'s own host prices each request with usage, by its priceCall, and the table keeps each call beside its price', () => {
  const dir = host(`export function priceCall(c: { provider: string; inputTokens: number }) { return c.provider === 'anthropic' ? { total: c.inputTokens / 1_000_000, tier: 'standard' } : undefined; }`);
  try {
    const table = pricesOf({ hostDir: dir, records, dir });
    assert.equal(table.unread, undefined);
    assert.deepEqual(table.requests.map((r) => [r.id, r.step, r.kind, r.agent ?? null, r.api, r.dialect ?? null, r.call.provider, r.price]), [
      ['r1', 's1', 'agent', 'primary', 'messages', null, 'anthropic', { total: 0.001, tier: 'standard' }],
      ['r3', 's2', 'summariser', null, 'messages', 'bedrock', 'bedrock', null],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a host with no priceCall, or whose pricing module can\'t load, prices nothing and says why, keeping each call', () => {
  for (const [source, why] of [
    ['export const OTHER = 1;', /^its src\/call-pricing\.ts exports no priceCall$/],
    [null, /^its src\/call-pricing\.ts couldn't be loaded: /],
    ['export function priceCall() { return { total: -1 }; }', /^the host's priceCall answered call 1 of 2 with neither a price whose total is a number of 0 or more nor none$/],
  ] as const) {
    const dir = host(source);
    try {
      const table = pricesOf({ hostDir: dir, records, dir });
      assert.match(table.unread ?? '', why);
      assert.deepEqual(table.requests.map((r) => [r.id, r.price]), [['r1', null], ['r3', null]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a host whose priceCall prints and then throws, or whose module writes to stdout without a line break, still gets its run an answer from the harness rather than a harness error', () => {
  for (const [source, why] of [
    [`export function priceCall() { console.log('null'); throw new Error('boom'); }`, /^the host couldn't price its calls \(bun exited 1: [\s\S]*boom/],
    [`process.stdout.write('loaded'); export function priceCall() { return undefined; }`, null],
  ] as const) {
    const dir = host(source);
    try {
      const table = pricesOf({ hostDir: dir, records, dir });
      if (why) assert.match(table.unread ?? '', why);
      else assert.equal(table.unread, undefined);
      assert.deepEqual(table.requests.map((r) => [r.id, r.price]), [['r1', null], ['r3', null]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a host that ignores SIGTERM and hangs is killed at the bound, and its prices are unread', () => {
  const dir = host(`import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); export function priceCall() { writeFileSync(${JSON.stringify('HANGING')}, ''); for (;;) {} }`);
  try {
    // The bound runs from the spawn, so on a loaded machine bun may not have reached priceCall, its handler in
    // place, by 500 ms. Then the kill shows nothing, and the test tries again at 10 s, about ten times the slowest
    // of 45 starts measured under load (1,012 ms, at a load of 45 to 49 on 12 cores).
    for (const timeoutMs of [500, 10_000]) {
      const table = pricesOf({ hostDir: dir, records, dir, timeoutMs });
      if (!existsSync(join(dir, 'HANGING'))) continue;
      assert.match(table.unread ?? '', new RegExp(`^the host couldn't price its calls \\(bun was killed at the bound of ${timeoutMs} ms\\)$`));
      return;
    }
    assert.fail('bun never reached priceCall, so the kill shows nothing about a handler in place');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a host that prints more than the output kept has its bun killed, and its prices are unread, not the invocation failed', () => {
  const dir = host(`import { writeSync } from 'node:fs'; export function priceCall() { writeSync(1, 'x'.repeat(2 * 1024 * 1024)); for (;;) {} }`);
  try {
    const table = pricesOf({ hostDir: dir, records, dir });
    assert.match(table.unread ?? '', /^the host couldn't price its calls \(bun was killed for printing more than the 1048576 bytes kept of its output\)$/);
    assert.deepEqual(table.requests.map((r) => [r.id, r.price]), [['r1', null], ['r3', null]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pricing bun ended by a signal the harness didn\'t send fails the invocation, as any of its child processes would', () => {
  const dir = host(`export function priceCall() { process.kill(process.pid, 'SIGKILL'); }`);
  try {
    assert.throws(() => pricesOf({ hostDir: dir, records, dir }), (e: Error) => e instanceof HarnessFailure && /^the host's pricing \(bun\) was ended by SIGKILL$/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run with no request answered with usage has an empty table, and nothing is asked of its host', () => {
  assert.deepEqual(pricesOf({ hostDir: '/nonexistent', records: [records[1]!], dir: '/nonexistent' }), { requests: [] });
});
