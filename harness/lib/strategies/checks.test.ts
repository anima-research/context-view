// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemblies, bindingControl, compileInvariants, pairing, reloads, requestPairs, declaredProducts, everyTurnAnswers, wellFormed, calibrationEdge, coverage, subOwners } from './checks.ts';
import { continuation, products, configurations, L3_PRODUCT } from './script.ts';
import { msg, text, call, result, carrying, store, panel, asked, opened, continued, started, sent, under } from '../testing/check-builders.ts';
import { blockRecord } from '../standin/view.ts';

test('check 2 names each segment whose product no record in it shows, and only those', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const records = [
    { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } },
    { id: 'r2', step: 'c.tool', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'), call('b')), msg('user', result('a'), result('b', 1))] },
    { id: 'r3', step: 'c.par', kind: 'agent', messages: [msg('assistant', call('a'), call('b'), call('c')), msg('user', result('a'), result('b'), result('c'))] },
  ];
  const missing = declaredProducts(records, script, wanted);
  assert.deepEqual(missing.map((m) => m.segment), ['close-merge', 'parallel', 'thinking-call', 'debt']);
  assert.deepEqual(missing[0].missing, ['a merge request', 'an L3 merge request']);
});

test('check 2: close-merge declares an L3 merge, which a merge at L3 meets with the merge product', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const l1 = { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } };
  const atLevel = (level) => ({ id: `m${level}`, step: 'c.cm.2', kind: 'summariser', level, answer: { shape: 'summary' } });
  const closeMerge = (records) => declaredProducts(records, script, wanted).find((m) => m.segment === 'close-merge')?.missing ?? [];
  assert.deepEqual(closeMerge([l1, atLevel(2)]), [L3_PRODUCT]);
  assert.deepEqual(closeMerge([l1, atLevel(3)]), []);
});

test('check 2: a configuration without adaptive resolution declares no long message stored in parts, which only adaptive resolution stores so, and its other close-merge products as one with it', () => {
  const closing = (config) => products(configurations()[config])['close-merge'].map((p) => p.name);
  assert.deepEqual(closing('H1'), ['an L1 compression request', 'a merge request', L3_PRODUCT, 'the long message stored in parts']);
  for (const config of ['C12h', 'C20h']) assert.deepEqual(closing(config), ['an L1 compression request', 'a merge request', L3_PRODUCT], config);
});

test('check 2: a configuration whose merge threshold is 0 (C19h), which queues the empty group and refuses it, declares no merge, and one of 2 (C18h) declares them as the default does', () => {
  const closing = (config) => products(configurations()[config])['close-merge'].map((p) => p.name);
  assert.deepEqual(closing('C19h'), ['an L1 compression request', 'the long message stored in parts']);
  assert.deepEqual(closing('C18h'), closing('H1'));
});

test('check 2: under a tool presentation the continuation ends with a catalogue stretch, a turn reading the catalogue past its revision and one calling set_tool_visibility with the hidden tool\'s name misspelt, each one call, and declares a request carrying each call\'s result; without a presentation the continuation is as it was', () => {
  const h7 = configurations().H7;
  const plain = continuation(configurations().H1);
  const steps = continuation(h7);
  assert.ok(!plain.some((s) => s.segment === 'catalogue'));
  const asBuilt = (s) => { const { copyStore, ...rest } = s; return rest; };
  assert.deepEqual(steps.slice(0, plain.length).map(asBuilt), plain.map(asBuilt), 'the stretches before it are the same steps, each as it was, but for the store copy the continuation\'s last checkpoint takes');
  const stretch = steps.slice(plain.length);
  assert.deepEqual(stretch.map((s) => [s.id, s.kind, s.segment]), [['c.cat.adv', 'advance', 'catalogue'], ['c.cat', 'channel', 'catalogue'], ['c.vis.adv', 'advance', 'catalogue'], ['c.vis', 'channel', 'catalogue'], ['c.catalogue.cp', 'checkpoint', 'catalogue']]);
  assert.equal(steps.at(-1).copyStore, true, 'the store is copied at the continuation\'s last checkpoint');
  const callsOf = (s) => s.replies.flatMap((r) => r.calls ?? []);
  assert.deepEqual(callsOf(stretch[1]), [{ name: 'workspace--read', input: { path: h7.agent.toolPresentation.cataloguePath, offset: 4, limit: 140 } }], 'the catalogue from the line after its revision, as many lines as the catalogue tells a resident to read: its revision hashes the presentation file\'s absolute path, which holds the run\'s directory');
  const hidden = Object.entries(JSON.parse(h7.files['tool-presentation.json']).tools).filter(([, t]) => t.visible === false).map(([name]) => name);
  assert.deepEqual(hidden, ['workspace--glob']);
  assert.deepEqual(callsOf(stretch[3]), [{ name: 'set_tool_visibility', input: { name: 'workspace--glbo', visible: true } }], 'the hidden tool\'s name with two letters swapped, a name no tool has');
  const wanted = products(h7);
  const READ = 'a request carrying the catalogue\'s read';
  const REFUSAL = 'a request carrying the visibility call\'s refusal';
  const answer = (id, isError, of = id, repairs) => ({ ...result(of), ...(isError ? { isError: true } : {}), ...(repairs ? { repairs } : {}) });
  const asked = (id, step, { isError = step === 'c.vis', of = id, round = `[[c:${step}.r0]]`, repairs } = {}) => ({ id, step, kind: 'agent', messages: [msg('user', text()), msg('assistant', text([round]), call(id)), msg('user', answer(id, isError, of, repairs))] });
  const missing = (records) => declaredProducts(records, steps, wanted).find((m) => m.segment === 'catalogue')?.missing ?? [];
  assert.deepEqual(missing([asked('r1', 'c.cat'), asked('r2', 'c.vis')]), []);
  assert.deepEqual(missing([asked('r1', 'c.cat')]), [REFUSAL]);
  assert.deepEqual(missing([asked('r2', 'c.vis')]), [READ]);
  assert.deepEqual(missing([asked('r1', 'c.cat'), { id: 'r2', step: 'c.vis', kind: 'agent', messages: [msg('user', text())] }]), [REFUSAL], 'a request at the step without the call\'s result');
  assert.deepEqual(missing([asked('r1', 'c.cat', { isError: true }), asked('r2', 'c.vis', { isError: false })]), [READ, REFUSAL], 'a read that failed, and a visibility call that changed something, aren\'t what the steps ask for');
  assert.deepEqual(missing([asked('r1', 'c.cat', { of: 'stale' }), asked('r2', 'c.vis', { of: 'stale' })]), [READ, REFUSAL], 'a result answering another call than the step\'s own');
  assert.deepEqual(missing([asked('r1', 'c.cat', { round: '[[c:c.par.r0]]' }), asked('r2', 'c.vis', { round: '[[c:c.cat.r0]]' })]), [READ, REFUSAL], 'a call made by a turn other than the step\'s own');
  assert.deepEqual(missing([asked('r1', 'c.cat', { repairs: ['context-manager:stub'] }), asked('r2', 'c.vis', { repairs: ['membrane:pending'] })]), [READ, REFUSAL], 'a repair\'s stub in the result\'s place');
});

test('check 2: a configuration that doesn\'t summarise declares no summariser products', () => {
  const missing = declaredProducts([], continuation(), products(configurations().H3));
  assert.deepEqual(missing.map((m) => m.segment), ['tool-round', 'parallel', 'thinking-call']);
});

test('check 1 flags unclassified and refused requests, failure events and unsettled steps', () => {
  const flags = everyTurnAnswers(
    [{ id: 'r1', step: 's', kind: 'agent' }, { id: 'r2', step: 's', kind: 'unclassified', reason: 'x' }, { id: 'r3', step: 't', kind: 'agent', refused: 'window' }],
    [{ kind: 'ipc', step: 'u', event: { type: 'inference:failed', error: 'boom' } }, { kind: 'settle', phase: 'end', step: 'v', settled: false }, { kind: 'settle', phase: 'end', step: 'w', settled: true }],
  );
  assert.deepEqual(flags.map((f) => f.step), ['s', 't', 'u', 'v']);
  assert.ok(flags.every((f) => f.check === 1));
});

