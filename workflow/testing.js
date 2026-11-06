import { homedir } from 'node:os'
import { join } from 'node:path'

export const RECORDS = process.env.CONTEXT_VIEW_RECORDS || join(homedir(), 'astra/data/records')

let loads = 0
export const moduleOf = (code) => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${++loads}`).toString('base64')}`)
export const runOf = async (code) => (await moduleOf(code)).default

export const frozen = (value) => {
  const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
  return freeze(value === undefined ? undefined : structuredClone(value))
}

export const script = (name) => {
  const r = Bun.spawnSync(['git', '-C', RECORDS, 'show', `HEAD:workflows/${name}.md`])
  if (r.exitCode !== 0) throw new Error(`workflows/${name}.md can't be read as committed at the git HEAD of ${RECORDS}: ${r.stderr.toString().trim()}`)
  return (r.stdout.toString().match(/```js\n([\s\S]*?)\n```/) || [])[1] ?? null
}
