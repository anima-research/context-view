import { createHash } from 'node:crypto';
import { maskRunVarying } from '../strategies/compare.ts';
import { asWritten } from '../strategies/control.ts';
import { anthropicCache, countTokens as anthropicTokens, contextParts as anthropicParts } from './anthropic.ts';
import { cacheId, prefixOf, promptCache } from './openai-cache.ts';
import type { CacheUses } from './openai-cache.ts';
import { partsFrom, textOf } from './seams.ts';
import { blockTokens, RATE } from './tokens.ts';
import { blockRecord, blocksOf, sorted } from './view.ts';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { JsonLike, Masker } from '../strategies/compare.ts';
import type { MessagesBody } from './anthropic.ts';
import type { ContextPart, PartMemo } from './seams.ts';
import type { Configuration, Decoded, Read, Refusal, Sent } from './standin.ts';
import type { Block, BlockRecord, CacheControl, Message } from './view.ts';

type ChatPart = { type?: string; text?: string; refusal?: string; image_url?: { url?: JsonLike; [field: string]: JsonLike }; cache_control?: CacheControl | null; [field: string]: JsonLike };

type ChatMessage = {
  role?: string;
  content?: string | ChatPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  reasoning?: JsonLike;
  reasoning_content?: JsonLike;
  prefix?: JsonLike;
  [field: string]: JsonLike;
};

type ChatTool = { type?: string; name?: string; function?: { name?: string; description?: string; parameters?: JsonLike; [field: string]: JsonLike }; [field: string]: JsonLike };

export type ChatBody = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: ChatTool[];
  tool_choice?: JsonLike;
  reasoning_effort?: string;
  thinking?: { type?: string; [field: string]: JsonLike };
  stream?: boolean;
  stream_options?: { include_usage?: boolean; [field: string]: JsonLike };
  n?: JsonLike;
  prompt_cache_options?: { mode?: string; ttl?: JsonLike; [field: string]: JsonLike };
  [field: string]: JsonLike;
};

type Dialect = 'openai' | 'deepseek' | 'openrouter';

export type ChatWritten = {
  head: {
    api: 'chat-completions';
    dialect: Dialect;
    model: string | null;
    maxTokens: number | null;
    maxCompletionTokens: number | null;
    toolChoice: JsonLike | null;
    reasoningEffort: string | null;
    thinking: ChatBody['thinking'] | null;
    streamOptions: ChatBody['stream_options'] | null;
    tools: Array<{ name: string | null; sha: string }>;
    rest: string | null;
    headers:
      | { referer: string | string[] | null; title: string | string[] | null; organization?: undefined; project?: undefined }
      | { organization: string | string[] | null; project: string | string[] | null; referer?: undefined; title?: undefined };
    path?: string;
    query?: string;
  };
  model: string | null;
  maxTokens: number | null;
  stream: boolean;
  thinking: string | ChatBody['thinking'] | null;
  system: { sha256: string; chars: number };
  tools: Array<string | null>;
  messages: Array<{ role: string | null; side: Side | null; digest: string; blocks: Array<BlockRecord & { field?: JsonLike; sealed?: boolean }> }>;
};

export type ChatReply = {
  role: 'assistant';
  content: string | null;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: ChatCall[];
  refusal?: string | null;
};

type ChatCall = { id: string | undefined; type: 'function'; function: { name: string | undefined; arguments: string } };

type Side = 'system' | 'user' | 'assistant';

type DecodedMessage = { side: Side; blocks: Block[]; reason?: undefined } | { reason: string; side?: undefined; blocks?: undefined };

export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details: { reasoning_tokens: number };
};