test('check 3 flags roles out of turn and calls parted from their results, either way, in each request the stand-in answered, the reply judge\'s too, and none it refused unclassified', () => {
  const ok = { id: 'ok', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a')), msg('user', result('a'))] };
  const twice = { id: 'twice', step: 's', kind: 'agent', messages: [msg('user', text()), msg('user', text())] };
  const orphan = { id: 'orphan', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', text()), msg('user', result('a'))] };
  const unanswered = { id: 'unanswered', step: 's', kind: 'summariser', messages: [msg('assistant', call('a')), msg('user', text()), msg('assistant', text()), msg('user', text())] };
  const lastCall = { id: 'last', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'))] };
  const judgeTwice = { id: 'judge', step: 's', kind: 'judge', messages: [msg('user', text()), msg('user', text())] };
  const refused = { id: 'refused', step: 's', kind: 'unclassified', messages: [msg('user', text()), msg('user', text())] };
  const flags = wellFormed([ok, twice, orphan, unanswered, lastCall, judgeTwice, refused]);
  assert.deepEqual(flags.map((f) => f.request), ['twice', 'orphan', 'unanswered', 'judge']);
  assert.equal(flags.judged, 6);
});

test('check 3 reads a request whose codec writes each wire unit as a message by its turns: consecutive units on one side are one turn, a developer item takes none, and a result its turn\'s predecessor didn\'t call is still flagged', () => {
  const unit = (role, side, ...blocks) => ({ role, side, blocks });
  const ok = { id: 'ok', step: 's', kind: 'agent', messages: [unit('user', 'user', text()), unit('developer', 'system', text()), unit('reasoning', 'assistant', { type: 'redacted_thinking', chars: 10, sealed: true }), unit('assistant', 'assistant', text()), unit('function_call', 'assistant', call('a')), unit('function_call', 'assistant', call('b')), unit('function_call_output', 'user', result('a')), unit('function_call_output', 'user', result('b')), unit('user', 'user', text())] };
  const orphan = { id: 'orphan', step: 's', kind: 'agent', messages: [unit('user', 'user', text()), unit('assistant', 'assistant', text()), unit('function_call_output', 'user', result('a'))] };
  const flags = wellFormed([ok, orphan]);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['orphan', 'message 2\'s result a answers no call in the message before it']]);
});

test('check 3 reads a Chat Completions request\'s wire messages as messages: two assistant or two user messages in a row are out of turn, while a tool message joins its side\'s turn', () => {
  const unit = (role, side, ...blocks) => ({ role, side, blocks });
  const chat = (id, messages) => ({ id, step: 's', kind: 'agent', head: { api: 'chat-completions' }, messages });
  const ok = chat('ok', [unit('system', 'system', text()), unit('user', 'user', text()), unit('assistant', 'assistant', call('a'), call('b')), unit('tool', 'user', result('a')), unit('tool', 'user', result('b')), unit('user', 'user', text()), unit('assistant', 'assistant', text())]);
  const assistants = chat('assistants', [unit('user', 'user', text()), unit('assistant', 'assistant', text()), unit('assistant', 'assistant', text())]);
  const users = chat('users', [unit('user', 'user', text()), unit('user', 'user', text())]);
  const items = { ...assistants, id: 'items', head: { api: 'responses' } };
  assert.deepEqual(wellFormed([ok, assistants, users, items]).map((f) => [f.request, f.message]), [
    ['assistants', 'messages 1 and 2 are both assistant\'s'],
    ['users', 'messages 0 and 1 are both user\'s'],
  ]);
});

test('check 3 reads a Messages API request\'s consecutive messages of one role as one turn, as the API combines them: a prefill\'s two assistant messages and two user messages in a row pass, and a result its turn\'s predecessor didn\'t call is still flagged', () => {
  const messages = (id, ...ms) => ({ id, step: 's', kind: 'agent', head: { api: 'messages' }, messages: ms });
  const prefill = messages('prefill', msg('user', text()), msg('assistant', text()), msg('user', { type: 'image', chars: 10 }), msg('assistant', text()), msg('assistant', text()));
  const users = messages('users', msg('user', text()), msg('assistant', call('a')), msg('user', result('a')), msg('user', text()));
  const orphan = messages('orphan', msg('user', text()), msg('assistant', text()), msg('assistant', text()), msg('user', result('a')));
  const flags = wellFormed([prefill, users, orphan]);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['orphan', 'message 2\'s result a answers no call in the message before it']]);
});

test('check 3 flags, on the Messages API, a tool result after another block of its user turn, as the tool-use page says results come first: a user message between a call and its result, joined into the result\'s turn, and the one-message form; results first, then text, pass', () => {
  const messages = (id, ...ms) => ({ id, step: 's', kind: 'agent', head: { api: 'messages' }, messages: ms });
  const between = messages('between', msg('user', text()), msg('assistant', call('a')), msg('user', text()), msg('user', result('a')));
  const after = messages('after', msg('user', text()), msg('assistant', call('a')), msg('user', text(), result('a')));
  const first = messages('first', msg('user', text()), msg('assistant', call('a'), call('b')), msg('user', result('a'), result('b'), text()));
  const late = 'message 2\'s result a comes after another block of its turn, where the Messages API takes a turn\'s tool results first';
  assert.deepEqual(wellFormed([between, after, first]).map((f) => [f.request, f.message]), [['between', late], ['after', late]]);
  assert.deepEqual(wellFormed([{ ...after, head: { api: 'responses' } }]).map((f) => f.request), [], 'the rule is the Messages API\'s');
});

test('check 2 on the prefill formatter (H6) finds each tool round\'s products in the transcript\'s XML: the results each call\'s canary marks, the image as a user turn, its placeholder beside the image call\'s result, and the call that literal thinking leads', () => {
  const script = continuation();
  const wanted = products(configurations().H6);
  const callsOf = (segment) => script.find((st) => st.segment === segment && st.kind === 'channel').replies.flatMap((r) => r.calls ?? []).map((c) => c.input.canary);
  const [prose, image] = callsOf('tool-round');
  const parallel = callsOf('parallel');
  const [thought] = callsOf('thinking-call');
  const xml = (more) => ({ type: 'text', chars: 10, ...more });
  const record = (id, step, ...ms) => ({ id, step, kind: 'agent', head: { api: 'messages' }, messages: [msg('user', text()), ...ms] });
  const records = [
    record('r1', 'c.tool', msg('assistant', xml({ xmlResults: [prose, image] })), msg('user', { type: 'image', chars: 10 }), msg('assistant', text())),
    record('r2', 'c.par', msg('assistant', xml({ xmlResults: [image], xmlPlaceheld: [image], placeholders: 1 })), msg('assistant', xml({ xmlResults: parallel }))),
    record('r3', 'c.think', msg('assistant', xml({ xmlThoughtCalls: [thought], xmlResults: [thought] }))),
  ];
  const missing = (rs) => declaredProducts(rs, script, wanted).filter((m) => ['tool-round', 'parallel', 'thinking-call'].includes(m.segment));
  assert.deepEqual(missing(records), []);
  assert.deepEqual(missing([{ ...records[0], messages: records[0].messages.filter((m) => m.role !== 'user' || !m.blocks.some((b) => b.type === 'image')) }, ...records.slice(1)]).map((m) => m.missing), [['a prefill carrying both results, the image as a user turn of its own']], 'a round whose image went nowhere');
  assert.deepEqual(missing([records[0], record('r2', 'c.par', msg('assistant', xml({ xmlResults: [image], xmlPlaceheld: [image], placeholders: 1 })), msg('user', { type: 'image', chars: 10 }), msg('assistant', xml({ xmlResults: parallel }))), records[2]]).map((m) => m.missing), [['the tool round\'s image as its placeholder']], 'an image still sent');
  assert.deepEqual(missing([records[0], record('r2', 'c.par', msg('assistant', xml({ xmlResults: [image, ...parallel], xmlPlaceheld: [parallel[0]], placeholders: 1 }))), records[2]]).map((m) => m.missing), [['the tool round\'s image as its placeholder']], 'a placeholder in another call\'s result');
  assert.deepEqual(missing([record('r1', 'c.tool', msg('assistant', xml({ xmlResults: [prose, image] })), msg('user', text()), msg('user', { type: 'image', chars: 10 })), ...records.slice(1)]).map((m) => m.missing), [['a prefill carrying both results, the image as a user turn of its own']], 'an image that doesn\'t follow its result');
  assert.deepEqual(missing([record('r1', 'c.tool', msg('assistant', xml({ xmlResults: [prose, image] })), msg('assistant', text()), msg('user', { type: 'image', chars: 10 }), msg('assistant', text())), ...records.slice(1)]).map((m) => m.missing), [], 'a cache marker\'s split between the result and its image');
  assert.deepEqual(missing([records[0], records[1], record('r3', 'c.think', msg('assistant', xml({ xmlResults: [thought] })))]).map((m) => m.missing), [['the call\'s prefill carrying the reply\'s thinking']], 'a call no thinking led');
});

