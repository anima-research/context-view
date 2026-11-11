// @ts-nocheck
import { turnsOf } from './checks.ts';
import { prose, seeded } from './prose.ts';
import type { RequestRecord } from '../standin/standin.ts';
import type { Message } from '../standin/view.ts';
import type { Store } from './read-store.ts';
import type { Configuration } from '../workloads/workloads.ts';

export type Delivered = { id: string; participant: string; text: string; channel?: string; tags?: string[] };
export type Pushed = { id: string; channel: string; participant: string; text: string; tags?: string[] };
type ActKinds = {
  deliver: { deliver: Delivered };
  push: { push: Pushed };
  console: { console: { id: string; text: string } };
  agentEnd: { agentEnd: string | { prefix: string } };
  remove: { remove: { messages: Array<{ fromHeld: number }> } };
  advance: { advance: number; cut?: true | 'ends' };
  asked: { asked: string; n?: number };
  budgetHeld: { budgetHeld: true };
  ended: { ended: string };
};
type ActField = { [K in keyof ActKinds]: keyof ActKinds[K] }[keyof ActKinds];
export type Act = { [K in keyof ActKinds]: ActKinds[K] & { [F in Exclude<ActField, keyof ActKinds[K]>]?: undefined } }[keyof ActKinds];
type CallInput = { canary?: string; [field: string]: unknown };
export type Call = { name: string; id?: string } & ({ input?: CallInput; during?: undefined } | { input: CallInput; during: Act[] });
export type Reply = {
  text?: string;
  calls?: Call[] | ((messages: Message[]) => Call[]);
  during?: Act[];
  error?: { status: number; type?: string; message?: string; headers?: Record<string, string> };
  stop?: string;
  cut?: boolean;
  [field: string]: unknown;
};
export type Step = {
  id: string;
  segment?: string;
  kind?: string;
  op?: string;
  command?: string;
  replies?: Reply[];
  subs?: Array<{ as?: string; replies?: Reply[]; [field: string]: unknown }>;
  inputs?: string[];
  ends?: 'contained' | 'unspoken';
  mayFail?: boolean;
  retries?: boolean;
  addressed?: boolean;
  failsPublish?: boolean;
  drafts?: 'no-destination' | 'explicit-send' | 'bounced';
  tunedOut?: string[];
  undoes?: string[];
  sheds?: string[];
  channel?: string;
  messages?: Array<{ canary?: string; channel?: string; server?: string; [field: string]: unknown }>;
  reader?: { prefix: string; name?: undefined } | { name: string; prefix?: undefined };
  summariserHold?: { level: number; during: Act[] };
  awaits?: { events: Array<{ type: string; kind?: string }>; what: string };
  [field: string]: unknown;
};
export type Product =
  | { name: string; test: (record: RequestRecord, mine: RequestRecord[]) => unknown; fromStore?: undefined }
  | { name: string; fromStore: (store: Store) => unknown; test?: undefined };
export type Products = Record<string, Product[]> | never[];
type Block = { [field: string]: unknown };
export type ChannelKind = { direction?: string; initiallyOpen?: boolean };
export type Agent = {
  model: string;
  name?: string;
  provider?: string;
  formatter?: string;
  maxStreamTokens?: number;
  toolPresentation?: { path: string; cataloguePath?: string };
  strategy?: Block;
  [field: string]: unknown;
};
export type Setup = {
  name: string;
  agent: Agent;
  modules?: { [module: string]: boolean | Block };
  subconscious?: Block;
  recipe?: Block;
  judges?: string;
  files?: Record<string, string>;
  dirs?: string[];
  maintenanceIntervalMs: number;
  summarises: boolean;
  thinks?: boolean;
  fleet?: Array<{ name: string }>;
  fixtureChannels?: Record<string, ChannelKind>;
  fixtureLifecycle?: boolean;
  fixturePush?: boolean;
  gated?: Record<string, Partial<Omit<Setup, 'name' | 'gated'>>>;
  windowTokens?: number;
  sendsReasoning?: boolean;
  textOnlyResults?: boolean;
  buildsHistory?: boolean;
  thinkingWrappedSummaries?: boolean;
};