// The Chat Completions API, in each dialect a run or a test reaches, each from its vendor's own documentation:
// - `openai`, OpenAI's own (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create,
//   read Nov 7 2026), which "OpenAI-compatible" names. A reasoning model's reasoning isn't sent; its tokens are
//   counted in `completion_tokens` and `completion_tokens_details.reasoning_tokens`.
// - `deepseek`, DeepSeek's (https://api-docs.deepseek.com/api/create-chat-completion and the guides it links, read
//   Nov 7 2026), whose reasoning comes as `reasoning_content`, the convention membrane's OpenAI-compatible adapter
//   reads as an alias of `reasoning`.
// Each dialect serves its vendor's own path, so a route names the dialect.
const DIALECTS: Record<Dialect, { path: string; models: Record<string, { maxOutput: number; anthropic?: string }>; reasoningField: 'reasoning' | 'reasoning_content' | null }> = {
  openai: {
    path: '/v1/chat/completions',
    // GPT-5.6 Sol's model page: "Chat Completions | `v1/chat/completions` | Supported", function_calling among its
    // features, "128,000 max output tokens" (https://developers.openai.com/api/docs/models/gpt-5.6-sol). It's GPT-5.6,
    // whose prompt cache openai-cache.ts models. GPT-6.1 Sol's page says "Tool calling requires the Responses API",
    // and GPT-6 Sol's that "Chat Completions supports function calling only with `reasoning_effort` set to `none`",
    // so neither serves a resident, whose every request declares tools.
    models: { 'gpt-5.6-sol': { maxOutput: 128_000 } },
    reasoningField: null,
  },
  deepseek: {
    path: '/chat/completions',
    // The models page: deepseek-flash's "MAX OUTPUT" is "MAXIMUM: 384K", which the API reference writes as 393216; with
    // no max_tokens, "the default is 8K in non-thinking mode, 64K in thinking mode (128K with reasoning_effort set to
    // max)" (https://api-docs.deepseek.com/quick_start/pricing, https://api-docs.deepseek.com/api/create-chat-completion).
    models: { 'deepseek-flash': { maxOutput: 393_216 } },
    reasoningField: 'reasoning_content',
  },
  openrouter: {
    // membrane's OpenRouterAdapter's default base URL, https://openrouter.ai/api/v1 (openrouter.ts:169).
    path: '/api/v1/chat/completions',
    // Claude Opus 4.6 through OpenRouter: its public model list gives `anthropic/claude-opus-4.6` 1,000,000 tokens of
    // context and 128,000 of completion (https://openrouter.ai/api/v1/models, read Nov 7 2026). OpenRouter's caching
    // guide says a Claude model caches by Anthropic's own rules, with `cache_control` on content blocks
    // (https://openrouter.ai/docs/features/prompt-caching), so its request is priced by anthropic.ts's cache, in the
    // Messages body it's forwarded as (`forwarded`, below), under its Anthropic name.
    models: { 'anthropic/claude-opus-4.6': { maxOutput: 128_000, anthropic: 'claude-opus-4-6' } },
    // The API reference's assistant message carries a reply's reasoning as `reasoning`, "Reasoning output", beside
    // `reasoning_details`, which the stand-in doesn't send (https://openrouter.ai/docs/api-reference/chat-completion).
    // membrane 0.8.0's OpenRouterAdapter reads neither.
    reasoningField: 'reasoning',
  },
};
const MESSAGE_OVERHEAD = 4;
const NAMED = ['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'tools', 'tool_choice', 'reasoning_effort', 'thinking'];
const SIDES: Record<string, Side> = { system: 'system', developer: 'system', user: 'user', assistant: 'assistant', tool: 'user' };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const digest64 = (text: string) => Buffer.from(sha(text), 'hex').toString('base64url');
const SEAL = /\nrx1\.([A-Za-z0-9_-]{22})$/;
const mint = (thinking: string) => `${thinking}\nrx1.${digest64(thinking).slice(0, 22)}`;
const minted = (text: unknown) => {
  const m = SEAL.exec(typeof text === 'string' ? text : '');
  return Boolean(m) && digest64((text as string).slice(0, m!.index)).slice(0, 22) === m![1];
};

const parsed = (text: string | undefined): JsonLike => { try { return JSON.parse(text as string, asWritten); } catch { return text; } };
function imageOf(url: JsonLike): Block {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(typeof url === 'string' ? url : '');
  return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url } };
}
const PARTS = new Set<string | undefined>(['text', 'refusal', 'image_url']);
function partOf(p: ChatPart): Block {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (p?.type === 'text') return { type: 'text', text: p.text ?? '', ...(p.cache_control != null ? { cache_control: p.cache_control } : {}) };
  if (p?.type === 'refusal') return { type: 'text', text: p.refusal ?? '' };
  if (p?.type === 'image_url') return imageOf(p.image_url?.url);
  return p && typeof p === 'object' ? { ...p, type: p.type ?? 'unknown' } : { type: 'unknown', value: p };
}
const unknownPart = (body: ChatBody) => body.messages.flatMap((m) => (Array.isArray(m?.content) ? m.content : [])).find((p) => typeof p !== 'string' && !PARTS.has(p?.type));
const contentOf = (content: ChatMessage['content']): Block[] => (typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : Array.isArray(content) ? content.map(partOf) : []);
// membrane's adapter reads either field, `reasoning` first unless it's blank (reasoningOf, openai-compatible.ts:49).
const reasoningOf = (m: ChatMessage): { text: string; field: 'reasoning' | 'reasoning_content' } | null => (typeof m?.reasoning === 'string' && m.reasoning.trim() ? { text: m.reasoning, field: 'reasoning' }
  : typeof m?.reasoning_content === 'string' && m.reasoning_content.trim() ? { text: m.reasoning_content, field: 'reasoning_content' } : null);

