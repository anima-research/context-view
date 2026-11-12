import type { ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cutError } from '../cut/interfaces.ts';
import { FORK_PREFIX, spawnName } from './checks.ts';
import type { Boot, HostEvent, Traced } from './driver.ts';
import type { HeldReadout, Ticks } from './module.ts';
import type { Call, Pushed, Step } from './script.ts';

type MaintainedAgent = {
  agentName?: unknown;
  ready?: unknown;
  pending?: unknown;
  progress?: { pending?: unknown; chunksCompressed?: unknown; summaryCounts?: unknown; l1QueueLength?: unknown; mergeQueueLength?: unknown; [field: string]: unknown } | null;
  [field: string]: unknown;
};
type MaintainAnswer = {
  ok?: unknown;
  maintenance?: { agents?: unknown; [field: string]: unknown } | null;
  hostMode?: { drained?: unknown; deferredWrites?: unknown; gatedRequests?: unknown; parkedAdmissions?: unknown; activeTurnAgents?: unknown; [field: string]: unknown } | null;
  [field: string]: unknown;
};
type WakeCall = Call & { input: { tool: 'wake_add_rule' | 'wake_remove_rule' } };
export type ReaderStep = Step & { reader: NonNullable<Step['reader']> };

// connectome-host mounts the session's config directory as `_config` where the recipe's workspace sets configMount
// (workspace-mounts.ts buildWorkspaceMounts), and agent-framework's workspace watcher reports a change to a watched
// mount's file as a `workspace:modified` (or `workspace:created`, for a new file) once chokidar's awaitWriteFinish has
// settled it, which waits on `new Date()`, and the watcher's 300 ms debounce, a real-time timer, has passed
// (modules/workspace/watcher.ts).
export function configWriteEcho(events: HostEvent[]) {
  let at = -1;
  let file = null as string | null;
  events.forEach((e, i) => {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') { at = i; file = e.configPath; }
  });
  if (at < 0) return { wrote: false };
  const path = `_config/${basename(file!)}`;
  const echoed = events.slice(at + 1).some((e) => echoDone(e, path));
  return { wrote: true, at, file, path, echoed };
}

export const echoDone = (e: HostEvent, path: string) => e.type === 'process:completed' && (e.processEvent?.type === 'workspace:modified' || e.processEvent?.type === 'workspace:created') && ((e.processEvent.paths ?? []) as string[]).includes(path);

const isConfigEcho = (e: HostEvent): e is HostEvent & { processEvent: { type: string; paths: string[] } } => e.type === 'process:received' && /^workspace:(created|modified|deleted)$/.test((e.processEvent?.type ?? '') as string) && ((e.processEvent!.paths ?? []) as string[]).some((p) => p.startsWith('_config/'));

export function unowedConfigEchoes(events: HostEvent[], owed: string[] = []) {
  const owing = new Map<string, number>();
  const owe = (p: string) => owing.set(p, (owing.get(p) ?? 0) + 1);
  owed.forEach(owe);
  const out: string[] = [];
  for (const e of events) {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') owe(`_config/${basename(e.configPath)}`);
    else if (isConfigEcho(e)) {
      for (const p of e.processEvent.paths) {
        if (!p.startsWith('_config/')) continue;
        if (e.processEvent.type !== 'workspace:deleted' && (owing.get(p) as number) > 0) owing.set(p, owing.get(p)! - 1);
        else out.push(`${p} (${e.processEvent.type})`);
      }
    }
  }
  return out;
}

export function echoWindows({ host, stepHost = host }: { host: Boot | null; stepHost?: Boot | null }) {
  const windows = [];
  if (stepHost && stepHost !== host) windows.push({ host: stepHost, from: stepHost.judged ?? 0 });
  if (host) windows.push({ host, from: host.judged ?? 0 });
  return windows;
}

export const movedSinceJudged = (host: Boot) => (host.moves ?? 0) > (host.judgedMoves ?? 0);

function includedNames(include: string[]) {
  const patterns = include.filter((name) => /[*?[\]{}]/.test(name) || name.includes('/'));
  if (patterns.length) throw new Error(`couldn't tell which files the _config mount watches: its include names ${patterns.join(', ')}, a pattern the driver doesn't read`);
  return include;
}

export function bootEchoesOwed(listing: string[], include: string[]) {
  const names = includedNames(include);
  return listing.filter((name) => names.includes(name)).sort().map((name) => `_config/${name}`);
}

export const echoOwed = (file: string, include: string[]) => includedNames(include).includes(basename(file));

