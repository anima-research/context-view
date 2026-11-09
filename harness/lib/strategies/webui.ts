type WithInit = new (url: string, init: { headers: Record<string, string> }) => WebSocket;
type Message = { type?: string; [field: string]: unknown };
interface Wait { test: (m: Message) => boolean; resolve: (m: Message) => void; reject: (e: Error) => void; label: string; timer: NodeJS.Timeout }

export async function openWebUi({ url, basicAuth = null, timeoutMs = 30_000 }: { url: string; basicAuth?: { username: string; password: string } | null; timeoutMs?: number }) {
  const headers: Record<string, string> = basicAuth ? { authorization: `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}` } : {};
  const ws = new (WebSocket as unknown as WithInit)(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`, { headers });
  const received: Message[] = [];
  const taken = new Set<number>();
  const waiting = new Set<Wait>();
  let closed: string | null = null;
  const look = () => {
    for (const w of [...waiting]) {
      const i = received.findIndex((m, k) => !taken.has(k) && w.test(m));
      if (i >= 0) { taken.add(i); waiting.delete(w); clearTimeout(w.timer); w.resolve(received[i]); }
      else if (closed) { waiting.delete(w); clearTimeout(w.timer); w.reject(new Error(`the web UI's socket closed (${closed}) before ${w.label}`)); }
    }
  };
  ws.addEventListener('message', (e) => {
    try { received.push(JSON.parse(String(e.data))); } catch { return; }
    look();
  });
  ws.addEventListener('close', (e: CloseEvent) => { closed = `code ${e.code}${e.reason ? `: ${e.reason}` : ''}`; look(); });
  ws.addEventListener('error', () => { closed ??= 'an error'; look(); });
  const next = (test: (m: Message) => boolean, { timeoutMs: ms = timeoutMs, label = 'the awaited message' }: { timeoutMs?: number; label?: string } = {}) => new Promise<Message>((resolve, reject) => {
    const w: Wait = { test, resolve, reject, label, timer: setTimeout(() => { waiting.delete(w); reject(new Error(`no ${label} from the web UI in ${ms} ms`)); }, ms) };
    waiting.add(w);
    look();
  });
  const welcome = await next((m) => m.type === 'welcome', { label: 'welcome' });
  return {
    welcome,
    send(message: unknown) { ws.send(JSON.stringify(message)); },
    next,
    close() { try { ws.close(); } catch {} },
  };
}
