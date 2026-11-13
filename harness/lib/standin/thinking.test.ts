import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { summariser } from './summariser.ts';
import { TOOLS, agentBody, post, prose, read, startStandin, step, summariserBody, withStandin } from '../testing/standin.ts';
import type { MessagesAnswer, MessagesBody } from './anthropic.ts';
import type { Block } from './view.ts';

type MessageItem = NonNullable<MessagesBody['messages']>[number];
type Thinking = NonNullable<MessagesBody['thinking']>;

test('T13: when the request\'s model binds thinking, a block whose request changed is refused, or set aside uncounted under the drop control; on a model that doesn\'t bind it\'s taken', async () => {
  const DROP = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  for (const [binds, control] of [[true, false], [true, true], [false, false]]) {
    const model = binds ? 'claude-opus-5-5' : 'claude-opus-4-6';
    await withStandin({}, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]', model }), ...(control ? { thinking: DROP } : binds ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}) };
      const first = (await post(s.url, opening)).json;
      const call = first.content!.find((b) => b.type === 'tool_use');
      const next = (prefix: MessageItem, reply: MessagesAnswer['content']) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
        ],
      });
      assert.equal((await post(s.url, next(opening.messages[0], first.content))).status, 200, 'the block sent after the prefix it was minted under is taken');
      const count = async (body: unknown) => s.countTokens(body);
      assert.ok(await count(next(opening.messages[0], first.content)) > await count(next(opening.messages[0], first.content!.filter((b) => b.type !== 'thinking'))), 'and it counts, under the drop control too');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const changed = next(changedPrefix, first.content);
      const withoutBlock = next(changedPrefix, first.content!.filter((b) => b.type !== 'thinking'));
      const r = await post(s.url, changed);
      if (binds && !control) {
        assert.equal(r.status, 400);
        assert.equal(r.json.error!.message, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.', 'the provider\'s own wording, which hosts read as a binding refusal');
        const reordered = { role: 'user', content: (opening.messages[0].content as Block[]).map(({ type, ...rest }) => ({ ...rest, type })) };
        assert.equal((await post(s.url, next(reordered, first.content))).status, 200, 'the same prefix with its keys in another order keeps the binding');
      } else if (binds) {
        assert.equal(r.status, 200);
        assert.equal(await count(changed), await count(withoutBlock), 'the block set aside counts for nothing');
        const billed = r.json.usage!.input_tokens + r.json.usage!.cache_read_input_tokens + r.json.usage!.cache_creation_input_tokens;
        assert.equal(billed, await count(withoutBlock), 'nor is it billed');
        await withStandin({ windowTokens: await count(withoutBlock) }, async (t) => {
          t.setStep({ ...step('g', [{ text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
          assert.equal((await post(t.url, changed)).status, 200, 'nor counted against the window: it fits once the block is set aside');
        });
      } else {
        assert.equal(r.status, 200);
        assert.ok(await count(changed) > await count(withoutBlock), 'a block the model reads counts');
      }
    });
  }
});

test('T13g: where the model binds, a block made after a tool result sent with `is_error: false` is taken when that result comes back with no flag, as the provider takes it (a Haiku 5.5 probe, Nov 10), and refused when the result\'s text changed', () => withStandin({}, async (s) => {
  const model = 'claude-opus-5-5';
  s.setStep({ ...step('h', [{ calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:h.call1]]' } }] }, { thinking: 'plan', text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:h.in]]', '[[c:h.call1]]'] });
  const opening = { ...agentBody({ canary: '[[c:h.in]]', model }), thinking: { type: 'adaptive', display: 'summarized' } };
  const first = (await post(s.url, opening)).json;
  const call = first.content!.find((b) => b.type === 'tool_use');
  const result = (text: string, flag: { is_error?: boolean }) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: [{ type: 'text', text }], ...flag }] });
  const said = `[[c:h.call1]] ${prose(280)}`;
  const second = (await post(s.url, { ...opening, messages: [opening.messages[0], { role: 'assistant', content: first.content }, result(said, { is_error: false })] })).json;
  assert.ok(second.content!.some((b) => b.type === 'thinking'), 'premise: the reply made after the result carries signed thinking');
  const replay = (back: ReturnType<typeof result>) => ({ ...opening, messages: [opening.messages[0], { role: 'assistant', content: first.content }, back, { role: 'assistant', content: second.content }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] and then?' }] }] });
  assert.equal((await post(s.url, replay(result(said, { is_error: false })))).status, 200, 'the result as it was sent');
  assert.equal((await post(s.url, replay(result(said, {})))).status, 200, 'the result with no flag, as a host sends it from its store');
  const changed = await post(s.url, replay(result(`${said} more`, { is_error: false })));
  assert.equal(changed.status, 400, 'the result with its text changed');
  assert.match(changed.json.error!.message, /bound to a different conversation/);
}));

