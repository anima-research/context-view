// @ts-nocheck
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_AGENT, FORK_PREFIX, assemblies, judgedBy, primaryAgent, requestPairs, spawnName, withJudged } from './checks.ts';
import { isUnreadable } from './invariants.ts';
import { png } from './png.ts';
import { hash32, prose, seeded } from './prose.ts';
import { CHANNEL, INSTRUCTIONS, READER, TOOL, continuation, prefix, products } from './script.ts';
import { REFUSED_CONTENT } from '../standin/summariser.ts';
import { JUDGE_FAILS, JUDGE_HOLDS, WAKE } from '../standin/judge.ts';
import { FLAG } from '../standin/review.ts';
import { STALE } from '../standin/retrieval.ts';
import { streamBoundFor } from './judge.ts';

export type Breach = { step?: string | null; request?: string; what?: string; message: string };
export type Breaches = Breach[] & { readonly judged?: number; readonly judgedBy?: number; readonly besides?: string };
export type Owned = { check: number; what?: string };

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
const SIDE = 'w14-side';
const W8_SIDE = 'w8-side';
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
    subs: [{ marker, canaries: subCanaries, replies: subReplies }],
  };
}

// agent-framework's coordinator ends a tune-out past its wake budget, and a reader's plain prose has no destination
// (the host asks it again), so the reader reports with `deliver_summary` and ends with `skip_reply`.
// A persistent reader is the agent `Subconscious`; reader forks are named `reader/<resident>/<epoch>/<n>`
// (agent-framework 0.33.0's tune-out coordinator), so a reader turn is matched by that prefix.
const readerOf = (configuration) => (configuration.subconscious?.reader === 'forks' ? { prefix: `reader/${configuration.agent?.name ?? FIXTURE_AGENT}/` } : { name: 'Subconscious' });

function tuneOut(w) {
  const t = w.turn('tune', { calls: 0 });
  return {
    ...t,
    replies: [
      { text: `${w.c('tune', 'r1')} ${prose(200, `${w.id('tune')}:r1`)}`, calls: [{ name: 'tune_out', input: { channelId: CHANNEL, cadenceSeconds: 86400, maxWakes: 64 } }] },
      { text: `${w.c('tune', 'r2')} ${prose(200, `${w.id('tune')}:r2`)}` },
    ],
    namedAnywhere: true,
  };
}

// agent-framework 0.33.0's reader forks may call only the reader's tools (`readerMayCall`: deliver_summary,
// cancel_tuneout, note_disposition), so a fork ends its look by ending its turn, and its summary is mail that wakes
// the resident, which answers with skip_reply. It withdraws the maintenance calls out on an ended fork's context
// manager, so the fork's last reply waits for compression to go idle, or a summary the fork started could go unwritten.
function readerRead(w, k, more = {}, reader = { name: 'Subconscious' }, { attach = false } = {}) {
  const held = w.turn(`h${k}`, { calls: 0, attach });
  const forks = reader.prefix !== undefined;
  const summary = w.c(`h${k}`, forks ? 'sum.in' : 'read');
  return {
    ...held,
    tags: ['chat:addressed'],
    reader,
    tunedOut: [w.c(`h${k}`, 'in')],
    ...more,
    ...(forks ? { canaries: [...held.canaries, summary], inputs: [summary], replies: [{ text: `${w.c(`h${k}`, 'r1')} noted`, calls: [{ name: 'skip_reply', input: {} }] }] } : { replies: [] }),
    subs: [{
      marker: READER,
      canaries: [w.c(`h${k}`, 'in')],
      namedAnywhere: true,
      also: ['addressed message'],
      replies: [
        { calls: [{ name: 'deliver_summary', input: { text: `${summary} ${prose(w.between(SIZES.reply), `${w.id(`h${k}`)}:read`)}`, channelId: CHANNEL } }] },
        forks ? { text: `${w.c(`h${k}`, 'end')} read`, settle: true } : { calls: [{ name: 'skip_reply', input: {} }] },
      ],
    }],
  };
}

// agent-framework's /undo takes the resident's last turn out of its window, so the script says whose words an /undo
// takes out: under reader forks the note answering the last fork's summary, and under a persistent reader, which wakes
// no resident turn, the turn that tuned the channel out.
const undoing = (step, steps) => (step.command === '/undo' ? { ...step, undoes: (steps.findLast((s) => s.replies?.length)?.replies ?? []).flatMap((r) => (typeof r.text === 'string' ? r.text.match(/\[\[c:[^\]\s]+\]\]/g) ?? [] : [])) } : step);

function tunedOut(w, steps, count, o = {}) {
  steps.push(tuneOut(w));
  for (let k = 1; k <= count; k++) {
    for (const step of o.before?.[k] ?? []) steps.push(undoing(step, steps));
    steps.push(readerRead(w, k, o.mayFail?.(k) ? { mayFail: true } : {}, o.reader, { attach: o.attach?.(k) === true }));
  }
}

const W1_KEEP = 'w1-keep';
const W1_SIDE = 'w1-side';

function allExcept(w) {
  const said = (step, k) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  const focus = w.turn('focus', { calls: 0, more: { channel: W1_KEEP, namedAnywhere: true } });
  focus.replies = [
    { text: said('focus', 1), calls: [{ name: 'tune_out', input: { channelId: W1_KEEP, scope: 'all-except', durationSeconds: 150, cadenceSeconds: 60 } }] },
    { text: said('focus', 2) },
  ];
  const [side, chat] = [w.c('held', 'side'), w.c('held', 'chat')];
  const held = {
    id: w.id('held'), segment: 'W1', kind: 'deliver', topic: 'W1', canaries: [side, chat], tunedOut: [side, chat],
    messages: [
      { channel: W1_SIDE, id: `${w.id('held')}.side`, participant: 'Wren', text: `${side} ${prose(600, `${w.id('held')}:side`)}`, held: true },
      { channel: CHANNEL, id: `${w.id('held')}.chat`, participant: 'Tavy', text: `${chat} ${prose(600, `${w.id('held')}:chat`)}`, held: true },
    ],
  };
  const summary = w.c('look', 'sum');
  const look = {
    id: w.id('look'), segment: 'W1', kind: 'advance', ms: 61_000, canaries: [], inputs: [], addressed: false, reader: { name: 'Subconscious' }, replies: [],
    subs: [{ marker: READER, canaries: [side], namedAnywhere: true, replies: [
      { calls: [{ name: 'deliver_summary', input: { text: `${summary} ${prose(300, `${w.id('look')}:sum`)}`, channelId: W1_SIDE } }] },
      { calls: [{ name: 'skip_reply', input: {} }] },
    ] }],
  };
  const release = {
    id: w.id('release'), segment: 'W1', kind: 'advance', ms: 90_000, canaries: [side, summary], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said('release', 1), calls: [{ name: 'skip_reply', input: {} }] }],
    subs: [{ marker: READER, canaries: [side], namedAnywhere: true, replies: [{ calls: [{ name: 'skip_reply', input: {} }] }] }],
  };
  return [focus, held, look, release];
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

// The history module's search answers with its matches, each naming its message's `id` (history/index.ts SearchMatch).
const searchedId = (messages) => /"id":\s*"([^"]+)"/.exec(lastResultTexts(messages).join('\n'))?.[1];

function historyTurns(g, w, { refused = false } = {}) {
  const sent = w.c('hist.send', 'sent');
  const send = g.deliver('hist.send', CHANNEL, 'wake', { rule: 'default' });
  send.replies = [{ calls: [{ name: 'channel_publish', input: { channelId: CHANNEL, content: `${sent} ${prose(300, `${w.id('hist.send')}:sent`)}` } }] }, { calls: [{ name: 'skip_reply', input: {} }] }];
  const read = g.deliver('hist.read', CHANNEL, 'wake', { rule: 'default' });
  read.replies = [
    { calls: [{ name: 'history--search', input: { query: sent, limit: 1 } }] },
    { calls: (messages) => [{ name: 'history--extract', input: { aroundId: searchedId(messages) ?? 'none', before: 0, after: 0, format: 'text' } }] },
    ...read.replies,
  ];
  read.history = sent;
  if (!refused) return [send, read].map((s) => ({ ...s, namedAnywhere: true }));
  // A publish the fixture server refuses (`[[fail-publish]]`) is stored as a call whose result is an error, which the
  // module's text form marks `, error` (agent-framework history/semantic.ts, the `failed` set).
  const failed = w.c('hist.fail', 'sent');
  const fail = g.deliver('hist.fail', CHANNEL, 'wake', { rule: 'default' });
  fail.replies = [{ calls: [{ name: 'channel_publish', input: { channelId: CHANNEL, content: `${failed} ${prose(300, `${w.id('hist.fail')}:sent`)} ${FAIL_PUBLISH}` } }] }, { calls: [{ name: 'skip_reply', input: {} }] }];
  const reread = g.deliver('hist.read2', CHANNEL, 'wake', { rule: 'default' });
  reread.replies = [
    { calls: [{ name: 'history--search', input: { query: failed, limit: 1 } }] },
    { calls: (messages) => [{ name: 'history--extract', input: { aroundId: searchedId(messages) ?? 'none', before: 0, after: 0, format: 'text' } }] },
    ...reread.replies,
  ];
  reread.history = failed;
  return [send, read, fail, reread].map((s) => ({ ...s, namedAnywhere: true }));
}

function workspaceTurns(g, w) {
  const draft = `${w.c('ws.draft', 'file')} ${prose(300, `${w.id('ws.draft')}:file`)}\n`;
  const disk = `${w.c('ws.disk', 'file')} ${DISK_MARK} ${prose(360, `${w.id('ws.disk')}:file`)}\n`;
  return [
    g.act('ws.draft', [{ name: 'workspace--write', input: { path: DRAFT_PATH, content: draft } }], { then: [[{ name: 'workspace--materialize', input: { path: DRAFT_PATH } }]] }),
    g.file('ws.disk', 'output/w12-draft.md', { text: disk }),
    g.file('ws.binary', 'output/w12-bin/blob.bin', { text: `${w.c('ws.binary', 'file')}\u0000\n` }),
    g.file('ws.backup', 'output/w12-draft.md~', { text: draft }),
    g.act('ws.edit', [{ name: 'workspace--edit', input: { path: DRAFT_PATH, oldString: w.c('ws.draft', 'file'), newString: w.c('ws.edit', 'file') } }], {
      then: [
        [{ name: 'workspace--read', input: { path: DRAFT_PATH } }],
        [{ name: 'workspace--grep', input: { pattern: DISK_MARK } }],
        [{ name: 'workspace--ls', input: { path: 'products' } }],
        [{ name: 'workspace--sync', input: { mount: 'products' } }],
      ],
    }),
  ];
}

function pairTurns(g, w) {
  const said = (step, part) => `${w.c(step, part)} ${prose(300, `${w.id(step)}:${part}`)}`;
  const ambient = { tags: ['chat:ambient'], rule: W12_PAIR.name };
  const fire = g.fire('pair.fire', W12_PAIR.debounceMs + 1_000, ['pair.a', 'pair.in', 'pair.note'], { addressed: false });
  fire.replies = [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, with a stated wait', headers: { 'retry-after': String(PAIR_HOLD_MS / 1000) } } }];
  fire.retries = true;
  const held = { ...g.timed('pair.held', PAIR_HOLD_MS, 'the provider hold\'s end', 'pair.a'), replies: [{ text: said('pair.held', 'r1'), calls: [{ name: 'sleep', input: { seconds: 120 } }] }] };
  return [
    g.act('pair.rule', [{ name: 'toolsets--act', input: { tool: 'wake_add_rule', args: W12_PAIR } }]),
    g.deliver('pair.a', 'w12-pair', 'none', ambient),
    g.deliver('pair.in', 'w12-pair-in', 'none', ambient),
    g.deliver('pair.note', 'w12-pair-note', 'none', { tags: ['chat:system'], rule: W12_PAIR.name }),
    fire,
    g.deliver('pair.b', 'w12-pair-b', 'none', ambient),
    held,
    g.timed('pair.wake', 121_000, 'the sleep\'s end', 'pair.a'),
  ];
}

function mixTurns(g, w) {
  const add = (rule) => [{ name: 'toolsets--act', input: { tool: 'wake_add_rule', args: rule } }];
  const chan = g.deliver('mix.chan', 'w12-mix', 'none', { rule: W12_MIX.name });
  chan.messages = chan.messages.map((m) => ({ ...m, text: m.text.replace(w.c('mix.chan', 'in'), `${w.c('mix.chan', 'in')} ${MIX}`) }));
  const console = {
    id: w.id('mix.console'), segment: 'W12', kind: 'console', text: `${w.c('mix.console', 'in')} ${MIX} ${prose(300, `${w.id('mix.console')}:in`)}`,
    canaries: [w.c('mix.console', 'in')], addressed: false, spare: [{ text: `${w.c('mix.console', 'spare')} ${prose(200, `${w.id('mix.console')}:spare`)}` }],
    gate: { expect: 'none', rule: W12_MIX.name, canaries: [w.c('mix.console', 'in')] },
  };
  const quick = (step, mark = '') => ({ channel: 'w12-quick', id: w.id(step), participant: 'Tavy', text: `${w.c(step, 'in')}${mark ? ` ${mark}` : ''} ${prose(300, `${w.id(step)}:in`)}` });
  const said = (step, part) => `${w.c(step, part)} ${prose(300, `${w.id(step)}:${part}`)}`;
  const window = W12_QUICK.judge.debounceMs + 1_000;
  const first = g.deliver('quick.1', 'w12-quick', 'none', { rule: W12_QUICK.name });
  first.messages = [quick('quick.1', JUDGE_HOLDS)];
  const judged = {
    ...g.timed('quick.fire', window, W12_QUICK.name, 'quick.1'),
    verdict: W12_QUICK.name,
    verdicts: 2,
    judgeHold: { during: [{ deliver: quick('quick.2', WAKE) }, { advance: window }] },
    gate: { expect: 'batch', rule: W12_QUICK.name, canaries: [w.c('quick.2', 'in')] },
  };
  const behind = g.deliver('quick.held', CHANNEL, 'wake', { rule: 'default' });
  behind.replies = [
    { text: said('quick.held', 'r1'), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c('quick.held', 'call1') } }], hold: true, during: [{ deliver: quick('quick.3') }, { advance: window }] },
    { text: said('quick.held', 'r2'), hold: true, during: [{ deliver: quick('quick.4', WAKE) }, { advance: window }] },
  ];
  behind.spare = [{ calls: [{ name: 'skip_reply', input: {} }] }];
  behind.verdictAfterTurn = W12_QUICK.name;
  behind.namedAnywhere = true;
  return [
    g.act('mix.rules', add(W12_MIX), { then: [add(W12_WATCH), add(W12_QUICK)] }),
    chan,
    console,
    g.deliver('mix.read', 'w12-always', 'wake'),
    g.fire('mix.fire', W12_MIX.debounceMs + 1_000, ['mix.chan', 'mix.console'], { read: ['mix.chan'], addressed: false }),
    { ...g.file('mix.file', MIX_PATH), watched: 'settles', gate: { expect: 'none', rule: W12_WATCH.name, canaries: [] } },
    g.timed('mix.wfire', W12_WATCH.debounceMs + 1_000, W12_WATCH.name, 'mix.chan'),
    first,
    judged,
    behind,
  ];
}

// A console turn spawns a subagent without waiting, so its result comes back as input of its own from private work
// (agent-framework#190's private sources). agent-framework puts a row stored during a turn's last request after the
// turn's final reply, and starts a turn for its wake.
function privateSpawn(w, ctx) {
  const step = 'priv.spawn';
  const said = (part) => `${w.c(step, part)} ${prose(200, `${w.id(step)}:${part}`)}`;
  const marker = `[[${step}:${ctx.seed}]]`;
  const name = `priv-spawn-${ctx.seed}`;
  return {
    id: w.id(step), segment: 'W12', kind: 'console', text: said('in'), canaries: [w.c(step, 'in')], addressed: false, namedAnywhere: true,
    replies: [
      { text: said('r1'), calls: [{ name: 'subagent--spawn', input: { name, systemPrompt: `${marker} You are the fixture's private work.`, task: said('task') } }] },
      { text: said('r2'), hold: true, during: [{ agentEnd: name }] },
      { text: said('r3') },
    ],
    subs: [{ marker, canaries: [w.c(step, 'task')], replies: [{ text: said('s1'), hold: true, during: [{ asked: 'primary', n: 2 }] }] }],
    arrivals: [{ canary: w.c(step, 's1'), point: 'end', after: w.c(step, 'r2'), agent: name }],
    gate: { expect: 'wake', rule: 'default', canaries: [w.c(step, 'in')] },
  };
}

// A console turn forks without waiting, so the fork's result is input from private work too, held as privateSpawn's
// is. The fork's request shows agent-framework's derivation notice where the call's result goes.
function privateFork(w, ctx) {
  const step = 'priv.fork';
  const said = (part) => `${w.c(step, part)} ${prose(200, `${w.id(step)}:${part}`)}`;
  const marker = `[[${step}:${ctx.seed}]]`;
  const name = `priv-fork-${ctx.seed}`;
  return {
    id: w.id(step), segment: 'W12', kind: 'console', text: said('in'), canaries: [w.c(step, 'in')], addressed: false, namedAnywhere: true,
    replies: [
      { text: said('r1'), calls: [{ name: 'subagent--fork', input: { name, systemPrompt: `${marker} You are the fixture's private work.`, task: said('task') } }] },
      { text: said('r2'), hold: true, during: [{ agentEnd: name }] },
      { text: said('r3') },
    ],
    subs: [{ marker, canaries: [w.c(step, 'task')], replies: [{ text: said('s1'), hold: true, during: [{ asked: 'primary', n: 2 }] }] }],
    arrivals: [{ canary: w.c(step, 's1'), point: 'end', after: w.c(step, 'r2'), agent: name }],
    gate: { expect: 'wake', rule: 'default', canaries: [w.c(step, 'in')] },
  };
}

