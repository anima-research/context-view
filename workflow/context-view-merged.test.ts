import { afterAll, expect, test } from 'bun:test'
import { RECORDS, frozen, moduleOf, runOf, script } from './testing.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const body = script('context-view-merged')
const m = await moduleOf(body!)
const { BOUND, HARNESS, INSTRUCTIONS, REACH_CAUSE, RESULT, ROOM, RUN_DEADLINE, couldntOf, heldBy, inputsOf, namesOf, placesOf, problemsOf, promptOf, seenOf } = m

const CHECKS = [
  '# Checks', '', '## The workloads, and what each checks', '', '### `W1`', '', 'one', '', '### `W12`', '', 'twelve', '',
  '## Paths no run reaches', '', '- A stream that ends with no terminal event, which no run cuts.', '',
  '## The checks every run is judged by', '', '### Check 1: every turn answers', '', 'x', '', '### Check 3: request shape and budgets', '', 'y', '',
].join('\n')
const STACK = { release: 'r', seconds: { runs: { 'H1/W1': 14.4, 'H1/W12': 30.5, 'H3/W1': 9 }, checkpoints: {} } }
const MEASURED = { 'H1/W1': 28.8, 'H1/W12': 61, 'H3/W1': 18 }
const REACH = {
  files: {
    'src/a.ts': { state: 'read', ran: [10, 11, 12], notRan: [20], couldntTell: [30], noCode: [13, 14], unloaded: [], deletions: [{ after: 40, state: 'reached', by: 41 }, { after: 50, state: 'not-reached', by: 51 }, { after: 60, state: 'no-code', by: null }, { after: 70, state: 'couldnt-tell', by: 71 }], reason: 'src/a.ts is built into two scripts' },
    'src/b.ts': { state: 'not-loaded', ran: [], notRan: [], couldntTell: [], noCode: [2], unloaded: [5, 6], deletions: [] },
    'src/c.ts': { state: 'read', ran: [], notRan: [], couldntTell: [], noCode: [1], unloaded: [], deletions: [] },
    'src/d.json': { state: 'couldnt-tell', ran: [], notRan: [], couldntTell: [], noCode: [], unloaded: [1, 2], deletions: [{ after: 3, state: 'unloaded', by: null }], reason: "src/d.json isn't script source, so whether its change ran can't be read" },
  },
  notes: [],
}
const names = namesOf(CHECKS, STACK, MEASURED)
const places = placesOf(REACH)
const R = (file: string, from: number, to = from) => ({ file, from, to })
const D = (file: string, after: number) => ({ file, after })
const covered = (lines: object[], extra: object = {}) => ({ lines, deletions: [], verdict: 'covered', runs: ['H1/W1'], check: 'Check 3', why: 'It shapes the request.', ...extra })
const gap = (lines: object[], extra: object = {}) => ({ lines, deletions: [], verdict: 'gap', reach: 'W12', seconds: 30, build: 'A W12 turn that reaches it.', why: 'No run reaches it.', ...extra })
const whole = () => [
  covered([R('src/a.ts', 10, 14)], { deletions: [D('src/a.ts', 40)] }),
  gap([R('src/a.ts', 20)], { deletions: [D('src/a.ts', 50)] }),
  gap([R('src/b.ts', 1, 9)], { reach: 'H1/W12', seconds: 12 }),
]

test('the record holds the script, and its answer is areas, each placing lines and deletions with a verdict and a why', () => {
  expect(body).toBeTruthy()
  expect(RESULT.properties.areas.items.required).toEqual(['lines', 'deletions', 'verdict', 'why'])
  expect(RESULT.properties.areas.items.properties.verdict.enum).toEqual(['covered', 'gap'])
})

test("an area places each changed line reach found code on and could judge, and each deletion of code it could judge; a line or deletion with no code is no one's", () => {
  expect([...places.lines.get('src/a.ts')!].sort((a, b) => a[0] - b[0])).toEqual([[10, 'ran'], [11, 'ran'], [12, 'ran'], [20, 'notRan']])
  expect([...places.lines.get('src/b.ts')!]).toEqual([[5, 'unloaded'], [6, 'unloaded']])
  expect(places.lines.has('src/c.ts')).toBe(false)
  expect([...places.deletions.get('src/a.ts')!]).toEqual([[40, 'reached'], [50, 'not-reached']])
})

test("the names an answer may use are the harness's: stack.json's runs with the seconds this view measured, CHECKS.md's workload headings with their runs' count and measured seconds, its check headings, and its paths no run reaches", () => {
  expect([...names.runs]).toEqual([['H1/W1', 28.8], ['H1/W12', 61], ['H3/W1', 18]])
  expect([...names.workloads]).toEqual([['W1', { runs: 2, seconds: 46.8 }], ['W12', { runs: 1, seconds: 61 }]])
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
  expect(problemsOf(places, names, { areas: [first, { ...second, lines: [R('src/a.ts', 12, 20)] }, third] }))
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
  expect(inputs.reach['src/a.ts']).toEqual({ ran: [10, 11, 12], notRan: [20], deletions: [{ after: 40, state: 'reached' }, { after: 50, state: 'not-reached' }] })
  expect(inputs.reach['src/b.ts']).toEqual({ unloaded: [5, 6] })
  expect('src/c.ts' in inputs.reach).toBe(false)
  expect('src/d.json' in inputs.reach).toBe(false)
  expect(inputs.differing).toEqual([{ describe: 'a kind', count: 2, runs: ['H1/W1'] }])
  const prompt = promptOf(INSTRUCTIONS, CHECKS, names, inputs)
  for (const part of [INSTRUCTIONS, CHECKS, '"H1/W12": 61', '"title": "a title"', '"description": "a body"', '"describe": "a kind"', JSON.stringify('diff --git a/src/a.ts b/src/a.ts')]) expect(prompt).toContain(part)
})

test("D20: a run's seconds are those this view measured, null where it kept none; a workload's runs are those whose name's second part is it, variants included, with their measured seconds together to a tenth, null where any has none; one CHECKS.md heads that no run is has none, and a run of a workload it doesn't head, or a measure for a run stack.json doesn't name, counts for none", () => {
  const checks = CHECKS.replace('### `W12`', '### `W7`\n\nseven\n\n### `W12`')
  const stack = { seconds: { runs: { 'H1/W7/merges-refused': 3.3, 'C3h/W7/no-tools': 1.2, 'H1/W1': 14.4, 'H2/W1': 5, 'H1/W99': 2 } } }
  const n = namesOf(checks, stack, { 'H1/W7/merges-refused': 0.1, 'C3h/W7/no-tools': 0.2, 'H1/W1': 14.4, 'H2/W1': 'x', 'H1/W99': 2, 'X/W12': 9 })
  expect(Object.fromEntries(n.runs)).toEqual({ 'H1/W7/merges-refused': 0.1, 'C3h/W7/no-tools': 0.2, 'H1/W1': 14.4, 'H2/W1': null, 'H1/W99': 2 })
  expect(Object.fromEntries(n.workloads)).toEqual({ W1: { runs: 2, seconds: null }, W7: { runs: 2, seconds: 0.3 }, W12: { runs: 0, seconds: 0 } })
  expect(Object.fromEntries(namesOf(checks, stack, undefined).runs)).toEqual({ 'H1/W7/merges-refused': null, 'C3h/W7/no-tools': null, 'H1/W1': null, 'H2/W1': null, 'H1/W99': null })
})

