// @ts-nocheck
import { createConnection, createServer } from 'node:net';

const args = process.argv.slice(2);
const sockPath = args[args.indexOf('--socket-path') + 1];
const script = JSON.parse(process.env.FAKE_HOST_SCRIPT);
let moved = false;
const phase = () => (moved && script.after ? script.after : script.before);
const send = (sock, message) => sock.write(`${JSON.stringify(message)}\n`);
const lines = (sock, on) => {
  let buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line) on(JSON.parse(line));
    }
  });
};

const ops = {
  server: { host: ({ params }) => (params?.command === 'maintain' ? { ok: true, maintenance: { ran: true } } : { ok: true }) },
  clock: { advance: ({ at }) => { moved = true; return { at, fired: null }; }, due: () => ({ due: true }) },
  module: { snapshot: () => ({ ticks: {}, agents: phase().agents, hostMode: phase().hostMode }), take: () => ({ lines: [], store: {}, blobs: {} }), held: () => phase().held ?? null },
};
for (const [peer, answers] of Object.entries(ops)) {
  const sock = createConnection(process.env.FIXTURE_CONTROL, () => send(sock, { type: 'hello', peer }));
  sock.on('error', () => {});
  lines(sock, (m) => send(sock, { id: m.id, result: answers[m.op]?.(m) ?? null }));
}

createServer((sock) => {
  send(sock, { type: 'lifecycle', phase: 'ready' });
  lines(sock, (m) => {
    if (m.type === 'command' && m.command === '/budget') for (const text of ['--- Stream Token Budgets ---', '  fixture: 0 / 100000']) send(sock, { type: 'command-output', text });
    if (m.type === 'describe') send(sock, { type: 'snapshot', corrId: m.corrId });
    if (m.type === 'panel-request') send(sock, { type: 'panel-response', corrId: m.corrId, ok: true, data: {} });
    if (m.type === 'shutdown') process.exit(0);
  });
}).listen(sockPath);
