import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { countTokens } from './anthropic.ts';
import { agentBody, arrivals, post, prose, read, startStandin, step, withStandin } from '../testing/standin.ts';
import type { AnthropicUsage, MessagesBody, MessagesWritten } from './anthropic.ts';
import type { RequestRecord } from './standin.ts';
import type { Block } from './view.ts';

type MessageItem = NonNullable<MessagesBody['messages']>[number];
type MessagesRecord = RequestRecord & MessagesWritten;

test('T10: the same request always counts the same, at about 1.3 times context-manager\'s own estimate of prose, and an image counts by its size', () => withStandin({}, async (s) => {
  s.setStep(step('n', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = agentBody({ canary: '[[c:n.in]]' });
  const one = (await post(s.url, body)).json.usage!;
  const two = (await post(s.url, body)).json.usage!;
  const total = (u: AnthropicUsage) => u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  assert.equal(total(one), total(two));
  const big = 29_000;
  const counted = s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: prose(big, 9) }] }] });
  const cmEstimate = Math.ceil(big / 2.9);
  assert.ok(counted > cmEstimate * 1.2 && counted < cmEstimate * 1.4, `${counted} vs ${cmEstimate}`);
  const png = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString('base64'); };
  const withImage = (w: number, h: number) => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(w, h) } }] }] });
  const small = s.countTokens(withImage(100, 100));
  const large = s.countTokens(withImage(750, 1000));
  assert.ok(large - small > 900, `${small} → ${large}`);
}));

test('T10b: denser text counts more tokens a character (prose, then code, JSON and base64), and a prose opening doesn\'t price a dense body as prose', () => withStandin({}, async (s) => {
  const count = async (text: string) => s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const empty = await count('');
  const rate = async (text: string) => (await count(text) - empty) / text.length;
  const code = (n: number) => 'const value_1 = read(index, total);\n'.repeat(Math.ceil(n / 36)).slice(0, n);
  const json = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const base64 = Buffer.from(Array.from({ length: 4500 }, (_, i) => (i * 37) % 256)).toString('base64');
  const rates = [await rate(prose(6000, 3)), await rate(code(6000)), await rate(json), await rate(base64)];
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2] && rates[2] < rates[3], rates.join(' < '));
  const opening = prose(2500, 4);
  const body = code(30_000);
  const mixed = await count(`${opening}${body}`) - empty;
  const apart = (await count(opening) - empty) + (await count(body) - empty);
  assert.ok(Math.abs(mixed - apart) <= apart * 0.02, `priced in stretches, as its parts are: ${mixed} vs ${apart}`);
  assert.ok(mixed > (await count(prose(32_500, 4)) - empty) * 1.1, 'not as prose');
}));