test("D20, D21: the reader is given each run and each workload with the seconds this view measured, under headings that say so, and told a gap's seconds count every run its build lands in", () => {
  const prompt: string = promptOf(INSTRUCTIONS, CHECKS, names, inputsOf({ repo: 'o/r', number: 7, entries: [] }, REACH, 'd'))
  const table = (heading: string) => {
    const at = prompt.indexOf(`\n${heading}\n`, prompt.indexOf(CHECKS) + CHECKS.length)
    expect([heading, at > 0]).toEqual([heading, true])
    return { at, value: JSON.parse(prompt.slice(prompt.indexOf('\n\n', at + 1) + 2, prompt.indexOf('\n\n## ', at + 1))) }
  }
  const runs = table("## The runs, with the seconds this view measured each take in its base arm, null where it kept none")
  const workloads = table("## The workloads, each with how many of the runs are its and the seconds this view measured them take together")
  expect(runs.value).toEqual({ 'H1/W1': 28.8, 'H1/W12': 61, 'H3/W1': 18 })
  expect(workloads.at).toBeGreaterThan(runs.at)
  expect(workloads.value).toEqual({ W1: { runs: 2, seconds: 46.8 }, W12: { runs: 1, seconds: 61 } })
  expect(INSTRUCTIONS).toContain("counting every run it lands in: a build that extends a workload's script lands in each of that workload's runs")
  expect(INSTRUCTIONS).not.toContain('from the seconds of the run nearest')
  expect(INSTRUCTIONS).toContain("each with the seconds this view's drive of it took in its base arm (null where it kept none)")
  expect(INSTRUCTIONS).toContain("A view drives each run three times, as its base arm, its head arm and the head arm's self-check, and the seconds you're given are one drive's, the base arm's, so count all three")
})

const made: string[] = []
afterAll(() => { for (const p of made) rmSync(p, { recursive: true, force: true }) })

const REPO = 'anima-research/membrane'
const MERGED = 'a'.repeat(40)
const HARNESS_AT = 'e'.repeat(40)
const VIEWS = '/home/nissa/.local/state/context-view/views'
const STATE = '/home/nissa/.local/state/context-view'
const DIR = `${VIEWS}/merged.anima-research.membrane.248.${MERGED.slice(0, 12)}`
const CURRENT = '/home/nissa/.local/lib/context-view/current'
const RELEASE_DIR = '/home/nissa/.local/lib/context-view/releases'
const RELEASE = `${RELEASE_DIR}/${'c'.repeat(40)}`
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+const changed = 1'
const RANBY = { 'src/a.ts': { 10: ['H1/W1'], 11: ['H3/W1'], 12: ['H1/W1'] } }
const JUDGED = {
  files: {
    'src/a.ts': { ...REACH.files['src/a.ts'], couldntTell: [], deletions: REACH.files['src/a.ts'].deletions.filter((d) => d.state !== 'couldnt-tell'), reason: undefined },
    'src/b.ts': REACH.files['src/b.ts'],
    'src/c.ts': REACH.files['src/c.ts'],
  },
  notes: [],
  ranBy: RANBY,
}
const ENTRY = (runs: string[]) => ({ id: 'e1', describe: 'a kind', count: 1, runs, places: [], example: { place: {}, before: 'b', after: 'a' } })
const RAN = { repo: REPO, number: 248, head: MERGED, outcome: 'ran', detail: null, merge: { commit: MERGED, k: 0, src: true }, harness: { repo: HARNESS, sha: HARNESS_AT }, title: 'a title', body: 'a body', entries: [ENTRY(['H3/W1'])] }
const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

type Reply = { result: unknown, transcript: object[] } | Error
type Options = { model: string, effort?: string, schema?: unknown, transcript?: boolean, kept?: Record<string, unknown>, check: (v: unknown) => string[] }
type Stand = { run?: number, manifest?: object | null, view?: object, reach?: object, stack?: object, measured?: object | null | 'no-manifest' | 'unreadable', replies?: Reply[], tokens?: number, tender?: object | null, agentRef?: string, commonsFails?: boolean, postFails?: boolean, releases?: string, cut?: Record<string, number>, elided?: Record<string, number>, partial?: Record<string, number>, diff?: string | Uint8Array }
const message = (result: unknown, fold = false): Reply => ({ result, transcript: fold ? [{ type: 'compaction' }] : [{ type: 'message' }] })

