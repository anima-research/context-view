import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { summariser } from './summariser.ts';
import { moduleCounts } from '../strategies/ledger.ts';
import { configurations } from '../strategies/script.ts';
import { runOf } from '../workloads/workloads.ts';
import { CHAT, MERGE, TOOLS, agentBody, arrivals, post, prose, read, startStandin, step, summariserBody, textOf, withStandin } from '../testing/standin.ts';
import type { Posted, StandinOptions } from '../testing/standin.ts';
import type { DeepPartial } from '../testing/deep-partial.ts';
import type { Masker } from '../strategies/compare.ts';
import type { AnthropicUsage } from './anthropic.ts';
import type { HeldEvent } from './standin.ts';
import type { ReadView } from './view.ts';

const WITNESSED = 'Write the memory of this slice of the log. This part of the record predates your own first turn. Target ~200 tokens.';

const READING = 'You have just been reading a substantial body of text — approximately 4000 tokens total in this piece, of which what you just read is a portion. Target ~200 tokens.';

const READING_MERGE = 'You have just re-experienced the portions of text you read above (raw passages from a larger piece), in chronological order. They cover a contiguous stretch of a substantial body of text you have been reading — approximately 9000 tokens in total across all of it. The portions above cover the stretch you are now consolidating at L2.\n\nReflect across the stretch. Target ~200 tokens.';

// Knowledge's other three openings, as context-manager's knowledge.ts writes them (leadSuffix empty).
const SYNTHESIS = 'Capture the reasoning and conclusions from this discussion. What connections were drawn? What hypotheses were formed or rejected? What decisions were made about what to investigate next? Preserve the logic chain.  Aim for about 200 tokens.';

const LESSON = 'Record what knowledge was captured. What lessons were created or updated? What was the evidence basis? Note any confidence gaps or unresolved questions.  Aim for about 200 tokens.';

const SUBAGENT = 'Summarize the subagent work. What tasks were dispatched, what did each return, and what was the coordinator\'s synthesis of the results? Collapse dispatch/wait mechanics.  Aim for about 200 tokens.';

const FRONTDESK = 'Starting from my last message, please describe everything that has happened. Aim for about 200 tokens. Describe it as you would to yourself, as if you are remembering what has happened.';

const KNOWLEDGE = 'Summarize the research performed. What was searched for, what sources were consulted, and what was found? Aim for about 200 tokens.';

test('T1: each compression instruction context-manager sends is a summariser request, though its message carries the slice\'s canaries', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('k', []));
  for (const instruction of [CHAT, MERGE, WITNESSED, READING, READING_MERGE, KNOWLEDGE, SYNTHESIS, LESSON, SUBAGENT, FRONTDESK]) {
    const r = await post(s.url, summariserBody({ canaries: ['[[c:k.in]]'], instruction }));
    assert.equal(r.status, 200, instruction.slice(0, 40));
    assert.equal(seen.at(-1)!.kind, 'summariser', instruction.slice(0, 40));
  }
  await post(s.url, summariserBody({ instruction: 'Please consolidate these 3 L1 summaries (2 synthesis, 1 research) into a single cohesive memory. Aim for about 200 tokens.' }));
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level), [1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(records.map((r) => r.retry), [false, false, false, false, false, false, false, false, false, false, false]);
}));

