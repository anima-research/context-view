import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JsonLike, maskRequest, maskRunDir, maskRunVarying, runVaryingMasker, sameBodies, selfCheckOf } from '../lib/strategies/compare.ts';
import type { SelfCheck } from '../lib/shapes.ts';

type Differs = Extract<SelfCheck, { outcome: 'differs' }>;
import * as compare from '../lib/strategies/compare.ts';

const sameAcrossRuns = (a: JsonLike, b: JsonLike) => JSON.stringify(maskRunVarying(a)) === JSON.stringify(maskRunVarying(b));
const sameRequests = (a: JsonLike, b: JsonLike) => JSON.stringify(maskRequest(a)) === JSON.stringify(maskRequest(b));

const body = ({ nonce = '2ie66y', seq = 1, signature = 'fx1.AAAA', text = 'hello [[c:c.chat.in]]', model = 'claude-opus-4-6' } = {}) => ({
  model,
  max_tokens: 2048,
  messages: [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'about it', signature }, { type: 'tool_use', id: 'toolu_fx000001', name: 'mcpl--fixture--result', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: [{ type: 'text', text: `[image: image/png, ~9KB, ref img_${nonce}_${seq}]\n[[c:c.tool.call2]]` }] }] },
  ],
});

test('a reader fork\'s epoch, in its name and its framing\'s header, is named by its first appearance in the run, and nothing else of either is', () => {
  const run = (epoch: string, other: string) => ({ messages: [
    { role: 'user', content: [{ type: 'text', text: `[Tune-out reader — chat, epoch ${epoch}, wake]` }] },
    { role: 'user', content: [{ type: 'text', text: `reader/fixture/${epoch}/1: [[c:h1.read]] words` }, { type: 'text', text: `reader/fixture/${other}/2: [[c:h2.read]] reader/fixture/${epoch}/3` }] },
  ] });
  const a = maskRunVarying(run('638fd205', '0a1b2c3d'));
  assert.deepEqual(a, maskRunVarying(run('c922c44e', '99887766')));
  assert.deepEqual(a.messages.map((m) => m.content.map((b) => b.text)), [['[Tune-out reader — chat, epoch E1, wake]'], ['reader/fixture/E1/1: [[c:h1.read]] words', 'reader/fixture/E2/2: [[c:h2.read]] reader/fixture/E1/3']]);
  assert.notDeepEqual(maskRunVarying(run('638fd205', '638fd205')), a, 'one epoch twice isn\'t two');
  const prose = { text: 'the epoch deadbeef of reader/x/abcdef12 and reader/x/abcdef12/ends' };
  assert.deepEqual(maskRunVarying(prose), prose, 'eight hex after "epoch" outside a framing header, or after a reader-shaped path with no fork number, is text');
  const epochs = new Map();
  const one = (epoch: string) => (runVaryingMasker(null, { runDir: null, epochs })({ text: `reader/fixture/${epoch}/1:` }) as { text: string }).text;
  assert.deepEqual([one('aaaaaaaa'), one('bbbbbbbb'), one('aaaaaaaa')], ['reader/fixture/E1/1:', 'reader/fixture/E2/1:', 'reader/fixture/E1/1:'], 'one map across a run\'s requests');
});

test('N12: two runs\' bodies that differ only in the image ledger\'s nonce and thinking signatures compare equal', { timeout: 30_000 }, () => {
  const a = body();
  const b = body({ nonce: 'nai651', signature: 'fx1.BBBB' });
  assert.notDeepEqual(a, b);
  assert.equal(sameAcrossRuns(a, b), true);
  assert.deepEqual(maskRunVarying(a), maskRunVarying(b));
  const record = (signature: string) => ({ kind: 'agent', messages: [{ role: 'assistant', blocks: [{ type: 'thinking', chars: 8, signature }] }] });
  assert.equal(sameAcrossRuns(record('fx1.AAAA'), record('fx1.CCCC')), true);
  assert.equal((a.messages[1].content[0] as { signature: string }).signature, 'fx1.AAAA');
  assert.match((a.messages[2].content[0] as { content: Array<{ text: string }> }).content[0].text, /img_2ie66y_1/);
});

