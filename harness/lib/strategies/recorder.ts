import { createHash } from 'node:crypto';
import { maskRunDir, maskRunVarying } from './compare.ts';
import { asWritten } from './control.ts';
import { canariesOf, namingCanaries } from './names.ts';
import { checkCompile, digest, isUnreadable, normalizeMessage, readSummaries, readable, sourceStrings, storedMessages } from './invariants.ts';
import type { JsonLike } from './compare.ts';
import type { Compiled, ElsewhereRead, Entry, Manager, Sent, TunedOut, Unreadable, Violation } from './invariants.ts';

export type LineEntry = Entry & { content: string; marker?: unknown };
export type CompiledBody = {
  outcome: 'compiled';
  messages: LineEntry[];
  system: string;
  layout: Record<string, unknown> | null;
  stats: unknown;
  violations: Violation[];
  unjudged?: readonly string[];
  slots?: string[];
  error?: undefined;
  reason?: undefined;
  full?: undefined;
};
export type RefusedBody = {
  outcome: 'refused';
  error: { class: unknown; message: string; fields: unknown };
  violations: never[];
  messages?: undefined;
  system?: undefined;
  layout?: undefined;
  stats?: undefined;
  unjudged?: undefined;
  slots?: undefined;
  reason?: undefined;
  full?: undefined;
};

type Read<T> = (T & { unreadable?: undefined; full?: undefined }) | Unreadable;
export type ReceiptHead = Read<{ [field: string]: unknown }> | null;
export type Quarantine = { compression: Read<string[]>; merge: Read<string[]>; unreadable?: undefined; full?: undefined } | (Unreadable & { compression?: undefined; merge?: undefined }) | null;
export type StoreDelta = {
  whole?: true;
  messages?: Read<([string, string[]] | [string, string[], { thinking: boolean }])[]>;
  removedMessages?: string[];
  summaries?: Read<{ id: string; level: number; sourceLevel: number; sources: string[]; parent: unknown; content: string }[]>;
  removed?: string[];
  receiptHead?: ReceiptHead;
  quarantine?: Quarantine;
};
export type Seen = { messages: Map<string, { thinking: boolean; canaries: string }>; summaries: Map<string, string>; head: string; quarantine: string };
export type Blobs = ReturnType<typeof blobStore>;

export type Strategy = NonNullable<ReturnType<Manager['getStrategy']>> & {
  kvUnifiedReceipts?: { head?: { sequence?: unknown; receiptHash?: unknown; parentReceiptHash?: unknown; requestHash?: unknown; layoutHash?: unknown; changes?: unknown } | string | number | boolean | null } | null;
  beginKvUnifiedSubmission?: unknown;
  getCompressionQuarantineStatus?(): { unreadable?: unknown; spans?: unknown };
  getMergeQuarantineStatus?(): { records?: unknown };
};
type Recorded = Omit<Manager, 'getStrategy'> & { getStrategy(): Strategy | null | undefined };
type Thrown = { name?: unknown; message?: unknown; constructor?: { name?: unknown } | null } | null | undefined;
type Compile = Compiled & { messages?: unknown; provenance?: { messages?: unknown } | null; systemInjections?: unknown };
type Source = { kind?: unknown; bodies?: unknown; summaries?: unknown; namespace?: unknown } | null | undefined;
type Unit = { k?: unknown; t?: unknown; p?: unknown; n?: unknown; sm?: unknown } | null | undefined;
type Change = { leafId?: unknown; value?: { repHash?: unknown; level?: unknown; lastChangedSeq?: unknown } | null } | null | undefined;
type Block = { type?: unknown; id?: unknown; name?: unknown; toolUseId?: unknown; tool_use_id?: unknown; content?: unknown; text?: unknown; thinking?: unknown } | null | undefined;
type BlockShape = { type: unknown; id?: unknown; name?: unknown; toolUseId?: unknown; content?: BlockShape[] | TextShape; chars?: number; sha256?: string | null };
type TextShape = { chars: number; sha256: string | null };