function decode(m: ChatMessage): DecodedMessage {
  const side = Object.hasOwn(SIDES, m?.role ?? '') ? SIDES[m.role!] : null;
  if (!side) return { reason: `it carries a message whose role is ${JSON.stringify(m?.role ?? null)}` };
  if (m.content != null && typeof m.content !== 'string' && !Array.isArray(m.content)) return { reason: `it carries a ${m.role} message whose content is ${typeof m.content === 'object' ? 'an object' : `a ${typeof m.content}`}, neither text nor a list of parts` };
  if (m.role === 'tool') return { side, blocks: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : contentOf(m.content) }] };
  if (m.role !== 'assistant') return { side, blocks: contentOf(m.content) };
  const reasoning = reasoningOf(m);
  return {
    side,
    blocks: [
      ...(reasoning ? [{ type: 'thinking', thinking: reasoning.text, field: reasoning.field }] : []),
      ...contentOf(m.content),
      ...(m.tool_calls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.function?.name, input: parsed(c.function?.arguments) })),
    ],
  };
}

const toolName = (t: ChatTool) => t?.function?.name ?? t?.name ?? t?.type ?? null;
const thinksIn = (body: ChatBody) => body.thinking?.type !== 'disabled';

// The prompt as OpenAI's cache reads it: tools, then the messages in order. Its chain starts from the model alone: the
// prompt-caching guide's "Which settings affect the cached prefix?" names Responses API fields (`parallel_tool_calls`,
// `text.format`, `reasoning.effort`, `text.verbosity`), each linked to that API's reference, and doesn't say whether
// their Chat Completions counterparts act alike, so the stand-in doesn't guess. A message's end is eligible where it's a
// user message, or the last of a run of tool messages. The initial system or developer group's end is eligible too, but
// the cache writes only at the latest eligible ending, which a request the stand-in serves always has after it, so no
// entry is ever there to read.
function elements(body: ChatBody) {
  const { push, elements: out } = prefixOf(body.model);
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(tool).length / RATE.json), false, { value: { tool }, role: 'tools', type: 'tool', text: null });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((m, i) => {
    const tokens = (decode(m).blocks ?? []).reduce((t, b) => t + blockTokens(b), 0) + MESSAGE_OVERHEAD;
    push({ message: m }, tokens, m?.role === 'user' || (m?.role === 'tool' && messages[i + 1]?.role !== 'tool'), { value: { message: m }, role: String(m?.role), type: 'message', text: textOf(m?.content, Array.isArray(m?.content) ? m.content : undefined) });
  });
  return out;
}

export function countTokens(body: ChatBody): number {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

export const contextParts = (body: ChatBody, mask: (v: unknown) => unknown, memo: PartMemo | null = null): ContextPart[] => partsFrom(elements(body), mask, memo);

function identity(body: ChatBody, beforeMessage: number) {
  const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'stream', 'stream_options', 'tools', 'model'].includes(k)));
  return sha(JSON.stringify(sorted({ model: body.model, tools: body.tools ?? null, head, messages: body.messages.slice(0, beforeMessage) })));
}