export const TOOL = 'mcpl--fixture--result';
export const CHANNEL = 'chat';
export const READER = '[[reader]]';
export const INSTRUCTIONS = 'The strategy fixture\'s instructions: answer each message in the channel it came from.\n';
const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
const MINUTE = 60_000;

export function configurations(): Record<string, Setup> {
  const agent = { model: 'claude-opus-4-6', cacheKeepalive: { enabled: false } };
  const run = (name, more, summarises = true) => ({ name, agent: { ...agent, ...more.agent }, ...(more.modules ? { modules: more.modules } : {}), ...(more.subconscious ? { subconscious: more.subconscious } : {}), ...(more.recipe ? { recipe: more.recipe } : {}), ...(more.judges ? { judges: more.judges } : {}), ...(more.files ? { files: more.files } : {}), ...(more.dirs ? { dirs: more.dirs } : {}), maintenanceIntervalMs: 0, summarises });
  return {
    H1: run('H1', {}),
    H1b: { ...run('H1b', { agent: { model: 'claude-opus-5-5' } }), thinks: true },
    H1c: run('H1c', { agent: { strategy: { compressionModel: 'claude-opus-5-5', carrierPolicy: 'live-strip', maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 0 } } }),
    H1d: run('H1d', { agent: { strategy: { compressionModel: 'claude-opus-5-5' } } }),
    H1r: run('H1r', { agent: { refusalHandling: { autoRewind: true } } }),
    Hfleet: { ...run('Hfleet', { agent: { refusalHandling: { retries: 1 } } }), fleet: [{ name: 'src' }, { name: 'dst' }] },
    H2: run('H2', { modules: { subagents: true }, judges: 'subagent' }),
    H3: run('H3', { agent: { strategy: { type: 'passthrough' } } }, false),
    H4: run('H4', { subconscious: { enabled: true, systemPrompt: `${READER} You read what the resident has tuned out, and tell them what matters.` } }),
    H4t: { ...run('H4t', { agent: { model: 'claude-opus-5-5' }, subconscious: { enabled: true, systemPrompt: `${READER} You read what the resident has tuned out, and tell them what matters.` } }), thinks: true },
    H4b: run('H4b', { subconscious: { enabled: true, reader: 'forks', model: agent.model, voice: `${READER} You read what the resident has tuned out, and tell them what matters.` } }),
    H5: { ...run('H5', merged(H5_PARTS, { recipe: { toolResultInlineMaxChars: 10_000 } })), fixtureChannels: { 'w12-pair-in': { direction: 'inbound' } } },
    H5b: run('H5b', merged(H5_PARTS, {
      agent: { maxStreamTokens: 200_000 },
      recipe: { dendrite: { announceOrphans: false } },
      modules: {
        instructions: { position: 'beforeUser', header: '# The strategy fixture\'s instructions, in H5b', maxBytes: 40 },
        subagents: { orientation: 'none', lifecycleReach: 'all' },
        heartbeat: { defaults: { intervalSeconds: 5400, deliveryMode: 'silent' } },
        wake: { judge: { onError: 'skip', effort: 'medium', cacheTtl: '1h', maxInputTokens: 4000 } },
        notices: { kinds: { 'instructions-unavailable': 'status' }, statusChannels: ['w12-status'] },
        workspace: {
          mounts: [
            { name: 'input', path: './input', mode: 'read-only' },
            { name: 'products', path: './output', mode: 'read-write', backend: 'direct' },
            { name: 'instructions', path: './instructions', mode: 'read-only' },
            { name: 'watched', path: './watched', watch: 'on-agent-action', wakeOnChange: true },
          ],
          configMount: true,
        },
      },
    })),
    H5c: { ...run('H5c', merged(H5_PARTS, {
      agent: { contextBudgetTokens: null },
      modules: {
        instructions: { position: 'afterUser' },
        heartbeat: { defaults: { intervalSeconds: 5400, paused: true } },
        wake: { judge: { enabled: false } },
        notices: { kinds: { 'instructions-unavailable': 'silent' } },
        workspace: {
          mounts: [
            { name: 'input', path: './input', mode: 'read-only' },
            { name: 'products', path: './output', autoMaterialize: true },
            { name: 'instructions', path: './instructions', mode: 'read-only' },
            { name: 'watched', path: './watched', watch: 'always', wakeOnChange: ['deleted'] },
          ],
          configMount: true,
        },
      },
    })), fixtureLifecycle: false },
    Hoff: run('Hoff', { modules: { wake: false, workspace: false, channelMode: false, subscriptionGc: false } }),
    Hcont: run('Hcont', { agent: { autoContinue: true } }),
    Hlatest: { ...run('Hlatest', { recipe: { speech: { locus: 'latest-inbound' } } }), fixturePush: true, fixtureChannels: { 'w13-push': { initiallyOpen: false }, 'w13-feed': { direction: 'inbound' } } },
    // `conversations` is deprecated, and agent-framework#235 removes it.
    Hconv: { ...run('Hconv', {}), gated: { conversations: { recipe: { conversations: { bind: { channel: 'always' }, trigger: { channel: 'always' } } }, judges: 'fork' } } },
    Hexpl: run('Hexpl', { agent: { proseRouting: 'explicit' } }),
    Hhyb: run('Hhyb', { agent: { proseRouting: 'hybrid' } }),
    Hdis: run('Hdis', { agent: { proseRouting: 'disabled' } }),
    Hlock: run('Hlock', { agent: { proseRouting: 'locked' } }),
    Hpriv: run('Hpriv', { agent: { sameRoundThinkTextPolicy: 'private' } }),
    Hretry: run('Hretry', { agent: { retry: { retryDelayMs: 1, overloaded: { maxRetries: 2, retryDelayMs: 2 } } } }),
    Hfold: run('Hfold', { agent: { refusalHandling: { retries: 1 }, toolWrapperProseGuard: true }, recipe: { inferenceBounds: false } }),
    H6: run('H6', { agent: { model: 'claude-haiku-4-5-20251001', formatter: 'anthropic-xml', prefillUserMessage: 'The strategy fixture\'s transcript follows.' } }),
    H7: { ...run('H7', {
      agent: {
        toolPresentation: { path: 'tool-presentation.json', cataloguePath: 'products/tool-catalogue.md' },
        clock: false,
        promptCaching: false,
        thinking: { enabled: true, type: 'enabled', budgetTokens: 2048, display: 'summarized', effort: 'medium' },
      },
      files: { 'tool-presentation.json': `${JSON.stringify({ version: 1, tools: { 'time--now': { description: 'The strategy fixture\'s presentation of the clock tool.' }, 'workspace--glob': { visible: false } } })}\n` },
    }), thinks: true },
    C9h: { ...run('C9h', {
      agent: {
        strategy: {
          type: 'frontdesk',
          identityReminder: 'You are the strategy fixture\'s agent, fixture: what Ash, Tavy and Wren said is theirs.',
          identityReminderSilent: true,
          summaryParticipant: 'fixture-memory',
          summarySystemPrompt: 'The strategy fixture\'s summary system prompt.',
          summaryUserPrompt: 'The strategy fixture\'s summary user prompt.',
          summaryContextLabel: 'The strategy fixture\'s memory of what came before follows.',
          recoverLiteralThinkingWrappedCompression: true,
        },
      },
    }), thinkingWrappedSummaries: true },
    C11h: run('C11h', { agent: { strategy: { kvUnified: kvUnified({ engine: 'dag', latentDemandMode: 'individual', preserveGapBearingSummaries: true }) } } }),
    C12h: run('C12h', { agent: { strategy: { adaptiveResolution: false, recallHeaderTemplate: '[Recall L{level} {id}, {first} to {last}{tools}]' } } }),
    C20h: run('C20h', { agent: { strategy: { adaptiveResolution: false, positionedRecallPairs: false } } }),
    C18h: run('C18h', { agent: { strategy: { mergeThreshold: 2 } } }),
    C13h: run('C13h', { agent: { strategy: { mergeThreshold: 2, speculativeProduction: false } } }),
    C19h: run('C19h', { agent: { strategy: { mergeThreshold: 0 } } }),
    C21h: run('C21h', { agent: { strategy: { toolResultMaxLastN: 1, toolUseInputMaxTokens: 1 } } }),
    C23h: run('C23h', { agent: { strategy: { maxSpeculativeL1s: 2 } } }),
    C14h: run('C14h', { agent: { strategy: { compressionSourceOnly: true, compressionMergeSourceOnly: true } } }),
    C15h: run('C15h', { agent: { strategy: { compressionToolProseFallback: { intoTool: 'journal', fromTools: ['result'], minChars: 8 } } } }),
    C16h: run('C16h', { agent: { strategy: { compressionSourceOnlyFallback: true, compressionSplitFallback: true, compressionSplitPlaceholder: true, compressionRefusalCurveFallbacks: 0 } } }),
    C17h: run('C17h', { agent: { strategy: { compressionSourceOnlyFallback: true, compressionMergeSourceOnlyFallback: true } } }),
    C3h: run('C3h', { agent: { strategy: { adaptiveResolution: false } } }),
    C5h: run('C5h', { agent: { strategy: { foldingStrategy: 'flat-profile' } } }),
    C6h: run('C6h', { agent: { strategy: { foldingStrategy: 'kv-stable' } } }),
    C8h: run('C8h', { agent: { strategy: { foldingStrategy: 'oldest-first' } } }),
    // H1 on Bedrock, by the US geo inference id AWS's Claude Opus 4.6 model card gives, with its 1M-token context
    // window (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-6.html, read
    // Nov 7 2026). membrane passes an id in that form through as it is (bedrock.ts, toBedrockModelId).
    P3: { ...run('P3', { agent: { provider: 'bedrock', model: 'us.anthropic.claude-opus-4-6-v1' } }), windowTokens: 1_000_000 },
    P1: { ...run('P1', { agent: { provider: 'openai-responses', model: 'gpt-6.1-sol', responses: { reasoningEffort: 'medium', reasoningContext: 'current_turn', serviceTier: 'flex', compactThreshold: 150_000 } } }), windowTokens: 922_000, thinks: true },
    P2: { ...run('P2', { agent: { provider: 'openai-codex', model: 'gpt-6.1-sol', responses: { reasoningEffort: 'medium', reasoningContext: 'current_turn' }, codex: { fastMode: true } } }), windowTokens: 872_000, thinks: true },
    // H1 through OpenRouter, on the one model its dialect serves. membrane 0.8.0's OpenRouterAdapter reads no reasoning,
    // so a reply's thinking never comes back, and sends a tool message's content through textOnlyToolResultContent
    // (openrouter.js), so an image goes as its text. The fixed release can't send OpenRouter requests to the stand-in
    // (its adapter takes no base URL), so P4's run builds its own history (`buildsHistory`, workloads.ts runOf).
    P4: { ...run('P4', { agent: { provider: 'openrouter', model: 'anthropic/claude-opus-4.6' } }), windowTokens: 1_000_000, sendsReasoning: false, textOnlyResults: true, buildsHistory: true },
    // OpenAI's Chat Completions sends no reasoning, so a reply's thinking never comes back in a later request, and a
    // tool message carries text only ("For tool messages, only type `text` is supported"), so membrane's adapter sends
    // its own text in an image's place (textOnlyToolResultContent).
    P5: { ...run('P5', { agent: { provider: 'openai-compatible', model: 'gpt-5.6-sol' } }), windowTokens: 922_000, thinks: true, sendsReasoning: false, textOnlyResults: true },
  };
}