const PASSTHROUGH: readonly unknown[] = ['PassthroughStrategy', 'WindowedPassthroughStrategy'];

export function plain(value: unknown): unknown {
  if (isUnreadable(value)) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)) ?? 'null', asWritten);
}

export function untimed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untimed);
  if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /Ms$/.test(k) ? '*' : untimed(v)]));
}

export function errorClass(error: Thrown): unknown {
  if (error && typeof error.name === 'string' && error.name !== 'Error') return error.name;
  return error?.constructor?.name ?? typeof error;
}

export function compresses(manager: Pick<Manager, 'getStrategy'>): boolean | Unreadable {
  const strategy = readable(() => manager.getStrategy());
  return isUnreadable(strategy) ? strategy : !!strategy && !PASSTHROUGH.includes(strategy.constructor?.name);
}

// Nothing is masked here: agent-framework 0.32.0 mints its image-ref nonce per ledger, and a ledger lives as long as
// its process, so only the record writer, which sees every boot, can name the nonces alike across runs.
export function blobStore() {
  const sent = new Set<string>();
  let fresh = new Map<string, unknown>();
  return {
    put(value: unknown) {
      const held = maskRunDir(plain(value) as JsonLike);
      const id = digest(held);
      if (!sent.has(id) && !fresh.has(id)) fresh.set(id, held);
      return id;
    },
    take() {
      const out = Object.fromEntries(fresh);
      for (const id of fresh.keys()) sent.add(id);
      fresh = new Map();
      return out;
    },
  };
}

// context-manager 0.24.0 gives a compile's provenance a `messages` list parallel to its messages, each of these kinds
// (CompiledMessageSources) with these fields; a body that isn't complete always names what it's missing.
const SOURCE_FIELDS = {
  raw: (s: NonNullable<Source>) => Array.isArray(s.bodies) && s.bodies.every((b) => b?.messageId != null && typeof b.complete === 'boolean'
    && (b.complete || (Array.isArray(b.missing) && b.missing.length > 0 && b.missing.every((x: unknown) => x === 'shards' || x === 'content')))),
  summary: (s: NonNullable<Source>) => Array.isArray(s.summaries) && s.summaries.every((x) => typeof x?.id === 'string' && typeof x.level === 'number' && (x.partial === undefined || x.partial === true)),
  injection: (s: NonNullable<Source>) => typeof s.namespace === 'string',
  other: () => true,
};

function unreadSources(compiled: Compile) {
  const sent = (compiled?.messages ?? []) as unknown[];
  if (!compiled?.provenance || sent.length === 0) return null;
  const list = compiled.provenance.messages;
  if (!Array.isArray(list)) return `the compile's provenance gives no messages list, so its ${sent.length} messages' sources couldn't be read`;
  if (list.length !== sent.length) return `the compile's provenance gives sources for ${list.length} of its ${sent.length} messages`;
  const odd = [...new Set(list.filter((s) => !Object.hasOwn(SOURCE_FIELDS, s?.kind)).map((s) => String(s?.kind)))];
  if (odd.length) return `the compile's provenance gives sources of a kind context-manager 0.24.0 doesn't: ${odd.join(', ')}`;
  const malformed = [...new Set(list.filter((s) => !SOURCE_FIELDS[s.kind as keyof typeof SOURCE_FIELDS](s)).map((s) => s.kind))];
  return malformed.length ? `the compile's provenance gives ${malformed.join(', ')} sources without the fields context-manager 0.24.0 gives them` : null;
}

// context-manager 0.24.0's RenderedLayout: its members' ids, and units that cover them in order, each one message raw
// (`r`, its tokens `t`, `p` 1 when partial), `n` messages under summaries (`s`, each `[id, level, method, partial,
// tokens]`), or `n` messages left out (`o`).
const summaryUnit = (x: unknown) => Array.isArray(x) && x.length === 5 && typeof x[0] === 'string' && typeof x[1] === 'number'
  && typeof x[2] === 'string' && (x[3] === 0 || x[3] === 1) && typeof x[4] === 'number';