function stand({ run = 0, manifest = null, view = RAN, reach = JUDGED, stack = STACK, measured = MEASURED, replies = [message({ areas: whole() })], tokens = 100, tender = { kind: 'colleague', agentId: 'tender-1' }, agentRef = 'Tender-1', commonsFails = false, postFails = false, releases = RELEASE, cut = {}, elided = {}, partial = {}, diff = DIFF }: Stand = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'context-view-merged-test-'))
  made.push(dir)
  const calls: { step: string, command?: string, cwd?: string, timeout_ms?: number, input?: any, release?: string }[] = []
  const said: Record<string, any>[] = [], asked: ({ prompt: string } & Options)[] = [], reads: { label: string, at?: number }[] = []
  const cuts = { ...cut }, elides = { ...elided }, parts = { ...partial }
  // Hands gives stdout null where a stream was elided or cut off, and output_complete false where the output was cut off.
  const read = (step: string, exit: number, out: string) => ((cuts[step] ?? 0) > 0 && cuts[step]!-- > 0
    ? { isError: false, structuredContent: { exit_code: exit, stdout: null, stderr: '', output_complete: false }, content: [{ type: 'text', text: '' }] }
    : (elides[step] ?? 0) > 0 && elides[step]!-- > 0
      ? { isError: false, structuredContent: { exit_code: exit, stdout: null, stderr: '', output_complete: true, elided_chars: out.length }, content: [{ type: 'text', text: '' }] }
    : (parts[step] ?? 0) > 0 && parts[step]!-- > 0
      ? { isError: false, structuredContent: { exit_code: exit, stdout: out.slice(0, Math.floor(out.length / 2)), stderr: '', output_complete: false }, content: [{ type: 'text', text: '' }] }
      : bash(exit, out))
  const bash = (exit: number | null, out = '', stderr = '') => ({ isError: false, structuredContent: { exit_code: exit, stdout: out, stderr }, content: [{ type: 'text', text: stderr }] })
  const real = (c: string) => { const r = Bun.spawnSync(['bash', '-c', c]); return { exit: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() } }
  const answer = async (name: string, a: Record<string, any>, o: { label?: string } = {}) => {
    if (name === 'mcp__commons__post_message') { said.push(a); return postFails ? { isError: true, content: [{ type: 'text', text: 'Commons: refused' }] } : { isError: false, content: [] } }
    expect(name).toBe('mcp__hands__Bash')
    const c: string = a.command
    if (c === `realpath -e ${CURRENT} ${RELEASE_DIR}`) { calls.push({ step: 'release', cwd: a.cwd }); return read('release', 0, `${releases}\n${RELEASE_DIR}\n`) }
    if (/ && timeout (--preserve-status )?-s TERM /.test(c)) {
      calls.push({ step: 'run', command: c, cwd: a.cwd, timeout_ms: a.timeout_ms })
      return bash(run, '', run === 0 || run === 3 ? '' : 'context-view-run: on-gh failed')
    }
    if (c.startsWith('cat -- ')) { calls.push({ step: 'manifest', command: c }); return manifest ? read('manifest', 0, JSON.stringify(manifest)) : bash(1, '', 'cat: No such file or directory') }
    const named = /^'([^']+)'\/view\/step (\w+) <</.exec(c)
    if (named) {
      calls.push({ step: named[2], input: JSON.parse(c.split('\n')[1]!), cwd: a.cwd, release: named[1] })
      writeFileSync(join(dir, 'view.json'), JSON.stringify(view))
      writeFileSync(join(dir, 'reach.json'), JSON.stringify(reach))
      writeFileSync(join(dir, 'merge.diff'), diff)
      if (measured === 'unreadable') writeFileSync(join(dir, 'manifest.json'), '{"outcome": "ran", "seconds": ')
      else if (measured !== 'no-manifest') writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ outcome: 'ran', seconds: { planned: null, ...(measured ? { measured: { runs: measured, checkpoints: {} } } : {}) } }))
      return read('facts', 0, `${JSON.stringify({ path: join(dir, 'view.json'), changed: false })}\n`)
    }
    if (c.startsWith('curl ')) {
      calls.push({ step: 'curl', command: c })
      return c.includes('/CHECKS.md') ? read('checks', 0, CHECKS) : read('stack', 0, JSON.stringify(stack))
    }
    if (c.includes('/ctoc -')) { calls.push({ step: 'count' }); return read('count', 0, `${tokens} tokens, 0 uncertain (0.0%)\n`) }
    if (c.startsWith('astra-commons ')) {
      const op = JSON.parse(/operation '(.*)'$/.exec(c)![1]!)
      calls.push({ step: `commons:${op.operation}`, input: op.input })
      if (commonsFails) return bash(1, '', 'astra-commons: no backend')
      if (op.operation === 'list_rooms') return read('commons', 0, JSON.stringify({ rooms: [{ id: op.input.room, tender: { effective: tender } }] }))
      if (op.operation === 'get_agent') return bash(0, JSON.stringify({ id: op.input.agentId, reference: agentRef }))
    }
    if (c.startsWith('rm -rf -- ')) { calls.push({ step: 'clear', command: c }); return bash(0) }
    if (/^python3 -c 'import sys; s = open\(sys\.argv\[1\], [^)']*\)\.read\(\)\[int\(sys\.argv\[2\]\):int\(sys\.argv\[2\]\) \+ 90000\]; sys\.stdout\.buffer\.write\(s\.encode\("utf-8"\)\)' /.test(c)) {
      reads.push({ label: o.label!, at: Number(c.slice(c.lastIndexOf(' ') + 1)) })
      const r = real(c)
      return read(`read:${o.label}`, r.exit, r.out)
    }
    if (/^if test -e '[^']+'; then echo yes; else echo no; fi$/.test(c)) {
      reads.push({ label: `exists:${o.label}` })
      const r = real(c)
      return read(`exists:${o.label}`, r.exit, r.out)
    }
    throw new Error(`a command the stand-in doesn't know: ${c.slice(0, 200)}`)
  }
  // Hands' Bash refuses a budget outside 1,000 to 200,000 before anything runs, and gives stdout null, with output_complete
  // true and the characters past the budget, where a stream is longer than its budget (30,000 when none is named).
  const tool = async (name: string, a: Record<string, any>, o: { label?: string } = {}) => {
    if (name !== 'mcp__hands__Bash') return answer(name, a, o)
    const budget = a.max_output_chars ?? 30000
    if (!Number.isInteger(budget) || budget < 1000 || budget > 200_000) throw Object.assign(new Error(`max_output_chars must be a whole number from 1,000 to 200,000, not ${budget}`), { name: 'ToolInputValidationError', data: { code: 'rejected' } })
    const r: any = await answer(name, a, o)
    const out = r.structuredContent?.stdout
    return typeof out === 'string' && out.length > budget
      ? { ...r, structuredContent: { ...r.structuredContent, stdout: null, output_complete: r.structuredContent.output_complete ?? true, elided_chars: out.length - budget } }
      : r
  }
  const agent = async (prompt: string, o: Options) => {
    asked.push({ prompt, ...o })
    const r = replies[Math.min(asked.length, replies.length) - 1]!
    if (r instanceof Error) throw r
    return frozen(r)
  }
  return { dir, calls, said, asked, reads, words: { agent, tools: tool, phase: () => {}, text: () => {} } }
}
type Stood = ReturnType<typeof stand>
const check = async (s: Stood, args: Record<string, unknown> = {}) => (await runOf(body!))({ repo: REPO, number: 248, merged: MERGED, ...args }, s.words)
const failed = (s: Stood, args: Record<string, unknown> = {}) => check(s, args).then(() => null, (e) => String(e && e.message))
const steps = (s: Stood) => s.calls.map((c) => c.step)
const text = (s: Stood) => s.said.map((p) => p.text as string)
const fenced = (line: string) => [...line.matchAll(/(`{4,})\n([\s\S]*?)\n\1/g)].map((x) => x[2]!)
const refused = Object.assign(new Error('refused'), { data: { code: 'refused', category: 'cyber' } })

test("D1: the release resolves once from current, and one that isn't a release fails the run before the run side, saying so in a line", async () => {
  const s = stand({ releases: '/home/nissa/astra/context-view' })
  expect(await failed(s)).toContain(`${CURRENT} resolves to /home/nissa/astra/context-view, which isn't a release under ${RELEASE_DIR}`)
  expect(steps(s)).toEqual(['release'])
  expect(text(s)).toEqual([expect.stringContaining("which isn't a release under")])
})

test("D2: the run side runs the merge under a SIGTERM deadline inside one Bash call, into the merge's own directory, and facts reads it, each from the release", async () => {
  const s = stand()
  await check(s)
  const [release, run, facts] = s.calls
  expect(release!.cwd).toBe(STATE)
  expect(run!.cwd).toBe(VIEWS)
  expect(run!.timeout_ms).toBe(600000)
  expect(RUN_DEADLINE).toBeLessThan(600)
  expect(run!.command).toBe(`rm -f -- '${DIR}/manifest.json' && timeout --preserve-status -s TERM ${RUN_DEADLINE} bun '${RELEASE}/run/context-view-run.ts' --repo 'membrane' --pr 248 --merged ${MERGED} --out '${DIR}'`)
  expect([facts!.step, facts!.input, facts!.release, facts!.cwd]).toEqual(['facts', { dir: DIR, repo: REPO }, RELEASE, STATE])
})

test("D3, D5: a run side's couldnt-run is a merge that can't be checked: no facts, a line naming the room's tender with the cause, a Work line and a whole acorn record with no coordinator", async () => {
  const why = 'GitHub says the pull request merged at another commit'
  const s = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why, mergeCommit: 'b'.repeat(40) } } })
  const result = await check(s)
  expect(steps(s)).toEqual(['release', 'run', 'manifest', 'commons:list_rooms', 'commons:get_agent'])
  expect(result).toMatchObject({ outcome: 'couldnt-run', action: 'posted' })
  const [line] = text(s)
  const title = `context view: ${REPO}'s merges can't be checked: couldnt-run: ${why}`
  expect(line!.startsWith('@Tender-1 ')).toBe(true)
  expect(line).toContain(`titled \`${title}\``)
  const [work, record] = fenced(line!)
  expect(work).toContain(`merged at \`${MERGED}\``)
  expect(work).toContain(DIR)
  expect(record!.split('\n').slice(0, 5)).toEqual(['---', `title: ${JSON.stringify(title)}`, 'nextAction: understand', 'holder: null', '---'])
  expect(record).not.toContain('coordinator')
  expect(record!.split('\n')[5]!.startsWith('**Impact:**')).toBe(true)
  expect(record).toContain(work!)
})