test('T4/T5: a summary answer opens with an id that is a function of what its request carries, then untagged padding to the target its instruction states, and the record lists what each call was sent', async () => {
  const one = await startStandin({ configuration: { windowTokens: 50_000 } });
  const other = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    one.setStep(step('p', []));
    other.setStep(step('p', []));
    const a = summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~60') });
    const b = summariserBody({ canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'], textChars: 400 });
    const [small, big] = [await post(one.url, a), await post(one.url, b)];
    const [big2, small2] = [await post(other.url, b), await post(other.url, a)];
    const [x, y] = [textOf(small.json), textOf(big.json)];
    assert.match(x, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 1 canaries to c:p\.1: /);
    assert.match(y, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 2 canaries to c:p\.3: /);
    const idOf = (t: string) => t.match(/^\[\[s:M[0-9a-f]{8}\]\]/)![0];
    assert.notEqual(idOf(x), idOf(y));
    assert.equal(textOf(small2.json), x);
    assert.equal(textOf(big2.json), y);
    const retargeted = await post(one.url, summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~61') }));
    assert.notEqual(idOf(textOf(retargeted.json)), idOf(x));
    assert.equal(/<|>/.test(x + y), false);
    assert.equal(/\[\[c:/.test(x + y), false, 'a summary carries no canary in the form a message carries one');
    for (const [r, target] of [[small, 60], [big, 200]] satisfies Array<[Posted, number]>) {
      assert.ok(Math.abs(r.json.usage!.output_tokens - target) <= target * 0.05, `${r.json.usage!.output_tokens} for a target of ${target}`);
    }
    records = await one.close();
    assert.deepEqual(records[1].sent, { canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'] });
    assert.equal(records[1].answer!.summary, idOf(y));
  } finally {
    if (!records) await one.close();
    await other.close();
  }
});

test('T1/T4: a compression instruction that states no target is refused as unclassified', () => withStandin({}, async (s) => {
  s.setStep(step('nt', []));
  const r = await post(s.url, summariserBody({ instruction: CHAT.replace('Target ~200 tokens. ', '') }));
  assert.equal(r.status, 400);
  assert.match(r.json.error!.message, /no target/);
}));

test('T36: a merge instruction that names no level it asks for is refused as unclassified, not counted as a compression', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('nl', []));
  for (const instruction of [MERGE.replace('single L2 memory', 'single higher memory'), READING_MERGE.replace('consolidating at L2.', 'consolidating one level up.')]) {
    const r = await post(s.url, summariserBody({ instruction }));
    assert.equal(r.status, 400, instruction.slice(0, 40));
    assert.match(r.json.error!.message, /its merge instruction names no level/);
    assert.equal(seen.at(-1)!.kind, 'unclassified');
  }
  await post(s.url, summariserBody({ instruction: MERGE }));
  assert.equal(seen.at(-1)!.kind, 'summariser', 'one that names its level is still the summariser\'s');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level ?? null), [null, null, 2], 'no level is recorded for a request it couldn\'t classify');
}));

test('T40: an instruction that names a level in none of the forms the stand-in reads is refused as unclassified, not counted as a compression', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('lv', []));
  const reworded = 'Write the memory of this slice of the log. Consolidate the preceding summaries into one L2 memory. Target ~200 tokens.';
  const r = await post(s.url, summariserBody({ instruction: reworded }));
  assert.equal(r.status, 400);
  assert.match(r.json.error!.message, /its instruction names a level \(L2\) in none of the forms the stand-in reads/);
  assert.equal(seen.at(-1)!.kind, 'unclassified');
  await post(s.url, summariserBody({ instruction: CHAT }));
  assert.equal(seen.at(-1)!.kind, 'summariser', 'an L1 instruction that names no level is still level 1');
  const records = await s.close();
  assert.deepEqual(records.map((x) => x.level ?? null), [null, 1]);
}));

test('T4: an answer never runs past what max_tokens allows: one that would is cut there, with a max_tokens stop, as a provider cuts it', () => withStandin({}, async (s) => {
  const scripted = `[[c:m.r1]] ${prose(4_000)}`;
  s.setStep(step('m', [{ text: scripted }, { text: scripted }]));
  const summary = await post(s.url, summariserBody({ canaries: ['[[c:m.1]]'], textChars: 40_000, max_tokens: 100 }));
  assert.ok(summary.json.usage!.output_tokens <= 100, String(summary.json.usage!.output_tokens));
  assert.equal(summary.json.stop_reason, 'max_tokens');
  assert.ok(textOf(summary.json).length <= 100 * 2.2, `the summary itself is cut to what 100 tokens of prose hold: ${textOf(summary.json).length} chars`);
  for (const stream of [false, true]) {
    const reply = (await post(s.url, agentBody({ canary: '[[c:m.in]]', stream, max_tokens: 50 }))).json;
    assert.ok(reply.usage!.output_tokens <= 50, String(reply.usage!.output_tokens));
    assert.equal(reply.stop_reason, 'max_tokens');
    const text = textOf(reply);
    assert.ok(text.length > 0 && text.length <= 50 * 2.2, `${stream ? 'streamed' : 'whole'}: the text itself is cut to what 50 tokens of prose hold: ${text.length} chars`);
    assert.ok(scripted.startsWith(text), 'the answer is its own beginning, cut');
  }
  const fits = await post(s.url, summariserBody({ canaries: ['[[c:m.2]]'], max_tokens: 16_000 }));
  assert.equal(fits.json.stop_reason, 'end_turn', 'an answer within the ceiling ends as it would');
  const none = await post(s.url, { ...summariserBody({ canaries: ['[[c:m.3]]'] }), max_tokens: undefined });
  assert.equal(none.status, 400, 'a request without max_tokens is refused, as the API refuses it');
}));