test('N12: two runs\' bodies that differ only in a fork call\'s random UUID compare equal, and the fork\'s name still counts', () => {
  const fork = (name: string, uuid: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `fork-${name}-${uuid}`, name: 'subagent--fork', input: { name } }] });
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321741', '7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true);
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321742', 'd5641659-0a1b-4c2d-8e3f-123456789abc')), false);
  const result = (uuid: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-w9-${uuid}`, content: 'forked' }] });
  assert.equal(sameAcrossRuns(result('d5641659-0a1b-4c2d-8e3f-123456789abc'), result('7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true, 'its result names it the same way');
});

test('two runs\' Codex bodies that differ only in the prompt_cache_key membrane draws for each adapter compare equal, by its shape', () => {
  const codex = (key: string, text = 'user: [[c:c.cm.1.in]] hi') => ({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], store: false, stream: true, prompt_cache_key: key });
  const a = codex('d5641659-0a1b-4c2d-8e3f-123456789abc:0123456789ab');
  const b = codex('7271e5fa-9f8e-4d7c-b6a5-cba987654321:ba9876543210');
  assert.equal(sameRequests(a, b), true);
  assert.equal(maskRequest(a).prompt_cache_key, '<uuid>:<12 hex>');
  assert.equal(sameRequests(a, codex('7271e5fa-9f8e-4d7c-b6a5-cba987654321:ba9876543210', 'user: [[c:c.cm.1.in]] ho')), false, 'and a difference elsewhere still shows');
  assert.equal(maskRequest({ prompt_cache_key: 'fixture-key' }).prompt_cache_key, 'fixture-key', 'a key of another form is left as sent');
});

test('a string of the Codex key\'s shape is masked only as a request\'s own prompt_cache_key or its session_id header: anywhere else, a nested field of either name included, it is content, and a change to it shows', () => {
  const [a, b] = ['d5641659-0a1b-4c2d-8e3f-123456789abc:0123456789ab', 'd5641659-0a1b-4c2d-8e3f-123456789abc:ba9876543210'];
  const said = (text: string) => ({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], prompt_cache_key: a });
  assert.equal(sameRequests(said(`user: [[c:c.cm.1.in]] the id is ${a}`), said(`user: [[c:c.cm.1.in]] the id is ${b}`)), false);
  assert.equal(maskRequest(said(`id ${a}`)).input[0].content[0].text, `id ${a}`);
  assert.equal(maskRequest({ session_id: b }).session_id, '<uuid>:<12 hex>');
  const called = (v: string) => ({ model: 'claude-opus-5-5', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'look', input: { session_id: v } }] }], metadata: { prompt_cache_key: v } });
  assert.equal(sameRequests(called(a), called(b)), false, 'a nested session_id in a message\'s content, or a nested prompt_cache_key, is content');
  assert.equal(maskRequest({ prompt_cache_key: `${a} and more` }).prompt_cache_key, `${a} and more`, 'and only a value that is a key whole');
  assert.equal(maskRunVarying({ prompt_cache_key: b }).prompt_cache_key, b, 'a value masked as anything but a request keeps it');
});

test('a run\'s Codex keys are numbered by first appearance across the run, so the self-check sees which requests share a key: two keys made one differs', () => {
  const codex = (key: string) => ({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user: [[c:c.cm.1.in]] hi' }] }], store: false, stream: true, prompt_cache_key: key });
  const [a, b, c, d] = ['d5641659-0a1b-4c2d-8e3f-123456789abc:0123456789ab', '7271e5fa-9f8e-4d7c-b6a5-cba987654321:ba9876543210', '11111111-2222-4333-8444-555555555555:aaaaaaaaaaaa', '66666666-7777-4888-9999-000000000000:bbbbbbbbbbbb'];
  const keys = new Map();
  const mask = (v: unknown) => runVaryingMasker(keys).request(v) as { prompt_cache_key: string };
  assert.deepEqual([a, b, a].map((k) => mask(codex(k)).prompt_cache_key), ['<uuid>:<12 hex>#1', '<uuid>:<12 hex>#2', '<uuid>:<12 hex>#1']);
  const dir = mkdtempSync(join(tmpdir(), 'codex-keys-'));
  try {
    const drive = (name: string, ks: string[]) => { const d = join(dir, name); mkdirSync(d); ks.forEach((k, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(codex(k)))); return d; };
    const on = drive('on', [a, b, a]);
    assert.equal(sameBodies(on, drive('off', [c, d, c])).outcome, 'same', 'each drive draws its own keys, and they pair alike');
    const merged = sameBodies(on, drive('merged', [c, c, c]));
    assert.equal(merged.outcome, 'differs', 'the summariser given the agent\'s key');
    assert.equal(merged.at, 1);
    assert.match(merged.detail, /prompt_cache_key differs/);
    assert.equal(sameBodies(on, drive('split', [c, d, d])).outcome, 'differs', 'one key split in two');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N15: two runs\' bodies that differ only in a reminder id\'s four random characters compare equal; its time part, a second reminder, and a longer word still count', () => {
  const set = (text: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000032', content: `Reminder ${text} set: due 2026-01-05T09:17:08+00:00 [UTC] (~600s) | one-shot` }] });
  assert.equal(sameAcrossRuns(set('rem_mk0xssww_mvqs'), set('rem_mk0xssww_b5py')), true);
  assert.equal(maskRunVarying(set('rem_mk0xssww_mvqs')).content[0].content.startsWith('Reminder rem_mk0xssww_R1 set'), true);
  assert.equal(sameAcrossRuns(set('rem_mk0xssww_mvqs'), set('rem_mk0xsszz_mvqs')), false, 'the time part is the clock\'s, so it counts');
  assert.equal(sameAcrossRuns(set('rem_mk0xssww_mvqs and rem_mk0xssww_b5py'), set('rem_mk0xssww_mvqs and rem_mk0xssww_mvqs')), false, 'two reminders differ from one');
  assert.equal(sameAcrossRuns(set('rem_mk0xssww_mvqsx'), set('rem_mk0xssww_b5pyx')), false, 'five characters after it aren\'t a reminder\'s four');
});

test('N16: two runs\' bodies that differ only in a draft id\'s seven random characters compare equal, each id read as the draft it is by its first appearance; a second draft, a longer word, and characters outside its alphabet still count', () => {
  const receipt = (text: string) => ({ role: 'user', content: [{ type: 'text', text: `user: [delivered] nothing \u2014 1 plain-speech segment(s) held as draft ${text} (not sent \u2014 drafts can resend them unchanged, or dismiss them)` }] });
  assert.equal(sameAcrossRuns(receipt('d-mckugqs'), receipt('d-dgnk63a')), true);
  assert.equal(maskRunVarying(receipt('d-mckugqs, then d-dgnk63a, then d-mckugqs')).content[0].text.includes('held as draft d-D1, then d-D2, then d-D1 (not sent'), true);
  assert.equal(sameAcrossRuns(receipt('d-mckugqs and d-dgnk63a'), receipt('d-mckugqs and d-mckugqs')), false, 'two drafts differ from one');
  assert.equal(sameAcrossRuns(receipt('d-mckugqsx'), receipt('d-dgnk63ax')), false, 'eight characters aren\'t a draft id\'s seven');
  assert.equal(sameAcrossRuns(receipt('d-mckugq1'), receipt('d-dgnk631')), false, '1 is outside its alphabet');
  assert.equal(sameAcrossRuns(receipt('thread-mckugqs'), receipt('thread-dgnk63a')), false, 'a `d-` that ends a word isn\'t one');
});

test('N18: two runs whose history module shows other store sequences compare equal, each named by its first appearance across a search result\'s ids and skipSequences, an extract\'s aroundId and its result\'s anchorId and ids; an extract naming another message than the search found still differs, and a number in any other field is left as sent', () => {
  const searched = (skip: number | string, id: number | string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `{"scanned":209,"candidatePoolSize":213,"order":"oldest","truncated":false,"resume":{"from":"2026-01-05T11:01:52.000Z","skipSequences":[${skip},${id}]},"matches":[{"id":"${id}","text":"[[c:h.sent]]"}]}` }] });
  const extract = (around: number | string) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'history--extract', input: { aroundId: around, before: 0, after: 0, format: 'text' } }] });
  const extracted = (anchor: number | string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: `{"anchorId":"${anchor}","channelId":null,"returned":1,"messages":[{"id":"${anchor}","content":"[channel_publish] [[c:h.sent]]"}]}` }] });
  const run = (skip: number | string, id: number | string, around: number | string, anchor: number | string) => ({ messages: [searched(skip, id), extract(around), extracted(anchor)] });
  assert.equal(sameAcrossRuns(run(695, 791, '791', '791'), run(694, 792, '792', '792')), true);
  assert.equal(sameAcrossRuns(run(695, 791, '791', '791'), run(695, 791, '790', '790')), false, 'the extract around another message than the search found');
  assert.equal(sameAcrossRuns(run(695, 791, '791', '791'), run(695, 791, '791', '790')), false, 'an extract answering about another message than asked');
  const other = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: '{"delivered":true,"id":"791","messageId":"pub-1-42"}' }] };
  assert.deepEqual(maskRunVarying(other), other, 'an id outside a history result');
});

test('N18b: a history result quoted inside another text, as the reply judge\'s rendering of the agent\'s context quotes a search\'s and an extract\'s, names its ids by first appearance too, so two runs whose store sequences differ compare equal; an id in the text\'s next entry, past the quoted result, is left as sent', () => {
  const rendered = (id: number, after: number) => ({ role: 'user', content: [{ type: 'text', text: `user: # fixture's context\n\n[user] [history--search returned] {"scanned":269,"resume":{"skipSequences":[${id - 11},${id}]},"matches":[{"id":"${id}","text":"[[c:h.sent]]"}]}\n\n[user] [history--extract returned] {"anchorId":"${id}","returned":1,"messages":[{"id":"${id}","content":"[[c:h.sent]]"}]}\n\n[user] {"delivered":true,"id":"${after}"}` }] });
  assert.equal(sameAcrossRuns({ messages: [rendered(1061, 7)] }, { messages: [rendered(1062, 7)] }), true);
  assert.equal(sameAcrossRuns({ messages: [rendered(1061, 7)] }, { messages: [rendered(1062, 8)] }), false, 'an id outside the quoted results still differs');
});

