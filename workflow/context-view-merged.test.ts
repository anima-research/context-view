import { expect, test } from 'bun:test'
import { moduleOf, script } from './testing.ts'

const body = script('context-view-merged')
const m = await moduleOf(body!)
const { INSTRUCTIONS, RESULT, heldBy, inputsOf, namesOf, placesOf, problemsOf, promptOf, seenOf } = m

const CHECKS = [
  '# Checks', '', '## The workloads, and what each checks', '', '### `W1`', '', 'one', '', '### `W12`', '', 'twelve', '',
  '## Paths no run reaches', '', '- A stream that ends with no terminal event, which no run cuts.', '',
  '## The checks every run is judged by', '', '### Check 1: every turn answers', '', 'x', '', '### Check 3: request shape and budgets', '', 'y', '',
].join('\n')
const STACK = { release: 'r', seconds: { runs: { 'H1/W1': 14.4, 'H1/W12': 30.5, 'H3/W1': 9 }, checkpoints: {} } }
const REACH = {
  files: {
    'src/a.ts': { state: 'read', ran: [10, 11, 12], notRan: [20], couldntTell: [30], noCode: [13, 14], unloaded: [], deletions: [{ after: 40, state: 'reached', by: 41 }, { after: 50, state: 'not-reached', by: 51 }, { after: 60, state: 'no-code', by: null }] },
    'src/b.ts': { state: 'not-loaded', ran: [], notRan: [], couldntTell: [], noCode: [2], unloaded: [5, 6], deletions: [] },
    'src/c.ts': { state: 'read', ran: [], notRan: [], couldntTell: [], noCode: [1], unloaded: [], deletions: [] },
  },
  notes: [],
}
const names = namesOf(CHECKS, STACK)
const places = placesOf(REACH)
const R = (file: string, from: number, to = from) => ({ file, from, to })
const D = (file: string, after: number) => ({ file, after })
const covered = (lines: object[], extra: object = {}) => ({ lines, deletions: [], verdict: 'covered', runs: ['H1/W1'], check: 'Check 3', why: 'It shapes the request.', ...extra })
const gap = (lines: object[], extra: object = {}) => ({ lines, deletions: [], verdict: 'gap', reach: 'W12', seconds: 30, build: 'A W12 turn that reaches it.', why: 'No run reaches it.', ...extra })
const whole = () => [
  covered([R('src/a.ts', 10, 14)], { deletions: [D('src/a.ts', 40)] }),
  gap([R('src/a.ts', 20), R('src/a.ts', 30)], { deletions: [D('src/a.ts', 50)] }),
  gap([R('src/b.ts', 1, 9)], { reach: 'H1/W12', seconds: 12 }),
]

test('the record holds the script, and its answer is areas, each placing lines and deletions with a verdict and a why', () => {
  expect(body).toBeTruthy()
  expect(RESULT.properties.areas.items.required).toEqual(['lines', 'deletions', 'verdict', 'why'])
  expect(RESULT.properties.areas.items.properties.verdict.enum).toEqual(['covered', 'gap'])
})

test("an area places each changed line reach found code on, whatever reach saw of it, and each deletion of code; a line or deletion with no code is no one's", () => {
  expect([...places.lines.get('src/a.ts')!].sort((a, b) => a[0] - b[0])).toEqual([[10, 'ran'], [11, 'ran'], [12, 'ran'], [20, 'notRan'], [30, 'couldntTell']])
  expect([...places.lines.get('src/b.ts')!]).toEqual([[5, 'unloaded'], [6, 'unloaded']])
  expect(places.lines.has('src/c.ts')).toBe(false)
  expect([...places.deletions.get('src/a.ts')!]).toEqual([[40, 'reached'], [50, 'not-reached']])
})

test("the names an answer may use are the harness's: stack.json's runs with their seconds, CHECKS.md's workload and check headings, and its paths no run reaches", () => {
  expect([...names.runs]).toEqual([['H1/W1', 14.4], ['H1/W12', 30.5], ['H3/W1', 9]])
  expect([...names.workloads]).toEqual(['W1', 'W12'])
  expect([...names.checks]).toEqual(['Check 1', 'Check 3'])
  expect(names.known).toBe('- A stream that ends with no terminal event, which no run cuts.')
})

test('an answer placing every changed line and deletion once, each area covered by a run that ran it with a check, or a gap with its reach, seconds and build, has no problem', () => {
  expect(problemsOf(places, names, { areas: whole() })).toEqual([])
  expect(problemsOf(places, names, { areas: [{ ...whole()[0], check: 'records' }, ...whole().slice(1)] })).toEqual([])
})

