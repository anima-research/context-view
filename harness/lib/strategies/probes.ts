import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutThrow, errorText } from '../cut/interfaces.ts';
import { modelLimitsLine } from './older.ts';
import { HarnessFailure } from '../pool.ts';
import { laneRecipe } from './recipe.ts';
import type { Cut } from '../cut/interfaces.ts';
import type { Configuration } from '../workloads/workloads.ts';

// What a W12 stretch or a setup needs from the installed agent-framework, each read by the module it lives in, since no
// release exports the first two at run time; and what W16's kept-history branch needs, read as the literals it judges
// in the module that raises them, since nothing marks the breaker's probe at run time.
const CAPABILITIES = { suppression: 'gate/suppression-review', onboarding: 'gate/wake-onboarding', conversations: 'mcpl/conversation-router' };
const LITERALS: Record<string, [file: string, literals: string[]]> = { 'kept-history': ['framework', ['history-kept', 'fails-without-history']] };

const frameworkDir = (hostDir: string) => join(hostDir, 'node_modules', '@animalabs', 'agent-framework');
const frameworkRoots = (hostDir: string) => ['src', join('dist', 'src')].map((r) => join(frameworkDir(hostDir), r)).filter((r) => existsSync(r));

function frameworkModule(hostDir: string, file: string) {
  for (const root of frameworkRoots(hostDir)) for (const ext of ['.ts', '.js']) if (existsSync(join(root, file + ext))) return join(root, file + ext);
  return null;
}

const PROBE_BOUND_MS = 60_000;

const PROBE_OUTPUT_KEPT_BYTES = 1024 * 1024;

type FactsAnswer = { moved: string; window?: undefined } | { window?: unknown; streamBound?: unknown; budget?: unknown; maxTokens?: unknown; kvUnified?: { policy?: { [field: string]: unknown }; [field: string]: unknown }; moved?: undefined };
type ReviewAnswer = { reviewMs: number | null; moved?: undefined; why?: undefined } | { moved: 'gateOptionsFor'; why: string; reviewMs?: undefined } | { moved: 'reviewSettings'; why: string; reviewMs?: undefined };
type WatchedAnswer = { watched: { include?: unknown } | null; moved?: undefined } | { moved: string; watched?: undefined };

function askBun<T>({ hostDir, code, what, timeoutMs = PROBE_BOUND_MS }: { hostDir: string; code: string; what: string; timeoutMs?: number }): { said: T } | { why: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cv-probe-'));
  const answer = join(dir, 'said.json');
  try {
    const program = [
      "const { writeFileSync: writeAnswer } = await import('node:fs');",
      `const say = (o) => { writeAnswer(${JSON.stringify(answer)}, JSON.stringify(o)); process.exit(0); };`,
      code,
    ].join('\n');
    const r = spawnSync('bun', ['-e', program], { cwd: hostDir, encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: PROBE_OUTPUT_KEPT_BYTES, env: { ...process.env, NO_COLOR: '1' } });
    const failed = (r.error as NodeJS.ErrnoException | undefined)?.code;
    // A signal with ETIMEDOUT or ENOBUFS is spawnSync's own kill, at the bound or past the output it keeps; any other
    // is one the harness didn't send.
    if (r.signal && failed !== 'ETIMEDOUT' && failed !== 'ENOBUFS') throw new HarnessFailure(`the host's ${what} (bun) was ended by ${r.signal}`);
    try { return { said: JSON.parse(readFileSync(answer, 'utf-8')) as T }; } catch {}
    const why = failed === 'ETIMEDOUT' ? `bun was killed at the bound of ${timeoutMs} ms`
      : failed === 'ENOBUFS' ? `bun was killed for printing more than the ${PROBE_OUTPUT_KEPT_BYTES} bytes kept of its output`
      : r.error ? r.error.message : `bun exited ${r.status}`;
    return { why, output: (r.stderr || r.stdout || '').trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const unanswered = (asked: { why: string; output: string }) => (cut: Cut) => `${asked.why}${asked.output ? `): ${cut(asked.output, -2000)}` : ')'}`;

export function hostCapabilities(hostDir: string) {
  const dir = frameworkDir(hostDir);
  const unsure = (why: string) => new Error(`couldn't tell what the installed agent-framework brings: ${why}`);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown } | null; } catch (e) { throw unsure(`${join(dir, 'package.json')} can't be read (${(e as Error).message})`); }
  if (pkg?.name !== '@animalabs/agent-framework') throw unsure(`${join(dir, 'package.json')} names ${pkg?.name ?? 'no package'}`);
  if (!frameworkRoots(hostDir).length) throw unsure(`${dir} holds neither src nor dist/src`);
  const holds = ([file, literals]: [string, string[]]) => {
    const path = frameworkModule(hostDir, file);
    if (path === null) return { unreadable: unsure(`its ${file} module is in neither its src nor its dist/src`).message };
    let text;
    try { text = readFileSync(path, 'utf-8'); } catch (e) { return { unreadable: unsure(`${path} can't be read (${(e as Error).message})`).message }; }
    return literals.every((literal) => text.includes(literal));
  };
  return Object.fromEntries([
    ...Object.entries(CAPABILITIES).map(([name, file]): [string, boolean] => [name, frameworkModule(hostDir, file) !== null]),
    ...Object.entries(LITERALS).map(([name, read]): [string, boolean | { unreadable: string }] => [name, holds(read)]),
  ]);
}