test('N17: agent-framework\'s one constant example draft id, which its drafts tool\'s schema and its refusal quote, is left as sent wherever it stands, and a minted id beside it is still masked', () => {
  const tool = { name: 'drafts', description: 'Your held drafts.', input_schema: { type: 'object', properties: { draftIds: { type: ['array', 'null'], items: { type: 'string' }, description: 'read, resend, dismiss: draft ids such as "d-k7x3qm2", in order. null for list.' } } } };
  assert.deepEqual(maskRunVarying(tool), tool, 'the schema as sent');
  assert.equal(maskRunVarying({ type: 'text', text: 'draftIds must be a list of draft ids such as "d-k7x3qm2", or null; held as draft d-mckugqs' }).text, 'draftIds must be a list of draft ids such as "d-k7x3qm2", or null; held as draft d-D1');
});

test('N13: a run\'s own directory, and the session under its store, read the same from any run\'s directory; another path, and a text with no run named, are left as they are', () => {
  const gate = (run: string, session: string) => ({ type: 'text', text: `{"configPath":"${run}/store/sessions/${session}/config/gate.json","cwd":"${run}/work/input","other":"/etc/hosts"}` });
  const a = maskRunVarying(gate('/tmp/t/whole-host-ELZVUb/runs/H5_W12', '6d54967f'), { runDir: '/tmp/t/whole-host-ELZVUb/runs/H5_W12' });
  const b = maskRunVarying(gate('/runner/work/whole-host-WZgxfA/runs/H5_W12', 'a1b2c3d4'), { runDir: '/runner/work/whole-host-WZgxfA/runs/H5_W12' });
  assert.deepEqual(a, b);
  assert.equal(a.text, '{"configPath":"<run>/store/sessions/<session>/config/gate.json","cwd":"<run>/work/input","other":"/etc/hosts"}');
  assert.deepEqual(maskRunVarying(gate('/x/runs/A', 's1')), gate('/x/runs/A', 's1'), 'no run directory named, nothing masked');
  process.env.FIXTURE_RUN_DIR = '/x/runs/A';
  try {
    assert.equal(maskRunVarying(gate('/x/runs/A', 's1')).text, a.text, 'in the host, the directory its driver names in FIXTURE_RUN_DIR');
  } finally { delete process.env.FIXTURE_RUN_DIR; }
  const dir = mkdtempSync(join(tmpdir(), 'n13-'));
  try {
    const [on, off] = ['on', 'off'].map((side) => { const d = join(dir, side); mkdirSync(d); return d; });
    writeFileSync(join(on, 'r1.json'), JSON.stringify({ messages: [{ role: 'user', content: [gate('/w/runs/X', 'aaaa')] }] }));
    writeFileSync(join(off, 'r1.json'), JSON.stringify({ messages: [{ role: 'user', content: [gate('/w/runs/X.recording-off', 'bbbb')] }] }));
    assert.equal(sameBodies(on, off, { onRun: '/w/runs/X', offRun: '/w/runs/X.recording-off' }).outcome, 'same');
    assert.equal(sameBodies(on, off).outcome, 'differs', 'without each side\'s directory the paths differ');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N14: each id its run\'s lessons file lists reads as lesson-N, N its place in the file, wherever it stands on its own; a run with no lessons file masks none; a lessons file of another shape fails the mask, saying so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n14-'));
  const run = (name: string, lessons?: unknown) => {
    const d = join(dir, name);
    mkdirSync(join(d, 'store'), { recursive: true });
    if (lessons !== undefined) writeFileSync(join(d, 'store', 'lessons.json'), typeof lessons === 'string' ? lessons : JSON.stringify({ lessons }, null, 2));
    return d;
  };
  const seen = (a: string, b: string) => ({ type: 'text', text: `{"id":"${a}","message":"Lesson created"} then ${b}, ${a}` });
  try {
    const a = run('a', [{ id: '0a06e0ba', content: 'x' }, { id: '601bd5e7', content: 'y' }]);
    const b = run('b', [{ id: 'cd3e9a41', content: 'x' }, { id: '7f00b2c6', content: 'y' }]);
    const one = maskRunVarying(seen('0a06e0ba', '601bd5e7'), { runDir: a });
    assert.equal(one.text, '{"id":"lesson-1","message":"Lesson created"} then lesson-2, lesson-1');
    assert.equal(maskRunVarying('ff0a06e0ba and 0a06e0ba9 hold it', { runDir: a }), 'ff0a06e0ba and 0a06e0ba9 hold it', 'an id inside a longer word stays');
    assert.deepEqual(maskRunVarying(seen('cd3e9a41', '7f00b2c6'), { runDir: b }), one, 'two runs\' lessons, made in one order, read alike');
    assert.deepEqual(maskRunDir(seen('cd3e9a41', '7f00b2c6'), b), one, 'the recorder\'s mask reads them alike too');
    assert.notDeepEqual(maskRunVarying(seen('7f00b2c6', 'cd3e9a41'), { runDir: b }), one, 'lessons that answer in another order differ');
    const three = run('c', [{ id: '11111111' }, { id: '0a06e0ba' }, { id: '601bd5e7' }]);
    assert.notDeepEqual(maskRunVarying(seen('0a06e0ba', '601bd5e7'), { runDir: three }), one, 'a lesson more before them shows');
    const none = run('d');
    assert.deepEqual(maskRunVarying(seen('0a06e0ba', '601bd5e7'), { runDir: none }), seen('0a06e0ba', '601bd5e7'));
    writeFileSync(join(dir, 'e'), 'a file where a run would be');
    assert.deepEqual(maskRunVarying(seen('0a06e0ba', '601bd5e7'), { runDir: join(dir, 'e') }), seen('0a06e0ba', '601bd5e7'), 'nor does a run named by a path through a file');
    for (const [what, text] of ([['a list with no ids', [{ content: 'x' }]], ['an empty id', [{ id: '' }]], ['a bare list', '[{"id":"0a06e0ba"}]'], ['text that isn\'t JSON', '{"lessons": [']] as Array<[string, unknown]>)) {
      const bad = run(`bad-${what.replace(/\W+/g, '-')}`, text);
      assert.throws(() => maskRunVarying(seen('0a06e0ba', '601bd5e7'), { runDir: bad }), /lessons\.json isn't the shape the run-varying masker reads/, what);
      assert.throws(() => maskRunDir(seen('0a06e0ba', '601bd5e7'), bad), /lessons\.json isn't the shape the run-varying masker reads/, `${what}, in the recorder's mask`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N12: any difference outside the run-varying patterns compares unequal, the ref\'s sequence number and the order of keys included', { timeout: 30_000 }, () => {
  const a = body();
  for (const [what, b] of ([
    ['the ref\'s sequence number', body({ seq: 2 })],
    ['a character of a message', body({ text: 'hellp [[c:c.chat.in]]' })],
    ['the model', body({ model: 'claude-opus-4-5' })],
  ] as Array<[string, JsonLike]>)) assert.equal(sameAcrossRuns(a, b), false, what);
  const signed = (signature: string) => { const x = body(); (x.messages[1].content[1] as { signature?: string }).signature = signature; return x; };
  assert.equal(sameAcrossRuns(signed('fx1.YYYY'), signed('fx1.ZZZZ')), false, 'a signature on a block that isn\'t thinking');
  const { model, ...rest } = a;
  assert.equal(sameAcrossRuns(a, { ...rest, model }), false, 'the order of keys');
});

test('a fork\'s UUID is named by its first appearance in what one masker reads, so a call and a result that disagree still differ', () => {
  const pair = (callUuid: string, resultUuid: string) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `fork-w9-${callUuid}`, name: 'subagent--fork', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-w9-${resultUuid}`, content: 'forked' }] },
  ];
  const a = 'd5641659-0a1b-4c2d-8e3f-123456789abc';
  const b = '7271e5fa-9f8e-4d7c-b6a5-cba987654321';
  const masked = (messages: unknown[]) => { const mask = runVaryingMasker(); return JSON.stringify(messages.map(mask)); };
  assert.equal(masked(pair(a, a)), masked(pair(b, b)), 'the same pairing under another run\'s UUID');
  assert.notEqual(masked(pair(a, a)), masked(pair(a, b)), 'a result naming another fork than its call');
});