// agent-framework orphans a subagent's task work when that subagent ends, and offers it to the nearest live ancestor
// (dendrite/registry.ts `endRecursive`, framework.ts `announceOrphaned` and `tellResultHeld`). Where the held result's
// notice also wakes that ancestor (anima-research/agent-framework#1009), the resident has a third turn at the step.
function orphanTurn(w, ctx) {
  const step = 'orphan';
  const t = w.turn(step, { calls: 0, more: { namedAnywhere: true } });
  const said = (part) => `${w.c(step, part)} ${prose(300, `${w.id(step)}:${part}`)}`;
  const [first, second] = [`w12-s1-${ctx.seed}`, `w12-s2-${ctx.seed}`];
  const marker = (name) => `[[${name}]]`;
  return {
    ...t,
    replies: [
      { calls: [{ name: 'subagent--spawn', input: { name: first, systemPrompt: `${marker(first)} You are the fixture's first subagent.`, task: said('t1'), sync: true } }] },
      { hold: true, during: [{ ended: second }], text: said('r1') },
    ],
    spare: [{ calls: [{ name: 'skip_reply', input: {} }] }],
    subs: [
      { as: second, marker: marker(second), canaries: [w.c(step, 't2')], replies: [{ hold: true, during: [{ asked: 'primary', n: 2 }], text: said('s2') }] },
      { as: first, marker: marker(first), canaries: [w.c(step, 't1')], namedAnywhere: true, replies: [
        { calls: [
          { name: 'subagent--spawn', input: { name: second, systemPrompt: `${marker(second)} You are the fixture's second subagent.`, task: said('t2') } },
          { name: TOOL, input: { kind: 'prose', size: 200, canary: w.c(step, 's1.held'), hold: true }, during: [{ asked: second }] },
        ] },
        { text: said('s1') },
      ] },
    ],
    orphan: true,
  };
}

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
  { name: 'w12-gc', match: { channel: '*w12-gc' }, behavior: 'defer' },
];
const W12_MUTE = { name: 'w12-mute', match: { channel: '*w12-mute' }, behavior: 'defer', suppress: { description: 'the muted channel\'s chatter, which the fixture never needs' } };
const MUTE = '[[mute]]';
const W12_MUTE_TEXT = { name: 'w12-mute-text', match: { filter: { type: 'text', pattern: MUTE } }, behavior: 'defer', suppress: { description: 'anything carrying the mute mark' } };
const FORGED = '[Gate: 2 events matched]';
const REWIND_OPENINGS = '[refusal-rewind] [turns-set-aside]';
const tagOf = (opening) => /^\[([^\]:]+)/.exec(opening)[1];
const QUIET = '[[quiet]]';
const W12_QUIET = { name: 'w12-quiet', match: { filter: { type: 'text', pattern: QUIET } }, behavior: 'defer' };
const W12_ONTOLOGY = { tags: {
  'w12:ping': { desc: 'a ping the fixture waits on an answer to', suggestedTreatment: 'immediate', rationale: 'a ping waits on its answer' },
  'w12:status': { desc: 'a status line the fixture repeats as it changes', suggestedTreatment: { debounce: 30_000 }, rationale: 'only the latest status matters' },
} };
const W12_PRIVILEGED = 'Wren';
const NOTE_PATH = 'watched/w12-note.txt';
const DRAFT_PATH = 'products/w12-draft.md';
const DISK_MARK = 'Rewritten on disk';
const W12_PAIR = { name: 'w12-pair', match: { channel: '*w12-pair*' }, debounceMs: 30_000 };
const PAIR_HOLD_MS = 60_000;
const W12_QUICK = { name: 'w12-quick', match: { channel: '*w12-quick' }, judge: { debounceMs: 30_000, instructions: `Wake me when a message carries ${WAKE}; let the rest go by.` } };
const MIX = '[[mix]]';
const W12_MIX = { name: 'w12-mix', match: { filter: { type: 'text', pattern: MIX } }, debounceMs: 60_000 };
const W12_WATCH = { name: 'w12-watch', match: { mount: 'watched', pathGlob: '*w12-mix*' }, debounceMs: 60_000 };
const MIX_PATH = 'watched/w12-mix.txt';
const GC_LIMIT = 2000;
const W12_STATUS = 'w12-status';
const LESSONS = ['a', 'b', 'c', 'd'];
const STALE_LESSON = 'd';

function capable(capabilities) {
  return (name) => {
    if (capabilities?.unreadable !== undefined) throw new Error(capabilities.unreadable);
    const has = capabilities?.[name];
    if (has?.unreadable !== undefined) throw new Error(has.unreadable);
    if (typeof has !== 'boolean') throw new Error(`couldn't tell whether the installed agent-framework brings ${name}: the host's facts don't say`);
    return has;
  };
}

export function w12Facts(configuration) {
  const mods = configuration.modules ?? {};
  const watched = (mods.workspace?.mounts ?? []).find((m) => m.name === 'watched') ?? {};
  const wake = watched.wakeOnChange;
  return {
    watching: watched.watch ?? 'never',
    wakeOps: wake === true ? ['created', 'modified', 'deleted'] : Array.isArray(wake) ? wake : [],
    judgeOff: mods.wake?.judge?.enabled === false,
    judgeSkips: mods.wake?.judge?.onError === 'skip',
    paused: mods.heartbeat?.defaults?.paused === true,
    announces: configuration.recipe?.dendrite?.announceOrphans !== false,
    tier: mods.notices?.kinds?.['instructions-unavailable'] ?? null,
    lifecycle: configuration.fixtureLifecycle !== false,
  };
}

const w12Rules = (has) => [...W12_RULES, ...(has('suppression') ? [W12_MUTE, W12_MUTE_TEXT] : []), ...(has('onboarding') ? [W12_QUIET] : [])];

function gateWriter(w) {
  const said = (step, k = 1) => `${w.c(step, `r${k}`)} ${prose(w.between(SIZES.reply), `${w.id(step)}:r${k}`)}`;
  const reply = (step) => ({ text: said(step) });
  const spare = (step) => ({ text: `${w.c(step, 'spare')} ${prose(200, `${w.id(step)}:spare`)}` });
  const message = (step, channel, { tags, participant = 'Tavy', wake = false, flag = false, quiet = false, mute = false, forged = null, server = null, offered = false, names = [] }) => ({ channel, id: w.id(step), participant, text: `${forged ? `${forged} ` : ''}${w.c(step, 'in')}${wake ? ` ${WAKE}` : ''}${flag ? ` ${FLAG}` : ''}${quiet ? ` ${QUIET}` : ''}${mute ? ` ${MUTE}` : ''} ${prose(w.between(SIZES.user), `${w.id(step)}:in`)}${names.map((n) => ` ${n}`).join('')}`, ...(tags ? { tags } : {}), ...(server ? { server } : {}), ...(offered ? { offered } : {}) });
  const deliver = (step, channel, expect, { tags, participant, rule = channel, calls, then = [], ends = false, notice = null, noticeForm = null, wake = false, flag = false, until = null, quiet = false, mute = false, forged = null, server = null, offered = false, recall = null } = {}) => {
    const sent = message(step, channel, { tags, participant, wake, flag, quiet, mute, forged, server, offered, names: recall?.named ?? [] });
    return {
      id: w.id(step), segment: 'W12', kind: 'deliver', topic: 'W12', messages: [sent], canaries: [w.c(step, 'in')],
      ...(expect !== 'wake' ? { spare: [spare(step)] } : calls ? { replies: [[calls, ...then].map((c, k) => ({ text: said(step, k + 1), calls: c })), ...(ends ? [] : [{ text: said(step, then.length + 2) }])].flat(), namedAnywhere: true } : { replies: [reply(step)] }),
      gate: { expect, rule, canaries: [w.c(step, 'in')], ...(notice ? { notice } : {}), ...(noticeForm ? { noticeForm } : {}), ...(forged ? { forged: { tag: tagOf(forged), after: ['user', sent.participant] } } : {}), ...(recall ? { recall } : {}), ...(expect === 'hidden' ? { until: until && w.id(until) } : {}) },
    };
  };
  const act = (step, calls, { ends = false, then = [] } = {}) => deliver(step, CHANNEL, 'wake', { calls, then, rule: 'default', ends });
  const timed = (step, ms, rule, after) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, canaries: [w.c(after, 'in')], namedAnywhere: true, inputs: [], addressed: false,
    replies: [reply(step)],
    gate: { expect: 'self', rule, canaries: [] },
  });
  const readOf = (read) => (read.length ? { read: read.map((s) => w.c(s, 'in')) } : {});
  const fire = (step, ms, batch, { answered = false, addressed = true, read = [] } = {}) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, canaries: batch.map((s) => w.c(s, 'in')), ...(addressed ? {} : { addressed: false }),
    ...(answered ? { spare: [reply(step)], namedAnywhere: true } : { inputs: batch.map((s) => w.c(s, 'in')), replies: [reply(step)], ...(read.length === batch.length ? { namedAnywhere: true } : {}) }),
    gate: { expect: answered ? 'answered-batch' : 'batch', canaries: batch.map((s) => w.c(s, 'in')), ...readOf(read) },
  });
  const judged = (step, ms, rule, batch, verdict, { read = [], wakes = verdict === 'reply', answered = false } = {}) => ({
    id: w.id(step), segment: 'W12', kind: 'advance', ms, verdict: rule, canaries: batch.map((s) => w.c(s, 'in')), addressed: false,
    ...(answered ? { spare: [reply(step)], namedAnywhere: true } : wakes ? { inputs: batch.map((s) => w.c(s, 'in')), replies: [reply(step)] } : { spare: [spare(step)] }),
    ...(read.length === batch.length ? { namedAnywhere: true } : {}),
    gate: { expect: answered ? 'answered-batch' : !wakes ? 'none' : verdict === 'failed' ? 'wake' : 'batch', rule, judged: verdict, canaries: batch.map((s) => w.c(s, 'in')), ...readOf(read) },
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
  const heldTick = (step, ms, after) => {
    const text = (part) => `${w.c(step, part)} ${prose(300, `${w.id(step)}:${part}`)}`;
    return {
      ...timed(step, ms, 'the heartbeat\'s tick', after),
      replies: [
        { text: text('r1'), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c(step, 'call1') } }], hold: true, during: [{ console: { id: `${w.id(step)}.con`, text: text('con.in') } }] },
        { text: text('r2') },
      ],
      spare: [{ calls: [{ name: 'skip_reply', input: {} }] }],
    };
  };
  return { deliver, act, fire, judged, reviewed, absent, timed, heldTick, file, typed };
}

export function gateFates(run, steps) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const judge = run.records.filter((r) => r.kind === 'judge');
  const reviews = run.records.filter((r) => r.kind === 'review');
  const filters = run.records.filter((r) => r.kind === 'relevance');
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const carriesIn = (blocks, c) => blocks.some((b) => (b.canaries ?? []).includes(c));
  const lastCarries = (r, c) => carriesIn(r.messages?.at(-1)?.blocks ?? [], c);
  const carries = (r, c) => (r.messages ?? []).some((m) => carriesIn(m.blocks, c));
  const overLine = (r, n) => (r.messages?.at(-1)?.blocks ?? []).find((b) => b.wakeLine > n);
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
      else if (s.gate.judged === 'failed' ? asked[0].answer?.shape !== 'error' : asked[0].answer?.verdict !== s.gate.judged) out.push({ step: s.id, message: `the reply judge's request ${asked[0].id} was answered ${asked[0].answer?.verdict ?? asked[0].answer?.shape ?? 'nothing'}, where the batch's mark gives ${s.gate.judged === 'failed' ? 'an error' : s.gate.judged}` });
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
      else if (s.gate.noticeForm && !(opened.messages.at(-1).blocks ?? []).some((b) => b.notice === s.gate.notice && b.noticeForm === s.gate.noticeForm)) out.push({ step: s.id, message: `request ${opened.id}'s ${s.gate.notice} line is in the form ${(opened.messages.at(-1).blocks ?? []).find((b) => b.notice === s.gate.notice).noticeForm ?? 'neither form'}, where its alert's tier gives the ${s.gate.noticeForm} form` });
      else if (s.gate.forged && !(block.markedNotice?.tag === s.gate.forged.tag && block.markedNotice.after.join(': ') === s.gate.forged.after.join(': '))) out.push({ step: s.id, message: `request ${opened.id} carries the step's text without its [${s.gate.forged.tag}] marked as supplied text after the names the host writes before it (${s.gate.forged.after.join(', ')}), so it can read as the framework's own` });
    } else if (s.gate.expect === 'none') {
      if (mine.length) out.push({ step: s.id, message: `the ${s.gate.rule} rule's message started ${mine.length} request(s), where its rule starts none` });
      const next = agent.find((r) => order.get(r.step) > order.get(s.id));
      const missing = s.gate.canaries.filter((x) => next && !carries(next, x));
      if (!next) out.push({ step: s.id, message: `couldn't judge: no request after the ${s.gate.rule} rule's message to carry it` });
      else if (missing.length) out.push({ step: s.id, message: `request ${next.id}, the next after the ${s.gate.rule} rule's message, doesn't carry ${missing.join(' ')}` });
    } else if (s.gate.expect === 'batch' && s.gate.read) {
      const left = s.gate.canaries.filter((x) => !s.gate.read.includes(x));
      const opening = left.length ? mine.filter((r) => left.some((x) => lastCarries(r, x))) : mine.slice(0, 1);
      if (opening.length !== 1) out.push({ step: s.id, message: `the batch started ${opening.length} request(s)${left.length ? ' carrying the events the agent hadn\'t read' : ''}, where it starts one` });
      else if (!left.every((x) => lastCarries(opening[0], x))) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn without all ${left.length} of the events the agent hadn't read` });
      else if (overLine(opening[0], s.gate.canaries.length)) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn with a wake line counting ${overLine(opening[0], s.gate.canaries.length).wakeLine} events, where its batch holds ${s.gate.canaries.length}` });
    } else if (s.gate.expect === 'batch') {
      const opening = mine.filter((r) => s.gate.canaries.some((x) => lastCarries(r, x)));
      if (opening.length !== 1) out.push({ step: s.id, message: `the batch started ${opening.length} request(s) carrying it, where it starts one` });
      else if (!s.gate.canaries.every((x) => lastCarries(opening[0], x))) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn without all ${s.gate.canaries.length} of its events` });
      else if (overLine(opening[0], s.gate.canaries.length)) out.push({ step: s.id, message: `request ${opening[0].id} opens the batch's turn with a wake line counting ${overLine(opening[0], s.gate.canaries.length).wakeLine} events, where its batch holds ${s.gate.canaries.length}` });
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

export function turnFates(run, steps, { forks, unrouted = false }) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const out = [];
  let judged = 0;
  // A row the host adds after a user message, with no reply between, joins that message on the wire, and the host's
  // cache marker moves to the newest message, so the earlier request's last message is compared by its blocks.
  const shape = (b) => JSON.stringify([b.type, b.chars, b.canaries ?? null, b.notice ?? null, b.toolUseId ?? null]);
  const added = (r) => {
    const i = agent.indexOf(r);
    const before = i > 0 ? agent[i - 1].messages ?? [] : [];
    const now = r.messages ?? [];
    if (!before.length) return now.flatMap((m) => (m.blocks ?? []).map((b) => ({ role: m.role, b })));
    const last = before.length - 1;
    if (before.slice(0, last).some((m, k) => now[k]?.digest !== m.digest)) return null;
    const was = before[last].blocks ?? [];
    const is = now[last]?.role === before[last].role ? now[last].blocks ?? [] : null;
    if (!is || was.some((b, k) => !is[k] || shape(is[k]) !== shape(b))) return null;
    return [...is.slice(was.length).map((b) => ({ role: now[last].role, b })), ...now.slice(before.length).flatMap((m) => (m.blocks ?? []).map((b) => ({ role: m.role, b })))];
  };
  for (const s of steps) {
    const fate = s.fate;
    if (!fate) continue;
    const mine = agent.filter((r) => r.step === s.id);
    if (fate.none) {
      judged++;
      if (mine.length) out.push({ step: s.id, message: `request ${mine[0].id} came at this step, where ${fate.none}` });
      continue;
    }
    const next = agent.find((r) => order.get(r.step) > order.get(s.id));
    const later = [...mine.slice(1), ...(next ? [next] : [])].map((r) => ({ r, blocks: added(r) }));
    const unreadable = later.find((x) => x.blocks === null);
    const rows = later.flatMap((x) => x.blocks ?? []);
    const couldnt = (what) => out.push({ step: s.id, message: `couldn't judge ${what}: ${!mine.length ? 'no request at this step' : `request ${unreadable.r.id} doesn't carry the window of the request before it unchanged`}` });
    if (!mine.length || unreadable) { couldnt('its turn\'s fate'); continue; }
    if (!later.length && ['receipt', 'undeliverable', 'bounces', 'continues', 'wrapper'].some((k) => k in fate)) { out.push({ step: s.id, message: 'couldn\'t judge its turn\'s fate: no request follows it' }); continue; }
    const notices = (tag) => rows.filter(({ b }) => b.notice === tag).length;
    if ('receipt' in fate) {
      judged++;
      const receipt = rows.find(({ b }) => b.delivered)?.b.delivered;
      const want = fate.receipt;
      if (want === null && receipt) out.push({ step: s.id, message: `its turn wrote a [delivered] receipt (to ${receipt.to.join(', ') || 'no channel'}), where its setup writes none` });
      else if (want && !receipt) out.push({ step: s.id, message: `no [delivered] receipt follows its turn${next ? `, up to request ${next.id}` : ''}, where its setup writes one` });
      else if (want && receipt) {
        if (receipt.to.join(' · ') !== want.to.join(' · ')) out.push({ step: s.id, message: `its turn's receipt says its plain speech landed in ${receipt.to.join(' · ') || 'no channel'}, where its setup lands it in ${want.to.join(' · ') || 'no channel'}` });
        if (Boolean(want.held) !== receipt.held > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.held} draft(s) held, where its setup holds ${want.held ? 'some' : 'none'}` });
        if (Boolean(want.kept) !== receipt.kept > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.kept} segment(s) kept private, where its setup keeps ${want.kept ? 'some' : 'none'} private` });
        if (Boolean(want.transcript) !== receipt.transcript > 0) out.push({ step: s.id, message: `its turn's receipt names ${receipt.transcript} segment(s) kept in the transcript, where its setup keeps ${want.transcript ? 'its words there' : 'none there'}` });
      }
    }
    if (fate.undeliverable) {
      judged++;
      if (!notices('send-undeliverable')) out.push({ step: s.id, message: 'no [send-undeliverable] row follows its turn, though its reply had no channel to go to' });
    }
    if (fate.bounces !== undefined) {
      judged++;
      if (notices('prose-routing') !== fate.bounces) out.push({ step: s.id, message: `${notices('prose-routing')} [prose-routing] bounce(s) follow its turn, where its setup bounces ${fate.bounces}` });
    }
    if (fate.sendFailed) {
      judged++;
      if (notices(SEND_FAILED_NOTICE) !== 1) out.push({ step: s.id, message: `${notices(SEND_FAILED_NOTICE)} [${SEND_FAILED_NOTICE}] row(s) follow its turn, where its setup refuses its speech once` });
    }
    if (fate.continues !== undefined) {
      judged++;
      const continued = notices('continue');
      if (continued !== (fate.continues ? 1 : 0)) out.push({ step: s.id, message: `${continued} continuation(s) followed its turn, where ${fate.continues ? 'autoContinue continues a turn the model ends itself once, its continuation ending in skip_reply' : 'none does'}` });
    }
    if (fate.wrapper) {
      judged++;
      const [reply] = s.replies[0].text.match(CANARY_MARK);
      const carried = agent.filter((r) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => (b.canaries ?? []).includes(reply))));
      if (fate.wrapper === 'contained') {
        if (carried.length) out.push({ step: s.id, message: `request ${carried[0].id} carries the wrapper the guard contains, ${reply}` });
        if (!notices('tool-boundary')) out.push({ step: s.id, message: 'no [tool-boundary] row follows the contained wrapper' });
      } else if (!rows.some(({ role, b }) => role === 'assistant' && (b.canaries ?? []).includes(reply))) out.push({ step: s.id, message: `the wrapper ${reply} isn't in the history after its turn, where without the guard it's ordinary prose` });
    }
    if (fate.refused) {
      judged++;
      const refusedAt = mine.filter((r) => r.answer?.stop === 'refusal');
      if (refusedAt.length !== 1 || mine[0].answer?.stop !== 'refusal') out.push({ step: s.id, message: `${refusedAt.length} of the step's ${mine.length} request(s) were refused, where the stand-in refuses its first, once` });
      else if (fate.refused === 'ended' && mine.length !== 1) out.push({ step: s.id, message: `the refused request was followed by ${mine.length - 1} more at its step, where nothing retries a refusal with no retries and no rewind` });
      else if (fate.refused === 'replayed' && (mine.length !== 2 || (mine[1].messages ?? []).map((m) => m.digest).join() !== (mine[0].messages ?? []).map((m) => m.digest).join() || JSON.stringify(mine[1].head) !== JSON.stringify(mine[0].head) || mine[1].stream !== mine[0].stream)) out.push({ step: s.id, message: `the refused request wasn't replayed once whole (${mine.length} request(s) at its step), where refusalHandling's retries replay the same request` });
    }
    if (fate.stall) {
      judged++;
      const flag = stallFlag(mine, fate.stall);
      if (flag) out.push({ step: s.id, message: flag });
    }
    if (fate.stall === 'failed') {
      judged++;
      const note = rows.find(({ b }) => b.inferenceFailed)?.b.inferenceFailed;
      if (!next) out.push({ step: s.id, message: 'couldn\'t judge its turn\'s fate: no request follows it' });
      else if (!note) out.push({ step: s.id, message: `no [inference-failed] note follows its turn${next ? `, up to request ${next.id}` : ''}, where the bound cut its call and the fresh call` });
      else if (note.setting !== BEFORE_CONTENT_SETTING) out.push({ step: s.id, message: `its turn's [inference-failed] note names ${note.setting ?? 'no host setting'} as its reason, where the bound that cut it is ${BEFORE_CONTENT_SETTING}` });
    }
    if (fate.wakeRefused) {
      judged++;
      const refusedWake = run.log.some((e) => e.kind === 'ipc' && e.step === s.id && e.event?.type === 'tool:failed' && e.event.tool === 'skip_reply' && /can't take wake_in_seconds/.test(e.event.error ?? ''));
      if (!refusedWake || mine.length !== 2) out.push({ step: s.id, message: `${refusedWake ? 'skip_reply was refused' : 'no skip_reply call was refused'} and ${mine.length} request(s) came at its step, where with no gate skip_reply's wake_in_seconds is refused, the turn goes on, and its next call ends it` });
    }
    if (fate.overloaded) {
      judged++;
      const input = w13Input(s);
      if (mine.length !== 2 || mine[0].answer?.shape !== 'error' || !(mine[1].messages?.at(-1)?.blocks ?? []).some((b) => (b.canaries ?? []).includes(input))) out.push({ step: s.id, message: `the 529 wasn't followed by one request carrying its turn's message (${mine.length} request(s) at its step), where the retry setup sends it again` });
    }
  }
  // Disabled routing injects no primer and announces no locus (docs/disabled-prose-routing.md), so none of the run's
  // requests carries a `[routing]` row, the first turn's own announcement, which no step's later rows hold, included.
  if (unrouted) {
    judged++;
    const routed = agent.find((r) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => b.notice === 'routing')));
    if (routed) out.push({ step: routed.step, message: `request ${routed.id} carries a [routing] row, where disabled routing writes none` });
  }
  if (forks) {
    judged++;
    const by = primaryAgent(run.log);
    if (!by.startsWith(FORK_PREFIX)) out.push({ step: 'the run', message: `the requests were made by ${by}, not by one fork of conversations` });
  }
  return withJudged(out, judged);
}