const unitCovers = (u: Unit) => (u?.k === 'r' && typeof u.t === 'number' && (u.p === undefined || u.p === 1) ? 1
  : u?.k === 'o' && Number.isInteger(u.n) && (u.n as number) >= 0 ? u.n as number
    : u?.k === 's' && Number.isInteger(u.n) && (u.n as number) >= 0 && Array.isArray(u.sm) && u.sm.every(summaryUnit) ? u.n as number : null);

function unreadLayout(layout: { memberIds?: unknown; units?: unknown } | null | undefined) {
  if (!Array.isArray(layout?.memberIds) || !Array.isArray(layout?.units)) return null;
  let covered = 0;
  for (const u of layout.units) {
    const n = unitCovers(u);
    if (n === null) return `the compile's layout has a unit context-manager 0.24.0 doesn't give: ${String(JSON.stringify(u) ?? u).slice(0, 80)}`;
    covered += n;
  }
  return covered === layout.memberIds.length ? null : `the compile's layout units cover ${covered} of its ${layout.memberIds.length} members`;
}

export function compiledLine(
  manager: Parameters<typeof checkCompile>[0],
  budget: Parameters<typeof checkCompile>[1],
  compiled: Compile,
  blobs: Pick<Blobs, 'put'>,
  elsewhere?: (ids: string[]) => ElsewhereRead,
  { resident = false, tunedOut = new Set() }: { resident?: boolean; tunedOut?: TunedOut } = {},
): CompiledBody {
  const prov = compiled?.provenance?.messages;
  const sourcesUnread = unreadSources(compiled);
  const entries = ((compiled?.messages ?? []) as Sent[]).map((m, i) => {
    const { message, marker } = normalizeMessage(m);
    const entry: LineEntry = { sources: prov && !sourcesUnread ? sourceStrings((prov as Parameters<typeof sourceStrings>[0][])[i]) : ['o'], content: blobs.put(message) };
    if (marker) entry.marker = plain(marker);
    return entry;
  });
  let slots: string[] = [];
  const reading = elsewhere && ((ids: string[]) => { const r = elsewhere(ids); slots = r.from ?? []; return r; });
  const violations = checkCompile(manager, budget, compiled, entries, { compresses: compresses(manager), elsewhere: reading, resident, tunedOut });
  if (sourcesUnread) violations.push({ invariant: 'unreadable', detail: sourcesUnread });
  const layout = compiled?.provenance?.layout;
  const layoutUnread = unreadLayout(layout);
  if (layoutUnread) violations.push({ invariant: 'unreadable', detail: layoutUnread });
  return {
    outcome: 'compiled',
    messages: entries,
    system: blobs.put(compiled?.systemInjections ?? []),
    layout: !compiled?.provenance ? { unreadable: 'no provenance' } : layout ? untimed(plain({ ...layout, members: undefined })) as Record<string, unknown> : null,
    stats: untimed(plain(compiled?.renderStats ?? null)),
    violations,
    ...(violations.unjudged?.length ? { unjudged: violations.unjudged } : {}),
    ...(slots.length ? { slots } : {}),
  };
}

export function refusedLine(error: Thrown, blobs: Pick<Blobs, 'put'>): RefusedBody {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(error ?? {})) if (k !== 'message' && k !== 'stack') fields[k] = v;
  return {
    outcome: 'refused',
    error: { class: errorClass(error), message: blobs.put(String(error?.message ?? error)), fields: plain(readable(() => plain(fields))) },
    violations: [],
  };
}

export function stateOf(manager: { getMaxSummaryLevel(): unknown }) {
  return { maxLevel: plain(readable(() => manager.getMaxSummaryLevel())) };
}

