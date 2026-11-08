import { FIXTURE_AGENT, assemblies, judgedBy, requestPairs, withJudged } from './checks.mjs';
import { isUnreadable } from './invariants.mjs';
import { png } from './png.mjs';
import { hash32, prose, seeded } from './prose.mjs';
import { CHANNEL, INSTRUCTIONS, READER, TOOL, continuation, prefix, products } from './script.mjs';
import { REFUSED_CONTENT } from '../standin/summariser.mjs';
import { WAKE } from '../standin/judge.mjs';
import { FLAG } from '../standin/review.mjs';
import { STALE } from '../standin/retrieval.mjs';

const SIZES = {
  user: [450, 1800],
  call: [1200, 4500],
  result: [3000, 13500],
  reading: [9000, 12000],
  reply: [900, 3600],
  large: [45000, 60000],
  largeReply: [28000, 34000],
  document: [240000, 270000],
};

const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
// agent-framework's preflight refuses a budget no store fits and names its floor; the panel refuses one at or below
// the response reserve.
const edge = (ctx) => ctx.reserve + 1000;
export const canary = (seed, step, part) => `[[c:${seed}.${step}.${part}]]`;

function image(seed) {
  const r = seeded(seed);
  return png(16, 16, (m) => Math.floor(r() * m));
}

function writer(ctx, workload) {
  const r = seeded(`${ctx.seed}:${workload}`);
  const between = ([lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
  const c = (step, part) => canary(ctx.seed, step, part);
  const id = (step) => `${ctx.seed}.${step}`;
  const turn = (step, o = {}) => {
    const sid = id(step);
    const canaries = [c(step, 'in')];
    const text = `${c(step, 'in')} ${o.mark ? `${o.mark} ` : ''}${o.user ?? prose(between(o.size ?? SIZES.user), `${sid}:in`)}`;
    const calls = o.calls ?? 1;
    const rounds = calls === 0 ? 0 : (o.rounds ?? 1);
    const replies = [];
    let k = 0;
    let held = null;
    for (let i = 0; i < rounds; i++) {
      const roundCalls = [];
      for (let j = 0; j < calls; j++) {
        k++;
        const callCanary = c(step, `call${k}`);
        canaries.push(callCanary);
        const input = o.result ? o.result(k, callCanary) : { kind: 'prose', size: between(SIZES.result), canary: callCanary };
        const call = { name: TOOL, input: o.arrival?.after === k ? { ...input, hold: true } : input, ...(o.callId?.(k) ? { id: o.callId(k) } : {}) };
        if (o.arrival?.after === k) held = call;
        roundCalls.push(call);
      }
      replies.push({
        text: `${c(step, `r${i + 1}`)} ${prose(between(SIZES.call), `${sid}:r${i + 1}`)}`,
        ...(o.thinking && i === 0 ? { thinking: prose(o.thinking, `${sid}:think`) } : {}),
        calls: roundCalls,
      });
    }
    replies.push({ text: `${c(step, `r${rounds + 1}`)} ${prose(between(SIZES.reply), `${sid}:r${rounds + 1}`)}` });
    if (held) {
      held.during = [{ deliver: { id: `${sid}.arrival`, participant: 'Tavy', text: `${c(step, 'arr')} ${prose(between(SIZES.user), `${sid}:arr`)}` } }];
      canaries.push(c(step, 'arr'));
    }
    return {
      id: sid, segment: workload, kind: 'channel', channel: CHANNEL, participant: PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)], topic: workload,
      text, canaries, replies,
      ...(o.attach ? { images: [{ data: image(hash32(sid)), mimeType: 'image/png' }] } : {}),
      ...(o.more ?? {}),
    };
  };
  const other = (step, kind, fields) => ({ id: id(step), segment: workload, kind, ...fields });
  return { turn, other, c, id, between, size: between, SIZES };
}

// Knowledge sorts a message by its tools' names, which in a host are the fixture server's one tool.
const PHASE_PLAN = [
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 0 }, { calls: 0 }, { calls: 0 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 2 },
  { calls: 1 },
  { calls: 0 },
  { calls: 1 }, { calls: 1 },
];
const phaseTurn = (n) => PHASE_PLAN[(n - 1) % PHASE_PLAN.length];
const REFUSED_TURN = 3;

const READING_PLAN = [
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1 }, { calls: 1 }, { calls: 0 },
  { calls: 1, rounds: 2 }, { calls: 1 },
  { calls: 0, paste: true },
  { calls: 0 },
];
const readingTurn = (n) => READING_PLAN[(n - 1) % READING_PLAN.length];

function guardTurn(w, step) {
  const t = w.turn(step, { calls: 0 });
  const said = (k) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  return {
    ...t,
    replies: [
      { text: said(1), calls: [{ name: 'toolsets--open', input: { toolset: 'settings' } }] },
      { text: said(2), calls: [{ name: 'toolsets--act', input: { tool: 'agent_settings', args: { action: 'update', tool_result_guard: true } } }] },
      { text: said(3) },
    ],
    also: ['agent_settings', 'tool_result_guard'],
  };
}

function subagentTurn(w, ctx, step, rounds) {
  const marker = `[[knowledge:${ctx.seed}]]`;
  const sid = w.id(step);
  const subCanaries = [w.c(step, 'task')];
  const subReplies = rounds.map((round, i) => {
    const calls = round.calls.map((input, j) => {
      const callCanary = w.c(step, `s${i + 1}call${j + 1}`);
      subCanaries.push(callCanary);
      return { name: TOOL, input: { ...input, canary: callCanary } };
    });
    return { text: `${w.c(step, `s${i + 1}`)} ${prose(w.between(SIZES.call), `${sid}:s${i + 1}`)}`, calls, settle: true };
  });
  const report = w.c(step, 'report');
  subReplies.push({ text: `${report} ${prose(w.between(SIZES.reply), `${sid}:report`)}`, settle: true });
  const t = w.turn(step, { calls: 0 });
  return {
    ...t,
    canaries: [...t.canaries, report],
    replies: [
      { text: `${w.c(step, 'r1')} ${prose(200, `${sid}:r1`)}`, calls: [{ name: 'subagent--spawn', input: { name: `knowledge-${ctx.seed}`, systemPrompt: `${marker} You are the fixture's knowledge subagent.`, task: `${w.c(step, 'task')} ${prose(w.between(SIZES.user), `${sid}:task`)}`, sync: true } }] },
      { text: `${w.c(step, 'r2')} ${prose(w.between(SIZES.reply), `${sid}:r2`)}` },
    ],
    sub: { marker, canaries: subCanaries, replies: subReplies },
  };
}

// agent-framework's coordinator ends a tune-out past its wake budget, and a reader's plain prose has no destination
// (the host asks it again), so the reader reports with `deliver_summary` and ends with `skip_reply`.
function tunedOut(w, steps, count, o = {}) {
  const t = w.turn('tune', { calls: 0 });
  steps.push({
    ...t,
    replies: [
      { text: `${w.c('tune', 'r1')} ${prose(200, `${w.id('tune')}:r1`)}`, calls: [{ name: 'tune_out', input: { channelId: CHANNEL, cadenceSeconds: 86400, maxWakes: 64 } }] },
      { text: `${w.c('tune', 'r2')} ${prose(200, `${w.id('tune')}:r2`)}` },
    ],
    namedAnywhere: true,
  });
  for (let k = 1; k <= count; k++) {
    for (const step of o.before?.[k] ?? []) steps.push(step);
    const held = w.turn(`h${k}`, { calls: 0 });
    steps.push({
      ...held,
      tags: ['chat:addressed'],
      reader: 'Subconscious',
      ...(o.mayFail?.(k) ? { mayFail: true } : {}),
      replies: [],
      sub: {
        marker: READER,
        canaries: [w.c(`h${k}`, 'in')],
        namedAnywhere: true,
        also: ['addressed message'],
        replies: [
          { calls: [{ name: 'deliver_summary', input: { text: `${w.c(`h${k}`, 'read')} ${prose(w.between(SIZES.reply), `${w.id(`h${k}`)}:read`)}`, channelId: CHANNEL } }] },
          { calls: [{ name: 'skip_reply', input: {} }] },
        ],
      },
    });
  }
}

function markdownPaste(seed, step, target) {
  const window = target * 4;
  let s = `${canary(seed, step, 'in')} `;
  const fill = (to) => { if (s.length < to) s += prose(Math.round(to) - s.length, `${seed}.${step}:${s.length}`); };
  const kind = step.endsWith('h') ? 'headings' : step.endsWith('i') ? 'fence' : 'blank';
  if (kind === 'headings') { fill(0.4 * window); s += '\n## Notes\n'; fill(0.75 * window); s += '\n### Detail\n'; }
  else if (kind === 'fence') { fill(0.3 * window); s += '\n```\nconst x = 1;\n```\n'; fill(0.75 * window); s += '\n\n'; }
  else { fill(0.4 * window); s += '\n\n'; fill(0.75 * window); s += '\n'; }
  fill(2.5 * window);
  return s;
}

