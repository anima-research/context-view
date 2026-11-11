import { afterAll, expect, test } from 'bun:test'
import { RECORDS, frozen, moduleOf, runOf, script, withWords, type Words } from './testing.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const VIEW_DIR = join(import.meta.dir, '..', 'view')

const body = script('context-view')
const m = await moduleOf(body!)
const { BOUND, CUT, LEAD, LIMIT, OVERHEAD, RESULT, GUIDE_HEADING, HARNESS, INSTRUCTIONS, RUN_DEADLINE, ctocCount, cutEntries, fitPrompt, folded, guideOf, inputsOf, placeOf, problemsOf, promptOf, readView } = m

type Step = number | string
type AgentOptions = { model: string, effort?: string, transcript?: boolean, kept?: Record<string, unknown>, check: (result: unknown) => string[] }
type Said = { prompt?: string, opts?: AgentOptions, texts?: string[] }

const made: string[] = []
afterAll(() => { for (const p of made) rmSync(p, { recursive: true, force: true }) })


const E = (id: string, before: string, after: string, step: Step = 1) => ({ id, describe: 'k', count: 1, runs: ['H1/W2'], places: [{ run: 'H1/W2', step }], example: { place: { run: 'H1/W2', step }, before, after } })
const viewOf = (entries: object[]) => ({ repo: 'anima-research/context-manager', number: 1, title: 't', body: 'b', base: 'a'.repeat(40), head: 'b'.repeat(40), form: 'overlay', host: 'c'.repeat(40), held: {}, runs: { total: 26, compared: 26 }, flags: [], reached: {}, entries })
const words = (answer: unknown, extra: Said = {}) => ({ agent: async (prompt: string, opts: AgentOptions) => { extra.prompt = prompt; extra.opts = opts; if (answer instanceof Error) throw answer; return answer }, text: (s: string) => { extra.texts = [...(extra.texts ?? []), s] } })
const chars = async (t: string) => t.length
const readWith = (w: Words, v: object, count: (t: string) => Promise<number>, kept?: object) => withWords(w, () => readView(v, { instructions: 'i', guide: 'g' }, count, kept))
const ok = () => ({ result: { changes: [{ title: 'Line changes', where: 'In the run that reopens a conversation, at its first turn.', base: 'The model is sent the line as it was.', head: 'It is sent the line reworded.', refs: ['a1'], before: 'base', after: 'head' }] }, transcript: [{ type: 'message' }] })

test('the record holds the script', () => {
  expect(body).toBeTruthy()
})

test('the words are globals only while their body runs, and a word runs are not given is refused', async () => {
  const g = globalThis as Record<string, any>
  g.text = 'before'
  const seen = await withWords({ agent: 1, text: 2, tools: async (name, args) => [name, args] }, async () => [g.agent, g.text, await g.tools.x(3)])
  expect(seen).toEqual([1, 2, ['x', 3]])
  expect(['agent' in g, g.text, 'tools' in g]).toEqual([false, 'before', false])
  delete g.text
  await expect(withWords({ parallel: () => {} }, async () => 0)).rejects.toThrow(/not parallel/)
})

test('a word is set as the global itself, past any setter a global had, and a symbol among the words is refused', async () => {
  const g = globalThis as Record<string | symbol, any>
  let set = 0
  Object.defineProperty(g, 'text', { get: () => 'held', set: () => { set++ }, configurable: true })
  const own = Symbol('own')
  try {
    const seen = await withWords({ text: 2 }, async () => g.text)
    expect([seen, set, g.text]).toEqual([2, 0, 'held'])
    await expect(withWords({ agent: 1, [own]: 2 } as unknown as Words, async () => 0)).rejects.toThrow(/not Symbol\(own\)/)
    expect([own in g, 'agent' in g]).toEqual([false, false])
  } finally {
    delete g.text
    delete g[own]
    delete g.agent
  }
})

test("the tools object is no thenable: awaiting it gives it back, and calls no tool named then", async () => {
  const g = globalThis as Record<string, any>
  const called: string[] = []
  const awaited = await withWords({ tools: async (name) => { called.push(name); return null } }, async () => {
    const tools = g.tools
    let set: unknown = null
    try { tools.then = 1 } catch (e) { set = (e as Error).name }
    const seen = [Object.keys(tools), Object.getOwnPropertyDescriptor(tools, 'then'), set]
    return [await Promise.race([Promise.resolve(tools).then((t) => t === tools), new Promise((r) => setTimeout(() => r('it hung'), 1000))]), ...seen]
  })
  expect([awaited, called]).toEqual([[true, [], undefined, 'TypeError'], []])
})

test('the reader sees no places, and a prompt within the bound goes whole', async () => {
  const v = viewOf([E('a1', 'base line', 'head line')])
  expect(inputsOf(v).entries[0].places).toBeUndefined()
  const fit = await fitPrompt('i', 'g', inputsOf(v), chars)
  expect(fit.cutAt).toBeNull()
  expect(fit.prompt.includes('base line')).toBe(true)
})

test('past the bound, the largest cut that fits is taken, longest sides first, marked', async () => {
  const big = 'x'.repeat(BOUND)
  const v = viewOf([E('a1', big, 'short head'), E('b2', 'short base', '')])
  const fit = await fitPrompt('i', 'g', inputsOf(v), chars)
  expect(fit.tokens).toBeLessThanOrEqual(BOUND)
  expect(fit.cutAt).toBeGreaterThan(0)
  expect(fit.sidesCut).toBe(1)
  expect(fit.prompt.includes(CUT)).toBe(true)
  expect(fit.prompt.includes('short head')).toBe(true)
  expect(promptOf('i', 'g', { ...inputsOf(v), entries: cutEntries(inputsOf(v).entries, fit.cutAt + 1) }).length).toBeGreaterThan(BOUND)
})

test('a prompt that cannot fit even with every side cut stops', async () => {
  const v = viewOf([E('a1', 'b', 'h')])
  const r = await readWith(words(ok()), v, async () => BOUND + 1)
  expect(r.stopped).toMatch(/past its bound/)
})

test("a good answer comes back with each change placed; the check is the call's", async () => {
  const seen: Said = {}
  const v = viewOf([E('a1', 'base line', 'head line')])
  const r = await readWith(words(ok(), seen), v, chars)
  expect(r.reader.changes[0].place).toEqual({ run: 'H1/W2', step: 1 })
  expect(seen.opts!.model).toBe('sol-prompt')
  expect(seen.opts!.effort).toBe('high')
  expect(seen.opts!.transcript).toBe(true)
  expect(seen.opts!.check(ok().result)).toEqual([])
})

test('a fold, a refusal, a failed call and a last try with problems each end without a reader account', async () => {
  const v = viewOf([E('a1', 'base line', 'head line')])
  const fold = ok(); fold.transcript.push({ type: 'compaction' })
  expect((await readWith(words(fold), v, chars)).stopped).toMatch(/folded/)
  const refusal = Object.assign(new Error("Refused by the provider's safety classifier (category: cyber)."), { data: { code: 'refused', category: 'cyber' } })
  expect(await readWith(words(refusal), v, chars)).toEqual({ stopped: "the reader was refused by its provider's safety classifier, so it wrote no account; this view was asked for, so whoever asked is waiting on it" })
  const failed = Object.assign(new Error('x'), { data: { code: 'failed' } })
  expect((await readWith(words(failed), v, chars)).stopped).toMatch(/failed/)
  const bad = ok(); bad.result.changes[0].after = 'not in the record'
  expect((await readWith(words(bad), v, chars)).stopped).toMatch(/problem/)
  expect(folded([{ type: 'message' }])).toBe(false)
})

test('a cut keeps the stretch where the sides first differ, on both sides alike', () => {
  const same = 'p'.repeat(5000)
  const [e] = cutEntries([E('a1', same + 'BASE' + 'z'.repeat(5000), same + 'HEAD' + 'z'.repeat(5000))], 400)
  expect(e.example.before.startsWith(LEAD)).toBe(true)
  expect(e.example.before.includes('BASE')).toBe(true)
  expect(e.example.after.includes('HEAD')).toBe(true)
  expect(e.example.before.endsWith(CUT)).toBe(true)
  const [one] = cutEntries([E('b2', 'q'.repeat(1000), '')], 100)
  expect(one.example.before).toBe('q'.repeat(100) + CUT)
  expect(one.example.after).toBe('')
})

test('a first fold gets one fresh call under its own kept value; a second fold stops', async () => {
  const v = viewOf([E('a1', 'base line', 'head line')])
  const fold = () => { const f = ok(); f.transcript.push({ type: 'compaction' }); return f }
  const calls: unknown[] = []
  const twice = (answers: unknown[]) => ({ agent: async (p: string, o: AgentOptions) => { calls.push(o.kept); return answers.shift() }, text: () => {} })
  const r = await readWith(twice([fold(), ok()]), v, chars, { view: 'k' })
  expect(r.reader).toBeDefined()
  expect(calls).toEqual([{ view: 'k' }, { view: 'k', afterFold: true }])
  const s = await readWith(twice([fold(), fold()]), v, chars, { view: 'k' })
  expect(s.stopped).toMatch(/folded its context twice/)
})

test("ctocCount adds ctoc's uncertain tokens to its tokens", async () => {
  const tool = async () => ({ isError: false, structuredContent: { exit_code: 0, stdout: '100 tokens, 7 uncertain (7.0%)\n' } })
  expect(await withWords({ tools: tool }, () => ctocCount()('anything'))).toBe(107)
  const bad = async () => ({ isError: false, structuredContent: { exit_code: 1, stdout: '', stderr: 'no' } })
  await expect(withWords({ tools: bad }, () => ctocCount()('x'))).rejects.toThrow(/ctoc gave no count/)
})