test('check 2 reads a Chat Completions request\'s turns as check 3 does: results followed by two user messages in a row are not the last turn\'s', () => {
  const unit = (role, side, ...blocks) => ({ role, side, blocks });
  const parallel = products(configurations().P5).parallel.find((p) => p.name === 'a request carrying the three results');
  const record = (api, ...tail) => ({ id: 'r', step: 's', kind: 'agent', head: { api }, messages: [unit('user', 'user', text()), unit('assistant', 'assistant', call('a'), call('b'), call('c')), unit('tool', 'user', result('a')), unit('tool', 'user', result('b')), unit('tool', 'user', result('c')), ...tail] });
  assert.equal(parallel.test(record('chat-completions')), true, 'the three results are the last turn');
  assert.equal(parallel.test(record('chat-completions', unit('user', 'user', text()))), true, 'and a user message after them joins it');
  assert.equal(parallel.test(record('chat-completions', unit('user', 'user', text()), unit('user', 'user', text()))), false, 'but a second user message in a row is a turn of its own');
});

test('check 2 finds a Responses request\'s products across its items: two results, one an image, in its last turn, and a call led by reasoning the stand-in sealed', () => {
  const script = continuation();
  const wanted = products(configurations().P1);
  const think = script.find((st) => st.segment === 'thinking-call' && st.kind === 'channel').replies.flatMap((r) => r.calls ?? []).map((c) => c.input.canary);
  const unit = (role, side, ...blocks) => ({ role, side, blocks });
  const records = [
    { id: 'r2', step: 'c.tool', kind: 'agent', messages: [unit('user', 'user', text()), unit('function_call', 'assistant', call('a')), unit('function_call', 'assistant', call('b')), unit('function_call_output', 'user', result('a')), unit('function_call_output', 'user', result('b', 1))] },
    { id: 'r3', step: 'c.think', kind: 'agent', messages: [unit('user', 'user', text()), unit('reasoning', 'assistant', { type: 'redacted_thinking', chars: 10, sealed: true }), unit('function_call', 'assistant', call('t')), unit('function_call_output', 'user', { ...result('t'), canaries: [think[0]] })] },
  ];
  const missing = declaredProducts(records, script, wanted).map((m) => m.segment);
  assert.ok(!missing.includes('tool-round') && !missing.includes('thinking-call'), missing.join(' '));
  const unsealed = records.map((r) => (r.id === 'r3' ? { ...r, messages: r.messages.map((m) => (m.role === 'reasoning' ? unit('reasoning', 'assistant', { type: 'redacted_thinking', chars: 10, sealed: false }) : m)) } : r));
  assert.ok(declaredProducts(unsealed, script, wanted).map((m) => m.segment).includes('thinking-call'), 'reasoning the stand-in didn\'t mint leads no call');
});

test('check 2: on OpenAI\'s Chat Completions (P5) thinking-call declares nothing, since no reasoning is sent, and tool-round declares its two results with the image as membrane\'s text in its place, since a tool message carries text only', () => {
  const script = continuation();
  const wanted = products(configurations().P5);
  assert.deepEqual(wanted['thinking-call'], []);
  const unit = (role, side, ...blocks) => ({ role, side, blocks });
  const round = (image) => ({ id: 'r2', step: 'c.tool', kind: 'agent', messages: [unit('user', 'user', text()), unit('assistant', 'assistant', call('a'), call('b')), unit('tool', 'user', result('a')), unit('tool', 'user', { ...result('b'), ...image })] });
  const missing = (records) => declaredProducts(records, script, wanted).map((m) => m.segment);
  assert.ok(!missing([round({ imagesNotShown: 1 })]).includes('tool-round'));
  assert.ok(missing([round({ images: 1 })]).includes('tool-round'), 'an image carried as an image isn\'t what this API carries');
  assert.ok(!missing([]).includes('thinking-call'));
});

test('check 10 flags a multiplier at either clamp edge, wherever the health panel puts it, and nothing inside them', () => {
  const at = (m) => ({ kind: 'checkpoint', step: 's', name: 'n', health: { contextComposition: { fixture: { calibration: { multiplier: m } } } } });
  const flags = calibrationEdge([at(1.3), at(0.6), at(1.8), at(1.79), { kind: 'settle' }]);
  assert.deepEqual(flags.map((f) => f.message.match(/\(([\d.]+)\)/)[1]), ['0.6', '1.8']);
});

test('check 10 says it couldn\'t judge where a health read failed, or where a completed adaptive run logged no end-of-run read at all', () => {
  const end = { kind: 'end', ok: true };
  const read = (health, more = {}) => ({ kind: 'health', name: 'end', step: 's.9', health, ...more });
  const whats = (log, adaptive = true) => calibrationEdge(log, { adaptive }).map((f) => f.what);
  assert.deepEqual(whats([read({ ok: true, data: { contextComposition: { fixture: { calibration: { multiplier: 1.2 } } } } }), end]), []);
  assert.deepEqual(whats([read({ ok: false, error: 'healthSnapshot threw' }), end]), ['unread-panel'], 'a panel op that failed');
  assert.deepEqual(whats([read({ ok: false, error: '' }), end]), ['unread-panel'], 'one that failed with an empty error');
  assert.deepEqual(whats([read({ ok: true, data: { contextComposition: {}, readFailures: { fixture: { contextComposition: 'getRenderStats threw' } } } }), end]), ['unread-panel'], 'a composition read that threw');
  assert.deepEqual(whats([read(undefined, { skipped: 'the run\'s last step stopped its host' }), end]), [], 'an end read the driver says it skipped');
  assert.deepEqual(whats([end]), ['no-end-read'], 'a completed adaptive run with no end read, read or skipped');
  assert.deepEqual(whats([end], false), [], 'not for a passthrough run');
  assert.deepEqual(whats([{ kind: 'end', ok: false }]), [], 'nor for a run that failed before its end');
});

