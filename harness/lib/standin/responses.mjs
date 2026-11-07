import { createHash } from 'node:crypto';
import { maskRunVarying } from '../strategies/compare.mjs';
import { prefixOf, promptCache } from './openai-cache.mjs';
import { blockTokens, RATE, textTokens } from './tokens.mjs';
import { blockRecord, blocksOf, sorted } from './view.mjs';

// The models the stand-in serves on each backend of the Responses API, each with its output limit from its model page
// ("128,000 max output tokens", https://developers.openai.com/api/docs/models/gpt-6.1-sol). Each is GPT-5.6 or later,
// whose prompt cache openai-cache.mjs models. The Codex backend is ChatGPT's, which the host's `openai-codex` provider
// reaches; its catalog in OpenAI's own Codex client lists gpt-6.1-sol (codex-rs at 67f0994b53,
// `models-manager/models.json`).
const BACKENDS = {
  api: { api: 'responses', path: '/v1/responses', models: { 'gpt-6.1-sol': { maxOutput: 128_000 } } },
  codex: { api: 'codex', path: '/codex/responses', models: { 'gpt-6.1-sol': { maxOutput: 128_000 } } },
};

// The Codex backend is undocumented. What it refuses was found by sending it each field in turn (orca-router's
// `usage.md`, "Codex compatibility caveats", May 4, 2026): the fields here, a string `input`, a `service_tier` other
// than priority, and the tool types here. Two of that capture's refusals have since gone:
// it took `max_output_tokens` when rechecked on October 31, 2026, and a request with no `instructions` on November 7,
// 2026 (one asking gpt-6.1-terra, which carried no `include`, `tools`, `service_tier` or `prompt_cache_key`).
const CODEX_REFUSED = ['background', 'conversation', 'max_tool_calls', 'metadata', 'previous_response_id', 'prompt', 'safety_identifier', 'stream_options', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user'];
const CODEX_REFUSED_TOOLS = ['apply_patch', 'web_search_preview', 'file_search', 'computer', 'computer_use_preview', 'code_interpreter', 'local_shell', 'shell', 'mcp'];
const ITEM_OVERHEAD = 4;
const NAMED = ['model', 'input', 'max_output_tokens', 'stream', 'instructions', 'tools', 'reasoning', 'include', 'store', 'service_tier'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const digest64 = (text) => Buffer.from(sha(text), 'hex').toString('base64url');
const mint = (thinking) => `rx1.${Buffer.from(thinking, 'utf-8').toString('base64url')}.${digest64(thinking).slice(0, 22)}`;
const minted = (data) => {
  const m = /^rx1\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]{22})$/.exec(typeof data === 'string' ? data : '');
  return Boolean(m) && digest64(Buffer.from(m[1], 'base64url').toString('utf-8')).slice(0, 22) === m[2];
};

const inputOf = (body) => (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input);
const parsed = (text) => { try { return JSON.parse(text); } catch { return text; } };
function imageOf(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(typeof url === 'string' ? url : '');
  return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url } };
}
// A part of a type the codec doesn't model is kept whole in the view where it sits in a user or assistant message or
// a tool output (a developer or system message's text alone joins the instructions), so a refused request's transcript
// shows it, and
// `read` refuses the request (unknownPart).
const PARTS = ['input_text', 'output_text', 'refusal', 'input_image'];
function partOf(p) {
  if (typeof p === 'string') return { type: 'text', text: p };
  if (p?.type === 'input_text' || p?.type === 'output_text') return { type: 'text', text: p.text ?? '' };
  if (p?.type === 'refusal') return { type: 'text', text: p.refusal ?? '' };
  if (p?.type === 'input_image') return imageOf(p.image_url);
  return p && typeof p === 'object' ? p : { type: 'unknown', value: p ?? null };
}
const partsOf = (item) => [
  ...(item?.type === 'message' || (item?.type === undefined && item?.role) ? (Array.isArray(item.content) ? item.content : []) : []),
  ...(item?.type === 'function_call_output' && Array.isArray(item.output) ? item.output : []),
];
const unknownPart = (body) => {
  const parts = inputOf(body).flatMap(partsOf);
  const i = parts.findIndex((p) => typeof p !== 'string' && !PARTS.includes(p?.type));
  return i < 0 ? null : { type: parts[i]?.type ?? null };
};
const listOfObjects = (v) => Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
const modelOf = (models, name) => (typeof name === 'string' && Object.hasOwn(models, name) ? models[name] : undefined);
const SIDES = { user: 'user', assistant: 'assistant', developer: 'system', system: 'system' };

