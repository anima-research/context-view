// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answeredBare, budgets, compileKinds } from './checks.ts';
import { continuation } from './script.ts';
import { text, call, panel, opened, continued, sent, compiledAs, crossingAs, crossing, R1_COMPILED, under, turnStep } from '../testing/check-builders.ts';

const resumed = { kind: 'ipc', event: { type: 'inference:stream_resumed', agentName: 'fixture' } };

const budgetReport = (...lines) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', ...lines], ms: 5 });

const WINDOW_CLAUSE = '; its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold';

test('K2e: with the module\'s compile lines, a request is compiled when it arrives after its agent\'s latest compile stamped before it, so a restart that sends what a continuation would is compiled', () => {
  const withCanary = (r, canary, arrived) => ({ ...r, arrived: String(arrived), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const r1 = withCanary(opened('r1', 'a', 15_000, 23_000, ['t1']), '[[c:a.in]]', 11);
  const r2 = withCanary(continued(r1, 'r2', 19_000, 25_000, ['t2']), '[[c:a.call1]]', 31);
  const r3 = withCanary(continued(r2, 'r3', 20_000, 26_000), '[[c:a.call2]]', 41);
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'compiled', ...(stamp ? { stamp: String(stamp) } : {}), messages: [{ sources: ['r:1'], content }] });
  const refused = (seq, assembly) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'refused' });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10), refused(2, 2), line(3, 2, 'x2', 30), { ...line(4, 3, 'x9', 35), kind: 'dry' }, line(5, 4, 'x5', 50)], blobs: { ...b('x1', '[[c:a.in]]'), ...b('x2', '[[c:a.call1]]'), ...b('x9', '[[c:a.call2]]'), ...b('x5', '[[c:z.in]]') } },
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