const H5_PARTS = {
  agent: { timezone: 'Asia/Kathmandu', cacheTtl: '5m', clock: { intervalSeconds: 30, precision: 'seconds' }, anthropicBetas: ['token-efficient-tools-2025-02-19'], maxTokens: 12_000, contextBudgetTokens: 400_000 },
  recipe: { codeExecution: { enabled: true } },
  modules: {
    subagents: true, lessons: true, retrieval: true, history: true, activity: true, identity: true, mcplAdmin: true, selfRestart: true, fleet: true, instructions: true,
    heartbeat: { defaults: { intervalSeconds: 5400 } },
    workspace: {
      mounts: [
        { name: 'input', path: './input', mode: 'read-only' },
        { name: 'products', path: './output' },
        { name: 'instructions', path: './instructions', mode: 'read-only' },
        { name: 'watched', path: './watched', watch: 'always', wakeOnChange: true },
      ],
      configMount: true,
    },
    notices: { kinds: { 'instructions-unavailable': 'reply' } },
    channelMode: { serverId: 'fixture' },
    subscriptionGc: { serverId: 'fixture' },
  },
  files: { 'instructions/AGENTS.md': INSTRUCTIONS },
  dirs: ['input', 'output', 'watched'],
};

function merged(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merged(a[k], v) : v;
  return out;
}

