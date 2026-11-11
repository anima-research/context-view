// @ts-nocheck
import { FIXTURE_AGENT, spawnName, withJudged } from '../strategies/checks.ts';
import { prose } from '../strategies/prose.ts';
import { CHANNEL, INSTRUCTIONS, TOOL } from '../strategies/script.ts';
import { JUDGE_FAILS, JUDGE_HOLDS, WAKE } from '../standin/judge.ts';
import { FLAG } from '../standin/review.ts';
import { STALE } from '../standin/retrieval.ts';
import { FAIL_PUBLISH, SIZES, capable, writer } from './turns.ts';
import { arrivalFates, stallFlag, stalled } from './fates.ts';

const lastResultTexts = (messages) => {
  const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
  return blocks(messages.at(-1)?.content).filter((b) => b.type === 'tool_result').flatMap((b) => blocks(b.content)).filter((b) => b.type === 'text').map((b) => b.text ?? '');
};
const listedTools = (messages) => [...lastResultTexts(messages).join('\n').matchAll(/^ {2}([^\s(]+)\(/gm)].map((m) => m[1]);

// agent-framework's history module's search answers with its matches, each naming its message's `id`
// (history/index.ts SearchMatch).
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

export const W12 = {
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
};
