import { createHash } from 'node:crypto';
import { bindingControl, budgets, compileInvariants, compilingAgents, ofSide, pairing, withJudged, reloads, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, coverage, heldFramed, undoneSent, bookkeeping, calibrationEdge, FIXTURE_AGENT, STREAM_BOUND, primaryAgent, sideOfAgent, subOwners } from './checks.ts';
import { bindsThinking } from '../standin/anthropic.ts';
import { servedModel } from '../standin/bedrock.ts';
import { messageNames, requestNames, spanName } from './names.ts';
import { cutText } from '../cut/interfaces.ts';
import { epochNames } from './compare.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { CheckFlag, Headroom } from './checks.ts';
import type { Cut } from '../cut/interfaces.ts';
import type { LogEntry } from './driver.ts';
import type { Judgement } from './judge.ts';
import type { Store, StoreSummary } from './read-store.ts';
import type { Products, Step } from './script.ts';
import type { Breaches, Owned } from '../workloads/fates.ts';

export type Note = string | { message: string; full: string };
export type JudgedCount = { check: number; name: string; judged: number | null; besides?: string };
type Part = { check: number; name: string; flags: CheckFlag[] & { readonly judged?: number; readonly besides?: string }; judged?: number | null; applies?: string | null };
type Missing = { segment: string; missing: string[] };
type Candidate = { flags: CheckFlag[]; missing: Missing[]; notes?: Note[]; headroom?: Headroom[]; judged?: JudgedCount[] };
export type Report = ReturnType<typeof perCheckReport>;

const noteOf = (write: (cut: Cut, whole: boolean) => string): Note => {
  const { shown, full } = cutText(write);
  return full ? { message: shown, full } : shown;
};