test('D3: any other exit fails the run naming it and stderr, as does a couldnt-run exit with no manifest, with a line naming no one', async () => {
  for (const [run, manifest] of [[1, null], [124, null], [2, null], [2, { outcome: 'ran' }]] as [number, object | null][]) {
    const s = stand({ run, manifest })
    expect(await failed(s)).toBe(`the run side couldn't run it (exit ${run}): context-view-run: on-gh failed`)
    expect(steps(s)).not.toContain('facts')
    expect(text(s)).toEqual([expect.stringContaining(`the run side couldn't run it (exit ${run})`)])
    expect(text(s)[0]).not.toContain('@')
  }
})

test('D4: a merge into another branch, and one that changes no file under src/, no dependency map and no root lockfile beyond its own version, each get one line naming no one, saying what was checked, and no reader', async () => {
  for (const [view, says] of [
    [{ repo: REPO, number: 248, head: MERGED, outcome: 'elsewhere', detail: { branch: 'release-0.9' }, merge: { commit: MERGED } }, '`release-0.9`'],
    [{ repo: REPO, number: 248, head: MERGED, outcome: 'unchanged', detail: null, merge: { commit: MERGED } }, "isn't checked: it changes no file under `src/`, no dependency map of its `package.json`, and its root lockfile in nothing but the package's own version"],
  ] as [{ outcome: string, [field: string]: unknown }, string][]) {
    const s = stand({ run: 3, view })
    expect(await check(s)).toMatchObject({ outcome: view.outcome, action: 'posted' })
    expect(text(s)).toEqual([expect.stringContaining(says)])
    expect(text(s)[0]).not.toContain('@')
    expect(steps(s)).toEqual(['release', 'run', 'facts'])
    expect(s.asked).toEqual([])
  }
})

test("D5: a view that didn't run can't be checked, its cause the outcome, detail's why and its release, so a later merge with the same cause and other versions gives the same title", async () => {
  const titles = []
  for (const has of ['0.9.0', '0.9.1']) {
    const view = { repo: REPO, number: 248, head: MERGED, outcome: 'needs-companion', detail: { why: 'no-release', release: '@animalabs/agent-framework', has }, merge: { commit: MERGED, k: 0, src: true }, harness: { repo: HARNESS, sha: HARNESS_AT } }
    const s = stand({ run: 3, view })
    expect(await check(s)).toMatchObject({ outcome: 'needs-companion' })
    const [, record] = fenced(text(s)[0]!)
    titles.push(record!.split('\n')[1])
    expect(text(s)[0]!.startsWith('@Tender-1 ')).toBe(true)
    expect(s.asked).toEqual([])
  }
  expect(titles[0]).toBe(titles[1])
  expect(titles[0]).toBe(`title: ${JSON.stringify(`context view: ${REPO}'s merges can't be checked: needs-companion: no-release: release @animalabs/agent-framework`)}`)
})

test("D6: a merge that ran and changed no src/ file gets no reader; its line names the runs whose records differ, or says none do, and names no one", async () => {
  const s = stand({ view: { ...RAN, merge: { ...RAN.merge, src: false }, entries: [ENTRY(['H3/W1']), ENTRY(['H1/W1', 'H3/W1'])] } })
  await check(s)
  expect(text(s)).toEqual([expect.stringContaining('the records of H1/W1, H3/W1 differ')])
  expect(text(s)[0]).not.toContain('@')
  expect(s.asked).toEqual([])
  const t = stand({ view: { ...RAN, merge: { ...RAN.merge, src: false }, entries: [] } })
  await check(t)
  expect(text(t)).toEqual([expect.stringContaining("no run's records differ")])
})

