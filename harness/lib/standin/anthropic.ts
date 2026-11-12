import { createHash } from 'node:crypto';
import { maskRunVarying } from '../strategies/compare.ts';
import { blockAlike, partsFrom, readAlike } from './seams.ts';
import { blockTokens, RATE } from './tokens.ts';
import { blockRecorder, blocksOf, isParsed, markParsed, markerOf, sorted } from './view.ts';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { JsonLike, Masker } from '../strategies/compare.ts';
import type { Configuration, Decoded, Read, Refusal, RequestRecord, Sent } from './standin.ts';
import type { ContextPart, PartMemo } from './seams.ts';
import type { Block, BlockRecord, CacheControl } from './view.ts';
import { cacheId } from './openai-cache.ts';
import * as value from './value-kinds.ts';
import type { CacheUse, CacheUses } from './openai-cache.ts';

type MessageItem = { role: string; content?: JsonLike; [field: string]: JsonLike };

export const MESSAGES_ROWS = {
  model: value.string,
  max_tokens: value.json,
  system: value.choice(value.string, value.listOf<Block>()),
  messages: value.list<MessageItem>(),
  tools: value.listOf<{ name?: string; cache_control?: CacheControl | null; [field: string]: JsonLike }>(),
  thinking: value.object({ type: value.string, block_binding: value.object() }),
  output_config: value.object({ effort: value.string }),
  cache_control: value.object(),
};

export type MessagesBody = value.Fielded<typeof MESSAGES_ROWS>;
export type MessagesRead = MessagesBody & { model: string; messages: MessageItem[] };

export interface AnthropicUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens: number;
}

export type MessagesHead = {
  api: 'messages';
  model: string | null;
  maxTokens: JsonLike | null;
  toolChoice: JsonLike | null;
  thinking: NonNullable<MessagesBody['thinking']> | null;
  system: Array<{ text: string; cache: string | null; other?: string }>;
  tools: Array<{ name: string | undefined; sha: string }>;
  rest: string | null;
  headers: { beta: string[]; version: string | string[] | null };
  path?: string;
  query?: string;
};

export type MessagesWritten = {
  head: MessagesHead;
  model: string | null;
  maxTokens: JsonLike | null;
  stream: boolean;
  thinking: NonNullable<MessagesBody['thinking']> | null;
  system: { sha256: string; chars: number };
  tools: Array<string | undefined>;
  messages: Array<{ role: string; digest: string; blocks: BlockRecord[] }>;
  transformations?: Array<{ type: string; reason: string; path: string }>;
};

type MessagesRecord = RequestRecord & MessagesWritten;

interface ModelRules {
  cacheMinimum: number;
  effort: string | null;
  efforts: string[];
  prefill: boolean;
  thinks: 'off' | 'on' | 'always';
  refuses: Record<string, string>;
  manualInterleaves?: boolean;
  binds?: boolean;
  olderAccountTakesUnset?: boolean;
  disabledRefusedAt?: string[];
}

interface Element {
  hash: string;
  tokens: number;
  marker: CacheControl | null | undefined;
  position: number;
  run: string | null;
  part: { value: unknown; role: string; type: string; text: string | null };
  place: string | null;
}

export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Block[];
  stop_reason: string;
  stop_sequence: string | null;
  stop_details: StopDetails | null;
  usage: AnthropicUsage;
}

// The Messages API's refusal: `stop_details` is null for every stop reason but refusal, and on a refusal names the
// category that triggered it, one of five, or null where the refusal maps to no named category, with an explanation
// that is null too then. A stream carries it on `message_delta`, beside `stop_reason`
// (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback, "What a refusal looks like";
// https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals).
export const REFUSAL_CATEGORIES = ['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms'];
export interface StopDetails { type: 'refusal'; category: string | null; explanation: string | null }
export const stopDetailsOf = (stop: string, category: string | null = null): StopDetails | null => (stop !== 'refusal' ? null
  : { type: 'refusal', category, explanation: category === null ? null : `The stand-in refused this request as ${category}.` });

