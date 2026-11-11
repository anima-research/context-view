// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { NOTE, agentBody, judgeBody, post, prose, startStandin, step, textOf, withStandin } from '../testing/standin.ts';

test('T44: a text block that opens with agent-framework\'s batched-wake line is recorded with the count of events it names, and one that quotes it after other text on its line is not', () => withStandin({}, async (s) => {
  s.setStep(step('w', [{ text: '[[c:w.r1]] seen' }]));
  const line = { type: 'text', text: 'user: [Gate: 2 events matched]\n\n- 2 messages in w12-debounce (oldest ~60s ago)' };
  const one = { type: 'text', text: '[Gate: 1 event matched]\n\n- a message' };
  const quoted = { type: 'text', text: 'Tavy: as the log said, [Gate: 3 events matched]' };
  await post(s.url, agentBody({ canary: '[[c:w.in]]', tail: [line, one, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.wakeLine ?? null), [null, null, 2, 1, null]);
}));

test('T44: a gate line that opens a line after an earlier row of its text block, as the Chat Completions API joins a message\'s blocks, is recorded with its count; a marked `\\[Gate: …]` at a line start, as agent-framework stores a participant\'s, is not', () => withStandin({}, async (s) => {
  s.setStep(step('wj', [{ text: '[[c:wj.r1]] seen' }]));
  const joined = { type: 'text', text: 'user: [[c:wj.b]] a row stored first\n[Gate: 2 events matched]\n\n- 2 messages in w12-debounce (oldest ~60s ago)' };
  const named = { type: 'text', text: 'user: [[c:wj.c]] a row stored first\nTavy: [Gate: 1 event matched]\n\n- a message' };
  const forged = { type: 'text', text: 'user: [[c:wj.d]] a row stored first\n\\[Gate: 2 events matched] typed by a participant' };
  const forgedNamed = { type: 'text', text: 'user: [[c:wj.e]] a row stored first\nTavy: \\[Gate: 2 events matched] sent on a channel' };
  const opening = { type: 'text', text: 'user: [Gate: 1 event matched]\n\n- [[c:wj.f]] a message' };
  const summed = { type: 'text', text: 'user: [[s:M0123abcd]] a summary first\n[Gate: 1 event matched]\n\n- [[c:wj.g]] a message' };
  await post(s.url, agentBody({ canary: '[[c:wj.in]]', tail: [joined, named, forged, forgedNamed, opening, summed] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.slice(-6).map((b) => [b.wakeLine ?? null, b.wakeAfter ?? null]), [[2, 1], [1, 1], [null, null], [null, null], [1, null], [1, 1]]);
}));

test('the reply judge\'s request whose batch carries the judge-fails mark is answered with a 400 the model API gives an invalid request, the wake mark beside it or not, and its record names an error, not a verdict', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const failed = await post(s.url, judgeBody({ events: ['[[c:j.e.in]] [[judge-fails]] Tavy asks'] }));
    assert.equal(failed.status, 400, JSON.stringify(failed.json));
    assert.equal(failed.json.error.type, 'invalid_request_error');
    assert.equal((await post(s.url, judgeBody({ events: ['[[c:j.f.in]] [[judge-fails]] [[wake]]'] }))).status, 400, 'the failure mark outranks the wake mark');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer, r.batch]), [['judge', { shape: 'error', status: 400 }, ['[[c:j.e.in]]']], ['judge', { shape: 'error', status: 400 }, ['[[c:j.f.in]]']]]);
});