const lastResultTexts = (messages) => {
  const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
  return blocks(messages.at(-1)?.content).filter((b) => b.type === 'tool_result').flatMap((b) => blocks(b.content)).filter((b) => b.type === 'text').map((b) => b.text ?? '');
};
const listedTools = (messages) => [...lastResultTexts(messages).join('\n').matchAll(/^ {2}([^\s(]+)\(/gm)].map((m) => m[1]);

function settingsTurn(w, step) {
  const t = w.turn(step, { calls: 0 });
  const said = (k) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  return {
    ...t,
    replies: [
      { text: said(1), calls: [{ name: 'toolsets--open', input: { toolset: 'settings' } }] },
      { text: said(2), calls: (messages) => listedTools(messages).map((tool) => ({ name: 'toolsets--look', input: { tool } })) },
      { text: said(3) },
    ],
    also: ['[settings]'],
  };
}

const W12_RULES = [
  { name: 'w12-always', match: { channel: '*w12-always' }, behavior: 'always' },
  { name: 'w12-defer', match: { channel: '*w12-defer' }, behavior: 'defer' },
  { name: 'w12-debounce', match: { channel: '*w12-debounce' }, behavior: { debounce: 60_000 } },
  { name: 'w12-rate', match: { channel: '*w12-rate' }, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000 } } },
  { name: 'w12-sample', match: { channel: '*w12-sample' }, behavior: { passive_sample: { every: 2 } }, passthrough: true },
  { name: 'w12-sample-rest', match: { channel: '*w12-sample' }, behavior: 'defer' },
  { name: 'w12-judge', match: { channel: '*w12-judge' }, behavior: { judge: { debounceMs: 60_000, instructions: `Wake me when a message carries ${WAKE}; let the rest go by.` } } },
];
const W12_MUTE = { name: 'w12-mute', match: { channel: '*w12-mute' }, behavior: 'defer', suppress: { description: 'the muted channel\'s chatter, which the fixture never needs' } };
const MUTE = '[[mute]]';
const W12_MUTE_TEXT = { name: 'w12-mute-text', match: { filter: { type: 'text', pattern: MUTE } }, behavior: 'defer', suppress: { description: 'anything carrying the mute mark' } };
const FORGED = '[Gate: 2 events matched]';
const tagOf = (opening) => /^\[([^\]:]+)/.exec(opening)[1];
const QUIET = '[[quiet]]';
const W12_QUIET = { name: 'w12-quiet', match: { filter: { type: 'text', pattern: QUIET } }, behavior: 'defer' };
const W12_ONTOLOGY = { tags: { 'w12:ping': { desc: 'a ping the fixture waits on an answer to', suggestedTreatment: 'immediate', rationale: 'a ping waits on its answer' } } };
const W12_PRIVILEGED = 'Wren';
const LESSONS = ['a', 'b', 'c', 'd'];
const STALE_LESSON = 'd';

function capable(capabilities) {
  return (name) => {
    if (capabilities?.unreadable) throw new Error(capabilities.unreadable);
    const has = capabilities?.[name];
    if (typeof has !== 'boolean') throw new Error(`couldn't tell whether the installed agent-framework brings ${name}: the host's facts don't say`);
    return has;
  };
}
const w12Rules = (has) => [...W12_RULES, ...(has('suppression') ? [W12_MUTE, W12_MUTE_TEXT] : []), ...(has('onboarding') ? [W12_QUIET] : [])];

function gateWriter(w) {
  const said = (step, k = 1) => `${w.c(step, `r${k}`)} ${prose(w.between(SIZES.reply), `${w.id(step)}:r${k}`)}`;
  const reply = (step) => ({ text: said(step) });
  const spare = (step) => ({ text: `${w.c(step, 'spare')} ${prose(200, `${w.id(step)}:spare`)}` });
  const message = (step, channel, { tags, participant = 'Tavy', wake = false, flag = false, quiet = false, mute = false, forged = null, server = null, offered = false, names = [] }) => ({ channel, id: w.id(step), participant, text: `${forged ? `${forged} ` : ''}${w.c(step, 'in')}${wake ? ` ${WAKE}` : ''}${flag ? ` ${FLAG}` : ''}${quiet ? ` ${QUIET}` : ''}${mute ? ` ${MUTE}` : ''} ${prose(w.between(SIZES.user), `${w.id(step)}:in`)}${names.map((n) => ` ${n}`).join('')}`, ...(tags ? { tags } : {}), ...(server ? { server } : {}), ...(offered ? { offered } : {}) });
  const deliver = (step, channel, expect, { tags, participant, rule = channel, calls, then = [], ends = false, notice = null, wake = false, flag = false, until = null, quiet = false, mute = false, forged = null, server = null, offered = false, recall = null } = {}) => {
    const sent = message(step, channel, { tags, participant, wake, flag, quiet, mute, forged, server, offered, names: recall?.named ?? [] });
    return {
      id: w.id(step), segment: 'W12', kind: 'deliver', topic: 'W12', messages: [sent], canaries: [w.c(step, 'in')],
      ...(expect !== 'wake' ? { spare: [spare(step)] } : calls ? { replies: [[calls, ...then].map((c, k) => ({ text: said(step, k + 1), calls: c })), ...(ends ? [] : [{ text: said(step, then.length + 2) }])].flat(), namedAnywhere: true } : { replies: [reply(step)] }),
      gate: { expect, rule, canaries: [w.c(step, 'in')], ...(notice ? { notice } : {}), ...(forged ? { forged: { tag: tagOf(forged), after: ['user', sent.participant] } } : {}), ...(recall ? { recall } : {}), ...(expect === 'hidden' ? { until: until && w.id(until) } : {}) },
    };
  };
  const act = (step, calls, { ends = false, then = [] } = {}) => deliver(step, CHANNEL, 'wake', { calls, then, rule: 'default', ends });
  const timed = (step, ms, rule, after) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, canaries: [w.c(after, 'in')], namedAnywhere: true, inputs: [], addressed: false,
    replies: [reply(step)],
    gate: { expect: 'self', rule, canaries: [] },
  });
  const fire = (step, ms, batch, { answered = false, addressed = true } = {}) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, canaries: batch.map((s) => w.c(s, 'in')), ...(addressed ? {} : { addressed: false }),
    ...(answered ? { spare: [reply(step)], also: ['[Gate: '] } : { inputs: batch.map((s) => w.c(s, 'in')), replies: [reply(step)] }),
    gate: { expect: answered ? 'answered-batch' : 'batch', canaries: batch.map((s) => w.c(s, 'in')) },
  });
  const judged = (step, ms, rule, batch, verdict) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, verdict: rule, canaries: batch.map((s) => w.c(s, 'in')), addressed: false,
    ...(verdict === 'reply' ? { inputs: batch.map((s) => w.c(s, 'in')), replies: [reply(step)] } : { spare: [spare(step)] }),
    gate: { expect: verdict === 'reply' ? 'batch' : 'none', rule, judged: verdict, canaries: batch.map((s) => w.c(s, 'in')) },
  });
  const file = (step, path, { remove = false, watched = false, rule = null, also = [], text = null } = {}) => ({
    id: w.id(step), segment: 'W12', kind: 'file', path, ...(remove ? { remove: true } : { text: text ?? `${w.c(step, 'file')} ${prose(400, `${w.id(step)}:file`)}\n` }), watched,
    canaries: [], inputs: [], also,
    ...(watched ? { addressed: false, replies: [reply(step)], gate: { expect: 'self', rule, canaries: [] } } : {}),
  });
  const reviewed = (step, ms, rule, hidden, flagged) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, review: true, canaries: flagged.map((s) => w.c(s, 'in')), inputs: [], addressed: false,
    replies: [reply(step)],
    gate: { expect: 'review', rule, hidden: hidden.map((s) => w.c(s, 'in')), flagged: flagged.map((s) => w.c(s, 'in')), canaries: [] },
  });
  const absent = (stretch) => ({ id: w.id(`absent.${stretch}`), segment: 'W12', kind: 'absent', stretch, canaries: [] });
  const typed = (step, { forged = null, mute = false, named = false } = {}) => ({
    id: w.id(step), segment: 'W12', kind: 'console', text: `${forged ? `${forged} ` : ''}${w.c(step, 'in')}${mute ? ` ${MUTE}` : ''} ${prose(w.between(SIZES.user), `${w.id(step)}:in`)}`,
    canaries: [w.c(step, 'in')], addressed: false, replies: [reply(step)], ...(named ? { named: true } : {}),
    gate: { expect: 'wake', rule: mute ? `default (the ${W12_MUTE_TEXT.name} suppress rule never meets console input)` : 'default', canaries: [w.c(step, 'in')], ...(forged ? { forged: { tag: tagOf(forged), after: ['user'] } } : {}), ...(named ? { naming: true } : {}) },
  });
  return { deliver, act, fire, judged, reviewed, absent, timed, file, typed };
}