const MESSAGE_OVERHEAD = 4;
// The provider's prompt-cache lifetimes, 5 minutes or 1 hour, and its lookback: "The lookback window is 20 blocks.
// The system checks at most 20 positions for each breakpoint, counting the breakpoint itself as the first", where "a
// run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks"
// ("How automatic prefix checking works", https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
const LOOKBACK_POSITIONS = 20;
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
// The beta header under which the Messages API takes the binding control and reports what failed its check (membrane's
// THINKING_BINDING_BETA).
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
// By model, the provider's minimum cacheable prompt length, under which a prefix isn't cached even marked ("Cache
// limitations", https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and the effort it takes when a
// request sends none: "Most Claude models default to high effort ...; Claude Opus 5.5 and Claude Haiku 5.5 default
// to medium" (https://platform.claude.com/docs/en/build-with-claude/effort). Claude Haiku 4.5's minimum is 4,096 tokens,
// and its "Default effort" is "Not supported" (https://platform.claude.com/docs/en/models/haiku-4-5/overview), so none.
// And the efforts each takes, from the effort page's "Effort levels" table as read on 2026-11-08, whose rows are `max`,
// `xhigh`, `high`, `medium` and `low`: it gives `low`, `medium` and `high` no "Available on" list, `max` is "Available on ...
// Claude Opus 5.5, ... Claude Opus 4.6, ... and Claude Haiku 5.5", `xhigh` on "... Claude Opus 5.5, ... and Claude
// Haiku 5.5", not Claude Opus 4.6, and under it the page says "Not every model that supports `max` supports `xhigh`".
// And whether each takes a prefill: "Claude 4.6 and later models and Claude Mythos Preview do not support prefilling
// assistant messages" ("Prefill not supported", https://platform.claude.com/docs/en/api/errors, read 2026-11-08).
// And how each thinks, from the troubleshooting page's "Thinking support, defaults, and rejected configurations by model"
// (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting, read 2026-11-08): its Default
// column (`thinks`), where "Models marked `Always on` cannot turn thinking off. Models marked `On` default to thinking",
// and the `thinking.type` values it rejects with a 400 (`refuses`), with "Only Claude Sonnet 5.5 accepts
// `"between_tools"`", each refused with the words that page gives for it. Claude Haiku 5.5 accepts `"disabled"` only
// at effort `high` or below, refusing it at `xhigh` or `max` with the message that "names the level the request sent".
// Where a Claude 5 model thinks, "`thinking.display` defaults to `"omitted"`, so `thinking` blocks arrive with an empty
// `thinking` field alongside their `signature`" (https://platform.claude.com/docs/en/models/opus-5-5/migration-guide),
// and with `display: "updates"`, "reasoning blocks stream as they do under `"omitted"`"
// (https://platform.claude.com/docs/en/build-with-claude/thinking).
// And whether manual thinking (`type: "enabled"`) interleaves: "Claude Opus 4.6: manual mode has no interleaved
// thinking at all. Only its adaptive mode interleaves", and "Claude Haiku 4.5 does not support interleaved thinking"
// (https://platform.claude.com/docs/en/build-with-claude/extended-thinking, read 2026-11-08), where "Without interleaved
// thinking, Claude thinks once at the start of the assistant turn. Subsequent responses after tool results continue
// without new thinking blocks" (https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows).
// And whether it binds thinking: "A request that replays earlier thinking blocks to a Claude 5.1 or later model can fail
// with a 400 `invalid_request_error` whose message reads: ... The block is bound to a different conversation" (the
// troubleshooting page), so of the models the stand-in knows, Claude Opus 5.5 and Claude Haiku 5.5.
const NOT_ENABLED = '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
const NOT_DISABLED = '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
const NOT_BETWEEN_TOOLS = '"thinking.type.between_tools" is not supported for this model.';
const NOT_ADAPTIVE = 'adaptive thinking is not supported on this model';
const MODELS: Record<string, ModelRules> = {
  'claude-haiku-4-5-20251001': { cacheMinimum: 4096, effort: null, efforts: [], prefill: true, thinks: 'off', refuses: { adaptive: NOT_ADAPTIVE, between_tools: NOT_BETWEEN_TOOLS }, manualInterleaves: false },
  'claude-opus-4-6': { cacheMinimum: 4096, effort: 'high', efforts: ['low', 'medium', 'high', 'max'], prefill: false, thinks: 'off', refuses: { between_tools: NOT_BETWEEN_TOOLS }, manualInterleaves: false },
  'claude-opus-5-5': { cacheMinimum: 512, effort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], prefill: false, thinks: 'always', refuses: { enabled: NOT_ENABLED, disabled: NOT_DISABLED, between_tools: NOT_BETWEEN_TOOLS }, binds: true, olderAccountTakesUnset: true },
  'claude-haiku-5-5': { cacheMinimum: 512, effort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], prefill: false, thinks: 'on', refuses: { enabled: NOT_ENABLED, between_tools: NOT_BETWEEN_TOOLS }, disabledRefusedAt: ['xhigh', 'max'], binds: true },
};
// Anthropic's prompt-caching page's "What invalidates the cache" also keys the messages cache on `tool_choice`, and
// the system and messages caches on `speed`.
const UNMODELLED = ['tool_choice', 'speed'];
const CACHE_MINIMUM = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.cacheMinimum]));
export const bindsThinking = (model: string) => MODELS[model]?.binds === true;