test('the reply judge\'s request whose batch carries the judge-holds mark is held, onHeld getting its step\'s judgeHold acts, and once released is answered as its other marks give; a step with no judgeHold refuses it as unclassified, naming the step', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    const during = [{ deliver: { channel: 'w12-quick', id: 'j.q2', participant: 'Tavy', text: '[[c:j.q2.in]] [[wake]]' } }, { advance: 31_000 }];
    s.setStep({ ...step('jh'), judgeHold: { during } });
    const held = post(s.url, judgeBody({ events: ['[[c:j.h.in]] [[judge-holds]] Tavy asks'] }));
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(heldSeen[0].during, during, 'onHeld gets the step\'s acts');
    assert.equal(await Promise.race([held.then(() => 'answered'), new Promise((r) => setTimeout(() => r('pending'), 200))]), 'pending', 'the request stays unanswered until its release');
    assert.equal(s.releaseHeld(heldSeen[0].id), true);
    const answered = await held;
    assert.equal(answered.status, 200, JSON.stringify(answered.json));
    assert.match(textOf(answered.json), /^WAIT: \S/, 'answered as the batch\'s marks give once released');
    s.setStep(step('bare'));
    assert.equal((await post(s.url, judgeBody({ events: ['[[c:j.i.in]] [[judge-holds]] [[wake]]'] }))).status, 400, 'a step with no judgeHold refuses it');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer?.verdict ?? null]), [['judge', 'wait'], ['unclassified', null]]);
  assert.match(records[1].reason, /judge-holds.*step \S*bare\S* gives no judgeHold/);
});

test('a text block that opens with subscription-gc\'s `[subscription-gc]` is recorded as that notice, and one quoting it later isn\'t', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const closed = { type: 'text', text: '[subscription-gc] Auto-closed channel w12-gc: it emitted over 2000 characters of ambient traffic since your last activation without engagement.' };
  const quoted = { type: 'text', text: 'Tavy: it said [subscription-gc] earlier' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [closed, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.notice ?? null).slice(-2), ['subscription-gc', null]);
}));

test('a `[host-notice]` block records which of the notices module\'s two forms it\'s in: what the host posted while the agent couldn\'t respond, or a status notice it posted', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const unanswered = { type: 'text', text: 'user: [host-notice] While you could not respond (instructions-unavailable), the host posted this in chat: "⚠ [host notice] fixture"' };
  const status = { type: 'text', text: 'user: [host-notice] The host posted this status notice in w12-status about instructions-unavailable, for whoever runs it; nothing in it needs you to act: "⚠ [host notice] fixture"' };
  const other = { type: 'text', text: 'user: [host-notice] Something the module doesn\'t write.' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [unanswered, status, other] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.slice(-3).map((b) => [b.notice, b.noticeForm]), [['host-notice', 'unanswered'], ['host-notice', 'status'], ['host-notice', null]]);
}));

test('T46: a text block that opens with the notices module\'s `[host-notice]`, or agent-framework\'s `[suppression review]`, `[wake onboarding]`, `[refusal-rewind]` or `[turns-set-aside]`, `[discord-send-failed]`, `[self-wake]` or `[routing]`, or with a line break and then `[Channel invitation]`, is recorded as that notice, and one quoting any of them later isn\'t', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const notice = { type: 'text', text: 'user: [host-notice] While you could not respond (instructions-unavailable), the host posted this in chat.' };
  const reviewed = { type: 'text', text: 'user: [suppression review] Since 2026-01-05T09:00:00Z (2 hours), your suppress rules hid 2 events.' };
  const offered = { type: 'text', text: 'user: [wake onboarding] Events from the MCPL server "quiet" reach your context without waking you.' };
  const rewound = { type: 'text', text: 'user: [refusal-rewind] The 1 most recent turn(s) were set aside because the model refused on them (content filter: unknown).' };
  const setAside = { type: 'text', text: 'user: [turns-set-aside] The 1 most recent turn(s) were set aside because the model refused on them (content filter: unknown).' };
  const unposted = { type: 'text', text: 'user: [discord-send-failed] Your previous reply (12 chars) could not be delivered to #chat (the "fixture" server said it didn\'t post the message). Nothing was posted; it is saved in your archive.' };
  const woke = { type: 'text', text: 'user: [self-wake] your skip_reply timer (120s) elapsed — now 2026-01-05T09:02:00Z' };
  const routed = { type: 'text', text: 'user: [routing] The conversation is now in feed.' };
  const invited = { type: 'text', text: '\n[Channel invitation] side is closed: 1. Open it with channel_open to reply there.' };
  const quoted = { type: 'text', text: 'Tavy: it said [host-notice] earlier, and [suppression review], [wake onboarding], [refusal-rewind], [turns-set-aside], [discord-send-failed], [self-wake], [routing] and [Channel invitation] too' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [notice, reviewed, offered, rewound, setAside, unposted, woke, routed, invited, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.notice ?? null), [null, null, 'host-notice', 'suppression review', 'wake onboarding', 'refusal-rewind', 'turns-set-aside', 'discord-send-failed', 'self-wake', 'routing', 'Channel invitation', null]);
}));


