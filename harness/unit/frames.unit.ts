// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callText, renderRecord } from '../lib/record.ts';
import { generatedTexts } from '../lib/strategies/transcript.ts';
import { RUN_VARYING, maskRunVarying } from '../lib/strategies/compare.ts';
import { differencesOf } from '../lib/entries.ts';

const P1 = '[[c:p.1.in]] Window thread river letter bridge garden canyon letter river.';
const R1 = '[[c:p.1.r1]] Signal orchard pencil market window compass orchard basket morning.';
const SHORT = '[[c:p.2.r1]] noted';
const SUMMARY = '[[s:M0123abcd]] Memory 0123abcd, carried 2 canaries to c:p.1.r1: Orchard quiet meadow lantern.';
const THINK = 'Thinking about the river and the bridge and the garden at some length.';
const CALL = { type: 'tool_use', id: 't1', name: 'mcpl--fixture--result', input: { kind: 'prose', size: 400, canary: '[[c:p.1.call1]]' } };
const steps = [{ id: 'p.1', kind: 'channel', text: P1, replies: [{ text: R1 }] }, { id: 'p.2', kind: 'channel', replies: [{ text: SHORT }] }];
const answers = [[{ type: 'thinking', thinking: THINK, signature: 's' }, { type: 'text', text: R1 }, CALL], [{ type: 'text', text: SUMMARY }]];
const registry = () => generatedTexts({ steps, answers, callText });

const text = (participant, t) => ({ participant, content: [{ type: 'text', text: t }] });
const m = (id, content, more = {}) => ({ sources: [`r:${id}`], content, ...more });
const line = (seq, messages, more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(seq * 10), messages, ...more });
const store = { fixture: { messages: [['1', ['[[c:p.1.in]]']], ['2', ['[[c:p.1.r1]]']], ['3', ['[[c:p.2.r1]]']]] } };
const header = { configuration: 'H1/W1', from: 'empty' };
const render = (log, generated) => renderRecord({ header, log, records: [], end: { ok: true }, generated }).split('\n');
const compiles = (r) => r.filter((l) => l.startsWith('  compile'));
const forms = (r) => r.filter((l) => l.startsWith('form'));
const named = (base, shaped) => `${base}-${createHash('sha256').update(shaped).digest('hex').slice(0, 12)}`;
const compiled = (blobs, ...lists) => [{ kind: 'compiles', step: 'p.1', blobs, store, lines: lists.map((list, i) => line(i + 1, list)) }];

