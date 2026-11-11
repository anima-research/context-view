// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens } from './anthropic.ts';
import { decoded, keptBody, tokensSent } from './standin.ts';
import { blockRecord, repairMarks } from './view.ts';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane } from '@animalabs/membrane';
import { TOOLS, agentBody, arrivals, post, prose, read, startStandin, step, summariserBody, textOf, withStandin } from '../testing/standin.ts';

test('a request\'s kept body is read by its API; a refused tunnel, which keeps none, gives its record\'s reason, and a kept body that isn\'t JSON, or that its API can\'t read, says so', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'kept-body-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    s.setStep(step('t'));
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: new URL(s.url).port, method: 'CONNECT', path: 'openrouter.ai:443' });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(); });
      req.on('error', reject);
      req.end();
    });
    assert.equal((await post(s.url, agentBody({ canary: '[[c:t.in]]' }))).status, 200);
    const [tunnel, sent] = await s.close();
    assert.deepEqual(readdirSync(rawDir).filter((f) => !f.includes('answer')).sort(), [`${sent.id}.json`], 'the tunnel keeps no body');
    assert.equal(keptBody(rawDir, tunnel.id, tunnel.head?.api ?? null, tunnel.reason).reason, `the stand-in kept no body for it: ${tunnel.reason}`);
    assert.ok(keptBody(rawDir, sent.id, sent.head.api).view.messages.length > 0);
    writeFileSync(join(rawDir, 'r9.json'), '');
    assert.match(keptBody(rawDir, 'r9', 'messages').reason, /^its kept body isn't JSON: /);
    writeFileSync(join(rawDir, 'r10.json'), JSON.stringify({ messages: [null] }));
    assert.match(keptBody(rawDir, 'r10', 'messages').reason, /^its body couldn't be read as the messages API: the stand-in couldn't read it: TypeError: /);
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
});

test('T45: a request whose text names its run\'s own directory is recorded the same from any run\'s directory', async () => {
  const recordFrom = async (runDir) => {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir });
    s.setStep(step('p', [{ text: '[[c:p.r1]] seen' }]));
    await post(s.url, agentBody({ canary: '[[c:p.in]]', tail: [{ type: 'text', text: `{"configPath":"${runDir}/store/sessions/0a1b2c3d/config/gate.json"}` }] }));
    const [record] = await s.close();
    return record.messages.map((m) => m.digest);
  };
  assert.deepEqual(await recordFrom('/tmp/a/runs/H5_W12'), await recordFrom('/runner/b/runs/H5_W12'));
});