test('T6: a step\'s bad answers go one each, in order, to the next first attempts, from that step on; a retry is answered well', () => withStandin({}, async (s) => {
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty', 'max-tokens'] }));
  const retry = (instruction: string) => summariserBody({ instruction: `${instruction}\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.` });
  const got = [];
  got.push((await post(s.url, summariserBody({}))).json);
  got.push((await post(s.url, retry(CHAT))).json);
  s.setStep(step('bad.cp', []));
  for (let i = 0; i < 3; i++) got.push((await post(s.url, summariserBody({ canaries: [`[[c:x.${i + 2}]]`] }))).json);
  assert.match(textOf(got[0]), /^<thinking>[\s\S]*<\/thinking>$/);
  assert.equal(got[0].stop_reason, 'end_turn');
  assert.match(textOf(got[1]), /^\[\[s:M[0-9a-f]{8}\]\] /, 'the retry gets a good answer');
  assert.deepEqual(got[2].content, [{ type: 'text', text: '' }]);
  assert.equal(got[3].stop_reason, 'max_tokens');
  assert.match(textOf(got[4]), /^\[\[s:M[0-9a-f]{8}\]\] /);
}));

test('T37: a retry of an L1 request answered with only thinking re-sends it, its canaries and summaries alike, and carries a retry hint; one that re-sends it without a hint, or carries a hint with nothing to re-send, is unclassified and refused', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const NO_TOOLS = '\n\nWrite the memory as plain text directly in your response — do not call any tools for this.';
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty'] }));
  assert.match(textOf((await post(s.url, summariserBody({}))).json), /^<thinking>/);
  const reworded = await post(s.url, summariserBody({ instruction: `${CHAT}\n\nWrite the memory as prose, with no tags around it.` }));
  assert.equal(reworded.status, 400);
  assert.equal(seen.at(-1)!.kind, 'unclassified');
  assert.match(reworded.json.error!.message, /re-sends a request answered thinking-only, but carries no retry hint the stand-in knows/);
  assert.match(textOf((await post(s.url, summariserBody({ instruction: `${CHAT}${PLAIN}` }))).json), /^\[\[s:M[0-9a-f]{8}\]\] /, 'a hinted retry is answered well');
  const unprompted = await post(s.url, summariserBody({ canaries: ['[[c:x.9]]'], instruction: `${CHAT}${NO_TOOLS}` }));
  assert.equal(unprompted.status, 400);
  assert.equal(seen.at(-1)!.kind, 'unclassified');
  assert.match(unprompted.json.error!.message, /carries a retry hint, but no earlier request with its canaries and summaries took a bad answer/);
  assert.deepEqual((await post(s.url, summariserBody({ canaries: ['[[c:x.10]]'] }))).json.content, [{ type: 'text', text: '' }], 'a request for another slice is a first attempt');
}));

