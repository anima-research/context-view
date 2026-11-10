import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { type Notice, listenForPeers } from '../lib/strategies/control.ts';
import { png, zlibStored } from '../lib/strategies/png.ts';
import { MAX_SIDE, MAX_TEXT, toolResult } from '../lib/strategies/results.ts';

const SERVER = fileURLToPath(new URL('../lib/strategies/mcpl-server.ts', import.meta.url));
const ANSWER_BOUND_MS = 10_000;
const servers = new Set<ChildProcess>();
after(() => { for (const child of servers) child.kill('SIGKILL'); });

interface Block { type: string; text?: string; data?: string; mimeType?: string }
interface CallResult { content: Block[]; isError?: boolean }
interface Descriptor { id: string; type: string; label: string; direction: string; initiallyOpen: boolean }
interface Reply<R = unknown> { result?: R; error?: { code: number; message: string } }
type Params<P> = P & { [key: string]: unknown };
type Sent =
  | { id: number; method: 'channels/register'; params: Params<{ channels: Descriptor[] }> }
  | { id: number; method: 'channels/incoming'; params: Params<{ messages: Array<{ messageId: string; content: Block[]; tags?: string[] }> }> }
  | { id: number; method: 'host/command'; params: Record<string, unknown> }
  | { id: number; method: 'push/event'; params: Record<string, unknown> };
interface Results {
  initialize: { capabilities: { experimental: { mcpl: { pushEvents?: boolean; featureSets: Array<{ name: string; uses: string[]; tagOntology?: unknown }>; channels?: { lifecycle?: boolean } } } } };
  'featureSets/update': unknown;
  'tools/list': { tools: Array<{ name: string }> };
  'tools/call': CallResult;
  'channels/publish': { delivered: boolean; messageId?: string; reason?: string; threadId?: unknown };
  'channels/open': { channel: Descriptor };
  'channels/close': { closed: boolean };
}
type Host = Awaited<ReturnType<typeof startHost>>;