const CANARY_MARK = /\[\[c:[^\]\s]+\]\]/;
const w13Input = (s) => s.canaries[0];

const entries = (run, kind) => run.log.filter((e) => e.kind === kind);
const readsOf = (run, op) => entries(run, 'read').filter((e) => e.op === op);

const blocksOf = (record) => (record.messages ?? []).flatMap((m, i) => m.blocks.map((b) => ({ i, role: m.role, b })));

const summarises = (configuration) => configuration.summarises !== false;

const W17_CHANNELS = { chat: {}, other: {}, side: { initiallyOpen: false }, feed: { direction: 'inbound', initiallyOpen: false } };
const W17_VOICE = 'You read what the resident holds while it focuses, and tell it what matters.';

function w17Writer(w) {
  const said = (step, k) => `${w.c(step, `r${k}`)} ${prose(w.between(SIZES.reply), `${w.id(step)}:r${k}`)}`;
  const replies = (step, rounds, ends) => [...rounds.map((calls, k) => ({ text: said(step, k + 1), calls })), ...(ends ? [] : [{ text: said(step, rounds.length + 1) }])];
  const deliver = (step, channel, { rounds = [], ends = false, addressed = false, w17 = {} } = {}) => ({
    id: w.id(step), segment: 'W17', kind: 'deliver', topic: 'W17',
    messages: [{ channel, id: w.id(step), participant: 'Tavy', text: `${w.c(step, 'in')} ${prose(w.between(SIZES.user), `${w.id(step)}:in`)}`, ...(addressed ? { tags: ['chat:addressed'] } : {}) }],
    canaries: [w.c(step, 'in')], namedAnywhere: true, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 },
  });
  const wake = (step, ms, after, w17) => ({ id: w.id(step), segment: 'W17', kind: 'advance', ms, canaries: [w.c(after, 'in')], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said(step, 1) }], w17 });
  const text = (step, part) => `${w.c(step, part)} ${prose(w.between(SIZES.user), `${w.id(step)}:${part}`)}`;
  const turn = (step, channel, { rounds = [], ends = false, addressed = false, w17 = {} } = {}) => ({
    id: w.id(step), segment: 'W17', kind: 'channel', channel, participant: 'Tavy', topic: 'W17', text: text(step, 'in'), ...(addressed ? { tags: ['chat:addressed'] } : {}),
    canaries: [w.c(step, 'in')], namedAnywhere: true, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 },
  });
  const typed = (step, rounds, { ends = true, w17 = {} } = {}) => ({ id: w.id(step), segment: 'W17', kind: 'console', text: text(step, 'in'), canaries: [w.c(step, 'in')], namedAnywhere: true, addressed: false, replies: replies(step, rounds, ends), w17: { message: w.c(step, 'in'), ...w17 } });
  const consoleAct = (step, part) => ({ console: { id: `${w.id(step)}.${part}`, text: text(step, `${part}.in`) } });
  const deliverAct = (step, part, channel, { addressed = false, participant = 'Ash' } = {}) => ({ deliver: { channel, id: `${w.id(step)}.${part}`, participant, text: text(step, `${part}.in`), ...(addressed ? { tags: ['chat:addressed'] } : {}) } });
  return { deliver, wake, turn, typed, consoleAct, deliverAct, said, c: w.c, id: w.id };
}

// v0.9.0 knows no window for the model, and its context-manager refuses the prefix's 90,000-character turn at its
// default budget, so the budget is the 160,000 of a resident who upgraded from it. It sends no binding control, so only
// an older account's binding rule lets it fold its history.
// agent-framework 0.28.0 to 0.31.x stored reasoning-loss notices, and 0.30.0 stores one when a compile leaves out stored
// thinking because the request's tools, system text or model changed (reasoning-loss.ts). v0.20.0's lockfile gives
// 0.30.0, so its prefix alone restarts under a prompt an operator changed, after its last turn that thinks, and its
// store keeps the notice an upgraded resident's store holds.
export const UPGRADES = ['from-0.9.0', 'from-0.20.0', 'from-0.23.0'];
const NOTICED = 'from-0.20.0';
const UPGRADED = { agent: { contextBudgetTokens: 160_000 }, account: 'older' };
const PRICED = 'rewrite-priced';
// Any notice in the continuation's final store is the prefix's: no agent-framework from 0.32.0 on writes one. If a
// later release wrote reasoning-loss notices again, this would need the prefix's notice by identity.
const STORED_NOTICE = { name: 'the reasoning-loss notice the older release stored, kept in the store', fromStore: (store) => store.messages.some((m) => m.reasoningLoss) };

// agent-framework's breaker, before its first shed of a streak, sends the failed request with its messages replaced by
// one, and sheds only if that probe is answered; one that fails as the request did keeps the history and raises this
// alert, keyed by that verdict (framework.ts probeBeforeShed).
const HISTORY_KEPT = { kind: 'history-kept', verdict: 'fails-without-history' };
// The probe goes out as the failed turn ends, and the host's settle doesn't count it, so a step whose turn it follows
// waits for what the breaker does with its answer: a retry, or the history kept. A breaker that does neither is
// waited for up to a turn's bound and then judged.
const PROBED = { events: [{ type: 'inference:started' }, { type: 'ops:alert', kind: HISTORY_KEPT.kind }], what: 'what the breaker does after the failed turn, a retry\'s start or a history-kept alert' };