test('T38: a merge re-sent after a bad answer keeps its last summary, its sources, whatever prior summaries it carries, and carries a retry hint after thinking or nothing but none after max_tokens, as context-manager 0.24.0 re-sends it; an L1 request is re-sent whole', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const S = (n: number) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const merge = (canary: string, summaries: string[], hint = '') => summariserBody({ canaries: [canary], summaries, instruction: `${MERGE}${hint}` });
  const good = /^\[\[s:M[0-9a-f]{8}\]\] /;
  s.setStep(step('bad', [], { badAnswers: ['empty', 'max-tokens', 'thinking-only', 'empty'] }));
  assert.deepEqual((await post(s.url, merge('[[c:m.1]]', [S(1), S(2), S(3), S(4)]))).json.content, [{ type: 'text', text: '' }]);
  assert.match(textOf((await post(s.url, merge('[[c:m.1]]', [S(1), S(3), S(4)], PLAIN))).json), good, 'a hinted retry that skipped a prior summary in the middle is a retry');
  assert.equal((await post(s.url, merge('[[c:m.2]]', [S(5), S(6), S(7)]))).json.stop_reason, 'max_tokens');
  const hintedAfterCut = await post(s.url, merge('[[c:m.2]]', [S(7)], PLAIN));
  assert.equal(hintedAfterCut.status, 400);
  assert.equal(seen.at(-1)!.kind, 'unclassified');
  assert.match(hintedAfterCut.json.error!.message, /re-sends a request cut at max_tokens, which context-manager 0\.24\.0 re-sends with no retry hint, but carries one/);
  assert.match(textOf((await post(s.url, merge('[[c:m.2]]', [S(8), S(7)]))).json), good, 'a bare re-send after max_tokens, with a prior the first try didn\'t send, is a retry');
  assert.match(textOf((await post(s.url, merge('[[c:m.2]]', [S(5), S(6)]))).json), /^<thinking>/, 'a merge ending with another summary is another merge, a first attempt');
  assert.deepEqual((await post(s.url, summariserBody({ canaries: ['[[c:l.1]]'], summaries: [S(8), S(9)] }))).json.content, [{ type: 'text', text: '' }]);
  const l1Shrunk = await post(s.url, summariserBody({ canaries: ['[[c:l.1]]'], summaries: [S(9)], instruction: `${CHAT}${PLAIN}` }));
  assert.equal(l1Shrunk.status, 400, 'an L1 retry is re-sent whole');
  assert.match(l1Shrunk.json.error!.message, /carries a retry hint, but no earlier request with its canaries and summaries took a bad answer/);
}));

test('T39: until a merge cut at max_tokens is re-sent and answered well, a hintless merge alike in level, target and canaries but ending with another summary is refused, since context-manager 0.24.0 re-sends the merge at its queue\'s head; once it settles, such a merge is a first attempt', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  const S = (n: number) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const merge = (summaries: string[]) => summariserBody({ canaries: ['[[c:m.3]]'], summaries, instruction: MERGE });
  s.setStep(step('bad', [], { badAnswers: ['max-tokens', 'empty'] }));
  assert.equal((await post(s.url, merge([S(1), S(2)]))).json.stop_reason, 'max_tokens');
  const unknown = await post(s.url, merge([S(1)]));
  assert.equal(unknown.status, 400, 'it can\'t be told from the cut merge\'s re-send');
  assert.equal(seen.at(-1)!.kind, 'unclassified');
  assert.match(unknown.json.error!.message, /matches a merge cut at max_tokens and not yet re-sent in level, target and canaries, but ends with another summary/);
  assert.match(textOf((await post(s.url, merge([S(2)]))).json), /^\[\[s:M[0-9a-f]{8}\]\] /, 'its re-send is answered well');
  assert.deepEqual((await post(s.url, merge([S(2), S(9)]))).json.content, [{ type: 'text', text: '' }], 'once it settles, a merge ending with another summary is a first attempt');
}));

test('T41: once a re-send is answered well, the same request sent again is a first attempt, served the next queued answer', () => withStandin({}, async (s) => {
  const PLAIN = '\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.';
  const S = (n: number) => `[[s:M${String(n).padStart(8, '0')}]]`;
  const good = /^\[\[s:M[0-9a-f]{8}\]\] /;
  const l1 = (hint = '') => summariserBody({ canaries: ['[[c:l.4]]'], summaries: [S(1)], instruction: `${CHAT}${hint}` });
  const merge = () => summariserBody({ canaries: ['[[c:m.4]]'], summaries: [S(2)], instruction: MERGE });
  s.setStep(step('bad', [], { badAnswers: ['empty', 'thinking-only', 'max-tokens', 'empty'] }));
  assert.deepEqual((await post(s.url, l1())).json.content, [{ type: 'text', text: '' }]);
  assert.match(textOf((await post(s.url, l1(PLAIN))).json), good, 'its hinted re-send is answered well');
  assert.match(textOf((await post(s.url, l1())).json), /^<thinking>/, 'the same request again, with no hint, takes the next queued answer');
  assert.equal((await post(s.url, merge())).json.stop_reason, 'max_tokens');
  assert.match(textOf((await post(s.url, merge())).json), good, 'its bare re-send is answered well');
  assert.deepEqual((await post(s.url, merge())).json.content, [{ type: 'text', text: '' }], 'the same merge again takes the next queued answer');
}));