export function hostFacts({ hostDir, configuration, timeoutMs = PROBE_BOUND_MS }: { hostDir: string; configuration: Configuration; timeoutMs?: number }) {
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const model = recipe.agent.model;
  const src = (f: string) => JSON.stringify(join(hostDir, 'src', f));
  const code = [
    `const recipe = ${JSON.stringify(recipe)};`,
    modelLimitsLine(hostDir, src),
    `const { buildFrameworkAgentConfig } = await import(${src('framework-agent-config.ts')});`,
    `const agentConfig = buildFrameworkAgentConfig(recipe, ${JSON.stringify(recipe.agent.name)}, ${JSON.stringify(model)}, undefined);`,
    ...(configuration.kvUnifiedPolicy === undefined ? ['const kvUnified = {};'] : [
      `const strategyHost = await import(${src('framework-strategy.ts')}).catch((e) => say({ moved: String(e?.message ?? e) }));`,
      "if (typeof strategyHost.standardKvUnifiedConfig !== 'function') say({ moved: 'src/framework-strategy.ts exports no function of that name' });",
      `const kvUnified = { kvUnified: strategyHost.standardKvUnifiedConfig(recipe, ${JSON.stringify(model)}) };`,
    ]),
    'say({',
    `  window: getDefaultModelLimits(${JSON.stringify(model)})?.maxContextTokens ?? null,`,
    '  streamBound: agentConfig.maxStreamTokens ?? null,',
    '  budget: agentConfig.contextBudgetTokens ?? null,',
    '  maxTokens: agentConfig.maxTokens ?? null,',
    '  ...kvUnified,',
    '});',
  ].join('\n');
  const asked = askBun<FactsAnswer>({ hostDir, code, what: 'recipe facts', timeoutMs });
  if (!('said' in asked)) throw cutThrow((cut) => `couldn't read the installed host's recipe facts (${unanswered(asked)(cut)}`);
  if ('moved' in asked.said) throw cutThrow((cut) => `couldn't read the host's standard kv-unified block, which this run of ${configuration.name} lays policy keys over: connectome-host's private standardKvUnifiedConfig, which the harness reads the block through, can't be called: ${cut(asked.said.moved, -2000)}`);
  let capabilities;
  try { capabilities = hostCapabilities(hostDir); } catch (e) { capabilities = { unreadable: errorText(e) }; }
  return { ...asked.said, capabilities };
}