// context-manager 0.24.0 keeps the kv-unified receipt chain of a strategy with `beginKvUnifiedSubmission` in its
// private `kvUnifiedReceipts`, and the chain's head at `.head`. agent-framework 0.32.0 gives it each send's acceptance
// time as wall time and a submission id made per send with the wall time in it, so both are left out.
export function receiptHeadOf(manager: Pick<Recorded, 'getStrategy'>) {
  return plain(readable(() => {
    const strategy = manager.getStrategy();
    const chain = strategy?.kvUnifiedReceipts;
    if (chain == null) {
      if (typeof strategy?.beginKvUnifiedSubmission === 'function') throw new Error('the strategy takes kv-unified submissions but has no kvUnifiedReceipts to read its receipt chain from');
      return null;
    }
    if (!('head' in chain)) throw new Error('kvUnifiedReceipts has no head');
    const head = chain.head;
    if (head === null) return null;
    if (!head || typeof head !== 'object') throw new Error('the receipt head is neither null nor a receipt');
    if (typeof head.sequence !== 'number') throw new Error('the receipt head has no numeric sequence');
    if (!Array.isArray(head.changes)) throw new Error('the receipt head has no changes list');
    if (!head.changes.every(readableChange)) throw new Error('a receipt change lacks its leafId or value, or its value a string repHash and a numeric level and lastChangedSeq');
    return {
      sequence: head.sequence,
      receiptHash: head.receiptHash,
      parentReceiptHash: head.parentReceiptHash,
      requestHash: head.requestHash,
      layoutHash: head.layoutHash,
      changes: head.changes.map((c) => [String(c.leafId), c.value ? [c.value.repHash, c.value.level, c.value.lastChangedSeq] : null]),
    };
  })) as ReceiptHead;
}

// context-manager 0.24.0's PresentationDelta: a leafId, and a value that is null for a leaf removed, or a PresentedLeaf.
function readableChange(change: Change): change is { leafId: {}; value: { repHash: string; level: number; lastChangedSeq: number } | null } {
  if (!change || typeof change !== 'object' || change.leafId == null || !('value' in change)) return false;
  const v = change.value;
  return v === null || (typeof v?.repHash === 'string' && typeof v.level === 'number' && typeof v.lastChangedSeq === 'number');
}

export function storeDelta(manager: Parameters<typeof readSummaries>[0] & Pick<Recorded, 'getAllMessages' | 'getStrategy'>, seen: Seen | undefined, blobs: Pick<Blobs, 'put'>) {
  const out: StoreDelta = {};
  if (seen === undefined) {
    seen = { messages: new Map(), summaries: new Map(), head: 'null', quarantine: 'null' };
    out.whole = true;
  }
  const next: Seen = { messages: new Map(seen.messages), summaries: new Map(), head: seen.head, quarantine: seen.quarantine };
  const messages = storedMessages(manager);
  if (!isUnreadable(messages)) {
    next.messages = new Map();
    const added: ([string, string[]] | [string, string[], { thinking: boolean }])[] = [];
    for (const m of messages) {
      const id = String(m.id);
      const thinking = (m.content as Block[]).some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
      const canaries = namingCanaries(m.content);
      const before = seen.messages.get(id);
      next.messages.set(id, { thinking, canaries: JSON.stringify(canaries) });
      if (before === undefined) added.push(thinking ? [id, canaries, { thinking }] : [id, canaries]);
      else if (before.thinking !== thinking) added.push([id, canaries, { thinking }]);
      else if (before.canaries !== JSON.stringify(canaries)) added.push(thinking ? [id, canaries, { thinking }] : [id, canaries]);
    }
    if (added.length || out.whole) out.messages = added;
    const gone = [...seen.messages.keys()].filter((id) => !next.messages.has(id));
    if (gone.length) out.removedMessages = gone;
  } else out.messages = messages;
  const summaries = readSummaries(manager);
  if (!isUnreadable(summaries)) {
    const added: Exclude<StoreDelta['summaries'], Unreadable | undefined> = [];
    for (const s of summaries.values()) {
      const entry = { id: s.id, level: s.level, sourceLevel: s.sourceLevel, sources: s.sources, parent: s.parent, content: blobs.put(s.content ?? null) };
      const key = JSON.stringify(entry);
      next.summaries.set(s.id, key);
      if (seen.summaries.get(s.id) !== key) added.push(entry);
    }
    const removed = [...seen.summaries.keys()].filter((id) => !summaries.has(id));
    if (added.length || out.whole) out.summaries = added;
    if (removed.length) out.removed = removed;
  } else {
    out.summaries = summaries;
    next.summaries = new Map(seen.summaries);
  }
  const head = receiptHeadOf(manager);
  const headKey = JSON.stringify(head);
  if (headKey !== seen.head) { out.receiptHead = head; next.head = headKey; }
  const quarantine = quarantineOf(manager);
  const quarantineKey = JSON.stringify(quarantine);
  if (quarantineKey !== seen.quarantine) { out.quarantine = quarantine; next.quarantine = quarantineKey; }
  const unread = [messages, summaries, head, quarantine, quarantine?.compression, quarantine?.merge].some(isUnreadable);
  return { out, seen: next, changed: Object.keys(out).length > 0, unread };
}