test('the self-check compares two arms\' request bodies in order, and names the pair where they first differ', () => {
  const arm = (bodies: unknown[]) => { const d = mkdtempSync(join(tmpdir(), 'arm-')); bodies.forEach((b, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(b))); writeFileSync(join(d, 'r1.answer.json'), '[]'); return d; };
  const on = arm([body(), body({ text: 'two [[c:c.chat.in]]' })]);
  const same = arm([body({ nonce: 'nai651' }), body({ text: 'two [[c:c.chat.in]]', nonce: 'q0q0q0' })]);
  const off = arm([body(), body({ text: 'twO [[c:c.chat.in]]' })]);
  try {
    assert.deepEqual(sameBodies(on, same), { outcome: 'same', requests: 2 }, 'answers aren\'t compared, and what differs by design is masked');
    const differs = sameBodies(on, off);
    assert.equal(differs.outcome, 'differs');
    assert.equal(differs.at, 1);
    assert.deepEqual(differs.files, ['r2.json', 'r2.json'], 'the pair a failing job keeps');
  } finally { for (const d of [on, same, off]) rmSync(d, { recursive: true, force: true }); }
});

test('image nonces are named by their first appearance in what one masker reads, so refs to two ledgers differ from refs to one', () => {
  const refs = (...nonces: string[]) => ({ role: 'user', content: nonces.map((n) => ({ type: 'text', text: `[ref img_${n}_1]` })) });
  assert.equal(sameAcrossRuns(refs('aaaaaa', 'bbbbbb'), refs('cccccc', 'dddddd')), true, 'two ledgers under other nonces');
  assert.equal(sameAcrossRuns(refs('aaaaaa', 'bbbbbb'), refs('cccccc', 'cccccc')), false, 'two ledgers against one');
  assert.match(JSON.stringify(maskRunVarying(refs('aaaaaa', 'bbbbbb', 'aaaaaa'))), /img_N1_1.*img_N2_1.*img_N1_1/);
});

