import { crc32 } from 'node:zlib';
import { anthropic, messageOf, streamEvents } from './anthropic.mjs';

// Amazon Bedrock's InvokeModel and InvokeModelWithResponseStream, which membrane's BedrockAdapter sends to
// `${baseURL}/model/${encodeURIComponent(modelId)}/invoke` and `…/invoke-with-response-stream` (bedrock.ts,
// invokeModel and invokeModelWithStream). For a Claude model the body is the Messages API's, with `anthropic_version`
// and the betas (`anthropic_beta`) in it, and the model and the streaming in the path. So this front reads it as the
// Messages body it is, with the path's model and streaming, and answers through the Messages codec, with Anthropic's
// cache rule: the model card below gives a Claude model on Bedrock explicit caching only, by Anthropic's markers.
// AWS's Claude Messages page: `anthropic_version` is required, and "The value must be bedrock-2023-05-31"
// (https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html,
// read Nov 7 2026). A Bedrock request's record names its API `messages` and its dialect `bedrock`.
const ROUTE = /\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/;

// The models the front knows, by the id membrane sends in the path. AWS's Claude Opus 4.6 model card gives its US
// geo inference id, `us.anthropic.claude-opus-4-6-v1`, explicit prompt caching with a 4,096-token minimum per
// checkpoint, 4 checkpoints, 5-minute and 1-hour lifetimes, and no implicit caching
// (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-6.html, read Nov 7 2026).
// The prompt-caching guide's lookback, "about 20 content blocks", is the Messages codec's
// (https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, read the same day). The same guide lists
// the models that take a top-level `cache_control` (automatic caching), and Opus 4.6 isn't among them: "Models that
// don't support it return a ValidationException for the top-level cache_control field".
const MODELS = { 'us.anthropic.claude-opus-4-6-v1': { cacheMinimum: 4096, automaticCaching: false } };
const CACHE_MINIMUM = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.cacheMinimum]));

// The status each exception has in the InvokeModel and InvokeModelWithResponseStream references' Errors, by the
// status the stand-in answers with. membrane reads the exception's name from the `x-amzn-ErrorType` header (errors.ts,
// amznErrorType); the body's form, `{"message": …}`, is the stand-in's own. The references tie no exception to an
// overloaded model (ServiceUnavailableException is only "The service isn't available"), so answering a scripted
// overload, Anthropic's 529, as ServiceUnavailableException's 503 is the stand-in's own choice. membrane's
// classifyFailure takes only a 529 as an overload (retry.ts:72 at 0.8.0), so on this front an injected overload
// reads as a retryable server error, not an overload.
// Where the references give a status more than one exception (400: ValidationException and
// ServiceQuotaExceededException; 424: ModelErrorException and, on the streaming route, ModelStreamErrorException; 429:
// ThrottlingException and ModelNotReadyException), the table takes the stand-in's pick, the first named here. A
// scripted status the references give no exception for goes as a ValidationException's 400 below 500, and an
// InternalServerException's 500 from 500 up.
const EXCEPTIONS = { 400: 'ValidationException', 403: 'AccessDeniedException', 404: 'ResourceNotFoundException', 408: 'ModelTimeoutException', 424: 'ModelErrorException', 429: 'ThrottlingException', 500: 'InternalServerException', 503: 'ServiceUnavailableException' };