test('K1: check 1 flags the operator alerts the host raises, naming each one\'s kind and message', () => {
  const alert = (step, kind, message) => ({ kind: 'ipc', step, event: { type: 'ops:alert', kind, agentName: 'fixture', message } });
  const flags = everyTurnAnswers([], [
    alert('c.debt', 'compression-quarantine', '1 span(s) in compression quarantine'),
    alert('c.cm.2', 'context-maintenance-failed', 'the tick threw'),
    alert('c.par', 'mcpl-down', 'MCPL server unreachable'),
    { kind: 'ipc', step: 'c.par', event: { type: 'inference:speech' } },
  ]);
  assert.deepEqual(flags.map((f) => [f.check, f.step]), [[1, 'c.debt'], [1, 'c.cm.2'], [1, 'c.par']]);
  assert.match(flags[0].message, /compression-quarantine.*1 span\(s\) in compression quarantine/);
  assert.match(flags[1].message, /context-maintenance-failed.*the tick threw/);
  assert.deepEqual(flags.map((f) => f.what), ['compression-quarantine', 'context-maintenance-failed', 'mcpl-down'], 'K1b: each carries its kind');
  const designed = [{ id: 'w.over', segment: 'w', mayFail: true }, { id: 'w.next', segment: 'w' }];
  const owned = everyTurnAnswers([], [
    { kind: 'ipc', step: 'w.over', event: { type: 'inference:failed' } },
    alert('w.over', 'context-refusal', 'the context was refused'),
    alert('w.over', 'mcpl-down', 'MCPL server unreachable'),
    alert('w.next', 'context-refusal', 'the context was refused'),
  ], designed);
  assert.deepEqual(owned.map((f) => [f.step, f.what]), [['w.over', 'mcpl-down'], ['w.next', 'context-refusal']]);
});

test('requestPairs: each compiled assembly takes the request that arrives after it, before its agent compiles again; a refusal retried in its assembly counts once; a subagent\'s requests pair only with its own lines', () => {
  const withCanary = (r, canary, agent, arrived) => ({ ...r, ...(agent ? { agent } : {}), arrived: String(arrived), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const p1 = withCanary(opened('p1', 'a', 1_000, undefined, ['t1']), '[[c:a.in]]', 'primary', 11);
  const s1 = withCanary(opened('s1', 'a', 900), '[[c:a.task]]', 'sub', 21);
  const p2 = withCanary(continued(p1, 'p2', 1_100), '[[c:a.in]]', 'primary', 31);
  const p3 = withCanary(opened('p3', 'a', 1_000), '[[c:b.in]]', 'primary', 41);
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, agent, assembly, content, stamp, outcome = 'compiled') => ({ seq, agent, kind: 'request', assembly, outcome, ...(stamp ? { stamp: String(stamp) } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 'fixture', 1, 'x1', 10), line(2, 'knowledge', 1, 'xs', 20), line(3, 'fixture', 2, 'x3', null, 'refused'), line(4, 'fixture', 2, 'x3', 40)], blobs: { ...b('x1', '[[c:a.in]]'), ...b('xs', '[[c:a.task]]'), ...b('x3', '[[c:b.in]]') } },
    { kind: 'compiles', step: 'b', boot: 1, lines: [line(5, 'fixture', 3, 'x5', null, 'refused')], blobs: b('x5', '[[c:b.again]]') },
  ];
  assert.deepEqual(assemblies(log).map((l) => [l.seq, l.outcome, l.step]), [[1, 'compiled', 'a'], [4, 'compiled', 'a'], [5, 'refused', 'b']], 'a retried refusal counts once, by its last line; a refusal not retried stays');
  const primary = requestPairs([p1, s1, p2, p3], log);
  assert.deepEqual(primary.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'p1'], [4, 'p3']]);
  assert.deepEqual(primary.continuations.map((r) => r.id), ['p2']);
  assert.deepEqual([primary.unpaired, primary.disagree], [[], []]);
  const sub = requestPairs([p1, s1, p2, p3], log, 'knowledge');
  assert.deepEqual(sub.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[2, 's1']], 'the second agent\'s lines pair with the stand-in\'s sub requests alone');
  assert.equal(requestPairs([p1], []), null);
});

test('requestPairs by the clock: a round between two compiles carrying one canary stays a round', () => {
  const at = (id, canary, arrived) => {
    const r = opened(id, 'h', 1_000);
    return { ...r, arrived: String(arrived), messages: [{ ...r.messages[0], blocks: [text(canary ? [canary] : undefined)] }] };
  };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: canary ? `${canary} words` : '[Tune-out wake: chat \u2014 1 addressed message]' }] } });
  const line = (seq, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const restart = [{ kind: 'compiles', step: 'h', lines: [line(1, 'x', 10), line(2, 'x', 40)], blobs: b('x', '[[c:h.in]]') }];
  const rounds = requestPairs([at('r1', '[[c:h.in]]', 11), at('ra', '[[c:h.in]]', 21), at('rb', '[[c:h.in]]', 41)], restart);
  assert.deepEqual(rounds.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'r1'], [2, 'rb']], 'the round sent before the second compile doesn\'t take it');
  assert.deepEqual(rounds.continuations.map((r) => r.id), ['ra']);
});

test('requestPairs by the clock: a compile never sent leaves the next compile\'s request to it, though the request carries its canary', () => {
  const at = (id, canary, arrived) => {
    const r = opened(id, 'h', 1_000);
    return { ...r, arrived: String(arrived), messages: [{ ...r.messages[0], blocks: [text(canary ? [canary] : undefined)] }] };
  };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: canary ? `${canary} words` : '[Tune-out wake: chat \u2014 1 addressed message]' }] } });
  const line = (seq, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const unsent = [{ kind: 'compiles', step: 'h', lines: [line(1, 'x', 10), line(2, 'x', 20), line(3, 'x', 30)], blobs: b('x', '[[c:h.in]]') }];
  const retried = requestPairs([at('r1', '[[c:h.in]]', 11), at('r3', '[[c:h.in]]', 31)], unsent);
  assert.deepEqual(retried.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'r1'], [3, 'r3']]);
  assert.deepEqual(retried.unpaired.map((l) => l.seq), [2], 'named unsent, though the next request carries its canary');
  const wake = [{ kind: 'compiles', step: 'h', lines: [line(1, 'w', 10)], blobs: b('w', null) }];
  assert.deepEqual(requestPairs([at('r1', null, 11)], wake).pairs.map(({ request }) => request.id), ['r1'], 'a compile and request with no canary at all');
});

test('requestPairs: a compile or request with no stamp, or a pair whose request doesn\'t end on its compile\'s last canary, leaves check 13 judging nothing of the agent, never pairing silently', () => {
  const r1 = { ...opened('r1', 'h', 1_000), messages: [{ role: 'user', digest: 'd', blocks: [text(['[[c:h.in]]'])] }] };
  const b = { x: { role: 'user', content: [{ type: 'text', text: '[[c:h.in]] words' }] }, y: { role: 'user', content: [{ type: 'text', text: '[[c:h.other]] words' }] } };
  const line = (content, stamp) => ({ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', ...(stamp ? { stamp } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = (l) => [{ kind: 'compiles', step: 'h', lines: [l], blobs: b }];
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('x'))).map((f) => f.what), ['fixture:unstamped'], 'a compile with no stamp');
  assert.deepEqual(pairing([r1], log(line('x', '10'))).map((f) => f.what), ['fixture:unstamped'], 'a request with no arrival stamp');
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('y', '10'))).map((f) => f.what), ['fixture:disagree']);
  assert.equal(pairing([{ ...r1, arrived: '11' }], log(line('y', '10'))).judged, 0, 'a disagreement judges nothing, so the run doesn\'t measure');
  assert.equal(pairing([r1], log(line('x', '10'))).judged, 0, 'nor does a missing stamp');
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('x', '10'))), []);
});

test('check 13 reads a call\'s input on both sides, so a request whose last canary is a say\'s, inside its call, pairs with its compile and is judged', () => {
  const say = { channelId: 'chat', content: '[[c:w.8.say1]] said' };
  const wire = [
    { role: 'user', content: [{ type: 'text', text: '[[c:w.8.in]] words' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send_message', input: say }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] },
  ];
  const request = { ...opened('r1', 'w.9', 1_000), arrived: '11', messages: wire.map((m, i) => ({ role: m.role, digest: `d${i}`, blocks: m.content.map((b) => blockRecord(b)) })) };
  const blobs = {
    x1: { participant: 'Tavy', content: [{ type: 'text', text: '[[c:w.8.in]] words' }] },
    x2: { participant: 'fixture', content: [{ type: 'tool_use', id: 't1', name: 'send_message', input: say }] },
    x3: { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'sent' }] },
  };
  const log = [{ kind: 'compiles', step: 'w.9', blobs, lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: ['x1', 'x2', 'x3'].map((content) => ({ sources: ['r:1'], content })) }] }];
  const flags = pairing([request], log);
  assert.deepEqual(flags, []);
  assert.equal(flags.judged, 1);
});