test('T20: with refuseMerges every merge request is refused and an L1 answered; with rejectMerges every merge request is rejected for its request', async () => {
  for (const [opts, check] of [
    [{ refuseMerges: true }, (r) => assert.equal(r.json.stop_reason, 'refusal')],
    [{ rejectMerges: true }, (r) => { assert.equal(r.status, 400); assert.equal(r.json.error!.type, 'invalid_request_error'); }],
  ] satisfies Array<[Partial<StandinOptions>, (r: Posted) => void]>) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...opts });
    try {
      s.setStep(step('m', []));
      check(await post(s.url, summariserBody({ instruction: MERGE })));
      const l1 = await post(s.url, summariserBody({}));
      assert.equal(l1.status, 200);
      assert.equal(l1.json.stop_reason, 'end_turn');
    } finally { await s.close(); }
  }
});

test('T34: with refuseContent a summariser request carrying the refused content anywhere in it is refused, and its record says whether the content sat in the slice, ahead of it, in a merge, or in an L1 request with no single notice opening a slice, also when the request is refused for something else first', async () => {
  const NOTICE = 'Context Manager: System: You will soon form a new memory, get ready. The messages that follow are the slice of recent experience you are about to compress. After them, write the memory in your own voice.';
  const l1 = (ahead: string, slice: string): ReturnType<typeof summariserBody> => ({
    model: 'claude-opus-5-5', max_tokens: 16000, stream: false, tools: TOOLS,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `user: [[c:x.1]] ${ahead} ${prose(300, 3)}` },
      { type: 'text', text: NOTICE },
      { type: 'text', text: `user: [[c:x.2]] ${slice} ${prose(300, 5)}` },
      { type: 'text', text: `Context Manager: ${CHAT}` },
    ] }],
  });
  const merge = summariserBody({ instruction: MERGE });
  merge.messages[0].content[0].text = `user: [[c:x.1]] REFUSED-CONTENT ${prose(400, 3)}`;
  const unnoticed = l1('', 'REFUSED-CONTENT');
  unnoticed.messages[0].content.splice(1, 1);
  const quoted = l1('', 'REFUSED-CONTENT');
  quoted.messages[0].content.splice(0, 0, { type: 'text', text: NOTICE });
  const between = l1('REFUSED-CONTENT', '');
  between.messages[0].content.splice(0, 0, { type: 'text', text: NOTICE });
  const inSystem = { ...l1('', ''), system: [{ type: 'text', text: 'REFUSED-CONTENT' }] };
  const inSystemUnnoticed = { ...l1('', ''), system: [{ type: 'text', text: 'REFUSED-CONTENT' }] };
  inSystemUnnoticed.messages = [{ ...inSystemUnnoticed.messages[0], content: inSystemUnnoticed.messages[0].content.filter((b) => b.text !== NOTICE) }];
  const inTools = { ...l1('', ''), tools: [{ ...TOOLS[0], description: 'REFUSED-CONTENT' }, ...TOOLS.slice(1)] };
  const inCall = l1('', '');
  inCall.messages[0].content.splice(3, 0, { type: 'tool_use', id: 'toolu_x', name: 'read', input: { path: 'REFUSED-CONTENT' } });
  const unsized = l1('REFUSED-CONTENT', '');
  delete (unsized as { max_tokens?: number }).max_tokens;
  const sent = [
    ['ahead', l1('REFUSED-CONTENT', ''), 'refusal'],
    ['slice', l1('', 'REFUSED-CONTENT'), 'refusal'],
    ['merge', merge, 'refusal'],
    ['unplaced', unnoticed, 'refusal'],
    ['unplaced', quoted, 'refusal'],
    ['unplaced', between, 'refusal'],
    ['ahead', inSystem, 'refusal'],
    ['ahead', inSystemUnnoticed, 'refusal'],
    ['ahead', inTools, 'refusal'],
    ['slice', inCall, 'refusal'],
    ['ahead', unsized, undefined],
    [undefined, l1('', ''), 'end_turn'],
  ];
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, refuseContent: true });
  s.setStep(step('m', []));
  for (const [, body, stop] of sent) assert.equal((await post(s.url, body)).json.stop_reason, stop);
  const records = (await s.close()).filter((r) => r.kind === 'summariser');
  assert.deepEqual(records.map((r) => r.carried), sent.map(([carried]) => carried));
  assert.deepEqual(records.map((r) => r.answer!.shape), ['refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refusal', 'refused', 'summary']);
  assert.equal(records.at(-2)!.refused, 'max_tokens');
  const plain = await startStandin({ configuration: { windowTokens: 50_000 } });
  plain.setStep(step('m', []));
  assert.equal((await post(plain.url, l1('REFUSED-CONTENT', ''))).json.stop_reason, 'end_turn');
  assert.equal((await plain.close()).find((r) => r.kind === 'summariser')!.carried, undefined);
});

