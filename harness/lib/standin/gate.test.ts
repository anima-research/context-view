// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decoded, keptBody } from './standin.ts';
import { agentBody, arrivals, post, startStandin, step } from '../testing/standin.ts';

const { MESSAGES_ROWS, BEDROCK_ROWS } = await import('./anthropic.ts');
const { CHAT_ROWS } = await import('./chat.ts');
const { RESPONSES_ROWS, CODEX_ROWS } = await import('./responses.ts');

const BEDROCK = 'us.anthropic.claude-opus-4-6-v1';
const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:g.in]] go' }] }];
const CODECS = [
  { api: 'Messages', path: '/v1/messages', rows: MESSAGES_ROWS, base: agentBody({ canary: '[[c:g.in]]', stream: false }) },
  { api: 'Bedrock', path: `/model/${BEDROCK}/invoke`, rows: BEDROCK_ROWS, base: { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:g.in]] hi' }] } },
  { api: 'Chat Completions', path: '/v1/chat/completions', rows: CHAT_ROWS, base: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'user: [[c:g.in]] hi' }] } },
  { api: 'Responses', path: '/v1/responses', rows: RESPONSES_ROWS, base: { model: 'gpt-6.1-sol', store: false, input } },
  { api: 'Codex', path: '/codex/responses', rows: CODEX_ROWS, base: { model: 'gpt-6.1-sol', store: false, stream: true, input } },
];
const SAMPLES = [['a string', 'x'], ['a number', 5], ['a boolean', true], ['a list', [1]], ['an object', { a: 1 }]];

const send = (s, path, body) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
const copied = (r) => ['head', 'model', 'maxTokens', 'messages'].filter((k) => r[k] !== undefined);

function cases(rows, place = (v) => v, at = '') {
  const out = [];
  for (const [field, row] of Object.entries(rows ?? {})) {
    const set = (v) => place({ [field]: v });
    for (const [kind, v] of SAMPLES) if (!row.is(v)) out.push({ field: `${at}${field}`, kind, row: row.name, set: set(v) });
    if (row.rows) out.push(...cases(row.rows, (inner) => set(inner), `${at}${field}.`));
  }
  return out;
}

for (const { api, path, rows, base } of CODECS) {
  test(`a ${api} request whose named field is of another kind is unclassified, its reason naming the field and both kinds, and its record holds no field copied from it (each row of its table, each other kind)`, async () => {
    assert.ok(rows, `the ${api} codec has a table`);
    const all = cases(rows);
    assert.ok(all.length > 0);
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    s.setStep(step('g'));
    const statuses = [];
    for (const c of all) statuses.push((await send(s, path, { ...base, ...c.set })).status);
    const records = await s.close();
    assert.deepEqual(statuses, all.map(() => 400));
    all.forEach((c, i) => {
      assert.equal(records[i].kind, 'unclassified', `${c.field} as ${c.kind}`);
      assert.equal(records[i].reason, `a ${api} request's \`${c.field}\` is ${c.kind}, and the stand-in reads it as ${c.row}`);
      assert.deepEqual(copied(records[i]), [], `${c.field} as ${c.kind}: no field copied`);
    });
  });

  test(`a ${api} request's named field that is null passes the gate, as an absent one does: the gate turns none away, and each record keeps its copied fields`, async () => {
    assert.ok(rows, `the ${api} codec has a table`);
    const s = await startStandin({ configuration: { windowTokens: 50_000 } });
    s.setStep(step('n', Object.keys(rows ?? {}).map(() => ({ text: 'n' }))));
    for (const field of Object.keys(rows ?? {})) await send(s, path, { ...base, [field]: null });
    const records = await s.close();
    assert.equal(records.length, Object.keys(rows ?? {}).length);
    for (const r of records) assert.ok(!String(r.reason ?? '').includes('request\'s `'), r.reason);
    for (const r of records) assert.ok(r.head, `a record whose head is missing, which a turned-away or a thrown body leaves: ${r.reason}`);
  });
}