// connectome-host's standard kv-unified block for Claude Opus 4.6 on Anthropic's API with the 1-hour cache
// (framework-strategy.ts standardKvUnifiedConfig, at a34d39011: anthropicCacheReadMultiplier 0.1, a 1-hour write 2),
// written out, as a recipe that names `kvUnified` must write it whole.
function kvUnified(more) {
  return {
    policy: {
      alpha: 0.7, budgetLowRatio: 0.6, budgetHighRatio: 0.85, budgetUnderLambda: 1_000, budgetOverLambda: 4_000,
      cacheLambda: 1, cacheScale: 100_000, cacheReadPrice: 0.1, cacheWritePrice: 2,
      continuityLambda: 1, continuityScale: 100_000, continuityRecencyHalfLifeTokens: 100_000, continuityRecencyFloor: 0.2, continuityStableHalfLife: 16, continuityStableFloor: 0.25,
    },
    tokenBucketSize: 50_000, continuityBucketSize: 50_000, fidelityBucketSize: 100_000, labelCeiling: 100_000, adoptEpsilon: 3_000,
    treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false, hysteresisCertificate: true,
    ...more,
  };
}

const canary = (id, part) => `[[c:${id}.${part}]]`;

const LONG_ID = JSON.rawJSON('1234567890123456789');
const LONG_NEGATIVE = JSON.rawJSON('-2345678901234567891');