test('a side within n stays whole beside a long side, and only the long one is counted as cut', async () => {
  const shared = 'p'.repeat(140)
  const base = shared + 'B'.repeat(11)
  const head = shared + 'H'.repeat(5000)
  const [e] = cutEntries([E('a1', base, head)], 200)
  expect(e.example.before).toBe(base)
  expect(e.example.after.startsWith(LEAD)).toBe(true)
  expect(e.example.after.includes('HHH')).toBe(true)
  const v = viewOf([E('a1', base, 'x'.repeat(BOUND))])
  const fit = await fitPrompt('i', 'g', inputsOf(v), chars)
  expect(fit.sidesCut).toBe(1)
  expect(fit.prompt.includes(base)).toBe(true)
})

test("each entry's at gives its places by run and by step, in the places' order, with how many fall at each step, and the reader is told what at is; places stay out", () => {
  const places = [['H1/W1', 'c.think'], ['H1/W1', 'c.think'], ['H1/W1', '12'], ['C6h/W11', '232330.9'], ['C6h/W11', '232330.10'], ['C6h/W11', '232330.9']]
  const e = { id: 'a1', describe: 'k', count: 6, runs: ['H1/W1', 'C6h/W11'], places: places.map(([run, step]) => ({ run, step, digest: 'd' })), example: { place: { run: 'H1/W1', step: 'c.think' }, before: 'b', after: 'h' } }
  const inputs = inputsOf({ ...viewOf([]), entries: [e] })
  const [given] = inputs.entries
  expect(given.at).toEqual([{ run: 'H1/W1', steps: [['c.think', 2], ['12', 1]] }, { run: 'C6h/W11', steps: [['232330.9', 2], ['232330.10', 1]] }])
  expect('places' in given).toBe(false)
  const prompt = promptOf('i', 'g', inputs)
  expect(prompt).toContain('`at` is, for each of those runs, the steps of the run it occurs at, in the order the run reaches them, each with how many of its places fall there')
  expect(prompt).toContain("The example is one of the entry's places, not a description of them all: what changed is the same kind of thing at every place, the kind `describe` names, while what surrounds it can differ from place to place.")
})

test("at follows the view's run order and each run's step order once facts' code has merged the shares, run through compared", () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-view-at-'))
  made.push(dir)
  const order = ['H1/W1', 'C6h/W11']
  const result = (run: string) => ({ run, outcome: 'pass', record: 'differs', flags: { new: [], gone: [], kept: [] }, counts: { compiles: 3, compressions: 0, merges: 0, quarantines: { compression: 0, merge: 0 } }, selfCheck: { outcome: 'same', requests: 3 } })
  const share = (i: number, run: string, steps: string[]) => {
    for (const arm of ['before', 'after']) {
      mkdirSync(join(dir, `share-${i}`, arm), { recursive: true })
      writeFileSync(join(dir, `share-${i}`, arm, 'run.json'), JSON.stringify({ runs: order, candidate: { versions: { '@animalabs/context-manager': '0.24.2' } }, results: arm === 'after' ? [result(run)] : [] }))
    }
    const entry = { id: 'a1', describe: 'k', count: steps.length, runs: [run], places: steps.map((step) => ({ run, step, digest: 'd' })), examples: [{ run, step: steps[0], before: 'b', after: 'h' }] }
    writeFileSync(join(dir, `share-${i}`, 'after', 'entries.json'), JSON.stringify([entry]))
  }
  share(1, 'C6h/W11', ['232330.9', '232330.10', '232330.9'])
  share(2, 'H1/W1', ['c.think', 'c.think', '12'])
  const input = { dir, repo: REPO, number: 7, head: HEAD, form: 'overlay', base: { ref: 'main', sha: 'a'.repeat(40) }, host: { sha: 'c'.repeat(40) }, harness: { repo: HARNESS, sha: HARNESS_AT }, title: 't', body: 'b' }
  const r = Bun.spawnSync(['uv', 'run', '--quiet', '--frozen', '--project', VIEW_DIR, 'python', '-c', "import sys, view; sys.exit(view.main(['compared']))"], { cwd: VIEW_DIR, env: { ...process.env, UV_NO_BUILD: '0' }, stdin: Buffer.from(JSON.stringify(input)) })
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
  const [given] = inputsOf(JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8'))).entries
  expect(given.at).toEqual([{ run: 'H1/W1', steps: [['c.think', 2], ['12', 1]] }, { run: 'C6h/W11', steps: [['232330.9', 2], ['232330.10', 1]] }])
  expect('places' in given).toBe(false)
})

test('the machinery names runs that could not be compared, by run and kind only', () => {
  const v = { repo: 'r', number: 1, title: 't', body: 'b', entries: [], broken: [{ run: 'H1/W2', what: 'unmeasured', reason: 'the run failed', unmeasured: { head: ['x'] } }] }
  expect(inputsOf(v).machinery.broken).toEqual([{ run: 'H1/W2', what: 'unmeasured' }])
  expect(inputsOf({ ...v, broken: undefined }).machinery.broken).toEqual([])
})

test('the machinery names each package besides the pull request\'s that the arms ran at different releases, and a view with none says what it said before', () => {
  const v = viewOf([E('a1', 'base line', 'head line')])
  const differing = [{ package: 'membrane', base: '0.8.0', head: '0.9.0' }]
  expect(inputsOf({ ...v, differing }).machinery.differing).toEqual(differing)
  expect(promptOf('i', 'g', inputsOf(v))).not.toContain('differing')
  expect(promptOf('i', 'g', inputsOf({ ...v, differing }))).toContain('"differing"')
})

const C = (id: string, before: string, after: string, step: Step = 1) => ({ id, describe: 'k', count: 1, runs: ['H1/W2'], example: { place: { run: 'H1/W2', step }, before, after } })
const entries = [C('a1', 'base line one', 'head line one'), C('b2', 'only in base', ''), C('c3', 'x', 'y', 2), C('d4', 'unpaired base', '', 3), C('e5', '', 'unpaired head', 3)]
const change = (title: string, refs: string[], before: string, after: string, more: object = {}) => ({ title, where: 'In every run compared, at the first turn.', base: 'The model is sent the line as it was.', head: 'It is sent the line reworded.', refs, before, after, ...more })
const account = {
  changes: [
    change('Line one changes', ['a1', 'c3'], 'base line one', 'head line one'),
    change('A base line is gone', ['b2'], 'only in base', ''),
    change('An unpaired line changes', ['d4', 'e5'], 'unpaired base', 'unpaired head', { follows: 1, unmentioned: true, also: 'In the run that reopens a conversation, at its later turns, too.' }),
  ],
}
const clone = (v: unknown) => JSON.parse(JSON.stringify(v))
const unpaired = (p: string) => p.includes("aren't the base and head sides of one place")

test('a clean result has no problems', () => {
  expect(problemsOf(entries, account)).toEqual([])
})

test('figures, versions and commit ids in prose are refused; run names and levels pass', () => {
  for (const bad of ['in 26 runs', 'a 2,000-character bound', 'context-manager 0.24.0', 'at 933fce362', 'Haiku 4.5']) {
    const v = clone(account); v.changes[0].base = bad
    expect(problemsOf(entries, v).some((p: string) => p.includes('figure'))).toBe(true)
  }
  const v = clone(account); v.changes[0].base = 'In H1/W11 and C6h_W8_enforced, L1 requests recall the L2, with a 1h marker; a defaced or effaced word is no hash.'
  expect(problemsOf(entries, v)).toEqual([])
})

test('counts of runs, steps or requests, in digits or words, are refused; counts a quote holds pass', () => {
  for (const bad of ['In run C3h/W9 only, a single request changed.', 'The two continuation rounds now differ.', 'Three rounds re-send it.', 'In the two enforced runs it moves.', 'at one step only']) {
    const v = clone(account); v.changes[0].base = bad
    expect(problemsOf(entries, v).some((p: string) => p.includes('count of runs'))).toBe(true)
  }
  const v = clone(account); v.changes[0].base = 'The head sends those four messages raw on both arms of every run compared; the two arms agree, all three fields gain one number, and no one else moves.'
  expect(problemsOf(entries, v)).toEqual([])
})

test('rough, hyphenated and spread-out counts are refused too', () => {
  for (const bad of ['Both continuation rounds now differ.', 'Both requests send it.', 'Only one of the rounds changed.', 'Two of its requests changed.', 'In one of the runs it moves.', 'The two later continuation rounds differ.', 'A single-request change.', 'A two-round difference.', 'A couple of rounds re-send it.', 'A pair of requests changed.', 'A lone request changed.', 'Twenty requests carry it.', 'Zero requests carry it.', 'Dozens of requests carry it.', 'Several requests carry it.', 'A few rounds re-send it.', 'Many requests carry it.']) {
    const v = clone(account); v.changes[0].base = bad
    expect(problemsOf(entries, v).some((p: string) => p.includes('count of runs'))).toBe(true)
  }
  for (const good of ['The compile and the continuation rounds changed.', 'The compile and every round after it changed.', 'The first round and the third round changed.', 'In run C3h/W9 only, the compile changed.', 'In the knowledge runs only, the second request changes.', 'It shows on both arms of every run compared.', 'Both arms send the same four messages.']) {
    const v = clone(account); v.changes[0].base = good
    expect(problemsOf(entries, v)).toEqual([])
  }
})

test('a sentence with a figure and a count gets both problems at once', () => {
  const v = clone(account); v.changes[0].base = 'At 0.24.0 two rounds changed.'
  const ps = problemsOf(entries, v)
  expect(ps.some((p: string) => p.includes('figure'))).toBe(true)
  expect(ps.some((p: string) => p.includes('count of runs'))).toBe(true)
})

test('the records notation in prose is refused', () => {
  for (const bad of ['a notice reading [# of # characters omitted]', 'the T:error-overbudget template']) {
    const v = clone(account); v.changes[0].head = bad
    expect(problemsOf(entries, v).some((p: string) => p.includes('notation'))).toBe(true)
  }
})

