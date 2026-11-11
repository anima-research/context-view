import type { JsonLike } from '../strategies/compare.ts';

const parsed = new WeakSet<object>();
export const markParsed = <T>(body: T): T => {
  if (body !== null && typeof body === 'object') parsed.add(body);
  return body;
};
export const isParsed = (body: unknown): boolean => body !== null && typeof body === 'object' && parsed.has(body);

export const CANARY = /\[\[c:[^\]\s]+\]\]/g;
export const SUMMARY = /\[\[s:M[0-9a-f]{8}\]\]/g;
const MARK = /\[\[c:[^\]\s]+\]\]|\[\[s:M[0-9a-f]{8}\]\]/g;
const IMAGE_NOT_SHOWN = '[system: an image in this tool result was NOT shown to you';

export type CacheControl = { type?: string; ttl?: string };

export type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string | null;
  id?: string;
  name?: string;
  input?: JsonLike;
  tool_use_id?: string;
  content?: JsonLike;
  source?: { type?: string; media_type?: string; data?: string; url?: JsonLike };
  cache_control?: CacheControl | null;
  [field: string]: JsonLike;
};

export type Message = { role: string; content: Block[]; [field: string]: JsonLike };

export interface View {
  model: string;
  maxTokens?: number | null;
  system: string;
  messages: Message[];
  tools: unknown[];
}

export interface ReadView extends View {
  seed: () => number;
}

export interface Delivered { to: string[]; held: number; kept: number; transcript: number }

export interface BlockRecord {
  type: string | undefined;
  chars: number;
  canaries?: string[];
  summaries?: string[];
  marks?: string[];
  imagesNotShown?: number;
  placeholders?: number;
  repairs?: string[];
  wakeLine?: number;
  wakeAfter?: number;
  notice?: string;
  noticeForm?: 'unanswered' | 'status' | null;
  markedNotice?: { tag: string; after: string[] };
  inferenceFailed?: { setting: string | null };
  notHeld?: true;
  delivered?: Delivered;
  retrieved?: true;
  xmlResults?: string[];
  xmlPlaceheld?: string[];
  xmlThoughtCalls?: string[];
  xmlMarks?: string[];
  toolUseId?: string;
  isError?: true;
  images?: number;
  contentCache?: Array<string | null>;
  cache?: string;
  signature?: string | null;
}

export const blocksOf = (content: unknown): Block[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

export function texts(view: { messages?: ReadonlyArray<{ content?: unknown }> }): string[] {
  const out: string[] = [];
  const walk = (b: string | Block | null | undefined) => {
    if (typeof b === 'string') { out.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') out.push(b.text || '');
    if (b.type === 'tool_result') blocksOf(b.content).forEach(walk);
  };
  for (const m of view.messages || []) blocksOf(m.content).forEach(walk);
  return out;
}

export const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' && !JSON.isRawJSON(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);

export const found = (strings: readonly string[], re: RegExp): string[] => strings.flatMap((s) => s.match(re) || []);

// What a request's tool pairs went through, by the marks the repairs write, at the stack's locked versions:
// membrane 0.8.0's normalizer textifies a result with no call before it or a second one for a call, and answers a
// call left without one with `[pending]` (normalize-tool-pairs.ts:546, :641, :968); context-manager 0.24.0's
// pairing repair leaves `[tool call omitted]` for blocks it drops, a moved result's note and a stub for a call whose
// result it hasn't (autobiographical.ts:19390, :19500, :19319; normalize-tool-messages.ts:133).
export function repairMarks(type: string | undefined, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[(orphan|duplicate) tool_result for [^\]\n]*\]/g)) out.push(`membrane:${m[1]}`);
  if (type === 'tool_result' && text === '[pending]') out.push('membrane:pending');
  for (const m of text.matchAll(/\[tool call omitted\]|\[tool result moved during context repair\]/g)) out.push(m[0] === '[tool call omitted]' ? 'context-manager:omitted' : 'context-manager:moved');
  if (type === 'tool_result' && text.startsWith('[this call\'s result isn\'t shown in this context.')) out.push('context-manager:stub');
  return out;
}