function unmodelledField(body: MessagesBody) {
  const top = UNMODELLED.find((k) => Object.hasOwn(body, k));
  if (top) return top;
  if (!Object.hasOwn(body, 'output_config')) return null;
  const config = body.output_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'output_config';
  const other = Object.keys(config).find((k) => k !== 'effort');
  return other ? `output_config.${other}` : null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const elementsOf = new WeakMap<MessagesBody, Element[]>();

// Anthropic's API caches a request's prefix in the order it reads it: tools, then system, then messages.
function elements(body: MessagesBody): Element[] {
  const kept = elementsOf.get(body);
  if (kept) return kept;
  const out = elementsFrom(body);
  if (isParsed(body)) elementsOf.set(body, Object.freeze(out) as Element[]);
  return out;
}

function elementsFrom(body: MessagesBody) {
  const out: Element[] = [];
  let h = sha(String(body.model));
  const push = (value: unknown, tokens: number, marker: CacheControl | null | undefined, part: Element['part'], run: string | null = null, place: string | null = null) => {
    h = sha(h + JSON.stringify(readAlike(value)));
    const last = out.at(-1);
    out.push({ hash: h, tokens, marker, position: !last ? 0 : run && last.run === run ? last.position : last.position + 1, run, part, place });
  };
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(readAlike(tool)).length / RATE.json), tool.cache_control, { value: { tool }, role: 'tools', type: 'tool', text: null });
  for (const block of typeof body.system === 'string' ? [{ type: 'text', text: body.system }] as Block[] : body.system || []) push({ system: block }, blockTokens(block), block.cache_control, { value: { system: block }, role: 'system', type: String(block.type), text: block.type === 'text' ? block.text ?? '' : null });
  // Changing the thinking configuration (its mode and budget_tokens) invalidates the messages cache; the page names no
  // model that renders thinking ahead of tools and system ("What invalidates the cache", and "Thinking and prompt
  // caching" at https://platform.claude.com/docs/en/build-with-claude/thinking).
  // The same table says adding or removing images anywhere in the prompt does too, but requests to the API keyed an
  // image by its bytes alone (harness/README.md, "Reading a record": the stand-in's model of the prompt cache).
  // The same table: "Changing the `output_config.effort` value always invalidates message blocks, with the same
  // model-specific effect on tool and system caches as thinking parameters. Setting effort explicitly to the model's
  // default is equivalent to omitting it and does not invalidate."
  const effort = body.output_config?.effort;
  h = sha(h + JSON.stringify([body.thinking?.type ?? null, body.thinking?.budget_tokens ?? null, ...(effort !== undefined && effort !== (typeof body.model === 'string' ? MODELS[body.model]?.effort : undefined) ? [effort] : [])]));
  for (const [i, m] of (body.messages || []).entries()) {
    const blocks = blocksOf(m.content);
    blocks.forEach((block, j) => push({ message: i, role: m.role, block }, blockTokens(block) + (j === 0 ? MESSAGE_OVERHEAD : 0), block.cache_control, { value: { role: m.role, block: blockAlike(block) }, role: String(m.role), type: String(block.type), text: block.type === 'text' ? block.text ?? '' : null }, (['tool_use', 'tool_result'] as Array<string | undefined>).includes(block.type) ? block.type! : null, `${i}.${j}`));
  }
  if (body.cache_control && out.length) out.at(-1)!.marker = out.at(-1)!.marker ?? body.cache_control;
  return out;
}

export function countTokens(body: MessagesBody): number {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

export const contextParts = (body: MessagesBody, mask: (v: unknown) => unknown, memo: PartMemo | null = null): ContextPart[] => partsFrom(elements(body), mask, memo);

// The troubleshooting page: these models "accept a replayed thinking block only while the `system` prompt, `tools`,
// and messages that preceded it are unchanged" (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
// A message's tool result's `is_error: false` is bound as no flag, either way round, and `is_error: true` as sent
// (`blockAlike`); the same literal elsewhere, as in a tool's schema, is bound as sent. On
// Claude Haiku 5.5 (probed 2026-11-10), a block made after a result sent with `is_error: false` was kept under the drop
// control, and taken under "error", when the result came back with no flag, and dropped or refused when the result's text
// changed.
//
// A block's identity is the sha256 of `{"head":…,"messages":[…],"model":…,"system":…,"tools":…}` with the messages
// before its own, each message's own blocks read by `blockAlike`, read alike and its keys sorted. The text up to the
// messages is the same at every cut, and each message adds its own, so one running hash over the messages gives every
// cut's identity: at a cut it's copied and finished with the text after the messages. `identityBefore(i)` takes cuts in
// order, and a request is read once however many blocks it holds.
const boundMessage = (m: MessageItem) => (Array.isArray(m.content) ? { ...m, content: m.content.map(blockAlike) } : m);

function bindingIdentities(body: MessagesBody) {
  const messages = body.messages || [];
  const text = (v: unknown) => JSON.stringify(sorted(readAlike(v))) ?? 'null';
  let running: ReturnType<typeof createHash> | null = null;
  let after = '';
  let read = 0;
  return function identityBefore(cut: number) {
    if (!running) {
      const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'stream', 'metadata', 'system', 'tools', 'model'].includes(k)));
      const open = `{"head":${text(head)},"messages":[`;
      after = text({ model: body.model, system: body.system ?? null, tools: body.tools ?? null, head, messages: [] }).slice(open.length);
      running = createHash('sha256').update(open);
    }
    if (cut < read) throw new Error(`a binding identity before message ${cut} was asked for after message ${read - 1} was read`);
    for (; read < Math.min(cut, messages.length); read++) running.update(`${read ? ',' : ''}${text(boundMessage(messages[read]))}`);
    return running.copy().update(after).digest('hex');
  };
}

