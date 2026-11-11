// @ts-nocheck
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cutError } from '../cut/interfaces.ts';
import { FORK_PREFIX, spawnName } from './checks.ts';

// connectome-host mounts the session's config directory as `_config` where the recipe's workspace sets configMount
// (workspace-mounts.ts buildWorkspaceMounts), and agent-framework's workspace watcher reports a change to a watched
// mount's file as a `workspace:modified` (or `workspace:created`, for a new file) once chokidar's awaitWriteFinish has
// settled it, which waits on `new Date()`, and the watcher's 300 ms debounce, a real-time timer, has passed
// (modules/workspace/watcher.ts).
export function configWriteEcho(events) {
  let at = -1;
  let file = null;
  events.forEach((e, i) => {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') { at = i; file = e.configPath; }
  });
  if (at < 0) return { wrote: false };
  const path = `_config/${basename(file)}`;
  const echoed = events.slice(at + 1).some((e) => echoDone(e, path));
  return { wrote: true, at, file, path, echoed };
}

export const echoDone = (e, path) => e.type === 'process:completed' && (e.processEvent?.type === 'workspace:modified' || e.processEvent?.type === 'workspace:created') && (e.processEvent.paths ?? []).includes(path);

const isConfigEcho = (e) => e.type === 'process:received' && /^workspace:(created|modified|deleted)$/.test(e.processEvent?.type ?? '') && (e.processEvent.paths ?? []).some((p) => p.startsWith('_config/'));

export function unowedConfigEchoes(events, owed = []) {
  const owing = new Map();
  const owe = (p) => owing.set(p, (owing.get(p) ?? 0) + 1);
  owed.forEach(owe);
  const out = [];
  for (const e of events) {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') owe(`_config/${basename(e.configPath)}`);
    else if (isConfigEcho(e)) {
      for (const p of e.processEvent.paths) {
        if (!p.startsWith('_config/')) continue;
        if (e.processEvent.type !== 'workspace:deleted' && owing.get(p) > 0) owing.set(p, owing.get(p) - 1);
        else out.push(`${p} (${e.processEvent.type})`);
      }
    }
  }
  return out;
}

export function echoWindows({ host, stepHost = host }) {
  const windows = [];
  if (stepHost && stepHost !== host) windows.push({ host: stepHost, from: stepHost.judged ?? 0 });
  if (host) windows.push({ host, from: host.judged ?? 0 });
  return windows;
}

export const movedSinceJudged = (host) => (host.moves ?? 0) > (host.judgedMoves ?? 0);

function includedNames(include) {
  const patterns = include.filter((name) => /[*?[\]{}]/.test(name) || name.includes('/'));
  if (patterns.length) throw new Error(`couldn't tell which files the _config mount watches: its include names ${patterns.join(', ')}, a pattern the driver doesn't read`);
  return include;
}

export function bootEchoesOwed(listing, include) {
  const names = includedNames(include);
  return listing.filter((name) => names.includes(name)).sort().map((name) => `_config/${name}`);
}

export const echoOwed = (file, include) => includedNames(include).includes(basename(file));

export async function lastTake({ boot, take, log, fail, step = null }) {
  await take().catch((e) => {
    log('compiles', { boot, lost: String(e?.message ?? e) });
    const { shown, full } = cutError(e, 500);
    const said = `boot ${boot}'s last take of the module's compiles failed: `;
    fail({ step, reason: `${said}${shown}`, ...(full ? { full: `${said}${full}` } : {}) });
  });
}

export function shutdownFailure({ boot, timedOut, exited, seconds }) {
  if (timedOut) return `boot ${boot}: the host didn't exit within ${seconds} s of its shutdown`;
  if (exited && (exited.code !== 0 || exited.signal)) return `boot ${boot}: the host exited (${exited.code ?? exited.signal}) on its shutdown`;
  return null;
}