test('before and after from two entries pass only at one place', () => {
  expect(placeOf(entries, account.changes[2])).toEqual({ run: 'H1/W2', step: 3 })
  const v = clone(account); v.changes[0].before = 'x'; v.changes[0].after = 'head line one'
  expect(problemsOf(entries, v).some(unpaired)).toBe(true)
})

test("an empty side is allowed only where that entry's side is empty", () => {
  const v = clone(account); v.changes[0].after = ''
  expect(problemsOf(entries, v).some(unpaired)).toBe(true)
  const u = clone(account); u.changes[0].before = ''
  expect(problemsOf(entries, u).some(unpaired)).toBe(true)
  const w = clone(account); w.changes[2].before = ''
  expect(problemsOf(entries, w)).toEqual([])
})

test("a quote from another change's entry is refused", () => {
  const v = clone(account); v.changes[1].before = 'base line one'
  expect(problemsOf(entries, v).some((p: string) => p.startsWith('change 2: before and after'))).toBe(true)
})

test('the same text as before and after is refused', () => {
  const es = [C('a1', 'shared line one', 'shared line two')]
  const p = problemsOf(es, { changes: [change('A line', ['a1'], 'shared line', 'shared line')] })
  expect(p.some((x: string) => x.includes('the same text'))).toBe(true)
})

test('coverage: every entry in exactly one change, every ref an entry', () => {
  const v = clone(account); v.changes[1].refs = ['b2', 'a1', 'zz']
  const p = problemsOf(entries, v)
  expect(p).toContain('change 2: ref a1 is already in change 1')
  expect(p).toContain('change 2: ref zz names no entry')
  const w = clone(account); w.changes[0].refs = ['a1']
  expect(problemsOf(entries, w)).toContain('entries in no change: c3')
})

test('shape limits: title words, empty prose', () => {
  const v = clone(account); v.changes[0].title = 'one two three four five six seven eight nine ten eleven'; v.changes[1].where = ' '
  const p = problemsOf(entries, v)
  expect(p.some((x: string) => x.includes('longer than 10 words'))).toBe(true)
  expect(p).toContain("change 2's where is empty")
})

test("a change's where, base and head are each one line, and each is held to the prose rules", () => {
  for (const k of ['where', 'base', 'head']) {
    const v = clone(account); v.changes[1][k] = 'The model is sent the line.\nThen another.'
    expect(problemsOf(entries, v)).toEqual([`change 2's ${k} holds a line break; it's one line`])
    const w = clone(account); w.changes[1][k] = 'In 26 runs.'
    expect(problemsOf(entries, w).some((p: string) => p.startsWith(`change 2's ${k} holds a figure`))).toBe(true)
    const e = clone(account); e.changes[1][k] = ' '
    expect(problemsOf(entries, e)).toEqual([`change 2's ${k} is empty`])
  }
})

test("the result's schema asks for each change's fields, with also, follows and unmentioned optional", () => {
  const item = RESULT.properties.changes.items
  expect(RESULT.required).toEqual(['changes'])
  expect(item.required).toEqual(['title', 'where', 'base', 'head', 'refs', 'before', 'after'])
  expect([item.properties.also, item.properties.follows, item.properties.unmentioned]).toEqual([{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }])
  expect(item.additionalProperties).toBe(false)
})

test("also is one sentence, on one line, held to the prose rules, and may be left out", () => {
  const broken = clone(account); broken.changes[2].also = 'In the later turns.\nAnd elsewhere.'
  expect(problemsOf(entries, broken)).toEqual(["change 3's also holds a line break; it's one line"])
  const empty = clone(account); empty.changes[2].also = ' '
  expect(problemsOf(entries, empty)).toEqual(["change 3's also is empty"])
  const counted = clone(account); counted.changes[2].also = 'In 26 runs.'
  expect(problemsOf(entries, counted).some((p: string) => p.startsWith("change 3's also holds a figure"))).toBe(true)
  for (const bad of [null, 3, ['In the later turns.']]) {
    const v = clone(account); v.changes[2].also = bad
    expect(problemsOf(entries, v)).toEqual([`change 3's also is ${JSON.stringify(bad)}; it's one sentence saying where other requests carry this change forward, or is left out`])
  }
  const none = clone(account); delete none.changes[2].also
  expect(problemsOf(entries, none)).toEqual([])
})

test("follows names an earlier change by its place counting from 1, and unmentioned is only ever true; both may be left out", () => {
  for (const bad of [0, 3, 1.5, '1', null]) {
    const v = clone(account); v.changes[2].follows = bad
    expect(problemsOf(entries, v)).toEqual([`change 3's follows is ${JSON.stringify(bad)}; it names an earlier change by its place in the list, counting from 1, or is left out`])
  }
  const first = clone(account); first.changes[0].follows = 1
  expect(problemsOf(entries, first)).toEqual(["change 1's follows is 1; it names an earlier change by its place in the list, counting from 1, or is left out"])
  const later = clone(account); later.changes[0].follows = 2; later.changes[1].follows = 3
  expect(problemsOf(entries, later)).toEqual([
    "change 1's follows is 2; it names an earlier change by its place in the list, counting from 1, or is left out",
    "change 2's follows is 3; it names an earlier change by its place in the list, counting from 1, or is left out",
  ])
  for (const bad of [false, 'yes', null]) {
    const v = clone(account); v.changes[2].unmentioned = bad
    expect(problemsOf(entries, v)).toEqual([`change 3's unmentioned is ${JSON.stringify(bad)}; it's true when the description doesn't mention the change, and left out otherwise`])
  }
  const none = clone(account); delete none.changes[2].follows; delete none.changes[2].unmentioned
  expect(problemsOf(entries, none)).toEqual([])
})


test("the reader's guide is the README's section by its heading, to the next section, then CHECKS.md whole; without either there's none", () => {
  const readme = ['# Whole-host records', '', '## Running it', 'run', '', `${GUIDE_HEADING}`, '', 'A record opens with one header line.', '', '### Templates', 'T:KEY = TEXT', '', '## The view of what changed', 'view'].join('\n')
  const checks = '# What a context view runs and checks\n\nIt runs things.\n'
  expect(guideOf(readme, checks)).toBe(`A record opens with one header line.\n\n### Templates\nT:KEY = TEXT\n\n${checks}`)
  expect(guideOf(readme.replace(GUIDE_HEADING, '## Reading records'), checks)).toBeNull()
  expect(guideOf(`${GUIDE_HEADING}\n\n## Next`, checks)).toBeNull()
  expect(guideOf(readme, ' \n')).toBeNull()
})

const REPO = 'anima-research/context-manager'
const HEAD = 'd'.repeat(40)
const HARNESS_AT = 'e'.repeat(40)
const README = `# Whole-host records\n\n${GUIDE_HEADING}\n\nThe guide's own text.\n\n## The view of what changed\n`
const CHECKS = '# What a context view runs and checks\n\nWhat each run does.\n'
const ANSWER = { changes: [{ title: 'Line changes', where: 'In the run that reopens a conversation, at its first turn.', base: 'The model is sent the line as it was.', head: 'It is sent the line reworded.', refs: ['a1'], before: 'base line', after: 'head line' }] }
const VIEW = { ...viewOf([E('a1', 'base line', 'head line')]), repo: REPO, number: 7, head: HEAD, outcome: 'ran', broken: [], harness: { repo: HARNESS, sha: HARNESS_AT } }

const UNCHANGED = { ...VIEW, entries: [] }
const CURRENT = '/home/nissa/.local/lib/context-view/current'
const RELEASE_DIR = '/home/nissa/.local/lib/context-view/releases'
const STATE = '/home/nissa/.local/state/context-view'
const RELEASES = ['c', 'f'].map((x) => `${RELEASE_DIR}/${x.repeat(40)}`)
type Given = { post?: boolean }
type Answered = object | ((given: Given) => object)
type Shown = { outcome?: unknown, entries?: unknown[], [field: string]: unknown }
type Stand = {
  run?: number | object, manifest?: object | string | null, left?: object | null, view?: Shown, readme?: string, checks?: string, answer?: unknown,
  post?: Answered, stopped?: Answered, fail?: { step: string, exit: number, why?: string } | null, releases?: (string | [number, string, string])[], versions?: string,
  cut?: Record<string, number>, cutAs?: 'null' | 'part' | 'elided', postSaid?: string
}
type Call = { step: string, command?: string, cwd?: string, timeout_ms?: number, input?: any, release?: string }
type BashArgs = { command: string, cwd?: string, timeout_ms?: number, max_output_chars?: number }

