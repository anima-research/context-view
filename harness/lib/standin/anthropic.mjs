import { createHash } from 'node:crypto';
import { maskRunVarying } from '../strategies/compare.mjs';
import { blockTokens, RATE } from './tokens.mjs';
import { blockRecord, blocksOf, markerOf, sorted } from './view.mjs';

const MESSAGE_OVERHEAD = 4;
// The provider's prompt-cache lifetimes, 5 minutes or 1 hour, and its lookback: "The lookback window is 20 blocks.
// The system checks at most 20 positions for each breakpoint, counting the breakpoint itself as the first", where "a
// run of consecutive `tool_use` blocks counts as one position, and so does a run of consecutive `tool_result` blocks"
// ("How automatic prefix checking works", https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
const LOOKBACK_POSITIONS = 20;
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
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
// troubleshooting page), so of the models the stand-in knows, Claude Opus 5.5 and Claude Haiku 5.5. A request is judged
// by its own model, so a compressor on one model and an agent on another are each answered as theirs.
const NOT_ENABLED = '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
const NOT_DISABLED = '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
const NOT_BETWEEN_TOOLS = '"thinking.type.between_tools" is not supported for this model.';
const NOT_ADAPTIVE = 'adaptive thinking is not supported on this model';
const MODELS = {
  'claude-haiku-4-5-20251001': { cacheMinimum: 4096, effort: null, efforts: [], prefill: true, thinks: 'off', refuses: { adaptive: NOT_ADAPTIVE, between_tools: NOT_BETWEEN_TOOLS }, manualInterleaves: false },
  'claude-opus-4-6': { cacheMinimum: 4096, effort: 'high', efforts: ['low', 'medium', 'high', 'max'], prefill: false, thinks: 'off', refuses: { between_tools: NOT_BETWEEN_TOOLS }, manualInterleaves: false },
  'claude-opus-5-5': { cacheMinimum: 512, effort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], prefill: false, thinks: 'always', refuses: { enabled: NOT_ENABLED, disabled: NOT_DISABLED, between_tools: NOT_BETWEEN_TOOLS }, binds: true },
  'claude-haiku-5-5': { cacheMinimum: 512, effort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], prefill: false, thinks: 'on', refuses: { enabled: NOT_ENABLED, between_tools: NOT_BETWEEN_TOOLS }, disabledRefusedAt: ['xhigh', 'max'], binds: true },
};
// The prompt-caching page's "What invalidates the cache" also keys the messages cache on `tool_choice`, and the
// system and messages caches on `speed`.
const UNMODELLED = ['tool_choice', 'speed'];
const CACHE_MINIMUM = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.cacheMinimum]));
export const bindsThinking = (model) => MODELS[model]?.binds === true;

function unmodelledField(body) {
  const top = UNMODELLED.find((k) => Object.hasOwn(body, k));
  if (top) return top;
  if (!Object.hasOwn(body, 'output_config')) return null;
  const config = body.output_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'output_config';
  const other = Object.keys(config).find((k) => k !== 'effort');
  return other ? `output_config.${other}` : null;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

const unmarked = (v) => {
  if (Array.isArray(v)) return v.map(unmarked);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, k === 'input' ? x : unmarked(x)]));
};
const holdsImage = (blocks) => blocks.some((b) => b?.type === 'image' || (b?.type === 'tool_result' && holdsImage(blocksOf(b.content))));