test("D7: where reach couldn't tell which lines ran, the merge can't be checked, by that cause, with reach's words in its Work line", async () => {
  const s = stand({ reach: { couldnt: 'share 2 gave 3 digests for its drives\' 4 boots' } })
  await check(s)
  const line = text(s)[0]!
  expect(line.startsWith('@Tender-1 ')).toBe(true)
  const [work, record] = fenced(line)
  expect(record!.split('\n')[1]).toBe(`title: ${JSON.stringify(`context view: ${REPO}'s merges can't be checked: reach couldn't tell which lines ran`)}`)
  expect(work).toContain("share 2 gave 3 digests for its drives' 4 boots")
  expect(s.asked).toEqual([])
})

test("D8: a merge whose reach lists no changed line or deletion of code gets no reader, and its line says so, naming no one", async () => {
  const s = stand({ reach: { files: { 'src/c.ts': REACH.files['src/c.ts'] }, notes: [], ranBy: {} } })
  await check(s)
  expect(text(s)).toEqual([expect.stringContaining('reach lists no changed line or deletion of code')])
  expect(text(s)[0]).not.toContain('@')
  expect(s.asked).toEqual([])
})

test("D9: the reader is given CHECKS.md and the runs at the view's harness commit, reach, the diff and the pull request's words, in one checked sol-prompt call kept by its prompt", async () => {
  const s = stand()
  await check(s)
  expect(s.calls.filter((c) => c.step === 'curl').map((c) => c.command)).toEqual(['CHECKS.md', 'harness/stack.json']
    .map((f) => `curl -sfL --max-time 60 'https://raw.githubusercontent.com/${HARNESS}/${HARNESS_AT}/${f}'`))
  expect(s.asked.length).toBe(1)
  const [a] = s.asked
  for (const part of [INSTRUCTIONS, CHECKS, '"H1/W12": 61', '"title": "a title"', JSON.stringify(DIFF), '"notRan": [\n   20\n  ]']) expect(a!.prompt).toContain(part)
  expect([a!.model, a!.effort, a!.schema, a!.transcript, a!.kept]).toEqual(['sol-prompt', 'high', RESULT, true, { contextViewMerged: sha(a!.prompt) }])
  expect(a!.check({ areas: whole() })).toEqual([])
  expect(a!.check({ areas: whole().slice(1) })).toEqual(["no area holds src/a.ts 10–12, src/a.ts's deletion after 40"])
})

test('D9: a fold gets one more call, kept apart; a second fold, a failed call, a last try with problems and a prompt past the bound each fail the run, the last with no call', async () => {
  const once = stand({ replies: [message({ areas: whole() }, true), message({ areas: whole() })] })
  await check(once)
  expect(once.asked.map((a) => a.kept)).toEqual([{ contextViewMerged: sha(once.asked[0]!.prompt) }, { contextViewMerged: sha(once.asked[0]!.prompt), afterFold: true }])
  for (const [given, says, calls] of [
    [{ replies: [message({ areas: whole() }, true)] }, 'the reader folded its context twice, so its answer would rest on a summary of what merged', 2],
    [{ replies: [refused] }, "the reader's call failed (refused, cyber)", 1],
    [{ replies: [message({ areas: whole().slice(1) })] }, "the reader's last try still had 1 problem(s): no area holds src/a.ts 10–12, src/a.ts's deletion after 40", 1],
    [{ tokens: BOUND + 1 }, `the reader's prompt is ${BOUND + 1} tokens, past its bound of ${BOUND}`, 0],
  ] as [Stand, string, number][]) {
    const s = stand(given)
    expect(await failed(s)).toBe(says)
    expect(s.asked.length).toBe(calls)
    expect(text(s)).toEqual([expect.stringContaining(says)])
    expect(text(s)[0]).not.toContain('@')
  }
})

test("D10, D11: each covered area says observed or judged, each gap its reach, seconds and build in the reader's words, and gaps CHECKS.md doesn't list make one acorn record, naming the room's tender", async () => {
  const s = stand()
  expect(await check(s)).toMatchObject({ outcome: 'ran', action: 'posted', gaps: 2 })
  const line = text(s)[0]!
  expect(line.startsWith('@Tender-1 ')).toBe(true)
  expect(line).toContain('observed: the records of H3/W1 differ')
  const [record] = fenced(line)
  expect(record!.split('\n').slice(0, 5)).toEqual(['---', `title: ${JSON.stringify(`context view: cover what ${REPO} #248 merged (2 gaps)`)}`, 'nextAction: design', 'holder: null', '---'])
  expect(record).not.toContain('coordinator')
  expect(record!.split('\n')[5]!.startsWith('**Impact:**')).toBe(true)
  for (const part of ['`A W12 turn that reaches it.`', '`No run reaches it.`', 'H1/W12', 'about 12 s', `\`src/b.ts\` 1–9`]) expect(record).toContain(part)
  expect(record).not.toContain('It shapes the request.')
  const judged = stand({ view: { ...RAN, entries: [ENTRY(['H9/W9'])] } })
  await check(judged)
  expect(text(judged)[0]).toContain('judged: the reader names Check 3')
})

test("D11: a merge whose areas are covered or gaps CHECKS.md already lists names no one and carries no acorn", async () => {
  const known = (lines: object[], deletions: object[] = []) => ({ lines, deletions, verdict: 'gap', known: 'A stream that ends with no terminal event', why: 'No run cuts a stream.' })
  const s = stand({ replies: [message({ areas: [whole()[0], known([R('src/a.ts', 20)], [D('src/a.ts', 50)]), known([R('src/b.ts', 1, 9)])] })] })
  expect(await check(s)).toMatchObject({ gaps: 0 })
  expect(text(s)[0]).not.toContain('@')
  expect(fenced(text(s)[0]!)).toEqual([])
  expect(text(s)[0]).toContain('`A stream that ends with no terminal event`')
})

test('D12: where a line needs filing and no colleague tends the room, or the lookup fails, the line posts naming no one and the run fails saying so', async () => {
  for (const [given, says] of [
    [{ tender: { kind: 'nissa' } }, `no colleague tends ${ROOM}`],
    [{ commonsFails: true }, "astra-commons couldn't answer list_rooms (exit 1): astra-commons: no backend"],
  ] as [Stand, string][]) {
    const s = stand(given)
    expect(await failed(s)).toBe(`its line needs filing, and it names no one to file it: ${says}`)
    expect(text(s).length).toBe(1)
    expect(text(s)[0]!.startsWith('**')).toBe(true)
    expect(fenced(text(s)[0]!).length).toBe(1)
  }
})

test('D13: every post is quiet, in the room, keyed by the merge and its text; a dry check posts nothing and returns its lines', async () => {
  const s = stand()
  await check(s)
  expect(s.said.map((p) => [p.room, p.quiet, p.requestKey])).toEqual([[ROOM, true, `context-view-merged:${REPO}#248@${MERGED}:${sha(p0(s)).slice(0, 16)}`]])
  const d = stand()
  const result = await check(d, { post: false })
  expect(d.said).toEqual([])
  expect(result).toMatchObject({ action: 'dry', lines: [expect.stringContaining('@Tender-1 ')] })
  const f = stand({ run: 1 })
  expect(await failed(f, { post: false })).toContain("the run side couldn't run it")
  expect(f.said).toEqual([])
})
const p0 = (s: Stood) => text(s)[0]!

test("D14: after a posted line about a merge that ran, the shares go; a failure, a can't-check line and a dry check keep them", async () => {
  const s = stand()
  await check(s)
  expect(s.calls.filter((c) => c.step === 'clear').map((c) => c.command)).toEqual([`rm -rf -- '${DIR}'/share-*`])
  for (const [given, args, reached] of [
    [{ run: 1 }, {}, (t: Stood, r: unknown) => expect([r, text(t)]).toEqual([expect.stringContaining("the run side couldn't run it (exit 1)"), [expect.stringContaining('the check failed')]])],
    [{ run: 2, manifest: { outcome: 'couldnt-run', detail: { why: 'x' } } }, {}, (t: Stood, r: unknown) => expect([r, text(t)]).toEqual([expect.objectContaining({ outcome: 'couldnt-run', action: 'posted' }), [expect.stringContaining("can't be checked: `couldnt-run: x`")]])],
    [{}, { post: false }, (t: Stood, r: unknown) => expect([r, t.said]).toEqual([expect.objectContaining({ outcome: 'ran', action: 'dry' }), []])],
  ] as [Stand, Record<string, unknown>, (t: Stood, r: unknown) => void][]) {
    const t = stand(given)
    reached(t, await check(t, args).catch((e) => String(e && e.message)))
    expect(steps(t)).not.toContain('clear')
  }
})

test("D14: a line that can't be posted keeps the shares of a merge that ran, so they're never cleared before a post that holds", async () => {
  const s = stand({ postFails: true })
  expect(await failed(s)).toContain(`its line couldn't be posted in ${ROOM}`)
  expect(s.said).toHaveLength(1)
  expect(steps(s)).not.toContain('clear')
})

test("D13: the record's declared arguments are the ones the run reads, post among them, so a dry check can be started", () => {
  const r = Bun.spawnSync(['git', '-C', RECORDS, 'show', 'HEAD:workflows/context-view-merged.md'])
  const front = Bun.YAML.parse(r.stdout.toString().split(/^---$/m)[1]!) as { args: { properties: Record<string, unknown>, required: string[], additionalProperties: boolean } }
  expect(Object.keys(front.args.properties).sort()).toEqual(['merged', 'number', 'post', 'repo'])
  expect(front.args.properties.post).toMatchObject({ type: 'boolean', default: true })
  expect(front.args.required).toEqual(['repo', 'number', 'merged'])
  expect(front.args.additionalProperties).toBe(false)
})

test("D15: a read whose output comes back cut off is read once more, and one cut off twice fails the run saying so, never read as the whole", async () => {
  const once = stand({ cut: { checks: 1, stack: 1, release: 1 } })
  expect(await check(once)).toMatchObject({ outcome: 'ran', gaps: 2 })
  expect(once.calls.filter((c) => c.step === 'curl').length).toBe(4)
  expect(once.asked[0]!.prompt).toContain(CHECKS)
  const read = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why: 'x' } }, cut: { manifest: 1 } })
  expect(await check(read)).toMatchObject({ outcome: 'couldnt-run', cause: 'couldnt-run: x' })
  expect(read.calls.filter((c) => c.step === 'manifest').length).toBe(2)
  for (const [given, says] of [
    [{ cut: { release: 2 } }, `context-view:release came back incomplete twice, so where ${CURRENT} leads couldn't be read`],
    [{ cut: { checks: 2 } }, `the harness's CHECKS.md at ${HARNESS_AT} came back incomplete twice`],
    [{ partial: { checks: 2 } }, `the harness's CHECKS.md at ${HARNESS_AT} came back incomplete twice`],
    [{ cut: { stack: 2 } }, `the harness's harness/stack.json at ${HARNESS_AT} came back incomplete twice`],
    [{ cut: { facts: 1 } }, "view facts's answer came back incomplete, so what it found can't be read"],
    [{ cut: { count: 1 } }, "ctoc's count came back incomplete"],
    [{ run: 2, manifest: { outcome: 'couldnt-run', detail: { why: 'x' } }, cut: { manifest: 2 } }, "the run side couldn't run it (exit 2): context-view-run: on-gh failed; its manifest came back incomplete twice"],
  ] as [Stand, string][]) {
    const s = stand(given)
    expect([JSON.stringify(given.cut ?? given.partial), await failed(s)]).toEqual([JSON.stringify(given.cut ?? given.partial), expect.stringContaining(says)])
    expect(s.asked).toEqual([])
    expect(text(s)).toEqual([expect.stringContaining('the check failed')])
  }
  const lookup = stand({ cut: { commons: 1 } })
  expect(await failed(lookup)).toContain('its line needs filing, and it names no one to file it')
  expect(text(lookup)[0]!.startsWith('**')).toBe(true)
})