test('T11: a request over the window is refused as the API refuses it', () => withStandin({ windowTokens: 1000 }, async (s) => {
  s.setStep(step('o'));
  const r = await post(s.url, agentBody({ canary: '[[c:o.in]]', history: [{ role: 'user', content: [{ type: 'text', text: prose(8000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error!.type, 'invalid_request_error');
  assert.match(r.json.error!.message, /^prompt is too long: \d+ tokens > 1000 maximum$/);
}));

test('T12: a marked prefix is written, read back byte for byte while live on the virtual clock, and its lifetime follows its marker', () => withStandin({}, async (s) => {
  s.setStep(step('c', Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` }))));
  const history = (ttl?: string, text = prose(4000, 5)) => [
    { role: 'user', content: [{ type: 'text', text: `user: ${text}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }] },
  ];
  const ask = async (h: MessageItem[]) => (await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:c.in]]', history: h }))).json.usage!;
  s.setClock(0);
  const first = await ask(history());
  assert.ok(first.cache_creation_input_tokens > 1000);
  assert.equal(first.cache_read_input_tokens, 0);
  assert.equal(first.cache_creation.ephemeral_5m_input_tokens, first.cache_creation_input_tokens);
  s.setClock(4 * 60_000);
  const second = await ask(history());
  assert.equal(second.cache_read_input_tokens, first.cache_creation_input_tokens);
  assert.equal(second.cache_creation_input_tokens, 0);
  s.setClock(8 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, first.cache_creation_input_tokens);
  s.setClock(14 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, 0);
  await ask(history('1h'));
  s.setClock(40 * 60_000);
  const hour = await ask(history('1h'));
  assert.ok(hour.cache_read_input_tokens > 1000);
  assert.equal((await ask(history('1h', prose(4000, 6)))).cache_read_input_tokens, 0);
  s.setClock(100 * 60_000);
  for (const seed of [7, 8]) assert.ok((await ask(history('1h', prose(4000, seed)))).cache_creation.ephemeral_1h_input_tokens > 1000, 'two fresh one-hour entries');
  s.setClock(159 * 60_000);
  assert.ok((await ask(history('1h', prose(4000, 7)))).cache_read_input_tokens > 1000, 'read back at 59 minutes');
  s.setClock(160 * 60_000);
  assert.equal((await ask(history('1h', prose(4000, 8)))).cache_read_input_tokens, 0, 'gone at 60');
}));

test('T12: a cache entry is the model\'s own', () => withStandin({}, async (s) => {
  s.setStep(step('cm', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  // Above both models' minimum cacheable lengths, Claude Opus 4.6's 4,096 tokens the higher.
  const h = [{ role: 'user', content: [{ type: 'text', text: prose(12000, 5), cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }];
  const first = await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:cm.in]]', history: h }));
  assert.ok(first.json.usage!.cache_creation_input_tokens > 4096, `the first request writes its prefix: ${first.json.usage!.cache_creation_input_tokens}`);
  const same = await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:cm.in]]', history: h }));
  assert.equal(same.json.usage!.cache_read_input_tokens, first.json.usage!.cache_creation_input_tokens, 'the same model reads it back');
  const other = await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h, model: 'claude-opus-4-6' }));
  assert.equal(other.json.usage!.cache_read_input_tokens, 0);
  assert.ok(other.json.usage!.cache_creation_input_tokens > 4096, 'the other model writes its own');
}));

test('T12: the lookback counts 20 positions back from a marker, its own included, with a run of tool_use blocks, or of tool_result blocks, as one', () => withStandin({}, async (s) => {
  s.setStep({ ...step('lb', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:lb.in]]'] });
  const marked = { type: 'ephemeral' };
  const opening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5), cache_control: marked }] };
  const unmarkedOpening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5) }] };
  const ask = (n: number, k: Block[]) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:lb.in]] ${n}`, cache_control: marked }, ...k] });
  const first = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [opening, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ask(1, [])] });
  assert.ok(first.json.usage!.cache_creation_input_tokens > 0, 'premise: the opening is written');
  const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `lb${i}`, name: 'time--now', input: {} }));
  const results = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `lb${i}`, content: `out ${i}` }));
  const turn = (n: number) => [{ role: 'assistant', content: [{ type: 'text', text: 'checking' }, ...calls(n)] }, { role: 'user', content: results(n) }];
  const wide = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...turn(25), ask(2, [])] });
  assert.equal(wide.json.usage!.cache_read_input_tokens > 0, true, `a run of calls and a run of results are one position each: ${JSON.stringify(wide.json.usage)}`);
  const long = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...Array.from({ length: 21 }, () => turn(1)).flat(), ask(3, [])] });
  assert.equal(long.json.usage!.cache_read_input_tokens, 0, `past 20 positions, nothing is read back: ${JSON.stringify(long.json.usage)}`);
  const edge = (n: number, i: number) => post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, { role: 'assistant', content: Array.from({ length: n }, (_, k) => ({ type: 'text', text: `ok ${k}` })) }, ask(i, [])] });
  assert.ok((await edge(18, 4)).json.usage!.cache_read_input_tokens > 0, 'the 20th position back is read');
  assert.equal((await edge(19, 5)).json.usage!.cache_read_input_tokens, 0, 'the 21st isn\'t');
}));

test('T12: the messages cache keys on the thinking configuration\'s mode and budget, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('tk', Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))));
  const ask = async (thinking: NonNullable<MessagesBody['thinking']> | null) => {
    const body = agentBody({ model: 'claude-opus-4-6', canary: '[[c:tk.in]]', history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(24000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ], extra: thinking ? { thinking } : {} });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(24000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage!;
  };
  const first = await ask(null);
  assert.ok(first.cache_creation_input_tokens > 0 && first.cache_read_input_tokens === 0, 'premise: the system and the messages are written');
  const whole = (await ask(null)).cache_read_input_tokens;
  assert.equal(whole, first.cache_creation_input_tokens, 'premise: the same request reads both');
  const adaptive = await ask({ type: 'adaptive' });
  assert.ok(adaptive.cache_read_input_tokens > 0 && adaptive.cache_read_input_tokens < whole, `a new mode reads the system's prefix only (${adaptive.cache_read_input_tokens} of ${whole})`);
  assert.equal((await ask({ type: 'adaptive', display: 'summarized' })).cache_read_input_tokens, whole, 'the same mode with another display reads what it wrote');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 1024 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'another mode reads the system\'s prefix only');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 2048 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'and so does another budget');
}));