test('check 13: a request compile no stand-in request took is a flag at its batch\'s step; a run whose compiles all paired, or with no compile lines, has none', () => {
  const r1 = { ...opened('r1', 'a', 1_000, undefined, ['t1']), arrived: '11' };
  r1.messages[0] = { ...r1.messages[0], blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
    { kind: 'compiles', step: 'b', lines: [line(2, 2, 'x2', 20)], blobs: b('x2', '[[c:b.in]]') },
  ];
  const flags = pairing([r1], log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [[13, 'b', 'fixture:unpaired']]);
  assert.match(flags[0].message, /compile 2 \(assembly 2\) went out in no request: none arrived at the stand-in after it/);
  assert.deepEqual(pairing([r1], log.slice(0, 1)), []);
  assert.deepEqual(pairing([r1], []), [], 'no compile lines: nothing to pair');
});

test('check 13: an unpaired compile\'s flag carries the host\'s inference:failed, inference:exhausted, inference:aborted and inference:waiting events of its step whole, as logged, beside a message that stays its own', () => {
  const r1 = { ...opened('r1', 'a', 1_000, undefined, ['t1']), arrived: '11' };
  r1.messages[0] = { ...r1.messages[0], blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const ipc = (step, event) => ({ kind: 'ipc', step, at: 1, event });
  const stack = `Error: socket closed\n${Array.from({ length: 60 }, (_, i) => `    at frame${i} (/m/connectome-host/node_modules/@animalabs/membrane/dist/x.js:${i}:1)`).join('\n')}`;
  const failed = { type: 'inference:failed', agentName: 'fixture', error: 'The socket connection was closed unexpectedly.', stack };
  const waiting = { type: 'inference:waiting', agentName: 'fixture', until: 1_000 };
  const exhausted = { type: 'inference:exhausted', agentName: 'fixture', error: 'gave up', errorType: 'network', retryable: true };
  const aborted = { type: 'inference:aborted', agentName: 'fixture', reason: 'interrupted' };
  const log = [
    ipc('a', { type: 'inference:failed', agentName: 'fixture', error: 'an earlier step\'s failure', stack: 'Error: earlier' }),
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
    ipc('b', { type: 'inference:started', agentName: 'fixture' }),
    ipc('b', failed),
    ipc('b', waiting),
    ipc('b', exhausted),
    ipc('b', aborted),
    { kind: 'compiles', step: 'b', lines: [line(2, 2, 'x2', 20)], blobs: b('x2', '[[c:b.in]]') },
  ];
  const [flag, ...rest] = pairing([r1], log);
  assert.deepEqual(rest, []);
  const own = 'fixture\'s request compile 2 (assembly 2) went out in no request: none arrived at the stand-in after it and before the agent\'s next compile, so agent-framework never sent it, or the pairing went wrong';
  assert.equal(flag.message, own, 'the message, which the summaries and run.json read, is as it was');
  assert.ok(!('detail' in flag) && !('full' in flag));
  assert.deepEqual(flag.events, [
    'the host\'s inference:failed, inference:exhausted, inference:aborted and inference:waiting events in step b, every agent\'s, as logged:',
    JSON.stringify(failed),
    JSON.stringify(waiting),
    JSON.stringify(exhausted),
    JSON.stringify(aborted),
  ], 'the step\'s failure, its stack uncut, its wait, its giving up and its abort, in the order logged; not another step\'s failure, nor a start');
  const quiet = pairing([r1], log.filter((e) => e.kind !== 'ipc'));
  assert.equal(quiet[0].message, own);
  assert.deepEqual(quiet[0].events, ['the host logged no inference:failed, inference:exhausted, inference:aborted or inference:waiting event in step b']);
  assert.deepEqual(pairing([r1], [...log.filter((e) => e.kind === 'ipc'), log[1]]), [], 'a run whose compiles all paired gains nothing from its events');
  const boot = [
    ipc(null, failed),
    ipc('a', { type: 'inference:failed', agentName: 'fixture', error: 'a step\'s failure', stack: 'Error: step' }),
    { kind: 'compiles', step: null, lines: [line(2, 2, 'x2', 5)], blobs: b('x2', '[[c:b.in]]') },
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
  ];
  const [first] = pairing([r1], boot);
  assert.equal(first.step, 'the run');
  assert.deepEqual(first.events, [
    'the host\'s inference:failed, inference:exhausted, inference:aborted and inference:waiting events before the first step, every agent\'s, as logged:',
    JSON.stringify(failed),
  ], 'a compile of the first boot, before any step, is given the events the driver logged before the first step');
});

test('check 12: the dry compile after a restart matches the one before, with image-ref nonces masked; a difference, a changed outcome and a missing line are flags', () => {
  const dry = (seq, contents, system = 'sys', outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'dry', outcome, ...(outcome === 'refused' ? { error: { class: 'OverBudgetError' } } : {}), messages: contents.map((content, i) => ({ sources: [`r:m${i}`], content })), system });
  const blobs = { a: 'one [ref img_loxiqa_1]', b: 'two', a2: 'one [ref img_68l20r_1]', c: 'three', sys: [{ text: 'x' }] };
  const run = (before, after) => [
    { kind: 'compiles', boot: 1, lines: [before], blobs },
    { kind: 'compiles', boot: 2, lines: [after], blobs: {} },
    { kind: 'reload', step: 'r.restart', agent: 'fixture', before: { boot: 1, seq: before.seq }, after: { boot: 2, seq: after.seq } },
  ];
  assert.deepEqual(reloads(run(dry(7, ['a', 'b']), dry(1, ['a2', 'b']))), [], 'a nonce made fresh by the new process is no difference');
  const changed = reloads(run(dry(7, ['a', 'b']), dry(1, ['a', 'c'])));
  assert.deepEqual(changed.map((f) => [f.check, f.step]), [[12, 'r.restart']]);
  assert.match(changed[0].message, /differs from the one before at message 1 of 2 before and 2 after/);
  assert.match(reloads(run(dry(7, ['a']), dry(1, [], 'sys', 'refused')))[0].message, /refused \(OverBudgetError\), where before it compiled/);
  const moved = dry(1, ['a', 'b']);
  moved.messages[1] = { ...moved.messages[1], sources: ['r:m9'] };
  const resourced = reloads(run(dry(7, ['a', 'b']), moved));
  assert.equal(resourced.length, 1);
  assert.match(resourced[0].message, /differs from the one before at message 1 of 2 before and 2 after \(sources \["r:m1"\] before, \["r:m9"\] after\)/, 'the same content from another stored message');
  const resystemed = reloads(run(dry(7, ['a', 'b']), dry(1, ['a', 'b'], 'c')));
  assert.deepEqual(resystemed.map((f) => f.message), ['after the restart the dry compile\'s system injections differ from the ones before']);
  const missing = reloads([{ kind: 'compiles', boot: 1, lines: [dry(7, ['a'])], blobs }, { kind: 'reload', step: 'r.restart', before: { boot: 1, seq: 7 }, after: { boot: 2, seq: null } }]);
  assert.match(missing[0].message, /couldn't judge the reload: the log holds no dry compile line after it/);
});

test('check 11: each breach a compile line carries is a flag, named by agent, kind and invariant, and so is a compile the module couldn\'t record', () => {
  const log = [
    { kind: 'compiles', step: 'a', lines: [
      { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [] },
      { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'budget', detail: '30100 tokens against an input budget of 29952 and a grace of 0' }] },
    ] },
    { kind: 'settle', step: 'b' },
    { kind: 'compiles', step: 'b', lines: [
      { seq: 3, agent: 'fixture', kind: 'other', outcome: 'refused', violations: [] },
      { seq: 4, agent: 'researcher', kind: 'dry', outcome: 'unrecordable', reason: 'getAllMessages threw' },
      { seq: 5, agent: 'researcher', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: m9' }, { invariant: 'shape', detail: 'message 2: result t1 answers no call in the message before it' }] },
    ] },
  ];
  const flags = compileInvariants(log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [
    [11, 'a', 'fixture:request:budget'],
    [11, 'b', 'researcher:dry:unrecordable'],
    [11, 'b', 'researcher:request:coverage'],
    [11, 'b', 'researcher:request:shape'],
  ]);
  assert.match(flags[0].message, /fixture's request compile 2 breaks budget: 30100 tokens/);
  assert.match(flags[1].message, /couldn't record researcher's dry compile 4: getAllMessages threw/);
  assert.deepEqual(compileInvariants([]), [], 'a log with no compile lines has nothing to flag');
  assert.equal(flags.besides, undefined, 'nothing unplaced, nothing beside the count');
  const unplaced = compileInvariants([{ kind: 'compiles', step: 'a', lines: [
    { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unplaced', count: 2, detail: 'store order couldn\'t place 2 of what was sent' }] },
    { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unplaced', count: 1, detail: 'store order couldn\'t place 1 of what was sent' }] },
  ] }]);
  assert.deepEqual([unplaced.length, unplaced.judged, unplaced.besides], [2, 2, 'the order couldn\'t place 3 of what was sent'], 'each a flag, the compiles judged, and the count beside them');
  assert.match(unplaced[0].message, /^couldn't judge all of fixture's request compile 1: store order couldn't place 2/, 'a couldn\'t-judge, not a breach');
  const besides = compileInvariants([{ kind: 'compiles', step: 'a', lines: [
    { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [], unjudged: ['budget: PassthroughStrategy gives no render stats'] },
    { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unreadable', detail: 'listPins: failed; pins weren\'t judged' }], unjudged: ['budget: PassthroughStrategy gives no render stats'] },
  ] }]);
  assert.deepEqual(besides.map((f) => [f.what, f.message]), [['fixture:request:unreadable', 'couldn\'t judge all of fixture\'s request compile 2: listPins: failed; pins weren\'t judged']], 'a budget its strategy gives no stats for is counted, not flagged');
  assert.equal(besides.besides, 'budget couldn\'t be judged in 2, as PassthroughStrategy gives no render stats; 1 read an invariant needed failed');
  const judgedOnly = compileInvariants([{ kind: 'compiles', step: 'a', lines: [
    { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unreadable', read: false, detail: 'the compile gave no render stats, though its strategy S reports them; budget wasn\'t judged' }] },
  ] }]);
  assert.equal(judgedOnly.length, 1, 'it stays a flag');
  assert.equal(judgedOnly.besides, undefined, 'and counts as no failed read');
});

