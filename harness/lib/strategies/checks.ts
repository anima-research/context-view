import { runVaryingMasker } from './compare.ts';
import { cutMessage } from './cut.ts';
import { CANARY } from '../standin/view.ts';
import { bindsThinking } from '../standin/anthropic.ts';
import { servedModel } from '../standin/bedrock.ts';
import type { AnthropicUsage, MessagesWritten } from '../standin/anthropic.ts';
import type { BedrockWritten } from '../standin/bedrock.ts';
import type { ChatUsage } from '../standin/chat.ts';
import type { ResponsesUsage } from '../standin/responses.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { SummariserRecord } from '../standin/summariser.ts';
import type { BlockRecord } from '../standin/view.ts';
import type { LogEntry, PanelAnswer } from './driver.ts';
import type { CompileLine } from './module.ts';
import type { CompiledBody } from './recorder.ts';
import type { Store, StoreSummary } from './read-store.ts';
import type { Call, Products, Reply, Step } from './script.ts';

export type CheckFlag = { check: number; step: string | null; request?: string; what?: unknown; message: string; detail?: string; full?: string; events?: string[] };
export type Judged<F> = F[] & { readonly judged: number; readonly besides?: string };
type Entry<K extends LogEntry['kind']> = Extract<LogEntry, { kind: K }>;
type Assembly = CompileLine & { step: string | null; boot: number | null };
type Arrival = { at: bigint | null; line: Assembly & CompiledBody; request?: undefined } | { at: bigint | null; request: RequestRecord; line?: undefined };
type StepAt = { id: string | null; inputs?: string[]; replies?: Reply[]; ends?: Step['ends'] };
type BudgetReport = { boot: number; figure: string; window: boolean; windowFigure: string | null };
type Row = Store['messages'][number];
type Place = 'head' | 'rest' | 'from' | 'before';
type Item = [mark: string, rank: number | undefined, within: Place, canaries: string[]];
type Placed = [...item: Item, place: number];
type WireMessage = { role: string | null; side?: string | null; blocks: BlockRecord[] };
type Turn = { role: string | null; side?: string | null; wire?: string | null; blocks: BlockRecord[] };
export type Headroom = { segment: string | undefined; kind: 'compiled' | 'continuation'; request: string; tokens: number; bound: number };

export function declaredProducts(records: RequestRecord[], script: Step[], products: Products, store: Store | null = null) {
  const segmentOf = new Map<string | null, string | undefined>(script.map((s) => [s.id, s.segment]));
  const out: Array<{ segment: string; missing: string[] }> = [];
  let judged = 0;
  let storeless = 0;
  for (const [segment, wanted] of Object.entries(products)) {
    if (!script.some((s) => s.segment === segment)) continue;
    const mine = records.filter((r) => segmentOf.get(r.step) === segment);
    const judgeable = wanted.filter((p) => !p.fromStore || store !== null);
    storeless += wanted.length - judgeable.length;
    judged += judgeable.length;
    const missing = judgeable.filter((p) => (p.fromStore ? !p.fromStore(store!) : !mine.some((r) => p.test(r, mine)))).map((p) => p.name);
    if (missing.length) out.push({ segment, missing });
  }
  return withJudged(out, judged, storeless ? `${storeless} product${storeless === 1 ? '' : 's'} not judged, as ${storeless === 1 ? 'it needs' : 'they need'} the final store and the run has none` : null);
}

export function compileInvariants(log: LogEntry[] = []) {
  const flags: CheckFlag[] = [];
  let judged = 0, unplaced = 0, unread = 0;
  const unjudged = new Map<string, number>();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const line of e.lines ?? []) {
      if (line.outcome === 'compiled') judged++;
      for (const v of line.violations ?? []) {
        if (v.invariant === 'unplaced') unplaced += v.count ?? 0;
        if (v.invariant === 'unreadable' && v.read !== false) unread++;
      }
      for (const u of line.unjudged ?? []) unjudged.set(u, (unjudged.get(u) ?? 0) + 1);
      if (line.outcome === 'unrecordable') flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:unrecordable`, message: `the harness module couldn't record ${line.agent}'s ${line.kind} compile ${line.seq}: ${line.reason}`, ...(line.full ? { full: `the harness module couldn't record ${line.agent}'s ${line.kind} compile ${line.seq}: ${line.full}` } : {}) });
      for (const v of line.violations ?? []) flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:${v.invariant}`, detail: v.detail, ...(v.full ? { full: v.full } : {}), message: COULDNT.has(v.invariant) ? `couldn't judge all of ${line.agent}'s ${line.kind} compile ${line.seq}: ${v.detail}` : `${line.agent}'s ${line.kind} compile ${line.seq} breaks ${v.invariant}: ${v.detail}` });
    }
  }
  const besides = [
    ...[...unjudged].map(([what, n]) => { const [part, ...why] = what.split(': '); return `${part} couldn't be judged in ${n}, as ${why.join(': ')}`; }),
    ...(unplaced ? [`the order couldn't place ${unplaced} of what was sent`] : []),
    ...(unread ? [`${unread} read${unread === 1 ? '' : 's'} an invariant needed failed`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

const COULDNT = new Set(['unplaced', 'unreadable']);

const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export function bindingControl(records: RequestRecord[], { served = servedModel }: { served?: (model: string) => string } = {}) {
  const asked = records.filter((r): r is RequestRecord & (MessagesWritten | BedrockWritten) => r.kind === 'agent' && r.head?.api === 'messages' && bindsThinking(served(r.head?.model as string)));
  const flags = asked.flatMap((r) => [
    ...(r.thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block' ? [{ check: 15, step: r.step ?? 'the run', what: 'no-drop-control', message: `request ${r.id} carries no drop control (its thinking setting: ${JSON.stringify(r.thinking ?? null)})` }] : []),
    ...(!(r.head?.headers?.beta ?? []).includes(BINDING_BETA) ? [{ check: 15, step: r.step ?? 'the run', what: 'no-binding-beta', message: `request ${r.id} doesn't ask for the ${BINDING_BETA} beta the control needs (its anthropic-beta: ${JSON.stringify(r.head?.headers?.beta ?? null)})` }] : []),
  ]);
  return withJudged(flags, asked.length);
}

export function pairing(records: RequestRecord[], log: LogEntry[] = [], agent: string = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return withJudged([], 0);
  if (paired.disagree?.length) return withJudged([{ check: 13, step: 'the run', what: `${agent}:disagree`, ...cutMessage((cut) => `couldn't judge ${agent}'s pairing: by the clock ${cut(paired.disagree, 4)} pair, but the request doesn't end on the compile's last canary, so the two processes' stamps may not share a clock`) }], 0);
  if (paired.unstamped.length) return withJudged([{ check: 13, step: 'the run', what: `${agent}:unstamped`, ...cutMessage((cut, whole) => `couldn't judge ${agent}'s pairing: ${cut(paired.unstamped, 4)}${!whole && paired.unstamped.length > 4 ? ` and ${paired.unstamped.length - 4} more` : ''} carry no clock stamp to order by`) }], 0);
  return withJudged(paired.unpaired.map((l) => ({ check: 13, step: l.step ?? 'the run', what: `${agent}:unpaired`, message: `${agent}'s request compile ${l.seq} (assembly ${l.assembly}) went out in no request: none arrived at the stand-in after it and before the agent's next compile, so agent-framework never sent it, or the pairing went wrong`, events: inferenceEnds(log, l.step) })), paired.pairs.length + paired.unpaired.length);
}

const INFERENCE_ENDS: readonly unknown[] = ['inference:failed', 'inference:exhausted', 'inference:aborted', 'inference:waiting'];

function inferenceEnds(log: LogEntry[], step: string | null | undefined) {
  const at = step ?? null;
  const where = at === null ? 'before the first step' : `in step ${at}`;
  const events = log.filter((e): e is Entry<'ipc'> => e.kind === 'ipc' && (e.step ?? null) === at && INFERENCE_ENDS.includes(e.event?.type));
  if (!events.length) return [`the host logged no inference:failed, inference:exhausted, inference:aborted or inference:waiting event ${where}`];
  return [`the host's inference:failed, inference:exhausted, inference:aborted and inference:waiting events ${where}, every agent's, as logged:`, ...events.map((e) => JSON.stringify(e.event))];
}

export function reloads(log: LogEntry[] = []) {
  const flags: CheckFlag[] = [];
  const lines = new Map<string, CompileLine>();
  const blobs: Record<string, unknown> = {};
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    Object.assign(blobs, e.blobs ?? {});
    for (const l of e.lines ?? []) lines.set(`${e.boot}:${l.seq}`, l);
  }
  const shape = (l: CompileLine) => {
    const mask = runVaryingMasker();
    const held = (id: string | undefined) => JSON.stringify(mask(blobs[id as string] ?? null));
    return {
      outcome: l.outcome,
      error: l.error?.class ?? null,
      messages: (l.messages ?? []).map((m) => ({ sources: m.sources, content: held(m.content) })),
      system: held(l.system),
    };
  };
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'reload') continue;
    const [before, after] = [e.before, e.after].map((at) => (at?.seq == null ? null : lines.get(`${at.boot}:${at.seq}`) ?? null));
    const step = e.step;
    if (!before || !after) { flags.push({ check: 12, step, message: `couldn't judge the reload: the log holds no dry compile line ${!before ? 'before the restart' : 'after it'}` }); continue; }
    const [a, b] = [shape(before), shape(after)];
    if (a.outcome === 'refused' && b.outcome === 'refused' && a.error === b.error) { flags.push({ check: 12, step, message: `couldn't judge the reload: the dry compile refused (${a.error}) both before the restart and after it` }); continue; }
    judged++;
    if (a.outcome !== b.outcome || a.error !== b.error) { flags.push({ check: 12, step, message: `after the restart the dry compile ${b.outcome === 'refused' ? `refused (${b.error})` : 'compiled'}, where before it ${a.outcome === 'refused' ? `refused (${a.error})` : 'compiled'}` }); continue; }
    const n = Math.max(a.messages.length, b.messages.length);
    const at = [...Array(n).keys()].find((i) => JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i]));
    if (at !== undefined) flags.push({ check: 12, step, message: `after the restart the dry compile differs from the one before at message ${at} of ${a.messages.length} before and ${b.messages.length} after (sources ${JSON.stringify(a.messages[at]?.sources ?? null)} before, ${JSON.stringify(b.messages[at]?.sources ?? null)} after)` });
    if (a.system !== b.system) flags.push({ check: 12, step, message: 'after the restart the dry compile\'s system injections differ from the ones before' });
  }
  return withJudged(flags, judged);
}