const digest64 = (text: string) => Buffer.from(sha(text), 'hex').toString('base64url');
const signatureFor = (identity: string, thinking: string) => `fx1.${digest64(`${identity}\n${thinking}`).slice(0, 22)}${digest64(thinking).slice(0, 21)}`;
const signs = (signature: unknown, thinking: string) => typeof signature === 'string' && signature.startsWith('fx1.') && signature.slice(4 + 22) === digest64(thinking).slice(0, 21);

const systemText = (body: MessagesBody) => (typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text || '').join('') : '');

const headerValues = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

function normalise(body: MessagesBody, headers: IncomingHttpHeaders, mask: Masker): MessagesWritten {
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : '';
  const digest = (v: unknown) => sha(JSON.stringify(sorted(mask(v ?? null)))).slice(0, 16);
  const { messages: _m, model: _o, max_tokens: _x, stream: _s, thinking: _t, tool_choice: _c, system: _y, tools: _l, ...rest } = body;
  const systemBlocks = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] as Block[] : Array.isArray(body.system) ? body.system : [];
  return {
    head: {
      api: 'messages',
      model: body.model ?? null,
      maxTokens: body.max_tokens ?? null,
      toolChoice: body.tool_choice ?? null,
      thinking: body.thinking ?? null,
      system: systemBlocks.map(({ type, text, cache_control: cc, ...rest }) => {
        const other = { ...(type !== 'text' ? { type: type ?? null } : {}), ...rest };
        return { text: mask(text ?? ''), cache: cc === undefined ? null : cc === null ? 'null' : markerOf(cc), ...(Object.keys(other).length ? { other: digest(other) } : {}) };
      }),
      tools: (body.tools || []).map((t) => ({ name: t.name, sha: digest(t) })),
      rest: Object.keys(rest).length ? JSON.stringify(sorted(mask.request(rest))) : null,
      headers: { beta: [...new Set(headerValues(headers['anthropic-beta']))].sort(), version: headers['anthropic-version'] ?? null },
    },
    model: body.model ?? null,
    maxTokens: body.max_tokens ?? null,
    stream: body.stream === true,
    thinking: body.thinking ?? null,
    system: { sha256: sha(system), chars: system.length },
    tools: (body.tools || []).map((t) => t.name),
    messages: ((record: (b: Block) => BlockRecord) => (Array.isArray(body.messages) ? body.messages : []).map((m) => ({ role: m.role, digest: digestOf(m, mask), blocks: blocksOf(m.content).map(record) })))(blockRecorder()),
  };
}

const withoutKept = (x: Block) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.cache_control == null) return x;
  const { cache_control: _c, ...rest } = x;
  return rest;
};
const withoutRecordedMarkers = (blocks: Block[]) => blocks.map((b) => {
  const rest = withoutKept(b);
  return rest?.type === 'tool_result' && Array.isArray(rest.content) ? { ...rest, content: rest.content.map(withoutKept) } : rest;
});
const digestOf = ({ role, content, ...envelope }: MessageItem, mask: Masker) => sha(JSON.stringify(mask({ role, content: withoutRecordedMarkers(blocksOf(content)), ...(sorted(envelope) as Record<string, unknown>) }))).slice(0, 16);

// The stand-in parses a body's integers past 2^53 as raw JSON, an object to `typeof`, where the API sees a number.
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !JSON.isRawJSON(v);
const kindRefusal = (block: unknown, at: string): string | null => (!isObject(block) ? `${at}: Input should be an object` : !Object.hasOwn(block, 'type') ? `${at}.type: Field required` : null);
// The fields the API requires of a block, by its type, in the order it judges them after the block's marker: the kind
// each holds, and the path its words name when the field holds another kind (a live probe of claude-haiku-5-5, Nov 11,
// 2026); a thinking's signature is named `signature.str` then, and `signature` when it's absent.
const FIELDS: Record<string, Array<[field: string, kind: 'string' | 'object', wrong: string]>> = {
  text: [['text', 'string', 'text']],
  thinking: [['thinking', 'string', 'thinking'], ['signature', 'string', 'signature.str']],
  redacted_thinking: [['data', 'string', 'data']],
  tool_use: [['id', 'string', 'id'], ['name', 'string', 'name'], ['input', 'object', 'input']],
  tool_result: [['tool_use_id', 'string', 'tool_use_id']],
};
const fieldRefusal = (block: object, at: string): string | null => {
  const fields = block as Record<string, unknown>;
  for (const [field, kind, wrong] of Object.hasOwn(FIELDS, String(fields.type)) ? FIELDS[String(fields.type)] : []) {
    if (!Object.hasOwn(fields, field)) return `${at}.${field}: Field required`;
    if (kind === 'string' ? typeof fields[field] !== 'string' : !isObject(fields[field])) return `${at}.${wrong}: Input should be ${kind === 'string' ? 'a valid string' : 'an object'}`;
  }
  return null;
};