test('K5: close-merge declares its long message stored in parts, from the store, and parallel the tool round\'s image reaching it as its placeholder', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const segment = (missing, name) => missing.find((m) => m.segment === name)?.missing ?? [];
  const parts = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'], bodyGroupId: 'g', shardIndex: 0 }, { id: 'm2', canaries: [], bodyGroupId: 'g', shardIndex: 1 }], summaries: [] };
  const whole = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'] }], summaries: [] };
  const LONG = 'the long message stored in parts';
  assert.ok(!segment(declaredProducts([], script, wanted, parts), 'close-merge').includes(LONG));
  assert.ok(segment(declaredProducts([], script, wanted, whole), 'close-merge').includes(LONG));
  assert.ok(!segment(declaredProducts([], script, wanted, null), 'close-merge').includes(LONG), 'with no store read, the store\'s product waits on none');
  const PLACEHOLDER = 'the tool round\'s image as its placeholder';
  const imageCall = script.find((s) => s.id === 'c.tool').replies[0].calls.find((c) => c.input.kind === 'image').input.canary;
  const carryingResult = (images, placeholders) => ({ id: 'r', step: 'c.par', kind: 'agent', messages: [msg('user', { type: 'tool_result', chars: 61, toolUseId: 't', canaries: [imageCall], ...(images ? { images } : {}), ...(placeholders ? { placeholders } : {}) })] });
  assert.ok(!segment(declaredProducts([carryingResult(0, 1)], script, wanted, null), 'parallel').includes(PLACEHOLDER));
  assert.ok(segment(declaredProducts([carryingResult(1, 0)], script, wanted, null), 'parallel').includes(PLACEHOLDER), 'an image still in it isn\'t its placeholder');
  assert.ok(segment(declaredProducts([carryingResult(0, 0)], script, wanted, null), 'parallel').includes(PLACEHOLDER), 'a result that lost its image and holds no placeholder isn\'t one either');
});

test('C15: on a binding model every agent request carries the drop control and asks for the beta it needs; a request without either is flagged, and only Messages API agent requests to a binding model are judged', () => {
  const control = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const asks = (...beta) => ({ api: 'messages', model: 'claude-opus-5-5', headers: { beta, version: '2023-06-01' } });
  const records = [
    { id: 'r1', step: 'a', kind: 'agent', thinking: control, head: asks('other-beta', 'thinking-binding-controls-2026-08-01') },
    { id: 'r2', step: 'b', kind: 'agent', thinking: { type: 'adaptive' }, head: asks('thinking-binding-controls-2026-08-01') },
    { id: 'r3', step: 'b', kind: 'agent', thinking: null, head: asks('thinking-binding-controls-2026-08-01') },
    { id: 'r4', step: 'c', kind: 'agent', thinking: control, head: asks('other-beta') },
    { id: 'r5', step: 'b', kind: 'summariser', thinking: null, head: asks() },
    { id: 'r6', step: 'b', kind: 'agent', thinking: null, head: { ...asks(), model: 'claude-opus-4-6' } },
    { id: 'r7', step: 'b', kind: 'agent', thinking: null, head: { ...asks(), api: 'chat-completions' } },
  ];
  const flags = bindingControl(records);
  assert.equal(flags.judged, 4, 'a Chat Completions request under a binding model\'s id isn\'t the Messages API\'s to judge');
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what, f.message.split(' ')[1]]), [[15, 'b', 'no-drop-control', 'r2'], [15, 'b', 'no-drop-control', 'r3'], [15, 'c', 'no-binding-beta', 'r4']]);
  assert.deepEqual([...bindingControl([records[0]])], []);
  const front = { id: 'r8', step: 'b', kind: 'agent', thinking: null, head: { ...asks(), model: 'front-binding' } };
  assert.equal(bindingControl([front], { served: (id) => (id === 'front-binding' ? 'claude-opus-5-5' : id) }).judged, 1, 'a front\'s id is judged by the Messages API model it serves, as the codec resolves it');
});

test('check 2: thinking-call and debt each pass when their segment produced what it declares, and debt fails a compression between the turn\'s rounds', () => {
  const script = [{ id: 't.1', segment: 'thinking-call', kind: 'channel' }, { id: 'd.1', segment: 'debt', kind: 'channel' }];
  const wanted = products(configurations().H1);
  const thinkingWanted = { 'thinking-call': wanted['thinking-call'] };
  const missing = [{ segment: 'thinking-call', missing: [wanted['thinking-call'][0].name] }];
  const call = { type: 'tool_use', toolUseId: 'toolu_t1' };
  const answering = (canary) => ({ role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'toolu_t1', canaries: [canary] }] });
  const result = answering('[[c:c.think.call1]]');
  const request = (assistantBlocks, rest = [result]) => ({ id: 'a1', seq: 1, step: 't.1', kind: 'agent', messages: [msg('user', carrying('[[c:t.1.in]]')), { role: 'assistant', blocks: assistantBlocks }, ...rest] });
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call])], script, thinkingWanted), [], 'signed thinking leading a call, with the call\'s result');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }], [])], script, thinkingWanted), missing, 'signed thinking with no call isn\'t a thinking-led call');
  assert.deepEqual(declaredProducts([request([call, { type: 'thinking', signature: 'fx1.abc' }])], script, thinkingWanted), missing, 'thinking after the call doesn\'t lead it');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call], [])], script, thinkingWanted), missing, 'a call with no result in the request');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call], [answering('[[c:p.11.call1]]')])], script, thinkingWanted), missing, 'a thinking-led call the prefix made isn\'t the segment\'s');
  const debtWanted = { debt: wanted.debt };
  const agent = (seq) => ({ id: `d${seq}`, seq, step: 'd.1', kind: 'agent', messages: [], answer: { shape: 'reply' } });
  const answered = (seq, shape) => ({ id: `s${seq}`, seq, step: 'd.1', kind: 'summariser', messages: [], answer: { shape } });
  const parked = [agent(1), agent(2), answered(3, 'summary'), answered(4, 'thinking-only'), answered(5, 'empty'), answered(6, 'max-tokens')];
  assert.deepEqual(declaredProducts(parked, script, debtWanted), []);
  const between = [agent(1), answered(2, 'summary'), agent(3), answered(4, 'thinking-only'), answered(5, 'empty'), answered(6, 'max-tokens')];
  assert.deepEqual(declaredProducts(between, script, debtWanted), [{ segment: 'debt', missing: [wanted.debt[0].name] }]);
});