test('the self-check counts an extra, a missing and an empty arm\'s bodies as differing, naming where', () => {
  const arm = (bodies: unknown[]) => { const d = mkdtempSync(join(tmpdir(), 'arm-')); bodies.forEach((b, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(b))); return d; };
  const two = arm([body(), body({ text: 'two [[c:c.chat.in]]' })]);
  const three = arm([body(), body({ text: 'two [[c:c.chat.in]]' }), body({ text: 'three [[c:c.chat.in]]' })]);
  const none = arm([]);
  try {
    const extra = sameBodies(three, two) as Differs;
    assert.deepEqual([extra.outcome, extra.at, extra.files![0]], ['differs', 2, 'r3.json'], 'recording on sent one more');
    assert.match(extra.detail, /3 requests with recording on, 2 with it off/);
    const missing = sameBodies(two, three) as Differs;
    assert.deepEqual([missing.outcome, missing.at], ['differs', 2], 'recording off sent one more');
    assert.match((sameBodies(none, two) as Differs).detail, /no request bodies were saved/);
    assert.deepEqual([sameBodies(two, none).outcome, (sameBodies(two, none) as Differs).at], ['differs', 0], 'an arm with none differs at its first');
  } finally { for (const d of [two, three, none]) rmSync(d, { recursive: true, force: true }); }
});

