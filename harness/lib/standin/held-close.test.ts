// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStandin } from './standin.ts';

const step = (id, replies, more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const body = (messages) => ({ model: 'claude-opus-4-6', max_tokens: 2048, system: 'You are the fixture agent.', tools: [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }], messages });
const calls = [{ name: 'look', input: {} }];
// What a promise settles to within `ms`, or that it hadn't.
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('not yet'), ms))]);

// A held request: its id once onHeld names it, the client that can close it, and what the client's fetch gives.
async function heldCall(s) {
  const heldSeen = [];
  s.onHeld((h) => heldSeen.push(h));
  const client = new AbortController();
  const sent = fetch(`${s.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body([user('user: [[c:k.in]] hello')])), signal: client.signal }).catch((e) => e);
  for (const until = performance.now() + 5000; !heldSeen.length;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  return { id: heldSeen[0].id, client, sent };
}

async function withHeld(options, fn) {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...options });
  let records = null;
  try {
    s.setStep(step('k', [{ text: '[[c:k.r1]] held', hold: true, calls }]));
    await fn(s, await heldCall(s));
  } finally { records = await s.close(); }
  return records;
}

test('whenHeldClosed is true once the client closes a held call, and its release then records it as cut', async () => {
  const records = await withHeld({}, async (s, { id, client, sent }) => {
    const told = s.whenHeldClosed(id, 5000);
    client.abort();
    assert.equal((await sent).name, 'AbortError');
    assert.equal(await told, true);
    assert.equal(await s.whenHeldClosed(id, 1), true, 'and stays true');
    s.releaseHeld(id);
  });
  assert.deepEqual(records.map((r) => r.answer.shape), ['cut']);
});

test('whenHeldClosed is false once its bound passes with the client still holding the call, and its release then answers it', async () => {
  let answered = null;
  const records = await withHeld({}, async (s, { id, sent }) => {
    assert.equal(await within(s.whenHeldClosed(id, 50), 2000), false);
    s.releaseHeld(id);
    answered = await sent;
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(records.map((r) => r.answer.shape), ['reply']);
});

test("at its own close the stand-in takes no close it makes as a client's: a waiter hears false, and a held call it ends unreleased isn't cut", async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('k', [{ text: '[[c:k.r1]] held', hold: true, calls }]));
  const { id } = await heldCall(s);
  const told = s.whenHeldClosed(id, 60_000);
  const records = await s.close();
  assert.equal(await within(told, 2000), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await within(s.whenHeldClosed(id, 60_000), 2000), false, 'and one asked once the sockets it closed have closed');
  s.releaseHeld(id);
  assert.notEqual(records[0].answer?.shape, 'cut', 'a release then answers the call, as for any call the host kept open');
});

test('with heldCloseDelayMs the stand-in takes a close that much later, so a release before then answers a call its client already closed; its own close clears the delay', async () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  let pending = null;
  const records = await withHeld({ heldCloseDelayMs: 60_000 }, async (s, { id, client, sent }) => {
    client.abort();
    assert.equal((await sent).name, 'AbortError');
    assert.equal(await s.whenHeldClosed(id, 200), false, 'not taken as closed while the delay runs');
    s.releaseHeld(id);
    pending = timeouts();
  });
  assert.ok(timeouts() < pending, 'the close cleared the delay\'s timer');
  assert.deepEqual(records.map((r) => r.answer.shape), ['reply'], 'a release before the close is taken answers the call');
});