function decode(item) {
  const type = item?.type ?? (item?.role ? 'message' : undefined);
  if (type === 'message') {
    const side = Object.hasOwn(SIDES, item.role ?? '') ? SIDES[item.role] : undefined;
    if (!side) return { reason: `it carries a message whose role is ${JSON.stringify(item.role)}` };
    if (typeof item.content !== 'string' && !Array.isArray(item.content)) return { reason: 'it carries a message whose content is neither a string nor a list of parts' };
    return { side, blocks: typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : blocksOf(item.content).map(partOf) };
  }
  if (type === 'function_call') return { side: 'assistant', blocks: [{ type: 'tool_use', id: item.call_id, name: item.name, input: parsed(item.arguments) }] };
  if (type === 'function_call_output') return { side: 'user', blocks: [{ type: 'tool_result', tool_use_id: item.call_id, content: Array.isArray(item.output) ? item.output.map(partOf) : typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null) }] };
  if (type === 'reasoning') {
    if (typeof item.encrypted_content === 'string') return { side: 'assistant', blocks: [{ type: 'redacted_thinking', data: item.encrypted_content }] };
    return { side: 'assistant', blocks: [{ type: 'thinking', thinking: (item.summary ?? []).map((s) => s?.text ?? '').join('\n') }] };
  }
  if (type === 'compaction') return { side: 'assistant', blocks: [{ type: 'compaction', data: item.encrypted_content }] };
  return { reason: `it carries an input item of type ${JSON.stringify(type ?? null)}, which the stand-in doesn't model` };
}

function identity(body, beforeItem) {
  const head = Object.fromEntries(Object.entries(body).filter(([k]) => !['input', 'stream', 'metadata', 'instructions', 'tools', 'model'].includes(k)));
  return sha(JSON.stringify(sorted({ model: body.model, instructions: body.instructions ?? null, tools: body.tools ?? null, head, input: inputOf(body).slice(0, beforeItem) })));
}

const kindOf = (item) => item?.type ?? (item?.role ? 'message' : undefined);

// The prompt as the server renders it, which the cache reads: tools, then the instructions, then the input items from
// the latest compaction item on, each element with its running hash and tokens, and whether its end is an eligible
// message ending. That the items before the latest compaction item go unrendered is the stand-in's reading of the
// compaction guide's "prunes context before continuing inference" and "The latest compaction item carries the
// necessary context" (https://developers.openai.com/api/docs/guides/compaction), and the prompt-caching guide's
// `context_management` "Replaces earlier conversation content with a compacted context"; the guides say such items may
// be dropped, not that the server ignores them when they are sent. Under `reasoning.context: current_turn` the reasoning
// guide says the service "does not render reasoning from earlier turns into the next sample": the reasoning items
// before the input's last user message go unrendered too, a turn beginning there by the stand-in's own reading, since
// the guide doesn't say where one begins (https://developers.openai.com/api/docs/guides/reasoning).
function elements(body) {
  const { push, elements: out } = prefixOf(body.model, { parallel_tool_calls: body.parallel_tool_calls ?? null, format: body.text?.format ?? null, effort: body.reasoning?.effort ?? null, verbosity: body.text?.verbosity ?? null });
  for (const tool of body.tools || []) push({ tool }, Math.ceil(JSON.stringify(tool).length / RATE.json));
  if (typeof body.instructions === 'string' && body.instructions) push({ instructions: body.instructions }, textTokens(body.instructions));
  const items = inputOf(body);
  const from = Math.max(0, items.findLastIndex((item) => kindOf(item) === 'compaction'));
  const turn = body.reasoning?.context === 'current_turn' ? items.findLastIndex((item) => kindOf(item) === 'message' && item.role === 'user') : -1;
  items.forEach((item, i) => {
    const kind = kindOf(item);
    if (i < from || (i < turn && kind === 'reasoning')) return;
    const tokens = (decode(item).blocks ?? []).reduce((t, b) => t + blockTokens(b), 0) + ITEM_OVERHEAD;
    push({ item }, tokens, (kind === 'message' && item.role === 'user') || (kind === 'function_call_output' && items[i + 1]?.type !== 'function_call_output'));
  });
  return out;
}

