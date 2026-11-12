// @ts-nocheck
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ipcConnect, send, sleep, spawnHost, stopHost, stopListedToo } from '../common.ts';
import { reachAttach, reachLaunch } from '../reach/interfaces.ts';
import { lineReader, listenForPeers } from './control.ts';
import { openWebUi } from './webui.ts';
import { cutText, errorText } from '../cut/interfaces.ts';
import { FORK_PREFIX, spawnName } from './checks.ts';
import { hostLines, stepWatch } from './step-log.ts';
import { HarnessFailure } from '../pool.ts';
import type { RequestEvent } from '../standin/standin.ts';
import type { CompileLine } from './module.ts';
import type { StoreDelta } from './recorder.ts';
import { PRELOAD } from './recipe.ts';
import { BOOT_MS, COMMAND_MS, MAINTAIN_MS, RESTART_MS, SHUTDOWN_MS, timerDelay, TURN_MS, WRITE_SETTLE_MS } from './bounds.ts';
import { addedRules, authorId, awaitedAfter, bootEchoesOwed, budgetHeld, budgetHeldAt, budgetReportDone, compressionIdleOver, configWriteEcho, echoDone, echoOwed, echoWindows, endsSpeechWait, exitWithin, forkSpeech, gateSpeeches, heldCalls, heldRefusal, heldTurns, lastTake, lateBudgetHold, maintainedAgents, movedSinceJudged, notRestingText, pauseNotes, pushEvent, pushStored, readSettle, readerEnds, snapshotOver, givesUp, readerFailureAllowed, readerStarts, shutdownFailure, speechEnd, spoke, subagentResult, tunedOutAuthors, unowedConfigEchoes } from './events.ts';
import { BASE_AGENT, fixtureChannels, hostEnv, laneRecipe } from './recipe.ts';
import { chokidarVersion, configWatched, reviewInterval } from './probes.ts';
import { childRecipe, childWatchers, endFleetGroups, fleetChildren, fleetReady } from './fleet.ts';

export type HostEvent = { type?: unknown; kind?: unknown; message?: unknown; error?: unknown; reason?: unknown; processEvent?: { type?: unknown; paths?: unknown; [field: string]: unknown } | null; [field: string]: unknown };
export type Traced = { at: number; e: HostEvent };
export type Boot = {
  n: number;
  events: Traced[];
  stopping: boolean;
  fleet?: ReturnType<typeof fleetChildren>;
  child?: ChildProcess;
  out?: string[];
  sockPath?: string;
  reach?: ReturnType<typeof reachAttach>;
  sock?: Socket;
  exited?: { code: number | null; signal: NodeJS.Signals | null };
  killed?: boolean;
  module?: boolean;
  judged?: number;
  judgedMoves?: number;
  moves?: number;
  webui?: Awaited<ReturnType<typeof openWebUi>>;
};
type Composition = {
  head?: { messages?: unknown; [field: string]: unknown } | null;
  tail?: { messages?: unknown; [field: string]: unknown } | null;
  [field: string]: unknown;
};
export type PanelAnswer = HostEvent & {
  ok?: unknown;
  data?: {
    contextComposition?: { [agent: string]: Composition | null | undefined } | null;
    runtimeSettings?: { [agent: string]: unknown } | null;
    readFailures?: { [agent: string]: { contextComposition?: unknown; [field: string]: unknown } | null | undefined } | null;
    [field: string]: unknown;
  } | null;
};
type Dry = { boot: number; seq: number | null };
type Unread = 'absent' | 'advance' | 'agent-end' | 'awaited' | 'awaits' | 'boot' | 'budget-held' | 'copy' | 'exit' | 'failure' | 'fleet-groups' | 'fork-speech' | 'held' | 'held-close' | 'host' | 'host-output' | 'kept' | 'moving' | 'notice' | 'panel' | 'provider-held' | 'compression-paused' | 'ready' | 'recipe' | 'shutdown' | 'stopping' | 'suppress' | 'turn-failed';
export type Failure = { step: string | null; reason: string; full?: string };
type FieldOf<T> = T extends unknown ? keyof T : never;
type Exclusive<T, F extends PropertyKey> = T extends unknown ? T & { [K in Exclude<F, keyof T>]?: undefined } : never;
type SendArm =
  | { via: 'release'; request: string }
  | { via: 'release'; canary: string }
  | { via: 'channel'; during?: string; message: { channelId: string; messageId: string; author: { id: string; name: string }; topic?: string; text: string; images?: number; tags?: string[]; at: number } }
  | { via: 'push'; during?: string; eventId: string; channel: string; chars: number }
  | { via: 'console'; during?: string; id?: string; chars: number }
  | { via: 'module'; op: 'remove'; messageIds: unknown[]; during: string }
  | { via: 'file'; path: string; remove: true }
  | { via: 'file'; path: string; chars: number }
  | { via: 'ipc'; command: string }
  | { via: 'panel'; op: string; params: Record<string, unknown>; edge?: number }
  | { via: 'webui'; op: 'suppress'; messageIds: unknown[] }
  | { via: 'fixture'; host: unknown }
  | { via: 'relist' };
export type Send = Exclusive<SendArm, FieldOf<SendArm>>;
export type LogEntry = { seq: number; wall: number; clock: number; step: string | null } & (
  | { kind: 'compiles'; boot: number; at?: 'boot'; lines: CompileLine[]; store: Record<string, StoreDelta>; blobs: Record<string, unknown>; submissions?: unknown[]; lost?: undefined }
  | { kind: 'compiles'; boot: number; lost: string; at?: undefined; lines?: undefined; store?: undefined; blobs?: undefined; submissions?: undefined }
  | { kind: 'reload'; agent: string; before: Dry; after: Dry }
  | { kind: 'ipc'; at: number; event: HostEvent }
  | { kind: 'settle'; phase: 'pass' | 'end'; settled?: boolean; [field: string]: unknown }
  | { kind: 'undelivered'; reason: unknown }
  | { kind: 'checkpoint'; name: string; health: PanelAnswer; skipped?: undefined }
  | { kind: 'health'; name: 'end'; health: PanelAnswer; skipped?: undefined }
  | { kind: 'health'; name: 'end'; skipped: string; health?: undefined }
  | { kind: 'budget-report'; boot: number; lines: string[]; ms: number }
  | { kind: 'request'; request: RequestEvent }
  | { kind: 'end'; ok: boolean; clockEnd: number }
  | { kind: 'read'; op: string; params?: Record<string, unknown>; answer: unknown }
  | { kind: 'order'; order: string[]; ended: boolean }
  | ({ kind: 'send' } & Send)
  | { kind: 'remove'; messageIds: unknown[]; canaries: string[]; during: string }
  | { kind: 'crash'; boot: number; answer: unknown; exited: { code: number | null; signal: NodeJS.Signals | null } | null; timedOut: boolean; hostLog: string }
  | ({ kind: 'fleet'; boot: number } & Awaited<ReturnType<typeof fleetReady>>)
  | { kind: Unread; [field: string]: unknown }
);


const FENCE = 'settle-fence:';