export function runChecks({ records: all, log, script, products, store, agent = FIXTURE_AGENT, side = sideOfAgent(agent, log, all), streamBound = STREAM_BOUND, windowTokens, binds = false, adaptive = false, served = servedModel }: { records: RequestRecord[]; log: LogEntry[]; script: Step[]; products: Products; store?: Store | null; agent?: string; side?: string; streamBound?: number | null; windowTokens?: number; binds?: boolean; adaptive?: boolean; served?: (model: string) => string }) {
  const placed = side === 'sub' ? subOwners(all, log).owners : null;
  const records = placed ? all.filter((r) => !(r.kind === 'agent' && (r.agent ?? 'primary') === 'sub') || placed.get(r.id) === agent) : all;
  const own = ofSide(side);
  const budget = budgets(records, script, log, { agent, streamBound, windowTokens });
  const ownRequests = records.filter(own).length;
  const laterTurns = new Set<string | null>(script.filter((st) => Array.isArray(st.replies) && st.replies.length).slice(1).map((st) => st.id));
  const turnRequests = records.filter((r) => own(r) && laterTurns.has(r.step)).length;
  const missing = declaredProducts(all, script, products, store);
  const declared = Object.values(products ?? {}).flat().length;
  const primary = primaryAgent(log);
  const placing = subOwners(all, log).problem;
  const parts: Part[] = [
    { check: 1, name: 'every turn answers', flags: everyTurnAnswers(all, log, script) },
    { check: 2, name: 'declared products', flags: withJudged([], missing.judged, missing.besides ?? null), judged: missing.judged, applies: declared > 0 ? `the run declares ${declared} product(s)` : null },
    { check: 3, name: 'request shape', flags: wellFormed(all) },
    { check: 3, name: 'budgets', flags: budget.flags, judged: budget.judged, applies: budget.requests > 0 ? `the run's agent made ${budget.requests} request(s)` : null },
    ...(store ? [{ check: 4, name: 'coverage', flags: coverage(records, store, script, log, { agent, side }), applies: ownRequests > 0 ? `a store was read and the run's agent made ${ownRequests} request(s)` : null }] : []),
    ...(script.some((s) => s.reader?.prefix !== undefined && (s.tunedOut ?? []).length) ? [{ check: 4, name: 'held messages framed', flags: heldFramed(all, script, log), applies: 'reader forks read what a tune-out held' }] : []),
    ...(script.some((s) => (s.undoes ?? []).length) ? [{ check: 4, name: 'undone replies', flags: undoneSent(records, script, { side }), applies: 'the script says an /undo took a reply out' }] : []),
    ...(store ? [(() => { const flags = bookkeeping(records, store, { side }); return { check: 5, name: 'bookkeeping', flags, applies: flags.written > 0 ? `the store holds ${flags.written} summar${flags.written === 1 ? 'y' : 'ies'} a summariser request wrote` : null }; })()] : []),
    { check: 6, name: 'windows raw', flags: windowsRaw(records, script, log, store, { agent, side }), applies: side === 'primary' && turnRequests > 0 ? `the run's agent made ${turnRequests} request(s) at a scripted turn after the first` : null },
    { check: 10, name: 'calibration edge', flags: calibrationEdge(log, { adaptive }), applies: adaptive && log.some((e) => (e.kind === 'checkpoint' || e.kind === 'health') && Object.keys(e.health?.data?.contextComposition ?? {}).length) ? 'an adaptive configuration\'s health panel reported its context composition' : null },
    { check: 11, name: 'compile invariants', flags: compileInvariants(log), applies: budget.requests > 0 ? 'the run\'s agent made requests' : null },
    { check: 12, name: 'reloads', flags: reloads(log), applies: script.some((s) => s.reloadCheck) ? 'the script restarts with a reload check' : null },
    ...[...new Set([...(budget.requests > 0 ? [agent] : []), ...compilingAgents(log) as string[]])].map((a) => ({
      check: 13, name: `pairing ${a}`,
      flags: a !== primary && placing && sideOfAgent(a, log, all) === 'sub'
        ? withJudged([{ check: 13, step: 'the run', what: `${a}:shared-side`, message: `couldn't judge ${a}'s pairing: ${placing}, and the stand-in tells only the configuration's own agent's requests, and those of a subagent its script labels by the name it's spawned with, from the rest` }], 0)
        : pairing(all, log, a),
      applies: a === agent && budget.requests > 0 ? `${a} made ${budget.requests} request(s)` : `${a} compiled requests`,
    })),
    ...(binds || all.some((r) => r.kind === 'agent' && r.head?.api === 'messages' && bindsThinking(served(r.head?.model as string))) ? [{ check: 15, name: 'binding control', flags: bindingControl(all, { served }), applies: binds ? 'the configuration\'s agent model binds thinking' : 'an agent request went to a model that binds thinking' }] : []),
  ];
  const judged = parts.map((p): JudgedCount => ({ check: p.check, name: p.name, judged: p.judged ?? p.flags.judged ?? null, ...(p.flags.besides ? { besides: p.flags.besides } : {}) }));
  const unjudged = parts.filter((p) => p.applies && (p.judged ?? p.flags.judged) === 0).map((p): CheckFlag => ({
    check: p.check, step: 'the run', what: `judged-none:${p.name}`,
    message: `couldn't judge: check ${p.check} (${p.name}) judged nothing, though it applies (${p.applies})`,
  }));
  const flags = [...parts.flatMap((p) => p.flags), ...unjudged];
  const unmarked = (store?.summaries ?? []).filter((s) => !s.number).map(summaryNamer(store));
  const notes = [...budget.notes, ...(unmarked.length ? [noteOf((cut) => `check 5 doesn't judge ${unmarked.length} stored summar${unmarked.length === 1 ? 'y' : 'ies'} with no stand-in mark, which context-manager wrote without a summariser request: ${cut(unmarked, 5)}`)] : [])];
  return { flags, missing, headroom: budget.headroom, notes, judged };
}