// The provider caches a request's prefix in the order it reads it: tools, then system, then messages.
function elements(body) {
  const out = [];
  let h = sha(String(body.model));
  const push = (value, tokens, marker, run = null) => {
    h = sha(h + JSON.stringify(unmarked(value)));
    const last = out.at(-1);
    out.push({ hash: h, tokens, marker, position: !last ? 0 : run && last.run === run ? last.position : last.position + 1, run });
  };
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(unmarked(tool)).length / RATE.json), tool.cache_control);
  for (const block of typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system || []) push({ system: block }, blockTokens(block), block.cache_control);
  // Changing the thinking configuration (its mode and budget_tokens), or adding or removing images anywhere in the
  // prompt, invalidates the messages cache; the page names no model that renders thinking ahead of tools and system
  // ("What invalidates the cache", and "Thinking and prompt caching" at
  // https://platform.claude.com/docs/en/build-with-claude/thinking).
  // The same table: "Changing the `output_config.effort` value always invalidates message blocks, with the same
  // model-specific effect on tool and system caches as thinking parameters. Setting effort explicitly to the model's
  // default is equivalent to omitting it and does not invalidate."
  const images = (body.messages || []).some((m) => holdsImage(blocksOf(m.content)));
  const effort = body.output_config?.effort;
  h = sha(h + JSON.stringify([body.thinking?.type ?? null, body.thinking?.budget_tokens ?? null, images, ...(effort !== undefined && effort !== MODELS[body.model]?.effort ? [effort] : [])]));
  for (const [i, m] of (body.messages || []).entries()) {
    const blocks = blocksOf(m.content);
    blocks.forEach((block, j) => push({ message: i, role: m.role, block }, blockTokens(block) + (j === 0 ? MESSAGE_OVERHEAD : 0), block.cache_control, ['tool_use', 'tool_result'].includes(block.type) ? block.type : null));
  }
  if (body.cache_control && out.length) out.at(-1).marker = out.at(-1).marker ?? body.cache_control;
  return out;
}

export function countTokens(body) {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

// The troubleshooting page: these models "accept a replayed thinking block only while the `system` prompt, `tools`,
// and messages that preceded it are unchanged" (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting).
function bindingIdentity(body, beforeMessage) {
  const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'stream', 'metadata', 'system', 'tools', 'model'].includes(k)));
  return sha(JSON.stringify(sorted(unmarked({ model: body.model, system: body.system ?? null, tools: body.tools ?? null, head, messages: (body.messages || []).slice(0, beforeMessage) }))));
}

const digest64 = (text) => Buffer.from(sha(text), 'hex').toString('base64url');
const signatureFor = (identity, thinking) => `fx1.${digest64(`${identity}\n${thinking}`).slice(0, 22)}${digest64(thinking).slice(0, 21)}`;
const signs = (signature, thinking) => typeof signature === 'string' && signature.startsWith('fx1.') && signature.slice(4 + 22) === digest64(thinking).slice(0, 21);

const listOfObjects = (v) => Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));

const systemText = (body) => (typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text || '').join('') : '');

const headerValues = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

function normalise(body, headers, mask) {
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('') : '';
  const digest = (v) => sha(JSON.stringify(sorted(mask(v ?? null)))).slice(0, 16);
  const { messages: _m, model: _o, max_tokens: _x, stream: _s, thinking: _t, tool_choice: _c, system: _y, tools: _l, ...rest } = body;
  const systemBlocks = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
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
    messages: (Array.isArray(body.messages) ? body.messages : []).map((m) => ({ role: m.role, digest: digestOf(m, mask), blocks: blocksOf(m.content).map(blockRecord) })),
  };
}

const withoutKept = (x) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.cache_control == null) return x;
  const { cache_control: _c, ...rest } = x;
  return rest;
};
const withoutRecordedMarkers = (blocks) => blocks.map((b) => {
  const rest = withoutKept(b);
  return rest?.type === 'tool_result' && Array.isArray(rest.content) ? { ...rest, content: rest.content.map(withoutKept) } : rest;
});
const digestOf = ({ role, content, ...envelope }, mask) => sha(JSON.stringify(mask({ role, content: withoutRecordedMarkers(blocksOf(content)), ...sorted(envelope) }))).slice(0, 16);

// A body whose `messages` is an empty list is still read, its system and tools, so the transcript of one the codec
// refused for that shows them; `read` refuses it. One with no `messages` list is refused before reading.
export function decodeMessages(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return { reason: 'no messages' };
  return { view: { model: body.model, maxTokens: body.max_tokens, system: systemText(body), messages: body.messages.map((m) => ({ ...m, content: blocksOf(m.content) })), tools: body.tools || [] } };
}

