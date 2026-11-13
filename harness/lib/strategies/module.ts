import { AsyncLocalStorage } from 'node:async_hooks';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { FIXTURE_AGENT, readerForkOf } from './checks.ts';
import { lineReader } from './control.ts';
import { isUnreadable, readable, storedMessages } from './invariants.ts';
import { cutError } from '../cut/interfaces.ts';
import { agentRecords, primaryAgentName } from './older.ts';
import { namingCanaries, messageNames } from './names.ts';
import { blobStore, compiledLine, messagesOf, plain, refusedLine, stateOf, storeDelta } from './recorder.ts';
import type { ElsewhereRead, Manager as StoreReader, Stored } from './invariants.ts';
import type { Blobs, CompiledBody, RefusedBody, Seen, StoreDelta, Strategy as RecordedStrategy } from './recorder.ts';

export type Ticks = Record<string, number | null>;
type HeldAgent = { name: unknown; status: unknown; primaryActive: unknown; auxiliaryInFlight: unknown; cooldownUntil: unknown; heldRequests: unknown; budgetHold: unknown };
export type HeldReadout =
  | { why: string; pendingRequests?: undefined; activeStreams?: undefined; agents?: undefined }
  | { pendingRequests: unknown; activeStreams: unknown; agents: HeldAgent[]; why?: undefined };
type ChildReadout = { name: unknown; status: unknown; pid: unknown };
export type FleetReadout =
  | { moved: string; children?: undefined }
  | { children: ChildReadout[]; moved?: undefined };

type Unrecordable = {
  outcome: 'unrecordable';
  reason: string;
  full?: string;
  messages?: undefined;
  system?: undefined;
  layout?: undefined;
  stats?: undefined;
  violations?: undefined;
  unjudged?: undefined;
  slots?: undefined;
  error?: undefined;
};
type Head = {
  seq: number;
  agent: string | null;
  kind: 'dry' | 'request' | 'other';
  assembly?: number;
  dry: boolean;
  budget: unknown;
  by?: string;
  lacks?: 'storableToolCall' | 'logicalTurnAlive';
  alive?: true;
  stamp?: string;
};
export type CompileLine = Head & (CompiledBody | RefusedBody | Unrecordable);

type Marked<F> = F & { [WRAPPED]?: boolean };
type Answer = Partial<PromiseLike<unknown>> | null | undefined;
type Strategy = RecordedStrategy & {
  tick?(...args: unknown[]): unknown;
  beginKvUnifiedSubmission?(args: { submissionId?: unknown } | null | undefined, ...rest: unknown[]): unknown;
};
type Compile = (this: Manager, budget?: unknown, injections?: unknown, opts?: { dryRun?: unknown } | null) => Promise<Parameters<typeof compiledLine>[2]>;
type Add = (this: Manager, ...args: unknown[]) => unknown;
type Manager = Omit<StoreReader, 'getStrategy'> & {
  getStrategy(): Strategy | null | undefined;
  getMaxSummaryLevel(): unknown;
  getDerivation?(): { branch?: unknown } | null | undefined;
  compile(...args: Parameters<Compile>): ReturnType<Compile>;
  addMessage?(...args: unknown[]): unknown;
};
type Agent = { name: unknown; getContextManager(): Manager; compileBudget?(): unknown };
type ToolCall = { callerAgentName?: unknown } | null | undefined;
type Framework = NonNullable<Parameters<typeof agentRecords>[0]> & {
  getAgent(name: string): Agent | null | undefined;
  logicalTurnAlive?(agent: Agent): unknown;
  moduleRegistry?: unknown;
  eventGate?: { getStatus?(): { policies?: unknown } | null | undefined } | null;
  getContextMaintenanceSnapshot?(): { agents?: unknown } | null | undefined;
  getHostModeStatus?(): unknown;
  getModule?(name: string): { getChildren?(): unknown } | null | undefined;
  healthSnapshot?(): unknown;
};
type Policy = { name?: unknown; judgeState?: { judging?: unknown } | null } | null | undefined;
type Health = {
  pendingRequests?: unknown;
  activeStreams?: unknown;
  agents?: Array<{ name?: unknown; status?: unknown; providerAdmission?: { primaryActive?: unknown; auxiliaryInFlight?: unknown; cooldownUntil?: unknown; heldRequests?: unknown } | null; budgetHold?: unknown }> | null;
};
type Child = { name?: unknown; status?: unknown; pid?: unknown };
type Caller = { agent: string; manager: Manager; assembly?: number; tool?: true; open: boolean };
type Request = { id?: unknown; op?: unknown; agent?: unknown; messageId?: unknown; budget?: unknown };
type Taken = { lines: CompileLine[]; store: Record<string, StoreDelta>; blobs: ReturnType<Blobs['take']>; submissions?: string[] };
export type Snapshot = { ticks: Ticks; agents: {} | null; hostMode: {} | null; unread?: string };
export type ModuleAnswers = { take: Taken; snapshot: Snapshot; messages: ReturnType<typeof messagesOf>; 'dry-compile': { seq: number | null }; held: HeldReadout; fleet: FleetReadout };
type ModuleContext = { removeMessage(messageId: unknown): unknown };