test('T49: the reply judge\'s request is answered REPLY when its batch carries the wake mark and WAIT when it doesn\'t, whatever the document and instructions carry, whatever the step; its record names the verdict and the batch\'s canaries', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const yes = await post(s.url, judgeBody({ events: ['[[c:j.a.in]] Tavy asks [[wake]] about the garden', '[[c:j.b.in]] and more'] }));
    assert.equal(yes.status, 200, JSON.stringify(yes.json));
    assert.match(textOf(yes.json), /^REPLY: \S/);
    const no = await post(s.url, judgeBody({ events: ['[[c:j.c.in]] Tavy talks to Ash'] }));
    assert.equal(no.status, 200, JSON.stringify(no.json));
    assert.match(textOf(no.json), /^WAIT: \S/);
    s.setStep(null);
    assert.match(textOf((await post(s.url, judgeBody({ events: ['[[c:j.d.in]] [[wake]]'] }))).json), /^REPLY: /, 'with no step set too');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['judge', 'reply', ['[[c:j.a.in]]', '[[c:j.b.in]]']], ['judge', 'wait', ['[[c:j.c.in]]']], ['judge', 'reply', ['[[c:j.d.in]]']]]);
});

test('T49: a reply judge\'s request whose last block holds no batch is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const body = judgeBody({ events: ['[[c:j.e.in]] [[wake]]'] });
  body.messages[0].content.at(-1).text = 'user: Should fixture be woken now to respond?';
  const r = await post(s.url, body);
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /new_events/);
}));

function reviewBody(events) {
  const text = [
    'The agent\'s rule "w12-mute" hides events from its context. The agent described it as:',
    '"the muted channel\'s chatter"',
    'The rule matches: {"channel":"*w12-mute"}',
    'From 2026-01-05T09:00:00.000Z to 2026-01-05T11:00:00.000Z it hid 2 events. Here they are:',
    '',
    ...events.map((e, i) => `#${i + 1} [09:01] mcpl:channel-incoming · fixture · w12-mute · u-tavy: ${e}`),
    '',
    'Which of these, if any, should the agent have seen? Answer with the JSON object.',
  ].join('\n');
  return {
    model: 'claude-haiku-5-5', max_tokens: 4096, stream: false, output_config: { effort: 'low' },
    system: 'You review a filter an AI agent set on its own attention. The agent wrote a rule that hides some incoming events',
    messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${text}` }] }],
  };
}

test('T50: a suppression review\'s request is answered with the JSON the review reads, flagging by number each event that carries the flag mark, and fitting when none does, whatever the step; its record names the verdict, every listed event\'s canary and the flagged ones\'', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const flagged = await post(s.url, reviewBody(['[[c:m.1.in]] the eye went on', '[[c:m.2.in]] [[flag]] Ash asks the fixture something', '[[c:m.3.in]] the eye went off']));
    assert.equal(flagged.status, 200, JSON.stringify(flagged.json));
    assert.deepEqual({ ...JSON.parse(textOf(flagged.json)), note: undefined }, { fits: false, flagged: [2], note: undefined });
    s.setStep(null);
    const fits = await post(s.url, reviewBody(['[[c:m.4.in]] the eye went on']));
    assert.deepEqual({ ...JSON.parse(textOf(fits.json)), note: undefined }, { fits: true, flagged: [], note: undefined });
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch, r.flagged]), [['review', 'flagged', ['[[c:m.1.in]]', '[[c:m.2.in]]', '[[c:m.3.in]]'], ['[[c:m.2.in]]']], ['review', 'fits', ['[[c:m.4.in]]'], []]]);
});

test('T50: a suppression review\'s request that lists no event is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const r = await post(s.url, reviewBody([]));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /lists no event/);
}));

function retrievalBody(system, text) {
  return { model: 'claude-haiku-4-5-20251001', max_tokens: 500, stream: false, temperature: 0, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${text}` }] }] };
}

const CONCEPTS_SYSTEM = 'You are a knowledge retrieval assistant. Given the recent conversation below, identify concepts, entities, topics, or themes that might benefit from background knowledge or lessons learned from previous research.';