export function withJudged<F>(flags: F[], judged: number, besides: string | null = null) {
  Object.defineProperty(flags, 'judged', { value: judged, enumerable: false });
  if (besides) Object.defineProperty(flags, 'besides', { value: besides, enumerable: false });
  return flags as Judged<F>;
}

export function judgedBy<T extends object>(flags: T, check: number) {
  Object.defineProperty(flags, 'judgedBy', { value: check, enumerable: false });
  return flags as T & { readonly judgedBy: number };
}

export function everyTurnAnswers(records: RequestRecord[], log: LogEntry[] = [], script: Step[] = []) {
  const mayFail = new Set<string | null>(script.filter((s) => s.mayFail).map((s) => s.id));
  const retries = new Set<string | null>(script.filter((s) => s.retries).map((s) => s.id));
  const unaddressed = new Set<string | null>(script.filter((s) => s.addressed === false).map((s) => s.id));
  const failsPublish = new Set<string | null>(script.filter((s) => s.failsPublish).map((s) => s.id));
  const drafted = new Map<string | null, Step['drafts']>(script.filter((s) => s.drafts).map((s) => [s.id, s.drafts]));
  const owned = (e: Entry<'ipc'>) => (mayFail.has(e.step) && (/^inference:(failed|exhausted)$/.test((e.event?.type ?? '') as string) || (e.event?.type === 'ops:alert' && e.event.kind === 'context-refusal')))
    || (retries.has(e.step) && e.event?.type === 'inference:failed');
  const flags: CheckFlag[] = [];
  withJudged(flags, records.length);
  const lost = new Map<string, number>();
  for (const r of records) {
    if (r.kind === 'unclassified') flags.push({ check: 1, step: r.step, request: r.id, message: `unclassified request: ${r.reason}` });
    else if (r.refused) flags.push({ check: 1, step: r.step, request: r.id, message: `the stand-in refused it (${r.refused})` });
    if (r.kind !== 'agent') continue;
    const agent = r.agent ?? 'primary';
    // agent-framework's words for lost speech give only the segments' count and the draft store's error, and the rest of
    // a receipt needn't differ from another's, so receipts can't be told apart, and a new one shows only as the count rising.
    const told = (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => b.notHeld).length;
    if (told > (lost.get(agent) ?? 0)) flags.push({ check: 1, step: r.step, request: r.id, message: 'the request carries a delivery receipt saying a turn\'s speech was suppressed and NOT held as drafts, so the host lost it' });
    lost.set(agent, told);
  }
  for (const e of log) {
    if (e.kind === 'ipc' && owned(e)) continue;
    if (e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test((e.event?.type ?? '') as string)) flags.push({ check: 1, step: e.step, message: `${e.event.type}: ${e.event.error ?? e.event.reason ?? ''}`.trim() });
    if (e.kind === 'ipc' && e.event?.type === 'ops:alert') flags.push({ check: 1, step: e.step, what: e.event.kind, message: `the host raised an operator alert, ${e.event.kind}: ${e.event.message ?? ''}`.trim() });
    if (e.kind === 'settle' && e.phase === 'end' && e.settled === false) flags.push({ check: 1, step: e.step, message: 'the step did not settle' });
    if (e.kind === 'undelivered' && !(/\bno locus\b/.test((e.reason ?? '') as string) ? unaddressed : failsPublish).has(e.step)) flags.push({ check: 1, step: e.step, message: `the turn's answer never reached its channel: the host reported mcpl:speech-route-failed${e.reason ? ` (${e.reason})` : ''}` });
    if (e.kind === 'ipc' && e.event?.type === 'prose:drafts-held' && !(unaddressed.has(e.step) && e.event.reason === 'no-destination') && !(drafted.has(e.step) && drafted.get(e.step) === e.event.reason)) flags.push({ check: 1, step: e.step, message: `the turn's answer reached no channel: the host held it as drafts (${e.event.reason ?? 'no reason given'})` });
  }
  for (const s of script) {
    for (const [agent, replies] of [['primary', s.replies] as const, ...(s.subs ?? []).map((x) => [x.as ?? 'sub', x.replies] as const)]) {
      if (!Array.isArray(replies) || !replies.length) continue;
      const used = records.filter((r) => r.kind === 'agent' && r.step === s.id && (r.agent ?? 'primary') === agent).length;
      if (used >= replies.length || (mayFail.has(s.id) && log.some((e) => e.kind === 'ipc' && e.step === s.id && owned(e)))) continue;
      flags.push({ check: 1, step: s.id, message: `${replies.length - used} of the step's ${replies.length} scripted ${agent === 'primary' ? '' : agent === 'sub' ? 'subagent ' : `subagent ${agent} `}replies went unused, so what it scripts didn't all happen` });
    }
  }
  return flags;
}

export const FIXTURE_AGENT = 'fixture';

// agent-framework 0.33.0 names a reader fork `reader/<resident>/<epoch's first 8 hex>/<n>` (framework.ts,
// invokeReaderFork), and a fork inherits its resident's view filter, which holds back what a tune-out holds.
export const readerForkOf = (agent: unknown, resident: string = FIXTURE_AGENT) => typeof agent === 'string' && agent.startsWith(`reader/${resident}/`);

export const tunedOutOf = (script: Step[] = []) => new Set(script.flatMap((s) => s.tunedOut ?? []));

// What an operator's /undo took out, as the script says (a step's `undoes`), owed to no request after it.
export function undoneBy(script: Step[] = []) {
  const at = new Map<string | null, number>(script.map((s, i) => [s.id, i]));
  const undone = new Map<string, number>();
  script.forEach((s, i) => { for (const c of s.undoes ?? []) if (!undone.has(c)) undone.set(c, i); });
  return (c: string, stepId: string | null) => undone.has(c) && undone.get(c)! < (at.get(stepId) ?? Infinity);
}