const changedOf = (view: Shown) => view.outcome === 'ran' && (view.entries || []).length > 0
const posted = (url: string) => (given: Given) => (given.post === false ? { action: 'dry', parts: 1 } : { action: 'posted', url })
function stand({ run = 0, manifest = null, left = null, view = UNCHANGED, readme = README, checks = CHECKS, answer = ANSWER, post = posted('https://github.com/x#c1'), stopped = posted('https://github.com/x#s1'), fail = null, releases = RELEASES, versions = RELEASE_DIR, cut = {}, cutAs = 'null', postSaid = '' }: Stand = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'context-view-test-'))
  made.push(dir)
  const calls: Call[] = [], said: Record<string, unknown>[] = [], logs: string[] = [], asked: ({ prompt: string } & Pick<AgentOptions, 'model' | 'kept' | 'check'>)[] = [], read: string[] = [], resolved: unknown[] = [], order: string[] = []
  const bash = (exit: number | null, out = '', stderr = '') => ({ isError: false, structuredContent: { exit_code: exit, timed_out: exit === null, stdout: out, stderr }, content: [{ type: 'text', text: stderr }] })
  const input = (command: string) => JSON.parse(command.split('\n')[1]!)
  const answerOf = (given: Answered, value: Given) => (typeof given === 'function' ? given(value) : given)
  const cuts: Record<string, number> = { ...cut }
  const reads: { label: string, at: number }[] = [], answered: number[] = []
  const cutOff = (read: string) => {
    if ((cuts[read] ?? 0) <= 0) return null
    cuts[read]--
    const part = 'the first part of what it printed'
    const shape = cutAs === 'elided' ? { stdout: null, output_complete: true, elided_chars: 4001 } : { stdout: cutAs === 'part' ? part : null, output_complete: false, elided_chars: 0 }
    return { isError: false, structuredContent: { exit_code: 0, timed_out: false, stderr: '', ...shape }, content: [{ type: 'text', text: part }] }
  }
  const tool = async (name: string, a: BashArgs & Record<string, unknown>, o?: unknown) => {
    if (name === 'mcp__commons__post_message') { said.push(a); return { isError: false, content: [] } }
    expect(name).toBe('mcp__hands__Bash')
    const budget = a.max_output_chars ?? 30000
    if (!Number.isInteger(budget) || budget < 1000 || budget > 200_000) throw Object.assign(new Error(`max_output_chars must be a whole number from 1,000 to 200,000, not ${budget}`), { name: 'ToolInputValidationError', data: { code: 'rejected' } })
    const r = await bashOf(a)
    const s = (r as { structuredContent: { exit_code: number | null, stdout: string | null, stderr: string } }).structuredContent
    if (typeof s.stdout !== 'string' || s.stdout.length <= budget) return r
    return { isError: false, structuredContent: { exit_code: s.exit_code, timed_out: false, stdout: null, stderr: s.stderr, output_complete: true, elided_chars: s.stdout.length - budget }, content: [{ type: 'text', text: s.stdout.slice(0, 200) }] }
  }
  const bashOf = async (a: BashArgs) => {
    const c = a.command
    if (c.startsWith(`python3 -c 'import sys; s = open(sys.argv[1], encoding="utf-8"`) || c.startsWith(`python3 -c 'import sys; open(sys.argv[1], "wb")`)) {
      const reading = c.includes("open(sys.argv[1], encoding=")
      if (reading) reads.push({ label: 'view.json', at: Number(c.trim().split(/\s+/).at(-1)) })
      const short = reading ? cutOff('view.json') : null
      if (short) return short
      const r = Bun.spawnSync(['bash', '-c', c])
      const out = r.stdout.toString()
      if (reading) answered.push(out.length)
      return bash(r.exitCode, out, r.stderr.toString())
    }
    order.push(c.split(' ', 1)[0])
    if (c === `realpath -e ${CURRENT} ${RELEASE_DIR}`) {
      const short = cutOff('release')
      if (short) return short
      const answer = releases[Math.min(resolved.length, releases.length - 1)]
      resolved.push([answer, a.cwd])
      return Array.isArray(answer) ? bash(answer[0], answer[2] ?? '', answer[1]) : bash(0, `${answer}\n${versions}\n`)
    }
    if (c.startsWith('timeout -s TERM') || / && timeout -s TERM /.test(c)) {
      if (/^rm -f -- '[^']+\/manifest\.json' && timeout -s TERM /.test(c)) left = null
      calls.push({ step: 'run', command: c, cwd: a.cwd, timeout_ms: a.timeout_ms })
      return typeof run === 'object' ? run : bash(run, '', run === 0 || run === 3 ? '' : 'context-view-run: on-gh failed')
    }
    const named = /^'([^']+)'\/view\/step (\w+) <</.exec(c)
    if (named) {
      const [, release, s] = named
      const given = input(c)
      calls.push({ step: s, input: given, cwd: a.cwd, release })
      if (fail && fail.step === s) return bash(fail.exit, '', fail.why ?? `view.py ${s}: no`)
      if (s === 'facts') writeFileSync(join(dir, 'view.json'), JSON.stringify(view))
      const short = cutOff(s)
      if (short) return short
      if (s === 'facts') {
        return bash(0, `${JSON.stringify({ path: join(dir, 'view.json'), changed: changedOf(view) })}\n`)
      }
      if (s === 'post') return bash(0, `${JSON.stringify(answerOf(post, given))}\n`, postSaid)
      if (s === 'stopped') return bash(0, `${JSON.stringify(answerOf(stopped, given))}\n`)
    }
    if (c.startsWith('cat -- ') && c.endsWith("/manifest.json'")) {
      read.push(c)
      const short = cutOff('manifest')
      if (short) return short
      const there = manifest ?? left
      return there ? bash(0, typeof there === 'string' ? there : JSON.stringify(there)) : bash(1, '', `cat: ${c.slice(8, -1)}: No such file or directory`)
    }
    if (c.startsWith('curl ')) {
      const step = c.includes('/CHECKS.md') ? 'checks' : 'guide'
      calls.push({ step, command: c })
      const short = cutOff(step)
      if (short) return short
      return fail && fail.step === step ? bash(fail.exit, '', 'curl: (22) 404') : bash(0, step === 'checks' ? checks : readme)
    }
    if (c.includes('/ctoc -')) return bash(0, '100 tokens, 0 uncertain (0.0%)\n')
    if (c.startsWith('rm -rf -- ')) { calls.push({ step: 'clear', command: c }); return bash(0) }
    throw new Error(`a command the stand-in doesn't know: ${c.slice(0, 200)}`)
  }
  const agent = async (prompt: string, o: AgentOptions) => {
    asked.push({ prompt, model: o.model, kept: o.kept, check: o.check })
    if (answer instanceof Error) throw answer
    return frozen({ result: answer, transcript: [{ type: 'message', message: { role: 'user', content: [] } }] })
  }
  return { dir, calls, said, logs, asked, read, reads, answered, resolved, order, cuts, words: { agent, tools: tool, phase: () => {}, text: (line: string) => { logs.push(line) } } }
}

type Stood = ReturnType<typeof stand>

const run = async (s: Stood, args: Record<string, unknown> = {}) => (await runOf(body!))({ repo: REPO, number: 7, head: HEAD, ...args }, s.words)
const steps = (s: Stood) => s.calls.map((c) => c.step)
const refused = (category: string | null) => Object.assign(new Error(`Refused by the provider's safety classifier (category: ${category}). The content that stopped this session may stop yours too if you read it.`), { name: 'WorkflowCallError', data: { code: 'refused', category } })
const REFUSED = "the reader was refused by its provider's safety classifier, so it wrote no account; this view was asked for, so whoever asked is waiting on it"