test('T47: with its run\'s lessons file of a shape the mask can\'t read, a request is refused as unclassified, naming the file', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 't47-'));
  try {
    mkdirSync(join(runDir, 'store'));
    writeFileSync(join(runDir, 'store', 'lessons.json'), '[]');
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, runDir });
    s.setStep(step('p', [{ text: '[[c:p.r1]] seen' }]));
    const answer = await post(s.url, agentBody({ canary: '[[c:p.in]]' }));
    assert.equal(answer.status, 400);
    const [record] = await s.close();
    assert.equal(record.kind, 'unclassified');
    assert.match(record.reason, /lessons\.json isn't the shape the run-varying masker reads/);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test('T25: each request\'s record carries its head, the body\'s fields but its messages, and its anthropic-beta and anthropic-version headers: the API it is, the fields it names by value, and the rest as its text, masked as other texts are', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }, { text: 'g' }, { text: 'h' }, { text: 'i' }, { text: 'j' }, { text: 'k' }, { text: 'l' }, { text: 'm' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    const variants = [
      base,
      base,
      { ...base, tools: base.tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} (changed)` } : t)) },
      { ...base, system: [{ type: 'text', text: base.system, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { ...base, thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } },
      { ...base, metadata: { user_id: 'u' } },
    ];
    for (const v of variants) assert.equal((await post(s.url, v)).status, 200);
    assert.equal((await post(s.url, { ...base, metadata: { user_id: 'v' } })).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages', { 'anthropic-beta': 'b2-2026, b1-2026,b2-2026' })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: true } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: false } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system, citations: { enabled: true } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, metadata: { user_id: 'fork-x-0a1b2c3d-0000-4000-8000-000000000001' } })).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [same, again, tool, system, thinking, more, otherUser, beta, cited, uncited, typeless, typelessCited, forked] = records;
  assert.deepEqual(same.head, again.head, 'the same body, the same head');
  assert.equal(same.head.api, 'messages');
  assert.deepEqual(same.head.tools.map((t) => t.name), ['time--now']);
  assert.notEqual(tool.head.tools[0].sha, same.head.tools[0].sha, 'a tool\'s description moves its definition\'s digest');
  assert.deepEqual(system.head.system, [{ text: same.head.system[0].text, cache: '1h' }], 'a system block keeps its text and its marker');
  assert.deepEqual(thinking.head.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.equal(same.head.rest, null, 'nothing else on the body');
  assert.equal(more.head.rest, '{"metadata":{"user_id":"u"}}', 'a field no part names is kept as text');
  assert.equal(forked.head.rest, '{"metadata":{"user_id":"fork-x-UUID1"}}', 'with a fork\'s UUID masked');
  assert.notEqual(otherUser.head.rest, more.head.rest, 'by its value');
  assert.deepEqual(same.head.headers, { beta: [], version: '2023-06-01' }, 'the headers that change what a provider does');
  assert.deepEqual(beta.head.headers, { beta: ['b1-2026', 'b2-2026'], version: '2023-06-01' }, 'betas as a set');
  assert.match(cited.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a system block\'s other fields are digested');
  assert.equal('other' in same.head.system[0], false);
  assert.notEqual(uncited.head.system[0].other, cited.head.system[0].other, 'by its value');
  assert.match(typeless.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a block that lost its type differs from one that has it');
  assert.notEqual(typelessCited.head.system[0].other, cited.head.system[0].other, 'and so does one that lost it beside another field');
});

test('T1: a POST to count_tokens, or to another path not ending in /v1/messages, is recorded as unclassified, naming its method and route, and refused', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('ct'));
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:ct.in]] count me' }] }] };
  const counted = await post(s.url, body, '/v1/messages/count_tokens');
  const elsewhere = await post(s.url, body, '/v1/models');
  assert.deepEqual([counted.status, elsewhere.status], [404, 404]);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.reason]), [
    ['unclassified', 'it goes to POST /v1/messages/count_tokens, which no run sends and the stand-in doesn\'t model'],
    ['unclassified', 'it goes to POST /v1/models, which no run sends and the stand-in doesn\'t model'],
  ]);
});

test('a Messages body the codec can\'t read is refused as unclassified, naming why, never thrown on, and a transcript still reads the system and tools of one with no messages', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('bad'));
  const ok = agentBody({ canary: '[[c:bad.in]]', stream: false });
  for (const body of [{ ...ok, messages: {} }, { ...ok, system: {}, tool_choice: { type: 'auto' } }, { ...ok, messages: [] }]) {
    assert.equal((await post(s.url, body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.reason]), [
    ['unclassified', 'no messages'],
    ['unclassified', 'it carries `tool_choice`, which the stand-in\'s prompt cache doesn\'t model'],
    ['unclassified', 'no messages'],
  ]);
  const { view } = decoded('messages', { ...ok, messages: [] });
  assert.deepEqual([view.system, view.tools.map((t) => t.name), view.messages], ['You are the fixture agent.', ['time--now'], []]);
});

test('a body a codec throws on, reading, recording or answering it, is refused as unclassified with the exception as its reason, and the stand-in goes on serving', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('t', [{ text: '[[c:t.r1]] fine' }]));
  const ok = agentBody({ canary: '[[c:t.in]]', stream: false });
  const raw = (path, body) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sent = [
    ['/v1/messages', { ...ok, messages: [null] }],
    ['/elsewhere', { messages: [null] }],
    ['/v1/messages', { ...ok, tools: {} }],
    ['/v1/messages', { ...ok, messages: [{ role: 'user', content: [{ type: 'text', text: 123 }] }] }],
    ['/v1/responses', { model: 'gpt-6.1-sol', store: false, input: [{ type: 'reasoning', summary: {} }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:t.in]] go' }] }] }],
  ];
  const statuses = [];
  for (const [path, body] of sent) statuses.push((await raw(path, body)).status);
  assert.deepEqual(statuses, [400, 404, 400, 400, 400]);
  assert.equal((await post(s.url, ok)).status, 200, 'and serves the next request');
  const records = await s.close();
  assert.deepEqual(records.slice(0, 5).map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
  for (const i of [0, 3, 4]) assert.match(records[i].reason, /^the stand-in couldn't (read|answer) it: TypeError: /, records[i].reason);
  assert.equal(records[1].reason, 'it goes to POST /elsewhere, which no run sends and the stand-in doesn\'t model', 'a read that gave its reason keeps it, though the writer threw on the body');
  assert.equal(records[2].reason, 'its tools are not a list of tools');
  assert.match(decoded('messages', { messages: [null] }).reason, /^the stand-in couldn't read it: TypeError: /);
});

test('a throw while answering a claimed request, refusing it or sending a held reply after its release, records it as unclassified, tells onRequest so the driver fails the run, and the stand-in goes on serving', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen } = arrivals(s);
  try {
    s.setStep(step('t', [{ text: '[[c:t.r2]] two', settle: true, calls: [{ name: 'look', input: { n: 1n } }] }, { text: '[[c:t.r3]] three' }]));
    const badSystem = agentBody({ canary: '[[c:t.in]]', stream: false, extra: { system: [{ type: 'text', text: ['bad'] }] } });
    assert.equal((await post(s.url, badSystem)).status, 400, 'refusing it throws');
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    const held = post(s.url, agentBody({ canary: '[[c:t.in]]', stream: false }));
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    s.releaseHeld(heldSeen[0].id);
    assert.equal((await held).status, 400, 'its held reply throws once released');
    assert.equal(textOf((await post(s.url, agentBody({ canary: '[[c:t.in]]', stream: false }))).json), '[[c:t.r3]] three', 'and the next request is served');
  } finally {
    const records = await s.close();
    assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent']);
    for (const r of records.slice(0, 2)) assert.match(r.reason, /^the stand-in couldn't answer it: TypeError: /, r.reason);
    for (const r of records.slice(0, 2)) assert.deepEqual(seen.filter((t) => t.id === r.id).map((t) => t.kind), ['agent', 'unclassified'], 'each is told to onRequest as claimed on arrival, then as unclassified');
    for (const r of seen.filter((t) => t.kind === 'unclassified')) assert.match(r.reason, /^the stand-in couldn't answer it: TypeError: /);
  }
});

test('an unclassified request whose refusal check throws keeps the reason the stand-in couldn\'t classify it by, and its head, and gets the stand-in\'s 400', () => withStandin({ windowTokens: 50_000 }, async (s) => {
  const { seen, until } = arrivals(s);
  s.setStep(step('k'));
  const badSystem = agentBody({ canary: '[[c:other.in]]', stream: false, extra: { system: [{ type: 'text', text: ['bad'] }] } });
  const r = await post(s.url, badSystem);
  assert.equal(r.status, 400);
  await until(1);
  assert.match(seen[0].reason, /^its last message carries none of step k's canaries/);
  const [record] = await s.close();
  assert.deepEqual([record.kind, record.head?.model], ['unclassified', 'claude-opus-4-6']);
}));

test('a Messages body whose system or tools are of the wrong kind is refused as unclassified, naming them, not read as having none', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('w', [{ text: '[[c:w.r1]] a' }, { text: '[[c:w.r1]] b' }, { text: '[[c:w.r1]] c' }]));
  const ok = agentBody({ canary: '[[c:w.in]]', stream: false });
  for (const body of [{ ...ok, system: {} }, { ...ok, system: [null] }, { ...ok, tools: [null] }]) assert.equal((await post(s.url, body)).status, 400, JSON.stringify(body.system ?? body.tools));
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.reason), [
    'its system is neither a string nor a list of blocks',
    'its system is neither a string nor a list of blocks',
    'its tools are not a list of tools',
  ]);
});

test('T25b: a request to another path ending in /v1/messages, one with an empty query, and a system block whose cache_control is null each record a head of their own', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep({ ...step('u', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:u.in]]'] });
  const base = agentBody({ canary: '[[c:u.in]]', stream: false });
  for (const [body, path] of [[base, '/v1/messages'], [base, '/proxy/v1/messages'], [base, '/v1/messages?'], [{ ...base, system: [{ type: 'text', text: base.system }] }, '/v1/messages'], [{ ...base, system: [{ type: 'text', text: base.system, cache_control: null }] }, '/v1/messages']]) {
    assert.equal((await post(s.url, body, path)).status, 200, path);
  }
  const [plain, prefixed, emptyQuery, absent, nulled] = await s.close();
  assert.equal('path' in plain.head || 'query' in plain.head, false, 'the path every host sends, with no query, adds nothing');
  assert.equal(prefixed.head.path, '/proxy/v1/messages');
  assert.equal(emptyQuery.head.query, '');
  assert.deepEqual([absent.head.system[0].cache, nulled.head.system[0].cache], [null, 'null']);
  assert.notDeepEqual(absent.head, nulled.head);
});

test('T28: with a raw directory, each answer\'s content goes beside its request as r<n>.answer.json, a refused request leaves none, and tokensSent sums what the answers billed', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'standin-raw-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    s.setStep(step('w', [{ text: '[[c:w.r1]] noted', thinking: 'a thought' }, { text: '[[c:w.r2]] again' }]));
    const summBody = summariserBody({ model: 'claude-opus-5-5', canaries: ['[[c:w.in]]'] });
    const marked = agentBody({ model: 'claude-opus-5-5', canary: '[[c:w.in]]', history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(2000, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    marked.messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
    assert.ok(countTokens(marked) >= 512, 'premise: the marked prefix is over the model\'s minimum');
    const refusedBody = agentBody({ model: 'claude-opus-5-5', canary: '[[c:other.in]]' });
    const summ = await post(s.url, summBody);
    const agent = await post(s.url, marked);
    const again = await post(s.url, marked);
    const refused = await post(s.url, refusedBody);
    const records = await s.close();
    assert.equal(refused.status, 400);
    assert.deepEqual(readdirSync(rawDir).sort(), ['r1.answer.json', 'r1.json', 'r2.answer.json', 'r2.json', 'r3.answer.json', 'r3.json', 'r4.json']);
    const saved = (name) => JSON.parse(readFileSync(join(rawDir, name), 'utf-8'));
    assert.deepEqual([saved('r1.json'), saved('r2.json'), saved('r3.json'), saved('r4.json')], [summBody, marked, marked, refusedBody], 'each body as it was sent');
    assert.deepEqual(saved('r1.answer.json'), summ.json.content);
    assert.deepEqual(saved('r2.answer.json'), agent.json.content);
    assert.deepEqual(saved('r3.answer.json'), again.json.content);
    const billed = [summ.json.usage, agent.json.usage, again.json.usage];
    const sum = (k) => billed.reduce((t, u) => t + u[k], 0);
    assert.ok(sum('cache_creation_input_tokens') > 0 && sum('cache_read_input_tokens') > 0, 'the marked prefix was written, then read');
    assert.deepEqual(tokensSent(records), { input: sum('input_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), output: sum('output_tokens') });
  } finally { rmSync(rawDir, { recursive: true, force: true }); }
});

test('T29: every non-null cache marker moves the record: on the system, a message block or inside a tool result it shows as sent, a plain one as its TTL and any other shape whole, a request the API refuses for its marker included; on a tool or the body it is held in that one\'s digest', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('k', Array.from({ length: 16 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:k.in]]'] });
    const odd = { type: 'ephemeral', ttl: '1h', scope: 'x' };
    const base = { ...agentBody({ canary: '[[c:k.in]]', stream: false }), system: [{ type: 'text', text: 'You are the fixture agent.' }] };
    const text = (cc) => ({ type: 'text', text: 'user: [[c:k.in]] hello', ...(cc !== null ? { cache_control: cc } : {}) });
    const nested = (cc) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[[c:k.in]] one' }, { type: 'text', text: 'two', ...(cc !== null ? { cache_control: cc } : {}) }] });
    const bodies = [
      { ...base, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral' })] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '1h' })] }] },
      { ...base, messages: [{ role: 'user', content: [text(odd)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'persistent' })] }] },
      { ...base, messages: [{ role: 'user', content: [nested(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(odd)] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: odd }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, tools: [{ ...TOOLS[0], cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text(false)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '' })] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: false }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(false)] }] },
    ];
    // The Messages API refuses every marker but an ephemeral one with a ttl of 5m or 1h, or none; the request is
    // recorded as sent either way.
    const statuses = [200, 200, 200, 400, 400, 200, 400, 400, 200, 200, 400, 400, 400, 400];
    for (const [i, body] of bodies.entries()) assert.equal((await post(s.url, body)).status, statuses[i], `body ${i}`);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [none, plain, hour, oddBlock, persistent, nestedNone, nestedOdd, system, tool, top, falsy, emptyTtl, systemFalse, nestedFalse] = records;
  const shown = '{"scope":"x","ttl":"1h","type":"ephemeral"}';
  assert.deepEqual([none, plain, hour, oddBlock, persistent].map((r) => r.messages[0].blocks[0].cache ?? null), [null, '5m', '1h', shown, '{"type":"persistent"}']);
  assert.equal('contentCache' in nestedNone.messages[0].blocks[0], false);
  assert.deepEqual(nestedOdd.messages[0].blocks[0].contentCache, [null, shown]);
  assert.deepEqual(system.head.system, [{ text: 'You are the fixture agent.', cache: shown }]);
  assert.notEqual(tool.head.tools[0].sha, none.head.tools[0].sha, 'a tool\'s marker is in its definition\'s digest');
  assert.notEqual(top.head.rest, none.head.rest, 'the body\'s marker is in its rest');
  assert.deepEqual([falsy, emptyTtl].map((r) => r.messages[0].blocks[0].cache), ['false', '{"ttl":"","type":"ephemeral"}'], 'a falsy marker and an empty ttl are shown as sent, not as none or 5m');
  assert.equal(systemFalse.head.system[0].cache, 'false', 'on a system block');
  assert.deepEqual(nestedFalse.messages[0].blocks[0].contentCache, [null, 'false'], 'inside a tool result');
});

test('T29: a cache marker the Messages API refuses is refused with its 400 and its words, wherever it sits: on a tool, the system, a message block or inside a tool result; none, null, and an ephemeral one with a ttl of 5m or 1h are answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    s.setStep({ ...step('m', Array.from({ length: 30 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:m.in]]'] });
    const base = { ...agentBody({ canary: '[[c:m.in]]', stream: false }), system: [{ type: 'text', text: 'You are the fixture agent.' }] };
    const text = (cc) => ({ type: 'text', text: 'user: [[c:m.in]] hello', ...(cc !== undefined ? { cache_control: cc } : {}) });
    const at = {
      tool: (cc) => ({ ...base, tools: [{ ...TOOLS[0], cache_control: cc }], messages: [{ role: 'user', content: [text()] }] }),
      system: (cc) => ({ ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: cc }], messages: [{ role: 'user', content: [text()] }] }),
      text: (cc) => ({ ...base, messages: [{ role: 'user', content: [text(cc)] }] }),
      toolUse: (cc) => ({ ...base, messages: [{ role: 'user', content: [text()] }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: TOOLS[0].name, input: {}, cache_control: cc }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, text()] }] }),
      toolResult: (cc) => ({ ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'one' }], cache_control: cc }, text()] }] }),
      inside: (cc) => ({ ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two', cache_control: cc }] }, text()] }] }),
    };
    const path = { tool: 'tools.0.custom', system: 'system.0', text: 'messages.0.content.0.text', toolUse: 'messages.1.content.0.tool_use', toolResult: 'messages.0.content.0.tool_result', inside: 'messages.0.content.0.tool_result.content.1.text' };
    // A live probe's words (claude-haiku-5-5, Nov 11, 2026: each shape on a tool, a system block, a text, tool_use and
    // tool_result block, and inside a tool result).
    const refused = [
      [false, (p) => `${p}.cache_control: Input should be an object`],
      ['ephemeral', (p) => `${p}.cache_control: Input should be an object`],
      [[], (p) => `${p}.cache_control: Input should be an object`],
      [{}, (p) => `${p}.cache_control.type: Field required`],
      [{ ttl: '1h' }, (p) => `${p}.cache_control.type: Field required`],
      [{ type: 'persistent' }, (p) => `${p}.cache_control: Input tag 'persistent' found using 'type' does not match any of the expected tags: 'ephemeral'`],
      [{ type: null }, (p) => `${p}.cache_control: Input tag 'null' found using 'type' does not match any of the expected tags: 'ephemeral'`],
      [{ type: 'ephemeral', ttl: '' }, (p) => `${p}.cache_control.ephemeral.ttl: Input should be '5m' or '1h'`],
      [{ type: 'ephemeral', ttl: null }, (p) => `${p}.cache_control.ephemeral.ttl: Input should be '5m' or '1h'`],
      [{ type: 'ephemeral', ttl: '1h', scope: 'x' }, (p) => `${p}.cache_control.ephemeral.scope: Extra inputs are not permitted`],
    ];
    for (const [where, build] of Object.entries(at)) {
      for (const [cc, words] of refused) {
        const r = await post(s.url, build(cc));
        assert.deepEqual([r.status, r.json?.error?.type, r.json?.error?.message], [400, 'invalid_request_error', words(path[where])], `${where} ${JSON.stringify(cc)}`);
      }
      for (const cc of [undefined, null, { type: 'ephemeral' }, { type: 'ephemeral', ttl: '5m' }, { type: 'ephemeral', ttl: '1h' }]) {
        const r = await post(s.url, build(cc));
        assert.deepEqual([r.status, r.json?.error ?? null], [200, null], `${where} ${JSON.stringify(cc)}`);
      }
    }
  } finally { await s.close(); }
});

test('T29: when a request has two faults, the stand-in names the one the Messages API names: a marker on a tool, then a message block, then the system, then max_tokens; in a message, the first block, a tool result\'s content before the next block', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    s.setStep({ ...step('m', Array.from({ length: 16 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:m.in]]'] });
    const { max_tokens, ...base } = agentBody({ canary: '[[c:m.in]]', stream: false });
    const text = (cc) => ({ type: 'text', text: 'user: [[c:m.in]] hello', ...(cc !== undefined ? { cache_control: cc } : {}) });
    const body = ({ tokens = max_tokens, noTokens = false, tool, system, first, second, inner } = {}) => ({
      ...base,
      ...(noTokens ? {} : { max_tokens: tokens }),
      tools: [{ ...TOOLS[0], ...(tool === undefined ? {} : { cache_control: tool }) }],
      system: [{ type: 'text', text: 'You are the fixture agent.', ...(system === undefined ? {} : { cache_control: system }) }],
      messages: [{ role: 'user', content: [
        ...(inner === undefined ? [] : [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'one', cache_control: inner }] }]),
        text(first), text(second),
      ] }],
    });
    const object = (p) => `${p}.cache_control: Input should be an object`;
    // A live probe's answers (claude-haiku-5-5, Nov 11, 2026: each request with two faults).
    const cases = [
      ['no max_tokens, a message marker', body({ noTokens: true, first: false }), object('messages.0.content.0.text')],
      ['a string max_tokens, a message marker', body({ tokens: 'x', first: false }), object('messages.0.content.0.text')],
      ['no max_tokens, a system marker', body({ noTokens: true, system: false }), object('system.0')],
      ['no max_tokens, a tool marker', body({ noTokens: true, tool: false }), object('tools.0.custom')],
      ['a tool and a message marker', body({ tool: false, first: false }), object('tools.0.custom')],
      ['a tool and a system marker', body({ tool: false, system: false }), object('tools.0.custom')],
      ['a message and a system marker', body({ system: false, first: false }), object('messages.0.content.0.text')],
      ['two blocks of one message', body({ first: false, second: false }), object('messages.0.content.0.text')],
      ['inside a tool result, and a later block', body({ inner: false, first: false }), object('messages.0.content.0.tool_result.content.0.text')],
      ['no max_tokens alone', body({ noTokens: true }), 'max_tokens: Field required'],
    ];
    for (const [name, b, words] of cases) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error?.type, r.json?.error?.message], [400, 'invalid_request_error', words], name);
    }
  } finally { await s.close(); }
});

test('T29: a marker on a block of a tool result\'s content before its last is refused with the API\'s words, after the shapes of that tool result\'s blocks and before anything later; one on the last block, or a null one, is answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    s.setStep({ ...step('m', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:m.in]]'] });
    const { max_tokens, ...base } = agentBody({ canary: '[[c:m.in]]', stream: false });
    const M = { type: 'ephemeral' };
    const text = (t, cc) => ({ type: 'text', text: t, ...(cc !== undefined ? { cache_control: cc } : {}) });
    const result = (id, ...inner) => ({ type: 'tool_result', tool_use_id: id, content: inner });
    const canary = text('user: [[c:m.in]] hello');
    const body = (blocks, more = {}) => ({ ...base, max_tokens, messages: [{ role: 'user', content: [...blocks, canary] }], ...more });
    const placed = (at) => `${at}.cache_control: cache_control may not be specified within \`tool_result.content\`. Instead, place it directly on \`tool_result\``;
    const first = 'messages.0.content.0.tool_result.content.0';
    // The probe's answers (a live probe of claude-haiku-5-5, Nov 11, 2026: each request's tool result content as here).
    const refused = [
      ['an earlier block marked', body([result('t1', text('x', M), text('b'))]), placed(first)],
      ['the earlier and the last block marked', body([result('t1', text('x', M), text('b', M))]), placed(first)],
      ['an earlier block marked, of three', body([result('t1', text('x', M), text('b'), text('c'))]), placed(first)],
      ['an earlier block with a refused shape', body([result('t1', text('x', { type: 'persistent' }), text('b'))]), `${first}.text.cache_control: Input tag 'persistent' found using 'type' does not match any of the expected tags: 'ephemeral'`],
      ['an earlier block marked, the last with a refused shape', body([result('t1', text('x', M), text('b', false))]), 'messages.0.content.0.tool_result.content.1.text.cache_control: Input should be an object'],
      ['an earlier block marked, and no max_tokens', (({ max_tokens: _m, ...rest }) => rest)(body([result('t1', text('x', M), text('b'))])), placed(first)],
      ['an earlier block marked, and a tool marked false', body([result('t1', text('x', M), text('b'))], { tools: [{ ...TOOLS[0], cache_control: false }] }), 'tools.0.custom.cache_control: Input should be an object'],
      ['an earlier block marked, and a later block marked false', body([result('t1', text('x', M), text('b')), text('later', false)]), placed(first)],
      ['an earlier block marked, and a system block marked false', body([result('t1', text('x', M), text('b'))], { system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: false }] }), placed(first)],
      ['two tool results, each with an earlier block marked', body([result('t1', text('x', M), text('b')), result('t2', text('x', M), text('b'))]), placed(first)],
      ['the middle block of three marked', body([result('t1', text('b'), text('x', M), text('c'))]), placed('messages.0.content.0.tool_result.content.1')],
      ['the first two blocks of three marked', body([result('t1', text('x', M), text('y', M), text('c'))]), placed(first)],
      ['the middle and the last block of three marked', body([result('t1', text('b'), text('x', M), text('y', M))]), placed('messages.0.content.0.tool_result.content.1')],
      ['the first block marked null, the middle marked', body([result('t1', text('x', null), text('y', M), text('c'))]), placed('messages.0.content.0.tool_result.content.1')],
    ];
    for (const [name, b, words] of refused) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error?.type, r.json?.error?.message], [400, 'invalid_request_error', words], name);
    }
    const answered = [
      ['an earlier block marked null', body([result('t1', text('x', null), text('b'))])],
      ['the last block marked', body([result('t1', text('b'), text('x', M))])],
      ['a tool result of one marked block, and another after it', body([result('t1', text('x', M)), result('t2', text('b'))])],
    ];
    for (const [name, b] of answered) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error ?? null], [200, null], name);
    }
  } finally { await s.close(); }
});