export function perCheckReport({ configuration, candidate }: { configuration: { name: string }; candidate: Candidate }) {
  const invalid = candidate.flags.filter((f) => f.check === 10 && f.what === 'clamp-edge');
  const flags = candidate.flags.filter((f) => !invalid.includes(f));
  const missing = candidate.missing.flatMap((m) => m.missing.map((name) => ({ segment: m.segment, name })));
  const verdict = invalid.length ? 'invalid' : flags.length || missing.length ? 'flags' : 'pass';
  const lines = [];
  if (invalid.length) lines.push(`INVALID: ${invalid[0].message}${invalid.length > 1 ? ` (and ${invalid.length - 1} more)` : ''}. Its folds are clamped folds, not a store's.`);
  lines.push(`${configuration.name}: ${verdict === 'pass' ? 'no flags' : `${flags.length} flag(s), ${missing.length} missing product(s)`}.`);
  const whole = (x: { full?: string }) => (x.full ? [`  whole: ${x.full}`] : []);
  for (const f of flags) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}`, ...whole(f), ...(f.events ?? []).map((e) => `  ${e}`));
  for (const m of missing) lines.push(`- check 2, ${m.segment}: missing ${m.name}`);
  for (const n of (candidate.notes ?? []) as Array<Note & { message?: string; full?: string }>) lines.push(`- ${n.message ?? n}`, ...(n.full ? [`  whole: ${n.full}`] : []));
  if (candidate.judged?.length) lines.push(`- judged: ${candidate.judged.map((j) => `check ${j.check} ${j.name} ${j.judged ?? '?'}${j.besides ? ` (${j.besides})` : ''}`).join(', ')}`);
  if (candidate.headroom?.length) lines.push(`- budget headroom, each segment's least: ${candidate.headroom.map((h) => `${h.segment} ${h.bound - h.tokens} of ${h.bound}${h.kind === 'continuation' ? ' (a stream\'s fresh input through a continuation round, against the stream bound)' : ' (a compiled request\'s whole input, against the model\'s window)'}`).join(', ')}`);
  return { verdict, lines, invalid, flags, missing, judged: candidate.judged ?? [] };
}

