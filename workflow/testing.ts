import { homedir } from 'node:os'
import { join } from 'node:path'

export const RECORDS = process.env.CONTEXT_VIEW_RECORDS || join(homedir(), 'astra/data/records')

let loads = 0
export const moduleOf = (code: string) => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${++loads}`).toString('base64')}`)

const WORDS = ['agent', 'run', 'phase', 'text', 'budget', 'tools'] as const
export type Words = { [word: string]: unknown, tools?: (name: string, args: any, options?: any) => Promise<unknown> }

export const withWords = async <T>(words: Words, body: () => T): Promise<Awaited<T>> => {
  const stray = Reflect.ownKeys(words).filter((n) => typeof n !== 'string' || !(WORDS as readonly string[]).includes(n))
  if (stray.length) throw new Error(`withWords takes only the words ${WORDS.join(', ')}, not ${stray.map(String).join(', ')}`)
  const g = globalThis as Record<string, unknown>
  const before = WORDS.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)] as const)
  const { tools, ...rest } = words
  const given: Record<string, unknown> = {
    ...rest,
    tools: new Proxy(Object.freeze({}), { get: (_t, name) => (typeof name === 'string' && name !== 'then' && tools ? (args: unknown, options?: unknown) => tools(name, args, options) : undefined) }),
  }
  try {
    for (const [n, value] of Object.entries(given)) Object.defineProperty(g, n, { value, writable: true, enumerable: true, configurable: true })
    return await body()
  } finally {
    const stuck: string[] = []
    for (const [n, d] of before) {
      try {
        if (d) Object.defineProperty(g, n, d); else delete g[n]
      } catch {
        stuck.push(n)
      }
    }
    if (stuck.length) console.error(`withWords couldn't put back ${stuck.join(', ')}, which the body left fixed`)
  }
}

const shares = (stdout: number, stderr: number, budget: number) => {
  if (stdout + stderr <= budget) return { stdout, stderr }
  const half = Math.floor(budget / 2)
  if (stdout <= half) return { stdout, stderr: budget - stdout }
  if (stderr <= half) return { stdout: budget - stderr, stderr }
  return { stdout: half, stderr: budget - half }
}

export const budgeted = <A extends object>(answer: A, budget: number): A => {
  const s = (answer as { structuredContent?: Record<string, unknown> }).structuredContent
  if (!s || typeof s.stdout !== 'string' || typeof s.stderr !== 'string') return answer
  const share = shares(s.stdout.length, s.stderr.length, budget)
  if (s.stdout.length <= share.stdout && s.stderr.length <= share.stderr) return answer
  return {
    ...answer,
    content: [{ type: 'text', text: s.stdout.slice(0, 200) }],
    structuredContent: {
      ...s,
      stdout: s.stdout.length <= share.stdout ? s.stdout : null,
      stderr: s.stderr.length <= share.stderr ? s.stderr : null,
      output_complete: s.output_complete ?? true,
    },
  } as A
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
  const r = Bun.spawnSync(['git', '-C', RECORDS, 'show', `HEAD:scripts/${name}.md`])
  if (r.exitCode !== 0) throw new Error(`scripts/${name}.md can't be read as committed at the git HEAD of ${RECORDS}: ${r.stderr.toString().trim()}`)
  return (r.stdout.toString().match(/```js\n([\s\S]*?)\n```/) || [])[1] ?? null
}
