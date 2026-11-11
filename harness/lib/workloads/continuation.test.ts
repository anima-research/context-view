// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { declaredProducts } from '../strategies/checks.ts';
import { continuation, products, configurations } from '../strategies/script.ts';
import { CHECKPOINT_GAP_MS, RUNS, runOf } from './workloads.ts';
import { UPGRADES } from './continuation.ts';
import { releaseOf, upgradeVariant } from '../strategies/lane.ts';
import { laneRecipe } from '../strategies/recipe.ts';
import { text, store, under } from '../testing/check-builders.ts';

test('the continuation runs from its configuration\'s prefix, which is written from empty at the length stack.json pins, or, for a setup that builds its history, after it in the same run', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const pinned = Object.entries(lengths.prefixTurns);
  assert.deepEqual(pinned.map(([config]) => config).sort(), ['C11h', 'C12h', 'C13h', 'C18h', 'C19h', 'C20h', 'C21h', 'C23h', 'C9h', 'H1', 'H1b', 'H3', 'H6', 'H7', 'P1', 'P2', 'P3', 'P4', 'P5'], 'the configurations stack.json pins a prefix length for');
  assert.deepEqual(Object.entries(configurations()).filter(([, c]) => c.buildsHistory).map(([name]) => name), ['P4'], 'the setups that build their own history');
  for (const [config, turns] of pinned) {
    const cont = runOf(`${config}/continuation`, configurations(), facts, lengths);
    assert.ok(Object.keys(cont.products).length > 0, 'and declares its segments\' products');
    const pre = runOf(`${config}/prefix`, configurations(), facts, lengths);
    assert.equal(pre.from, null);
    assert.equal(pre.steps().filter((st) => st.kind === 'channel').length, turns);
    if (!configurations()[config].buildsHistory) { assert.equal(cont.from, `${config}/prefix`); continue; }
    assert.equal(cont.from, null, `${config}'s continuation starts empty`);
    const steps = cont.steps();
    const history = pre.steps();
    assert.deepEqual(steps.slice(0, history.length - 1), history.slice(0, -1), 'its prefix\'s steps');
    assert.deepEqual(steps[history.length - 1], { ...history.at(-1), gapMs: CHECKPOINT_GAP_MS }, 'whose last copies the store and boots it a checkpoint\'s gap later');
    assert.deepEqual([history.at(-1).kind, history.at(-1).copyStore], ['checkpoint', true]);
    assert.deepEqual(steps.slice(history.length), continuation(), 'then the continuation\'s');
    assert.equal(CHECKPOINT_GAP_MS, 24 * 60 * 60_000);
  }
  for (const id of RUNS) {
    const from = runOf(id, configurations(), facts, lengths).from;
    if (from) assert.doesNotThrow(() => runOf(from, configurations(), facts, lengths), `${id} starts from ${from}, a run that exists`);
  }
  assert.equal(runOf('H3/W4', configurations(), facts, lengths).from, 'H3/W1', 'a workload that starts from its configuration\'s checkpoint still does');
});

test('the upgrade runs: each older release\'s continuation starts from the prefix that release writes, under the same older account and budget, and the fresh twin writes that prefix itself; the variants are stack.json\'s upgrades', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  assert.deepEqual(UPGRADES, lengths.upgrades.map(upgradeVariant), 'one variant for each older release stack.json lists, in its order');
  for (const variant of UPGRADES) {
    const cont = runOf(`H1b/continuation/${variant}`, configurations(), facts, lengths);
    assert.equal(cont.from, `H1b/prefix/${variant}`);
    assert.equal(releaseOf(cont.from, lengths), lengths.upgrades[UPGRADES.indexOf(variant)], 'its checkpoint is that release\'s');
    const pre = runOf(cont.from, configurations(), facts, lengths);
    assert.deepEqual(pre.configuration, cont.configuration, 'the prefix is written under the configuration its continuation runs under');
    assert.deepEqual([cont.configuration.account, cont.configuration.agent.contextBudgetTokens, cont.configuration.agent.model], ['older', 160_000, 'claude-opus-5-5']);
    assert.equal(pre.steps().filter((st) => st.kind === 'channel').length, lengths.prefixTurns.H1b);
  }
  const fresh = runOf('H1b/continuation/fresh', configurations(), facts, lengths);
  const history = runOf('H1b/prefix/from-0.9.0', configurations(), facts, lengths).steps();
  assert.equal(fresh.from, null, 'the twin starts empty');
  assert.deepEqual(fresh.configuration, runOf('H1b/continuation/from-0.9.0', configurations(), facts, lengths).configuration, 'under the same configuration');
  assert.deepEqual(fresh.steps().slice(0, history.length - 1), history.slice(0, -1), 'writing the same prefix');
  assert.deepEqual(fresh.steps()[history.length - 1], { ...history.at(-1), gapMs: CHECKPOINT_GAP_MS });
  assert.deepEqual(fresh.steps().slice(history.length), continuation());
  assert.equal(runOf('H1b/W2', configurations(), facts, lengths).configuration.account, undefined, 'H1b\'s other runs keep a newer account');
});