test('T35: a summariser request the stand-in refuses before answering keeps the level it asked for, so the counts take every summariser request', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('m', []));
  const sent = [
    [{ ...summariserBody({}), max_tokens: undefined }, 400, 1],
    [{ ...summariserBody({ instruction: MERGE }), max_tokens: undefined }, 400, 2],
    [summariserBody({ textChars: 400_000 }), 400, 1],
    [summariserBody({}), 200, 1],
  ];
  for (const [body, status] of sent) assert.equal((await post(s.url, body)).status, status);
  const records = (await s.close()).filter((r) => r.kind === 'summariser');
  assert.deepEqual(records.map((r) => [r.refused ?? null, r.level]), [['max_tokens', 1], ['max_tokens', 2], ['window', 1], [null, 1]]);
  assert.deepEqual((['compressions', 'merges'] satisfies Array<keyof ReturnType<typeof moduleCounts>>).map((k) => moduleCounts([], records)[k]), [3, 1], 'every summariser request, refused or answered, is counted under its level');
});

test('a step\'s summariserHold holds the first summariser request at its level, once, and tells onHeld the acts and the canaries the request\'s slice carries, in the order it sends them; requests meanwhile are answered as usual, and the held one gets, at its release, the answer queued when it arrived', () => withStandin({}, async (s) => {
  const NOTICE = 'Context Manager: System: You will soon form a new memory, get ready. The messages that follow are the slice of recent experience you are about to compress.';
  const l1 = (ahead: string, slice: string[]): ReturnType<typeof summariserBody> => ({
    model: 'claude-opus-5-5', max_tokens: 16000, stream: false, tools: TOOLS,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `user: ${ahead} ${prose(300, 3)}` },
      { type: 'text', text: NOTICE },
      ...slice.map((c, i) => ({ type: 'text', text: `user: ${c} ${prose(300, 5 + i)}` })),
      { type: 'text', text: `Context Manager: ${CHAT}` },
    ] }],
  });
  const acts = [{ remove: { messages: [{ fromHeld: 0 }] } }];
  s.setStep(step('h', [], { summariserHold: { level: 1, during: acts }, badAnswers: ['empty'] }));
  const heldSeen: HeldEvent[] = [];
  s.onHeld((h) => heldSeen.push(h));
  const first = post(s.url, l1('[[c:x.1]]', ['[[c:x.9]]', '[[c:x.2]]']));
  let answered = false;
  first.then(() => { answered = true; });
  for (const until = performance.now() + 5000; heldSeen.length < 1;) {
    if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(heldSeen[0].during, acts);
  assert.deepEqual(heldSeen[0].canaries, ['[[c:x.9]]', '[[c:x.2]]'], 'the slice\'s canaries as sent, not what comes before the notice');
  const memory = /^\[\[s:M[0-9a-f]{8}\]\] Memory /;
  assert.match(textOf((await post(s.url, summariserBody({ instruction: MERGE }))).json), memory, 'a merge meanwhile is answered');
  assert.match(textOf((await post(s.url, l1('[[c:y.1]]', ['[[c:y.2]]']))).json), memory, 'a second L1 is answered, not held');
  assert.equal(heldSeen.length, 1);
  assert.equal(answered, false, 'the held request is unanswered until its release');
  assert.equal(s.releaseHeld(heldSeen[0].id), true);
  assert.deepEqual((await first).json.content!.map((b) => [b.type, b.thinking ?? b.text]), [['thinking', ''], ['text', '']], 'the empty answer it took from the queue when it arrived, after the empty thinking Opus 5.5 leads with');
}));