function turn(id, segment, { chars, replyChars = 2400, calls = [], rounds = null, thinking = null, more = {} }) {
  const r = seeded(`${id}:sizes`);
  const input = `${canary(id, 'in')} ${prose(chars, `${id}:in`)}`;
  const replies = [];
  const canaries = [canary(id, 'in')];
  const allRounds = rounds ?? (calls.length ? [calls] : []);
  if (allRounds.length || thinking) {
    let k = 0;
    allRounds.forEach((roundCalls, i) => {
      const reply = { text: `${canary(id, `r${i + 1}`)} ${prose(1200 + 15 * Math.floor(r() * 80), `${id}:r${i + 1}`)}` };
      if (thinking && i === 0) reply.thinking = prose(thinking, `${id}:think`);
      reply.calls = roundCalls.map((c) => {
        const callCanary = canary(id, `call${++k}`);
        canaries.push(callCanary);
        return { name: TOOL, input: { ...c, canary: callCanary } };
      });
      replies.push(reply);
    });
    const last = allRounds.length + 1;
    replies.push({ text: `${canary(id, `r${last}`)} ${prose(replyChars, `${id}:r${last}`)}` });
  } else {
    replies.push({ text: `${canary(id, 'r1')} ${prose(replyChars, `${id}:r1`)}` });
  }
  const participant = PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)];
  return { id, segment, kind: 'channel', channel: CHANNEL, participant, topic: segment, text: input, canaries, replies, ...more };
}

const advance = (id, segment, ms) => ({ id, segment, kind: 'advance', ms });
const checkpoint = (id, segment, more = {}) => ({ id, segment, kind: 'checkpoint', name: segment, ...more });

export const L3_PRODUCT = 'an L3 merge request';