test('T29: a content block that isn\'t an object, or has no type, and a message\'s or a tool result\'s content of a kind the Messages API refuses, are refused with its words, block by block in its order; a tool result\'s content of null or a string is answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    s.setStep({ ...step('m', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:m.in]]'] });
    const { max_tokens, ...base } = agentBody({ canary: '[[c:m.in]]', stream: false });
    const M = { type: 'ephemeral' };
    const text = (t, cc) => ({ type: 'text', text: t, ...(cc !== undefined ? { cache_control: cc } : {}) });
    const result = (content, more = {}) => ({ type: 'tool_result', tool_use_id: 't1', content, ...more });
    const canary = text('user: [[c:m.in]] hello');
    const body = (blocks, more = {}) => ({ ...base, max_tokens, messages: [{ role: 'user', content: [...blocks, canary] }], ...more });
    const content = (c) => ({ ...base, max_tokens, messages: [{ role: 'user', content: c }] });
    const object = (at) => `${at}: Input should be an object`;
    const typed = (at) => `${at}.type: Field required`;
    const found = (kind) => `messages.0.content.0.tool_result.content: Found ${kind}, but \`tool_result\` content must either be a string or a list of content blocks.`;
    const inner = 'messages.0.content.0.tool_result.content';
    // The probe's answers (a live probe of claude-haiku-5-5, Nov 11, 2026, with the blocks and content as here).
    const refused = [
      ['a null block', body([text('Reply OK.'), null]), object('messages.0.content.1')],
      ['a string block', body([text('Reply OK.'), 'x']), object('messages.0.content.1')],
      ['a number block', body([text('Reply OK.'), 5]), object('messages.0.content.1')],
      ['a list block', body([text('Reply OK.'), []]), object('messages.0.content.1')],
      ['a boolean block', body([text('Reply OK.'), true]), object('messages.0.content.1')],
      ['a block of an integer past 2^53, which the stand-in reads as raw JSON', body([text('Reply OK.'), 12345678901234567000]), object('messages.0.content.1')],
      ['a block with no type', body([text('Reply OK.'), {}]), typed('messages.0.content.1')],
      ['a block with a refused marker and no type', body([text('Reply OK.'), { cache_control: false }]), typed('messages.0.content.1')],
      ['a message\'s content a number', content(5), 'messages.0.content: Input should be a valid array'],
      ['a message\'s content null', content(null), 'messages.0.content: Input should be a valid array'],
      ['a message\'s content an object', content({}), 'messages.0.content: Input should be a valid array'],
      ['a message\'s content a boolean', content(true), 'messages.0.content: Input should be a valid array'],
      ['a tool result\'s null block', body([result([null])]), object(`${inner}.0`)],
      ['a tool result\'s string block', body([result(['x'])]), object(`${inner}.0`)],
      ['a tool result\'s number block', body([result([5])]), object(`${inner}.0`)],
      ['a tool result\'s list block', body([result([[]])]), object(`${inner}.0`)],
      ['a tool result\'s boolean block', body([result([true])]), object(`${inner}.0`)],
      ['a tool result\'s null block after a text', body([result([text('found'), null])]), object(`${inner}.1`)],
      ['a tool result\'s block with no type', body([result([{}])]), typed(`${inner}.0`)],
      ['a tool result\'s block with no type, then a marked text', body([result([{}, text('found', M)])]), typed(`${inner}.0`)],
      ['a tool result\'s content a number', body([result(5)]), found('a number')],
      ['a tool result\'s content a boolean', body([result(true)]), found('a boolean')],
      ['a tool result\'s content an object', body([result({})]), found('an object')],
      ['a tool result\'s content an integer past 2^53', body([result(12345678901234567000)]), found('a number')],
      ['a null block, then a text marked false', body([null, text('Reply OK.', false)]), object('messages.0.content.0')],
      ['a text marked false, then a null block', body([text('Reply OK.', false), null]), 'messages.0.content.0.text.cache_control: Input should be an object'],
      ['a null block, and no max_tokens', (({ max_tokens: _m, ...rest }) => rest)(body([text('Reply OK.'), null])), object('messages.0.content.1')],
      ['a null block, and a tool marked false', body([text('Reply OK.'), null], { tools: [{ ...TOOLS[0], cache_control: false }] }), 'tools.0.custom.cache_control: Input should be an object'],
      ['a null block, and a system block marked false', body([text('Reply OK.'), null], { system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: false }] }), object('messages.0.content.1')],
      ['a tool result marked false, with a null block', body([result([null], { cache_control: false })]), 'messages.0.content.0.tool_result.cache_control: Input should be an object'],
      ['a tool result marked false, with content a number', body([result(5, { cache_control: false })]), 'messages.0.content.0.tool_result.cache_control: Input should be an object'],
      ['a tool result\'s marked text, then a null block', body([result([text('found', M), null])]), object(`${inner}.1`)],
    ];
    for (const [name, b, words] of refused) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error?.type, r.json?.error?.message], [400, 'invalid_request_error', words], name);
    }
    const answered = [
      ['a tool result\'s content null', body([result(null)])],
      ['a tool result\'s content a string', body([result('x')])],
    ];
    for (const [name, b] of answered) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error ?? null], [200, null], name);
    }
  } finally { await s.close(); }
});

