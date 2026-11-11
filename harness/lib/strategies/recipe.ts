import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindsThinking } from '../standin/anthropic.ts';
import { actsOf } from './events.ts';
import type { FleetChild } from './fleet.ts';
import type { Agent, Step } from './script.ts';
import type { Configuration } from '../workloads/workloads.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcpl-server.ts');
export const PRELOAD = join(HERE, 'virtual-date.ts');
const MODULE = join(HERE, 'module.ts');

type Block = { [field: string]: unknown };
export type RecipeAgent = Agent & { name: string; provider: string; systemPrompt: string; baseUrl?: string };
export type Recipe = {
  name: string;
  agent: RecipeAgent;
  maintenanceIntervalMs?: number;
  mcpServers: { [server: string]: { command: string; args: string[]; env: { [name: string]: string }; enabledFeatureSets: string[]; allowHostCommands?: boolean; [field: string]: unknown } };
  modules: { [module: string]: boolean | Block };
  extensions: { [extension: string]: { kind: string; path: string } };
  subconscious?: Block;
  [field: string]: unknown;
};

export function hostEnv({ configuration, standinUrl, control, clock, runDir = null, tunedOut = [] }: { configuration: Configuration; standinUrl: string; control: string; clock: number; runDir?: string | null; tunedOut?: Array<[string, unknown]> }) {
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

export const BASE_AGENT = { name: 'fixture', provider: 'anthropic', systemPrompt: 'You are the strategy fixture\'s agent.' };

// The events a fleet child sends its parent: `lifecycle`, which fleet--await requires, and `inference:speech`, which
// fleet--relay requires (connectome-host fleet-module.ts, each tool's description).
export const FLEET_SUBSCRIPTION = ['lifecycle', 'inference:speech'];

// An `openai-compatible` recipe names its endpoint itself (`agent.baseUrl`), so the stand-in's goes into the recipe,
// at the path of OpenAI's own Chat Completions, which the stand-in serves at `/v1`.
export function laneRecipe({ configuration, control, channels, boot, servers = {}, standinUrl = null, work = null, fleet = [] }: { configuration: Configuration; control: string; channels: string[]; boot: number; servers?: Record<string, string[]>; standinUrl?: string | null; work?: string | null; fleet?: FleetChild[] }): Recipe {
  const presentation = configuration.agent?.toolPresentation;
  const agent = {
    ...BASE_AGENT, ...configuration.agent,
    ...(configuration.agent?.provider === 'openai-compatible' && standinUrl ? { baseUrl: `${standinUrl}/v1` } : {}),
    ...(presentation && work ? { toolPresentation: { ...presentation, path: resolve(work, presentation.path) } } : {}),
  };
  const kept = configuration.fixtureLifecycle === false ? Object.entries(configuration.fixtureChannels ?? {}).filter(([, kind]) => Object.keys(kind).length) : [];
  if (kept.length) throw new Error(`${configuration.name}'s fixtureLifecycle false gives the fixture server no channel kinds, so it can't keep ${kept.map(([id]) => id).join(', ')}'s ${[...new Set(kept.flatMap(([, kind]) => Object.keys(kind)))].join(' and ')}, which the server reads only from its kinds`);
  const env = (peerChannels: string[]) => ({ FIXTURE_CONTROL: control, FIXTURE_CHANNELS: peerChannels.join(','), FIXTURE_BOOT: String(boot) });
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
    modules: {
      subagents: false, lessons: false, retrieval: false, ...configuration.modules,
      ...(fleet.length ? { fleet: { children: fleet.map((f) => ({ name: f.name, recipe: f.recipePath, dataDir: f.dataDir, autoStart: true, subscription: FLEET_SUBSCRIPTION, env: f.env })) } } : {}),
    },
    extensions: { 'whole-host-harness': { kind: 'module', path: MODULE } },
    ...(configuration.subconscious ? { subconscious: configuration.subconscious } : {}),
  };
}

export function fixtureChannels(steps: Step[], configuration: Configuration) {
  const channelsOf = (server: string) => [...new Set(steps.flatMap((s) => (s.kind === 'channel' && server === 'fixture' ? [s.channel!, ...actsOf(s).flatMap((a) => (a.deliver?.channel ? [a.deliver.channel] : []))] : s.kind === 'deliver' ? s.messages!.filter((m) => (m.server ?? 'fixture') === server).map((m) => m.channel!) : [])))];
  return {
    channels: [...new Set([...Object.keys(configuration.fixtureChannels ?? {}), ...channelsOf('fixture')])],
    servers: Object.fromEntries([...new Set(steps.flatMap((s) => (s.kind === 'deliver' ? s.messages!.map((m) => m.server ?? 'fixture') : [])))].filter((n) => n !== 'fixture').map((n) => [n, channelsOf(n)])),
  };
}