test('T13h: where the model binds, the binding takes a tool result\'s `is_error: false` and no flag alike the other way round too, and `is_error: true` as sent: a block made after a result with no flag is taken when it comes back with `is_error: false`, and one made after `is_error: true` is refused when it comes back with no flag', () => withStandin({}, async (s) => {
  const model = 'claude-opus-5-5';
  s.setStep({ ...step('h', [{ calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:h.call1]]' } }] }, { thinking: 'plan', text: 'ok' }, { text: 'ok' }, { thinking: 'plan', text: 'ok' }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:h.in]]', '[[c:h.call1]]'] });
  const opening = { ...agentBody({ canary: '[[c:h.in]]', model }), thinking: { type: 'adaptive', display: 'summarized' } };
  const first = (await post(s.url, opening)).json;
  const call = first.content!.find((b) => b.type === 'tool_use');
  const said = `[[c:h.call1]] ${prose(280)}`;
  const result = (flag: { is_error?: boolean }) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: [{ type: 'text', text: said }], ...flag }] });
  const after = async (made: { is_error?: boolean }) => (await post(s.url, { ...opening, messages: [opening.messages[0], { role: 'assistant', content: first.content }, result(made)] })).json;
  const replay = (back: { is_error?: boolean }, second: MessagesAnswer) => ({ ...opening, messages: [opening.messages[0], { role: 'assistant', content: first.content }, result(back), { role: 'assistant', content: second.content }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] and then?' }] }] });
  const bare = await after({});
  assert.ok(bare.content!.some((b) => b.type === 'thinking'), 'premise: the reply made after the result with no flag carries signed thinking');
  assert.equal((await post(s.url, replay({ is_error: false }, bare))).status, 200, 'made after no flag, sent back with `is_error: false`');
  const failed = await after({ is_error: true });
  assert.ok(failed.content!.some((b) => b.type === 'thinking'), 'premise: the reply made after `is_error: true` carries signed thinking');
  assert.equal((await post(s.url, replay({ is_error: true }, failed))).status, 200, 'made after `is_error: true`, sent back as it was');
  const unflagged = await post(s.url, replay({}, failed));
  assert.equal(unflagged.status, 400, 'made after `is_error: true`, sent back with no flag');
  assert.match(unflagged.json.error!.message, /bound to a different conversation/);
}));

test('T13d: on a configuration that doesn\'t bind, thinking altered in the latest assistant message is refused with the page\'s 400, and the same thinking after a changed request ahead of it, or altered in an earlier message, is taken', () => withStandin({}, async (s) => {
  s.setStep({ ...step('th', [{ text: 'first', thinking: 'a thought' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:th.in]]'] });
  const opening = agentBody({ canary: '[[c:th.in]]', stream: false });
  const first = await post(s.url, opening);
  const thought = first.json.content!.find((b) => b.type === 'thinking');
  assert.ok(thought?.signature, 'premise: the reply carries signed thinking');
  const next = (reply: MessagesAnswer['content'], system = opening.system, earlier: MessageItem[] = []) => ({ ...opening, system, messages: [...earlier, ...opening.messages, { role: 'assistant', content: reply }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:th.in]] and then' }] }] });
  const altered = await post(s.url, next([{ ...thought, thinking: `${thought.thinking} (changed)` }, { type: 'text', text: 'first' }]));
  assert.equal(altered.status, 400);
  assert.match(altered.json.error!.message, /^messages\.1\.content\.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified$/);
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], 'You are the fixture agent, with another prompt.'))).status, 200, 'the request ahead changed, the thinking didn\'t');
  const older = [{ role: 'user', content: [{ type: 'text', text: 'user: before' }] }, { role: 'assistant', content: [{ ...thought, thinking: 'not what was signed' }, { type: 'text', text: 'old' }] }];
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], opening.system, older))).status, 200, 'the page says nothing of an earlier message');
}));