test('T29: a block\'s field the Messages API requires, absent or holding another kind, and a user message with empty content are refused with its words, a field after the block\'s marker in the order the API judges them and an empty message after every other fault; an assistant message with empty content is answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    s.setStep({ ...step('m', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:m.in]]'] });
    const { max_tokens, ...base } = agentBody({ canary: '[[c:m.in]]', stream: false });
    const text = (t, more = {}) => ({ type: 'text', text: t, ...more });
    const canary = text('user: [[c:m.in]] hello');
    const of = (messages, more = {}) => ({ ...base, max_tokens, messages, ...more });
    const user = (content) => ({ role: 'user', content });
    const said = (...blocks) => of([user([text('hi')]), { role: 'assistant', content: blocks }, user([canary])]);
    const called = (use, result) => of([user([text('hi')]), { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'time--now', input: {}, ...use }] }, user([{ type: 'tool_result', tool_use_id: 't1', content: 'found', ...result }, canary])]);
    const string = (at) => `${at}: Input should be a valid string`;
    const empty = (i) => `messages.${i}: user messages must have non-empty content`;
    // The probe's answers (a live probe of claude-haiku-5-5, Nov 11, 2026: each field 5, then null, as here).
    const refused = [];
    for (const v of [5, null]) {
      refused.push(
        [`a text ${v}`, of([user([text(v), canary])]), string('messages.0.content.0.text.text')],
        [`a thinking ${v}`, said({ type: 'thinking', thinking: v, signature: 'sig' }, text('ok')), string('messages.1.content.0.thinking.thinking')],
        [`a signature ${v}`, said({ type: 'thinking', thinking: 't', signature: v }, text('ok')), string('messages.1.content.0.thinking.signature.str')],
        [`a redacted thinking's data ${v}`, said({ type: 'redacted_thinking', data: v }, text('ok')), string('messages.1.content.0.redacted_thinking.data')],
        [`a tool use's id ${v}`, called({ id: v }, {}), string('messages.1.content.0.tool_use.id')],
        [`a tool use's name ${v}`, called({ name: v }, {}), string('messages.1.content.0.tool_use.name')],
        [`a tool result's tool_use_id ${v}`, called({}, { tool_use_id: v }), string('messages.2.content.0.tool_result.tool_use_id')],
        [`a text ${v} in a tool result`, called({}, { content: [text(v)] }), string('messages.2.content.0.tool_result.content.0.text.text')],
      );
    }
    refused.push(
      ['a text with no text', of([user([{ type: 'text' }, canary])]), 'messages.0.content.0.text.text: Field required'],
      ['a thinking with no thinking', said({ type: 'thinking', signature: 'sig' }, text('ok')), 'messages.1.content.0.thinking.thinking: Field required'],
      ['a thinking with no signature', said({ type: 'thinking', thinking: 't' }, text('ok')), 'messages.1.content.0.thinking.signature: Field required'],
      ['a redacted thinking with no data', said({ type: 'redacted_thinking' }, text('ok')), 'messages.1.content.0.redacted_thinking.data: Field required'],
      ['a tool use with no id', called({ id: undefined }, {}), 'messages.1.content.0.tool_use.id: Field required'],
      ['a tool use with no name', called({ name: undefined }, {}), 'messages.1.content.0.tool_use.name: Field required'],
      ['a tool use with no input', called({ input: undefined }, {}), 'messages.1.content.0.tool_use.input: Field required'],
      ['a tool result with no tool_use_id', called({}, { tool_use_id: undefined }), 'messages.2.content.0.tool_result.tool_use_id: Field required'],
      ['a tool use\'s input 5', called({ input: 5 }, {}), 'messages.1.content.0.tool_use.input: Input should be an object'],
      ['a tool use\'s input null', called({ input: null }, {}), 'messages.1.content.0.tool_use.input: Input should be an object'],
      ['a tool use\'s input []', called({ input: [] }, {}), 'messages.1.content.0.tool_use.input: Input should be an object'],
      ['a tool use\'s input "x"', called({ input: 'x' }, {}), 'messages.1.content.0.tool_use.input: Input should be an object'],
      ['a tool use with no id and a name 5', called({ id: undefined, name: 5 }, {}), 'messages.1.content.0.tool_use.id: Field required'],
      ['a tool use\'s name 5 and input 5', called({ name: 5, input: 5 }, {}), string('messages.1.content.0.tool_use.name')],
      ['a thinking with no thinking and a signature 5', said({ type: 'thinking', signature: 5 }, text('ok')), 'messages.1.content.0.thinking.thinking: Field required'],
      ['a text with no text, marked false', of([user([{ type: 'text', cache_control: false }, canary])]), 'messages.0.content.0.text.cache_control: Input should be an object'],
      ['a user message\'s content ""', of([user('')]), empty(0)],
      ['a user message\'s content []', of([user([])]), empty(0)],
      ['a text 5 marked false', of([user([text(5, { cache_control: false }), canary])]), 'messages.0.content.0.text.cache_control: Input should be an object'],
      ['a tool result\'s tool_use_id 5 and a null block', called({}, { tool_use_id: 5, content: [null] }), string('messages.2.content.0.tool_result.tool_use_id')],
      ['a tool result\'s tool_use_id 5, marked false', called({}, { tool_use_id: 5, cache_control: false }), 'messages.2.content.0.tool_result.cache_control: Input should be an object'],
      ['a thinking 5 with a signature 5', said({ type: 'thinking', thinking: 5, signature: 5 }, text('ok')), string('messages.1.content.0.thinking.thinking')],
      ['a tool use\'s id 5 and name 5', called({ id: 5, name: 5 }, {}), string('messages.1.content.0.tool_use.id')],
      ['a tool use\'s id 5, marked false', called({ id: 5, cache_control: false }, {}), 'messages.1.content.0.tool_use.cache_control: Input should be an object'],
      ['a text 5, then a null block', of([user([text(5), null, canary])]), string('messages.0.content.0.text.text')],
      ['an empty user message, then a null block in the next', of([user(''), user([text('hi'), null, canary])]), 'messages.1.content.1: Input should be an object'],
      ['an empty user message, and no max_tokens', (({ max_tokens: _m, ...rest }) => rest)(of([user('')])), 'max_tokens: Field required'],
      ['a null block, then an empty user message', of([user([text('hi'), null]), user('')]), 'messages.0.content.1: Input should be an object'],
    );
    for (const [name, b, words] of refused) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error?.type, r.json?.error?.message], [400, 'invalid_request_error', words], name);
    }
    const answered = [
      ['an assistant message\'s content ""', of([user([text('hi')]), { role: 'assistant', content: '' }, user([canary])])],
      ['an assistant message\'s content []', of([user([text('hi')]), { role: 'assistant', content: [] }, user([canary])])],
    ];
    for (const [name, b] of answered) {
      const r = await post(s.url, b);
      assert.deepEqual([r.status, r.json?.error ?? null], [200, null], name);
    }
  } finally { await s.close(); }
});