test('check 12: a fork call\'s UUID and its result\'s are masked together across a dry compile\'s messages, so a result that names another call is a difference', () => {
  const dry = (seq, contents) => ({ seq, agent: 'fixture', kind: 'dry', outcome: 'compiled', messages: contents.map((content, i) => ({ sources: [`r:m${i}`], content })), system: 'sys' });
  const uuid = (c) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
  const blobs = { callA: `call fork-w9-${uuid('a')}`, resA: `result fork-w9-${uuid('a')}`, callB: `call fork-w9-${uuid('b')}`, resB: `result fork-w9-${uuid('b')}`, resC: `result fork-w9-${uuid('c')}`, sys: [] };
  const run = (before, after) => [
    { kind: 'compiles', boot: 1, lines: [before], blobs },
    { kind: 'compiles', boot: 2, lines: [after], blobs: {} },
    { kind: 'reload', step: 'r.restart', agent: 'fixture', before: { boot: 1, seq: before.seq }, after: { boot: 2, seq: after.seq } },
  ];
  assert.deepEqual(reloads(run(dry(7, ['callA', 'resA']), dry(1, ['callB', 'resB']))), [], 'a fresh UUID for the same call and result');
  assert.match(reloads(run(dry(7, ['callA', 'resA']), dry(1, ['callB', 'resC'])))[0].message, /differs from the one before at message 1/);
});

test('requestPairs: a request stamped the same nanosecond as a compile doesn\'t pair with it', () => {
  const r = { ...opened('r1', 'h', 1_000), arrived: '10', messages: [{ role: 'user', digest: 'd', blocks: [text(['[[c:h.in]]'])] }] };
  const log = [{ kind: 'compiles', step: 'h', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'x' }] }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:h.in]] words' }] } } }];
  const paired = requestPairs([r], log);
  assert.deepEqual([paired.pairs.length, paired.unpaired.map((l) => l.seq)], [0, [1]]);
});

test('assemblies: a retry is in the same process, so a restarted process reusing an assembly number with a higher seq starts its own', () => {
  const line = (seq, assembly, outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [] });
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [line(3, 2)] },
    { kind: 'compiles', step: 'b', boot: 2, lines: [line(5, 2)] },
    { kind: 'compiles', step: 'b', boot: 2, lines: [line(6, 3, 'refused'), line(7, 3)] },
  ];
  assert.deepEqual(assemblies(log).map((l) => [l.boot, l.seq]), [[1, 3], [2, 5], [2, 7]]);
});

test('check 1 flags a step that leaves a scripted reply unused, its own or its subagent\'s, unless it may fail and failed', () => {
  const agent = (id, step, sub = false) => ({ id, kind: 'agent', step, ...(sub ? { agent: 'sub' } : { agent: 'primary' }) });
  const turn = { id: 's.2', replies: [{ text: 'a' }, { text: 'b' }], subs: [{ replies: [{ text: 'f' }] }] };
  assert.deepEqual([...everyTurnAnswers([agent('r1', 's.2'), agent('r2', 's.2'), agent('r3', 's.2', true)], [], [turn])], [], 'every reply used');
  assert.deepEqual(everyTurnAnswers([agent('r1', 's.2'), agent('r2', 's.2')], [], [turn]).map((f) => [f.step, f.message]), [['s.2', '1 of the step\'s 1 scripted subagent replies went unused, so what it scripts didn\'t all happen']], 'a fork that never ran');
  assert.deepEqual(everyTurnAnswers([agent('r1', 's.2'), agent('r3', 's.2', true)], [], [turn]).map((f) => f.message), ['1 of the step\'s 2 scripted replies went unused, so what it scripts didn\'t all happen']);
  const cut = { id: 's.10', replies: [{ text: 'a' }, { text: 'b' }], mayFail: true };
  const refused = { kind: 'ipc', step: 's.10', event: { type: 'inference:failed', error: 'over budget' } };
  assert.deepEqual([...everyTurnAnswers([], [refused], [cut])], [], 'a step that may fail, and failed, owns its unused replies');
  assert.deepEqual(everyTurnAnswers([], [], [cut]).map((f) => [f.step, f.message]), [['s.10', '2 of the step\'s 2 scripted replies went unused, so what it scripts didn\'t all happen']], 'one that may fail but never asked and never failed still flags');
});

test('check 1 flags a turn whose answer never reached its channel, and a step that retries a scripted error owns only the failure agent-framework retries', () => {
  const undelivered = everyTurnAnswers([], [{ kind: 'undelivered', step: 's.3', reason: 'no route' }], []);
  assert.deepEqual(undelivered.map((f) => f.message), ['the turn\'s answer never reached its channel: the host reported mcpl:speech-route-failed (no route)']);
  const ev = (type) => ({ kind: 'ipc', step: 's.2', event: { type, error: 'overloaded' } });
  const retries = [{ id: 's.2', retries: true }];
  assert.deepEqual([...everyTurnAnswers([], [ev('inference:failed')], retries)], [], 'the retried failure is the step\'s own');
  assert.deepEqual(everyTurnAnswers([], [ev('inference:exhausted')], retries).map((f) => f.message), ['inference:exhausted: overloaded'], 'ending without an answer is not');
  assert.deepEqual([...everyTurnAnswers([], [ev('inference:exhausted')], [{ id: 's.2', mayFail: true }])], [], 'a step that may fail owns it');
});

test('check 1 lets a step whose answer the script has the channel refuse to post own a route failure there, other than one with no locus, which still flags', () => {
  const NO_LOCUS = 'turn has no locus (no home/trigger channel; nothing to deliver into)';
  const REFUSED = 'the "fixture" server said it didn\'t post the message';
  const script = [{ id: 's.pub', failsPublish: true }, { id: 's.chan' }];
  const said = (step, reason) => everyTurnAnswers([], [{ kind: 'undelivered', step, reason }], script).map((f) => [f.step, f.message]);
  assert.deepEqual(said('s.pub', REFUSED), [], 'a refused publish, as the step scripts');
  assert.deepEqual(said('s.pub', 'the "fixture" server\'s answer didn\'t say whether it posted the message (delivery uncertain)'), [], 'any other route failure there but one with no locus');
  assert.deepEqual(said('s.pub', NO_LOCUS), [['s.pub', `the turn's answer never reached its channel: the host reported mcpl:speech-route-failed (${NO_LOCUS})`]]);
  assert.deepEqual(said('s.chan', REFUSED), [['s.chan', `the turn's answer never reached its channel: the host reported mcpl:speech-route-failed (${REFUSED})`]], 'another step\'s refused publish');
});