/** Whether the host exits within `ms`, not counting the time a profiled host's read where it exits takes. */
export const exitWithin = (child, ms, reach = null) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const started = performance.now();
  const readBefore = reach?.readMs() ?? 0;
  const left = () => ms - (performance.now() - started) + ((reach?.readMs() ?? 0) - readBefore);
  let timer = null;
  let exited = false;
  const wait = () => {
    timer = setTimeout(async () => {
      await reach?.reading;
      if (exited) return;
      if (left() > 0) wait();
      else resolve(false);
    }, Math.max(0, left()));
  };
  child.once('exit', () => { exited = true; clearTimeout(timer); resolve(true); });
  wait();
});

// A step's reader is a persistent reader by name, or reader forks by the prefix their names share.
export const readerTurn = (reader, name) => (reader.prefix ? typeof name === 'string' && name.startsWith(reader.prefix) : name === reader.name);
export const readerStarts = (step) => (e) => readerTurn(step.reader, e.agentName) && e.type === 'inference:started';
// A step that scripts the resident a turn, as a fork's summary wakes it, fails on that turn's end too.
export const readerEnds = (step, resident) => (e) => (readerTurn(step.reader, e.agentName) || ((step.replies ?? []).length > 0 && e.agentName === resident)) && /^inference:(exhausted|aborted)$/.test(e.type);

/** The first event after the failed turn's end, of its agent, that a step's `awaits` names. */
export const awaitedAfter = (events, ended, awaits) => events.slice(events.indexOf(ended) + 1)
  .find(({ e }) => e.agentName === ended.e.agentName && awaits.events.some((a) => e.type === a.type && (a.kind === undefined || e.kind === a.kind)));

export const readerFailureAllowed = (step, e) => step.mayFail === true && readerTurn(step.reader, e.agentName);

// Each held message's canary, with the author the script sends it under.
export const tunedOutAuthors = (steps) => [...new Map(steps.flatMap((s) => (s.tunedOut ?? []).map((c) => [c, typeof s.text === 'string' && s.text.includes(c) ? s.participant ?? null : (s.messages ?? []).find((m) => typeof m.text === 'string' && m.text.includes(c))?.participant ?? null]))).entries()];

export function budgetReportDone(lines, agent, { prefix = false } = {}) {
  return lines.some((l) => l.startsWith(prefix ? `  ${agent}` : `  ${agent}: `) || !(l === BUDGET_HEADER || /^ {2}\S/.test(l)));
}
const BUDGET_HEADER = '--- Stream Token Budgets ---';

export function addedRules(steps, step) {
  return steps.slice(0, steps.indexOf(step)).flatMap((s) => (s.replies ?? []).flatMap((r) => r.calls ?? [])).filter((c) => c.name === 'toolsets--act' && ['wake_add_rule', 'wake_remove_rule'].includes(c.input?.tool))
    .map((c) => (c.input.tool === 'wake_remove_rule' ? { name: c.input.args?.name, removed: true } : c.input.args));
}

// connectome-host names a task fork `<name>-d<depth>-<stamp>`, or `<name>-d<depth>-retry<n>-<stamp>` on a retry
// (subagent-module.ts, the fork's attempt loop).
const forkName = (agent) => /^(.+)-d\d+(?:-retry\d+)?-\d+$/.exec(String(agent))?.[1] ?? null;

// The child is a subagent or task fork by the name the script launched it as, or, by its reader's prefix, the reader
// fork created since the step began, so a reader fork an earlier step started never answers for it. A step that creates
// more than one, as a wake or cadence look would beside a cancel's when a tuned-out channel gets traffic
// (tune-out/coordinator.ts), gives a reason instead of a result: the hold can't tell which one it waits for.
export function subagentResult(events, child, since) {
  const after = events.slice(since);
  const readers = typeof child === 'string' ? [] : after.flatMap(({ e }) => (e.type === 'dendrite:agent-created' && typeof e.agentName === 'string' && e.agentName.startsWith(child.prefix) ? [e.agentName] : []));
  if (readers.length > 1) return `${readers.length} reader forks (${readers.join(', ')}) were created in the step, so its hold can't tell which one's result it waits for`;
  const from = (agent) => (typeof child === 'string' ? (spawnName(agent) ?? forkName(agent)) === child : readers.length === 1 && agent === readers[0]);
  return after.find(({ e }) => e.type === 'dendrite:mail-delivered' && e.kind === 'result' && from(e.from));
}