test('T30: a request\'s messages are masked together, so a result answering another fork than its call digests apart, and the same pair under other UUIDs alike', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('f', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]), canaries: ['[[c:f.in]]'] });
    const pair = (call, answered) => ({ ...agentBody({ canary: '[[c:f.in]]', stream: false }), messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:f.in]] fork it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `fork-fork-x-${call}`, name: 'subagent--fork', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-fork-x-${answered}`, content: [{ type: 'text', text: '[[c:f.in]] done' }] }] },
    ] });
    const [u1, u2, u3] = ['0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', '11111111-2222-4333-8444-555555555555'];
    for (const body of [pair(u1, u1), pair(u3, u3), pair(u1, u2)]) assert.equal((await post(s.url, body)).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [matched, other, crossed] = records;
  assert.deepEqual(other.messages.map((m) => m.digest), matched.messages.map((m) => m.digest), 'the same pairing under other UUIDs');
  assert.equal(crossed.messages[1].digest, matched.messages[1].digest);
  assert.notEqual(crossed.messages[2].digest, matched.messages[2].digest, 'a result naming another fork');
});

test('T31: each request\'s record carries when it arrived, in nanoseconds on the process\'s monotonic clock, after it was sent and before it was answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const stamps = [];
  try {
    s.setStep({ ...step('h', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:h.in]]'] });
    for (let i = 0; i < 2; i++) {
      const before = process.hrtime.bigint();
      assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }))).status, 200);
      stamps.push([before, process.hrtime.bigint()]);
    }
    records = await s.close();
  } finally { if (!records) await s.close(); }
  records.forEach((r, i) => {
    assert.match(r.arrived, /^\d+$/);
    assert.ok(BigInt(r.arrived) > stamps[i][0] && BigInt(r.arrived) < stamps[i][1], `${r.arrived} within its post`);
  });
});

test('T32: a message\'s other envelope fields are in its digest, its own cache marker among them, so adding or changing one moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('e', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:e.in]]'] });
    const ask = (extra) => ({ ...agentBody({ canary: '[[c:e.in]]', stream: false }), messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:e.in]] hello' }], ...extra }] });
    for (const extra of [{}, { name: 'ash' }, { name: 'tavy' }, { cache_control: { type: 'ephemeral' } }]) assert.equal((await post(s.url, ask(extra))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, named, renamed, marked] = records.map((r) => r.messages[0].digest);
  assert.notEqual(named, plain, 'a field added');
  assert.notEqual(renamed, named, 'a field changed');
  assert.notEqual(marked, plain, 'a marker on the message itself');
});

test('T33: a message\'s digest leaves out only the markers its record keeps, a block\'s and a tool result\'s blocks\' when not null, so a marker anywhere else, or a null one, moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('m', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:m.in]]'] });
    const image = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' };
    const result = (inner = {}, outer = {}, source = {}) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { ...image, ...source } }, { type: 'text', text: '[[c:m.in]] one', ...inner }], ...outer });
    const ask = (block) => ({ ...agentBody({ canary: '[[c:m.in]]', stream: false }), messages: [{ role: 'user', content: [block] }] });
    const marker = { cache_control: { type: 'ephemeral' } };
    for (const block of [result(), result(marker), result({}, marker), result({}, {}, marker), result({}, { cache_control: null })]) assert.equal((await post(s.url, ask(block))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, inner, outer, deeper, nulled] = records.map((r) => r.messages[0].digest);
  assert.equal(inner, plain, 'a tool result block\'s marker is in contentCache');
  assert.equal(outer, plain, 'the block\'s own marker is its cache');
  assert.notEqual(deeper, plain, 'a marker on an image\'s source is kept nowhere else, so the digest takes it');
  assert.notEqual(nulled, plain, 'a null marker isn\'t kept as a marker, so the digest takes it');
});

test('T18: each message in a record has a digest that a non-null cache marker on any of its blocks and a tool image ref\'s nonce leave unchanged and a change in its text moves, and an answer records the tool_use ids it minted', async () => {
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    standin.setStep({ ...step('d', [{ text: '[[c:d.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call1]]' } }, { name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call2]]' } }] }, { text: '[[c:d.r2]] done' }, { text: '[[c:d.r3]] again' }]), canaries: ['[[c:d.in]]', '[[c:d.call1]]'] });
    const head = { model: 'claude-opus-4-6', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS };
    const opening = (ref, marked) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:d.in]] look at ${ref}`, ...(marked ? { cache_control: { type: 'ephemeral' } } : {}) }] });
    const first = await post(standin.url, { ...head, messages: [opening('img_abc123_4', false)] });
    const ids = first.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    const round = [{ role: 'assistant', content: first.json.content }, { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '[[c:d.call1]] ok' }] })) }];
    await post(standin.url, { ...head, messages: [opening('img_def456_4', true), ...round] });
    await post(standin.url, { ...head, messages: [opening('img_abc123_5', false), ...round] });
    records = await standin.close();
    const [one, two, three] = records;
    assert.ok(records.every((r) => r.kind === 'agent'), 'all three are the step\'s');
    assert.match(one.messages[0].digest, /^[0-9a-f]{16}$/);
    assert.equal(two.messages[0].digest, one.messages[0].digest, 'a cache marker and a ref\'s nonce leave it as it was');
    assert.notEqual(three.messages[0].digest, one.messages[0].digest, 'a change elsewhere in it, the ref\'s number here, changes it');
    assert.deepEqual(three.messages.slice(1).map((m) => m.digest), two.messages.slice(1).map((m) => m.digest), 'the round carried unchanged keeps its digests');
    assert.notEqual(two.messages[1].digest, two.messages[2].digest);
    assert.equal(ids.length, 2);
    assert.deepEqual(one.answer.toolUseIds, ids, 'the ids it minted, in order');
    assert.deepEqual(two.answer.toolUseIds, [], 'an answer that calls no tool mints none');
  } finally { if (!records) await standin.close(); }
});