export const markerOf = (cc: unknown): string => (cc && typeof cc === 'object' && (cc as CacheControl).type === 'ephemeral' && Object.keys(cc).every((k) => k === 'type' || k === 'ttl') && [undefined, '5m', '1h'].includes((cc as CacheControl).ttl) ? (cc as CacheControl).ttl ?? '5m' : JSON.stringify(sorted(cc)));

// agent-framework's `[delivered]` receipt names where a turn's plain speech landed, its destinations and then its notes
// joined by ` · ` (framework.ts appendProseDeliveryReceipt, the same at 0.32.0 and 0.33.0): `plain speech → chat ·
// side`, `plain speech → no channel — N plain-speech segment(s) kept in the transcript (…)` in disabled mode, or
// `nothing — N plain-speech segment(s) held as draft(s) …`. A draft a resend delivered is a destination with its draft
// named after it.
export function deliveredOf(body: string): Delivered {
  const landed = /^plain speech → ([\s\S]*)$/.exec(body);
  const none = landed && landed[1].startsWith('no channel — ');
  const rest = landed ? (none ? landed[1].slice('no channel — '.length) : landed[1]) : body.replace(/^nothing(?: confirmed)? — /, '');
  const out: Delivered = { to: [], held: 0, kept: 0, transcript: 0 };
  for (const item of rest.split(' · ')) {
    const count = (re: RegExp) => Number(re.exec(item)?.[1] ?? 0);
    const held = count(/^(\d+) plain-speech segment\(s\) held as drafts? /);
    const kept = count(/^(\d+) plain-speech segment\(s\) kept private\b/);
    const transcript = count(/^(\d+) plain-speech segment\(s\) kept in the transcript\b/);
    out.held += held;
    out.kept += kept;
    out.transcript += transcript;
    if (landed && !none && !held && !kept && !transcript && !/^(\d+ plain-speech segment|drafts? )/.test(item)) out.to.push(item.replace(/ \(draft [^)]*\)$/, ''));
  }
  return out;
}

// membrane's anthropic-xml transcript opens each turn with its participant's name, `name: text`, and writes a tool
// round's calls and results in XML between them (formatters/anthropic-xml.js). The last turn a transcript holds is the
// last such opening outside those rounds, with the text after it; one with no opening is all one turn's.
const OPENING = /(?:^|\n)([^\n:<>[\]]{1,60}): /g;
export function lastRun(text: string): { name: string | null; text: string } {
  const close = text.indexOf('</function_results>');
  const open = text.indexOf('<function_results>');
  const rest = close >= 0 && (open < 0 || close < open) ? text.slice(close + '</function_results>'.length) : text;
  const plain = rest.replace(/<function_(calls|results)>[\s\S]*?(?:<\/function_\1>|$)/g, '');
  const opening = [...plain.matchAll(OPENING)].at(-1);
  return opening ? { name: opening[1], text: plain.slice(opening.index + opening[0].length) } : { name: null, text: plain };
}

// A request's blocks in order, each recorded knowing whether the blocks before it left a round's results open: an
// image splits membrane's prefill transcript at a result, sending the text after it in a message of its own.
export function blockRecorder() {
  let inResults = false;
  return (b: Block): BlockRecord => {
    const out = blockRecord(b, { inResults });
    if (b.type === 'text') {
      const text = b.text || '';
      const open = text.lastIndexOf('<function_results>');
      const close = text.lastIndexOf('</function_results>');
      if (open > close) inResults = true;
      else if (close > open) inResults = false;
    }
    return out;
  };
}