const RELEVANCE_SYSTEM = 'You are a relevance filter. Given the current conversation context and a set of candidate knowledge lessons, determine which lessons are actually relevant to the current discussion.';

test('T51: retrieval\'s concept request is answered with a JSON array of the canaries its conversation names, in order and once each, or an empty one; its record names them', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('elsewhere'));
    const named = await post(s.url, retrievalBody(CONCEPTS_SYSTEM, 'Recent conversation:\nuser: Tavy: [[c:m.1.in]] the eye [[c:l.lesson-a]]\n\nfixture: [[c:m.1.r1]] went on [[c:l.lesson-a]]'));
    assert.equal(named.status, 200, JSON.stringify(named.json));
    assert.deepEqual(JSON.parse(textOf(named.json)), ['[[c:m.1.in]]', '[[c:l.lesson-a]]', '[[c:m.1.r1]]']);
    s.setStep(null);
    const none = await post(s.url, retrievalBody(CONCEPTS_SYSTEM, 'Recent conversation:\nuser: Tavy: the eye went on'));
    assert.deepEqual(JSON.parse(textOf(none.json)), []);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['concepts', 'named', ['[[c:m.1.in]]', '[[c:l.lesson-a]]', '[[c:m.1.r1]]']], ['concepts', 'none', []]]);
});

test('T51: retrieval\'s relevance request is answered with the ids of the candidate lessons whose content doesn\'t carry the stale mark; its record names every candidate\'s canary and the kept ones\'', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const asking = (lines) => retrievalBody(RELEVANCE_SYSTEM, `Current conversation:\nuser: Tavy: [[c:m.2.in]] [[c:l.lesson-a]] [[c:l.lesson-d]]\n\nCandidate lessons:\n${lines.join('\n')}`);
  try {
    s.setStep(step('elsewhere'));
    const filtered = await post(s.url, asking(['[370a9eb3] (0.50) [[c:l.lesson-a]] the eye went on', '[74bb5736] (0.50) [[c:l.lesson-d]] [[stale]] the eye went off']));
    assert.equal(filtered.status, 200, JSON.stringify(filtered.json));
    assert.deepEqual(JSON.parse(textOf(filtered.json)), ['370a9eb3']);
    const kept = await post(s.url, asking(['[1b49fcf3] (0.50) [[c:l.lesson-b]] the eye went on']));
    assert.deepEqual(JSON.parse(textOf(kept.json)), ['1b49fcf3']);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch, r.kept]), [['relevance', 'filtered', ['[[c:l.lesson-a]]', '[[c:l.lesson-d]]'], ['[[c:l.lesson-a]]']], ['relevance', 'kept', ['[[c:l.lesson-b]]'], ['[[c:l.lesson-b]]']]]);
});

test('T51: a relevance request that lists no candidate lesson is refused as unclassified, naming what\'s missing', () => withStandin({}, async (s) => {
  const r = await post(s.url, retrievalBody(RELEVANCE_SYSTEM, 'Current conversation:\nuser: Tavy: [[c:m.2.in]] the eye\n\nCandidate lessons:\n'));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /lists no candidate lesson/);
}));

test('T52: a text block that opens with retrieval\'s `## Retrieved Knowledge` heading, as placed or as stored, is recorded as retrieved, and one quoting the heading later isn\'t', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const placed = { type: 'text', text: '## Retrieved Knowledge\n- [50%] [[c:l.lesson-a]] the eye went on (tags: fixture)' };
  const stored = { type: 'text', text: 'system_context:retrieval: ## Retrieved Knowledge, for the message beginning "Tavy: [[c:h.in]] the…"\n- [50%] [[c:l.lesson-a]] the eye went on (tags: fixture)' };
  const quoted = { type: 'text', text: 'Tavy: it said ## Retrieved Knowledge earlier' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [placed, stored, quoted] }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.map((b) => b.retrieved ?? null), [null, null, true, true, null]);
}));

const NAMING_SYSTEM = 'You are a session naming assistant. Given a brief summary of a conversation, generate a short, evocative name (2-4 words) that captures its essence. The name should be memorable and descriptive, like a chapter title.\n\nExamples of good names:\n- "Context Window Budgeting"\n\nRespond with ONLY the name, nothing else. No quotes, no explanation.';