export function namedReport(report: Report, log: LogEntry[] = [], epochs: (text: string) => string = epochNames(log)) {
  const requests = requestNames(log);
  const named = (text: string) => requests.named(epochs(text));
  const walk = (v: unknown): unknown => (typeof v === 'string' ? named(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' && !JSON.isRawJSON(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  const eventLines = new Set((report.flags ?? []).flatMap((f) => (f.events ?? []).map((e) => `  ${e}`)));
  walk({ ...report, lines: (report.lines ?? []).filter((l) => !eventLines.has(l)), flags: (report.flags ?? []).map(({ events, ...f }) => f) });
  return walk(report) as Report;
}

export const comparableFlags = (report: Report) => [
  ...report.invalid,
  ...report.flags,
  ...report.missing.map((m): CheckFlag => ({ check: 2, step: m.segment, message: `missing ${m.name}` })),
].map((f) => ({ check: f.check, step: f.step, ...(f.what ? { what: f.what } : {}), detail: f.detail ?? f.message, ...(f.full ? { whole: createHash('sha256').update(f.full).digest('hex').slice(0, 12) } : {}) }));

export interface UntracedToken { request: string; token: string; givenBy: string[] }

const brokenTrace = ([first, ...rest]: UntracedToken[]) => {
  const by = first.givenBy.length === 1
    ? `which the answer to ${first.givenBy[0]} gives, and ${first.request} arrived before that answer began to be sent`
    : `which the answers to ${first.givenBy.slice(0, -1).join(', ')} and ${first.givenBy.at(-1)} give, and ${first.request} arrived before any of them began to be sent`;
  const more = rest.length === 0 ? '' : `; ${rest.length} more carried token${rest.length === 1 ? ' breaks' : 's break'} it`;
  return `its trace is broken: request ${first.request} carries ${first.token}, ${by}${more}`;
};

export interface UnorderedUse { request: string; with: string; why: 'kinds' | 'markers' | 'passed' }

const unorderedCache = ([[a, b], ...rest]: Array<[string, string]>) => `a cache figure rests on arrival: requests ${a} and ${b} meet in one cache, nothing orders the two, and their order can move what one of them reads${rest.length === 0 ? '' : `; ${rest.length} more pair${rest.length === 1 ? ' does' : 's do'} too`}`;

const recordPlace = (log: LogEntry[]) => {
  const at = new Map<string, number>();
  for (const e of log as Array<{ kind: string; order?: readonly string[] }>) if (e.kind === 'order') for (const id of e.order ?? []) if (!at.has(id)) at.set(id, at.size);
  return (id: string) => at.get(id) ?? at.size;
};

export interface TiedPair { request: string; with: string }

export interface CrossCompile { by: string | null; agent: string | null; boot: number; seq: number; lacks?: string }

const JUDGED_SINCE: Record<string, string> = { storableToolCall: '0.22.0', logicalTurnAlive: '0.33.0' };

const unjudgedCompile = (c: CrossCompile) => `a dry compile couldn't be judged: the host's agent-framework gives no \`${c.lacks}\` (agent-framework has it from ${JUDGED_SINCE[c.lacks!]}), so ${c.lacks === 'storableToolCall'
  ? `whether another agent's tool call compiled ${c.agent === null ? 'an unnamed agent' : c.agent}'s context`
  : `whether ${c.agent}'s context was compiled by something other than its own turn while that turn was alive`} can't be read (boot ${c.boot}, compile line ${c.seq})`;

const crossCompile = ([first, ...rest]: CrossCompile[]) => `${first.lacks !== undefined ? unjudgedCompile(first) : first.by !== null
  ? `a dry compile rests on two agents' timing: ${first.by}'s tool call compiled ${first.agent ?? 'an unnamed agent'}'s context (boot ${first.boot}, compile line ${first.seq}), and its line goes on ${first.agent ?? 'that agent'}'s chain`
  : `a dry compile rests on timing: something other than ${first.agent}'s own turn compiled its context while that turn was alive (boot ${first.boot}, compile line ${first.seq})`}${rest.length === 0 ? '' : `; ${rest.length} more such compile${rest.length === 1 ? ' does' : 's do'} too`}${first.lacks === undefined ? '' : `. To measure this run, the tree needs an agent-framework that has \`${first.lacks}\`, as \`main\`'s does`}`;

const tiedByArrival = ([[a, b], ...rest]: Array<[string, string]>) => `a record's numbering rests on arrival: requests ${a} and ${b} share a name, their bodies differ, and nothing but their arrival orders them${rest.length === 0 ? '' : `; ${rest.length} more pair${rest.length === 1 ? ' does' : 's do'} too`}`;

const alongIn = (place: (id: string) => number) => (found: ReadonlyArray<{ request: string; with: string }>) => {
  const pairs = new Map<string, [string, string]>();
  for (const f of found) {
    const pair = [f.request, f.with].sort((a, b) => place(a) - place(b) || (a < b ? -1 : a > b ? 1 : 0)) as [string, string];
    pairs.set(pair.join('\u0000'), pair);
  }
  return [...pairs.values()].sort((a, b) => place(a[0]) - place(b[0]) || place(a[1]) - place(b[1]));
};

const arrivalPairs = ({ unordered, tied, log }: { unordered: UnorderedUse[]; tied: TiedPair[]; log: LogEntry[] }) => {
  const along = alongIn(recordPlace(log));
  const pairs = along(unordered);
  const sameName = along(tied);
  return [
    ...(pairs.length ? [requestNames(log).named(unorderedCache(pairs))] : []),
    ...(sameName.length ? [requestNames(log).named(tiedByArrival(sameName))] : []),
  ];
};

const unorderedIn = (records: readonly RequestRecord[]) => records.flatMap((r) => (r.unordered ?? []).map((u) => ({ request: r.id, ...u })));
const tiedIn = (records: readonly RequestRecord[]) => records.flatMap((r) => (r.tied ?? []).map((w) => ({ request: r.id, with: w })));

export const buildRestsOnArrival = (records: readonly RequestRecord[], log: LogEntry[]) => arrivalPairs({ unordered: unorderedIn(records), tied: tiedIn(records), log });

export const unmeasuredOf = (report: Report, { completed, untraced = [], unordered = [], tied = [], crossed = [], log = [] }: { completed: boolean; untraced?: UntracedToken[]; unordered?: UnorderedUse[]; tied?: TiedPair[]; crossed?: CrossCompile[]; log?: LogEntry[] }) => {
  const place = recordPlace(log);
  const traced = untraced.map((u) => ({ ...u, givenBy: [...u.givenBy].sort((a, b) => place(a) - place(b)) })).sort((a, b) => place(a.request) - place(b.request));
  return [...new Set([
    ...(completed ? [] : ['the run failed']),
    ...(traced.length ? [requestNames(log).named(brokenTrace(traced))] : []),
    ...arrivalPairs({ unordered, tied, log }),
    ...(crossed.length ? [crossCompile(crossed)] : []),
    ...(report.invalid.length ? ['its folds were clamped (check 10)'] : []),
    ...report.flags.filter((f) => (f.what as string | undefined)?.startsWith('judged-none:')).map((f) => `check ${f.check} (${(f.what as string).slice('judged-none:'.length)}) judged nothing`),
    ...(completed ? report.judged.filter((j) => j.check === 14 && j.judged === 0).map(() => 'check 14 (property) judged nothing') : []),
  ])];
};

export const unmeasuredOfRun = (report: Report, { completed, records, log }: { completed: boolean; records: readonly RequestRecord[]; log: LogEntry[] }) => unmeasuredOf(report, {
  completed,
  untraced: records.flatMap((r) => (r.untraced ?? []).map((u) => ({ request: r.id, ...u }))),
  unordered: unorderedIn(records),
  tied: tiedIn(records),
  crossed: (log as Array<{ kind: string; boot?: number; lines?: Array<{ by?: string; alive?: boolean; lacks?: string; agent: string | null; seq: number }> }>).flatMap((e) => (e.kind === 'compiles' ? (e.lines ?? []).filter((l) => typeof l.by === 'string' || l.alive === true || typeof l.lacks === 'string').map((l) => ({ by: l.by ?? null, agent: l.agent, boot: Number(e.boot), seq: l.seq, ...(typeof l.lacks === 'string' ? { lacks: l.lacks } : {}) })) : [])),
  log,
});

export function workloadReport({ id, workload, owns = [], judged, breaches, completed, contextUnread = null }: { id: string; workload: string; owns?: Owned[]; judged: Judgement; breaches: Breaches; completed: boolean; contextUnread?: string | null }) {
  const isOwned = (f: CheckFlag) => owns.some((o) => o.check === f.check && (o.what === undefined || o.what === f.what));
  const judgedFlags = judged.flags.filter((f) => !isOwned(f));
  const owned = judged.flags.length - judgedFlags.length;
  const flags = [...judgedFlags, ...breaches.map((b) => ({ check: 14, step: b.step ?? 'the run', ...(b.what ? { what: b.what } : {}), message: `${workload}'s property: ${b.message}` }))];
  const by = breaches.judgedBy;
  const byCounts = (judged.judged ?? []).filter((j): j is JudgedCount & { judged: number } => j.check === by && typeof j.judged === 'number');
  const count = typeof breaches.judged === 'number' ? breaches.judged : byCounts.length ? byCounts.reduce((n, j) => n + j.judged, 0) : null;
  const counts = [...(judged.judged ?? []), ...(count === null ? [] : [{ check: 14, name: 'property', judged: count, ...(by !== undefined ? { besides: `judged by check ${by}` } : breaches.besides ? { besides: breaches.besides } : {}) }])];
  if (completed && !breaches.length && !(count! > 0)) {
    const why = by !== undefined ? `is judged by check ${by}, which ${count === null ? 'gave no count' : 'judged nothing'}` : count === null ? 'gave no judged count and names no check that judges it' : 'judged nothing';
    flags.push({ check: 14, step: 'the run', what: 'judged-none:property', message: `couldn't judge: ${workload}'s property ${why}, though the run completed` });
  }
  const notes = [...(judged.notes ?? []), ...(owned ? [`${owned} flag(s) are ${workload}'s by design, judged by its property (runOf owns)`] : []),
    ...(contextUnread ? [`the run gives no context figures, since ${contextUnread}`] : [])];
  return perCheckReport({ configuration: { name: id }, candidate: { flags, missing: judged.missing ?? [], notes, headroom: judged.headroom, judged: counts } });
}

export function summaryNamer(store: Store | null | undefined) {
  const canary = new Map((store?.messages ?? []).map((m) => [String(m.id), m.nameCanary]));
  const nameOf = messageNames((store?.messages ?? []).map((m) => m.id), (id) => canary.get(String(id)));
  const sums = new Map((store?.summaries ?? []).map((s) => [s.id, s]));
  const leaves = (s: StoreSummary | undefined, seen = new Set<string>()): string[] => {
    if (!s || seen.has(s.id)) return [];
    seen.add(s.id);
    return s.sourceLevel === 0 ? s.sourceIds : s.sourceIds.flatMap((id) => leaves(sums.get(id), seen));
  };
  return (s: StoreSummary) => {
    const ids = leaves(s);
    return ids.length ? spanName(`L${s.level}`, nameOf(ids[0]) ?? `#${ids[0]}`, nameOf(ids.at(-1)) ?? `#${ids.at(-1)}`) : `L${s.level}(-)`;
  };
}