function gateFates(run, steps) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const judge = run.records.filter((r) => r.kind === 'judge');
  const reviews = run.records.filter((r) => r.kind === 'review');
  const filters = run.records.filter((r) => r.kind === 'relevance');
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const carriesIn = (blocks, c) => blocks.some((b) => (b.canaries ?? []).includes(c));
  const lastCarries = (r, c) => carriesIn(r.messages?.at(-1)?.blocks ?? [], c);
  const carries = (r, c) => (r.messages ?? []).some((m) => carriesIn(m.blocks, c));
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const out = [];
  let judged = 0;
  for (const s of steps.filter((x) => x.gate)) {
    judged++;
    const mine = agent.filter((r) => r.step === s.id);
    const [c] = s.gate.canaries;
    if (s.gate.judged) {
      const asked = judge.filter((r) => r.step === s.id);
      if (asked.length !== 1) out.push({ step: s.id, message: `the ${s.gate.rule} rule's batch went to the reply judge in ${asked.length} request(s), where it goes in one` });
      else if (!s.gate.canaries.every((x) => (asked[0].batch ?? []).includes(x))) out.push({ step: s.id, message: `the reply judge's request ${asked[0].id} doesn't list every event of the batch (it lists ${(asked[0].batch ?? []).join(' ') || 'none'})` });
      else if (asked[0].answer?.verdict !== s.gate.judged) out.push({ step: s.id, message: `the reply judge's request ${asked[0].id} was answered ${asked[0].answer?.verdict ?? 'nothing'}, where the batch's mark gives ${s.gate.judged}` });
    }
    if (s.gate.recall) {
      const { named, kept, lessons, filtered } = s.gate.recall;
      const asked = filters.filter((r) => r.step === s.id);
      const opened = mine.find((r) => lastCarries(r, c));
      const injected = (opened?.messages ?? []).flatMap((m) => m.blocks).filter((b) => b.retrieved).at(-1);
      const given = (injected?.canaries ?? []).filter((x) => lessons.includes(x));
      if (!filtered && asked.length) out.push({ step: s.id, message: `the message naming ${named.length} lesson(s) brought ${asked.length} relevance request(s), where the module injects so few candidates without one` });
      if (filtered && asked.length !== 1) out.push({ step: s.id, message: `the ${named.length} candidate lessons the message names went to the relevance filter in ${asked.length} request(s), where they go in one` });
      else if (filtered && !sameSet(asked[0].batch ?? [], named)) out.push({ step: s.id, message: `the relevance request ${asked[0].id} lists ${(asked[0].batch ?? []).join(' ') || 'no lesson'}, where the message names ${named.join(' ')}` });
      if (opened && !injected) out.push({ step: s.id, message: `request ${opened.id}, which the message started, carries no retrieved lessons, where it names ${named.join(' ')}` });
      else if (opened && !sameSet([...new Set(given)], kept)) out.push({ step: s.id, message: `request ${opened.id}'s newest retrieved lessons are ${[...new Set(given)].join(' ') || 'none'}, where the message's candidates, less any the relevance filter drops, are ${kept.join(' ')}` });
    }
    if (s.gate.naming) {
      const named = run.records.filter((r) => r.kind === 'naming');
      const here = named.filter((r) => r.step === s.id);
      if (here.length !== 1) out.push({ step: s.id, message: `the third console message brought ${here.length} session naming request(s), where it brings one` });
      for (const r of named.filter((x) => x.step !== s.id)) out.push({ step: s.id, message: `session naming request ${r.id} came at step ${r.step}, where only the third console message brings one` });
    }
    if (s.gate.expect === 'wake') {
      const opened = mine.find((r) => lastCarries(r, c));
      const block = (opened?.messages.at(-1).blocks ?? []).find((b) => (b.canaries ?? []).includes(c));
      if (!opened) out.push({ step: s.id, message: `the ${s.gate.rule} rule's message started no request carrying it` });
      else if (s.gate.notice && !(opened.messages.at(-1).blocks ?? []).some((b) => b.notice === s.gate.notice)) out.push({ step: s.id, message: `request ${opened.id}, which its message started, carries no ${s.gate.notice} line in its last message, where the host owes one` });
      else if (s.gate.forged && !(block.markedNotice?.tag === s.gate.forged.tag && block.markedNotice.after.join(': ') === s.gate.forged.after.join(': '))) out.push({ step: s.id, message: `request ${opened.id} carries the step's text without its [${s.gate.forged.tag}] marked as supplied text after the names the host writes before it (${s.gate.forged.after.join(', ')}), so it can read as the framework's own` });
    } else if (s.gate.expect === 'none') {
      if (mine.length) out.push({ step: s.id, message: `the ${s.gate.rule} rule's message started ${mine.length} request(s), where its rule starts none` });
      const next = agent.find((r) => order.get(r.step) > order.get(s.id));
      const missing = s.gate.canaries.filter((x) => next && !carries(next, x));
      if (!next) out.push({ step: s.id, message: `couldn't judge: no request after the ${s.gate.rule} rule's message to carry it` });
      else if (missing.length) out.push({ step: s.id, message: `request ${next.id}, the next after the ${s.gate.rule} rule's message, doesn't carry ${missing.join(' ')}` });
    } else if (s.gate.expect === 'batch') {
      const opening = mine.filter((r) => s.gate.canaries.some((x) => lastCarries(r, x)));
      if (opening.length !== 1) out.push({ step: s.id, message: `the batch started ${opening.length} request(s) carrying it, where it starts one` });
      else if (!s.gate.canaries.every((x) => lastCarries(opening[0], x))) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn without all ${s.gate.canaries.length} of its events` });
      else if (!(opening[0].messages.at(-1).blocks ?? []).some((b) => b.wakeLine === s.gate.canaries.length)) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn with no wake line naming its ${s.gate.canaries.length} events` });
    } else if (s.gate.expect === 'hidden') {
      const shown = agent.filter((r) => carries(r, c) && (!s.gate.until || order.get(r.step) < order.get(s.gate.until)));
      if (shown.length) out.push({ step: s.id, message: `the ${s.gate.rule} rule's suppressed message reached request ${shown[0].id}${s.gate.until ? ', before the review that flags it' : ''}` });
    } else if (s.gate.expect === 'review') {
      const asked = reviews.filter((r) => r.step === s.id);
      const told = mine.filter((r) => (r.messages?.at(-1)?.blocks ?? []).some((b) => b.notice === 'suppression review'));
      const unflagged = s.gate.hidden.filter((x) => !s.gate.flagged.includes(x));
      if (asked.length !== 1) out.push({ step: s.id, message: `the review of what the ${s.gate.rule} rule hid went to the reviewer in ${asked.length} request(s), where it goes in one` });
      else if (!s.gate.hidden.every((x) => (asked[0].batch ?? []).includes(x))) out.push({ step: s.id, message: `the review's request ${asked[0].id} doesn't list every event the rule hid (it lists ${(asked[0].batch ?? []).join(' ') || 'none'})` });
      if (told.length !== 1) out.push({ step: s.id, message: `the review's notice started ${told.length} request(s) carrying it, where its flag wakes one` });
      else if (!s.gate.flagged.every((x) => lastCarries(told[0], x))) out.push({ step: s.id, message: `request ${told[0].id} carries the review's notice without the event it flagged` });
      else if (unflagged.some((x) => carries(told[0], x))) out.push({ step: s.id, message: `request ${told[0].id} carries an event the review found fits its rule` });
    } else if (s.gate.expect === 'answered-batch') {
      if (mine.length > 1) out.push({ step: s.id, message: `the batch the agent had already answered started ${mine.length} requests, where it starts one turn at most` });
    } else if (s.gate.expect === 'self') {
      if (!mine.length) out.push({ step: s.id, message: `${s.gate.rule} woke no turn at the step that moved the clock past it` });
    }
  }
  return withJudged(out, judged);
}

const entries = (run, kind) => run.log.filter((e) => e.kind === kind);
const readsOf = (run, op) => entries(run, 'read').filter((e) => e.op === op);

const blocksOf = (record) => (record.messages ?? []).flatMap((m, i) => m.blocks.map((b) => ({ i, role: m.role, b })));

const summarises = (configuration) => configuration.summarises !== false;