// agent-framework opens an MCPL server with initialize, the initialized notification and the policy request.
async function startHost({ control = '', channels = '', boot = '', env = {}, answer = () => ({ result: { ok: true } }) }: { control?: string; channels?: string; boot?: string; env?: Record<string, string>; answer?: (msg: Sent) => Reply | null } = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, FIXTURE_CONTROL: control, FIXTURE_CHANNELS: channels, FIXTURE_BOOT: boot, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  servers.add(child);
  child.once('exit', () => servers.delete(child));
  const fromServer: Sent[] = [];
  const waiting = new Map<number, { method: string; resolve: (msg: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 0;
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if ('method' in msg) {
        fromServer.push(msg);
        if (msg.id === undefined) continue;
        Promise.resolve(answer(msg)).then((a) => {
          if (a && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...a }) + '\n');
        });
      } else {
        const pending = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (pending) { clearTimeout(pending.timer); pending.resolve(msg); }
      }
    }
  });
  const fail = (id: number, error: Error) => {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  };
  const request = <M extends keyof Results>(method: M, params: unknown) => new Promise<Reply<Results[M]>>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => fail(id, new Error(`the server sent no answer to ${method} within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiting.set(id, { method, resolve: resolve as (msg: Reply) => void, reject, timer });
    if (child.exitCode !== null || child.signalCode !== null) fail(id, new Error(`the server had exited before ${method}`));
    else child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise<void>((r) => child.once('exit', (code, signal) => {
    for (const [id, { method }] of [...waiting]) fail(id, new Error(`the server exited (${signal ?? `code ${code}`}) before answering ${method}`));
    r();
  }));
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'agent-framework', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const policy = await request('featureSets/update', { effectiveCapabilities: ['tools', 'channels.register', 'channels.incoming'] });
  const call = async (args: object) => (await request('tools/call', { name: 'result', arguments: args })).result!;
  const stop = async () => { child.stdin.end(); child.kill('SIGKILL'); await exited; };
  return { child, init, policy, call, request, fromServer, stop, exited };
}

function tempSocket() {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  return { path: join(dir, 'c.sock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const textOf = (r: CallResult) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function pngSize(b64: string) {
  const png = Buffer.from(b64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const CALLS = [
  { kind: 'prose', size: 4000, canary: 'CANARY-P-17' },
  { kind: 'code', size: 2500, canary: 'CANARY-C-4' },
  { kind: 'json', size: 3000, canary: 'CANARY-J-9' },
  { kind: 'image', width: 64, height: 48, canary: 'CANARY-I-2' },
];

test('S1: the same arguments give byte-identical results, in one process and in another', async () => {
  const a = await startHost();
  const b = await startHost();
  try {
    for (const args of CALLS) {
      const first = await a.call(args);
      const again = await a.call({ ...args });
      const elsewhere = await b.call(JSON.parse(JSON.stringify(args)));
      assert.equal(JSON.stringify(again), JSON.stringify(first), `${args.kind}: same process`);
      assert.equal(JSON.stringify(elsewhere), JSON.stringify(first), `${args.kind}: another process`);
      assert.notEqual(first.isError, true, `${args.kind}: not an error`);
    }
  } finally { await a.stop(); await b.stop(); }
});

test('S2: a text result is exactly the asked size with the canary at its start; json parses with the canary as its first member; an image is a PNG of the asked size with the canary beside it', async () => {
  const h = await startHost();
  try {
    for (const args of CALLS.filter((c) => c.kind !== 'image')) {
      for (const size of [args.size, args.size! + 1, 257]) {
        const text = textOf(await h.call({ ...args, size }));
        assert.equal(text.length, size, `${args.kind} at ${size}`);
        if (args.kind === 'json') {
          assert.ok(text.startsWith(`{"canary":${JSON.stringify(args.canary)}`), `json at ${size} opens with its canary`);
          assert.equal(JSON.parse(text).canary, args.canary, `json at ${size} parses`);
        } else {
          assert.ok(text.startsWith(args.canary), `${args.kind} at ${size} begins with its canary`);
        }
      }
    }
    const img = await h.call({ kind: 'image', width: 37, height: 5, canary: 'CANARY-I-3' });
    const image = img.content.find((b) => b.type === 'image');
    assert.equal(image!.mimeType, 'image/png');
    assert.deepEqual(pngSize(image!.data!), { width: 37, height: 5 });
    assert.ok(textOf(img).includes('CANARY-I-3'));
  } finally { await h.stop(); }
});

test('S3: arguments the server cannot honour get an error result naming what is wrong', async () => {
  const h = await startHost();
  try {
    const cases = [
      [{ kind: 'poem', size: 100, canary: 'C' }, /kind/],
      [{ kind: 'prose', size: 3, canary: 'CANARY-LONG' }, /size/],
      [{ kind: 'json', size: 12, canary: 'CANARY-J' }, /size/],
      [{ kind: 'prose', size: 100 }, /canary/],
      [{ kind: 'prose', size: 1.5, canary: 'C' }, /size/],
      [{ kind: 'prose', size: MAX_TEXT + 1, canary: 'C' }, /size/],
      [{ kind: 'image', canary: 'C' }, /width/],
      [{ kind: 'image', width: 0, height: 4, canary: 'C' }, /width/],
      [{ kind: 'image', width: MAX_SIDE + 1, height: 4, canary: 'C' }, /width/],
      [{ kind: 'image', width: 4, height: MAX_SIDE + 1, canary: 'C' }, /height/],
      [{ kind: 'mixed', width: MAX_SIDE + 1, height: 4, size: 100, canary: 'C' }, /width/],
      [{ kind: 'mixed', width: 4, height: MAX_SIDE + 1, size: 100, canary: 'C' }, /height/],
      [{ kind: 'mixed', width: 4, height: 4, size: MAX_TEXT + 1, canary: 'C' }, /size/],
    ] satisfies Array<[object, RegExp]>;
    for (const [args, names] of cases) {
      const r = await h.call(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(textOf(r), names, JSON.stringify(args));
    }
  } finally { await h.stop(); }
});

test('S4: a host command reaches the host with exactly its params, and the answer comes back whole; a host error comes back as a rejection', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const answer = { ok: true, maintenance: { intervalMs: 5000, agents: [{ agentName: 'smoke', ready: false, pending: { compressions: 2 } }] }, hostMode: { mode: 'running' } };
  const h = await startHost({
    control: sock.path,
    answer: (msg) => (msg.params.command === 'fail' ? { error: { code: -32002, message: 'host/command requires host-owned authority' } } : { result: answer }),
  });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const params = { command: 'maintain', requesterName: 'fixture', nested: { a: [1, 2] } };
    const got = await ctl.hostCommand(params, { timeoutMs: 5000 });
    assert.deepEqual(got, answer);
    const sent = h.fromServer.filter((m) => m.method === 'host/command');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, params);
    await assert.rejects(ctl.hostCommand({ command: 'fail' }, { timeoutMs: 5000 }), (e: Error & { code?: unknown }) => e.code === -32002 && /host-owned authority/.test(e.message));
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: with no server connected, a host command rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  try {
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 }), /no server is connected/);
  } finally { await ctl.close(); sock.done(); }
});

test('S5: a command pending when the connection closes rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const pending = ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 });
    for (const until = performance.now() + 5000; !h.fromServer.some((m) => m.method === 'host/command');) {
      if (performance.now() > until) assert.fail('the fake host was sent no host/command within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    h.child.kill('SIGKILL');
    await assert.rejects(pending, /connection closed/);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: a command the host never answers rejects at the caller\'s bound, naming the command', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const t0 = performance.now();
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 300 }), /maintain/);
    const waited = performance.now() - t0;
    assert.ok(waited >= 280, `it rejected at the bound, not at once (${Math.round(waited)} ms)`);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S6: after a restart the new server takes the commands, and the old one closing later leaves it connected', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const old = await startHost({ control: sock.path, answer: () => ({ result: { from: 'old' } }) });
  let fresh: Host | undefined;
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const gen = ctl.generation('server');
    fresh = await startHost({ control: sock.path, answer: () => ({ result: { from: 'new' } }) });
    await ctl.waitConnected('server', { since: gen, timeoutMs: 5000 });
    await old.stop();
    for (const until = performance.now() + 5000; ctl.closed('server') < 1;) {
      if (performance.now() > until) assert.fail('the control saw no server connection close within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 5000 }), { from: 'new' });
  } finally { await old.stop(); await fresh?.stop(); await ctl.close(); sock.done(); }
});

const channelHost = (accepted: boolean, reason?: string) => (msg: Sent): Reply => {
  if (msg.method === 'channels/register') return { result: { results: msg.params.channels.map((c) => ({ id: c.id, accepted: true })) } };
  if (msg.method === 'channels/incoming') return { result: { results: msg.params.messages.map((m) => ({ messageId: m.messageId, accepted, ...(reason ? { reason } : {}) })) } };
  return { result: { ok: true } };
};

test('S7: the server registers the channels it is given, and a delivery reaches the host on its channel with its author, topic and time', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general, random', answer: channelHost(true) });
  const plain = await startHost();
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'step-7', author: { id: 'u-alice', name: 'Alice' }, topic: 'garden', text: 'CANARY-CH-1 hello', at: Date.UTC(2026, 0, 2, 3, 4, 5) };
    assert.deepEqual(await ctl.deliver(message, { timeoutMs: 5000 }), { messageId: 'step-7', accepted: true });
    const methods = h.fromServer.map((m) => m.method);
    const reg = h.fromServer.find((m) => m.method === 'channels/register');
    assert.deepEqual(reg!.params.channels.map((c) => c.id), ['general', 'random']);
    assert.ok(methods.indexOf('channels/register') < methods.indexOf('channels/incoming'), 'registered before the first delivery');
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming')!.params, {
      messages: [{ channelId: 'general', messageId: 'step-7', author: { id: 'u-alice', name: 'Alice' }, timestamp: '2026-01-02T03:04:05.000Z', content: [{ type: 'text', text: 'CANARY-CH-1 hello' }], metadata: { topic: 'garden' } }],
    });
    await plain.call({ kind: 'prose', size: 10, canary: 'C' });
    assert.equal(plain.fromServer.some((m) => m.method === 'channels/register'), false, 'a server given no channels registers none');
  } finally { await h.stop(); await plain.stop(); await ctl.close(); sock.done(); }
});

test('S7: a refused message rejects with the host\'s reason; a channel the server doesn\'t register, or a field it can\'t send, rejects without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(false, 'channel is tuned out') });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const ok = { channelId: 'general', messageId: 'm1', author: { id: 'u', name: 'U' }, text: 'hi', at: 0 };
    await assert.rejects(ctl.deliver(ok, { timeoutMs: 5000 }), /tuned out/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm2', channelId: 'nowhere' }, { timeoutMs: 5000 }), /nowhere/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm3', at: 'soon' }, { timeoutMs: 5000 }), /at must be/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm4', author: 'U' }, { timeoutMs: 5000 }), /author/);
    assert.deepEqual(h.fromServer.filter((m) => m.method === 'channels/incoming').map((m) => m.params.messages[0].messageId), ['m1']);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S8: a reply published to one of the server\'s channels is delivered, with ids fixed by boot and order; one to another channel is refused with a reason', async () => {
  const publish = (h: Host, channelId: string, extra: object = {}) => h.request('channels/publish', { conversationId: 'smoke', channelId, content: [{ type: 'text', text: 'Noted.' }], ...extra });
  const a = await startHost({ channels: 'general', boot: '3', answer: channelHost(true) });
  const b = await startHost({ channels: 'general', boot: '3', answer: channelHost(true) });
  const later = await startHost({ channels: 'general', boot: '4', answer: channelHost(true) });
  try {
    const first = [(await publish(a, 'general')).result, (await publish(a, 'general', { threadId: null })).result];
    assert.deepEqual(first, [{ delivered: true, messageId: 'pub-3-1' }, { delivered: true, messageId: 'pub-3-2', threadId: null }]);
    const again = [(await publish(b, 'general')).result, (await publish(b, 'general', { threadId: null })).result];
    assert.deepEqual(again, first, 'the same boot and order give the same ids');
    assert.equal((await publish(later, 'general')).result!.messageId, 'pub-4-1', 'a later boot gives ids of its own');
    const elsewhere = (await publish(a, 'nowhere')).result!;
    assert.equal(elsewhere.delivered, false);
    assert.match(elsewhere.reason!, /nowhere/);
  } finally { await a.stop(); await b.stop(); await later.stop(); }
});

test('S8b: a reply whose text carries [[fail-publish]] is answered not delivered, with a reason and no message id, and takes no id from the replies after it', async () => {
  const publish = (h: Host, text: string) => h.request('channels/publish', { conversationId: 'smoke', channelId: 'general', content: [{ type: 'text', text }] });
  const h = await startHost({ channels: 'general', boot: '3', answer: channelHost(true) });
  try {
    const failed = (await publish(h, 'Noted. [[fail-publish]]')).result!;
    assert.equal(failed.delivered, false);
    assert.equal('messageId' in failed, false);
    assert.match(failed.reason!, /\[\[fail-publish\]\]/);
    assert.deepEqual((await publish(h, 'Noted.')).result, { delivered: true, messageId: 'pub-3-1' });
  } finally { await h.stop(); }
});

test('S2b: an image\'s pixels are stored, not compressed, so the same colours give the same bytes from any zlib', () => {
  for (const n of [0, 1, 65_535, 65_536, 200_001]) {
    const raw = Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256));
    const z = zlibStored(raw);
    assert.deepEqual(inflateSync(z), raw, `${n} bytes round-trip through zlib`);
    // Stored blocks: each a 5-byte head (BTYPE 00) then its bytes as they are, between the zlib head and the Adler-32.
    const blocks = Math.max(1, Math.ceil(n / 0xffff));
    assert.equal(z.length, 2 + 5 * blocks + n + 4, `${n} bytes stored, not compressed`);
    for (let k = 0, at = 2; k < blocks; k++) {
      const len = z.readUInt16LE(at + 1);
      assert.equal(z[at] & 0b110, 0, `block ${k} of ${n} bytes is stored`);
      assert.deepEqual(z.subarray(at + 5, at + 5 + len), raw.subarray(k * 0xffff, k * 0xffff + len));
      at += 5 + len;
    }
  }
  const picker = () => { let k = 1; return (m: number) => { k = (k * 1103515245 + 12345) % 2147483648; return k % m; }; };
  const a = Buffer.from(png(400, 300, picker()), 'base64');
  assert.deepEqual(Buffer.from(png(400, 300, picker()), 'base64'), a, 'the same picks, the same bytes');
  assert.equal(createHash('sha256').update(Buffer.from(png(4, 3, picker()), 'base64')).digest('hex'), 'eead022f35527e799e94602d980ca449c99a8a93dcf6bb55697021884a7c68d3', 'the bytes themselves, as any zlib leaves them');
  const idat = a.indexOf('IDAT', 0, 'latin1');
  const pixels = inflateSync(a.subarray(idat + 4, idat + 4 + a.readUInt32BE(idat - 4)));
  assert.equal(pixels.length, 300 * (1 + 400 * 3), 'one filter byte and three per pixel, for each row');
});

test('S9: a delivery\'s images reach the host after its text, as image blocks; images that aren\'t { data, mimeType } reject without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(true) });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'pic', author: { id: 'u', name: 'U' }, text: 'CANARY-IMG look', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }], at: 0 };
    await ctl.deliver(message, { timeoutMs: 5000 });
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming')!.params.messages[0].content, [{ type: 'text', text: 'CANARY-IMG look' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
    await assert.rejects(ctl.deliver({ ...message, messageId: 'bad', images: [{ data: 'x' }] }, { timeoutMs: 5000 }), /images/);
    assert.equal(h.fromServer.filter((m) => m.method === 'channels/incoming').length, 1);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S10: a call whose arguments say hold is answered only when the driver releases its canary, and the driver hears that it\'s held; releasing a canary no call holds rejects', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const notices: Notice[] = [];
  ctl.onNotice((n) => notices.push(n));
  const h = await startHost({ control: sock.path });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    let answered = null;
    const held = h.call({ kind: 'prose', size: 200, canary: 'CANARY-H-1', hold: true }).then((r) => { answered = r; return r; });
    for (const until = performance.now() + 5000; !notices.length;) {
      if (performance.now() > until) assert.fail('no held notice came within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(notices, [{ peer: 'server', notice: 'held', canary: 'CANARY-H-1' }]);
    assert.equal(textOf(await h.call({ kind: 'prose', size: 50, canary: 'CANARY-H-2' })).length, 50, 'other calls are answered meanwhile');
    assert.equal(answered, null);
    assert.deepEqual(await ctl.release('CANARY-H-1', { timeoutMs: 5000 }), { released: 'CANARY-H-1' });
    const r = await held;
    assert.equal(textOf(r).length, 200);
    assert.ok(textOf(r).startsWith('CANARY-H-1'));
    await assert.rejects(ctl.release('CANARY-H-1', { timeoutMs: 5000 }), /no call carrying/);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S11: a mixed result is a text, an image of the asked size and a text, the two texts together the asked size, each starting with the canary', async () => {
  const h = await startHost();
  try {
    const r = await h.call({ kind: 'mixed', size: 300, width: 32, height: 24, canary: 'CANARY-M-1' });
    assert.deepEqual(r.content.map((b) => b.type), ['text', 'image', 'text']);
    assert.equal(r.content[0].text!.length + r.content[2].text!.length, 300);
    assert.ok(r.content[0].text!.startsWith('CANARY-M-1') && r.content[2].text!.startsWith('CANARY-M-1'));
    assert.deepEqual(pngSize(r.content[1].data!), { width: 32, height: 24 });
    assert.equal((await h.call({ kind: 'mixed', size: 300, canary: 'CANARY-M-2' })).isError, true, 'a mixed result needs its image size');
  } finally { await h.stop(); }
});

test('S12: a delivery\'s tags reach the host with it; tags that aren\'t strings reject without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(true) });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'tagged', author: { id: 'u', name: 'U' }, text: 'CANARY-T hi', tags: ['chat:addressed'], at: 0 };
    await ctl.deliver(message, { timeoutMs: 5000 });
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming')!.params.messages[0].tags, ['chat:addressed']);
    await assert.rejects(ctl.deliver({ ...message, messageId: 'bad', tags: [1] }, { timeoutMs: 5000 }), /tags/);
    assert.equal(h.fromServer.filter((m) => m.method === 'channels/incoming').length, 1);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S13: a server named as another peer takes the deliveries sent to that peer, beside the first; one given a tag ontology declares it in its feature set, and one given none declares none', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const ontology = { tags: { 'w12:ping': { desc: 'a ping', suggestedTreatment: 'immediate' } } };
  const first = await startHost({ control: sock.path, channels: 'general', env: { FIXTURE_ONTOLOGY: JSON.stringify(ontology) }, answer: channelHost(true) });
  const second = await startHost({ control: sock.path, channels: 'elsewhere', env: { FIXTURE_PEER: 'server:quiet' }, answer: channelHost(true) });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    await ctl.waitConnected('server:quiet', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'elsewhere', messageId: 'q-1', author: { id: 'u-ash', name: 'Ash' }, text: 'CANARY-Q-1 hi', at: Date.UTC(2026, 0, 2) };
    assert.deepEqual(await ctl.deliver(message, { timeoutMs: 5000, peer: 'server:quiet' }), { messageId: 'q-1', accepted: true });
    assert.equal(second.fromServer.filter((m) => m.method === 'channels/incoming').length, 1);
    assert.equal(first.fromServer.filter((m) => m.method === 'channels/incoming').length, 0, 'the first server got none');
    const sets = (h: Host) => h.init.result!.capabilities.experimental.mcpl.featureSets;
    assert.deepEqual(sets(first).map((f) => f.tagOntology), [ontology]);
    assert.deepEqual(sets(second).map((f) => 'tagOntology' in f), [false]);
  } finally { await first.stop(); await second.stop(); await ctl.close(); sock.done(); }
});

test('S14: a server told FIXTURE_SEND lists send_message beside result and answers a send with discord-mcpl\'s receipt, its channel by its MCPL id; one not told it lists result alone', async () => {
  const sends = await startHost({ channels: 'chat', boot: '3', env: { FIXTURE_SEND: '1' } });
  const plain = await startHost({ channels: 'chat' });
  try {
    assert.deepEqual((await sends.request('tools/list', {})).result!.tools.map((t) => t.name), ['result', 'send_message']);
    assert.deepEqual((await plain.request('tools/list', {})).result!.tools.map((t) => t.name), ['result']);
    const sent = (await sends.request('tools/call', { name: 'send_message', arguments: { channelId: 'chat', content: 'hello' } })).result!;
    assert.notEqual(sent.isError, true);
    assert.deepEqual(JSON.parse(textOf(sent)), { messageId: 'sent-3-1', channelId: 'chat', channelLabel: 'chat' });
    const again = (await sends.request('tools/call', { name: 'send_message', arguments: { channelId: 'chat', content: 'again' } })).result!;
    assert.equal(JSON.parse(textOf(again)).messageId, 'sent-3-2', 'each send has an id of its own');
    assert.equal((await plain.request('tools/call', { name: 'send_message', arguments: { channelId: 'chat', content: 'hello' } })).error?.code, -32602, 'a server not told FIXTURE_SEND refuses the tool');
  } finally { await sends.stop(); await plain.stop(); }
});

test('S15: a server given channel kinds registers each channel with its own, a field left out as an open bidirectional channel\'s, directs their lifecycle, and opens or closes only a channel it registers; one given none registers every channel open and bidirectional and directs no lifecycle', async () => {
  const kinds = { side: { initiallyOpen: false }, feed: { direction: 'inbound', initiallyOpen: false } };
  const h = await startHost({ channels: 'chat,side,feed', env: { FIXTURE_CHANNEL_KINDS: JSON.stringify(kinds) }, answer: channelHost(true) });
  const plain = await startHost({ channels: 'chat,side', answer: channelHost(true) });
  try {
    const registered = async (host: Host) => {
      for (const until = performance.now() + 5000; !host.fromServer.some((m) => m.method === 'channels/register');) {
        if (performance.now() > until) throw new Error('the server registered no channels within 5 s');
        await new Promise((r) => setTimeout(r, 10));
      }
      return host.fromServer.find((m) => m.method === 'channels/register')!.params.channels;
    };
    const fields = (channels: Descriptor[]) => channels.map(({ id, direction, initiallyOpen }) => ({ id, direction, initiallyOpen }));
    assert.deepEqual(fields(await registered(h)), [
      { id: 'chat', direction: 'bidirectional', initiallyOpen: true },
      { id: 'side', direction: 'bidirectional', initiallyOpen: false },
      { id: 'feed', direction: 'inbound', initiallyOpen: false },
    ]);
    const lifecycle = (host: Host) => host.init.result!.capabilities.experimental.mcpl.channels!.lifecycle;
    assert.equal(lifecycle(h), true);
    const opened = await h.request('channels/open', { channelId: 'feed', type: 'chat' });
    assert.deepEqual(fields([opened.result!.channel]), [{ id: 'feed', direction: 'inbound', initiallyOpen: false }]);
    assert.deepEqual((await h.request('channels/close', { channelId: 'chat' })).result, { closed: true });
    for (const method of ['channels/open', 'channels/close'] as const) {
      const refused = await h.request(method, { channelId: 'elsewhere', type: 'chat' });
      assert.ok(refused.error && !refused.result, `${method} of a channel the server doesn't register is refused`);
    }
    assert.deepEqual(fields(await registered(plain)), [
      { id: 'chat', direction: 'bidirectional', initiallyOpen: true },
      { id: 'side', direction: 'bidirectional', initiallyOpen: true },
    ]);
    assert.equal(lifecycle(plain), undefined);
  } finally { await h.stop(); await plain.stop(); }
});

