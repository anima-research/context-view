// @ts-nocheck
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ipcConnect, send, sleep, spawnHost, stopHost } from '../common.ts';
import { reachAttach, reachLaunch } from '../reach.ts';
import { lineReader, listenForPeers } from './control.ts';
import { openWebUi } from './webui.ts';
import { cutError, cutText, cutThrow, errorText } from './cut.ts';
import { FORK_PREFIX, spawnName } from './checks.ts';
import { bindsThinking } from '../standin/anthropic.ts';
import { modelLimitsLine } from './older.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcpl-server.ts');
const PRELOAD = join(HERE, 'virtual-date.ts');
const MODULE = join(HERE, 'module.ts');
const BOOT_MS = 120_000;
const TURN_MS = 120_000;
const COMMAND_MS = 60_000;
const MAINTAIN_MS = 120_000;
const SHUTDOWN_MS = 30_000;
const RESTART_MS = 1_000;
// chokidar 4's awaitWriteFinish holds a write it has seen until `new Date()` has moved its stabilityThreshold (100 ms in
// agent-framework's watcher) past the write, statting the file through `fs.stat` meanwhile, and the host's Date moves
// only with the workload's clock. So a watched write's step waits for that stat, then moves the clock a second: a
// resident's time passing, and more than the threshold.
const WRITE_SETTLE_MS = 1_000;

const FENCE = 'settle-fence:';