export function shedBy(script: Step[] = []) {
  const at = new Map<string | null, number>(script.map((s, i) => [s.id, i]));
  const shed = new Map<string, number>();
  script.forEach((s, i) => { for (const c of s.sheds ?? []) if (!shed.has(c)) shed.set(c, i); });
  return (c: string, stepId: string | null) => shed.has(c) && shed.get(c)! <= (at.get(stepId) ?? Infinity);
}

export const STREAM_BOUND = 150_000;

function panelAt(e: Entry<'checkpoint'>, agent: string = FIXTURE_AGENT) {
  const data: NonNullable<PanelAnswer['data']> = e.health?.data ?? {};
  return { composition: data.contextComposition?.[agent], settings: data.runtimeSettings?.[agent] };
}

function lastRequests(records: RequestRecord[], script: Step[], log: LogEntry[], agent: string = FIXTURE_AGENT) {
  const bySegment = segmentAgents(records, script);
  const out = [];
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const agents = bySegment.get(e.name) ?? [];
    const request = agents.at(-1) ?? null;
    const answered = request ? agents.filter((r) => r !== request && r.step === request.step && !answeredBare(r)).length : 0;
    out.push({ checkpoint: e, segment: e.name, request, agents, n: request ? answered + 1 : 0, ...panelAt(e, agent) });
  }
  return out;
}

export const ofSide = (side: string = 'primary') => (r: RequestRecord) => r.kind === 'agent' && (r.agent ?? 'primary') === side;
export const primary = ofSide('primary');

function segmentAgents(records: RequestRecord[], script: Step[], side: string = 'primary') {
  const segmentOf = new Map<string | null, string | undefined>(script.map((s) => [s.id, s.segment]));
  const bySegment = new Map<string | undefined, RequestRecord[]>();
  const mine = ofSide(side);
  for (const r of records) {
    if (!mine(r) || !segmentOf.has(r.step)) continue;
    const segment = segmentOf.get(r.step);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), r]);
  }
  return bySegment;
}

const segmentLasts = (records: RequestRecord[], script: Step[]) => new Set([...segmentAgents(records, script).values()].map((agents) => agents.at(-1)));

// agent-framework 0.32.0's `compileUnpinningOnRefusal` compiles again within the assembly whose compile refused.
export function assemblies(log: LogEntry[] = [], agent: string = FIXTURE_AGENT) {
  const out: Assembly[] = [];
  let previous: Assembly | null = null;
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) {
      if (l.agent !== agent || l.kind !== 'request' || !['compiled', 'refused'].includes(l.outcome)) continue;
      const at = { ...l, step: e.step ?? null, boot: e.boot ?? null };
      const same = previous && at.boot === previous.boot && l.seq > previous.seq && l.assembly === previous.assembly;
      if (same) out[out.length - 1] = at;
      else out.push(at);
      previous = at;
    }
  }
  return out;
}

// The stand-in tells the primary's requests, and those of a subagent the script labels by its spawn name, from the rest.
// Where several other agents compile, as reader forks do, each in a step of its own, a sub-side request belongs to the
// one that compiled in its step.
export function subOwners(records: RequestRecord[], log: LogEntry[] = []) {
  const primary = primaryAgent(log);
  const byStep = new Map<string | null, Set<unknown>>();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) {
      if (l.kind !== 'request' || l.outcome !== 'compiled' || l.agent === primary || sideOfAgent(l.agent, log, records) !== 'sub') continue;
      if (!byStep.has(e.step)) byStep.set(e.step, new Set());
      byStep.get(e.step)!.add(l.agent);
    }
  }
  const others = [...new Set([...byStep.values()].flatMap((a) => [...a]))];
  if (others.length <= 1) return { owners: null, problem: null };
  const crowded = [...byStep].find(([, a]) => a.size > 1);
  if (crowded) return { owners: null, problem: `${[...crowded[1]].join(' and ')} each made request compiles in step ${crowded[0]}` };
  const owners = new Map<string, unknown>();
  const unplaced: string[] = [];
  for (const r of records) {
    if (r.kind !== 'agent' || (r.agent ?? 'primary') !== 'sub') continue;
    const there = byStep.get(r.step);
    if (there) owners.set(r.id, [...there][0]);
    else unplaced.push(r.id);
  }
  if (unplaced.length) return { owners: null, problem: `${unplaced.length} sub-side request${unplaced.length === 1 ? '' : 's'} came in a step where none of ${others.join(' and ')} compiled` };
  return { owners, problem: null };
}

export function requestPairs(records: RequestRecord[], log: LogEntry[] = [], agent: string = FIXTURE_AGENT, { side = sideOfAgent(agent, log, records) }: { side?: string } = {}) {
  const sent = assemblies(log, agent).filter((l): l is Assembly & CompiledBody => l.outcome === 'compiled');
  if (!sent.length) return null;
  const placed = side === 'sub' ? subOwners(records, log).owners : null;
  const requests = records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === side && (!placed || placed.get(r.id) === agent));
  const stampOf = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);
  const unstamped = [...sent.filter((l) => stampOf(l.stamp) === null).map((l) => `compile ${l.seq}`), ...requests.filter((r) => stampOf(r.arrived) === null).map((r) => `request ${r.id}`)];
  if (unstamped.length) return { pairs: [], continuations: requests, unpaired: [], unstamped, disagree: [] };
  const events = [...sent.map((l): Arrival => ({ at: stampOf(l.stamp), line: l })), ...requests.map((r): Arrival => ({ at: stampOf(r.arrived), request: r }))]
    .sort((x, y) => (x.at! < y.at! ? -1 : x.at! > y.at! ? 1 : x.line ? 1 : -1));
  const pairs: Array<{ line: Assembly & CompiledBody; request: RequestRecord }> = [];
  const continuations: RequestRecord[] = [];
  let latest: (Assembly & CompiledBody) | null = null;
  for (const e of events) {
    if (e.line) latest = e.line;
    else if (latest) { pairs.push({ line: latest, request: e.request }); latest = null; }
    else continuations.push(e.request);
  }
  const paired = new Set(pairs.map((p) => p.line));
  const blobs: Record<string, unknown> = Object.assign({}, ...log.filter((e): e is Entry<'compiles'> => e.kind === 'compiles').map((e) => e.blobs ?? {}));
  const lineCanary = (l: Assembly & CompiledBody) => {
    for (let i = (l.messages ?? []).length - 1; i >= 0; i--) {
      const found = JSON.stringify(blobs[l.messages[i].content] ?? '').match(CANARY);
      if (found) return found.at(-1);
    }
    return null;
  };
  const requestCanary = (r: RequestRecord) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).at(-1) ?? null;
  const disagree = pairs.filter(({ line, request }) => lineCanary(line) !== requestCanary(request)).map(({ line, request }) => `compile ${line.seq} and request ${request.id}`);
  return { pairs, continuations, unpaired: sent.filter((l) => !paired.has(l)), unstamped: [], disagree };
}