export function countTokens(body) {
  return elements(body).reduce((t, e) => t + e.tokens, 0);
}

const hasInput = (body) => Boolean(body) && typeof body === 'object' && (typeof body.input === 'string' || (Array.isArray(body.input) && body.input.length > 0));

export function decodeResponses(body, backend = 'api') {
  if (!hasInput(body)) return { reason: 'no input' };
  const messages = [];
  const system = typeof body.instructions === 'string' ? [body.instructions] : [];
  for (const item of inputOf(body)) {
    const d = decode(item);
    if (d.reason) return { reason: d.reason };
    if (d.side === 'system') { system.push(...d.blocks.filter((b) => b.type === 'text').map((b) => b.text)); continue; }
    if (messages.at(-1)?.role === d.side) messages.at(-1).content.push(...d.blocks);
    else messages.push({ role: d.side, content: [...d.blocks] });
  }
  return {
    view: {
      model: body.model,
      maxTokens: body.max_output_tokens ?? modelOf(BACKENDS[backend].models, body.model)?.maxOutput ?? null,
      system: system.join('\n'),
      messages,
      tools: (body.tools || []).map((t) => (t?.type === 'function' ? { name: t.name, description: t.description, input_schema: t.parameters } : t)),
    },
  };
}

export function responses({ configuration: config, clock, backend = 'api' }) {
  const cached = promptCache({ clock });
  const be = BACKENDS[backend];
  const codex = backend === 'codex';

  function read(body) {
    if (!hasInput(body)) return { reason: 'no input' };
    if (body.instructions != null && typeof body.instructions !== 'string') return { reason: 'its instructions are not a string' };
    if (body.tools != null && !listOfObjects(body.tools)) return { reason: 'its tools are not a list of tools' };
    if (codex) {
      if (body.stream !== true) return { reason: 'it isn\'t streamed, and the stand-in has no model of an unstreamed request to the Codex backend' };
      const unmodelled = ['context_management', 'prompt_cache_retention', 'prompt_cache_options'].find((k) => body[k] != null);
      if (unmodelled) return { reason: `it carries \`${unmodelled}\`, which the stand-in has no model of on the Codex backend` };
      if (body.store !== false) return { reason: 'its `store` isn\'t false, and the stand-in has no record of what the Codex backend answers to that' };
    } else {
      const stateful = ['previous_response_id', 'conversation', 'prompt', 'background'].find((k) => body[k] != null);
      if (stateful) return { reason: `it carries \`${stateful}\`, which asks for state the stand-in doesn't keep` };
      if (body.truncation === 'auto') return { reason: 'it asks for `truncation: auto`, which the stand-in doesn\'t model' };
    }
    if (body.prompt_cache_options?.mode === 'explicit' || JSON.stringify(body.input).includes('"prompt_cache_breakpoint"')) return { reason: 'it places explicit cache breakpoints, which the stand-in\'s prompt cache doesn\'t model' };
    const ttl = body.prompt_cache_options?.ttl;
    if (ttl != null && ttl !== '30m') return { reason: `it asks for a cache lifetime of ${JSON.stringify(ttl)}, and the stand-in's prompt cache models the default 30 minutes alone` };
    if (!modelOf(be.models, body.model)) return { reason: `the stand-in knows no cache rules or output limit for the model ${body.model}` };
    const decoded = decodeResponses(body, backend);
    if (decoded.reason) return decoded;
    const part = unknownPart(body);
    if (part) return { reason: `it carries a content part of type ${JSON.stringify(part?.type ?? null)}, which the stand-in doesn't model` };
    if (!decoded.view.messages.length) return { reason: 'its input holds only developer or system messages' };
    return { view: { ...decoded.view, seed: () => parseInt(identity(maskRunVarying(body), inputOf(body).length).slice(0, 8), 16) } };
  }

  function record(body, headers, mask) {
    const text = (v) => (v == null ? null : JSON.stringify(sorted(mask(v))));
    const digest = (v) => sha(JSON.stringify(sorted(mask(v ?? null)))).slice(0, 16);
    const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !NAMED.includes(k)));
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';
    const items = Array.isArray(body.input) || typeof body.input === 'string' ? inputOf(body) : [];
    const block = (b) => (b.type === 'redacted_thinking' ? { ...blockRecord(b), sealed: minted(b.data) } : blockRecord(b));
    return {
      head: {
        api: be.api,
        model: body.model ?? null,
        maxOutputTokens: body.max_output_tokens ?? null,
        instructions: body.instructions == null ? null : mask(String(body.instructions)),
        tools: (body.tools || []).map((t) => ({ name: t.name ?? t.type ?? null, sha: digest(t) })),
        reasoning: body.reasoning ?? null,
        include: body.include ?? null,
        store: body.store ?? null,
        serviceTier: body.service_tier ?? null,
        rest: Object.keys(rest).length ? text(rest) : null,
        headers: codex ? { sessionId: mask({ session_id: headers['session_id'] ?? null }).session_id } : { organization: headers['openai-organization'] ?? null, project: headers['openai-project'] ?? null },
      },
      model: body.model ?? null,
      maxTokens: body.max_output_tokens ?? null,
      stream: body.stream === true,
      thinking: body.reasoning ?? null,
      system: { sha256: sha(instructions), chars: instructions.length },
      tools: (body.tools || []).map((t) => t.name ?? t.type ?? null),
      messages: items.map((item) => {
        const d = decode(item);
        return { role: item?.role ?? item?.type ?? null, side: d.side ?? null, digest: digest(item), blocks: (d.blocks ?? []).map(block) };
      }),
    };
  }

  function codexRefusal(body) {
    const refuse = (param, what) => ({ refused: 'request', status: 400, message: `stand-in: the Codex backend refuses ${what}`, type: 'invalid_request_error', param });
    const field = CODEX_REFUSED.find((k) => body[k] !== undefined);
    if (field) return refuse(field, `\`${field}\``);
    if (typeof body.input === 'string') return refuse('input', 'an `input` given as a string');
    if (body.service_tier != null && body.service_tier !== 'priority') return refuse('service_tier', `the service tier ${JSON.stringify(body.service_tier)}`);
    const tool = (body.tools || []).find((t) => CODEX_REFUSED_TOOLS.includes(t?.type));
    if (tool) return refuse('tools', `a tool of type ${JSON.stringify(tool.type)}`);
    return null;
  }

  function refusal(body) {
    const refused = codex ? codexRefusal(body) : null;
    if (refused) return refused;
    const tokens = countTokens(body);
    // OpenAI's Codex client meets an input past the window as a streamed `response.failed` with code
    // `context_length_exceeded` and this message (codex-rs at 67f0994b53, `codex-api/src/sse/responses.rs`,
    // context_window_error_is_fatal).
    if (codex && tokens > config.windowTokens) return { refused: 'window', failed: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.' };
    if (tokens > config.windowTokens) return { refused: 'window', status: 400, message: `Your input exceeds the context window of this model: ${tokens} tokens > ${config.windowTokens} maximum.`, type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' };
    return null;
  }

  const seal = (content) => content.map((b) => (b.type === 'thinking' ? { ...b, signature: mint(b.thinking) } : b));

  // The Codex backend reports cache reads in whole blocks of 128 tokens and no cache writes, as orca-router's usage log
  // shows: in its `usage_log` rows 5474903 to 5505970 (November 7, 2026) of provider `openai`, status 200 and no
  // credential or one that isn't an API key's, every cache read is a multiple of 128 and no cache write is above 0
  // (harness/README.md gives the query). The rest of the prompt cache is the API's, taken for the backend's by the
  // stand-in's own assumption.
  function usage(body, outputTokens, content) {
    const { total, read, written } = cached(elements(body));
    const reasoning = content.filter((b) => b.type === 'thinking').reduce((t, b) => t + blockTokens(b), 0);
    return {
      input_tokens: total,
      input_tokens_details: codex ? { cached_tokens: Math.floor(read / 128) * 128, cache_write_tokens: 0 } : { cached_tokens: read, cache_write_tokens: written, cache_write_tokens_details: { ttl_30m_tokens: written, ttl_12h_tokens: 0 } },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: Math.min(reasoning, outputTokens) },
      total_tokens: total + outputTokens,
    };
  }

  const tokens = (u) => ({ input: u.input_tokens - u.input_tokens_details.cached_tokens - u.input_tokens_details.cache_write_tokens, cacheRead: u.input_tokens_details.cached_tokens, cacheWrite: u.input_tokens_details.cache_write_tokens, output: u.output_tokens });

  // The error codes guide's 503: "`service_unavailable_error` ... `server_is_overloaded`"
  // (https://developers.openai.com/api/docs/guides/error-codes), for what Anthropic's API calls `overloaded_error`. On
  // the Codex backend an overload goes, like an input past the window, as a streamed `response.failed`, in which
  // OpenAI's Codex client reads `server_is_overloaded` as the server overloaded (codex-rs at 67f0994b53,
  // `codex-api/src/sse/responses_error.rs`).
  function error(res, status, message, { type = 'invalid_request_error', headers = {}, param = null, code = null, failed = null } = {}) {
    const overloaded = type === 'overloaded_error';
    if (codex && (failed || overloaded)) return fail(res, failed ?? 'server_is_overloaded', message, headers);
    const out = { error: { message, type: overloaded ? 'service_unavailable_error' : type, param, code: overloaded ? 'server_is_overloaded' : code } };
    res.writeHead(overloaded ? 503 : status, { 'content-type': 'application/json', 'x-request-id': 'req_standin', ...headers });
    res.end(JSON.stringify(out));
  }

  function fail(res, code, message, headers) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'req_standin', ...headers });
    const response = (status, more) => ({ id: 'resp_standin', object: 'response', created_at: Math.floor(clock() / 1000), status, background: false, error: null, usage: null, ...more });
    let n = 0;
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: n++ })}\n\n`);
    ev('response.created', { response: response('in_progress') });
    ev('response.in_progress', { response: response('in_progress') });
    ev('response.failed', { response: response('failed', { error: { code, message } }) });
    res.end();
  }

  function outputOf(record, content, stop) {
    const id = (kind, i) => `${kind}_${record.id}_${i}`;
    return content.map((b, i) => {
      if (b.type === 'thinking') return { id: id('rs', i), type: 'reasoning', summary: [], encrypted_content: b.signature };
      if (b.type === 'tool_use') return { id: id('fc', i), type: 'function_call', status: 'completed', arguments: JSON.stringify(b.input ?? {}), call_id: b.id, name: b.name };
      if (b.type === 'compaction') return { id: id('cmp', i), type: 'compaction', encrypted_content: b.data };
      const part = stop === 'refusal' ? { type: 'refusal', refusal: b.text } : { type: 'output_text', text: b.text, annotations: [], logprobs: [] };
      return { id: id('msg', i), type: 'message', status: 'completed', role: 'assistant', content: [part] };
    });
  }

  // The compaction guide: "When the rendered token count crosses the configured threshold, the server runs
  // server-side compaction" and "emits a compaction output item in the same stream"
  // (https://developers.openai.com/api/docs/guides/compaction).
  function compaction(body, record) {
    const threshold = (Array.isArray(body.context_management) ? body.context_management : []).find((c) => c?.type === 'compaction')?.compact_threshold;
    if (typeof threshold !== 'number' || countTokens(body) < threshold) return [];
    return [{ id: `cmp_${record.id}`, type: 'compaction', encrypted_content: `cx1.${digest64(JSON.stringify(maskRunVarying(inputOf(body))))}` }];
  }

  // The Codex backend's `response.completed` comes with its `output` empty or absent, the items only in the stream's
  // events (orca-router's `providers.contract`, PVR-016, undated and in its first commit, of October 9, 2026), and
  // echoes `service_tier: "default"` whatever tier was asked (orca-router's `usage.md`, probes of July 23 and
  // September 23, 2026).
  function send(res, { body, record, content, stop, usage: u }) {
    const output = [...compaction(body, record), ...outputOf(record, content, stop)];
    const incomplete = stop === 'max_tokens';
    const response = (status, out, used) => ({
      ...(codex ? { service_tier: 'default' } : {}),
      id: `resp_${record.id}`, object: 'response', created_at: Math.floor(clock() / 1000), status, error: null,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null, model: body.model, output: out,
      parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: null, reasoning: body.reasoning ?? { effort: null, summary: null },
      store: body.store ?? true, tool_choice: body.tool_choice ?? 'auto', tools: body.tools ?? [], truncation: body.truncation ?? 'disabled', usage: used,
    });
    const final = response(incomplete ? 'incomplete' : 'completed', codex && !incomplete ? [] : output, u);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `req_${record.id}` });
      res.end(JSON.stringify(final));
      return;
    }
    // A text message's events follow the API reference's streaming example. The refusal and function-call-argument
    // events, and `response.incomplete`, are named in no saved page with their fields, so theirs are the stand-in's,
    // shaped as membrane 0.8.0's adapter reads a stream.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': `req_${record.id}` });
    let n = 0;
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: n++ })}\n\n`);
    ev('response.created', { response: response('in_progress', [], null) });
    ev('response.in_progress', { response: response('in_progress', [], null) });
    output.forEach((item, output_index) => {
      if (item.type === 'message') {
        const part = item.content[0];
        const empty = part.type === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [], logprobs: [] };
        ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
        ev('response.content_part.added', { item_id: item.id, output_index, content_index: 0, part: empty });
        if (part.type === 'refusal') {
          ev('response.refusal.delta', { item_id: item.id, output_index, content_index: 0, delta: part.refusal });
          ev('response.refusal.done', { item_id: item.id, output_index, content_index: 0, refusal: part.refusal });
        } else {
          ev('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: part.text, logprobs: [] });
          ev('response.output_text.done', { item_id: item.id, output_index, content_index: 0, text: part.text, logprobs: [] });
        }
        ev('response.content_part.done', { item_id: item.id, output_index, content_index: 0, part });
      } else if (item.type === 'function_call') {
        ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } });
        ev('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
        ev('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
      } else {
        ev('response.output_item.added', { output_index, item });
      }
      ev('response.output_item.done', { output_index, item });
    });
    ev(incomplete ? 'response.incomplete' : 'response.completed', { response: final });
    res.end();
  }

  return {
    path: be.path,
    routes: (method, path) => method === 'POST' && (codex ? path.endsWith(BACKENDS.codex.path) : path.endsWith('/responses') && !path.endsWith(BACKENDS.codex.path)),
    read,
    record,
    refusal,
    seal,
    usage,
    tokens,
    send,
    error,
    countTokens,
  };
}