test('a range may span lines with no code or no change between the changed lines it holds, and two ranges of one area may overlap', () => {
  const [, ...rest] = whole()
  expect(problemsOf(places, names, { areas: [covered([R('src/a.ts', 1, 12), R('src/a.ts', 11, 15)], { deletions: [D('src/a.ts', 40)] }), ...rest] })).toEqual([])
})

test('a changed line or deletion no area holds, or one two areas hold, is named', () => {
  const [first, second, third] = whole()
  expect(problemsOf(places, names, { areas: [{ ...first, lines: [R('src/a.ts', 10, 11)] }, second, third] })).toEqual(['no area holds src/a.ts 12'])
  expect(problemsOf(places, names, { areas: [first, { ...second, deletions: [] }, third] })).toEqual(["no area holds src/a.ts's deletion after 50"])
  expect(problemsOf(places, names, { areas: [first, { ...second, lines: [R('src/a.ts', 12, 20), R('src/a.ts', 30)] }, third] }))
    .toEqual(['src/a.ts 12 is in areas 1 and 2, and belongs in one'])
})

test("an area can't be covered where reach says no profiled drive ran one of its lines or reached one of its deletions", () => {
  const [, , third] = whole()
  expect(problemsOf(places, names, { areas: [covered([R('src/a.ts', 10, 30)], { deletions: [D('src/a.ts', 40), D('src/a.ts', 50)] }), third] }))
    .toEqual(["area 1 is covered, but reach says no profiled drive ran src/a.ts 20, src/a.ts's deletion after 50"])
  expect(problemsOf(places, names, { areas: [whole()[0], whole()[1], covered([R('src/b.ts', 5, 6)])] }))
    .toEqual(['area 3 is covered, but reach says no profiled drive ran src/b.ts 5–6'])
})

test("a covered area names the runs that ran it, each one of the runs, and a check CHECKS.md heads or records, and nothing of a gap's", () => {
  const [first, ...rest] = whole()
  const problems = (area: object) => problemsOf(places, names, { areas: [{ ...first, ...area }, ...rest] })
  expect(problems({ runs: [] })).toEqual(['area 1 is covered, but names no run that ran it'])
  expect(problems({ runs: ['H1/W1', 'H9/W9'] })).toEqual(['area 1 names "H9/W9", which isn\'t one of the runs'])
  expect(problems({ check: 'Check 2' })).toEqual(['area 1\'s check is "Check 2", neither "records" nor a check CHECKS.md heads'])
  expect(problems({ reach: 'W12', seconds: 3 })).toEqual(['area 1 is covered, so it has no reach', 'area 1 is covered, so it has no seconds'])
})

test("a gap names a run, a workload or a check that would reach it, its seconds above 0 and its build, and nothing of a covered area's", () => {
  const [first, second, third] = whole()
  const problems = (area: object) => problemsOf(places, names, { areas: [first, { ...second, ...area }, third] })
  for (const reach of ['H3/W1', 'W1', 'Check 1']) expect(problems({ reach })).toEqual([])
  expect(problems({ reach: 'W99' })).toEqual(['area 2\'s reach is "W99", which is neither a run, a workload CHECKS.md heads, nor one of its checks'])
  expect(problems({ seconds: 0 })).toEqual(['area 2 gives no seconds of runner time above 0'])
  expect(problems({ build: ' ' })).toEqual(['area 2 gives no build'])
  expect(problems({ runs: ['H1/W1'], check: 'Check 3' })).toEqual(['area 2 is a gap, so it has no runs', 'area 2 is a gap, so it has no check'])
})

test("a gap CHECKS.md already lists quotes its words from paths no run reaches, character for character, and gives no price", () => {
  const [first, second, third] = whole()
  const { reach: _r, seconds: _s, build: _b, ...bare } = second as Record<string, unknown>
  const problems = (area: object) => problemsOf(places, names, { areas: [first, area, third] })
  expect(problems({ ...bare, known: 'A stream that ends with no terminal event' })).toEqual([])
  expect(problems({ ...bare, known: 'A stream that ends without a terminal event' })).toEqual(['area 2\'s known isn\'t quoted word for word from CHECKS.md\'s "Paths no run reaches"'])
  expect(problems({ ...second, known: 'A stream that ends with no terminal event' }))
    .toEqual(['area 2 is a known gap, so it has no reach', 'area 2 is a known gap, so it has no seconds', 'area 2 is a known gap, so it has no build'])
})