export const WORKLOADS = {
  prefix: {
    from: null,
    variants: UPGRADES,
    recipe: (variant) => (variant ? UPGRADED : {}),
    property: 'none: it writes the continuation\'s checkpoint and is no run of its own',
    steps: (ctx) => prefix(ctx.prefixTurns, { promptChanged: ctx.variant === NOTICED }),
    check: () => [],
  },

  continuation: {
    from: 'prefix',
    variants: [...UPGRADES, 'fresh', PRICED],
    recipe: (variant) => (variant === PRICED ? { kvUnifiedPolicy: { rewriteLambda: 500 } } : variant ? UPGRADED : {}),
    fromVariant: (variant) => (UPGRADES.includes(variant) ? variant : null),
    buildsFresh: (variant) => variant === 'fresh',
    property: 'each segment produces what it exists to produce (check 2)',
    steps: (ctx) => continuation(ctx.configuration),
    check: () => judgedBy([], 2),
    products: (configuration, variant) => {
      const own = products(configuration);
      return variant === NOTICED ? { ...own, 'close-merge': [...own['close-merge'], STORED_NOTICE] } : own;
    },
  },

  W1: {
    from: null,
    turns: 70,
    property: 'grows: L1, L2 and L3 summaries form as the store grows (configurations that summarise)',
    steps(ctx) {
      const w = writer(ctx, 'W1');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) steps.push(w.turn(n, { ...phaseTurn(n), ...(n === this.turns ? { more: { reads: ['state'] } } : {}) }));
      if (['H4', 'H4b'].includes(ctx.configurationName)) tunedOut(w, steps, 6, { before: { 4: [w.other('undo', 'command', { command: '/undo' })] }, reader: readerOf(ctx.configuration), ...(ctx.configurationName === 'H4b' ? { attach: (k) => k === 6 } : {}) });
      if (ctx.configurationName === 'H4') steps.push(...allExcept(w));
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
    property: 'tools: no request carries a mark of membrane\'s pairing repair, which would mean context-manager handed it a result without its call or a call without its result; context-manager\'s own repair marks, the designed output for the suppression it scripts, are counted beside (marks are found by their text, which the fixture\'s tool output never quotes; check 11 judges each compile\'s pairs); and no tool result goes out right after an assistant message carrying the canary of a call none of the scripted replies that message holds made, which an operator\'s suppression of turn 5\'s first result tests, leaving that call unanswered while the turn\'s second round reuses its id',
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
            if (n === 5) steps.push(w.other(`${n}.unanswered`, 'suppress', { messages: [{ canary: w.c(n, 'call1') }] }));
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
      const callsOf = new Map(this.steps(ctx).flatMap((s) => (s.replies ?? []).filter((reply) => CANARY_MARK.test(reply.text ?? '')).map((reply) => [reply.text.match(CANARY_MARK)[0], new Set((reply.calls ?? []).map((c) => c.input.canary))])));
      let results = 0;
      for (const r of requests) {
        const messages = r.messages ?? [];
        messages.forEach((m, k) => {
          const said = m.role === 'assistant' ? (m.blocks ?? []).flatMap((b) => b.canaries ?? []).filter((c) => callsOf.has(c)) : [];
          if (!said.length) return;
          const made = new Set(said.flatMap((c) => [...callsOf.get(c)]));
          for (const b of messages[k + 1]?.blocks ?? []) {
            if (b.type !== 'tool_result') continue;
            results++;
            const foreign = (b.canaries ?? []).filter((c) => !made.has(c));
            if (foreign.length) out.push({ step: r.step, request: r.id, message: `request ${r.id}: a result after the calls of ${said.length > 1 ? `replies ${said.join(' and ')}` : `reply ${said[0]}`} carries ${foreign.join(', ')}, which no call of ${said.length > 1 ? 'those replies' : 'that reply'} made` });
          }
        });
      }
      const held = `${ctx.seed}.2`;
      const at = run.log.filter((e) => e.step === held);
      if (!at.some((e) => e.kind === 'notice' && e.peer === 'server' && e.notice === 'held')) out.push({ step: held, message: 'the fixture server held no call at this step, so the call it should hold never reached it' });
      else if (!at.some((e) => e.kind === 'ipc' && e.event?.type === 'tool:failed' && String(e.event.error ?? '').includes('didn\'t answer within'))) out.push({ step: held, message: 'the call the fixture server held never timed out at this step' });
      return withJudged(out, requests.length + results + 1, `${requests.length} request(s), ${membrane.length} membrane repair mark(s), ${own} of context-manager's own, ${results} result(s) judged by their reply's calls, and the held call's timeout`);
    },
  },

  W7: {
    from: 'checkpoint',
    turns: 21,
    property: 'failures: at each step, the summariser requests the stand-in refuses, its merges or those carrying the content it refuses, raise one off-path refusal alert each, and nothing else raises one; content the summariser refuses reaches it only in the slice it is asked to remember; and in chunk-refused no summariser request carries a membrane repair mark, which under H1 two turns that each reuse their own call id over their rounds test, an operator having suppressed the first one\'s first result and the second one\'s first call',
    variants: ['merges-refused', 'merges-rejected', 'fable-no-tools', 'no-tools', 'chunk-refused'],
    owns: (variant) => (['merges-refused', 'chunk-refused'].includes(variant) ? [{ check: 1, what: 'refusal-offpath' }] : []),
    fromEmpty: (variant) => variant === 'fable-no-tools' || variant === 'no-tools',
    standin: (variant) => ({ refuseMerges: variant === 'merges-refused', rejectMerges: variant === 'merges-rejected', refuseContent: variant === 'chunk-refused' }),
    recipe: (variant, capabilities, setup) => ({
      ...(variant === 'chunk-refused' && setup === 'H1' ? { modules: { webui: WEB_UI } } : {}),
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
        else if (ctx.variant === 'chunk-refused') {
          const reused = ctx.configurationName === 'H1' && n <= 2;
          steps.push(w.turn(n, { ...phaseTurn(n), ...(n === REFUSED_TURN ? { mark: REFUSED_CONTENT } : {}), ...(reused ? { callId: () => `t${ctx.seed}_reuse_${n}` } : {}) }));
          if (reused && n === 1) steps.push(w.other(`${n}.unanswered`, 'suppress', { messages: [{ canary: w.c(n, 'call1') }] }));
          if (reused && n === 2) steps.push(w.other(`${n}.orphaned`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
        }
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
        const marked = calls.flatMap((r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => (b.repairs ?? []).filter((mark) => mark.startsWith('membrane:')).map((mark) => ({ step: r.step, request: r.id, message: `summariser request ${r.id} carries membrane's ${mark.slice('membrane:'.length)} repair mark, so context-manager handed it a call or result unpaired` })))));
        const judgedMarks = `${calls.length} summariser request(s) judged for membrane repair marks`;
        if (!carrying.length) return withJudged([{ step: null, message: 'couldn\'t judge: no summariser request carried the refused content' }, ...alerts, ...marked], 0, judgedMarks);
        const unplaced = carrying.filter((r) => r.carried === 'unplaced');
        if (unplaced.length) return withJudged([{ step: unplaced[0].step, message: `couldn't judge: ${unplaced.length} L1 request(s) carried the refused content with no single notice opening the slice they asked the summariser to remember, so where it sat can't be read` }, ...alerts, ...marked], 0, judgedMarks);
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
        out.push(...alerts, ...marked);
        return withJudged(out, carrying.length, judgedMarks);
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
        const t = w.turn(n, underCut(n) ? { more: { mayFail: true } } : {});
        if (n === 10 && ctx.configurationName === 'H1') {
          const arrival = (part, more = {}) => ({ id: `${w.id(n)}.${part}`, text: `${w.c(n, `${part}.in`)} ${prose(300, `${w.id(n)}:${part}`)}`, ...more });
          t.summariserHold = { level: 1, during: [{ budgetHeld: true }, { deliver: arrival('arrival', { participant: 'Tavy' }) }, { deliver: arrival('side', { participant: 'Wren', channel: W8_SIDE, tags: ['chat:addressed'] }) }, { advance: 61_000 }] };
          t.canaries.push(w.c(n, 'arrival.in'), w.c(n, 'side.in'));
        }
        steps.push(t);
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
            steps.push(w.other('6.witnessed', 'restart', { agent: { strategy: { witnessedBeforeSequence: { sequenceOf: w.c(6, 'r2') }, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.', witnessedInstruction: 'Write the memory of this slice of the log. It is a record the strategy fixture inherited. Target ~{targetTokens} tokens.' } } }));
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
              subs: [{ marker, canaries: [w.c('7f', 'task')], replies: [{ text: `${w.c('7f', 'f1')} ${prose(400, `${w.id('7f')}:f1`)}` }] }],
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
    owns: [{ check: 1, what: 'instructions-unavailable' }, { check: 1, what: 'instructions-unavailable-clear' }, { check: 1, what: 'subscription-gc-close' }],
    property: 'wake: each scripted event meets the fate its rule gives it: one its rule wakes starts a request whose last message carries it; one its rule holds back starts none at its step, and the next request carries it; a batch starts one request whose last message carries every event in it the agent hadn\'t read, a gate line there counting no more events than the batch holds; a batch a judge rule holds goes to the reply judge in one request listing it, answered as its mark gives, and one it lets go by starts none, the next request carrying it; a suppressed message reaches no request, and the one the suppression review flags none before the review\'s notice, which starts one request carrying it and not the other; an onboarding offer starts a request carrying the message that brought it and the offer\'s notice; a message naming lessons starts a request whose newest retrieved lessons are those it names less any the relevance filter drops, the one naming one lesson bringing no relevance request and the one naming four bringing one that lists them all; a batch already answered starts one turn at most; a sleep\'s end, skip_reply\'s wake, a watched file\'s change, a reminder and the heartbeat\'s tick each start a turn; the host\'s notice reaches the next request; a message opening with a notice tag reaches its request with the tag marked, not as a notice; console input starts a turn past a suppress rule that hides a channel message carrying the same mark; the third console message brings the one session naming request; a subagent that ends while the task it spawned still runs leaves the resident the adoption offer in the request answering it, and the held result\'s notice once that task ends; a message the agent sent with channel_publish, and one the fixture refused to post, each come back in the history module\'s search and in its extract\'s text; a subagent\'s result, or a fork\'s, stored while the turn that started it is in its last request is first carried by the turn its wake starts, after the closing words; a held call the inference bound cuts is sent again once with the same messages; a batch whose judge call fails starts one request carrying it where the judge wakes on an error, and none where it skips, the next request carrying it, and one the agent read and answered in the judge\'s channel starts one turn at most, and with the judge off every judge rule\'s batch wakes as a debounce\'s does; set_channel_mode succeeds where the fixture server directs its channels\' lifecycle, and where it doesn\'t says w12-mode is only partly in debounced mode, its opening the one step that failed; subscription-gc closes w12-gc once, at the message passing the limit the agent gave it, and the request the next chat message starts carries its note, and where the server directs no lifecycle no close goes through, no alert or note comes, and channel_list, right after the message passing the limit, shows w12-gc open with its close decided; the watched file\'s change reaches the workspace at its step, or, where the mount is looked at only after the agent\'s tool batches, at the next one\'s, and adds a message for the resident only where wakeOnChange takes a created file; with orphan announcements off no request of the agent\'s carries an orphan\'s notice, though agent-framework orphaned the second subagent with the agent first to adopt it; under the silent tier no request carries a host notice, though the alert came; and the agent looks at a tool the built-in settings toolset lists',
    recipe: (variant, capabilities) => ({ modules: { wake: { policies: capabilities === undefined ? W12_RULES : w12Rules(capable(capabilities)), default: 'always' } }, privileged: [W12_PRIVILEGED], fixtureChannels: { [W12_STATUS]: {} }, ...(capabilities !== undefined && capable(capabilities)('onboarding') ? { fixtureOntology: W12_ONTOLOGY } : {}) }),
    steps(ctx) {
      const w = writer(ctx, 'W12');
      const g = gateWriter(w);
      const has = capable(ctx.capabilities);
      const suppression = has('suppression');
      const act = (tool, args) => [{ name: 'toolsets--act', input: { tool, args } }];
      const lesson = (k) => w.c('lessons', `lesson-${k}`);
      const { watching, wakeOps, judgeOff, judgeSkips, paused, tier, lifecycle } = w12Facts(ctx.configuration);
      // H5's alone: a subagent's result from private work and a refused send's mark in the history module's extract
      // depend on no setup's values, so one setup reaches each.
      const privately = ctx.configurationName === 'H5';
      const failing = (step, tags) => {
        const s = g.deliver(step, 'w12-judge', 'none', { tags });
        return { ...s, messages: [{ ...s.messages[0], text: s.messages[0].text.replace(w.c(step, 'in'), `${w.c(step, 'in')} ${JUDGE_FAILS}`) }] };
      };
      const note = watching === 'always' && wakeOps.includes('created')
        ? [g.file('ws.note', NOTE_PATH, { watched: true, rule: 'the watched mount\'s change', also: ['w12-note'] })]
        : watching === 'always'
          ? [{ ...g.file('ws.note', NOTE_PATH), watched: 'settles' }]
          : [g.file('ws.note', NOTE_PATH), { ...g.act('ws.scan', [{ name: 'workspace--ls', input: { path: 'watched' } }]), namedAnywhere: true, also: ['w12-note'] }];
      const judgedSteps = judgeOff
        ? [
          g.deliver('judge.a1', 'w12-judge', 'none', { wake: true }),
          g.deliver('judge.a2', 'w12-judge', 'none'),
          g.deliver('judge.read', 'w12-always', 'wake'),
          g.fire('judge.yes', 61_000, ['judge.a1', 'judge.a2'], { read: ['judge.a1', 'judge.a2'], addressed: false }),
          g.deliver('judge.b1', 'w12-judge', 'none'),
          g.deliver('judge.b2', 'w12-judge', 'none'),
          g.fire('judge.no', 61_000, ['judge.b1', 'judge.b2'], { addressed: false }),
          failing('judge.c1'),
          { ...g.fire('judge.err', 61_000, ['judge.c1'], { addressed: false }), gate: { expect: 'wake', rule: 'w12-judge, a debounce with the judge off', canaries: [w.c('judge.c1', 'in')] } },
        ]
        : [
          g.deliver('judge.a1', 'w12-judge', 'none', { wake: true }),
          g.deliver('judge.a2', 'w12-judge', 'none'),
          g.deliver('judge.read', 'w12-always', 'wake'),
          g.judged('judge.yes', 61_000, 'w12-judge', ['judge.a1', 'judge.a2'], 'reply', { read: ['judge.a1', 'judge.a2'] }),
          g.deliver('judge.b1', 'w12-judge', 'none'),
          g.deliver('judge.b2', 'w12-judge', 'none'),
          g.judged('judge.no', 61_000, 'w12-judge', ['judge.b1', 'judge.b2'], 'wait'),
          failing('judge.c1'),
          g.judged('judge.err', 61_000, 'w12-judge', ['judge.c1'], 'failed', { wakes: !judgeSkips }),
          // Where a failed judge wakes the agent, a batch the agent has read and answered in the channel a reply was owed
          // in, its one event written for it, may wake it once or not at all (agent-framework#972's drop rule).
          ...(judgeSkips ? [] : [
            failing('judge.c2', ['chat:addressed']),
            { ...g.deliver('judge.read2', 'w12-always', 'wake'), namedAnywhere: true, replies: [{ calls: [{ name: 'channel_publish', input: { channelId: 'w12-judge', content: prose(200, `${w.id('judge.read2')}:pub`) } }] }, { calls: [{ name: 'skip_reply', input: {} }] }] },
            g.judged('judge.err2', 61_000, 'w12-judge', ['judge.c2'], 'failed', { read: ['judge.c2'], answered: true }),
          ]),
        ];
      const ticks = paused
        ? [{ id: w.id('tick'), segment: 'W12', kind: 'advance', ms: 4_300_000 }]
        : [g.timed('tick', 4_300_000, 'the heartbeat\'s tick', 'remind')];
      const privTick = paused ? [{ id: w.id('tick.priv'), segment: 'W12', kind: 'advance', ms: 5_400_000 }] : [g.heldTick('tick.priv', 5_400_000, 'console.3')];
      return [
        settingsTurn(w, 'set'),
        // Early, while the fork's inherited context is under its budget.
        ...(privately ? [privateFork(w, ctx)] : []),
        g.deliver('always', 'w12-always', 'wake'),
        g.deliver('defer', 'w12-defer', 'none'),
        g.deliver('debounce.a', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.deliver('debounce.b', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.fire('debounce.fire', 61_000, ['debounce.a', 'debounce.b']),
        g.deliver('answered.x', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.deliver('answered.y', 'w12-always', 'wake'),
        g.fire('answered.fire', 61_000, ['answered.x'], { answered: true }),
        g.deliver('part.x1', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.deliver('part.y', 'w12-always', 'wake'),
        g.deliver('part.x2', 'w12-debounce', 'none', { tags: ['chat:addressed'] }),
        g.fire('part.fire', 61_000, ['part.x1', 'part.x2'], { read: ['part.x1'] }),
        g.deliver('rate.1', 'w12-rate', 'wake'),
        g.deliver('rate.2', 'w12-rate', 'none'),
        g.deliver('sample.1', 'w12-sample', 'none'),
        g.deliver('sample.2', 'w12-sample', 'wake'),
        ...judgedSteps,
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
        g.act('rules.add', [{ name: 'toolsets--act', input: { tool: 'wake_add_rule', args: { name: 'w12-own', match: { channel: '*w12-own', weather: 'rain', mood: 'calm' }, behavior: 'defer', colour: 'teal' } } }]),
        g.deliver('own.1', 'w12-own', 'none', { rule: 'w12-own' }),
        g.act('rules.remove', [{ name: 'toolsets--act', input: { tool: 'wake_remove_rule', args: { name: 'w12-own' } } }, { name: 'toolsets--act', input: { tool: 'gate_status', args: {} } }]),
        g.deliver('own.2', 'w12-own', 'wake', { rule: 'default, once w12-own is removed' }),
        g.act('mode.set', [{ name: 'channel-mode--set_channel_mode', input: { channelId: 'w12-mode', mode: 'debounced', debounceMs: 60_000 } }]),
        g.deliver('mode.a', 'w12-mode', 'none', { tags: ['chat:ambient'], rule: 'set_channel_mode\'s debounce' }),
        g.deliver('mode.b', 'w12-mode', 'none', { tags: ['chat:ambient'], rule: 'set_channel_mode\'s debounce' }),
        g.fire('mode.fire', 61_000, ['mode.a', 'mode.b'], { addressed: false }),
        g.act('gc.limit', act('agent_settings', { action: 'update', channel_idle_limits: { 'w12-gc': GC_LIMIT } })),
        (() => {
          const s = g.deliver('gc.1', 'w12-gc', 'none', { rule: 'w12-gc' });
          return { ...s, messages: [{ ...s.messages[0], text: `${w.c('gc.1', 'in')} ${prose(GC_LIMIT + 500, `${w.id('gc.1')}:in`)}` }] };
        })(),
        ...(lifecycle ? [] : [g.act('gc.look', [{ name: 'channel_list', input: {} }])]),
        g.deliver('gc.after', 'w12-gc', 'none', { rule: lifecycle ? 'w12-gc, after the close' : 'w12-gc, its close refused' }),
        { ...g.deliver('gc.seen', CHANNEL, 'wake', { rule: 'default', ...(lifecycle ? { notice: 'subscription-gc' } : {}) }), namedAnywhere: true },
        ...note,
        g.act('ws.config', [{ name: 'workspace--write', input: { path: '_config/gate.json', content: `${JSON.stringify({ policies: w12Rules(has).map((r) => (r.name === 'w12-defer' ? { ...r, behavior: 'always' } : r)), default: 'always' }, null, 2)}\n` } }], { then: [[{ name: 'workspace--materialize', input: { path: '_config/gate.json' } }]] }),
        { id: w.id('ws.later'), segment: 'W12', kind: 'advance', ms: 2_000 },
        g.deliver('defer.after', 'w12-defer', 'wake', { rule: 'w12-defer, made always in gate.json' }),
        g.act('lessons', LESSONS.map((k) => ({ name: 'lessons--create', input: { content: `${lesson(k)}${k === STALE_LESSON ? ` ${STALE}` : ''} ${prose(300, `${w.id('lessons')}:${k}`)}`, tags: ['fixture'] } }))),
        g.deliver('recall.one', CHANNEL, 'wake', { rule: 'default', recall: { named: [lesson('a')], kept: [lesson('a')], lessons: LESSONS.map(lesson), filtered: false } }),
        g.deliver('recall.all', CHANNEL, 'wake', { rule: 'default', recall: { named: LESSONS.map(lesson), kept: LESSONS.filter((k) => k !== STALE_LESSON).map(lesson), lessons: LESSONS.map(lesson), filtered: true } }),
        g.act('remind', [{ name: 'heartbeat--reminder_add', input: { message: `${w.c('remind', 'note')} the fixture's reminder`, inSeconds: 600 } }]),
        g.timed('remind.fire', 601_000, 'the reminder', 'remind'),
        ...ticks,
        ...(suppression ? [g.reviewed('review', 1_800_000, 'w12-mute', ['mute.1', 'mute.2'], ['mute.2'])] : []),
        g.file('instr.gone', 'instructions/AGENTS.md', { remove: true }),
        g.deliver('instr.read', CHANNEL, 'wake', { rule: 'default' }),
        { id: w.id('instr.wait'), segment: 'W12', kind: 'advance', ms: 61_000 },
        g.file('instr.back', 'instructions/AGENTS.md', { text: INSTRUCTIONS }),
        g.deliver('instr.notice', CHANNEL, 'wake', { rule: 'default', ...(tier === 'silent' ? {} : { notice: 'host-notice', noticeForm: tier === 'reply' ? 'unanswered' : 'status' }) }),
        g.deliver('forged.chan', CHANNEL, 'wake', { rule: 'default', forged: `${FORGED} ${REWIND_OPENINGS}` }),
        ...(suppression ? [g.deliver('mute.text', CHANNEL, 'hidden', { rule: W12_MUTE_TEXT.name, mute: true })] : []),
        g.typed('console.1'),
        // connectome-host names the session at the third console message, which under H5 is console.2.
        g.typed('console.2', { forged: FORGED, mute: suppression, named: privately }),
        g.typed('console.3', { named: !privately }),
        ...privTick,
        ...historyTurns(g, w, { refused: privately }),
        ...(privately ? [privateSpawn(w, ctx)] : []),
        orphanTurn(w, ctx),
        g.act('subs.list', [{ name: 'subagent--list', input: {} }]),
        ...(privately ? [{ id: w.id('relist'), segment: 'W12', kind: 'relist', canaries: [] }] : []),
        ...(privately ? workspaceTurns(g, w) : []),
        ...(privately ? pairTurns(g, w) : []),
        ...(privately ? mixTurns(g, w) : []),
        { ...stalled(g.deliver('stall', CHANNEL, 'wake', { rule: 'default' })), stall: 'cut' },
        w.turn('end', { calls: 0 }),
      ];
    },
    check(run, ctx) {
      const steps = this.steps(ctx);
      const fates = gateFates(run, steps);
      const arrivals = arrivalFates(run, steps);
      const looks = run.records.filter((r) => r.kind === 'agent' && r.step === steps[0].id)[1];
      const out = [...fates, ...arrivals];
      const own = (s) => run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary' && r.step === s.id);
      const stalls = steps.filter((s) => s.stall);
      for (const s of stalls) {
        const flag = stallFlag(own(s), s.stall);
        if (flag) out.push({ step: s.id, message: flag });
      }
      const orphans = steps.filter((s) => s.orphan);
      const primaries = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
      const lifecycle = (r, last = false) => (last ? [r.messages?.at(-1)] : r.messages ?? []).flatMap((m) => m?.blocks ?? []).filter((b) => b.notice === 'Agent lifecycle').length;
      const facts = w12Facts(ctx.configuration);
      for (const s of orphans) {
        const [, answered] = own(s);
        const next = primaries.find((r) => steps.findIndex((x) => x.id === r.step) > steps.indexOf(s));
        if (!answered || !next) out.push({ step: s.id, message: `couldn't judge the orphan's notices: ${!answered ? 'no request answered the first subagent\'s result' : 'no request follows the step'}` });
        else if (!facts.announces) {
          const second = `w12-s2-${ctx.seed}`;
          const resident = ctx.configuration.agent?.name ?? FIXTURE_AGENT;
          const orphaned = run.log.find((e) => e.kind === 'ipc' && e.step === s.id && e.event?.type === 'dendrite:agent-orphaned' && spawnName(e.event.agentName) === second);
          const told = primaries.filter((r) => lifecycle(r));
          if (!orphaned || orphaned.event.candidates?.[0] !== resident) out.push({ step: s.id, message: `${orphaned ? `agent-framework offered ${second}'s orphaned work first to ${orphaned.event.candidates?.[0] ?? 'no one'}` : `agent-framework traced no orphaning of ${second}`} at the step, where its end orphans it with ${resident} first to adopt it, so dendrite.announceOrphans false has a notice to keep back` });
          else if (told.length) out.push({ step: s.id, message: `${told.map((r) => `request ${r.id} carries ${lifecycle(r)}`).join(', ')} [Agent lifecycle] notice(s), where dendrite.announceOrphans false tells the agent of no orphan` });
        } else if (!lifecycle(answered, true)) out.push({ step: s.id, message: `request ${answered.id}, which answers the first subagent's result, carries no [Agent lifecycle] notice in its last message, where its end orphans the second and offers it to the resident` });
        else if (lifecycle(next) !== 2) out.push({ step: s.id, message: `request ${next.id} carries ${lifecycle(next)} [Agent lifecycle] notice(s), where the adoption offer and the held result's notice make two` });
      }
      const searches = steps.filter((s) => s.history);
      for (const s of searches) {
        const [, searched, extracted] = own(s);
        const results = (r) => (r?.messages?.at(-1)?.blocks ?? []).filter((b) => b.type === 'tool_result');
        const carries = (r) => results(r).some((b) => (b.canaries ?? []).includes(s.history));
        if (!extracted) out.push({ step: s.id, message: `couldn't judge the history module's search and extract: ${own(s).length} request(s) at the step, where its opening and one after each of its two calls make three` });
        else if (!carries(searched)) out.push({ step: s.id, message: `request ${searched.id} carries the history search's result without the sent message ${s.history}` });
        else if (!carries(extracted)) out.push({ step: s.id, message: `request ${extracted.id} carries the history extract's text without the sent message ${s.history}` });
      }
      const at = (name) => steps.find((s) => s.id === `${ctx.seed}.${name}`)?.id;
      const ipc = (type) => run.log.filter((e) => e.kind === 'ipc' && e.event?.type === type);
      const noted = ipc('process:received').filter((e) => String(e.event.processEvent?.type ?? '').startsWith('workspace:') && (e.event.processEvent.paths ?? []).includes(NOTE_PATH));
      const noteAt = facts.watching === 'always' ? at('ws.note') : at('ws.scan');
      const added = ipc('message:added').filter((e) => String(e.event.source ?? '').startsWith('workspace:'));
      if (!noted.length) out.push({ step: at('ws.note'), message: `couldn't judge: ${NOTE_PATH}'s change reached the workspace at no step` });
      else if (noted[0].step !== noteAt) out.push({ step: at('ws.note'), message: `${NOTE_PATH}'s change reached the workspace at step ${noted[0].step}, where its mount's watch, ${facts.watching}, brings it at ${noteAt}` });
      else if (facts.wakeOps.includes('created') && !added.some((e) => e.step === noteAt)) out.push({ step: noteAt, message: `${NOTE_PATH}'s change added no message for the resident at its step, where wakeOnChange takes a created file` });
      else if (!facts.wakeOps.includes('created') && added.length) out.push({ step: added[0].step, message: `the workspace added a message for the resident at step ${added[0].step}, where wakeOnChange (${JSON.stringify(facts.wakeOps)}) takes no created file` });
      const closed = ipc('ops:alert').filter((e) => e.event.kind === 'subscription-gc-close');
      const resultOf = (step, tool) => ipc('process:received').find((e) => e.step === at(step) && e.event.processEvent?.type === 'tool-result' && e.event.processEvent.toolName === tool)?.event.processEvent.result;
      const moded = resultOf('mode.set', 'channel-mode--set_channel_mode');
      if (!moded) out.push({ step: at('mode.set'), message: 'couldn\'t judge: set_channel_mode\'s answer reached the host\'s trace at no step' });
      else if (facts.lifecycle && !moded.success) out.push({ step: at('mode.set'), message: `set_channel_mode answered that it failed (${moded.data?.message ?? moded.error ?? 'no words'}), where the fixture server directs its channels' lifecycle, so opening w12-mode and each step succeed` });
      else if (!facts.lifecycle) {
        const steps = moded.data?.steps ?? [];
        const refusedOpen = steps.length > 0 && steps.every((x) => x.ok === (x.step !== 'open')) && steps.some((x) => x.step === 'open');
        const why = 'where on a fixture server that doesn\'t direct its channels\' lifecycle opening w12-mode fails and the channel is only partly in debounced mode';
        if (moded.success) out.push({ step: at('mode.set'), message: `set_channel_mode answered that every step succeeded, ${why}` });
        else if (moded.data?.channelId !== 'w12-mode') out.push({ step: at('mode.set'), message: `set_channel_mode answered "${moded.data?.message ?? moded.error ?? ''}" about ${moded.data?.channelId ?? 'no channel'}, ${why}` });
        else if (!refusedOpen || !/only partly in debounced mode/.test(moded.data?.message ?? '')) out.push({ step: at('mode.set'), message: `set_channel_mode answered "${moded.data?.message ?? moded.error ?? ''}" with its steps ${steps.map((x) => `${x.step} ${x.ok ? 'ok' : 'failed'}`).join(', ') || 'unnamed'}, ${why}` });
      }
      const list = facts.lifecycle ? null : resultOf('gc.look', 'channel_list')?.data;
      if (!facts.lifecycle) {
        const listed = Array.isArray(list) ? list.find((c) => c.id === 'w12-gc') : undefined;
        const gcNoted = run.records.filter((r) => r.kind === 'agent' && (r.messages ?? []).some((m) => m.blocks.some((b) => b.notice === 'subscription-gc')));
        if (!Array.isArray(list)) out.push({ step: at('gc.look'), message: 'couldn\'t judge: channel_list\'s answer at gc.look reached the host\'s trace at no step, or listed no channels' });
        else if (!listed || listed.open !== true || listed.desired !== 'closed') out.push({ step: at('gc.look'), message: `channel_list ${listed ? `shows w12-gc open: ${listed.open}, desired: ${listed.desired}` : 'names no w12-gc'}, where subscription-gc's close is decided and the server, directing no lifecycle, keeps the channel open` });
        if (closed.length) out.push({ step: closed[0].step, message: `subscription-gc raised its close alert ${closed.length} time(s), where on a server that doesn't direct its channels' lifecycle no close goes through` });
        for (const r of gcNoted) out.push({ step: r.step, message: `request ${r.id} carries a [subscription-gc] note, where no close went through to note` });
      } else if (closed.length !== 1 || closed[0].step !== at('gc.1') || closed[0].event.data?.channelId !== 'w12-gc') out.push({ step: at('gc.1'), message: `subscription-gc closed a channel ${closed.length} time(s)${closed.length ? `, ${closed.map((e) => `${e.event.data?.channelId ?? 'one it doesn\'t name'} at ${e.step}`).join(', ')}` : ''}, where the message passing w12-gc's own limit closes w12-gc once, at its step` });
      if (facts.judgeOff) {
        const asked = run.records.filter((r) => r.kind === 'judge');
        if (asked.length) out.push({ step: asked[0].step, message: `${asked.map((r) => r.id).join(', ')} went to the reply judge, where with the judge off no batch goes to it` });
      }
      if (facts.tier === 'silent') {
        const outage = ['instr.gone', 'instr.read', 'instr.wait'].map(at);
        if (!ipc('ops:alert').some((e) => e.event.kind === 'instructions-unavailable' && outage.includes(e.step))) out.push({ step: at('instr.gone'), message: 'the host raised no instructions-unavailable alert between the instructions\' removal and their return, so the silent tier had no notice to keep from the resident' });
        for (const r of run.records.filter((x) => x.kind === 'agent' && (x.messages ?? []).some((m) => m.blocks.some((b) => b.notice === 'host-notice')))) out.push({ step: r.step, message: `request ${r.id} carries a [host-notice] line, where the silent tier for instructions-unavailable tells the agent nothing` });
      }
      if (!looks) out.push({ step: steps[0].id, message: 'couldn\'t judge: no request answered the settings toolset\'s listing' });
      else if (!(looks.answer?.toolUseIds ?? []).length) out.push({ step: steps[0].id, message: `request ${looks.id} answered the settings toolset's listing with no look, so the listing named no tool` });
      return withJudged(out, fates.judged + arrivals.judged + stalls.length + searches.length + orphans.length + (looks ? 1 : 0) + (noted.length ? 1 : 0) + (facts.lifecycle || Array.isArray(list) ? 1 : 0) + (moded ? 1 : 0) + (facts.tier === 'silent' ? 1 : 0) + (facts.judgeOff ? 1 : 0));
    },
  },

  W14: {
    from: 'checkpoint',
    fromEmpty: (variant, setup) => setup === 'H1b',
    compresses: (variant, setup) => setup !== 'H1b',
    property: 'arrivals: each message or result that arrives while a turn is alive is first carried by the request its presentation point gives, and by none before it: one at the turn\'s end by its wake turn\'s first request, after the turn\'s final reply; one at a boundary by the request after it, after the round\'s results, and one addressed from another channel with its routing notice',
    needs: { subagents: true },
    steps(ctx) {
      const w = writer(ctx, 'W14');
      const arrival = (step, part, more = {}) => ({ id: `${w.id(step)}.${part}`, participant: 'Tavy', text: `${w.c(step, `${part}.in`)} ${prose(w.between(SIZES.user), `${w.id(step)}:${part}`)}`, ...more });
      const holdCall = (t, round, during) => {
        const { calls } = t.replies[round];
        const call = calls.at(-1);
        calls[calls.length - 1] = { ...call, input: { ...call.input, hold: true }, during };
        return call.input.canary;
      };
      const steps = [];

      const end = w.turn('end', { more: { namedAnywhere: true } });
      const a1 = arrival('end', 'a1');
      end.replies[1] = { ...end.replies[1], hold: true, during: [{ deliver: a1 }] };
      end.replies.push({ text: `${w.c('end', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('end')}:r3`)}` });
      end.canaries.push(w.c('end', 'a1.in'));
      end.arrivals = [{ canary: w.c('end', 'a1.in'), point: 'end', after: w.c('end', 'r2'), message: a1.id }];
      steps.push(end);

      if (ctx.configurationName === 'H1b') {
        const side = w.turn('side', { more: { namedAnywhere: true } });
        const a3 = arrival('side', 'a3', { participant: 'Wren', channel: SIDE, tags: ['chat:addressed'] });
        const after = holdCall(side, 0, [{ deliver: a3 }]);
        side.replies.push({ text: `${w.c('side', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('side')}:r3`)}` });
        side.canaries.push(w.c('side', 'a3.in'));
        side.arrivals = [{ canary: w.c('side', 'a3.in'), point: 'boundary', after, routing: true, message: a3.id }];
        steps.push(side);
        return steps;
      }

      steps.push(w.other('break.budget', 'command', { command: '/budget 1' }));
      const brk = w.turn('break', { rounds: 2 });
      const a2 = arrival('break', 'a2');
      const breakAfter = holdCall(brk, 1, [{ deliver: a2 }]);
      brk.canaries.push(w.c('break', 'a2.in'));
      brk.spare = [{ text: `${w.c('break', 'spare')} ${prose(200, `${w.id('break')}:spare`)}` }];
      brk.arrivals = [{ canary: w.c('break', 'a2.in'), point: 'boundary', after: breakAfter, message: a2.id }];
      steps.push(brk);
      steps.push(w.other('break.restore', 'command', { command: `/budget ${ctx.streamBound}` }));

      const sub = w.turn('sub', { more: { namedAnywhere: true } });
      const name = `w14-${ctx.seed}`;
      const marker = `[[w14-sub:${ctx.seed}]]`;
      const subAfter = holdCall(sub, 0, [{ agentEnd: name }]);
      sub.replies[0].calls.unshift({ name: 'subagent--spawn', input: { name, systemPrompt: `${marker} You are the fixture's subagent.`, task: `${w.c('sub', 'task')} ${prose(w.between(SIZES.user), `${w.id('sub')}:task`)}` } });
      sub.subs = [{ marker, canaries: [w.c('sub', 'task')], replies: [{ text: `${w.c('sub', 's1')} ${prose(w.between(SIZES.reply), `${w.id('sub')}:s1`)}` }] }];
      sub.replies.push({ text: `${w.c('sub', 'r3')} ${prose(w.between(SIZES.reply), `${w.id('sub')}:r3`)}` });
      sub.arrivals = [{ canary: w.c('sub', 's1'), point: 'boundary', after: subAfter, agent: name }];
      steps.push(sub);

      steps.push(w.other('topic', 'command', { command: '/newtopic' }));
      return steps;
    },
    check(run, ctx) {
      return arrivalFates(run, this.steps(ctx));
    },
  },

  W15: {
    from: null,
    compresses: false,
    property: 'reader: the reader\'s read after a /restore doesn\'t carry the row stored between its checkpoint and the restore; its read after a restart, on the branch /checkout went back to, carries the row that branch holds and not the one the restore\'s branch holds; a row suppressed through the Web UI is in none of its later reads; and its read after the restart starts where its read before it started',
    needs: { webui: true },
    recipe: { fixtureSend: true, modules: { history: true } },
    steps(ctx) {
      const w = writer(ctx, 'W15');
      const command = (step, text) => w.other(step, 'command', { command: text });
      const h2 = w.c('h2', 'in');
      const side = w.turn('side', { calls: 0, more: { channel: SIDE_W15, namedAnywhere: true } });
      side.replies = [
        { text: `${w.c('side', 'r1')} ${prose(200, `${w.id('side')}:r1`)}`, calls: [{ name: 'mcpl--fixture--send_message', input: { channelId: CHANNEL, content: `${w.c('side', 'sent')} ${prose(300, `${w.id('side')}:sent`)}` } }] },
        { text: `${w.c('side', 'r2')} ${prose(200, `${w.id('side')}:r2`)}`, calls: [{ name: 'history--search', input: { query: h2 } }] },
        { text: `${w.c('side', 'r3')} ${prose(200, `${w.id('side')}:r3`)}` },
      ];
      return [
        w.turn(1),
        tuneOut(w),
        readerRead(w, 1),
        command('checkpoint', '/checkpoint w15'),
        { id: w.id('h2'), segment: 'W15', kind: 'deliver', topic: 'W15', messages: [{ channel: CHANNEL, id: w.id('h2'), participant: 'Tavy', text: `${h2} ${prose(w.between(SIZES.user), `${w.id('h2')}:in`)}`, held: true }], canaries: [h2], tunedOut: [h2] },
        command('restore', '/restore w15'),
        readerRead(w, 3),
        command('back', '/checkout main'),
        w.other('suppress', 'suppress', { messages: [{ canary: w.c('h1', 'in') }] }),
        side,
        w.other('restart', 'restart', {}),
        readerRead(w, 4),
      ];
    },
    check(run, ctx) {
      return readerWindows(run, this.steps(ctx), ctx.seed);
    },
  },

  W16: {
    from: null,
    compresses: false,
    owns: [{ check: 1, what: 'hard-down' }, { check: 1, what: HISTORY_KEPT.kind }],
    property: 'rewind: a turn whose request carrying its call\'s result the model refuses, the third of three turns the model API refuses as invalid, and an unstick whose turn the model refuses each shed the newest exchange and retry, not replay: each failed request is followed, at the same step, by a request that carries one more rewind marker and the shed message nowhere, the refused call\'s turn keeping its own message, and no turn before the third invalid one is retried, nor raises the breaker\'s hard-down alert, which the third raises; a turn whose answer the channel refuses to post is followed by a request telling the resident so; and where the breaker probes before it sheds, three more invalid turns trip it again and its probe, failing as the request did, keeps the history: the breaker sends the probe, queues no retry, raises one history-kept alert keyed fails-without-history and a hard-down alert at that third failure, and the next turn\'s request carries all three turns\' messages and as many rewind markers as the failed request',
    steps(ctx) {
      const w = writer(ctx, 'W16');
      // agent-framework's rewind takes the newest exchange the refused request carried out of the agent's window and
      // stores its marker, `[refusal-rewind] The N most recent turn(s) were set aside …` or, under its later tag,
      // `[turns-set-aside] The …` (framework.ts shedNewestTurn, updateRewindMarker). The stand-in refuses the request
      // carrying `refuse`'s call result, and the rewind sheds that result with the call's turn, keeping the message.
      // The stand-in knows the retry by the marker.
      const refused = w.turn('refuse', { calls: 0, more: { also: REWIND_MARKS, namedAnywhere: true } });
      const [round, call] = [w.c('refuse', 'r0'), w.c('refuse', 'call1')];
      refused.canaries = [...refused.canaries, call];
      refused.replies = [{ text: `${round} ${prose(1200, `${w.id('refuse')}:r0`)}`, calls: [{ name: TOOL, input: { kind: 'prose', size: 3000, canary: call } }] }, { stop: 'refusal' }, ...refused.replies];
      refused.sheds = [round];
      const breaker = BREAKER_STEPS.map((id, i) => {
        const last = i === BREAKER_STEPS.length - 1;
        const t = w.turn(id, { calls: 0, more: { mayFail: true, also: REWIND_MARKS, namedAnywhere: true, ...(last ? { sheds: [w.c(id, 'in')] } : {}) } });
        const [reply] = t.replies;
        t.replies = [{ error: INVALID }, ...(last ? [reply] : [])];
        if (!last) t.spare = [reply];
        if (last) Object.assign(t, { probe: { text: 'Word.' }, awaits: PROBED });
        return t;
      });
      const keeps = capable(ctx.capabilities)('kept-history') ? [...KEEP_STEPS.map((id, i) => {
        const t = w.turn(id, { calls: 0, more: { mayFail: true, also: REWIND_MARKS, namedAnywhere: true } });
        t.spare = t.replies;
        t.replies = [{ error: INVALID }];
        if (i === KEEP_STEPS.length - 1) Object.assign(t, { probe: { error: INVALID }, awaits: PROBED });
        return t;
      }), w.turn('kept', { calls: 0 })] : [{ id: w.id('absent.kept-history'), segment: 'W16', kind: 'absent', stretch: 'kept-history', canaries: [] }];
      // agent-framework's `unstick` host command queues a turn on the agent's context as it stands, with no message of
      // its own, and sheds only when the model refuses that turn (framework.ts handleHostCommand, the refusal's
      // `forced` rewind). The stand-in knows the turn by a rewind marker an earlier step left, and refuses it once.
      const unstick = w.other('unstick', 'host', {
        host: { command: 'unstick', channelId: CHANNEL }, inputs: [], canaries: [], also: REWIND_MARKS, namedAnywhere: true, sheds: [w.c(BREAKER_STEPS.at(-1), 'r1')],
        replies: [{ stop: 'refusal' }, { text: `${w.c('unstick', 'r1')} ${prose(w.between(SIZES.reply), `${w.id('unstick')}:r1`)}` }],
      });
      const failed = w.turn('failpub', { calls: 0, more: { failsPublish: true } });
      failed.replies = [{ ...failed.replies[0], text: `${failed.replies[0].text} ${FAIL_PUBLISH}` }];
      // Console input before the refused turn, so the turns after it, the unstick's among them, follow private input
      // (agent-framework#190's operator turns).
      const con = { id: w.id('pre.con'), segment: 'W16', kind: 'console', text: `${w.c('pre.con', 'in')} ${prose(w.between(SIZES.user), `${w.id('pre.con')}:in`)}`, canaries: [w.c('pre.con', 'in')], addressed: false, namedAnywhere: true, replies: [{ text: `${w.c('pre.con', 'r1')} ${prose(200, `${w.id('pre.con')}:r1`)}`, calls: [{ name: 'skip_reply', input: {} }] }] };
      return [w.turn(1, { calls: 0 }), con, refused, w.turn('after', { calls: 0 }), ...breaker, unstick, failed, w.turn('told', { calls: 0 }), ...keeps];
    },
    check(run, ctx) {
      const out = [];
      let judged = 0;
      const at = (id) => run.records.filter((r) => r.step === `${ctx.seed}.${id}` && (r.kind === 'unclassified' || (r.kind === 'agent' && (r.agent ?? 'primary') === 'primary')));
      const markers = (r) => (r.messages ?? []).flatMap((m) => m.blocks ?? []).filter((b) => REWIND_NOTICES.includes(b.notice)).length;
      const carries = (r, c) => (r.messages ?? []).some((m) => (m.blocks ?? []).some((b) => (b.canaries ?? []).includes(c)));
      const rewound = (id, failed, last, { shed = [canary(ctx.seed, id, 'in')], what = 'the shed turn\'s message', kept = null } = {}) => {
        const step = `${ctx.seed}.${id}`;
        const retry = at(id).find((r) => r.seq > last.seq);
        if (!retry) return out.push({ step, message: `couldn't judge: no request at this step followed the ${failed} ${last.id}` });
        judged++;
        const lacks = shed.filter((c) => !carries(last, c));
        if (lacks.length) return out.push({ step, message: `request ${last.id}, the one ${failed} at this step, lacks ${lacks.join(' ')}, which its rewind is to shed, so its retry isn't judged` });
        if (markers(retry) !== markers(last) + 1) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, carries ${markers(retry)} rewind marker(s) where ${last.id} carried ${markers(last)}, and the rewind adds one` });
        const still = shed.filter((c) => carries(retry, c));
        if (still.length) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, still carries ${what} ${still.join(' ')}: it was replayed, not shed` });
        if (kept && !carries(retry, kept)) out.push({ step, message: `request ${retry.id}, the next after the ${failed} ${last.id}, no longer carries the turn's message ${kept}, which a rewind that sheds the turn's call and its result keeps` });
      };
      const refusals = at('refuse').filter((r) => r.answer?.stop === 'refusal');
      if (!refusals.length) out.push({ step: `${ctx.seed}.refuse`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
      else {
        if (refusals.length > 1) out.push({ step: `${ctx.seed}.refuse`, message: `${refusals.length} requests at this step were answered with a refusal, where the stand-in refuses once: the refusal was replayed` });
        rewound('refuse', 'refused', refusals.at(-1), { shed: [canary(ctx.seed, 'refuse', 'r0'), canary(ctx.seed, 'refuse', 'call1')], what: 'the shed call\'s round', kept: canary(ctx.seed, 'refuse', 'in') });
      }
      const keeps = capable(ctx.capabilities)('kept-history');
      const keptAt = `${ctx.seed}.${KEEP_STEPS.at(-1)}`;
      const keptAlerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === HISTORY_KEPT.kind);
      for (const e of keptAlerts) {
        if (!keeps || e.step !== keptAt || e.event.data?.probe !== HISTORY_KEPT.verdict) out.push({ step: e.step, message: `a ${HISTORY_KEPT.kind} alert keyed ${e.event.data?.probe ?? 'by nothing'} at this step, other than the one a probe failing as the request did raises at the third failure of the kept-history turns: ${e.event.message ?? ''}`.trim() });
      }
      const probed = (step, failed) => run.records.find((r) => r.step === step && r.kind === 'probe' && r.seq > failed.seq);
      const kept = (id, failed) => {
        const step = `${ctx.seed}.${id}`;
        if (!probed(step, failed)) out.push({ step, message: `no probe reached the stand-in at this step after the failed ${failed.id}, where a breaker that raises ${HISTORY_KEPT.kind} sends the failed request without its history before it sheds` });
        judged++;
        const next = at(id).find((r) => r.seq > failed.seq);
        if (next) out.push({ step, message: `request ${next.id} followed the failed ${failed.id} at this step, where a probe that fails as the request did keeps the history and queues no retry` });
        const n = keptAlerts.filter((e) => e.step === step && e.event.data?.probe === HISTORY_KEPT.verdict).length;
        if (n !== 1) out.push({ step, message: `${n} ${HISTORY_KEPT.kind} alert(s) keyed ${HISTORY_KEPT.verdict} at this step, where a probe that fails as the request did raises one` });
        const turn = at('kept')[0];
        if (!turn) return out.push({ step: `${ctx.seed}.kept`, message: `couldn't judge: no request at this step, after the third failure in a row at ${step}` });
        const lost = KEEP_STEPS.map((k) => canary(ctx.seed, k, 'in')).filter((c) => !carries(turn, c));
        if (lost.length) out.push({ step: turn.step, message: `request ${turn.id}, the first after the third failure in a row at ${step}, lacks ${lost.join(' ')}, which a kept history still holds` });
        if (markers(turn) !== markers(failed)) out.push({ step: turn.step, message: `request ${turn.id}, the first after the third failure in a row at ${step}, carries ${markers(turn)} rewind marker(s) where ${failed.id} carried ${markers(failed)}, and a kept history adds none` });
      };
      const streaks = [BREAKER_STEPS, ...(keeps ? [KEEP_STEPS] : [])];
      for (const steps of streaks) {
        steps.forEach((id, i) => {
          const step = `${ctx.seed}.${id}`;
          const mine = at(id);
          const failed = mine.find((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status);
          if (!failed) return out.push({ step, message: `couldn't judge: no request at this step was answered with the stand-in's ${INVALID.status}` });
          if (i === steps.length - 1 && steps === KEEP_STEPS) return kept(id, failed);
          if (i === steps.length - 1) {
            rewound(id, 'failed', failed);
            if (!keeps) return;
            judged++;
            const probe = probed(step, failed);
            const retry = mine.find((r) => r.seq > failed.seq);
            if (!probe) out.push({ step, message: `no probe reached the stand-in at this step after the failed ${failed.id}, where a breaker that raises ${HISTORY_KEPT.kind} sends the failed request without its history before it sheds` });
            else if (retry && retry.seq < probe.seq) out.push({ step, message: `request ${retry.id} came after the failed ${failed.id} and before its probe, where a breaker that raises ${HISTORY_KEPT.kind} sheds and retries only once its probe is answered` });
            return;
          }
          judged++;
          const next = mine.find((r) => r.seq > failed.seq);
          if (next) out.push({ step, message: `request ${next.id} followed the failed ${failed.id} at this step, where the breaker waits for the third failure in a row` });
        });
      }
      const trips = streaks.map((steps) => `${ctx.seed}.${steps.at(-1)}`);
      const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'hard-down')
        .reduce((m, e) => m.set(e.step, (m.get(e.step) ?? 0) + 1), new Map());
      const tripped = streaks.filter((steps) => at(steps.at(-1)).some((r) => r.answer?.shape === 'error' && r.answer.status === INVALID.status)).map((steps) => `${ctx.seed}.${steps.at(-1)}`);
      judged += tripped.length;
      for (const step of new Set([...alerts.keys(), ...tripped])) {
        const n = alerts.get(step) ?? 0;
        if (trips.includes(step) && n !== 1) out.push({ step, message: `${n} hard-down alert(s) at this step, where the breaker's trip at the third failure in a row raises one` });
        if (!trips.includes(step)) out.push({ step, message: `${n} hard-down alert(s) at this step, where no streak of failures reaches its third` });
      }
      const unstuck = at('unstick').filter((r) => r.answer?.stop === 'refusal');
      if (!unstuck.length) out.push({ step: `${ctx.seed}.unstick`, message: 'couldn\'t judge: no request at this step was answered with a refusal' });
      else rewound('unstick', 'refused', unstuck.at(-1), { shed: [canary(ctx.seed, BREAKER_STEPS.at(-1), 'r1')] });
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
  W13: {
    from: null,
    compresses: false,
    property: 'turn endings: each turn\'s speech meets the fate its setup documents: its `[delivered]` receipt, in the next request, names where it landed (its channel, the hybrid envelope\'s channel beside it, the lock once the agent moves it, the latest inbound channel for a self-wake under latest-inbound), or says it stayed in the transcript (disabled) or was held as drafts (locked, before a move), and explicit mode writes none; disabled routing writes no `[routing]` row; a self-wake with no locus is told its reply had no channel; explicit mode bounces unprefixed prose and an unknown target with a notice each, and hybrid an envelope naming no channel; a turn whose speech moves to an inbound-only channel has its post there refused once; the text beside a private think() writes no receipt; under autoContinue a turn the model ends itself is followed by one continuation and a turn ended by skip_reply or a refusal by none; the guard contains a whole-response tool wrapper, which no later request carries and whose place a tool-boundary row takes, and without it the wrapper is ordinary history; a refusal is replayed whole once where retries allow and otherwise ends its turn with no other request; a held call the inference bound cuts is sent again once with the same messages, and with no bounds its own reply answers it; under H1, where the fresh call is held too, both are cut with the same messages and the next request carries the turn\'s [inference-failed] note naming the host\'s setting for that bound; a 529 under the retry setup is sent again; and under conversations one fork makes every request; and with no gate, skip_reply\'s wake_in_seconds is refused, its turn going on to its next call, and no request comes where the self-wake would have; and under latest-inbound no request comes at the first held push, and the push a batch turn\'s held reply lets arrive is first carried by the request after that reply\'s call, after the call\'s result',
    recipe: () => ({ modules: { wake: { policies: [W13_QUIET_RULE, W13_HELD_PUSH_RULE], default: 'always' } } }),
    steps(ctx) {
      const w = writer(ctx, 'W13');
      const agent = ctx.configuration.agent ?? {};
      const mode = agent.proseRouting ?? 'locus';
      const explicit = mode === 'explicit';
      const continues = agent.autoContinue === true || (typeof agent.autoContinue === 'object' && agent.autoContinue !== null);
      const forks = Boolean(ctx.configuration.recipe?.conversations);
      const latest = ctx.configuration.recipe?.speech?.locus === 'latest-inbound';
      const guarded = agent.toolWrapperProseGuard === true;
      const replayed = (agent.refusalHandling?.retries ?? 0) > 0;
      const bounded = ctx.configuration.recipe?.inferenceBounds !== false;
      const gated = ctx.configuration.modules?.wake !== false;
      const side = forks ? CHANNEL : W13_SIDE;
      // Under `locked` with no `proseLock`, plain speech is held as drafts until the agent's `prose_locus` moves it, and
      // then goes where it points, whichever channel woke the turn (agent-framework docs/locked-prose-routing.md).
      let locked = mode === 'locked' && agent.proseLock === undefined;
      let lockedTo = null;
      const said = (step, k, size = 300) => `${w.c(step, `r${k}`)} ${prose(size, `${w.id(step)}:r${k}`)}`;
      // Explicit mode delivers only prose a `>>` target opens (docs/explicit-prose-routing.md), as a resident there
      // writes it.
      const to = (channel, text) => (explicit ? `>>#${channel} ${text}` : text);
      const held = () => (locked ? { drafts: 'no-destination' } : {});
      // Where a turn's plain speech lands, as its `[delivered]` receipt says (framework.ts appendProseDeliveryReceipt):
      // explicit mode's envelopes acknowledge themselves and write no receipt, disabled mode keeps the words in the
      // transcript, and a lock to drafts holds them.
      const lands = (...channels) => (explicit ? { receipt: null }
        : mode === 'disabled' ? { receipt: { to: [], transcript: true } }
          : locked ? { receipt: { to: [], held: true } }
            : { receipt: { to: lockedTo ? [lockedTo] : channels } });
      // A turn the model ends itself continues under autoContinue, whose `[continue]` row the stand-in answers with
      // skip_reply (docs/auto-continue.md).
      const closing = (t) => (continues ? { ...t, also: [...(t.also ?? []), CONTINUE_ROW], replies: [...t.replies, { calls: [{ name: 'skip_reply', input: {} }] }], fate: { ...t.fate, continues: true } } : t);
      const turn = (step, channel, replies, fate, more = {}) => ({ ...w.turn(step, { calls: 0, more: { channel, ...held(), ...more } }), replies, fate: { continues: false, ...fate } });
      const steps = [];
      steps.push(closing(turn('end', CHANNEL, [{ text: to(CHANNEL, said('end', 1)) }], lands(CHANNEL))));
      // A send to the turn's own channel holds the round's words and the closing words after it as drafts, and the
      // continuation's row then says closing words were held (framework.ts sendHoldAt, auto-continue.ts).
      if (continues) {
        steps.push(closing(turn('sent', CHANNEL, [
          { text: said('sent', 1), calls: [{ name: 'channel_publish', input: { channelId: CHANNEL, content: `${w.c('sent', 'pub')} ${prose(200, `${w.id('sent')}:pub`)}` } }] },
          { text: said('sent', 2) },
        ], { receipt: { to: [], held: true } }, { namedAnywhere: true, drafts: 'explicit-send' })));
      }
      if (agent.retry) {
        const busy = turn('overloaded', side, [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, { text: to(side, said('overloaded', 1)) }], { ...lands(side), overloaded: true }, { retries: true });
        steps.push(closing(busy));
      }
      const wrapper = `<${TOOL}>${said('wrapper', 1)}</${TOOL}>`;
      steps.push(guarded
        ? turn('wrapper', CHANNEL, [{ text: wrapper }], { wrapper: 'contained' }, { ends: 'contained' })
        : closing(turn('wrapper', CHANNEL, [{ text: to(CHANNEL, wrapper) }], { ...lands(CHANNEL), wrapper: 'kept' })));
      // Explicit mode reads the `>>>#chat` line as the target `>#chat`, which names no channel.
      const lines = [said('routed', 1), `>>#${CHANNEL} ${prose(200, `${w.id('routed')}:explicit`)}`, `>>>#${CHANNEL} ${prose(200, `${w.id('routed')}:hybrid`)}`].join('\n\n');
      const routedFate = explicit ? { receipt: null, bounces: 2 } : mode === 'hybrid' && !forks ? lands(side, CHANNEL) : lands(side);
      const routed = turn('routed', side, [{ text: lines }], routedFate, explicit ? { drafts: 'bounced', also: [BOUNCE_NOTICE] } : {});
      if (explicit) routed.replies = [...routed.replies, { text: `>>#${side} {{unsent}}` }];
      steps.push(closing(routed));
      steps.push(turn('think', CHANNEL, [
        { text: to(CHANNEL, said('think', 1)), calls: [{ name: 'think', input: { content: prose(200, `${w.id('think')}:thought`) } }] },
        { calls: [{ name: 'skip_reply', input: {} }] },
      ], agent.sameRoundThinkTextPolicy === 'private' ? { receipt: null } : lands(CHANNEL), { namedAnywhere: true, ends: 'unspoken' }));
      const stall = bounded
        ? stalled(turn('stall', CHANNEL, [{ text: to(CHANNEL, said('stall', 1)) }], { ...lands(CHANNEL), stall: 'cut' }))
        : turn('stall', CHANNEL, [{ text: to(CHANNEL, said('stall', 1)), hold: true, during: [{ advance: BEFORE_CONTENT_MS }] }], { ...lands(CHANNEL), stall: 'waited' });
      steps.push(closing(stall));
      if (bounded && ctx.configurationName === 'H1') steps.push(turn('stall.failed', CHANNEL, [cutByBound(), cutByBound('ends')], { stall: 'failed', receipt: null }, { mayFail: true, retries: true }));
      // A refusal nothing replays ends its turn with nothing sent and nothing stored.
      const refused = turn('refuse', side, [{ stop: 'refusal' }], replayed ? { refused: 'replayed', ...lands(side) } : { refused: 'ended', receipt: null }, replayed ? {} : { ends: 'unspoken' });
      if (replayed) refused.replies = [...refused.replies, { text: to(side, said('refuse', 1)) }];
      else refused.spare = [{ text: said('refuse', 1) }];
      // A refused turn doesn't continue (docs/auto-continue.md), so only its replay's turn would.
      steps.push(replayed ? closing(refused) : refused);
      if (mode === 'locked') {
        // What the agent writes in the round that moves the lock goes where speech went before it (the doc's
        // `prose_locus`), so the receipt names the lock and the draft beside it.
        steps.push(turn('lock', CHANNEL, [
          { text: said('lock', 1), calls: [{ name: 'prose_locus', input: { to: `#${CHANNEL}` } }] },
          { text: said('lock', 2) },
        ], { receipt: { to: [CHANNEL], held: true } }, { namedAnywhere: true }));
        locked = false;
        lockedTo = CHANNEL;
        steps.push(turn('locked', side, [{ text: said('locked', 1) }], lands(side)));
      }
      if (!forks && !gated) {
        steps.push(turn('skip', CHANNEL, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }, { calls: [{ name: 'skip_reply', input: {} }] }], { receipt: null, wakeRefused: true }, { ends: 'unspoken', namedAnywhere: true }));
        steps.push({ id: w.id('ambient'), segment: 'W13', kind: 'deliver', topic: 'W13', messages: [{ channel: W13_QUIET, id: w.id('ambient'), participant: 'Ash', text: `${w.c('ambient', 'in')} ${prose(300, `${w.id('ambient')}:in`)}` }], canaries: [w.c('ambient', 'in')], replies: [{ text: said('ambient', 1) }], fate: { continues: false, ...lands(W13_QUIET) } });
        steps.push({ id: w.id('skip.wake'), segment: 'W13', kind: 'advance', ms: 121_000, fate: { none: 'with no gate no self-wake was set to wake the agent' } });
      }
      if (!forks && gated) {
        steps.push(turn('skip', CHANNEL, [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }], { receipt: null }, { ends: 'unspoken' }));
        steps.push({ id: w.id('ambient'), segment: 'W13', kind: 'deliver', topic: 'W13', messages: [{ channel: W13_QUIET, id: w.id('ambient'), participant: 'Ash', text: `${w.c('ambient', 'in')} ${prose(300, `${w.id('ambient')}:in`)}` }], canaries: [w.c('ambient', 'in')], spare: [{ text: said('ambient', 1) }] });
        // A self-wake has no channel of its own: under `delivery` locus and hybrid modes its reply has none to go to,
        // and under `latest-inbound` it lands where the latest message came from.
        const wakeFate = latest ? lands(W13_QUIET) : (mode === 'locus' || mode === 'hybrid') ? { undeliverable: true } : lands(CHANNEL);
        steps.push(closing({ id: w.id('skip.wake'), segment: 'W13', kind: 'advance', ms: 121_000, canaries: [w.c('skip', 'in')], namedAnywhere: true, inputs: [], addressed: false, ...held(), replies: [{ text: to(CHANNEL, said('skip.wake', 1)) }], fate: { continues: false, ...wakeFate } }));
      }
      if (latest && !forks) {
        steps.push({ id: w.id('push'), segment: 'W13', kind: 'push', channel: W13_PUSH, participant: 'Wren', tags: ['chat:addressed'], text: `${w.c('push', 'in')} ${prose(300, `${w.id('push')}:in`)}`, canaries: [w.c('push', 'in')], namedAnywhere: true, replies: [{ calls: [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }] }], fate: { continues: false, receipt: null } });
        steps.push(closing({ id: w.id('push.wake'), segment: 'W13', kind: 'advance', ms: 121_000, canaries: [w.c('push', 'in')], namedAnywhere: true, inputs: [], addressed: false, replies: [{ text: said('push.wake', 1) }], fate: { continues: false, ...lands(W13_QUIET) } }));
        const repin = turn('repin', CHANNEL, [
          { text: said('repin', 1), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c('repin', 'call1') } }], hold: true, during: [{ deliver: { channel: W13_FEED, id: `${w.id('repin')}.feed`, participant: 'Ash', text: `${w.c('repin', 'feed.in')} ${prose(300, `${w.id('repin')}:feed.in`)}`, tags: ['chat:addressed'] } }] },
          { text: said('repin', 2) },
        ], { ...lands(CHANNEL), sendFailed: true }, { namedAnywhere: true, failsPublish: true });
        repin.spare = [{ calls: [{ name: 'skip_reply', input: {} }] }];
        repin.canaries.push(w.c('repin', 'feed.in'), w.c('repin', 'call1'));
        steps.push(closing(repin));
        const pushed = (step, part) => `${w.c(step, part)} ${HELD_PUSH} ${prose(300, `${w.id(step)}:${part}`)}`;
        const skip = [{ calls: [{ name: 'skip_reply', input: {} }] }];
        const again = { channel: W13_PUSH, id: `${w.id('held.wake')}.push`, participant: 'Ash', tags: UNOPENED_AMBIENT, text: pushed('held.wake', 'push.in') };
        steps.push({ id: w.id('held'), segment: 'W13', kind: 'push', channel: W13_PUSH, participant: 'Ash', tags: UNOPENED_AMBIENT, text: pushed('held', 'in'), canaries: [w.c('held', 'in')], spare: skip, fate: { none: 'the held-push rule holds it until its window ends' } });
        steps.push({
          id: w.id('held.wake'), segment: 'W13', kind: 'advance', ms: 31_000, canaries: [w.c('held', 'in'), w.c('held.wake', 'push.in'), w.c('held.wake', 'call1')], namedAnywhere: true, inputs: [w.c('held', 'in')], addressed: false,
          replies: [{ calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: w.c('held.wake', 'call1') } }], hold: true, during: [{ push: again }] }, ...skip],
          fate: { continues: false, receipt: null },
          arrivals: [{ canary: w.c('held.wake', 'push.in'), point: 'boundary', after: w.c('held.wake', 'call1'), push: true, message: again.id }],
        });
        steps.push({ id: w.id('held.again'), segment: 'W13', kind: 'advance', ms: 31_000, canaries: [w.c('held.wake', 'push.in')], namedAnywhere: true, inputs: [], addressed: false, spare: skip });
      }
      if ((explicit || mode === 'hybrid') && !forks) {
        const words = said('con', 1);
        steps.push({
          id: w.id('con'), segment: 'W13', kind: 'console', text: `${w.c('con', 'in')} ${prose(300, `${w.id('con')}:in`)}`, canaries: [w.c('con', 'in')], namedAnywhere: true, addressed: false, drafts: 'bounced',
          replies: [{ text: explicit ? words : `>>>#${W13_NOWHERE} ${words}` }], spare: [{ calls: [{ name: 'skip_reply', input: {} }] }],
          fate: { continues: false, ...(explicit ? { receipt: null } : { receipt: { to: [], held: true } }), bounces: 1 },
        });
      }
      const last = turn('last', CHANNEL, [{ text: to(CHANNEL, said('last', 1)) }], {});
      delete last.fate;
      steps.push(closing(last));
      return steps;
    },
    check(run, ctx) {
      const steps = this.steps(ctx);
      const [fates, arrivals] = [turnFates(run, steps, { forks: Boolean(ctx.configuration.recipe?.conversations), unrouted: ctx.configuration.agent?.proseRouting === 'disabled' }), arrivalFates(run, steps)];
      return withJudged([...fates, ...arrivals], fates.judged + arrivals.judged);
    },
  },

  W17: {
    from: null,
    compresses: false,
    property: 'inputs: each step\'s first request carries its message, where it has one, and the notice it names by its opening tag, the closed-channel invitation, a [routing] notice or the [self-wake] line, in its last message; the request after the call a step names as its result carries that result in its last message; and each input a held request lets arrive, a message typed at the console or on a channel or a reader fork\'s summary, is first carried by the request its point gives',
    recipe: { fixtureChannels: W17_CHANNELS, subconscious: { enabled: true, reader: 'forks', model: 'claude-opus-4-6', voice: W17_VOICE } },
    steps(ctx) {
      const w = writer(ctx, 'W17');
      const s = w17Writer(w);
      const meet = s.turn('meet', CHANNEL);
      meet.replies = [{ ...meet.replies[0], hold: true, during: [s.consoleAct('meet', 'con'), s.deliverAct('meet', 'a', CHANNEL)] }, { text: s.said('meet', 2) }];
      meet.canaries.push(s.c('meet', 'con.in'), s.c('meet', 'a.in'));
      meet.arrivals = [{ canary: s.c('meet', 'con.in'), point: 'end', after: s.c('meet', 'r1'), console: true, message: `${s.id('meet')}.con` }, { canary: s.c('meet', 'a.in'), point: 'end', after: s.c('meet', 'r1'), message: `${s.id('meet')}.a` }];
      const priv = s.deliver('priv', CHANNEL, { w17: { result: 'channel_publish' } });
      const call1 = { name: TOOL, input: { kind: 'prose', size: 400, canary: s.c('priv', 'call1') } };
      priv.replies = [
        { text: s.said('priv', 1), calls: [call1], hold: true, during: [s.consoleAct('priv', 'con')] },
        { calls: [{ name: 'channel_publish', input: { content: `${s.c('priv', 'pub')} ${prose(300, `${s.id('priv')}:pub`)}` } }] },
        { text: s.said('priv', 3), calls: [{ name: 'skip_reply', input: {} }] },
        { text: s.said('priv', 4), calls: [{ name: 'skip_reply', input: {} }] },
      ];
      priv.canaries.push(s.c('priv', 'con.in'), s.c('priv', 'call1'));
      priv.arrivals = [{ canary: s.c('priv', 'con.in'), point: 'boundary', after: s.c('priv', 'call1'), console: true, message: `${s.id('priv')}.con` }];
      const nowhere = s.wake('close.wake', 121_000, 'close', { notice: 'routing' });
      nowhere.replies = [{ text: s.said('close.wake', 1), calls: [{ name: TOOL, input: { kind: 'prose', size: 400, canary: s.c('close.wake', 'call1') } }], hold: true, during: [s.deliverAct('close.wake', 'a', 'other', { addressed: true, participant: 'Wren' })] }, { text: s.said('close.wake', 2) }];
      nowhere.canaries = [...nowhere.canaries, s.c('close.wake', 'a.in'), s.c('close.wake', 'call1')];
      nowhere.spare = [{ text: `${s.c('close.wake', 'spare')} ${prose(200, `${s.id('close.wake')}:spare`)}` }];
      nowhere.arrivals = [{ canary: s.c('close.wake', 'a.in'), point: 'boundary', after: s.c('close.wake', 'call1'), routing: true, message: `${s.id('close.wake')}.a` }];
      const steps = [
        meet,
        priv,
        s.deliver('side', 'side', { addressed: true, w17: { notice: 'Channel invitation' } }),
        s.deliver('feed.early', 'feed', { addressed: true, rounds: [[{ name: 'skip_reply', input: {} }]], ends: true, w17: { notice: 'Channel invitation' } }),
        s.deliver('feed.open', CHANNEL, { rounds: [[{ name: 'channel_open', input: { channelId: 'feed' } }], [{ name: 'skip_reply', input: {} }]], ends: true, w17: { result: 'channel_open' } }),
        s.deliver('close', CHANNEL, { rounds: [[{ name: 'channel_close', input: { channelId: CHANNEL } }], [{ name: 'skip_reply', input: { wake_in_seconds: 120 } }]], ends: true, w17: { result: 'channel_close' } }),
        nowhere,
        s.deliver('feed.in', 'feed', { addressed: true, rounds: [[{ name: 'skip_reply', input: {} }]], ends: true, w17: { notice: 'routing' } }),
        s.typed('self', [[{ name: 'skip_reply', input: { wake_in_seconds: 120 } }]]),
        s.wake('self.wake', 121_000, 'self', { notice: 'self-wake' }),
        // Other sources of private input after a console message (agent-framework#190): a sleep's end and an operator's
        // nudge.
        s.typed('sleep', [[{ name: 'sleep', input: { seconds: 120 } }]]),
        s.wake('sleep.wake', 121_000, 'sleep'),
        s.typed('nudge.in', [[{ name: 'skip_reply', input: {} }]]),
        { id: s.id('nudge'), segment: 'W17', kind: 'host', host: { command: 'nudge' }, inputs: [], canaries: [s.c('nudge.in', 'in')], namedAnywhere: true, addressed: false, replies: [{ text: s.said('nudge', 1) }] },
        s.deliver('focus', 'other', { rounds: [[{ name: 'focus', input: { channelId: 'other', durationSeconds: 3600 } }]], w17: { result: 'focus' } }),
      ];
      // A tune-out's cancel after a message typed at the console, another of agent-framework#190's sources of private
      // input: agent-framework derives a reader fork inside the agent's tune_out call to look at the cancel, and the
      // fork's summary is mail to the resident, held as W12's priv.spawn holds its subagent's result. Its two steps are
      // written after the others, so every other step keeps the sizes it drew without them, and they run before focus,
      // whose focus on other comes after the tune-out of other has ended.
      const tune = s.typed('tune', [[{ name: 'tune_out', input: { channelId: 'other', durationSeconds: 3600 } }]], { ends: false });
      const reader = { prefix: `reader/${ctx.configuration?.agent?.name ?? FIXTURE_AGENT}/` };
      const cancel = s.typed('tune.cancel', [[{ name: 'tune_out', input: { mode: 'cancel', channelId: 'other' } }]], { ends: false });
      const read = s.c('tune.cancel', 'read');
      cancel.replies = [cancel.replies[0], { ...cancel.replies[1], hold: true, during: [{ agentEnd: reader }] }, { text: s.said('tune.cancel', 3) }];
      cancel.reader = reader;
      cancel.subs = [{ marker: W17_VOICE, canaries: [s.c('tune.cancel', 'in')], namedAnywhere: true, replies: [{ text: `${read} ${prose(200, `${s.id('tune.cancel')}:read`)}`, hold: true, during: [{ asked: 'primary', n: 2 }] }] }];
      cancel.arrivals = [{ canary: read, point: 'end', after: s.c('tune.cancel', 'r2'), agent: reader.prefix }];
      // Before agent-framework#998 the host takes both: the publish goes to the turn's channel and the skip ends the
      // turn. So the publish's round has no words, which that host would hold as drafts, and the skip's next reply is
      // spare and names no result.
      const pub = s.deliver('pub.num', 'other', { w17: { result: 'channel_publish' } });
      pub.replies = [
        { calls: [{ name: 'channel_publish', input: { channelId: 7, content: `${s.c('pub.num', 'pub')} ${prose(300, `${s.id('pub.num')}:pub`)}` } }] },
        { text: s.said('pub.num', 2), calls: [{ name: 'skip_reply', input: {} }] },
      ];
      const skip = s.deliver('skip.bool', 'other', { rounds: [[{ name: 'skip_reply', input: { reason: true } }]], ends: true });
      skip.spare = [{ text: `${s.c('skip.bool', 'spare')} ${prose(200, `${s.id('skip.bool')}:spare`)}` }];
      return [...steps.slice(0, -1), tune, cancel, steps.at(-1), skip, pub];
    },
    check(run, ctx) {
      const steps = this.steps(ctx);
      const [inputs, arrivals] = [inputFates(run, steps), arrivalFates(run, steps)];
      return withJudged([...inputs, ...arrivals], inputs.judged + arrivals.judged);
    },
  },

  W18: {
    from: 'checkpoint',
    property: 'removals: no request that arrives after a removal lands carries the removed message, raw or for a summariser to summarise',
    steps(ctx) {
      const w = writer(ctx, 'W18');
      const out = w.turn(2);
      Object.assign(out, { summariserHold: { level: 1, during: [{ remove: { messages: [{ fromHeld: 0 }] } }] }, badAnswers: ['empty'] });
      return [w.turn(1), out, w.turn(3)];
    },
    check(run, ctx) {
      return removalFates(run, this.steps(ctx));
    },
  },
  W20: {
    from: null,
    compresses: false,
    property: 'a fleet\'s relay: a parent whose two children, src and dst, answer every request with an empty round relays src\'s latest reply to dst before src has replied, after src answers a task, after the parent\'s crash, and after src is killed, and each relay, having nothing to pass on, answers as an error; and the parent\'s boot after its crash adopts both children, its fleet module reading the same pids as before',
    steps: (ctx) => fleetSteps(ctx),
    check(run, ctx) {
      const out = [];
      let judged = 0;
      const steps = this.steps(ctx);
      const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary').sort((a, b) => a.seq - b.seq);
      // Each relay's result, as the first request after its call carries it.
      const resultOf = (id) => {
        for (const r of primary) for (const m of r.messages ?? []) for (const b of m.blocks ?? []) if (b.type === 'tool_result' && b.toolUseId === id) return { request: r, block: b };
        return null;
      };
      for (const s of steps.filter((x) => x.w20)) {
        for (const id of s.w20.relays) {
          // A relay's case is reached by the calls before it in its turn: src sent a task and awaited, or killed.
          const before = s.w20.calls.slice(0, s.w20.calls.findIndex((c) => c.id === id));
          const unreached = before.map((c) => ({ ...c, got: resultOf(c.id) })).find((c) => !c.got || c.got.block.isError === true);
          if (unreached) {
            const why = unreached.got ? 'answered as an error' : 'had its result in no request';
            out.push({ step: s.id, message: `couldn't judge the relay ${id}: its case wasn't reached, since ${unreached.name} ${unreached.id} before it ${why}` });
            continue;
          }
          const got = resultOf(id);
          if (!got) { out.push({ step: s.id, message: `couldn't judge: no request carried the result of the relay ${id}` }); continue; }
          judged++;
          if (got.block.isError !== true) out.push({ step: s.id, request: got.request.id, message: `the relay ${id} answered as a success, where src's latest round had nothing to pass on, or src had no reply since the parent's connection to it opened (request ${got.request.id})` });
        }
      }
      // The parent's next boot after its crash adopts the children that live on (connectome-host docs/fleet-protocol.md
      // §4.5, "Adopt on start"), so its fleet module reads each child's pid as the boot before did (fleet.ts fleetReady).
      const crashStep = steps.find((x) => x.kind === 'crash');
      if (crashStep) {
        const crashed = run.log.find((e) => e.kind === 'crash');
        const at = (boot) => run.log.find((e) => e.kind === 'fleet' && e.boot === boot);
        const before = crashed ? at(crashed.boot) : null;
        const after = crashed ? at(crashed.boot + 1) : null;
        const pidsOf = (e) => new Map((e?.children ?? []).map((c) => [c.name, c.pid]));
        const was = pidsOf(before);
        const now = pidsOf(after);
        const unread = [...new Set([...was.keys(), ...now.keys()])].filter((n) => !Number.isInteger(was.get(n)) || !Number.isInteger(now.get(n)));
        if (!crashed || !before || !after) out.push({ step: crashStep.id, message: `couldn't judge the boot after the crash: the run logged ${!crashed ? 'no crash' : `no children at boot ${before ? crashed.boot + 1 : crashed.boot}`}` });
        else if (unread.length) out.push({ step: crashStep.id, message: `couldn't judge the boot after the crash: ${unread.join(' and ')}'s pid wasn't read at both boots` });
        else {
          judged++;
          const anew = [...now.keys()].filter((n) => now.get(n) !== was.get(n));
          if (anew.length) out.push({ step: crashStep.id, message: `boot ${after.boot}, after the parent's crash, started ${anew.join(' and ')} anew (${anew.map((n) => `pid ${was.get(n)}, then ${now.get(n)}`).join('; ')}) rather than adopting ${anew.length > 1 ? 'them' : 'it'}` });
        }
      }
      return withJudged(out, judged);
    },
  },
  W19: {
    from: null,
    compresses: false,
    property: 'an XML round\'s words when its stream ends past the round: after a round of words and a call whose continuation fails, with a 400 or a 529 retried, at a channel message or at the console, the first request after the failure carries a [speech-not-posted] notice after the round\'s call, read by its tag, and no post carries the round\'s words',
    steps(ctx) {
      const w = writer(ctx, 'W19');
      // agent-framework posts an XML round's words only when its stream completes, since membrane gives such a round
      // no native content (framework.ts pendingRoundSent, :28641), and otherwise names them in a [speech-not-posted]
      // notice it stores where the turn ends or a retry starts (nameUnpostedSpeech). A 400 isn't retried (membrane
      // 0.8.0 classifies it invalid_request); a 529 is, by the turn's error policy, with its default backoff, since a
      // retry-after hint makes the framework hold a resident for it instead (nonOwningProviderWait).
      const failing = (t, error, after = []) => ({ ...t, replies: [t.replies[0], { error }, ...after], w19: { call: w.c(t.id.slice(t.id.indexOf('.') + 1), 'call1'), round: w.c(t.id.slice(t.id.indexOf('.') + 1), 'r1') } });
      const said = (step) => w.turn(step, { calls: 0, more: { namedAnywhere: true } });
      const fail = failing(w.turn('fail', { more: { mayFail: true, namedAnywhere: true } }), INVALID);
      const retried = w.turn('retry', { more: { retries: true, namedAnywhere: true } });
      const retry = failing(retried, OVERLOADED_ONCE, [retried.replies[1]]);
      // A console message's turn is an operator's: its speech goes to no channel, and its failure is the private one.
      const typed = w.turn('private', { more: { namedAnywhere: true } });
      const priv = failing({ id: typed.id, segment: 'W19', kind: 'console', text: typed.text, canaries: typed.canaries, namedAnywhere: true, addressed: false, mayFail: true, replies: typed.replies }, INVALID);
      return [said(1), fail, said('told'), retry, said('after'), priv, said('last')];
    },
    check(run, ctx) {
      const out = [];
      let judged = 0;
      const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary').sort((a, b) => a.seq - b.seq);
      const marksOf = (r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.xmlMarks ?? b.canaries ?? []));
      for (const s of this.steps(ctx).filter((x) => x.w19)) {
        for (const e of run.log) {
          const posted = e.kind === 'ipc' && /^(inference:published|mcpl:speech-routed)$/.test(e.event?.type ?? '') && String(e.event.text ?? '').includes(s.w19.round);
          if (posted) out.push({ step: s.id, message: `the round's words ${s.w19.round} were posted: ${e.event.type}` });
        }
        const failed = primary.find((r) => r.step === s.id && r.answer?.shape === 'error');
        if (!failed) { out.push({ step: s.id, message: 'couldn\'t judge: no request at this step was answered with an error' }); continue; }
        const next = primary.find((r) => r.seq > failed.seq);
        if (!next) { out.push({ step: s.id, message: `couldn't judge: no request followed the failed ${failed.id}` }); continue; }
        judged++;
        const marks = marksOf(next);
        const at = marks.lastIndexOf(s.w19.call);
        if (at < 0 || !marks.slice(at + 1).includes(SPEECH_NOT_POSTED)) out.push({ step: s.id, request: next.id, message: `request ${next.id}, the first after the failed round at ${s.id}, carries no ${SPEECH_NOT_POSTED} notice after ${s.w19.call}` });
      }
      return withJudged(out, judged);
    },
  },
};

// agent-framework's rewind marker opens with its tag (notice-tags.ts NOTICE_TAG.refusalRewind) and the count of turns
// set aside (framework.ts updateRewindMarker). The tag is `refusal-rewind` at 0.33.0, and agent-framework#1000 renames
// it `turns-set-aside`, so a base and its head can each write either.
const REWIND_NOTICES = ['refusal-rewind', 'turns-set-aside'];
const REWIND_MARKS = REWIND_NOTICES.map((tag) => `[${tag}] The `);
// membrane classifies a 400 as `invalid_request`, not retryable, unless its text reads as an account refusal or a
// context overflow (types/errors.ts classifyByStatus, 0.8.0), and agent-framework's breaker sheds on three such
// failures in a row (framework.ts noteInferenceExhausted, inferenceFailureEscalationThreshold, shedMayHelp).
const INVALID = { status: 400, type: 'invalid_request_error', message: 'stand-in: an invalid request, scripted to fail' };
const OVERLOADED_ONCE = { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' };
const SPEECH_NOT_POSTED = '[speech-not-posted]';
const BREAKER_STEPS = ['break.1', 'break.2', 'break.3'];
const KEEP_STEPS = ['keep.1', 'keep.2', 'keep.3'];
const FAIL_PUBLISH = '[[fail-publish]]';
// agent-framework tells the resident of a publish the channel refused in its next request (framework.ts onRouteFailure,
// NOTICE_TAG.discordSendFailed).
const SEND_FAILED_NOTICE = 'discord-send-failed';
// W20's parent is the only agent the record follows: its children answer on the stand-in's `/empty` route (Hfleet), so
// each relay finds src with no reply since the parent's connection to it last opened (f1, and f4 after the crash) or
// with an empty latest round (f2, and f5 once src is killed), and a correct host relays nothing (fleet-module.ts,
// fleet--relay's description). Each relay's call has an id of its own, by which the check finds its result. f0's
// refused round, thinking and text, and f4's empty last round after a tool round, are what the record's speech lines
// show; no check judges them.
function fleetSteps(ctx) {
  const w = writer(ctx, 'W20');
  const said = (step, k, size = 240) => `${w.c(step, k)} ${prose(size, `${w.id(step)}:${k}`)}`;
  const call = (step, k, name, input) => ({ id: `toolu_w20${step.toLowerCase()}${k}`, name: `fleet--${name}`, input });
  const relay = (step, k) => call(step, k, 'relay', { from: 'src', to: 'dst' });
  const turn = (step, calls, { last = { text: said(step, `r${calls.length + 1}`, 300) }, more = {} } = {}) => ({
    ...w.turn(step, { calls: 0 }),
    namedAnywhere: true,
    replies: [...calls.map((c, i) => ({ text: said(step, `r${i + 1}`), calls: [c] })), last],
    ...(calls.some((c) => c.name === 'fleet--relay') ? { w20: { relays: calls.filter((c) => c.name === 'fleet--relay').map((c) => c.id), calls: calls.map((c) => ({ id: c.id, name: c.name })) } } : {}),
    ...more,
  });
  return [
    { ...w.turn('f0', { calls: 0 }), namedAnywhere: true, replies: [{ thinking: said('f0', 'think'), text: said('f0', 'r0'), stop: 'refusal' }, { text: said('f0', 'r1', 300) }] },
    turn('f1', [relay('f1', 1)]),
    turn('f2', [call('f2', 1, 'send', { name: 'src', content: said('f2', 'task', 120) }), call('f2', 2, 'await', { names: ['src'], timeoutMs: 20_000 }), relay('f2', 3)]),
    w.other('f3', 'crash', {}),
    turn('f4', [relay('f4', 1)], { last: {}, more: { ends: 'unspoken' } }),
    turn('f5', [call('f5', 1, 'kill', { name: 'src' }), relay('f5', 2)]),
  ];
}

const W13_SIDE = 'side';
const W13_QUIET = 'w13-quiet';
const W13_PUSH = 'w13-push';
const W13_FEED = 'w13-feed';
const W13_NOWHERE = 'w13-nowhere';
const W13_QUIET_RULE = { name: 'w13-quiet', match: { channel: `*${W13_QUIET}` }, behavior: 'defer' };
const HELD_PUSH = '[[held-push]]';
const W13_HELD_PUSH_RULE = { name: 'w13-held-push', match: { scope: ['mcpl:push-event'], filter: { type: 'text', pattern: HELD_PUSH } }, behavior: { debounce: 30_000 } };
// discord-mcpl tags a message on a channel the agent hasn't opened, that doesn't mention it, so (server.ts addressTags).
const UNOPENED_AMBIENT = ['chat:ambient', 'chat:from-human'];
// agent-framework's continuation row (auto-continue.ts) and explicit mode's bounce notice open so.
const CONTINUE_ROW = '[continue] ';
const BOUNCE_NOTICE = '[prose-routing] ';
// membrane 0.8.0 cuts a streamed call that has sent no content 60 s after its send (src/progress-bounds.ts PROGRESS_BOUNDS, which Bun loads).
const BEFORE_CONTENT_MS = 60_000;
// agent-framework names the host's setting for that bound in a cut's reason (inference-bounds.ts `withHostSetting`).
const BEFORE_CONTENT_SETTING = 'inferenceBounds.progressBounds.beforeContentMs';
const cutByBound = (cut = true) => ({ hold: true, cut: true, during: [{ advance: BEFORE_CONTENT_MS, cut }] });
const stalled = (step) => ({ ...step, replies: [cutByBound(), ...step.replies], retries: true });

function stallFlag(mine, stall) {
  const digests = (r) => (r.messages ?? []).map((m) => m.digest).join();
  const cuts = mine.filter((r) => r.answer?.shape === 'cut').length;
  if (stall === 'cut' && (cuts !== 1 || mine[0]?.answer?.shape !== 'cut' || !mine[1] || digests(mine[1]) !== digests(mine[0]))) return `the held call wasn't cut and sent again once with the same messages (${cuts} of the step's ${mine.length} request(s) cut, the first ${mine[0]?.answer?.shape ?? 'unanswered'}), where the inference bound cuts it ${BEFORE_CONTENT_MS} ms after its send and the deadline schedule gives it one fresh call`;
  if (stall === 'failed' && (mine.length !== 2 || cuts !== 2 || digests(mine[1]) !== digests(mine[0]))) return `the held call and its fresh call weren't both cut with the same messages (${cuts} of the step's ${mine.length} request(s) cut), where the inference bound cuts each ${BEFORE_CONTENT_MS} ms after its send and the deadline schedule gives the call one fresh call before the turn fails`;
  if (stall === 'waited' && (cuts || mine[0]?.answer?.shape !== 'reply')) return `${cuts} of the step's ${mine.length} request(s) were cut, the first ${mine[0]?.answer?.shape ?? 'unanswered'}, where with no inference bounds nothing cuts the held call and its own reply answers it`;
  return null;
}

const SIDE_W15 = 'w15-side';

function readerWindows(run, steps, seed) {
  const reads = (step) => run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && r.step === `${seed}.${step}`);
  const carries = (r, c) => (r.messages ?? []).some((m) => m.blocks.some((b) => (b.canaries ?? []).includes(c)));
  const c = (step) => `[[c:${seed}.${step}.in]]`;
  const out = [];
  let judged = 0;
  const missing = (step, what) => out.push({ step: `${seed}.${step}`, message: `couldn't judge ${what}: the reader made no request at step ${step}` });
  const [h3] = reads('h3');
  if (!h3) missing('h3', 'the read after the restore');
  else {
    judged++;
    if (carries(h3, c('h2'))) out.push({ step: `${seed}.h3`, request: h3.id, message: `request ${h3.id}, the reader's read after /restore, carries ${c('h2')}, which was stored after the checkpoint` });
  }
  const [h4] = reads('h4');
  if (!h4) missing('h4', 'the read after the restart');
  else {
    judged++;
    if (!carries(h4, c('h2'))) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, doesn't carry ${c('h2')}, which the branch /checkout went back to holds` });
    if (h3 && !carries(h3, c('h3'))) out.push({ step: `${seed}.h4`, message: `couldn't judge whether the reader's read after the restart leaves out ${c('h3')}: ${h3.id}, its read after /restore, doesn't carry it` });
    else if (h3 && carries(h4, c('h3'))) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, carries ${c('h3')}, which only the restore's branch holds` });
  }
  const suppressed = steps.findIndex((s) => s.id === `${seed}.suppress`);
  const later = new Set(steps.slice(suppressed + 1).map((s) => s.id));
  const earlier = new Set(steps.slice(0, suppressed).map((s) => s.id));
  const after = run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && later.has(r.step));
  const before = run.records.filter((r) => r.kind === 'agent' && r.agent === 'sub' && earlier.has(r.step)).at(-1);
  if (!after.length) out.push({ step: `${seed}.suppress`, message: 'couldn\'t judge the suppression: the reader made no request after it' });
  else if (!before) out.push({ step: `${seed}.suppress`, message: 'couldn\'t judge the suppression: the reader made no request before it' });
  else if (!carries(before, c('h1'))) out.push({ step: `${seed}.suppress`, message: `couldn't judge the suppression: request ${before.id}, the reader's last before it, doesn't carry ${c('h1')}` });
  else {
    judged++;
    for (const r of after.filter((x) => carries(x, c('h1')))) out.push({ step: r.step, request: r.id, message: `request ${r.id}, the reader's after the suppression, carries ${c('h1')}, which the suppression removed` });
  }
  if (h3 && h4) {
    judged++;
    const start = (r) => (r.messages ?? []).flatMap((m) => m.blocks).find((b) => b.canaries?.length)?.canaries[0] ?? null;
    if (start(h4) !== start(h3)) out.push({ step: `${seed}.h4`, request: h4.id, message: `request ${h4.id}, the reader's read after the restart, starts at ${start(h4) ?? 'no row a canary names'}, where ${h3.id}, its read before it, starts at ${start(h3) ?? 'no row a canary names'}` });
  }
  return withJudged(out, judged);
}