export function prefix(turns, { promptChanged = false } = {}) {
  const steps = [{ id: 'p.name', segment: 'prefix', kind: 'command', command: '/session rename fixture' }];
  for (let i = 1; i <= turns; i++) {
    const id = `p.${i}`;
    const r = seeded(id);
    steps.push(advance(`${id}.adv`, 'prefix', 4 * MINUTE));
    if (i === 1) steps.push(turn(id, 'prefix', { chars: 2250, replyChars: 1800 }));
    else if (i % 17 === 0) steps.push(turn(id, 'prefix', { chars: 90_000 }));
    else if (i % 13 === 0) steps.push(turn(id, 'prefix', { chars: 4500, calls: [{ kind: 'json', size: 9000 }, { kind: 'prose', size: 13_500 }, { kind: 'code', size: 10_500 }] }));
    else if (i % 11 === 0) steps.push(turn(id, 'prefix', { chars: 4500, thinking: 6000, calls: [{ kind: 'prose', size: 12_000 }] }));
    else if (i % 7 === 0) steps.push(turn(id, 'prefix', { chars: 3750, calls: [{ kind: 'prose', size: 18_000 }] }));
    else steps.push(turn(id, 'prefix', { chars: 1800 + 15 * Math.floor(r() * 900), replyChars: 1200 + 15 * Math.floor(r() * 500) }));
  }
  if (promptChanged) {
    const at = steps.findLastIndex((st) => (st.replies ?? []).some((reply) => reply.thinking));
    steps.splice(at + 1, 0, { id: 'p.prompt', segment: 'prefix', kind: 'restart', agent: { systemPrompt: 'You are the strategy fixture\'s agent, with a prompt an operator changed.' } });
  }
  steps.push(checkpoint('p.end', 'prefix', { copyStore: true }));
  return steps;
}

export function continuation(configuration = {}) {
  const steps = [{ id: 'c.name', segment: 'name', kind: 'command', command: '/session rename fixture' }];
  const seg = (name, list) => { steps.push(...list, checkpoint(`c.${name}.cp`, name)); };
  seg('close-merge', [
    advance('c.cm.1.adv', 'close-merge', 4 * MINUTE), turn('c.cm.1', 'close-merge', { chars: 10_500, replyChars: 6000 }),
    advance('c.cm.2.adv', 'close-merge', 4 * MINUTE), turn('c.cm.2', 'close-merge', { chars: 90_000, replyChars: 4500 }),
    advance('c.cm.3.adv', 'close-merge', 4 * MINUTE), turn('c.cm.3', 'close-merge', { chars: 13_500, replyChars: 7500 }),
    advance('c.cm.4.adv', 'close-merge', 4 * MINUTE), turn('c.cm.4', 'close-merge', { chars: 9000, replyChars: 4500 }),
  ]);
  seg('tool-round', [
    advance('c.tool.adv', 'tool-round', 4 * MINUTE),
    turn('c.tool', 'tool-round', { chars: 3750, calls: [
      { kind: 'prose', size: 18_000, channel: { id: LONG_ID, before: LONG_NEGATIVE }, width: LONG_ID, height: LONG_NEGATIVE },
      { kind: 'image', width: 400, height: 300 },
    ] }),
  ]);
  seg('parallel', [
    advance('c.par.adv', 'parallel', 4 * MINUTE),
    turn('c.par', 'parallel', { chars: 3750, calls: [{ kind: 'json', size: 7500 }, { kind: 'prose', size: 10_500 }, { kind: 'code', size: 9000 }] }),
  ]);
  seg('thinking-call', [
    advance('c.think.adv', 'thinking-call', 4 * MINUTE),
    turn('c.think', 'thinking-call', { chars: 4500, thinking: 9000, calls: [{ kind: 'prose', size: 12_000 }] }),
  ]);
  // The compressions a long tool turn's closes start park at agent-framework's provider gate until the turn ends.
  seg('debt', [
    advance('c.debt.adv', 'debt', 4 * MINUTE),
    turn('c.debt', 'debt', {
      chars: 4500,
      rounds: [[{ kind: 'prose', size: 22_500 }], [{ kind: 'code', size: 19_500 }], [{ kind: 'json', size: 19_500 }], [{ kind: 'prose', size: 22_500 }]],
      more: { badAnswers: ['thinking-only', 'empty', 'max-tokens'] },
    }),
  ]);
  const presentation = configuration.agent?.toolPresentation;
  if (presentation) {
    const own = (id, call) => {
      const t = turn(id, 'catalogue', { chars: 1500, replyChars: 1200, more: { namedAnywhere: true } });
      const said = `${canary(id, 'r0')} ${prose(1200, `${id}:r0`)}`;
      return { ...t, replies: [{ text: said, calls: [call] }, ...t.replies] };
    };
    seg('catalogue', [
      advance('c.cat.adv', 'catalogue', 4 * MINUTE), own('c.cat', { name: 'workspace--read', input: { path: presentation.cataloguePath, offset: 4, limit: 140 } }),
      advance('c.vis.adv', 'catalogue', 4 * MINUTE), own('c.vis', { name: 'set_tool_visibility', input: { name: 'workspace--glbo', visible: true } }),
    ]);
  }
  steps.at(-1).copyStore = true;
  return steps;
}