test("the view's steps, facts, post and stopped among them, run from the release current names at the run's first call, in its state directory, whatever a later promote makes it", async () => {
  const cases: [string, Record<string, unknown>, Stood, RegExp | null, string[]][] = [
    ['a head with no change', {}, stand(), null, ['facts', 'post']],
    ['a changed head', {}, stand({ view: VIEW }), null, ['facts', 'post']],
    ['a refused reader', {}, stand({ view: VIEW, answer: refused('cyber') }), /the context view stopped, its stopped words posted at https:\/\/github\.com\/x#s1: the reader was refused by its provider's safety classifier, so it wrote no account; this view was asked for, so whoever asked is waiting on it; its directory is /, ['facts', 'stopped']],
    ['a dry run', { post: false }, stand({ view: VIEW }), null, ['facts', 'post']],
    ['a failure before the post', {}, stand({ fail: { step: 'facts', exit: 1, why: 'view.py facts: no' } }), /the context view stopped, its stopped words posted at https:\/\/github\.com\/x#s1: view facts failed/, ['facts', 'stopped']],
  ]
  for (const [what, args, s, fails, names] of cases) {
    const e = await run(s, args).then(() => null, (x) => x)
    if (fails) expect(String(e && e.message)).toMatch(fails)
    else expect(e).toBe(null)
    expect(s.order[0]).toBe('realpath')
    expect(s.resolved).toEqual([[RELEASES[0], STATE]])
    const steps = s.calls.filter((c) => c.release)
    expect([what, steps.map((c) => c.step)]).toEqual([what, names])
    expect(steps.map((c) => [c.release, c.cwd])).toEqual(steps.map(() => [RELEASES[0], STATE]))
  }
})

test("a current that names no installed release, or can't be read, fails the run before the run side or any step, and posts no stopped words", async () => {
  const cases: [Stand, string][] = [
    [{ releases: ['/home/nissa/astra/context-view'] }, `${CURRENT} resolves to /home/nissa/astra/context-view, which isn't a release under ${RELEASE_DIR}`],
    [{ releases: [`${RELEASES[0]}/bin`] }, `resolves to ${RELEASES[0]}/bin, which isn't a release under`],
    [{ versions: '/data/context-view/releases' }, `resolves to ${RELEASES[0]}, which isn't a release under ${RELEASE_DIR} (/data/context-view/releases)`],
    [{ releases: [[1, `realpath: ${CURRENT}: No such file or directory`, `${RELEASE_DIR}\n`]] }, `context-view:release failed (exit 1): realpath: ${CURRENT}: No such file or directory`],
    [{ cut: { release: 2 } }, `context-view:release came back incomplete twice, so where ${CURRENT} leads couldn't be read`],
  ]
  for (const [current, says] of cases) {
    const s = stand(current)
    const e = await run(s).then(() => null, (x) => x)
    expect(String(e && e.message)).toContain(says)
    expect(String(e && e.message).endsWith('No words saying it stopped were posted, since no release of the context view ran to post them.')).toBe(true)
    expect(s.calls).toEqual([])
    expect(s.said).toEqual([])
    for (const read of Object.keys(current.cut ?? {})) expect([read, s.cuts[read]]).toEqual([read, 0])
  }
})

test("the installed run side runs the poll's head under a SIGTERM deadline inside the Bash call, into the view's own directory, from a directory no promote removes", async () => {
  const s = stand()
  await run(s)
  const [r] = s.calls
  expect(r.cwd).toBe('/home/nissa/.local/state/context-view/views')
  expect(r.timeout_ms).toBe(600000)
  expect(RUN_DEADLINE).toBeLessThan(600)
  expect(r.command).toBe(`rm -f -- '/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}/manifest.json' && timeout -s TERM ${RUN_DEADLINE} bun '${RELEASES[0]}/run/context-view-run.ts' --repo 'context-manager' --pr 7 --head ${HEAD} --out '/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}'`)
})

test('a dry view given a harness branch runs the run side with CONTEXT_VIEW_HARNESS_REF naming it, in a directory named for it; one given none runs the installed release in its own', async () => {
  const dryDir = `/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}.dry`
  const branchDir = `${dryDir}.harness-me%2Fa'b`
  const s = stand()
  const result = await run(s, { post: false, harnessRef: "me/a'b" })
  expect(s.calls[0].command).toBe(`rm -f -- '${branchDir.replace(/'/g, `'\\''`)}/manifest.json' && timeout -s TERM ${RUN_DEADLINE} env CONTEXT_VIEW_HARNESS_REF='me/a'\\''b' bun '${RELEASES[0]}/run/context-view-run.ts' --repo 'context-manager' --pr 7 --head ${HEAD} --out '${branchDir.replace(/'/g, `'\\''`)}'`)
  expect(s.calls[1].input).toEqual({ dir: branchDir, repo: REPO })
  expect(result.label).toBe(`anima-research.context-manager.7.${HEAD.slice(0, 12)}.dry.harness-me%2Fa'b`)
  const t = stand()
  await run(t, { post: false })
  expect(t.calls[0].command).toBe(`rm -f -- '${dryDir}/manifest.json' && timeout -s TERM ${RUN_DEADLINE} bun '${RELEASES[0]}/run/context-view-run.ts' --repo 'context-manager' --pr 7 --head ${HEAD} --out '${dryDir}'`)
  const [u, v] = [stand(), stand()]
  await run(u, { post: false, harnessRef: 'me/a' })
  await run(v, { post: false, harnessRef: 'me_a' })
  expect(u.calls[1].input.dir).not.toBe(v.calls[1].input.dir)
})

test("the record's declared arguments are the ones the run reads, a harness branch among them, so the runner starts a run that names one", () => {
  const r = Bun.spawnSync(['git', '-C', RECORDS, 'show', 'HEAD:workflows/context-view.md'])
  const front = Bun.YAML.parse(r.stdout.toString().split(/^---$/m)[1]!) as { args: { properties: Record<string, unknown>, required: string[], additionalProperties: boolean } }
  expect(Object.keys(front.args.properties).sort()).toEqual(['auto', 'harnessRef', 'head', 'number', 'post', 'repo', 'view'])
  expect(front.args.properties.auto).toMatchObject({ type: 'boolean', default: false })
  expect(front.args.properties.harnessRef).toMatchObject({ type: 'string', minLength: 1 })
  expect(front.args.properties.view).toMatchObject({ type: 'string', pattern: '^/' })
  expect(front.args.required).toEqual(['repo', 'number', 'head'])
  expect(front.args.additionalProperties).toBe(false)
})

test('a harness branch is refused before anything runs, the release resolved included, for a view that posts and for one that names no branch', async () => {
  for (const [args, says] of [
    [{ harnessRef: 'me/a' }, 'only a dry view (post: false) may name a harness branch'],
    [{ harnessRef: 'me/a', post: true }, 'only a dry view (post: false) may name a harness branch'],
    [{ harnessRef: '', post: false }, 'harnessRef names a branch of anima-research/context-view'],
    [{ harnessRef: 7, post: false }, 'harnessRef names a branch of anima-research/context-view'],
  ] as [Record<string, unknown>, string][]) {
    const s = stand()
    const e = await run(s, args).then(() => null, (x) => x)
    expect([JSON.stringify(args), String(e && e.message)]).toEqual([JSON.stringify(args), expect.stringContaining(says)])
    expect(s.order).toEqual([])
    expect(s.said).toEqual([])
  }
})

const shown = (s: Stood, view: object | null) => {
  if (view) writeFileSync(join(s.dir, 'view.json'), JSON.stringify(view))
  return s
}

test("a dry view given a directory's view.json runs no jobs and no facts: a changed one is read with the guide at its harness commit, and post writes the comment there", async () => {
  const s = shown(stand(), { ...VIEW, harness: { repo: HARNESS, sha: 'a'.repeat(40) } })
  const result = await run(s, { post: false, view: s.dir })
  expect(s.resolved).toEqual([[RELEASES[0], STATE]])
  expect(steps(s)).toEqual(['guide', 'checks', 'post'])
  expect(s.calls[0].command).toBe(`curl -sfL --max-time 60 'https://raw.githubusercontent.com/${HARNESS}/${'a'.repeat(40)}/harness/README.md'`)
  expect(s.calls[1].command).toBe(`curl -sfL --max-time 60 'https://raw.githubusercontent.com/${HARNESS}/${'a'.repeat(40)}/CHECKS.md'`)
  expect(s.asked.length).toBe(1)
  expect(s.asked[0].prompt).toContain('"base line"')
  const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
  expect(s.calls[2].input).toEqual({ dir: s.dir, reader: join(s.dir, 'reader.json'), post: false, reads: { instructions: sha(INSTRUCTIONS), guide: sha(`The guide's own text.\n\n${CHECKS}`) } })
  expect(result).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}.dry`, outcome: 'ran', action: 'dry', parts: 1, cut: null })
  const u = shown(stand(), UNCHANGED)
  await run(u, { post: false, view: u.dir })
  expect(steps(u)).toEqual(['post'])
  expect(u.asked).toEqual([])
  expect(u.calls[0].input).toEqual({ dir: u.dir, reader: null, post: false })
  const moved = { repo: REPO, number: 7, head: HEAD, outcome: 'moved', detail: { headNow: 'f'.repeat(40) } }
  const w = shown(stand({ post: { action: 'moved' } }), moved)
  expect(await run(w, { post: false, view: w.dir })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}.dry`, outcome: 'moved', action: 'moved' })
  expect(steps(w)).toEqual(['post'])
  expect(w.asked).toEqual([])
})

test("a view to read is refused before anything runs, the release resolved included: for a view that posts, beside a harness branch, by a path that isn't absolute, and for a view.json that isn't there or is another head's", async () => {
  for (const [args, says, view] of [
    [{}, 'only a dry view (post: false) may read a view.json it was given', VIEW],
    [{ post: true }, 'only a dry view (post: false) may read a view.json it was given', VIEW],
    [{ post: false, harnessRef: 'me/a' }, "runs no jobs, so it names no harness branch", VIEW],
    [{ post: false, view: 'views/x' }, 'view names a directory by its absolute path, not "views/x"', VIEW],
    [{ post: false, view: 7 }, 'view names a directory by its absolute path, not 7', VIEW],
    [{ post: false }, `/view.json is a view of ${REPO} #8 at ${HEAD}, not of ${REPO} #7 at ${HEAD}`, { ...VIEW, number: 8 }],
    [{ post: false }, `/view.json is a view of ${REPO} #7 at ${'f'.repeat(40)}, not of`, { ...VIEW, head: 'f'.repeat(40) }],
    [{ post: false }, `/view.json is a view of anima-research/membrane #7`, { ...VIEW, repo: 'anima-research/membrane' }],
    [{ post: false }, "/view.json couldn't be read", null],
  ] as [Record<string, unknown>, string, object | null][]) {
    const s = shown(stand(), view)
    const e = await run(s, { view: s.dir, ...args }).then(() => null, (x) => x)
    expect([JSON.stringify(args), String(e && e.message)]).toEqual([JSON.stringify(args), expect.stringContaining(says)])
    expect(String(e && e.message).endsWith('; nothing ran')).toBe(true)
    expect(s.order).toEqual([])
    expect(s.said).toEqual([])
  }
})

test('a head whose records show no change posts fixed words with no model call, then the shares go', async () => {
  const s = stand()
  const result = await run(s)
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'clear'])
  expect(s.asked).toEqual([])
  const dir = `/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}`
  expect(s.calls[1].input).toEqual({ dir, repo: REPO })
  expect(s.calls[2].input).toEqual({ dir, reader: null, post: true })
  expect('reads' in s.calls[2].input).toBe(false)
  expect(s.calls[3].command).toBe(`rm -rf -- '${dir}'/share-*`)
  expect(result).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}`, outcome: 'ran', action: 'posted', url: 'https://github.com/x#c1' })
})

test("an automatic view of a head no stack of releases could run posts nothing and settles, where an ask's view posts it", async () => {
  const manifested = Object.fromEntries(Object.entries(VIEW).filter(([k]) => !['held', 'runs', 'flags', 'reached', 'entries', 'broken'].includes(k)))
  const stopped = { ...manifested, baseRef: 'main', outcome: 'needs-companion', detail: null, jobs: 0 }
  const s = stand({ run: 3, view: stopped })
  expect(await run(s, { auto: true })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}`, outcome: 'needs-companion', action: 'none' })
  expect(steps(s)).toEqual(['run', 'facts'])
  const asked = stand({ run: 3, view: stopped })
  expect((await run(asked)).outcome).toBe('needs-companion')
  expect(steps(asked)).toEqual(['run', 'facts', 'post', 'clear'])
  expect(asked.calls.filter((c) => c.step === 'clear').map((c) => c.command)).toEqual([expect.stringMatching(/^rm -rf -- '[^']+'\/share-\*$/)])
})

