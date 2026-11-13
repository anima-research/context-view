import type { MessagesWritten } from '../standin/anthropic.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { BlockRecord } from '../standin/view.ts';
import type { LogEntry } from '../strategies/driver.ts';
import type { Store } from '../strategies/read-store.ts';
import type { Step } from '../strategies/script.ts';
import type { Facts } from '../workloads/workloads.ts';
import type { DeepPartial } from './deep-partial.ts';

type Block = DeepPartial<BlockRecord>;
type Message = MessagesWritten['messages'][number];
type Entry<K extends LogEntry['kind']> = Extract<LogEntry, { kind: K }>;
type Asked = ReturnType<typeof asked>;

export const msg = (role: string, ...blocks: Block[]): DeepPartial<Message> => ({ role, blocks });

export const text = (canaries?: string[]): Block => ({ type: 'text', chars: 10, ...(canaries ? { canaries } : {}) });

export const call = (id: string): Block => ({ type: 'tool_use', chars: 10, toolUseId: id });

export const result = (id: string, images?: number): Block => ({ type: 'tool_result', chars: 10, toolUseId: id, ...(images ? { images } : {}) });

export const carrying = (...canaries: string[]): Block => ({ type: 'text', chars: 10, canaries });

export const store = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: ['[[c:b.in]]'] }, { id: 'm4', canaries: ['[[c:b.r1]]'] },
    { id: 'm5', canaries: ['[[c:c.in]]'] }, { id: 'm6', canaries: [] },
  ],
  summaries: [
    { id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] },
    { id: 'L1-2', level: 1, sourceLevel: 0, sourceIds: ['m3', 'm4', 'm6'], number: '[[s:C2]]', covers: ['[[c:b.in]]', '[[c:b.r1]]'] },
    { id: 'L2-1', level: 2, sourceLevel: 1, sourceIds: ['L1-1', 'L1-2'], number: '[[s:C3]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] },
  ],
} satisfies DeepPartial<Store>;

export const panel = (name: string, { budget = 20_000, budgetMet = true, exhausted = false, head, tail }: { budget?: number | null; budgetMet?: boolean; exhausted?: boolean; head?: number; tail?: number } = {}): DeepPartial<Entry<'checkpoint'>> => ({
  kind: 'checkpoint', name, step: `${name}.cp`,
  health: { data: {
    contextComposition: { fixture: { planVsActual: { planned: 15_000, actual: 15_000, budgetMet, exhausted }, ...(head !== undefined ? { head: { messages: head } } : {}), ...(tail !== undefined ? { tail: { messages: tail } } : {}) } },
    runtimeSettings: { fixture: budget === null ? {} : { contextBudgetTokens: budget, effectiveContextBudgetTokens: budget } },
  } },
});

export const asked = (id: string, step: string, messageTokens: number, input: number, messages: DeepPartial<Message>[], toolUseIds: string[], cached = 0) => ({ id, step, kind: 'agent', maxTokens: 2_048, usage: { input_tokens: input - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }, tokens: { input: input - cached, cacheRead: cached, cacheWrite: 0, output: 0 }, messages, answer: { shape: 'reply', stop: toolUseIds.length ? 'tool_use' : 'end_turn', toolUseIds } } satisfies DeepPartial<RequestRecord>);

export const wholeInput = (r: Asked) => r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens;

export const opened = (id: string, step: string, messageTokens: number, input = messageTokens + 8_000, calls: string[] = [], cached = 0) => asked(id, step, messageTokens, input, [{ role: 'user', digest: `in.${id}`, blocks: [text()] }], calls, cached);

export const continued = (before: Asked, id: string, messageTokens: number, input = messageTokens + 8_000, calls: string[] = [], cached = wholeInput(before)) => asked(id, before.step, messageTokens, input, [
  ...before.messages,
  { role: 'assistant', digest: `reply.${before.id}`, blocks: [text(), ...before.answer.toolUseIds.map(call)] },
  { role: 'user', digest: `results.${before.id}`, blocks: before.answer.toolUseIds.map((id) => result(id)) },
], calls, cached);

export const started = { kind: 'ipc', event: { type: 'inference:started', agentName: 'fixture' } } satisfies DeepPartial<Entry<'ipc'>>;

export const sent = (id: string) => ({ kind: 'request', request: { id, kind: 'agent' } } satisfies DeepPartial<Entry<'request'>>);

type Compiled = { id: string; step: string; agent?: string; messages: DeepPartial<Message>[] };

export const compiledAs = <R extends Compiled>(records: R[], compiled: string[], agent = 'fixture') => {
  const turn = new Map<string, string>();
  const canaryOf = (r: Compiled) => `[[c:${r.step}.${r.id}]]`;
  const marked = records.map((r) => {
    const key = `${r.agent ?? 'primary'}|${r.step}`;
    if (compiled.includes(r.id)) turn.set(key, canaryOf(r));
    const canary = turn.get(key);
    const arrived = { arrived: String((records.indexOf(r) + 1) * 10) };
    return canary ? { ...r, ...arrived, messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [...r.messages.at(-1)!.blocks!, text([canary])] }] } : { ...r, ...arrived };
  });
  const sentFrom = records.filter((r) => compiled.includes(r.id));
  const steps = [...new Set(sentFrom.map((r) => r.step))];
  const entries = steps.map((step) => ({
    kind: 'compiles', step,
    lines: sentFrom.map((r, i): [R, number] => [r, i]).filter(([r]) => r.step === step).map(([r, i]) => ({ seq: i + 1, agent, kind: 'request', assembly: i + 1, outcome: 'compiled', stamp: String((records.indexOf(r) + 1) * 10 - 5), messages: [{ sources: ['r:1'], content: `x.${r.id}` }] })),
    blobs: Object.fromEntries(sentFrom.filter((r) => r.step === step).map((r) => [`x.${r.id}`, { role: 'user', content: [{ type: 'text', text: `${canaryOf(r)} words` }] }])),
  }) satisfies DeepPartial<Entry<'compiles'>>);
  return [marked, entries] as const;
};

export const crossingAs = (agent = 'fixture') => {
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 16_000, 31_000, ['t2']);
  return compiledAs([r1, r2, continued(r2, 'r3', 17_000, 32_000)], ['r1'], agent);
};

export const crossing = () => crossingAs()[0];

export const R1_COMPILED = crossingAs()[1];

export const under = (report?: DeepPartial<Entry<'budget-report'>> | null) => [...(report ? [report] : []), ...R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), panel('s')];

export const W14_FACTS = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true } } satisfies Facts;

export const turnStep = (id: string, replies = 1) => ({ id, segment: 's', kind: 'channel', canaries: [`[[c:${id}.in]]`], replies: Array.from({ length: replies }, (_, k) => ({ text: `[[c:${id}.r${k + 1}]] x` })) }) satisfies DeepPartial<Step>;