// Anthropic's prompt cache over a Messages body, as the Messages codec prices it and as the Chat Completions codec's
// OpenRouter dialect prices a Claude model's request in the Messages body it forwards.
// `minimums` is the minimum cacheable length by the model id a request names, Anthropic's own unless a front names its
// API's ids (bedrock.mjs).
export function anthropicCache({ clock, minimums = CACHE_MINIMUM }) {
  const cache = new Map();
  return function usageFor(body, outputTokens) {
    const now = clock();
    const els = elements(body);
    const total = els.reduce((t, e) => t + e.tokens, 0);
    const cum = []; let c = 0;
    for (const e of els) { c += e.tokens; cum.push(c); }
    const markers = els.map((e, i) => (e.marker ? i : -1)).filter((i) => i >= 0);
    let readAt = -1;
    for (const m of markers) {
      for (let j = m; j >= 0 && els[m].position - els[j].position < LOOKBACK_POSITIONS; j--) {
        const entry = cache.get(els[j].hash);
        if (entry && entry.expiresAt > now && j > readAt) readAt = j;
      }
    }
    const read = readAt >= 0 ? cum[readAt] : 0;
    if (readAt >= 0) {
      const ttl = els[readAt].marker?.ttl === '1h' || cache.get(els[readAt].hash).ttl === ONE_HOUR ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[readAt].hash, { expiresAt: now + ttl, ttl });
    }
    const split = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    let written = read;
    for (const m of markers) {
      if (m <= readAt || cum[m] < minimums[body.model]) continue;
      const ttl = els[m].marker.ttl === '1h' ? ONE_HOUR : FIVE_MINUTES;
      cache.set(els[m].hash, { expiresAt: now + ttl, ttl });
      split[ttl === ONE_HOUR ? 'ephemeral_1h_input_tokens' : 'ephemeral_5m_input_tokens'] += cum[m] - written;
      written = cum[m];
    }
    const creation = written - read;
    return { input_tokens: total - written, cache_read_input_tokens: read, cache_creation_input_tokens: creation, cache_creation: split, output_tokens: outputTokens };
  };
}