function removalFates(run, steps) {
  const byId = new Map(run.records.map((r) => [r.id, r]));
  const carried = (r) => (r.kind === 'summariser' ? r.sent?.canaries ?? [] : (r.messages ?? []).flatMap((m) => m.blocks).flatMap((b) => b.canaries ?? []));
  const out = [];
  let judged = 0;
  for (const s of steps.filter((x) => x.summariserHold)) {
    const landed = run.log.findIndex((e) => e.kind === 'remove' && e.step === s.id);
    const released = landed < 0 ? -1 : run.log.findIndex((e) => e.kind === 'send' && e.via === 'release' && e.request === run.log[landed].during);
    if (landed < 0 || released < landed) {
      out.push({ step: s.id, message: `couldn't judge: no removal landed while the step's summariser request was held` });
      continue;
    }
    const removals = run.log.filter((e) => e.kind === 'remove' && e.step === s.id).length;
    if (removals > 1) {
      out.push({ step: s.id, message: `couldn't judge: the step made ${removals} removals, and W18 judges a step's one removal` });
      continue;
    }
    const sent = run.log.slice(0, landed).findLastIndex((e) => e.kind === 'send' && e.via === 'module' && e.op === 'remove' && e.step === s.id);
    const inside = run.log.slice(sent + 1, landed).filter((e) => e.kind === 'request').map((e) => e.request.id);
    const unsure = sent < 0 || inside.length > 0;
    if (unsure) out.push({ step: s.id, message: `couldn't judge: ${sent < 0 ? 'the removal\'s send isn\'t in the log' : `request ${inside.join(', ')} arrived while the removal was being made, between the driver's remove and its answer, so whether it was built before the removal or after can't be told`}` });
    const removed = run.log[landed].canaries;
    const after = run.log.slice(landed + 1).filter((e) => e.kind === 'request').map((e) => byId.get(e.request.id)).filter(Boolean);
    if (!removed.length || !after.length) {
      if (!unsure) out.push({ step: s.id, message: `couldn't judge: ${!removed.length ? 'the removed message carried no canary' : 'no request came after the removal landed'}` });
      continue;
    }
    if (!unsure) judged++;
    for (const r of after) {
      const kept = removed.filter((c) => carried(r).includes(c));
      if (kept.length) out.push({ step: r.step, request: r.id, message: `request ${r.id}, which arrived after the removal at ${s.id} landed, carries ${kept.join(' ')}` });
    }
  }
  return withJudged(out, judged);
}