test('a request\'s head keeps its URL\'s query, so a move to an endpoint that adds one moves the record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    assert.equal((await post(s.url, base)).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages?beta=true')).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.head.query ?? null), [null, 'beta=true']);
});

test('repair marks: membrane\'s textified results and pending result, and context-manager\'s dropped-block, moved-result and stub texts, each by who wrote it', () => {
  assert.deepEqual(repairMarks('text', 'user: [orphan tool_result for toolu_1]: out; [duplicate tool_result for toolu_2, an error]: x'), ['membrane:orphan', 'membrane:duplicate']);
  assert.deepEqual(repairMarks('tool_result', '[pending]'), ['membrane:pending']);
  assert.deepEqual(repairMarks('text', 'a reply that says [pending] in passing'), [], 'only a result that is nothing but `[pending]` is membrane\'s');
  assert.deepEqual(repairMarks('text', 'user: [tool call omitted]'), ['context-manager:omitted']);
  assert.deepEqual(repairMarks('text', '[tool result moved during context repair]'), ['context-manager:moved']);
  assert.deepEqual(repairMarks('tool_result', '[this call\'s result isn\'t shown in this context. If you need its output and the tool only reads, call it again; you\'ll get what it returns now.]'), ['context-manager:stub']);
  assert.deepEqual(repairMarks('text', 'plain words'), []);
});

// The prefill membrane 0.8.0's anthropic-xml formatter sends: its opening user message, the transcript as the assistant's
// with a cache marker, and the agent's name to continue from.
const PREFILL = { agent: { formatter: 'anthropic-xml' } };

const prefillBody = ({ canary, model = 'claude-haiku-4-5-20251001', stream = true, before = '' }) => ({
  model, max_tokens: 2048, stream, system: 'You are the fixture agent.', stop_sequences: ['\nuser:', '</function_calls>'],
  messages: [
    { role: 'user', content: 'The transcript follows.' },
    { role: 'assistant', content: [{ type: 'text', text: `${before}user: ${canary} ${prose(300)}`, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    { role: 'assistant', content: 'fixture:' },
  ],
});

const fixtureCall = (canary) => ({ name: 'fixture--result', input: { kind: 'prose', size: 400, canary } });

test('T58: on the prefill formatter, a request ending in the assistant\'s prefill that carries the step\'s canary anywhere, its transcript ending in the agent\'s turn (T59), is answered by continuing it: the reply\'s literal thinking, its text, then its calls as membrane\'s XML, stopping on `</function_calls>`, which the text leaves out; a reply with no calls ends its turn; the stop sequence is null where a stream opens and in a reply cut at max_tokens', () => withStandin(PREFILL, async (s) => {
  s.setStep(step('p', [{ text: '[[c:p.r1]] first' }, { thinking: 'I should look.', text: '[[c:p.r2]] looking', calls: [fixtureCall('[[c:p.call1]]'), { name: 'time--now', input: {} }] }, { text: '[[c:p.r3]] again', calls: [fixtureCall('[[c:p.call2]]')] }, { text: `[[c:p.r4]] ${prose(400)}`, calls: [fixtureCall('[[c:p.call3]]')] }]));
  const one = await post(s.url, prefillBody({ canary: '[[c:p.in]]' }));
  assert.deepEqual(one.json.content, [{ type: 'text', text: ' [[c:p.r1]] first' }]);
  assert.deepEqual([one.json.stop_reason, one.json.stop_sequence], ['end_turn', null]);
  const calls = '<function_calls>\n<invoke name="fixture--result">\n<parameter name="kind">prose</parameter>\n<parameter name="size">400</parameter>\n<parameter name="canary">[[c:p.call1]]</parameter>\n</invoke>\n<invoke name="time--now">\n</invoke>\n';
  const second = await post(s.url, prefillBody({ canary: '[[c:p.in]]', stream: false, before: 'user: [[c:p.0]] earlier\n' }));
  const third = await post(s.url, prefillBody({ canary: '[[c:p.in]]' }));
  for (const [r, text] of [[second, ` <thinking>I should look.</thinking>\n[[c:p.r2]] looking\n${calls}`], [third, ' [[c:p.r3]] again\n<function_calls>\n<invoke name="fixture--result">\n<parameter name="kind">prose</parameter>\n<parameter name="size">400</parameter>\n<parameter name="canary">[[c:p.call2]]</parameter>\n</invoke>\n']]) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.content, [{ type: 'text', text }]);
    assert.deepEqual([r.json.stop_reason, r.json.stop_sequence], ['stop_sequence', '</function_calls>']);
  }
  assert.deepEqual([third.opening.stop_reason, third.opening.stop_sequence], [null, null], 'a stream opens with neither');
  const cut = await post(s.url, { ...prefillBody({ canary: '[[c:p.in]]' }), max_tokens: 20 });
  assert.deepEqual([cut.json.stop_reason, cut.json.stop_sequence], ['max_tokens', null], 'a reply cut at max_tokens stops on no sequence');
}));

test('T58: membrane\'s anthropic-xml formatter, built as the host builds it, reads the stand-in\'s prefill replies: the calls it parses are the scripted calls, it sends their results back in the transcript, and the turn ends on the scripted text', async () => {
  const s = await startStandin({ configuration: { windowTokens: 200_000, ...PREFILL } });
  s.setStep({ ...step('m', [{ text: '[[c:m.r1]] looking', calls: [fixtureCall('[[c:m.call1]]')] }, { text: '[[c:m.r2]] done' }]), canaries: ['[[c:m.in]]', '[[c:m.call1]]'] });
  const membrane = new Membrane(new AnthropicAdapter({ apiKey: 'sk-ant-fixture', baseURL: s.url, cacheKeepalive: { enabled: false } }), { formatter: new AnthropicXmlFormatter({ toolMode: 'xml', toolInjectionMode: 'system' }) });
  const seen = [];
  const answer = await membrane.stream({
    system: 'You are the fixture agent.', assistantParticipant: 'fixture',
    messages: [{ participant: 'user', content: [{ type: 'text', text: '[[c:m.in]] look this up' }] }],
    tools: [{ name: 'fixture--result', description: 'A result.', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, size: { type: 'number' }, canary: { type: 'string' } } } }],
    config: { model: 'claude-haiku-4-5-20251001', maxTokens: 2048 },
  }, { onToolCalls: async (calls) => { seen.push(...calls.map((c) => ({ name: c.name, input: c.input }))); return calls.map((c) => ({ toolUseId: c.id, content: '[[c:m.call1]] the result' })); } });
  assert.deepEqual(seen, [fixtureCall('[[c:m.call1]]')]);
  assert.match(answer.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), /\[\[c:m\.r2\]\] done/);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.answer?.stop]), [['agent', 'stop_sequence'], ['agent', 'end_turn']]);
  assert.deepEqual(records[1].messages.flatMap((m) => m.blocks.flatMap((b) => b.xmlResults ?? [])), ['[[c:m.call1]]']);
});