// The Messages API's check of a request's content and cache markers, in its words (live probes of claude-haiku-5-5,
// Nov 11, 2026). A message's content is a string or a list, or it refuses "Input should be a valid array". A block, at
// the top level or inside a tool result's content, is an object, or it refuses "Input should be an object", and has a
// `type`, or it refuses "type: Field required". A field its type requires (`FIELDS`) that's absent it refuses as
// "Field required", and one holding another kind, `null` included, as "Input should be a valid string" or "Input should
// be an object". A tool result's content is a string, a list or null; a number, a boolean or an object it refuses as
// "Found a number" (or a boolean, an object) "but `tool_result` content must either be a string or a list of content
// blocks". A marker absent or null is none, and the shape it answers is `{type: "ephemeral"}` with a `ttl` of "5m" or
// "1h" or none, and no other key; any other shape it refuses with a 400 naming where the marker is, on a tool, a system
// block, a message block and a block inside a tool result alike. Inside a tool result's content it answers a marker
// only on the last block: a marker on an earlier block it refuses, naming the first such block by its index alone. Of
// several faults, it names the first on a tool, then in the messages, block by block: a block's kind, its marker, its
// fields in `FIELDS`' order, and for a tool result its content's kind, each inner block's kind, marker and fields, then
// where a marker sits, all before the next block; then on the system, and any of them before a missing `max_tokens`;
// the walk follows that order. Only a tool with no `type` was probed, whose path names it `custom`. A block's `type` the
// API doesn't know it refuses with words that list every tag it knows.
function contentRefusal(body: MessagesBody): Refusal | null {
  const judge = (marker: unknown, at: string): string | null => {
    if (marker === undefined || marker === null) return null;
    if (!isObject(marker)) return `${at}.cache_control: Input should be an object`;
    if (!Object.hasOwn(marker, 'type')) return `${at}.cache_control.type: Field required`;
    const { type, ttl, ...rest } = marker as Record<string, unknown>;
    if (type !== 'ephemeral') return `${at}.cache_control: Input tag '${String(type)}' found using 'type' does not match any of the expected tags: 'ephemeral'`;
    if (Object.hasOwn(marker, 'ttl') && ttl !== '5m' && ttl !== '1h') return `${at}.cache_control.ephemeral.ttl: Input should be '5m' or '1h'`;
    const [extra] = Object.keys(rest);
    return extra === undefined ? null : `${at}.cache_control.ephemeral.${extra}: Extra inputs are not permitted`;
  };
  const marked = (message: string | null): Refusal | null => (message === null ? null : { refused: 'cache-control', status: 400, message });
  const shaped = (message: string | null): Refusal | null => (message === null ? null : { refused: 'content', status: 400, message });
  for (const [i, tool] of (body.tools || []).entries()) {
    const refused = marked(judge(tool?.cache_control, `tools.${i}.${typeof tool?.type === 'string' ? tool.type : 'custom'}`));
    if (refused) return refused;
  }
  for (const [i, m] of (body.messages || []).entries()) {
    if (isObject(m) && m.content !== undefined && typeof m.content !== 'string' && !Array.isArray(m.content)) return shaped(`messages.${i}.content: Input should be a valid array`);
    for (const [j, block] of blocksOf(m?.content).entries()) {
      const kind = shaped(kindRefusal(block, `messages.${i}.content.${j}`));
      if (kind) return kind;
      const at = `messages.${i}.content.${j}.${String(block.type)}`;
      const refused = marked(judge(block.cache_control, at)) ?? shaped(fieldRefusal(block, at));
      if (refused) return refused;
      if (block.type !== 'tool_result') continue;
      const content: unknown = block.content;
      if (content != null && typeof content !== 'string' && !Array.isArray(content)) return shaped(`${at}.content: Found ${typeof content === 'boolean' ? 'a boolean' : typeof content === 'number' || JSON.isRawJSON(content) ? 'a number' : 'an object'}, but \`tool_result\` content must either be a string or a list of content blocks.`);
      const inners = blocksOf(content);
      for (const [k, inner] of inners.entries()) {
        const innerAt = `${at}.content.${k}.${String(inner?.type)}`;
        const nested = shaped(kindRefusal(inner, `${at}.content.${k}`)) ?? marked(judge(inner.cache_control, innerAt)) ?? shaped(fieldRefusal(inner, innerAt));
        if (nested) return nested;
      }
      const early = inners.slice(0, -1).findIndex((inner) => inner?.cache_control != null);
      if (early >= 0) return marked(`${at}.content.${early}.cache_control: cache_control may not be specified within \`tool_result.content\`. Instead, place it directly on \`tool_result\``);
    }
  }
  for (const [i, block] of (Array.isArray(body.system) ? body.system : []).entries()) {
    const refused = marked(judge(block?.cache_control, `system.${i}`));
    if (refused) return refused;
  }
  return null;
}

export function decodeMessages(body: MessagesBody): Decoded {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return { reason: 'no messages' };
  return { view: { model: body.model, maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined, system: systemText(body), messages: body.messages.map((m) => ({ ...m, content: blocksOf(m.content) })), tools: body.tools ?? [] } };
}