const CALLER = new AsyncLocalStorage<Caller>();
// Each request compile is stamped from CLOCK_MONOTONIC, the clock the driver's Node reads for process.hrtime on Linux
// (libuv's uv_hrtime), so the stand-in's arrival stamps order against it. Bun's process.hrtime counts from its own
// start, and elsewhere than Linux libuv reads another clock, so there the compile goes unstamped and unjudged.
const monotonic = await (async () => {
  if (typeof Bun === 'undefined') return () => process.hrtime.bigint();
  if (process.platform !== 'linux') return () => null;
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const { symbols } = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const ts = new BigInt64Array(2);
    return () => (symbols.clock_gettime(1, ptr(ts)) === 0 ? ts[0] * 1_000_000_000n + ts[1] : null);
  } catch {
    return () => null;
  }
})();
const WRAPPED: unique symbol = Symbol.for('connectome-host.whole-host.wrapped');
const AGENT_COMPILES = ['compileWithInjections', 'compileContext'] as const;
// context-manager's compile takes this budget when it's given none (context-manager.ts `compile`).
const DEFAULT_BUDGET = { maxTokens: 100000, reserveForResponse: 4000 };

export const tuneOutHolds = (agent: unknown) => agent === FIXTURE_AGENT || readerForkOf(agent);

export function register(api: { registerModule(factory: () => HarnessModule): unknown }) {
  api.registerModule(() => new HarnessModule(process.env.FIXTURE_CONTROL, { record: process.env.FIXTURE_RECORD !== 'off', tunedOut: JSON.parse(process.env.FIXTURE_TUNED_OUT ?? '[]') }));
}

export class HarnessModule {
  declare name: string;
  declare controlPath: string | null | undefined;
  declare recording: boolean;
  declare tunedOut: Map<string, string | null | undefined>;
  declare framework: Framework | null;
  declare sock: Socket | null;
  declare lines: CompileLine[];
  declare seq: number;
  declare assemblies: number;
  declare blobs: Blobs;
  declare ticks: WeakMap<Strategy, { inFlight: number }>;
  declare submitting: WeakSet<Strategy>;
  declare submissions: string[];
  declare agentOf: WeakMap<Manager, string>;
  declare seen: Map<string, Seen>;
  declare managers: Map<string, Manager>;
  declare watching: Set<Manager>;
  declare ctx?: ModuleContext;
  declare toolCalls?: boolean;

  constructor(controlPath: string | null | undefined, { record = true, tunedOut = [] }: { record?: boolean; tunedOut?: Iterable<readonly [string, string | null | undefined]> } = {}) {
    this.name = 'whole-host-harness';
    this.controlPath = controlPath;
    this.recording = record;
    this.tunedOut = new Map(tunedOut);
    this.framework = null;
    this.sock = null;
    this.lines = [];
    this.seq = 0;
    this.assemblies = 0;
    this.blobs = blobStore();
    this.ticks = new WeakMap();
    this.submitting = new WeakSet();
    this.submissions = [];
    this.agentOf = new WeakMap();
    this.seen = new Map();
    this.managers = new Map();
    this.watching = new Set();
  }

