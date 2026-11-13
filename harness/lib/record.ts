import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_AGENT, primaryAgent, requestPairs, sideOfAgent, subOwners } from './strategies/checks.ts';
import { heldName, messageNames, spanName } from './strategies/names.ts';
import { EXAMPLE_DRAFT_ID, RUN_VARYING, epochNames, historySequences, ownTextOf } from './strategies/compare.ts';
import { frameOf } from './frames.ts';
import { compileRef } from './strategies/step-log.ts';
import { asWritten } from './strategies/control.ts';
import { kindOf } from './standin/value-kinds.ts';
import type { RequestRecord, Written } from './standin/standin.ts';
import type { SummariserRecord } from './standin/summariser.ts';
import type { Block } from './standin/view.ts';
import type { HostEvent, LogEntry } from './strategies/driver.ts';
import type { CompileLine } from './strategies/module.ts';
import type { LineEntry, StoreDelta } from './strategies/recorder.ts';
import type { RunResult } from './shapes/interfaces.ts';
import type { JudgedCount } from './strategies/report.ts';
import type { Generated } from './strategies/transcript.ts';

export const LONG_TEXT_BYTES = 4096;

const CANARY = /\[\[c:([^\]\s]+)\]\]/;
const CANARIES = /\[\[c:([^\]\s]+)\]\]/g;
const MARK = /\[\[s:M[0-9a-f]{8}\]\]/g;
const canonical = (v: unknown) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) && !JSON.isRawJSON(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const longText = (s: string) => {
  const bytes = Buffer.byteLength(s, 'utf8');
  return bytes <= LONG_TEXT_BYTES ? s : canonical({ sha256: createHash('sha256').update(s).digest('hex').slice(0, 16), bytes, head: s.slice(0, 80), tail: s.slice(-80) });
};
export const callText = (x: { name?: unknown; input?: unknown }) => `${x.name ?? 'tool'} ${canonical(x.input ?? null)}`;
export const answersIn = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /\.answer\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8'), asWritten) as Block[]);
type Part = { type?: unknown; text?: unknown; thinking?: unknown; content?: Content; name?: unknown; input?: unknown; source?: { media_type?: unknown } | null; mimeType?: unknown };
type Content = Part | Content[] | string | number | boolean | null | undefined;
const textParts = (content: unknown) => {
  if (typeof content === 'string') return [content];
  const out: string[] = [];
  const walk = (x: Content): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.text === 'string') out.push(x.text);
    if (typeof x.thinking === 'string') out.push(x.thinking);
    if (x.type === 'tool_result') { if (typeof x.content === 'string') out.push(x.content); else walk(x.content); }
    if (x.type === 'tool_use') out.push(callText(x));
    if (x.type === 'image') out.push(`[image ${x.source?.media_type ?? x.mimeType ?? ''}]`.replace(' ]', ']'));
  };
  walk(content as Content);
  return out;
};
const textOf = (content: unknown) => textParts(content).join('\n');

function recordAgents(log: LogEntry[], records: RequestRecord[] | null | undefined) {
  const primary = primaryAgent(log);
  const agentOf = new Map<string, string>();
  const sentAs = new Map<string, RequestRecord>();
  const rounds = new Map<string, { agent: string; request: RequestRecord }>();
  const spawned = new Map<string, string>();
  for (const agent of new Set(log.filter((e) => e.kind === 'compiles').flatMap((b) => (b.lines ?? []).map((l) => l.agent as string)).filter(Boolean))) {
    const side = sideOfAgent(agent, log, records ?? []);
    if (side !== 'primary' && side !== 'sub') spawned.set(side, agent);
    const paired = requestPairs(records ?? [], log, agent);
    for (const { line, request } of paired?.pairs ?? []) { sentAs.set(`${agent}|${line.boot}|${line.seq}`, request); agentOf.set(request.id, agent); }
    for (const request of paired?.continuations ?? []) rounds.set(request.id, { agent, request });
  }
  const owned = new Set([...sentAs.values()].map((r) => r.id));
  for (const r of records ?? []) if (r.kind === 'agent' && !owned.has(r.id) && !rounds.has(r.id)) rounds.set(r.id, { agent: (r.agent ?? 'primary') === 'primary' ? primary : spawned.get(r.agent!) ?? 'sub', request: r });
  for (const e of log) if (e.kind === 'compiles') for (const l of e.lines ?? []) if (typeof l.agent === 'string') agentOf.set(compileRef(e.boot, l.seq), l.agent);
  for (const [id, { agent }] of rounds) agentOf.set(id, agent);
  const epochNamed = epochNames(log, log.filter((e) => e.kind === 'order').flatMap((e) => e.order.map((ref) => agentOf.get(ref)).filter((a) => a !== undefined)));
  return { primary, sentAs, rounds, epochNamed };
}

export const recordEpochNames = (log: LogEntry[], records: RequestRecord[] | null | undefined) => recordAgents(log, records).epochNamed;

type Compiles = Extract<LogEntry, { kind: 'compiles' }>;
type Summary = Extract<NonNullable<StoreDelta['summaries']>, readonly unknown[]>[number];
type Blob = { content?: unknown; participant?: unknown } | null;
type Template = { base: string; role: unknown; words: string[] | null; shaped: string };
type Place = { name?: string; pos?: number; owner?: unknown; text?: string };
type Run = Place & { from?: string; to?: string; end?: number };
type Line = {
  text?: string;
  base?: string;
  kind?: 'compile' | 'round' | 'call' | 'ask' | 'unclassified';
  driver?: true;
  store?: { agent: unknown; level?: number; range?: [number, number] };
  held?: { agent: unknown };
  ref?: string;
  request?: string;
  sent?: RequestRecord;
  agent?: unknown;
  who?: unknown;
  compile?: CompileLine | null;
  round?: true;
};
type Head = Written['head'] & { dialect?: unknown; stream: unknown };
type StoreState = {
  ids: Set<string>;
  reported: Set<string>;
  present: Map<string, [number, boolean][]>;
  highest: [number, number][];
  canaries: Map<string, [number, string | null][]>;
  summaries: Map<string, [number, Summary][]>;
  order: Map<string, number> | null;
};
export type RecordArgs = {
  header: { configuration: string; from: string };
  log: LogEntry[];
  records: RequestRecord[] | null | undefined;
  end: { ok?: unknown; reason?: unknown } | null | undefined;
  judged?: JudgedCount[] | null;
  generated?: Generated | null;
  runDir?: string | null;
};