test('a range naming a file with no changed code, holding none, or that isn\'t a range, a deletion reach doesn\'t list, and an area with no why or holding nothing, are named', () => {
  const [first, second, third] = whole()
  const problems = (areas: object[]) => problemsOf(places, names, { areas })
  expect(problems([first, second, third, gap([R('src/c.ts', 1)])])).toEqual(['area 4 names lines of src/c.ts, where reach lists no changed line with code', 'area 4 holds no changed line or deletion'])
  expect(problems([first, second, third, gap([R('src/a.ts', 15, 19)])])).toEqual(['area 4\'s range 15–19 of src/a.ts holds no changed line with code', 'area 4 holds no changed line or deletion'])
  expect(problems([first, second, third, gap([R('src/a.ts', 12, 10)])])).toEqual(['area 4\'s range 12–10 of src/a.ts isn\'t a range of lines', 'area 4 holds no changed line or deletion'])
  expect(problems([first, second, third, gap([], { deletions: [D('src/a.ts', 60)] })])).toEqual(['area 4 names a deletion after line 60 of src/a.ts, which reach doesn\'t list', 'area 4 holds no changed line or deletion'])
  expect(problems([{ ...first, why: '' }, second, third])).toEqual(['area 1 gives no why'])
  expect(problemsOf(places, names, {})).toEqual(['the answer has no list of areas'])
})

test('an area holds the changed code lines its ranges cover and the deletions it names, once each', () => {
  expect([...heldBy(covered([R('src/a.ts', 9, 12), R('src/a.ts', 11, 25)], { deletions: [D('src/a.ts', 40)] }), places).keys()])
    .toEqual(['src/a.ts:10', 'src/a.ts:11', 'src/a.ts:12', 'src/a.ts:20', 'src/a.ts@40'])
})

test('a covered area is observed where a run that ran one of its lines has records that differ, naming other areas those runs ran, and judged otherwise; a gap is neither', () => {
  const areas = [covered([R('src/a.ts', 10, 11)]), covered([R('src/a.ts', 12)]), gap([R('src/a.ts', 20)])]
  const ranBy = { 'src/a.ts': { 10: ['H1/W1'], 11: ['H3/W1'], 12: ['H1/W1', 'H1/W12'] } }
  expect(seenOf(areas, places, ranBy, new Set(['H3/W1']))).toEqual([{ how: 'observed', runs: ['H3/W1'], with: [] }, { how: 'judged' }, null])
  expect(seenOf(areas, places, ranBy, new Set(['H1/W1']))).toEqual([{ how: 'observed', runs: ['H1/W1'], with: [2] }, { how: 'observed', runs: ['H1/W1'], with: [1] }, null])
  expect(seenOf(areas, places, ranBy, new Set())).toEqual([{ how: 'judged' }, { how: 'judged' }, null])
  expect(seenOf([covered([], { deletions: [D('src/a.ts', 40)] })], places, ranBy, new Set(['H1/W1']))).toEqual([{ how: 'judged' }])
})

test("the reader's prompt holds its instructions, CHECKS.md, the runs with their seconds, the pull request's words, reach without lines of no code, the kinds of difference by run, and the diff", () => {
  const view = { repo: 'o/r', number: 7, title: 'a title', body: 'a body', entries: [{ id: 'e1', describe: 'a kind', count: 2, runs: ['H1/W1'], places: [], example: { place: {}, before: 'b', after: 'a' } }] }
  const inputs = inputsOf(view, REACH, 'diff --git a/src/a.ts b/src/a.ts')
  expect(inputs.reach['src/a.ts']).toEqual({ ran: [10, 11, 12], notRan: [20], couldntTell: [30], deletions: [{ after: 40, state: 'reached' }, { after: 50, state: 'not-reached' }] })
  expect(inputs.reach['src/b.ts']).toEqual({ unloaded: [5, 6] })
  expect('src/c.ts' in inputs.reach).toBe(false)
  expect(inputs.differing).toEqual([{ describe: 'a kind', count: 2, runs: ['H1/W1'] }])
  const prompt = promptOf(INSTRUCTIONS, CHECKS, names.runs, inputs)
  for (const part of [INSTRUCTIONS, CHECKS, '"H1/W12": 30.5', '"title": "a title"', '"description": "a body"', '"describe": "a kind"', JSON.stringify('diff --git a/src/a.ts b/src/a.ts')]) expect(prompt).toContain(part)
})