export async function lastTake({ boot, take, log, fail, step = null }: {
  boot: number;
  take: () => Promise<unknown>;
  log: (kind: 'compiles', fields: { boot: number; lost: string }) => void;
  fail: (failure: { step: string | null; reason: string; full?: string }) => void;
  step?: string | null;
}) {
  await take().catch((e) => {
    log('compiles', { boot, lost: String(e?.message ?? e) });
    const { shown, full } = cutError(e, 500);
    const said = `boot ${boot}'s last take of the module's compiles failed: `;
    fail({ step, reason: `${said}${shown}`, ...(full ? { full: `${said}${full}` } : {}) });
  });
}

export function shutdownFailure({ boot, timedOut, exited, seconds }: { boot: number; timedOut: boolean; exited: Boot['exited']; seconds: number }) {
  if (timedOut) return `boot ${boot}: the host didn't exit within ${seconds} s of its shutdown`;
  if (exited && (exited.code !== 0 || exited.signal)) return `boot ${boot}: the host exited (${exited.code ?? exited.signal}) on its shutdown`;
  return null;
}

export const exitWithin = (child: ChildProcess, ms: number, reach: Boot['reach'] | null = null) => new Promise<boolean>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const started = performance.now();
  const readBefore = reach?.readMs() ?? 0;
  const left = () => ms - (performance.now() - started) + ((reach?.readMs() ?? 0) - readBefore);
  let timer = null as ReturnType<typeof setTimeout> | null;
  let exited = false;
  const wait = () => {
    timer = setTimeout(async () => {
      await reach?.reading;
      if (exited) return;
      if (left() > 0) wait();
      else resolve(false);
    }, Math.max(0, left()));
  };
  child.once('exit', () => { exited = true; clearTimeout(timer!); resolve(true); });
  wait();
});

export const readerTurn = (reader: NonNullable<Step['reader']>, name: unknown) => (reader.prefix ? typeof name === 'string' && name.startsWith(reader.prefix) : name === reader.name);
export const readerStarts = (step: ReaderStep) => (e: HostEvent) => readerTurn(step.reader, e.agentName) && e.type === 'inference:started';
export const readerEnds = (step: ReaderStep, resident: string) => (e: HostEvent) => (readerTurn(step.reader, e.agentName) || ((step.replies ?? []).length > 0 && e.agentName === resident)) && /^inference:(exhausted|aborted)$/.test(e.type as string);

export const awaitedAfter = (events: Traced[], ended: Traced, awaits: NonNullable<Step['awaits']>) => events.slice(events.indexOf(ended) + 1)
  .find(({ e }) => e.agentName === ended.e.agentName && awaits.events.some((a) => e.type === a.type && (a.kind === undefined || e.kind === a.kind)));

export const readerFailureAllowed = (step: ReaderStep, e: HostEvent) => step.mayFail === true && readerTurn(step.reader, e.agentName);

export const tunedOutAuthors = (steps: Step[]) => [...new Map(steps.flatMap((s) => (s.tunedOut ?? []).map((c): [string, unknown] => [c, typeof s.text === 'string' && s.text.includes(c) ? s.participant ?? null : (s.messages ?? []).find((m) => typeof m.text === 'string' && m.text.includes(c))?.participant ?? null]))).entries()];

export function budgetReportDone(lines: string[], agent: string, { prefix = false }: { prefix?: boolean } = {}) {
  return lines.some((l) => l.startsWith(prefix ? `  ${agent}` : `  ${agent}: `) || !(l === BUDGET_HEADER || /^ {2}\S/.test(l)));
}
const BUDGET_HEADER = '--- Stream Token Budgets ---';

export function addedRules(steps: Step[], step: Step) {
  return steps.slice(0, steps.indexOf(step)).flatMap((s) => (s.replies ?? []).flatMap((r) => (r.calls ?? []) as Call[])).filter((c): c is WakeCall => c.name === 'toolsets--act' && (['wake_add_rule', 'wake_remove_rule'] as unknown[]).includes(c.input?.tool))
    .map((c) => (c.input.tool === 'wake_remove_rule' ? { name: (c.input.args as { name?: unknown } | undefined)?.name, removed: true } : c.input.args));
}

// connectome-host names a task fork `<name>-d<depth>-<stamp>`, or `<name>-d<depth>-retry<n>-<stamp>` on a retry
// (subagent-module.ts, the fork's attempt loop).
const forkName = (agent: unknown) => /^(.+)-d\d+(?:-retry\d+)?-\d+$/.exec(String(agent))?.[1] ?? null;