export function compilingAgents(log: LogEntry[] = []) {
  return [...new Set(log.filter((e): e is Entry<'compiles'> => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request' && l.outcome === 'compiled').map((l) => l.agent)))];
}

// connectome-host names a fork of `conversations` `<agentPrefix>-<channel>-…`, `conversation` when the recipe sets no
// prefix (recipe.ts RecipeConversations), and the stand-in can't tell its requests from the fixture agent's.
export const FORK_PREFIX = 'conversation-';

export function primaryAgent(log: LogEntry[] = []) {
  const agents = compilingAgents(log) as string[];
  return agents.length === 1 && agents[0].startsWith(FORK_PREFIX) ? agents[0] : FIXTURE_AGENT;
}


// connectome-host names a spawned subagent's agent `spawn-<name>-<stamp>`, its stamp a number (subagent-module.ts
// nameStamp).
export const spawnName = (agent: unknown) => /^spawn-(.+)-\d+$/.exec(String(agent))?.[1] ?? null;

export function sideOfAgent(agent: unknown, log: LogEntry[], records: RequestRecord[] = []) {
  if (agent === primaryAgent(log)) return 'primary';
  const name = spawnName(agent);
  return name !== null && records.some((r) => r.kind === 'agent' && r.agent === name) ? name : 'sub';
}

export function compileKinds(records: RequestRecord[], log: LogEntry[] = [], agent: string = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return null;
  const kinds = new Map<string, 'compiled' | 'continuation'>();
  for (const { request } of paired.pairs) kinds.set(request.id, 'compiled');
  for (const r of paired.continuations) kinds.set(r.id, 'continuation');
  return { kinds, unpaired: paired.unpaired };
}

function inputOf(r: RequestRecord) {
  const t = r?.tokens;
  if (!t) return null;
  const parts = [t.input, t.cacheRead, t.cacheWrite];
  return parts.every((x) => typeof x === 'number') ? parts.reduce((a, b) => a + b, 0) : null;
}

export function hostTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// connectome-host's `/budget` writes an agent's line as its stream budget and last use, and adds the rest when
// agent-framework breaks its stream mid-turn only at its window, for a model whose thinking binds
// (`handleBudget`, src/commands.ts:846; `windowInsteadOfBudget`, #508).
const BUDGET_LINE = /^(\d+\.\d[kM]|\d+) \(last: [^()]*\)(?:; its stream doesn't break at this budget mid-turn: for its size, only before a request its (\d+\.\d[kM]|\d+) window can't hold)?$/;

function budgetReports(log: LogEntry[], agent: string, listed: boolean) {
  const governs = new Map<string, BudgetReport | null>();
  let current: BudgetReport | null = null;
  // A report from before the agent's first compile can't list an agent made later, as a fork of `conversations` is.
  let compiled = agent === FIXTURE_AGENT;
  let listedSince = agent === FIXTURE_AGENT;
  for (const e of log) {
    if (e.kind === 'compiles' && (e.lines ?? []).some((l) => l.agent === agent)) compiled = true;
    if (e.kind === 'budget-report') {
      const line = (e.lines ?? []).find((l) => l.startsWith(`  ${agent}: `));
      const read = line === undefined ? null : BUDGET_LINE.exec(line.slice(agent.length + 4));
      if (listed && !read && (compiled || line !== undefined)) return { governs, unreadable: `at boot ${e.boot} ${line === undefined ? `has no line for ${agent}` : `writes ${agent}'s line in no form the check reads`}` };
      if (compiled && read) listedSince = true;
      current = read ? { boot: e.boot, figure: read[1], window: read[2] !== undefined, windowFigure: read[2] ?? null } : null;
    }
    if (e.kind === 'request' && e.request?.kind === 'agent') governs.set(e.request.id, current);
  }
  if (listed && compiled && !listedSince) return { governs, unreadable: `came at no point after ${agent}'s first compile` };
  return { governs, unreadable: null };
}

// A round's input as membrane 0.8.0's usage event counts it: the Messages API's `input_tokens`, which leave out cache
// reads and writes; the Responses API's `input_tokens` less `cached_tokens`, the one cache count its adapter reads
// (`parseResponse`), restated cache-excluded (`normalizeUsageToCacheExcluded`, utils/usage.ts); the Chat Completions
// API's `prompt_tokens` whole, since the OpenAI-compatible adapter reads no cache count and declares its convention
// unknown, which normalizeUsageToCacheExcluded passes through unchanged; and on OpenRouter's dialect `prompt_tokens`
// less `cached_tokens`, which its adapter reads as cache-inclusive (`resolveRoutedCacheConvention`, openrouter.ts).
const membraneInput = (r: RequestRecord) => {
  const u = r?.usage as Partial<AnthropicUsage & ResponsesUsage & ChatUsage> | undefined;
  if (typeof u?.prompt_tokens === 'number') return u.prompt_tokens - ((r.head as { [field: string]: unknown } | undefined)?.dialect === 'openrouter' ? u.prompt_tokens_details?.cached_tokens ?? 0 : 0);
  return typeof u?.input_tokens !== 'number' ? null : u.input_tokens_details ? u.input_tokens - (u.input_tokens_details.cached_tokens ?? 0) : u.input_tokens;
};

// membrane's usage event sums each round's input over a stream's rounds, and agent-framework restarts rather than
// continues once that sum passes `maxStreamTokens`.
function streamFreshBefore(agentRequests: RequestRecord[], r: RequestRecord, kinds: Map<string, 'compiled' | 'continuation'>) {
  let sum = 0;
  for (let i = agentRequests.indexOf(r) - 1; i >= 0; i--) {
    const x = agentRequests[i];
    if (x.step !== r.step) return null;
    // A provider error's round reports no usage, so membrane adds nothing for it.
    if (x.answer?.shape !== 'error') {
      const input = membraneInput(x);
      if (input === null) return null;
      sum += input;
    }
    if (kinds.get(x.id) === 'compiled') return sum;
  }
  return null;
}

// context-manager 0.24.0 sets `planVsActual.budgetMet` to `tokens <= targetBudget` (`src/adaptive/picker.ts`), so it's
// false whenever a plan sits between its soft target and its budget, and isn't read.
export function budgets(records: RequestRecord[], script: Step[], log: LogEntry[] = [], { agent = FIXTURE_AGENT, streamBound = STREAM_BOUND, windowTokens }: { agent?: string; streamBound?: number | null; windowTokens?: number } = {}) {
  const flags: CheckFlag[] = [];
  const headroom: Headroom[] = [];
  let judged = 0;
  const paired = compileKinds(records, log, agent);
  const kinds = paired?.kinds ?? new Map<string, 'compiled' | 'continuation'>();
  const side = sideOfAgent(agent, log, records);
  const { governs: reports, unreadable } = budgetReports(log, agent, side === 'primary');
  const windowBoots = new Set<number>();
  const own = records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === side);
  const agentRequests = own;
  if (streamBound === null) return { flags: [{ check: 3, step: 'the run', what: 'no-launch-budget', message: `couldn't judge ${agent}'s continuation rounds: no compile sent it a launch notice stating its stream budget` }], headroom: [], notes: [], judged: 0, requests: own.length };
  if (unreadable !== null && own.length) return { flags: [{ check: 3, step: 'the run', what: 'budget-unreadable', message: `couldn't judge ${agent}'s ${own.length} request(s): the host's /budget report ${unreadable}, so the bound that governs its continuation rounds can't be read` }], headroom: [], notes: [], judged: 0, requests: own.length };
  if (!paired && own.length) {
    return { flags: [{ check: 3, step: 'the run', what: 'no-compile-lines', message: `couldn't judge ${agent}'s ${own.length} request(s): the log holds no request compile line of ${agent}'s, so nothing tells a compiled request from a continuation round` }], headroom: [], notes: [], judged: null, requests: own.length };
  }
  const bySegment = segmentAgents(own, script, side);
  for (const e of log) {
    if (e.kind === 'checkpoint' && !bySegment.has(e.name)) flags.push({ check: 3, step: e.step ?? e.name, message: `segment ${e.name} made no agent request` });
  }
  for (const [segment, agents] of bySegment) {
    const least: Partial<Record<Headroom['kind'], Headroom>> = {};
    const room = (kind: Headroom['kind'], r: RequestRecord, tokens: number, bound: number) => {
      if (!least[kind] || bound - tokens < least[kind].bound - least[kind].tokens) least[kind] = { segment, kind, request: r.id, tokens, bound };
    };
    for (const r of agents) {
      // A provider error, or a call cut before any answer, returns no usage, and agent-framework's retry is the request
      // that reaches the window.
      if (r.answer?.shape === 'error' || r.answer?.shape === 'cut') continue;
      if (kinds.get(r.id) === 'compiled') {
        const whole = inputOf(r);
        if (whole === null || windowTokens === undefined) { flags.push({ check: 3, step: r.step, request: r.id, message: whole === null ? 'couldn\'t judge it: the stand-in recorded no usage for it' : 'couldn\'t judge it: the check was given no window' }); continue; }
        judged++;
        room('compiled', r, whole, windowTokens);
        if (whole > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts its whole input at ${whole} tokens, over the model's ${windowTokens}-token window` });
      } else {
        const report = reports.get(r.id) ?? null;
        if (report && report.figure !== hostTokens(streamBound)) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports ${agent}'s stream budget as ${report.figure}, and the check holds continuations to ${streamBound} (${hostTokens(streamBound)})` }); continue; }
        if (report?.window && report.windowFigure !== (windowTokens === undefined ? undefined : hostTokens(windowTokens))) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports that ${agent}'s window, ${report.windowFigure ?? 'which it doesn\'t name'}, governs its stream, and the stand-in refuses past ${windowTokens ?? 'no window it was given'}${windowTokens === undefined ? '' : ` (${hostTokens(windowTokens)})`}` }); continue; }
        if (report?.window) { windowBoots.add(report.boot); continue; }
        const whole = inputOf(r);
        if (whole === null || windowTokens === undefined) { flags.push({ check: 3, step: r.step, request: r.id, message: whole === null ? 'couldn\'t judge this continuation round: the stand-in recorded no usage for it' : 'couldn\'t judge this continuation round: the check was given no window' }); continue; }
        if (whole > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts this continuation round's whole input at ${whole} tokens, over the model's ${windowTokens}-token window` });
        const fresh = streamFreshBefore(agentRequests, r, kinds);
        if (fresh === null) { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge this continuation round: a request of its stream before it has no usage recorded, or its stream has no compiled request in its turn' }); continue; }
        judged++;
        room('continuation', r, fresh + membraneInput(r)!, streamBound);
        if (fresh > streamBound && !report) flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: its stream's fresh input before it was ${fresh} tokens, over the stream bound ${streamBound}, and no report of the host's stream budget for ${agent} came before it to say whether agent-framework breaks the stream there or only at the window` });
        else if (fresh > streamBound) flags.push({ check: 3, step: r.step, request: r.id, message: `a continuation round after its stream's fresh input reached ${fresh} tokens, over the stream bound ${streamBound}, past which agent-framework restarts rather than continues` });
      }
    }
    for (const k of ['compiled', 'continuation'] as const) if (least[k]) headroom.push(least[k]);
  }
  const notes = [...windowBoots].map((boot) => `the host reported that ${agent}'s stream breaks mid-turn only at its window (boot ${boot}), so its continuation rounds weren't held to the stream bound`);
  return { flags, headroom, notes, judged, requests: own.length };
}

export function headCounts(log: LogEntry[], agent: string = FIXTURE_AGENT) {
  const counts = new Map<string | undefined, number>();
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const head = panelAt(e, agent).composition?.head;
    if (typeof head?.messages === 'number') counts.set(e.name, head.messages);
  }
  return counts;
}

export const inputsOf = (step: StepAt | undefined) => step?.inputs ?? [`[[c:${step?.id}.in]]`];

export function headStart(store: Store, inputs: string[]) {
  const own = store.messages.findIndex((m) => m.canaries.some((c) => inputs.includes(c)));
  let start = 0;
  for (let i = 0; i < (own < 0 ? store.messages.length : own); i++) if (store.messages[i].topicTransition) start = i;
  return start;
}

export const answeredBare = (r: RequestRecord) => (['error', 'refused', 'cut'] as readonly unknown[]).includes(r.answer?.shape) || r.answer?.stop === 'refusal';

const answeredReplies = (step: StepAt | undefined) => (step?.replies ?? []).filter((r) => !r.error && r.stop !== 'refusal' && !r.cut);

export function replyCanaries(step: StepAt, upTo = Infinity) {
  if (!Array.isArray(step.replies)) return Number.isFinite(upTo) ? Array.from({ length: Math.max(0, upTo) }, (_, k) => `[[c:${step.id}.r${k + 1}]]`) : [];
  if (step.ends === 'contained') return [];
  const own = `[[c:${step.id}.r`;
  return answeredReplies(step).slice(0, upTo).flatMap((r) => (typeof r.text === 'string' ? r.text.match(CANARY) ?? [] : [])).filter((c) => c.startsWith(own));
}

export function windowsRaw(records: RequestRecord[], script: Step[], log: LogEntry[], store: Store | null | undefined, { agent = FIXTURE_AGENT, side = 'primary' }: { agent?: string; side?: string } = {}) {
  const own = ofSide(side);
  const tuned = side === 'primary' ? tunedOutOf(script) : new Set<string>();
  const undone = undoneBy(script);
  const shed = shedBy(script);
  const flags: CheckFlag[] = [];
  let judged = 0;
  const turns = script.filter((s) => Array.isArray(s.replies) && s.replies.length);
  const before = new Map<string | null, Step[]>(turns.map((s, i) => [s.id, turns.slice(Math.max(0, i - 2), i)]));
  const segmentOf = new Map<string | null, string | undefined>(turns.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const checkpointed = new Set<string | undefined>(log.filter((e): e is Entry<'checkpoint'> => e.kind === 'checkpoint').map((e) => e.name));
  const order = store ? store.messages.flatMap((m) => m.canaries.filter(conversational)) : [];
  const at = new Map<string, number>(order.map((c, i) => [c, i]));
  const stepAt = new Map<string | null, number>(script.map((s, i) => [s.id, i]));
  const stepById = new Map<string | null, Step>(script.map((s) => [s.id, s]));
  const suppressedAt = new Map<string, number>();
  script.forEach((s, i) => { if (s.op === 'suppress' || s.kind === 'suppress') for (const m of s.messages ?? []) if (m.canary && !suppressedAt.has(m.canary)) suppressedAt.set(m.canary, i); });
  const suppressed = (c: string, stepId: string | null) => suppressedAt.has(c) && suppressedAt.get(c)! < (stepAt.get(stepId) ?? Infinity);
  const failed = new Set<string | null>(log.filter((e) => e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test((e.event?.type ?? '') as string)).map((e) => e.step));
  const failedReply = (c: string, stepId: string | null) => failed.has(stepId) && /\.r\d+\]\]$/.test(c);
  // A /branchto in the script rolls the record back to the message its canary names, dropping each turn's input and
  // replies after it. Without a final store read, the check can't tell what the record still holds of those, so it
  // asks for none of them at a request after the rollback and counts them as not judged.
  const rolledAt = new Map<string, number>();
  script.forEach((s, i) => {
    const target = s.kind === 'command' && /^\/branchto (\[\[c:[^\]\s]+\]\])/.exec(s.command ?? '')?.[1];
    if (!target) return;
    const order = script.slice(0, i).filter((t) => Array.isArray(t.replies) && t.replies.length).flatMap((t) => [`[[c:${t.id}.in]]`, ...replyCanaries(t)]);
    const from = order.indexOf(target);
    if (from >= 0) for (const c of order.slice(from + 1)) if (!rolledAt.has(c)) rolledAt.set(c, i);
  });
  const rolledBack = (c: string, stepId: string | null) => rolledAt.has(c) && rolledAt.get(c)! < (stepAt.get(stepId) ?? Infinity);
  const held = (c: string, stepId: string | null, at_: string | null = stepId) => (store ? at.has(c) || (suppressedAt.has(c) && !suppressed(c, at_)) : !suppressed(c, at_) && !failedReply(c, stepId) && !rolledBack(c, at_));
  const unjudged = new Set<string>();
  const gone = new Set<string>();
  const asked = new Map<string | null, number>();
  for (const r of records) {
    if (!own(r)) continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (answeredBare(r) ? 1 : 0));
    if (!before.has(r.step)) continue;
    let heldTo = 0;
    const carried = new Set((r.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const inputs = inputsOf(stepById.get(r.step) ?? { id: r.step });
    const ownInput = inputs.map((c) => at.get(c)).filter((i) => i !== undefined).reduce((a, b) => Math.max(a, b), -1);
    if (store && ownInput >= 0 && lasts.has(r) && checkpointed.has(segmentOf.get(r.step))) {
      const storedBefore = new Set([...order.slice(0, ownInput + 1), ...replyCanaries(stepById.get(r.step) ?? { id: r.step }, n - 1)]);
      if (!heads.has(segmentOf.get(r.step))) {
        flags.push({ check: 6, step: r.step, request: r.id, message: `no head size was reported at segment ${segmentOf.get(r.step)}'s checkpoint` });
      } else {
        const from = headStart(store, inputs);
        const head = store.messages.slice(from, from + heads.get(segmentOf.get(r.step))!).flatMap((m) => m.canaries.filter(conversational)).filter((c) => storedBefore.has(c) && !shed(c, r.step) && !undone(c, r.step));
        heldTo += head.length;
        const lost = head.filter((c) => !carried.has(c));
        if (lost.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the head window's ${lost.join(' ')} isn't raw` });
      }
    }
    for (const t of before.get(r.step)!) {
      const each = [...inputsOf(t), ...replyCanaries(t)].filter((c) => !tuned.has(c) && !shed(c, r.step));
      const wanted = each.filter((c) => held(c, t.id, r.step) && !undone(c, r.step));
      if (store) for (const c of each) if (!wanted.includes(c) && !suppressedAt.has(c) && !undone(c, r.step)) gone.add(c);
      if (!store) for (const c of each) if (rolledBack(c, r.step) && !suppressed(c, r.step) && !failedReply(c, t.id)) unjudged.add(c);
      heldTo += wanted.length;
      const missing = wanted.filter((c) => !carried.has(c));
      if (missing.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the recent window lacks ${missing.join(' ')}` });
    }
    if (heldTo) judged++;
  }
  if (!store) return withJudged(flags, judged, unjudged.size ? `${unjudged.size} recent message${unjudged.size === 1 ? '' : 's'} not judged, as a rollback before ${unjudged.size === 1 ? 'its request' : 'their requests'} may have dropped ${unjudged.size === 1 ? 'it' : 'them'} and no final store was read` : null);
  let tailsGone = 0;
  const stepOf = new Map<string | null, Step>(script.map((s) => [s.id, s]));
  for (const { segment, request, n, composition } of lastRequests(records, script, log, agent)) {
    if (!request) continue;
    const size = composition?.tail?.messages;
    if (typeof size !== 'number') { flags.push({ check: 6, step: request.step, request: request.id, message: `no tail size was reported at segment ${segment}'s checkpoint` }); continue; }
    const step = stepOf.get(request.step);
    const earlier = answeredReplies(step).slice(0, Math.max(0, n - 1));
    const storedBefore = new Set([...inputsOf(step ?? { id: request.step }), ...replyCanaries(step ?? { id: request.step }, n - 1), ...earlier.flatMap((reply) => ((reply.calls ?? []) as Call[]).map((c) => c.input?.canary))]);
    let at = -1;
    store.messages.forEach((m, i) => { if (m.canaries.some((c) => storedBefore.has(c))) at = i; });
    if (at < 0) { tailsGone++; continue; }
    judged++;
    const tail = store.messages.slice(Math.max(0, at - size + 1), at + 1).flatMap((m) => m.canaries.filter(conversational)).filter((c) => !shed(c, request.step) && !undone(c, request.step));
    const carried = new Set((request.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const lost = tail.filter((c) => !carried.has(c));
    if (lost.length) flags.push({ check: 6, step: request.step, request: request.id, message: `the reported tail's ${lost.join(' ')} isn't raw` });
  }
  const besides = [
    ...(gone.size ? [`${gone.size} recent message${gone.size === 1 ? '' : 's'} not asked for, as the final store doesn't hold ${gone.size === 1 ? 'it' : 'them'}`] : []),
    ...(tailsGone ? [`${tailsGone} checkpoint tail${tailsGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${tailsGone === 1 ? 'its' : 'their'} last input`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

// context-manager prunes older tool results by design, so only inputs and replies must stay.
const conversational = (c: string) => /\.(in|r\d+)\]\]$/.test(c);

export function coverage(records: RequestRecord[], store: Store, script: Step[] = [], log: LogEntry[] = [], { agent = FIXTURE_AGENT, side = 'primary' }: { agent?: string; side?: string } = {}) {
  const own = ofSide(side);
  const sub = side !== 'primary';
  const tuned = sub ? new Set<string>() : tunedOutOf(script);
  const undone = undoneBy(script);
  const shed = shedBy(script);
  const counted: (c: string) => boolean = sub ? () => true : conversational;
  const flags: CheckFlag[] = [];
  let judged = 0;
  let inputGone = 0;
  const segmentOf = new Map<string | null, string | undefined>(script.map((s) => [s.id, s.segment]));
  const stepById = new Map<string | null, Step>(script.map((s) => [s.id, s]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const covers = new Map<string | null, string[]>(store.summaries.filter((s) => s.number).map((s) => [s.number, s.covers]));
  // A stitched summary's later marks are its own fold parts where a fold answer wrote them, carried in the same block as
  // its number, which carries its coverage.
  const folded = new Set(records.filter((r) => r.kind === 'summariser' && r.answer?.summary).map((r) => r.answer!.summary));
  const partOf = new Map<string, string | null>(store.summaries.flatMap((s) => (s.parts ?? []).filter((p) => folded.has(p)).map((p) => [p, s.number])));
  const order = store.messages.flatMap((m) => m.canaries.filter(counted));
  // agent-framework never renders a row a suppress rule hid (`metadata.suppressed`), so no request owes it.
  const hiddenAt = store.messages.flatMap((m) => m.canaries.filter(counted).map(() => m.suppressed === true));
  const at = new Map<string, number>(order.map((c, i) => [c, i]));
  // An agent whose window is presented is sent its rows in the order they entered it (read-store's ordinals), so a row
  // that arrived during a turn and was presented after rows stored after it goes out after them; a row the store's last
  // window doesn't hold has no place in that order. One whose window is the record is sent them in store order.
  const presents = store.presented === true;
  const ranked = presents ? store.messages.filter((m) => m.ordinal !== undefined).sort((a, b) => a.ordinal! - b.ordinal!) : store.messages;
  const rank = new Map<string, number>();
  ranked.flatMap((m) => m.canaries.filter(counted)).forEach((c, i) => { if (!rank.has(c)) rank.set(c, i); });
  // What a presented window doesn't order is counted by stored row, each once whatever its canaries and however it was
  // sent, a row a suppress rule hid taken only for a canary no other row carries; a canary no stored row carries is
  // counted by itself.
  const rowOf = new Map<string, Row['id']>();
  for (const m of [...store.messages.filter((x) => x.suppressed !== true), ...store.messages.filter((x) => x.suppressed === true)]) for (const c of m.canaries.filter(counted)) if (!rowOf.has(c)) rowOf.set(c, m.id);
  const unordered = new Set<Row['id']>();
  const unstored = new Set<string>();
  const leave = (c: string) => { if (!rank.has(c)) (rowOf.has(c) ? unordered.add(rowOf.get(c)!) : unstored.add(c)); };
  const orderWhat = presents ? 'window-order' : 'store-order';
  const asked = new Map<string | null, number>();
  for (const r of records) {
    if (!own(r)) continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (answeredBare(r) ? 1 : 0));
    const shown: string[] = [];
    const unknown: string[] = [];
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        shown.push(...(b.canaries || []).filter(counted));
        for (const s of b.summaries || []) {
          if (covers.has(s)) shown.push(...covers.get(s)!.filter(counted));
          else if (!((b.summaries ?? []) as readonly unknown[]).includes(partOf.get(s))) unknown.push(s);
        }
      }
    }
    const inputs = inputsOf(stepById.get(r.step) ?? { id: r.step });
    const ownInput = sub ? Math.max(-1, ...shown.map((x) => at.get(x) ?? -1)) : Math.max(-1, ...inputs.map((c) => at.get(c) ?? -1));
    if (ownInput < 0) { inputGone++; continue; }
    judged++;
    for (const s of new Set(unknown)) flags.push({ check: 4, step: r.step, request: r.id, what: 'unmapped-summary', message: `summary ${s} is in the request, and no store read maps it` });
    const size = lasts.has(r) ? heads.get(segmentOf.get(r.step)) : undefined;
    const from = headStart(store, inputs);
    const head = size === undefined ? null : new Set(store.messages.slice(from, from + size).flatMap((m) => m.canaries));
    const boundary = store.messages.slice(0, from).flatMap((m) => m.canaries.filter(conversational)).length;
    const raw = (c: string, i: number): Place => (head ? (head.has(c) ? 'head' : 'rest') : i >= boundary ? 'from' : 'before');
    const summary = (i: number): Place => (head ? 'rest' : i >= boundary ? 'from' : 'before');
    const within = { head: 'its head window', rest: 'messages past its head window', from: "what was stored from its head's start on", before: "what was stored before its head's start" };
    const last: Partial<Record<Place, Placed>> = {};
    // agent-framework's gate line quotes events its batch held, which the request carried in their own place before it;
    // on the Chat Completions API rows before and after the line can share its block.
    const carriedBefore = new Set<string>();
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        const seq = b.marks ?? [...(b.canaries || []), ...(b.summaries || [])];
        const line = b.wakeLine !== undefined ? (b.wakeAfter ?? 0) : Infinity;
        const carried = (x: string) => (x.startsWith('[[s:') ? covers.get(x) ?? [] : [x]);
        const quoted = line < Infinity ? new Set([...carriedBefore, ...seq.slice(0, line).flatMap(carried)]) : null;
        for (const x of seq) for (const c of carried(x)) carriedBefore.add(c);
        const canaryItem = (c: string): Item => [c, rank.get(c), raw(c, at.get(c)!), [c]];
        const summaryItem = (x: string): Item => { const i = Math.min(...covers.get(x)!.filter(counted).map((c) => at.get(c) ?? Infinity)); return [x, Math.min(...covers.get(x)!.filter(counted).map((c) => rank.get(c) ?? Infinity)), summary(i), covers.get(x)!.filter(counted)]; };
        let items = seq.flatMap((x, place): Placed[] => (x.startsWith('[[s:') ? (covers.has(x) ? [[...summaryItem(x), place]] : []) : counted(x) ? [[...canaryItem(x), place]] : []));
        if (presents) for (const item of items) item[3].forEach(leave);
        items = items.filter(([x, i, , , place]) => Number.isFinite(i) && !(place >= line && quoted?.has(x)));
        for (const item of items) {
          const before = last[item[2]];
          if (before && item[1]! < before[1]! && !flags.some((f) => f.request === r.id && f.what === orderWhat)) {
            flags.push({ check: 4, step: r.step, request: r.id, what: orderWhat, message: `it carries ${item[0]} after ${before[0]}, out of ${presents ? 'the order its window presented them in' : 'store order'}${head || boundary > 0 ? ` within ${within[item[2]]}` : ''}` });
          }
          last[item[2]] = item;
        }
      }
    }
    const count = new Map<string, number>();
    for (const c of shown) count.set(c, (count.get(c) ?? 0) + 1);
    const wanted = [...order.slice(0, ownInput + 1).filter((c, i) => !hiddenAt[i]), ...(sub ? [] : replyCanaries(stepById.get(r.step) ?? { id: r.step }, n - 1))].filter((c) => !tuned.has(c) && !undone(c, r.step) && !shed(c, r.step));
    // A canary is owed once for each stored row that carries it: a message and a row that quotes it, such as the
    // knowledge retrieval's, each go out once.
    const rows = new Map<string, number>();
    for (const c of wanted) rows.set(c, (rows.get(c) ?? 0) + 1);
    const missing = [...rows.keys()].filter((c) => !count.has(c));
    const twice = [...rows.keys()].filter((c) => count.get(c)! > rows.get(c)!);
    const often = (c: string) => `${c} (${count.get(c)} for ${rows.get(c)} row${rows.get(c) === 1 ? '' : 's'})`;
    if (missing.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'not-reached', ...cutMessage((cut, whole) => `${missing.length} stored message(s) reach the request neither raw nor in a summary: ${cut(missing, 5, ' ')}${!whole && missing.length > 5 ? ' …' : ''}`) });
    if (twice.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'more-than-once', ...cutMessage((cut, whole) => `${twice.length} message(s) reach the request more often than stored rows carry them: ${cut(twice.map(often), 5, ' ')}${!whole && twice.length > 5 ? ' …' : ''}`) });
  }
  const besides = [
    ...(inputGone ? [`${inputGone} request${inputGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${inputGone === 1 ? 'its' : 'their'} own input`] : []),
    ...(unordered.size ? [`${unordered.size} row${unordered.size === 1 ? '' : 's'} not judged for order, as the final window doesn't hold ${unordered.size === 1 ? 'it' : 'them'}`] : []),
    ...(unstored.size ? [`${unstored.size} ${unstored.size === 1 ? 'canary' : 'canaries'} not judged for order, as no row the final store holds carries ${unstored.size === 1 ? 'it' : 'them'}`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

// A reply the script says an /undo took out, sent raw after it anyway, read from the request alone.
export function undoneSent(records: RequestRecord[], script: Step[] = [], { side = 'primary' }: { side?: string } = {}) {
  const undone = undoneBy(script);
  const flags: CheckFlag[] = [];
  let judged = 0;
  for (const r of records) {
    if (!ofSide(side)(r) || !script.some((s) => (s.undoes ?? []).some((c) => undone(c, r.step)))) continue;
    judged++;
    const resent = [...new Set((r.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []).filter((c) => undone(c, r.step)))];
    if (resent.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'undone-sent', message: `${resent.join(' ')}, which the script says the /undo before it took out, goes out raw` });
  }
  return withJudged(flags, judged);
}

// A reader fork is shown in its framing what its step's tune-out held, and its view filter keeps the held rows
// themselves out of its compiles (agent-framework 0.33.0, invokeReaderFork).
export function heldFramed(records: RequestRecord[], script: Step[] = [], log: LogEntry[] = []) {
  const flags: CheckFlag[] = [];
  let judged = 0;
  const { owners, problem } = subOwners(records, log);
  if (problem) return withJudged([], 0);
  const others = compilingAgents(log).filter((a) => a !== primaryAgent(log) && sideOfAgent(a, log, records) === 'sub');
  const forks = (r: RequestRecord) => readerForkOf(owners?.get(r.id) ?? (others.length === 1 ? others[0] : null));
  for (const s of script) {
    if (s.reader?.prefix === undefined || !(s.tunedOut ?? []).length) continue;
    const carried = new Set(records.filter((r) => ofSide('sub')(r) && r.step === s.id && forks(r)).flatMap((r) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).flatMap((b) => b.canaries ?? [])));
    for (const c of s.tunedOut!) {
      judged++;
      if (!carried.has(c)) flags.push({ check: 4, step: s.id, what: 'held-unframed', message: `${c}, which the tune-out held, reaches no reader fork's request at its step` });
    }
  }
  return withJudged(flags, judged);
}

export function bookkeeping(records: RequestRecord[], store: Store, { side = 'primary' }: { side?: string } = {}) {
  const counted: (c: string) => boolean = side === 'sub' ? () => true : conversational;
  const flags: CheckFlag[] = [];
  let judged = 0;
  let written = 0;
  let answersGone = 0;
  let sourcesUnknown = 0;
  const byNumber = new Map<string | null, StoreSummary>(store.summaries.flatMap((s) => [s.number, ...(s.parts ?? [])].filter(Boolean).map((n) => [n, s])));
  const byId = new Map<string, StoreSummary>(store.summaries.map((s) => [s.id, s]));
  const messages = new Map<Row['id'], Row>(store.messages.map((m) => [m.id, m]));
  // A stitched summary is judged once, at its first fold part's request, against what all its parts' requests showed.
  const stitchedBy = new Map<string, RequestRecord[]>();
  for (const r of records) {
    const s = r.kind === 'summariser' && r.answer?.summary ? byNumber.get(r.answer.summary) : null;
    if (s?.parts?.length) stitchedBy.set(s.id, [...(stitchedBy.get(s.id) ?? []), r]);
  }
  for (const r of records) {
    const answered = r.kind === 'summariser' ? r.answer?.summary : null;
    if (!answered) continue;
    const s = byNumber.get(answered);
    if (!s) { answersGone++; continue; }
    const group = (stitchedBy.get(s.id) ?? [r]) as SummariserRecord[];
    if (group[0] !== r) continue;
    const number = s.parts?.length ? s.number : answered;
    written++;
    const unread = s.sourceIds.filter((id) => !(s.sourceLevel === 0 ? messages.has(id) : byId.has(id)));
    if (unread.length) { flags.push({ check: 5, step: r.step, request: r.id, what: 'unread-source', ...cutMessage((cut) => `summary ${number} (${s.id}) has ${unread.length} source(s) the store read doesn't hold: ${cut(unread, 5)}`) }); continue; }
    const sentCanaries = new Set(group.flatMap((x) => x.sent?.canaries || []));
    const sentSummaries = new Set(group.flatMap((x) => x.sent?.summaries || []));
    const shown = (child: StoreSummary, seen: Set<string> = new Set()): 'shown' | 'unseen' | 'unknown' => {
      if (seen.has(child.id)) return 'unseen';
      seen.add(child.id);
      if (child.number && sentSummaries.has(child.number)) return 'shown';
      if (child.sourceLevel > 0 && child.sourceIds.length && child.sourceIds.every((id) => byId.has(id) && shown(byId.get(id)!, seen) === 'shown')) return 'shown';
      const covered = child.covers.filter(counted);
      if (!covered.length) return 'unknown';
      return covered.every((c) => sentCanaries.has(c)) ? 'shown' : 'unseen';
    };
    const unseen: string[] = [];
    let held = 0;
    for (const id of s.sourceIds) {
      if (s.sourceLevel === 0) {
        if (s.placeheld?.includes(id)) { held++; continue; }
        const own = messages.get(id)!.canaries.filter(counted);
        if (!own.length) { sourcesUnknown++; continue; }
        held++;
        if (own.some((c) => !sentCanaries.has(c))) unseen.push(id);
      } else {
        const seenAs = shown(byId.get(id)!);
        if (seenAs === 'unknown') { sourcesUnknown++; continue; }
        held++;
        if (seenAs === 'unseen') unseen.push(id);
      }
    }
    if (held) judged++;
    if (unseen.length) flags.push({ check: 5, step: r.step, request: r.id, ...cutMessage((cut) => `summary ${number} (${s.id}, L${s.level}) declares ${unseen.length} source(s) its request didn't show: ${cut(unseen, 5)}`) });
  }
  Object.defineProperty(flags, 'written', { value: written, enumerable: false });
  const besides = [
    ...(answersGone ? [`${answersGone} summariser answer${answersGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${answersGone === 1 ? 'its' : 'their'} summary`] : []),
    ...(sourcesUnknown ? [`${sourcesUnknown} source${sourcesUnknown === 1 ? '' : 's'} not judged, as nothing ${sourcesUnknown === 1 ? 'it covers' : 'they cover'} carries a canary to tell by`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null) as Judged<CheckFlag> & { readonly written: number };
}

type Walked = { calibration?: { multiplier?: unknown; [field: string]: unknown } | null; [field: string]: unknown } | string | number | bigint | boolean | symbol | null | undefined;

function multipliers(value: Walked, out: number[] = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.calibration && typeof value.calibration.multiplier === 'number') out.push(value.calibration.multiplier);
  for (const v of Object.values(value)) multipliers(v as Walked, out);
  return out;
}

export function calibrationEdge(log: LogEntry[] = [], { low = 0.6, high = 1.8, adaptive = false }: { low?: number; high?: number; adaptive?: boolean } = {}) {
  const flags: CheckFlag[] = [];
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'checkpoint' && e.kind !== 'health') continue;
    if (e.skipped) continue;
    const where = e.kind === 'health' ? 'the run\'s end' : `checkpoint ${e.name}`;
    const failed = e.health?.ok === false ? e.health.error || 'the panel read failed' : Object.entries(e.health?.data?.readFailures ?? {}).map(([agent, f]) => (f?.contextComposition ? `${agent}'s context composition: ${f.contextComposition}` : null)).filter(Boolean).join('; ');
    if (failed) flags.push({ check: 10, step: e.step ?? 'the run', what: 'unread-panel', message: `couldn't judge calibration at ${where}: the health panel's read failed (${failed})` });
    for (const m of multipliers(e.health)) {
      judged++;
      if (Math.abs(m - low) < 1e-9 || Math.abs(m - high) < 1e-9) flags.push({ check: 10, step: e.step ?? 'the run', what: 'clamp-edge', message: `calibration at the clamp edge (${m}) at ${where}: the run is invalid` });
    }
  }
  if (adaptive && log.some((e) => e.kind === 'end' && e.ok) && !log.some((e) => e.kind === 'health' && e.name === 'end')) {
    flags.push({ check: 10, step: 'the run', what: 'no-end-read', message: 'couldn\'t judge calibration at the run\'s end: the run completed and logged no end-of-run health read, read or skipped' });
  }
  return withJudged(flags, judged);
}