test('the mask keeps a key named __proto__ as the body has it, so a change to it still shows', () => {
  const a = maskRunVarying(JSON.parse('{"tools":[{"input_schema":{"properties":{"__proto__":{"type":"string"}}}}]}'));
  const b = maskRunVarying(JSON.parse('{"tools":[{"input_schema":{"properties":{"__proto__":{"type":"number"}}}}]}'));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.match(JSON.stringify(a), /"__proto__":\{"type":"string"\}/);
});

test('the self-check names the arm that failed, and can\'t judge where the arm with recording off recorded compiles', () => {
  const arm = () => { const d = mkdtempSync(join(tmpdir(), 'arm-')); writeFileSync(join(d, 'r1.json'), JSON.stringify(body())); return d; };
  const [onBodies, offBodies] = [arm(), arm()];
  try {
    const check = (on: { ok: boolean; reason?: string }, off: { ok?: boolean; reason?: string; log?: Array<{ kind?: string }>; couldnt?: string }) => compare.selfCheckOf({ on, off, onBodies, offBodies });
    assert.deepEqual(check({ ok: false, reason: 'x' }, { ok: true, log: [] }), { outcome: 'couldnt-run', reason: 'the run with recording on failed: x' });
    assert.deepEqual(check({ ok: true }, { ok: false, reason: 'y', log: [] }), { outcome: 'couldnt-run', reason: 'the run with recording off failed: y' });
    assert.deepEqual(check({ ok: true }, { couldnt: 'z' }), { outcome: 'couldnt-run', reason: 'the run with recording off couldn\'t run: z' });
    assert.deepEqual(check({ ok: true }, { couldnt: '' }), { outcome: 'couldnt-run', reason: 'the run with recording off couldn\'t run: ' }, 'an empty reason is still a reason');
    assert.deepEqual(check({ ok: true }, { ok: true, log: [{ kind: 'boot' }, { kind: 'compiles' }, { kind: 'compiles' }] }), { outcome: 'couldnt-run', reason: 'the run with recording off logged 2 compile batches, so the test module recorded though its recording was off' });
    assert.deepEqual(check({ ok: true }, { ok: true, log: [{ kind: 'boot' }] }), { outcome: 'same', requests: 1 });
  } finally { rmSync(onBodies, { recursive: true, force: true }); rmSync(offBodies, { recursive: true, force: true }); }
});