  async start(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  async stop() {
    this.sock?.destroy();
    this.sock = null;
  }

  getTools() {
    return [];
  }

  async handleToolCall(call: { name?: unknown } | null | undefined) {
    return { success: false, isError: true, error: `There's no tool ${JSON.stringify(call?.name)}, so nothing ran: the whole-host harness module offers none.` };
  }

  async onProcess() {
    return {};
  }

  setFramework(framework: Framework) {
    if (!this.controlPath) {
      console.warn('[whole-host-harness] FIXTURE_CONTROL is unset, so the harness module records nothing');
      return;
    }
    this.framework = framework;
    const primary = primaryAgentName(framework);
    const agent = primary === null ? null : framework.getAgent(primary);
    if (!agent) throw new Error(`the whole-host harness module found no primary agent to record (getPrimaryAgentName() is ${JSON.stringify(primary)})`);
    if (this.recording) this.wrapAgentCompiles(Object.getPrototypeOf(agent));
    this.wrapManagerCompile(Object.getPrototypeOf(agent.getContextManager()));
    if (this.recording) this.toolCalls = this.wrapToolCalls(framework.moduleRegistry);
    this.watchTicks(agent.getContextManager());
    this.connect();
  }

  wrapAgentCompiles(proto: { [M in (typeof AGENT_COMPILES)[number]]?: Marked<(this: Agent, ...args: unknown[]) => Answer> }) {
    const module = this;
    for (const method of AGENT_COMPILES) {
      const original = proto[method];
      if (typeof original !== 'function' || original[WRAPPED]) continue;
      const wrapped = function (this: Agent, ...args: unknown[]) {
        const caller: Caller = { agent: this.name as string, manager: this.getContextManager(), assembly: ++module.assemblies, open: true };
        const close = () => { caller.open = false; };
        const result = CALLER.run(caller, () => original.apply(this, args));
        if (result && typeof result.then === 'function') result.then(close, close);
        else close();
        return result;
      };
      wrapped[WRAPPED] = true;
      proto[method] = wrapped;
    }
  }

  turnAlive(name: string) {
    const agent = this.framework?.getAgent(name);
    return agent ? this.framework!.logicalTurnAlive!(agent) === true : false;
  }

  wrapToolCalls(registry: unknown) {
    const module = this;
    const proto: { storableToolCall?: Marked<(this: unknown, call: ToolCall, ...rest: unknown[]) => Answer> } | null = registry ? Object.getPrototypeOf(registry) : null;
    const original = proto?.storableToolCall;
    if (typeof original !== 'function') return false;
    if (original[WRAPPED]) return true;
    const wrapped = function (this: unknown, call: ToolCall, ...rest: unknown[]) {
      const name = call?.callerAgentName;
      const agent = typeof name === 'string' ? module.framework?.getAgent(name) : null;
      if (!agent) return original.call(this, call, ...rest);
      const caller: Caller = { agent: name as string, manager: agent.getContextManager(), tool: true, open: true };
      const close = () => { caller.open = false; };
      const result = CALLER.run(caller, () => original.call(this, call, ...rest));
      if (result && typeof result.then === 'function') result.then(close, close);
      else close();
      return result;
    };
    wrapped[WRAPPED] = true;
    proto!.storableToolCall = wrapped;
    return true;
  }

  wrapManagerCompile(proto: { compile?: Marked<Compile>; addMessage?: Marked<Add> }) {
    const module = this;
    const original = proto.compile;
    if (typeof original !== 'function' || original[WRAPPED]) return;
    const wrapped = async function (this: Manager, ...args: Parameters<Compile>) {
      module.watchTicks(this);
      if (!module.recording) return original.apply(this, args);
      const [budget, , opts] = args;
      const caller = CALLER.getStore();
      const own = caller?.manager === this && caller.open && !caller.tool;
      const dry = opts?.dryRun === true;
      const open = caller?.open ? caller : null;
      const by = dry && open?.tool && open.manager !== this ? open.agent : null;
      const head: Head = {
        seq: ++module.seq,
        agent: module.agentName(this, own ? caller : null),
        kind: dry ? 'dry' : own ? 'request' : 'other',
        ...(own ? { assembly: caller.assembly } satisfies Partial<Head> : {}),
        dry,
        budget: budget === undefined ? null : plain(budget),
        ...(by ? { by } satisfies Partial<Head> : {}),
      };
      if (dry && module.toolCalls === false) head.lacks = 'storableToolCall';
      else if (dry && !open && head.agent !== null && typeof module.framework?.logicalTurnAlive !== 'function') head.lacks = 'logicalTurnAlive';
      else if (dry && !open && head.agent !== null && module.turnAlive(head.agent)) head.alive = true;
      if (head.agent !== null) module.managers.set(head.agent, this);
      let result: Awaited<ReturnType<Compile>>;
      try {
        result = await original.apply(this, args);
      } catch (error) {
        module.record(head, () => refusedLine(error as Parameters<typeof refusedLine>[0], module.blobs));
        throw error;
      }
      const line = module.record(head, () => compiledLine(this, (budget ?? DEFAULT_BUDGET) as Parameters<typeof compiledLine>[1], result, module.blobs, (ids) => module.elsewhere(this, ids), { resident: tuneOutHolds(head.agent), tunedOut: module.tunedOut }));
      if (own && !dry) line.stamp = String(monotonic());
      return result;
    };
    wrapped[WRAPPED] = true;
    proto.compile = wrapped;
    const add = proto.addMessage;
    if (typeof add === 'function' && !add[WRAPPED]) {
      const watchedAdd = function (this: Manager, ...args: unknown[]) {
        module.watchTicks(this);
        return add.apply(this, args);
      };
      watchedAdd[WRAPPED] = true;
      proto.addMessage = watchedAdd;
    }
  }

  record(head: Head, body: () => CompiledBody | RefusedBody) {
    let line: CompileLine;
    try {
      line = { ...head, ...body() };
    } catch (error) {
      const { shown, full } = cutError(error, 300);
      line = { ...head, outcome: 'unrecordable', reason: shown, ...(full ? { full } satisfies Partial<Unrecordable> : {}) };
    }
    this.lines.push(line);
    return line;
  }


  watchSubmissions(strategy: Strategy | null | undefined) {
    if (!strategy || this.submitting.has(strategy) || typeof strategy.beginKvUnifiedSubmission !== 'function') return;
    this.submitting.add(strategy);
    const begin = strategy.beginKvUnifiedSubmission.bind(strategy);
    strategy.beginKvUnifiedSubmission = (args, ...rest) => {
      const result = begin(args, ...rest);
      this.submissions.push(String(args?.submissionId));
      return result;
    };
  }

  watchTicks(manager: Manager) {
    let strategy;
    try { strategy = manager.getStrategy(); } catch { return; }
    this.watching.add(manager);
    if (this.recording) this.watchSubmissions(strategy);
    if (!strategy || this.ticks.has(strategy) || typeof strategy.tick !== 'function') return;
    const counter = { inFlight: 0 };
    this.ticks.set(strategy, counter);
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (...args) => {
      counter.inFlight++;
      let p;
      try { p = tick(...args); } catch (error) { counter.inFlight--; throw error; }
      return Promise.resolve(p).finally(() => { counter.inFlight--; });
    };
  }

  elsewhere(manager: Manager, ids: string[]) {
    const wanted = new Set(ids);
    const found: Stored[] = [];
    const from: Array<string | null> = [];
    const holders: Array<{ messages: Stored[]; agent: string | null }> = [];
    const others = new Set(this.managers.values());
    for (const record of agentRecords(this.framework)) {
      const agent = this.framework!.getAgent(record.name);
      if (agent) others.add(agent.getContextManager());
    }
    others.delete(manager);
    // In context-manager, a derived context (a fork) writes its own branch, and a view merges slots on the compiling
    // manager's branch.
    const derivation = (m: Manager) => readable(() => m.getDerivation?.() ?? null);
    const failed = [];
    const own = derivation(manager);
    if (isUnreadable(own)) failed.push(`the compiling agent's derivation: ${own.unreadable}`);
    const branch = isUnreadable(own) ? undefined : own?.branch ?? null;
    for (const other of others) {
      if (branch === undefined || !wanted.size) break;
      const named = this.agentName(other, null) ?? 'an agent';
      const d = derivation(other);
      if (isUnreadable(d)) { failed.push(`${named}'s derivation: ${d.unreadable}`); continue; }
      if ((d?.branch ?? null) !== branch) continue;
      const messages = storedMessages(other);
      if (isUnreadable(messages)) { failed.push(`${named}'s messages: ${messages.unreadable}`); continue; }
      const before = found.length;
      for (const m of messages) if (wanted.delete(String(m.id))) found.push(m);
      if (found.length > before) {
        from.push(this.agentName(other, null));
        holders.push({ messages, agent: this.agentName(other, null) });
      }
    }
    const named = new Map<(typeof holders)[number], (id: unknown) => string | null>();
    const nameOf = (id: string) => {
      const holder = holders.find(({ messages }) => messages.some((m) => String(m.id) === id));
      if (!holder) return null;
      if (!named.has(holder)) {
        const byId = new Map(holder.messages.map((m) => [String(m.id), m]));
        named.set(holder, messageNames([...byId.keys()], (x) => namingCanaries(byId.get(x)!.content)[0]));
      }
      return `${holder.agent ?? '?'}/${named.get(holder)!(id)}`;
    };
    return { found, unfound: [...wanted], from: from.filter(Boolean) as string[], nameOf, ...(failed.length ? { failed } satisfies ElsewhereRead : {}) } satisfies ElsewhereRead;
  }

  ticksInFlight(manager: Manager) {
    try { return this.ticks.get(manager.getStrategy()!)?.inFlight ?? 0; } catch { return null; }
  }

  agentName(manager: Manager, caller: Caller | null | undefined) {
    if (caller) return caller.agent;
    const known = this.agentOf.get(manager);
    if (known) return known;
    for (const record of agentRecords(this.framework, { includeEnded: true })) {
      const agent = this.framework!.getAgent(record.name);
      if (agent && agent.getContextManager() === manager) {
        this.agentOf.set(manager, record.name);
        return record.name;
      }
    }
    return null;
  }

  agentNamed(name: unknown) {
    const agent = this.framework?.getAgent(String(name));
    if (!agent) throw Object.assign(new Error(`no agent ${JSON.stringify(name)} is running`), { code: -32602 });
    return agent;
  }

  managerOf(name: unknown) {
    return this.agentNamed(name).getContextManager();
  }

  connect() {
    const sock = connect(this.controlPath!, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'module', pid: process.pid })}\n`));
    sock.unref();
    sock.on('error', (e) => console.error(`[whole-host-harness] control socket ${this.controlPath}: ${e.message}`));
    lineReader<Request | null>(sock, (msg) => {
      if (msg?.id === undefined || typeof msg.op !== 'string') return;
      Promise.resolve()
        .then(() => this.answer(msg))
        .then((result) => ({ id: msg.id, result }), (error) => ({ id: msg.id, error: { code: error?.code ?? -32000, message: String(error?.message ?? error) } }))
        .then((reply) => sock.write(`${JSON.stringify(reply)}\n`));
    });
    this.sock = sock;
  }

  takeDelta(store: Record<string, StoreDelta>, name: string, manager: Manager) {
    const delta = storeDelta(manager, this.seen.get(name), this.blobs);
    this.seen.set(name, delta.seen);
    if (delta.changed) store[name] = delta.out;
    return delta.unread;
  }

  answer<Op extends keyof ModuleAnswers>(msg: Request & { op: Op }): Promise<ModuleAnswers[Op]>;
  answer(msg: Request): Promise<unknown>;
  async answer(msg: Request) {
    switch (msg.op) {
      case 'take': {
        if (!this.recording) return { lines: [], store: {}, blobs: {} } satisfies Taken;
        const lines = this.lines;
        this.lines = [];
        const store: Record<string, StoreDelta> = {};
        const live = new Map<string, Manager>();
        for (const record of agentRecords(this.framework)) {
          const agent = this.framework!.getAgent(record.name);
          if (agent) live.set(record.name, agent.getContextManager());
        }
        // agent-framework deregisters an ephemeral agent at its run's end without closing its manager, so the
        // changes of one that compiled and has left are read from the manager kept from its compiles until its
        // ticks settle.
        for (const [name, manager] of this.managers) {
          if (live.get(name) === manager) continue;
          const unread = this.takeDelta(store, name, manager);
          if (unread || this.ticksInFlight(manager)! > 0) continue;
          this.managers.delete(name);
          this.seen.delete(name);
        }
        for (const [name, manager] of live) this.takeDelta(store, name, manager);
        const submissions = this.submissions.splice(0);
        return { lines, store, blobs: this.blobs.take(), ...(submissions.length ? { submissions } satisfies Partial<Taken> : {}) } satisfies Taken;
      }
      case 'agents':
        return (agentRecords(this.framework, { includeEnded: true })).map((r) => r.name);
      case 'snapshot': {
        const out: Ticks = {};
        const live = new Set<Manager>();
        for (const record of agentRecords(this.framework)) {
          const agent = this.framework!.getAgent(record.name);
          if (!agent) continue;
          live.add(agent.getContextManager());
          out[record.name] = this.ticksInFlight(agent.getContextManager());
        }
        // agent-framework releases an ended agent's manager without awaiting its tick, so it still counts until done.
        for (const manager of this.watching) {
          if (live.has(manager)) continue;
          const n = this.ticksInFlight(manager);
          if (n) out[`${this.agentName(manager, null) ?? 'an agent'} (ended)`] = n;
        }
        const gate = this.framework?.eventGate;
        let unread;
        if (gate) {
          if (typeof gate.getStatus !== 'function') unread = 'the gate gives no getStatus(), which says whether a reply judge decides';
          else for (const p of (gate.getStatus()?.policies ?? []) as Policy[]) {
            if (p?.judgeState === undefined) continue;
            if (typeof p.judgeState?.judging !== 'boolean') { unread = `the gate's policy ${p.name} has a judge whose state gives no boolean \`judging\``; break; }
            if (p.judgeState.judging) out[`rule ${p.name}'s judge`] = 1;
          }
        }
        const agents = this.framework?.getContextMaintenanceSnapshot?.()?.agents ?? null;
        const hostMode = this.framework?.getHostModeStatus?.() ?? null;
        return { ticks: out, agents, hostMode, ...(unread ? { unread } satisfies Partial<Snapshot> : {}) } satisfies Snapshot;
      }
      // The host ends at once, as a crash ends it: process.reallyExit skips the exit listeners, the fleet module's
      // among them, which would end its children, and reach's preload, which wraps reallyExit, still reads the host
      // where it exits (reach/reach-preload.cts).
      case 'crash': {
        setImmediate(() => (process as unknown as { reallyExit: (code: number) => never }).reallyExit(137));
        return { ending: process.pid };
      }
      case 'fleet': {
        // A fleet parent's children as its fleet module holds them (connectome-host fleet-module.ts getChildren), by
        // which the driver waits at each boot for every child to read ready.
        if (typeof this.framework?.getModule !== 'function') return { moved: 'the host\'s agent-framework gives no getModule()' } satisfies FleetReadout;
        const fleet = this.framework.getModule('fleet');
        if (typeof fleet?.getChildren !== 'function') return { moved: fleet ? 'the fleet module gives no getChildren()' : 'the host has no fleet module' } satisfies FleetReadout;
        return { children: [...(fleet.getChildren() as ReadonlyMap<unknown, Child>).values()].map((c): ChildReadout => ({ name: c.name, status: c.status, pid: c.pid ?? null })) } satisfies FleetReadout;
      }
      case 'held': {
        if (typeof this.framework?.healthSnapshot !== 'function') return { why: 'the host\'s agent-framework gives no healthSnapshot(), which says whether a turn waits on a provider hold' } satisfies HeldReadout;
        const health = this.framework.healthSnapshot() as Health;
        return {
          pendingRequests: health.pendingRequests,
          activeStreams: health.activeStreams,
          agents: (health.agents ?? []).map(({ name, status, providerAdmission: p, budgetHold }): HeldAgent => ({ name, status, primaryActive: p?.primaryActive, auxiliaryInFlight: p?.auxiliaryInFlight, cooldownUntil: p?.cooldownUntil, heldRequests: p?.heldRequests, budgetHold: budgetHold ?? null })),
        } satisfies HeldReadout;
      }
      case 'state':
        return stateOf(this.managerOf(msg.agent));
      case 'messages':
        return messagesOf(this.managerOf(msg.agent));
      case 'remove':
        this.ctx!.removeMessage(msg.messageId);
        return { removed: msg.messageId };
      case 'dry-compile': {
        // agent-framework 0.32.0's compileBudget: the budget its own request compile passes, the context budget with
        // the tool-result guard's reservation.
        const agent = this.agentNamed(msg.agent);
        const budget = msg.budget ?? (typeof agent.compileBudget === 'function' ? agent.compileBudget() : undefined);
        const before = this.seq;
        await agent.getContextManager().compile(budget, undefined, { dryRun: true }).catch(() => null);
        return { seq: this.lines.find((l) => l.seq === before + 1 && l.kind === 'dry')?.seq ?? null };
      }
      default:
        throw Object.assign(new Error(`the harness module has no op ${JSON.stringify(msg.op)}`), { code: -32601 });
    }
  }
}