export function subagentResult(events: Traced[], child: string | { prefix: string }, since: number) {
  const after = events.slice(since);
  const readers = typeof child === 'string' ? [] : after.flatMap(({ e }) => (e.type === 'dendrite:agent-created' && typeof e.agentName === 'string' && e.agentName.startsWith(child.prefix) ? [e.agentName] : []));
  if (readers.length > 1) return `${readers.length} reader forks (${readers.join(', ')}) were created in the step, so its hold can't tell which one's result it waits for`;
  const from = (agent: unknown) => (typeof child === 'string' ? (spawnName(agent) ?? forkName(agent)) === child : readers.length === 1 && agent === readers[0]);
  return after.find(({ e }) => e.type === 'dendrite:mail-delivered' && e.kind === 'result' && from(e.from));
}

// connectome-host's headless sends `inference:speech` for its primary agent only (headless.ts `idleTrace`), so a fork of
// `conversations` speaks with none. The driver derives one as headless does: a fork's round that completed after
// tokens, with no tool calls yielded since it started.
export function forkSpeech() {
  const speech = new Map<string, string>();
  return (e: HostEvent) => {
    const agent = e?.agentName;
    if (typeof agent !== 'string' || !agent.startsWith(FORK_PREFIX)) return null;
    if (e.type === 'inference:started' || e.type === 'inference:tool_calls_yielded') speech.set(agent, '');
    else if (e.type === 'inference:tokens' && e.content) speech.set(agent, `${speech.get(agent) ?? ''}${e.content}`);
    else if (e.type === 'inference:completed') {
      const content = speech.get(agent) ?? '';
      speech.set(agent, '');
      if (content) return { type: 'inference:speech', agentName: agent, content, derived: 'fork' };
    }
    return null;
  };
}

// connectome-host#555 on, headless sends `inference:speech` with `""` for a round that ended without tool calls and held
// no text, where a host before it sent nothing (headless.ts, docs/fleet-protocol.md). Such a frame isn't speech.
export function spoke(e: HostEvent) {
  return e.type === 'inference:speech' && e.content !== '';
}

export function gateSpeeches(events: Traced[], from: number) {
  return events.slice(from).filter(({ e }) => spoke(e));
}

export function endsSpeechWait(step: Step, e: HostEvent, ending: RegExp) {
  return (step.ends === 'contained' ? e.type === 'inference:speech' : spoke(e)) || ending.test(e.type as string);
}

// connectome-host's headless mode traces the primary agent's speech as `inference:speech` once its round completes
// (headless.ts). agent-framework then ends it one of four ways, the same at 0.32.0 and 0.33.0: published to a channel,
// refused a route (whose trace names the agent as its conversationId), held as drafts, or kept private or unrouted, which
// only the turn's `[delivered]` receipt says (framework.ts appendProseDeliveryReceipt). A turn whose trigger suppresses
// its prose starts silent and ends none of those ways, and speech of whitespace alone, or an explicit turn's private
// envelope, ends none at all. The receipt's trace (`message:added` from `delivery-receipt`) names no agent, the same on
// agent-framework's main. At agent-framework#190's head a private turn's bounced words, under explicit and hybrid routing,
// hold no draft and write no receipt, only the bounce notice (`message:added` from `prose-bounce`), which names no agent
// either and ends the wait as a receipt does; where a bounce holds drafts, as at main, it holds them before it writes the
// notice.
export function speechEnd(events: Traced[], at: number) {
  const agent = events[at].e.agentName;
  const alive = new Set<unknown>();
  const others = new Set<unknown>();
  const live = (e: HostEvent, i: number) => {
    if (e.type === 'inference:started') alive.add(e.agentName);
    else if (/^inference:(completed|aborted|exhausted)$/.test(e.type as string)) alive.delete(e.agentName);
    if (i >= at) for (const a of alive) if (a !== agent) others.add(a);
  };
  for (let i = 0; i <= at; i++) live(events[i].e, i);
  for (let i = at - 1; i >= 0; i--) {
    const { e } = events[i];
    if (e.type !== 'inference:started' || e.agentName !== agent) continue;
    if (e.silent === true) return { how: 'silent' };
    break;
  }
  for (let i = at + 1; i < events.length; i++) {
    const { e } = events[i];
    live(e, i);
    if (e.type === 'inference:published_complete' && e.agentName === agent) return { how: 'published' };
    if (e.type === 'mcpl:speech-route-failed' && e.conversationId === agent) return { how: 'undelivered', reason: e.reason ?? null };
    if (e.type === 'prose:drafts-held' && e.agentName === agent) return { how: 'held', reason: e.reason ?? null };
    const of = e.type === 'message:added' ? ({ 'delivery-receipt': 'receipt', 'prose-bounce': 'bounced' } as Partial<Record<string, 'receipt' | 'bounced'>>)[e.source as string] : undefined;
    if (of) return others.size ? { how: 'unsure', of, agents: [...others] } : { how: of };
  }
  return null;
}