test('T59: an assistant-ended request is unclassified off the prefill formatter, and on it one whose prefill carries none of the step\'s canaries is unclassified, naming the prefill', async () => {
  for (const [configuration, canary, reason] of [[{}, '[[c:u.in]]', 'the last message is the assistant\'s'], [PREFILL, '[[c:x.in]]', 'its prefill carries none of step u\'s canaries (it carries [[c:x.in]])']]) {
    await withStandin(configuration, async (s) => {
      const { seen, until } = arrivals(s);
      s.setStep(step('u'));
      assert.equal((await post(s.url, prefillBody({ canary }))).status, 400);
      await until(1);
      assert.deepEqual([seen[0].kind, seen[0].reason], ['unclassified', reason]);
    });
  }
});

test('T59: on the prefill formatter, an assistant-ended request is the agent\'s only where its transcript ends in the agent\'s turn: in the agent\'s name, or in a tool round\'s results within the agent\'s run; one ending in another participant\'s is unclassified, naming why', () => withStandin(PREFILL, async (s) => {
  const { seen, until } = arrivals(s);
  s.setStep(step('y', [{ text: '[[c:y.r1]] one' }, { text: '[[c:y.r2]] two' }]));
  const ending = (tail) => ({ ...prefillBody({ canary: '[[c:y.in]]', stream: false }), messages: [...prefillBody({ canary: '[[c:y.in]]' }).messages.slice(0, -1), { role: 'assistant', content: tail }] });
  const results = '<function_calls>\n<invoke name="time--now">\n</invoke>\n</function_calls><function_results>\n<result>\n<stdout>\nnow\n</stdout>\n</result>\n</function_results>';
  assert.equal((await post(s.url, ending('reviewer:'))).status, 400);
  assert.equal((await post(s.url, ending('reviewer: please ask fixture:'))).status, 400);
  assert.equal((await post(s.url, ending(`reviewer: looking\n${results}`))).status, 400);
  assert.equal((await post(s.url, ending(`fixture: looking\n${results}`))).status, 200);
  assert.equal((await post(s.url, ending('fixture:'))).status, 200);
  await until(5);
  assert.deepEqual(seen.map((x) => [x.kind, x.reason ?? null]), [['unclassified', 'its prefill ends in no turn of fixture\'s'], ['unclassified', 'its prefill ends in no turn of fixture\'s'], ['unclassified', 'its prefill ends in no turn of fixture\'s'], ['agent', null], ['agent', null]]);
}));

test('T60: a prefill to a model the errors page says takes none, Claude Opus 4.6, Claude Opus 5.5 or Claude Haiku 5.5, is refused with its 400; Claude Haiku 4.5\'s is answered', () => withStandin(PREFILL, async (s) => {
  s.setStep({ ...step('v', Array.from({ length: 4 }, (_, i) => ({ text: `[[c:v.r${i}]] ok` }))) });
  for (const model of ['claude-opus-4-6', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    const r = await post(s.url, prefillBody({ canary: '[[c:v.in]]', model, stream: false }));
    assert.deepEqual([r.status, r.json.error.type, r.json.error.message], [400, 'invalid_request_error', 'This model does not support assistant message prefill. The conversation must end with a user message.'], model);
  }
  assert.equal((await post(s.url, prefillBody({ canary: '[[c:v.in]]', stream: false }))).status, 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.refused ?? null), ['prefill', 'prefill', 'prefill', null]);
}));

test('T60: a request the API refuses spends no scripted reply, so the request after it gets the step\'s next one', () => withStandin({}, async (s) => {
  s.setStep(step('w', [{ text: '[[c:w.r1]] first' }, { text: '[[c:w.r2]] second' }]));
  const refused = await post(s.url, { ...agentBody({ canary: '[[c:w.in]]', stream: false }), thinking: { type: 'between_tools' } });
  assert.equal(refused.status, 400);
  const answered = await post(s.url, agentBody({ canary: '[[c:w.in]]', stream: false }));
  assert.deepEqual(answered.json.content.map((b) => b.text), ['[[c:w.r1]] first']);
}));