// The Messages body a Claude model's Chat Completions request is forwarded to Anthropic as, so Anthropic's cache rule
// has a body to apply to. OpenRouter doesn't document what it forwards, so this map is the stand-in's own: the system
// messages' parts with their markers as the system, each other message's blocks with theirs, its calls as `tool_use`
// and a tool message as a `tool_result`, consecutive messages on one side as one, and the tools by name. A marker is a
// text part's: the reference gives an image part none, and `read` refuses a request that marks one.
export function forwarded(body: ChatBody, anthropicModel: string): MessagesBody {
  const system: Block[] = [];
  const messages: Message[] = [];
  for (const m of body.messages || []) {
    const d = decode(m);
    if (d.reason) continue;
    const blocks = d.blocks!.map(({ field: _f, ...b }) => b);
    if (d.side === 'system') { system.push(...blocks.filter((b) => b.type === 'text')); continue; }
    if (messages.at(-1)?.role === d.side) messages.at(-1)!.content.push(...blocks);
    else messages.push({ role: d.side!, content: blocks });
  }
  return {
    model: anthropicModel,
    ...(system.length ? { system } : {}),
    messages,
    tools: (body.tools || []).map((t) => (t?.type === 'function' && t.function ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters } : t)),
  };
}

export function decodeChat(body: ChatBody): Decoded {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return { reason: 'no messages' };
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some((t) => !t || typeof t !== 'object' || Array.isArray(t)))) return { reason: 'its tools aren\'t a list of objects' };
  const messages: Message[] = [];
  const system: string[] = [];
  for (const m of body.messages) {
    const d = decode(m);
    if (d.reason) return { reason: d.reason };
    if (d.side === 'system') { system.push(...d.blocks!.filter((b) => b.type === 'text').map((b) => b.text!)); continue; }
    if (messages.at(-1)?.role === d.side) messages.at(-1)!.content.push(...d.blocks!);
    else messages.push({ role: d.side!, content: [...d.blocks!] });
  }
  return {
    view: {
      model: body.model,
      maxTokens: body.max_completion_tokens ?? body.max_tokens ?? null,
      system: system.join('\n'),
      messages,
      tools: (body.tools || []).map((t) => (t?.type === 'function' && t.function ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters } : t)),
    },
  };
}