// The reply as the Messages API gives it, and the events a stream of it carries, in order: the Messages codec sends
// those as server-sent events, and Bedrock's front each in an event-stream frame (bedrock.mjs).
export const messageOf = ({ body, record, content, stop, stopSequence = null, usage }) => ({ id: `msg_${record.id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: stopSequence, usage });

export function streamEvents(message, content, stop, usage) {
  const out = [];
  const ev = (type, data) => out.push({ type, ...data });
  ev('message_start', { message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
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
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: message.stop_sequence }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {});
  return out;
}

export function anthropic({ configuration: config, clock, minimums = CACHE_MINIMUM, runDir = null }) {
  const usageFor = anthropicCache({ clock, minimums });

  function read(body) {
    const unmodelled = body && typeof body === 'object' ? unmodelledField(body) : null;
    if (unmodelled) return { reason: `it carries \`${unmodelled}\`, which the stand-in's prompt cache doesn't model` };
    const decoded = decodeMessages(body);
    if (decoded.reason) return decoded;
    if (!decoded.view.messages.length) return { reason: 'no messages' };
    if (body.system != null && typeof body.system !== 'string' && !listOfObjects(body.system)) return { reason: 'its system is neither a string nor a list of blocks' };
    if (body.tools != null && !listOfObjects(body.tools)) return { reason: 'its tools are not a list of tools' };
    if (!Object.hasOwn(minimums, body.model)) return { reason: `the stand-in knows no minimum cacheable length for the model ${body.model}` };
    if (body.output_config?.effort !== undefined && !Object.hasOwn(MODELS, body.model)) return { reason: `it carries \`output_config.effort\`, and the stand-in knows no default effort for the model ${body.model}` };
    if (body.output_config?.effort !== undefined && MODELS[body.model].effort === null) return { reason: `it carries \`output_config.effort\`, and the model ${body.model} takes no effort` };
    if (body.output_config?.effort !== undefined && !MODELS[body.model].efforts.includes(body.output_config.effort)) return { reason: `it carries \`output_config.effort\` ${JSON.stringify(body.output_config.effort)}, which the model ${body.model} doesn't take` };
    if (body.max_tokens === 0) return { reason: 'max_tokens 0, the shape of a cache keepalive refresh' };
    return { view: { ...decoded.view, seed: () => parseInt(bindingIdentity(maskRunVarying(body, { runDir }), body.messages.length).slice(0, 8), 16) } };
  }


  function unbound(body) {
    if (!bindsThinking(body.model)) return [];
    const out = [];
    for (const [i, m] of body.messages.entries()) {
      for (const [j, b] of blocksOf(m.content).entries()) {
        if (b.type === 'thinking' && b.signature !== signatureFor(bindingIdentity(body, i), b.thinking ?? '')) out.push({ i, j });
      }
    }
    return out;
  }
  const dropsUnbound = (body) => body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block';
  function asRead(body) {
    const drop = dropsUnbound(body) ? unbound(body) : [];
    if (!drop.length) return body;
    const gone = new Set(drop.map(({ i, j }) => `${i}.${j}`));
    return { ...body, messages: body.messages.map((m, i) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((_, j) => !gone.has(`${i}.${j}`)) } : m)) };
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
  function modifiedThinking(body) {
    const last = body.messages.findLastIndex((m) => m.role === 'assistant');
    for (const [i, m] of body.messages.entries()) {
      if (m.role !== 'assistant' || (i !== last && !bindsThinking(body.model))) continue;
      const j = blocksOf(m.content).findIndex((b) => b.type === 'thinking' && !signs(b.signature, b.thinking ?? ''));
      if (j >= 0) return `messages.${i}.content.${j}: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
    }
    return null;
  }
  function bindingRefusal(body) {
    if (dropsUnbound(body)) return null;
    const [first] = unbound(body);
    return first ? `messages.${first.i}.content.${first.j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` : null;
  }

  function refusal(body) {
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return { refused: 'max_tokens', status: 400, message: 'max_tokens: Field required' };
    if (body.messages.at(-1)?.role === 'assistant' && MODELS[body.model]?.prefill === false) return { refused: 'prefill', status: 400, message: 'This model does not support assistant message prefill. The conversation must end with a user message.' };
    const mode = MODELS[body.model]?.refuses?.[body.thinking?.type];
    if (mode) return { refused: 'thinking-mode', status: 400, message: mode };
    const effort = body.output_config?.effort ?? MODELS[body.model]?.effort;
    if (body.thinking?.type === 'disabled' && MODELS[body.model]?.disabledRefusedAt?.includes(effort)) return { refused: 'thinking-mode', status: 400, message: `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.` };
    const tooLong = countTokens(asRead(body));
    if (tooLong > config.windowTokens) return { refused: 'window', status: 400, message: `prompt is too long: ${tooLong} tokens > ${config.windowTokens} maximum` };
    const modified = modifiedThinking(body);
    if (modified) return { refused: 'thinking-modified', status: 400, message: modified };
    const binding = bindingRefusal(body);
    if (binding) return { refused: 'thinking', status: 400, message: binding };
    return null;
  }

  const seal = (content, body) => {
    const identity = bindingIdentity(body, body.messages.length);
    const thinks = MODELS[body.model]?.thinks;
    const always = thinks === 'always' || (thinks === 'on' && body.thinking?.type !== 'disabled');
    const omitted = always && body.thinking?.display !== 'summarized';
    const last = blocksOf(body.messages.at(-1)?.content);
    const midTurn = body.thinking?.type === 'enabled' && MODELS[body.model]?.manualInterleaves === false && last.length > 0 && last.every((b) => b.type === 'tool_result');
    const led = midTurn ? content.filter((b) => b.type !== 'thinking') : always && content[0]?.type !== 'thinking' ? [{ type: 'thinking', thinking: '' }, ...content] : content;
    return led.map((b) => {
      if (b.type !== 'thinking') return b;
      const thinking = omitted ? '' : b.thinking;
      return { ...b, thinking, signature: signatureFor(identity, thinking) };
    });
  };

  const error = (res, status, message, { type = 'invalid_request_error', headers = {} } = {}) => {
    const body = JSON.stringify({ type: 'error', error: { type, message } });
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin', ...headers });
    res.end(body);
  };

  function send(res, { body, record, content, stop, stopSequence, usage }) {
    const message = messageOf({ body, record, content, stop, stopSequence, usage });
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
    routes: (method, path) => method === 'POST' && path.endsWith('/v1/messages'),
    read,
    record: normalise,
    refusal,
    seal,
    usage: (body, outputTokens) => usageFor(asRead(body), outputTokens),
    tokens: (u) => ({ input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens }),
    send,
    error,
    countTokens: (body) => countTokens(asRead(body)),
  };
}
