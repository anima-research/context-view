#!/usr/bin/env node
import { type Socket, connect } from 'node:net';
import { asWritten, lineReader } from './control.ts';
import { KINDS, toolResult } from './results.ts';

interface RpcError { code: number; message: string }
interface Reply<R = unknown> { result?: R; error?: RpcError }
interface FromHost extends Reply {
  id?: unknown;
  method?: unknown;
  params?: { channelId?: unknown; content?: unknown; threadId?: unknown; name?: unknown; arguments?: { channelId?: unknown; hold?: unknown; canary?: unknown } };
}
type FromDriver =
  | { op: 'host'; id: number; params: Record<string, unknown> }
  | { op: 'deliver'; id: number; message: Delivered }
  | { op: 'push'; id: number; event: Record<string, unknown> }
  | { op: 'release'; id: number; canary: string }
  | { op: 'relist'; id: number };
interface Delivered { channelId?: unknown; messageId?: unknown; author?: { id?: unknown; name?: unknown }; text?: unknown; at?: unknown; topic?: unknown; images?: unknown; tags?: unknown }
interface Registered { results?: Array<{ id: string; accepted: boolean; reason?: string }> }

const PROTOCOL_VERSION = '2024-11-05';
const FEATURE_SET = 'fixture';
const FAIL_PUBLISH = '[[fail-publish]]';

const TOOL = {
  name: 'result',
  description: 'Returns a result of the asked kind and size, carrying the canary.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS },
      size: { type: 'integer', description: 'Characters, for prose, code and json; for mixed, the two texts\' together.' },
      canary: { type: 'string' },
      width: { type: 'integer', description: 'Pixels, for image and mixed.' },
      height: { type: 'integer', description: 'Pixels, for image and mixed.' },
      hold: { type: 'boolean', description: 'Answer only when the fixture releases this canary.' },
    },
    required: ['kind', 'canary'],
  },
};