// AWS's event stream encoding: each message a prelude (its total length and its headers' length, big-endian, then a
// CRC32 of those 8 bytes), its headers, its payload, and a CRC32 of everything before it ("Event stream encoding",
// https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html, read Nov 7 2026). A header is its name's
// length and name, a value type (the page's text gives 7 for a string), and a string's length and value. The page
// gives the two lengths' sizes only in its diagram, so they're the ones membrane 0.8.0's reader takes: one byte for
// the name's length, two big-endian for the value's (bedrock.ts:653 and :661). The
// InvokeModelWithResponseStream reference gives a stream's content as `chunk` events whose payload carries `bytes`
// (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html), a blob,
// which in JSON is base64. membrane reads a Claude model's `bytes` as one of the Messages API's stream events
// (bedrock.ts, invokeModelWithStream); the AWS pages read here don't show what a Claude stream's events are, so
// those are the Messages codec's.
const STRING = 7;
export function eventFrame(headers, payload) {
  const encoded = Buffer.concat(Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    h.writeUInt8(n.length, 0);
    n.copy(h, 1);
    h.writeUInt8(STRING, 1 + n.length);
    h.writeUInt16BE(v.length, 2 + n.length);
    v.copy(h, 4 + n.length);
    return h;
  }));
  const total = 12 + encoded.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(encoded.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  encoded.copy(out, 12);
  payload.copy(out, 12 + encoded.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}
const chunkFrame = (event) => eventFrame(
  { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
  Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') }), 'utf8'),
);

export function bedrock({ configuration: config, clock }) {
  const messages = anthropic({ configuration: config, clock, minimums: CACHE_MINIMUM });
  // The Messages body a Bedrock body is, which every other member hands the Messages codec.
  const asMessages = (body) => {
    const { anthropic_version: _v, anthropic_beta: _b, ...rest } = body;
    return rest;
  };

  // The body the other members take: Bedrock's, with the path's model and, from the streaming route, `stream`.
  function read(raw, path) {
    const [, id, route] = ROUTE.exec(path) ?? [];
    let model = null;
    try { model = decodeURIComponent(id); } catch { return { reason: `its path, ${path}, names no model` }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'no body' };
    // A body that names its own model or streaming is refused, and recorded as it came, with the path's model only
    // where it names none, so its record shows what the refusal is for.
    if (Object.hasOwn(raw, 'model') || Object.hasOwn(raw, 'stream')) return { body: { model, ...raw }, reason: 'its body names a model or streaming, which Bedrock takes from the path' };
    const body = { ...raw, model, ...(route === 'invoke-with-response-stream' ? { stream: true } : {}) };
    if (!Object.hasOwn(MODELS, model)) return { body, reason: `the stand-in knows no Bedrock model ${model}` };
    return { ...messages.read(asMessages(body)), body };
  }

  function record(body, headers, mask) {
    const { head, ...rest } = messages.record(asMessages(body), {}, mask);
    const { api, headers: _h, ...fields } = head;
    // The betas and the version ride in the body on Bedrock (bedrock.ts, buildRequest); the record keeps them where the
    // Messages codec keeps their headers. The request's own headers are AWS's signing, which the record leaves out.
    const betas = Array.isArray(body.anthropic_beta) ? [...new Set(body.anthropic_beta.map(String))].sort() : [];
    return { head: { api, dialect: 'bedrock', ...fields, headers: { beta: betas, version: body.anthropic_version ?? null } }, ...rest };
  }

  function refusal(body) {
    if (body.anthropic_version !== 'bedrock-2023-05-31') return { refused: 'version', status: 400, message: 'anthropic_version: The value must be bedrock-2023-05-31.' };
    if (Object.hasOwn(body, 'cache_control') && !MODELS[body.model]?.automaticCaching) {
      // The guide gives only the exception; the words are the stand-in's own.
      return { refused: 'automatic-caching', status: 400, message: `The model ${body.model} doesn't support a top-level cache_control field.` };
    }
    const refused = messages.refusal(asMessages(body));
    // Bedrock's words for a prompt past the window, as membrane quotes them (errors.ts, CONTEXT_LENGTH_PATTERN's
    // doc); AWS's references don't give them.
    if (refused?.refused === 'window') return { ...refused, message: 'Input is too long for requested model.' };
    return refused;
  }

  function send(res, { body, record: r, content, stop, usage }) {
    const message = messageOf({ body: asMessages(body), record: r, content, stop, usage });
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-amzn-requestid': `req_${r.id}` });
      res.end(JSON.stringify(message));
      return;
    }
    // The reference: "For streaming, the content type in the response is always set to
    // application/vnd.amazon.eventstream", with the body's own in `x-amzn-bedrock-content-type`.
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-bedrock-content-type': 'application/json', 'x-amzn-requestid': `req_${r.id}` });
    for (const event of streamEvents(message, content, stop, usage)) res.write(chunkFrame(event));
    res.end();
  }

  function error(res, status, message, { type = null, headers = {} } = {}) {
    const answered = type === 'overloaded_error' || status === 529 ? 503 : EXCEPTIONS[status] ? status : status >= 500 ? 500 : 400;
    res.writeHead(answered, { 'content-type': 'application/json', 'x-amzn-errortype': EXCEPTIONS[answered], ...headers });
    res.end(JSON.stringify({ message }));
  }

  return {
    // Each request's path names its model and its route, so none is the front's own, and the core records each.
    path: null,
    routes: (method, path) => method === 'POST' && ROUTE.test(path),
    read,
    record,
    refusal,
    seal: (content, body) => messages.seal(content, asMessages(body)),
    usage: (body, outputTokens) => messages.usage(asMessages(body), outputTokens),
    tokens: messages.tokens,
    send,
    error,
    countTokens: (body) => messages.countTokens(asMessages(body)),
  };
}