export function renderRecord(args: RecordArgs) {
  return `${renderRecordLines(args).map((l) => l.text).join('\n')}\n`;
}

export function renderRecordLines({ header, log, records, end, judged = null, generated = null, runDir = null }: RecordArgs) {
  const blobs = new Map<string, unknown>();
  const batches: Compiles[] = [];
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [id, v] of Object.entries(e.blobs ?? {})) blobs.set(id, v);
    batches.push(e);
  }

  const letters = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : letters(Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  // agent-framework mints an image ref's nonce per process (tool-image-ledger.ts), and a draft's id, a reminder's id and
  // a fork's UUID at random (compare.ts's RUN_VARYING), so each is named by its first appearance in the run, whichever
  // boot it comes in.
  const own = ownTextOf(runDir);
  const minter = (epochNamed: (text: string) => string) => {
    const nonces = new Map<string, string>(), drafts = new Map<string, string>(), sequences = new Map<string, string>(), forks = new Map<string, string>(), reminders = new Map<string, string>();
    const name = (map: Map<string, string>, key: string, prefix: string) => {
      if (!map.has(key)) map.set(key, `${prefix}${letters(map.size)}`);
      return map.get(key)!;
    };
    const shown = historySequences((n) => name(sequences, n, 's'));
    return (s: string) => shown(epochNamed(own(s)))
      .replace(RUN_VARYING.imageRef, (_, nonce, n) => `img_${name(nonces, nonce, 'n')}_${n}`)
      .replace(RUN_VARYING.draft, (id) => (id === EXAMPLE_DRAFT_ID ? id : name(drafts, id, 'd-D')))
      .replace(RUN_VARYING.fork, (_, prefix, uuid) => `${prefix}${name(forks, uuid, 'UUID')}`)
      .replace(RUN_VARYING.reminder, (_, prefix, random) => `${prefix}${name(reminders, random, 'R')}`);
  };
  const { primary, sentAs, rounds, epochNamed } = recordAgents(log, records);
  const nameMinted = minter(epochNamed);

  const templates: Template[] = [];
  const slot = new Map<string, number>();
  const slug = (s: unknown) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, '-').replace(/^-+|-+$/g, '');
  const template = (role: unknown, text: string, key: string | null = null) => {
    const shaped = longText(nameMinted(text));
    const words = key ? null : text.split(/\s+/);
    const base = key ?? `${slug(role)}-${slug(words!.slice(0, 3).join(' ')).slice(0, 40) || 'empty'}`;
    const k = `${base}\u0000${shaped}`;
    if (!slot.has(k)) { slot.set(k, templates.length); templates.push({ base, role, words, shaped }); }
    return `\u0001${slot.get(k)}\u0001`;
  };

  const stores = new Map<unknown, StoreState>();
  const storeOf = (agent: unknown) => {
    if (!stores.has(agent)) stores.set(agent, { ids: new Set(), reported: new Set(), present: new Map(), highest: [], canaries: new Map(), summaries: new Map(), order: null });
    return stores.get(agent)!;
  };
  const remember = <V>(map: Map<string, [number, V][]>, key: string, at: number, value: V) => { if (!map.has(key)) map.set(key, []); map.get(key)!.push([at, value]); };
  const batchAt = new Map(batches.map((b, i) => [b, i]));
  const live = new Map<string, Set<string>>();
  batches.forEach((b, i) => {
    for (const [agent, st] of Object.entries(b.store ?? {})) {
      const store = storeOf(agent);
      if (!live.has(agent)) live.set(agent, new Set());
      const here = live.get(agent)!;
      if (st.whole && Array.isArray(st.messages)) {
        const listed = new Set(st.messages.map(([id]) => String(id)));
        for (const id of [...here]) if (!listed.has(id)) { remember(store.present, id, i, false); here.delete(id); }
      }
      for (const [id, canaries] of Array.isArray(st.messages) ? st.messages : []) {
        store.ids.add(String(id));
        store.reported.add(String(id));
        remember(store.present, String(id), i, true);
        remember(store.canaries, String(id), i, CANARY.exec(canaries?.[0] ?? '')?.[1] ?? null);
        here.add(String(id));
      }
      for (const id of Array.isArray(st.removedMessages) ? st.removedMessages : []) { remember(store.present, String(id), i, false); here.delete(String(id)); }
      const top = Math.max(store.highest.at(-1)?.[1] ?? -Infinity, ...(Array.isArray(st.messages) ? st.messages : []).map(([id]) => Number(id)).filter(Number.isFinite));
      store.highest.push([i, top]);
      for (const sm of Array.isArray(st.summaries) ? st.summaries : []) remember(store.summaries, sm.id, i, sm);
    }
  });
  const reportedAnywhere = (id: string) => [...stores.values()].some((st) => st.reported.has(id));
  for (const b of batches) for (const l of b.lines ?? []) for (const m of l.messages ?? []) {
    if (m.sources.length !== 1 || !m.sources[0].startsWith('r:')) continue;
    const id = m.sources[0].slice(2).split('!')[0];
    if (!reportedAnywhere(id)) storeOf(l.agent).ids.add(id);
  }
  let now = -1;
  const asOf = <V>(history: [number, V][] | undefined) => {
    if (!history) return undefined;
    let value = history[0][1];
    for (const [at, v] of history) { if (at > now) break; value = v; }
    return value;
  };
  const heldNow = (agent: unknown, id: string) => {
    const store = storeOf(agent);
    const history = store.present.get(String(id));
    if (!history) return false;
    if (history[0][0] <= now) return asOf(history);
    let top = -Infinity;
    for (const [at, v] of store.highest) { if (at > now) break; top = v; }
    return Number(id) > top;
  };
  const canaryOf = (agent: unknown, id: string) => asOf(storeOf(agent).canaries.get(String(id))) ?? undefined;
  const summaryOf = (agent: unknown, id: string) => asOf(storeOf(agent).summaries.get(id));
  const isSummary = (agent: unknown, id: string) => storeOf(agent).summaries.has(id);
  const byId = (a: string, b: string) => {
    const x = Number(a), y = Number(b);
    const nx = Number.isFinite(x), ny = Number.isFinite(y);
    return nx && ny ? x - y : nx ? -1 : ny ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  const positionOf = (agent: unknown, id: string) => {
    const store = storeOf(agent);
    if (!store.order) store.order = new Map([...store.ids].sort(byId).map((x, i) => [x, i]));
    return store.order.get(id);
  };
  const leaves = (agent: unknown, id: string, seen = new Set<string>()): string[] => {
    const sm = summaryOf(agent, id);
    if (!sm || seen.has(id)) return [];
    seen.add(id);
    return sm.sources.flatMap((src) => (isSummary(agent, src) && sm.sourceLevel > 0 ? leaves(agent, src, seen) : [String(src)]));
  };
  const spanOf = (agent: unknown, id: string): [number, number] => {
    const ls = leaves(agent, id);
    return ls.length ? [positionOf(agent, ls[0]) ?? 0, positionOf(agent, ls.at(-1)!) ?? 0] : [0, 0];
  };
  const namers = new Map<string, ReturnType<typeof messageNames>>();
  const nameOf = (agent: unknown, id: string) => {
    const key = `${agent}\u0000${now}`;
    if (!namers.has(key)) namers.set(key, messageNames([...storeOf(agent).reported].filter((x) => heldNow(agent, x)).sort(byId), (x) => canaryOf(agent, x)));
    return namers.get(key)!(id) ?? `#${id}`;
  };
  const summaryName = (agent: unknown, id: string, level?: unknown) => {
    const named = leaves(agent, id).filter((leaf) => heldNow(agent, leaf)).map((leaf) => nameOf(agent, leaf));
    return named.length ? spanName(`L${summaryOf(agent, id)?.level ?? level}`, named[0], named.at(-1)) : `L${summaryOf(agent, id)?.level ?? level}(-)`;
  };
  const leafName = (agent: unknown, leaf: string) => (isSummary(agent, leaf) ? summaryName(agent, leaf) : nameOf(agent, leaf));
  const summaryTemplate = (sm: Summary) => {
    const value = blobs.get(sm.content) as Blob | undefined;
    const text = textOf(value?.content ?? value ?? '');
    return template('summary', text, `summary-l${sm.level}-${createHash('sha256').update(nameMinted(text)).digest('hex').slice(0, 12)}`);
  };
  let marks: Map<string, string> | null = null;
  let marksAt: number | null = null;
  const markName = () => {
    if (!marks || marksAt !== now) {
      marks = new Map();
      marksAt = now;
      for (const [agent, store] of stores) for (const sm of [...store.summaries.keys()].map((id) => summaryOf(agent, id)!)) {
        const value = blobs.get(sm.content) as Blob | undefined;
        for (const m of textOf(value?.content ?? value ?? '').match(MARK) ?? []) if (!marks.has(m)) marks.set(m, summaryName(agent, sm.id, sm.level));
      }
    }
    return marks;
  };
  const frames = new Map<string, ReturnType<typeof frameOf>>();
  const frameOfBlob = (id: string) => {
    if (!frames.has(id)) {
      const value = blobs.get(id) as Blob | undefined;
      frames.set(id, frameOf(textParts(value?.content ?? value ?? ''), generated!));
    }
    return frames.get(id) as ReturnType<typeof frameOf>;
  };
  // context-manager gives a recall pair's question the sources of the summary it asks for, so a summary-sourced message
  // is told by its speaker too.
  const frameKey = (m: LineEntry, agent: unknown) => {
    if (m.sources.length === 1 && m.sources[0].startsWith('r:')) {
      const value = blobs.get(m.content) as Blob | undefined;
      return CANARY.test(textOf(value?.content ?? value)) ? `${agent}\u0000${m.sources[0].split('!')[0]}` : null;
    }
    if (m.sources.length && m.sources.every((s) => s.startsWith('s:'))) return `${agent}\u0000${m.sources.join(' ')}\u0000${(blobs.get(m.content) as Blob | undefined)?.participant ?? ''}`;
    return null;
  };
  const formOf = new Map<string | null, string>();
  if (generated) {
    const seenFrames = new Map<string, Set<ReturnType<typeof frameOf>>>();
    for (const b of batches) for (const l of b.lines ?? []) for (const msg of (l.kind === 'other' || l.outcome === 'refused' || l.error ? [] : l.messages ?? [])) {
      const k = frameKey(msg, l.agent);
      if (!k) continue;
      if (!seenFrames.has(k)) seenFrames.set(k, new Set());
      seenFrames.get(k)!.add(frameOfBlob(msg.content));
    }
    const named = minter(epochNames(log));
    for (const [k, seen] of seenFrames) {
      const [f] = seen;
      if (seen.size === 1 && f !== null && !/\d/.test(named(f))) formOf.set(k, f);
    }
  }
  const formUses = new Map<string, Place & { agent: unknown; f: string; shown: string }>();
  const formShown = new Map<string, string>();
  const frameText = (value: Blob | undefined, f: string) => {
    const named = nameMinted(f);
    const numbers = named.match(/\d+/g) ?? [];
    return `[${template(value?.participant ?? 'message', named.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}`;
  };
  const frameAt = (m: LineEntry, agent: unknown, use: Place) => {
    if (!generated) return null;
    const f = frameOfBlob(m.content);
    if (f === null) return null;
    const k = frameKey(m, agent);
    if (formOf.get(k) !== f) return f;
    const shown = formShown.get(`${agent}\u0000${f}`) ?? frameText(blobs.get(m.content) as Blob | undefined, f);
    formShown.set(`${agent}\u0000${f}`, shown);
    const at = `${k}\u0000${use.name ?? use.text}`;
    if (!formUses.has(at)) formUses.set(at, { agent, f, shown, ...use });
    return null;
  };
  const thinking = new Map<string, boolean>();
  const ownerOf = (agent: unknown, slots: string[], id: string) => [agent, ...slots, ...[...stores.keys()].filter((n) => n !== agent && !slots.includes(n as string))].find((n) => stores.has(n) && heldNow(n, id));
  const item = (m: LineEntry, agent: unknown, slots: string[] = []): Place => {
    const value = blobs.get(m.content) as Blob | undefined;
    const raw = textOf(value?.content ?? value);
    if (m.sources.length === 1 && m.sources[0].startsWith('r:')) {
      const [id, why] = m.sources[0].slice(2).split('!');
      const bare = thinking.get(`${ownerOf(agent, slots, id) ?? agent} ${id}`) === true && !(Array.isArray(value?.content) && value.content.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'));
      const after = `${why ? `!${why}` : ''}${bare ? ':no-thinking' : ''}`;
      const canary = CANARY.exec(raw)?.[1];
      const owner = canary ? ownerOf(agent, slots, id) : undefined;
      const named = owner ? `${owner === agent ? '' : `${owner}/`}${nameOf(owner, id)}` : canary;
      const place = { name: named, pos: positionOf(owner ?? agent, id), owner: owner ?? agent };
      const frame = canary ? frameAt(m, agent, place) : null;
      if (canary && !after && frame === null) return place;
      if (canary) return { text: `${named}${frame === null ? '' : frameText(value, frame)}${after}` };
      const text = nameMinted(raw);
      const numbers = text.match(/\d+/g) ?? [];
      return { text: `[${template(value?.participant ?? 'message', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}${after}` };
    }
    const ids = m.sources.map((s) => /^s:([^@]+)@?(.*)$/.exec(s));
    if (ids.every((x) => x && isSummary(agent, x[1]))) {
      const named = ids.map((x) => `${summaryName(agent, x![1], x![2])}${x![2].endsWith('~') ? '~' : ''}`).join('+');
      const frame = frameAt(m, agent, { text: named });
      return { text: `${named}${frame === null ? '' : frameText(value, frame)}` };
    }
    const levels = m.sources.map((s) => (s.startsWith('s:') ? `L${s.split('@')[1] ?? '?'}` : s.split(':')[0])).join('+');
    const hash = createHash('sha256').update(nameMinted(raw)).digest('hex').slice(0, 12);
    return { text: `${levels}[${template('summary', raw, `summary-${levels.toLowerCase()}-${hash}`)}]` };
  };
  const items = (list: Place[]) => {
    const out: Run[] = [];
    for (const it of list) {
      const last = out.at(-1);
      if (it.name && last?.from && it.pos !== undefined && it.owner === last.owner && it.pos === (last.end as number) + 1) { last.to = it.name; last.end = it.pos; continue; }
      out.push(it.name ? { from: it.name, to: it.name, end: it.pos, owner: it.owner } : it);
    }
    return out.map((r) => r.text ?? (r.from === r.to ? r.from : `${r.from}-${r.to}`)).join(' ');
  };
  const previous = new Map<string, (string | undefined)[]>();
  const keyOf = (it: Place) => it.name ?? it.text;
  const sha8 = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex').slice(0, 8);
  const heads = new Map<string, string>();
  const lastHead = new Map<unknown, string>();
  const headTemplate = (role: string, raw: string | null | undefined) => {
    const text = nameMinted(raw ?? '');
    const numbers = text.match(/\d+/g) ?? [];
    return `[${template(role, text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}`;
  };
  const sent = (v: unknown, own: 'number' | 'string') => (v == null || typeof v === own ? `${v}` : own === 'number' && JSON.isRawJSON(v) ? canonical(v) : `${canonical(v)} (${kindOf(v)})`);
  const tools = (h: Head) => `tools ${(h.tools ?? []).map((t) => `${t.name}:${String(t.sha).slice(0, 8)}`).join(' ') || '-'}`;
  const responsesHead = (h: Extract<Head, { api: 'responses' | 'codex' }>) => [
    `max_output_tokens ${sent(h.maxOutputTokens, 'number')}`,
    `stream ${h.stream}`,
    `instructions ${h.instructions == null ? '-' : headTemplate('instructions', h.instructions)}`,
    tools(h),
    ...(h.reasoning != null ? [`reasoning ${canonical(h.reasoning)}`] : []),
    ...(h.include != null ? [`include ${canonical(h.include)}`] : []),
    ...(h.store != null ? [`store ${h.store}`] : []),
    ...(h.serviceTier != null ? [`service_tier ${sent(h.serviceTier, 'string')}`] : []),
    ...(h.headers?.organization != null || h.headers?.project != null ? [`headers organization ${h.headers.organization ?? '-'} project ${h.headers.project ?? '-'}`] : []),
    ...(h.headers?.sessionId != null ? [`headers session_id ${h.headers.sessionId}`] : []),
  ];
  // The Chat Completions API's own fields, as every dialect's head holds them (chat.ts), each where the request sent it.
  const chatHead = (h: Extract<Head, { api: 'chat-completions' }>) => [
    ...(h.maxTokens != null ? [`max_tokens ${sent(h.maxTokens, 'number')}`] : []),
    ...(h.maxCompletionTokens != null ? [`max_completion_tokens ${sent(h.maxCompletionTokens, 'number')}`] : []),
    `stream ${h.stream}`,
    ...(h.streamOptions != null ? [`stream_options ${canonical(h.streamOptions)}`] : []),
    ...(h.toolChoice != null ? [`tool_choice ${canonical(h.toolChoice)}`] : []),
    ...(h.reasoningEffort != null ? [`reasoning_effort ${h.reasoningEffort}`] : []),
    ...(h.thinking != null ? [`thinking ${canonical(h.thinking)}`] : []),
    tools(h),
    ...(h.headers?.organization != null || h.headers?.project != null ? [`headers organization ${h.headers.organization ?? '-'} project ${h.headers.project ?? '-'}`] : []),
    ...(h.headers?.referer != null || h.headers?.title != null ? [`headers referer ${h.headers.referer ?? '-'} title ${h.headers.title ?? '-'}`] : []),
  ];
  const messagesHead = (h: Extract<Head, { api: 'messages' }>) => [
    `max_tokens ${sent(h.maxTokens, 'number')}`,
    `stream ${h.stream}`,
    ...(h.toolChoice != null ? [`tool_choice ${canonical(h.toolChoice)}`] : []),
    ...(h.thinking != null ? [`thinking ${canonical(h.thinking)}`] : []),
    `system ${(h.system ?? []).map((b) => `${headTemplate('system', b.text)}${b.cache ? `^${b.cache}` : ''}${b.other ? `{${String(b.other).slice(0, 8)}}` : ''}`).join(' ') || '-'}`,
    tools(h),
    ...(h.headers ? [`headers beta ${(h.headers.beta ?? []).join('+') || '-'} version ${h.headers.version ?? '-'}`] : []),
  ];
  const headText = (h: Head) => [
    ...(h.api ? [`api ${h.api}`] : []),
    ...(h.dialect ? [`dialect ${h.dialect}`] : []),
    `model ${h.model}`,
    ...(h.api === 'responses' || h.api === 'codex' ? responsesHead(h) : h.api === 'chat-completions' ? chatHead(h) : messagesHead(h as Extract<Head, { api: 'messages' }>)),
    ...(h.path ? [`path ${h.path}`] : []),
    ...(h.query != null ? [`query ${JSON.stringify(h.query)}`] : []),
    ...(h.rest ? [`rest ${headTemplate('rest', h.rest)}`] : []),
  ].join(', ');
  const messagesOf = (r: RequestRecord) => (r.messages ?? []).map((m) => ({ role: m.role, digest: m.digest, cache: (m.blocks ?? []).map((b) => (b.contentCache ? [b.cache ?? null, b.contentCache] : b.cache ?? null)) }));
  const sentNote = (who: unknown, r: RequestRecord) => {
    const head = r.head ? { ...r.head, stream: r.stream ?? null } : null;
    let note = '';
    if (head) {
      const key = sha8(head);
      if (!heads.has(key)) heads.set(key, headText(head));
      if (lastHead.get(who) !== key) { lastHead.set(who, key); note = `, head H:${key}`; }
    }
    const dropped = (r.transformations ?? []).filter((t) => t.type === 'thinking_dropped').length;
    return `${note}, body ${sha8(messagesOf(r))}${dropped ? `, dropped ${dropped}` : ''}`;
  };
  const lastCarried = new Map<unknown, string[]>();
  const lastSent = new Map<unknown, CompileLine>();
  const carriedBy = (r: RequestRecord) => [...new Set((r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
  const compileLine = (l: CompileLine, boot: number): Line => {
    const list = (l.messages ?? []).map((m) => item(m, l.agent, l.slots ?? []));
    const marks = (l.messages ?? []).flatMap((m, i) => (m.marker ? [i + 1] : []));
    const keys = list.map(keyOf);
    const whose = `${l.agent} ${l.kind}`;
    const before = previous.get(whose);
    previous.set(whose, keys);
    let dropped = -1;
    if (before) {
      for (let n = 0; n <= before.length && dropped < 0; n++) {
        const kept = before.length - n;
        if (kept <= keys.length && (kept > 0 || n === 0) && before.slice(n).every((k, i) => keys[i] === k)) dropped = n;
      }
    }
    const added = dropped < 0 ? null : list.slice(before!.length - dropped);
    const shown = dropped < 0 ? items(list) : [dropped ? `-${dropped}` : '', added!.length ? `+ ${items(added!)}` : ''].filter(Boolean).join(' ') || '= (as before)';
    const sent = l.kind === 'request' ? sentAs.get(`${l.agent}|${boot ?? null}|${l.seq}`) : null;
    const text = `  compile${l.agent === primary ? '' : ` [${l.agent}]`}${l.kind === 'dry' ? ' dry' : ''} ${shown}${marks.length ? ` ^ ${marks.join(',')}` : ''}`;
    return sent ? { kind: 'compile', base: text, sent, agent: l.agent, compile: l, request: sent.id } : { text };
  };

  const lines: (string | Line)[] = [];
  lines.push(`# whole-host record ${header.configuration}, from ${header.from}`);

  const totals = { compiles: 0, dry: 0, refused: 0, other: 0, calls: 0, rounds: 0, written: 0, actions: 0 };
  const receipt = new Map<string, Exclude<NonNullable<StoreDelta['receiptHead']>, { unreadable: string }>>();
  const firstBoot = log.find((e) => e.kind === 'compiles' && e.at === 'boot');
  const taken = new Set<string>();
  const receiptBoot = new Map<string, number>();
  const known = new Map<string, string>();
  const byStep = new Map<string | null, Line[]>();
  const at = (step: string | null) => { if (!byStep.has(step)) byStep.set(step, []); return byStep.get(step)!; };
  // connectome-host's headless sends `inference:speech` frames (headless.ts idleTrace), which its fleet module keeps as
  // a child's latest reply and relays (fleet-module.ts).
  const spoken = new Map<string | null, HostEvent[]>();
  const steps: (string | null)[] = [];
  const seen = (step: string | null) => { if (!steps.includes(step)) steps.push(step); };
  const summariser = new Map((records ?? []).filter((r): r is SummariserRecord => r.kind === 'summariser').map((r) => [r.id, r]));
  const unclassified = new Map((records ?? []).filter((r) => r.kind === 'unclassified').map((r) => [r.id, r]));
  const asks = new Map((records ?? []).filter((r) => !['agent', 'summariser', 'unclassified'].includes(r.kind)).map((r) => [r.id, r]));
  const carriedIn = (r: RequestRecord) => [...new Set((r.messages ?? []).flatMap((m) => m.blocks.flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
  for (const e of log) {
    const action = e.kind !== 'send' ? null : e.via === 'ipc' ? e.command : e.via === 'fixture' ? (e.host as { command?: unknown } | undefined)?.command : null;
    if (action) { seen(e.step); at(e.step).push({ text: `  action ${action}`, driver: true }); totals.actions++; }
    if (e.kind === 'request' && rounds.has(e.request?.id)) {
      const { agent, request } = rounds.get(e.request.id)!;
      seen(e.step);
      totals.rounds++;
      at(e.step).push({ kind: 'round', agent, sent: request, request: request.id, round: true });
    }
    if (e.kind === 'request' && summariser.has(e.request?.id)) {
      const r = summariser.get(e.request.id)!;
      totals.calls++;
      seen(e.step);
      const carried = carriedIn(r);
      const words = (r.texts ?? []).map((t) => {
        const text = nameMinted(t);
        const marked = text.match(MARK);
        if (marked) return marked.map((m) => markName().get(m) ?? `S(${m.slice(4, -2)})`).join('+');
        const numbers = text.match(/\d+/g) ?? [];
        return `[${template('call', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}`;
      });
      at(e.step).push({ kind: 'call', base: `  call ${[carried.length ? carried.join(' ') : '-', ...words].join(' ')} -> ${r.answer?.shape ?? 'none'}`, sent: r, request: r.id });
    }
    if (e.kind === 'request' && asks.has(e.request?.id)) {
      const r = asks.get(e.request.id)!;
      seen(e.step);
      const batch = [...new Set((r.batch ?? []).map((c) => CANARY.exec(c)?.[1] ?? c))];
      at(e.step).push({ kind: 'ask', who: r.kind, base: `  ask [${r.kind}] ${batch.length ? batch.join(' ') : '-'} -> ${r.answer?.verdict ?? (r.answer?.shape === 'error' ? `error ${r.answer.status}` : r.answer?.shape === 'refresh' ? 'refresh' : 'none')}`, sent: r, request: r.id });
    }
    if (e.kind === 'request' && unclassified.has(e.request?.id)) {
      const r = unclassified.get(e.request.id)!;
      seen(e.step);
      const carried = carriedIn(r);
      at(e.step).push({ kind: 'unclassified', base: `  unclassified ${carried.length ? carried.join(' ') : '-'}`, sent: r, request: r.id });
    }
    if (e.kind === 'compiles') {
      now = batchAt.get(e)!;
      for (const [agent, st] of Object.entries(e.store ?? {})) {
        const tag = agent === primary ? '' : ` [${agent}]`;
        epochNamed(agent);
        if (receiptBoot.has(agent) && receiptBoot.get(agent) !== e.boot && !('receiptHead' in st)) receipt.delete(agent);
        receiptBoot.set(agent, e.boot);
        if ('receiptHead' in st) {
          if (st.receiptHead?.unreadable !== undefined) { seen(e.step); at(e.step).push({ text: `  unreadable${tag} receipt: ${st.receiptHead.unreadable}`, store: { agent } }); receipt.delete(agent); }
          else if (st.receiptHead) receipt.set(agent, st.receiptHead);
          else receipt.delete(agent);
        }
        for (const part of ['messages', 'summaries'] as const) if (st[part] && !Array.isArray(st[part])) { seen(e.step); at(e.step).push({ text: `  unreadable${tag} ${part}: ${(st[part] as { unreadable?: string }).unreadable ?? 'not a list'}`, store: { agent } }); }
        for (const [id, , more] of Array.isArray(st.messages) ? st.messages : []) thinking.set(`${agent} ${id}`, more?.thinking === true);
        const listed = Array.isArray(st.summaries) ? new Set(st.summaries.map((sm) => sm.id)) : null;
        const gone = st.whole && listed && taken.has(agent) ? [...known.keys()].filter((k) => k.startsWith(`${agent} `)).map((k) => k.slice(agent.length + 1)).filter((id) => !listed.has(id)) : [];
        const baseline = st.whole && e === firstBoot;
        taken.add(agent);
        for (const sm of Array.isArray(st.summaries) ? st.summaries : []) {
          const was = known.get(`${agent} ${sm.id}`);
          const now = canonical({ level: sm.level, sources: sm.sources, content: sm.content, parent: sm.parent ?? null });
          known.set(`${agent} ${sm.id}`, now);
          if (was === now || baseline) continue;
          seen(e.step); at(e.step).push({ text: `  wrote${agent === primary ? '' : ` [${agent}]`} ${summaryName(agent, sm.id, sm.level)} [${summaryTemplate(sm)}]`, store: { agent, level: sm.level, range: spanOf(agent, sm.id) } }); totals.written++;
        }
        const removed = [...(st.removed ?? []), ...gone];
        for (const id of removed) known.delete(`${agent} ${id}`);
        if (removed.length) { seen(e.step); at(e.step).push({ text: `  removed${agent === primary ? '' : ` [${agent}]`} ${removed.map((id) => leafName(agent, id)).join(' ')}`, store: { agent } }); }
      }
      const batch = [];
      for (const l of e.lines ?? []) {
        if (l.kind === 'other') { totals.other++; continue; }
        seen(e.step);
        if (l.outcome === 'refused' || l.error) {
          totals.refused++;
          const text = typeof l.error?.message === 'string' ? (blobs.get(l.error.message) ?? l.error.message) : '';
          batch.push({ ref: compileRef(e.boot, l.seq), text: `  compile${l.agent === primary ? '' : ` [${l.agent}]`} refused ${l.error?.class ?? 'unknown'}${text ? ` [${template(`error-${l.error?.class ?? 'unknown'}`, nameMinted(String(text)).replace(/\d+/g, '#'))}]` : ''}` });
          continue;
        }
        if (l.kind === 'dry') totals.dry++; else totals.compiles++;
        batch.push({ ...compileLine(l, e.boot), ref: compileRef(e.boot, l.seq) });
      }
      at(e.step).push(...batch);
    }
    if (e.kind === 'ipc' && e.event?.type === 'inference:speech') {
      seen(e.step);
      if (!spoken.has(e.step)) spoken.set(e.step, []);
      spoken.get(e.step)!.push(e.event);
    }
    if (e.kind === 'checkpoint') { seen(e.step); at(e.step).push({ text: `checkpoint ${e.name}`, driver: true }); }
    if (e.kind === 'absent') { seen(e.step); at(e.step).push({ text: `absent ${e.stretch}`, driver: true }); }
    if (e.kind === 'provider-held') { seen(e.step); at(e.step).push({ text: `provider-held ${heldName(e.agent)} ${e.ms} ms`, held: { agent: e.agent } }); }
    if (e.kind === 'compression-paused') { seen(e.step); at(e.step).push({ text: `compression-paused ${heldName(e.agent)} ${e.ms} ms`, held: { agent: e.agent } }); }
  }
  const placed = new Map<string | null, Map<string | null | undefined, number>>();
  const unended = new Set<string | null>();
  for (const e of log) {
    if (e.kind !== 'order') continue;
    const was = placed.get(e.step) ?? new Map();
    placed.set(e.step, new Map([...was, ...e.order.map((ref, i): [string, number] => [ref, was.size + i])]));
    if (!e.ended) unended.add(e.step);
  }
  const agentRank = (agent: unknown) => (agent === primary ? '' : typeof agent === 'string' ? `\u0001${epochNamed(agent)}` : '\u0002');
  const storeOrder = (a: Line, b: Line) => {
    const [x, y] = [a.store!, b.store!];
    if (x.agent !== y.agent) return agentRank(x.agent) < agentRank(y.agent) ? -1 : 1;
    if ((x.level ?? 0) !== (y.level ?? 0)) return (x.level ?? 0) - (y.level ?? 0);
    for (let i = 0; i < 2; i++) if ((x.range?.[i] ?? 0) !== (y.range?.[i] ?? 0)) return (x.range?.[i] ?? 0) - (y.range?.[i] ?? 0);
    const [p, q] = [a, b].map((l) => l.text!.replace(/\u0001(\d+)\u0001/g, (_, i) => templates[i].shaped));
    return p < q ? -1 : p > q ? 1 : 0;
  };
  for (const step of steps) {
    const at = placed.get(step) ?? new Map();
    const own = byStep.get(step) ?? [];
    const placeOf = (l: Line) => at.get(l.request ?? l.ref);
    const ordered = own.filter((l) => !l.driver && !l.store && placeOf(l) !== undefined).sort((a, b) => placeOf(a) - placeOf(b));
    const rest = own.filter((l) => !l.driver && !l.store && l.held === undefined && placeOf(l) === undefined);
    const held = own.filter((l) => l.held !== undefined).sort((a, b) => (agentRank(a.held!.agent) < agentRank(b.held!.agent) ? -1 : agentRank(a.held!.agent) > agentRank(b.held!.agent) ? 1 : 0));
    const keyed = [...own.filter((l) => l.driver), ...ordered, ...rest, ...held, ...own.filter((l) => l.store).sort(storeOrder)].map((l) => ({ l }));
    byStep.set(step, keyed.map(({ l }) => {
      if (l.kind === 'compile') {
        lastCarried.set(l.agent, carriedBy(l.sent!));
        lastSent.set(l.agent, l.compile!);
        return { text: `${l.base}${sentNote(l.agent, l.sent!)}`, request: l.request, compile: l.compile };
      }
      if (l.kind === 'round') {
        const before = new Set(lastCarried.get(l.agent) ?? []);
        const carried = carriedBy(l.sent!);
        lastCarried.set(l.agent, carried);
        const added = carried.filter((c) => !before.has(c));
        return { text: `  round${l.agent === primary ? '' : ` [${l.agent}]`} ${added.length ? `+ ${added.join(' ')}` : '='}${sentNote(l.agent, l.sent!)}`, request: l.request, compile: lastSent.get(l.agent) ?? null, round: true };
      }
      if (l.kind === 'call') return { text: `${l.base}${sentNote('summariser', l.sent!)}`, request: l.request };
      if (l.kind === 'unclassified') return { text: `${l.base}${sentNote('unclassified', l.sent!)}`, request: l.request };
      if (l.kind === 'ask') return { text: `${l.base}${sentNote(l.who, l.sent!)}`, request: l.request };
      const { driver, store, ref, held: _, ...line } = l;
      return line;
    }));
  }
  const speechLine = (e: HostEvent) => {
    const tag = e.agentName === primary ? '' : ` [${e.agentName}]`;
    const content = e.content;
    if (typeof content !== 'string') return { text: `  speech${tag} (content ${content === undefined ? 'missing' : typeof content})` };
    if (content === '') return { text: `  speech${tag} ""` };
    const keys = [...content.matchAll(CANARIES)].map((x) => x[1]);
    if (keys.length) return { text: `  speech${tag} ${keys.join(' ')}` };
    const named = nameMinted(content);
    const numbers = named.match(/\d+/g) ?? [];
    return { text: `  speech${tag} [${template('speech', named.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}` };
  };
  const said = new Map([...spoken].map(([step, frames]) => [step, frames.map(speechLine)]));
  for (const step of steps) {
    const own = byStep.get(step) ?? [];
    const body = own.filter((l) => l.text!.startsWith('  '));
    const speech = said.get(step) ?? [];
    if (own.length || speech.length) lines.push(`step ${step}${unended.has(step) ? ' (not ended)' : ''}`, ...body, ...speech);
    lines.push(...own.filter((l) => !l.text!.startsWith('  ')));
  }
  lines.push(`end ${end?.ok ? 'ok' : 'failed'}`);
  for (const [agent, head] of [...receipt.entries()].sort(([a], [b]) => (epochNamed(a) < epochNamed(b) ? -1 : 1))) {
    const changes = ((head.changes ?? []) as [string, [unknown, unknown, unknown] | null][]).map(([leaf, change]) => (change ? `${leafName(agent, leaf)}/${String(change[0]).split(':')[0]}/${change[1]}/${change[2]}` : `${leafName(agent, leaf)}/removed`));
    lines.push(`receipt ${agent} #${head.sequence}${changes.length ? ` changes ${changes.join(' ')}` : ''}`);
  }
  const unjudged: Record<string, number> = {};
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) for (const u of l.unjudged ?? []) {
      const key = `${l.agent === primary ? '' : `[${l.agent}] `}${u}`;
      unjudged[key] = (unjudged[key] ?? 0) + 1;
    }
  }
  lines.push(`totals ${canonical(Object.keys(unjudged).length ? { ...totals, unjudged } : totals)}`);
  if (judged) lines.push(`judged ${judged.map((j) => `${j.check} ${j.name} ${j.judged ?? '?'}`).join(', ')}`);
  const formLines = [];
  const formGroups = new Map();
  for (const u of formUses.values()) {
    const g = `${u.agent}\u0000${u.f}`;
    if (!formGroups.has(g)) formGroups.set(g, []);
    formGroups.get(g).push(u);
  }
  for (const us of formGroups.values()) {
    const inOrder = [...us].sort((a, b) => (a.pos ?? Infinity) - (b.pos ?? Infinity));
    formLines.push(`form${us[0].agent === primary ? '' : ` [${us[0].agent}]`} ${us[0].shown} ${items(inOrder.map(({ text, name, pos, owner }) => (text === undefined ? { name, pos, owner } : { text })))}`);
  }
  const names = nameTemplates(templates);
  const head = lines.findIndex((l) => typeof l === 'string' && !l.startsWith('#'));
  const block = ['templates', ...templates.map((t, i) => [names[i], t.shaped]).sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([name, text]) => `T:${name} = ${text.split('\n').join('\n  ')}`.split('\n'))];
  const headBlock = heads.size ? ['heads', ...[...heads.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, text]) => `H:${key} = ${text}`)] : [];
  lines.splice(head < 0 ? lines.length : head, 0, ...block, ...headBlock, ...formLines);
  const named = (text: string) => text.replace(/\u0001(\d+)\u0001/g, (_, i) => `T:${names[i]}`);
  return lines.map((l) => (typeof l === 'string' ? { text: epochNamed(named(l)), request: null } : { ...l, text: epochNamed(named(l.text!)), request: l.request ?? null }));
}

type Arm =
  | { outcome: 'couldnt-run'; reason?: string; records?: RequestRecord[]; log?: LogEntry[] }
  | (Partial<Pick<RunResult, 'outcome' | 'reason'>> & { records: RequestRecord[]; log: LogEntry[] });
type Result = Pick<RunResult, 'outcome' | 'record' | 'flags' | 'unmeasured' | 'baseUnmeasured' | 'readsFailed' | 'baseReadsFailed'> & { selfCheck?: Pick<NonNullable<RunResult['selfCheck']>, 'outcome'> };

const sha12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export function nameTemplates(templates: Pick<Template, 'base' | 'words' | 'shaped'>[], hash = sha12) {
  const names = templates.map((t) => (t.words ? `${t.base}-${hash(t.shaped)}` : t.base));
  const holder = new Map<string, number>();
  names.forEach((name, i) => {
    if (holder.has(name)) throw new Error(`two different texts take the template name ${name}: ${JSON.stringify(templates[holder.get(name)!].shaped)} and ${JSON.stringify(templates[i].shaped)}`);
    holder.set(name, i);
  });
  return names;
}

export function unrecordable(records: RequestRecord[], log: LogEntry[]) {
  const primary = primaryAgent(log);
  const sideOf = (agent: unknown) => sideOfAgent(agent, log, records);
  const lines = log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request' && l.outcome === 'compiled'));
  const compiled = new Set(lines.map((l) => sideOf(l.agent)));
  const uncompiled = [...new Set(records.filter((r) => r.kind === 'agent').map((r) => r.agent ?? 'primary'))].filter((side) => !compiled.has(side));
  const begun = new Map<unknown, number>();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const id of e.submissions ?? []) {
      if (begun.has(id) && begun.get(id) !== e.boot) return `kv-unified submission ${id} was begun in boot ${begun.get(id)} and again in boot ${e.boot}, which a restart's later clock never allows, so the context manager would take the second as a duplicate and the record would show a host no resident runs`;
      if (!begun.has(id)) begun.set(id, e.boot);
    }
  }
  const placing = subOwners(records, log).problem;
  if (placing) return `${recordEpochNames(log, records)(placing)}, and the stand-in tells only the fixture's requests, and those of a subagent its script labels by the name it's spawned with (connectome-host's spawn-<name>-<stamp>), from the rest, so the record couldn't tell one agent's requests from another's`;
  if (uncompiled.length) return `the run sent ${uncompiled.join(' and ')} agent requests, and its log holds no compiled request line from the test module for ${uncompiled.length > 1 ? 'either' : 'that side'}, so its record couldn't tell their compiles from their rounds`;
  const agents = [...new Set(lines.map((l) => l.agent))];
  const labelled = new Map<string, unknown[]>();
  for (const a of agents) { const side = sideOf(a); if (side !== 'primary' && side !== 'sub') labelled.set(side, [...(labelled.get(side) ?? []), a]); }
  const shared = [...labelled].find(([, as]) => as.length > 1);
  if (shared) return `${shared[1].join(' and ')} both read as the subagent labelled ${shared[0]}, by the name each was spawned with, so the record couldn't tell one's requests from the other's`;
  const unlabelled = agents.filter((a) => a !== primary && sideOf(a) === 'sub');
  if (labelled.size && unlabelled.length && !records.some((r) => r.kind === 'agent' && r.agent === 'sub')) return `${unlabelled.join(' and ')} compiled requests the stand-in recorded under no unlabelled side, so they went under a label ${unlabelled.length > 1 ? 'their names don\'t' : 'its name doesn\'t'} read as (connectome-host's spawn-<name>-<stamp>), or never reached the stand-in, and the record couldn't tell whose requests they were`;
  const unstamped = lines.filter((l) => l.outcome === 'compiled' && !/^\d+$/.test(String(l.stamp ?? ''))).length;
  if (unstamped) return `${unstamped} request compile(s) carry no stamp from the machine's monotonic clock, which the test module reads on Linux, but under Bun not on a Linux whose C library isn't at libc.so.6, such as a plain musl one, so the record couldn't tell their requests from rounds`;
  return null;
}

export function refuseUnrecordable(r: Arm) {
  const cannot = r.outcome === 'couldnt-run' ? null : unrecordable(r.records, r.log);
  if (cannot) Object.assign(r, { outcome: 'couldnt-run', reason: cannot });
  return cannot;
}

export function exitCode(results: Result[]) {
  if (results.some((r) => r.outcome === 'couldnt-run' || r.selfCheck?.outcome === 'couldnt-run' || r.unmeasured?.length || r.baseUnmeasured?.length || r.readsFailed?.length || r.baseReadsFailed?.length)) return 2;
  const moved = (flags: Result['flags']) => Boolean(flags && (flags.new.length || flags.gone.length));
  return results.every((r) => (r.record === 'same' || r.record === 'written') && !moved(r.flags) && (!r.selfCheck || r.selfCheck.outcome === 'same')) ? 0 : 1;
}