export function maintainedAgents(answer: MaintainAnswer | null | undefined, agent: string): { unreadable: string; agents?: undefined } | { agents: MaintainedAgent[]; unreadable?: undefined } {
  const agents = answer?.maintenance?.agents;
  if (!Array.isArray(agents)) return { unreadable: 'holds no list of agents' };
  if (!agents.some((a) => a?.agentName === agent)) return { unreadable: `lists no agent named ${JSON.stringify(agent)}` };
  return { agents };
}

export interface SettleSnapshot { ticks: Ticks; agents: unknown[] | null; hostMode: Record<string, unknown> | null; unread?: string }

export const snapshotOver = (answer: MaintainAnswer | null | undefined, snap: SettleSnapshot | null | undefined): MaintainAnswer | null => (snap?.agents && snap.hostMode
  ? { ...(answer ?? {}), maintenance: { ...(answer?.maintenance ?? {}), agents: snap.agents }, hostMode: snap.hostMode } as MaintainAnswer
  : null);

const workIn = (agents: MaintainedAgent[], host: Record<string, unknown>) => agents.some((a) => a.progress?.pending === true) || ((host.activeTurnAgents ?? []) as unknown[]).length > 0 || ((host.parkedAdmissions ?? 0) as number) > 0 || ((host.gatedRequests ?? 0) as number) > 0;

const settleReading = (agents: MaintainedAgent[], host: Record<string, unknown>, ticking: string[]) => ({
  agents: agents.map((a) => {
    const p = a.progress ?? {};
    return [a.agentName, a.ready, p.chunksCompressed, p.summaryCounts, p.l1QueueLength, p.mergeQueueLength, a.pending];
  }),
  ready: agents.every((a) => a.ready === true),
  deferredWrites: host.deferredWrites,
  drained: host.drained,
  gatedRequests: host.gatedRequests,
  parkedAdmissions: host.parkedAdmissions ?? 0,
  ticking,
});