function arrivalFates(run, steps) {
  const primary = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const blocksOf = (r) => (r.messages ?? []).flatMap((m) => m.blocks);
  const at = (r, c) => blocksOf(r).findIndex((b) => (b.canaries ?? []).includes(c));
  const out = [];
  let judged = 0;
  for (const s of steps) {
    for (const a of s.arrivals ?? []) {
      const log = run.log.filter((e) => e.step === s.id);
      // The turn's hold, not a subagent's held answer: a held request the log names as a subagent's is left out.
      const subs = new Set(log.filter((e) => e.kind === 'request' && (e.request?.agent ?? 'primary') !== 'primary').map((e) => e.request.id));
      const released = log.findIndex((e) => e.kind === 'send' && e.via === 'release' && !subs.has(e.request));
      const sent = a.console ? log.findIndex((e) => e.kind === 'send' && e.via === 'console' && e.during !== undefined && e.id === a.message) : a.push ? log.findIndex((e) => e.kind === 'send' && e.via === 'push' && e.during !== undefined && e.eventId === a.message) : a.message ? log.findIndex((e) => e.kind === 'send' && e.via === 'channel' && e.during !== undefined && e.message?.messageId === a.message) : log.findIndex((e) => e.kind === 'agent-end');
      const stored = sent >= 0 && released > sent && (a.agent || log.slice(sent, released).some((e) => e.kind === 'ipc' && e.event?.type === 'message:added' && e.event.source === (a.console ? 'external-message' : a.push ? 'mcpl:push-event' : 'mcpl:channel-incoming')));
      const first = primary.find((r) => at(r, a.canary) >= 0);
      if (!stored) { out.push({ step: s.id, message: `couldn't judge ${a.canary}: it wasn't stored before its hold's release` }); continue; }
      if (!first) { out.push({ step: s.id, message: `couldn't judge ${a.canary}: no request carries it` }); continue; }
      judged++;
      const held = a.point === 'end' ? primary.find((r) => r.id === log[released].request) : null;
      const due = a.point === 'end' ? (held ? primary.find((r) => r.seq > held.seq) : null) : primary.find((r) => at(r, a.after) >= 0);
      const where = a.point === 'end' ? 'its wake turn\'s first request, the first after the turn\'s held final request' : `the request after its boundary, the first to carry ${a.after}`;
      if (first !== due) { out.push({ step: s.id, request: first.id, message: `${a.canary} is first carried by request ${first.id}, where its point gives ${due ? `request ${due.id}` : 'no request'}, ${where}` }); continue; }
      const ahead = at(first, a.after);
      if (ahead < 0) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary} without ${a.after}, which its point puts ahead of it` });
      else if (at(first, a.canary) < ahead) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary} before ${a.after}` });
      if (a.routing) {
        const rest = blocksOf(first).slice(at(first, a.canary) + 1);
        const next = rest.findIndex((b) => !b.notice && (b.canaries ?? []).length > 0);
        if (!(next < 0 ? rest : rest.slice(0, next)).some((b) => b.notice === 'routing')) out.push({ step: s.id, request: first.id, message: `request ${first.id} carries ${a.canary}, addressed from another channel, with no [routing] notice after it ahead of the next block that carries a canary` });
      }
    }
  }
  return withJudged(out, judged);
}