// Each command's answer as every host the runs drive writes it. connectome-host's #485 (merged into main as 08efb40e) made
// /undo and /redo act on the agent's window, answering "Undone: …" and "Redone: …", where they had branched the store
// and answered "Undone. Switched to branch …" (cebc11b and before); its changelog's migration names /branchto for the
// record's rollback, which both answer "Branched at [ID] -> …" once the store has moved.
const COMMANDS = {
  session: (lines) => {
    if (lines.some((l) => /^Session renamed to /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/session rename|No active session)/.test(l))) return 'failed';
    return null;
  },
  budget: (lines) => {
    if (lines.some((l) => /^Stream budget set to /.test(l))) return 'done';
    if (lines.some((l) => /^(Invalid token count|No agents)/.test(l))) return 'failed';
    return null;
  },
  newtopic: (lines) => {
    if (lines.some((l) => /^(Topic reset failed:|\/newtopic refused:|No context manager)/.test(l))) return 'failed';
    const at = lines.indexOf('Topic reset. Transition summary:');
    return at >= 0 && lines.length > at + 1 ? 'done' : null;
  },
  undo: (lines) => {
    if (lines.some((l) => /^(Undone\. Switched to branch "|Undone: )/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to undo|Undo failed|No agent context manager|No agent\.|\/undo refused:)/.test(l))) return 'failed';
    return null;
  },
  redo: (lines) => {
    if (lines.some((l) => /^(Redone\. Switched to branch "|Redone: )/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to redo|Redo failed|No agent context manager|No agent\.|\/redo refused:)/.test(l))) return 'failed';
    return null;
  },
  branchto: (lines) => {
    if (lines.some((l) => /^Branched at \[[^\]]*\] -> ".*" and switched\./.test(l))) return 'done';
    if (lines.some((l) => /^(branchto failed|No message with id|No agent context manager|Usage: \/branchto|\/branchto refused:)/.test(l))) return 'failed';
    return null;
  },
  checkout: (lines) => {
    if (lines.some((l) => /^Switched to branch /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/checkout|Branch ".*" not found|Checkout failed|No agent context manager|\/checkout refused:)/.test(l))) return 'failed';
    return null;
  },
  checkpoint: (lines) => {
    if (lines.some((l) => /^Checkpoint ".*" saved at branch /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/checkpoint|No agent context manager)/.test(l))) return 'failed';
    return null;
  },
  restore: (lines) => {
    if (lines.some((l) => /^Restored to checkpoint ".*" \(branch: /.test(l))) return 'done';
    if (lines.some((l) => /^(Checkpoint ".*" not found|No checkpoints saved|Available checkpoints:|Already at checkpoint "|No agent context manager|Restore failed|\/restore refused:)/.test(l))) return 'failed';
    return null;
  },
  branches: (lines) => {
    if (lines.some((l) => /^No agent context manager/.test(l))) return 'failed';
    const at = lines.findIndex((l) => /^--- Branches \(\d+\) ---$/.test(l));
    if (at < 0) return null;
    return lines.length > at + Number(/\((\d+)\)/.exec(lines[at])[1]) ? 'done' : null;
  },
};

export const commandEnds = (name, lines) => COMMANDS[name]?.(lines) ?? null;

const WEBUI_LISTENING = /\[webui\] listening on (https?:\/\/\S+)/;

export function decisionTimer(step, { configuration, facts, added = [] }) {
  const unknown = (why) => new Error(`the driver can't tell which timer starts ${why}`);
  if (step.verdict) {
    const scripted = added.findLast((r) => r?.name === step.verdict);
    if (scripted?.removed) throw unknown(`rule ${step.verdict}'s reply judge: an earlier step's wake_remove_rule removed it`);
    if (scripted && typeof scripted.judge?.debounceMs !== 'number') throw unknown(`rule ${step.verdict}'s reply judge: the earlier step's wake_add_rule that last added it gives it no judge debounceMs`);
    const delay = scripted ? scripted.judge.debounceMs : configuration.modules?.wake?.policies?.find((p) => p.name === step.verdict)?.behavior?.judge?.debounceMs;
    if (typeof delay !== 'number') throw unknown(`rule ${step.verdict}'s reply judge: neither the recipe nor an earlier step's wake_add_rule gives a judge rule of that name a debounceMs`);
    return { delay: timerDelay(delay), repeat: false };
  }
  if (step.review) {
    if (typeof facts.reviewMs !== 'number') throw unknown(`the suppression review: the host's facts give no review interval (${JSON.stringify(facts.reviewMs ?? null)})`);
    return { delay: timerDelay(facts.reviewMs), repeat: false };
  }
  return null;
}

// A fired timer is told apart only by its delay and whether it repeats: agent-framework arms the gate's timers with a
// plain setTimeout, which carries nothing else. So a one-shot timer of the decision's delay that fires before the
// decision's own in the same move is taken for it, and the wait for the decision runs out its bound, failing the run
// with that wait named. The decision is waited for before the round's settle: the host's maintain answer counts no
// request the reply judge or the suppression review has in flight (agent-framework's getHostModeStatus), so a settle
// could end between the judge's dry compile of the agent's context and the request that follows it.
export async function moveClockTo(to, { advance, settle, decision = null, now = null }) {
  let decided = false;
  for (;;) {
    if (now && now() > to) return { decided };
    const fired = await advance(to);
    if (!fired) return { decided };
    const decides = decision && !decided && fired.delay === decision.timer.delay && fired.repeat === decision.timer.repeat;
    if (decides) await decision.made();
    await settle();
    if (decides) {
      await decision.turns();
      decided = true;
    }
  }
}

export function speechWaits({ events, until, log, timeoutMs = TURN_MS }) {
  const judged = new Set();
  return async (speech, label) => {
    if (judged.has(speech)) return false;
    judged.add(speech);
    const list = events();
    const at = list.indexOf(speech);
    const end = await until(() => speechEnd(list, at), timeoutMs, `${label} (published, refused a route, held as drafts, or told in its turn's delivery receipt or a bounce notice)`);
    if (end.how === 'unsure') {
      const [what, whose, which] = end.of === 'bounced' ? ['a bounce notice', 'a bounce notice\'s', 'notice'] : ['a delivery receipt', 'a receipt\'s', 'receipt'];
      throw new RunFailure(`${label}: ${what} came while ${end.agents.join(' and ')}'s turn was alive too, and ${whose} trace names no agent, so it can't be told whether the ${which} is this speech's`);
    }
    if (end.how === 'silent') log('kept', { why: 'its turn started silent' });
    if (end.how === 'undelivered') log('undelivered', { reason: end.reason });
    return true;
  };
}

export async function inferenceEnd({ step, from, events, until, settle, speechEnds, ending }) {
  const after = (test) => events().slice(from).find(({ e }) => test(e));
  const done = await until(() => after((e) => e.type === 'inference:completed' || ending.test(e.type)), TURN_MS, `turn ${step.id}: its inference's end`);
  if (done.e.type !== 'inference:completed') return { ended: done };
  await settle();
  const said = after(spoke);
  if (!said) return {};
  if (step.ends === 'unspoken') return { spoke: said };
  await speechEnds(said, `turn ${step.id}: its speech's end`);
  await settle();
  return {};
}

class RunFailure extends Error {}

export async function runScript({ steps, configuration, standin, hostDir, facts, work, storeDir, epoch, logPath, hostLogs, runDir = null, reach = null }) {
  if (steps.some((s) => s.review)) facts = { ...facts, reviewMs: reviewInterval({ hostDir, configuration }) };
  mkdirSync(work, { recursive: true });
  mkdirSync(hostLogs.dir, { recursive: true });
  const hostLogOf = (b) => `${hostLogs.at}/host-${b.n}.log`;
  const ending = (b, out) => `its whole output is ${hostLogOf(b)} in the evidence, and its last lines are:\n${tail(out)}`;
  mkdirSync(storeDir, { recursive: true });
  if (configuration.privileged) writeFileSync(join(work, 'sleep-privileged.json'), JSON.stringify(configuration.privileged.map(authorId)));
  for (const dir of configuration.dirs ?? []) mkdirSync(join(work, dir), { recursive: true });
  for (const [path, text] of Object.entries(configuration.files ?? {})) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  const t0 = performance.now();
  const wall = () => Math.round((performance.now() - t0) * 10) / 10;
  let seq = 0;
  let clock = epoch;
  let current = null;
  let stepFrom = 0;
  let readerHolds = [];
  let budgetSkipped = null;
  let stepHost = null;
  const hosted = hostLines();
  const watch = stepWatch();
  const log = (kind, fields = {}) => {
    appendFileSync(logPath, `${JSON.stringify({ seq: seq++, wall: wall(), clock, step: current?.id ?? null, kind, ...fields })}\n`);
    hosted.see(kind, fields);
    const late = watch.logged(kind, fields, current?.id ?? null);
    if (late) fail({ step: current?.id ?? null, reason: late });
  };
  const endStep = (ended) => {
    const { lines, primary, wrote, managers } = hosted.take();
    const order = standin.endStep(lines, primary, wrote, managers);
    if (order.length) log('order', { order, ended });
    const [again] = standin.reissued();
    if (again) fail({ step: current?.id ?? null, reason: `request ${again.request} gives the tool id ${again.ids[0]}, which its checkpoint's build gave already, so the run's calls can't be told from the store's: give the run's steps ids of their own, seeded from the run's name` });
  };
  const { channels, servers } = fixtureChannels(steps, configuration);
  const tunedOut = tunedOutAuthors(steps);
  const peerOf = (server) => (server && server !== 'fixture' ? `server:${server}` : 'server');
  const runName = `fx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = { ...BASE_AGENT, ...configuration.agent }.name;
  let recipeOf = configuration;
  const control = join(tmpdir(), `${runName}.ctl`);
  const ctl = await listenForPeers(control);
  const watchers = new Set();
  const poke = () => { for (const w of [...watchers]) w(); };
  let failure = null;
  const holdsSeen = new Set();
  const pausesSeen = new Set();
  const notePaused = (paused) => { for (const p of pauseNotes(paused, pausesSeen, clock)) log('compression-paused', p); };
  const cutsFired = new Set();
  const fail = (f: Failure) => { if (!failure) { failure = f; log('failure', f); } poke(); };
  const until = (check, timeoutMs, label, { pollMs = 0, soft = false } = {}) => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); clearInterval(poll); watchers.delete(attempt); };
    const attempt = () => {
      if (failure) { stop(); reject(new RunFailure(failure.reason)); return; }
      const v = check();
      if (v) { stop(); resolve(v); }
    };
    const timer = setTimeout(() => {
      stop();
      if (soft) { resolve(null); return; }
      fail({ step: current?.id ?? null, reason: `${label}: nothing after ${timeoutMs} ms` });
      reject(new RunFailure(label));
    }, timeoutMs);
    const poll = pollMs ? setInterval(attempt, pollMs) : undefined;
    watchers.add(attempt);
    attempt();
  });
  const unlessFailed = (p) => new Promise((resolve, reject) => {
    const check = () => { if (failure) { watchers.delete(check); reject(new RunFailure(failure.reason)); } };
    watchers.add(check);
    check();
    p.then((v) => { watchers.delete(check); resolve(v); }, (e) => { watchers.delete(check); reject(e); });
  });

  const notices = [];
  ctl.onNotice((n) => { notices.push(n); log('notice', n); poke(); });
  // connectome-host's report of a cut can reach the driver before the stand-in sees the held call's connection close.
  standin.onHeld(async (request) => {
    try {
      if (request.during) {
        await act(current, request.during, request.id, request);
        if (cutsFired.has(request.id)) {
          const from = wall();
          const close = await standin.whenHeldClosed(request.id);
          log('held-close', { request: request.id, close, waitedMs: Math.round(wall() - from) });
        }
      } else await compressionIdle(request);
    } catch (e) {
      const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 2000));
      if (!failure) fail({ step: current?.id ?? null, reason: `while ${request.id} was held: ${c.shown}`, ...(c.full ? { full: `while ${request.id} was held: ${c.full}` } : {}) });
    } finally {
      standin.releaseHeld(request.id);
      if (request.during) log('send', { via: 'release', request: request.id });
    }
  });

  let ended = false;
  standin.setClock(clock);
  const asked = [];
  standin.onRequest((r) => {
    if (ended) return;
    asked.push(r);
    poke();
    log('request', { request: r });
    const late = watch.request(r, current?.id ?? null);
    if (r.kind === 'unclassified') fail({ step: current?.id ?? null, reason: `the stand-in got a request it couldn't classify (${r.reason ?? r.id})` });
    else if (late) fail({ step: current?.id ?? null, reason: late });
  });

  let host = null;
  let boots = 0;
  let signalled = null;
  const reads = [];
  const groupsFile = configuration.fleet?.length ? join(work, 'fleet.groups') : null;
  if (groupsFile) rmSync(groupsFile, { force: true });
  const unlist = groupsFile ? stopListedToo(groupsFile) : () => {};
  const childReach = reach ? childWatchers({ wanted: reach.wanted, reads }) : null;
  const timing = { boots: [], steps: [] };
  const copies = [];

  async function boot(after = RESTART_MS) {
    if (boots > 0) {
      const to = clock + after;
      log('advance', { from: clock, to, restart: true });
      clock = to;
      standin.setClock(clock);
    }
    const b = { n: ++boots, events: [], stopping: false };
    const fresh = !existsSync(storeDir) || readdirSync(storeDir).length === 0;
    const started = performance.now();
    if (childReach) for (const c of recipeOf.fleet ?? []) if (!childReach.has(c.name)) childReach.watch(c.name, await reachLaunch({ logDir: reach.logDir }), childRecipe(work, c.name));
    const fleet = fleetChildren({ configuration: recipeOf, work, storeDir, standinUrl: standin.url, reachOf: (name) => childReach?.launchOf(name) ?? null });
    for (const f of fleet) writeFileSync(f.recipePath, JSON.stringify(f.recipe, null, 2));
    b.fleet = fleet;
    const recipe = laneRecipe({ configuration: recipeOf, control, channels, boot: b.n, servers, standinUrl: standin.url, work, fleet });
    const recipePath = join(work, `recipe-${b.n}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
    const sockPath = join(tmpdir(), `${runName}-${b.n}.sock`);
    rmSync(sockPath, { force: true });
    const since = { server: ctl.generation('server'), clock: ctl.generation('clock'), module: ctl.generation('module'), ...Object.fromEntries(Object.keys(servers).map((n) => [peerOf(n), ctl.generation(peerOf(n))])) };
    log('boot', { boot: b.n, recipePath, storeDir });
    const env = { ...hostEnv({ configuration: recipeOf, standinUrl: standin.url, control, clock, runDir, tunedOut }), ...(groupsFile ? { FIXTURE_GROUPS: groupsFile } : {}) };
    const launch = reach ? await reachLaunch({ logDir: reach.logDir }) : null;
    const { child, out } = spawnHost({ hostDir, recipePath, dataDir: storeDir, cwd: work, sockPath, env: { ...env, ...launch?.env }, preload: PRELOAD, bunArgs: launch?.args ?? [] });
    Object.assign(b, { child, out, sockPath, ...(launch ? { reach: reachAttach({ launch, child, wanted: reach.wanted, killing: () => { b.killed = true; } }) } : {}) });
    host = b;
    child.once('exit', (code, signal) => {
      b.exited = { code, signal };
      if (signal && !b.killed) signalled ??= { boot: b.n, signal };
      log('exit', { boot: b.n, code, signal, expected: b.stopping });
      if (!b.stopping) fail({ step: current?.id ?? null, reason: `the host exited (${code ?? signal}); ${ending(b, out)}` });
      poke();
    });
    await until(() => existsSync(sockPath), BOOT_MS, `boot ${b.n}: the host's IPC socket`, { pollMs: 50 });
    for (let attempt = 0; !b.sock; attempt++) {
      try { b.sock = await ipcConnect(sockPath); } catch (e) {
        if (attempt >= 40 || failure) throw new RunFailure(`boot ${b.n}: couldn't connect to IPC: ${e.message}`);
        await sleep(50);
      }
    }
    const spoke = configuration.judges === 'fork' ? forkSpeech() : null;
    lineReader(b.sock, (e) => {
      const at = wall();
      b.events.push({ at, e });
      if (!(e.type === 'snapshot' && String(e.corrId).startsWith(FENCE))) log('ipc', { at, event: e });
      const said = spoke?.(e);
      if (said) {
        b.events.push({ at, e: said });
        log('fork-speech', { at, agent: said.agentName, chars: said.content.length });
      }
      poke();
    });
    await until(() => b.events.some(({ e }) => e.type === 'lifecycle' && e.phase === 'ready'), BOOT_MS, `boot ${b.n}: lifecycle ready`);
    await unlessFailed(ctl.waitConnected('server', { since: since.server, timeoutMs: BOOT_MS }));
    for (const n of Object.keys(servers)) await unlessFailed(ctl.waitConnected(peerOf(n), { since: since[peerOf(n)], timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('clock', { since: since.clock, timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('module', { since: since.module, timeoutMs: BOOT_MS }));
    b.module = true;
    if (fleet.length) await waitForFleet(b);
    timing.boots.push(Math.round(performance.now() - started));
    log('ready', { boot: b.n, ms: timing.boots.at(-1) });
    await takeCompiles('boot');
    await budgetReport(b);
    await configBootEcho(b, fresh);
  }

  async function waitForFleet(b) {
    try {
      const { children, ms } = await fleetReady({ ask: () => ctl.moduleRequest('fleet'), names: b.fleet.map((f) => f.name) });
      log('fleet', { boot: b.n, ms, children });
    } catch (e) {
      fail({ step: current?.id ?? null, reason: `boot ${b.n}: ${e.message}` });
      throw new RunFailure('fleet not ready');
    }
  }

  async function budgetReport(b, { fork = false } = {}) {
    const started = performance.now();
    const from = b.events.length;
    send(b.sock, { type: 'command', command: '/budget' });
    const lines = () => b.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    // connectome-host's `/budget` writes each agent's line as its own output, so a report read for a fork waits for the
    // fork's.
    await until(() => budgetReportDone(lines(), fork ? FORK_PREFIX : agentName, { prefix: fork }), COMMAND_MS, `boot ${b.n}: /budget`);
    log('budget-report', { boot: b.n, lines: lines(), ms: Math.round(performance.now() - started) });
  }

  async function takeCompiles(at = null) {
    if (!host) return;
    const { lines, store, blobs, submissions } = await ctl.moduleRequest('take');
    if (lines.length || Object.keys(store).length || Object.keys(blobs).length || submissions?.length) log('compiles', { boot: host.n, ...(at ? { at } : {}), lines, store, blobs, ...(submissions?.length ? { submissions } : {}) });
  }

  async function shutdown() {
    const b = host;
    if (!b) return;
    if (b.module) await lastTake({ boot: b.n, take: takeCompiles, log, fail, step: current?.id ?? null });
    host = null;
    b.stopping = true;
    if (!b.exited) {
      log('stopping', { boot: b.n });
      if (b.sock) send(b.sock, { type: 'shutdown' });
      const timedOut = !(await exitWithin(b.child, SHUTDOWN_MS, b.reach));
      if (timedOut) {
        b.killed = true;
        stopHost(b.child);
        await exitWithin(b.child, SHUTDOWN_MS);
      }
      const why = shutdownFailure({ boot: b.n, timedOut, exited: b.exited, seconds: SHUTDOWN_MS / 1000 });
      if (why) fail({ step: current?.id ?? null, reason: `${why}; ${ending(b, b.out)}` });
    }
    try { b.sock?.destroy(); } catch {}
    b.webui?.close();
    b.killed = true;
    stopHost(b.child);
    if (b.reach) {
      reads.push({ boot: b.n, ...await b.reach.atExit });
      b.reach.close();
    }
    try { writeFileSync(join(hostLogs.dir, `host-${b.n}.log`), b.out.join('')); } catch (e) {
      fail({ step: current?.id ?? null, reason: `boot ${b.n}: the host's log couldn't be written: ${e.message}` });
    }
    log('shutdown', { boot: b.n, hostLog: hostLogOf(b) });
  }

  const eventAfter = (from, test) => host.events.slice(from).find(({ e }) => test(e));
  const speechEnds = speechWaits({ events: () => host.events, until, log });

  let fences = 0;
  async function ipcFence() {
    const t = performance.now();
    const corrId = `${FENCE}${++fences}`;
    const from = host.events.length;
    send(host.sock, { type: 'describe', corrId });
    await until(() => eventAfter(from, (e) => e.type === 'snapshot' && e.corrId === corrId), COMMAND_MS, 'the IPC answer that ends a settle');
    return Math.round((performance.now() - t) * 10) / 10;
  }

  async function heldNow(answer) {
    const readout = await unlessFailed(ctl.moduleRequest('held', {}, { timeoutMs: COMMAND_MS }));
    const due = new Set();
    for (const end of new Set((readout?.agents ?? []).filter((a) => a.heldRequests >= 1 && typeof a.cooldownUntil === 'number').map((a) => a.cooldownUntil))) {
      if ((await unlessFailed(ctl.due(end)))?.due) due.add(end);
    }
    return heldTurns(answer, readout, clock, due);
  }

  async function settle({ drained: needs = null } = {}) {
    const started = performance.now();
    let progress = null;
    let pass = 0;
    for (;;) {
      pass++;
      const t = performance.now();
      const ran = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const snap = await ctl.moduleRequest('snapshot');
      const answer = snapshotOver(ran, snap);
      if (!answer || snap?.unread) {
        const why = snap?.unread ? `couldn't read the settle: ${snap.unread}` : 'couldn\'t read the settle: the harness module read no snapshot of the host (agent-framework\'s getContextMaintenanceSnapshot and getHostModeStatus), which a settle decides on';
        log('settle', { phase: 'end', settled: false, passes: pass, ms: Math.round(performance.now() - started), why });
        fail({ step: current?.id ?? null, reason: why });
        throw new RunFailure('no snapshot');
      }
      const read = readSettle(answer, progress, snap.ticks, agentName, ran, clock);
      const { ticking } = read;
      progress = read.progress;
      const agents = answer?.maintenance?.agents ?? [];
      const { drained, deferredWrites, gatedRequests, activeTurnAgents = [] } = answer?.hostMode ?? {};
      log('settle', { phase: 'pass', pass, ms: Math.round(performance.now() - t), ok: answer?.ok, ran: answer?.maintenance?.ran, runId: answer?.maintenance?.history?.[0]?.id ?? null, agents, drained, deferredWrites, gatedRequests, activeTurnAgents, inFlight: read.inFlight, moved: read.moved, ...(ticking.length ? { ticking } : {}) });
      if (read.unreadable !== undefined) {
        const why = `couldn't read the settle: the host's maintain answer ${read.unreadable}`;
        log('settle', { phase: 'end', settled: false, passes: pass, ms: Math.round(performance.now() - started), why });
        fail({ step: current?.id ?? null, reason: why });
        throw new RunFailure('unreadable');
      }
      if (read.settled) {
        notePaused(read.paused);
        const fence = await ipcFence();
        log('settle', { phase: 'end', settled: true, passes: pass, ms: Math.round(performance.now() - started), fenceMs: fence });
        await takeCompiles();
        return pass;
      }
      const held = read.waits ? await heldNow(answer) : null;
      if (held?.holds) {
        const refused = heldRefusal(held.holds, needs);
        if (refused) {
          log('settle', { phase: 'end', settled: false, passes: pass, ms: Math.round(performance.now() - started), held: held.holds });
          fail({ step: current?.id ?? null, reason: refused });
          throw new RunFailure('held');
        }
        for (const h of held.holds) {
          if (holdsSeen.has(`${h.agent}@${h.until}`)) continue;
          holdsSeen.add(`${h.agent}@${h.until}`);
          log('provider-held', { agent: h.agent, until: h.until, ms: timerDelay(h.until - clock) });
        }
        notePaused(read.paused);
        const fence = await ipcFence();
        log('settle', { phase: 'end', settled: true, held: held.holds, passes: pass, ms: Math.round(performance.now() - started), fenceMs: fence });
        await takeCompiles();
        return pass;
      }
      if (failure) throw new RunFailure(failure.reason);
      const whyOf = (cut) => (!answer?.ok ? `maintain answered ${cut(JSON.stringify(answer), 300)}`
        : givesUp(read) ? 'nothing in flight, and the last pass moved nothing on'
          : performance.now() - started >= TURN_MS ? `still unsettled after ${TURN_MS} ms between passes, the bound a turn's speech has`
            : null);
      const why = whyOf((v, n) => String(v).slice(0, n));
      if (why) {
        const ms = Math.round(performance.now() - started);
        log('settle', { phase: 'end', settled: false, passes: pass, ms, why, ...(held?.why ? { notHeld: held.why } : {}) });
        const host = [
          drained === true ? 'the host drained' : drained === false ? `the host not drained (turns alive: ${activeTurnAgents.join(', ') || 'none named'})` : 'no drained state in the host\'s answer',
          typeof deferredWrites !== 'number' || deferredWrites === 0 ? null : `${deferredWrites} deferred write(s) still to land`,
          typeof gatedRequests !== 'number' ? 'no count of gated requests in the host\'s answer' : gatedRequests === 0 ? null : `${gatedRequests} wake(s) waiting to start a turn`,
          held?.why && typeof gatedRequests === 'number' ? `not a provider hold the clock ends: ${held.why}` : null,
        ].filter(Boolean).join(', ');
        const said = cutText((cut) => {
          const notReady = agents.filter((a) => a.ready !== true).map((a) => (a.agentName ? `${a.agentName} (${notRestingText(a, clock)})` : cut(JSON.stringify(a), 200)));
          return `the run didn't settle (${whyOf(cut)}; ${pass} maintenance passes in ${(ms / 1000).toFixed(1)} s): ${notReady.length ? `not ready: ${notReady.join(', ')}` : 'every agent ready'}, ${host}. A wait timed by the host's virtual clock can't end inside a settle, since the driver moves that clock only between settles.`;
        });
        fail({ step: current?.id ?? null, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure('unsettled');
      }
    }
  }

  async function compressionIdle(request) {
    const started = performance.now();
    for (let pass = 1; ; pass++) {
      const ran = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const snap = await ctl.moduleRequest('snapshot');
      const answer = snapshotOver(ran, snap);
      if (!answer || snap?.unread) throw new RunFailure(`couldn't read whether compression is idle: ${snap?.unread ?? 'the harness module read no snapshot of the host'}`);
      const listed = maintainedAgents(answer, agentName);
      if (answer?.ok === true && listed.unreadable !== undefined) throw new RunFailure(`couldn't read whether compression is idle: the host's maintain answer ${listed.unreadable}`);
      const over = compressionIdleOver(answer, snap.ticks, agentName, ran, clock);
      if (over.idle) {
        log('held', { request: request.id, agent: request.agent, passes: pass, ms: Math.round(performance.now() - started) });
        return;
      }
      if (performance.now() - started >= TURN_MS) throw new RunFailure(`compression didn't go idle within ${TURN_MS} ms (${pass} passes)${over.why ? `: ${over.why}` : ''}`);
    }
  }

  const channelMessage = (step, { id, participant, text, images, tags }) => ({ channelId: step.channel, messageId: id, author: { id: authorId(participant), name: participant }, topic: step.topic, text, ...(images ? { images } : {}), ...(tags ? { tags } : {}), at: clock });
  const sendSummary = (message) => ({ ...message, text: `${message.text.length} chars`, ...(message.images ? { images: message.images.length } : {}) });

  async function act(step, acts, during, request = null) {
    for (const a of acts) {
      if (a.deliver) {
        const message = channelMessage({ channel: a.deliver.channel ?? step.channel, topic: step.topic }, a.deliver);
        const from = host.events.length;
        log('send', { via: 'channel', during, message: sendSummary(message) });
        await ctl.deliver(message, { timeoutMs: TURN_MS });
        const stored = () => {
          const admitted = host.events.findIndex(({ e }, i) => i >= from && e.type === 'admission:decided' && e.messageId === message.messageId);
          return admitted >= 0 && host.events.slice(admitted).some(({ e }) => e.type === 'message:added' && e.source === 'mcpl:channel-incoming');
        };
        await until(stored, TURN_MS, `step ${step.id}: ${message.messageId} admitted and stored by the host (admission:decided, then message:added)`);
      } else if (a.push) {
        const event = pushEvent(a.push, clock);
        const from = host.events.length;
        log('send', { via: 'push', during, eventId: event.eventId, channel: a.push.channel, chars: a.push.text.length });
        await ctl.push(event, { timeoutMs: TURN_MS });
        await until(() => pushStored(host.events, from, event.eventId), TURN_MS, `step ${step.id}: push ${event.eventId} admitted and stored by the host (admission:decided, then message:added from mcpl:push-event)`);
      } else if (a.console) {
        const from = host.events.length;
        log('send', { via: 'console', during, id: a.console.id, chars: a.console.text.length });
        send(host.sock, { type: 'text', content: a.console.text, from: 'console' });
        await until(() => eventAfter(from, (e) => e.type === 'message:added' && e.source === 'external-message'), TURN_MS, `step ${step.id}: console input ${a.console.id} stored by the host (message:added from external-message)`);
      } else if (a.agentEnd) {
        const landed = await until(() => subagentResult(host.events, a.agentEnd, stepFrom), TURN_MS, `step ${step.id}: ${typeof a.agentEnd === 'string' ? `subagent ${a.agentEnd}'s` : `a reader fork's (${a.agentEnd.prefix}…)`} result stored for its launcher (dendrite:mail-delivered)`);
        if (typeof landed === 'string') { fail({ step: step.id, reason: `step ${step.id}: ${landed}` }); throw new RunFailure('reader forks'); }
        if (typeof a.agentEnd !== 'string') readerHolds.push(a.agentEnd);
        log('agent-end', { during, agent: landed.e.from, to: landed.e.to });
      } else if (a.remove) {
        const messageIds = await resolveMessages(fromHeld(a.remove.messages, request));
        const got = await moduleRead('messages', { agent: agentName });
        const canaries = messageIds.flatMap((id) => (got?.messages ?? got ?? []).find((m) => m.id === String(id))?.canaries ?? []);
        log('send', { via: 'module', op: 'remove', messageIds, during });
        for (const messageId of messageIds) await moduleRead('remove', { messageId });
        log('remove', { messageIds, canaries, during });
      } else if (a.advance) {
        const from = asked.length;
        const events = host.events.length;
        let firedAny = false;
        await moveClockTo(clock + a.advance, {
          advance: async (to) => {
            log('moving', { during, from: clock, to });
            const { at, fired } = await unlessFailed(ctl.advance(to));
            log('advance', { during, from: clock, to: at, ...(fired ? { fired } : {}) });
            host.moves = (host.moves ?? 0) + 1;
            clock = at;
            standin.setClock(clock);
            if (fired) firedAny = true;
            return fired;
          },
          settle: async () => {},
        });
        if (a.cut && !firedAny) {
          fail({ step: step.id, reason: `step ${step.id}: moving the clock ${a.advance} ms past the held call's send fired no host timer, where the inference bound's cut of a call with no content would fire` });
          throw new RunFailure('no cut');
        }
        if (a.cut) cutsFired.add(during);
        if (a.cut === 'ends') await until(() => eventAfter(events, (e) => e.agentName === agentName && e.type === 'inference:exhausted'), TURN_MS, `step ${step.id}: the turn's end in inference:exhausted after the inference bound cut its last call, ${a.advance} ms on`);
        else if (a.cut) await until(() => asked.slice(from).some((r) => r.kind === 'agent' && r.step === step.id), TURN_MS, `step ${step.id}: a fresh call after the inference bound cut the held one, ${a.advance} ms on`);
      } else if (a.asked) {
        const n = a.n ?? 1;
        await until(() => asked.filter((r) => r.agent === a.asked && r.step === step.id).length >= n, TURN_MS, `step ${step.id}: request ${n} of ${a.asked === 'primary' ? agentName : `subagent ${a.asked}`} at the step`);
      } else if (a.budgetHeld) {
        const checked = wall();
        const held = budgetHeld(host.events, stepFrom, agentName);
        log('budget-held', { during, held, ...(held ? { marginMs: Math.round(checked - budgetHeldAt(host.events, stepFrom, agentName)) } : {}) });
        if (!held) {
          budgetSkipped = checked;
          return;
        }
      } else if (a.ended) {
        await until(() => host.events.slice(stepFrom).some(({ e }) => spawnName(e.agentName) === a.ended && /^inference:(completed|aborted|exhausted)$/.test(e.type)), TURN_MS, `step ${step.id}: a turn of subagent ${a.ended} ending`);
      } else {
        fail({ step: step.id, reason: `the driver has no act ${JSON.stringify(a)} for a hold` });
        throw new RunFailure('unknown act');
      }
    }
  }

  async function channelTurn(step) {
    const from = host.events.length;
    const message = channelMessage(step, { id: step.id, participant: step.participant, text: step.text, images: step.images, tags: step.tags });
    log('send', { via: 'channel', message: sendSummary(message) });
    await ctl.deliver(message, { timeoutMs: TURN_MS });
    if (step.reader) {
      const reader = step.reader.prefix ? `a reader fork's (${step.reader.prefix}…)` : `${step.reader.name}'s`;
      await until(() => eventAfter(from, readerStarts(step)), TURN_MS, `turn ${step.id}: ${reader} turn`);
      await settle();
      const failed = eventAfter(from, readerEnds(step, agentName));
      if (failed && readerFailureAllowed(step, failed.e)) {
        log('turn-failed', { agent: failed.e.agentName, event: failed.e.type, error: failed.e.error ?? null });
        return;
      }
      if (failed) {
        const said = cutText((cut) => `${failed.e.agentName}'s turn ended in ${failed.e.type}: ${cut(JSON.stringify(failed.e), 1500)}`);
        fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure(failed.e.type);
      }
      return;
    }
    for (const { canary, during } of heldCalls(step)) {
      await until(() => notices.some((n) => n.notice === 'held' && n.canary === canary), TURN_MS, `turn ${step.id}: the call held for ${canary}`);
      await act(step, during, canary);
      await ctl.release(canary, { timeoutMs: COMMAND_MS });
      log('send', { via: 'release', canary });
    }
    const ending = step.mayFail || step.retries ? /^inference:(exhausted|aborted)$/ : /^inference:(failed|exhausted|aborted)$/;
    if (step.ends === 'unspoken' || step.ends === 'either') {
      const end = await inferenceEnd({ step, from, events: () => host.events, until, settle, speechEnds, ending });
      if (end.ended) {
        const said = cutText((cut) => `the turn's end in ${end.ended.e.type}: ${cut(JSON.stringify(end.ended.e), 1500)}`);
        fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure(end.ended.e.type);
      }
      if (end.spoke) {
        fail({ step: step.id, reason: `turn ${step.id} spoke, where its script ends it with no speech` });
        throw new RunFailure('spoke');
      }
      return;
    }
    const ended = await until(() => eventAfter(from, (e) => endsSpeechWait(step, e, ending)), TURN_MS, `turn ${step.id}: its speech`);
    if (ended.e.type === 'inference:speech' && step.ends === 'contained') {
      // agent-framework's tool-wrapper guard contains the speech: it publishes, holds and receipts none of it
      // (docs/tool-wrapper-prose-guard.md), so its speech has no end to wait for.
      await settle();
      return;
    }
    if (ended.e.type !== 'inference:speech' && step.mayFail) {
      log('turn-failed', { event: ended.e.type, error: ended.e.error ?? null });
      const { awaits } = step;
      if (awaits && !(await until(() => awaitedAfter(host.events, ended, awaits), TURN_MS, `turn ${step.id}: ${awaits.what}`, { soft: true }))) log('awaited', { what: awaits.what, came: null, waitedMs: TURN_MS });
      await gateTurns(step, from);
      return;
    }
    if (ended.e.type !== 'inference:speech') {
      // agent-framework reports inference:failed before it decides whether to retry, and the
      // event doesn't say which; the fixture stops at the first failure either way.
      const what = ended.e.type === 'inference:failed'
        ? 'the turn\'s first inference failure (inference:failed, which agent-framework may still have retried)'
        : `the turn's end in ${ended.e.type}`;
      const said = cutText((cut) => `${what}: ${cut(JSON.stringify(ended.e), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(ended.e.type);
    }
    await speechEnds(ended, `turn ${step.id}: its speech's end`);
    await settle();
  }

  async function gateTurns(step, from, { settled = false } = {}) {
    if (step.verdictAfterTurn) {
      log('awaits', { what: 'verdict', rule: step.verdictAfterTurn });
      await until(() => eventAfter(from, (e) => e.type === 'gate:judge-verdict' && e.policyName === step.verdictAfterTurn), TURN_MS, `step ${step.id}: the reply judge's verdict on rule ${step.verdictAfterTurn}'s batch, held while the step's turn ran`);
    }
    if (!settled || step.verdictAfterTurn) await settle();
    let waited = false;
    for (const speech of gateSpeeches(host.events, from)) {
      if (await speechEnds(speech, `step ${step.id}: a gate-started turn's speech's end`)) waited = true;
    }
    const ending = step.retries ? /^inference:(exhausted|aborted)$/ : /^inference:(failed|exhausted|aborted)$/;
    const failed = eventAfter(from, (e) => ending.test(e.type));
    if (failed && !step.mayFail) {
      const said = cutText((cut) => `a turn the gate started ended in ${failed.e.type}: ${cut(JSON.stringify(failed.e), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(failed.e.type);
    }
    if (waited) await settle();
  }

  async function deliver(step) {
    const from = host.events.length;
    for (const m of step.messages) {
      const message = channelMessage({ channel: m.channel, topic: m.topic ?? step.topic }, m);
      const sent = host.events.length;
      log('send', { via: 'channel', message: sendSummary(message) });
      await ctl.deliver(message, { timeoutMs: TURN_MS, peer: peerOf(m.server) });
      if (m.held) await until(() => eventAfter(sent, (e) => e.type === 'admission:decided' && e.messageId === message.messageId && e.held), TURN_MS, `step ${step.id}: the host holding its message in ${m.channel} for a tune-out (admission:decided with a hold)`);
      else if (configuration.modules?.wake === false) await until(() => eventAfter(sent, (e) => e.type === 'admission:decided' && e.messageId === message.messageId), TURN_MS, `step ${step.id}: the host's admission of its message in ${m.channel}, with no gate to decide it`);
      else await until(() => eventAfter(sent, (e) => (e.type === 'gate:decision' || e.type === 'gate:suppressed') && e.channelId === m.channel), TURN_MS, `step ${step.id}: the gate's decision on its message in ${m.channel}, or its suppression`);
      if (m.offered) await until(() => eventAfter(sent, (e) => e.type === 'gate:onboarding-offered' && e.serverId === (m.server ?? 'fixture')), TURN_MS, `step ${step.id}: the wake onboarding offer its message brings`);
    }
    await gateTurns(step, from);
  }

  async function pushed(step) {
    const from = host.events.length;
    const event = pushEvent(step, clock);
    log('send', { via: 'push', eventId: event.eventId, channel: step.channel, chars: step.text.length });
    await ctl.push(event, { timeoutMs: TURN_MS });
    await until(() => eventAfter(from, (e) => (e.type === 'gate:decision' || e.type === 'gate:suppressed') && e.eventType === 'mcpl:push-event' && e.serverId === 'fixture' && e.channelId === step.channel), TURN_MS, `step ${step.id}: the gate's decision on its push`);
    await gateTurns(step, from);
  }

  async function typed(step) {
    const from = host.events.length;
    const since = asked.length;
    log('send', { via: 'console', chars: step.text.length });
    send(host.sock, { type: 'text', content: step.text, from: 'console' });
    await until(() => eventAfter(from, (e) => e.type === 'gate:decision' && e.eventType === 'external-message' && e.serverId === 'cli'), TURN_MS, `step ${step.id}: the gate's decision on its console input`);
    if (step.named) await until(() => asked.slice(since).some((r) => r.kind === 'naming'), TURN_MS, `step ${step.id}: the session naming request its input brings`);
    await gateTurns(step, from);
  }

  async function file(step) {
    const from = host.events.length;
    const path = join(realpathSync(work), step.path);
    const noticed = notices.length;
    if (step.watched) await unlessFailed(ctl.expectStat(path));
    if (step.remove) rmSync(path, { force: true });
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, step.text); }
    log('send', { via: 'file', path: step.path, ...(step.remove ? { remove: true } : { chars: step.text.length }) });
    if (step.watched) {
      await until(() => notices.slice(noticed).some((n) => n.peer === 'clock' && n.notice === 'stat' && n.path === path), TURN_MS, `step ${step.id}: chokidar's settle poll of ${step.path}, a callback fs.stat of the written file (${chokidarVersion(hostDir)}); a chokidar that settles a write some other way sends none`);
      await moveClock(WRITE_SETTLE_MS);
      if (step.watched === 'settles') await until(() => eventAfter(from, (e) => e.type === 'process:completed' && String(e.processEvent?.type ?? '').startsWith('workspace:') && (e.processEvent.paths ?? []).includes(step.path)), TURN_MS, `step ${step.id}: the workspace's processing of ${step.path}'s change`);
      else await until(() => eventAfter(from, (e) => e.type === 'gate:decision' && String(e.eventType ?? '').startsWith('workspace:')), TURN_MS, `step ${step.id}: the gate's decision on ${step.path}'s change`);
    }
    await gateTurns(step, from);
  }

  async function command(step) {
    const name = /^\/(\S+)/.exec(step.command)?.[1];
    const ends = COMMANDS[name];
    if (!ends) {
      fail({ step: step.id, reason: `the driver doesn't know when ${JSON.stringify(step.command)} ends` });
      throw new RunFailure('unknown command');
    }
    let sent = step.command;
    for (const canary of new Set(step.command.match(/\[\[c:[^\]\s]+\]\]/g) ?? [])) sent = sent.replaceAll(canary, String((await stored({ canary })).id));
    const from = host.events.length;
    log('send', { via: 'ipc', command: step.command });
    send(host.sock, { type: 'command', command: sent });
    const lines = () => host.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    const outcome = await until(() => ends(lines()), COMMAND_MS, `command ${step.command}`);
    if (outcome !== (step.expect ?? 'done')) {
      const said = cutText((cut) => `${step.command} ${outcome}, where the step expects it ${step.expect ?? 'done'}: ${cut(lines().join(' | '), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(`command ${outcome}`);
    }
    await settle();
  }

  async function moveClock(ms, decision = null) {
    return moveClockTo(clock + ms, {
      advance: async (to) => {
        log('moving', { from: clock, to });
        const { at, fired } = await unlessFailed(ctl.advance(to));
        log('advance', { from: clock, to: at, ...(fired ? { fired } : {}) });
        host.moves = (host.moves ?? 0) + 1;
        clock = at;
        standin.setClock(clock);
        return fired;
      },
      settle,
      decision,
      now: () => clock,
    });
  }

  function decisionOf(step) {
    let timer;
    try { timer = decisionTimer(step, { configuration: recipeOf, facts, added: addedRules(steps, step) }); } catch (e) {
      fail({ step: step.id, reason: `step ${step.id}: ${e.message}` });
      throw new RunFailure('no decision timer');
    }
    if (!timer) return null;
    return step.verdict
      ? { timer, what: `rule ${step.verdict}'s reply judge`, made: (e) => e.type === 'gate:judge-verdict' && e.policyName === step.verdict, waiting: (step.verdicts ?? 1) === 1 ? `the reply judge's verdict on rule ${step.verdict}'s batch` : `the reply judge's ${step.verdicts} verdicts on rule ${step.verdict}'s batches` }
      : { timer, what: 'the suppression review', made: (e) => e.type === 'gate:suppression-review', waiting: 'the suppression review\'s end' };
  }

  async function advance(step) {
    await settle();
    const from = host.events.length;
    const decision = decisionOf(step);
    const { decided } = await moveClock(step.ms, decision && {
      timer: decision.timer,
      made: () => until(() => host.events.slice(from).filter(({ e }) => decision.made(e)).length >= (step.verdicts ?? 1), TURN_MS, `step ${step.id}: ${decision.waiting}`),
      turns: () => gateTurns(step, from),
    });
    if (decision && !decided) {
      fail({ step: step.id, reason: `step ${step.id}: the clock moved the step's ${step.ms} ms without firing the timer that starts ${decision.what} (${JSON.stringify(decision.timer)})` });
      throw new RunFailure('undecided');
    }
    await gateTurns(step, from, { settled: !decision });
  }

  async function health(id, what) {
    await settle({ drained: what });
    const corrId = `${id}:health`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op: 'health', corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `${what}: the health panel`)).e;
  }

  async function checkpoint(step, last) {
    log('checkpoint', { name: step.name, health: await health(step.id, `checkpoint ${step.id}`) });
    if (!step.copyStore) return;
    await shutdown();
    const dest = join(work, 'copies', step.name ?? step.id);
    rmSync(dest, { recursive: true, force: true });
    cpSync(storeDir, dest, { recursive: true });
    const sessions = existsSync(join(dest, 'sessions')) ? readdirSync(join(dest, 'sessions')).map((id) => join(dest, 'sessions', id)) : [];
    copies.push({ step: step.id, name: step.name, path: dest, sessions, clock });
    log('copy', { path: dest, sessions });
    if (!last) await boot(step.gapMs ?? RESTART_MS);
  }

  // The host ends at once, without a shutdown, as a crash ends it (the harness module's `crash` op), so a fleet parent's
  // children live on for its next boot to adopt (connectome-host docs/fleet-protocol.md §4.5).
  async function crash(step) {
    await settle({ drained: `crash ${step.id}` });
    const b = host;
    await lastTake({ boot: b.n, take: takeCompiles, log, fail, step: step.id });
    host = null;
    b.stopping = true;
    const answer = await ctl.moduleRequest('crash', {}, { timeoutMs: COMMAND_MS }).catch((e) => ({ unanswered: errorText(e) }));
    const ended = await exitWithin(b.child, SHUTDOWN_MS, b.reach);
    if (!ended) { b.killed = true; stopHost(b.child); await exitWithin(b.child, SHUTDOWN_MS); }
    try { b.sock?.destroy(); } catch {}
    b.webui?.close();
    // connectome-host's fleet module starts each child in a process group of its own.
    b.killed = true;
    stopHost(b.child);
    if (b.reach) {
      reads.push({ boot: b.n, ...await b.reach.atExit });
      b.reach.close();
    }
    try { writeFileSync(join(hostLogs.dir, `host-${b.n}.log`), b.out.join('')); } catch (e) {
      fail({ step: step.id, reason: `boot ${b.n}: the host's log couldn't be written: ${e.message}` });
    }
    log('crash', { boot: b.n, answer, exited: b.exited ?? null, timedOut: !ended, hostLog: hostLogOf(b) });
    if (!ended) {
      fail({ step: step.id, reason: `the crash step's host was still running ${SHUTDOWN_MS} ms after its crash op, so it was killed and crashed nothing; the op answered ${JSON.stringify(answer)}` });
      throw new RunFailure('crash');
    }
    await boot();
  }

  async function restart(step) {
    await settle({ drained: `restart ${step.id}` });
    const agent = agentName;
    const dry = async () => ({ boot: host.n, seq: (await ctl.moduleRequest('dry-compile', { agent })).seq });
    const before = step.reloadCheck ? await dry() : null;
    const patch = step.agent ? await resolveMessages(step.agent) : null;
    await shutdown();
    if (patch) {
      const { strategy, ...rest } = patch;
      recipeOf = { ...recipeOf, agent: { ...recipeOf.agent, ...rest, ...(strategy ? { strategy: { ...recipeOf.agent?.strategy, ...strategy } } : {}) } };
      log('recipe', { agent: patch });
    }
    await boot();
    if (!step.reloadCheck) return;
    await settle({ drained: `restart ${step.id}'s reload check` });
    const after = await dry();
    await takeCompiles();
    log('reload', { agent, before, after });
  }

  async function moduleRead(op, params) {
    return unlessFailed(ctl.moduleRequest(op, params, { timeoutMs: COMMAND_MS }));
  }

  async function stored(which) {
    const messages = await moduleRead('messages', { agent: agentName });
    const all = messages?.messages ?? messages ?? [];
    let found;
    if (which.canary !== undefined) found = all.find((m) => (m.canaries ?? []).includes(which.canary));
    else {
      const from = Math.min(all.length - 1, Math.floor(all.length * which.storeAt));
      const plain = (m) => !m.bodyGroupId && m.metadata?.system !== true;
      found = all.slice(from).find((m) => plain(m) && (!which.withBlock || m.blocks.some((b) => b.type === which.withBlock)));
    }
    if (!found) {
      fail({ step: current?.id ?? null, reason: `no stored message is ${JSON.stringify(which)}` });
      throw new RunFailure('no such message');
    }
    return found;
  }

  let panelRequests = 0;
  async function panelRequest(op, params) {
    const corrId = `${current?.id ?? 'run'}:panel:${++panelRequests}`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op, params, corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `panel ${op}`)).e;
  }

  async function pinId(name) {
    const answer = await panelRequest('pins', {});
    const pin = (answer.data?.pins ?? []).find((p) => p.name === name);
    if (!pin) {
      fail({ step: current?.id ?? null, reason: `the panel lists no pin named ${JSON.stringify(name)}` });
      throw new RunFailure('no such pin');
    }
    return pin.id;
  }

  async function resolveMessages(value) {
    if (Array.isArray(value)) return Promise.all(value.map(resolveMessages));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'canary') return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'sequenceOf') return (await stored({ canary: value.sequenceOf })).sequence;
    if (keys.includes('storeAt') && keys.every((k) => k === 'storeAt' || k === 'withBlock')) return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'pin') return pinId(value.pin);
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveMessages(v)])));
  }

  async function panel(step) {
    const params = await resolveMessages(step.params ?? {});
    log('send', { via: 'panel', op: step.op, params });
    let answer = await panelRequest(step.op, params);
    log('panel', { op: step.op, response: answer });
    for (let attempt = 0; step.edge && answer.ok !== true && attempt < 4; attempt++) {
      const floor = /folded floor renders (\d+) tokens/.exec(String(answer.error ?? ''));
      if (!floor) break;
      const lowest = Math.ceil((Number(floor[1]) + step.edge.reserve) * 1.01 / 1000) * 1000;
      log('send', { via: 'panel', op: step.op, params: { ...params, contextBudgetTokens: lowest }, edge: Number(floor[1]) });
      answer = await panelRequest(step.op, { ...params, contextBudgetTokens: lowest });
      log('panel', { op: step.op, response: answer });
    }
    const expected = (step.expect ?? 'ok') === 'ok';
    const ok = answer.ok === true && answer.data?.warning === undefined;
    if (ok !== expected) {
      fail({ step: step.id, reason: `the panel's ${step.op} answered ${ok ? 'ok' : `not ok (${answer.data?.warning ?? answer.error ?? answer.status ?? 'no reason given'})`}, where the step expects ${step.expect ?? 'ok'}` });
      throw new RunFailure('panel');
    }
    await settle();
  }

  async function webui() {
    if (host.webui) return host.webui;
    const line = host.out.join('').match(WEBUI_LISTENING);
    if (!line) throw new RunFailure(`the host logged no "[webui] listening on" line, so the web UI isn't on in this recipe`);
    host.webui = await unlessFailed(openWebUi({ url: line[1], basicAuth: configuration.modules?.webui?.basicAuth ?? null, timeoutMs: COMMAND_MS }));
    return host.webui;
  }

  const fromHeld = (messages, request) => messages.map((m) => {
    if (!m || typeof m !== 'object' || !('fromHeld' in m)) return m;
    const canary = request?.canaries?.at(m.fromHeld);
    if (canary === undefined) {
      fail({ step: current?.id ?? null, reason: `no held request's slice gives a canary at ${m.fromHeld} (${request ? `${request.id}'s slice carries ${request.canaries?.length ?? 0}` : 'nothing is held'})` });
      throw new RunFailure('no such held canary');
    }
    return { canary };
  });

  let suppressions = 0;
  async function suppress(step) {
    const messageIds = await resolveMessages(step.messages);
    const ui = await webui();
    const corrId = `${step.id}:suppress:${++suppressions}`;
    log('send', { via: 'webui', op: 'suppress', messageIds });
    ui.send({ type: 'suppress', messageIds, sessionId: ui.welcome.session.id, corrId });
    const result = await unlessFailed(ui.next((m) => m.type === 'surgery-result' && m.corrId === corrId, { label: `the suppress result for ${corrId}` }));
    log('suppress', { result });
    if (result.ok !== true) {
      const said = cutText((cut) => `the web UI's suppress failed: ${result.error ?? cut(JSON.stringify(result), 500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure('suppress');
    }
    await settle();
  }

  async function hostCommand(step) {
    const from = host.events.length;
    log('send', { via: 'fixture', host: step.host });
    const answer = await unlessFailed(ctl.hostCommand(step.host, { timeoutMs: COMMAND_MS }));
    log('host', { answer });
    if (answer?.ok !== true) {
      const said = cutText((cut) => `the host answered ${step.host.command} with ${cut(JSON.stringify(answer), 500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(`host command ${step.host.command}`);
    }
    await until(() => eventAfter(from, (e) => e.agentName === agentName && e.type === 'inference:started'), TURN_MS, `step ${step.id}: the turn ${step.host.command} starts`);
    await gateTurns(step, from);
  }

  let configWatch;
  let harnessFailure = null;
  const watchOfConfig = (where) => {
    if (configWatch === undefined) { try { configWatch = configWatched({ hostDir, configuration }); } catch (e) { if (e instanceof HarnessFailure) harnessFailure = e; configWatch = e; } }
    if (configWatch instanceof Error) throw new RunFailure(`${where}: ${configWatch.message}`);
    return configWatch;
  };
  const unowed = (where, events, owed) => {
    const left = unowedConfigEchoes(events, owed);
    if (left.length) throw new RunFailure(`${where}: the workspace reported ${left.join(', ')} in the watched _config mount, which no traced gate write in it and no first boot's start owes, so it landed wherever real time put it`);
  };
  const judgedNow = (h) => { h.judged = h.events.length; h.judgedMoves = h.moves ?? 0; };
  const recipeWorkspace = () => typeof recipeOf.modules?.workspace === 'object' && recipeOf.modules.workspace !== null;
  async function configEcho(step) {
    let current = null;
    for (const w of echoWindows({ host, stepHost })) {
      if (w.host === host) { current = w; continue; }
      unowed(`step ${step.id}`, w.host.events.slice(w.from).map(({ e }) => e));
      judgedNow(w.host);
    }
    if (!current) return;
    const { from } = current;
    const events = () => host.events.slice(from).map(({ e }) => e);
    const echo = () => configWriteEcho(events());
    const write = echo();
    const watch = write.wrote && recipeWorkspace() ? watchOfConfig(`step ${step.id}`) : null;
    if (watch) {
      if (movedSinceJudged(host)) throw new RunFailure(`step ${step.id}: the driver moved the clock in a step whose host traced a gate write to ${write.path}, and a move is what lets chokidar settle such a write, so its echo would land wherever real time put it among what the move brings; a gate-writing step moves the clock only by the write's own settle`);
      let owed;
      try { owed = echoOwed(write.file, watch.include); } catch (e) { throw new RunFailure(`step ${step.id}: ${e.message}`); }
      if (owed && !write.echoed) {
        const noticed = notices.length;
        await unlessFailed(ctl.expectStat(write.file));
        await until(() => notices.slice(noticed).some((n) => n.peer === 'clock' && n.notice === 'stat' && n.path === write.file), TURN_MS, `step ${step.id}: chokidar's settle poll of ${write.path}, a callback fs.stat of ${write.file} (${chokidarVersion(hostDir)}); a chokidar that settles a write some other way sends none`);
        await moveClock(WRITE_SETTLE_MS);
        await until(() => echo().echoed, TURN_MS, `step ${step.id}: the workspace's change for ${write.path} once chokidar has settled the gate's write to it, processed`);
        await settle();
      }
    }
    unowed(`step ${step.id}`, events());
    judgedNow(host);
  }

  function configEnd() {
    for (const w of echoWindows({ host })) {
      unowed('the run\'s end', w.host.events.slice(w.from).map(({ e }) => e));
      judgedNow(w.host);
    }
  }

  async function configBootEcho(b, fresh) {
    const events = () => b.events.map(({ e }) => e);
    let owed = [];
    if (fresh && recipeWorkspace()) {
      const watch = watchOfConfig(`boot ${b.n}`);
      if (watch) {
        const mounted = await until(() => events().find((e) => e.type === 'process:received' && e.processEvent?.type === 'workspace:mounted' && e.processEvent.mount === '_config'), TURN_MS, `boot ${b.n}: the workspace's mount of _config`);
        let listing;
        try { listing = readdirSync(mounted.processEvent.path); } catch (e) { throw new RunFailure(`boot ${b.n}: couldn't list the _config mount's directory ${mounted.processEvent.path}: ${e.message}`); }
        try { owed = bootEchoesOwed(listing, watch.include); } catch (e) { throw new RunFailure(`boot ${b.n}: ${e.message}`); }
        if (owed.length) {
          await until(() => owed.every((p) => events().some((e) => echoDone(e, p))), TURN_MS, `boot ${b.n}: the workspace's catch-up of ${owed.join(', ')}, which the gate's start left in the watched _config mount, processed`);
          await settle();
        }
      }
    }
    unowed(`boot ${b.n}`, events(), owed);
    judgedNow(b);
  }

  const absent = async (step) => log('absent', { stretch: step.stretch });
  const relisted = async () => {
    log('send', { via: 'relist' });
    await unlessFailed(ctl.relist({ timeoutMs: COMMAND_MS }));
  };
  const KINDS = { channel: channelTurn, deliver, push: pushed, console: typed, file, command, advance, restart, crash, panel, suppress, absent, relist: relisted, host: hostCommand };
  let stepEnded = true;
  try {
    await boot();
    for (const [i, step] of steps.entries()) {
      endStep(true);
      stepEnded = false;
      watch.stepStarted();
      current = step;
      stepFrom = host.events.length;
      stepHost = host;
      readerHolds = [];
      budgetSkipped = null;
      standin.setStep(step);
      const started = performance.now();
      if (step.kind === 'checkpoint') await checkpoint(step, i === steps.length - 1);
      else if (KINDS[step.kind]) await KINDS[step.kind](step);
      else { fail({ step: step.id, reason: `the driver has no step kind ${JSON.stringify(step.kind)}` }); throw new RunFailure('unknown kind'); }
      const many = host && readerHolds.map((r) => subagentResult(host.events, r, stepFrom)).find((v) => typeof v === 'string');
      if (many) { fail({ step: step.id, reason: `step ${step.id}: ${many}` }); throw new RunFailure('reader forks'); }
      if (budgetSkipped !== null && host && budgetHeld(host.events, stepFrom, agentName)) {
        fail({ step: step.id, reason: lateBudgetHold(step.id, agentName, budgetHeldAt(host.events, stepFrom, agentName) - budgetSkipped) });
        throw new RunFailure('budget hold after its summariser request');
      }
      await configEcho(step);
      // connectome-host makes a fork of `conversations` at its channel's first message, after the boot's `/budget`, which
      // lists every agent there is (commands.ts handleBudget), so a run that judges a fork reads its bound again after
      // each step.
      if (configuration.judges === 'fork' && host) await budgetReport(host, { fork: true });
      for (const read of step.reads ?? []) {
        const { op, ...params } = typeof read === 'string' ? { op: read } : read;
        log('read', { op, ...(Object.keys(params).length ? { params } : {}), answer: await moduleRead(op, { agent: agentName, ...params }) });
      }
      timing.steps.push({ id: step.id, kind: step.kind, ms: Math.round(performance.now() - started) });
      stepEnded = true;
      watch.stepEnded();
    }
    if (host) {
      log('health', { name: 'end', health: await health('end', 'the run\'s end') });
      configEnd();
    } else log('health', { name: 'end', skipped: 'the run\'s last step stopped its host' });
  } catch (e) {
    const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 3000));
    if (!failure) fail({ step: current?.id ?? null, reason: c.shown, ...(c.full ? { full: c.full } : {}) });
    if (host) log('host-output', { boot: host.n, hostLog: hostLogOf(host), tail: tail(host.out) });
  } finally {
    try {
      try { await shutdown(); } finally {
        if (childReach?.size) await childReach.stop();
      }
    } finally {
      if (groupsFile) await endFleetGroups({ file: groupsFile, fail, log, unlist });
    }
    endStep(stepEnded);
    await ctl.close();
    ended = true;
    log('end', { ok: !failure, clockEnd: clock });
  }
  if (harnessFailure) throw harnessFailure;
  return { ok: !failure, failure, clockEnd: clock, copies, timing, signalled, ...(reach ? { reads } : {}) };
}

const tail = (out) => out.join('').split('\n').slice(-30).join('\n');