export function anthropicCache({ clock, minimums = CACHE_MINIMUM, uses = null }: { clock: () => number; minimums?: Record<string, number>; uses?: CacheUses | null }) {
  const cache = new Map<string, { expiresAt: number; ttl: number; by: string | null }>();
  const id = cacheId();
  return function usageFor(body: MessagesBody, outputTokens: number, who: string | null = null): AnthropicUsage {
    const now = clock();
    const els = elements(body);
    const total = els.reduce((t, e) => t + e.tokens, 0);
    const cum: number[] = []; let c = 0;
    for (const e of els) { c += e.tokens; cum.push(c); }
    const markers = els.map((e, i) => (e.marker ? i : -1)).filter((i) => i >= 0);
    let readAt = -1;
    const looked = new Set<number>();
    for (const m of markers) {
      for (let j = m; j >= 0 && els[m].position - els[j].position < LOOKBACK_POSITIONS; j--) {
        looked.add(j);
        const entry = cache.get(els[j].hash);
        if (entry && entry.expiresAt > now && j > readAt) readAt = j;
      }
    }
    const read = readAt >= 0 ? cum[readAt] : 0;
    const lifetime = (m: number) => (els[m].marker!.ttl === '1h' ? ONE_HOUR : FIVE_MINUTES);
    const use: CacheUse = { cache: id, seq: uses?.size ?? 0, read: null, writes: [], passed: [...looked].filter((j) => j > readAt).sort((a, b) => b - a).map((j) => els[j].hash), marks: markers.map((m) => ({ at: m, ttl: lifetime(m) })) };
    if (readAt >= 0) {
      const was = cache.get(els[readAt].hash)!;
      const marked = els[readAt].marker;
      use.read = { hash: els[readAt].hash, by: was.by, at: readAt };
      const ttl = marked?.ttl === '1h' || was.ttl === ONE_HOUR ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[readAt].hash, { expiresAt: now + ttl, ttl, by: was.by });
    }
    const split = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    let written = read;
    for (const m of markers) {
      if (m <= readAt || cum[m] < (typeof body.model === 'string' ? minimums[body.model] ?? -Infinity : -Infinity)) continue;
      const ttl = els[m].marker!.ttl === '1h' ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[m].hash, { expiresAt: now + ttl, ttl, by: who });
      use.writes.push(els[m].hash);
      split[ttl === ONE_HOUR ? 'ephemeral_1h_input_tokens' : 'ephemeral_5m_input_tokens'] += cum[m] - written;
      written = cum[m];
    }
    const creation = written - read;
    if (who !== null) uses?.set(who, use);
    return { input_tokens: total - written, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: split, output_tokens: outputTokens };
  };
}