test('B7: v0.20.0\'s prefix alone restarts the host with a system prompt an operator changed, right after its last turn whose reply thinks, so a turn of that release follows under the new head; it is otherwise the prefix the other releases write', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: {} };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const steps = (id) => runOf(id, configurations(), facts, lengths).steps();
  assert.equal(runOf('H1b/continuation/from-0.20.0', configurations(), facts, lengths).from, 'H1b/prefix/from-0.20.0');
  assert.equal(releaseOf('H1b/prefix/from-0.20.0', lengths), 'v0.20.0');
  assert.ok(RUNS.includes('H1b/continuation/from-0.20.0'), 'a view runs it');
  const pre = steps('H1b/prefix/from-0.20.0');
  const restarts = pre.filter((st) => st.kind === 'restart');
  assert.equal(restarts.length, 1);
  assert.deepEqual(Object.keys(restarts[0].agent), ['systemPrompt'], 'it changes the prompt and nothing else');
  const booted = laneRecipe({ configuration: runOf('H1b/prefix/from-0.20.0', configurations(), facts, lengths).configuration, control: '/c.sock', channels: ['chat'], boot: 1 });
  assert.equal(typeof restarts[0].agent.systemPrompt, 'string');
  assert.notEqual(restarts[0].agent.systemPrompt, booted.agent.systemPrompt, 'a prompt other than the one the host booted with');
  const thinks = (st) => (st.replies ?? []).some((r) => r.thinking);
  const at = pre.indexOf(restarts[0]);
  assert.ok(thinks(pre[at - 1]), 'right after a turn whose reply thinks');
  assert.ok(!pre.slice(at + 1).some(thinks), 'the last such turn');
  assert.ok(pre.slice(at + 1).some((st) => st.kind === 'channel'), 'a turn follows it before the checkpoint');
  assert.deepEqual(pre.filter((st) => st.kind !== 'restart'), steps('H1b/prefix/from-0.9.0'));
  for (const id of ['H1b/prefix/from-0.9.0', 'H1b/prefix/from-0.23.0', 'H1b/continuation/fresh']) assert.ok(!steps(id).some((st) => st.kind === 'restart'), `${id} takes no restart`);
});

test('B7: v0.20.0\'s continuation declares, from its store, the reasoning-loss notice its prefix stored, and no other run declares it', () => {
  const facts = { budget: 100_000, maxTokens: 16_000, capabilities: { suppression: true, onboarding: true, conversations: true } };
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const run = (id) => runOf(id, configurations(), facts, lengths);
  const names = (id) => Object.values(run(id).products).flat().map((p) => p.name);
  const added = names('H1b/continuation/from-0.20.0').filter((n) => !names('H1b/continuation/from-0.9.0').includes(n));
  assert.equal(added.length, 1, 'one product beside the other upgrade runs\'');
  const missing = (store) => declaredProducts([], continuation(), run('H1b/continuation/from-0.20.0').products, store).flatMap((m) => m.missing);
  assert.ok(!missing({ messages: [{ id: 'm1', canaries: [] }, { id: 'n', canaries: [], reasoningLoss: true }], summaries: [] }).includes(added[0]));
  assert.ok(missing({ messages: [{ id: 'm1', canaries: [] }], summaries: [] }).includes(added[0]), 'a store without the notice lacks it');
  assert.ok(!missing(null).includes(added[0]), 'with no store read, it waits on none');
  for (const id of RUNS.filter((r) => r !== 'H1b/continuation/from-0.20.0')) assert.ok(!names(id).includes(added[0]), `${id} doesn't declare it`);
  assert.deepEqual(names('H1b/continuation/from-0.23.0'), names('H1b/continuation/from-0.9.0'));
  assert.deepEqual(names('H1b/continuation/fresh'), names('H1b/continuation/from-0.9.0'));
});

test('the prefix an older release writes holds a raw message the host\'s message cap cuts, the class context-manager\'s epoch 3 repriced, which makes the candidate\'s discard of v0.9.0\'s unstamped multiplier take the branch for a store holding repriced content, as the upgrading resident\'s log line shows', () => {
  // connectome-host's `maxMessageTokens` for a built-in strategy whose recipe sets none is 10,000, at v0.9.0 and at
  // a34d39011 (`strategyMessageCap`, src/framework-strategy.ts), and H1b sets none; and
  // context-manager 0.25.0 prices prose at 2.9 characters a token (PROSE_CHARS_PER_TOKEN), so a turn of more than
  // 10,000 × 2.9 / 0.6 characters passes the cap at any multiplier the clamp allows, its floor 0.6 included.
  const lengths = JSON.parse(readFileSync(new URL('../../stack.json', import.meta.url), 'utf-8'));
  const run = runOf('H1b/prefix/from-0.9.0', configurations(), { budget: 100_000, maxTokens: 16_000, capabilities: {} }, lengths);
  assert.equal(run.configuration.agent.strategy?.maxMessageTokens, undefined, 'the host\'s default cap applies');
  assert.ok(run.steps().some((st) => st.kind === 'channel' && st.text.length > (10_000 * 2.9) / 0.6), 'a turn the cap cuts, as p.17 and p.34 are');
});