test("the stand holds every Bash call to Hands' budget: a budget outside 1,000 to 200,000 is refused before anything runs, and any answer past its budget comes back elided, not whole", async () => {
  const s = stand({ stack: { ...STACK, note: 'n'.repeat(5000) } })
  for (const command of [`realpath -e ${CURRENT} ${RELEASE_DIR}`, 'curl -sfL x/harness/stack.json', `if test -e '/nowhere'; then echo yes; else echo no; fi`])
    for (const max_output_chars of [999, 200_001, 300_000])
      await expect(s.words.tools('mcp__hands__Bash', { command, max_output_chars }, { label: 'x' })).rejects.toThrow(`max_output_chars must be a whole number from 1,000 to 200,000, not ${max_output_chars}`)
  expect(s.calls).toEqual([])
  expect(s.reads).toEqual([])
  const whole = JSON.stringify({ ...STACK, note: 'n'.repeat(5000) })
  const elided: any = await s.words.tools('mcp__hands__Bash', { command: 'curl -sfL x/harness/stack.json', max_output_chars: 1000 })
  expect(elided.structuredContent).toEqual({ exit_code: 0, stdout: null, stderr: '', output_complete: true, elided_chars: whole.length - 1000 })
  const unbounded: any = await s.words.tools('mcp__hands__Bash', { command: 'curl -sfL x/harness/stack.json' })
  expect(unbounded.structuredContent.stdout).toBe(whole)
})

test("D16: a line or deletion reach couldn't judge, and every line and deletion of a file reach couldn't read, is no area's and isn't given to the reader; each is listed with reach's reason", () => {
  expect(places.lines.has('src/d.json')).toBe(false)
  expect([...places.deletions.get('src/a.ts')!.keys()]).toEqual([40, 50])
  const c = couldntOf(REACH)
  expect([...c.entries()]).toEqual([
    ['src/a.ts', { lines: [30], deletions: [70], reason: 'src/a.ts is built into two scripts' }],
    ['src/d.json', { lines: [1, 2], deletions: [3], reason: "src/d.json isn't script source, so whether its change ran can't be read" }],
  ])
  expect(couldntOf(JUDGED).size).toBe(0)
})

test("D17: a merge with places reach couldn't judge says them with reach's reason, names the room's tender, and carries the Work line and record of its repository's reach acorn, beside the reader's areas", async () => {
  const s = stand({ reach: { ...REACH, ranBy: RANBY } })
  expect(await check(s)).toMatchObject({ outcome: 'ran', gaps: 2, couldnt: 5 })
  expect(s.asked[0]!.prompt).not.toContain('couldntTell')
  expect(s.asked[0]!.prompt).not.toContain('src/d.json')
  const line = text(s)[0]!
  expect(line.startsWith('@Tender-1 ')).toBe(true)
  for (const part of ['`src/a.ts` 30', 'the deletion after line 70 of `src/a.ts`', '`src/d.json` 1–2', 'src/a.ts is built into two scripts', "src/d.json isn't script source"]) expect(line).toContain(part)
  const [gaps, work, record] = fenced(line)
  expect(gaps!.split('\n')[1]).toBe(`title: ${JSON.stringify(`context view: cover what ${REPO} #248 merged (2 gaps)`)}`)
  const title = `context view: ${REPO}'s merges can't be checked: ${REACH_CAUSE}`
  expect(line).toContain(`titled \`${title}\``)
  expect(work).toContain('`src/d.json` 1–2')
  expect(record!.split('\n').slice(0, 5)).toEqual(['---', `title: ${JSON.stringify(title)}`, 'nextAction: understand', 'holder: null', '---'])
  expect(record).toContain(work!)
})

test("D17: a merge whose every place reach couldn't judge runs no reader, and its line says them and carries the reach acorn's text", async () => {
  const only = { files: { 'src/d.json': REACH.files['src/d.json'], 'src/c.ts': REACH.files['src/c.ts'] }, notes: [], ranBy: {} }
  const s = stand({ reach: only })
  expect(await check(s)).toMatchObject({ outcome: 'ran', couldnt: 3 })
  expect(s.asked).toEqual([])
  expect(text(s)[0]!.startsWith('@Tender-1 ')).toBe(true)
  expect(fenced(text(s)[0]!).length).toBe(2)
  expect(text(s)[0]).toContain('`src/d.json` 1–2')
})

test("D17: a merge with no gap to file, beside places reach couldn't judge, still names the room's tender and carries the reach acorn's text", async () => {
  const known = (lines: object[], deletions: object[] = []) => ({ lines, deletions, verdict: 'gap', known: 'A stream that ends with no terminal event', why: 'No run cuts a stream.' })
  const s = stand({ reach: { ...JUDGED, files: { ...JUDGED.files, 'src/d.json': REACH.files['src/d.json'] } }, replies: [message({ areas: [whole()[0], known([R('src/a.ts', 20)], [D('src/a.ts', 50)]), known([R('src/b.ts', 1, 9)])] })] })
  expect(await check(s)).toMatchObject({ gaps: 0, couldnt: 3 })
  expect(text(s)[0]!.startsWith('@Tender-1 ')).toBe(true)
  expect(fenced(text(s)[0]!).length).toBe(2)
})

test("D18: a couldnt-run naming a share is a job's failure: the run fails, its one line names no one and says the job's why, and nothing is filed, read from the manifest or from facts", async () => {
  const why = "on-gh exited 255: on-gh: the artifact's download failed (HTTP 503); on-gh --fetch 20261109T163202Z-1be4a340 tries again"
  for (const given of [
    { run: 2, manifest: { outcome: 'couldnt-run', detail: { share: 2, why } } },
    { run: 3, view: { repo: REPO, number: 248, head: MERGED, outcome: 'couldnt-run', detail: { share: 2, why }, merge: { commit: MERGED } } },
  ] as Stand[]) {
    const s = stand(given)
    const e = await failed(s)
    expect(e).toContain(`share 2's job failed: ${why}`)
    expect(e).toContain('`:again-<n>`')
    expect(steps(s)).not.toContain('commons:list_rooms')
    expect(text(s).length).toBe(1)
    const line = text(s)[0]!
    expect(line).toContain("share 2's job failed")
    expect(line).toContain(`\`${why}\``)
    expect(line).toContain('`:again-<n>`')
    expect(line).not.toContain('@')
    expect(fenced(line)).toEqual([])
  }
})

test("D18: every stop, told by its detail's stopped, fails the run as a job's failure does, from the manifest or from facts, with jobs out or during the plan; the plan's own failure, and a detail with shares but no stopped, can't be checked", async () => {
  const why = 'stopped by SIGTERM after 599 s', stopped = { signal: 'SIGTERM', seconds: 599 }
  for (const [given, says] of [
    [{ run: 2, manifest: { outcome: 'couldnt-run', detail: { why, stopped, shares: [2, 3] } } }, 'the run side was stopped with shares 2, 3 out'],
    [{ run: 3, view: { repo: REPO, number: 248, head: MERGED, outcome: 'couldnt-run', detail: { why, stopped, shares: [2, 3] }, merge: { commit: MERGED } } }, 'the run side was stopped with shares 2, 3 out'],
    [{ run: 2, manifest: { outcome: 'couldnt-run', detail: { why, stopped, shares: [] } } }, 'the run side was stopped, so'],
  ] as [Stand, string][]) {
    const s = stand(given)
    const e = await failed(s)
    expect([says, e]).toEqual([says, expect.stringContaining(`${says.replace(', so', '')}: ${why}`)])
    expect(e).toContain('`:again-<n>`')
    expect(steps(s)).not.toContain('commons:list_rooms')
    expect(text(s).length).toBe(1)
    const line = text(s)[0]!
    expect(line).toContain(says)
    expect(line).toContain(`\`${why}\``)
    expect(line).toContain('`:again-<n>`')
    expect(line).not.toContain('@')
    expect(fenced(line)).toEqual([])
  }
  for (const detail of [{ why: 'the run side failed before any job: x' }, { why: 'x', shares: [2] }]) {
    const plan = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail } })
    expect(await check(plan)).toMatchObject({ outcome: 'couldnt-run', action: 'posted' })
    expect(text(plan)[0]!.startsWith('@Tender-1 ')).toBe(true)
    expect(fenced(text(plan)[0]!).length).toBe(2)
  }
})