test('check 1 flags an answer with no locus on a turn a message the script addressed to the resident woke, since that turn had a channel to answer on, and doesn\'t on a turn no addressed message woke, where the host shows the answer on its console and tells the resident; any other route failure flags on either', () => {
  const NO_LOCUS = 'turn has no locus (no home/trigger channel; nothing to deliver into)';
  const script = [{ id: 's.chan' }, { id: 's.console', addressed: false }];
  const said = (step, reason) => everyTurnAnswers([], [{ kind: 'undelivered', step, reason }], script).map((f) => [f.step, f.message]);
  assert.deepEqual(said('s.chan', NO_LOCUS), [['s.chan', `the turn's answer never reached its channel: the host reported mcpl:speech-route-failed (${NO_LOCUS})`]], 'an addressed turn that lost its locus');
  assert.deepEqual(said('s.console', NO_LOCUS), [], 'a console turn, which has no channel');
  assert.deepEqual(said('s.console', 'delivery not confirmed'), [['s.console', 'the turn\'s answer never reached its channel: the host reported mcpl:speech-route-failed (delivery not confirmed)']], 'any other failure, though no addressed message woke it');
  assert.deepEqual(said('s.console', null), [['s.console', 'the turn\'s answer never reached its channel: the host reported mcpl:speech-route-failed']], 'and one that names no reason');
});

test('check 1 flags speech the host held as drafts because an explicit send or a routing prefix held it back, on any turn, and speech held for having no destination on a turn a message the script addressed to the resident woke, but not on one no addressed message woke, such as a reminder\'s', () => {
  const script = [{ id: 's.chan' }, { id: 's.remind', addressed: false }];
  const held = (step, reason) => everyTurnAnswers([], [{ kind: 'ipc', step, event: { type: 'prose:drafts-held', agentName: 'fixture', reason, draftIds: ['d1'], textLen: 40 } }], script).map((f) => [f.step, f.message]);
  assert.deepEqual(held('s.remind', 'no-destination'), [], 'a reminder\'s turn, which has no channel');
  assert.deepEqual(held('s.chan', 'no-destination'), [['s.chan', 'the turn\'s answer reached no channel: the host held it as drafts (no-destination)']], 'a turn that had a channel to answer on');
  for (const reason of ['explicit-send', 'bounced']) {
    for (const step of ['s.chan', 's.remind']) assert.deepEqual(held(step, reason), [[step, `the turn's answer reached no channel: the host held it as drafts (${reason})`]], `${reason} at ${step}`);
  }
});

test('check 1 flags a request once where it carries more delivery receipts saying a turn\'s speech was NOT held as drafts than its agent\'s last request did, however many more, and no receipt that says the speech went out or was kept private', () => {
  const said = (notHeld) => ({ type: 'text', chars: 90, ...(notHeld ? { notHeld: true } : {}) });
  const request = (id, step, blocks, extra = {}) => ({ id, step, kind: 'agent', messages: [{ role: 'user', blocks }], ...extra });
  const records = [
    request('r1', 's.1', [said(false)]),
    request('r2', 's.2', [said(false), said(true)]),
    request('r3', 's.3', [said(false), said(true), said(false)]),
    { id: 'r4', step: 's.3', kind: 'summariser', messages: [{ role: 'user', blocks: [said(true), said(true)] }] },
    request('r5', 's.4', [said(true), said(false), said(true)]),
    request('r6', 's.4', [said(true)], { agent: 'sub' }),
  ];
  const flags = everyTurnAnswers(records, [], []);
  const lost = 'the request carries a delivery receipt saying a turn\'s speech was suppressed and NOT held as drafts, so the host lost it';
  assert.deepEqual(flags.map((f) => [f.request, f.step, f.message]), [['r2', 's.2', lost], ['r5', 's.4', lost], ['r6', 's.4', lost]], 'the first request carrying each, the subagent\'s counted as its own');
  assert.deepEqual([...everyTurnAnswers([request('r1', 's.1', [said(false), said(false)])], [], [])], [], 'receipts that say nothing was lost');
});

test('check 12 can\'t judge a reload whose dry compiles refused alike on both sides, and judges one whose refusal changed', () => {
  const line = (outcome, error) => ({ seq: 1, kind: 'dry', outcome, ...(error ? { error: { class: error } } : {}), messages: [] });
  const log = (a, b) => [{ kind: 'compiles', boot: 1, lines: [a], blobs: {} }, { kind: 'compiles', boot: 2, lines: [b], blobs: {} }, { kind: 'reload', step: 'r', before: { boot: 1, seq: 1 }, after: { boot: 2, seq: 1 } }];
  const alike = reloads(log(line('refused', 'OverBudgetError'), line('refused', 'OverBudgetError')));
  assert.deepEqual([alike.judged, alike.map((f) => f.message)], [0, ['couldn\'t judge the reload: the dry compile refused (OverBudgetError) both before the restart and after it']]);
  const moved = reloads(log(line('refused', 'OverBudgetError'), line('compiled')));
  assert.deepEqual([moved.judged, moved.map((f) => f.message)], [1, ['after the restart the dry compile compiled, where before it refused (OverBudgetError)']]);
  const same = reloads(log(line('compiled'), line('compiled')));
  assert.deepEqual([same.length, same.judged], [0, 1]);
});

test('check 2 counts the products it couldn\'t judge for want of a store, rather than leaving them out of its count', () => {
  const script = [{ id: 's.1', segment: 'seg' }];
  const wanted = { seg: [{ name: 'a request', test: () => true }, { name: 'a stored merge', fromStore: () => true }] };
  const records = [{ id: 'r1', step: 's.1', kind: 'agent', messages: [] }];
  const none = declaredProducts(records, script, wanted, null);
  assert.equal(none.judged, 1);
  assert.equal(none.besides, '1 product not judged, as it needs the final store and the run has none');
  assert.equal(declaredProducts(records, script, wanted, { messages: [], summaries: [] }).besides, undefined);
});

test('a sub-side request belongs to the one agent besides the primary that compiled in its step, so reader forks pair one by one; two such agents in one step, or a sub-side request in a step where none compiled, leave them unplaced', () => {
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, agent, stamp, content) => ({ seq, agent, kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const req = (id, step, agent, canary, arrived) => ({ id, step, kind: 'agent', agent, arrived: String(arrived), messages: [{ role: 'user', blocks: [{ type: 'text', canaries: [canary] }] }] });
  const records = [req('p1', 'h1', 'primary', '[[c:h1.read]]', 21), req('s1', 'h1', 'sub', '[[c:h1.in]]', 11), req('s2', 'h2', 'sub', '[[c:h2.in]]', 31)];
  const log = [
    { kind: 'compiles', step: 'h1', boot: 1, lines: [line(1, 'reader/fixture/aa/1', 10, 'x1'), line(2, 'fixture', 20, 'x2')], blobs: { ...b('x1', '[[c:h1.in]]'), ...b('x2', '[[c:h1.read]]') } },
    { kind: 'compiles', step: 'h2', boot: 1, lines: [line(3, 'reader/fixture/aa/2', 30, 'x3')], blobs: b('x3', '[[c:h2.in]]') },
  ];
  assert.deepEqual([...subOwners(records, log).owners], [['s1', 'reader/fixture/aa/1'], ['s2', 'reader/fixture/aa/2']]);
  assert.deepEqual(requestPairs(records, log, 'reader/fixture/aa/1').pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 's1']]);
  assert.deepEqual(requestPairs(records, log, 'reader/fixture/aa/2').pairs.map(({ line: l, request }) => [l.seq, request.id]), [[3, 's2']]);
  assert.deepEqual([...pairing(records, log, 'reader/fixture/aa/2')], [], 'each fork judged alone');
  assert.equal(subOwners(records, log.slice(0, 1)).owners, null, 'one agent besides the primary needs no placing');
  const crowded = [log[0], { ...log[1], step: 'h1' }];
  assert.match(subOwners(records, crowded).problem, /reader\/fixture\/aa\/1 and reader\/fixture\/aa\/2 each made request compiles in step h1/);
  assert.match(subOwners([...records, req('s3', 'a', 'sub', '[[c:a.in]]', 41)], log).problem, /1 sub-side request came in a step where none of reader\/fixture\/aa\/1 and reader\/fixture\/aa\/2 compiled/);
});