// A record's turns: its messages, where a codec that writes each wire unit as a message of its own gives each a side,
// and units on the system side take no turn. On the Responses API (`api` anything but 'chat-completions') the units
// are items, and consecutive items on one side are one turn. On the Chat Completions API each wire message is a
// message, so two on one side are two turns, out of turn, but a `tool` message joins its side's turn, and so does the
// message after one: the results answering a call, and a user message following them, are the user's one turn. A
// message with no side, as the Messages API's, is its own turn, but on the Messages API consecutive messages of one
// role are one: "Consecutive `user` or `assistant` turns in your request will be combined into a single turn"
// (https://platform.claude.com/docs/en/api/messages/create, `messages`, read 2026-11-08).
export function turnsOf(messages: readonly WireMessage[] = [], api: string | null | undefined = null) {
  const out: Turn[] = [];
  for (const m of messages) {
    if (m.side === undefined) {
      const last = out.at(-1);
      if (api === 'messages' && last !== undefined && last.side === undefined && last.role === m.role) out[out.length - 1] = { ...last, blocks: [...last.blocks, ...m.blocks] };
      else out.push(m);
      continue;
    }
    if (m.side === 'system') continue;
    const last = out.at(-1);
    const joins = last?.side === m.side && (api !== 'chat-completions' || m.role === 'tool' || last.wire === 'tool');
    if (joins) { last.blocks = [...last.blocks, ...m.blocks]; last.wire = m.role; }
    else out.push({ role: m.side, side: m.side, wire: m.role, blocks: [...m.blocks] });
  }
  return out;
}

