import { homedir } from 'node:os'
import { join } from 'node:path'

export const RECORDS = process.env.CONTEXT_VIEW_RECORDS || join(homedir(), 'astra/data/records')

// A saved workflow's script is a module whose default export is the run, given its args, which reads its words as globals;
// each import is evaluated afresh, as each run's is.
let loads = 0
export const moduleOf = (code: string) => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${++loads}`).toString('base64')}`)

const WORDS = ['agent', 'run', 'phase', 'text', 'budget', 'tools'] as const
export type Words = { [word: string]: unknown, tools?: (name: string, args: any, options?: any) => Promise<unknown> }

// Runs body with words as the globals a run reads, tools as an object whose each name calls tools(name, args, options), and
// puts back what the globals held before. The words are the process's globals, so two bodies overlapping in time would
// call each other's words, and the first to end would put back the other's.
export const withWords = async <T>(words: Words, body: () => T): Promise<Awaited<T>> => {
  const stray = Object.keys(words).filter((n) => !(WORDS as readonly string[]).includes(n))
  if (stray.length) throw new Error(`withWords takes only the words ${WORDS.join(', ')}, not ${stray.join(', ')}`)
  const g = globalThis as Record<string, unknown>
  const before = WORDS.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)] as const)
  const { tools, ...rest } = words
  Object.assign(g, rest, {
    tools: new Proxy({}, { get: (_t, name) => (typeof name === 'string' && tools ? (args: unknown, options?: unknown) => tools(name, args, options) : undefined) }),
  })
  try {
    return await body()
  } finally {
    for (const [n, d] of before) if (d) Object.defineProperty(g, n, d); else delete g[n]
  }
}

export const runOf = async (code: string) => {
  const run = (await moduleOf(code)).default
  return (args: unknown, words: Words) => withWords(words, () => run(args))
}

export const frozen = <T>(value: T): T => {
  const freeze = <V>(v: V): V => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
  return freeze(value === undefined ? undefined : structuredClone(value)) as T
}

export const script = (name: string): string | null => {
  const r = Bun.spawnSync(['git', '-C', RECORDS, 'show', `HEAD:workflows/${name}.md`])
  if (r.exitCode !== 0) throw new Error(`workflows/${name}.md can't be read as committed at the git HEAD of ${RECORDS}: ${r.stderr.toString().trim()}`)
  return (r.stdout.toString().match(/```js\n([\s\S]*?)\n```/) || [])[1] ?? null
}