test('a held summariser answer that is an error goes out at its release as an unheld one does: with rejectMerges, a held merge is rejected for its request', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 }, rejectMerges: true });
  let records;
  try {
    s.setStep(step('m', [], { summariserHold: { level: 2, during: [] } }));
    const heldSeen: HeldEvent[] = [];
    s.onHeld((h) => heldSeen.push(h));
    const merge = post(s.url, summariserBody({ instruction: MERGE }));
    for (const until = performance.now() + 5000; heldSeen.length < 1;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.releaseHeld(heldSeen[0].id), true);
    const r = await merge;
    assert.equal(r.status, 400);
    assert.equal(r.json.error!.type, 'invalid_request_error');
    assert.match(r.json.error!.message, /^stand-in: merge request \S+ is rejected for its request$/);
  } finally { records = await s.close(); }
  assert.deepEqual(records.map((x) => [x.kind, x.answer!.shape]), [['summariser', 'rejection']], 'recorded as the summariser request it is, not as one the stand-in couldn\'t answer');
});

test('T27: a summary\'s id comes from what its request carries as sets (target, canaries, recalled summaries), not its wording, order or repeats', () => withStandin({}, async (s) => {
  s.setStep(step('i', []));
  const idOf = async (body: unknown) => textOf((await post(s.url, body)).json).match(/^\[\[s:M[0-9a-f]{8}\]\]/)![0];
  const base = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.2]]', '[[c:i.1]]', '[[c:i.2]]'] })), base, 'order and repeats leave it');
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], instruction: CHAT.replace('Speak in the first person', 'Use the first person'), textChars: 900 })), base, 'rewording and longer text leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]'] })), base, 'a recalled summary moves it');
  const recalled = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]', '[[s:M89abcdef]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M89abcdef]]', '[[s:M0123abcd]]', '[[s:M89abcdef]]'] })), recalled, 'recalled summaries\' order and repeats leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.3]]'] })), base, 'another canary moves it');
}));

test('T7/T14/T15: summariser requests are answered at once, every arrival is reported, and close() returns each request\'s normalised record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen, until } = arrivals(s);
  s.setClock(123);
  s.setStep(step('r', [{ text: '[[c:r.r1]] ok' }, { text: '[[c:r.r2]] ok' }]));
  assert.equal((await post(s.url, summariserBody({ model: 'claude-opus-5-5', canaries: ['[[c:r.in]]'] }))).status, 200);
  await post(s.url, agentBody({ model: 'claude-opus-5-5', canary: '[[c:r.in]]' }));
  await until(2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'clock', 'id', 'kind', 'seq', 'step']);
  assert.equal(seen[0].clock, 123);
  assert.equal(seen[0].step, 'r');
  const records = await s.close();
  const [summ, agent] = records;
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.model, 'claude-opus-5-5');
  assert.equal(agent.maxTokens, 2048);
  assert.equal(agent.stream, true);
  assert.equal(agent.system.chars, 'You are the fixture agent.'.length);
  assert.match(agent.system.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(agent.tools, ['time--now']);
  assert.equal(agent.messages.at(-1)!.role, 'user');
  assert.deepEqual(agent.messages.at(-1)!.blocks[0].canaries, ['[[c:r.in]]']);
  assert.equal(typeof (agent.usage as AnthropicUsage).input_tokens, 'number');
  assert.equal(summ.kind, 'summariser');
  assert.equal(summ.answer!.shape, 'summary');
});

const claimOf = (text: string) => {
  const c = summariser({}).claim({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text }] }] } satisfies DeepPartial<ReadView> as unknown as ReadView);
  if (!c) return null;
  const f = c.fields!(((x: unknown) => x) as Masker);
  return { kind: c.kind, ...(c.reason ? { reason: c.reason } : {}), level: f.level, target: f.target, texts: f.texts };
};