function inputFates(run, steps) {
  const agent = run.records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === 'primary');
  const last = (r) => r.messages?.at(-1)?.blocks ?? [];
  const out = [];
  let judged = 0;
  for (const s of steps.filter((x) => x.w17)) {
    const mine = agent.filter((r) => r.step === s.id);
    if (!mine.length) { out.push({ step: s.id, message: 'couldn\'t judge: the step has no request' }); continue; }
    judged++;
    const [first] = mine;
    if (s.w17.message && !last(first).some((b) => (b.canaries ?? []).includes(s.w17.message))) out.push({ step: s.id, message: `request ${first.id}, the step's first, doesn't carry ${s.w17.message} in its last message` });
    if (s.w17.notice && !last(first).some((b) => b.notice === s.w17.notice)) out.push({ step: s.id, message: `request ${first.id}, the step's first, carries no [${s.w17.notice}] notice in its last message` });
    if (s.w17.result) {
      const round = s.replies.findIndex((reply) => (reply.calls ?? []).some((call) => call.name === s.w17.result));
      const id = mine[round]?.answer?.toolUseIds?.[0];
      const next = mine[round + 1];
      if (!id || !next) out.push({ step: s.id, message: `couldn't judge: the step has no request ${!id ? `answered with its ${s.w17.result} call` : `after the one answered with its ${s.w17.result} call`}` });
      else if (!last(next).some((b) => b.type === 'tool_result' && b.toolUseId === id)) out.push({ step: s.id, message: `request ${next.id} doesn't carry the result of ${s.w17.result} (${id}) in its last message` });
    }
  }
  return withJudged(out, judged);
}

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
  'H1/continuation', 'H1/continuation/rewrite-priced', 'H3/continuation',
  'H1b/continuation/from-0.9.0', 'H1b/continuation/from-0.20.0', 'H1b/continuation/from-0.23.0', 'H1b/continuation/fresh',
  'H1/W1', 'H4/W1', 'H4b/W1',
  'C3h/W2', 'H1/W2', 'H1b/W2',
  'H3/W4',
  'C5h/W5',
  'C8h/W6',
  'C3h/W7/merges-refused', 'C3h/W7/fable-no-tools', 'C3h/W7/no-tools',
  'H1/W7/merges-refused', 'H1/W7/merges-rejected', 'H2/W7/merges-refused', 'H1/W7/chunk-refused',
  'C14h/W7/merges-refused', 'C15h/W7/chunk-refused', 'C16h/W7/chunk-refused', 'C17h/W7/merges-refused', 'C17h/W7/chunk-refused',
  'C3h/W8/unenforced', 'C6h/W8/enforced', 'H1/W8/enforced', 'H4/W8/unenforced',
  'H3/W9', 'C3h/W9', 'C6h/W9', 'H1/W9',
  'H1/W14', 'H1b/W14',
  'H4/W15', 'H4t/W15',
  'C6h/W11', 'H1/W11',
  'P1/continuation', 'P2/continuation',
  'P3/continuation', 'P4/continuation',
  'P5/continuation',
  'H5/W12', 'H5b/W12', 'H5c/W12',
  'H1r/W16',
  'Hoff/W13',
  'H1/W13', 'Hcont/W13', 'Hlatest/W13', 'Hconv/W13', 'Hexpl/W13', 'Hhyb/W13', 'Hdis/W13', 'Hlock/W13', 'Hpriv/W13', 'Hretry/W13', 'Hfold/W13',
  'H6/continuation', 'H7/continuation',
  'H1c/W2', 'H1d/W2',
  'C9h/continuation',
  'C11h/continuation',
  'C12h/continuation', 'C20h/continuation',
  'C18h/continuation', 'C13h/continuation', 'C19h/continuation',
  'C21h/continuation', 'C23h/continuation',
  'H1/W17',
  'H1/W18',
  'H6/W19',
  'Hfleet/W20',
];

