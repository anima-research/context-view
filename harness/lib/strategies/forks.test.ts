// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetReportDone, forkSpeech, laneRecipe } from './driver.ts';
import { everyTurnAnswers, primaryAgent, sideOfAgent } from './checks.ts';
import { judgedAgent } from './judge.ts';
import { configurations } from './script.ts';
import { runOf } from './workloads.ts';

const compiles = (...agents) => ({ kind: 'compiles', lines: agents.map((agent) => ({ kind: 'request', outcome: 'compiled', agent })) });

test('a fork of conversations speaks as headless traces the primary agent: a round that completed after tokens, with no tool calls yielded since it started', () => {
  const said = forkSpeech();
  const fork = 'conversation-chat-g1-abc';
  assert.equal(said({ type: 'inference:started', agentName: fork }), null);
  said({ type: 'inference:tokens', agentName: fork, content: 'hello ' });
  said({ type: 'inference:tool_calls_yielded', agentName: fork });
  said({ type: 'inference:started', agentName: fork });
  said({ type: 'inference:tokens', agentName: fork, content: 'there' });
  assert.deepEqual(said({ type: 'inference:completed', agentName: fork }), { type: 'inference:speech', agentName: fork, content: 'there', derived: 'fork' });
  assert.equal(said({ type: 'inference:completed', agentName: fork }), null, 'a round with no tokens says nothing');
  said({ type: 'inference:started', agentName: fork });
  said({ type: 'inference:tokens', agentName: fork, content: 'beside a call' });
  said({ type: 'inference:tool_calls_yielded', agentName: fork });
  assert.equal(said({ type: 'inference:completed', agentName: fork }), null, 'a round that yielded tool calls says nothing, though it had tokens');
  said({ type: 'inference:tokens', agentName: 'fixture', content: 'mine' });
  assert.equal(said({ type: 'inference:completed', agentName: 'fixture' }), null, 'headless traces the fixture agent\'s own');
});

test('a budget report read for a fork waits for a fork\'s line, since each agent\'s line comes as its own output', () => {
  const header = '--- Stream Token Budgets ---';
  assert.equal(budgetReportDone([header, '  fixture: 320.0k (last: 0, 0%)'], 'conversation-', { prefix: true }), false);
  assert.equal(budgetReportDone([header, '  fixture: 320.0k (last: 0, 0%)', '  conversation-chat-g1-abc: 320.0k (last: 0, 0%)'], 'conversation-', { prefix: true }), true);
  assert.equal(budgetReportDone([header, '  fixturette: 1.0k (last: 0, 0%)'], 'fixture'), false, 'without a prefix, an exact name');
});

test('the primary side\'s agent is the fixture agent, or the one fork of conversations that compiles where the fixture agent compiles nothing, and a run that judges a fork reads its namespace', () => {
  assert.equal(primaryAgent([]), 'fixture');
  assert.equal(primaryAgent([compiles('fixture', 'spawn-k-1')]), 'fixture');
  assert.equal(primaryAgent([compiles('conversation-chat-g1-abc')]), 'conversation-chat-g1-abc');
  assert.equal(primaryAgent([compiles('conversation-chat-g1-abc', 'conversation-side-g1-def')]), 'fixture', 'two forks: no one primary side');
  assert.equal(primaryAgent([compiles('fixture'), compiles('conversation-chat-g1-abc')]), 'fixture');
  assert.equal(sideOfAgent('conversation-chat-g1-abc', [compiles('conversation-chat-g1-abc')]), 'primary');
  assert.equal(sideOfAgent('spawn-k-1', [compiles('fixture', 'spawn-k-1')]), 'sub');
  assert.deepEqual(judgedAgent({ judges: 'fork' }, [compiles('conversation-chat-g1-abc')]), { agent: 'conversation-chat-g1-abc', namespace: 'conversations/conversation-chat-g1-abc', isolate: false });
  assert.throws(() => judgedAgent({ judges: 'fork' }, [compiles('fixture')]), /no compile line names the one fork/);
});

test('check 1 takes drafts held for the reason a step\'s script gives as that step\'s fate, and no other', () => {
  const held = (step, reason) => ({ kind: 'ipc', step, event: { type: 'prose:drafts-held', reason } });
  const script = [{ id: 'a', drafts: 'no-destination' }, { id: 'b', drafts: 'bounced' }, { id: 'c' }];
  const flags = everyTurnAnswers([], [held('a', 'no-destination'), held('b', 'bounced'), held('a', 'bounced'), held('c', 'no-destination'), held('c', undefined)], script);
  assert.deepEqual(flags.map((f) => f.step), ['a', 'c', 'c']);
  assert.match(flags[2].message, /no reason given/, 'a hold with no reason, on a step whose script names none');
});

test('a setup\'s recipe-level fields reach the recipe, and can\'t replace the fixture\'s own', () => {
  const recipe = laneRecipe({ configuration: { name: 'X', recipe: { speech: { locus: 'latest-inbound' }, name: 'other', mcpServers: {}, agent: { name: 'other' }, modules: { wake: true }, extensions: {} } }, control: '/c.sock', channels: ['chat'], boot: 1 });
  assert.deepEqual(recipe.speech, { locus: 'latest-inbound' });
  assert.equal(recipe.name, 'Strategy fixture (X)');
  assert.deepEqual(Object.keys(recipe.mcpServers), ['fixture']);
  assert.equal(recipe.agent.name, 'fixture');
  assert.deepEqual(recipe.modules, { subagents: false, lessons: false, retrieval: false });
  assert.deepEqual(Object.keys(recipe.extensions), ['whole-host-harness']);
});

test('a setup\'s part gated on a capability is brought where the arm has it, and where it doesn\'t the run leaves it out and says so', () => {
  const all = { ...configurations(), Hg: { ...configurations().H1, name: 'Hg', gated: { conversations: { recipe: { conversations: { bind: { channel: 'always' } } }, judges: 'fork' } } } };
  const facts = (capabilities) => ({ budget: 100_000, maxTokens: 16_000, capabilities });
  const has = runOf('Hg/W1', all, facts({ suppression: true, onboarding: true, conversations: true }));
  assert.ok(has.configuration.recipe.conversations && has.configuration.judges === 'fork' && !('gated' in has.configuration));
  assert.ok(!has.steps().some((s) => s.kind === 'absent'));
  const lacks = runOf('Hg/W1', all, facts({ suppression: true, onboarding: true, conversations: false }));
  assert.ok(!lacks.configuration.recipe?.conversations && lacks.configuration.judges === undefined && !('gated' in lacks.configuration));
  assert.deepEqual(lacks.steps()[0], { id: `${lacks.seed}.absent.conversations`, segment: 'W1', kind: 'absent', stretch: 'conversations', canaries: [] });
  assert.throws(() => runOf('Hg/W1', all, facts({ unreadable: 'no package.json' })), /no package\.json/);
  assert.ok(runOf('Hg/W1', all, {}).configuration.recipe.conversations, 'before an arm is read, as brought');
});