test("D5, D18: an arm-missing view, though its detail names a share, can't be checked, with one acorn per repository and cause", async () => {
  const view = { repo: REPO, number: 248, head: MERGED, outcome: 'arm-missing', detail: { share: 2, arm: 'after', log: null }, merge: { commit: MERGED, k: 0, src: true }, harness: { repo: HARNESS, sha: HARNESS_AT } }
  const s = stand({ run: 3, view })
  expect(await check(s)).toMatchObject({ outcome: 'arm-missing', action: 'posted' })
  expect(text(s)[0]!.startsWith('@Tender-1 ')).toBe(true)
  expect(fenced(text(s)[0]!)[1]!.split('\n')[1]).toBe(`title: ${JSON.stringify(`context view: ${REPO}'s merges can't be checked: arm-missing`)}`)
})

const ODD = 'it `ran` for @Q-1 "here'
const SPAN = '``it `ran` for @Q-1 "here``'

test("D19: the reader's why, known and build are each in a code span no backtick in them can close, with control characters as spaces", async () => {
  const s = stand({ replies: [message({ areas: [
    covered([R('src/a.ts', 10, 14)], { deletions: [D('src/a.ts', 40)], why: '`x` ends it' }),
    gap([R('src/a.ts', 20)], { deletions: [D('src/a.ts', 50)], why: ODD, build: 'first\nsecond' }),
    { lines: [R('src/b.ts', 1, 9)], deletions: [], verdict: 'gap', known: 'A stream that ends with no terminal event', why: 'a "b' },
  ] })] })
  expect(await check(s)).toMatchObject({ outcome: 'ran', gaps: 1 })
  const line = text(s)[0]!
  for (const part of ['The reader: `` `x` ends it ``', `The reader: ${SPAN}`, "Its build, in the reader's words: `first second`", 'which CHECKS.md lists: `A stream that ends with no terminal event`', 'The reader: `a "b`'])
    expect([part, line.includes(part)]).toEqual([part, true])
})

test("D19: each file path, and reach's reason, is in a code span no backtick in it can close", async () => {
  const P = 'src/`q`@Q-1 ".ts', PS = '``src/`q`@Q-1 ".ts``'
  const reach = { files: { [P]: { state: 'read', ran: [1], notRan: [2], couldntTell: [3], noCode: [], unloaded: [], deletions: [{ after: 4, state: 'couldnt-tell', by: 5 }, { after: 6, state: 'not-reached', by: 7 }], reason: ODD } }, notes: [], ranBy: { [P]: { 1: ['H1/W1'] } } }
  const s = stand({ reach, replies: [message({ areas: [covered([R(P, 1)]), gap([R(P, 2)], { deletions: [D(P, 6)] })] })] })
  expect(await check(s)).toMatchObject({ outcome: 'ran', gaps: 1, couldnt: 2 })
  const line = text(s)[0]!
  for (const part of [`1. ${PS} 1:`, `2. ${PS} 2, the deletion after line 6 of ${PS}:`, `${PS} 3, the deletion after line 4 of ${PS} (reach: ${SPAN})`])
    expect([part, line.includes(part)]).toEqual([part, true])
})

test("D19: the branch a merge went into, a can't-check cause and its acorn's title, a job's why and a failed run's why are each in a code span", async () => {
  const elsewhere = stand({ run: 3, view: { repo: REPO, number: 248, head: MERGED, outcome: 'elsewhere', detail: { branch: ODD }, merge: { commit: MERGED } } })
  await check(elsewhere)
  expect(text(elsewhere)[0]).toContain(`into ${SPAN}, isn't checked`)
  const plan = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { why: ODD } } })
  await check(plan)
  const title = `context view: ${REPO}'s merges can't be checked: couldnt-run: ${ODD}`
  expect(text(plan)[0]).toContain(`can't be checked: \`\`couldnt-run: ${ODD}\`\`.`)
  expect(text(plan)[0]).toContain(`titled \`\`${title}\`\``)
  const job = stand({ run: 2, manifest: { outcome: 'couldnt-run', detail: { share: 1, why: ODD } } })
  await failed(job)
  expect(text(job)[0]).toContain(SPAN)
  const run = stand({ releases: ODD })
  const why = (await failed(run))!
  expect(why).toContain(ODD)
  expect(text(run)[0]).toContain(`\`\`${why}\`\``)
})

test("D22: a gap whose reach is a workload or a run says the seconds this view's drives of it took in its base arm, one drive of each run, or that the view didn't measure all of it, or that a workload has no run, and then the reader's seconds as its estimate; a check's gives the estimate alone", async () => {
  const areas = (second: object, third: object) => [whole()[0], gap([R('src/a.ts', 20)], { deletions: [D('src/a.ts', 50)], ...second }), gap([R('src/b.ts', 1, 9)], third)]
  const s = stand({ replies: [message({ areas: areas({ reach: 'W1', seconds: 5 }, { reach: 'W12', seconds: 7 }) })] })
  await check(s)
  expect(text(s)[0]).toContain("which W1 would reach: this view's drives of W1's 2 runs took 46.8 s in its base arm, and the reader estimates its build adds about 5 s.")
  expect(text(s)[0]).toContain("which W12 would reach: this view's drive of W12's one run took 61 s in its base arm, and the reader estimates its build adds about 7 s.")
  expect(text(s)[0]).not.toContain('s of runner time')
  const other = stand({ replies: [message({ areas: areas({ reach: 'Check 1', seconds: 4 }, { reach: 'H1/W12', seconds: 12 }) })] })
  await check(other)
  expect(text(other)[0]).toContain("which Check 1 would reach; the reader estimates its build adds about 4 s.")
  expect(text(other)[0]).toContain("which H1/W12 would reach: this view's drive of H1/W12 took 61 s in its base arm, and the reader estimates its build adds about 12 s.")
  const none = stand({ stack: { seconds: { runs: { 'H1/W1': 14.4, 'H3/W1': 9 } } }, replies: [message({ areas: areas({ reach: 'W1', seconds: 5 }, { reach: 'W12', seconds: 7 }) })] })
  await check(none)
  expect(text(none)[0]).toContain("which W12 would reach: W12 has no run at the view's harness, and the reader estimates its build adds about 7 s.")
  const unmeasured = stand({ measured: { 'H1/W1': 28.8 }, replies: [message({ areas: areas({ reach: 'W1', seconds: 5 }, { reach: 'H1/W12', seconds: 12 }) })] })
  await check(unmeasured)
  expect(text(unmeasured)[0]).toContain("which W1 would reach: this view didn't measure all of W1's 2 runs, and the reader estimates its build adds about 5 s.")
  expect(text(unmeasured)[0]).toContain("which H1/W12 would reach: this view didn't measure H1/W12, and the reader estimates its build adds about 12 s.")
})