test('the self-check numbers a reader fork\'s epoch across each run\'s requests, so two requests that share one epoch with recording on and not with it off differ; and a failure reason with recording off names its epoch', () => {
  const body = (epoch: string) => ({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: [{ type: 'text', text: `reader/fixture/${epoch}/1: [[c:h1.read]] words` }] }] });
  const dir = mkdtempSync(join(tmpdir(), 'epochs-'));
  try {
    const drive = (name: string, es: string[]) => { const d = join(dir, name); mkdirSync(d); es.forEach((e, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(body(e)))); return d; };
    const on = drive('on', ['aaaaaaaa', 'aaaaaaaa']);
    assert.equal(sameBodies(on, drive('same', ['bbbbbbbb', 'bbbbbbbb'])).outcome, 'same');
    assert.equal(sameBodies(on, drive('split', ['bbbbbbbb', 'cccccccc'])).outcome, 'differs', 'one epoch split in two');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const failed = selfCheckOf({ on: { ok: true }, off: { ok: false, reason: 'reader/fixture/9f8e7d6c/2\'s turn ended in inference:aborted', log: [] } } as unknown as Parameters<typeof selfCheckOf>[0]) as Extract<SelfCheck, { outcome: 'couldnt-run' }>;
  assert.match(failed.reason, /reader\/fixture\/E1\/2's turn/);
});