// connectome-host's headless sends `inference:speech` for its primary agent only (headless.ts `idleTrace`), so a fork of
// `conversations` speaks with none. The driver derives one as headless does: a fork's round that completed after
// tokens, with no tool calls yielded since it started.
export function forkSpeech() {
  const speech = new Map();
  return (e) => {
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
export function spoke(e) {
  return e.type === 'inference:speech' && e.content !== '';
}

export function gateSpeeches(events, from) {
  return events.slice(from).filter(({ e }) => spoke(e));
}

export function endsSpeechWait(step, e, ending) {
  return (step.ends === 'contained' ? e.type === 'inference:speech' : spoke(e)) || ending.test(e.type);
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
export function speechEnd(events, at) {
  const agent = events[at].e.agentName;
  const alive = new Set();
  const others = new Set();
  const live = (e, i) => {
    if (e.type === 'inference:started') alive.add(e.agentName);
    else if (/^inference:(completed|aborted|exhausted)$/.test(e.type)) alive.delete(e.agentName);
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
    const of = e.type === 'message:added' ? { 'delivery-receipt': 'receipt', 'prose-bounce': 'bounced' }[e.source] : undefined;
    if (of) return others.size ? { how: 'unsure', of, agents: [...others] } : { how: of };
  }
  return null;
}

export function maintainedAgents(answer, agent) {
  const agents = answer?.maintenance?.agents;
  if (!Array.isArray(agents)) return { unreadable: 'holds no list of agents' };
  if (!agents.some((a) => a?.agentName === agent)) return { unreadable: `lists no agent named ${JSON.stringify(agent)}` };
  return { agents };
}

export function readSettle(answer, previous, ticks = {}, agent) {
  const listed = maintainedAgents(answer, agent);
  if (answer?.ok === true && listed.unreadable !== undefined) return { unreadable: listed.unreadable, ticking: [], settled: false, inFlight: false, moved: false, progress: previous };
  const agents = listed.agents ?? [];
  const host = answer?.hostMode ?? {};
  const progress = JSON.stringify({
    agents: agents.map((a) => {
      const p = a.progress ?? {};
      return [a.agentName, p.chunksCompressed, p.summaryCounts, p.l1QueueLength, p.mergeQueueLength, a.pending];
    }),
    deferredWrites: host.deferredWrites,
  });
  const ticking = Object.entries(ticks).filter(([, n]) => n !== 0).map(([name, n]) => `${name} ${n}`);
  const rest = answer?.ok === true && agents.every((a) => a.ready === true) && host.deferredWrites === 0 && !ticking.length;
  return {
    ticking,
    settled: rest && host.drained === true && host.gatedRequests === 0,
    waits: rest && (host.drained === false || host.gatedRequests > 0) && (host.parkedAdmissions ?? 0) === 0,
    inFlight: agents.some((a) => a.progress?.pending === true) || (host.activeTurnAgents ?? []).length > 0 || (host.parkedAdmissions ?? 0) > 0 || (host.gatedRequests ?? 0) > 0 || ticking.length > 0,
    moved: progress !== previous,
    progress,
  };
}

export function heldRefusal(holds, needs) {
  if (!needs) return null;
  return `a provider hold keeps ${holds.map((h) => `${h.agent} waiting until ${new Date(h.until).toISOString()}`).join(' and ')}, where ${needs} needs the host drained`;
}

export function heldTurns(answer, readout, clock, due = null) {
  if (readout?.why) return { why: `the held readout: ${readout.why}` };
  const alive = answer?.hostMode?.activeTurnAgents ?? [];
  const gated = answer?.hostMode?.gatedRequests;
  if (typeof gated !== 'number') return { why: 'no count of gated requests in the host\'s answer' };
  if (!alive.length && !gated) return { why: 'no turn is alive and no wake waits' };
  const why = [];
  if (readout?.pendingRequests !== 0) why.push(`${readout?.pendingRequests} request(s) pending outside any hold`);
  if ((readout?.activeStreams ?? []).length) why.push(`a stream open (${readout.activeStreams.join(', ')})`);
  const holding = (readout?.agents ?? []).filter((x) => x.heldRequests >= 1).map((x) => x.name);
  if (gated && !holding.length) why.push(`${gated} wake(s) waiting outside any hold`);
  // A budget hold waits on compression, and its agent gives up its turn, while its wakes count among the gated.
  for (const x of readout?.agents ?? []) if (x.budgetHold) why.push(`${x.name} waits in a budget hold, which no move of the clock ends`);
  const holds = [];
  for (const name of [...new Set([...alive, ...holding])]) {
    const a = (readout?.agents ?? []).find((x) => x.name === name);
    if (!a) { why.push(`the readout lists no agent ${name}`); continue; }
    if (a.status !== 'idle') why.push(`${name} is ${a.status}`);
    else if (a.primaryActive) why.push(`${name} is starting a turn`);
    else if (a.auxiliaryInFlight !== 0) why.push(`${name} has ${a.auxiliaryInFlight} auxiliary call(s) in flight`);
    else if (!(a.heldRequests >= 1)) why.push(`${name} has no request held`);
    else if (typeof a.cooldownUntil !== 'number') why.push(`${name}'s hold has no end on the clock`);
    else if (a.cooldownUntil <= clock) why.push(`${name}'s hold ended at ${a.cooldownUntil}, and the clock reads ${clock}`);
    else if (due && !due.has(a.cooldownUntil)) why.push(`${name}'s hold ends at ${a.cooldownUntil} on a timer the workload's clock doesn't run`);
    else holds.push({ agent: name, until: a.cooldownUntil });
  }
  return why.length ? { why: why.join('; ') } : { holds };
}

export const heldCalls = (step) => [...(step.subs ?? []).flatMap((s) => s.replies ?? []), ...(step.replies ?? [])].flatMap((r) => (Array.isArray(r.calls) ? r.calls : [])).filter((c) => c.during).map((c) => ({ canary: c.input.canary, during: c.during }));
export const actsOf = (step) => [...heldCalls(step).flatMap((h) => h.during), ...(step.replies ?? []).flatMap((r) => r.during ?? []), ...(step.summariserHold?.during ?? [])];

export const authorId = (participant) => `u-${String(participant).toLowerCase()}`;

export const pushEvent = ({ id, channel, participant, tags, text }, clock) => ({
  eventId: id,
  timestamp: new Date(clock).toISOString(),
  origin: { source: 'fixture', mcplChannelId: channel, channelId: channel, channelName: channel, messageId: id, authorId: authorId(participant), authorName: participant },
  ...(tags ? { tags } : {}),
  payload: { content: [{ type: 'text', text }] },
});

export function pushStored(events, from, id) {
  const admitted = events.findIndex(({ e }, i) => i >= from && e.type === 'admission:decided' && e.messageId === id);
  return admitted >= 0 && events.slice(admitted).some(({ e }) => e.type === 'message:added' && e.source === 'mcpl:push-event');
}

export const budgetHeldAt = (events, from, agent) => events.slice(from).find(({ e }) => e.type === 'inference:held' && e.agentName === agent)?.at;
export const budgetHeld = (events, from, agent) => events.slice(from).some(({ e }) => e.type === 'inference:held' && e.agentName === agent);
export const lateBudgetHold = (stepId, agent, gapMs) =>
  `step ${stepId}: the host held ${agent}'s turn for budget only after the summariser request held for it, so the hold's acts were skipped; the driver received the hold ${Math.round(gapMs)} ms after it checked for it`;