test('T12: the messages cache keys on the bytes sent, not on whether an image is sent: a request with an image after a cached prefix, in a message or a tool result, reads all of it, one without reads a prefix only requests with one wrote, and a replaced image reads up to its message', () => withStandin({}, async (s) => {
  s.setStep(step('im', Array.from({ length: 16 }, (_, i) => ({ text: `r${i}` }))));
  const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } } satisfies Block;
  const marked = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
  const opening = (seed: number) => [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(4000, seed)}` }] }, marked('stored reply')];
  const ask = async (history: MessageItem[], tail: Block[] = []) => {
    const body = agentBody({ model: 'claude-opus-5-5', canary: '[[c:im.in]]', tail, history });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(3000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage!;
  };
  const first = await ask(opening(5));
  const whole = (await ask(opening(5))).cache_read_input_tokens;
  assert.ok(whole > 0 && whole === first.cache_creation_input_tokens, 'premise: the same request reads what the first wrote');
  assert.equal((await ask(opening(5), [IMAGE])).cache_read_input_tokens, whole, 'an image in a message after the marker reads the prefix a request without one wrote');
  await ask(opening(23));
  const other = (await ask(opening(23))).cache_read_input_tokens;
  assert.equal((await ask(opening(23), [{ type: 'tool_result', tool_use_id: 'x', content: [IMAGE] }])).cache_read_input_tokens, other, 'and so does an image in a tool result');
  const systemOnly = (await ask(opening(19))).cache_read_input_tokens;
  assert.ok(systemOnly > 0 && systemOnly < whole, `premise: a new opening reads the system's prefix only (${systemOnly} of ${whole})`);
  await ask(opening(13), [IMAGE]);
  const withImage = (await ask(opening(13), [IMAGE])).cache_read_input_tokens;
  assert.ok(withImage > systemOnly, 'premise: the request with the image reads what it wrote');
  assert.equal((await ask(opening(13))).cache_read_input_tokens, withImage, 'a request without the image reads the prefix only a request with one wrote');
  await ask([...opening(17), { role: 'user', content: [{ type: 'text', text: 'look' }, IMAGE] }, marked('seen')]);
  const stripped = (await ask([...opening(17), { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'text', text: '[image not shown]' }] }, marked('seen')])).cache_read_input_tokens;
  const upTo = (await ask(opening(17))).cache_read_input_tokens;
  assert.ok(upTo > systemOnly, `premise: the prefix before the image's message is cached (${upTo}, the system's ${systemOnly})`);
  assert.equal(stripped, upTo, 'replacing the image with text reads up to the message that held it');
}));

test('T12: a marked prefix shorter than its model\'s minimum isn\'t written: 4,096 tokens for Claude Opus 4.6 and Claude Haiku 4.5, 512 for Claude Opus 5.5 and Claude Haiku 5.5', () => withStandin({}, async (s) => {
  s.setStep(step('mn', Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` }))));
  const marked = (model: string, chars: number) => agentBody({ canary: '[[c:mn.in]]', model, history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(chars, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], tail: [{ type: 'text', text: 'end', cache_control: { type: 'ephemeral' } }] });
  for (const [model, minimum, under, over] of [['claude-opus-4-6', 4096, 7000, 10_000], ['claude-opus-5-5', 512, 200, 1600], ['claude-haiku-5-5', 512, 200, 1600], ['claude-haiku-4-5-20251001', 4096, 7000, 10_000]] satisfies Array<[string, number, number, number]>) {
    const short = marked(model, under);
    const long = marked(model, over);
    assert.ok(countTokens(short) < minimum && countTokens(long) >= minimum, `premise: ${countTokens(short)} under ${minimum}, ${countTokens(long)} not`);
    const shortUsage = (await post(s.url, short)).json.usage!;
    assert.equal(shortUsage.cache_creation_input_tokens, 0, `${model}: a ${countTokens(short)}-token prefix isn't written`);
    assert.equal(shortUsage.input_tokens, countTokens(short), 'and goes as input');
    assert.equal((await post(s.url, short)).json.usage!.cache_read_input_tokens, 0, 'so nothing reads it');
    assert.equal((await post(s.url, long)).json.usage!.cache_creation_input_tokens, countTokens(long), `${model}: a ${countTokens(long)}-token prefix is written`);
  }
}));

test('T48: the messages cache keys on output_config\'s effort, an effort the model takes by default reading as none sent, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('ef', Array.from({ length: 24 }, (_, i) => ({ text: `r${i}` }))));
  const ask = async (model: string, effort: string | null) => {
    const body = agentBody({ canary: '[[c:ef.in]]', model, history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(16_000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ], extra: effort ? { output_config: { effort } } : {} });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(16_000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.usage!;
  };
  // The effort page: Claude Opus 5.5 and Claude Haiku 5.5 default to medium, every other model that takes effort to high.
  for (const [model, byDefault, other] of [['claude-haiku-5-5', 'medium', 'low'], ['claude-opus-5-5', 'medium', 'high'], ['claude-opus-4-6', 'high', 'low']] satisfies Array<[string, string, string]>) {
    const first = await ask(model, null);
    const whole = (await ask(model, null)).cache_read_input_tokens;
    assert.ok(whole > 0 && whole === first.cache_creation_input_tokens, `premise: ${model}'s same request reads what the first wrote`);
    assert.equal((await ask(model, byDefault)).cache_read_input_tokens, whole, `${model}: ${byDefault}, its default, reads what no effort wrote`);
    const moved = await ask(model, other);
    assert.ok(moved.cache_read_input_tokens > 0 && moved.cache_read_input_tokens < whole, `${model}: ${other} reads the system's prefix only (${moved.cache_read_input_tokens} of ${whole})`);
    assert.equal((await ask(model, other)).cache_read_input_tokens, whole, `${model}: and ${other} again reads what it wrote`);
  }
}));