export function blockRecord(b: Block, { inResults = false }: { inResults?: boolean } = {}): BlockRecord {
  const text = b.type === 'text' ? b.text || '' : b.type === 'tool_result' ? texts({ messages: [{ content: [b] }] }).join('') : '';
  const out: BlockRecord = { type: b.type, chars: b.type === 'text' || b.type === 'tool_result' ? text.length : b.type === 'thinking' ? (b.thinking || '').length : b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length : b.type === 'image' ? (b.source?.data || '').length : JSON.stringify(b).length };
  const canaries = text.match(CANARY); if (canaries) out.canaries = canaries;
  const summaries = text.match(SUMMARY); if (summaries) out.summaries = summaries;
  // A block that carries both, in the order it carries them: on the Chat Completions API membrane joins a message's
  // text blocks into one string (openai-compatible.ts, convertMessages), so a summary and the reply after it can share
  // a block, which the lists above don't order between them.
  if (canaries && summaries) out.marks = text.match(MARK)!;
  // membrane's text for an image in a tool result it sends as text only (TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER,
  // providers/utils.ts), as its OpenAI-compatible adapter sends every tool result.
  const unshown = text.split(IMAGE_NOT_SHOWN).length - 1; if (unshown) out.imagesNotShown = unshown;
  // agent-framework's placeholder for an image it no longer sends: `[image: image/png, ~691KB, ref img_k7x3q2_7]`.
  const placeholders = text.match(/\[image: [^\]]*\]/g); if (placeholders) out.placeholders = placeholders.length;
  const repairs = repairMarks(b.type, text); if (repairs.length) out.repairs = repairs;
  // agent-framework's batched-wake line opens a line of its text block: `[Gate: 2 events matched]` (event-gate.ts
  // `wakeLineText`), wherever the text before it in its block puts it, as the Chat Completions API and membrane's XML
  // formatter join a message's text, and a side request quoting the conversation carries it. From v0.29.0
  // agent-framework marks each `[Gate` in the text a participant or a server supplies, `\[Gate`, as it takes that text
  // in (supplied-text.ts `markedTexts`). It never marks the agent's own words, summaries or tool results, so any of
  // those with the line's text at a line start is told as the line: tool results where they're text, on those two, and
  // the others on any formatter.
  const wake = b.type === 'text' ? /(?:^|\n)(?:[^\n:]{1,60}: )?\[Gate: (\d+) events? matched\]/.exec(text) : null;
  if (wake) {
    out.wakeLine = Number(wake[1]);
    const after = text.slice(0, wake.index).match(MARK)?.length ?? 0; if (after) out.wakeAfter = after;
  }
  if (b.type === 'text' && /^(?:[^\n:]{1,60}: )?\[inference-failed\]/.test(text)) out.inferenceFailed = { setting: /\(the host's setting for this bound: `([^`]+)`\)/.exec(text)?.[1] ?? null };
  const notice = b.type === 'text' ? /^\n?(?:[^\n:]{1,60}: )?\[(host-notice|suppression review|wake onboarding|refusal-rewind|turns-set-aside|discord-send-failed|routing|prose-routing|continue|tool-boundary|send-undeliverable|self-wake|Channel invitation|subscription-gc)\]/.exec(text) ?? /^(?:[^\n:]{1,60}: )?\[(Agent lifecycle): /.exec(text) : null; if (notice) out.notice = notice[1];
  // connectome-host's notices module writes its marker in one of two forms: an alert of the reply tier, or one that
  // closes on success, says what the host posted while the agent couldn't respond; any other says it posted a status
  // notice (notices-module.ts `writeMarker`, `markerForm`).
  if (notice?.[1] === 'host-notice') out.noticeForm = /\[host-notice\] While you could not respond \(/.test(text) ? 'unanswered' : /\[host-notice\] The host posted this status notice in /.test(text) ? 'status' : null;
  const marked = b.type === 'text' ? /(?:^|\n)((?:[^\n:]{1,60}: ){0,2})\\\[(Gate|suppression review|wake onboarding)(?=[\]:])/.exec(text) : null;
  if (marked) out.markedNotice = { tag: marked[2], after: marked[1].split(': ').slice(0, -1) };
  // agent-framework's `[delivered]` receipt for a turn says so when the turn's speech could be neither sent nor held as
  // drafts: "suppressed and NOT held as drafts (ERROR)" (framework.ts appendProseDeliveryReceipt, 0.32.0 and 0.33.0).
  if (b.type === 'text' && /^(?:[^\n:]{1,60}: )?\[delivered\][\s\S]*\bsuppressed and NOT held as drafts \(/.test(text)) out.notHeld = true;
  const receipt = b.type === 'text' ? /^(?:[^\n:]{1,60}: )?\[delivered\] ([\s\S]*)$/.exec(text) : null;
  if (receipt) out.delivered = deliveredOf(receipt[1]);
  // connectome-host's retrieval module heads the lessons it injects `## Retrieved Knowledge` (retrieval-module.ts), and
  // agent-framework stores them as a row of the participant `system_context:retrieval` (stored-injections.ts).
  if (b.type === 'text' && /^(?:system_context:retrieval: )?## Retrieved Knowledge\b/.test(text)) out.retrieved = true;
  // membrane's anthropic-xml formatter writes a prefill's tool rounds into its transcript: calls in `<function_calls>`,
  // results in `<function_results>`, and a reply's thinking in literal `<thinking>` tags (utils/tool-parser.js). An
  // image in a result splits the transcript there, the image going as a user message, so a block's last results can
  // run to its end (formatters/anthropic-xml.js `sentSplit`).
  if (b.type === 'text' && text.includes('<function_')) {
    const results = [...text.matchAll(/<function_results>([\s\S]*?)(?:<\/function_results>|$)/g)].flatMap((m) => m[1].match(CANARY) ?? []);
    if (results.length) out.xmlResults = results;
    const placeheld = [...text.matchAll(/<function_results>([\s\S]*?)(?:<\/function_results>|$)/g)].flatMap((round) => [...round[1].matchAll(/<result>([\s\S]*?)(?:<\/result>|$)/g)]).filter((m) => /\[image: [^\]]*\]/.test(m[1])).flatMap((m) => m[1].match(CANARY) ?? []);
    if (placeheld.length) out.xmlPlaceheld = placeheld;
    const thought: string[] = [];
    let from = 0;
    for (const m of text.matchAll(/<function_calls>([\s\S]*?)<\/function_calls>/g)) {
      const led = lastRun(text.slice(from, m.index)).text.trimStart();
      if (led.startsWith('<thinking>') && led.includes('</thinking>')) thought.push(...(m[1].match(CANARY) ?? []));
      from = m.index + m[0].length;
    }
    if (thought.length) out.xmlThoughtCalls = thought;
  }
  // membrane's prefill writes each stored row as a run of its participant's, `name: text`, so a notice agent-framework
  // stores, such as `[speech-not-posted]`, opens a run inside the transcript, not the block. Its tag, with the
  // canaries around it, in the order the text has them, is what places it after a round (W19).
  // A round's results are the tools' text, not runs, so a line in them opens none, though their canaries count. A
  // block an image split can open inside a round's results, an earlier block's (`inResults`, from `blockRecorder`),
  // which run to their closing tag, or to its end when it holds none, as a round an image split twice leaves one.
  if (b.type === 'text') {
    const close = text.indexOf('</function_results>');
    const open = text.indexOf('<function_results>');
    const inside = inResults || (close >= 0 && (open < 0 || close < open));
    const results = [...(inside ? [[0, close >= 0 ? close : text.length]] : []), ...[...text.matchAll(/<function_results>[\s\S]*?(?:<\/function_results>|$)/g)].map((m) => [m.index, m.index + m[0].length])];
    const withinResults = (at: number) => results.some(([from, to]) => at >= from && at < to);
    const marks = [...text.matchAll(/\[\[c:[^\]\s]+\]\]|(?:^|\n)[^\n:<>[\]]{1,60}: (\[[a-z][a-z-]*\])/g)].filter((m) => m[1] === undefined || !withinResults(m.index)).map((m) => m[1] ?? m[0]);
    if (marks.some((m) => !m.startsWith('[[c:'))) out.xmlMarks = marks;
  }
  if (b.type === 'tool_use') out.toolUseId = b.id;
  if (b.type === 'tool_result') {
    out.toolUseId = b.tool_use_id;
    if (b.is_error === true) out.isError = true;
    const images = blocksOf(b.content).filter((x) => x?.type === 'image').length;
    if (images) out.images = images;
    const inner = blocksOf(b.content).map((x) => (x?.cache_control != null ? markerOf(x.cache_control) : null));
    if (inner.some(Boolean)) out.contentCache = inner;
  }
  if (b.cache_control != null) out.cache = markerOf(b.cache_control);
  if (b.type === 'thinking') out.signature = b.signature ?? null;
  return out;
}