test('S16: a server told FIXTURE_PUSH advertises pushes and a feature set that uses them, and its push op sends the host a push/event in that set and answers with the host\'s answer; one not told it advertises neither and refuses the op', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const hosts = [];
  try {
    const pushes = await startHost({ control: sock.path, env: { FIXTURE_PUSH: '1' }, answer: (msg) => (msg.method === 'push/event' ? { result: { accepted: true, inferenceId: 'inf-1' } } : { result: { ok: true } }) });
    hosts.push(pushes);
    const mcpl = (h: Host) => h.init.result!.capabilities.experimental.mcpl;
    assert.equal(mcpl(pushes).pushEvents, true);
    assert.deepEqual(mcpl(pushes).featureSets.map((f) => [f.name, f.uses]), [['fixture', ['tools', 'pushEvents']]]);
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const event = { eventId: 'e.1', timestamp: '2026-01-05T09:00:00.000Z', origin: { source: 'fixture', channelId: 'dm', messageId: 'e.1', authorId: 'u-wren', authorName: 'Wren' }, tags: ['chat:addressed'], payload: { content: [{ type: 'text', text: 'hello' }] } };
    assert.deepEqual(await ctl.push(event, { timeoutMs: 5000 }), { accepted: true, inferenceId: 'inf-1' });
    assert.deepEqual(pushes.fromServer.filter((m) => m.method === 'push/event').map((m) => m.params), [{ featureSet: 'fixture', ...event }]);
    await pushes.stop();
    const plain = await startHost({ control: sock.path });
    hosts.push(plain);
    assert.equal(mcpl(plain).pushEvents, undefined);
    assert.deepEqual(mcpl(plain).featureSets.map((f) => f.uses), [['tools']]);
    await ctl.waitConnected('server', { since: 1, timeoutMs: 5000 });
    await assert.rejects(ctl.push({ eventId: 'e.2', payload: { content: [{ type: 'text', text: 'x' }] } }, { timeoutMs: 5000 }), /FIXTURE_PUSH/);
    assert.deepEqual(plain.fromServer.filter((m) => m.method === 'push/event'), [], 'it sends the host nothing');
  } finally { for (const h of hosts) await h.stop(); await ctl.close(); sock.done(); }
});