// The interval of the suppression review the host arms: agent-framework's reviewSettings gives it from the options
// connectome-host's gateOptionsFor builds. Neither is public (agent-framework's package exports only its index, which
// leaves reviewSettings out, and gateOptionsFor is the host's own), so a run that needs the interval depends on both
// names, and only such a run should read it. Null where the gate or its review is off, or the install has no review.
export function reviewInterval({ hostDir, configuration, timeoutMs = PROBE_BOUND_MS }: { hostDir: string; configuration: Configuration; timeoutMs?: number }) {
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const reviewModule = frameworkModule(hostDir, CAPABILITIES.suppression);
  const code = [
    `const recipe = ${JSON.stringify(recipe)};`,
    `const host = await import(${JSON.stringify(join(hostDir, 'src', 'gate-options.ts'))}).catch((e) => say({ moved: 'gateOptionsFor', why: String(e?.message ?? e) }));`,
    "if (typeof host.gateOptionsFor !== 'function') say({ moved: 'gateOptionsFor', why: 'src/gate-options.ts exports no function of that name' });",
    "const gate = host.gateOptionsFor(recipe.modules.wake, '/');",
    'const review = gate?.suppressionReview;',
    'if (!gate || review === false || review?.enabled === false) say({ reviewMs: null });',
    ...(reviewModule === null ? ['say({ reviewMs: null });'] : [
      `const framework = await import(${JSON.stringify(reviewModule)}).catch((e) => say({ moved: 'reviewSettings', why: String(e?.message ?? e) }));`,
      `if (typeof framework.reviewSettings !== 'function') say({ moved: 'reviewSettings', why: ${JSON.stringify(`${CAPABILITIES.suppression} exports no function of that name`)} });`,
      'const settings = framework.reviewSettings(review || {});',
      "if (typeof settings?.intervalMs !== 'number') say({ moved: 'reviewSettings', why: `its settings give no intervalMs (${JSON.stringify(settings ?? null)})` });",
      'say({ reviewMs: settings.intervalMs });',
    ]),
  ].join('\n');
  const asked = askBun<ReviewAnswer>({ hostDir, code, what: "suppression review's interval", timeoutMs });
  if (!('said' in asked)) throw cutThrow((cut) => `couldn't read the suppression review's interval through connectome-host's private gateOptionsFor and agent-framework's unexported reviewSettings (${unanswered(asked)(cut)}`);
  const said = asked.said;
  if (said.moved === 'gateOptionsFor') throw cutThrow((cut) => `couldn't read the suppression review's interval: connectome-host's private gateOptionsFor, which the harness reads the review's options through, can't be called: ${cut(said.why, -2000)}`);
  if (said.moved === 'reviewSettings') throw cutThrow((cut) => `couldn't read the suppression review's interval: agent-framework's unexported reviewSettings, which the harness reads the interval through, can't be called: ${cut(said.why, -2000)}`);
  return said.reviewMs;
}

export function configWatched({ hostDir, configuration, timeoutMs = PROBE_BOUND_MS }: { hostDir: string; configuration: Configuration; timeoutMs?: number }) {
  const unsure = (why: string) => new Error(`couldn't tell whether the host watches its _config mount: ${why}`);
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const file = join(hostDir, 'src', 'workspace-mounts.ts');
  if (!existsSync(file)) throw unsure(`${file} doesn't exist`);
  const code = [
    `const host = await import(${JSON.stringify(file)}).catch((e) => say({ moved: String(e?.message ?? e) }));`,
    "if (typeof host.buildWorkspaceMounts !== 'function') say({ moved: 'src/workspace-mounts.ts exports no function buildWorkspaceMounts' });",
    `const mounts = host.buildWorkspaceMounts(${JSON.stringify(recipe.modules ?? {})}.workspace, '/store');`,
    "const config = (mounts ?? []).find((m) => m.name === '_config' && (m.watch ?? 'never') !== 'never');",
    'say({ watched: config ? { include: config.include ?? null } : null });',
  ].join('\n');
  const asked = askBun<WatchedAnswer>({ hostDir, code, what: '_config mount', timeoutMs });
  if (!('said' in asked)) throw cutThrow((cut) => unsure(`reading its buildWorkspaceMounts, ${asked.why}${asked.output ? `: ${cut(asked.output, -2000)}` : ''}`).message);
  const said = asked.said;
  if (said.moved) throw unsure(said.moved);
  if (!said.watched) return null;
  if (frameworkModule(hostDir, 'modules/workspace/watcher') === null) throw unsure(`the installed agent-framework has no workspace watcher at modules/workspace/watcher, which reports a watched mount's changes`);
  if (!Array.isArray(said.watched.include) || !said.watched.include.every((name): name is string => typeof name === 'string')) throw unsure(`its _config mount gives no include list of names (${JSON.stringify(said.watched.include)})`);
  return { include: said.watched.include };
}

export function chokidarVersion(hostDir: string) {
  for (const under of [['@animalabs', 'agent-framework', 'node_modules', 'chokidar'], ['chokidar']]) {
    const at = join(hostDir, 'node_modules', ...under, 'package.json');
    if (!existsSync(at)) continue;
    try { return `chokidar ${(JSON.parse(readFileSync(at, 'utf-8')) as { version?: unknown }).version}`; } catch (e) { return `chokidar of a version ${at} doesn't give: ${(e as Error).message}`; }
  }
  return `no chokidar in ${join(hostDir, 'node_modules')}`;
}