test('F1: a frame the same at every compile, with no numbers, is one form line naming its messages; their items stay bare and keep their ranges', () => {
  const blobs = { u: text('user', `Wren: ${P1}`), r: text('fixture', R1) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r')], [m(1, 'u'), m(2, 'r')]), registry());
  assert.deepEqual(compiles(r), ['  compile p.1.in-p.1.r1', '  compile = (as before)']);
  const name = named('user-wren-own-text', 'Wren: \u27e8own text\u27e9');
  assert.deepEqual(forms(r), [`form [T:${name}] p.1.in`]);
  assert.ok(r.includes(`T:${name} = Wren: \u27e8own text\u27e9`), 'the form\'s text is a template like any other');
  assert.ok(r.indexOf(forms(r)[0]) < r.indexOf('step p.1'), 'the forms come before the steps');
});

test('F2: a frame that holds numbers is written at its item, which stands outside any range', () => {
  const head = '[fixture \u00b7 #chat \u00b7 topic "prefix" \u00b7 @Wren \u00b7 09:04 \u00b7 msg p.1]\n';
  const blobs = { u: text('user', `${head}Wren: ${P1}`), r: text('fixture', R1) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r')]), registry());
  const shaped = '[fixture \u00b7 #chat \u00b7 topic "prefix" \u00b7 @Wren \u00b7 #:# \u00b7 msg p.#]\nWren: \u27e8own text\u27e9';
  const name = named('user-fixture-#chat', shaped);
  assert.deepEqual(compiles(r), [`  compile p.1.in[T:${name}](09,04,1) p.1.r1`]);
  assert.deepEqual(forms(r), []);
  assert.ok(r.includes(`T:${name} = [fixture \u00b7 #chat \u00b7 topic "prefix" \u00b7 @Wren \u00b7 #:# \u00b7 msg p.#]`) && r.includes('  Wren: \u27e8own text\u27e9'));
});

test('F3: a frame that varies between compiles is no form: it is written at each of them, and a cut names the part of the fixture\'s words it kept', () => {
  const cut = `Wren: ${P1.slice(0, 40)}\n\n[truncated \u2014 original was 19 tokens]`;
  const blobs = { u: text('user', `Wren: ${P1}`), c: text('user', cut), r: text('fixture', R1) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r')], [{ sources: ['r:1!content'], content: 'c' }, m(2, 'r')]), registry());
  const whole = named('user-wren-own-text', 'Wren: \u27e8own text\u27e9');
  const part = named('user-wren-own-text', 'Wren: \u27e8own text, chars #\u2013# of #\u27e9\n\n[truncated \u2014 original was # tokens]');
  assert.deepEqual(compiles(r), [
    `  compile p.1.in[T:${whole}] p.1.r1`,
    `  compile p.1.in[T:${part}](0,40,${P1.length},19)!content p.1.r1`,
  ]);
  assert.deepEqual(forms(r), []);
});

test('F4: a recall pair\'s question is told from its summary by its speaker: the question is a form, the summary, the fixture\'s words alone, is bare', () => {
  const summaryStore = { fixture: { ...store.fixture, summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['1', '2'], parent: null, content: 'sm' }] } };
  const blobs = { q: text('Context Manager', 'What do you remember from earlier?'), sm: text('fixture', SUMMARY), u: text('fixture', SHORT) };
  const s = (content) => ({ sources: ['s:L1-1@1'], content });
  const log = [{ kind: 'compiles', step: 'p.1', blobs, store: summaryStore, lines: [line(1, [s('q'), s('sm'), m(3, 'u')]), line(2, [s('q'), s('sm'), m(3, 'u')])] }];
  const r = render(log, registry());
  assert.deepEqual(compiles(r), ['  compile L1(p.1.in-p.1.r1) L1(p.1.in-p.1.r1) p.2.r1', '  compile = (as before)']);
  assert.deepEqual(forms(r), [`form [T:${named('context-manager-what-do-you', 'What do you remember from earlier?')}] L1(p.1.in-p.1.r1)`]);
});

test('F5: the stand-in\'s thinking, a short marked text and an answered call are the fixture\'s, and a capped call\'s input is not', () => {
  const reply = { participant: 'fixture', content: [{ type: 'thinking', thinking: THINK, signature: 's' }, { type: 'text', text: R1 }, CALL] };
  const capped = { participant: 'fixture', content: [{ type: 'text', text: R1 }, { ...CALL, input: { _truncated: true, _originalTokens: 120, _keys: ['canary', 'kind', 'size'] } }] };
  const blobs = { u: text('user', P1), r: reply, rc: capped, s: text('fixture', SHORT) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r'), m(3, 's')], [m(1, 'u'), m(2, 'rc'), m(3, 's')]), registry());
  const frame = '\u27e8own text\u27e9\nmcpl--fixture--result {"_keys":["canary","kind","size"],"_originalTokens":#,"_truncated":true}';
  assert.deepEqual(compiles(r), ['  compile p.1.in-p.2.r1', `  compile p.1.in p.1.r1[T:${named('fixture-own-text-mcpl-fixture-result', frame)}](120) p.2.r1`]);
});

test('F9: an answered call under 32 characters is the fixture\'s where it is a block of its own, and a host\'s text that quotes it keeps it', () => {
  const LIST = { type: 'tool_use', id: 't2', name: 'subagent--list', input: {} };
  const withList = generatedTexts({ steps, answers: [...answers, [{ type: 'text', text: R1 }, LIST]], callText });
  const blobs = { u: text('user', P1), r: { participant: 'fixture', content: [{ type: 'text', text: R1 }, LIST] }, n: text('user', `${P1}\nthe host ran subagent--list {} for you`) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r'), m(3, 'n')]), withList);
  const frame = '\u27e8own text\u27e9\nthe host ran subagent--list {} for you';
  assert.deepEqual(compiles(r), ['  compile p.1.in-p.2.r1']);
  assert.deepEqual(forms(r), [`form [T:${named('user-own-text-the', frame)}] p.2.r1`]);
});

test('F6: where every message is the fixture\'s words alone, the record is the one written with no registry', () => {
  const blobs = { u: text('user', P1), r: { participant: 'fixture', content: [{ type: 'text', text: R1 }, CALL] }, s: text('fixture', SHORT) };
  const log = compiled(blobs, [m(1, 'u'), m(2, 'r'), m(3, 's')]);
  assert.deepEqual(render(log, registry()), render(log, undefined));
  assert.deepEqual(compiles(render(log, undefined)), ['  compile p.1.in-p.2.r1']);
});

// One pair of texts for each run-varying value a request's digest masks, differing only in that value.
const VARYING = {
  imageRef: ['ref img_k7x3q2_1', 'ref img_a1b2c3_1'],
  fork: ['task fork-knowledge-1-0123abcd-89ab-4cde-8f01-23456789abcd', 'task fork-knowledge-1-fedcba98-7654-4321-8fed-cba987654321'],
  readerEpoch: ['[Tune-out reader \u2014 chat, epoch 638fd205, wake]', '[Tune-out reader \u2014 chat, epoch c922c44e, wake]'],
  reminder: ['[reminder rem_mk0xy49s_jxng, set]', '[reminder rem_mk0xy49s_05o9, set]'],
  draft: ['held as draft d-mckugqs', 'held as draft d-dgnk63a'],
};

// The words around each value, which its frame shows, and the value's own run-minted part, which it mustn't.
const AROUND = { imageRef: ['ref img_', 'k7x3q2'], fork: ['task fork-knowledge-', '0123abcd'], readerEpoch: ['Tune-out reader', '638fd205'], reminder: ['[reminder rem_', 'jxng'], draft: ['held as draft d-D', 'mckugqs'] };

test('F7: a frame takes every run-varying mask the digests take, so two runs that differ only in one write the same record', () => {
  assert.deepEqual(Object.keys(VARYING).sort(), Object.keys(RUN_VARYING).sort(), 'every value on compare.ts\'s list has its pair here');
  for (const [kind, [a, b]] of Object.entries(VARYING)) {
    assert.equal(maskRunVarying(a), maskRunVarying(b), `${kind}: the digests mask it`);
    const once = (v) => render(compiled({ u: text('user', `${v}\n${P1}`), r: text('fixture', R1) }, [m(1, 'u'), m(2, 'r')]), registry());
    const [words, minted] = AROUND[kind];
    assert.ok(once(a).some((l) => l.startsWith('T:') && l.includes(words)), `${kind}: the frame shows its words`);
    assert.ok(!once(a).join('\n').includes(minted), `${kind}: and not the run's own part of the value`);
    assert.deepEqual(once(a), once(b), `${kind}: and the frame masks it`);
  }
});

test('F10: added whitespace, or a host\'s own text that reads like a placeholder, is a frame', () => {
  const blobs = { u: text('user', ` ${P1}`), r: text('fixture', `${R1} \u27e8own text\u27e9`) };
  const r = render(compiled(blobs, [m(1, 'u'), m(2, 'r')]), registry());
  assert.deepEqual(forms(r), [`form [T:${named('user-own-text', ' \u27e8own text\u27e9')}] p.1.in`, `form [T:${named('fixture-own-text-own', '\u27e8own text\u27e9 \u27e8own text\u27e9')}] p.1.r1`]);
});

test('F11: a form is judged on the compiles the record writes, not on an `other` or refused one', () => {
  const blobs = { u: text('user', `Wren: ${P1}`), v: text('user', `Ash: ${P1}`), r: text('fixture', R1) };
  const log = [{ kind: 'compiles', step: 'p.1', blobs, store, lines: [line(1, [m(1, 'u'), m(2, 'r')]), line(2, [m(1, 'v')], { kind: 'other' }), line(3, [m(1, 'v')], { outcome: 'refused', error: { class: 'x' } })] }];
  const r = render(log, registry());
  assert.deepEqual(forms(r), [`form [T:${named('user-wren-own-text', 'Wren: \u27e8own text\u27e9')}] p.1.in`]);
});

test('F12: a form names each name its message is written under, another owner\'s too', () => {
  const blobs = { u: text('user', `Wren: ${P1}`), v: text('user', `Wren: ${R1}`) };
  const log = [
    { kind: 'compiles', step: 'p.1', blobs, store: { fixture: { messages: [['1', ['[[c:p.1.in]]']]] }, sub: { messages: [] } }, lines: [line(1, [m(1, 'u')])] },
    { kind: 'compiles', step: 'p.2', blobs, store: { fixture: { messages: [], removedMessages: ['1'] }, sub: { messages: [['1', ['[[c:p.5.in]]']]] } }, lines: [line(2, [m(1, 'v')], { slots: ['sub'] })] },
  ];
  const r = render(log, registry());
  assert.deepEqual(forms(r), [`form [T:${named('user-wren-own-text', 'Wren: \u27e8own text\u27e9')}] p.1.in sub/p.5.in`]);
});

test('F13: a form\'s frame is named at its first use, as a frame at an item is, so being a form moves no other name', () => {
  const blobs = { u: text('user', `held as draft d-mckugqs\n${P1}`), s: text('user', 'drafted d-dgnk63a') };
  const twoStores = { fixture: { messages: [['1', ['[[c:p.1.in]]']], ['2', []]] } };
  const log = [{ kind: 'compiles', step: 'p.1', blobs, store: twoStores, lines: [line(1, [m(1, 'u')]), line(2, [m(1, 'u'), m(2, 's')])] }];
  const r = render(log, registry());
  assert.deepEqual(forms(r), [`form [T:${named('user-held-as-draft', 'held as draft d-Da\n\u27e8own text\u27e9')}] p.1.in`]);
  assert.ok(r.includes(`T:${named('user-drafted-d-db', 'drafted d-Db')} = drafted d-Db`), 'the later draft takes the second name');
});

test('F14: a summary\'s or a fallback\'s text is named once, so an image ref\'s nonce takes its first name', () => {
  const blobs = { i: text('instructions', 'instructions img_k7x3q2_1') };
  const log = [{ kind: 'compiles', step: 'p.1', blobs, store, lines: [line(1, [{ sources: ['i:x'], content: 'i' }])] }];
  const r = render(log, registry());
  assert.ok(r.some((l) => /^T:summary-i-[0-9a-f]{12} = instructions img_na_1$/.test(l)), r.filter((l) => l.startsWith('T:')).join('\n'));
});

test('F15: a refused compile\'s error names its run-varying ids before its digits go', () => {
  const refused = (id) => render([{ kind: 'compiles', step: 'p.1', blobs: { e: `no reminder rem_mk0xy49s_${id} here` }, store, lines: [line(1, [], { outcome: 'refused', error: { class: 'gone', message: 'e' } })] }], registry());
  assert.deepEqual(refused('jxng'), refused('05o9'));
});

test('F16: a frame names the run\'s directory, its session paths and its lesson ids as a request\'s digest does', () => {
  const runOf = (lesson) => {
    const dir = mkdtempSync(join(tmpdir(), 'frames-'));
    mkdirSync(join(dir, 'store'));
    writeFileSync(join(dir, 'store', 'lessons.json'), JSON.stringify({ lessons: [{ id: lesson }] }));
    const blobs = { u: text('user', `${P1}\nsaved to ${dir}/store/sessions/s-${lesson} under ${lesson}`) };
    try { return renderRecord({ header, log: compiled(blobs, [m(1, 'u')]), records: [], end: { ok: true }, generated: registry(), runDir: dir }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const a = runOf('lsn-q7a');
  assert.equal(a, runOf('lsn-z2b'));
  assert.ok(a.includes('saved to <run>/store/sessions/<session> under lesson-#'), a);
});

test('F17: forms mix a subagent\'s, another owner\'s and a summary\'s members, and a `!content` item stays out of its range', () => {
  const sumStore = { fixture: { messages: [['1', ['[[c:p.1.in]]']], ['2', ['[[c:p.1.r1]]']], ['3', ['[[c:p.2.r1]]']]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['1', '2'], parent: null, content: 'sm' }] }, sub: { messages: [['1', ['[[c:p.1.in]]']]] } };
  const blobs = { u: text('user', `Wren: ${P1}`), q: text('user', `Wren: ${SUMMARY}`), w: text('user', `Wren: ${R1}`), x: text('user', `Ash: ${P1}`), z: text('fixture', SHORT) };
  const s = (content) => ({ sources: ['s:L1-1@1'], content });
  const cut = { sources: ['r:1!content'], content: 'u' };
  const log = [{ kind: 'compiles', step: 'p.1', blobs, store: sumStore, lines: [
    line(1, [m(1, 'u'), m(2, 'w'), s('q')]),
    line(2, [cut, m(2, 'w'), s('q')]),
    line(3, [cut, m(2, 'w'), s('q'), m(3, 'z')]),
    line(4, [m(1, 'x')], { agent: 'sub' }),
  ] }];
  const r = render(log, registry());
  const wren = named('user-wren-own-text', 'Wren: \u27e8own text\u27e9');
  assert.deepEqual(forms(r), [`form [T:${wren}] p.1.in-p.1.r1 L1(p.1.in-p.1.r1)`, `form [sub] [T:${named('user-ash-own-text', 'Ash: \u27e8own text\u27e9')}] p.1.in`]);
  assert.deepEqual(compiles(r).slice(0, 3), ['  compile p.1.in-p.1.r1 L1(p.1.in-p.1.r1)', '  compile p.1.in!content p.1.r1 L1(p.1.in-p.1.r1)', '  compile + p.2.r1']);
});

test('F18: a short marked text is the fixture\'s inside a block the host added to, too', () => {
  const blobs = { u: text('user', P1), z: text('user', `Wren: ${SHORT}`) };
  const r = render(compiled(blobs, [m(1, 'u'), m(3, 'z')]), registry());
  assert.deepEqual(forms(r), [`form [T:${named('user-wren-own-text', 'Wren: \u27e8own text\u27e9')}] p.2.r1`]);
});

test('F8: a form line that changes is a difference at the step `forms`', () => {
  const rec = (formLine) => `${['# whole-host record H1/W1, from empty', 'templates', 'T:user-wren-own-text-aaaaaaaaaaaa = Wren: \u27e8own text\u27e9', formLine, 'step p.1', '  compile p.1.in p.2.in', 'end ok'].join('\n')}\n`;
  const ds = differencesOf('H1/W1', rec('form [T:user-wren-own-text-aaaaaaaaaaaa] p.1.in'), rec('form [T:user-wren-own-text-aaaaaaaaaaaa] p.1.in p.2.in'));
  assert.deepEqual(ds.map((d) => [d.describe, d.place.step, d.before, d.after]), [
    ['`form` lines whose `` became `p.C`', 'forms', 'form [T:user-wren-own-text-aaaaaaaaaaaa] p.1.in', 'form [T:user-wren-own-text-aaaaaaaaaaaa] p.1.in p.2.in'],
  ]);
});