test('T53: connectome-host\'s session naming request is answered with one name of at most 60 characters on one line, whatever the summary and the step; its record names the summary\'s canaries', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const ask = (summary) => post(s.url, { model: 'claude-haiku-4-5-20251001', max_tokens: 30, temperature: 0.8, stream: false, system: [{ type: 'text', text: NAMING_SYSTEM }], messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${summary}` }] }] });
  try {
    s.setStep(step('elsewhere'));
    const first = await ask('user: Tavy: [[c:n.1.in]] the eye\nfixture: [[c:n.1.r1]] went on');
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const name = textOf(first.json);
    assert.ok(name.length > 0 && name.length <= 60 && !name.includes('\n'), `a name the host keeps: ${JSON.stringify(name)}`);
    s.setStep(null);
    assert.equal(textOf((await ask('user: Tavy: nothing marked')).json), name, 'the same name for any summary');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => [r.kind, r.answer.verdict, r.batch]), [['naming', 'named', ['[[c:n.1.in]]', '[[c:n.1.r1]]']], ['naming', 'named', []]]);
});

test('T54: a text block that opens with one of agent-framework\'s tags it has marked as supplied text, `\\[Gate: …]`, `\\[suppression review]` or `\\[wake onboarding]`, is recorded as that marked tag with the names written before it, a participant\'s and an author\'s, and not as a notice; an unmarked one is still the notice, and one quoting a marked tag later in its line is neither', () => withStandin({}, async (s) => {
  s.setStep(step('h', [{ text: '[[c:h.r1]] seen' }]));
  const typed = { type: 'text', text: 'user: \\[Gate: 2 events matched] [[c:h.in]] typed at the console' };
  const sent = { type: 'text', text: 'user: Tavy: \\[Gate: 2 events matched] [[c:h.b]] sent on a channel' };
  const reviewed = { type: 'text', text: 'Tavy: \\[suppression review] and on' };
  const offered = { type: 'text', text: '\\[wake onboarding] and on' };
  const real = { type: 'text', text: 'user: [suppression review] Since 2026-01-05T09:00:00Z (2 hours), your suppress rules hid 2 events.' };
  const quoted = { type: 'text', text: 'Tavy: it said \\[Gate: 2 events matched] earlier' };
  const other = { type: 'text', text: 'user: Tavy: \\[host-notice] not one of its tags' };
  await post(s.url, agentBody({ canary: '[[c:h.in]]', tail: [typed, sent, reviewed, offered, real, quoted, other] }));
  const [record] = await s.close();
  const blocks = record.messages.at(-1).blocks.slice(-7);
  assert.deepEqual(blocks.map((b) => [b.markedNotice ?? null, b.notice ?? null, b.wakeLine ?? null]), [[{ tag: 'Gate', after: ['user'] }, null, null], [{ tag: 'Gate', after: ['user', 'Tavy'] }, null, null], [{ tag: 'suppression review', after: ['Tavy'] }, null, null], [{ tag: 'wake onboarding', after: [] }, null, null], [null, 'suppression review', null], [null, null, null], [null, null, null]]);
}));

test('T54: a marked tag that opens a line after an earlier row of its text block, as the Chat Completions API joins a message\'s blocks, is recorded with the names written before it on its line, as the gate line is found at any line start; one quoting a marked tag later in its line is not', () => withStandin({}, async (s) => {
  s.setStep(step('hj', [{ text: '[[c:hj.r1]] seen' }]));
  const typed = { type: 'text', text: 'user: [[c:hj.b]] a row stored first\n\\[Gate: 2 events matched] typed at the console' };
  const sent = { type: 'text', text: 'user: [[c:hj.c]] a row stored first\nTavy: \\[Gate: 2 events matched] sent on a channel' };
  const reviewed = { type: 'text', text: 'user: [[c:hj.d]] a row stored first\nTavy: \\[suppression review] and on' };
  const quoted = { type: 'text', text: 'user: [[c:hj.e]] a row stored first\nTavy: it said \\[Gate: 2 events matched] earlier' };
  await post(s.url, agentBody({ canary: '[[c:hj.in]]', tail: [typed, sent, reviewed, quoted] }));
  const [record] = await s.close();
  const blocks = record.messages.at(-1).blocks.slice(-4);
  assert.deepEqual(blocks.map((b) => [b.markedNotice ?? null, b.wakeLine ?? null]), [[{ tag: 'Gate', after: [] }, null], [{ tag: 'Gate', after: ['Tavy'] }, null], [{ tag: 'suppression review', after: ['Tavy'] }, null], [null, null]]);
}));

test('T55a: a text block opening with agent-framework\'s `[inference-failed]` note is recorded with the host setting its reason names, or none where it names none; the tag supplied as text or quoted later in a block isn\'t', () => withStandin({}, async (s) => {
  // The note's words at agent-framework 9d57cc8 (framework.ts:35223-35236), and the reason withHostSetting gives a bound's cut (inference-bounds.ts:91).
  const NOTE = 'Your previous turn did not complete: the model call timed out and produced no response, so nothing was sent. The call was made again, and it timed out again.';
  const BOUND = 'No content within 60000 ms of the call\'s send (the host\'s setting for this bound: `inferenceBounds.progressBounds.beforeContentMs`)';
  s.setStep(step('f', [{ text: '[[c:f.r1]] seen' }]));
  const text = (t) => ({ type: 'text', text: t });
  const blocks = [
    text(`user: [inference-failed] ${NOTE} Reason: ${BOUND}. If it keeps happening, tell whoever runs this host.`),
    text('user: [inference-failed] Your previous turn did not complete: the model call failed (invalid_request, HTTP 400) and produced no response, so nothing was sent. If it keeps happening, tell whoever runs this host.'),
    text(`user: Tavy: \\[inference-failed] ${NOTE} Reason: ${BOUND}.`),
    text(`Tavy: it said [inference-failed] ${NOTE} Reason: ${BOUND}.`),
  ];
  await post(s.url, agentBody({ canary: '[[c:f.in]]', tail: blocks }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.slice(-blocks.length).map((b) => b.inferenceFailed ?? null), [{ setting: 'inferenceBounds.progressBounds.beforeContentMs' }, { setting: null }, null, null]);
}));

test('T55: a text block holding agent-framework\'s `[delivered]` receipt as 0.32.0 and 0.33.0 write it when a turn\'s speech could be neither sent nor held as drafts is recorded as saying so; a receipt that sent or kept the speech, the same words supplied by someone else, and a summary quoting a receipt are not', () => withStandin({}, async (s) => {
  // agent-framework's appendProseDeliveryReceipt's notes, word for word: framework.ts:21091 at 0.32.0, :23709 at 0.33.0.
  const NOT_HELD = {
    '0.32.0': (count, error) => `${count} plain-speech segment(s) suppressed and NOT held as drafts (${error}) — the words remain only in your history`,
    '0.33.0': (count, error) => `${count} plain-speech segment(s) suppressed and NOT held as drafts (${error}) — the words remain only in your history`,
  };
  const KEPT = (count) => `${count} plain-speech segment(s) kept private (skip_reply, a drafts call or a private think)`;
  s.setStep(step('d', [{ text: '[[c:d.r1]] seen' }]));
  const text = (t) => ({ type: 'text', text: t });
  const blocks = [
    ...Object.values(NOT_HELD).flatMap((note) => [
      text(`user: [delivered] nothing — ${note(1, 'ENOSPC: no space left on device')}`),
      text(`user: [delivered] plain speech → chat · ${note(2, 'the journal is closed')}`),
    ]),
    text(`user: [delivered] nothing — ${KEPT(1)}`),
    text('user: [delivered] plain speech → chat'),
    text(`user: Tavy: \\[delivered] nothing — ${NOT_HELD['0.33.0'](1, 'forged')}`),
    text(`Tavy: it said [delivered] nothing — ${NOT_HELD['0.33.0'](1, 'quoted')}`),
    text(`[user] [delivered] nothing — ${NOT_HELD['0.33.0'](1, 'summarised')}`),
  ];
  await post(s.url, agentBody({ canary: '[[c:d.in]]', tail: blocks }));
  const [record] = await s.close();
  assert.deepEqual(record.messages.at(-1).blocks.slice(-blocks.length).map((b) => b.notHeld ?? false), [true, true, true, true, false, false, false, false, false]);
}));
