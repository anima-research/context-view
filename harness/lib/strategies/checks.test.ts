// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answeredBare, assemblies, bindingControl, budgets, compileInvariants, compileKinds, pairing, reloads, replyCanaries, requestPairs, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, calibrationEdge, coverage, bookkeeping, heldFramed, readerForkOf, subOwners, undoneSent } from './checks.ts';
import { continuation, products, configurations, L3_PRODUCT } from './script.ts';
import { msg, text, call, result, carrying, store, panel, asked, opened, continued, started, sent, compiledAs, crossingAs, crossing, R1_COMPILED, under } from '../testing/check-builders.ts';

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

const summaryBlock = (...summaries) => ({ type: 'text', chars: 10, summaries });

const turnStep = (id, replies = 1) => ({ id, segment: 's', kind: 'channel', canaries: [`[[c:${id}.in]]`], replies: Array.from({ length: replies }, (_, k) => ({ text: `[[c:${id}.r${k + 1}]] x` })) });

test('check 6 without a store read still holds a request to the two turns before it, less what was suppressed before it', () => {
  const suppress = { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] };
  const before = [turnStep('a'), turnStep('b'), suppress, turnStep('c')];
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), suppress];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const withoutSuppressed = req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([withoutSuppressed], before, [], null), [], 'a.r1 was suppressed before c, so it isn\'t wanted');
  assert.deepEqual(windowsRaw([withoutSuppressed], after, [], null).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a suppression scripted after c excuses nothing at c');
  const lacking = windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]'])], before, [], null);
  assert.deepEqual(lacking.map((f) => f.message), ['the recent window lacks [[c:b.r1]]']);
});

test('check 6 asks for no canary of a scripted reply that has no text, since it carries none, and still asks for the turn\'s replies that have text', () => {
  const quiet = { ...turnStep('b', 3), replies: [{ text: '[[c:b.r1]] x' }, { calls: [{ name: 'channel_publish', input: {} }] }, { text: '[[c:b.r3]] x' }] };
  const script = [turnStep('a'), quiet, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r3]]', '[[c:c.in]]'])], script, [], null), []);
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], script, [], null).map((f) => f.message), ['the recent window lacks [[c:b.r3]]']);
});

test('check 6 without a store read asks for nothing a /branchto before the request rolled back, and says it couldn\'t judge it; a rollback after the request excuses nothing', () => {
  const rollback = { id: 'x', segment: 's', kind: 'command', command: '/branchto [[c:a.r1]]' };
  const req = (step, canaries) => ({ id: 'r', step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const script = [turnStep('a'), turnStep('b'), rollback, turnStep('c')];
  const rolled = windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], script, [], null);
  assert.deepEqual(rolled.map((f) => f.message), [], 'b was rolled back before c, so c isn\'t asked for it');
  assert.equal(rolled.besides, '2 recent messages not judged, as a rollback before their requests may have dropped them and no final store was read');
  assert.equal(rolled.judged, 1);
  const later = [turnStep('a'), turnStep('b'), turnStep('c'), rollback];
  assert.deepEqual(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], later, [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]] [[c:b.r1]]'], 'a rollback scripted after c excuses nothing at c');
  assert.equal(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], later, [], null).besides, undefined);
  const suppressedToo = [turnStep('a'), turnStep('b'), { id: 'y', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:b.r1]]' }] }, rollback, turnStep('c')];
  assert.equal(windowsRaw([req('c', ['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]'])], suppressedToo, [], null).besides, '1 recent message not judged, as a rollback before its request may have dropped it and no final store was read', 'a message suppressed before the rollback isn\'t counted as the rollback\'s');
});

test('check 6 owes a refused step\'s retried reply by the canary its text carries, and owes a later request nothing of a step that sheds its message', () => {
  const refusing = (sheds) => ({ ...turnStep('b'), replies: [{ stop: 'refusal' }, { text: '[[c:b.r1]] x' }], ...(sheds ? { sheds: ['[[c:b.in]]'] } : {}) });
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const retried = req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(true), turnStep('c')], [], null), [], 'the retry\'s reply is b.r1, and the shed b.in isn\'t owed');
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(false), turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], 'a refusal that isn\'t rewound leaves its message owed');
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  assert.deepEqual(windowsRaw([retried], [turnStep('a'), refusing(true), turnStep('c')], [], store), [], 'a store that keeps the shed message owes it to no later request');
  const atB = (id, answer, ...canaries) => ({ id, step: 'b', kind: 'agent', answer, messages: [msg('user', carrying(...canaries))] });
  const refusedAtB = atB('r2', { shape: 'reply', stop: 'refusal' }, '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]');
  const answeredRetry = atB('r3', { shape: 'reply', stop: 'end_turn' }, '[[c:a.in]]', '[[c:a.r1]]');
  const lacking = req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([refusedAtB, answeredRetry, lacking], [turnStep('a'), refusing(true), turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.r1]]'], 'the answered retry\'s reply is owed to the next turn');
  const toolsFirst = { ...turnStep('b'), replies: [{ calls: [{ name: 'skip_reply' }] }, { text: '[[c:b.r2]] x' }] };
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r2]]', '[[c:c.in]]'])], [turnStep('a'), toolsFirst, turnStep('c')], [], null), [], 'a reply of tool calls alone carries no canary, so none is owed for it');
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]'])], [turnStep('a'), toolsFirst, turnStep('c')], [], null).map((f) => f.message), ['the recent window lacks [[c:b.r2]]'], 'the text reply after it is owed');
});

test('check 6 owes a later request what a refused tool round\'s rewind keeps, the step\'s message, and not what it sheds, the call\'s round', () => {
  const step = { ...turnStep('b'), replies: [{ text: '[[c:b.r1]] x', calls: [{ name: 't', input: { canary: '[[c:b.call1]]' } }] }, { stop: 'refusal' }, { text: '[[c:b.r2]] x' }], sheds: ['[[c:b.r1]]'] };
  const script = [turnStep('a'), step, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r2]]', '[[c:c.in]]'])], script, [], null), [], 'the retry\'s reply is b.r2, and the shed b.r1 isn\'t owed');
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.r2]]', '[[c:c.in]]'])], script, [], null).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], 'the message the rewind kept is owed');
});

test('check 6 with a store read holds a request to a message an operator suppressed only after it, which the final store no longer holds', () => {
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] }];
  const store = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]']);
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store), []);
  const failedLater = [{ kind: 'ipc', step: 'a', event: { type: 'inference:failed' } }];
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, failedLater, store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a reply an operator suppressed was stored, even in a step that failed on a later round');
});

test('check 6 flags a request that loses a raw message of the head the host reported, or lacks the two turns before it raw', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const noHead = { ...full, id: 'nohead', messages: [msg('user', carrying('[[c:p.1.in]]')), ...full.messages.slice(1)] };
  const noRecent = { ...full, id: 'norecent', messages: [head, msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'))] };
  const flags = [full, noHead, noRecent].flatMap((r) => windowsRaw([r], script, log, store));
  assert.deepEqual(flags.map((f) => f.request), ['nohead', 'norecent'], 'p.2, past the reported head, may fold');
  assert.match(flags[0].message, /p\.1\.r1/);
  assert.match(flags[1].message, /b\.r2/);
  const sized = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { tail: { messages: 0, tokens: 0 } } } } } }];
  assert.deepEqual(windowsRaw([full], script, sized, store).map((f) => f.message), ["no head size was reported at segment s's checkpoint"]);
  assert.deepEqual(windowsRaw([noHead, full], script, sized, store).map((f) => [f.request, f.message]), [['ok', "no head size was reported at segment s's checkpoint"]], 'once a segment, on its last request');
  assert.deepEqual(windowsRaw([noHead], script, [], store).filter((f) => /head/.test(f.message)), [], 'a segment that ends at no checkpoint, as a workload\'s, has no head to hold it to');
  assert.deepEqual(windowsRaw([noHead], script, log, null), [], 'with no store read, only the recent window is checked');
});

test('check 6 holds only a segment\'s last request to the head its checkpoint reported, since the panel describes that compile alone', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]')), msg('assistant', summaryBlock('[[s:P2]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const lastLost = { ...last, id: 'last-lost', messages: [msg('user', carrying('[[c:p.1.in]]')), ...last.messages.slice(1)] };
  assert.deepEqual(windowsRaw([early, last], script, log, store), []);
  assert.deepEqual(windowsRaw([early, lastLost], script, log, store).map((f) => [f.request, f.message]), [['last-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});

test('check 6 holds a checkpoint\'s head and tail to nothing the script says a rewind shed or an /undo took out, which a presented window\'s store keeps', () => {
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), ...['p.1.in', 'p.1.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries.map((c) => `[[c:${c}]]`)))] });
  const rest = ['a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'd.in'];
  const shedding = [{ ...turnStep('p.1'), sheds: ['[[c:p.1.r1]]'] }, turnStep('a'), turnStep('b'), turnStep('c'), turnStep('d')];
  const undoing = [turnStep('p.1'), { id: 'u', segment: 's', kind: 'command', command: '/undo', undoes: ['[[c:p.1.r1]]'] }, turnStep('a'), turnStep('b'), turnStep('c'), turnStep('d')];
  const head = [panel('s', { head: 3, tail: 0 })];
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], shedding, head, store), [], 'the head');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], undoing, head, store), [], 'the head, after an /undo');
  const tail = [panel('s', { head: 0, tail: 9 })];
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], shedding, tail, store), [], 'the tail');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], undoing, tail, store), [], 'the tail, after an /undo');
  assert.deepEqual(windowsRaw([req('last', 'd', ['p.1.in', ...rest])], [turnStep('p.1'), ...shedding.slice(1)], head, store).map((f) => f.message), ['the head window\'s [[c:p.1.r1]] isn\'t raw'], 'without either, the head owes it');
});