export const WORKLOADS = {
  prefix: {
    from: null,
    property: 'none: it writes the continuation\'s checkpoint and is no run of its own',
    steps: (ctx) => prefix(ctx.prefixTurns),
    check: () => [],
  },

  continuation: {
    from: 'prefix',
    property: 'each segment produces what it exists to produce (check 2)',
    steps: () => continuation(),
    check: () => judgedBy([], 2),
    products: (configuration) => products(configuration),
  },

  W1: {
    from: null,
    turns: 70,
    property: 'grows: L1, L2 and L3 summaries form as the store grows (configurations that summarise)',
    steps(ctx) {
      const w = writer(ctx, 'W1');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) steps.push(w.turn(n, { ...phaseTurn(n), ...(n === this.turns ? { more: { reads: ['state'] } } : {}) }));
      if (ctx.configurationName === 'H4') tunedOut(w, steps, 6, { before: { 4: [w.other('undo', 'command', { command: '/undo' })] } });
      return steps;
    },
    check(run, ctx) {
      if (!summarises(ctx.configuration)) return withJudged([{ step: null, message: 'couldn\'t judge: the property needs a configuration that summarises, and this one doesn\'t' }], 0);
      const last = readsOf(run, 'state').at(-1);
      if (!last) return withJudged([{ step: null, message: 'couldn\'t judge: the run logged no state read' }], 0);
      const got = last.answer?.maxLevel;
      if (typeof got !== 'number') return withJudged([{ step: last.step ?? null, message: `couldn't judge: the state read gave no level for the store${typeof got?.unreadable === 'string' ? ` (unreadable: ${got.unreadable})` : ''}` }], 0);
      return withJudged(got >= 3 ? [] : [{ step: last.step ?? null, message: `the store reached L${got} in ${this.turns} turns, short of L3` }], 1);
    },
  },

  W2: {
    from: null,
    turns: 70,
    property: 'reads: a store of reading-sized tool results, attachments and a paste reaches L3 by its end (the store is ready after each turn, which the driver\'s settle requires)',
    steps(ctx) {
      const w = writer(ctx, 'W2');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        const plan = readingTurn(n);
        steps.push(w.turn(n, {
          calls: plan.calls,
          rounds: plan.rounds,
          ...(plan.paste ? { size: SIZES.document } : {}),
          attach: n % 7 === 0,
          result: (k, canaryText) => ({ kind: 'prose', size: w.between(SIZES.reading), canary: canaryText }),
          ...(n === this.turns ? { more: { reads: ['state'] } } : {}),
        }));
      }
      return steps;
    },
    check(run, ctx) {
      return WORKLOADS.W1.check.call(this, run, ctx);
    },
  },

  W4: {
    from: 'checkpoint',
    turns: 4,
    property: 'thinking: no call this workload makes goes out parted from the thinking that led to it, which comes ahead of it in its message',
    steps(ctx) {
      const w = writer(ctx, 'W4');
      return Array.from({ length: this.turns }, (_, i) => w.turn(i + 1, { thinking: w.between(SIZES.call), callId: () => `t${ctx.seed}_${i + 1}` }));
    },
    check(run, ctx) {
      const own = new RegExp(`^t${ctx.seed}_\\d+$`);
      const out = [];
      let judged = 0;
      for (const r of run.records.filter((x) => x.kind === 'agent')) {
        for (const m of r.messages ?? []) {
          let since = 0;
          const parted = [];
          m.blocks.forEach((b, k) => {
            if (b.type !== 'tool_use') return;
            if (own.test(String(b.toolUseId))) {
              judged++;
              if (!m.blocks.slice(since, k).some((x) => x.type === 'thinking' || x.type === 'redacted_thinking')) parted.push(b.toolUseId);
            }
            since = k + 1;
          });
          if (parted.length) out.push({ step: r.step, message: `request ${r.id}: a call went out without its thinking (${parted.join(', ')})` });
        }
      }
      return withJudged(out, judged);
    },
  },

  W5: {
    from: 'checkpoint',
    turns: 12,
    property: 'shards: the store holds both blocks, the call and its result, of each of the workload\'s own calls, and a body larger than the message cap, stored in parts, that context-manager sends whole never goes out without its tool blocks',
    steps(ctx) {
      const w = writer(ctx, 'W5');
      const steps = [guardTurn(w, 'g')];
      for (let n = 1; n <= this.turns; n++) {
        const big = n % 2 === 0;
        const t = w.turn(n, {
          callId: () => `t${ctx.seed}_${n}`,
          result: (k, canaryText) => (big
            ? { kind: 'mixed', size: w.between(SIZES.large), width: 64, height: 48, canary: canaryText }
            : { kind: 'prose', size: w.between(SIZES.result), canary: canaryText }),
          more: { reads: ['messages'] },
        });
        if (n % 4 === 1) t.replies[0].text = `${w.c(n, 'r1')} ${prose(w.between(SIZES.largeReply), `${w.id(n)}:large`)}`;
        steps.push(t);
      }
      return steps;
    },
    check(run, ctx) {
      return toolBlocksLost(run, Array.from({ length: this.turns }, (_, i) => `t${ctx.seed}_${i + 1}`));
    },
  },

  // A call the fixture server never answers is answered with an error by agent-framework once the recipe's
  // `requestTimeoutMs` passes.
  W6: {
    from: 'checkpoint',
    turns: 12,
    property: 'tools: no request carries a mark of membrane\'s pairing repair, which would mean context-manager handed it a result without its call or a call without its result; context-manager\'s own repair marks, the designed output for the suppression it scripts, are counted beside (marks are found by their text, which the fixture\'s tool output never quotes; check 11 judges each compile\'s pairs)',
    recipe: { fixtureServer: { requestTimeoutMs: 2000 } },
    needs: { webui: true },
    steps(ctx) {
      const w = writer(ctx, 'W6');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        switch (n % 4) {
          case 0:
            steps.push(w.turn(n, { calls: 2 }));
            break;
          case 1:
            steps.push(w.turn(n, { rounds: 2, callId: () => `t${ctx.seed}_reuse_${n}` }));
            break;
          case 2:
            steps.push(w.turn(n, n === 2 ? { result: (k, canaryText) => ({ kind: 'prose', size: 400, canary: canaryText, hold: true }), more: { also: ['server didn\'t answer within'] } } : {}));
            break;
          default:
            steps.push(w.turn(n));
            steps.push(w.other(`${n}.suppress`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
        }
      }
      return steps;
    },
    // membrane 0.8.0's normalizer repairs both shapes on the wire (normalize-tool-pairs.ts), so a request that
    // reaches the stand-in shows them only as its repair marks.
    check(run, ctx) {
      const requests = run.records.filter((r) => r.kind === 'agent');
      const marks = requests.flatMap((r) => (r.messages ?? []).flatMap((m) => m.blocks.flatMap((b) => (b.repairs ?? []).map((mark) => ({ r, mark })))));
      const membrane = marks.filter((x) => x.mark.startsWith('membrane:'));
      const own = marks.length - membrane.length;
      const out = membrane.map(({ r, mark }) => ({ step: r.step, request: r.id, message: `request ${r.id} carries membrane's ${mark.slice('membrane:'.length)} repair mark, so context-manager handed it a call or result unpaired` }));
      const held = `${ctx.seed}.2`;
      const at = run.log.filter((e) => e.step === held);
      if (!at.some((e) => e.kind === 'notice' && e.peer === 'server' && e.notice === 'held')) out.push({ step: held, message: 'the fixture server held no call at this step, so the call it should hold never reached it' });
      else if (!at.some((e) => e.kind === 'ipc' && e.event?.type === 'tool:failed' && String(e.event.error ?? '').includes('didn\'t answer within'))) out.push({ step: held, message: 'the call the fixture server held never timed out at this step' });
      return withJudged(out, requests.length + 1, `${requests.length} request(s), ${membrane.length} membrane repair mark(s), ${own} of context-manager's own, and the held call's timeout`);
    },
  },

  W7: {
    from: 'checkpoint',
    turns: 21,
    property: 'failures: at each step, the summariser requests the stand-in refuses, its merges or those carrying the content it refuses, raise one off-path refusal alert each, and nothing else raises one; content the summariser refuses reaches it only in the slice it is asked to remember',
    variants: ['merges-refused', 'merges-rejected', 'fable-no-tools', 'no-tools', 'chunk-refused'],
    owns: (variant) => (['merges-refused', 'chunk-refused'].includes(variant) ? [{ check: 1, what: 'refusal-offpath' }] : []),
    fromEmpty: (variant) => variant === 'fable-no-tools' || variant === 'no-tools',
    standin: (variant) => ({ refuseMerges: variant === 'merges-refused', rejectMerges: variant === 'merges-rejected', refuseContent: variant === 'chunk-refused' }),
    recipe: (variant) => ({
      ...(variant === 'fable-no-tools' || variant === 'no-tools' ? { agent: { allowedTools: [] } } : {}),
      ...(variant === 'fable-no-tools' ? { agent: { allowedTools: [], strategy: { compressionModel: 'claude-fable-5-1' } } } : {}),
    }),
    steps(ctx) {
      const w = writer(ctx, 'W7');
      const noTools = ['fable-no-tools', 'no-tools'].includes(ctx.variant);
      const turns = noTools ? 32 : this.turns;
      if (ctx.configurationName === 'H2') {
        const rounds = [];
        for (let n = 1; n <= turns; n++) {
          const plan = phaseTurn(n);
          for (let k = 0; plan.calls && k < (plan.rounds ?? 1); k++) rounds.push({ calls: Array.from({ length: plan.calls }, () => ({ kind: 'prose', size: w.between(SIZES.result) })) });
        }
        return [subagentTurn(w, ctx, 1, rounds)];
      }
      const steps = [];
      for (let n = 1; n <= turns; n++) {
        if (noTools) steps.push(w.turn(n, { calls: 0, size: SIZES.reading }));
        else if (ctx.variant === 'chunk-refused') steps.push(w.turn(n, { ...phaseTurn(n), ...(n === REFUSED_TURN ? { mark: REFUSED_CONTENT } : {}) }));
        else steps.push(w.turn(n, ctx.variant === 'merges-refused' ? phaseTurn(n) : {}));
      }
      return steps;
    },
    check(run, ctx) {
      const out = [];
      const calls = run.records.filter((r) => r.kind === 'summariser');
      if (ctx.variant === 'merges-refused') {
        const refused = calls.filter((r) => r.answer?.shape === 'refusal');
        const alerts = refusalAlerts(run, refused, 'merge(s)');
        if (!refused.length) return withJudged([{ step: null, message: 'couldn\'t judge: the stand-in refused no merge' }, ...alerts], 0);
        return withJudged(alerts, refused.length);
      }
      if (ctx.variant === 'chunk-refused') {
        const carrying = calls.filter((r) => r.carried);
        const alerts = refusalAlerts(run, calls.filter((r) => r.answer?.shape === 'refusal'), 'summariser request(s)');
        if (!carrying.length) return withJudged([{ step: null, message: 'couldn\'t judge: no summariser request carried the refused content' }, ...alerts], 0);
        const unplaced = carrying.filter((r) => r.carried === 'unplaced');
        if (unplaced.length) return withJudged([{ step: unplaced[0].step, message: `couldn't judge: ${unplaced.length} L1 request(s) carried the refused content with no single notice opening the slice they asked the summariser to remember, so where it sat can't be read` }, ...alerts], 0);
        const byStep = new Map();
        for (const r of carrying.filter((x) => x.carried !== 'slice')) {
          const at = byStep.get(r.step) ?? { ahead: 0, merge: 0 };
          at[r.carried]++;
          byStep.set(r.step, at);
        }
        for (const [step, { ahead, merge }] of byStep) {
          out.push({ step, message: [
            ahead ? `${ahead} L1 request(s) carried the content the summariser refuses ahead of the slice they asked it to remember` : null,
            merge ? `${merge} merge request(s) carried it` : null,
          ].filter(Boolean).join(', and ') });
        }
        out.push(...alerts);
        return withJudged(out, carrying.length);
      }
      return judgedBy(out, 1);
    },
  },

  W8: {
    from: 'checkpoint',
    turns: 16,
    property: 'tight: with the budget lowered to the edge and restored, a configuration that compiled every turn before the lowering does so again within two steps of the restore',
    variants: ['enforced', 'unenforced'],
    recipe: (variant) => ({ agent: { strategy: { enforceBudget: variant === 'enforced' } } }),
    steps(ctx) {
      const w = writer(ctx, 'W8');
      const underCut = (n) => n >= 5 && n <= 14;
      const budget = ctx.budget;
      const cut = (step, tokens) => w.other(`${step}.budget`, 'panel', { op: 'settings-update', params: { contextBudgetTokens: tokens, immediate: true }, edge: { reserve: ctx.reserve } });
      if (ctx.configurationName === 'H4') {
        const forReader = (step, tokens) => { const c = cut(step, tokens); return { ...c, params: { ...c.params, agent: 'Subconscious' } }; };
        const steps = [];
        tunedOut(w, steps, this.turns, { mayFail: underCut, before: { 5: [forReader('h5', Math.round(budget * 0.6))], 9: [forReader('h9', edge(ctx))], 13: [forReader('h13', budget)] } });
        return steps;
      }
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 5) steps.push(cut(n, Math.round(budget * 0.6)));
        if (n === 9) steps.push(cut(n, edge(ctx)));
        if (n === 13) steps.push(cut(n, budget));
        steps.push(w.turn(n, underCut(n) ? { more: { mayFail: true } } : {}));
      }
      return steps;
    },
    check(run, ctx) {
      if (ctx.configurationName === 'H4') return restoredWithin(run, 'Subconscious', (k) => `${ctx.seed}.h${k}`, 'the reader\'s turn');
      return restoredWithin(run, FIXTURE_AGENT, (n) => `${ctx.seed}.${n}`, 'step');
    },
  },

  W9: {
    from: 'checkpoint',
    turns: 20,
    property: 'lifecycle: a store closed and reopened compiles the request it compiled before it closed (check 12, on dry compiles either side of the restart)',
    needs: { webui: true, subagents: true },
    steps(ctx) {
      const w = writer(ctx, 'W9');
      const { budget, adaptive, folding, native } = ctx;
      const dry = { op: 'dry-compile', budget: { maxTokens: budget, reserveForResponse: ctx.reserve } };
      const panel = (step, op, params) => w.other(step, 'panel', { op, params });
      const command = (step, text, more = {}) => w.other(step, 'command', { command: text, ...more });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) for (const k of ['a', 'b', 'c']) steps.push(w.turn(`9${k}`, { calls: 0, size: SIZES.reading }));
        if (n === 16) steps.push({ ...guardTurn(w, '16g'), namedAnywhere: true });
        steps.push(w.turn(n, { ...(n === 18 && native ? { arrival: { after: 1 } } : {}), ...(n >= 16 ? { more: { namedAnywhere: true } } : {}) }));
        switch (n) {
          case 2:
            if (adaptive) for (const k of ['h', 'i', 'j']) steps.push({ ...w.turn(`2${k}`, { calls: 0 }), text: markdownPaste(ctx.seed, `2${k}`, 3000) });
            break;
          case 3:
            steps.push(w.other('3.reopen', 'restart', { reloadCheck: true }));
            break;
          case 4:
            steps.push(panel(`4.pins`, 'pins', {}));
            break;
          case 5:
            steps.push({ ...panel('5.tail', 'settings-update', { tailTokens: 15000 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            if (folding === 'kv-stable') steps.push(panel('5.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 10000 }));
            break;
          case 6:
            steps.push(w.other('6.witnessed', 'restart', { agent: { strategy: { witnessedBeforeSequence: { sequenceOf: w.c(6, 'r2') }, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.' } } }));
            break;
          case 7: {
            const fork = w.turn('7f', { calls: 0 });
            const marker = `[[fork:${ctx.seed}]]`;
            steps.push({
              ...fork,
              canaries: [...fork.canaries, w.c('7f', 'task'), w.c('7f', 'f1')],
              replies: [
                { text: `${w.c('7f', 'r1')} forking`, calls: [{ name: 'subagent--fork', input: { name: `fork-${ctx.seed}`, task: `${w.c('7f', 'task')} ${prose(300, `${w.id('7f')}:task`)}`, systemPrompt: `${marker} You are the fork.`, sync: true } }] },
                { text: `${w.c('7f', 'r2')} ${prose(300, `${w.id('7f')}:r2`)}` },
              ],
              sub: { marker, canaries: [w.c('7f', 'task')], replies: [{ text: `${w.c('7f', 'f1')} ${prose(400, `${w.id('7f')}:f1`)}` }] },
            });
            break;
          }
          case 8:
            steps.push(w.other('8.prompt', 'restart', { agent: { systemPrompt: 'You are the strategy fixture\'s agent, with a prompt an operator changed.' } }));
            if (folding === 'kv-stable') steps.push(panel('8.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 50000 }));
            break;
          case 10:
            steps.push({ ...panel('10.pin', 'pin-add', { firstMessageId: { canary: w.c(1, 'in') }, lastMessageId: { canary: w.c(1, 'r2') }, name: `w9-${ctx.seed}` }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 11:
            steps.push({ ...panel('11.pin-level', 'pin-add', { firstMessageId: { canary: w.c(2, 'in') }, lastMessageId: { canary: w.c(2, 'r2') }, level: 1 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 13:
            steps.push(command('13.undo', '/undo', { reads: [dry] }));
            steps.push(command('13.redo', '/redo', { reads: [dry] }));
            break;
          case 14:
            if (summarises(ctx.configuration)) steps.push(panel('14.unpin', 'pin-remove', { pinId: { pin: `w9-${ctx.seed}` } }));
            break;
          case 15:
            steps.push(command('15.newtopic', '/newtopic A new topic.', summarises(ctx.configuration) ? {} : { expect: 'failed' }));
            break;
          case 17:
            steps.push(w.other('17.suppress', 'suppress', { messages: [{ canary: w.c(16, 'in') }] }));
            break;
          case 19:
            steps.push(w.other('19.head', 'restart', { agent: { strategy: { headWindowTokens: 8000 } } }));
            // The record rolled back to turn 18's last reply, as an operator's /branchto does it: turn 19's rows leave
            // it, and turn 20 compiles from what's left. Last, since no later step names a turn-19 message.
            steps.push(command('19.branchto', `/branchto ${w.c(18, 'r2')}`, { reads: [dry] }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    check: () => judgedBy([], 12),
  },

  W11: {
    from: 'checkpoint',
    turns: 14,
    property: 'protections: pins and document marks an operator puts on older messages stay placed through a budget cut and a restore, as context-manager\'s pins promise (a compile that can\'t hold them refuses instead), and the pins invariant holds each compile to them',
    steps(ctx) {
      const w = writer(ctx, 'W11');
      const budget = ctx.budget;
      const pin = (step, first, last, opts = {}) => w.other(step, 'panel', { op: 'pin-add', params: { firstMessageId: first, lastMessageId: last, ...opts } });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) steps.push(w.other('9.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: Math.round(budget * 0.35), immediate: true }, edge: { reserve: ctx.reserve } }));
        if (n === 13) steps.push(w.other('13.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: budget, immediate: true } }));
        const failFirst = n === 2 && ctx.configurationName === 'H1';
        const t = w.turn(n, { more: { ...(n >= 9 && n < 13 ? { mayFail: true } : {}), ...(failFirst ? { retries: true } : {}) } });
        if (failFirst) t.replies = [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, ...t.replies];
        steps.push(t);
        switch (n) {
          case 2:
            steps.push(pin('2.level0', { storeAt: 0.10 }, { storeAt: 0.10 }, { level: 0 }));
            steps.push(pin('2.max0', { storeAt: 0.14 }, { storeAt: 0.14 }, { maxLevel: 0 }));
            break;
          case 3:
            steps.push(pin('3.result', { storeAt: 0.30, withBlock: 'tool_result' }, { storeAt: 0.30, withBlock: 'tool_result' }));
            break;
          case 4:
            steps.push(pin('4.max2', { storeAt: 0.45 }, { storeAt: 0.45 }, { maxLevel: 2 }));
            steps.push(pin('4.level1', { storeAt: 0.55 }, { storeAt: 0.55 }, { level: 1 }));
            break;
          case 8:
            steps.push(pin('8.document', { storeAt: 0.20 }, { storeAt: 0.20 }, { kind: 'document', maxLevel: 1 }));
            steps.push(pin('8.level1', { canary: w.c(1, 'in') }, { canary: w.c(1, 'r2') }, { level: 1 }));
            break;
          case 12:
          case 14:
            steps.push(w.other(`${n}.pins`, 'panel', { op: 'pins', params: {} }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    // context-manager 0.24.0's README: "`listPins` and `unpin` manage the pins", and "A compile whose budget can't
    // hold the raw pins beside the rest refuses with `OverBudgetError`".
    check(run, ctx) {
      const panels = entries(run, 'panel');
      const pinsAt = (step) => panels.filter((e) => e.step === `${ctx.seed}.${step}`).at(-1)?.response?.data?.pins;
      const placed = pinsAt('8.level1') ?? [];
      if (!placed.length) return withJudged([{ step: `${ctx.seed}.8.level1`, message: 'couldn\'t judge: the panel listed no pin once the last was added' }], 0);
      const named = (p) => `${p.kind}${p.level !== undefined ? ` at L${p.level}` : ''}${p.maxLevel !== undefined ? ` to L${p.maxLevel}` : ''}`;
      const protection = (p) => JSON.stringify([p.kind, p.level, p.maxLevel, p.firstMessageId, p.lastMessageId]);
      const out = [];
      let judged = 0;
      let before = [];
      for (const step of ['2.level0', '2.max0', '3.result', '4.max2', '4.level1', '8.document', '8.level1']) {
        const listed = pinsAt(step);
        if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s answer to this pin holds no list' }); before = null; continue; }
        if (before) {
          judged++;
          const gone = before.filter((p) => !listed.some((q) => q.id === p.id));
          const added = listed.filter((p) => !before.some((q) => q.id === p.id));
          if (gone.length || added.length !== 1) out.push({ step: `${ctx.seed}.${step}`, message: `adding this pin listed ${added.length} new pin(s) or mark(s), and ${gone.length} listed before it are gone${gone.length ? `: ${gone.map(named).join(', ')}` : ''}` });
        }
        before = listed;
      }
      for (const step of ['12.pins', '14.pins']) {
        const listed = pinsAt(step);
        if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s pins answer holds no list' }); continue; }
        judged += placed.length;
        const now = new Map(listed.map((p) => [p.id, p]));
        const gone = placed.filter((p) => !now.has(p.id));
        const changed = placed.filter((p) => now.has(p.id) && protection(now.get(p.id)) !== protection(p));
        if (gone.length) out.push({ step: `${ctx.seed}.${step}`, message: `${gone.length} of the ${placed.length} pins and marks placed by step 8 are gone: ${gone.map(named).join(', ')}` });
        if (changed.length) out.push({ step: `${ctx.seed}.${step}`, message: `${changed.length} of the ${placed.length} pins and marks placed by step 8 no longer protect what they did: ${changed.map((p) => `${named(p)} is now ${named(now.get(p.id))}${now.get(p.id).firstMessageId !== p.firstMessageId || now.get(p.id).lastMessageId !== p.lastMessageId ? ' over another range' : ''}`).join(', ')}` });
      }
      return withJudged(out, judged);
    },
  },

  W12: {
    from: null,
    compresses: false,
    owns: [{ check: 1, what: 'instructions-unavailable' }, { check: 1, what: 'instructions-unavailable-clear' }],
    property: 'wake: each scripted event meets the fate its rule gives it: one its rule wakes starts a request whose last message carries it; one its rule holds back starts none at its step, and the next request carries it; a batch starts one request whose last message carries every event in it and the gate\'s line counting them; a batch a judge rule holds goes to the reply judge in one request listing it, answered as its mark gives, and one it lets go by starts none, the next request carrying it; a suppressed message reaches no request, and the one the suppression review flags none before the review\'s notice, which starts one request carrying it and not the other; an onboarding offer starts a request carrying the message that brought it and the offer\'s notice; a message naming lessons starts a request whose newest retrieved lessons are those it names less any the relevance filter drops, the one naming one lesson bringing no relevance request and the one naming four bringing one that lists them all; a batch already answered starts one turn at most; a sleep\'s end, skip_reply\'s wake, a watched file\'s change, a reminder and the heartbeat\'s tick each start a turn; the host\'s notice reaches the next request; a message opening with a notice tag reaches its request with the tag marked, not as a notice; console input starts a turn past a suppress rule that hides a channel message carrying the same mark; the third console message brings the one session naming request; and the agent looks at a tool the built-in settings toolset lists',
    recipe: (variant, capabilities) => ({ modules: { wake: { policies: capabilities === undefined ? W12_RULES : w12Rules(capable(capabilities)), default: 'always' } }, privileged: [W12_PRIVILEGED], ...(capabilities !== undefined && capable(capabilities)('onboarding') ? { fixtureOntology: W12_ONTOLOGY } : {}) }),
    steps(ctx) {
      const w = writer(ctx, 'W12');
      const g = gateWriter(w);
      const has = capable(ctx.capabilities);
      const suppression = has('suppression');
      const act = (tool, args) => [{ name: 'toolsets--act', input: { tool, args } }];
      const lesson = (k) => w.c('lessons', `lesson-${k}`);
      return [
        settingsTurn(w, 'set'),
        g.deliver('always', 'w12-always', 'wake'),
        g.deliver('defer', 'w12-defer', 'none'),
        g.deliver('debounce.a', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.deliver('debounce.b', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.fire('debounce.fire', 61_000, ['debounce.a', 'debounce.b']),
        g.deliver('answered.x', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.deliver('answered.y', 'w12-always', 'wake'),
        g.fire('answered.fire', 61_000, ['answered.x'], { answered: true }),
        g.deliver('rate.1', 'w12-rate', 'wake'),
        g.deliver('rate.2', 'w12-rate', 'none'),
        g.deliver('sample.1', 'w12-sample', 'none'),
        g.deliver('sample.2', 'w12-sample', 'wake'),
        g.deliver('judge.a1', 'w12-judge', 'none', { wake: true }),
        g.deliver('judge.a2', 'w12-judge', 'none'),
        g.judged('judge.yes', 61_000, 'w12-judge', ['judge.a1', 'judge.a2'], 'reply'),
        g.deliver('judge.b1', 'w12-judge', 'none'),
        g.deliver('judge.b2', 'w12-judge', 'none'),
        g.judged('judge.no', 61_000, 'w12-judge', ['judge.b1', 'judge.b2'], 'wait'),
        ...(suppression ? [
          g.deliver('mute.1', 'w12-mute', 'hidden'),
          g.deliver('mute.2', 'w12-mute', 'hidden', { flag: true, until: 'review' }),
        ] : [g.absent('suppression')]),
        ...(has('onboarding') ? [
          g.deliver('onboard.offer', 'w12-quiet', 'wake', { tags: ['chat:addressed'], quiet: true, offered: true, rule: 'w12-quiet, which names no server, channel or tag', notice: 'wake onboarding', calls: act('wake_accept_suggestions', { server: 'fixture' }) }),
          g.deliver('onboard.after', 'w12-quiet', 'wake', { tags: ['chat:addressed', 'w12:ping'], quiet: true, rule: 'suggested:fixture:1, once accepted' }),
          g.deliver('decline.offer', 'w12-other', 'wake', { server: 'quiet', tags: ['chat:addressed'], quiet: true, offered: true, rule: 'w12-quiet, for another server', notice: 'wake onboarding', calls: act('wake_decline', { server: 'quiet' }) }),
          g.deliver('decline.after', 'w12-other', 'none', { server: 'quiet', tags: ['chat:addressed'], quiet: true, rule: 'w12-quiet, the offer declined' }),
        ] : [g.absent('onboarding')]),
        g.act('sleep.go', [{ name: 'sleep', input: { seconds: 3600 } }], { ends: true }),
        g.deliver('sleep.ambient', 'w12-always', 'none', { rule: 'asleep' }),
        g.deliver('sleep.privileged', 'w12-always', 'wake', { participant: W12_PRIVILEGED, calls: [{ name: 'sleep', input: { seconds: 120 } }], ends: true }),
        g.timed('sleep.end', 121_000, 'the sleep\'s end', 'sleep.privileged'),
        g.act('skip.go', [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }], { ends: true }),
        g.timed('skip.wake', 121_000, 'skip_reply\'s wake_in_seconds', 'skip.go'),
        g.act('rules.add', [{ name: 'toolsets--act', input: { tool: 'wake_add_rule', args: { name: 'w12-own', match: { channel: '*w12-own' }, behavior: 'defer' } } }]),
        g.deliver('own.1', 'w12-own', 'none', { rule: 'w12-own' }),
        g.act('rules.remove', [{ name: 'toolsets--act', input: { tool: 'wake_remove_rule', args: { name: 'w12-own' } } }, { name: 'toolsets--act', input: { tool: 'gate_status', args: {} } }]),
        g.deliver('own.2', 'w12-own', 'wake', { rule: 'default, once w12-own is removed' }),
        g.act('mode.set', [{ name: 'channel-mode--set_channel_mode', input: { channelId: 'w12-mode', mode: 'debounced', debounceMs: 60_000 } }]),
        g.deliver('mode.a', 'w12-mode', 'none', { tags: ['chat:ambient'], rule: 'set_channel_mode\'s debounce' }),
        g.deliver('mode.b', 'w12-mode', 'none', { tags: ['chat:ambient'], rule: 'set_channel_mode\'s debounce' }),
        g.fire('mode.fire', 61_000, ['mode.a', 'mode.b'], { addressed: false }),
        g.file('ws.note', 'watched/w12-note.txt', { watched: true, rule: 'the watched mount\'s change', also: ['w12-note'] }),
        g.act('ws.config', [{ name: 'workspace--write', input: { path: '_config/gate.json', content: `${JSON.stringify({ policies: w12Rules(has).map((r) => (r.name === 'w12-defer' ? { ...r, behavior: 'always' } : r)), default: 'always' }, null, 2)}\n` } }], { then: [[{ name: 'workspace--materialize', input: { path: '_config/gate.json' } }]] }),
        { id: w.id('ws.later'), segment: 'W12', kind: 'advance', ms: 2_000 },
        g.deliver('defer.after', 'w12-defer', 'wake', { rule: 'w12-defer, made always in gate.json' }),
        g.act('lessons', LESSONS.map((k) => ({ name: 'lessons--create', input: { content: `${lesson(k)}${k === STALE_LESSON ? ` ${STALE}` : ''} ${prose(300, `${w.id('lessons')}:${k}`)}`, tags: ['fixture'] } }))),
        g.deliver('recall.one', CHANNEL, 'wake', { rule: 'default', recall: { named: [lesson('a')], kept: [lesson('a')], lessons: LESSONS.map(lesson), filtered: false } }),
        g.deliver('recall.all', CHANNEL, 'wake', { rule: 'default', recall: { named: LESSONS.map(lesson), kept: LESSONS.filter((k) => k !== STALE_LESSON).map(lesson), lessons: LESSONS.map(lesson), filtered: true } }),
        g.act('remind', [{ name: 'heartbeat--reminder_add', input: { message: `${w.c('remind', 'note')} the fixture's reminder`, inSeconds: 600 } }]),
        g.timed('remind.fire', 601_000, 'the reminder', 'remind'),
        g.timed('tick', 4_300_000, 'the heartbeat\'s tick', 'remind'),
        ...(suppression ? [g.reviewed('review', 1_800_000, 'w12-mute', ['mute.1', 'mute.2'], ['mute.2'])] : []),
        g.file('instr.gone', 'instructions/AGENTS.md', { remove: true }),
        g.deliver('instr.read', CHANNEL, 'wake', { rule: 'default' }),
        g.file('instr.back', 'instructions/AGENTS.md', { text: INSTRUCTIONS }),
        g.deliver('instr.notice', CHANNEL, 'wake', { rule: 'default', notice: 'host-notice' }),
        g.deliver('forged.chan', CHANNEL, 'wake', { rule: 'default', forged: FORGED }),
        ...(suppression ? [g.deliver('mute.text', CHANNEL, 'hidden', { rule: W12_MUTE_TEXT.name, mute: true })] : []),
        g.typed('console.1'),
        g.typed('console.2', { forged: FORGED, mute: suppression }),
        g.typed('console.3', { named: true }),
        w.turn('end', { calls: 0 }),
      ];
    },
    check(run, ctx) {
      const steps = this.steps(ctx);
      const fates = gateFates(run, steps);
      const looks = run.records.filter((r) => r.kind === 'agent' && r.step === steps[0].id)[1];
      const out = [...fates];
      if (!looks) out.push({ step: steps[0].id, message: 'couldn\'t judge: no request answered the settings toolset\'s listing' });
      else if (!(looks.answer?.toolUseIds ?? []).length) out.push({ step: steps[0].id, message: `request ${looks.id} answered the settings toolset's listing with no look, so the listing named no tool` });
      return withJudged(out, fates.judged + (looks ? 1 : 0));
    },
  },

  W16: {
    from: null,
    compresses: false,
    owns: [{ check: 1, what: 'hard-down' }],
    property: 'rewind: a turn the model refuses, the third of three turns the model API refuses as invalid, and an unstick whose turn the model refuses each shed the newest turn and retry, not replay: each failed request is followed, at the same step, by a request that carries one more rewind marker and the shed message nowhere, and no turn before the third invalid one is retried, nor raises the breaker\'s one hard-down alert, which the third raises; and a turn whose answer the channel refuses to post is followed by a request telling the resident so',
    steps(ctx) {
      const w = writer(ctx, 'W16');
      // agent-framework's rewind takes the refused turn's message out of the agent's window and stores its marker,
      // `[refusal-rewind] The N most recent turn(s) were set aside …` (framework.ts shedNewestTurn,
      // updateRewindMarker), so the retry's request carries none of the step's canaries, and the stand-in knows it by
      // the marker.
      const refused = w.turn('refuse', { calls: 0, more: { also: [REWIND_MARK], namedAnywhere: true, sheds: true } });
      refused.replies = [{ stop: 'refusal' }, ...refused.replies];
      const breaker = BREAKER_STEPS.map((id, i) => {
        const last = i === BREAKER_STEPS.length - 1;
        const t = w.turn(id, { calls: 0, more: { mayFail: true, also: [REWIND_MARK], namedAnywhere: true, ...(last ? { sheds: true } : {}) } });
        const [reply] = t.replies;
        t.replies = [{ error: INVALID }, ...(last ? [reply] : [])];
        if (!last) t.spare = [reply];
        return t;
      });
      // agent-framework's `unstick` host command queues a turn on the agent's context as it stands, with no message of
      // its own, and sheds only when the model refuses that turn (framework.ts handleHostCommand, the refusal's
      // `forced` rewind). The stand-in knows the turn by a rewind marker an earlier step left, and refuses it once.
      const unstick = w.other('unstick', 'host', {
        host: { command: 'unstick', channelId: CHANNEL }, inputs: [], canaries: [], also: [REWIND_MARK], namedAnywhere: true,
        replies: [{ stop: 'refusal' }, { text: `${w.c('unstick', 'r1')} ${prose(w.between(SIZES.reply), `${w.id('unstick')}:r1`)}` }],
      });
      const failed = w.turn('failpub', { calls: 0, more: { failsPublish: true } });
      failed.replies = [{ ...failed.replies[0], text: `${failed.replies[0].text} ${FAIL_PUBLISH}` }];
      return [w.turn(1, { calls: 0 }), refused, w.turn('after', { calls: 0 }), ...breaker, unstick, failed, w.turn('told', { calls: 0 })];
    },
    check(run, ctx) {
      const out = [];
      let judged = 0;
      const at = (id) => run.records.filter((r) => r.step === `${ctx.seed}.${id}` && (r.kind === 'unclassified' || (r.kind === 'agent' && (r.agent ?? 'primary') === 'primary')));
      const markers = (r) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => b.notice === REWIND_NOTICE).length;
      const rewound = (id, failed, last, input = canary(ctx.seed, id, 'in')) => {
        const step = `${ctx.seed}.${id}`;
        const retry = at(id).find((r) => r.seq > last.seq);
        if (!retry) return out.push({ step, message: `couldn't judge: no request at this step followed the ${failed} ${last.id}` });
        judged++;
        if (markers(retry) !== markers(last) + 1) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, carries ${markers(retry)} rewind marker(s) where ${last.id} carried ${markers(last)}, and the rewind adds one` });
        if ((retry.messages ?? []).some((m) => (m.blocks ?? []).some((b) => (b.canaries ?? []).includes(input)))) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, still carries the shed turn's message ${input}: it was replayed, not shed` });
      };
      const refusals = at('refuse').filter((r) => r.answer?.stop === 'refusal');
      if (!refusals.length) out.push({ step: `${ctx.seed}.refuse`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
      else {
        if (refusals.length > 1) out.push({ step: `${ctx.seed}.refuse`, message: `${refusals.length} requests at this step were answered with a refusal, where the stand-in refuses once: the refusal was replayed` });
        rewound('refuse', 'refused', refusals.at(-1));
      }
      BREAKER_STEPS.forEach((id, i) => {
        const step = `${ctx.seed}.${id}`;
        const mine = at(id);
        const failed = mine.find((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status);
        if (!failed) return out.push({ step, message: `couldn't judge: no request at this step was answered with the stand-in's ${INVALID.status}` });
        if (i === BREAKER_STEPS.length - 1) return rewound(id, 'failed', failed);
        judged++;
        const next = mine.find((r) => r.seq > failed.seq);
        if (next) out.push({ step, message: `request ${next.id} followed the failed ${failed.id} at this step, where the breaker waits for the third failure in a row` });
      });
      const tripped = `${ctx.seed}.${BREAKER_STEPS.at(-1)}`;
      const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'hard-down')
        .reduce((m, e) => m.set(e.step, (m.get(e.step) ?? 0) + 1), new Map());
      const thirdFailed = at(BREAKER_STEPS.at(-1)).some((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status);
      if (thirdFailed) judged++;
      for (const step of new Set([...alerts.keys(), ...(thirdFailed ? [tripped] : [])])) {
        const n = alerts.get(step) ?? 0;
        if (step === tripped && n !== 1) out.push({ step, message: `${n} hard-down alert(s) at this step, where the breaker's trip at the third failure in a row raises one` });
        if (step !== tripped) out.push({ step, message: `${n} hard-down alert(s) at this step, where the breaker raises its one at the third failure in a row, ${tripped}` });
      }
      const unstuck = at('unstick').filter((r) => r.answer?.stop === 'refusal');
      if (!unstuck.length) out.push({ step: `${ctx.seed}.unstick`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
      else rewound('unstick', 'refused', unstuck.at(-1), canary(ctx.seed, BREAKER_STEPS.at(-1), 'r1'));
      const failpub = `${ctx.seed}.failpub`;
      const published = at('failpub').at(-1);
      const refusedThere = run.log.some((e) => e.kind === 'undelivered' && e.step === failpub && !/\bno locus\b/.test(e.reason ?? ''));
      const told = published && run.records.find((r) => r.seq > published.seq && r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
      const notices = (r) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => b.notice === SEND_FAILED_NOTICE).length;
      if (!published) out.push({ step: failpub, message: 'couldn\'t judge: no request at this step' });
      else if (!refusedThere) out.push({ step: failpub, message: 'couldn\'t judge: the driver heard no route failure at this step other than one with no locus, so nothing for a later request to tell of' });
      else if (!told) out.push({ step: failpub, message: `couldn't judge: no request followed ${published.id}, at whose step the driver heard a route failure other than one with no locus` });
      else {
        judged++;
        if (notices(told) !== notices(published) + 1) out.push({ step: told.step, message: `request ${told.id}, the next after ${published.id}, at whose step the driver heard a route failure other than one with no locus, carries ${notices(told)} [${SEND_FAILED_NOTICE}] notice(s) where ${published.id} carried ${notices(published)}, and agent-framework adds one for such a failure of a reply routed by its turn` });
      }
      return withJudged(out, judged);
    },
  },
};

// agent-framework's rewind marker opens with its tag (notice-tags.ts NOTICE_TAG.refusalRewind) and the count of turns
// set aside (framework.ts updateRewindMarker), the same at 0.33.0 and on its main.
const REWIND_NOTICE = 'refusal-rewind';
const REWIND_MARK = `[${REWIND_NOTICE}] The `;
// membrane classifies a 400 as `invalid_request`, not retryable, unless its text reads as an account refusal or a
// context overflow (types/errors.ts classifyByStatus, 0.8.0), and agent-framework's breaker sheds on three such
// failures in a row (framework.ts noteInferenceExhausted, inferenceFailureEscalationThreshold, shedMayHelp).
const INVALID = { status: 400, type: 'invalid_request_error', message: 'stand-in: an invalid request, scripted to fail' };
const BREAKER_STEPS = ['break.1', 'break.2', 'break.3'];
const FAIL_PUBLISH = '[[fail-publish]]';
// agent-framework tells the resident of a publish the channel refused in its next request (framework.ts onRouteFailure,
// NOTICE_TAG.discordSendFailed).
const SEND_FAILED_NOTICE = 'discord-send-failed';

function refusalAlerts(run, refused, noun) {
  const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'refusal-offpath');
  const count = (list) => list.reduce((m, x) => m.set(x.step, (m.get(x.step) ?? 0) + 1), new Map());
  const byStep = count(refused);
  const alertsBy = count(alerts);
  const out = [];
  for (const step of new Set([...byStep.keys(), ...alertsBy.keys()])) {
    const n = byStep.get(step) ?? 0;
    const a = alertsBy.get(step) ?? 0;
    if (n !== a) out.push({ step, message: `${n} refused ${noun} at this step raised ${a} off-path refusal alert(s), where each raises one and nothing else does` });
  }
  return out;
}

function restoredWithin(run, agent, stepOf, noun) {
  const firstByStep = new Map();
  for (const a of assemblies(run.log, agent)) if (!firstByStep.has(a.step)) firstByStep.set(a.step, a);
  const outcome = (n) => firstByStep.get(stepOf(n))?.outcome ?? 'no request';
  const before = [1, 2, 3, 4].filter((n) => outcome(n) !== 'compiled');
  if (before.length) return withJudged([{ step: stepOf(before[0]), message: `couldn't judge the restore: ${before.map((n) => `${noun} ${n} ${outcome(n)}`).join(', ')}, before the budget was lowered` }], 0);
  return withJudged([15, 16].filter((n) => outcome(n) !== 'compiled').map((n) => ({ step: stepOf(n), message: `${noun} ${n}: ${outcome(n)} ${n - 13} turn(s) after the budget was restored` })), 2);
}

export function toolBlocksLost(run, calls = []) {
  const reads = readsOf(run, 'messages');
  const failed = reads.find((read) => !Array.isArray(read.answer ?? []));
  if (failed) return withJudged([{ step: failed.step ?? null, message: `couldn't judge: the store's messages couldn't be read${isUnreadable(failed.answer) ? ` (${failed.answer.unreadable})` : ''}` }], 0);
  const toolIds = new Map();
  const groupOf = new Map();
  for (const m of reads.flatMap((read) => read.answer ?? [])) {
    if (!groupOf.has(m.id)) groupOf.set(m.id, m.bodyGroupId ?? m.id);
    if (!m.bodyGroupId) continue;
    const ids = toolIds.get(m.bodyGroupId) ?? new Set();
    for (const b of m.blocks) if (b.type === 'tool_use' || b.type === 'tool_result') ids.add(`${b.type}:${b.id ?? b.toolUseId}`);
    if (ids.size) toolIds.set(m.bodyGroupId, ids);
  }
  const paired = requestPairs(run.records, run.log, FIXTURE_AGENT);
  if (!paired) return withJudged([{ step: null, message: 'couldn\'t judge: the log holds no request compile line to pair with the requests' }], 0);
  const out = [];
  let judged = calls.length;
  const stored = new Set(reads.flatMap((read) => read.answer ?? []).flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => `${b.type}:${b.id ?? b.toolUseId}`));
  const unstored = calls.flatMap((id) => [`tool_use:${id}`, `tool_result:${id}`]).filter((key) => !stored.has(key));
  if (unstored.length) out.push({ step: null, message: `the store holds none of these blocks of the workload's calls: ${unstored.join(', ')}` });
  for (const { line, request } of paired.pairs) {
    const sent = new Set(blocksOf(request).filter((x) => x.b.type === 'tool_use' || x.b.type === 'tool_result').map((x) => `${x.b.type}:${x.b.toolUseId}`));
    const whole = new Set((line.messages ?? []).flatMap((m) => m.sources ?? []).filter((s) => /^r:[^!]+$/.test(s)).map((s) => groupOf.get(s.slice(2))).filter(Boolean));
    for (const key of whole) {
      if (!toolIds.has(key)) continue;
      judged++;
      const lost = [...toolIds.get(key)].filter((id) => !sent.has(id));
      if (lost.length) out.push({ step: request.step, message: `request ${request.id}: ${key} went out whole but without its tool blocks ${[...new Set(lost)].join(', ')}` });
    }
  }
  return withJudged(out, judged);
}

export const RUNS = [
  'H1/continuation', 'H3/continuation',
  'H1/W1', 'H4/W1',
  'C3h/W2', 'H1/W2', 'H1b/W2',
  'H3/W4',
  'C5h/W5',
  'C8h/W6',
  'C3h/W7/merges-refused', 'C3h/W7/fable-no-tools', 'C3h/W7/no-tools',
  'H1/W7/merges-refused', 'H1/W7/merges-rejected', 'H2/W7/merges-refused', 'H1/W7/chunk-refused',
  'C3h/W8/unenforced', 'C6h/W8/enforced', 'H1/W8/enforced', 'H4/W8/unenforced',
  'H3/W9', 'C3h/W9', 'C6h/W9', 'H1/W9',
  'C6h/W11', 'H1/W11',
  'P1/continuation', 'P2/continuation',
  'P3/continuation', 'P4/continuation',
  'P5/continuation',
  'H5/W12',
  'H1r/W16',
];

export function seedOf(id) {
  return 100 + (hash32(id) % 900000);
}

const merge = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

// The time between a checkpoint's end and the run that starts from it (run.mjs), and between a history a run builds
// itself and the workload that continues it.
export const CHECKPOINT_GAP_MS = 24 * 60 * 60_000;

export function runOf(id, configurations, facts, { prefixTurns = {} } = {}) {
  const [configName, workloadName, variant = null] = id.split('/');
  const base = configurations[configName];
  const workload = WORKLOADS[workloadName];
  if (!base || !workload || (variant !== null && !(workload.variants ?? []).includes(variant))) throw new Error(`no run ${id}: no such configuration, workload or variant`);
  const recipe = typeof workload.recipe === 'function' ? workload.recipe(variant, facts.capabilities) : workload.recipe ?? {};
  const modules = {
    ...(workload.needs?.webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    ...(workload.needs?.subagents ? { subagents: true } : {}),
  };
  const configuration = merge(merge(base, Object.keys(modules).length ? { modules } : {}), recipe);
  const strategy = configuration.agent?.strategy ?? {};
  const adaptive = strategy.type !== 'passthrough' && strategy.adaptiveResolution !== false;
  const seed = seedOf(id);
  const ctx = {
    seed,
    variant,
    configuration,
    configurationName: configName,
    budget: facts.budget,
    reserve: facts.maxTokens,
    adaptive,
    folding: adaptive ? strategy.foldingStrategy ?? 'kv-unified' : null,
    native: configuration.agent?.formatter !== 'anthropic-xml',
    prefixTurns: prefixTurns[configName],
    capabilities: facts.capabilities,
  };
  const fromEmpty = workload.from === null || workload.fromEmpty?.(variant) || configName === 'H2';
  // A setup the fixed release can't drive builds the history its workload continues in the run itself: the history's
  // steps, whose last copies the store and boots it a checkpoint's gap later, then the workload's, so the record holds
  // every turn.
  const history = WORKLOADS[workload.from] ?? null;
  const builds = history !== null && base.buildsHistory === true;
  const built = () => {
    const steps = history.steps(ctx);
    return [...steps.slice(0, -1), { ...steps.at(-1), gapMs: CHECKPOINT_GAP_MS }];
  };
  return {
    id,
    workload: workloadName,
    variant,
    seed,
    configuration,
    standin: typeof workload.standin === 'function' ? workload.standin(variant) : {},
    from: history ? (builds ? null : `${configName}/${workload.from}`) : fromEmpty ? null : `${configName}/${base.summarises === false ? 'W1' : 'W2'}`,
    steps: () => (builds ? [...built(), ...workload.steps(ctx)] : workload.steps(ctx)),
    check: (run) => workload.check(run, ctx),
    owns: typeof workload.owns === 'function' ? workload.owns(variant) : workload.owns ?? [],
    products: workload.products ? workload.products(configuration) : [],
    compresses: workload.compresses !== false,
  };
}