test('T56: a request carrying output_config.effort for a model that takes none, Claude Haiku 4.5, is refused as unclassified, naming the model, and the same request without it is answered', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const model = 'claude-haiku-4-5-20251001';
  s.setStep(step('he', [{ text: 'r1' }, { text: 'r2' }]));
  for (const effort of ['low', 'high']) {
    const r = await post(s.url, agentBody({ canary: '[[c:he.in]]', model, extra: { output_config: { effort } } }));
    assert.equal(r.status, 400, `${effort}: ${JSON.stringify(r.json)}`);
    assert.equal(seen.at(-1)!.kind, 'unclassified');
    assert.equal(seen.at(-1)!.reason, `it carries \`output_config.effort\`, and the model ${model} takes no effort`);
  }
  assert.equal((await post(s.url, agentBody({ canary: '[[c:he.in]]', model }))).status, 200, 'with no effort it is answered');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:he.in]]', model: 'claude-haiku-5-5', extra: { output_config: { effort: 'low' } } }))).status, 200, 'a model that takes effort is answered with one');
  await s.close();
}));

test('T57: a request carrying an output_config.effort the model doesn\'t take, as the effort page lists them, is refused as unclassified, naming the value and the model, and each value the page gives the model is answered', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('ev', Array.from({ length: 24 }, (_, i) => ({ text: `r${i}` }))));
  const send = (model: string, effort: string | null) => post(s.url, agentBody({ canary: '[[c:ev.in]]', model, extra: { output_config: { effort } } }));
  for (const [model, effort] of [['claude-opus-5-5', 'bogus'], ['claude-opus-4-6', 'bogus'], ['claude-opus-5-5', null], ['claude-opus-5-5', 'HIGH'], ['claude-opus-4-6', 'xhigh']] satisfies Array<[string, string | null]>) {
    const r = await send(model, effort);
    assert.equal(r.status, 400, `${model} ${effort}: ${JSON.stringify(r.json)}`);
    assert.equal(seen.at(-1)!.kind, 'unclassified');
    assert.equal(seen.at(-1)!.reason, `it carries \`output_config.effort\` ${JSON.stringify(effort)}, which the model ${model} doesn't take`);
  }
  for (const [model, efforts] of [['claude-opus-4-6', ['low', 'medium', 'high', 'max']], ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']], ['claude-haiku-5-5', ['low', 'medium', 'high', 'xhigh', 'max']]] satisfies Array<[string, string[]]>) {
    for (const effort of efforts) assert.equal((await send(model, effort)).status, 200, `${model} takes ${effort}`);
  }
  await s.close();
}));

test('T1/T12: a request carrying a field the stand-in\'s cache doesn\'t model, or naming a model it knows no minimum for, is refused as unclassified, naming it; its record keeps its head', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('uf'));
    for (const [extra, named] of [[{ tool_choice: { type: 'auto' } }, '`tool_choice`'], [{ speed: 'fast' }, '`speed`'], [{ output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } } }, '`output_config.format`'], [{ model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5'], [{ model: 'constructor' }, 'constructor']] satisfies Array<[MessagesBody, string]>) {
      const r = await post(s.url, agentBody({ canary: '[[c:uf.in]]', extra }));
      assert.equal(r.status, 400);
      assert.ok(r.json.error!.message.includes(named), `${r.json.error!.message} names ${named}`);
    }
    records = await s.close() as MessagesRecord[];
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified', 'unclassified']);
  assert.deepEqual(records[0].head.toolChoice, { type: 'auto' });
  assert.equal(records[1].head.rest, '{"speed":"fast"}');
});