export function seedOf(id) {
  return 100 + (hash32(id) % 900000);
}

const merge = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

// The time between a checkpoint's end and the run that starts from it (drive.ts), and between a history a run builds
// itself and the workload that continues it.
export const CHECKPOINT_GAP_MS = 24 * 60 * 60_000;
const WEB_UI = { host: '127.0.0.1', port: 0 };

/**
 * A workloads module (run.ts --workloads; harness/README.md, "A workloads module"): a file exporting WORKLOADS, workloads
 * in this file's shape, and RUNS, run ids over this harness's configurations. Its runs join the view's for one invocation
 * and nothing of the view's moves, so a workload name or run id the view has is refused, and so is a run of a workload
 * that isn't the module's. A module's workload declares `from: null`: checkpoints are built only from the view's own
 * workloads. Returns the joined table, the module's runs, and its path, or throws saying what's wrong.
 */
export async function workloadsModule(path) {
  const at = resolve(path);
  let module;
  try { module = await import(pathToFileURL(at).href); } catch (e) { throw new Error(`--workloads ${path} can't be imported: ${e.message}`); }
  const { WORKLOADS: own, RUNS: runs } = module;
  if (!own || typeof own !== 'object' || Array.isArray(own) || !Array.isArray(runs)) throw new Error(`--workloads ${path} doesn't export both WORKLOADS, an object of workloads, and RUNS, a list of run ids`);
  const names = Object.keys(own).filter((name) => Object.hasOwn(WORKLOADS, name));
  if (names.length) throw new Error(`--workloads ${path} names workloads the view already has: ${names.join(', ')}`);
  const ids = runs.filter((id) => RUNS.includes(id));
  if (ids.length) throw new Error(`--workloads ${path} names runs the view already has: ${ids.join(', ')}`);
  const checkpointed = Object.entries(own).filter(([, w]) => w?.from !== null).map(([name]) => name);
  if (checkpointed.length) throw new Error(`--workloads ${path}: a module's workload starts from no checkpoint, so it declares from: null, and ${checkpointed.join(', ')} doesn't`);
  const strangers = runs.filter((id) => !Object.hasOwn(own, String(id).split('/')[1]));
  if (strangers.length) throw new Error(`--workloads ${path} runs workloads not its own: ${strangers.join(', ')}`);
  return { table: { ...WORKLOADS, ...own }, runs, path: at };
}

export function runOf(id, configurations, facts, { prefixTurns = {}, workloads = WORKLOADS } = {}) {
  const [configName, workloadName, variant = null] = id.split('/');
  const base = configurations[configName];
  const workload = workloads[workloadName];
  if (!base || !workload || (variant !== null && !(workload.variants ?? []).includes(variant))) throw new Error(`no run ${id}: no such configuration, workload or variant`);
  const recipe = typeof workload.recipe === 'function' ? workload.recipe(variant, facts.capabilities, configName) : workload.recipe ?? {};
  const gated = Object.entries(base?.gated ?? {});
  const lacking = facts.capabilities === undefined || !gated.length ? [] : gated.map(([name]) => name).filter((name) => !capable(facts.capabilities)(name));
  const brought = gated.filter(([name]) => !lacking.includes(name)).reduce((c, [, part]) => merge(c, part), {});
  const modules = {
    ...(workload.needs?.webui ? { webui: WEB_UI } : {}),
    ...(workload.needs?.subagents ? { subagents: true } : {}),
  };
  const configuration = merge(merge(merge(base, brought), Object.keys(modules).length ? { modules } : {}), recipe);
  delete configuration.gated;
  for (const [name, on] of Object.entries(base.modules ?? {})) if (on === false) configuration.modules[name] = false;
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
    streamBound: streamBoundFor({ ...configuration, ...(typeof facts.streamBound === 'number' ? { streamBound: facts.streamBound } : {}) }),
    adaptive,
    folding: adaptive ? strategy.foldingStrategy ?? 'kv-unified' : null,
    native: configuration.agent?.formatter !== 'anthropic-xml',
    prefixTurns: prefixTurns[configName],
    capabilities: facts.capabilities,
  };
  const fromEmpty = workload.from === null || workload.fromEmpty?.(variant, configName) || configName === 'H2';
  // A setup the fixed release can't drive builds the history its workload continues in the run itself: the history's
  // steps, whose last copies the store and boots it a checkpoint's gap later, then the workload's, so the record holds
  // every turn.
  const history = workloads[workload.from] ?? null;
  const builds = history !== null && (base.buildsHistory === true || workload.buildsFresh?.(variant) === true);
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
    from: history ? (builds ? null : `${configName}/${workload.from}${workload.fromVariant?.(variant) ? `/${workload.fromVariant(variant)}` : ''}`) : fromEmpty ? null : `${configName}/${base.summarises === false ? 'W1' : 'W2'}`,
    steps: () => [...lacking.map((name) => ({ id: `${seed}.absent.${name}`, segment: workloadName, kind: 'absent', stretch: name, canaries: [] })), ...(builds ? [...built(), ...workload.steps(ctx)] : workload.steps(ctx))],
    check: (run) => workload.check(run, ctx),
    owns: typeof workload.owns === 'function' ? workload.owns(variant) : workload.owns ?? [],
    products: workload.products ? workload.products(configuration, variant) : [],
    compresses: typeof workload.compresses === 'function' ? workload.compresses(variant, configName) : workload.compresses !== false,
  };
}