test("D25: the measured seconds are read from the view's manifest beside its view.json; a manifest with no seconds.measured, or none at all, gives none measured, and one that can't be parsed fails the run naming it", async () => {
  const areas = [whole()[0], gap([R('src/a.ts', 20)], { deletions: [D('src/a.ts', 50)], reach: 'W12', seconds: 7 }), gap([R('src/b.ts', 1, 9)], { reach: 'H1/W1', seconds: 3 })]
  for (const measured of [null, 'no-manifest'] as const) {
    const s = stand({ measured, replies: [message({ areas })] })
    expect(await check(s)).toMatchObject({ outcome: 'ran', gaps: 2 })
    expect([measured, text(s)[0]!.includes("this view didn't measure W12's one run, and")]).toEqual([measured, true])
    expect([measured, text(s)[0]!.includes("this view didn't measure H1/W1, and")]).toEqual([measured, true])
  }
  const bad = stand({ measured: 'unreadable', replies: [message({ areas })] })
  const why = (await failed(bad))!
  expect(why).toContain("the view's manifest.json couldn't be read")
  expect(why).toContain('JSON Parse error')
  expect(bad.asked).toHaveLength(0)
  expect(text(bad)).toEqual([expect.stringContaining('the check failed')])
})

test("D23: the acorn's Impact gives each gap's seconds as the reader's estimate of what its build adds, and says gaps that share a build share that time", async () => {
  const s = stand()
  await check(s)
  const impact = fenced(text(s)[0]!)[0]!.split('\n')[5]!
  expect(impact.startsWith('**Impact:**')).toBe(true)
  expect(impact).toContain("the reader's estimate of the runner time its build adds to each view; gaps that share a build share that time.")
  expect(impact).not.toContain('the runner time that adds to every view')
})

test("D24: a gap's why is followed by a full stop only where the reader's words don't already end in one, a closing quote or bracket after it counted", async () => {
  const areas = (second: string, third: string) => [whole()[0], gap([R('src/a.ts', 20)], { deletions: [D('src/a.ts', 50)], why: second }), gap([R('src/b.ts', 1, 9)], { reach: 'H1/W12', seconds: 12, why: third })]
  const s = stand({ replies: [message({ areas: areas('No run reaches it.', 'no run loads it') })] })
  await check(s)
  expect(text(s)[0]).toContain('The reader: `No run reaches it.` Its build')
  expect(text(s)[0]).toContain('The reader: `no run loads it`. Its build')
  expect(text(s)[0]).not.toContain('.`. Its build')
  const quoted = stand({ replies: [message({ areas: areas('It says "no run."', 'Is it reached (by W1)?') })] })
  await check(quoted)
  expect(text(quoted)[0]).toContain('The reader: `It says "no run."` Its build')
  expect(text(quoted)[0]).toContain('The reader: `Is it reached (by W1)?` Its build')
})

test("a file the view reads comes back through Bash 90,000 code points at a time until a slice is empty, so a diff longer than one slice reaches the reader whole, a byte that isn't UTF-8 reads as U+FFFD, and line ends stay as written", async () => {
  const long = `${DIFF}\n+${'x'.repeat(200000)}`
  const s = stand({ diff: long })
  expect(await check(s)).toMatchObject({ outcome: 'ran', gaps: 2 })
  expect(s.reads.filter((r) => r.label === 'merge.diff').map((r) => r.at)).toEqual([0, 90000, 180000, 270000])
  expect(s.reads.filter((r) => r.label === 'view').map((r) => r.at)).toEqual([0, 90000])
  expect(s.asked[0]!.prompt).toContain(JSON.stringify(long))
  const bytes = stand({ diff: Buffer.concat([Buffer.from(`${DIFF}\n+`), Buffer.from([0xff, 0xfe]), Buffer.from(' after\n')]) })
  expect(await check(bytes)).toMatchObject({ outcome: 'ran', gaps: 2 })
  expect(bytes.asked[0]!.prompt).toContain(JSON.stringify(`${DIFF}\n+\ufffd\ufffd after\n`))
  const ends = stand({ diff: `${DIFF}\n+crlf\r\n+lone\rcr\n` })
  expect(await check(ends)).toMatchObject({ outcome: 'ran', gaps: 2 })
  expect(ends.asked[0]!.prompt).toContain(JSON.stringify(`${DIFF}\n+crlf\r\n+lone\rcr\n`))
})

test("a slice of view.json, reach.json, manifest.json or merge.diff, or whether manifest.json is there, that comes back cut off or elided once is read again and the view goes on, and one that does so twice fails the run saying so after reading it twice, never read as the whole", async () => {
  for (const shape of ['cut', 'elided'] as const) {
    const once = stand({ [shape]: { 'read:view': 1, 'read:reach': 1, 'read:manifest': 1, 'read:merge.diff': 1, 'exists:manifest': 1 } })
    expect([shape, await check(once)]).toEqual([shape, expect.objectContaining({ outcome: 'ran', gaps: 2 })])
    expect(once.reads.map((r) => r.at === undefined ? r.label : `${r.label}@${r.at}`)).toEqual(['view@0', 'view@0', 'view@90000', 'reach@0', 'reach@0', 'reach@90000', 'exists:manifest', 'exists:manifest', 'manifest@0', 'manifest@0', 'manifest@90000', 'merge.diff@0', 'merge.diff@0', 'merge.diff@90000'])
    expect(once.asked[0]!.prompt).toContain(JSON.stringify(DIFF))
    for (const [given, says] of [
      [{ 'read:view': 2 }, '/view.json came back incomplete twice, so it couldn\'t be read'],
      [{ 'read:reach': 2 }, '/reach.json came back incomplete twice, so it couldn\'t be read'],
      [{ 'read:manifest': 2 }, "the view's manifest.json couldn't be read: "],
      [{ 'read:merge.diff': 2 }, '/merge.diff came back incomplete twice, so it couldn\'t be read'],
      [{ 'exists:manifest': 2 }, 'whether the view has a manifest.json couldn\'t be read'],
    ] as [Record<string, number>, string][]) {
      const s = stand({ [shape]: given })
      const why = await failed(s)
      expect([shape, JSON.stringify(given), why]).toEqual([shape, JSON.stringify(given), expect.stringContaining(says)])
      if (given['read:manifest']) expect(why).toContain('/manifest.json came back incomplete twice')
      const key = Object.keys(given)[0]!
      const label = key.startsWith('read:') ? `${key.slice('read:'.length)}@0` : key
      expect([shape, key, s.reads.filter((r) => (r.at === undefined ? r.label : `${r.label}@${r.at}`) === label).length]).toEqual([shape, key, 2])
      expect(s.asked).toEqual([])
      expect(text(s)).toEqual([expect.stringContaining('the check failed')])
    }
  }
})