// context-manager 0.24.0's AutobiographicalStrategy reports its quarantines publicly: compression's as the spans it
// holds out, each named by its chunk's `chunkSourceHash`, and merges' as records, each named by its `key`. A strategy
// without them, such as a passthrough, has none to report.
function quarantineOf(manager: Pick<Recorded, 'getStrategy'>): Quarantine {
  const strategy = readable(() => manager.getStrategy());
  if (isUnreadable(strategy)) return strategy;
  if (typeof strategy?.getMergeQuarantineStatus !== 'function') {
    const compressing = compresses(manager);
    if (isUnreadable(compressing)) return compressing;
    if (!compressing) return null;
  }
  return {
    compression: plain(readable(() => {
      const status = strategy!.getCompressionQuarantineStatus!();
      if (status.unreadable) throw new Error('context-manager reports its compression quarantine unreadable');
      return identities(status.spans, 'chunkSourceHash', 'a compression quarantine span');
    })) as Read<string[]>,
    merge: plain(readable(() => {
      if (typeof strategy!.getMergeQuarantineStatus !== 'function') throw new Error('the strategy compresses but has no getMergeQuarantineStatus to read its merge quarantine from');
      return identities(strategy!.getMergeQuarantineStatus!().records, 'key', 'a merge quarantine record');
    })) as Read<string[]>,
  };
}

function identities(items: unknown, field: string, what: string): string[] {
  return (items as ({ [field: string]: unknown } | null | undefined)[]).map((item) => {
    if (typeof item?.[field] !== 'string') throw new Error(`${what} has no ${field}`);
    return item[field];
  }).sort();
}

export function messagesOf(manager: Pick<Manager, 'getAllMessages'>): Read<{ [field: string]: unknown }[]> {
  const stored = storedMessages(manager);
  if (isUnreadable(stored)) return stored;
  return plain(readable(() => stored.map((m) => ({
    id: String(m.id),
    sequence: m.sequence,
    participant: String(m.participant),
    blocks: (m.content as Block[]).map(blockShape),
    canaries: canariesOf(m.content),
    ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId, shardIndex: m.shardIndex ?? 0 } : {}),
    ...(m.metadata !== undefined ? { metadata: maskRunVarying(m.metadata as JsonLike) } : {}),
  })))) as Read<{ [field: string]: unknown }[]>;
}


function blockShape(b: Block): BlockShape {
  if (!b || typeof b !== 'object') return { type: typeof b };
  const out: BlockShape = { type: b.type };
  if (b.type === 'tool_use') { out.id = b.id; out.name = b.name; }
  if (b.type === 'tool_result') { out.toolUseId = b.toolUseId ?? b.tool_use_id; out.content = Array.isArray(b.content) ? b.content.map(blockShape) : textShape(String(b.content ?? '')); }
  if (typeof b.text === 'string') Object.assign(out, textShape(b.text));
  if (typeof b.thinking === 'string') Object.assign(out, textShape(b.thinking));
  return out;
}

function textShape(text: string): TextShape {
  const masked = maskRunVarying(text);
  return { chars: masked.length, sha256: textDigest(masked) };
}

const textDigest = (text: unknown) => (typeof text === 'string' ? createHash('sha256').update(text).digest('hex').slice(0, 16) : null);