test('check 6 asks a request for a head message only once it was stored, through the turn\'s own earlier replies', () => {
  const script = [turnStep('p.1', 2), turnStep('p.2')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: ['p.1.in', 'p.1.r1', 'p.1.r2', 'p.2.in', 'p.2.r1'].map((c) => stored(`[[c:${c}]]`)), summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 5, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const first = { id: 'first', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  const second = { id: 'second', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', carrying('[[c:p.1.r1]]'))] };
  const secondLost = { id: 'second-lost', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  assert.deepEqual(windowsRaw([first], script, log, store), [], 'the first request isn\'t asked for its own reply');
  assert.deepEqual(windowsRaw([first, second], script, log, store), []);
  const flags = windowsRaw([first, secondLost], script, log, store);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['second-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
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

test('check 4: each message stored before a request reaches it raw or in a summary, and no more often than stored rows carry it, and an unmapped summary is flagged', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merged = { id: 'merged', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const lost = { id: 'lost', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const unmapped = { id: 'unmapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]', '[[s:P9]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = [ok, merged, lost, twice, unmapped].flatMap((r) => coverage([r], store));
  assert.deepEqual(flags.map((f) => f.request), ['lost', 'twice', 'unmapped']);
  assert.match(flags[0].message, /b\.in.*b\.r1/);
});

test('check 4: a step\'s later request also needs that step\'s earlier replies', () => {
  const first = { id: 'one', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const second = { id: 'two', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = coverage([first, second], store);
  assert.deepEqual(flags.map((f) => f.request), ['two']);
  assert.match(flags[0].message, /c\.r1/);
  const toolsFirst = [{ id: 'c', replies: [{ calls: [{ name: 'skip_reply' }] }, { text: '[[c:c.r2]] x' }] }];
  assert.deepEqual(coverage([first, second], store, toolsFirst), [], 'a reply of tool calls alone carries no canary, so the second request owes none of c\'s');
  const third = { ...second, id: 'three' };
  const owed = coverage([first, second, third], store, toolsFirst);
  assert.deepEqual(owed.map((f) => f.request), ['three'], 'the third request owes c.r2, the text reply after it');
  assert.match(owed[0].message, /c\.r2/);
});

test('check 4: what the script says a step\'s rewind sheds is owed by no request from that step on, whether it was the step\'s own reply or a row the store kept', () => {
  // agent-framework's shedNewestTurn retracts a presented window's rows and leaves them stored.
  const kept = { ...store, messages: [...store.messages, { id: 'm7', canaries: ['[[c:c.r0]]'] }, { id: 'm8', canaries: ['[[c:c.r1]]'] }, { id: 'm9', canaries: ['[[c:d.in]]'] }] };
  const sheds = (shed) => [{ id: 'c', replies: [{ text: '[[c:c.r0]] x', calls: [{ name: 'fixture--result' }] }, { stop: 'refusal' }, { text: '[[c:c.r1]] y' }], ...(shed ? { sheds: ['[[c:c.r0]]'] } : {}) }, { id: 'd', replies: [{ text: '[[c:d.r1]] z' }] }];
  const asked = (id, step, answer, ...canaries) => ({ id, step, kind: 'agent', answer, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]', ...canaries))] });
  const records = [
    asked('first', 'c', { shape: 'reply', stop: 'tool_use' }),
    asked('refused', 'c', { shape: 'reply', stop: 'refusal' }, '[[c:c.r0]]'),
    asked('retry', 'c', { shape: 'reply', stop: 'end_turn' }),
    asked('later', 'd', { shape: 'reply', stop: 'end_turn' }, '[[c:c.r1]]', '[[c:d.in]]'),
  ];
  assert.deepEqual(coverage(records, kept, sheds(true)), []);
  assert.deepEqual(coverage(records, kept, sheds(false)).map((f) => [f.request, f.message]), [
    ['retry', '1 stored message(s) reach the request neither raw nor in a summary: [[c:c.r0]]'],
    ['later', '1 stored message(s) reach the request neither raw nor in a summary: [[c:c.r0]]'],
  ], 'without the shed list both owe it');
});

test('check 4: a stored row a suppress rule hid is owed to no request, and one that quotes it is owed as any row is', () => {
  // agent-framework stamps a row a suppress rule hid `metadata.suppressed` and never renders it; its suppression review
  // is a row of its own that may quote one of them.
  const hid = {
    messages: [
      { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
      { id: 'h1', canaries: ['[[c:h.in]]'], suppressed: true }, { id: 'h2', canaries: ['[[c:k.in]]'], suppressed: true },
      { id: 'v1', canaries: ['[[c:k.in]]'] },
      { id: 'm3', canaries: ['[[c:c.in]]'] },
    ],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
  };
  const quiet = { id: 'quiet', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:k.in]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([quiet], hid), [], 'neither hidden row is owed, and the review that quotes one carries it once');
  const noReview = { ...quiet, id: 'noReview', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([noReview], hid).map((f) => [f.request, f.what, f.message]), [['noReview', 'not-reached', '1 stored message(s) reach the request neither raw nor in a summary: [[c:k.in]]']], 'the review row is owed');
  const twiceK = { ...quiet, id: 'twiceK', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:k.in]]'), carrying('[[c:k.in]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([twiceK], hid).map((f) => [f.what, f.message]), [['more-than-once', '1 message(s) reach the request more often than stored rows carry them: [[c:k.in]] (2 for 1 row)']], 'the hidden row that shares the review\'s canary adds nothing to what the request may carry');
});

test('check 4: a canary may reach a request as many times as stored rows carry it, a message and a row that quotes it each once, and no more; once is enough', () => {
  // connectome-host's knowledge retrieval stores a row of its own after a message, opening "## Retrieved Knowledge, for
  // the message beginning" and its text, canary and all.
  const quoted = {
    messages: [
      { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
      { id: 'm3', canaries: ['[[c:d.in]]'] }, { id: 'q3', canaries: ['[[c:d.in]]'] }, { id: 'm4', canaries: ['[[c:d.r1]]'] },
      { id: 'm5', canaries: ['[[c:c.in]]'] },
    ],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
  };
  const each = { id: 'each', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([each], quoted), [], 'each of the two rows once');
  const thrice = { ...each, id: 'thrice', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]', '[[c:a.in]]'), carrying('[[c:d.in]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([thrice], quoted).filter((f) => f.what === 'more-than-once').map((f) => [f.what, f.message]), [['more-than-once', '2 message(s) reach the request more often than stored rows carry them: [[c:a.in]] (2 for 1 row) [[c:d.in]] (3 for 2 rows)']], 'each named once, with its count and its rows');
  const one = { ...each, id: 'one', messages: [msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:d.in]]')), msg('assistant', carrying('[[c:d.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([one], quoted), [], 'a canary it carries at all reaches it; which row went out is check 11\'s');
});

test('check 5: a summary declares only what its request showed, a child by its number or by all it covers', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const flags = bookkeeping([
    shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']),
    shown('[[s:C2]]', ['[[c:b.in]]']),
    shown('[[s:C3]]', ['[[c:a.in]]', '[[c:a.r1]]'], ['[[s:C2]]']),
  ], store);
  assert.deepEqual(flags.map((f) => f.request), ['[[s:C2]]']);
  const childUnseen = bookkeeping([shown('[[s:C3]]', ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]'])], store);
  assert.match(childUnseen[0].message, /L1-1/);
  const l3store = { ...store, summaries: [...store.summaries, { id: 'L3-1', level: 3, sourceLevel: 2, sourceIds: ['L2-1'], number: '[[s:C4]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }] };
  assert.deepEqual(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]', '[[s:C2]]'])], l3store), []);
  assert.equal(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]'])], l3store).length, 1);
  const holed = { ...store, messages: store.messages.filter((m) => m.id !== store.summaries.find((x) => x.number === '[[s:C1]]').sourceIds[0]) };
  const unread = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], holed);
  assert.deepEqual(unread.map((f) => f.what), ['unread-source']);
  assert.equal(unread.judged, 0);
  const tooled = { ...store, messages: [...store.messages, { id: 't1', canaries: ['[[c:a.call1]]'] }], summaries: [...store.summaries, { id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['t1'], number: '[[s:C9]]', covers: ['[[c:a.call1]]'] }] };
  const nothingHeld = bookkeeping([shown('[[s:C9]]', [])], tooled);
  assert.deepEqual(nothingHeld, []);
  assert.equal(nothingHeld.judged, 0, 'a summary of tool results alone holds no source to its request, so it isn\'t counted as judged');
  const merged = { ...tooled, summaries: [...tooled.summaries, { id: 'L2-9', level: 2, sourceLevel: 1, sourceIds: ['L1-9'], number: '[[s:C10]]', covers: ['[[c:a.call1]]'] }] };
  const unshownChild = bookkeeping([shown('[[s:C10]]', [])], merged);
  assert.deepEqual(unshownChild, [], 'a child covering no conversational message, its number not sent, may have gone as its sources raw, which carry nothing to judge by');
  assert.equal(unshownChild.judged, 0, 'so it isn\'t judged, and nothing passes on it');
  const shownChild = bookkeeping([shown('[[s:C10]]', [], ['[[s:C9]]'])], merged);
  assert.deepEqual(shownChild, []);
  assert.equal(shownChild.judged, 1, 'its number sent shows it');
  assert.equal(bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], store).judged, 1);
});

test('checks 4 and 5 read a stitched summary by all its fold parts: its later marks map to it, it is judged once against what all its parts\' requests showed, and a source it declares by a placeholder passes only where its text names that message', () => {
  const stitched = {
    messages: [{ id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] }, { id: 'm3', canaries: ['[[c:b.in]]'] }, { id: 'm4', canaries: ['[[c:b.r1]]'] }, { id: 'm5', canaries: ['[[c:c.in]]'] }],
    summaries: [{ id: 'L1-7', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2', 'm3', 'm4'], number: '[[s:Ma]]', parts: ['[[s:Mb]]'], placeheld: ['m3'], covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }],
  };
  const agentRequest = { id: 'r9', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:Ma]]', '[[s:Mb]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const part = (id, number, canaries) => ({ id, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries: [] } });
  const parts = [part('r1', '[[s:Ma]]', ['[[c:a.in]]', '[[c:a.r1]]']), part('r2', '[[s:Mb]]', ['[[c:b.r1]]'])];
  assert.deepEqual(coverage([...parts, agentRequest], stitched), [], 'its part\'s mark maps to it, and its coverage counts once');
  const unmapped = (records) => coverage(records, stitched).filter((f) => f.what === 'unmapped-summary').map((f) => f.message);
  assert.deepEqual(unmapped([parts[0], agentRequest]), ['summary [[s:Mb]] is in the request, and no store read maps it'], 'a later mark no fold answer wrote isn\'t a part');
  const alone = { ...agentRequest, messages: [msg('user', summaryBlock('[[s:Ma]]')), msg('user', summaryBlock('[[s:Mb]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(unmapped([...parts, alone]), ['summary [[s:Mb]] is in the request, and no store read maps it'], 'a part sent in a block without its summary\'s number');
  const judged = bookkeeping(parts, stitched);
  assert.deepEqual([...judged], [], 'm2 and m4 were each shown by one part\'s request, and m3 is its placeholder');
  assert.equal(judged.judged, 1, 'judged once');
  const unnamed = { ...stitched, summaries: [{ ...stitched.summaries[0], placeheld: [] }] };
  assert.deepEqual(bookkeeping(parts, unnamed).map((f) => f.message), ['summary [[s:Ma]] (L1-7, L1) declares 1 source(s) its request didn\'t show: m3'], 'a placeholder its text doesn\'t name is a source it didn\'t show');
});

test('a stored summary\'s marks: its number is its text\'s first; a stitched one\'s later marks are its parts, and its placeholders the messages its text names as left unsummarized', async () => {
  const { summaryMarks } = await import('./read-store.ts');
  assert.deepEqual(summaryMarks({ content: '[[s:M00000001]] one [[s:M00000002]]' }), { number: '[[s:M00000001]]' }, 'an ordinary summary\'s other marks are its text\'s, not its parts');
  const note = (id) => `[Operator note — not the resident's words: one preserved message at this point (message id ${id}) was not summarized in this entry; its exact source remains in the record.]`;
  const stitched = { content: `[[s:M0000000a]] left\n\n${note('17')}\n\n[[s:M0000000b]] right`, stitched: { placeholders: [{ messageId: '17', text: note('17') }, { messageId: '18', text: note('18') }] } };
  assert.deepEqual(summaryMarks(stitched), { number: '[[s:M0000000a]]', parts: ['[[s:M0000000b]]'], placeheld: ['17'] });
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

const resumed = { kind: 'ipc', event: { type: 'inference:stream_resumed', agentName: 'fixture' } };

const budgetReport = (...lines) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', ...lines], ms: 5 });

const WINDOW_CLAUSE = '; its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold';

test('K2e: with the module\'s compile lines, a request is compiled when it arrives after its agent\'s latest compile stamped before it, so a restart that sends what a continuation would is compiled', () => {
  const withCanary = (r, canary, arrived) => ({ ...r, arrived: String(arrived), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const r1 = withCanary(opened('r1', 'a', 15_000, 23_000, ['t1']), '[[c:a.in]]', 11);
  const r2 = withCanary(continued(r1, 'r2', 19_000, 25_000, ['t2']), '[[c:a.call1]]', 31);
  const r3 = withCanary(continued(r2, 'r3', 20_000, 26_000), '[[c:a.call2]]', 41);
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp, outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, ...(stamp ? { stamp: String(stamp) } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10), line(2, 2, 'x2', null, 'refused'), line(3, 2, 'x2', 30), { ...line(4, 3, 'x9', 35), kind: 'dry' }, line(5, 4, 'x5', 50)], blobs: { ...b('x1', '[[c:a.in]]'), ...b('x2', '[[c:a.call1]]'), ...b('x9', '[[c:a.call2]]'), ...b('x5', '[[c:z.in]]') } },
  ];
  const paired = compileKinds([r1, r2, r3], log);
  assert.deepEqual(Object.fromEntries(paired.kinds), { r1: 'compiled', r2: 'compiled', r3: 'continuation' }, 'a refused compile, retried in its assembly, and a dry compile take no request');
  assert.deepEqual(paired.unpaired.map((l) => l.seq), [5], 'a compile no request was sent from');
  assert.equal(compileKinds([r1], [{ kind: 'compiles', lines: [{ ...line(1, 1, 'x1', 10), agent: 'other' }], blobs: b('x1', '[[c:a.in]]') }]), null, 'no line for the agent: nothing to pair by');
  for (const boot of [2, 1]) {
    const twoProcesses = [
      { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
      { kind: 'compiles', step: 'a', boot, lines: [line(1, 1, 'x2', 30)], blobs: b('x2', '[[c:a.call1]]') },
    ];
    assert.deepEqual(Object.fromEntries(compileKinds([r1, r2], twoProcesses).kinds), { r1: 'compiled', r2: 'compiled' }, `each process's assembly 1 is its own (second boot numbered ${boot})`);
  }
});

test('K2d: a continuation under a report that the window governs the agent\'s stream, at the stand-in\'s window, isn\'t held to the stream bound, and a note says so', () => {
  const { flags, headroom, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`)), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, []);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled'], 'no continuation headroom against a bound that doesn\'t govern it');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('K2d: under a report that the window governs, a window other than the stand-in\'s makes every continuation couldn\'t-judge, smaller or larger', () => {
  for (const [printed, standin] of [['500.0k', 1_000_000], ['2.0M', 1_000_000], ['1.0M', 200_000]]) {
    const clause = WINDOW_CLAUSE.replace('1.0M', printed);
    const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${clause}`)), { streamBound: 30_000, windowTokens: standin });
    assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], `${printed} against ${standin}`);
    for (const f of flags) assert.match(f.message, new RegExp(`couldn't judge.*${printed.replace('.', '\\.')}.*${standin}`));
    assert.deepEqual(notes, []);
  }
});

test('K2d: a continuation under a report without that clause is held to the stream bound', () => {
  const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3']);
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(notes, []);
});

test('K2d: with no report logged, only a continuation after a round over the stream bound is couldn\'t-judge', () => {
  for (const log of [under(null)]) {
    const { flags } = budgets(crossing(), [turnStep('a')], log, { streamBound: 30_000, windowTokens: 1_000_000 });
    assert.deepEqual(flags.map((f) => f.request), ['r3'], JSON.stringify(log.map((e) => e.kind)));
    assert.match(flags[0].message, /couldn't judge/);
  }
  const late = budgets(crossing(), [turnStep('a')], [...R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags;
  assert.deepEqual(late.map((f) => f.request), ['r3']);
  assert.match(late[0].message, /couldn't judge/);
});

test('K2d: a /budget report with no line for the run\'s agent, or one in neither form the host writes, leaves check 3 judging nothing, since which bound governs can\'t be read; a subagent\'s line isn\'t looked for', () => {
  const lines = [
    [], ['  other: 30.0k (last: 0, 0%)'], ['  fixture: 30.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn'],
    ['  fixture: 30.0k (last: 0, 0%); only the context window interrupts this stream'], ['  fixture: 30.0k'],
    ['  fixture: 30k (last: 0, 0%)'], ['  fixture: 30,000 (last: 0, 0%)'],
    ['  fixture: 30.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1,000,000 window can\'t hold'],
  ];
  const logs = [...lines.map((l) => under(budgetReport(...l))), under({ kind: 'budget-report', boot: 1, lines: ['--- Budgets ---'], ms: 5 }), under({ kind: 'budget-report', boot: 1, lines: ['No agents.'], ms: 5 }), under({ kind: 'budget-report', boot: 1, lines: ['Unknown command: /budget'], ms: 5 })];
  for (const log of logs) {
    const { flags, judged, headroom, notes } = budgets(crossing(), [turnStep('a')], log, { streamBound: 30_000, windowTokens: 1_000_000 });
    assert.deepEqual([judged, flags.map((f) => [f.check, f.what]), headroom, notes], [0, [[3, 'budget-unreadable']], [], []], JSON.stringify(log[0].lines));
  }
  assert.match(budgets(crossing(), [turnStep('a')], logs[0], { streamBound: 30_000, windowTokens: 1_000_000 }).flags[0].message, /^couldn't judge fixture's 3 request\(s\): the host's \/budget report at boot 1 has no line for fixture, so the bound that governs its continuation rounds can't be read$/);
  assert.match(budgets(crossing(), [turnStep('a')], logs[2], { streamBound: 30_000, windowTokens: 1_000_000 }).flags[0].message, /at boot 1 writes fixture's line in no form the check reads/);
  const sub = budgets(crossing().map((r) => ({ ...r, agent: 'sub' })), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%)')), { agent: 'knowledge-1', streamBound: 30_000, windowTokens: 1_000_000 });
  assert.ok(!sub.flags.some((f) => f.what === 'budget-unreadable'), 'a subagent launched after the boot isn\'t in its report');
});

test('K2d: an agent made after the boot, as a fork of conversations is, is judged under a /budget report that lists it after its first compile, and with none, check 3 judges nothing for it', () => {
  const fork = 'conversation-chat-g1-abc';
  const [records, compiled] = crossingAs(fork);
  const boot = budgetReport('  fixture: 30.0k (last: 0, 0%)');
  const opts = { agent: fork, streamBound: 30_000, windowTokens: 1_000_000 };
  const none = budgets(records, [turnStep('a')], [boot, ...compiled, sent('r1'), sent('r2'), sent('r3'), panel('s')], opts);
  assert.deepEqual([none.judged, none.flags.map((f) => [f.check, f.what])], [0, [[3, 'budget-unreadable']]]);
  assert.match(none.flags[0].message, /the host's \/budget report came at no point after conversation-chat-g1-abc's first compile/);
  const listed = budgets(records, [turnStep('a')], [boot, ...compiled, budgetReport('  fixture: 30.0k (last: 0, 0%)', `  ${fork}: 30.0k (last: 0, 0%)`), sent('r1'), sent('r2'), sent('r3'), panel('s')], opts);
  assert.ok(listed.judged > 0 && !listed.flags.some((f) => f.what === 'budget-unreadable'));
});

test('K2d: a report whose figure isn\'t the stream bound as the host formats it makes every continuation under it couldn\'t-judge', () => {
  const { flags, headroom } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], 'r2 follows a round under the bound and is still couldn\'t-judge');
  for (const f of flags) assert.match(f.message, /couldn't judge.*150\.0k.*30000.*30\.0k/);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled']);
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 1.0M (last: 0, 0%)')), { streamBound: 1_000_000, windowTokens: 1_000_000 }).flags, [], 'a million, as the host writes it');
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { windowTokens: 1_000_000 }).flags, [], 'the default bound, as the host writes it');
});

test('K2b: a compiled request is held to the model\'s window by the stand-in\'s count of its whole input, every one of them, and context-manager\'s budgetMet flags nothing', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const [records, lines] = compiledAs([opened('r1', 'a', 17_952, 30_000), opened('r2', 'a', 18_000, 31_000), opened('r3', 'b', 10_000, 18_000)], ['r1', 'r2', 'r3']);
  const log = [...lines, panel('s'), panel('t', { budgetMet: false, exhausted: true })];
  const { flags, headroom } = budgets(records, script, log, { windowTokens: 30_000 });
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.request]), [[3, 'a', 'r2']]);
  assert.match(flags[0].message, /31000.*30000-token window/);
  assert.deepEqual(headroom.map((h) => [h.segment, h.kind, h.request, h.tokens, h.bound]), [['s', 'compiled', 'r2', 31_000, 30_000], ['t', 'compiled', 'r3', 18_000, 30_000]], 'the least headroom of each segment, against the window');
});

test('K2b: a continuation round is held to the stream bound by its stream\'s fresh input before it, flagged only once that sum is over it', () => {
  const script = [turnStep('a')];
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 22_000, 31_000, ['t2']);
  const [records, lines] = compiledAs([r1, r2, continued(r2, 'r3', 23_000, 32_000)], ['r1']);
  const log = [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')];
  const { flags, headroom } = budgets(records, script, log, { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3'], 'r2 may cross the bound, since r1\'s fresh 29,000 was under it; r3 follows r1\'s and r2\'s fresh 31,000');
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(headroom.filter((h) => h.kind === 'continuation').map((h) => [h.request, h.tokens, h.bound]), [['r3', 32_000, 30_000]]);
  assert.equal(budgets(records, script, [...lines, panel('s')], { windowTokens: 1_000_000 }).flags.length, 0, 'under agent-framework 0.28.0\'s default bound, 150,000, none is over');
  assert.deepEqual(budgets(records, script, [...lines, panel('s', { budgetMet: false })], { windowTokens: 1_000_000 }).flags, [], 'context-manager\'s budgetMet is no flag');
});

test('K2b: a continuation is held to its stream\'s fresh input so far, as membrane sums it, not to the whole input of the request before it', () => {
  const script = [turnStep('a')];
  const w1 = opened('w1', 'a', 20_000, 31_000, ['t1'], 2_000);
  const [warm, warmLines] = compiledAs([w1, continued(w1, 'w2', 21_000, 32_000)], ['w1']);
  assert.deepEqual(budgets(warm, script, [...warmLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags, []);
  const x1 = opened('x1', 'a', 12_000, 20_000, ['t1']);
  const x2 = continued(x1, 'x2', 14_000, 25_000, ['t2'], 10_000);
  const [missed, missedLines] = compiledAs([x1, x2, continued(x2, 'x3', 15_000, 27_000)], ['x1']);
  const { flags } = budgets(missed, script, [...missedLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('x1'), sent('x2'), sent('x3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['x3']);
  assert.match(flags[0].message, /fresh input reached 35000 tokens, over the stream bound 30000/);
  const wide = budgets(warm, script, [...warmLines, budgetReport('  fixture: 300.0k (last: 0, 0%)'), panel('s')], { streamBound: 300_000, windowTokens: 31_500 }).flags;
  assert.deepEqual(wide.map((f) => f.request), ['w2']);
  assert.match(wide[0].message, /continuation round's whole input at 32000 tokens, over the model's 31500-token window/);
});

test('K2b: a Responses round adds what membrane counts as its input to its stream\'s sum, input_tokens less cached_tokens', () => {
  const script = [turnStep('a')];
  const asResponses = (r) => {
    const u = r.usage;
    return { ...r, usage: { input_tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, input_tokens_details: { cached_tokens: u.cache_read_input_tokens, cache_write_tokens: u.cache_creation_input_tokens }, output_tokens: 0 } };
  };
  const x1 = opened('x1', 'a', 12_000, 20_000, ['t1']);
  const x2 = continued(x1, 'x2', 14_000, 25_000, ['t2'], 10_000);
  const [missed, missedLines] = compiledAs([x1, x2, continued(x2, 'x3', 15_000, 27_000)].map(asResponses), ['x1']);
  const { flags } = budgets(missed, script, [...missedLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('x1'), sent('x2'), sent('x3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['x3']);
  assert.match(flags[0].message, /fresh input reached 35000 tokens, over the stream bound 30000/, 'x2\'s 10,000 cached tokens left out');
});

test('K2b: a Chat Completions round adds what membrane counts as its input: prompt_tokens whole through the OpenAI-compatible adapter, and less cached_tokens through the OpenRouter adapter', () => {
  const script = [turnStep('a')];
  const asChat = (dialect) => (r) => {
    const u = r.usage;
    return { ...r, head: { api: 'chat-completions', dialect }, usage: { prompt_tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens, cache_write_tokens: u.cache_creation_input_tokens }, completion_tokens: 0 } };
  };
  const reached = (dialect) => {
    const x1 = opened('x1', 'a', 12_000, 20_000, ['t1']);
    const x2 = continued(x1, 'x2', 14_000, 25_000, ['t2'], 10_000);
    const [records, lines] = compiledAs([x1, x2, continued(x2, 'x3', 15_000, 27_000)].map(asChat(dialect)), ['x1']);
    const { flags } = budgets(records, script, [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('x1'), sent('x2'), sent('x3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
    return flags.map((f) => [f.request, /fresh input reached (\d+) tokens/.exec(f.message)?.[1]]);
  };
  assert.deepEqual(reached('openai'), [['x3', '45000']], 'x2\'s 10,000 cached tokens counted again');
  assert.deepEqual(reached('openrouter'), [['x3', '35000']], 'x2\'s 10,000 cached tokens left out');
});

test('K2b: for a second agent, check 3 judges its own requests (the stand-in\'s sub records) and none of the primary\'s', () => {
  const sub = (r) => ({ ...r, agent: 'sub' });
  const s1 = sub(opened('s1', 'a', 2_000, 10_000, ['t1']));
  const s2 = sub(continued(s1, 's2', 2_100, 11_000, ['t2']));
  const s3 = sub(continued(s2, 's3', 2_200, 12_000));
  const p1 = { ...opened('p1', 'b', 1_000, 9_000), agent: 'primary' };
  const script = [turnStep('a'), turnStep('b')];
  const [subMarked, subLines] = compiledAs([s1, s2, s3, p1], ['s1'], 'knowledge-1');
  const [records, primaryLines] = compiledAs(subMarked, ['p1']);
  const log = [...subLines, ...primaryLines, sent('s1'), sent('s2'), sent('s3'), sent('p1')];
  const forSub = budgets(records, script, log, { agent: 'knowledge-1', streamBound: 100_000, windowTokens: 1_000_000 });
  assert.deepEqual(forSub.flags, []);
  assert.equal(forSub.requests, 3);
  assert.equal(forSub.judged, 3, 'the subagent\'s compiled request and its two continuation rounds');
  assert.deepEqual(forSub.headroom.map((h) => [h.kind, h.request]), [['compiled', 's1'], ['continuation', 's3']]);
  const forPrimary = budgets(records, script, log, { streamBound: 100_000, windowTokens: 1_000_000 });
  assert.equal(forPrimary.requests, 1);
  assert.equal(forPrimary.judged, 1);
});

test('K2b: a request the stand-in answered with a provider error isn\'t judged, and adds nothing to its stream\'s fresh input; the retry is judged', () => {
  const script = [turnStep('a')];
  const failed = { ...opened('r1', 'a', 20_000, 31_000, ['t1']), usage: undefined, tokens: undefined, answer: { shape: 'error', status: 529 } };
  const retry = opened('r2', 'a', 20_000, 29_000, ['t1']);
  const next = continued(retry, 'r3', 21_000, 30_000);
  const [records, lines] = compiledAs([failed, retry, next], ['r1']);
  const { flags, judged } = budgets(records, script, [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, [], 'the error\'s missing usage is no couldn\'t-judge');
  assert.equal(judged, 2, 'the retry and its continuation');
});

test('K2b: a run with no compile line of the agent\'s, a compiled request with no usage, a check given no window, and a segment with no agent request each say the check couldn\'t judge', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const lineless = budgets([opened('r1', 'a', 1_000)], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 });
  assert.deepEqual(lineless.flags.map((f) => [f.check, f.step, f.what]), [[3, 'the run', 'no-compile-lines']]);
  assert.match(lineless.flags[0].message, /couldn't judge fixture's 1 request\(s\): the log holds no request compile line of fixture's/);
  assert.equal(lineless.judged, null, 'judged none, and counted as unknown rather than as nothing judged');
  const primaryLine = compiledAs([opened('p1', 'a', 1_000)], ['p1'])[1];
  const subLineless = budgets([{ ...opened('s1', 'a', 1_000), agent: 'sub' }], [turnStep('a')], [...primaryLine, panel('s')], { agent: 'knowledge-1', windowTokens: 1_000_000 }).flags;
  assert.match(subLineless[0].message, /couldn't judge knowledge-1's 1 request\(s\)/, 'the primary\'s lines don\'t stand for a second agent\'s');
  const [unusedRecords, unusedLines] = compiledAs([{ ...opened('r1', 'a', 1_000), usage: undefined, tokens: undefined }], ['r1']);
  const unused = budgets(unusedRecords, [turnStep('a')], [...unusedLines, panel('s')], { windowTokens: 1_000_000 }).flags;
  assert.deepEqual(unused.map((f) => f.request), ['r1']);
  assert.match(unused[0].message, /couldn't judge.*no usage/);
  const [one, oneLine] = compiledAs([opened('r1', 'a', 1_000)], ['r1']);
  const windowless = budgets(one, [turnStep('a')], [...oneLine, panel('s')]).flags;
  assert.deepEqual(windowless.map((f) => f.request), ['r1']);
  assert.match(windowless[0].message, /couldn't judge.*no window/);
  const [two, twoLines] = compiledAs([opened('r1', 'a', 1_000), opened('r2', 'b', 1_000)], ['r1', 'r2']);
  assert.deepEqual(budgets(two, script, [...twoLines, panel('s'), panel('t', { budget: 30_000 })], { windowTokens: 1_000_000 }).flags, [], 'a budget that moved between checkpoints bounds nothing the check reads');
  assert.equal(budgets([], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 }).flags.length, 1, 'a checkpoint whose segment made no agent request is a flag');
});

test('K2b: a continuation round with no usage recorded, or with no window given, is couldn\'t-judge, as a compiled request is', () => {
  const script = [turnStep('a')];
  const r1 = opened('r1', 'a', 10_000, 12_000, ['t1']);
  const [records, lines] = compiledAs([r1, { ...continued(r1, 'r2', 11_000, 13_000), usage: undefined, tokens: undefined }], ['r1']);
  const { flags, judged } = budgets(records, script, [...lines, sent('r1'), sent('r2'), panel('s')], { windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2']);
  assert.match(flags[0].message, /couldn't judge this continuation round: the stand-in recorded no usage for it/);
  assert.equal(judged, 1, 'the compiled request alone');
  const [whole, wholeLines] = compiledAs([r1, continued(r1, 'r2', 11_000, 13_000)], ['r1']);
  const windowless = budgets(whole, script, [...wholeLines, sent('r1'), sent('r2'), panel('s')]).flags;
  assert.deepEqual(windowless.map((f) => f.request), ['r1', 'r2']);
  assert.match(windowless[1].message, /couldn't judge this continuation round: the check was given no window/);
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

const resetStore = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: [], topicTransition: true },
    { id: 'm4', canaries: ['[[c:b.in]]'] }, { id: 'm5', canaries: ['[[c:b.r1]]'] },
    { id: 'm6', canaries: ['[[c:c.in]]'] },
  ],
  summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
};

const resetScript = [turnStep('a'), turnStep('b'), turnStep('c')];

const headOf3 = [panel('s', { head: 3, tail: 0 })];

test('K3b: after a head-window reset, store order holds within the head window and within what follows it, not across them', () => {
  // context-manager renders the head (from the transition on) first, then the summary of what came before it.
  const correct = { id: 'correct', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedHead = { id: 'swapped-head', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedRest = { id: 'swapped-rest', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'), summaryBlock('[[s:C1]]'))] };
  const order = (r) => coverage([r], resetStore, resetScript, headOf3).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(order), ['swapped-head', 'swapped-rest']);
  const unsized = (r) => coverage([r], resetStore).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(unsized), ['swapped-head']);
});

test('check 4 reads a block carrying both summaries and canaries in the order its marks give, as on the Chat Completions API, where membrane joins a message\'s text blocks into one', () => {
  const joined = (marks) => ({ type: 'text', chars: 10, canaries: marks.filter((x) => x.startsWith('[[c:')), summaries: marks.filter((x) => x.startsWith('[[s:')), marks });
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', joined(['[[s:C1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']))] };
  const outOfOrder = { id: 'out-of-order', step: 'c', kind: 'agent', messages: [msg('user', joined(['[[c:b.in]]', '[[s:C1]]', '[[c:b.r1]]', '[[c:c.in]]']))] };
  const unmarked = { id: 'unmarked', step: 'c', kind: 'agent', messages: [msg('user', { ...joined(['[[s:C1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']), marks: undefined })] };
  const store = { messages: resetStore.messages.filter((m) => !m.topicTransition), summaries: resetStore.summaries };
  const order = (r) => coverage([r], store).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([inOrder, outOfOrder].flatMap(order), ['out-of-order']);
  assert.deepEqual(order(unmarked), ['unmarked'], 'without marks a block\'s canaries are read before its summaries, which is why a block carrying both keeps them');
});

test('check 4 holds only a segment\'s last request to the head its checkpoint reported; an earlier one splits at the head\'s start alone', () => {
  const store = {
    messages: [...resetStore.messages, { id: 'm7', canaries: ['[[c:c.r1]]'] }, { id: 'm8', canaries: ['[[c:d.in]]'] }],
    summaries: resetStore.summaries,
  };
  const script = [...resetScript, turnStep('d')];
  const headOf2 = [panel('s', { head: 2, tail: 0 })];
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]')), msg('assistant', carrying('[[c:c.r1]]')), msg('user', carrying('[[c:d.in]]'))] };
  const lastSwapped = { ...last, id: 'last-swapped', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]')), ...last.messages.slice(3)] };
  const earlySwapped = { ...early, id: 'early-swapped', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), early.messages[2]] };
  const order = (rs) => coverage(rs, store, script, headOf2).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual(order([early, last]), []);
  assert.deepEqual(order([early, lastSwapped]), ['last-swapped'], 'b.r1 is past the reported head, so it comes after the history before the head');
  assert.deepEqual(order([earlySwapped, last]), ['early-swapped'], 'from the head\'s start on, an earlier request still runs in store order');
});

test('K6b: check 6\'s head window starts at the last topic transition stored before the request', () => {
  const r = { id: 'after-reset', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.deepEqual(windowsRaw([r], resetScript, headOf3, resetStore).filter((f) => /head window/.test(f.message)), [], 'a.in and a.r1 are before the head now, and may fold');
  const lost = { ...r, id: 'lost', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.match(windowsRaw([lost], resetScript, headOf3, resetStore).find((f) => /head window/.test(f.message))?.message ?? '', /b\.r1/);
});

test('K3: check 4 flags a request whose raw messages and summaries don\'t run in store order', () => {
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merge = { id: 'merge', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:c.in]]'))] };
  const swapped = { id: 'swapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C2]]', '[[s:C1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const rawFirst = { id: 'raw-first', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]')), msg('user', summaryBlock('[[s:C3]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const flags = [inOrder, merge, swapped, rawFirst, twice].flatMap((r) => coverage([r], store)).filter((f) => /store order/.test(f.message));
  assert.deepEqual(flags.map((f) => f.request), ['swapped', 'raw-first']);
});

test('K4: check 6 holds a segment\'s last request to the raw tail the host reported, past the two turns before it, among what was stored before it', () => {
  const script = [turnStep('q'), turnStep('p'), turnStep('a'), turnStep('b'), turnStep('c')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [...['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1'].map((c) => stored(`[[c:${c}]]`)), stored(), stored('[[c:c.in]]'), stored('[[c:c.r1]]')], summaries: [] };
  const all = ['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in'].map((c) => `[[c:${c}]]`);
  const without = (c) => all.filter((x) => x !== c);
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const log = [panel('s', { head: 1, tail: 7 })];
  assert.deepEqual(windowsRaw([req('b-early', 'b', without('[[c:q.r1]]')), req('ok', 'c', all)], script, log, store), []);
  const folded = windowsRaw([req('folded', 'c', without('[[c:p.r1]]'))], script, log, store);
  assert.deepEqual(folded.map((f) => [f.check, f.request]), [[6, 'folded']], 'p.r1 is past the two turns before c, inside the reported tail');
  assert.match(folded[0].message, /tail.*p\.r1/);
  const errored = { ...req('err', 'c', all), answer: { shape: 'error', status: 529 } };
  assert.deepEqual(windowsRaw([errored, req('retry', 'c', all)], script, log, store), [], 'an error gave c no reply, so its retry is held to the tail before c.r1');
  const noTail = windowsRaw([req('ok', 'c', all)], script, [panel('s', { head: 1 })], store);
  assert.deepEqual(noTail.map((f) => f.message), ["no tail size was reported at segment s's checkpoint"]);
});

test('K4b: check 6 anchors a segment\'s last request\'s tail after the call of a reply answered before it, though a refusal came first', () => {
  const turn = { ...turnStep('c'), replies: [{ stop: 'refusal' }, { text: '[[c:c.r1]] x', calls: [{ name: 'result', input: { kind: 'prose', canary: '[[c:c.call1]]' } }] }, { text: '[[c:c.r2]] y' }] };
  const script = [turnStep('a'), turnStep('b'), turn];
  const stored = (c) => ({ canaries: [`[[c:${c}]]`] });
  const store = { messages: ['a.in', 'a.r1', 'b.in', 'b.r1', 'c.in', 'c.r1', 'c.call1', 'c.r2'].map(stored), summaries: [] };
  const req = (id, canaries, answer) => ({ id, step: 'c', kind: 'agent', ...(answer ? { answer } : {}), messages: [msg('user', carrying(...canaries.map((c) => `[[c:${c}]]`)))] });
  const before = ['a.in', 'a.r1', 'b.in', 'b.r1'];
  const records = [req('refused', [...before, 'c.in'], { shape: 'reply', stop: 'refusal' }), req('called', [...before, 'c.in']), req('last', [...before, 'c.r1', 'c.call1'])];
  const flags = windowsRaw(records, script, [panel('s', { head: 1, tail: 2 })], store);
  assert.deepEqual(flags.filter((f) => /tail/.test(f.message)).map((f) => f.message), [], 'the tail of two ends at c.call1, so it holds c.r1 and not c.in');
  const lacking = windowsRaw([...records.slice(0, 2), req('last', [...before, 'c.call1'])], script, [panel('s', { head: 1, tail: 2 })], store);
  assert.deepEqual(lacking.filter((f) => /tail/.test(f.message)).map((f) => f.message), ['the reported tail\'s [[c:c.r1]] isn\'t raw'], 'the tail is judged there, and owes c.r1');
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

test('check 4: a request the stand-in answered with an error gives its step no reply, so its retry needs none', () => {
  const failed = { id: 'r3', step: 'c', kind: 'agent', answer: { shape: 'error', status: 529 }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const retry = { id: 'r4', step: 'c', kind: 'agent', answer: { shape: 'reply' }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([failed, retry], store).map((f) => f.request), [], 'the retry is held to what the step had stored, not to a reply the error never gave');
});

test('check 4 on a subagent: its requests are held to its own store up to the last canary each carries, whatever the canaries are named', () => {
  const sub = {
    messages: [{ id: 's1', canaries: ['[[c:k.task]]'] }, { id: 's2', canaries: ['[[c:k.s1]]'] }, { id: 's3', canaries: ['[[c:k.s1call1]]'] }, { id: 's4', canaries: ['[[c:k.s2]]'] }],
    summaries: [{ id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['s2', 's3'], number: '[[s:C9]]', covers: ['[[c:k.s1]]', '[[c:k.s1call1]]'] }],
  };
  const whole = { id: 'whole', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('assistant', summaryBlock('[[s:C9]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const lost = { id: 'lost', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const primaryOnly = coverage([whole, lost], sub);
  assert.equal(primaryOnly.judged, 0, 'the primary\'s side judges none of a subagent\'s requests');
  const flags = coverage([whole, lost], sub, [], [], { side: 'sub' });
  assert.equal(flags.judged, 2);
  assert.deepEqual(flags.map((f) => [f.request, f.what]), [['lost', 'not-reached']]);
  assert.match(flags[0].message, /\[\[c:k\.s1\]\] \[\[c:k\.s1call1\]\]/);
});

test('check 6 counts a request as judged only where it held it to some message', () => {
  const script = ['a', 'b', 'c'].map((id) => ({ id, segment: 's', replies: [{ text: `[[c:${id}.r1]]` }] }));
  const empty = { messages: [], summaries: [] };
  const r = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]'))] };
  assert.equal(windowsRaw([r], script, [], empty).judged, 0, 'nothing stored, so nothing to hold it to');
  assert.equal(windowsRaw([r], script, [], null).judged, 1, 'without a store read, the script\'s turns hold it');
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

test('check 5 holds a subagent\'s summary to every source it covers, as check 4 does, since a subagent\'s inputs and replies carry their own canaries', () => {
  const store = { messages: [{ id: 'k1', canaries: ['[[c:k.task]]'] }, { id: 'k2', canaries: ['[[c:k.s1]]'] }], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['k1', 'k2'], number: '[[s:C1]]', covers: ['[[c:k.task]]', '[[c:k.s1]]'] }] };
  const call = (canaries) => ({ id: 'c1', step: 'k', kind: 'summariser', answer: { summary: '[[s:C1]]' }, sent: { canaries, summaries: [] } });
  const primary = bookkeeping([call([])], store);
  assert.equal(primary.judged, 0, 'by the primary\'s rule these are no turn\'s input or reply');
  const sub = bookkeeping([call(['[[c:k.task]]', '[[c:k.s1]]'])], store, { side: 'sub' });
  assert.deepEqual(sub, []);
  assert.equal(sub.judged, 1);
  assert.deepEqual(bookkeeping([call(['[[c:k.task]]'])], store, { side: 'sub' }).map((f) => f.request), ['c1'], 'a source its request didn\'t show');
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

test('check 4 counts, beside what it judged, each request it couldn\'t judge because the final store doesn\'t hold its own input', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const gone = { id: 'gone', step: 'z', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:z.in]]'))] };
  const both = coverage([ok, gone], store);
  assert.equal(both.judged, 1);
  assert.equal(both.besides, '1 request not judged, as the final store doesn\'t hold its own input');
  assert.equal(coverage([ok], store).besides, undefined, 'nothing is said where every request was judged');
});

test('check 6 counts, beside what it judged, each message of the two turns before a request that it didn\'t ask for because the final store doesn\'t hold it', () => {
  const turns = [turnStep('a'), turnStep('b'), turnStep('c')];
  const withoutA = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] };
  const flags = windowsRaw([req], turns, [], withoutA);
  assert.deepEqual([...flags], []);
  assert.equal(flags.besides, '1 recent message not asked for, as the final store doesn\'t hold it');
  const whole = { ...withoutA, messages: [{ id: '0', canaries: ['[[c:a.in]]'] }, { id: '00', canaries: ['[[c:a.r1]]'] }, ...withoutA.messages.slice(1)] };
  assert.equal(windowsRaw([{ ...req, messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] }], turns, [], whole).besides, undefined);
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

test('check 5 counts the answers and sources it can\'t judge beside what it judged, never skipping them silently', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const gone = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']), shown('[[s:C9]]', ['[[c:a.in]]'])], store);
  assert.match(gone.besides ?? '', /^1 summariser answer not judged, as the final store doesn't hold its summary/);
  const blank = { ...store, messages: store.messages.map((m) => ({ ...m, canaries: [] })) };
  const unknown = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], blank);
  assert.match(unknown.besides ?? '', /source(s)? not judged, as nothing (it covers|they cover) carries a canary to tell by/);
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

test('check 6 counts each checkpoint tail it judges, and counts one it can\'t place in the final store beside them', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const all = ['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'];
  const storeOf = (names) => ({ messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), ...names.map((c) => stored(`[[c:${c}]]`))], summaries: [] });
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const placed = windowsRaw([full], script, log, storeOf(all));
  const lost = windowsRaw([full], script, log, storeOf(all.filter((c) => c !== 'd.in')));
  assert.equal(placed.judged, lost.judged + 1, 'a tail it judges counts');
  assert.ok(!/checkpoint tail/.test(placed.besides ?? ''));
  assert.match(lost.besides ?? '', /1 checkpoint tail not judged, as the final store doesn't hold its last input/);
});

test('a step\'s reply canaries are the ones its replies\' text carries: a reply with none carries none, a contained one is owed nowhere, and a step the script doesn\'t hold is numbered', () => {
  const step = { id: 's', replies: [{ stop: 'refusal' }, { text: '[[c:s.r1]] words' }, { calls: [{ name: 'skip_reply' }] }, { error: { status: 529 } }, { text: '>>#side {{unsent}}' }, { text: '[[c:s.r2]] more [[c:other.r1]]' }] };
  assert.deepEqual(replyCanaries(step), ['[[c:s.r1]]', '[[c:s.r2]]']);
  assert.deepEqual(replyCanaries(step, 1), ['[[c:s.r1]]'], 'the refusal and the error are no answered reply');
  assert.deepEqual(replyCanaries(step, 2), ['[[c:s.r1]]'], 'tool calls alone carry no canary');
  assert.deepEqual(replyCanaries(step, 4), ['[[c:s.r1]]', '[[c:s.r2]]'], 'the error is no answered reply either, so the fourth answered reply is s.r2\'s');
  assert.deepEqual(replyCanaries({ id: 'w', ends: 'contained', replies: [{ text: '<t>[[c:w.r1]]</t>' }] }), []);
  assert.deepEqual(replyCanaries({ id: 'u' }, 2), ['[[c:u.r1]]', '[[c:u.r2]]']);
  assert.deepEqual(replyCanaries({ id: 'u' }), [], 'nothing past a request\'s own step needs it unbounded');
  const stalled = { id: 'k', replies: [{ hold: true, cut: true }, { text: '[[c:k.r1]] fresh' }] };
  assert.deepEqual(replyCanaries(stalled, 1), ['[[c:k.r1]]'], 'a reply its client cuts is no answered reply, so the first answered reply is the fresh call\'s');
});

test('K2b: a compiled request its client cut before any answer isn\'t judged, and it gives its step no answered reply; the fresh call compiled after it is judged', () => {
  const script = [turnStep('a')];
  const cut = { ...opened('r1', 'a', 20_000, 31_000, ['t1']), usage: undefined, tokens: undefined, answer: { shape: 'cut' } };
  const fresh = opened('r2', 'a', 20_000, 29_000, ['t1']);
  const next = continued(fresh, 'r3', 21_000, 30_000);
  const [records, lines] = compiledAs([cut, fresh, next], ['r1', 'r2']);
  const { flags, judged } = budgets(records, script, [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, [], 'the cut call\'s missing usage is no couldn\'t-judge');
  assert.equal(judged, 2, 'the fresh call and its continuation');
  assert.equal(answeredBare(cut), true);
  assert.equal(answeredBare(fresh), false);
});

test('check 4: where the store\'s window is presented, a request is held to the order its rows entered the window, not store order, and a row the last window doesn\'t hold is left out of that order and counted once as not judged for it, whatever its canaries and however it was sent; a store whose window is the record is held to store order, and a presented window that holds no row orders nothing', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ...(ordinal !== undefined ? { ordinal } : {}) });
  const windowed = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]'], 2), at('m3', ['[[c:b.in]]'], 4), at('m4', ['[[c:a.r2]]'], 3)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'b', segment: 's' }];
  const request = (id, ...canaries) => ({ id, step: 'b', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const order = (store, r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => [f.what, f.message]);
  assert.deepEqual(order(windowed, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), []);
  assert.deepEqual(order(windowed, request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:a.r2]]')), [['window-order', 'it carries [[c:a.r2]] after [[c:b.in]], out of the order its window presented them in']]);
  const record = { presented: false, messages: windowed.messages.map(({ ordinal, ...m }) => m), summaries: [] };
  assert.deepEqual(order(record, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), [['store-order', 'it carries [[c:b.in]] after [[c:a.r2]], out of store order']]);
  const emptied = { ...record, presented: true };
  assert.deepEqual(order(emptied, request('w', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')), [], 'a presented window that holds no row orders nothing, rather than falling back to store order');
  const left = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]'], 2), at('m3', ['[[c:b.in]]'], 4), at('m4', ['[[c:a.r2]]'])], summaries: [] };
  const leftFlags = coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:a.r2]]')], left, script);
  assert.deepEqual(leftFlags.filter((f) => /order/.test(f.what ?? '')), [], 'a row the last window doesn\'t hold isn\'t ordered');
  assert.equal(leftFlags.besides, '1 row not judged for order, as the final window doesn\'t hold it');
  const two = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:a.r1]]', '[[c:a.r2]]']), at('m3', ['[[c:b.in]]'], 2)], summaries: [] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], two, script).besides, '1 row not judged for order, as the final window doesn\'t hold it', 'a row carrying two counted canaries counts once');
  const summed = { presented: true, messages: [at('m1', ['[[c:a.in]]']), at('m2', ['[[c:a.r1]]']), at('m3', ['[[c:b.in]]'], 1)], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }] };
  const under = (id, ...items) => ({ id, step: 'b', kind: 'agent', messages: [msg('user', { type: 'text', chars: 10, canaries: items.filter((x) => x.startsWith('[[c:')), summaries: items.filter((x) => x.startsWith('[[s:')) })] });
  assert.equal(coverage([under('s', '[[s:C1]]', '[[c:b.in]]')], summed, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a summary over two rows the window doesn\'t hold counts both');
  assert.equal(coverage([under('s', '[[c:a.r1]]', '[[c:b.in]]'), under('t', '[[s:C1]]', '[[c:b.in]]')], summed, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a row sent raw in one request and under a summary in another counts once');
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:z.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], windowed, script).besides, '1 canary not judged for order, as no row the final store holds carries it');
  const quoted = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), { ...at('h1', ['[[c:a.r1]]', '[[c:a.r2]]']), suppressed: true }, at('v1', ['[[c:a.r1]]']), at('v2', ['[[c:a.r2]]']), at('m3', ['[[c:b.in]]'], 2)], summaries: [] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:b.in]]')], quoted, script).besides, '2 rows not judged for order, as the final window doesn\'t hold them', 'a hidden row is no row a sent canary came from: the two rows that quote it are counted');
  const hiddenOnly = { ...quoted, messages: [...quoted.messages, { ...at('h2', ['[[c:x.in]]']), suppressed: true }] };
  assert.equal(coverage([request('s', '[[c:a.in]]', '[[c:a.r1]]', '[[c:a.r2]]', '[[c:x.in]]', '[[c:b.in]]')], hiddenOnly, script).besides, '3 rows not judged for order, as the final window doesn\'t hold them', 'a canary only a hidden row carries, sent anyway, is counted by that row, which the store holds');
});

test('check 4: an event\'s place in the window is its own row\'s, though a later gate line quotes it, and a gate line\'s quote of an event its batch held isn\'t judged as that event\'s place in a request', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'b', segment: 's' }];
  const block = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const gate = (...canaries) => ({ type: 'text', chars: 10, wakeLine: canaries.length, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'))] }), [], 'the event in its own place, before a row stored after it');
  assert.deepEqual(order({ id: 'r2', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'), gate('[[c:c.in]]'))] }), [], 'and quoted again by the gate line after it');
  assert.deepEqual(order({ id: 'r3', step: 'b', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'the event itself out of its place still flags');
});

test('check 4: in a block that opens with a gate line, only the canaries the request carried before it go unjudged for order, so a row joined after the line, as the Chat Completions API joins a message\'s text blocks, is judged', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4), at('m4', ['[[c:d.in]]'], 5)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'd', segment: 's' }];
  const block = (...canaries) => ({ type: 'text', chars: 10, canaries });
  const joined = (...canaries) => ({ type: 'text', chars: 10, wakeLine: 1, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'd', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]'), joined('[[c:c.in]]', '[[c:d.in]]'))] }), [], 'the line\'s quote skipped, the row joined after it in its place');
  assert.deepEqual(order({ id: 'r2', step: 'd', kind: 'agent', messages: [msg('user', block('[[c:a.in]]', '[[c:c.in]]', '[[c:d.in]]'), joined('[[c:c.in]]', '[[c:b.in]]'))] }), ['it carries [[c:b.in]] after [[c:d.in]], out of the order its window presented them in'], 'a row joined after the line out of its place flags');
  const summarised = { ...store, summaries: [{ number: '[[s:1]]', covers: ['[[c:a.in]]', '[[c:c.in]]'] }] };
  const sum = (...marks) => ({ type: 'text', chars: 10, summaries: marks });
  assert.deepEqual(coverage([{ id: 'r3', step: 'd', kind: 'agent', messages: [msg('user', sum('[[s:1]]'), block('[[c:b.in]]'), joined('[[c:c.in]]', '[[c:d.in]]'))] }], summarised, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message), [], 'an event a summary sent before the line covers is a quote too');
});

test('check 4: in a block where the gate line opens a line after earlier rows, as the Chat Completions API joins a message\'s text blocks, the line\'s quote of an event whose own row came before it in the block goes unjudged, and the rows before the line are judged in their place', () => {
  const at = (id, canaries, ordinal) => ({ id, canaries, ordinal });
  const store = { presented: true, messages: [at('m1', ['[[c:a.in]]'], 1), at('m2', ['[[c:c.in]]'], 2), at('m3', ['[[c:b.in]]'], 3), at('g1', ['[[c:c.in]]'], 4), at('m4', ['[[c:d.in]]'], 5)], summaries: [] };
  const script = [{ id: 'a', segment: 's' }, { id: 'd', segment: 's' }];
  const joined = (after, ...canaries) => ({ type: 'text', chars: 10, wakeLine: 1, wakeAfter: after, canaries });
  const order = (r) => coverage([r], store, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message);
  assert.deepEqual(order({ id: 'r1', step: 'd', kind: 'agent', messages: [msg('user', joined(3, '[[c:a.in]]', '[[c:c.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), [], 'the event\'s own row and a row after it, then the line quoting the event, then a row after the line');
  assert.deepEqual(order({ id: 'r2', step: 'd', kind: 'agent', messages: [msg('user', joined(3, '[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'a row before the line out of its place still flags');
  assert.deepEqual(order({ id: 'r3', step: 'd', kind: 'agent', messages: [msg('user', joined(2, '[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'))] }), ['it carries [[c:c.in]] after [[c:b.in]], out of the order its window presented them in'], 'an event after the line that the request carried nowhere before it is judged as any row is');
  const summarised = { ...store, summaries: [{ number: '[[s:1]]', covers: ['[[c:a.in]]', '[[c:c.in]]'] }] };
  assert.deepEqual(coverage([{ id: 'r4', step: 'd', kind: 'agent', messages: [msg('user', { type: 'text', chars: 10, wakeLine: 1, wakeAfter: 2, canaries: ['[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'], summaries: ['[[s:1]]'], marks: ['[[s:1]]', '[[c:b.in]]', '[[c:c.in]]', '[[c:d.in]]'] })] }], summarised, script).filter((f) => f.check === 4 && /order/.test(f.what ?? '')).map((f) => f.message), [], 'an event a summary before the line in the block covers is a quote too');
});

const heldStep = (k, forks = true) => ({ id: `h${k}`, segment: 's', kind: 'channel', canaries: [`[[c:h${k}.in]]`, ...(forks ? [`[[c:h${k}.sum.in]]`] : [])], tunedOut: [`[[c:h${k}.in]]`], reader: forks ? { prefix: 'reader/fixture/' } : { name: 'Subconscious' }, ...(forks ? { inputs: [`[[c:h${k}.sum.in]]`], replies: [{ text: `[[c:h${k}.r1]] noted`, calls: [{ name: 'skip_reply' }] }] } : { replies: [] }) });

test('a reader fork is an agent named reader/<resident>/…, the resident\'s alone', () => {
  assert.equal(readerForkOf('reader/fixture/1a2b3c4d/1'), true);
  assert.equal(readerForkOf('reader/other/1a2b3c4d/1'), false);
  assert.equal(readerForkOf('fixture'), false);
  assert.equal(readerForkOf('Subconscious'), false);
  assert.equal(readerForkOf(undefined), false);
});

test('check 4 owes the resident no message its tune-out holds, by the script\'s tunedOut, and still owes it every other', () => {
  const held = { messages: [{ id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] }, { id: 'm3', canaries: ['[[c:h1.in]]'] }, { id: 'm4', canaries: ['[[c:h1.sum.in]]'] }, { id: 'm5', canaries: ['[[c:h1.r1]]'] }, { id: 'm6', canaries: ['[[c:h2.in]]'] }, { id: 'm7', canaries: ['[[c:h2.sum.in]]'] }], summaries: [] };
  const script = [turnStep('a'), heldStep(1), heldStep(2)];
  const wake = (step, ...canaries) => ({ id: `w${step}`, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(coverage([wake('h1', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]')], held, script), [], 'the held message is owed to no request of the resident\'s');
  assert.deepEqual(coverage([wake('h1', '[[c:a.in]]', '[[c:h1.sum.in]]')], held, script).map((f) => f.what), ['not-reached'], 'a message no tune-out holds is owed as before');
  assert.deepEqual(coverage([wake('h2', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]')], held, script), [], 'the next wake turn: the earlier summary and note, and its own summary');
  const lost = coverage([wake('h2', '[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h2.sum.in]]')], held, script);
  assert.deepEqual(lost.map((f) => f.what), ['not-reached'], 'the earlier wake turn\'s note is owed');
  assert.match(lost[0].message, /h1\.r1/);
  const windows = (...canaries) => windowsRaw([wake('h2', ...canaries)], script, [], held);
  assert.deepEqual(windows('[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.sum.in]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]'), [], 'check 6 at the next wake turn');
  assert.deepEqual(windows('[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.r1]]', '[[c:h2.sum.in]]').map((f) => f.message), ['the recent window lacks [[c:h1.sum.in]]'], 'check 6 owes the earlier fork\'s summary');
  const sub = { id: 's', step: 'h1', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]'))] };
  const subSide = coverage([sub], held, script, [], { side: 'sub' });
  assert.deepEqual([[...subSide], subSide.judged], [[], 1], 'a sub side is held to what it carries, as before');
});

test('check 6 owes no request a message the script\'s tune-out holds, with a store read or without one', () => {
  const persistent = { ...heldStep(1, false), replies: [{ text: '[[c:h1.r1]] x' }] };
  const script = [turnStep('a'), persistent, turnStep('c')];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.in]]', '[[c:h1.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  for (const s of [null, store]) {
    assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:h1.r1]]', '[[c:c.in]]'])], script, [], s), [], `the held h1.in isn't owed (${s ? 'store' : 'no store'})`);
    assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:h1.r1]]', '[[c:c.in]]'])], script, [], s).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], `the rest is owed (${s ? 'store' : 'no store'})`);
  }
});

test('check 4 holds each message a tune-out held to its reader fork\'s requests at its step, where the fork\'s framing shows it: a framed message passes, a dropped framing line is flagged, and so is a step with no fork request', () => {
  const script = [turnStep('a'), heldStep(1), heldStep(2)];
  const fork = (step, ...canaries) => ({ id: `f${step}`, step, kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:a.in]]', ...canaries))] });
  const compiled = (step, agent) => ({ kind: 'compiles', step, lines: [{ kind: 'request', agent, outcome: 'compiled' }] });
  const log = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('h2', 'reader/fixture/aa/2')];
  const framed = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, log);
  assert.deepEqual([[...framed], framed.judged], [[], 2]);
  const dropped = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2')], script, log);
  assert.deepEqual(dropped.map((f) => [f.check, f.step, f.what]), [[4, 'h2', 'held-unframed']]);
  assert.match(dropped[0].message, /\[\[c:h2\.in\]\]/);
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]')], script, log).map((f) => f.step), ['h2'], 'no fork request at its step');
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]', '[[c:h2.in]]'), fork('h2')], script, log).map((f) => f.step), ['h2'], 'h2\'s held message only in h1\'s fork request, the wrong step');
  assert.deepEqual(heldFramed([{ ...fork('h2', '[[c:h2.in]]'), agent: 'primary' }, fork('h1', '[[c:h1.in]]')], script, log).map((f) => f.step), ['h2'], 'the resident\'s request carries no fork\'s framing');
  const other = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('h2', 'knowledge')];
  assert.deepEqual(heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, other).map((f) => f.step), ['h2'], 'a sub-side request at h2 that no reader fork owns');
  assert.equal(heldFramed([], [turnStep('a'), heldStep(1, false)], log).judged, 0, 'a persistent reader\'s view is check 11\'s, not this');
  const crowded = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), { kind: 'compiles', step: 'h2', lines: [{ kind: 'request', agent: 'reader/fixture/aa/2', outcome: 'compiled' }, { kind: 'request', agent: 'knowledge', outcome: 'compiled' }] }];
  const unplaced = heldFramed([fork('h1', '[[c:h1.in]]'), fork('h2', '[[c:h2.in]]')], script, crowded);
  assert.deepEqual([[...unplaced], unplaced.judged], [[], 0], 'where check 13 can\'t place the sub side, nothing is judged, which the report flags as couldn\'t-judge');
  const beside = [compiled('a', 'fixture'), compiled('h1', 'reader/fixture/aa/1'), compiled('a', 'spawn-w-1')];
  const labelled = heldFramed([fork('h1', '[[c:h1.in]]'), { id: 'w1', step: 'a', kind: 'agent', agent: 'w', messages: [] }], [turnStep('a'), heldStep(1)], beside);
  assert.deepEqual([[...labelled], labelled.judged], [[], 1], 'a labelled subagent beside the one reader fork leaves the fork the one unlabelled agent, as check 13 places it');
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

test('checks 4 and 6 owe no request after an operator\'s /undo what the script says it took out (its `undoes`), check 4 flags it sent raw after the /undo, and both still owe everything else', () => {
  const undo = { id: 'u', segment: 's', kind: 'command', command: '/undo', undoes: ['[[c:b.r1]]'] };
  const script = [turnStep('a'), turnStep('b'), undo, turnStep('c')];
  const req = (...canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const store = { messages: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], store, script), [], 'check 4');
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]')], store, script).map((f) => f.what), ['not-reached'], 'check 4 still owes a.r1');
  for (const s of [null, store]) {
    assert.deepEqual(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], script, [], s), [], `check 6 (${s ? 'store' : 'no store'})`);
    assert.equal(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:c.in]]')], script, [], s).besides ?? null, null, 'nor counted as one the final store doesn\'t hold');
    assert.deepEqual(windowsRaw([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:c.in]]')], script, [], s).map((f) => f.message), ['the recent window lacks [[c:b.in]]'], `check 6 still owes b.in (${s ? 'store' : 'no store'})`);
  }
  const back = undoneSent([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]')], script);
  assert.deepEqual([back.map((f) => [f.check, f.step, f.what]), back.judged], [[[4, 'c', 'undone-sent']], 1], 'what the /undo took out, sent raw after it, is flagged, with no store read');
  assert.match(back[0].message, /\[\[c:b\.r1\]\]/);
  assert.deepEqual(coverage([req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]')], store, script).map((f) => f.what), [], 'coverage leaves it to that part');
  const before = { ...req('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]'), step: 'b', id: 'rb' };
  assert.deepEqual(coverage([before, { ...before, id: 'rb2' }], store, [turnStep('a'), { ...turnStep('b'), replies: [{ text: '[[c:b.r1]] x' }, { text: '[[c:b.r2]] y' }] }, undo, turnStep('c')]).map((f) => f.request), ['rb2'], 'a request before the /undo is still owed it');
});