test('S16b: a push the host doesn\'t accept fails the driver\'s push, naming the host\'s reason or, where it gives none, its whole answer, as a delivery it doesn\'t accept does', async () => {
  for (const [answer, why] of [[{ accepted: false, reason: 'not permitted' }, /the host didn't accept push\/event "e\.3": not permitted$/], [{ accepted: false }, /the host didn't accept push\/event "e\.3": \{"accepted":false\}$/], [{ ok: true }, /the host didn't accept push\/event "e\.3": \{"ok":true\}$/]] satisfies Array<[object, RegExp]>) {
    const sock = tempSocket();
    const ctl = await listenForPeers(sock.path);
    let host: Host | undefined;
    try {
      host = await startHost({ control: sock.path, env: { FIXTURE_PUSH: '1' }, answer: (msg) => (msg.method === 'push/event' ? { result: answer } : { result: { ok: true } }) });
      await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
      await assert.rejects(ctl.push({ eventId: 'e.3', payload: { content: [{ type: 'text', text: 'x' }] } }, { timeoutMs: 5000 }), why, JSON.stringify(answer));
    } finally { await host?.stop(); await ctl.close(); sock.done(); }
  }
});

test('S17: the result tool declares width and height as integers and leaves channel undeclared, as the continuation\'s long integers need: two under integer declarations, two under a parameter the tool doesn\'t declare', async () => {
  const h = await startHost();
  try {
    const tools = (await h.request('tools/list', {})).result!.tools as Array<{ name: string; inputSchema: { properties: Record<string, { type?: string }> } }>;
    const declared = tools.find((t) => t.name === 'result')!.inputSchema.properties;
    assert.deepEqual([declared.width?.type, declared.height?.type, 'channel' in declared], ['integer', 'integer', false]);
  } finally { await h.stop(); }
});

test('S18: the served fixture reads a long integer the host sends as an exact number token as written, so its result says it unrounded; a call holding no unsafe integer is answered as before', async () => {
  const h = await startHost();
  try {
    const raw = (text: string) => (JSON as unknown as { rawJSON: (t: string) => unknown }).rawJSON(text);
    const texts = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((b) => (b.type === 'text' ? b.text : `(${b.type})`));
    const exact = texts(await h.call({ kind: 'prose', size: 2_000, canary: '[[c:s18.exact]]', width: raw('1234567890123456789'), height: raw('-2345678901234567891') }));
    assert.equal(exact.at(-1), 'the long integers as received: {"height":-2345678901234567891,"width":1234567890123456789}');
    const plain = { kind: 'prose', size: 2_000, canary: '[[c:s18.plain]]', width: 640, height: 9_007_199_254_740_991, scale: 1.5e300 };
    assert.deepEqual(texts(await h.call(plain)), texts(toolResult(plain)), 'the control call, with safe integers only, is answered as toolResult answers its JSON');
  } finally { await h.stop(); }
});