// The Messages API's tool-use page: "In the user message containing tool results, the `tool_result` blocks must come
// FIRST in the content array" (https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls, read
// 2026-11-08), so a result after another block in a user turn is out of place there, also where turnsOf joined it.
export function wellFormed(records: RequestRecord[]) {
  const flags: CheckFlag[] = [];
  let judged = 0;
  for (const r of records) {
    if (r.kind === 'unclassified') continue;
    judged++;
    const ms = turnsOf(r.messages || [], r.head?.api);
    if (r.head?.api === 'messages') {
      for (const [i, m] of ms.entries()) {
        if (m.role !== 'user') continue;
        const first = m.blocks.findIndex((b) => b.type !== 'tool_result');
        const late = first < 0 ? undefined : m.blocks.slice(first).find((b) => b.type === 'tool_result');
        if (late) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s result ${late.toolUseId} comes after another block of its turn, where the Messages API takes a turn's tool results first` });
      }
    }
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].role === ms[i - 1].role) { flags.push({ check: 3, step: r.step, request: r.id, message: `messages ${i - 1} and ${i} are both ${ms[i].role}'s` }); break; }
    }
    for (let i = 0; i < ms.length; i++) {
      const calls = new Set(ms[i].blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const results = new Set(ms[i].blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      const before = new Set((ms[i - 1]?.blocks || []).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const after = new Set((ms[i + 1]?.blocks || []).filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      for (const id of results) if (!before.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s result ${id} answers no call in the message before it` });
      if (i < ms.length - 1) for (const id of calls) if (!after.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s call ${id} has no result in the message after it` });
    }
  }
  return withJudged(flags, judged);
}