// Its answer has the shape of discord-mcpl's send_message at ee86be39 (src/server.ts augmentSendResult, written by
// agentJson): agent-framework 0.33.0 reads the target its [tuned out] note is for from the answer's channelId
// (extractChannelIdFromToolResult), and nothing else of it. discordChannelId, Discord's own id for the channel, is left
// out, since the fixture's channels have none.
const SEND = {
  name: 'send_message',
  description: 'Sends a message to a channel this server registers.',
  inputSchema: {
    type: 'object',
    properties: {
      channelId: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['channelId', 'content'],
  },
};

function serve() {
  const log = (...parts: unknown[]) => console.error('[fixture-mcpl]', ...parts);
  const toHost = (msg: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const channels = (process.env.FIXTURE_CHANNELS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const kinds: Record<string, { direction?: string; initiallyOpen?: boolean } | undefined> | null = process.env.FIXTURE_CHANNEL_KINDS ? JSON.parse(process.env.FIXTURE_CHANNEL_KINDS) : null;
  const descriptorOf = (id: string) => ({ id, type: 'chat', label: id, direction: kinds?.[id]?.direction ?? 'bidirectional', initiallyOpen: kinds?.[id]?.initiallyOpen ?? true });
  const boot = process.env.FIXTURE_BOOT ?? '0';
  let published = 0;
  let sent = 0;
  const sends = process.env.FIXTURE_SEND === '1';
  const pushes = process.env.FIXTURE_PUSH === '1';
  const waitingOnHost = new Map<unknown, (msg: FromHost) => void>();
  const held = new Map<string, FromHost>();
  let failingList: (() => void) | null = null;
  let nextId = 1;
  let control: Socket | null = null;
  let registering = false;
  let markRegistered: (refused: string[]) => void;
  const registered = new Promise<string[]>((resolve) => { markRegistered = resolve; });

  const askHost = (method: string, params: unknown) => new Promise<FromHost>((resolve) => {
    const id = nextId++;
    waitingOnHost.set(id, resolve);
    toHost({ id, method, params });
  });

  const register = async () => {
    registering = true;
    const answer = await askHost('channels/register', { channels: channels.map(descriptorOf) }) as Reply<Registered>;
    const refused = answer.error
      ? [answer.error.message]
      : channels.filter((id) => !answer.result?.results?.find((r) => r.id === id)?.accepted)
        .map((id) => `${id}: ${answer.result?.results?.find((r) => r.id === id)?.reason ?? 'no result for it'}`);
    if (refused.length) log(`channels/register refused: ${refused.join('; ')}`);
    markRegistered(refused);
  };

  const mcpl = {
    version: '0.5',
    ...(pushes ? { pushEvents: true } : {}),
    featureSets: [{ name: FEATURE_SET, description: 'The strategy fixture\'s sized tool results', uses: pushes ? ['tools', 'pushEvents'] : ['tools'], rollback: false, ...(process.env.FIXTURE_ONTOLOGY ? { tagOntology: JSON.parse(process.env.FIXTURE_ONTOLOGY) } : {}) }],
    ...(channels.length ? { channels: { register: true, incoming: true, publish: true, ...(kinds ? { lifecycle: true } : {}) } } : {}),
  };
  const answer = (msg: FromHost): Reply => {
    if (kinds && (msg.method === 'channels/open' || msg.method === 'channels/close')) {
      const id = msg.params?.channelId;
      if (!(channels as unknown[]).includes(id)) return { error: { code: -32602, message: `no channel ${JSON.stringify(id)} here` } };
      return { result: msg.method === 'channels/open' ? { channel: descriptorOf(id as string) } : { closed: true } };
    }
    switch (msg.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, experimental: { mcpl } },
            serverInfo: { name: 'connectome-smoke-fixture', version: '0.0.0' },
          },
        };
      case 'ping': return { result: {} };
      case 'featureSets/update': return { result: { accepted: true, mode: 'full', unavailableFeatures: [] } };
      case 'tools/list': return { result: { tools: sends ? [TOOL, SEND] : [TOOL] } };
      case 'channels/publish':
        if (!(channels as unknown[]).includes(msg.params?.channelId)) return { result: { delivered: false, reason: `no channel ${JSON.stringify(msg.params?.channelId)} here` } };
        if (Array.isArray(msg.params!.content) && msg.params!.content.some((b) => b?.type === 'text' && b.text?.includes(FAIL_PUBLISH))) return { result: { delivered: false, reason: `the text carries ${FAIL_PUBLISH}` } };
        return { result: { delivered: true, messageId: `pub-${boot}-${++published}`, ...('threadId' in (msg.params ?? {}) ? { threadId: msg.params!.threadId } : {}) } };
      case 'tools/call':
        if (sends && msg.params?.name === SEND.name) {
          const { channelId } = msg.params.arguments ?? {};
          return { result: { content: [{ type: 'text', text: JSON.stringify({ messageId: `sent-${boot}-${++sent}`, channelId, channelLabel: channelId }) }] } };
        }
        if (msg.params?.name !== TOOL.name) return { error: { code: -32602, message: `unknown tool ${JSON.stringify(msg.params?.name)}` } };
        return { result: toolResult(msg.params.arguments) };
      default: return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  lineReader<FromHost>(process.stdin, (msg) => {
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) return;
      const args = msg.params?.arguments;
      if (msg.method === 'tools/call' && (msg.params?.name === TOOL.name || (sends && msg.params?.name === SEND.name)) && args?.hold === true && typeof args.canary === 'string') {
        held.set(args.canary, msg);
        control?.write(`${JSON.stringify({ type: 'notice', notice: 'held', canary: args.canary })}\n`);
        return;
      }
      if (msg.method === 'tools/list' && failingList) {
        const told = failingList;
        failingList = null;
        toHost({ id: msg.id, error: { code: -32603, message: 'the fixture fails this listing' } });
        told();
        return;
      }
      toHost({ id: msg.id, ...answer(msg) });
      if (msg.method === 'featureSets/update' && channels.length && !registering) register();
      return;
    }
    const waiting = waitingOnHost.get(msg.id);
    if (!waiting) return;
    waitingOnHost.delete(msg.id);
    waiting(msg);
  }, asWritten);
  process.stdin.on('end', () => { control?.end(); process.exit(0); });

  const incoming = (m: Delivered) => {
    if (!(channels as unknown[]).includes(m.channelId)) return `channel ${JSON.stringify(m.channelId)} isn't one this server registers (FIXTURE_CHANNELS: ${channels.join(', ') || 'none'})`;
    if (typeof m.messageId !== 'string' || m.messageId === '') return 'messageId must be a non-empty string';
    if (typeof m.author?.id !== 'string' || typeof m.author?.name !== 'string') return 'author must be { id, name }, both strings';
    if (typeof m.text !== 'string' || m.text === '') return 'text must be a non-empty string';
    if (!Number.isFinite(m.at)) return 'at must be a time in milliseconds';
    if (m.topic !== undefined && typeof m.topic !== 'string') return 'topic must be a string when given';
    if (m.images !== undefined && !(Array.isArray(m.images) && m.images.every((i) => typeof i?.data === 'string' && typeof i?.mimeType === 'string'))) return 'images must be a list of { data, mimeType } when given';
    if (m.tags !== undefined && !(Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string'))) return 'tags must be a list of strings when given';
    return {
      channelId: m.channelId,
      messageId: m.messageId,
      author: { id: m.author.id, name: m.author.name },
      timestamp: new Date(m.at as number).toISOString(),
      content: [{ type: 'text', text: m.text }, ...(m.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))],
      ...(m.topic !== undefined ? { metadata: { topic: m.topic } } : {}),
      ...(m.tags !== undefined ? { tags: m.tags } : {}),
    };
  };

  const path = process.env.FIXTURE_CONTROL;
  if (!path) return;
  const relay = (id: number, msg: Reply) => control?.write(`${JSON.stringify(msg.error ? { id, error: msg.error } : { id, result: msg.result })}\n`);
  control = connect(path, () => control!.write(`${JSON.stringify({ type: 'hello', peer: process.env.FIXTURE_PEER || 'server', pid: process.pid })}\n`));
  control.on('error', (e) => { log(`control socket ${path}: ${e.message}`); control = null; });
  lineReader<FromDriver>(control, async (msg) => {
    if (msg.op === 'host') {
      relay(msg.id, await askHost('host/command', msg.params));
    } else if (msg.op === 'deliver') {
      const item = incoming(msg.message ?? {});
      if (typeof item === 'string') return relay(msg.id, { error: { code: -32602, message: item } });
      const refused = await registered;
      if (refused.length) return relay(msg.id, { error: { code: -32002, message: `the host refused this server's channels: ${refused.join('; ')}` } });
      relay(msg.id, await askHost('channels/incoming', { messages: [item] }));
    } else if (msg.op === 'push') {
      if (!pushes) return relay(msg.id, { error: { code: -32601, message: 'this server wasn\'t told FIXTURE_PUSH, so it advertises no pushes' } });
      relay(msg.id, await askHost('push/event', { featureSet: FEATURE_SET, ...msg.event }));
    } else if (msg.op === 'release') {
      const call = held.get(msg.canary);
      if (!call) return relay(msg.id, { error: { code: -32602, message: `no call carrying ${JSON.stringify(msg.canary)} is held` } });
      held.delete(msg.canary);
      toHost({ id: call.id, ...answer(call) });
      relay(msg.id, { result: { released: msg.canary } });
    } else if (msg.op === 'relist') {
      if (failingList) return relay(msg.id, { error: { code: -32602, message: 'a relist is already waiting on the host\'s tools/list' } });
      failingList = () => relay(msg.id, { result: { failed: 'tools/list' } });
      toHost({ method: 'notifications/tools/list_changed' });
    }
  });
}

serve();