export function chat({ configuration: config, clock, dialect: name, runDir = null, uses = null }: { configuration: Configuration; clock: () => number; dialect: Dialect; runDir?: string | null; uses?: CacheUses | null }) {
  const dialect = DIALECTS[name];
  const cached = promptCache({ clock, uses });
  const claudeCache = anthropicCache({ clock, uses });
  const count = (body: ChatBody) => (name === 'openrouter' ? anthropicTokens(forwarded(body, dialect.models[body.model]?.anthropic ?? body.model)) : countTokens(body));
  // DeepSeek's context caching guide: "Each request will produce two cache prefix units at the end position of the
  // user input and the end position of the model output. A subsequent request can hit the cache if it fully matches
  // them", and a unit is cleared "usually within a few hours to a few days" once unused
  // (https://api-docs.deepseek.com/guides/kv_cache). Its other two ways to persist a unit, a detected common prefix and
  // "fixed token intervals", aren't specified closely enough to model, so the stand-in persists only those two, and
  // keeps them for the run. A unit is matched by the request's messages as the stand-in reads them, so a reasoning
  // text sent back under either field matches the answer it came from.
  const units = new Map<string, string | null>();
  const unitsId = cacheId();

  function read(body: ChatBody): Read {
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return { reason: 'no messages' };
    if (body.n != null && body.n !== 1) return { reason: `it asks for ${body.n} choices, which the stand-in doesn't model` };
    if (body.prompt_cache_options?.mode === 'explicit' || JSON.stringify(body.messages).includes('"prompt_cache_breakpoint"')) return { reason: 'it places explicit cache breakpoints, which the stand-in\'s prompt cache doesn\'t model' };
    if (body.messages.some((m) => m?.prefix === true)) return { reason: 'it asks for a prefix completion, which the stand-in doesn\'t model' };
    // OpenRouter's Chat Completions reference gives `cache_control` to a text part alone (ChatContentText; its
    // ChatContentImage has none), so what it forwards for a marked image isn't documented, and the stand-in doesn't guess.
    if (name === 'openrouter' && body.messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url' && p.cache_control != null))) return { reason: 'it marks an image part with cache_control, which OpenRouter\'s Chat Completions reference gives text parts alone, so what it forwards isn\'t documented' };
    const part = unknownPart(body);
    if (part !== undefined) return { reason: `it carries a content part of type ${JSON.stringify(part?.type ?? null)}, which the stand-in doesn't model` };
    // The Chat Completions reference: `prompt_cache_options.ttl` "Defaults to `30m`, which is currently the only supported
    // value" (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
    const ttl = body.prompt_cache_options?.ttl;
    if (ttl != null && ttl !== '30m') return { reason: `it asks for a cache lifetime of ${JSON.stringify(ttl)}, and the Chat Completions reference gives "30m" as the only supported value` };
    const model = Object.hasOwn(dialect.models, body.model) ? dialect.models[body.model] : null;
    if (!model) return { reason: `the stand-in knows no output limit or cache rules for the model ${body.model} on ${name}'s Chat Completions` };
    const decoded = decodeChat(body);
    if (decoded.reason) return decoded;
    if (!decoded.view!.messages.length) return { reason: 'its messages hold only system or developer messages' };
    const unset = name === 'deepseek' ? (thinksIn(body) ? (body.reasoning_effort === 'max' ? 131_072 : 65_536) : 8_192) : model.maxOutput;
    return { view: { ...decoded.view!, maxTokens: decoded.view!.maxTokens ?? unset, seed: () => parseInt(identity(maskRunVarying(body, { runDir }), body.messages.length).slice(0, 8), 16) } };
  }

  function record(body: ChatBody, headers: IncomingHttpHeaders, mask: Masker): ChatWritten {
    const digest = (v: unknown) => sha(JSON.stringify(sorted(mask(v ?? null)))).slice(0, 16);
    const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !NAMED.includes(k)));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => SIDES[m?.role as string] === 'system').flatMap((m) => contentOf(m.content)).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const block = (b: Block) => (b.type === 'thinking' ? { ...blockRecord(b), field: b.field, sealed: minted(b.thinking) } : blockRecord(b));
    return {
      head: {
        api: 'chat-completions',
        dialect: name,
        model: body.model ?? null,
        maxTokens: body.max_tokens ?? null,
        maxCompletionTokens: body.max_completion_tokens ?? null,
        toolChoice: body.tool_choice ?? null,
        reasoningEffort: body.reasoning_effort ?? null,
        thinking: body.thinking ?? null,
        streamOptions: body.stream_options ?? null,
        tools: (body.tools || []).map((t) => ({ name: toolName(t), sha: digest(t) })),
        rest: Object.keys(rest).length ? JSON.stringify(sorted(mask.request(rest))) : null,
        // OpenRouter's app attribution headers, which membrane's adapter always sends (openrouter.ts, getHeaders); OpenAI's
        // organization and project headers elsewhere.
        headers: name === 'openrouter'
          ? { referer: headers['http-referer'] ?? null, title: headers['x-title'] ?? null }
          : { organization: headers['openai-organization'] ?? null, project: headers['openai-project'] ?? null },
      },
      model: body.model ?? null,
      maxTokens: body.max_completion_tokens ?? body.max_tokens ?? null,
      stream: body.stream === true,
      thinking: body.reasoning_effort ?? body.thinking ?? null,
      system: { sha256: sha(system), chars: system.length },
      tools: (body.tools || []).map(toolName),
      messages: messages.map((m) => {
        const d = decode(m);
        return { role: m?.role ?? null, side: d.side ?? null, digest: digest(m), blocks: (d.blocks ?? []).map(block) };
      }),
    };
  }

  function refusal(body: ChatBody): Refusal | null {
    // An output limit, in each field a body gives, is an integer of at least 1. DeepSeek's reference gives `max_tokens`
    // "between 1 and 384K (393216)"; OpenAI's gives each field as an integer or null with no minimum. OpenRouter publishes
    // no minimum of its own; its reference notes that some providers enforce 16, which the stand-in doesn't model. So the
    // stand-in holds them all to 1. None of the three gives the refusal's words, so they're the stand-in's.
    for (const field of ['max_completion_tokens', 'max_tokens'] as const) {
      const limit: unknown = body[field];
      if (limit != null && !(Number.isInteger(limit) && (limit as number) >= 1)) return { refused: field, status: 400, message: `stand-in: \`${field}\` must be an integer of at least 1`, type: 'invalid_request_error', param: field };
    }
    const tokens = count(body);
    if (tokens > config.windowTokens) {
      // OpenRouter's errors page types a request past the window `context_length_exceeded`, a 400
      // (https://openrouter.ai/docs/api_reference/errors-and-debugging), and gives no message for it; the stand-in's is
      // the Messages codec's wording for Anthropic's, which membrane reads as context length.
      if (name === 'openrouter') return { refused: 'window', status: 400, message: `prompt is too long: ${tokens} tokens > ${config.windowTokens} maximum`, type: 'context_length_exceeded' };
      return name === 'openai'
        // The model page gives only the model's maximum input (gpt-5.6-sol's 922,000 tokens, P5's window), not what a
        // request past it gets, so the refusal's wording and code are the stand-in's own, the code the one membrane
        // reads as context length (errors.ts, `context_length_exceeded`).
        ? { refused: 'window', status: 400, message: `Your input exceeds the context window of this model: ${tokens} tokens > ${config.windowTokens} maximum.`, type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' }
        // DeepSeek's error codes page gives a 400 for an invalid body and no wording; this one is the stand-in's, in
        // words membrane reads as context length ("maximum context length").
        : { refused: 'window', status: 400, message: `This model's maximum context length is ${config.windowTokens} tokens. However, you requested ${tokens} tokens in the messages.`, type: 'invalid_request_error' };
    }
    // DeepSeek's thinking mode guide: "for requests carrying the `tools` parameter, the `reasoning_content` must be fully
    // passed back to the API in all subsequent requests — even for turns where the model did not perform a tool call.
    // If your code does not correctly pass back `reasoning_content`, the API will return a 400 error."
    // (https://api-docs.deepseek.com/guides/thinking_mode, read Nov 7 2026). Thinking mode is its default. The wording is
    // the stand-in's; the guide gives none. Whether DeepSeek enforces this live is unchecked.
    if (name === 'deepseek' && thinksIn(body) && (body.tools || []).length) {
      const at = body.messages.findIndex((m) => m?.role === 'assistant' && !(typeof m.reasoning_content === 'string' && m.reasoning_content));
      if (at >= 0) return { refused: 'reasoning-content', status: 400, message: `messages[${at}]: the reasoning_content of an assistant message must be passed back to the API in thinking mode when the request carries tools`, type: 'invalid_request_error' };
    }
    return null;
  }

  const seal = (content: Block[]) => (dialect.reasoningField ? content.map((b) => (b.type === 'thinking' ? { ...b, thinking: mint(b.thinking!) } : b)) : content);

  function deepseekHit(body: ChatBody, content: Block[], who: string | null) {
    const { push, elements: els } = prefixOf(body.model);
    const unit = (side: Side | undefined, blocks: Block[]) => ({ side, blocks: blocks.map(({ field: _f, ...b }) => b) });
    for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(tool).length / RATE.json));
    for (const m of body.messages) {
      const d = decode(m);
      push(unit(d.side, d.blocks!), d.blocks!.reduce((t, b) => t + blockTokens(b), 0) + MESSAGE_OVERHEAD);
    }
    let hit = 0; let c = 0; let at = -1;
    els.forEach((e, i) => { c += e.tokens; if (units.has(e.hash)) { hit = c; at = i; } });
    const last = els.length - 1;
    const passed = els.slice(at + 1).map((e) => e.hash);
    const ends = [els[last].hash];
    push(unit('assistant', content), 0);
    ends.push(els.at(-1)!.hash);
    const read = at < 0 ? null : { hash: els[at].hash, by: units.get(els[at].hash) ?? null, at };
    const writes = ends.filter((h) => !units.has(h));
    for (const h of writes) units.set(h, who);
    if (who !== null) uses?.set(who, { cache: unitsId, seq: uses.size, read, writes, passed, marks: [{ at: last, ttl: 0 }] });
    return hit;
  }

  function usage(body: ChatBody, outputTokens: number, content: Block[], who: string | null = null): ChatUsage {
    const reasoning = Math.min(content.filter((b) => b.type === 'thinking').reduce((t, b) => t + blockTokens(b), 0), outputTokens);
    if (name === 'openrouter') {
      // OpenRouter's usage for Chat Completions: `prompt_tokens`, with `prompt_tokens_details`' `cached_tokens` and
      // `cache_write_tokens` among them, as its caching guide says: "`cache_write_tokens` counts prompt tokens written to
      // the cache, and `cached_tokens` counts prompt tokens read from it" (https://openrouter.ai/docs/features/prompt-caching);
      // the usage-accounting page gives the fields (https://openrouter.ai/docs/use-cases/usage-accounting). Here from
      // Anthropic's cache over the forwarded body.
      const a = claudeCache(forwarded(body, dialect.models[body.model].anthropic!), outputTokens, who);
      const prompt = a.input_tokens + a.cache_read_input_tokens + a.cache_creation_input_tokens;
      return {
        prompt_tokens: prompt, completion_tokens: outputTokens, total_tokens: prompt + outputTokens,
        prompt_tokens_details: { cached_tokens: a.cache_read_input_tokens, cache_write_tokens: a.cache_creation_input_tokens },
        completion_tokens_details: { reasoning_tokens: reasoning },
      };
    }
    if (name === 'deepseek') {
      const total = countTokens(body);
      const hit = deepseekHit(body, content, who);
      return {
        prompt_tokens: total, completion_tokens: outputTokens, total_tokens: total + outputTokens,
        prompt_tokens_details: { cached_tokens: hit }, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: total - hit,
        completion_tokens_details: { reasoning_tokens: reasoning },
      };
    }
    const { total, read: hit, written } = cached(elements(body), who);
    return {
      prompt_tokens: total, completion_tokens: outputTokens, total_tokens: total + outputTokens,
      prompt_tokens_details: { cached_tokens: hit, cache_write_tokens: written },
      completion_tokens_details: { reasoning_tokens: reasoning },
    };
  }

  const tokens = (u: ChatUsage) => {
    const read = u.prompt_tokens_details?.cached_tokens ?? 0;
    const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
    return { input: u.prompt_tokens - read - written, cacheRead: read, cacheWrite: written, output: u.completion_tokens };
  };

  // OpenAI's error codes guide's 503 for what Anthropic's API calls `overloaded_error`: "`service_unavailable_error`
  // ... `server_is_overloaded`" (https://developers.openai.com/api/docs/guides/error-codes). DeepSeek's error codes page
  // gives "503 - Server Overloaded" and no body, so its body takes OpenAI's shape.
  function error(res: ServerResponse, status: number, message: string, { type = 'invalid_request_error', headers = {}, param = null, code = null }: { type?: string | null; headers?: Record<string, string>; param?: string | null; code?: string | null } = {}) {
    const overloaded = type === 'overloaded_error';
    if (name === 'openrouter') {
      // OpenRouter's errors page: `{ error: { code, message, metadata: { error_type } } }`, an overloaded provider's
      // `error_type` being `provider_overloaded`, a 503.
      const errorType = overloaded ? 'provider_overloaded' : type;
      res.writeHead(overloaded ? 503 : status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ error: { code: overloaded ? 503 : status, message, metadata: { error_type: errorType } } }));
      return;
    }
    const out = { error: { message, type: overloaded ? 'service_unavailable_error' : type, param, code: overloaded ? 'server_is_overloaded' : code } };
    res.writeHead(overloaded ? 503 : status, { 'content-type': 'application/json', 'x-request-id': 'req_standin', ...headers });
    res.end(JSON.stringify(out));
  }

  const FINISH: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

  function messageOf(content: Block[], stop: string): ChatReply {
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const calls: ChatCall[] = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
    // A refusal is OpenAI's `refusal` field, with no content; DeepSeek documents none, so its refusal is the content
    // with the `content_filter` finish reason its reference lists.
    const refused = stop === 'refusal' && name === 'openai';
    return {
      role: 'assistant',
      content: refused ? null : text || null,
      ...(dialect.reasoningField && thinking ? { [dialect.reasoningField]: thinking } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(name === 'openai' ? { refusal: refused ? text : null } : {}),
    };
  }
  // A refusal's finish_reason is the stand-in's choice on both dialects: OpenAI's reference lists the finish reasons
  // without saying which a refusal ends with, so its refusal ends `stop`, and DeepSeek's with `content_filter`.
  const finishOf = (stop: string) => FINISH[stop] ?? (stop === 'refusal' ? (name === 'openai' ? 'stop' : 'content_filter') : stop);

  function send(res: ServerResponse, { body, record, content, stop, usage: u }: Sent & { body: ChatBody; usage: ChatUsage }) {
    const message = messageOf(content, stop);
    const finish = finishOf(stop);
    const base = { id: `chatcmpl-${record.id}`, created: Math.floor(clock() / 1000), model: body.model };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `req_${record.id}` });
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage: u }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': `req_${record.id}` });
    // OpenRouter's streaming page: it "occasionally sends comments to prevent connection timeouts", such as
    // `: OPENROUTER PROCESSING`, and its usage comes on a chunk of its own at the end, whatever the request asks
    // (https://openrouter.ai/docs/api_reference/streaming).
    if (name === 'openrouter') res.write(': OPENROUTER PROCESSING\n\n');
    const withUsage = body.stream_options?.include_usage === true && name !== 'openrouter';
    const chunk = (delta: Record<string, unknown> | null, finishReason: string | null = null, used: ChatUsage | null | undefined = withUsage ? null : undefined, choices: unknown[] | undefined = undefined) => res.write(`data: ${JSON.stringify({
      ...base, object: 'chat.completion.chunk',
      choices: choices ?? [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      ...(used === undefined ? {} : { usage: used }),
    })}\n\n`);
    chunk({ role: 'assistant', content: '', ...(name === 'openai' ? { refusal: null } : {}) });
    if (dialect.reasoningField && message[dialect.reasoningField]) chunk({ [dialect.reasoningField]: message[dialect.reasoningField] });
    if (message.refusal) chunk({ refusal: message.refusal });
    if (message.content) chunk({ content: message.content });
    (message.tool_calls || []).forEach((c, index) => {
      // DeepSeek's reference: "The first chunk of each tool call carries the id, type and function fields; subsequent
      // chunks only carry the function arguments." membrane assembles a call from its deltas by `index` (`streamedToolCalls`,
      // utils.ts:177), for either dialect.
      chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: '' } }] });
      chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] });
    });
    if (name === 'openrouter') {
      // OpenRouter's streaming page: "every stream ends with an extra chunk that carries the `usage` object for the
      // request, sent just before the `[DONE]` message", with the last chunk's delta and finish_reason again.
      chunk({ content: '', role: 'assistant' }, finish);
      chunk({ content: '', role: 'assistant' }, finish, u);
    } else if (name === 'deepseek') {
      // DeepSeek's reference: "the last chunk before the `data: [DONE]` message carries the token usage statistics for
      // the entire request in its `usage` field. Note that no separate usage-only chunk is emitted".
      chunk({ content: '' }, finish, u);
    } else {
      chunk({}, finish);
      // OpenAI's reference, `stream_options.include_usage`: "an additional chunk will be streamed before the `data:
      // [DONE]` message. The `usage` field on this chunk shows the token usage statistics for the entire request, and the
      // `choices` field will always be an empty array."
      if (withUsage) chunk(null, null, u, []);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return {
    path: dialect.path,
    routes: (method: string | undefined, path: string) => method === 'POST' && path === dialect.path,
    read,
    record,
    refusal,
    seal,
    shown: (content: Block[]) => (dialect.reasoningField ? seal(content) : content.filter((b) => b.type !== 'thinking')),
    usage,
    tokens,
    send,
    error,
    countTokens: count,
    context: (body: ChatBody, mask: (v: unknown) => unknown, memo: PartMemo | null = null) => ({ parts: name === 'openrouter' ? anthropicParts(forwarded(body, dialect.models[body.model]?.anthropic ?? body.model), mask, memo) : contextParts(body, mask, memo), withheld: [] }),
  };
}