// Each command's answer as every host the runs drive writes it. connectome-host's #485 (merged into main as 08efb40e) made
// /undo and /redo act on the agent's window, answering "Undone: …" and "Redone: …", where they had branched the store
// and answered "Undone. Switched to branch …" (cebc11b and before); its changelog's migration names /branchto for the
// record's rollback, which both answer "Branched at [ID] -> …" once the store has moved.
const COMMANDS = {
  session: (lines) => {
    if (lines.some((l) => /^Session renamed to /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/session rename|No active session)/.test(l))) return 'failed';
    return null;
  },
  budget: (lines) => {
    if (lines.some((l) => /^Stream budget set to /.test(l))) return 'done';
    if (lines.some((l) => /^(Invalid token count|No agents)/.test(l))) return 'failed';
    return null;
  },
  newtopic: (lines) => {
    if (lines.some((l) => /^(Topic reset failed:|\/newtopic refused:|No context manager)/.test(l))) return 'failed';
    const at = lines.indexOf('Topic reset. Transition summary:');
    return at >= 0 && lines.length > at + 1 ? 'done' : null;
  },
  undo: (lines) => {
    if (lines.some((l) => /^(Undone\. Switched to branch "|Undone: )/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to undo|Undo failed|No agent context manager|No agent\.|\/undo refused:)/.test(l))) return 'failed';
    return null;
  },
  redo: (lines) => {
    if (lines.some((l) => /^(Redone\. Switched to branch "|Redone: )/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to redo|Redo failed|No agent context manager|No agent\.|\/redo refused:)/.test(l))) return 'failed';
    return null;
  },
  branchto: (lines) => {
    if (lines.some((l) => /^Branched at \[[^\]]*\] -> ".*" and switched\./.test(l))) return 'done';
    if (lines.some((l) => /^(branchto failed|No message with id|No agent context manager|Usage: \/branchto|\/branchto refused:)/.test(l))) return 'failed';
    return null;
  },
  checkout: (lines) => {
    if (lines.some((l) => /^Switched to branch /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/checkout|Branch ".*" not found|Checkout failed|No agent context manager|\/checkout refused:)/.test(l))) return 'failed';
    return null;
  },
  checkpoint: (lines) => {
    if (lines.some((l) => /^Checkpoint ".*" saved at branch /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/checkpoint|No agent context manager)/.test(l))) return 'failed';
    return null;
  },
  restore: (lines) => {
    if (lines.some((l) => /^Restored to checkpoint ".*" \(branch: /.test(l))) return 'done';
    if (lines.some((l) => /^(Checkpoint ".*" not found|No checkpoints saved|Available checkpoints:|Already at checkpoint "|No agent context manager|Restore failed|\/restore refused:)/.test(l))) return 'failed';
    return null;
  },
  branches: (lines) => {
    if (lines.some((l) => /^No agent context manager/.test(l))) return 'failed';
    const at = lines.findIndex((l) => /^--- Branches \(\d+\) ---$/.test(l));
    if (at < 0) return null;
    return lines.length > at + Number(/\((\d+)\)/.exec(lines[at])[1]) ? 'done' : null;
  },
};

/** How a host's answer to a command, its lines so far, ends: 'done', 'failed', or null while it may still come. */
export const commandEnds = (name, lines) => COMMANDS[name]?.(lines) ?? null;

const WEBUI_LISTENING = /\[webui\] listening on (https?:\/\/\S+)/;

// What a W12 stretch or a setup needs from the installed agent-framework, each read by the module it lives in, since no
// release exports the first two at run time.
const CAPABILITIES = { suppression: 'gate/suppression-review', onboarding: 'gate/wake-onboarding', conversations: 'mcpl/conversation-router' };

const frameworkDir = (hostDir) => join(hostDir, 'node_modules', '@animalabs', 'agent-framework');
const frameworkRoots = (hostDir) => ['src', join('dist', 'src')].map((r) => join(frameworkDir(hostDir), r)).filter((r) => existsSync(r));

function frameworkModule(hostDir, file) {
  for (const root of frameworkRoots(hostDir)) for (const ext of ['.ts', '.js']) if (existsSync(join(root, file + ext))) return join(root, file + ext);
  return null;
}

export function hostCapabilities(hostDir) {
  const dir = frameworkDir(hostDir);
  const unsure = (why) => new Error(`couldn't tell what the installed agent-framework brings: ${why}`);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')); } catch (e) { throw unsure(`${join(dir, 'package.json')} can't be read (${e.message})`); }
  if (pkg?.name !== '@animalabs/agent-framework') throw unsure(`${join(dir, 'package.json')} names ${pkg?.name ?? 'no package'}`);
  if (!frameworkRoots(hostDir).length) throw unsure(`${dir} holds neither src nor dist/src`);
  return Object.fromEntries(Object.entries(CAPABILITIES).map(([name, file]) => [name, frameworkModule(hostDir, file) !== null]));
}

export function hostFacts({ hostDir, configuration }) {
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const model = recipe.agent.model;
  const src = (f) => JSON.stringify(join(hostDir, 'src', f));
  const code = [
    `const recipe = ${JSON.stringify(recipe)};`,
    modelLimitsLine(hostDir, src),
    `const { buildFrameworkAgentConfig } = await import(${src('framework-agent-config.ts')});`,
    `const agentConfig = buildFrameworkAgentConfig(recipe, ${JSON.stringify(recipe.agent.name)}, ${JSON.stringify(model)}, undefined);`,
    'console.log(JSON.stringify({',
    `  window: getDefaultModelLimits(${JSON.stringify(model)})?.maxContextTokens ?? null,`,
    '  streamBound: agentConfig.maxStreamTokens ?? null,',
    '  budget: agentConfig.contextBudgetTokens ?? null,',
    '  maxTokens: agentConfig.maxTokens ?? null,',
    '}));',
  ].join('\n');
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  const line = (r.stdout || '').trim().split('\n').at(-1);
  let capabilities;
  try { capabilities = hostCapabilities(hostDir); } catch (e) { capabilities = { unreadable: errorText(e) }; }
  try {
    return { ...JSON.parse(line), capabilities };
  } catch {
    throw cutThrow((cut) => `couldn't read the installed host's recipe facts (bun exited ${r.status}): ${cut((r.stderr || r.stdout || '').trim(), -2000)}`);
  }
}

// The interval of the suppression review the host arms: agent-framework's reviewSettings gives it from the options
// connectome-host's gateOptionsFor builds. Neither is public (agent-framework's package exports only its index, which
// leaves reviewSettings out, and gateOptionsFor is the host's own), so a run that needs the interval depends on both
// names, and only such a run should read it. Null where the gate or its review is off, or the install has no review.
export function reviewInterval({ hostDir, configuration }) {
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const reviewModule = frameworkModule(hostDir, CAPABILITIES.suppression);
  const code = [
    `const recipe = ${JSON.stringify(recipe)};`,
    'const say = (o) => { console.log(JSON.stringify(o)); process.exit(0); };',
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
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  let said;
  try { said = JSON.parse((r.stdout || '').trim().split('\n').at(-1)); } catch {
    throw cutThrow((cut) => `couldn't read the suppression review's interval through connectome-host's private gateOptionsFor and agent-framework's unexported reviewSettings (bun exited ${r.status}): ${cut((r.stderr || r.stdout || '').trim(), -2000)}`);
  }
  if (said.moved === 'gateOptionsFor') throw cutThrow((cut) => `couldn't read the suppression review's interval: connectome-host's private gateOptionsFor, which the harness reads the review's options through, can't be called: ${cut(said.why, -2000)}`);
  if (said.moved === 'reviewSettings') throw cutThrow((cut) => `couldn't read the suppression review's interval: agent-framework's unexported reviewSettings, which the harness reads the interval through, can't be called: ${cut(said.why, -2000)}`);
  return said.reviewMs;
}

// connectome-host mounts the session's config directory as `_config` where the recipe's workspace sets configMount
// (workspace-mounts.ts buildWorkspaceMounts), and agent-framework's workspace watcher reports a change to a watched
// mount's file as a `workspace:modified` (or `workspace:created`, for a new file) once chokidar's awaitWriteFinish has
// settled it, which waits on `new Date()`, and the watcher's 300 ms debounce, a real-time timer, has passed
// (modules/workspace/watcher.ts).
export function configWriteEcho(events) {
  let at = -1;
  let file = null;
  events.forEach((e, i) => {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') { at = i; file = e.configPath; }
  });
  if (at < 0) return { wrote: false };
  const path = `_config/${basename(file)}`;
  const echoed = events.slice(at + 1).some((e) => echoDone(e, path));
  return { wrote: true, at, file, path, echoed };
}

const echoDone = (e, path) => e.type === 'process:completed' && (e.processEvent?.type === 'workspace:modified' || e.processEvent?.type === 'workspace:created') && (e.processEvent.paths ?? []).includes(path);

const isConfigEcho = (e) => e.type === 'process:received' && /^workspace:(created|modified|deleted)$/.test(e.processEvent?.type ?? '') && (e.processEvent.paths ?? []).some((p) => p.startsWith('_config/'));

export function unowedConfigEchoes(events, owed = []) {
  const owing = new Map();
  const owe = (p) => owing.set(p, (owing.get(p) ?? 0) + 1);
  owed.forEach(owe);
  const out = [];
  for (const e of events) {
    if ((e.type === 'gate:policy-added' || e.type === 'gate:policy-removed') && typeof e.configPath === 'string') owe(`_config/${basename(e.configPath)}`);
    else if (isConfigEcho(e)) {
      for (const p of e.processEvent.paths) {
        if (!p.startsWith('_config/')) continue;
        if (e.processEvent.type !== 'workspace:deleted' && owing.get(p) > 0) owing.set(p, owing.get(p) - 1);
        else out.push(`${p} (${e.processEvent.type})`);
      }
    }
  }
  return out;
}

export function echoWindows({ host, stepHost = host }) {
  const windows = [];
  if (stepHost && stepHost !== host) windows.push({ host: stepHost, from: stepHost.judged ?? 0 });
  if (host) windows.push({ host, from: host.judged ?? 0 });
  return windows;
}

export const movedSinceJudged = (host) => (host.moves ?? 0) > (host.judgedMoves ?? 0);

function includedNames(include) {
  const patterns = include.filter((name) => /[*?[\]{}]/.test(name) || name.includes('/'));
  if (patterns.length) throw new Error(`couldn't tell which files the _config mount watches: its include names ${patterns.join(', ')}, a pattern the driver doesn't read`);
  return include;
}

export function bootEchoesOwed(listing, include) {
  const names = includedNames(include);
  return listing.filter((name) => names.includes(name)).sort().map((name) => `_config/${name}`);
}

export const echoOwed = (file, include) => includedNames(include).includes(basename(file));

export function configWatched({ hostDir, configuration }) {
  const unsure = (why) => new Error(`couldn't tell whether the host watches its _config mount: ${why}`);
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const file = join(hostDir, 'src', 'workspace-mounts.ts');
  if (!existsSync(file)) throw unsure(`${file} doesn't exist`);
  const code = [
    'const say = (o) => { console.log(JSON.stringify(o)); process.exit(0); };',
    `const host = await import(${JSON.stringify(file)}).catch((e) => say({ moved: String(e?.message ?? e) }));`,
    "if (typeof host.buildWorkspaceMounts !== 'function') say({ moved: 'src/workspace-mounts.ts exports no function buildWorkspaceMounts' });",
    `const mounts = host.buildWorkspaceMounts(${JSON.stringify(recipe.modules ?? {})}.workspace, '/store');`,
    "const config = (mounts ?? []).find((m) => m.name === '_config' && (m.watch ?? 'never') !== 'never');",
    'say({ watched: config ? { include: config.include ?? null } : null });',
  ].join('\n');
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  let said;
  try { said = JSON.parse((r.stdout || '').trim().split('\n').at(-1)); } catch {
    throw cutThrow((cut) => unsure(`reading its buildWorkspaceMounts, bun exited ${r.status}: ${cut((r.stderr || r.stdout || '').trim(), -2000)}`).message);
  }
  if (said.moved) throw unsure(said.moved);
  if (!said.watched) return null;
  if (frameworkModule(hostDir, 'modules/workspace/watcher') === null) throw unsure(`the installed agent-framework has no workspace watcher at modules/workspace/watcher, which reports a watched mount's changes`);
  if (!Array.isArray(said.watched.include) || !said.watched.include.every((name) => typeof name === 'string')) throw unsure(`its _config mount gives no include list of names (${JSON.stringify(said.watched.include)})`);
  return { include: said.watched.include };
}

export async function lastTake({ boot, take, log, fail, step = null }) {
  await take().catch((e) => {
    log('compiles', { boot, lost: String(e?.message ?? e) });
    const { shown, full } = cutError(e, 500);
    const said = `boot ${boot}'s last take of the module's compiles failed: `;
    fail({ step, reason: `${said}${shown}`, ...(full ? { full: `${said}${full}` } : {}) });
  });
}

export function shutdownFailure({ boot, timedOut, exited, seconds }) {
  if (timedOut) return `boot ${boot}: the host didn't exit within ${seconds} s of its shutdown`;
  if (exited && (exited.code !== 0 || exited.signal)) return `boot ${boot}: the host exited (${exited.code ?? exited.signal}) on its shutdown`;
  return null;
}

/** Whether the host exits within `ms`, not counting the time a profiled host's read where it exits takes. */
export const exitWithin = (child, ms, reach = null) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const started = performance.now();
  const readBefore = reach?.readMs() ?? 0;
  const left = () => ms - (performance.now() - started) + ((reach?.readMs() ?? 0) - readBefore);
  let timer = null;
  let exited = false;
  const wait = () => {
    timer = setTimeout(async () => {
      await reach?.reading;
      if (exited) return;
      if (left() > 0) wait();
      else resolve(false);
    }, Math.max(0, left()));
  };
  child.once('exit', () => { exited = true; clearTimeout(timer); resolve(true); });
  wait();
});

// A step's reader is a persistent reader by name, or reader forks by the prefix their names share.
export const readerTurn = (reader, name) => (reader.prefix ? typeof name === 'string' && name.startsWith(reader.prefix) : name === reader.name);
export const readerStarts = (step) => (e) => readerTurn(step.reader, e.agentName) && e.type === 'inference:started';
// A step that scripts the resident a turn, as a fork's summary wakes it, fails on that turn's end too.
export const readerEnds = (step, resident) => (e) => (readerTurn(step.reader, e.agentName) || ((step.replies ?? []).length > 0 && e.agentName === resident)) && /^inference:(exhausted|aborted)$/.test(e.type);

export const readerFailureAllowed = (step, e) => step.mayFail === true && readerTurn(step.reader, e.agentName);

// Each held message's canary, with the author the script sends it under.
export const tunedOutAuthors = (steps) => [...new Map(steps.flatMap((s) => (s.tunedOut ?? []).map((c) => [c, typeof s.text === 'string' && s.text.includes(c) ? s.participant ?? null : (s.messages ?? []).find((m) => typeof m.text === 'string' && m.text.includes(c))?.participant ?? null]))).entries()];

export function hostEnv({ configuration, standinUrl, control, clock, runDir = null, tunedOut = [] }) {
  return {
    ANTHROPIC_BASE_URL: standinUrl, ANTHROPIC_API_KEY: 'sk-ant-fixture', TZ: 'UTC', AGENT_TIMEZONE: undefined, FIXTURE_CONTROL: control, FIXTURE_EPOCH_MS: String(clock),
    FIXTURE_TUNED_OUT: tunedOut.length ? JSON.stringify(tunedOut) : undefined,
    FIXTURE_RUN_DIR: runDir ?? undefined, IDENTITY_HOME: undefined, IDENTITY_KEY_FILE: undefined, SLEEP_PRIVILEGED_FILE: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_OAUTH_CREDENTIALS_FILE: undefined, ANTHROPIC_OAUTH_AUTO_REFRESH: undefined,
    MODEL: undefined, COUNT_TOKENS_MODEL: undefined,
    // The host reads npm's registry for its update notice at start and once a day unless this is 0
    // (connectome-host docs/DEPLOYMENTS.md), so a run would otherwise reach outside the machine, and the notice would
    // rest on what the registry answered.
    CONNECTOME_UPDATE_CHECK: '0',
    ...(configuration.agent?.provider === 'openai-responses' ? { OPENAI_BASE_URL: `${standinUrl}/v1`, OPENAI_API_KEY: 'sk-fixture' } : {}),
    ...(configuration.agent?.provider === 'openai-codex' ? { CODEX_BASE_URL: `${standinUrl}/codex`, CODEX_GATE_TOKEN: 'gate-fixture' } : {}),
    ...(configuration.agent?.provider === 'openai-compatible' ? { OPENAI_COMPATIBLE_API_KEY: 'sk-fixture' } : {}),
    // The host's Bedrock adapter reads AWS's variables and BEDROCK_BASE_URL (connectome-host index.ts); the fixture key
    // signs requests the stand-in doesn't check.
    ...(configuration.agent?.provider === 'bedrock' ? { BEDROCK_BASE_URL: standinUrl, AWS_ACCESS_KEY_ID: 'AKIAFIXTUREFIXTURE00', AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_SESSION_TOKEN: undefined, AWS_REGION: 'us-west-2' } : {}),
    // connectome-host reads OPENROUTER_BASE_URL since its pull request #620. The stand-in is the proxy for every HTTPS
    // request and tunnels none, so a host whose HTTPS client honours HTTPS_PROXY, as Bun 1.4.4's fetch does, sends nothing to
    // openrouter.ai if it doesn't read the variable: its request is refused at the stand-in, which records it. The
    // requests the stand-in serves are plain HTTP, which HTTPS_PROXY doesn't carry, and no other proxy is inherited.
    ...(configuration.agent?.provider === 'openrouter' ? { OPENROUTER_BASE_URL: `${standinUrl}/api/v1`, OPENROUTER_API_KEY: 'sk-or-fixture', HTTPS_PROXY: standinUrl, https_proxy: standinUrl, NO_PROXY: undefined, no_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined, ALL_PROXY: undefined, all_proxy: undefined } : {}),
    ...(bindsThinking(configuration.agent?.model) ? { THINKING_BINDING_PROBE: 'off' } : {}),
    FIXTURE_RECORD: configuration.recording === false ? 'off' : undefined,
  };
}

const BASE_AGENT = { name: 'fixture', provider: 'anthropic', systemPrompt: 'You are the strategy fixture\'s agent.' };

// An `openai-compatible` recipe names its endpoint itself (`agent.baseUrl`), so the stand-in's goes into the recipe,
// at the path of OpenAI's own Chat Completions, which the stand-in serves at `/v1`.
export function laneRecipe({ configuration, control, channels, boot, servers = {}, standinUrl = null, work = null }) {
  const presentation = configuration.agent?.toolPresentation;
  const agent = {
    ...BASE_AGENT, ...configuration.agent,
    ...(configuration.agent?.provider === 'openai-compatible' && standinUrl ? { baseUrl: `${standinUrl}/v1` } : {}),
    ...(presentation && work ? { toolPresentation: { ...presentation, path: resolve(work, presentation.path) } } : {}),
  };
  const kept = configuration.fixtureLifecycle === false ? Object.entries(configuration.fixtureChannels ?? {}).filter(([, kind]) => Object.keys(kind).length) : [];
  if (kept.length) throw new Error(`${configuration.name}'s fixtureLifecycle false gives the fixture server no channel kinds, so it can't keep ${kept.map(([id]) => id).join(', ')}'s ${[...new Set(kept.flatMap(([, kind]) => Object.keys(kind)))].join(' and ')}, which the server reads only from its kinds`);
  const env = (peerChannels) => ({ FIXTURE_CONTROL: control, FIXTURE_CHANNELS: peerChannels.join(','), FIXTURE_BOOT: String(boot) });
  return {
    ...configuration.recipe,
    name: `Strategy fixture (${configuration.name})`,
    agent,
    ...(configuration.maintenanceIntervalMs !== undefined ? { maintenanceIntervalMs: configuration.maintenanceIntervalMs } : {}),
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [SERVER],
        env: { ...env(channels), ...(configuration.fixtureOntology ? { FIXTURE_ONTOLOGY: JSON.stringify(configuration.fixtureOntology) } : {}), ...(configuration.fixtureSend ? { FIXTURE_SEND: '1' } : {}), ...(configuration.fixturePush ? { FIXTURE_PUSH: '1' } : {}), ...(configuration.fixtureChannels && configuration.fixtureLifecycle !== false ? { FIXTURE_CHANNEL_KINDS: JSON.stringify(configuration.fixtureChannels) } : {}) },
        enabledFeatureSets: ['fixture'],
        allowHostCommands: true,
        ...configuration.fixtureServer,
      },
      ...Object.fromEntries(Object.entries(servers).map(([name, list]) => [name, { command: process.execPath, args: [SERVER], env: { ...env(list), FIXTURE_PEER: `server:${name}` }, enabledFeatureSets: ['fixture'] }])),
    },
    modules: { subagents: false, lessons: false, retrieval: false, ...configuration.modules },
    extensions: { 'whole-host-harness': { kind: 'module', path: MODULE } },
    ...(configuration.subconscious ? { subconscious: configuration.subconscious } : {}),
  };
}

export function chokidarVersion(hostDir) {
  for (const under of [['@animalabs', 'agent-framework', 'node_modules', 'chokidar'], ['chokidar']]) {
    const at = join(hostDir, 'node_modules', ...under, 'package.json');
    if (!existsSync(at)) continue;
    try { return `chokidar ${JSON.parse(readFileSync(at, 'utf-8')).version}`; } catch (e) { return `chokidar of a version ${at} doesn't give: ${e.message}`; }
  }
  return `no chokidar in ${join(hostDir, 'node_modules')}`;
}

export function budgetReportDone(lines, agent, { prefix = false } = {}) {
  return lines.some((l) => l.startsWith(prefix ? `  ${agent}` : `  ${agent}: `) || !(l === BUDGET_HEADER || /^ {2}\S/.test(l)));
}
const BUDGET_HEADER = '--- Stream Token Budgets ---';

export function decisionTimer(step, { configuration, facts }) {
  const unknown = (why) => new Error(`the driver can't tell which timer starts ${why}`);
  if (step.verdict) {
    const delay = configuration.modules?.wake?.policies?.find((p) => p.name === step.verdict)?.behavior?.judge?.debounceMs;
    if (typeof delay !== 'number') throw unknown(`rule ${step.verdict}'s reply judge: the recipe gives no judge rule of that name a debounceMs`);
    return { delay, repeat: false };
  }
  if (step.review) {
    if (typeof facts.reviewMs !== 'number') throw unknown(`the suppression review: the host's facts give no review interval (${JSON.stringify(facts.reviewMs ?? null)})`);
    return { delay: facts.reviewMs, repeat: false };
  }
  return null;
}

// A fired timer is told apart only by its delay and whether it repeats: agent-framework arms the gate's timers with a
// plain setTimeout, which carries nothing else. So a one-shot timer of the decision's delay that fires before the
// decision's own in the same move is taken for it, and the wait for the decision runs out its bound, failing the run
// with that wait named. The decision is waited for before the round's settle: the host's maintain answer counts no
// request the reply judge or the suppression review has in flight (agent-framework's getHostModeStatus), so a settle
// could end between the judge's dry compile of the agent's context and the request that follows it.
export async function moveClockTo(to, { advance, settle, decision = null }) {
  let decided = false;
  for (;;) {
    const fired = await advance(to);
    if (!fired) return { decided };
    const decides = decision && !decided && fired.delay === decision.timer.delay && fired.repeat === decision.timer.repeat;
    if (decides) await decision.made();
    await settle();
    if (decides) {
      await decision.turns();
      decided = true;
    }
  }
}

// connectome-host names a task fork `<name>-d<depth>-<stamp>`, or `<name>-d<depth>-retry<n>-<stamp>` on a retry
// (subagent-module.ts, the fork's attempt loop).
const forkName = (agent) => /^(.+)-d\d+(?:-retry\d+)?-\d+$/.exec(String(agent))?.[1] ?? null;

// The child is a subagent or task fork by the name the script launched it as, or, by its reader's prefix, the reader
// fork created since the step began, so a reader fork an earlier step started never answers for it. A step that creates
// more than one, as a wake or cadence look would beside a cancel's when a tuned-out channel gets traffic
// (tune-out/coordinator.ts), gives a reason instead of a result: the hold can't tell which one it waits for.
export function subagentResult(events, child, since) {
  const after = events.slice(since);
  const readers = typeof child === 'string' ? [] : after.flatMap(({ e }) => (e.type === 'dendrite:agent-created' && typeof e.agentName === 'string' && e.agentName.startsWith(child.prefix) ? [e.agentName] : []));
  if (readers.length > 1) return `${readers.length} reader forks (${readers.join(', ')}) were created in the step, so its hold can't tell which one's result it waits for`;
  const from = (agent) => (typeof child === 'string' ? (spawnName(agent) ?? forkName(agent)) === child : readers.length === 1 && agent === readers[0]);
  return after.find(({ e }) => e.type === 'dendrite:mail-delivered' && e.kind === 'result' && from(e.from));
}

// connectome-host's headless sends `inference:speech` for its primary agent only (headless.ts `idleTrace`), so a fork of
// `conversations` speaks with none. The driver derives one as headless does: a fork's round that completed after
// tokens, with no tool calls yielded since it started.
export function forkSpeech() {
  const speech = new Map();
  return (e) => {
    const agent = e?.agentName;
    if (typeof agent !== 'string' || !agent.startsWith(FORK_PREFIX)) return null;
    if (e.type === 'inference:started' || e.type === 'inference:tool_calls_yielded') speech.set(agent, '');
    else if (e.type === 'inference:tokens' && e.content) speech.set(agent, `${speech.get(agent) ?? ''}${e.content}`);
    else if (e.type === 'inference:completed') {
      const content = speech.get(agent) ?? '';
      speech.set(agent, '');
      if (content) return { type: 'inference:speech', agentName: agent, content, derived: 'fork' };
    }
    return null;
  };
}

// connectome-host#555 on, headless sends `inference:speech` with `""` for a round that ended without tool calls and held
// no text, where a host before it sent nothing (headless.ts, docs/fleet-protocol.md). Such a frame isn't speech.
export function spoke(e) {
  return e.type === 'inference:speech' && e.content !== '';
}

export function gateSpeeches(events, from) {
  return events.slice(from).filter(({ e }) => spoke(e));
}

export function endsSpeechWait(step, e, ending) {
  return (step.ends === 'contained' ? e.type === 'inference:speech' : spoke(e)) || ending.test(e.type);
}

// connectome-host's headless mode traces the primary agent's speech as `inference:speech` once its round completes
// (headless.ts). agent-framework then ends it one of four ways, the same at 0.32.0 and 0.33.0: published to a channel,
// refused a route (whose trace names the agent as its conversationId), held as drafts, or kept private or unrouted, which
// only the turn's `[delivered]` receipt says (framework.ts appendProseDeliveryReceipt). A turn whose trigger suppresses
// its prose starts silent and ends none of those ways, and speech of whitespace alone, or an explicit turn's private
// envelope, ends none at all. The receipt's trace (`message:added` from `delivery-receipt`) names no agent, the same on
// agent-framework's main. At agent-framework#190's head a private turn's bounced words, under explicit and hybrid routing,
// hold no draft and write no receipt, only the bounce notice (`message:added` from `prose-bounce`), which names no agent
// either and ends the wait as a receipt does; where a bounce holds drafts, as at main, it holds them before it writes the
// notice.
export function speechEnd(events, at) {
  const agent = events[at].e.agentName;
  const alive = new Set();
  const others = new Set();
  const live = (e, i) => {
    if (e.type === 'inference:started') alive.add(e.agentName);
    else if (/^inference:(completed|aborted|exhausted)$/.test(e.type)) alive.delete(e.agentName);
    if (i >= at) for (const a of alive) if (a !== agent) others.add(a);
  };
  for (let i = 0; i <= at; i++) live(events[i].e, i);
  for (let i = at - 1; i >= 0; i--) {
    const { e } = events[i];
    if (e.type !== 'inference:started' || e.agentName !== agent) continue;
    if (e.silent === true) return { how: 'silent' };
    break;
  }
  for (let i = at + 1; i < events.length; i++) {
    const { e } = events[i];
    live(e, i);
    if (e.type === 'inference:published_complete' && e.agentName === agent) return { how: 'published' };
    if (e.type === 'mcpl:speech-route-failed' && e.conversationId === agent) return { how: 'undelivered', reason: e.reason ?? null };
    if (e.type === 'prose:drafts-held' && e.agentName === agent) return { how: 'held', reason: e.reason ?? null };
    const of = e.type === 'message:added' ? { 'delivery-receipt': 'receipt', 'prose-bounce': 'bounced' }[e.source] : undefined;
    if (of) return others.size ? { how: 'unsure', of, agents: [...others] } : { how: of };
  }
  return null;
}

export function speechWaits({ events, until, log, timeoutMs = TURN_MS }) {
  const judged = new Set();
  return async (speech, label) => {
    if (judged.has(speech)) return false;
    judged.add(speech);
    const list = events();
    const at = list.indexOf(speech);
    const end = await until(() => speechEnd(list, at), timeoutMs, `${label} (published, refused a route, held as drafts, or told in its turn's delivery receipt or a bounce notice)`);
    if (end.how === 'unsure') {
      const [what, whose, which] = end.of === 'bounced' ? ['a bounce notice', 'a bounce notice\'s', 'notice'] : ['a delivery receipt', 'a receipt\'s', 'receipt'];
      throw new RunFailure(`${label}: ${what} came while ${end.agents.join(' and ')}'s turn was alive too, and ${whose} trace names no agent, so it can't be told whether the ${which} is this speech's`);
    }
    if (end.how === 'silent') log('kept', { why: 'its turn started silent' });
    if (end.how === 'undelivered') log('undelivered', { reason: end.reason });
    return true;
  };
}

export function maintainedAgents(answer, agent) {
  const agents = answer?.maintenance?.agents;
  if (!Array.isArray(agents)) return { unreadable: 'holds no list of agents' };
  if (!agents.some((a) => a?.agentName === agent)) return { unreadable: `lists no agent named ${JSON.stringify(agent)}` };
  return { agents };
}

export function readSettle(answer, previous, ticks = {}, agent) {
  const listed = maintainedAgents(answer, agent);
  if (answer?.ok === true && listed.unreadable !== undefined) return { unreadable: listed.unreadable, ticking: [], settled: false, inFlight: false, moved: false, progress: previous };
  const agents = listed.agents ?? [];
  const host = answer?.hostMode ?? {};
  const progress = JSON.stringify({
    agents: agents.map((a) => {
      const p = a.progress ?? {};
      return [a.agentName, p.chunksCompressed, p.summaryCounts, p.l1QueueLength, p.mergeQueueLength, a.pending];
    }),
    deferredWrites: host.deferredWrites,
  });
  const ticking = Object.entries(ticks).filter(([, n]) => n !== 0).map(([name, n]) => `${name} ${n}`);
  return {
    ticking,
    settled: answer?.ok === true && agents.every((a) => a.ready === true) && host.drained === true && host.deferredWrites === 0 && host.gatedRequests === 0 && !ticking.length,
    inFlight: agents.some((a) => a.progress?.pending === true) || (host.activeTurnAgents ?? []).length > 0 || (host.parkedAdmissions ?? 0) > 0 || (host.gatedRequests ?? 0) > 0 || ticking.length > 0,
    moved: progress !== previous,
    progress,
  };
}

class RunFailure extends Error {}

const heldCalls = (step) => [...(step.subs ?? []).flatMap((s) => s.replies ?? []), ...(step.replies ?? [])].flatMap((r) => (Array.isArray(r.calls) ? r.calls : [])).filter((c) => c.during).map((c) => ({ canary: c.input.canary, during: c.during }));
const actsOf = (step) => [...heldCalls(step).flatMap((h) => h.during), ...(step.replies ?? []).flatMap((r) => r.during ?? [])];

const authorId = (participant) => `u-${String(participant).toLowerCase()}`;

export async function runScript({ steps, configuration, standin, hostDir, facts, work, storeDir, epoch, logPath, hostLogs, runDir = null, reach = null }) {
  if (steps.some((s) => s.review)) facts = { ...facts, reviewMs: reviewInterval({ hostDir, configuration }) };
  mkdirSync(work, { recursive: true });
  mkdirSync(hostLogs.dir, { recursive: true });
  const hostLogOf = (b) => `${hostLogs.at}/host-${b.n}.log`;
  const ending = (b, out) => `its whole output is ${hostLogOf(b)} in the evidence, and its last lines are:\n${tail(out)}`;
  mkdirSync(storeDir, { recursive: true });
  if (configuration.privileged) writeFileSync(join(work, 'sleep-privileged.json'), JSON.stringify(configuration.privileged.map(authorId)));
  for (const dir of configuration.dirs ?? []) mkdirSync(join(work, dir), { recursive: true });
  for (const [path, text] of Object.entries(configuration.files ?? {})) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  const t0 = performance.now();
  const wall = () => Math.round((performance.now() - t0) * 10) / 10;
  let seq = 0;
  let clock = epoch;
  let current = null;
  let stepFrom = 0;
  // A reader fork's hold released in this step, judged again at its end: a second reader fork made after the release still
  // leaves the step unable to say which one the hold waited for.
  let readerHolds = [];
  let stepHost = null;
  const log = (kind, fields = {}) => appendFileSync(logPath, `${JSON.stringify({ seq: seq++, wall: wall(), clock, step: current?.id ?? null, kind, ...fields })}\n`);
  const channelsOf = (server) => [...new Set(steps.flatMap((s) => (s.kind === 'channel' && server === 'fixture' ? [s.channel, ...actsOf(s).flatMap((a) => (a.deliver?.channel ? [a.deliver.channel] : []))] : s.kind === 'deliver' ? s.messages.filter((m) => (m.server ?? 'fixture') === server).map((m) => m.channel) : [])))];
  const channels = [...new Set([...Object.keys(configuration.fixtureChannels ?? {}), ...channelsOf('fixture')])];
  const tunedOut = tunedOutAuthors(steps);
  const servers = Object.fromEntries([...new Set(steps.flatMap((s) => (s.kind === 'deliver' ? s.messages.map((m) => m.server ?? 'fixture') : [])))].filter((n) => n !== 'fixture').map((n) => [n, channelsOf(n)]));
  const peerOf = (server) => (server && server !== 'fixture' ? `server:${server}` : 'server');
  const runName = `fx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = { ...BASE_AGENT, ...configuration.agent }.name;
  let recipeOf = configuration;
  const control = join(tmpdir(), `${runName}.ctl`);
  const ctl = await listenForPeers(control);
  const watchers = new Set();
  const poke = () => { for (const w of [...watchers]) w(); };
  let failure = null;
  const fail = (f) => { if (!failure) { failure = f; log('failure', f); } poke(); };
  const until = (check, timeoutMs, label, { pollMs = 0 } = {}) => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); clearInterval(poll); watchers.delete(attempt); };
    const attempt = () => {
      if (failure) { stop(); reject(new RunFailure(failure.reason)); return; }
      const v = check();
      if (v) { stop(); resolve(v); }
    };
    const timer = setTimeout(() => { stop(); fail({ step: current?.id ?? null, reason: `${label}: nothing after ${timeoutMs} ms` }); reject(new RunFailure(label)); }, timeoutMs);
    const poll = pollMs ? setInterval(attempt, pollMs) : undefined;
    watchers.add(attempt);
    attempt();
  });
  const unlessFailed = (p) => new Promise((resolve, reject) => {
    const check = () => { if (failure) { watchers.delete(check); reject(new RunFailure(failure.reason)); } };
    watchers.add(check);
    check();
    p.then((v) => { watchers.delete(check); resolve(v); }, (e) => { watchers.delete(check); reject(e); });
  });

  const notices = [];
  ctl.onNotice((n) => { notices.push(n); log('notice', n); poke(); });
  standin.onHeld(async (request) => {
    try {
      if (request.during) await act(current, request.during, request.id, request);
      else await compressionIdle(request);
    } catch (e) {
      const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 2000));
      if (!failure) fail({ step: current?.id ?? null, reason: `while ${request.id} was held: ${c.shown}`, ...(c.full ? { full: `while ${request.id} was held: ${c.full}` } : {}) });
    } finally {
      standin.releaseHeld(request.id);
      if (request.during) log('send', { via: 'release', request: request.id });
    }
  });

  let ended = false;
  standin.setClock(clock);
  const asked = [];
  standin.onRequest((r) => {
    if (ended) return;
    asked.push(r);
    poke();
    log('request', { request: r });
    if (r.kind === 'unclassified') fail({ step: current?.id ?? null, reason: `the stand-in got a request it couldn't classify (${r.reason ?? r.id})` });
  });

  let host = null;
  let boots = 0;
  let signalled = null;
  const reads = [];
  const timing = { boots: [], steps: [] };
  const copies = [];

  async function boot(after = RESTART_MS) {
    if (boots > 0) {
      const to = clock + after;
      log('advance', { from: clock, to, restart: true });
      clock = to;
      standin.setClock(clock);
    }
    const b = { n: ++boots, events: [], stopping: false };
    const fresh = !existsSync(storeDir) || readdirSync(storeDir).length === 0;
    const started = performance.now();
    const recipe = laneRecipe({ configuration: recipeOf, control, channels, boot: b.n, servers, standinUrl: standin.url, work });
    const recipePath = join(work, `recipe-${b.n}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
    const sockPath = join(tmpdir(), `${runName}-${b.n}.sock`);
    rmSync(sockPath, { force: true });
    const since = { server: ctl.generation('server'), clock: ctl.generation('clock'), module: ctl.generation('module'), ...Object.fromEntries(Object.keys(servers).map((n) => [peerOf(n), ctl.generation(peerOf(n))])) };
    log('boot', { boot: b.n, recipePath, storeDir });
    const env = hostEnv({ configuration: recipeOf, standinUrl: standin.url, control, clock, runDir, tunedOut });
    const launch = reach ? await reachLaunch({ logDir: reach.logDir }) : null;
    const { child, out } = spawnHost({ hostDir, recipePath, dataDir: storeDir, cwd: work, sockPath, env: { ...env, ...launch?.env }, preload: PRELOAD, bunArgs: launch?.args ?? [] });
    Object.assign(b, { child, out, sockPath, ...(launch ? { reach: reachAttach({ launch, child, wanted: reach.wanted, killing: () => { b.killed = true; } }) } : {}) });
    host = b;
    child.once('exit', (code, signal) => {
      b.exited = { code, signal };
      if (signal && !b.killed) signalled ??= { boot: b.n, signal };
      log('exit', { boot: b.n, code, signal, expected: b.stopping });
      if (!b.stopping) fail({ step: current?.id ?? null, reason: `the host exited (${code ?? signal}); ${ending(b, out)}` });
      poke();
    });
    await until(() => existsSync(sockPath), BOOT_MS, `boot ${b.n}: the host's IPC socket`, { pollMs: 50 });
    for (let attempt = 0; !b.sock; attempt++) {
      try { b.sock = await ipcConnect(sockPath); } catch (e) {
        if (attempt >= 40 || failure) throw new RunFailure(`boot ${b.n}: couldn't connect to IPC: ${e.message}`);
        await sleep(50);
      }
    }
    const spoke = configuration.judges === 'fork' ? forkSpeech() : null;
    lineReader(b.sock, (e) => {
      const at = wall();
      b.events.push({ at, e });
      if (!(e.type === 'snapshot' && String(e.corrId).startsWith(FENCE))) log('ipc', { at, event: e });
      const said = spoke?.(e);
      if (said) {
        b.events.push({ at, e: said });
        log('fork-speech', { at, agent: said.agentName, chars: said.content.length });
      }
      poke();
    });
    await until(() => b.events.some(({ e }) => e.type === 'lifecycle' && e.phase === 'ready'), BOOT_MS, `boot ${b.n}: lifecycle ready`);
    await unlessFailed(ctl.waitConnected('server', { since: since.server, timeoutMs: BOOT_MS }));
    for (const n of Object.keys(servers)) await unlessFailed(ctl.waitConnected(peerOf(n), { since: since[peerOf(n)], timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('clock', { since: since.clock, timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('module', { since: since.module, timeoutMs: BOOT_MS }));
    b.module = true;
    timing.boots.push(Math.round(performance.now() - started));
    log('ready', { boot: b.n, ms: timing.boots.at(-1) });
    await takeCompiles('boot');
    await budgetReport(b);
    await configBootEcho(b, fresh);
  }

  async function budgetReport(b, { fork = false } = {}) {
    const started = performance.now();
    const from = b.events.length;
    send(b.sock, { type: 'command', command: '/budget' });
    const lines = () => b.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    // Each agent's line comes as its own output, so a report read for a fork waits for the fork's.
    await until(() => budgetReportDone(lines(), fork ? FORK_PREFIX : agentName, { prefix: fork }), COMMAND_MS, `boot ${b.n}: /budget`);
    log('budget-report', { boot: b.n, lines: lines(), ms: Math.round(performance.now() - started) });
  }

  async function takeCompiles(at = null) {
    if (!host) return;
    const { lines, store, blobs, submissions } = await ctl.moduleRequest('take');
    if (lines.length || Object.keys(store).length || Object.keys(blobs).length || submissions?.length) log('compiles', { boot: host.n, ...(at ? { at } : {}), lines, store, blobs, ...(submissions?.length ? { submissions } : {}) });
  }

  async function shutdown() {
    const b = host;
    if (!b) return;
    if (b.module) await lastTake({ boot: b.n, take: takeCompiles, log, fail, step: current?.id ?? null });
    host = null;
    b.stopping = true;
    if (!b.exited) {
      if (b.sock) send(b.sock, { type: 'shutdown' });
      const timedOut = !(await exitWithin(b.child, SHUTDOWN_MS, b.reach));
      if (timedOut) {
        b.killed = true;
        stopHost(b.child);
        await exitWithin(b.child, SHUTDOWN_MS);
      }
      const why = shutdownFailure({ boot: b.n, timedOut, exited: b.exited, seconds: SHUTDOWN_MS / 1000 });
      if (why) fail({ step: current?.id ?? null, reason: `${why}; ${ending(b, b.out)}` });
    }
    try { b.sock?.destroy(); } catch {}
    b.webui?.close();
    b.killed = true;
    stopHost(b.child);
    if (b.reach) {
      reads.push({ boot: b.n, ...await b.reach.atExit });
      b.reach.close();
    }
    try { writeFileSync(join(hostLogs.dir, `host-${b.n}.log`), b.out.join('')); } catch (e) {
      fail({ step: current?.id ?? null, reason: `boot ${b.n}: the host's log couldn't be written: ${e.message}` });
    }
    log('shutdown', { boot: b.n, hostLog: hostLogOf(b) });
  }

  const eventAfter = (from, test) => host.events.slice(from).find(({ e }) => test(e));
  const speechEnds = speechWaits({ events: () => host.events, until, log });

  let fences = 0;
  async function ipcFence() {
    const t = performance.now();
    const corrId = `${FENCE}${++fences}`;
    const from = host.events.length;
    send(host.sock, { type: 'describe', corrId });
    await until(() => eventAfter(from, (e) => e.type === 'snapshot' && e.corrId === corrId), COMMAND_MS, 'the IPC answer that ends a settle');
    return Math.round((performance.now() - t) * 10) / 10;
  }

  async function settle() {
    const started = performance.now();
    let progress = null;
    let pass = 0;
    for (;;) {
      pass++;
      const t = performance.now();
      const answer = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const read = readSettle(answer, progress, await ctl.moduleRequest('ticks'), agentName);
      const { ticking } = read;
      const first = progress === null;
      progress = read.progress;
      const agents = answer?.maintenance?.agents ?? [];
      const { drained, deferredWrites, gatedRequests, activeTurnAgents = [] } = answer?.hostMode ?? {};
      log('settle', { phase: 'pass', pass, ms: Math.round(performance.now() - t), ok: answer?.ok, ran: answer?.maintenance?.ran, runId: answer?.maintenance?.history?.[0]?.id ?? null, agents, drained, deferredWrites, gatedRequests, activeTurnAgents, inFlight: read.inFlight, moved: read.moved, ...(ticking.length ? { ticking } : {}) });
      if (read.unreadable !== undefined) {
        const why = `couldn't read the settle: the host's maintain answer ${read.unreadable}`;
        log('settle', { phase: 'end', settled: false, passes: pass, ms: Math.round(performance.now() - started), why });
        fail({ step: current?.id ?? null, reason: why });
        throw new RunFailure('unreadable');
      }
      if (read.settled) {
        const fence = await ipcFence();
        log('settle', { phase: 'end', settled: true, passes: pass, ms: Math.round(performance.now() - started), fenceMs: fence });
        await takeCompiles();
        return pass;
      }
      if (failure) throw new RunFailure(failure.reason);
      const whyOf = (cut) => (!answer?.ok ? `maintain answered ${cut(JSON.stringify(answer), 300)}`
        : !read.inFlight && !first && !read.moved ? 'nothing in flight, and the last pass moved nothing on'
          : performance.now() - started >= TURN_MS ? `still unsettled after ${TURN_MS} ms between passes, the bound a turn's speech has`
            : null);
      const why = whyOf((v, n) => String(v).slice(0, n));
      if (why) {
        const ms = Math.round(performance.now() - started);
        log('settle', { phase: 'end', settled: false, passes: pass, ms, why });
        const host = [
          drained === true ? 'the host drained' : drained === false ? `the host not drained (turns alive: ${activeTurnAgents.join(', ') || 'none named'})` : 'no drained state in the host\'s answer',
          typeof deferredWrites !== 'number' || deferredWrites === 0 ? null : `${deferredWrites} deferred write(s) still to land`,
          typeof gatedRequests !== 'number' ? 'no count of gated requests in the host\'s answer' : gatedRequests === 0 ? null : `${gatedRequests} wake(s) waiting to start a turn`,
        ].filter(Boolean).join(', ');
        const said = cutText((cut) => {
          const notReady = agents.filter((a) => a.ready !== true).map((a) => (a.agentName ? `${a.agentName} (${a.error ?? a.pending ?? 'no pending work named'})` : cut(JSON.stringify(a), 200)));
          return `the run didn't settle (${whyOf(cut)}; ${pass} maintenance passes in ${(ms / 1000).toFixed(1)} s): ${notReady.length ? `not ready: ${notReady.join(', ')}` : 'every agent ready'}, ${host}. A wait timed by the host's virtual clock can't end inside a settle, since the driver moves that clock only between settles.`;
        });
        fail({ step: current?.id ?? null, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure('unsettled');
      }
    }
  }

  async function compressionIdle(request) {
    const started = performance.now();
    for (let pass = 1; ; pass++) {
      const answer = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const listed = maintainedAgents(answer, agentName);
      if (answer?.ok === true && listed.unreadable !== undefined) throw new RunFailure(`couldn't read whether compression is idle: the host's maintain answer ${listed.unreadable}`);
      const ticks = await ctl.moduleRequest('ticks');
      const idle = answer?.ok === true && listed.agents.every((a) => a.ready === true && a.progress?.pending !== true) && !readSettle(answer, null, ticks, agentName).ticking.length;
      if (idle) {
        log('held', { request: request.id, agent: request.agent, passes: pass, ms: Math.round(performance.now() - started) });
        return;
      }
      if (performance.now() - started >= TURN_MS) throw new RunFailure(`compression didn't go idle within ${TURN_MS} ms (${pass} passes)`);
    }
  }

  const channelMessage = (step, { id, participant, text, images, tags }) => ({ channelId: step.channel, messageId: id, author: { id: authorId(participant), name: participant }, topic: step.topic, text, ...(images ? { images } : {}), ...(tags ? { tags } : {}), at: clock });
  const sendSummary = (message) => ({ ...message, text: `${message.text.length} chars`, ...(message.images ? { images: message.images.length } : {}) });

  async function act(step, acts, during, request = null) {
    for (const a of acts) {
      if (a.deliver) {
        const message = channelMessage({ channel: a.deliver.channel ?? step.channel, topic: step.topic }, a.deliver);
        const from = host.events.length;
        log('send', { via: 'channel', during, message: sendSummary(message) });
        await ctl.deliver(message, { timeoutMs: TURN_MS });
        const stored = () => {
          const admitted = host.events.findIndex(({ e }, i) => i >= from && e.type === 'admission:decided' && e.messageId === message.messageId);
          return admitted >= 0 && host.events.slice(admitted).some(({ e }) => e.type === 'message:added' && e.source === 'mcpl:channel-incoming');
        };
        await until(stored, TURN_MS, `step ${step.id}: ${message.messageId} admitted and stored by the host (admission:decided, then message:added)`);
      } else if (a.console) {
        const from = host.events.length;
        log('send', { via: 'console', during, id: a.console.id, chars: a.console.text.length });
        send(host.sock, { type: 'text', content: a.console.text, from: 'console' });
        await until(() => eventAfter(from, (e) => e.type === 'message:added' && e.source === 'external-message'), TURN_MS, `step ${step.id}: console input ${a.console.id} stored by the host (message:added from external-message)`);
      } else if (a.agentEnd) {
        const landed = await until(() => subagentResult(host.events, a.agentEnd, stepFrom), TURN_MS, `step ${step.id}: ${typeof a.agentEnd === 'string' ? `subagent ${a.agentEnd}'s` : `a reader fork's (${a.agentEnd.prefix}…)`} result stored for its launcher (dendrite:mail-delivered)`);
        if (typeof landed === 'string') { fail({ step: step.id, reason: `step ${step.id}: ${landed}` }); throw new RunFailure('reader forks'); }
        if (typeof a.agentEnd !== 'string') readerHolds.push(a.agentEnd);
        log('agent-end', { during, agent: landed.e.from, to: landed.e.to });
      } else if (a.remove) {
        const messageIds = await resolveMessages(fromHeld(a.remove.messages, request));
        const got = await moduleRead('messages', { agent: agentName });
        const canaries = messageIds.flatMap((id) => (got?.messages ?? got ?? []).find((m) => m.id === String(id))?.canaries ?? []);
        log('send', { via: 'module', op: 'remove', messageIds, during });
        for (const messageId of messageIds) await moduleRead('remove', { messageId });
        log('remove', { messageIds, canaries, during });
      } else if (a.advance) {
        const from = asked.length;
        let firedAny = false;
        await moveClockTo(clock + a.advance, {
          advance: async (to) => {
            const { at, fired } = await unlessFailed(ctl.advance(to));
            log('advance', { during, from: clock, to: at, ...(fired ? { fired } : {}) });
            host.moves = (host.moves ?? 0) + 1;
            clock = at;
            standin.setClock(clock);
            if (fired) firedAny = true;
            return fired;
          },
          settle: async () => {},
        });
        if (a.cut && !firedAny) {
          fail({ step: step.id, reason: `step ${step.id}: moving the clock ${a.advance} ms past the held call's send fired no host timer, where the inference bound's cut of a call with no content would fire` });
          throw new RunFailure('no cut');
        }
        if (a.cut) await until(() => asked.slice(from).some((r) => r.kind === 'agent' && r.step === step.id), TURN_MS, `step ${step.id}: a fresh call after the inference bound cut the held one, ${a.advance} ms on`);
      } else if (a.asked) {
        const n = a.n ?? 1;
        await until(() => asked.filter((r) => r.agent === a.asked && r.step === step.id).length >= n, TURN_MS, `step ${step.id}: request ${n} of ${a.asked === 'primary' ? agentName : `subagent ${a.asked}`} at the step`);
      } else if (a.ended) {
        await until(() => host.events.slice(stepFrom).some(({ e }) => spawnName(e.agentName) === a.ended && /^inference:(completed|aborted|exhausted)$/.test(e.type)), TURN_MS, `step ${step.id}: a turn of subagent ${a.ended} ending`);
      } else {
        fail({ step: step.id, reason: `the driver has no act ${JSON.stringify(a)} for a hold` });
        throw new RunFailure('unknown act');
      }
    }
  }

  async function channelTurn(step) {
    const from = host.events.length;
    const message = channelMessage(step, { id: step.id, participant: step.participant, text: step.text, images: step.images, tags: step.tags });
    log('send', { via: 'channel', message: sendSummary(message) });
    await ctl.deliver(message, { timeoutMs: TURN_MS });
    if (step.reader) {
      const reader = step.reader.prefix ? `a reader fork's (${step.reader.prefix}…)` : `${step.reader.name}'s`;
      await until(() => eventAfter(from, readerStarts(step)), TURN_MS, `turn ${step.id}: ${reader} turn`);
      await settle();
      const failed = eventAfter(from, readerEnds(step, agentName));
      if (failed && readerFailureAllowed(step, failed.e)) {
        log('turn-failed', { agent: failed.e.agentName, event: failed.e.type, error: failed.e.error ?? null });
        return;
      }
      if (failed) {
        const said = cutText((cut) => `${failed.e.agentName}'s turn ended in ${failed.e.type}: ${cut(JSON.stringify(failed.e), 1500)}`);
        fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure(failed.e.type);
      }
      return;
    }
    for (const { canary, during } of heldCalls(step)) {
      await until(() => notices.some((n) => n.notice === 'held' && n.canary === canary), TURN_MS, `turn ${step.id}: the call held for ${canary}`);
      await act(step, during, canary);
      await ctl.release(canary, { timeoutMs: COMMAND_MS });
      log('send', { via: 'release', canary });
    }
    const ending = step.mayFail || step.retries ? /^inference:(exhausted|aborted)$/ : /^inference:(failed|exhausted|aborted)$/;
    if (step.ends === 'unspoken') {
      const done = await until(() => eventAfter(from, (e) => e.type === 'inference:completed' || ending.test(e.type)), TURN_MS, `turn ${step.id}: its inference's end`);
      if (done.e.type !== 'inference:completed') {
        const said = cutText((cut) => `the turn's end in ${done.e.type}: ${cut(JSON.stringify(done.e), 1500)}`);
        fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure(done.e.type);
      }
      await settle();
      if (eventAfter(from, spoke)) {
        fail({ step: step.id, reason: `turn ${step.id} spoke, where its script ends it with no speech` });
        throw new RunFailure('spoke');
      }
      return;
    }
    const ended = await until(() => eventAfter(from, (e) => endsSpeechWait(step, e, ending)), TURN_MS, `turn ${step.id}: its speech`);
    if (ended.e.type === 'inference:speech' && step.ends === 'contained') {
      // agent-framework's tool-wrapper guard contains the speech: it publishes, holds and receipts none of it
      // (docs/tool-wrapper-prose-guard.md), so its speech has no end to wait for.
      await settle();
      return;
    }
    if (ended.e.type !== 'inference:speech' && step.mayFail) {
      log('turn-failed', { event: ended.e.type, error: ended.e.error ?? null });
      await gateTurns(step, from);
      return;
    }
    if (ended.e.type !== 'inference:speech') {
      // agent-framework reports inference:failed before it decides whether to retry, and the
      // event doesn't say which; the fixture stops at the first failure either way.
      const what = ended.e.type === 'inference:failed'
        ? 'the turn\'s first inference failure (inference:failed, which agent-framework may still have retried)'
        : `the turn's end in ${ended.e.type}`;
      const said = cutText((cut) => `${what}: ${cut(JSON.stringify(ended.e), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(ended.e.type);
    }
    await speechEnds(ended, `turn ${step.id}: its speech's end`);
    await settle();
  }

  async function gateTurns(step, from, { settled = false } = {}) {
    if (!settled) await settle();
    let waited = false;
    for (const speech of gateSpeeches(host.events, from)) {
      if (await speechEnds(speech, `step ${step.id}: a gate-started turn's speech's end`)) waited = true;
    }
    const ending = step.retries ? /^inference:(exhausted|aborted)$/ : /^inference:(failed|exhausted|aborted)$/;
    const failed = eventAfter(from, (e) => ending.test(e.type));
    if (failed && !step.mayFail) {
      const said = cutText((cut) => `a turn the gate started ended in ${failed.e.type}: ${cut(JSON.stringify(failed.e), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(failed.e.type);
    }
    if (waited) await settle();
  }

  async function deliver(step) {
    const from = host.events.length;
    for (const m of step.messages) {
      const message = channelMessage({ channel: m.channel, topic: m.topic ?? step.topic }, m);
      const sent = host.events.length;
      log('send', { via: 'channel', message: sendSummary(message) });
      await ctl.deliver(message, { timeoutMs: TURN_MS, peer: peerOf(m.server) });
      if (m.held) await until(() => eventAfter(sent, (e) => e.type === 'admission:decided' && e.messageId === message.messageId && e.held), TURN_MS, `step ${step.id}: the host holding its message in ${m.channel} for a tune-out (admission:decided with a hold)`);
      else if (configuration.modules?.wake === false) await until(() => eventAfter(sent, (e) => e.type === 'admission:decided' && e.messageId === message.messageId), TURN_MS, `step ${step.id}: the host's admission of its message in ${m.channel}, with no gate to decide it`);
      else await until(() => eventAfter(sent, (e) => (e.type === 'gate:decision' || e.type === 'gate:suppressed') && e.channelId === m.channel), TURN_MS, `step ${step.id}: the gate's decision on its message in ${m.channel}, or its suppression`);
      if (m.offered) await until(() => eventAfter(sent, (e) => e.type === 'gate:onboarding-offered' && e.serverId === (m.server ?? 'fixture')), TURN_MS, `step ${step.id}: the wake onboarding offer its message brings`);
    }
    await gateTurns(step, from);
  }

  async function pushed(step) {
    const from = host.events.length;
    const event = {
      eventId: step.id,
      timestamp: new Date(clock).toISOString(),
      origin: { source: 'fixture', mcplChannelId: step.channel, channelId: step.channel, channelName: step.channel, messageId: step.id, authorId: authorId(step.participant), authorName: step.participant },
      ...(step.tags ? { tags: step.tags } : {}),
      payload: { content: [{ type: 'text', text: step.text }] },
    };
    log('send', { via: 'push', eventId: event.eventId, channel: step.channel, chars: step.text.length });
    await ctl.push(event, { timeoutMs: TURN_MS });
    await until(() => eventAfter(from, (e) => (e.type === 'gate:decision' || e.type === 'gate:suppressed') && e.eventType === 'mcpl:push-event' && e.serverId === 'fixture' && e.channelId === step.channel), TURN_MS, `step ${step.id}: the gate's decision on its push`);
    await gateTurns(step, from);
  }

  async function typed(step) {
    const from = host.events.length;
    const since = asked.length;
    log('send', { via: 'console', chars: step.text.length });
    send(host.sock, { type: 'text', content: step.text, from: 'console' });
    await until(() => eventAfter(from, (e) => e.type === 'gate:decision' && e.eventType === 'external-message' && e.serverId === 'cli'), TURN_MS, `step ${step.id}: the gate's decision on its console input`);
    if (step.named) await until(() => asked.slice(since).some((r) => r.kind === 'naming'), TURN_MS, `step ${step.id}: the session naming request its input brings`);
    await gateTurns(step, from);
  }

  async function file(step) {
    const from = host.events.length;
    const path = join(realpathSync(work), step.path);
    const noticed = notices.length;
    if (step.watched) await unlessFailed(ctl.expectStat(path));
    if (step.remove) rmSync(path, { force: true });
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, step.text); }
    log('send', { via: 'file', path: step.path, ...(step.remove ? { remove: true } : { chars: step.text.length }) });
    if (step.watched) {
      await until(() => notices.slice(noticed).some((n) => n.peer === 'clock' && n.notice === 'stat' && n.path === path), TURN_MS, `step ${step.id}: chokidar's settle poll of ${step.path}, a callback fs.stat of the written file (${chokidarVersion(hostDir)}); a chokidar that settles a write some other way sends none`);
      await moveClock(WRITE_SETTLE_MS);
      if (step.watched === 'settles') await until(() => eventAfter(from, (e) => e.type === 'process:completed' && String(e.processEvent?.type ?? '').startsWith('workspace:') && (e.processEvent.paths ?? []).includes(step.path)), TURN_MS, `step ${step.id}: the workspace's processing of ${step.path}'s change`);
      else await until(() => eventAfter(from, (e) => e.type === 'gate:decision' && String(e.eventType ?? '').startsWith('workspace:')), TURN_MS, `step ${step.id}: the gate's decision on ${step.path}'s change`);
    }
    await gateTurns(step, from);
  }

  async function command(step) {
    const name = /^\/(\S+)/.exec(step.command)?.[1];
    const ends = COMMANDS[name];
    if (!ends) {
      fail({ step: step.id, reason: `the driver doesn't know when ${JSON.stringify(step.command)} ends` });
      throw new RunFailure('unknown command');
    }
    // A canary in a command names the stored message that carries it, sent as that message's id (/branchto's), as a
    // panel step's `{ canary }` is; the record keeps the command as the step wrote it.
    let sent = step.command;
    for (const canary of new Set(step.command.match(/\[\[c:[^\]\s]+\]\]/g) ?? [])) sent = sent.replaceAll(canary, String((await stored({ canary })).id));
    const from = host.events.length;
    log('send', { via: 'ipc', command: step.command });
    send(host.sock, { type: 'command', command: sent });
    const lines = () => host.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    const outcome = await until(() => ends(lines()), COMMAND_MS, `command ${step.command}`);
    if (outcome !== (step.expect ?? 'done')) {
      const said = cutText((cut) => `${step.command} ${outcome}, where the step expects it ${step.expect ?? 'done'}: ${cut(lines().join(' | '), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(`command ${outcome}`);
    }
    await settle();
  }

  async function moveClock(ms, decision = null) {
    return moveClockTo(clock + ms, {
      advance: async (to) => {
        const { at, fired } = await unlessFailed(ctl.advance(to));
        log('advance', { from: clock, to: at, ...(fired ? { fired } : {}) });
        host.moves = (host.moves ?? 0) + 1;
        clock = at;
        standin.setClock(clock);
        return fired;
      },
      settle,
      decision,
    });
  }

  function decisionOf(step) {
    let timer;
    try { timer = decisionTimer(step, { configuration: recipeOf, facts }); } catch (e) {
      fail({ step: step.id, reason: `step ${step.id}: ${e.message}` });
      throw new RunFailure('no decision timer');
    }
    if (!timer) return null;
    return step.verdict
      ? { timer, what: `rule ${step.verdict}'s reply judge`, made: (e) => e.type === 'gate:judge-verdict' && e.policyName === step.verdict, waiting: `the reply judge's verdict on rule ${step.verdict}'s batch` }
      : { timer, what: 'the suppression review', made: (e) => e.type === 'gate:suppression-review', waiting: 'the suppression review\'s end' };
  }

  async function advance(step) {
    await settle();
    const from = host.events.length;
    const decision = decisionOf(step);
    const { decided } = await moveClock(step.ms, decision && {
      timer: decision.timer,
      made: () => until(() => eventAfter(from, decision.made), TURN_MS, `step ${step.id}: ${decision.waiting}`),
      turns: () => gateTurns(step, from),
    });
    if (decision && !decided) {
      fail({ step: step.id, reason: `step ${step.id}: the clock moved the step's ${step.ms} ms without firing the timer that starts ${decision.what} (${JSON.stringify(decision.timer)})` });
      throw new RunFailure('undecided');
    }
    await gateTurns(step, from, { settled: !decision });
  }

  async function health(id, what) {
    await settle();
    const corrId = `${id}:health`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op: 'health', corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `${what}: the health panel`)).e;
  }

  async function checkpoint(step, last) {
    log('checkpoint', { name: step.name, health: await health(step.id, `checkpoint ${step.id}`) });
    if (!step.copyStore) return;
    await shutdown();
    const dest = join(work, 'copies', step.name ?? step.id);
    rmSync(dest, { recursive: true, force: true });
    cpSync(storeDir, dest, { recursive: true });
    const sessions = existsSync(join(dest, 'sessions')) ? readdirSync(join(dest, 'sessions')).map((id) => join(dest, 'sessions', id)) : [];
    copies.push({ step: step.id, name: step.name, path: dest, sessions, clock });
    log('copy', { path: dest, sessions });
    if (!last) await boot(step.gapMs ?? RESTART_MS);
  }

  async function restart(step) {
    await settle();
    const agent = agentName;
    const dry = async () => ({ boot: host.n, seq: (await ctl.moduleRequest('dry-compile', { agent })).seq });
    const before = step.reloadCheck ? await dry() : null;
    const patch = step.agent ? await resolveMessages(step.agent) : null;
    await shutdown();
    if (patch) {
      const { strategy, ...rest } = patch;
      recipeOf = { ...recipeOf, agent: { ...recipeOf.agent, ...rest, ...(strategy ? { strategy: { ...recipeOf.agent?.strategy, ...strategy } } : {}) } };
      log('recipe', { agent: patch });
    }
    await boot();
    if (!step.reloadCheck) return;
    await settle();
    const after = await dry();
    await takeCompiles();
    log('reload', { agent, before, after });
  }

  async function moduleRead(op, params) {
    return unlessFailed(ctl.moduleRequest(op, params, { timeoutMs: COMMAND_MS }));
  }

  async function stored(which) {
    const messages = await moduleRead('messages', { agent: agentName });
    const all = messages?.messages ?? messages ?? [];
    let found;
    if (which.canary !== undefined) found = all.find((m) => (m.canaries ?? []).includes(which.canary));
    else {
      const from = Math.min(all.length - 1, Math.floor(all.length * which.storeAt));
      const plain = (m) => !m.bodyGroupId && m.metadata?.system !== true;
      found = all.slice(from).find((m) => plain(m) && (!which.withBlock || m.blocks.some((b) => b.type === which.withBlock)));
    }
    if (!found) {
      fail({ step: current?.id ?? null, reason: `no stored message is ${JSON.stringify(which)}` });
      throw new RunFailure('no such message');
    }
    return found;
  }

  let panelRequests = 0;
  async function panelRequest(op, params) {
    const corrId = `${current?.id ?? 'run'}:panel:${++panelRequests}`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op, params, corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `panel ${op}`)).e;
  }

  async function pinId(name) {
    const answer = await panelRequest('pins', {});
    const pin = (answer.data?.pins ?? []).find((p) => p.name === name);
    if (!pin) {
      fail({ step: current?.id ?? null, reason: `the panel lists no pin named ${JSON.stringify(name)}` });
      throw new RunFailure('no such pin');
    }
    return pin.id;
  }

  async function resolveMessages(value) {
    if (Array.isArray(value)) return Promise.all(value.map(resolveMessages));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'canary') return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'sequenceOf') return (await stored({ canary: value.sequenceOf })).sequence;
    if (keys.includes('storeAt') && keys.every((k) => k === 'storeAt' || k === 'withBlock')) return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'pin') return pinId(value.pin);
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveMessages(v)])));
  }

  async function panel(step) {
    const params = await resolveMessages(step.params ?? {});
    log('send', { via: 'panel', op: step.op, params });
    let answer = await panelRequest(step.op, params);
    log('panel', { op: step.op, response: answer });
    for (let attempt = 0; step.edge && answer.ok !== true && attempt < 4; attempt++) {
      const floor = /folded floor renders (\d+) tokens/.exec(String(answer.error ?? ''));
      if (!floor) break;
      const lowest = Math.ceil((Number(floor[1]) + step.edge.reserve) * 1.01 / 1000) * 1000;
      log('send', { via: 'panel', op: step.op, params: { ...params, contextBudgetTokens: lowest }, edge: Number(floor[1]) });
      answer = await panelRequest(step.op, { ...params, contextBudgetTokens: lowest });
      log('panel', { op: step.op, response: answer });
    }
    const expected = (step.expect ?? 'ok') === 'ok';
    const ok = answer.ok === true && answer.data?.warning === undefined;
    if (ok !== expected) {
      fail({ step: step.id, reason: `the panel's ${step.op} answered ${ok ? 'ok' : `not ok (${answer.data?.warning ?? answer.error ?? answer.status ?? 'no reason given'})`}, where the step expects ${step.expect ?? 'ok'}` });
      throw new RunFailure('panel');
    }
    await settle();
  }

  async function webui() {
    if (host.webui) return host.webui;
    const line = host.out.join('').match(WEBUI_LISTENING);
    if (!line) throw new RunFailure(`the host logged no "[webui] listening on" line, so the web UI isn't on in this recipe`);
    host.webui = await unlessFailed(openWebUi({ url: line[1], basicAuth: configuration.modules?.webui?.basicAuth ?? null, timeoutMs: COMMAND_MS }));
    return host.webui;
  }

  const fromHeld = (messages, request) => messages.map((m) => {
    if (!m || typeof m !== 'object' || !('fromHeld' in m)) return m;
    const canary = request?.canaries?.at(m.fromHeld);
    if (canary === undefined) {
      fail({ step: current?.id ?? null, reason: `no held request's slice gives a canary at ${m.fromHeld} (${request ? `${request.id}'s slice carries ${request.canaries?.length ?? 0}` : 'nothing is held'})` });
      throw new RunFailure('no such held canary');
    }
    return { canary };
  });

  let suppressions = 0;
  async function suppress(step) {
    const messageIds = await resolveMessages(step.messages);
    const ui = await webui();
    const corrId = `${step.id}:suppress:${++suppressions}`;
    log('send', { via: 'webui', op: 'suppress', messageIds });
    ui.send({ type: 'suppress', messageIds, sessionId: ui.welcome.session.id, corrId });
    const result = await unlessFailed(ui.next((m) => m.type === 'surgery-result' && m.corrId === corrId, { label: `the suppress result for ${corrId}` }));
    log('suppress', { result });
    if (result.ok !== true) {
      const said = cutText((cut) => `the web UI's suppress failed: ${result.error ?? cut(JSON.stringify(result), 500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure('suppress');
    }
    await settle();
  }

  async function hostCommand(step) {
    const from = host.events.length;
    log('send', { via: 'fixture', host: step.host });
    const answer = await unlessFailed(ctl.hostCommand(step.host, { timeoutMs: COMMAND_MS }));
    log('host', { answer });
    if (answer?.ok !== true) {
      const said = cutText((cut) => `the host answered ${step.host.command} with ${cut(JSON.stringify(answer), 500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(`host command ${step.host.command}`);
    }
    await until(() => eventAfter(from, (e) => e.agentName === agentName && e.type === 'inference:started'), TURN_MS, `step ${step.id}: the turn ${step.host.command} starts`);
    await gateTurns(step, from);
  }

  let configWatch;
  const watchOfConfig = (where) => {
    if (configWatch === undefined) { try { configWatch = configWatched({ hostDir, configuration }); } catch (e) { configWatch = e; } }
    if (configWatch instanceof Error) throw new RunFailure(`${where}: ${configWatch.message}`);
    return configWatch;
  };
  const unowed = (where, events, owed) => {
    const left = unowedConfigEchoes(events, owed);
    if (left.length) throw new RunFailure(`${where}: the workspace reported ${left.join(', ')} in the watched _config mount, which no traced gate write in it and no first boot's start owes, so it landed wherever real time put it`);
  };
  const judgedNow = (h) => { h.judged = h.events.length; h.judgedMoves = h.moves ?? 0; };
  const recipeWorkspace = () => typeof recipeOf.modules?.workspace === 'object' && recipeOf.modules.workspace !== null;
  async function configEcho(step) {
    let current = null;
    for (const w of echoWindows({ host, stepHost })) {
      if (w.host === host) { current = w; continue; }
      unowed(`step ${step.id}`, w.host.events.slice(w.from).map(({ e }) => e));
      judgedNow(w.host);
    }
    if (!current) return;
    const { from } = current;
    const events = () => host.events.slice(from).map(({ e }) => e);
    const echo = () => configWriteEcho(events());
    const write = echo();
    const watch = write.wrote && recipeWorkspace() ? watchOfConfig(`step ${step.id}`) : null;
    if (watch) {
      if (movedSinceJudged(host)) throw new RunFailure(`step ${step.id}: the driver moved the clock in a step whose host traced a gate write to ${write.path}, and a move is what lets chokidar settle such a write, so its echo would land wherever real time put it among what the move brings; a gate-writing step moves the clock only by the write's own settle`);
      let owed;
      try { owed = echoOwed(write.file, watch.include); } catch (e) { throw new RunFailure(`step ${step.id}: ${e.message}`); }
      if (owed && !write.echoed) {
        const noticed = notices.length;
        await unlessFailed(ctl.expectStat(write.file));
        await until(() => notices.slice(noticed).some((n) => n.peer === 'clock' && n.notice === 'stat' && n.path === write.file), TURN_MS, `step ${step.id}: chokidar's settle poll of ${write.path}, a callback fs.stat of ${write.file} (${chokidarVersion(hostDir)}); a chokidar that settles a write some other way sends none`);
        await moveClock(WRITE_SETTLE_MS);
        await until(() => echo().echoed, TURN_MS, `step ${step.id}: the workspace's change for ${write.path} once chokidar has settled the gate's write to it, processed`);
        await settle();
      }
    }
    unowed(`step ${step.id}`, events());
    judgedNow(host);
  }

  function configEnd() {
    for (const w of echoWindows({ host })) {
      unowed('the run\'s end', w.host.events.slice(w.from).map(({ e }) => e));
      judgedNow(w.host);
    }
  }

  async function configBootEcho(b, fresh) {
    const events = () => b.events.map(({ e }) => e);
    let owed = [];
    if (fresh && recipeWorkspace()) {
      const watch = watchOfConfig(`boot ${b.n}`);
      if (watch) {
        const mounted = await until(() => events().find((e) => e.type === 'process:received' && e.processEvent?.type === 'workspace:mounted' && e.processEvent.mount === '_config'), TURN_MS, `boot ${b.n}: the workspace's mount of _config`);
        let listing;
        try { listing = readdirSync(mounted.processEvent.path); } catch (e) { throw new RunFailure(`boot ${b.n}: couldn't list the _config mount's directory ${mounted.processEvent.path}: ${e.message}`); }
        try { owed = bootEchoesOwed(listing, watch.include); } catch (e) { throw new RunFailure(`boot ${b.n}: ${e.message}`); }
        if (owed.length) {
          await until(() => owed.every((p) => events().some((e) => echoDone(e, p))), TURN_MS, `boot ${b.n}: the workspace's catch-up of ${owed.join(', ')}, which the gate's start left in the watched _config mount, processed`);
          await settle();
        }
      }
    }
    unowed(`boot ${b.n}`, events(), owed);
    judgedNow(b);
  }

  const absent = async (step) => log('absent', { stretch: step.stretch });
  const KINDS = { channel: channelTurn, deliver, push: pushed, console: typed, file, command, advance, restart, panel, suppress, absent, host: hostCommand };
  try {
    await boot();
    for (const [i, step] of steps.entries()) {
      current = step;
      stepFrom = host.events.length;
      stepHost = host;
      readerHolds = [];
      standin.setStep(step);
      const started = performance.now();
      if (step.kind === 'checkpoint') await checkpoint(step, i === steps.length - 1);
      else if (KINDS[step.kind]) await KINDS[step.kind](step);
      else { fail({ step: step.id, reason: `the driver has no step kind ${JSON.stringify(step.kind)}` }); throw new RunFailure('unknown kind'); }
      const many = host && readerHolds.map((r) => subagentResult(host.events, r, stepFrom)).find((v) => typeof v === 'string');
      if (many) { fail({ step: step.id, reason: `step ${step.id}: ${many}` }); throw new RunFailure('reader forks'); }
      await configEcho(step);
      // A fork of `conversations` is made at its channel's first message, after the boot's `/budget`, which lists every
      // agent there is (commands.ts handleBudget), so a run that judges a fork reads its bound again after each step.
      if (configuration.judges === 'fork' && host) await budgetReport(host, { fork: true });
      for (const read of step.reads ?? []) {
        const { op, ...params } = typeof read === 'string' ? { op: read } : read;
        log('read', { op, ...(Object.keys(params).length ? { params } : {}), answer: await moduleRead(op, { agent: agentName, ...params }) });
      }
      timing.steps.push({ id: step.id, kind: step.kind, ms: Math.round(performance.now() - started) });
    }
    if (host) {
      log('health', { name: 'end', health: await health('end', 'the run\'s end') });
      configEnd();
    } else log('health', { name: 'end', skipped: 'the run\'s last step stopped its host' });
  } catch (e) {
    const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 3000));
    if (!failure) fail({ step: current?.id ?? null, reason: c.shown, ...(c.full ? { full: c.full } : {}) });
    if (host) log('host-output', { boot: host.n, hostLog: hostLogOf(host), tail: tail(host.out) });
  } finally {
    await shutdown();
    await ctl.close();
    ended = true;
    log('end', { ok: !failure, clockEnd: clock });
  }
  return { ok: !failure, failure, clockEnd: clock, copies, timing, signalled, ...(reach ? { reads } : {}) };
}

const tail = (out) => out.join('').split('\n').slice(-30).join('\n');