// context-manager's autobiographical strategy names a paused compression lane only in its readiness description, which
// agent-framework hands on as the agent's `pending`: "; compression paused until <ISO> (", or the form below for a wait
// that can't be held as an instant (autobiographical.ts checkReadiness and pauseUntilText; CHECKS.md names the releases
// read).
const PAUSE_WORD = /\bpaused\b/i;
const PAUSED_UNTIL = '; compression paused until ';
const NO_END = 'a restart, a change of model, or an explicit release (';
const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \(/;
const iso = (ms: number) => new Date(ms).toISOString();

export type LanePause = { until: number } | { noEnd: true } | { unread: true } | null;

export function lanePause(pending: unknown): LanePause {
  if (typeof pending !== 'string' || !PAUSE_WORD.test(pending)) return null;
  const at = pending.indexOf(PAUSED_UNTIL);
  if (at < 0) return { unread: true };
  const rest = pending.slice(at + PAUSED_UNTIL.length);
  if (rest.startsWith(NO_END)) return { noEnd: true };
  const instant = INSTANT.exec(rest)?.[1];
  const until = instant === undefined ? NaN : Date.parse(instant);
  return Number.isFinite(until) && iso(until) === instant ? { until } : { unread: true };
}

export function pauseHolds(a: MaintainedAgent, clock: number, ticked: ReadonlySet<unknown>): { until: number } | { why: string } | null {
  if (a.ready === true) return null;
  const pause = lanePause(a.pending);
  if (pause === null) return null;
  if ('unread' in pause) return { why: 'it names a pause in words the harness doesn\'t read' };
  if ('noEnd' in pause) return { why: 'its pause has no end on the clock' };
  if (pause.until <= clock) return { why: `its pause ended at ${iso(pause.until)}, and the clock reads ${iso(clock)}` };
  if (a.progress?.pending === true) return { why: 'a compression call is in flight' };
  if (!ticked.has(a.agentName)) return { why: 'the maintenance pass before the snapshot didn\'t tick it' };
  return { until: pause.until };
}

export function notRestingText(a: MaintainedAgent, clock: number, ticked: ReadonlySet<unknown>) {
  const said = `${a.error ?? a.pending ?? 'no pending work named'}`;
  const held = pauseHolds(a, clock, ticked);
  return held && 'why' in held ? `${said}; not a wait the clock ends: ${held.why}` : said;
}

type MaintainRun = { id?: unknown; agents?: unknown };

function tickedBy(worked: MaintainAnswer | null | undefined, seen: unknown) {
  const history = worked?.maintenance?.history;
  const newest = (Array.isArray(history) ? history[0] : undefined) as MaintainRun | undefined;
  const run = newest?.id ?? seen;
  if (newest?.id === undefined || newest.id === seen || !Array.isArray(newest.agents)) return { ticked: new Set<unknown>(), run };
  const by = (newest.agents as Array<{ agentName?: unknown; ticks?: unknown } | null>).filter((r) => typeof r?.ticks === 'number' && r.ticks >= 1).map((r) => r!.agentName);
  return { ticked: new Set<unknown>(by), run };
}

export type PauseClock = { clock: number; seen: unknown };

export function readSettle(answer: MaintainAnswer | null | undefined, previous: string | null, ticks: Ticks = {}, agent: string, worked: MaintainAnswer | null | undefined = answer, at: PauseClock | null = null) {
  const listed = maintainedAgents(answer, agent);
  const pass = at ? tickedBy(worked, at.seen) : { ticked: new Set<unknown>(), run: undefined };
  if (answer?.ok === true && listed.unreadable !== undefined) return { unreadable: listed.unreadable, ticking: [], settled: false, inFlight: false, moved: false, progress: previous, paused: [], ticked: pass.ticked, run: pass.run };
  const agents = listed.agents ?? [];
  const did = worked === answer ? agents : maintainedAgents(worked, agent).agents ?? [];
  const host = answer?.hostMode ?? {};
  const ticking = Object.entries(ticks).filter(([, n]) => n !== 0).map(([name, n]) => `${name} ${n}`);
  const seen = settleReading(agents, host, ticking);
  const progress = JSON.stringify({ worked: settleReading(did, worked?.hostMode ?? {}, []), seen });
  const paused = at ? agents.flatMap((a) => {
    const held = pauseHolds(a, at.clock, pass.ticked);
    return held && 'until' in held ? [{ agent: a.agentName, until: held.until }] : [];
  }) : [];
  const atRest = agents.every((a) => a.ready === true || paused.some((p) => p.agent === a.agentName));
  const rest = answer?.ok === true && atRest && seen.deferredWrites === 0 && !seen.ticking.length;
  return {
    ticking,
    settled: rest && seen.drained === true && seen.gatedRequests === 0,
    waits: rest && (seen.drained === false || (seen.gatedRequests as number) > 0) && seen.parkedAdmissions === 0,
    inFlight: workIn(did, worked?.hostMode ?? {}) || workIn(agents, host) || ticking.length > 0,
    moved: progress !== previous,
    progress,
    paused,
    ticked: pass.ticked,
    run: pass.run,
  };
}

export function compressionIdleOver(answer: MaintainAnswer | null | undefined, ticks: Ticks, agent: string, worked: MaintainAnswer | null | undefined, at: PauseClock) {
  const read = readSettle(answer, null, ticks, agent, worked, at);
  const agents = maintainedAgents(answer, agent).agents ?? [];
  const idleAgent = (a: MaintainedAgent) => (a.ready === true && a.progress?.pending !== true) || read.paused.some((p) => p.agent === a.agentName);
  const busy = agents.filter((a) => !idleAgent(a)).map((a) => `${a.agentName} (${notRestingText(a, at.clock, read.ticked)})`);
  return { idle: answer?.ok === true && !busy.length && !read.ticking.length, run: read.run, why: busy.join(', ') };
}

export function pauseNotes(paused: Array<{ agent: unknown; until: number }>, seen: Set<string>, clock: number) {
  return paused.filter((p) => {
    const key = `${p.agent}@${p.until}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((p) => ({ agent: p.agent, until: p.until, ms: p.until - clock }));
}

export const givesUp = (read: { inFlight: boolean; moved: boolean }) => !read.inFlight && !read.moved;

export function heldRefusal(holds: Array<{ agent: unknown; until: number }>, needs: string | null) {
  if (!needs) return null;
  return `a provider hold keeps ${holds.map((h) => `${h.agent} waiting until ${new Date(h.until).toISOString()}`).join(' and ')}, where ${needs} needs the host drained`;
}

export function heldTurns(answer: MaintainAnswer | null | undefined, readout: HeldReadout | null | undefined, clock: number, due: Set<number> | null = null) {
  if (readout?.why) return { why: `the held readout: ${readout.why}` };
  const alive = (answer?.hostMode?.activeTurnAgents ?? []) as unknown[];
  const gated = answer?.hostMode?.gatedRequests;
  if (typeof gated !== 'number') return { why: 'no count of gated requests in the host\'s answer' };
  if (!alive.length && !gated) return { why: 'no turn is alive and no wake waits' };
  const why = [];
  if (readout?.pendingRequests !== 0) why.push(`${readout?.pendingRequests} request(s) pending outside any hold`);
  if (((readout?.activeStreams ?? []) as unknown[]).length) why.push(`a stream open (${(readout!.activeStreams as unknown[]).join(', ')})`);
  const holding = (readout?.agents ?? []).filter((x) => (x.heldRequests as number) >= 1).map((x) => x.name);
  if (gated && !holding.length) why.push(`${gated} wake(s) waiting outside any hold`);
  for (const x of readout?.agents ?? []) if (x.budgetHold) why.push(`${x.name} waits in a budget hold, which no move of the clock ends`);
  const holds = [];
  for (const name of [...new Set([...alive, ...holding])]) {
    const a = (readout?.agents ?? []).find((x) => x.name === name);
    if (!a) { why.push(`the readout lists no agent ${name}`); continue; }
    if (a.status !== 'idle') why.push(`${name} is ${a.status}`);
    else if (a.primaryActive) why.push(`${name} is starting a turn`);
    else if (a.auxiliaryInFlight !== 0) why.push(`${name} has ${a.auxiliaryInFlight} auxiliary call(s) in flight`);
    else if (!((a.heldRequests as number) >= 1)) why.push(`${name} has no request held`);
    else if (typeof a.cooldownUntil !== 'number') why.push(`${name}'s hold has no end on the clock`);
    else if (a.cooldownUntil <= clock) why.push(`${name}'s hold ended at ${a.cooldownUntil}, and the clock reads ${clock}`);
    else if (due && !due.has(a.cooldownUntil)) why.push(`${name}'s hold ends at ${a.cooldownUntil} on a timer the workload's clock doesn't run`);
    else holds.push({ agent: name, until: a.cooldownUntil });
  }
  return why.length ? { why: why.join('; ') } : { holds };
}

export const heldCalls = (step: Step) => [...(step.subs ?? []).flatMap((s) => s.replies ?? []), ...(step.replies ?? [])].flatMap((r) => (Array.isArray(r.calls) ? r.calls : [])).filter((c) => c.during).map((c) => ({ canary: c.input!.canary, during: c.during! }));
export const actsOf = (step: Step) => [...heldCalls(step).flatMap((h) => h.during), ...(step.replies ?? []).flatMap((r) => r.during ?? []), ...(step.summariserHold?.during ?? [])];

export const authorId = (participant: unknown) => `u-${String(participant).toLowerCase()}`;

export const pushEvent = ({ id, channel, participant, tags, text }: Pushed, clock: number) => ({
  eventId: id,
  timestamp: new Date(clock).toISOString(),
  origin: { source: 'fixture', mcplChannelId: channel, channelId: channel, channelName: channel, messageId: id, authorId: authorId(participant), authorName: participant },
  ...(tags ? { tags } : {}),
  payload: { content: [{ type: 'text', text }] },
});

export function pushStored(events: Traced[], from: number, id: string) {
  const admitted = events.findIndex(({ e }, i) => i >= from && e.type === 'admission:decided' && e.messageId === id);
  return admitted >= 0 && events.slice(admitted).some(({ e }) => e.type === 'message:added' && e.source === 'mcpl:push-event');
}

export const budgetHeldAt = (events: Traced[], from: number, agent: string) => events.slice(from).find(({ e }) => e.type === 'inference:held' && e.agentName === agent)?.at;
export const budgetHeld = (events: Traced[], from: number, agent: string) => events.slice(from).some(({ e }) => e.type === 'inference:held' && e.agentName === agent);
export const lateBudgetHold = (stepId: string, agent: string, gapMs: number) =>
  `step ${stepId}: the host held ${agent}'s turn for budget only after the summariser request held for it, so the hold's acts were skipped; the driver received the hold ${Math.round(gapMs)} ms after it checked for it`;