test('the summariser\'s claim, given a view as a codec decodes one, reads a block with no canary or summary marker as the instruction whole, and ends on every text, one that opens with a newline included', () => {
  for (const text of ['\nhello', '\n', '\n\n', '\n[[c:x.in]] hello', '']) assert.equal(claimOf(text), null, JSON.stringify(text));
  assert.deepEqual(claimOf('Target ~300 tokens\nWrite the memory of this slice of the log.'), { kind: 'summariser', level: 1, target: 300, texts: ['Target ~300 tokens\nWrite the memory of this slice of the log.'] });
  const merge = 'You have just reviewed the summaries in chronological order.\ninto a single L2 memory. Target ~300 tokens\nEarlier summary: Write the memory of this slice of the log. Target ~20 tokens';
  assert.deepEqual([claimOf(merge)!.level, claimOf(merge)!.target], [2, 300]);
  const repeated = 'Write the memory of this slice of the log. Target ~100 tokens\nWrite the memory of this slice of the log.';
  assert.deepEqual([claimOf(repeated)!.kind, claimOf(repeated)!.target], ['summariser', 100]);
});

test('the summariser reads a block whose slice carries canaries or summaries as the slice joined to the instruction: the instruction opens at the line of the first opening after the last marked line', () => {
  const instruction = 'Context Manager: Write the memory of events since the most recent memory system notification. Target ~300 tokens.\nEarlier: Write the memory of this slice of the log. Target ~20 tokens';
  const joined = claimOf(`[[c:j.in]] The plan said Target ~20 tokens, and L2 came up. Write the memory of this slice of the log.\nmore of that message\n${instruction}`);
  assert.deepEqual(joined, { kind: 'summariser', level: 1, target: 300, texts: [instruction] });
  const merge = claimOf('[[s:M0123abcd]] Memory 0123abcd.\nContext Manager: You have just reviewed the L1 memories above, in chronological order. Merge them into a single L2 memory. Target ~400 tokens.');
  assert.deepEqual([merge!.kind, merge!.level, merge!.target], ['summariser', 2, 400]);
  assert.equal(claimOf('Write the memory of this slice of the log. Target ~20 tokens\n[[c:q.in]] hi'), null);
});

test('T62: on a configuration whose summaries come wrapped in thinking (C9h), a summary answer is the same memory wrapped whole in one closed literal `<thinking>` tag pair with no tag inside, the shape context-manager\'s recoverLiteralThinkingWrappedCompression reads as prose; its other answers are as without it', async () => {
  const answers = {} as Record<`${boolean}`, { bad: string; good: string }>;
  for (const wrapped of [false, true]) {
    await withStandin({ thinkingWrappedSummaries: wrapped }, async (s) => {
      s.setStep({ ...step('w'), badAnswers: ['thinking-only'] });
      const bad = (await post(s.url, summariserBody({ canaries: ['[[c:w.1]]'] }))).json.content![0].text!;
      const good = (await post(s.url, summariserBody({ canaries: ['[[c:w.2]]'] }))).json.content![0].text!;
      answers[wrapped as unknown as `${boolean}`] = { bad, good };
    });
  }
  assert.equal(answers.true.good, `<thinking>${answers.false.good}</thinking>`);
  assert.match(answers.true.good, /^<thinking>\[\[s:M[0-9a-f]{8}\]\] Memory [^<>]*<\/thinking>$/);
  assert.equal(answers.true.bad, answers.false.bad, 'a bad answer is as without it');
});

test('W9\'s witnessed restart sets its own instruction for an inherited record, which the summariser reads as an L1 request with the target context-manager fills in', async () => {
  const { configurations } = await import('../strategies/script.ts');
  const { runOf } = await import('../workloads/workloads.ts');
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true } };
  const restart = runOf('H1/W9', configurations(), facts).steps().find((st) => st.id.endsWith('6.witnessed'));
  const { strategy } = restart!.agent!;
  assert.equal(typeof strategy!.witnessedInstruction, 'string');
  assert.equal(typeof strategy!.witnessedIdentityReminder, 'string');
  const claimed = claimOf(`Context Manager: ${(strategy!.witnessedInstruction as string).replace('{targetTokens}', '300')}\n\n${strategy!.witnessedIdentityReminder}`);
  assert.deepEqual([claimed!.kind, claimed!.level, claimed!.target], ['summariser', 1, 300]);
});