test('the four kinds answered before are unclassified now: a model that is a list of one known name, on Messages and Chat Completions; a numeric reasoning_effort; a numeric service_tier and a string store on the OpenAI route. On the Codex route a numeric service_tier is still refused in the same words, and its record keeps it as sent', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('f', [{ text: 'a' }]));
  const chat = { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'user: [[c:f.in]] hi' }] };
  const responses = { model: 'gpt-6.1-sol', store: false, input };
  const sent = [
    ['/v1/messages', agentBody({ canary: '[[c:f.in]]', stream: false, model: ['claude-opus-4-6'] })],
    ['/v1/chat/completions', { ...chat, model: ['gpt-5.6-sol'] }],
    ['/v1/chat/completions', { ...chat, reasoning_effort: 5 }],
    ['/v1/responses', { ...responses, service_tier: 5 }],
    ['/v1/responses', { ...responses, store: 'yes' }],
  ];
  const statuses = [];
  for (const [path, body] of sent) statuses.push((await send(s, path, body)).status);
  const codex = await send(s, '/codex/responses', { ...responses, stream: true, service_tier: 5 });
  const said = await codex.json();
  const records = await s.close();
  assert.deepEqual(statuses, [400, 400, 400, 400, 400]);
  assert.deepEqual(records.slice(0, 5).map((r) => r.reason), [
    'a Messages request\'s `model` is a list, and the stand-in reads it as a string',
    'a Chat Completions request\'s `model` is a list, and the stand-in reads it as a string',
    'a Chat Completions request\'s `reasoning_effort` is a number, and the stand-in reads it as a string',
    'a Responses request\'s `service_tier` is a number, and the stand-in reads it as a string',
    'a Responses request\'s `store` is a string, and the stand-in reads it as a boolean',
  ]);
  assert.equal(codex.status, 400);
  assert.equal(said.error.message, 'stand-in: the Codex backend refuses the service tier 5');
  assert.equal(records[5].refused, 'request');
  assert.equal(records[5].head.serviceTier, 5);
});

test('a Messages max_tokens of "100" is refused in the same words as before, after the gate, and its record keeps "100"', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('m'));
  const res = await post(s.url, agentBody({ canary: '[[c:m.in]]', stream: false, max_tokens: '100' }));
  const [r] = await s.close();
  assert.equal(res.status, 400);
  assert.equal(res.json.error.message, 'max_tokens: Field required');
  assert.deepEqual([r.refused, r.maxTokens, r.head.maxTokens], ['max_tokens', '100', '100']);
});

test('a kept body and a fleet child\'s /empty request with a named field of another kind give the gate\'s reason', async () => {
  const bad = { ...agentBody({ canary: '[[c:k.in]]' }), tools: 'x' };
  const reason = 'a Messages request\'s `tools` is a string, and the stand-in reads it as a list of objects';
  assert.equal(decoded('messages', bad).reason, reason);
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen } = arrivals(s);
  s.setStep(step('k'));
  const res = await send(s, '/empty/v1/messages', bad);
  await s.close();
  assert.equal(res.status, 400);
  assert.equal(seen[0].reason, `a fleet child's request, POST /empty/v1/messages: ${reason}`);
});

test('a fleet child\'s /empty request whose body is a list, or an integer too large to hold exactly, is refused as not a JSON object; and a Bedrock request whose body is such an integer has a record with no field copied from it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen } = arrivals(s);
  s.setStep(step('o'));
  const raw = (path, text) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: text });
  const list = await raw('/empty/v1/messages', '[]');
  const big = await raw('/empty/v1/messages', '9007199254740993');
  const bedrock = await raw(`/model/${BEDROCK}/invoke`, '9007199254740993');
  const records = await s.close();
  assert.deepEqual([list.status, big.status, bedrock.status], [400, 400, 400]);
  assert.deepEqual(seen.slice(0, 2).map((e) => e.reason), [0, 1].map(() => 'a fleet child\'s request, POST /empty/v1/messages: its body isn\'t a JSON object'));
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, 'no body');
  assert.deepEqual(copied(records[0]), []);
});

test('a named field sent as an integer too large to hold exactly is named so in the gate\'s reason', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('i'));
  const body = JSON.stringify({ model: 'gpt-6.1-sol', store: false, input }).replace(/^\{/, '{"service_tier":9007199254740993,');
  const res = await fetch(s.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const [r] = await s.close();
  assert.equal(res.status, 400);
  assert.equal(r.reason, 'a Responses request\'s `service_tier` is an integer too large to hold exactly, and the stand-in reads it as a string');
});