test('T13b: a model that thinks leads every reply with signed thinking minted for its own request, but one mid-turn on manual thinking that doesn\'t interleave (T64), and a scripted reply\'s thinking stands', async () => {
  await withStandin({ thinks: true }, async (s) => {
    s.setStep({ ...step('h', [{ text: 'first' }, { thinking: 'scripted', text: 'second' }]), canaries: ['[[c:h.in]]'] });
    const opening = { ...agentBody({ canary: '[[c:h.in]]', model: 'claude-opus-5-5' }), thinking: { type: 'adaptive', display: 'summarized' } };
    const one = (await post(s.url, opening)).json;
    assert.equal(one.content![0].type, 'thinking');
    assert.ok(one.content![0].thinking!.length > 0 && typeof one.content![0].signature === 'string');
    const again = { ...opening, messages: [opening.messages[0], { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] and then?' }] }] };
    const two = await post(s.url, again);
    assert.equal(two.status, 200, 'its thinking, sent back after the prefix it was minted under, is taken by a binding model');
    assert.equal(two.json.content![0].thinking, 'scripted');
  });
  await withStandin({}, async (s) => {
    s.setStep({ ...step('k', [{ text: 'plain' }]), canaries: ['[[c:k.in]]'] });
    const one = (await post(s.url, agentBody({ canary: '[[c:k.in]]' }))).json;
    assert.deepEqual(one.content!.map((b) => b.type), ['text'], 'a model that doesn\'t think replies without thinking');
  });
});

test('T13c: a thinking model\'s thinking comes from its request as the run-varying mask reads it, so an image ref\'s nonce doesn\'t change the words', () => withStandin({ thinks: true }, async (s) => {
  s.setStep({ ...step('q', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]), canaries: ['[[c:q.in]]'] });
  const ask = (ref: string) => ({ ...agentBody({ canary: '[[c:q.in]]' }), messages: [{ role: 'user', content: [{ type: 'text', text: `user: [[c:q.in]] see ${ref}` }] }] });
  const [one, two, other] = [await post(s.url, ask('img_abc123_4')), await post(s.url, ask('img_def456_4')), await post(s.url, ask('img_abc123_5'))].map((r) => r.json.content![0].thinking);
  assert.equal(one, two, 'the nonce masked');
  assert.notEqual(one, other, 'the ref\'s number still moves it');
}));

test('T13e: where the request\'s model binds, thinking a host edited is refused with the page\'s 400 in any assistant message, under the drop control too, and a block whose text verifies but whose request changed is still refused, or set aside under the drop control', async () => {
  const DROP = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const modified = (i: number) => `messages.${i}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
  for (const control of [false, true]) {
    await withStandin({}, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, ...Array.from({ length: 6 }, () => ({ text: 'ok' }))]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]', model: 'claude-opus-5-5' }), thinking: control ? DROP : { type: 'adaptive', display: 'summarized' } };
      const first = (await post(s.url, opening)).json;
      const call = first.content!.find((b) => b.type === 'tool_use');
      const next = (reply: MessagesAnswer['content'], prefix = opening.messages[0], more: MessageItem[] = []) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
          ...more,
        ],
      });
      const later = [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] and then' }] }];
      assert.equal((await post(s.url, next(first.content))).status, 200, 'the block as it was minted is taken');
      const altered = first.content!.map((b) => (b.type === 'thinking' ? { ...b, thinking: `${b.thinking} (trimmed)` } : b));
      const latest = await post(s.url, next(altered));
      assert.deepEqual([latest.status, latest.json.error?.message], [400, modified(1)], 'edited in the latest assistant message');
      const earlier = await post(s.url, next(altered, opening.messages[0], later));
      assert.deepEqual([earlier.status, earlier.json.error?.message], [400, modified(1)], 'edited in an earlier one');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const moved = await post(s.url, next(first.content, changedPrefix, later));
      if (control) {
        assert.equal(moved.status, 200, 'its text verifies, so only its request changed, and the drop control sets it aside');
        const withoutBlock = next(first.content!.filter((b) => b.type !== 'thinking'), changedPrefix, later);
        assert.equal(await s.countTokens(next(first.content, changedPrefix, later)), await s.countTokens(withoutBlock), 'set aside in an earlier message, it counts for nothing');
        assert.equal(moved.json.usage!.input_tokens + moved.json.usage!.cache_read_input_tokens + moved.json.usage!.cache_creation_input_tokens, await s.countTokens(withoutBlock), 'nor is it billed');
      }
      else assert.deepEqual([moved.status, moved.json.error?.message], [400, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.']);
    });
  }
});

test('T13f: on Opus 5.5 an older account takes a block whose request changed with the field unset, and refuses it only under "error", and on Haiku 5.5, whose page gives no such rule, it refuses as a newer one; under the binding beta every answer reports what failed the check, as dropped or as allowed, streamed in message_start or not, and the records keep it', async () => {
  const BETA = { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' };
  const DROP = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const ERROR = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } };
  const report = (type: string) => [{ type, reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }];
  const cases = [
    { account: 'older', thinking: null, beta: true, status: 200, report: report('thinking_mismatch_allowed'), counts: true },
    { account: 'older', thinking: null, beta: false, status: 200, report: undefined, counts: true },
    { account: 'older', thinking: ERROR, beta: true, status: 400 },
    { account: undefined, thinking: null, beta: true, status: 400 },
    { account: undefined, thinking: DROP, beta: true, status: 200, report: report('thinking_dropped'), counts: false },
    { account: 'older', thinking: DROP, beta: true, status: 200, report: report('thinking_dropped'), counts: false },
    { account: 'older', thinking: null, beta: true, status: 400, model: 'claude-haiku-5-5' },
  ];
  for (const c of cases.flatMap((x) => [{ ...x, stream: false }, { ...x, stream: true }])) {
    const said = `${c.account ?? 'newer'} account on ${c.model ?? 'claude-opus-5-5'}, ${c.thinking?.block_binding?.prefix_mismatch_behavior ?? 'unset'}, ${c.beta ? 'with' : 'without'} the beta, ${c.stream ? 'streamed' : 'not streamed'}`;
    const s = await startStandin({ configuration: { windowTokens: 50_000, ...(c.account ? { account: c.account } : {}) } });
    let records = null;
    try {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]', stream: c.stream, model: c.model ?? 'claude-opus-5-5' }), thinking: { type: 'adaptive', display: 'summarized', ...c.thinking } };
      const headers = c.beta ? BETA : {};
      const first = await post(s.url, opening, '/v1/messages', headers);
      if (c.beta) assert.deepEqual(first.json.input_transformations, [], `${said}: an answer with nothing to report carries an empty report`);
      else assert.equal('input_transformations' in first.json, false, `${said}: no report without the beta`);
      const call = first.json.content!.find((b) => b.type === 'tool_use');
      const next = (prefix: MessageItem, reply: MessagesAnswer['content']) => ({ ...opening, messages: [prefix, { role: 'assistant', content: reply }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] }] });
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const changed = next(changedPrefix, first.json.content);
      const withoutBlock = next(changedPrefix, first.json.content!.filter((b) => b.type !== 'thinking'));
      const r = await post(s.url, changed, '/v1/messages', headers);
      assert.equal(r.status, c.status, said);
      if (c.status === 400) assert.match(JSON.stringify(r.json), /Invalid `signature` in `thinking` block\. The block is bound to a different conversation\./, `${said}: refused by the binding check`);
      if (c.status === 200) {
        assert.deepEqual(r.json.input_transformations, c.report, `${said}: the report`);
        assert.equal(await s.countTokens(changed) > await s.countTokens(withoutBlock), c.counts, `${said}: the block ${c.counts ? 'reaches the model and counts' : 'is set aside and counts for nothing'}`);
      }
      records = await s.close();
    } finally { if (!records) await s.close(); }
    if (c.status === 200) {
      assert.deepEqual(records.map((r) => r.transformations ?? []), [[], c.report ?? report(c.counts ? 'thinking_mismatch_allowed' : 'thinking_dropped')], `${said}: each record keeps what failed the check, reported or not`);
    }
  }
});

test('T63: on Claude Opus 5.5, whose thinking is always on, and Claude Haiku 5.5, which thinks unless asked not to, every answer leads with thinking signed for its request, empty unless the request asks display summarized: a summariser answer, which asks nothing, gains an empty block, and an agent\'s thinking goes empty under updates and stays under summarized; a summariser request disabling thinking on Haiku 5.5 is answered without; on Claude Opus 4.6 nothing changes', async () => {
  const asking = (thinking: Thinking) => ({ ...agentBody({ canary: '[[c:a.in]]', stream: false }), thinking });
  const thinksUnasked = (summ: MessagesAnswer, updates: MessagesAnswer, summarized: MessagesAnswer) => {
    assert.deepEqual(summ.content!.map((b) => [b.type, b.thinking ?? null]), [['thinking', ''], ['text', null]]);
    assert.equal(typeof summ.content![0].signature, 'string');
    assert.deepEqual(updates.content!.map((b) => [b.type, b.thinking ?? null]).slice(0, 1), [['thinking', '']]);
    assert.ok(summarized.content![0].thinking!.length > 0, 'summarized keeps the thinking\'s text');
  };
  for (const [model, check] of [
    ['claude-opus-5-5', thinksUnasked],
    ['claude-haiku-5-5', thinksUnasked],
    ['claude-opus-4-6', (summ, updates, summarized) => {
      assert.deepEqual(summ.content!.map((b) => b.type), ['text'], 'no thinking added on a model that thinks only when asked');
      assert.ok(updates.content![0].thinking!.length > 0 && summarized.content![0].thinking!.length > 0);
    }],
  ] satisfies Array<[string, typeof thinksUnasked]>) {
    await withStandin({ thinks: true }, async (s) => {
      s.setStep({ ...step('a', [{ text: 'one' }, { text: 'two' }]) });
      const summ = (await post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model })).json;
      const updates = (await post(s.url, { ...asking({ type: 'adaptive', display: 'updates' }), model })).json;
      const summarized = (await post(s.url, { ...asking({ type: 'adaptive', display: 'summarized' }), model })).json;
      check(summ, updates, summarized);
    });
  }
  await withStandin({}, async (s) => {
    const off = (await post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })).json;
    assert.deepEqual(off.content!.map((b) => b.type), ['text'], 'Haiku 5.5 with thinking disabled answers without');
  });
});

test('T65: each thinking type the troubleshooting page\'s table rejects on a model is refused with a 400 in that page\'s words: enabled, disabled and between_tools on Claude Opus 5.5; enabled, between_tools, and disabled at effort xhigh or max on Claude Haiku 5.5; between_tools on Claude Opus 4.6; adaptive and between_tools on Claude Haiku 4.5; disabled at high on Haiku 5.5 is answered', () => withStandin({}, async (s) => {
  const ENABLED = '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  const DISABLED = '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  const BETWEEN = '"thinking.type.between_tools" is not supported for this model.';
  const ask = (model: string, thinking: Thinking, effort: string | null) => post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model, thinking, ...(effort ? { output_config: { effort } } : {}) });
  for (const [model, thinking, effort, message] of [
    ['claude-opus-5-5', { type: 'enabled', budget_tokens: 2048 }, null, ENABLED],
    ['claude-opus-5-5', { type: 'disabled' }, null, DISABLED],
    ['claude-opus-5-5', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-5-5', { type: 'enabled', budget_tokens: 2048 }, null, ENABLED],
    ['claude-haiku-5-5', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-5-5', { type: 'disabled' }, 'xhigh', 'output_config.effort \'xhigh\' is not supported when thinking is disabled on this model. Use effort \'high\' or below, or enable thinking.'],
    ['claude-haiku-5-5', { type: 'disabled' }, 'max', 'output_config.effort \'max\' is not supported when thinking is disabled on this model. Use effort \'high\' or below, or enable thinking.'],
    ['claude-opus-4-6', { type: 'between_tools' }, null, BETWEEN],
    ['claude-haiku-4-5-20251001', { type: 'adaptive' }, null, 'adaptive thinking is not supported on this model'],
    ['claude-haiku-4-5-20251001', { type: 'between_tools' }, null, BETWEEN],
  ] satisfies Array<[string, Thinking, string | null, string]>) {
    const answer = await ask(model, thinking, effort);
    assert.deepEqual([answer.status, answer.json?.error?.message], [400, message], `${model} ${thinking.type}${effort ? ` at ${effort}` : ''}`);
  }
  assert.equal((await ask('claude-haiku-5-5', { type: 'disabled' }, 'high')).status, 200, 'disabled at high is accepted');
}));

test('T65a: a thinking type a model\'s rules don\'t list as their own, such as one only an object\'s prototype holds, isn\'t refused as a type they reject', () => withStandin({}, async (s) => {
  for (const type of ['constructor', 'toString', 'hasOwnProperty']) {
    const answer = await post(s.url, { ...summariserBody({ canaries: ['[[c:a.1]]'] }), model: 'claude-opus-5-5', thinking: { type } });
    assert.equal(answer.status, 200, type);
  }
  assert.deepEqual((await s.close()).map((r) => r.refused ?? null), [null, null, null]);
}));

test('T64: on Claude Opus 4.6, whose manual thinking doesn\'t interleave, an answer to a request asking `type: enabled` carries thinking only at a turn\'s start: after a user turn holding tool results it carries none, whether the results come alone, with text after them, or over two messages; under adaptive thinking, which interleaves, it keeps its thinking', () => withStandin({ thinks: true }, async (s) => {
  s.setStep({ ...step('i', [{ text: 'start', calls: [{ name: 'time--now', input: {} }] }, { text: 'after' }, { text: 'after, with text' }, { text: 'after, over two' }, { text: 'adaptive after' }]), canaries: ['[[c:i.in]]'], namedAnywhere: true });
  const enabled = { type: 'enabled', budget_tokens: 2048, display: 'summarized' };
  const start = (await post(s.url, { ...agentBody({ canary: '[[c:i.in]]', model: 'claude-opus-4-6', stream: false }), thinking: enabled })).json;
  assert.deepEqual(start.content!.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'a turn\'s start thinks');
  const call = start.content!.find((b) => b.type === 'tool_use');
  const history = [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:i.in]] go' }] }, { role: 'assistant', content: start.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: 'now' }] }];
  const round = (thinking: Thinking) => ({ model: 'claude-opus-4-6', max_tokens: 2048, stream: false, system: 'You are the fixture agent.', tools: TOOLS, thinking, messages: history });
  assert.deepEqual((await post(s.url, round(enabled))).json.content!.map((b) => b.type), ['text'], 'after results alone, no thinking');
  const withText = { ...round(enabled), messages: [...history.slice(0, -1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: call!.id, content: 'now' }, { type: 'text', text: 'and more' }] }] };
  assert.deepEqual((await post(s.url, withText)).json.content!.map((b) => b.type), ['text'], 'after results with text after them, no thinking');
  const overTwo = { ...round(enabled), messages: [...history, { role: 'user', content: [{ type: 'text', text: 'and more' }] }] };
  assert.deepEqual((await post(s.url, overTwo)).json.content!.map((b) => b.type), ['text'], 'after results and a second user message, which the API joins to them, no thinking');
  assert.deepEqual((await post(s.url, round({ type: 'adaptive', display: 'summarized' }))).json.content!.map((b) => b.type), ['thinking', 'text'], 'adaptive interleaves');
}));
