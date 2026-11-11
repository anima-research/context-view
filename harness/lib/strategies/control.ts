import { type Socket, createServer } from 'node:net';
import { rmSync } from 'node:fs';

interface PeerMessage { type?: string; peer?: unknown; id?: unknown; result?: unknown; error?: { message?: string; code?: unknown; data?: unknown } }
interface Conn { sock: Socket; peer: string | null }
interface Pending { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; label: string; conn: Conn }
interface Waiter { peer: string; since: number; done: () => void; fail: (e: Error) => void; timer: NodeJS.Timeout }
export type Notice = Record<string, unknown>;

export interface Advanced { at: number; fired: { delay: number; repeat: boolean } | null }

export const asWritten = (_key: string, value: unknown, context?: { source: string }) => (typeof value === 'number' && !Number.isSafeInteger(value) && context && /^-?\d+$/.test(context.source)
  ? JSON.rawJSON(context.source) : value);

export function lineReader<T = unknown>(stream: { setEncoding(encoding: BufferEncoding): unknown; on(event: 'data', listener: (part: string) => void): unknown }, onMessage: (msg: T) => void, reviver?: typeof asWritten) {
  let buf = '';
  stream.setEncoding('utf-8');
  stream.on('data', (part) => {
    buf += part;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line, reviver); } catch { continue; }
      onMessage(msg);
    }
  });
}

export async function listenForPeers(path: string) {
  rmSync(path, { force: true });
  const sockets = new Set<Socket>();
  const pending = new Map<unknown, Pending>();
  const waiters = new Set<Waiter>();
  const current = new Map<string | null, Conn>();
  const generations = new Map<string, number>();
  const closings = new Map<string, number>();
  const noticeListeners: Array<(notice: Notice) => void> = [];
  let nextId = 1;

  const settle = (id: unknown, fn: (p: Pending) => void) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  };

  const server = createServer((sock) => {
    sockets.add(sock);
    const conn: Conn = { sock, peer: null };
    lineReader<PeerMessage>(sock, (msg) => {
      if (msg.type === 'hello') {
        conn.peer = String(msg.peer);
        generations.set(conn.peer, (generations.get(conn.peer) ?? 0) + 1);
        current.set(conn.peer, conn);
        for (const w of waiters) if (w.peer === conn.peer && generations.get(conn.peer)! > w.since) w.done();
        return;
      }
      if (msg.type === 'notice') {
        const { type, ...notice } = msg;
        for (const cb of noticeListeners) cb({ peer: conn.peer, ...notice });
        return;
      }
      settle(msg.id, (p) => (msg.error
        ? p.reject(Object.assign(new Error(`${p.label} failed: ${msg.error.message}`), { code: msg.error.code, data: msg.error.data }))
        : p.resolve(msg.result)));
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      sockets.delete(sock);
      if (conn.peer) closings.set(conn.peer, (closings.get(conn.peer) ?? 0) + 1);
      if (current.get(conn.peer) === conn) current.delete(conn.peer);
      for (const [id, p] of pending) {
        if (p.conn === conn) settle(id, () => p.reject(new Error(`the fixture ${conn.peer}'s connection closed while ${p.label} was pending`)));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });

  const request = (peer: string, op: string, body: object, label: string, timeoutMs: number) => {
    const conn = current.get(peer);
    if (!conn) return Promise.reject(new Error(`no ${peer} is connected to ${path}, so ${label} wasn't sent`));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => settle(id, () => reject(new Error(`${label} had no answer in ${timeoutMs} ms`))), timeoutMs);
      pending.set(id, { resolve, reject, timer, label, conn });
      conn.sock.write(`${JSON.stringify({ id, op, ...body })}\n`);
    });
  };

  return {
    generation(peer: string) { return generations.get(peer) ?? 0; },
    closed(peer: string) { return closings.get(peer) ?? 0; },
    waitConnected(peer: string, { since = 0, timeoutMs = 30_000 }: { since?: number; timeoutMs?: number } = {}) {
      if ((generations.get(peer) ?? 0) > since && current.has(peer)) return Promise.resolve(generations.get(peer));
      return new Promise<number | undefined>((resolve, reject) => {
        const w: Waiter = {
          peer,
          since,
          done: () => { waiters.delete(w); clearTimeout(w.timer); resolve(generations.get(peer)); },
          fail: (e) => { waiters.delete(w); clearTimeout(w.timer); reject(e); },
          timer: setTimeout(() => { waiters.delete(w); reject(new Error(`no fixture ${peer} connected to ${path} within ${timeoutMs} ms`)); }, timeoutMs),
        };
        waiters.add(w);
      });
    },
    hostCommand(params: Record<string, unknown>, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}) {
      return request('server', 'host', { params }, `host/command ${String(params?.command)}`, timeoutMs);
    },
    async deliver(message: Record<string, unknown>, { timeoutMs = 60_000, peer = 'server' }: { timeoutMs?: number; peer?: string } = {}) {
      const label = `delivery ${JSON.stringify(message?.messageId)} to channel ${JSON.stringify(message?.channelId)}`;
      const answer = await request(peer, 'deliver', { message }, label, timeoutMs);
      const item = (answer as { results?: Array<{ messageId?: unknown; accepted?: boolean; reason?: string }> } | null | undefined)?.results?.find?.((r) => r.messageId === message.messageId);
      if (!item?.accepted) throw new Error(`the host didn't accept ${label}: ${item?.reason ?? JSON.stringify(answer)}`);
      return item;
    },
    async push(event: Record<string, unknown>, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}) {
      const label = `push/event ${JSON.stringify(event?.eventId)}`;
      const answer = await request('server', 'push', { event }, label, timeoutMs);
      if (!(answer as { accepted?: boolean } | null | undefined)?.accepted) throw new Error(`the host didn't accept ${label}: ${(answer as { reason?: string } | null | undefined)?.reason ?? JSON.stringify(answer)}`);
      return answer;
    },
    moduleRequest(op: string, body: object = {}, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}) {
      return request('module', op, body, `the harness module's ${op}`, timeoutMs);
    },
    advance(at: unknown, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
      return request('clock', 'advance', { at }, `advancing the clock to ${JSON.stringify(at)}`, timeoutMs) as Promise<Advanced>;
    },
    due(at: number, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
      return request('clock', 'due', { at }, `asking the clock whether a timer is due at ${at}`, timeoutMs) as Promise<{ due: boolean }>;
    },
    expectStat(path: string, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
      return request('clock', 'expect-stat', { path }, `asking the clock to report the next stat of ${JSON.stringify(path)}`, timeoutMs);
    },
    release(canary: string, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
      return request('server', 'release', { canary }, `releasing the call held for ${JSON.stringify(canary)}`, timeoutMs);
    },
    relist({ timeoutMs = 60_000 }: { timeoutMs?: number } = {}) {
      return request('server', 'relist', {}, 'tools/list_changed, and an error for the host\'s next tools/list', timeoutMs);
    },
    onNotice(cb: (notice: Notice) => void) { noticeListeners.push(cb); },
    async close() {
      for (const [id, p] of pending) settle(id, () => p.reject(new Error(`the control socket closed while ${p.label} was pending`)));
      for (const w of waiters) w.fail(new Error(`the control socket at ${path} closed before a fixture ${w.peer} connected`));
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(path, { force: true });
    },
  };
}