export const messageOf = ({ body, record, content, stop, stopSequence = null, category = null, usage }: { body: MessagesRead; record: RequestRecord; content: Block[]; stop: string; stopSequence?: string | null; category?: string | null; usage: AnthropicUsage }): Message => ({ id: `msg_${record.id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: stopSequence, stop_details: stopDetailsOf(stop, category), usage });

export function streamEvents(message: Message, content: Block[], stop: string, usage: AnthropicUsage) {
  const out: Array<{ type: string; [field: string]: unknown }> = [];
  const ev = (type: string, data: Record<string, unknown>) => out.push({ type, ...data });
  ev('message_start', { message: { ...message, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { ...usage, output_tokens: 1 } } });
  content.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: message.stop_sequence, stop_details: message.stop_details }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {});
  return out;
}

export function anthropic({ configuration: config, clock, minimums = CACHE_MINIMUM, runDir = null, models = {}, refreshes = false, uses = null }: { configuration: Configuration; clock: () => number; minimums?: Record<string, number>; runDir?: string | null; models?: Record<string, string>; refreshes?: boolean; uses?: CacheUses | null }) {
  const usageFor = anthropicCache({ clock, minimums, uses });
  const rulesOf = (model: string | null | undefined): ModelRules | undefined => (typeof model === 'string' ? MODELS[models[model] ?? model] : undefined);

  function read(body: MessagesBody): Read {
    const unmodelled = body && typeof body === 'object' ? unmodelledField(body) : null;
    if (unmodelled) return { reason: `it carries \`${unmodelled}\`, which the stand-in's prompt cache doesn't model` };
    const decoded = decodeMessages(body);
    if (decoded.reason) return decoded;
    if (!decoded.view!.messages.length) return { reason: 'no messages' };
    const model = body.model;
    if (typeof model !== 'string' || !Object.hasOwn(minimums, model)) return { reason: `the stand-in knows no minimum cacheable length for the model ${model}` };
    const effort = body.output_config?.effort;
    if (effort !== undefined && !Object.hasOwn(MODELS, model)) return { reason: `it carries \`output_config.effort\`, and the stand-in knows no default effort for the model ${model}` };
    if (effort !== undefined && MODELS[model].effort === null) return { reason: `it carries \`output_config.effort\`, and the model ${model} takes no effort` };
    if (effort !== undefined && (typeof effort !== 'string' || !MODELS[model].efforts.includes(effort))) return { reason: `it carries \`output_config.effort\` ${JSON.stringify(effort)}, which the model ${model} doesn't take` };
    if (body.max_tokens === 0 && !refreshes) return { reason: 'max_tokens 0, the shape of a cache keepalive refresh' };
    const length = decoded.view!.messages.length;
    return { view: { ...decoded.view!, seed: () => parseInt(bindingIdentities(maskRunVarying(body, { runDir }))(length).slice(0, 8), 16) } };
  }


  function unbound(body: MessagesBody) {
    if (rulesOf(body.model)?.binds !== true) return [];
    const out: Array<{ i: number; j: number }> = [];
    const identityBefore = bindingIdentities(body);
    for (const [i, m] of (body.messages ?? []).entries()) {
      for (const [j, b] of blocksOf(m.content).entries()) {
        if (b.type === 'thinking' && b.signature !== signatureFor(identityBefore(i), b.thinking ?? '')) out.push({ i, j });
      }
    }
    return out;
  }
  const dropsUnbound = (body: MessagesBody) => body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block';
  const readings = new WeakMap<MessagesBody, { read: MessagesBody; gone: ReadonlySet<string> }>();
  function reading(body: MessagesBody): { read: MessagesBody; gone: ReadonlySet<string> } {
    const kept = readings.get(body);
    if (kept) return kept;
    const gone = new Set((dropsUnbound(body) ? unbound(body) : []).map(({ i, j }) => `${i}.${j}`));
    const read: MessagesBody = !gone.size ? body : { ...body, messages: (body.messages ?? []).map((m, i) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((_, j) => !gone.has(`${i}.${j}`)) } : m)) };
    if (isParsed(body)) {
      if (read !== body) {
        for (const m of read.messages ?? []) { Object.freeze(m.content); Object.freeze(m); }
        Object.freeze(read.messages);
        markParsed(Object.freeze(read));
      }
      readings.set(body, { read, gone });
    }
    return { read, gone };
  }
  function asRead(body: MessagesBody): MessagesBody {
    return reading(body).read;
  }
  // The extended-thinking page: "If thinking blocks are modified, the API returns a 400 `invalid_request_error`
  // whose message contains `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be
  // modified" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking). The troubleshooting page:
  // where a signature "didn't verify: it was truncated, altered, or sent back empty", "`prefix_mismatch_behavior`
  // doesn't apply. Edited thinking text returns a different error. See A 400 error says thinking blocks cannot be
  // modified" (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), which doesn't limit
  // edited text to the latest message. So where the model binds, and earlier thinking is replayed, an edited block in
  // any assistant message is refused with that error's wording, and the binding check sees only blocks whose text
  // verifies; elsewhere only the latest message is checked.
  function modifiedThinking(body: MessagesRead) {
    const last = body.messages.findLastIndex((m) => m.role === 'assistant');
    for (const [i, m] of body.messages.entries()) {
      if (m.role !== 'assistant' || (i !== last && rulesOf(body.model)?.binds !== true)) continue;
      const j = blocksOf(m.content).findIndex((b) => b.type === 'thinking' && !signs(b.signature, b.thinking ?? ''));
      if (j >= 0) return `messages.${i}.content.${j}: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
    }
    return null;
  }
  // What's new in Claude Opus 5.5 (https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5): "A request
  // that replays a block after such a change and leaves `thinking.block_binding.prefix_mismatch_behavior` unset gets a
  // 400 error on accounts created on or after August 31, 2026, 00:00 UTC. … On accounts created before that date, the
  // request gets the error only when it sets the field to `"error"`." Each model's page gives its own rule:
  // "What's new in Claude Haiku 5.5" gives none
  // (https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5, read 2026-11-08), and the Claude
  // Fable 5.1 and Claude Mythos 5.1 migration guide gives Mythos 5.1 the 400 for an unset field on any account.
  function bindingRefusal(body: MessagesRead) {
    if (dropsUnbound(body)) return null;
    if (config.account === 'older' && MODELS[body.model]?.olderAccountTakesUnset && body.thinking?.block_binding?.prefix_mismatch_behavior !== 'error') return null;
    const [first] = unbound(body);
    return first ? `messages.${first.i}.content.${first.j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` : null;
  }

  function refusal(body: MessagesRead): Refusal | null {
    const content = contentRefusal(body);
    if (content) return content;
    if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < (refreshes ? 0 : 1)) return { refused: 'max_tokens', status: 400, message: 'max_tokens: Field required' };
    // The API judges a user message's empty content after every check of the request's shape, `max_tokens` included, and
    // answers an assistant message's (a live probe of claude-haiku-5-5, Nov 11, 2026). Its place among the checks below
    // wasn't probed.
    const empty = body.messages.findIndex((m) => m?.role === 'user' && (m.content === '' || (Array.isArray(m.content) && !m.content.length)));
    if (empty >= 0) return { refused: 'content', status: 400, message: `messages.${empty}: user messages must have non-empty content` };
    if (body.messages.at(-1)?.role === 'assistant' && rulesOf(body.model)?.prefill === false) return { refused: 'prefill', status: 400, message: 'This model does not support assistant message prefill. The conversation must end with a user message.' };
    const refuses = rulesOf(body.model)?.refuses;
    const type = body.thinking?.type;
    const mode = refuses && typeof type === 'string' && Object.hasOwn(refuses, type) ? refuses[type] : undefined;
    if (mode) return { refused: 'thinking-mode', status: 400, message: mode };
    const effort = body.output_config?.effort ?? rulesOf(body.model)?.effort;
    if (body.thinking?.type === 'disabled' && rulesOf(body.model)?.disabledRefusedAt?.includes(effort!)) return { refused: 'thinking-mode', status: 400, message: `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.` };
    const tooLong = countTokens(asRead(body));
    if (tooLong > config.windowTokens) return { refused: 'window', status: 400, message: `prompt is too long: ${tooLong} tokens > ${config.windowTokens} maximum` };
    const modified = modifiedThinking(body);
    if (modified) return { refused: 'thinking-modified', status: 400, message: modified };
    const binding = bindingRefusal(body);
    if (binding) return { refused: 'thinking', status: 400, message: binding };
    return null;
  }

  const seal = (content: Block[], body: MessagesRead) => {
    const identity = bindingIdentities(body)(body.messages.length);
    const thinks = rulesOf(body.model)?.thinks;
    const always = thinks === 'always' || (thinks === 'on' && body.thinking?.type !== 'disabled');
    const omitted = always && body.thinking?.display !== 'summarized';
    const turn = body.messages.slice(body.messages.findLastIndex((m) => m.role !== 'user') + 1).flatMap((m) => blocksOf(m.content));
    const midTurn = body.thinking?.type === 'enabled' && rulesOf(body.model)?.manualInterleaves === false && turn.some((b) => b.type === 'tool_result');
    const led = midTurn ? content.filter((b) => b.type !== 'thinking') : always && content[0]?.type !== 'thinking' ? [{ type: 'thinking', thinking: '' }, ...content] : content;
    return led.map((b) => {
      if (b.type !== 'thinking') return b;
      const thinking = omitted ? '' : b.thinking!;
      return { ...b, thinking, signature: signatureFor(identity, thinking) };
    });
  };

  const error = (res: ServerResponse, status: number, message: string, { type = 'invalid_request_error', headers = {} }: { type?: string | null; headers?: Record<string, string> } = {}) => {
    const body = JSON.stringify({ type: 'error', error: { type, message } });
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin', ...headers });
    res.end(body);
  };

  // The beta Messages reference: "Changes the API made to the request's input before showing it to the model, and blocks
  // that failed a binding check but were left unchanged: one entry per block, in request order", `thinking_dropped` for a
  // block removed and `thinking_mismatch_allowed` for one "shown to the model all the same, because that check is not
  // enforced for this request". It "Requires `anthropic-beta: thinking-binding-controls-2026-08-01`" and is "Present on
  // every such response from a model that supports extended thinking, as `[]` when there is no entry to report", which
  // every model the stand-in knows does
  // (https://platform.claude.com/docs/en/api/typescript/beta/messages/create).
  function transformationsOf(body: MessagesRead) {
    const type = dropsUnbound(body) ? 'thinking_dropped' : 'thinking_mismatch_allowed';
    return unbound(body).map(({ i, j }) => ({ type, reason: 'prefix_binding_mismatch', path: `messages.${i}.content.${j}` }));
  }

  function send(res: ServerResponse, { body, record, content, stop, stopSequence, category, usage }: Sent & { body: MessagesRead; record: MessagesRecord; usage: AnthropicUsage }) {
    const transformations = transformationsOf(body);
    record.transformations = transformations;
    const reported = (record.head?.headers?.beta ?? []).includes(BINDING_BETA);
    const message = { ...messageOf({ body, record, content, stop, stopSequence, category, usage }), ...(reported ? { input_transformations: transformations } : {}) };
    if (!body.stream) {
      const out = JSON.stringify(message);
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${record.id}` });
      res.end(out);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${record.id}` });
    for (const event of streamEvents(message, content, stop, usage)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }

  return {
    path: '/v1/messages',
    routes: (method: string | undefined, path: string) => method === 'POST' && path.endsWith('/v1/messages'),
    gate: (body: unknown) => value.gate('Messages', MESSAGES_ROWS, body),
    read,
    record: normalise,
    refusal,
    seal,
    shown: (content: Block[]) => content,
    usage: (body: MessagesBody, outputTokens: number, _content: Block[] = [], who: string | null = null) => usageFor(asRead(body), outputTokens, who),
    tokens: (u: AnthropicUsage) => ({ input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens }),
    send,
    error,
    countTokens: (body: MessagesBody) => countTokens(asRead(body)),
    context: (body: MessagesBody, mask: (v: unknown) => unknown, memo: PartMemo | null = null) => {
      const { read, gone } = reading(body);
      return { parts: contextParts(read, mask, memo), withheld: gone.size ? partsFrom(elements(body).filter((e) => e.place !== null && gone.has(e.place)), mask, memo) : [] };
    },
  };
}