test("an automatic view's failure before its post posts no stopped words and fails the run, and one in post still posts them", async () => {
  for (const [what, s, said, before] of [
    ['the run side', stand({ run: 2 }), "the run side couldn't run it (exit 2): context-view-run: on-gh failed", ['run']],
    ['facts', stand({ fail: { step: 'facts', exit: 1, why: 'view.py facts: no' } }), 'view facts failed (exit 1): view.py facts: no', ['run', 'facts']],
    ['view.json', stand({ view: VIEW, cut: { 'view.json': 2 } }), 'came back incomplete twice', ['run', 'facts']],
  ] as const) {
    const e = await run(s, { auto: true }).then(() => null, (x) => x)
    expect([what, e && e.message]).toEqual([what, expect.stringContaining(`the automatic context view stopped before its post, which posts no stopped words: `)])
    expect([what, e && e.message]).toEqual([what, expect.stringContaining(said)])
    expect([what, steps(s)]).toEqual([what, [...before]])
  }
  const inPost = stand({ fail: { step: 'post', exit: 1, why: 'view.py post: no' } })
  const e = await run(inPost, { auto: true }).then(() => null, (x) => x)
  expect(e && e.message).toMatch(/the context view stopped, its stopped words posted at https:\/\/github\.com\/x#s1: view post failed/)
  expect(steps(inPost)).toEqual(['run', 'facts', 'post', 'stopped'])
})

test("an automatic view of a head that ran posts as any view does", async () => {
  const s = stand()
  expect(await run(s, { auto: true })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}`, outcome: 'ran', action: 'posted', url: 'https://github.com/x#c1' })
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'clear'])
})

test("a post that answers with the comment up and says on stderr that its Changes context wasn't wanted settles as posted", async () => {
  const s = stand({ postSaid: "post: its Changes context, No, wasn't wanted: review-poll exited 2: review-poll: no such step, want\n" })
  expect(await run(s, { auto: true })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}`, outcome: 'ran', action: 'posted', url: 'https://github.com/x#c1' })
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'clear'])
})

test("an automatic view of a head whose records differ runs no reader, so its post gets no account, where a view asked for at that head runs one", async () => {
  const auto = stand({ view: VIEW })
  expect(await run(auto, { auto: true })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}`, outcome: 'ran', action: 'posted', url: 'https://github.com/x#c1' })
  expect([steps(auto), auto.asked.length]).toEqual([['run', 'facts', 'post', 'clear'], 0])
  expect(auto.calls.find((c) => c.step === 'post')!.input).toEqual({ dir: auto.calls[1].input.dir, reader: null, post: true })
  const asked = stand({ view: VIEW })
  await run(asked)
  expect([steps(asked), asked.asked.length]).toEqual([['run', 'facts', 'guide', 'checks', 'post', 'clear'], 1])
  const given = asked.calls.find((c) => c.step === 'post')!.input
  expect(Object.keys(given).sort()).toEqual(['dir', 'post', 'reader', 'reads'])
  expect([typeof given.reader, given.reader === null, given.reads === null || given.reads === undefined]).toEqual(['string', false, false])
})

test("the views' poll reads a head's view.json in the directory a posting view keeps it in", async () => {
  const s = stand()
  await run(s, { auto: true })
  const r = Bun.spawnSync(['uv', 'run', '--quiet', '--frozen', '--project', VIEW_DIR, 'python', '-c', `import json, os, poll; print(json.dumps([os.path.relpath(poll.STATE, os.path.expanduser('~')), os.path.relpath(poll.view_dir(${JSON.stringify(REPO)}, 7, ${JSON.stringify(HEAD)}), poll.STATE)]))`], { cwd: VIEW_DIR, env: { ...process.env, UV_NO_BUILD: '0' } })
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
  expect(JSON.parse(r.stdout.toString())).toEqual([relative('/home/nissa', STATE), relative(STATE, s.calls[1].input.dir)])
})

test("a head that couldn't be compared, or has nothing to run, goes to facts and post, not the stopped words", async () => {
  const manifested = Object.fromEntries(Object.entries(VIEW).filter(([k]) => !['held', 'runs', 'flags', 'reached', 'entries', 'broken'].includes(k)))
  const s = stand({ run: 3, view: { ...manifested, baseRef: 'main', outcome: 'doesnt-merge', detail: null, jobs: 0 } })
  const result = await run(s)
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'clear'])
  expect(result.outcome).toBe('doesnt-merge')
})

test('where the post step posts nothing, for a head that moved or a pull request that closed, the shares go all the same', async () => {
  for (const action of ['moved', 'closed']) {
    const detail = action === 'moved' ? { headNow: 'f'.repeat(40) } : { state: 'closed' }
    const s = stand({ run: 3, view: { repo: REPO, number: 7, head: HEAD, outcome: action, detail }, post: { action } })
    const result = await run(s)
    expect(steps(s)).toEqual(['run', 'facts', 'post', 'clear'])
    expect(result.action).toBe(action)
  }
})


test("every outcome the run side writes is one facts knows, with the exit code the workflow branches on, and post answers moved and closed by name, posting nothing", async () => {
  const { EXIT } = await import('../run/interfaces.ts')
  const python = (code: string, stdin?: string) => Bun.spawnSync(['uv', 'run', '--quiet', '--frozen', '--project', VIEW_DIR, 'python', '-c', code], { cwd: VIEW_DIR, env: { ...process.env, UV_NO_BUILD: '0' }, ...(stdin ? { stdin: Buffer.from(stdin) } : {}) })
  const py = (code: string) => {
    const r = python(code)
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return JSON.parse(r.stdout.toString())
  }
  expect(Object.keys(EXIT).filter((o) => !py('import json, view_read; print(json.dumps(view_read.OUTCOMES))').includes(o))).toEqual([])
  expect(Object.fromEntries(Object.entries(EXIT).map(([o, code]) => [o, code === 0 ? 'ran' : code === 3 ? 'facts' : 'stopped']))).toEqual({ ran: 'ran', moved: 'facts', closed: 'facts', 'doesnt-merge': 'facts', 'needs-companion': 'facts', 'arm-missing': 'facts', 'couldnt-run': 'stopped', elsewhere: 'facts', unchanged: 'facts' })
  expect(EXIT).toEqual({ ran: 0, moved: 3, closed: 3, 'doesnt-merge': 3, 'needs-companion': 3, 'arm-missing': 3, 'couldnt-run': 2, elsewhere: 3, unchanged: 3 })
  for (const outcome of ['moved', 'closed'] as const) {
    expect(EXIT[outcome]).toBe(3)
    const dir = mkdtempSync(join(tmpdir(), 'context-view-post-'))
    made.push(dir)
    writeFileSync(join(dir, 'view.json'), JSON.stringify({ repo: REPO, number: 7, head: HEAD, base: 'a'.repeat(40), form: 'overlay', host: 'c'.repeat(40), outcome, detail: null, jobs: 0, title: 't', body: 'b' }))
    const r = python("import sys, view; sys.exit(view.main(['post']))", JSON.stringify({ dir, reader: null, post: false }))
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
    expect(JSON.parse(r.stdout.toString().trim().split('\n').pop()!).action).toBe(outcome)
    expect(existsSync(join(dir, 'comment.md'))).toBe(false)
  }
})

test("a changed head is read: the reader gets the instructions, the harness's guide and CHECKS.md at the harness commit view.json names and the view, and its checked account goes to post as a file", async () => {
  const s = stand({ view: VIEW })
  const result = await run(s)
  expect(steps(s)).toEqual(['run', 'facts', 'guide', 'checks', 'post', 'clear'])
  expect(s.calls[2].command).toBe(`curl -sfL --max-time 60 'https://raw.githubusercontent.com/${HARNESS}/${HARNESS_AT}/harness/README.md'`)
  expect(s.calls[3].command).toBe(`curl -sfL --max-time 60 'https://raw.githubusercontent.com/${HARNESS}/${HARNESS_AT}/CHECKS.md'`)
  expect(s.asked.length).toBe(1)
  const [{ prompt, model, check }] = s.asked
  expect(model).toBe('sol-prompt')
  expect(prompt.startsWith(INSTRUCTIONS)).toBe(true)
  expect(prompt).toContain(`## How to read a record line, and what the runs do (from the harness's docs)\n\nThe guide's own text.\n\n${CHECKS}`)
  expect(prompt).toContain('"base line"')
  expect(check(ANSWER)).toEqual([])
  const reader = s.calls[4].input.reader
  expect(s.calls[4].input.dir).toBe(`/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}`)
  expect(reader).toBe(join(s.dir, 'reader.json'))
  const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
  expect(s.calls[4].input.reads).toEqual({ instructions: sha(INSTRUCTIONS), guide: sha(`The guide's own text.\n\n${CHECKS}`) })
  expect(JSON.parse(readFileSync(reader, 'utf8'))).toEqual({ changes: [{ ...ANSWER.changes[0], place: { run: 'H1/W2', step: 1 } }] })
  expect(result.cut).toBeNull()
})

test("the reader's bound is GPT-6.1 Sol's: its usable window less a full reply, less what the call adds around the prompt", () => {
  expect([LIMIT, OVERHEAD, BOUND]).toEqual([700400, 1107, 700400 - 1107])
})

test('runs it could compare that differ are read beside runs it couldn\'t compare, and the reader is told those by run and kind', async () => {
  const s = stand({ view: { ...VIEW, broken: [{ run: 'H3/W4', what: 'read', reason: '', reads: { head: ['receipt'], base: [] } }] } })
  await run(s)
  expect(steps(s)).toEqual(['run', 'facts', 'guide', 'checks', 'post', 'clear'])
  expect(s.asked.length).toBe(1)
  expect(s.asked[0].prompt).toContain('"broken": [\n  {\n   "run": "H3/W4",\n   "what": "read"\n  }\n ]')
  expect(s.asked[0].prompt).not.toContain('receipt')
})

test("the reader's kept is the view's inputs, so a run started again on the same view gets its answer back, and another view asks afresh", async () => {
  const a = stand({ view: VIEW }), b = stand({ view: VIEW })
  const c = stand({ view: { ...VIEW, title: 'another title' } })
  for (const s of [a, b, c]) await run(s)
  expect(a.asked[0].kept).toEqual(b.asked[0].kept)
  expect(Object.keys(a.asked[0].kept!)).toEqual(['contextView'])
  expect(c.asked[0].kept).not.toEqual(a.asked[0].kept)
})