test('a kept body that isn\'t JSON says so, for a record that names no API too; an intact one gives that record\'s reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    writeFileSync(join(dir, 'a1.json'), '{"model": ');
    assert.match(keptBody(dir, 'a1', null, 'the record\'s reason').reason, /^its kept body isn't JSON: /);
    writeFileSync(join(dir, 'a2.json'), '{"model": "x"}');
    assert.equal(keptBody(dir, 'a2', null, 'the record\'s reason').reason, 'the record\'s reason');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Bedrock request\'s record takes its model from the path, and a Bedrock body whose model is a list is turned away by the gate', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('b', [{ text: 'a' }]));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:b.in]] hi' }] };
  const ok = await send(s, `/model/${BEDROCK}/invoke`, body);
  const listed = await send(s, `/model/${BEDROCK}/invoke`, { ...body, model: [BEDROCK] });
  const [served, turned] = await s.close();
  assert.equal(ok.status, 200);
  assert.equal(served.model, BEDROCK);
  assert.equal(listed.status, 400);
  assert.equal(turned.reason, 'a Bedrock request\'s `model` is a list, and the stand-in reads it as a string');
  assert.deepEqual(copied(turned), []);
});

test('a request no codec routes keeps the route\'s reason, with fields copied where the first codec\'s gate passes its body and none where it doesn\'t', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('r'));
  const body = agentBody({ canary: '[[c:r.in]]', stream: false });
  const passed = await send(s, '/elsewhere', body);
  const turned = await send(s, '/elsewhere', { ...body, system: 5 });
  const records = await s.close();
  assert.deepEqual([passed.status, turned.status], [404, 404]);
  for (const r of records) assert.equal(r.reason, 'it goes to POST /elsewhere, which no run sends and the stand-in doesn\'t model');
  assert.equal(records[0].head.model, 'claude-opus-4-6');
  assert.deepEqual(copied(records[1]), []);
});

test('a stream sent in another kind is turned away, not answered as a stream by truthiness while its record says stream false: Messages, Chat Completions and the OpenAI Responses route', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('s'));
  const sent = [
    ['/v1/messages', { ...agentBody({ canary: '[[c:s.in]]' }), stream: 'false' }, 'a Messages request\'s `stream` is a string, and the stand-in reads it as a boolean'],
    ['/v1/messages', { ...agentBody({ canary: '[[c:s.in]]' }), stream: 1 }, 'a Messages request\'s `stream` is a number, and the stand-in reads it as a boolean'],
    ['/v1/chat/completions', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'user: [[c:s.in]] hi' }], stream: 'false' }, 'a Chat Completions request\'s `stream` is a string, and the stand-in reads it as a boolean'],
    ['/v1/responses', { model: 'gpt-6.1-sol', store: false, input, stream: 1 }, 'a Responses request\'s `stream` is a number, and the stand-in reads it as a boolean'],
  ];
  const statuses = [];
  for (const [path, body] of sent) statuses.push((await send(s, path, body)).status);
  const records = await s.close();
  assert.deepEqual(statuses, sent.map(() => 400));
  assert.deepEqual(records.map((r) => r.reason), sent.map(([, , reason]) => reason));
});

test('a Bedrock anthropic_beta that isn\'t a list is turned away, not recorded as no betas', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('a'));
  const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, messages: [{ role: 'user', content: 'user: [[c:a.in]] hi' }], anthropic_beta: 'x' };
  const res = await send(s, `/model/${BEDROCK}/invoke`, body);
  const [r] = await s.close();
  assert.equal(res.status, 400);
  assert.equal(r.reason, 'a Bedrock request\'s `anthropic_beta` is a string, and the stand-in reads it as a list');
  assert.deepEqual(copied(r), []);
});

test('decoded judges a kept body by its own API\'s table: a numeric service_tier is the Responses gate\'s to turn away and the Codex route\'s to refuse', () => {
  const body = { model: 'gpt-6.1-sol', store: false, stream: true, input, service_tier: 5 };
  assert.equal(decoded('responses', body).reason, 'a Responses request\'s `service_tier` is a number, and the stand-in reads it as a string');
  assert.ok(decoded('codex', body).view, 'the Codex route reads it');
});

test('a kept body whose record names no API gives the record\'s own reason for its transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-no-api-'));
  try {
    writeFileSync(join(dir, 'r1.json'), JSON.stringify({ ...agentBody({ canary: '[[c:k.in]]' }), tools: 'x' }));
    const reason = 'a Messages request\'s `tools` is a string, and the stand-in reads it as a list of objects';
    assert.equal(keptBody(dir, 'r1', null, reason).reason, reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
