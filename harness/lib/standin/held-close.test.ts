import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStandin, type HeldEvent, type RequestRecord, type Step } from './standin.ts';
import type { MessagesBody } from './anthropic.ts';
import type { AgentStep } from './agent.ts';

type Standin = Awaited<ReturnType<typeof startStandin>>;
type MessageItem = NonNullable<MessagesBody['messages']>[number];

const step = (id: string, replies: NonNullable<AgentStep['replies']>, more: Partial<Step> = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const body = (messages: MessageItem[]) => ({ model: 'claude-opus-4-6', max_tokens: 2048, system: 'You are the fixture agent.', tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages });
const calls = [{ name: 'look', input: {} }];
const within = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r('not yet'), ms))]);

async function heldCall(s: Standin) {
  const heldSeen: HeldEvent[] = [];
  s.onHeld((h) => heldSeen.push(h));
  const client = new AbortController();
  const sent = fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body([user('user: [[c:k.in]] hello')])), signal: client.signal }).catch((e: Error) => e);
  for (const until = performance.now() + 5000; !heldSeen.length;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  return { id: heldSeen[0].id, client, sent };
}

async function withHeld(options: Omit<Parameters<typeof startStandin>[0], 'configuration'>, fn: (s: Standin, held: Awaited<ReturnType<typeof heldCall>>) => Promise<void>) {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...options });
  let records: RequestRecord[] | null = null;
  try {
    s.setStep(step('k', [{ text: '[[c:k.r1]] held', hold: true, calls }]));
    await fn(s, await heldCall(s));
  } finally { records = await s.close(); }
  return records;
}

test('whenHeldClosed gives came once the client closes a held call, and seen when asked after, and its release then records it as cut', async () => {
  const records = await withHeld({}, async (s, { id, client, sent }) => {
    const told = s.whenHeldClosed(id);
    client.abort();
    assert.equal(((await sent) as Error).name, 'AbortError');
    assert.equal(await within(told, 2000), 'came');
    assert.equal(await within(s.whenHeldClosed(id), 2000), 'seen');
    s.releaseHeld(id);
  });
  assert.deepEqual(records.map((r) => r.answer!.shape), ['cut']);
});

test('whenHeldClosed has no bound of its own: with the client still holding the call it waits, and a release then answers the call', async () => {
  let answered = null as Response | Error | null;
  const records = await withHeld({}, async (s, { id, sent }) => {
    assert.equal(await within(s.whenHeldClosed(id), 300), 'not yet');
    s.releaseHeld(id);
    answered = await sent;
  });
  assert.equal((answered as Response).status, 200);
  assert.deepEqual(records.map((r) => r.answer!.shape), ['reply']);
});

test("at its own close the stand-in takes no close it makes as a client's: a waiter hears never, and a held call it ends unreleased isn't cut", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('k', [{ text: '[[c:k.r1]] held', hold: true, calls }]));
  const { id } = await heldCall(s);
  const told = s.whenHeldClosed(id);
  const records = await s.close();
  assert.equal(await within(told, 2000), 'never');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await within(s.whenHeldClosed(id), 2000), 'never', 'and one asked once the sockets it closed have closed');
  s.releaseHeld(id);
  assert.notEqual(records[0].answer?.shape, 'cut', 'a release then answers the call, as for any call the host kept open');
});

const sockets = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;
async function closedBoth(open: number) {
  for (const until = performance.now() + 5000; sockets() > open - 2;) {
    if (performance.now() > until) assert.fail('the held call\'s two sockets, the client\'s and the stand-in\'s, didn\'t close within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('with heldCloseOnWait a close the stand-in saw before anyone waited is taken once whenHeldClosed waits: the waiter hears came, not seen, and the release records the call as cut', async () => {
  const records = await withHeld({ heldCloseOnWait: true }, async (s, { id, client, sent }) => {
    const open = sockets();
    client.abort();
    assert.equal(((await sent) as Error).name, 'AbortError');
    await closedBoth(open);
    assert.equal(await within(s.whenHeldClosed(id), 2000), 'came');
    assert.equal(await within(s.whenHeldClosed(id), 2000), 'seen');
    s.releaseHeld(id);
  });
  assert.deepEqual(records.map((r) => [r.answer!.shape, r.closeUntaken]), [['cut', undefined]]);
});

test('with heldCloseOnWait a close nobody waits on is never taken: a release answers the call its client closed, and the stand-in\'s close marks its record closeUntaken', async () => {
  const records = await withHeld({ heldCloseOnWait: true }, async (s, { id, client, sent }) => {
    const open = sockets();
    client.abort();
    assert.equal(((await sent) as Error).name, 'AbortError');
    await closedBoth(open);
    s.releaseHeld(id);
  });
  assert.deepEqual(records.map((r) => [r.answer!.shape, r.closeUntaken]), [['reply', true]]);
});