const stops: [string, Stand, string[], RegExp][] = [
  ['the run side exits 2', { run: 2 }, ['run'], /couldn't run it \(exit 2\)/],
  ['the Bash call times out', { run: { isError: false, structuredContent: { exit_code: null, timed_out: true, stdout: '', stderr: '' }, content: [{ type: 'text', text: 'timed out' }] } }, ['run'], /exit null/],
  ['facts fails', { fail: { step: 'facts', exit: 1, why: "view.py facts: run H1/W2 is in two shares" } }, ['run', 'facts'], /two shares/],
  ["the harness's README can't be read", { view: VIEW, fail: { step: 'guide', exit: 22 } }, ['run', 'facts', 'guide'], /README at e+ couldn't be read/],
  ["the harness's CHECKS.md can't be read", { view: VIEW, fail: { step: 'checks', exit: 22 } }, ['run', 'facts', 'guide', 'checks'], /CHECKS\.md at e+ couldn't be read/],
  ['the README has no guide section', { view: VIEW, readme: '# Whole-host records\n\n## Running it\n' }, ['run', 'facts', 'guide', 'checks'], /no "## Reading a record" section, or its CHECKS\.md is empty/],
  ["the harness's CHECKS.md is empty", { view: VIEW, checks: '\n' }, ['run', 'facts', 'guide', 'checks'], /or its CHECKS\.md is empty/],
  ["the harness's README comes back cut off twice", { view: VIEW, cut: { guide: 2 } }, ['run', 'facts', 'guide', 'guide'], /the harness's README at e+ came back incomplete twice, so the reader's guide couldn't be read/],
  ["the harness's CHECKS.md comes back cut off twice", { view: VIEW, cut: { checks: 2 } }, ['run', 'facts', 'guide', 'checks', 'checks'], /the harness's CHECKS\.md at e+ came back incomplete twice, so the reader's guide couldn't be read/],
  ["facts' answer comes back cut off, and isn't asked again", { cut: { facts: 1 } }, ['run', 'facts'], /view facts's answer came back incomplete, so what it did can't be read/],
  ["view.json comes back cut off twice", { view: VIEW, cut: { 'view.json': 2 } }, ['run', 'facts'], /view\.json came back incomplete twice, so it couldn't be read/],
  ["the harness's README comes back twice with part of it as stdout, marked cut off only by output_complete", { view: VIEW, cut: { guide: 2 }, cutAs: 'part' }, ['run', 'facts', 'guide', 'guide'], /the harness's README at e+ came back incomplete twice/],
  ["the harness's README comes back twice with its stdout elided past the budget, output_complete true", { view: VIEW, cut: { guide: 2 }, cutAs: 'elided' }, ['run', 'facts', 'guide', 'guide'], /the harness's README at e+ came back incomplete twice/],
  ["the reader's last try still has problems", { view: VIEW, answer: { ...ANSWER, changes: [{ ...ANSWER.changes[0], after: 'not in the record' }] } }, ['run', 'facts', 'guide', 'checks'], /last try still had/],
]
for (const [what, given, before, why] of stops) {
  test(`before the post, ${what}: the stopped words post, and the run fails saying why`, async () => {
    const s = stand(given)
    const e = await run(s).then(() => null, (x) => x)
    expect(e && e.message).toMatch(why)
    expect(e.message).toMatch(/its stopped words posted at https:\/\/github.com\/x#s1/)
    expect(e.message).toContain(`its directory is /home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}`)
    expect(steps(s)).toEqual([...before, 'stopped'])
    expect(s.calls.at(-1)!.input).toEqual({ repo: REPO, number: 7, head: HEAD, post: true })
    for (const read of Object.keys(given.cut ?? {})) expect([read, s.cuts[read]]).toEqual([read, 0])
  })
}

test('a failure before the post whose pull request has moved on or closed posts no stopped words, and the run still fails saying so', async () => {
  const moved = stand({ run: 2, stopped: { action: 'moved', headNow: 'f'.repeat(40) } })
  const e = await run(moved).then(() => null, (x) => x)
  expect(e && e.message).toMatch(new RegExp(`its stopped words not posted, since the pull request's head had moved to ${'f'.repeat(40)}: the run side couldn't run it`))
  expect(steps(moved)).toEqual(['run', 'stopped'])
  const closed = stand({ fail: { step: 'facts', exit: 1, why: 'view.py facts: no' }, stopped: { action: 'closed', state: 'closed' } })
  await expect(run(closed)).rejects.toThrow(/its stopped words not posted, since the pull request is closed: view facts failed/)
})

test('stopped words that fail to post fail the run naming both', async () => {
  const s = stand({ run: 2, fail: { step: 'stopped', exit: 1, why: 'view.py stopped: GitHub said 502' } })
  const e = await run(s).then(() => null, (x) => x)
  expect(e.message).toMatch(/couldn't run it.*stopped words couldn't post.*502/s)
})

test("a repository the view doesn't cover (facts' exit 2) fails the run with nothing posted", async () => {
  const s = stand({ fail: { step: 'facts', exit: 2, why: "view.py facts: x/y isn't one of the context view's repositories" } })
  await expect(run(s)).rejects.toThrow(/isn't one of the context view's repositories/)
  expect(steps(s)).toEqual(['run', 'facts'])
})

test("a read that's safe to repeat, the release, view.json, the guide's two files or the run side's manifest, comes back cut off once, is asked once more, and the view goes on as if it hadn't", async () => {
  const s = stand({ view: VIEW, cut: { release: 1, 'view.json': 1, guide: 1, checks: 1 } })
  await run(s)
  expect(steps(s)).toEqual(['run', 'facts', 'guide', 'guide', 'checks', 'checks', 'post', 'clear'])
  expect(s.cuts).toEqual({ release: 0, 'view.json': 0, guide: 0, checks: 0 })
  expect(s.order.filter((c) => c === 'realpath').length).toBe(2)
  expect(s.asked.length).toBe(1)
  expect(s.asked[0].prompt).toContain("The guide's own text.")
  expect(s.asked[0].prompt).toContain('What each run does.')
  const why = "the run side failed before any job: the head's package.json isn't JSON"
  const once = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why } }, cut: { manifest: 1 } })
  expect(await run(once).then(() => null, (e) => e.message)).toContain(`the run side couldn't run it (exit 2): ${why}; its directory is `)
  expect(once.read.length).toBe(2)
  const twice = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why } }, cut: { manifest: 2 } })
  expect(await run(twice).then(() => null, (e) => e.message)).toMatch(/the run side couldn't run it \(exit 2\): context-view-run: on-gh failed; its manifest came back incomplete twice, so the run side's own words couldn't be read; its directory is /)
  expect([twice.read.length, twice.cuts.manifest]).toEqual([2, 0])
})

test("a view.json larger than one Bash answer holds is read 90,000 code points at a time, each slice within the answer's 200,000 characters, and reaches the run whole", async () => {
  const body = Array.from({ length: 1500 }, (_, i) => String(i).padStart(4, '0') + '\u{1D4B3}'.repeat(96)).join('') + ' the end of the body'
  const s = stand({ view: { ...VIEW, body } })
  await run(s)
  expect(s.reads).toEqual([0, 90_000, 180_000].map((at) => ({ label: 'view.json', at })))
  const file = JSON.stringify({ ...VIEW, body })
  expect(s.answered.reduce((a, b) => a + b, 0)).toBe(file.length)
  expect(s.answered.every((n) => n <= 200_000)).toBe(true)
  expect(steps(s)).toEqual(['run', 'facts', 'guide', 'checks', 'post', 'clear'])
  expect(s.asked.length).toBe(1)
  expect(s.asked[0].prompt).toContain(body)
})

test("a Bash call asking for more output than Hands gives, past 200,000 characters, is refused before it runs, whatever its command, as Hands' schema refuses it", async () => {
  const s = stand({ cut: { 'view.json': 1, release: 1 } })
  const commands = [`python3 -c 'import sys; s = open(sys.argv[1], encoding="utf-8", newline="").read()' /dev/null 0`, `realpath -e ${CURRENT} ${RELEASE_DIR}`, 'curl -fsS https://example.invalid/README.md']
  for (const command of commands) {
    await expect(withWords(s.words, () => (globalThis as any).tools.mcp__hands__Bash({ command, max_output_chars: 300_000 }))).rejects.toThrow(/max_output_chars must be a whole number from 1,000 to 200,000, not 300000/)
  }
  expect([s.cuts['view.json'], s.cuts.release, s.calls, s.order]).toEqual([1, 1, [], []])
})

test('an answer longer than the budget its call asks for comes back as Hands gives it, with no stdout and the characters left out, whatever its command', async () => {
  const readme = `${README}${'x'.repeat(5000)}`
  const s = stand({ readme })
  const got = await withWords(s.words, () => (globalThis as any).tools.mcp__hands__Bash({ command: 'curl -fsS https://example.invalid/README.md', max_output_chars: 1000 }))
  expect(got.structuredContent).toEqual({ exit_code: 0, timed_out: false, stdout: null, stderr: '', output_complete: true, elided_chars: readme.length - 1000 })
  const whole = await withWords(s.words, () => (globalThis as any).tools.mcp__hands__Bash({ command: 'curl -fsS https://example.invalid/README.md', max_output_chars: readme.length }))
  expect(whole.structuredContent.stdout).toBe(readme)
})

test("the stand holds stdout and stderr to one budget, split as the house's Bash tool splits it: a stream over its share comes back null, and output that fits comes back whole", async () => {
  const s = stand()
  const lengths = async (out: number, err: number) => {
    const command = `python3 -c 'import sys; open(sys.argv[1], "wb")' /dev/null; head -c ${out} /dev/zero | tr '\\0' a; head -c ${err} /dev/zero | tr '\\0' b >&2`
    const got = await withWords(s.words, () => (globalThis as any).tools.mcp__hands__Bash({ command, max_output_chars: 1000 }))
    return [got.structuredContent.stdout?.length ?? null, got.structuredContent.stderr?.length ?? null]
  }
  expect(await lengths(801, 801)).toEqual([null, null])
  expect(await lengths(1501, 101)).toEqual([null, 101])
  expect(await lengths(101, 1501)).toEqual([101, null])
  expect(await lengths(300, 300)).toEqual([300, 300])
})

test("stopped words whose step ran but whose answer came back cut off are said to be unknown, not unposted, and aren't asked again", async () => {
  const s = stand({ run: 2, cut: { stopped: 1 } })
  const e = await run(s).then(() => null, (x) => x)
  expect(e && e.message).toMatch(/the context view stopped \(the run side couldn't run it \(exit 2\): context-view-run: on-gh failed\), and its stopped words' step ran, but its answer came back incomplete, so whether they posted isn't known; its directory is /)
  expect(e.message).not.toMatch(/couldn't post/)
  expect(steps(s)).toEqual(['run', 'stopped'])
})

test("a run side that couldn't run it is named in its manifest's words, with the share that failed, and stderr's tail only where it wrote no manifest", async () => {
  const at = (s: Stood) => run(s).then(() => null, (e) => e.message)
  const before = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why: "the run side failed before any job: the head's package.json isn't JSON" } } })
  expect(await at(before)).toMatch(/the run side couldn't run it \(exit 2\): the run side failed before any job: the head's package\.json isn't JSON; its directory is /)
  expect(before.read).toEqual([`cat -- '/home/nissa/.local/state/context-view/views/anima-research.context-manager.7.${HEAD.slice(0, 12)}/manifest.json'`])
  const stop = stand({ run: 124, manifest: { outcome: 'couldnt-run', detail: { why: 'stopped by SIGTERM after 599 s', shares: [3] } } })
  expect(await at(stop)).toMatch(/the run side couldn't run it \(exit 124\): stopped by SIGTERM after 599 s; its directory is /)
  const job = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { share: 4, why: 'its setup failed (exit 1)', headNow: 'f'.repeat(40) } } })
  expect(await at(job)).toMatch(/the run side couldn't run it \(exit 2\): its setup failed \(exit 1\) \(share 4\); its directory is /)
  const none = stand({ run: 2 })
  expect(await at(none)).toMatch(/the run side couldn't run it \(exit 2\): context-view-run: on-gh failed; its directory is /)
  const other = stand({ run: 2, manifest: { outcome: 'ran', detail: { why: 'words no couldnt-run manifest wrote' } } })
  expect(await at(other)).toMatch(/the run side couldn't run it \(exit 2\): context-view-run: on-gh failed; its directory is /)
  const garbled = stand({ run: 2, manifest: '{"outcome": "couldnt-run", "detail": {"why": "cut off' })
  expect(await at(garbled)).toMatch(/the run side couldn't run it \(exit 2\): context-view-run: on-gh failed; its directory is /)
  const stale = stand({ run: 2, left: { outcome: 'couldnt-run', detail: { why: "an earlier run's why", share: 9 } } })
  expect(await at(stale)).toMatch(/the run side couldn't run it \(exit 2\): context-view-run: on-gh failed; its directory is /)
  for (const s of [before, stop, job, none, other, garbled, stale]) expect(steps(s)).toEqual(['run', 'stopped'])
  const ran = stand()
  await run(ran)
  expect(ran.read).toEqual([])
})

test('a failure in post gets the stopped words too, or none for a head that moved or a pull request that closed, and fails the run naming both', async () => {
  const s = stand({ fail: { step: 'post', exit: 1, why: 'view.py post: GitHub said 502 on part 2' } })
  await expect(run(s)).rejects.toThrow(/its stopped words posted at https:\/\/github\.com\/x#s1: view post failed.*part 2/)
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'stopped'])
  const moved = stand({ fail: { step: 'post', exit: 1, why: 'view.py post: GitHub said 502 on part 2' }, stopped: { action: 'moved', headNow: 'f'.repeat(40) } })
  await expect(run(moved)).rejects.toThrow(/its stopped words not posted, since the pull request's head had moved/)
  expect(steps(moved)).toEqual(['run', 'facts', 'post', 'stopped'])
  const closed = stand({ fail: { step: 'post', exit: 1, why: 'view.py post: GitHub said 502 on part 2' }, stopped: { action: 'closed', state: 'closed' } })
  await expect(run(closed)).rejects.toThrow(/its stopped words not posted, since the pull request is closed: view post failed.*part 2/)
  expect(steps(closed)).toEqual(['run', 'facts', 'post', 'stopped'])
  const uncovered = stand({ fail: { step: 'post', exit: 2, why: "view.py post: x/y isn't one of the context view's repositories" } })
  await expect(run(uncovered)).rejects.toThrow(/isn't one of the context view's repositories/)
  expect(steps(uncovered)).toEqual(['run', 'facts', 'post'])
})

test("post's answer cut off isn't asked again: stopped runs, and the run fails saying post's answer came back incomplete", async () => {
  const s = stand({ cut: { post: 1 } })
  await expect(run(s)).rejects.toThrow(/its stopped words posted at https:\/\/github\.com\/x#s1: view post's answer came back incomplete, so what it did can't be read/)
  expect(steps(s)).toEqual(['run', 'facts', 'post', 'stopped'])
  const there = stand({ cut: { post: 1 }, stopped: { action: 'unchanged', url: 'https://github.com/x#c1', found: 'view' } })
  await expect(run(there)).rejects.toThrow(/a view of this head already there at https:\/\/github\.com\/x#c1: view post's answer came back incomplete/)
  expect(steps(there)).toEqual(['run', 'facts', 'post', 'stopped'])
})

test('where stopped finds a whole view of this head already there, the run fails saying a view is there, not stopped words', async () => {
  const view = { action: 'unchanged', url: 'https://github.com/x#c1', found: 'view' }
  const afterPost = stand({ fail: { step: 'post', exit: 1, why: 'view.py post: its last line was not JSON' }, stopped: view })
  await expect(run(afterPost)).rejects.toThrow(/the context view stopped, a view of this head already there at https:\/\/github\.com\/x#c1: view post failed/)
  const before = stand({ run: 2, stopped: view })
  await expect(run(before)).rejects.toThrow(/the context view stopped, a view of this head already there at https:\/\/github\.com\/x#c1: the run side couldn't run it/)
  const words = stand({ run: 2, stopped: { action: 'unchanged', url: 'https://github.com/x#s1', found: 'stopped' } })
  await expect(run(words)).rejects.toThrow(/the context view stopped, its stopped words already there at https:\/\/github\.com\/x#s1: /)
})

test("a reader refused by its classifier stops the view as any failure before the post does: the stopped words, a failed run, no Commons, and no category anywhere", async () => {
  const s = stand({ view: VIEW, answer: refused('cyber') })
  const e = await run(s).then(() => null, (x) => x)
  expect(e.message.startsWith(`the context view stopped, its stopped words posted at https://github.com/x#s1: ${REFUSED}; its directory is /`)).toBe(true)
  expect(steps(s)).toEqual(['run', 'facts', 'guide', 'checks', 'stopped'])
  expect(s.said).toEqual([])
  const out = JSON.stringify([s.calls.map((c) => c.input ?? null), s.said, s.logs, e.message])
  expect(out).not.toMatch(/\bcyber\b/)
  for (const words of ["Refused by the provider's safety classifier", 'The content that stopped this session may stop yours too']) expect(out).not.toContain(words)
  const there = stand({ view: VIEW, answer: refused('cyber'), stopped: { action: 'unchanged', url: 'https://github.com/x#c1', found: 'view' } })
  await expect(run(there)).rejects.toThrow(`the context view stopped, a view of this head already there at https://github.com/x#c1: ${REFUSED}`)
  expect(there.said).toEqual([])
})

test('post false posts nothing on GitHub or in Commons: the steps get it, a refusal fails the run as any failure does, and the shares stay', async () => {
  const dry = stand()
  expect(await run(dry, { post: false })).toEqual({ label: `anima-research.context-manager.7.${HEAD.slice(0, 12)}.dry`, outcome: 'ran', action: 'dry', parts: 1 })
  expect(dry.calls[0].command).toContain(`.7.${HEAD.slice(0, 12)}.dry'`)
  expect(dry.calls[2].input.post).toBe(false)
  expect(steps(dry)).toEqual(['run', 'facts', 'post'])
  expect(dry.said).toEqual([])
  const stoppedDry = stand({ run: 2 })
  await expect(run(stoppedDry, { post: false })).rejects.toThrow(/its stopped words not posted \(dry\)/)
  expect(stoppedDry.calls.at(-1)!.input.post).toBe(false)
  const refusedDry = stand({ view: VIEW, answer: refused('cyber') })
  const dryError = await run(refusedDry, { post: false }).then(() => null, (x) => x)
  expect(dryError.message).toContain(`its stopped words not posted (dry): ${REFUSED}`)
  expect(dryError.message).not.toMatch(/\bcyber\b/)
  for (const words of ["Refused by the provider's safety classifier", 'The content that stopped this session may stop yours too']) expect(dryError.message).not.toContain(words)
  expect(refusedDry.said).toEqual([])
  expect(steps(refusedDry)).toEqual(['run', 'facts', 'guide', 'checks', 'stopped'])
})

test('the machinery names each range a view forced, and a view that forced none gives the reader none: in the prompt a run gives the reader, under the real instructions, which say what a forced range is', async () => {
  const forced = { base: [], head: [{ range: '^0.25.0', wantedBy: 'node_modules/@animalabs/agent-framework', has: '0.26.0' }] }
  expect(inputsOf({ ...viewOf([E('a1', 'base line', 'head line')]), forced }).machinery.forced).toEqual(forced)
  const machineryOf = (prompt: string) => JSON.parse(prompt.split("## The machinery's summary\n\n")[1]!.split('\n\n## The entries')[0]!)
  const given = async (view: object) => {
    const s = shown(stand(), view)
    await run(s, { post: false, view: s.dir })
    expect(s.asked.length).toBe(1)
    return s.asked[0].prompt as string
  }
  const prompt = await given({ ...VIEW, forced })
  expect(machineryOf(prompt).forced).toEqual(forced)
  expect(prompt).toContain("That is a stack the asking packages' own ranges don't admit.")
  expect(machineryOf(await given(VIEW))).not.toHaveProperty('forced')
})