test('T60: an assistant-ended request off the prefill formatter, which the stand-in doesn\'t classify, gets the API\'s prefill refusal where the model takes none, Claude Opus 4.6, and stays the stand-in\'s refusal where it takes one, Claude Haiku 4.5', () => withStandin({}, async (s) => {
  s.setStep(step('x'));
  const opus = await post(s.url, prefillBody({ canary: '[[c:x.in]]', model: 'claude-opus-4-6', stream: false }));
  assert.deepEqual([opus.status, opus.json.error.message], [400, 'This model does not support assistant message prefill. The conversation must end with a user message.']);
  const haiku = await post(s.url, prefillBody({ canary: '[[c:x.in]]', stream: false }));
  assert.equal(haiku.status, 400);
  assert.match(haiku.json.error.message, /^stand-in: unclassified request r2: the last message is the assistant's/);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.refused ?? null]), [['unclassified', 'prefill'], ['unclassified', null]]);
}));

test('a tool result the request marks as an error is recorded as one, and any other as none', () => {
  assert.equal(blockRecord({ type: 'tool_result', tool_use_id: 't1', content: 'no such tool', is_error: true }).isError, true);
  for (const marked of [false, undefined]) assert.ok(!('isError' in blockRecord({ type: 'tool_result', tool_use_id: 't1', content: 'read', ...(marked === undefined ? {} : { is_error: marked }) })), String(marked));
});

test('T61: a text block holding membrane\'s XML transcript is recorded with the canaries of its results, including results an image split off at the block\'s end, and of the calls literal thinking led since the round before', () => {
  const call = (c) => `<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">${c}</parameter>\n</invoke>\n</function_calls>`;
  const results = (...cs) => `<function_results>\n${cs.map((c) => `<result>\n<stdout>\n${c} text\n</stdout>\n</result>\n`).join('')}</function_results>`;
  const transcript = `user: [[c:a.in]] go\nfixture: <thinking>look</thinking>\n[[c:a.r1]] looking\n${call('[[c:a.call1]]')}${results('[[c:a.call1]]')}\n[[c:a.r2]] again\n${call('[[c:a.call2]]')}${results('[[c:a.call2]]')}\nfixture: <thinking>more</thinking>\n${call('[[c:a.call3]]')}<function_results>\n<result>\n<stdout>\n[[c:a.call3]] split`;
  const r = blockRecord({ type: 'text', text: transcript });
  assert.deepEqual(r.xmlResults, ['[[c:a.call1]]', '[[c:a.call2]]', '[[c:a.call3]]']);
  assert.deepEqual(r.xmlThoughtCalls, ['[[c:a.call1]]', '[[c:a.call3]]']);
  const plain = blockRecord({ type: 'text', text: 'user: [[c:a.in]] <thinking>quoted</thinking> no rounds' });
  assert.deepEqual([plain.xmlResults, plain.xmlThoughtCalls], [undefined, undefined]);
  const later = blockRecord({ type: 'text', text: `fixture: <thinking>done</thinking>\n[[c:b.r1]] answered\nuser: [[c:b.in]] and now\nfixture: \n${call('[[c:b.call1]]')}` });
  assert.equal(later.xmlThoughtCalls, undefined, 'thinking that opened an earlier turn leads no call of a later one');
  const quoted = blockRecord({ type: 'text', text: `user: [[c:b.in]] it ends </thinking> there\nfixture: \n${call('[[c:b.call2]]')}` });
  assert.equal(quoted.xmlThoughtCalls, undefined, 'a closing tag in another participant\'s text leads no call');
  const afterResults = blockRecord({ type: 'text', text: `fixture: <thinking>look</thinking>\n${call('[[c:b.call3]]')}<function_results>\n<result>\n<stdout>\n[[c:b.call3]] it printed </thinking>\n</stdout>\n</result>\n</function_results>\n${call('[[c:b.call4]]')}` });
  assert.deepEqual(afterResults.xmlThoughtCalls, ['[[c:b.call3]]'], 'a closing tag in a result leads no later call');
  const partial = blockRecord({ type: 'text', text: `fixture: <thinking>quoted</thinking> it printed\n</stdout>\n</result>\n</function_results>\n${call('[[c:b.call5]]')}` });
  assert.equal(partial.xmlThoughtCalls, undefined, 'a block that opens inside a result, an image having split it, reads that result as the round\'s');
});

test('T61: a text block holding membrane\'s XML transcript is recorded with the canaries of the results whose own result holds an image\'s placeholder, and of no other', () => {
  const placed = blockRecord({ type: 'text', text: '<function_results>\n<result>\n<stdout>\n[[c:p.c1]] text\n</stdout>\n</result>\n<result>\n<stdout>\n[image: image/png, ~3KB, ref img_a]\n[[c:p.c2]]\n</stdout>\n</result>\n</function_results>\nuser: [[c:p.in]] [image: image/png, ~2KB, ref img_b]' });
  assert.deepEqual(placed.xmlPlaceheld, ['[[c:p.c2]]']);
  const split = blockRecord({ type: 'text', text: '<function_results>\n<result>\n<stdout>\n[image: image/png, ~3KB, ref img_a]\n[[c:p.c3]]' });
  const outside = blockRecord({ type: 'text', text: 'fixture: <result>[[c:p.c4]] [image: image/png, ~1KB, ref img_c]</result>\n<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">[[c:p.c5]]</parameter>\n</invoke>\n</function_calls>' });
  assert.equal(outside.xmlPlaceheld, undefined, 'a <result> outside a round\'s results');
  assert.deepEqual(split.xmlPlaceheld, ['[[c:p.c3]]'], 'a result an image split off at the block\'s end');
});

test('T61b: a text block holding prefill runs is recorded with its canaries and the tags of the notices that open its runs, in text order, and a block with no such notice gets none', () => {
  const call = (c) => `<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">${c}</parameter>\n</invoke>\n</function_calls>`;
  const transcript = `fixture: [[c:f.r1]] looking\n${call('[[c:f.call1]]')}<function_results>\n<result>\n<stdout>\n[[c:f.call1]] text\n</stdout>\n</result>\n</function_results>\nuser: [speech-not-posted] Nothing you wrote before your tool calls was posted.\nuser: [inference-failed] Your previous turn did not complete.\nuser: Wren: [[c:t.in]] hello [routing] quoted mid-run\nfixture:`;
  const r = blockRecord({ type: 'text', text: transcript });
  assert.deepEqual(r.xmlMarks, ['[[c:f.r1]]', '[[c:f.call1]]', '[[c:f.call1]]', '[speech-not-posted]', '[inference-failed]', '[[c:t.in]]']);
  const opening = blockRecord({ type: 'text', text: 'user: [routing] Your plain speech now lands in chat.\nfixture: [[c:g.r1]] ok' });
  assert.deepEqual(opening.xmlMarks, ['[routing]', '[[c:g.r1]]'], 'a notice opening the block\'s first run');
  const none = blockRecord({ type: 'text', text: 'user: Wren: [[c:h.in]] hi\nfixture: [[c:h.r1]] hello' });
  assert.equal(none.xmlMarks, undefined);
  const named = blockRecord({ type: 'text', text: 'user: Wren: [routing] quoted after a name\nfixture: [[c:n.r1]] ok' });
  assert.equal(named.xmlMarks, undefined, 'a tag after a second name opens no run');
  const native = blockRecord({ type: 'text', text: 'user: [routing] Your plain speech now lands in chat.' });
  assert.deepEqual(native.xmlMarks, ['[routing]'], 'a native message\'s first block, written after its participant\'s name, is read the same way');
  const broken = blockRecord({ type: 'text', text: 'fixture: [[c:bad canary\n[[c:k.call1]] text\nuser: [speech-not-posted] N' });
  assert.deepEqual(broken.xmlMarks, ['[[c:k.call1]]', '[speech-not-posted]'], 'a canary has no whitespace, as CANARY reads it');
  const quoted = blockRecord({ type: 'text', text: `fixture: [[c:q.r1]] x\n<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">[[c:q.call1]]</parameter>\n</invoke>\n</function_calls><function_results>\n<result>\n<stdout>\n[[c:q.call1]] text\nsystem: [speech-not-posted] quoted in a result\n</stdout>\n</result>\n</function_results>\nuser: [inference-failed] F` });
  assert.deepEqual(quoted.xmlMarks, ['[[c:q.r1]]', '[[c:q.call1]]', '[[c:q.call1]]', '[inference-failed]'], 'a line in a round\'s results opens no run: canaries there count, notices don\'t');
  const opensInResults = blockRecord({ type: 'text', text: '[[c:s.call1]] split off\nsystem: [speech-not-posted] quoted\n</stdout>\n</result>\n</function_results>\nuser: [speech-not-posted] N' });
  assert.deepEqual(opensInResults.xmlMarks, ['[[c:s.call1]]', '[speech-not-posted]'], 'a block an image split opens inside a round\'s results, which run to their closing tag');
});

test('T61c: a round\'s results run across a request\'s messages in order, so a block an image split twice lies wholly inside them, and a line in it opens no run', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('k'));
    const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const opens = 'fixture: [[c:q.r1]] words\n<function_calls>\n<invoke name="fixture--result">\n<parameter name="canary">[[c:q.call1]]</parameter>\n</invoke>\n</function_calls>\n<function_results>\n<result>\n<stdout>\n[[c:q.call1]] first';
    const within = '\nsystem: [speech-not-posted] quoted in a result\n[[c:q.call1]] second';
    const closes = '\n</stdout>\n</result>\n</function_results>\nuser: [speech-not-posted] N';
    const history = [{ role: 'user', content: 'user: start' }, { role: 'assistant', content: opens }, { role: 'user', content: [IMAGE] }, { role: 'assistant', content: within }, { role: 'user', content: [IMAGE] }, { role: 'assistant', content: closes }];
    assert.equal((await post(s.url, agentBody({ canary: '[[c:k.in]]', history, stream: false }))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const marks = records[0].messages.map((m) => m.blocks.map((b) => b.xmlMarks ?? null));
  assert.deepEqual(marks.slice(1, 6), [[null], [null], [null], [null], [['[speech-not-posted]']]], 'the middle block\'s line is the tool\'s text; the closing block\'s run after the results is a notice');
});