export function products(configuration: Configuration): Products {
  const summarises = configuration.summarises !== false;
  const strategy = configuration.agent?.strategy ?? {};
  const shards = strategy.type !== 'passthrough' && strategy.adaptiveResolution !== false;
  const merges = strategy.mergeThreshold !== 0;
  const steps = continuation(configuration);
  const long = canary(steps.filter((s) => s.segment === 'close-merge' && s.kind === 'channel').reduce((a, b) => (b.text.length > a.text.length ? b : a)).id, 'in');
  const callsOf = (segment) => steps.find((s) => s.segment === segment && s.kind === 'channel').replies.flatMap((r) => r.calls ?? []).map((c) => c.input);
  const imageCall = callsOf('tool-round').find((c) => c.kind === 'image').canary;
  const thinkingCalls = callsOf('thinking-call').map((c) => c.canary);
  if (configuration.agent?.formatter === 'anthropic-xml') {
    const xml = (r, field) => r.messages.flatMap((m) => m.blocks.flatMap((b) => b[field] ?? []));
    const resultsAll = (r, segment) => r.kind === 'agent' && callsOf(segment).every((c) => xml(r, 'xmlResults').includes(c.canary));
    const images = (r) => r.messages.some((m) => m.blocks.some((b) => b.type === 'image'));
    return {
      'close-merge': summarises ? closing() : [],
      'tool-round': [{ name: 'a prefill carrying both results, the image as a user turn of its own', test: (r) => resultsAll(r, 'tool-round') && r.messages.some((m, i) => m.blocks.some((b) => (b.xmlResults ?? []).includes(imageCall)) && (r.messages.slice(i + 1).find((x) => x.role === 'user')?.blocks ?? []).some((b) => b.type === 'image')) }],
      parallel: [
        { name: 'a prefill carrying the three results', test: (r) => resultsAll(r, 'parallel') },
        { name: 'the tool round\'s image as its placeholder', test: (r) => r.kind === 'agent' && !images(r) && xml(r, 'xmlPlaceheld').includes(imageCall) },
      ],
      'thinking-call': [{ name: 'the call\'s prefill carrying the reply\'s thinking', test: (r) => r.kind === 'agent' && thinkingCalls.some((c) => xml(r, 'xmlThoughtCalls').includes(c) && xml(r, 'xmlResults').includes(c)) }],
      debt: summarises ? debt() : [],
    };
  }
  return {
    'close-merge': summarises ? closing() : [],
    'tool-round': [
      configuration.textOnlyResults
        ? { name: 'a request carrying both results, the image as membrane\'s text in its place', test: (r) => r.kind === 'agent' && resultsIn(turnsOf(r.messages, r.head?.api).at(-1)) === 2 && turnsOf(r.messages, r.head?.api).at(-1).blocks.some((b) => b.type === 'tool_result' && b.imagesNotShown > 0) }
        : { name: 'a request carrying both results, one an image', test: (r) => r.kind === 'agent' && resultsIn(turnsOf(r.messages, r.head?.api).at(-1)) === 2 && turnsOf(r.messages, r.head?.api).at(-1).blocks.some((b) => b.type === 'tool_result' && b.images > 0) },
    ],
    parallel: [
      { name: 'a request carrying the three results', test: (r) => r.kind === 'agent' && resultsIn(turnsOf(r.messages, r.head?.api).at(-1)) === 3 },
      { name: 'the tool round\'s image as its placeholder', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.blocks.some((b) => b.type === 'tool_result' && (b.canaries || []).includes(imageCall) && !b.images && b.placeholders > 0)) },
    ],
    'thinking-call': configuration.sendsReasoning === false
      ? []
      : [
        { name: 'the call\'s request carrying the reply\'s thinking', test: (r) => r.kind === 'agent' && turnsOf(r.messages, r.head?.api).some((m) => m.role === 'assistant' && thinkingLedCalls(m).some((id) => resultFor(r, id, thinkingCalls))) },
      ],
    debt: summarises ? debt() : [],
    catalogue: [
      { name: 'a request carrying the catalogue\'s read', test: (r) => answered(r, 'c.cat', false) },
      { name: 'a request carrying the visibility call\'s refusal', test: (r) => answered(r, 'c.vis', true) },
    ],
  };

  function answered(r, step, error) {
    if (r.kind !== 'agent' || r.step !== step) return false;
    const turns = turnsOf(r.messages, r.head?.api);
    const round = turns.find((m) => m.role === 'assistant' && m.blocks.some((b) => (b.canaries ?? []).includes(canary(step, 'r0'))));
    const own = round?.blocks.find((b) => b.type === 'tool_use')?.toolUseId;
    const results = (turns.at(-1)?.blocks ?? []).filter((b) => b.type === 'tool_result');
    return own !== undefined && results.length === 1 && results[0].toolUseId === own && (results[0].isError === true) === error && !results[0].repairs?.length;
  }

  function closing() {
    return [
      { name: 'an L1 compression request', test: (r) => r.kind === 'summariser' && r.level === 1 && r.answer?.shape === 'summary' },
      ...(merges ? [
        { name: 'a merge request', test: (r) => r.kind === 'summariser' && r.level >= 2 && r.answer?.shape === 'summary' },
        { name: L3_PRODUCT, test: (r) => r.kind === 'summariser' && r.level >= 3 && r.answer?.shape === 'summary' },
      ] : []),
      ...(shards ? [{ name: 'the long message stored in parts', fromStore: (store) => storedInParts(store, long) }] : []),
    ];
  }

  function debt() {
    return [
      { name: 'a compression after the turn, and none between its rounds', test: (r, mine) => r.kind === 'summariser' && parkedThrough(mine) && r.seq > Math.max(...mine.filter((x) => x.kind === 'agent').map((x) => x.seq)) },
      { name: 'a thinking-only answer', test: (r) => r.answer?.shape === 'thinking-only' },
      { name: 'an empty answer', test: (r) => r.answer?.shape === 'empty' },
      { name: 'an answer cut at max_tokens', test: (r) => r.answer?.shape === 'max-tokens' },
    ];
  }
}

const resultsIn = (message) => (message?.blocks || []).filter((b) => b.type === 'tool_result').length;

function thinkingLedCalls(message) {
  const thought = message.blocks.findIndex((b) => (b.type === 'thinking' && typeof b.signature === 'string' && b.signature.startsWith('fx1.')) || (b.type === 'redacted_thinking' && b.sealed === true));
  return thought < 0 ? [] : message.blocks.slice(thought + 1).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId);
}

const resultFor = (record, id, canaries) => turnsOf(record.messages, record.head?.api).some((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'tool_result' && b.toolUseId === id && (b.canaries ?? []).some((c) => canaries.includes(c))));

function storedInParts(store, input) {
  const first = store.messages.find((m) => m.canaries.includes(input));
  return Boolean(first?.bodyGroupId) && store.messages.filter((m) => m.bodyGroupId === first.bodyGroupId).length >= 2;
}

function parkedThrough(records) {
  const agents = records.filter((x) => x.kind === 'agent').map((x) => x.seq);
  if (agents.length < 2) return false;
  const [first, last] = [Math.min(...agents), Math.max(...agents)];
  return !records.some((x) => x.kind === 'summariser' && x.seq > first && x.seq < last);
}
